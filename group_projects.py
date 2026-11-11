"""Class-owned projects, revisioned files, and private editor presence."""
from contextlib import closing, contextmanager
from datetime import datetime
from io import BytesIO
from pathlib import Path, PurePosixPath
from threading import BoundedSemaphore, RLock
from time import monotonic, time, time_ns
from uuid import uuid4
from zoneinfo import ZoneInfo
import json
import re
import sqlite3
import unicodedata
import zipfile

from flask import jsonify, request, send_file

import editor_annotations as annotations
import file_provenance
import group_project_text as text_ops
from security_controls import AttemptLimiter

MAX_MEMBERS = 4
MAX_FILES = 100
MAX_NODES = 160
MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_PROJECT_BYTES = 32 * 1024 * 1024
MAX_CLASS_BYTES = 256 * 1024 * 1024
MAX_GLOBAL_BYTES = 2 * 1024 * 1024 * 1024
MAX_PROJECTS = 40
RECOVERY_SECONDS = 30 * 86400
LEASE_SECONDS = 35
MAX_RANGES = 16000
PALETTE_SIZE = 12
_lock = RLock()
_watchers = {}
_edits_per_member = AttemptLimiter(18, 1)
_project_creation = AttemptLimiter(6, 60)
_download_slots = BoundedSemaphore(2)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS projects(
 id TEXT PRIMARY KEY, class_id TEXT NOT NULL, name TEXT NOT NULL,
 folder INTEGER NOT NULL, owner TEXT NOT NULL, status TEXT NOT NULL,
 changed INTEGER NOT NULL, size INTEGER NOT NULL DEFAULT 0,
 file_count INTEGER NOT NULL DEFAULT 0, node_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS projects_by_class ON projects(class_id, status);
CREATE TABLE IF NOT EXISTS members(
 project TEXT REFERENCES projects(id) ON DELETE CASCADE,
 email TEXT NOT NULL, author TEXT NOT NULL, name TEXT NOT NULL,
 color INTEGER NOT NULL, state TEXT NOT NULL, joined INTEGER NOT NULL,
 PRIMARY KEY(project, email)
);
CREATE INDEX IF NOT EXISTS membership_by_email ON members(email, state);
CREATE TABLE IF NOT EXISTS files(
 id TEXT PRIMARY KEY, project TEXT REFERENCES projects(id) ON DELETE CASCADE,
 path TEXT NOT NULL, folder INTEGER NOT NULL, content BLOB NOT NULL,
 size INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
 authors TEXT NOT NULL DEFAULT '[]', spans TEXT NOT NULL DEFAULT '[]',
 paste TEXT NOT NULL DEFAULT '[]', UNIQUE(project, path COLLATE NOCASE)
);
CREATE TRIGGER IF NOT EXISTS project_file_added AFTER INSERT ON files BEGIN
 UPDATE projects SET size=size+NEW.size, file_count=file_count+1-NEW.folder, node_count=node_count+1 WHERE id=NEW.project;
END;
CREATE TRIGGER IF NOT EXISTS project_file_resized AFTER UPDATE OF size ON files BEGIN
 UPDATE projects SET size=size+NEW.size-OLD.size WHERE id=NEW.project;
END;
CREATE TRIGGER IF NOT EXISTS project_file_removed AFTER DELETE ON files BEGIN
 UPDATE projects SET size=size-OLD.size, file_count=file_count-1+OLD.folder, node_count=node_count-1 WHERE id=OLD.project;
END;
CREATE TABLE IF NOT EXISTS edits(
 file TEXT REFERENCES files(id) ON DELETE CASCADE, revision INTEGER NOT NULL,
 op_id TEXT NOT NULL, operation TEXT NOT NULL, author TEXT NOT NULL,
 PRIMARY KEY(file, revision), UNIQUE(file, op_id)
);
"""


class ProjectError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def policy_lock():
    return _lock


@contextmanager
def database(eagle):
    with _lock:
        path = eagle.GROUP_PROJECTS_DIR / "index.sqlite3"
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with closing(sqlite3.connect(path)) as db, db:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys = ON")
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if not version:
                db.execute("PRAGMA auto_vacuum = INCREMENTAL")
                db.executescript(_SCHEMA + "\nPRAGMA user_version = 1;")
            if version < 2:
                db.executescript("""
                    BEGIN;
                    CREATE TABLE IF NOT EXISTS project_teachers(
                        project TEXT REFERENCES projects(id) ON DELETE CASCADE,
                        email TEXT NOT NULL, author TEXT NOT NULL,
                        PRIMARY KEY(project, email)
                    );
                    PRAGMA user_version = 2;
                    COMMIT;
                """)
            if version < 3:
                db.executescript("""
                    BEGIN;
                    CREATE TABLE IF NOT EXISTS annotations(
                        file TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
                        id TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL,
                        discussion TEXT NOT NULL, PRIMARY KEY(file,id)
                    );
                    PRAGMA user_version = 3;
                    COMMIT;
                """)
            if version < 4:
                db.executescript("""
                    BEGIN;
                    ALTER TABLE projects ADD COLUMN tree_revision INTEGER NOT NULL DEFAULT 0;
                    ALTER TABLE projects ADD COLUMN snapshot_revision INTEGER NOT NULL DEFAULT 0;
                    ALTER TABLE files ADD COLUMN trash_id TEXT;
                    ALTER TABLE files ADD COLUMN trashed_at INTEGER;
                    ALTER TABLE files ADD COLUMN is_text INTEGER;
                    CREATE INDEX group_trash_expiry ON files(trashed_at) WHERE trashed_at IS NOT NULL;
                    PRAGMA user_version = 4;
                    COMMIT;
                """)
            yield db


def schedule(value):
    if value is None:
        return {"enabled": False, "days": [0, 1, 2, 3, 4],
                "start": "08:00", "end": "15:00", "timeZone": "UTC"}
    if not isinstance(value, dict) or type(value.get("enabled")) is not bool:
        raise ProjectError("Choose a valid group project schedule")
    days, start, end, zone = (value.get(k) for k in ("days", "start", "end", "timeZone"))
    if (not isinstance(days, list) or not 1 <= len(days) <= 7 or
            any(type(day) is not int or not 0 <= day <= 6 for day in days) or
            not all(isinstance(s, str) and re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", s) for s in (start, end)) or
            start >= end or not isinstance(zone, str) or len(zone) > 80):
        raise ProjectError("Select class days, a start and end time, and a time zone")
    try:
        ZoneInfo(zone)
    except (ValueError, KeyError) as exc:
        raise ProjectError("Enter an IANA time zone, such as America/Chicago") from exc
    return {"enabled": value["enabled"], "days": sorted(set(days)), "start": start, "end": end, "timeZone": zone}


def class_open(cls, now=None, *, ignore_schedule=False):
    settings = cls.get("settings") or {}
    if settings.get("group_projects_enabled") is not True:
        return False, "Group projects are disabled for this class"
    if settings.get("student_ide_access_enabled") is False:
        return False, "IDE access is disabled for this class"
    if ignore_schedule:
        return True, ""
    try:
        window = schedule(settings.get("group_project_schedule"))
    except ProjectError:
        return False, "Ask your teacher to check the group project schedule"
    if window["enabled"]:
        zone = ZoneInfo(window["timeZone"])
        local = now.astimezone(zone) if now else datetime.now(zone)
        if local.weekday() not in window["days"] or not window["start"] <= local.strftime("%H:%M") < window["end"]:
            return False, f"Group projects open during class, {window['start']}–{window['end']} ({window['timeZone']})"
    return True, ""


def roster_student(eagle, cls, email):
    if email not in cls.get("students", []):
        return None
    user = eagle._find_user(email)
    if user and user.get("enabled", True) and user.get("role", "student") == "student":
        return user
    return None


def student_class(eagle, class_id, email):
    cls = eagle._find_class_by_id(class_id) if isinstance(class_id, str) and class_id else None
    if not cls or not roster_student(eagle, cls, email):
        raise ProjectError("This class is unavailable", 403)
    return cls


def must_open(cls, *, ignore_schedule=False):
    allowed, reason = class_open(cls, ignore_schedule=ignore_schedule)
    if not allowed:
        raise ProjectError(reason, 403)


def identity(user):
    return str(user["email"]).lower()


def name_of(user):
    return str(user.get("name") or user.get("email") or "Student")[:120]


def member_info(row):
    return {"id": row["author"], "name": row["name"], "color": row["color"]}


def project_record(db, project_id):
    row = db.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
    if not row:
        raise ProjectError("Group project not found", 404)
    return row


def require_member(db, project, email, *, states=("active",)):
    member = db.execute("SELECT * FROM members WHERE project=? AND email=?", (project["id"], email)).fetchone()
    if not member or member["state"] not in states:
        raise ProjectError("You no longer have access to this group project", 403)
    return member


def teacher_member(db, project, actor):
    email = identity(actor)
    row = db.execute("SELECT author FROM project_teachers WHERE project=? AND email=?", (project["id"], email)).fetchone()
    if row:
        author = row["author"]
    else:
        author = uuid4().hex
        db.execute("INSERT INTO project_teachers VALUES (?,?,?)", (project["id"], email, author))
    return {"email": email, "author": author, "name": name_of(actor), "color": PALETTE_SIZE}


def select_file(db, project, file_id, *, content=False):
    columns = "*" if content else "id, project, path, folder, size, revision, is_text"
    row = db.execute(f"SELECT {columns} FROM files WHERE project=? AND id=? AND trash_id IS NULL", (project, file_id)).fetchone()
    if not row:
        raise ProjectError("This project file has been removed", 404)
    return row


def file_info(row):
    return {key: row[key] for key in ("id", "path", "folder", "size", "revision")}


def summary(db, project, *, email="", teacher=False, tree=False, cls=None):
    rows = db.execute("SELECT * FROM members WHERE project=? ORDER BY joined, author", (project["id"],)).fetchall()
    members = []
    for row in rows:
        if row["state"] in ("active", "pending", "removed") and (teacher or row["state"] == "active"):
            available = row["state"] == "active" and (not cls or row["email"] in cls.get("students", []))
            if not teacher and not available:
                continue
            item = {**member_info(row), "owner": row["email"] == project["owner"]}
            if teacher:
                item.update(state=row["state"], available=available)
            members.append(item)
    own = next((row for row in rows if row["email"] == email), None)
    result = {k: project[k] for k in ("id", "name", "folder", "status", "changed")}
    result.update(classId=project["class_id"], treeRevision=project["tree_revision"], members=members,
                  own=member_info(own) if own else None, membership=own["state"] if own else "",
                  canInvite=bool(own and own["email"] == project["owner"] and own["state"] == "active"))
    if project["status"] == "canceled":
        result["recoverUntil"] = project["changed"] + RECOVERY_SECONDS
    if tree and result["canInvite"]:
        result["invitations"] = [member_info(row) for row in rows if row["state"] == "pending"]
        result["invitedEmails"] = [row["email"] for row in rows if row["state"] in ("active", "pending", "removed")]
    if tree:
        result["files"] = [file_info(row) for row in db.execute(
            "SELECT id,path,folder,size,revision FROM files WHERE project=? AND trash_id IS NULL ORDER BY path COLLATE NOCASE", (project["id"],))]
        result["trash"] = [dict(row) for row in db.execute(
            """SELECT id,substr(path,length(trash_id)+3) AS path,folder,trashed_at+? AS recoverUntil
               FROM files WHERE project=? AND trash_id=id AND trashed_at>=? ORDER BY trashed_at DESC""",
            (RECOVERY_SECONDS, project["id"], int(time()) - RECOVERY_SECONDS))]
    return result


def bump(db, project):
    db.execute("UPDATE projects SET changed=? WHERE id=?", (int(time()), project))


def prune(db):
    db.execute("DELETE FROM files WHERE trashed_at<?", (int(time()) - RECOVERY_SECONDS,))
    db.execute("DELETE FROM projects WHERE status!='active' AND changed<?", (int(time()) - RECOVERY_SECONDS,))


def safe_path(eagle, value):
    if not isinstance(value, str) or not 1 <= len(value) <= 360 or "\\" in value:
        raise ProjectError("Choose a valid project path")
    try:
        value.encode("utf-8")
    except UnicodeError as exc:
        raise ProjectError("Choose a valid project path") from exc
    parts = value.split("/")
    if len(parts) > 12 or any(not eagle._valid_workspace_name(part) or part.startswith(".") or
            part.casefold() == "trash" or re.fullmatch(r"(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])",
                                                     part.split(".", 1)[0], re.IGNORECASE) for part in parts):
        raise ProjectError("Choose a valid project path")
    return value


def portable_path_key(path):
    return unicodedata.normalize("NFC", path.casefold())


def require_unique_paths(paths):
    if len({portable_path_key(path) for path in paths}) != len(paths):
        raise ProjectError("Names in this project differ only by capitalization or Unicode spelling", 409)


def text_file(eagle, path, content):
    if Path(path).suffix.lower() not in eagle.TEXT_EXTENSIONS or len(content) > text_ops.MAX_TEXT_BYTES:
        return None
    try:
        source = content.decode("utf-8")
    except UnicodeError:
        return None
    return None if "\x00" in source else source.replace("\r\n", "\n").replace("\r", "\n")


def check_active_quota(db, project, counts, files, nodes, extra):
    count, node_count, size = counts
    if count + files > MAX_FILES or node_count + nodes > MAX_NODES or size + extra > MAX_PROJECT_BYTES:
        trash_files, trash_nodes, trash_bytes = db.execute(
            "SELECT COALESCE(SUM(1-folder),0),COUNT(*),COALESCE(SUM(size),0) FROM files WHERE project=? AND trash_id IS NOT NULL",
            (project,)).fetchone()
        if (count - trash_files + files > MAX_FILES or node_count - trash_nodes + nodes > MAX_NODES or
                size - trash_bytes + extra > MAX_PROJECT_BYTES):
            raise ProjectError("This project has reached its file or storage limit", 413)


def check_quota(db, project, class_id, files, nodes, extra):
    counts = db.execute("SELECT file_count,node_count,size FROM projects WHERE id=?", (project,)).fetchone()
    check_active_quota(db, project, counts, files, nodes, extra)
    if counts[1] + nodes > 2 * MAX_NODES or counts[2] + extra > 2 * MAX_PROJECT_BYTES:
        raise ProjectError("This project and its Trash have reached the combined storage limit", 413)
    if extra <= 0:
        return
    used = db.execute("SELECT COALESCE(SUM(size),0) FROM projects WHERE class_id=?", (class_id,)).fetchone()[0]
    global_used = db.execute("SELECT COALESCE(SUM(size),0) FROM projects").fetchone()[0]
    if used + extra > MAX_CLASS_BYTES or global_used + extra > MAX_GLOBAL_BYTES:
        raise ProjectError("Group project storage is full. Ask your teacher for help.", 413)


def add_member(db, project, user, state):
    email = identity(user)
    existing = db.execute("SELECT * FROM members WHERE project=? AND email=?", (project, email)).fetchone()
    if existing and existing["state"] in ("active", "pending", "removed"):
        raise ProjectError("This classmate already has a membership or a teacher restriction", 409)
    members = db.execute("SELECT color,state FROM members WHERE project=?", (project,)).fetchall()
    if len(members) >= 64 and not existing:
        raise ProjectError("This project has reached its membership history limit", 409)
    reserved = [row["color"] for row in members if row["state"] in ("active", "pending")]
    if len(reserved) >= MAX_MEMBERS:
        raise ProjectError("All four group places are filled or reserved by invitations", 409)
    used = {row["color"] for row in members}
    color = next((i for i in range(PALETTE_SIZE) if i not in used),
                 next(i for i in range(PALETTE_SIZE) if i not in reserved))
    if existing:
        color = existing["color"] if existing["color"] not in reserved else color
        db.execute("UPDATE members SET state=?,name=?,color=?,joined=? WHERE project=? AND email=?",
                   (state, name_of(user), color, time_ns(), project, email))
    else:
        db.execute("INSERT INTO members VALUES (?,?,?,?,?,?,?)",
                   (project, email, uuid4().hex, name_of(user), color, state, time_ns()))


def remove_member(db, project, member, state):
    db.execute("UPDATE members SET state=? WHERE project=? AND email=?", (state, project["id"], member["email"]))
    update_organizer(db, project["id"])


def update_organizer(db, project_id):
    successor = db.execute(
        """SELECT m.email,m.state FROM members m JOIN projects p ON p.id=m.project
           WHERE m.project=? AND m.state IN ('active','pending')
           ORDER BY m.state!='active',m.email!=p.owner,m.joined,m.author LIMIT 1""", (project_id,)).fetchone()
    if successor and successor["state"] == "active":
        db.execute("UPDATE projects SET owner=? WHERE id=?", (successor["email"], project_id))
    elif not successor:
        db.execute("UPDATE projects SET status='canceled' WHERE id=?", (project_id,))
    bump(db, project_id)


def insert_file(eagle, db, project, path, folder, data=b"", paste=(), author=None):
    ident = uuid4().hex
    source = text_file(eagle, path, data) if not folder else None
    authors = [author] if author and not folder else []
    spans = [[0, text_ops.length(source), author["id"]]] if source and author else []
    db.execute("INSERT INTO files(id,project,path,folder,content,size,paste,authors,spans,is_text) VALUES (?,?,?,?,?,?,?,?,?,?)",
               (ident, project, path, int(folder), data, len(data), json.dumps(paste), json.dumps(authors), json.dumps(spans), int(source is not None)))
    return ident


def import_workspace(eagle, user, source):
    root = eagle._get_user_dir(identity(user)).resolve()
    safe_path(eagle, source)
    target = eagle._validate_workspace_path(root, source)
    unresolved = root.joinpath(*source.split("/"))
    if (not target or not target.exists() or eagle._is_trash_path(root, target) or
            unresolved != target or any(p.is_symlink() for p in [unresolved, *unresolved.parents] if p != root)):
        raise ProjectError("Choose an ordinary workspace file or folder")
    folder = target.is_dir()
    results = []
    total = 0

    def visit(path):
        nonlocal total
        relative = path.relative_to(target if folder else target.parent).as_posix()
        safe_path(eagle, relative)
        if path.is_symlink() or path.resolve() != path or not (path.is_dir() or path.is_file()):
            raise ProjectError("The selection contains a link or unsupported file")
        if len(results) >= MAX_NODES:
            raise ProjectError("This folder exceeds the group project file limit", 413)
        if path.is_dir():
            results.append((relative, True, b"", ()))
            for child in path.iterdir():
                visit(child)
            return
        workspace_path = path.relative_to(root).as_posix()
        if eagle.assignment_development.bindings_for_path(eagle, identity(user), workspace_path):
            raise ProjectError("The selection includes a teacher-controlled assignment file")
        with path.open("rb") as handle:
            content = handle.read(min(MAX_FILE_BYTES, MAX_PROJECT_BYTES - total) + 1)
        total += len(content)
        if len(content) > MAX_FILE_BYTES or total > MAX_PROJECT_BYTES:
            raise ProjectError("The selection exceeds group project storage limits", 413)
        source_text = text_file(eagle, relative, content)
        paste = ()
        if source_text is not None:
            paste = file_provenance.read(eagle, root, path, source_text)
            content = source_text.encode("utf-8")
        results.append((relative, False, content, paste))

    if folder:
        for child in target.iterdir():
            visit(child)
    else:
        visit(target)
    return target.name, folder, results


def projects_for(db, cls, email="", *, teacher=False):
    if teacher:
        projects = db.execute("""SELECT * FROM projects WHERE class_id=? AND (status='active' OR changed>=?)
                                 ORDER BY status,changed DESC""", (cls["id"], int(time()) - RECOVERY_SECONDS))
    else:
        projects = db.execute(
            """SELECT p.* FROM projects p JOIN members m ON m.project=p.id
               WHERE p.class_id=? AND m.email=? AND
               ((p.status='active' AND m.state IN ('active','pending')) OR
                (p.status='canceled' AND m.state='active' AND p.changed>=?)) ORDER BY p.changed DESC""",
            (cls["id"], email, int(time()) - RECOVERY_SECONDS))
    return [summary(db, row, email=email, teacher=teacher, cls=cls) for row in projects]


def changes_since(db, row, since):
    revision = row["revision"]
    if since < 0 or since > revision:
        return None
    if since == revision:
        return []
    if revision - since > 120:
        return None
    rows = db.execute(
        "SELECT revision,op_id,operation,author FROM edits WHERE file=? AND revision>? ORDER BY revision",
        (row["id"], since)).fetchall()
    if len(rows) != revision - since or sum(len(row["operation"]) for row in rows) > 512 * 1024:
        return None
    return [{"revision": r["revision"], "opId": r["op_id"], "parts": json.loads(r["operation"]),
             "author": json.loads(r["author"])} for r in rows]


def apply_edit(eagle, db, project, member, row, data):
    base, op_id = data.get("revision"), data.get("opId")
    if type(base) is not int or not isinstance(op_id, str) or not re.fullmatch(r"[a-f0-9]{32}", op_id):
        raise ProjectError("Invalid edit revision")
    cached = db.execute("SELECT author FROM edits WHERE file=? AND op_id=?", (row["id"], op_id)).fetchone()
    if cached:
        if json.loads(cached["author"])["id"] != member["author"]:
            raise ProjectError("This edit ID is already in use", 409)
        return None
    if not _edits_per_member.admit(member["email"]):
        raise ProjectError("Group edits are arriving too quickly. Retry shortly.", 429)
    updates = changes_since(db, row, base)
    if updates is None:
        raise ProjectError("Your draft is behind the saved file. Review it before applying it.", 409)
    content = text_file(eagle, row["path"], row["content"])
    if row["folder"] or content is None:
        raise ProjectError("This file uses saved revisions", 409)
    author = member_info(member)
    try:
        parts = text_ops.validate(data.get("parts"))
        for update in updates:
            parts = text_ops.transform(parts, update["parts"])
            if len(parts) > text_ops.MAX_PARTS:
                raise ValueError("Too many overlapping edits. Review your draft before reloading.")
        source, spans = text_ops.apply(content, parts, json.loads(row["spans"]), author["id"])
    except (ValueError, UnicodeError) as exc:
        raise ProjectError(str(exc)) from exc
    encoded = source.encode("utf-8")
    if len(encoded) > text_ops.MAX_TEXT_BYTES:
        raise ProjectError("Shared text files can be at most 2 MiB", 413)
    annotations_closed = annotations.group_move(db, row["id"], parts)
    if source == content:
        parts = [text_ops.length(content)] if content else []
        spans = json.loads(row["spans"])
    authors = json.loads(row["authors"])
    paste = json.loads(row["paste"])
    if source != content:
        authors = [a for a in authors if a["id"] != author["id"]] + [author]
        if paste or data.get("pasted") is True:
            _, marks = text_ops.apply(content, parts, [(*span, True) for span in paste],
                                      True if data.get("pasted") is True else None)
            paste = [span[:2] for span in marks[:file_provenance.MAX_RANGES]]
    check_quota(db, project["id"], project["class_id"], 0, 0, len(encoded) - row["size"])
    revision = row["revision"] + 1
    db.execute("UPDATE files SET content=?,size=?,revision=?,authors=?,spans=?,paste=? WHERE id=?",
               (encoded, len(encoded), revision, json.dumps(authors), json.dumps(spans[:MAX_RANGES]), json.dumps(paste), row["id"]))
    operation = json.dumps(parts, ensure_ascii=False, separators=(",", ":"))
    db.execute("INSERT INTO edits VALUES (?,?,?,?,?)", (row["id"], revision, op_id, operation, json.dumps(author)))
    db.execute("""DELETE FROM edits WHERE file=? AND revision<?""", (row["id"], revision - 120))
    total = 0
    for edit in db.execute("SELECT revision,length(CAST(operation AS BLOB)) FROM edits WHERE file=? ORDER BY revision DESC",
                           (row["id"],)).fetchall():
        total += edit[1]
        if total > 1024 * 1024:
            db.execute("DELETE FROM edits WHERE file=? AND revision<=?", (row["id"], edit[0]))
            break
    db.execute("UPDATE projects SET snapshot_revision=snapshot_revision+1,changed=? WHERE id=?",
               (int(time()), project["id"]))
    return {"revision": revision, "opId": op_id, "parts": parts, "author": author,
            "annotationsClosed": annotations_closed}


def edit_receipt(eagle, db, row, base):
    latest = select_file(db, row["project"], row["id"])
    updates = changes_since(db, latest, base)
    if updates is not None:
        return {**file_info(latest), "kind":"text", "updates":updates,
                "treeRevision":project_record(db, row["project"])["tree_revision"]}
    return file_payload(eagle, db, select_file(db, row["project"], row["id"], content=True))


def file_payload(eagle, db, row, since=None):
    data = file_info(row)
    data["treeRevision"] = project_record(db, row["project"])["tree_revision"]
    if since == row["revision"] and row["is_text"] is not None:
        return {**data, "kind":"text" if row["is_text"] else "asset", "updates":[]}
    source = text_file(eagle, row["path"], row["content"])
    if row["is_text"] is None:
        db.execute("UPDATE files SET is_text=? WHERE id=?", (int(source is not None), row["id"]))
    data["kind"] = "text" if source is not None else "asset"
    data["contribution"] = {"spans": json.loads(row["spans"]), "authors": json.loads(row["authors"])}
    if source is not None:
        updates = changes_since(db, row, since) if since is not None else None
        if updates is None:
            data["content"] = source
        else:
            data["updates"] = updates
    return data


def snapshot_for_submission(eagle, db, user, assignment, selection, *, content=True):
    if not isinstance(selection, dict) or selection.get("mode") not in ("self", "group"):
        raise ProjectError("Choose how to submit this group project")
    if assignment.get("fileControl") or assignment.get("assignmentType") == "lab_report":
        raise ProjectError("This assignment uses its own files", 403)
    project_id, files = selection.get("projectId"), selection.get("files")
    if (not isinstance(project_id, str) or not isinstance(files, list) or not 1 <= len(files) <= 20 or
            any(not isinstance(f, dict) or not isinstance(f.get("id"), str) or
                not isinstance(f.get("path"), str) or type(f.get("revision")) is not int for f in files) or
            len({f["id"] for f in files}) != len(files)):
        raise ProjectError("Select distinct files and saved revisions")
    project = project_record(db, project_id)
    if project["class_id"] != assignment.get("targetClassId") or project["status"] != "active":
        raise ProjectError("This project is unavailable for this assignment", 403)
    cls = student_class(eagle, project["class_id"], identity(user))
    must_open(cls, ignore_schedule=True)
    require_member(db, project, identity(user))
    recipient_ids = [identity(user)]
    if selection["mode"] == "group":
        if assignment.get("allowGroupSubmission") is not True:
            raise ProjectError("This assignment allows individual turn-in only", 403)
        recipient_ids = [r["email"] for r in db.execute(
            "SELECT email FROM members WHERE project=? AND state='active' ORDER BY joined,email", (project_id,))]
        if len(recipient_ids) < 2:
            raise ProjectError("At least two students must belong to the group to turn in together", 409)
        expected = sorted(r["author"] for r in db.execute(
            "SELECT author FROM members WHERE project=? AND state='active'", (project_id,)))
        if selection.get("recipients") != expected:
            raise ProjectError("The group membership changed. Review who will receive credit.", 409)
    recipients = [roster_student(eagle, cls, email) for email in recipient_ids]
    if not all(recipients):
        raise ProjectError("A group member is no longer eligible. Ask your teacher to review the group.", 409)
    records = []
    total = 0
    for f in files:
        row = db.execute(
            f"SELECT {'*' if content else 'folder,path,revision,size'} FROM files WHERE project=? AND id=? AND trash_id IS NULL",
            (project_id, f["id"])).fetchone()
        if not row or row["folder"] or row["revision"] != f["revision"] or row["path"] != f["path"]:
            raise ProjectError("A selected file changed or was removed. Review the current files before submitting.", 409)
        total += row["size"]
        if total > 25 * 1024 * 1024:
            raise ProjectError("Submission files exceed the 25 MiB total limit", 413)
        records.append(row)
    return project, records, recipients

def forget_account(eagle, email):
    if not (eagle.GROUP_PROJECTS_DIR / "index.sqlite3").exists():
        return
    with database(eagle) as db:
        rows = db.execute("""SELECT p.* FROM projects p JOIN members m ON m.project=p.id
                             WHERE m.email=? AND m.state IN ('active','pending') AND p.status='active'""", (email,)).fetchall()
        for project in rows:
            member = require_member(db, project, email, states=("active", "pending"))
            remove_member(db, project, member, "left")
            revoke_project_watches(eagle, db, project["id"], email)
        db.execute("DELETE FROM members WHERE email=?", (email,))
        db.execute("DELETE FROM project_teachers WHERE email=?", (email,))


def start_maintenance(eagle):
    def maintain():
        while True:
            if (eagle.GROUP_PROJECTS_DIR / "index.sqlite3").exists():
                try:
                    with database(eagle) as db:
                        prune(db)
                        db.commit()
                        db.execute("PRAGMA incremental_vacuum(128)")
                except (OSError, sqlite3.Error):
                    eagle.app.logger.warning("Group project recovery cleanup could not finish")
            eagle.socketio.sleep(3600)
    eagle.socketio.start_background_task(maintain)


def class_changed(eagle, class_id, *, disabled=False, removed="", deleted=False):
    """Synchronously invalidate existing watches when policy or roster changes."""
    with _lock:
        if (eagle.GROUP_PROJECTS_DIR / "index.sqlite3").exists():
            with database(eagle) as db:
                if deleted:
                    db.execute("DELETE FROM projects WHERE class_id=?", (class_id,))
                elif disabled:
                    db.execute("UPDATE projects SET status='canceled',changed=? WHERE class_id=? AND status='active'",
                               (int(time()), class_id))
                    db.execute("""UPDATE members SET state='left' WHERE state='pending' AND project IN
                                   (SELECT id FROM projects WHERE class_id=? AND status='canceled')""", (class_id,))
                elif removed:
                    rows = db.execute(
                        """SELECT p.* FROM projects p JOIN members m ON m.project=p.id
                           WHERE p.class_id=? AND m.email=? AND m.state IN ('active','pending')""",
                        (class_id, removed)).fetchall()
                    for project in rows:
                        member = require_member(db, project, removed, states=("active", "pending"))
                        if project["status"] == "active":
                            remove_member(db, project, member, "removed")
                        else:
                            db.execute("UPDATE members SET state='removed' WHERE project=? AND email=?",
                                       (project["id"], removed))
        for sid, watch in list(_watchers.items()):
            if watch["classId"] == class_id and (not removed or watch["email"] == removed):
                _watchers.pop(sid, None)
                eagle.socketio.emit("group_project_access_changed", {"projectId": watch["projectId"]}, to=sid)


def socket_teacher(eagle, cls, email, token):
    if not cls or cls.get("teacher_email") != email or not eagle._teacher_tokens.active(token):
        return None
    user = eagle._find_user(email)
    return user if user and user.get("enabled", True) and user.get("role") == "teacher" else None


def watcher_valid(eagle, sid, watch, cls, active, students_open):
    info = eagle._socket_sid_info.get(sid) or {}
    if (watch["expires"] <= monotonic() or info.get("token") != watch["token"] or
            info.get("email") != watch["email"] or info.get("role") != watch["role"] or
            watch["classId"] not in eagle._socket_sid_rooms.get(sid, ())):
        return False
    if watch["role"] == "teacher":
        return bool(socket_teacher(eagle, cls, watch["email"], watch["token"]))
    return (students_open and watch["email"] in active and watch["email"] in cls.get("students", []) and
            eagle._student_tokens.active(watch["token"]))


def live_viewers(eagle, db, project_id, file_id):
    project = project_record(db, project_id)
    cls = eagle._find_class_by_id(project["class_id"])
    active = {row["email"] for row in db.execute("SELECT email FROM members WHERE project=? AND state='active'", (project_id,))}
    recipients = {}
    allowed = bool(cls and project["status"] == "active")
    students_open = allowed and class_open(cls)[0]
    now = monotonic()
    for sid, watch in list(_watchers.items()):
        if watch["expires"] <= now:
            _watchers.pop(sid, None)
        if watch["projectId"] != project_id or watch["fileId"] != file_id:
            continue
        if allowed and watcher_valid(eagle, sid, watch, cls, active, students_open):
            recipients[sid] = watch
        else:
            _watchers.pop(sid, None)
    return recipients


def presence(eagle, db, project_id, file_id):
    try:
        select_file(db, project_id, file_id)
        viewers = live_viewers(eagle, db, project_id, file_id)
    except ProjectError:
        return []
    distinct = list(dict.fromkeys(w["author"] for w in viewers.values()))
    data = {"projectId": project_id, "fileId": file_id, "viewers": distinct}
    for sid in viewers:
        eagle.socketio.emit("group_project_presence", data, to=sid)
    return distinct


def close_watch(eagle, sid):
    with _lock:
        watch = _watchers.pop(sid, None)
        if watch:
            with database(eagle) as db:
                presence(eagle, db, watch["projectId"], watch["fileId"])


def deliver_edit(eagle, db, project, row, update):
    viewers = live_viewers(eagle, db, project["id"], row["id"])
    if len({w["author"] for w in viewers.values()}) >= 2:
        event = {key: update[key] for key in ("revision", "opId", "parts", "author")}
        event.update(projectId=project["id"], fileId=row["id"])
        for sid in viewers:
            eagle.socketio.emit("group_project_edit", event, to=sid)
    if update["annotationsClosed"]:
        deliver_annotations(eagle, project["id"], row["id"], viewers)


def deliver_annotations(eagle, project_id, file_id, viewers):
    for sid in viewers:
        eagle.socketio.emit("group_project_annotations_changed", {"projectId": project_id, "fileId": file_id}, to=sid)


def deliver_tree_change(eagle, db, project, cls):
    project_id, class_id = project["id"], project["class_id"]
    active = {row["email"] for row in db.execute(
        "SELECT email FROM members WHERE project=? AND state='active'", (project_id,))}
    roster = set(cls.get("students", []))
    data = {"projectId": project_id, "treeRevision": project["tree_revision"] + 1}
    for sid, info in list(eagle._socket_sid_info.items()):
        if class_id not in eagle._socket_sid_rooms.get(sid, ()):
            continue
        email, token = info.get("email"), info.get("token")
        role = info.get("role")
        if ((role == "student" and email in active and email in roster and eagle._student_tokens.active(token)) or
                (role == "teacher" and socket_teacher(eagle, cls, email, token))):
            eagle.socketio.emit("group_project_tree_changed", data, to=sid)


def checked_project(eagle, db, project_id, class_id, email, *, ignore_schedule=False):
    project = project_record(db, project_id)
    if class_id != project["class_id"] or project["status"] != "active":
        raise ProjectError("This project is unavailable in the selected class", 403)
    must_open(student_class(eagle, class_id, email), ignore_schedule=ignore_schedule)
    return project, require_member(db, project, email)


def move_paths(eagle, db, project_id, items, old, new):
    destinations = {item["id"]: safe_path(eagle, new + item["path"][len(old):]) for item in items}
    occupied = {portable_path_key(row["path"]) for row in db.execute(
        "SELECT id,path FROM files WHERE project=? AND trash_id IS NULL", (project_id,)) if row["id"] not in destinations}
    require_unique_paths(destinations.values())
    if occupied.intersection(map(portable_path_key, destinations.values())):
        raise ProjectError("That file or folder name is already in use", 409)
    for file_id, destination in destinations.items():
        db.execute("UPDATE files SET path=?,trash_id=NULL,trashed_at=NULL WHERE id=?", (destination, file_id))


def subtree(db, project_id, path):
    return db.execute(
        "SELECT id,path,revision FROM files WHERE project=? AND trash_id IS NULL AND (path=? OR substr(path,1,?)=?)",
        (project_id, path, len(path) + 1, path + "/")).fetchall()


def mutate_tree(eagle, db, project, member, data):
    action = data.get("action")
    file_id = data.get("fileId")
    project_id = project["id"]
    if type(data.get("treeRevision")) is not int or data["treeRevision"] != project["tree_revision"]:
        raise ProjectError("The project folders changed. Review the current files and try again.", 409)
    if file_id is not None and not isinstance(file_id, str):
        raise ProjectError("Choose a project file")
    row = select_file(db, project_id, file_id) if file_id and action != "restore" else None
    if row and action in ("replace", "delete") and (type(data.get("revision")) is not int or data["revision"] != row["revision"]):
        raise ProjectError("This file changed. Refresh the project and try again.", 409)
    deleted = []
    if action == "delete":
        if not row or not project["folder"]:
            raise ProjectError("Choose a file or folder inside the project")
        items = subtree(db, project_id, row["path"])
        if row["folder"] and data.get("descendants") != sorted(
                [[item["id"], item["revision"]] for item in items if item["id"] != file_id]):
            raise ProjectError("Files in this folder changed. Review the folder before moving it to Trash.", 409)
        deleted = [item["id"] for item in items]
        deleted_at = int(time())
        db.executemany("UPDATE files SET path=? || path,trash_id=?,trashed_at=? WHERE id=?",
                       [(f".{file_id}/", file_id, deleted_at, item_id) for item_id in deleted])
    elif action == "renameProject":
        name = safe_path(eagle, data.get("path"))
        if not project["folder"] or "/" in name:
            raise ProjectError("Choose a project name")
        db.execute("UPDATE projects SET name=? WHERE id=?", (name, project_id))
    else:
        path = safe_path(eagle, data.get("path"))
        parent = str(PurePosixPath(path).parent)
        if parent != "." and not db.execute("SELECT 1 FROM files WHERE project=? AND path=? AND folder=1 AND trash_id IS NULL",
                                            (project_id, parent)).fetchone():
            raise ProjectError("Choose an existing parent folder")
        if action == "rename":
            if not row or (not project["folder"] and parent != ".") or path.startswith(row["path"] + "/"):
                raise ProjectError("Choose a destination outside the folder being moved")
            if not row["folder"] and Path(path).suffix.lower() != Path(row["path"]).suffix.lower():
                raise ProjectError("Keep the file extension when moving a shared file")
            old = row["path"]
            move_paths(eagle, db, project_id, subtree(db, project_id, old), old, path)
            if not project["folder"]:
                db.execute("UPDATE projects SET name=? WHERE id=?", (path, project_id))
        elif action == "restore":
            items = db.execute("SELECT id,path,folder,size FROM files WHERE project=? AND trash_id=? AND trashed_at>=?",
                               (project_id, file_id, int(time()) - RECOVERY_SECONDS)).fetchall()
            root = next((item for item in items if item["id"] == file_id), None)
            if root is None:
                raise ProjectError("This item is no longer in group Trash", 404)
            if not root["folder"] and Path(path).suffix.lower() != Path(root["path"]).suffix.lower():
                raise ProjectError("Keep the file extension when restoring a shared file")
            check_active_quota(db, project_id, (project["file_count"], project["node_count"], project["size"]),
                               sum(not item["folder"] for item in items), len(items), sum(item["size"] for item in items))
            move_paths(eagle, db, project_id, items, root["path"], path)
        elif action in ("new", "mkdir", "upload", "replace"):
            if not project["folder"] and action != "replace":
                raise ProjectError("Share a folder to work with multiple files")
            blob = b""
            if action in ("upload", "replace"):
                upload = request.files.get("file")
                if not upload:
                    raise ProjectError("Select a file to upload")
                blob = upload.stream.read(MAX_FILE_BYTES + 1)
                if len(blob) > MAX_FILE_BYTES:
                    raise ProjectError("The file exceeds the 10 MiB upload limit", 413)
            normalized = text_file(eagle, path, blob)
            if normalized is not None:
                blob = normalized.encode("utf-8")
            if action == "replace":
                if not row or row["folder"] or path != row["path"]:
                    raise ProjectError("Select an existing project file")
                original = select_file(db, project["id"], file_id, content=True)
                if text_file(eagle, path, original["content"]) is not None:
                    raise ProjectError("Edit shared text in the editor")
                check_quota(db, project["id"], project["class_id"], 0, 0, len(blob) - row["size"])
                if blob != original["content"]:
                    author = member_info(member)
                    authors = [p for p in json.loads(original["authors"]) if p["id"] != author["id"]] + [author]
                    spans = [[0, text_ops.length(normalized), author["id"]]] if normalized else []
                    db.execute("UPDATE files SET content=?,size=?,revision=revision+1,authors=?,spans=?,is_text=? WHERE id=?",
                               (blob, len(blob), json.dumps(authors), json.dumps(spans), int(normalized is not None), file_id))
            else:
                if any(portable_path_key(row["path"]) == portable_path_key(path) for row in db.execute(
                        "SELECT path FROM files WHERE project=? AND trash_id IS NULL", (project_id,))):
                    raise ProjectError("That file or folder name is already in use", 409)
                check_quota(db, project["id"], project["class_id"], int(action != "mkdir"), 1, len(blob))
                file_id = insert_file(eagle, db, project["id"], path, action == "mkdir", blob,
                                      author=member_info(member) if action == "upload" else None)
        else:
            raise ProjectError("Unknown project action")
    db.execute("UPDATE projects SET tree_revision=tree_revision+1,snapshot_revision=snapshot_revision+1,changed=? WHERE id=?",
               (int(time()), project_id))
    return file_id, deleted


def attachment(data, name):
    response = send_file(BytesIO(data), mimetype="application/octet-stream", as_attachment=True,
                         download_name=name, conditional=False)
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


def project_download(project, rows):
    if not project["folder"] and rows:
        return attachment(rows[0]["content"], Path(rows[0]["path"]).name)
    require_unique_paths([row["path"] for row in rows])
    output = BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
        for row in rows:
            archive.writestr(row["path"] + ("/" if row["folder"] else ""), row["content"])
    return attachment(output.getvalue(), project["name"] + ".zip")


def project_download_rows(db, project_id):
    return db.execute("SELECT path,folder,content FROM files WHERE project=? AND trash_id IS NULL ORDER BY path",
                      (project_id,)).fetchall()


def teacher_class(eagle, class_id):
    actor = eagle._require_teacher(request)
    cls = eagle._find_class_by_id(class_id)
    if not actor or not cls or identity(actor) != cls.get("teacher_email"):
        raise ProjectError("Only the class owner can manage group projects", 403)
    return cls, actor


def checked_teacher_project(db, project_id, cls, *, recovery=False):
    project = project_record(db, project_id)
    if project["class_id"] != cls["id"] or (project["status"] != "active" and
            (not recovery or project["changed"] < int(time()) - RECOVERY_SECONDS)):
        raise ProjectError("This project is unavailable", 404)
    return project


def register(app, eagle):
    def student():
        user = eagle._require_user(request)
        if not user:
            raise ProjectError("Student login required", 401)
        return user

    def json_body():
        if request.is_json and (request.content_length or 0) > 512 * 1024:
            raise ProjectError("This group edit is too large", 413)
        data = request.get_json(silent=True) if not request.files else request.form.to_dict()
        if not isinstance(data, dict):
            raise ProjectError("Invalid group project request")
        if request.files:
            try:
                for field in ("revision", "treeRevision"):
                    if field in data:
                        data[field] = int(data[field])
            except ValueError as exc:
                raise ProjectError("Invalid file revision") from exc
        return data

    @app.errorhandler(ProjectError)
    def group_error(error):
        return jsonify(ok=False, error=str(error)), error.status

    @app.get("/api/group-projects")
    def list_group_projects():
        email = identity(student())
        cls = student_class(eagle, request.args.get("classId"), email)
        allowed, reason = class_open(cls)
        with database(eagle) as db:
            return jsonify(ok=True, allowed=allowed, reason=reason, projects=projects_for(db, cls, email))

    @app.get("/api/group-projects/roster")
    def group_roster():
        user = student()
        cls = student_class(eagle, request.args.get("classId"), identity(user))
        must_open(cls)
        enrolled = set(cls.get("students", [])) - {identity(user)}
        students = [{"email": record["email"].lower(), "name": name_of(record)}
                    for record in eagle._load_users(require_available=True).get("users", [])
                    if record["email"].lower() in enrolled and record.get("enabled", True)
                    and record.get("role", "student") == "student"]
        return jsonify(ok=True, students=students)

    @app.post("/api/group-projects")
    def create_group_project():
        data = json_body()
        user = student()
        email = identity(user)
        class_id = data.get("classId")
        must_open(student_class(eagle, class_id, email))
        invites = data.get("invitees", [])
        if (not isinstance(invites, list) or len(invites) >= MAX_MEMBERS or
                any(not isinstance(value, str) or value == email for value in invites) or len(set(invites)) != len(invites)):
            raise ProjectError("Choose up to three classmates")
        safe_path(eagle, data.get("path"))
        if not _project_creation.admit(email):
            raise ProjectError("Several projects were created recently. Try again in a minute.", 429)
        with eagle._assignment_lock, file_provenance.lock(eagle._get_user_dir(email)):
            name, folder, items = import_workspace(eagle, user, data.get("path"))
        require_unique_paths([item[0] for item in items])
        with database(eagle) as db:
            cls = student_class(eagle, class_id, email)
            must_open(cls)
            invitees = [roster_student(eagle, cls, person) for person in invites]
            if not all(invitees):
                raise ProjectError("Choose current classmates", 403)
            prune(db)
            if db.execute("SELECT COUNT(*) FROM projects WHERE class_id=? AND status='active'", (class_id,)).fetchone()[0] >= MAX_PROJECTS:
                raise ProjectError("This class has reached its active project limit", 413)
            if db.execute("SELECT COUNT(*) FROM projects WHERE class_id=?", (class_id,)).fetchone()[0] >= MAX_PROJECTS * 3:
                raise ProjectError("This class has too many saved recovery copies. Try again after older copies expire.", 413)
            project_id = uuid4().hex
            db.execute("INSERT INTO projects(id,class_id,name,folder,owner,status,changed) VALUES (?,?,?,?,?,'active',?)",
                       (project_id, class_id, name, int(folder), email, int(time())))
            check_quota(db, project_id, class_id, sum(not row[1] for row in items), len(items), sum(len(row[2]) for row in items))
            add_member(db, project_id, user, "active")
            project = project_record(db, project_id)
            author = member_info(require_member(db, project, email))
            for person in invitees:
                add_member(db, project_id, person, "pending")
            try:
                for path, is_folder, blob, paste in items:
                    insert_file(eagle, db, project_id, path, is_folder, blob, paste, author)
            except sqlite3.IntegrityError as exc:
                raise ProjectError("The folder contains names that differ only in capitalization") from exc
            return jsonify(ok=True, project=summary(db, project, email=email, tree=True, cls=cls))

    @app.get("/api/group-projects/<project_id>")
    def get_group_project(project_id):
        user = student()
        email = identity(user)
        class_id = request.args.get("classId")
        assignment_id = request.args.get("assignmentId")
        if assignment_id:
            assignment = eagle._load_assignment(assignment_id, class_id)
            if (not assignment or assignment.get("targetClassId") != class_id or assignment.get("fileControl") or
                    assignment.get("assignmentType") == "lab_report" or not assignment.get("allowFileSubmission", True)):
                raise ProjectError("This assignment does not accept project files", 403)
            error = eagle.assignment_workflow.submission_error(eagle, assignment, user)
            if error:
                raise ProjectError(error, 403)
        with database(eagle) as db:
            project, _ = checked_project(eagle, db, project_id, class_id, email, ignore_schedule=bool(assignment_id))
            cls = student_class(eagle, project["class_id"], email)
            result = summary(db, project, email=email, tree=True, cls=cls)
            if assignment_id:
                for field in ("trash", "invitations", "invitedEmails"):
                    result.pop(field, None)
            return jsonify(ok=True, project=result)

    @app.post("/api/group-projects/<project_id>")
    def change_group_project(project_id):
        data = json_body()
        user = student()
        email = identity(user)
        action = data.get("action")
        with database(eagle) as db:
            project = project_record(db, project_id)
            cls = student_class(eagle, data.get("classId"), email)
            if project["class_id"] != cls["id"] or project["status"] != "active":
                raise ProjectError("This group project is unavailable", 403)
            if action not in ("decline", "leave"):
                must_open(cls)
            if action in ("accept", "decline"):
                require_member(db, project, email, states=("pending",))
                db.execute("UPDATE members SET state=?,joined=? WHERE project=? AND email=?",
                           ("active" if action == "accept" else "left", time_ns(), project_id, email))
                update_organizer(db, project_id)
            else:
                member = require_member(db, project, email)
                if action == "leave":
                    remove_member(db, project, member, "left")
                    revoke_project_watches(eagle, db, project_id, email)
                    return jsonify(ok=True)
                if action in ("invite", "cancelInvite"):
                    if project["owner"] != email:
                        raise ProjectError("Only the group organizer can manage invitations", 403)
                    if action == "cancelInvite":
                        cancel = db.execute("UPDATE members SET state='left' WHERE project=? AND author=? AND state='pending'",
                                            (project_id, data.get("memberId")))
                        if not cancel.rowcount:
                            raise ProjectError("This invitation is no longer pending", 409)
                    else:
                        invitee = data.get("email")
                        person = roster_student(eagle, cls, invitee) if isinstance(invitee, str) else None
                        if not person:
                            raise ProjectError("Choose a current classmate", 403)
                        add_member(db, project_id, person, "pending")
                else:
                    try:
                        file_id, deleted = mutate_tree(eagle, db, project, member, data)
                    except sqlite3.IntegrityError as exc:
                        raise ProjectError("That file or folder name is already in use", 409) from exc
                    db.commit()
                    for removed in deleted:
                        revoke_project_watches(eagle, db, project_id, file_id=removed)
                    deliver_tree_change(eagle, db, project, cls)
                    return jsonify(ok=True, fileId=file_id)
            bump(db, project_id)
            return jsonify(ok=True)

    def read_file(db, project_id, file_id, **extra):
        row = select_file(db, project_id, file_id)
        if row["folder"]:
            raise ProjectError("Open a project file")
        since = request.args.get("since", type=int)
        if since != row["revision"] or row["is_text"] is None:
            row = select_file(db, project_id, file_id, content=True)
        result = file_payload(eagle, db, row, since)
        viewers = live_viewers(eagle, db, project_id, file_id)
        return jsonify(ok=True, file=result, viewers=list(dict.fromkeys(w["author"] for w in viewers.values())), **extra)

    def save_file(db, project, member, file_id, data):
        row = select_file(db, project["id"], file_id, content=True)
        update = apply_edit(eagle, db, project, member, row, data)
        db.commit()
        if update:
            deliver_edit(eagle, db, project, row, update)
        return jsonify(ok=True, file=edit_receipt(eagle, db, row, data["revision"]))

    @app.route("/api/group-projects/<project_id>/files/<file_id>", methods=["GET", "POST"])
    def group_file(project_id, file_id):
        email = identity(student())
        with database(eagle) as db:
            if request.method == "GET":
                checked_project(eagle, db, project_id, request.args.get("classId"), email)
                return read_file(db, project_id, file_id)
            data = json_body()
            project, member = checked_project(eagle, db, project_id, data.get("classId"), email)
            return save_file(db, project, member, file_id, data)

    @app.get("/api/group-projects/<project_id>/download")
    def download_group_project(project_id):
        email = identity(student())
        cls = student_class(eagle, request.args.get("classId"), email)
        if not _download_slots.acquire(blocking=False):
            raise ProjectError("Project downloads are busy. Try again shortly.", 503)
        try:
            with database(eagle) as db:
                project = project_record(db, project_id)
                if project["class_id"] != cls["id"]:
                    raise ProjectError("Choose the project's class", 403)
                require_member(db, project, email)
                if project["status"] == "canceled":
                    if project["changed"] < int(time()) - RECOVERY_SECONDS:
                        raise ProjectError("This project recovery copy has expired", 404)
                else:
                    must_open(cls)
                file_id = request.args.get("fileId")
                if file_id:
                    file = select_file(db, project_id, file_id, content=True)
                    if file["folder"]:
                        raise ProjectError("Select a file to download")
                    return attachment(file["content"], Path(file["path"]).name)
                rows = project_download_rows(db, project_id)
            return project_download(project, rows)
        finally:
            _download_slots.release()

    @app.get("/api/teacher/group-projects/<project_id>/download")
    def teacher_download_group_project(project_id):
        cls, _ = teacher_class(eagle, request.args.get("classId"))
        if not _download_slots.acquire(blocking=False):
            raise ProjectError("Project downloads are busy. Try again shortly.", 503)
        try:
            with database(eagle) as db:
                project = checked_teacher_project(db, project_id, cls, recovery=True)
                rows = project_download_rows(db, project_id)
            return project_download(project, rows)
        finally:
            _download_slots.release()

    @app.get("/api/teacher/group-projects")
    def list_teacher_group_projects():
        cls, _ = teacher_class(eagle, request.args.get("classId"))
        with database(eagle) as db:
            projects = projects_for(db, cls, teacher=True)
            for project in projects:
                project["openFiles"] = []
                for file_id in {w["fileId"] for w in _watchers.values() if w["projectId"] == project["id"]}:
                    try:
                        row = select_file(db, project["id"], file_id)
                        viewers = live_viewers(eagle, db, project["id"], file_id)
                        if viewers:
                            project["openFiles"].append({"path": row["path"], "viewers": list(dict.fromkeys(w["author"] for w in viewers.values()))})
                    except ProjectError:
                        continue
            return jsonify(ok=True, projects=projects)

    @app.route("/api/teacher/group-projects/<project_id>", methods=["GET", "POST"])
    def teacher_group_project(project_id):
        cls, _ = teacher_class(eagle, request.args.get("classId"))
        with database(eagle) as db:
            project = checked_teacher_project(db, project_id, cls, recovery=request.method == "GET")
            if request.method == "POST":
                data = json_body()
                member_id = data.get("memberId")
                if not isinstance(member_id, str):
                    raise ProjectError("Choose a project member")
                member = db.execute("SELECT * FROM members WHERE project=? AND author=?",
                                    (project_id, member_id)).fetchone()
                if not member:
                    raise ProjectError("Member not found", 404)
                if data.get("action") == "remove" and member["state"] in ("active", "pending"):
                    remove_member(db, project, member, "removed")
                    revoke_project_watches(eagle, db, project_id, member["email"])
                elif data.get("action") == "reinstate" and member["state"] == "removed":
                    db.execute("UPDATE members SET state='left' WHERE project=? AND author=?", (project_id, member["author"]))
                else:
                    raise ProjectError("This membership has already changed", 409)
                return jsonify(ok=True)
            file_id = request.args.get("fileId")
            if file_id:
                row = select_file(db, project_id, file_id, content=True)
                if row["folder"]:
                    raise ProjectError("Choose a file to preview")
                if request.args.get("download") == "1":
                    return attachment(row["content"], Path(row["path"]).name)
                return jsonify(ok=True, file=file_payload(eagle, db, row))
            return jsonify(ok=True, project=summary(db, project, teacher=True, tree=True, cls=cls))

    @app.route("/api/teacher/group-projects/<project_id>/files/<file_id>", methods=["GET", "POST"])
    def teacher_group_file(project_id, file_id):
        cls, actor = teacher_class(eagle, request.args.get("classId"))
        with database(eagle) as db:
            project = checked_teacher_project(db, project_id, cls)
            member = teacher_member(db, project, actor)
            if request.method == "POST":
                return save_file(db, project, member, file_id, json_body())
            return read_file(db, project_id, file_id, own=member_info(member))

    def file_annotations(db, project, member, file_id):
        row = select_file(db, project["id"], file_id, content=request.method == "POST")
        if row["folder"] or row["size"] > text_ops.MAX_TEXT_BYTES or Path(row["path"]).suffix.lower() not in eagle.TEXT_EXTENSIONS:
            raise annotations.AnnotationError("Open a shared text file", 415)
        threads = annotations.group_read(db, file_id)
        revision = row["revision"]
        if request.method == "GET":
            return annotations.response(threads, revision=revision)
        data = annotations.request_data()
        if data.get("action") == "add" and (type(data.get("revision")) is not int or data["revision"] != revision):
            raise annotations.AnnotationError("The shared file changed. Sync before annotating.", 409)
        source = text_file(eagle, row["path"], row["content"])
        if source is None:
            raise annotations.AnnotationError("Open a shared text file", 415)
        thread_id = annotations.mutate(threads, data, member_info(member), member["email"], source)
        annotations.group_write(db, file_id, threads, thread_id)
        db.commit()
        deliver_annotations(eagle, project["id"], file_id, live_viewers(eagle, db, project["id"], file_id))
        return annotations.response(threads, revision=revision, threadId=thread_id)

    @app.route("/api/group-projects/<project_id>/files/<file_id>/annotations", methods=["GET", "POST"])
    def student_file_annotations(project_id, file_id):
        email = identity(student())
        with database(eagle) as db:
            project, member = checked_project(eagle, db, project_id, request.args.get("classId"), email)
            return file_annotations(db, project, member, file_id)

    @app.route("/api/teacher/group-projects/<project_id>/files/<file_id>/annotations", methods=["GET", "POST"])
    def teacher_file_annotations(project_id, file_id):
        cls, actor = teacher_class(eagle, request.args.get("classId"))
        with database(eagle) as db:
            project = checked_teacher_project(db, project_id, cls)
            return file_annotations(db, project, teacher_member(db, project, actor), file_id)

    def socket_access(db, payload):
        if not isinstance(payload, dict):
            raise ProjectError("Invalid project subscription")
        sid = request.sid
        info = eagle._socket_sid_info.get(sid) or {}
        token = info.get("token")
        class_id = payload.get("classId")
        role = info.get("role")
        if (role not in ("student", "teacher") or not token or not isinstance(class_id, str) or
                class_id not in eagle._socket_sid_rooms.get(sid, ())):
            raise ProjectError("Open this project's class to connect", 403)
        project_id, file_id = payload.get("projectId"), payload.get("fileId")
        if not isinstance(project_id, str) or not isinstance(file_id, str):
            raise ProjectError("Select a project file")
        if role == "teacher":
            cls = eagle._find_class_by_id(class_id)
            user = socket_teacher(eagle, cls, info["email"], token)
            if not user:
                raise ProjectError("Only the class owner can edit these group files", 403)
            project = checked_teacher_project(db, project_id, cls)
            member = teacher_member(db, project, user)
        else:
            if not eagle._student_tokens.active(token):
                raise ProjectError("Open this project's class to connect", 403)
            project, member = checked_project(eagle, db, project_id, class_id, info["email"])
        return sid, info, project, member, file_id

    @eagle.socketio.on("group_project_watch")
    def watch_group_project(payload):
        try:
            with database(eagle) as db:
                sid, info, project, member, file_id = socket_access(db, payload)
                row = select_file(db, project["id"], file_id)
                if row["folder"]:
                    raise ProjectError("Choose a project file")
                old = _watchers.get(sid)
                matching = (old and old["token"] == info["token"] and old["projectId"] == project["id"] and
                            old["fileId"] == file_id)
                if old and not matching:
                    close_watch(eagle, sid)
                _watchers[sid] = {"classId": project["class_id"], "projectId": project["id"], "fileId": file_id,
                                  "email": info["email"], "token": info["token"], "author": member["author"],
                                  "role": info["role"], "person": member_info(member),
                                  "expires": monotonic() + LEASE_SECONDS, "cursorAt": old["cursorAt"] if matching else 0,
                                  "cursorVisible": bool(matching and old["cursorVisible"])}
                return {"ok": True, "viewers": presence(eagle, db, project["id"], file_id),
                        "revision": row["revision"], "treeRevision": project["tree_revision"]}
        except ProjectError as error:
            return {"ok": False, "error": str(error), "status": error.status}

    @eagle.socketio.on("group_project_unwatch")
    def unwatch_group_project():
        close_watch(eagle, request.sid)

    @eagle.socketio.on("group_project_change")
    def edit_group_project(payload):
        try:
            with database(eagle) as db:
                sid, info, project, member, file_id = socket_access(db, payload)
                watch = _watchers.get(sid)
                if (not watch or watch["fileId"] != file_id or watch["token"] != info["token"] or
                        watch["expires"] <= monotonic()):
                    raise ProjectError("Reconnect to the group editor", 409)
                row = select_file(db, project["id"], file_id, content=True)
                update = apply_edit(eagle, db, project, member, row, payload)
                db.commit()
                if update:
                    deliver_edit(eagle, db, project, row, update)
                return {"ok": True, "file": edit_receipt(eagle, db, row, payload["revision"])}
        except ProjectError as error:
            return {"ok": False, "error": str(error), "status": error.status}

    @eagle.socketio.on("group_project_cursor")
    def cursor_group_project(payload):
        sid = request.sid
        with _lock:
            watch = _watchers.get(sid)
            now = monotonic()
            if not watch or not isinstance(payload, dict):
                return
            if watch["role"] == "teacher" and any(payload.get(key) != watch[key] for key in ("projectId", "fileId", "classId")):
                return
            position, revision = payload.get("position"), payload.get("revision")
            clear = "position" in payload and position is None and watch["role"] == "teacher"
            if clear and not watch["cursorVisible"]:
                return
            if (type(revision) is not int or (not clear and (type(position) is not int or
                    not 0 <= position <= text_ops.MAX_TEXT_BYTES or now - watch["cursorAt"] < .095))):
                return
            watch["cursorAt"] = 0 if clear else now
            with database(eagle) as db:
                try:
                    row = select_file(db, watch["projectId"], watch["fileId"])
                    if not clear and revision != row["revision"]:
                        return
                    viewers = live_viewers(eagle, db, watch["projectId"], watch["fileId"])
                except ProjectError:
                    return
                if sid not in viewers or len({w["author"] for w in viewers.values()}) < 2:
                    return
                watch["cursorVisible"] = not clear
                event = {"projectId": watch["projectId"], "fileId": watch["fileId"],
                         "position": position, "revision": revision, "author": watch["author"]}
                if watch["role"] == "teacher":
                    event["person"] = watch["person"]
                for other_sid in viewers:
                    if other_sid != sid:
                        eagle.socketio.emit("group_project_cursor", event, to=other_sid)


def revoke_project_watches(eagle, db, project_id, email="", file_id=""):
    for sid, watch in list(_watchers.items()):
        if (watch["projectId"] == project_id and (not email or watch["email"] == email) and
                (not file_id or watch["fileId"] == file_id)):
            _watchers.pop(sid, None)
            eagle.socketio.emit("group_project_access_changed", {"projectId": project_id, "fileId": file_id}, to=sid)

def checked_run_file(eagle, db, email, target, *, content=False):
    if (not isinstance(target, dict) or any(not isinstance(target.get(key), str)
            for key in ("classId", "projectId", "fileId")) or type(target.get("revision")) is not int):
        raise ProjectError("Open a saved group project file")
    project, _ = checked_project(eagle, db, target["projectId"], target["classId"], email)
    row = select_file(db, project["id"], target["fileId"], content=content)
    if row["folder"]:
        raise ProjectError("Choose a project file")
    return project, row


def run_access(eagle, email, target):
    with database(eagle) as db:
        _, row = checked_run_file(eagle, db, email, target)
        return row["path"]


def prepare_run(eagle, email, target):
    with database(eagle) as db:
        project, row = checked_run_file(eagle, db, email, target)
        if row["revision"] != target["revision"] or target.get("treeRevision", project["tree_revision"]) != project["tree_revision"]:
            raise ProjectError("The project changed. Sync and run again.", 409)
        return row["path"], project["snapshot_revision"]


def run_snapshot(eagle, email, target, directory, version):
    """Materialize a checked revision in disposable runner/preview storage."""
    with database(eagle) as db:
        project, row = checked_run_file(eagle, db, email, target, content=True)
        if project["snapshot_revision"] != version or row["revision"] != target["revision"]:
            raise ProjectError("The project changed before it could run. Sync and run again.", 409)
        source = text_file(eagle, row["path"], row["content"])
        if source is None:
            raise ProjectError("This project asset cannot be run")
        files = db.execute("SELECT path,folder,content FROM files WHERE project=? AND trash_id IS NULL ORDER BY path",
                           (project["id"],)).fetchall()
    require_unique_paths([file["path"] for file in files])
    for file in files:
        destination = directory.joinpath(*safe_path(eagle, file["path"]).split("/"))
        destination.resolve().relative_to(directory.resolve())
        if file["folder"]:
            destination.mkdir(parents=True, exist_ok=True)
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(file["content"])
    return directory.joinpath(*row["path"].split("/")), source
