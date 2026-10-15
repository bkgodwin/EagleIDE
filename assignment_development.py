"""Private, bounded assignment development history and controlled workspace files.

The small catalog indexes file bindings; each assignment owns a separate SQLite
database so completing grading actually returns its recording space to the OS.
Source never lives in the catalog or in student-visible assignment metadata.
"""
from __future__ import annotations

import json
import re
import sqlite3
import time
import zlib
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from flask import jsonify, request

import assignment_workflow as workflow
import file_provenance

MAX_SOURCE_BYTES = 2 * 1024 * 1024
MAX_BATCH_BYTES = 512 * 1024
MAX_BATCH_FRAMES = 30
MAX_STREAM_BYTES = 16 * 1024 * 1024
MAX_STREAM_FRAMES = 100_000
MAX_TOTAL_BYTES = 512 * 1024 * 1024
CHECKPOINT_EVERY = 120
PAGE_SIZE = 120
EXTENSIONS = {".py", ".js", ".html", ".css"}
_storage_cache = {}
_policy_cache = None


def invalidate_policy():
    global _policy_cache
    _policy_cache = None


def _policy_assignments(eagle):
    """Share small, source-free policy summaries across a classroom's probes."""
    global _policy_cache
    with eagle._assignment_lock:
        directory = eagle.ASSIGNMENTS_DIR
        signature = (str(directory.resolve()), directory.stat().st_mtime_ns if directory.exists() else 0)
        if _policy_cache and _policy_cache[0] == signature and time.monotonic() - _policy_cache[1] < 30:
            return _policy_cache[2]
        result = []
        fields = ("id", "targetClassId", "releasedAt", "active", "dueAt", "dueLockOverride", "studentExtensions",
                  "allowSubmissionAnyTime", "allowFileSubmission", "maxFileSubmissions", "quizSettings", "fileControl", "gradingCompletedAt")
        for assignment in eagle._list_assignments():
            row = {k: assignment.get(k) for k in fields}
            row["hasQuestions"] = bool((assignment.get("quiz") or {}).get("questions"))
            row["submissions"] = [{"email":s.get("email"), "withdrawn":s.get("withdrawn"),
                "files": [{}] if workflow.files_for(s) else [],
                "fileSubmissionCount":s.get("fileSubmissionCount", 0), "quizSubmissionCount":s.get("quizSubmissionCount", 0),
                "quizComplete":eagle._assignment_quiz_complete(assignment, s)[0]} for s in assignment.get("submissions", [])]
            result.append(row)
        _policy_cache = (signature, time.monotonic(), result)
        return result


class Conflict(ValueError):
    def __init__(self, content, version):
        self.content, self.version = content, version
        super().__init__("Recording changed in another tab. Resynchronizing history.")


def _directory(eagle):
    return eagle.ASSIGNMENTS_DIR / ".development"


def _path(eagle, assignment_id):
    if not re.fullmatch(r"[a-f0-9]{32}", assignment_id or ""):
        raise ValueError("Invalid assignment ID")
    return _directory(eagle) / f"{assignment_id}.sqlite3"


@contextmanager
def _database(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=10)
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA journal_mode=DELETE")
        db.execute("PRAGMA foreign_keys=ON")
        with db:
            yield db
    finally:
        db.close()


@contextmanager
def _catalog(eagle):
    with _database(_directory(eagle) / "index.sqlite3") as db:
        db.execute("CREATE TABLE IF NOT EXISTS bindings (assignment TEXT, email TEXT, path TEXT, workspace TEXT, "
                   "PRIMARY KEY(assignment,email), UNIQUE(email,path COLLATE NOCASE))")
        db.execute("CREATE INDEX IF NOT EXISTS binding_workspace ON bindings(workspace)")
        yield db


@contextmanager
def _history(eagle, assignment_id):
    with _database(_path(eagle, assignment_id)) as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS streams (
                email TEXT PRIMARY KEY, version INTEGER NOT NULL, content BLOB NOT NULL,
                bytes INTEGER NOT NULL DEFAULT 0, first_at TEXT, last_at TEXT,
                last_received TEXT, capped INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS frames (
                email TEXT, seq INTEGER, at TEXT, received TEXT, kind TEXT,
                patch BLOB, checkpoint BLOB, PRIMARY KEY(email,seq));
            CREATE TABLE IF NOT EXISTS batches (
                email TEXT, id TEXT, PRIMARY KEY(email,id));
        """)
        yield db


def _pack(value):
    return zlib.compress(value.encode("utf-8"), 3)


def _unpack(value):
    return zlib.decompress(value).decode("utf-8")


def splice(before, after):
    """A linear, Unicode-safe single replacement using browser UTF-16 offsets."""
    start, high = 0, min(len(before), len(after))
    while start < high:
        middle = (start + high + 1) // 2
        if before[:middle] == after[:middle]: start = middle
        else: high = middle - 1
    tail, high = 0, min(len(before), len(after)) - start
    while tail < high:
        middle = (tail + high + 1) // 2
        if before[len(before)-middle:] == after[len(after)-middle:]: tail = middle
        else: high = middle - 1
    return {"from": len(before[:start].encode("utf-16-le")) // 2,
            "delete": len(before[start:len(before) - tail].encode("utf-16-le")) // 2,
            "insert": after[start:len(after) - tail]}


def apply_patch(content, patch):
    if not isinstance(patch, dict):
        raise ValueError("Invalid code change")
    start, count, text = patch.get("from"), patch.get("delete"), patch.get("insert")
    if type(start) is not int or type(count) is not int or not isinstance(text, str) or start < 0 or count < 0:
        raise ValueError("Invalid code change")
    raw = content.encode("utf-16-le")
    if (start + count) * 2 > len(raw) or len(text.encode("utf-8")) > MAX_SOURCE_BYTES:
        raise ValueError("Code change exceeds the file bounds")
    try:
        value = (raw[:start * 2] + text.encode("utf-16-le") + raw[(start + count) * 2:]).decode("utf-16-le")
    except UnicodeError as exc:
        raise ValueError("Code change splits a Unicode character") from exc
    if len(value.encode("utf-8")) > MAX_SOURCE_BYTES:
        raise ValueError("Recording supports files up to 2 MB")
    return value


def validate_options(data, assignment=None):
    enabled = data.get("fileControl", (assignment or {}).get("fileControl", False))
    extension = data.get("fileControlExtension", (assignment or {}).get("fileControlExtension", ".py"))
    if type(enabled) is not bool or not isinstance(extension, str) or extension not in EXTENSIONS:
        raise ValueError("Choose a supported file-control language")
    if assignment and (enabled != assignment.get("fileControl", False) or extension != assignment.get("fileControlExtension", ".py")):
        raise ValueError("File control and its language are fixed when an assignment is created")
    if enabled and (data.get("allowFileSubmission", (assignment or {}).get("allowFileSubmission", True)) is False
                    or data.get("allowMultiFileSubmission", (assignment or {}).get("allowMultiFileSubmission", False))):
        raise ValueError("File control requires a single-file code assignment")
    return {"fileControl": enabled, "fileControlExtension": extension}


def binding(eagle, assignment_id, email):
    if not (_directory(eagle) / "index.sqlite3").exists():
        return None
    with _catalog(eagle) as db:
        row = db.execute("SELECT * FROM bindings WHERE assignment=? AND email=?", (assignment_id, email.lower())).fetchone()
        return dict(row) if row else None


def bindings_for_path(eagle, email, path):
    if not (_directory(eagle) / "index.sqlite3").exists():
        return []
    with _catalog(eagle) as db:
        return [dict(row) for row in db.execute("SELECT * FROM bindings WHERE email=? AND path=? COLLATE NOCASE", (email.lower(), path))]


def ensure_file(eagle, assignment, email):
    """Provision once, without ever overwriting or recreating an existing binding."""
    if not assignment.get("fileControl"):
        return None
    email = email.lower()
    with eagle._assignment_lock:
        existing = binding(eagle, assignment["id"], email)
        if existing:
            return existing
        state = workflow.student_state(eagle, assignment, email)
        if assignment.get("gradingCompletedAt") or state["isPast"]:
            return None
        root = eagle._get_user_dir(email)
        with file_provenance.lock(root), _catalog(eagle) as db:
            root.mkdir(parents=True, exist_ok=True)
            if eagle._count_files_in_folder(root) >= eagle.MAX_FILES_PER_FOLDER or eagle._count_all_files_for_user(root) >= eagle.MAX_FILES_PER_ACCOUNT:
                raise ValueError("Your workspace file limit prevents creating the assignment file. Free a file slot and refresh.")
            title = re.sub(r"[^\w .-]", "_", str(assignment.get("name") or "Assignment"))[:90].strip(" .") or "Assignment"
            if Path(title).suffix.lower() in EXTENSIONS:
                title = str(Path(title).with_suffix(""))
            extension = assignment.get("fileControlExtension", ".py")
            for index in range(1000):
                name = f"{title}{f' ({index + 1})' if index else ''}{extension}"
                target = eagle._validate_workspace_path(root, name)
                if not target or not eagle._valid_workspace_name(name):
                    name = f"Assignment-{assignment['id'][:8]}{extension}"
                    target = eagle._validate_workspace_path(root, name)
                if not target:
                    raise ValueError("Could not allocate the assignment file")
                try:
                    with target.open("x", encoding="utf-8"):
                        pass
                except FileExistsError:
                    continue
                try:
                    db.execute("INSERT INTO bindings VALUES (?,?,?,?)", (assignment["id"], email, name, str(root.resolve())))
                except Exception:
                    target.unlink(missing_ok=True)
                    raise
                eagle._invalidate_workspace_tree_cache(root)
                return {"assignment": assignment["id"], "email": email, "path": name}
            raise ValueError("Too many files share this assignment name")


def protected(eagle, assignment, email):
    if assignment.get("gradingCompletedAt"):
        return False
    state = workflow.student_state(eagle, assignment, email)
    due = state["dueAt"]
    return not due or not eagle._assignment_due_has_passed({"dueAt": due}) or state["deadlineOpen"]


def mutation_error(eagle, user, target):
    """All workspace identities, including parent folder operations, use this guard."""
    root = eagle._get_user_dir(user["email"]).resolve()
    try:
        relative = target.resolve().relative_to(root).as_posix()
    except ValueError:
        return "Invalid workspace path"
    for row in bindings_for_path(eagle, user["email"], relative):
        assignment = eagle._load_assignment(row["assignment"])
        current = eagle._find_user(user["email"]) or user
        if assignment and eagle._user_in_class(current, assignment.get("targetClassId")) and protected(eagle, assignment, user["email"]):
            return "This assignment file stays in Home until its effective deadline or grading is complete."
    return None


def recording_open(eagle, assignment, email):
    return bool(assignment.get("fileControl") and not assignment.get("gradingCompletedAt")
                and assignment.get("releasedAt") and protected(eagle, assignment, email))


def protected_paths(eagle, root):
    if not (_directory(eagle) / "index.sqlite3").exists():
        return []
    with eagle._assignment_lock, _catalog(eagle) as db:
        rows = [dict(r) for r in db.execute("SELECT * FROM bindings WHERE workspace=?", (str(root.resolve()),))]
    result = []
    for row in rows:
        assignment = eagle._load_assignment(row["assignment"])
        if assignment and eagle._user_in_class(eagle._find_user(row["email"]), assignment.get("targetClassId")) and protected(eagle, assignment, row["email"]):
            result.append(str((root / row["path"]).resolve()))
    return result


def _stream(db, email):
    row = db.execute("SELECT * FROM streams WHERE email=?", (email,)).fetchone()
    if not row:
        db.execute("INSERT INTO streams(email,version,content) VALUES (?,0,?)", (email, _pack("")))
        row = db.execute("SELECT * FROM streams WHERE email=?", (email,)).fetchone()
    return row


def _append(db, email, row, content, at, received, kind, change=None):
    before, seq = _unpack(row["content"]), row["version"] + 1
    if before == content:
        return row
    patch = _pack(json.dumps(change or splice(before, content), ensure_ascii=False, separators=(",", ":")))
    checkpoint = _pack(content) if seq == 1 or seq % CHECKPOINT_EVERY == 0 else None
    size = len(patch) + len(checkpoint or b"") + 160
    if row["bytes"] + size > MAX_STREAM_BYTES or seq > MAX_STREAM_FRAMES:
        raise ValueError("Recording storage limit reached; code can still be saved and submitted. Tell your teacher.")
    db.execute("INSERT INTO frames VALUES (?,?,?,?,?,?,?)", (email, seq, at, received, kind, patch, checkpoint))
    db.execute("UPDATE streams SET version=?,content=?,bytes=bytes+?,first_at=?,last_at=?,last_received=? WHERE email=?",
               (seq, _pack(content), size, min(row["first_at"] or at, at), max(row["last_at"] or at, at), received, email))
    return db.execute("SELECT * FROM streams WHERE email=?", (email,)).fetchone()


def read_info(eagle, user, target):
    with eagle._assignment_lock:
        return _read_info_locked(eagle, user, target)


def _read_info_locked(eagle, user, target):
    relative = target.relative_to(eagle._get_user_dir(user["email"]).resolve()).as_posix()
    rows = bindings_for_path(eagle, user["email"], relative)
    if not rows:
        return None
    row = rows[0]
    assignment = eagle._load_assignment(row["assignment"])
    if not assignment or not eagle._user_in_class(eagle._find_user(user["email"]) or user, assignment.get("targetClassId")):
        return None
    info = {"assignmentId": row["assignment"], "recording": recording_open(eagle, assignment, user["email"]),
            "protected": protected(eagle, assignment, user["email"]), "version": 0, "content": ""}
    if _path(eagle, row["assignment"]).exists():
        with _history(eagle, row["assignment"]) as db:
            stream = _stream(db, user["email"].lower())
            info.update(version=stream["version"], content=_unpack(stream["content"]))
    return info


def capture_save(eagle, user, target, content):
    """Record non-editor/API changes too; ordinary saves do not duplicate samples."""
    info = read_info(eagle, user, target)
    if not info or not info["recording"]:
        return
    with _history(eagle, info["assignmentId"]) as db:
        row = _stream(db, user["email"].lower())
        stamp = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
        saved = _append(db, user["email"].lower(), row, content, stamp, stamp, "workspace-save")
        return saved["version"]


def purge(eagle, assignment_id, *, remove_binding=False):
    path = _path(eagle, assignment_id)
    path.unlink(missing_ok=True)
    Path(str(path) + "-journal").unlink(missing_ok=True)
    _storage_cache.pop(str(_directory(eagle)), None)
    if remove_binding and (_directory(eagle) / "index.sqlite3").exists():
        with _catalog(eagle) as db:
            db.execute("DELETE FROM bindings WHERE assignment=?", (assignment_id,))


def _teacher_assignment(eagle, data, *, owner=False):
    actor = eagle._assignment_actor(request)
    if not actor:
        return None, (jsonify(ok=False, error="Teacher token required"), 401)
    assignment = eagle._load_assignment(str(data.get("assignmentId") or ""))
    if not assignment or not eagle._assignment_access(actor, assignment, owner_only=owner):
        return None, (jsonify(ok=False, error="Assignment unavailable"), 403)
    if owner and actor.get("is_coteacher"):
        return None, (jsonify(ok=False, error="Class owner required"), 403)
    return assignment, None


def register(app, eagle):
    @app.before_request
    def protect_workspace_file():
        if request.endpoint not in {"files_rename", "files_delete", "files_move"}:
            return None
        user = eagle._require_user_for_files(request)
        if not user or user.get("role") != "student":
            return None
        data = request.get_json(silent=True) or {}
        if not isinstance(data, dict):
            return None
        key = {"files_rename": "old_path", "files_delete": "path", "files_move": "src"}[request.endpoint]
        relative = data.get(key)
        if not isinstance(relative, str):
            return None
        target = eagle._validate_workspace_path(eagle._get_user_dir(user["email"]), relative)
        if target:
            with eagle._assignment_lock:
                error = mutation_error(eagle, user, target)
                if error:
                    return jsonify(ok=False, error=error), 403
        return None

    @app.get("/api/editor/policy")
    def editor_policy():
        user = eagle._require_user(request)
        if not user:
            return jsonify(ok=False, error="Student login required"), 401
        current = eagle._find_user(user["email"]) or user
        rules, next_changes = [], []
        assignments = None
        for class_id in eagle._get_user_class_ids(current):
            cls = eagle._find_class_by_id(class_id)
            if not cls:
                continue
            mode = (cls.get("settings") or {}).get("editor_clipboard", "allow")
            if mode == "block":
                rules.append(cls.get("name") or "Your class")
            elif mode == "outstanding":
                if assignments is None:
                    assignments = _policy_assignments(eagle)
                for assignment in assignments:
                    if assignment.get("targetClassId") != class_id or not assignment.get("releasedAt"):
                        continue
                    state = workflow.student_state(eagle, assignment, user["email"])
                    next_changes.extend(t for t in (state["dueAt"], state["nextWindowChangeAt"]) if t)
                    if not state["canSubmit"]:
                        continue
                    sub = next((s for s in assignment.get("submissions", []) if s.get("email", "").lower() == user["email"].lower()), {})
                    files_missing = assignment.get("allowFileSubmission", True) and (not workflow.files_for(sub) or sub.get("withdrawn"))
                    quiz_missing = assignment["hasQuestions"] and not sub.get("quizComplete", False)
                    for kind in ("file", "quiz"):
                        maximum = workflow.attempt_limit(eagle, assignment, user["email"], kind)
                        if maximum and sub.get(f"{kind}SubmissionCount", 0) >= maximum:
                            if kind == "file": files_missing = False
                            else: quiz_missing = False
                    if files_missing or quiz_missing:
                        rules.append(cls.get("name") or "Your class")
                        break
        return jsonify(ok=True, clipboardBlocked=bool(rules),
                       message="Copy, cut, paste, and text dropping are disabled in the editor by your class settings." if rules else "",
                       nextChangeAt=min((v for v in next_changes if not eagle._assignment_due_has_passed({"dueAt": v})), default=""))

    @app.post("/api/assignments/development/record")
    def record():
        user = eagle._require_user_for_files(request)
        if not user or user.get("role") != "student":
            return jsonify(ok=False, error="Student login required"), 401
        if not request.content_length or request.content_length > MAX_BATCH_BYTES:
            return jsonify(ok=False, error="Recording batch is too large"), 413
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return jsonify(ok=False, error="Invalid recording batch"), 400
        email = user["email"].lower()
        with eagle._assignment_lock:
            assignment = eagle._load_assignment(str(data.get("assignmentId") or ""))
            if not assignment or not assignment.get("fileControl") or not eagle._user_in_class(eagle._find_user(email) or user, assignment.get("targetClassId")):
                return jsonify(ok=False, error="Assignment unavailable"), 403
            if assignment.get("gradingCompletedAt"):
                return jsonify(ok=True, stopped=True)
            if not assignment.get("releasedAt") or not binding(eagle, assignment["id"], email):
                return jsonify(ok=False, error="Assignment file is unavailable"), 403
            frames, batch = data.get("frames"), data.get("batchId")
            if not isinstance(frames, list) or not 1 <= len(frames) <= MAX_BATCH_FRAMES or not isinstance(batch, str) or not re.fullmatch(r"[a-zA-Z0-9-]{8,80}", batch):
                return jsonify(ok=False, error="Invalid recording batch"), 400
            try:
                # A global bound includes SQLite overhead, not just inserted text.
                directory_key = str(_directory(eagle))
                checked, stored = _storage_cache.get(directory_key, (0, 0))
                if time.monotonic() - checked > 30:
                    stored = sum(p.stat().st_size for p in _directory(eagle).glob("*.sqlite3"))
                    _storage_cache[directory_key] = (time.monotonic(), stored)
                    while len(_storage_cache) > 8:
                        _storage_cache.pop(next(iter(_storage_cache)))
                if stored > MAX_TOTAL_BYTES:
                    raise ValueError("Server recording storage is full. Tell your teacher; code can still be saved.")
                with _history(eagle, assignment["id"]) as db:
                    stream = _stream(db, email)
                    if db.execute("SELECT 1 FROM batches WHERE email=? AND id=?", (email, batch)).fetchone():
                        return jsonify(ok=True, version=stream["version"])
                    if type(data.get("version")) is not int or data["version"] != stream["version"]:
                        raise Conflict(_unpack(stream["content"]), stream["version"])
                    stamp = datetime.now(timezone.utc)
                    received = stamp.isoformat(timespec="milliseconds")
                    student_state = workflow.student_state(eagle, assignment, email)
                    # A teacher may explicitly reopen work past its ordinary
                    # deadline without choosing a new one. Keep recording then.
                    due = "" if student_state["deadlineOpen"] and student_state["dueExpired"] else student_state["dueAt"]
                    earliest = datetime.fromisoformat(assignment["createdAt"].replace("Z", "+00:00"))
                    if not earliest.tzinfo:
                        earliest = earliest.astimezone(timezone.utc)
                    previous_at = None
                    for frame in frames:
                        if not isinstance(frame, dict) or not isinstance(frame.get("at"), str):
                            raise ValueError("Each change needs a timestamp")
                        at = datetime.fromisoformat(frame["at"].replace("Z", "+00:00"))
                        if not at.tzinfo or at < earliest or at.timestamp() > stamp.timestamp() + 60 or at.timestamp() < stamp.timestamp() - 7 * 86400:
                            raise ValueError("Recording timestamp is outside the allowed window")
                        if previous_at and at < previous_at:
                            raise ValueError("Recording timestamps must be ordered")
                        previous_at = at
                        if due and eagle._assignment_due_has_passed({"dueAt": due}, now=at):
                            continue
                        content = apply_patch(_unpack(stream["content"]), frame)
                        stream = _append(db, email, stream, content, at.astimezone(timezone.utc).isoformat(timespec="milliseconds"), received,
                                         "resync" if frame.get("resync") else "editor", {k:frame[k] for k in ("from","delete","insert")})
                    db.execute("INSERT INTO batches VALUES (?,?)", (email, batch))
                    # Retry identities are bounded independently of source history.
                    db.execute("DELETE FROM batches WHERE email=? AND rowid NOT IN (SELECT rowid FROM batches WHERE email=? ORDER BY rowid DESC LIMIT 100)", (email, email))
                    return jsonify(ok=True, version=stream["version"], stopped=not recording_open(eagle, assignment, email))
            except Conflict as exc:
                return jsonify(ok=False, error=str(exc), content=exc.content, version=exc.version), 409
            except (ValueError, TypeError, UnicodeError) as exc:
                return jsonify(ok=False, error=str(exc)), 400
            except (OSError, sqlite3.Error):
                return jsonify(ok=False, error="History could not be stored. Your code can still be saved."), 503

    @app.get("/api/assignments/development")
    def playback():
        with eagle._assignment_lock:
            assignment, error = _teacher_assignment(eagle, request.args)
            if error:
                return error
            if not assignment.get("fileControl"):
                return jsonify(ok=False, error="File control is not enabled"), 400
            email = str(request.args.get("studentEmail") or "").strip().lower()
            if not email:
                return jsonify(ok=False, error="Choose a student"), 400
            bound = binding(eagle, assignment["id"], email)
            if assignment.get("gradingCompletedAt") or not bound or not _path(eagle, assignment["id"]).exists():
                return jsonify(ok=True, total=0, frames=[], gradingCompletedAt=assignment.get("gradingCompletedAt", ""))
            try:
                cursor = max(1, int(request.args.get("cursor", 1)))
            except ValueError:
                return jsonify(ok=False, error="Invalid history position"), 400
            with _history(eagle, assignment["id"]) as db:
                row = _stream(db, email)
                if request.args.get("index") == "1":
                    # Sparse seek index: at most 834 entries for the frame cap.
                    marks = [dict(r) for r in db.execute("SELECT seq,at FROM frames WHERE email=? AND (seq=1 OR seq%?=0 OR seq=?) ORDER BY seq", (email, CHECKPOINT_EVERY, row["version"]))]
                    return jsonify(ok=True, total=row["version"], firstAt=row["first_at"], lastAt=row["last_at"], marks=marks, path=bound["path"])
                cursor = min(cursor, max(1, row["version"]))
                checkpoint = db.execute("SELECT seq,checkpoint FROM frames WHERE email=? AND seq<? AND checkpoint IS NOT NULL ORDER BY seq DESC LIMIT 1", (email, cursor)).fetchone()
                base, start = (_unpack(checkpoint["checkpoint"]), checkpoint["seq"]) if checkpoint else ("", 0)
                for f in db.execute("SELECT patch FROM frames WHERE email=? AND seq>? AND seq<? ORDER BY seq", (email, start, cursor)):
                    base = apply_patch(base, json.loads(_unpack(f["patch"])))
                frames, size = [], 0
                for f in db.execute("SELECT * FROM frames WHERE email=? AND seq>=? ORDER BY seq LIMIT ?", (email, cursor, PAGE_SIZE)):
                    patch = json.loads(_unpack(f["patch"]))
                    size += len(patch["insert"].encode("utf-8")) + 200
                    if frames and size > MAX_BATCH_BYTES:
                        break
                    frames.append({"seq": f["seq"], "at": f["at"], "receivedAt": f["received"], "kind": f["kind"], **patch})
                return jsonify(ok=True, total=row["version"], base=base, frames=frames,
                               nextCursor=frames[-1]["seq"] + 1 if frames and frames[-1]["seq"] < row["version"] else None)

    @app.post("/api/assignments/grading-complete")
    def complete():
        data = request.get_json(silent=True) or {}
        if not isinstance(data, dict):
            return jsonify(ok=False, error="Invalid request"), 400
        with eagle._assignment_lock:
            assignment, error = _teacher_assignment(eagle, data, owner=True)
            if error:
                return error
            if not assignment.get("fileControl"):
                return jsonify(ok=False, error="File control is not enabled"), 400
            if not assignment.get("gradingCompletedAt"):
                assignment["gradingCompletedAt"] = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
                assignment["active"] = False
                assignment["dueLockOverride"] = False
                if not eagle._save_assignment(assignment):
                    return jsonify(ok=False, error="Could not mark grading complete"), 500
            try:
                purge(eagle, assignment["id"])
            except (OSError, sqlite3.Error):
                return jsonify(ok=False, error="Grading is complete, but recording cleanup failed. Retry this action."), 503
        eagle.socketio.emit("assignment_workflow_updated", {"classId": assignment.get("targetClassId")}, to=f"class_{assignment.get('targetClassId')}")
        return jsonify(ok=True, gradingCompletedAt=assignment["gradingCompletedAt"])
