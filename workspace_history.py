"""Private, bounded student editor history and submission-scoped playback."""
from __future__ import annotations

from concurrent.futures import Future, TimeoutError
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
from queue import Full, Queue
import re
import shutil
import sqlite3
import threading
import time
import uuid
import zlib

from flask import jsonify, request

import assignment_development as legacy
import assignment_workflow as workflow
import file_provenance

MAX_TEXT = 256 * 1024
MAX_REQUEST = 384 * 1024
MAX_PAGE = 384 * 1024
MAX_FRAMES = 15
PAGE_FRAMES = 60
CHECKPOINT = 120
ROLLING_AGE = 14 * 86400
PURGE_DEADLINE = 3 * 86400
MAX_STORAGE = 2 * 1024 ** 3
MAX_ROLLING = 1024 ** 3
MAX_ACCOUNT = 64 * 1024 ** 2
MAX_FILE = 16 * 1024 ** 2
MIN_FREE = 256 * 1024 ** 2
HEX = re.compile(r"[a-f0-9]{32}")
KINDS = {".py", ".js", ".html", ".css", ".txt", ".md", ".json", ".csv"}
_initialized = set()
_schema_lock = threading.Lock()
_jobs = Queue(maxsize=64)
_worker_lock = threading.Lock()
_worker = None
_last_batches = {}
_rate_lock = threading.Lock()
_disk_stats = {}
_pending_lock = threading.Lock()
_pending_counts = {}
_maintenance_ready = threading.Event()
_maintenance_started = False


class Conflict(Exception):
    def __init__(self, version):
        self.version = version


class Capacity(Exception):
    pass


def root(eagle):
    return eagle.ASSIGNMENTS_DIR / ".workspace-history"


def available():
    return os.getenv("EAGLE_WORKSPACE_HISTORY_ENABLED", "1") != "0"


def _owner(workspace):
    return hashlib.sha256(os.path.normcase(str(workspace.resolve())).encode()).hexdigest()


def _canonical(text):
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _hash(text):
    return hashlib.sha256(text.encode("utf-8")).digest()


def _pack(text):
    return zlib.compress(text.encode("utf-8"), 3)


def _unpack(data):
    return zlib.decompress(data).decode("utf-8")


@contextmanager
def database(eagle, *, write=False, create=True):
    path = root(eagle) / "history.sqlite3"
    if not path.is_file() and not create:
        yield None
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=.25)
    db.row_factory = sqlite3.Row
    try:
        if path not in _initialized:
            with _schema_lock:
                db.execute("PRAGMA auto_vacuum=INCREMENTAL")
                db.execute("PRAGMA journal_mode=WAL")
                db.executescript("""
                    CREATE TABLE IF NOT EXISTS files (
                      id TEXT PRIMARY KEY, owner TEXT NOT NULL, path TEXT, fingerprint TEXT,
                      version INTEGER NOT NULL DEFAULT 0, head BLOB, ranges BLOB,
                      digest BLOB, used INTEGER NOT NULL DEFAULT 0, UNIQUE(owner,path));
                    CREATE TABLE IF NOT EXISTS frames (
                      file TEXT, seq INTEGER, edited REAL, received REAL, kind TEXT,
                      patch BLOB, checkpoint BLOB, ranges BLOB, digest BLOB, size INTEGER,
                      PRIMARY KEY(file,seq));
                    CREATE INDEX IF NOT EXISTS frame_expiry ON frames(received,file);
                    CREATE INDEX IF NOT EXISTS frame_file_time ON frames(file,received,seq);
                    CREATE INDEX IF NOT EXISTS frame_hash ON frames(file,digest,seq);
                    CREATE INDEX IF NOT EXISTS frame_checkpoint ON frames(file,seq) WHERE checkpoint IS NOT NULL;
                    CREATE TABLE IF NOT EXISTS batches (
                      file TEXT, id TEXT, version INTEGER, received REAL, PRIMARY KEY(file,id));
                    CREATE TABLE IF NOT EXISTS clips (
                      assignment TEXT, student TEXT, revision TEXT, attachment TEXT, name TEXT,
                      file TEXT, first INTEGER, last INTEGER, submitted REAL, partial INTEGER,
                      PRIMARY KEY(assignment,revision,attachment));
                    CREATE INDEX IF NOT EXISTS clip_frames ON clips(file,first,last);
                    CREATE INDEX IF NOT EXISTS clip_student ON clips(assignment,student,submitted DESC);
                    CREATE TABLE IF NOT EXISTS cleanup (
                      assignment TEXT PRIMARY KEY, due REAL, completed REAL);
                    CREATE TABLE IF NOT EXISTS storage (
                      id INTEGER PRIMARY KEY CHECK(id=1), bytes INTEGER NOT NULL, pinned INTEGER NOT NULL);
                    INSERT OR IGNORE INTO storage VALUES(1,0,0);
                """)
                _initialized.add(path)
                _maintenance_ready.set()
        if write:
            db.execute("PRAGMA secure_delete=ON")
            db.execute("BEGIN IMMEDIATE")
        with db:
            yield db
    finally:
        db.close()


def _eligible(eagle, user, workspace, target, size):
    return (available() and user.get("role") == "student" and size <= MAX_TEXT
            and target.suffix.lower() in KINDS and not eagle._is_trash_path(workspace, target)
            and bool(eagle._get_user_class_ids(user)))


def _fingerprint(target):
    stat = target.stat()
    return f"{stat.st_dev}:{stat.st_ino}:{getattr(stat, 'st_birthtime_ns', '')}"


def open_file(eagle, user, workspace, target, size):
    if not _eligible(eagle, user, workspace, target, size):
        return None
    workspace = workspace.resolve()
    path = target.relative_to(workspace).as_posix()
    owner = _owner(workspace)
    fingerprint = _fingerprint(target)
    with database(eagle) as db:
        row = db.execute("SELECT id,version,fingerprint FROM files WHERE owner=? AND path=?", (owner, path)).fetchone()
    if row and row["fingerprint"] == fingerprint:
        return {"id": row["id"], "version": row["version"]}
    with database(eagle, write=True) as db:
        db.execute("UPDATE files SET path=NULL WHERE owner=? AND path=? AND fingerprint<>?", (owner, path, fingerprint))
        db.execute("INSERT OR IGNORE INTO files(id,owner,path,fingerprint) VALUES(?,?,?,?)",
                   (uuid.uuid4().hex, owner, path, fingerprint))
        return dict(db.execute("SELECT id,version FROM files WHERE owner=? AND path=?", (owner, path)).fetchone())


def move(eagle, workspace, source, destination=None):
    """Preserve recorded identities across a file or folder move."""
    workspace = workspace.resolve()
    old = source.relative_to(workspace).as_posix()
    new = destination.relative_to(workspace).as_posix() if destination else None
    try:
        with database(eagle, write=True, create=False) as db:
            if db is None:
                return
            owner = _owner(workspace)
            rows = db.execute("SELECT id,path FROM files WHERE owner=? AND (path=? OR substr(path,1,?)=?)",
                              (owner, old, len(old) + 1, old + "/")).fetchall()
            for row in rows:
                path = new + row["path"][len(old):] if new else None
                if path:
                    db.execute("UPDATE files SET path=NULL WHERE owner=? AND path=? AND id<>?", (owner, path, row["id"]))
                db.execute("UPDATE files SET path=? WHERE id=?", (path, row["id"]))
    except (sqlite3.Error, OSError):
        eagle._append_server_log("Workspace history could not follow a workspace move.", level="WARN")


def clear_workspace(eagle, workspace):
    with database(eagle, write=True, create=False) as db:
        if db is not None:
            db.execute("UPDATE files SET path=NULL WHERE owner=?", (_owner(workspace),))


def _reserve(eagle, db, row, size):
    stored, pinned = db.execute("SELECT bytes,pinned FROM storage WHERE id=1").fetchone()
    account = db.execute("SELECT COALESCE(SUM(used),0) FROM files WHERE owner=?", (row["owner"],)).fetchone()[0]
    directory = root(eagle)
    now = time.monotonic()
    checked, physical, free = _disk_stats.get(directory, (float("-inf"), 0, 0))
    if now - checked >= 2:
        physical = sum(path.stat().st_size for path in directory.glob("history.sqlite3*") if path.is_file())
        free = shutil.disk_usage(directory).free
        _disk_stats[directory] = (now, physical, free)
        if len(_disk_stats) > 16:
            _disk_stats.pop(next(iter(_disk_stats)))
    if (stored + size > MAX_STORAGE or stored - pinned + size > MAX_ROLLING or physical > MAX_STORAGE * 1.2
            or account + size > MAX_ACCOUNT or row["used"] + size > MAX_FILE
            or free < MIN_FREE):
        raise Capacity("History storage is full. You can still save and turn in work.")


def _patch_ranges(before_ranges, patch, content):
    start, end = patch["from"], patch["from"] + patch["delete"]
    shift = file_provenance.length(patch["insert"]) - patch["delete"]
    ranges = []
    for left, right in before_ranges:
        if left < start:
            ranges.append([left, min(right, start)])
        if right > end:
            ranges.append([max(left, end) + shift, right + shift])
    return file_provenance.normalize(ranges, content)


def _apply(content, patch):
    start, count, inserted = patch["from"], patch["delete"], patch["insert"]
    if content.isascii() and type(start) is int and type(count) is int and isinstance(inserted, str) \
            and 0 <= start <= start + count <= len(content) and len(inserted) <= MAX_TEXT:
        # ASCII offsets equal UTF-16 offsets. Avoid re-encoding every small edit.
        return content[:start] + inserted + content[start + count:]
    return legacy.apply_patch(content, patch)


def _frame(file_id, seq, at, received, kind, before, content, ranges, patch=None):
    blob = _pack(json.dumps(patch if patch is not None else legacy.splice(before, content), ensure_ascii=False, separators=(",", ":")))
    checkpoint = _pack(content) if kind in ("baseline", "resync") or seq % CHECKPOINT == 0 else None
    ranges_blob = _pack(json.dumps(ranges, separators=(",", ":"))) if ranges else None
    digest = _hash(content)
    return (file_id, seq, at, received, kind, blob, checkpoint, ranges_blob, digest,
            len(blob) + len(checkpoint or b"") + len(ranges_blob or b"") + 192)


def _record(eagle, owner, file_id, data, received, workspace=None):
    with database(eagle, write=True, create=False) as db:
        row = db.execute("SELECT * FROM files WHERE owner=? AND id=?", (owner, file_id)).fetchone() if db else None
        if not row or row["path"] is None or row["path"].split("/", 1)[0].casefold() == eagle.TRASH_DIR_NAME.casefold():
            raise ValueError("Reopen this workspace file before recording")
        if workspace is not None:
            target = eagle._validate_workspace_path(workspace, row["path"])
            if not target or not target.is_file() or _fingerprint(target) != row["fingerprint"]:
                raise ValueError("Reopen this workspace file before recording")
        version = row["version"]
        retry = db.execute("SELECT version FROM batches WHERE file=? AND id=?", (file_id, data["batchId"])).fetchone()
        if retry:
            return retry["version"]
        if version != data["version"]:
            raise Conflict(version)
        base = data.get("base")
        content = _unpack(row["head"]) if row["head"] is not None else ""
        ranges = json.loads(_unpack(row["ranges"])) if row["ranges"] else []
        records = []
        if base is not None:
            if not isinstance(base, str) or len(base.encode("utf-8")) > MAX_TEXT:
                raise ValueError("History checkpoint is too large")
            base = _canonical(base)
            base_ranges = file_provenance.normalize(data.get("baseRanges", []), base)
            if row["head"] is None or base != content or base_ranges != ranges:
                version += 1
                baseline_at = min(received, data["frames"][0]["at"]) if data["frames"] else received
                records.append(_frame(file_id, version, baseline_at, received, "baseline" if row["head"] is None else "resync",
                                      content, base, base_ranges))
            content, ranges = base, base_ranges
        elif row["head"] is None:
            raise Conflict(version)
        for entry in data["frames"]:
            patch = {key: entry.get(key) for key in ("from", "delete", "insert")}
            next_content = _apply(content, patch)
            if len(next_content.encode("utf-8")) > MAX_TEXT:
                raise Capacity("This file exceeds the detailed history limit.")
            next_ranges = (file_provenance.normalize(entry["pasteRanges"], next_content)
                           if "pasteRanges" in entry else _patch_ranges(ranges, patch, next_content))
            if next_content != content or next_ranges != ranges:
                version += 1
                kind = "offline" if received - entry["at"] > 60 else "editor"
                records.append(_frame(file_id, version, entry["at"], received, kind, content, next_content, next_ranges, patch))
            content, ranges = next_content, next_ranges
        if records:
            size = sum(record[-1] for record in records)
            head = _pack(content)
            packed_ranges = _pack(json.dumps(ranges)) if ranges else None
            head_delta = len(head) + len(packed_ranges or b"") - len(row["head"] or b"") - len(row["ranges"] or b"")
            _reserve(eagle, db, row, size + head_delta)
            db.executemany("INSERT INTO frames VALUES(?,?,?,?,?,?,?,?,?,?)", records)
            db.execute("UPDATE files SET version=?,head=?,ranges=?,digest=?,used=used+? WHERE id=?",
                       (version, head, packed_ranges, records[-1][-2], size + head_delta, file_id))
            db.execute("UPDATE storage SET bytes=bytes+? WHERE id=1", (size + head_delta,))
        db.execute("INSERT INTO batches VALUES(?,?,?,?)", (file_id, data["batchId"], version, received))
        db.execute("DELETE FROM batches WHERE file=? AND id NOT IN (SELECT id FROM batches WHERE file=? ORDER BY received DESC LIMIT 32)", (file_id, file_id))
        return version


def _process_jobs():
    while True:
        job, future = _jobs.get()
        if not future.set_running_or_notify_cancel():
            continue
        try:
            future.set_result(job())
        except Exception as exc:
            future.set_exception(exc)


def _enqueue(job):
    global _worker
    with _worker_lock:
        if _worker is None:
            _worker = threading.Thread(target=_process_jobs, name="workspace-history-writer", daemon=True)
            _worker.start()
    result = Future()
    _jobs.put_nowait((job, result))
    return result


def capture_checkpoint(eagle, user, workspace, target, content=None, ranges=(), *, replaced=None):
    """Best-effort checkpoints for writes without a live editor sample."""
    if not _maintenance_started:
        return
    try:
        size = len(content.encode("utf-8")) if content is not None else target.stat().st_size
    except OSError:
        return
    if not _eligible(eagle, user, workspace, target, size):
        return
    received = time.time()
    directory = root(eagle)
    def checkpoint():
        if root(eagle) != directory or not target.is_file() or target.stat().st_size > MAX_TEXT:
            return
        # A queued old save must never become a checkpoint for a replacement.
        current = target.read_text(encoding="utf-8")
        if content is not None and _canonical(current) != _canonical(content):
            return
        if replaced:
            with database(eagle, write=True, create=False) as db:
                if db is not None:
                    db.execute("UPDATE files SET fingerprint=? WHERE owner=? AND path=? AND fingerprint=?",
                               (_fingerprint(target), _owner(workspace), target.relative_to(workspace.resolve()).as_posix(), replaced))
        info = open_file(eagle, user, workspace, target, len(current.encode("utf-8")))
        if info:
            _record(eagle, _owner(workspace), info["id"], {"version": info["version"], "base": current,
                    "baseRanges": ranges, "batchId": uuid.uuid4().hex, "frames": []}, received, workspace)
    try:
        _enqueue(checkpoint)
    except Full:
        pass


def submission_source(eagle, workspace, target, content):
    if target.suffix.lower() not in KINDS or len(content) > MAX_TEXT:
        return None
    with database(eagle, create=False) as db:
        if db is None:
            return None
        row = db.execute("SELECT id FROM files WHERE owner=? AND path=? AND fingerprint=?",
                         (_owner(workspace), target.relative_to(workspace.resolve()).as_posix(), _fingerprint(target))).fetchone()
        return {"file": row["id"], "digest": _hash(_canonical(content.decode("utf-8"))).hex()} if row else None


def _intent_path(eagle, assignment_id, revision):
    if not HEX.fullmatch(assignment_id or "") or not HEX.fullmatch(revision or ""):
        raise ValueError("Invalid history revision")
    return root(eagle) / "pending" / (assignment_id + "-" + revision + ".json")


def prepare_submission(eagle, assignment, student, revision, files, sources):
    if not sources:
        return None
    submitted = time.time()
    release = assignment.get("releasedAt", "")
    try:
        released = datetime.fromisoformat(release.replace("Z", "+00:00"))
        released = (released if released.tzinfo else released.replace(tzinfo=timezone.utc)).timestamp()
    except ValueError:
        released = 0
    path = _intent_path(eagle, assignment["id"], revision)
    payload = {"assignment": assignment["id"], "student": student, "revision": revision,
               "submitted": submitted, "first": max(submitted - ROLLING_AGE, released),
               "files": [{**sources[f["id"]], "name": f["name"], "attachment": f["id"]}
                         for f in files if f["id"] in sources]}
    with _pending_lock:
        count = _pending_counts.get(path.parent)
        if count is None:
            count = sum(1 for _ in path.parent.glob("*.json"))
        if count >= 2048:
            raise Capacity("History is catching up")
        path.parent.mkdir(parents=True, exist_ok=True)
        eagle._write_json_file_atomic(path, payload)
        _pending_counts[path.parent] = count + 1
        if len(_pending_counts) > 32:
            _pending_counts.pop(next(iter(_pending_counts)))
    return path


def discard_intent(path):
    with _pending_lock:
        try:
            path.unlink()
        except FileNotFoundError:
            return
        if path.parent in _pending_counts:
            _pending_counts[path.parent] = max(0, _pending_counts[path.parent] - 1)


def _state_at(db, file_id, seq):
    row = db.execute("SELECT seq,checkpoint FROM frames WHERE file=? AND seq<=? AND checkpoint IS NOT NULL ORDER BY seq DESC LIMIT 1",
                     (file_id, seq)).fetchone()
    if not row:
        return "", 0
    content = _unpack(row["checkpoint"])
    for frame in db.execute("SELECT patch FROM frames WHERE file=? AND seq>? AND seq<=? ORDER BY seq", (file_id, row["seq"], seq)):
        content = _apply(content, json.loads(_unpack(frame["patch"])))
    return content, row["seq"]


def _promote_checkpoint(db, file_id, seq):
    row = db.execute("SELECT checkpoint FROM frames WHERE file=? AND seq=?", (file_id, seq)).fetchone()
    if row and row["checkpoint"] is None:
        content, _ = _state_at(db, file_id, seq)
        blob = _pack(content)
        db.execute("UPDATE frames SET checkpoint=?,size=size+? WHERE file=? AND seq=?", (blob, len(blob), file_id, seq))
        db.execute("UPDATE files SET used=used+? WHERE id=?", (len(blob), file_id))
        db.execute("UPDATE storage SET bytes=bytes+? WHERE id=1", (len(blob),))
        if db.execute("SELECT 1 FROM clips WHERE file=? AND ? BETWEEN first AND last LIMIT 1", (file_id, seq)).fetchone():
            db.execute("UPDATE storage SET pinned=pinned+? WHERE id=1", (len(blob),))


def _unshared_bytes(db, file_id, first, last):
    return db.execute("""SELECT COALESCE(SUM(size),0) FROM frames AS f
        WHERE file=? AND seq BETWEEN ? AND ?
        AND NOT EXISTS(SELECT 1 FROM clips AS c WHERE c.file=f.file AND f.seq BETWEEN c.first AND c.last)""",
        (file_id, first, last)).fetchone()[0]


def _release_clips(db, assignment_id):
    clips = db.execute("SELECT * FROM clips WHERE assignment=?", (assignment_id,))
    for clip in clips.fetchall():
        db.execute("DELETE FROM clips WHERE assignment=? AND revision=? AND attachment=?",
                   (assignment_id, clip["revision"], clip["attachment"]))
        size = _unshared_bytes(db, clip["file"], clip["first"], clip["last"])
        db.execute("UPDATE storage SET pinned=pinned-? WHERE id=1", (size,))


def _pin(eagle, path):
    if not path.exists():
        return
    intent = eagle._read_json_file(path, {})
    if not intent:
        discard_intent(path)
        return
    assignment_id, revision = intent["assignment"], intent["revision"]
    with eagle._assignment_lock:
        assignment = eagle._load_assignment(assignment_id)
        valid = assignment and not assignment.get("gradingCompletedAt") and (intent.get("accepted") or any(
            row.get("revisionId") == revision
            for sub in assignment.get("submissions", []) if sub.get("email") == intent["student"]
            for row in (sub, *sub.get("history", []))))
    if valid:
        with database(eagle, write=True, create=False) as db:
            if db is not None:
                if db.execute("SELECT 1 FROM cleanup WHERE assignment=?", (assignment_id,)).fetchone():
                    return
                for f in intent["files"]:
                    key = (assignment_id, revision, f["attachment"])
                    if db.execute("SELECT 1 FROM clips WHERE assignment=? AND revision=? AND attachment=?", key).fetchone():
                        continue
                    bounds = db.execute("SELECT MIN(seq) first,MAX(seq) last FROM frames WHERE file=? AND received BETWEEN ? AND ?",
                                        (f["file"], intent["first"], intent["submitted"])).fetchone()
                    if bounds["first"] is None:
                        continue
                    exact = db.execute("SELECT MAX(seq) FROM frames WHERE file=? AND digest=? AND seq BETWEEN ? AND ?",
                                       (f["file"], bytes.fromhex(f["digest"]), bounds["first"], bounds["last"])).fetchone()[0]
                    first, last = bounds["first"], exact or bounds["last"]
                    _promote_checkpoint(db, f["file"], first)
                    size = _unshared_bytes(db, f["file"], first, last)
                    db.execute("INSERT INTO clips VALUES(?,?,?,?,?,?,?,?,?,?)",
                               (assignment_id, intent["student"], revision, f["attachment"], f["name"],
                                f["file"], first, last, intent["submitted"], int(exact is None)))
                    db.execute("UPDATE storage SET pinned=pinned+? WHERE id=1", (size,))
    discard_intent(path)


def pin_after_commit(eagle, path):
    if path is not None:
        try:
            intent = eagle._read_json_file(path, {})
            if intent:
                intent["accepted"] = True
                eagle._write_json_file_atomic(path, intent)
            _maintenance_ready.set()
        except OSError:
            pass  # The durable intent is picked up by maintenance.


def schedule_cleanup(eagle, assignment_id, finalized_at):
    finalized = datetime.fromisoformat(finalized_at.replace("Z", "+00:00"))
    if finalized.tzinfo is None:
        finalized = finalized.replace(tzinfo=timezone.utc)
    with database(eagle, write=True) as db:
        db.execute("INSERT OR IGNORE INTO cleanup VALUES(?,?,NULL)", (assignment_id, finalized.timestamp() + PURGE_DEADLINE))
    _maintenance_ready.set()


def delete_assignment(eagle, assignment_id):
    with database(eagle, write=True, create=False) as db:
        if db is not None:
            _release_clips(db, assignment_id)
            db.execute("INSERT OR REPLACE INTO cleanup VALUES(?,?,?)", (assignment_id, time.time(), time.time()))


def _discard_frames(db, rows):
    totals = {}
    for row in rows:
        totals[row["file"]] = totals.get(row["file"], 0) + row["size"]
    db.executemany("DELETE FROM frames WHERE file=? AND seq=?", ((row["file"], row["seq"]) for row in rows))
    db.executemany("UPDATE files SET used=used-? WHERE id=?", ((size, file_id) for file_id, size in totals.items()))
    db.execute("UPDATE storage SET bytes=bytes-? WHERE id=1", (sum(totals.values()),))


def _rolling_cleanup(db, cutoff):
    candidates = db.execute("""SELECT file,seq,size FROM frames AS f WHERE received < ?
        AND NOT EXISTS(SELECT 1 FROM clips AS c WHERE c.file=f.file AND f.seq BETWEEN c.first AND c.last)
        ORDER BY received LIMIT 1500""", (cutoff,)).fetchall()
    for file_id in {row["file"] for row in candidates}:
        fresh = db.execute("SELECT MIN(seq) FROM frames WHERE file=? AND received>=?", (file_id, cutoff)).fetchone()[0]
        if fresh is not None:
            _promote_checkpoint(db, file_id, fresh)
        else:
            head_size = db.execute("SELECT COALESCE(length(head),0)+COALESCE(length(ranges),0) FROM files WHERE id=?", (file_id,)).fetchone()[0]
            db.execute("UPDATE files SET head=NULL,ranges=NULL,digest=NULL,used=used-? WHERE id=?", (head_size, file_id))
            db.execute("UPDATE storage SET bytes=bytes-? WHERE id=1", (head_size,))
    _discard_frames(db, candidates)
    db.execute("DELETE FROM batches WHERE rowid IN (SELECT rowid FROM batches WHERE received < ? LIMIT 1500)", (cutoff,))
    db.execute("DELETE FROM files WHERE path IS NULL AND used=0")
    return len(candidates)


def maintenance(eagle, now=None, *, rolling=True):
    now = time.time() if now is None else now
    directory = root(eagle)
    if not directory.exists():
        return
    # Disk intents precede expiry so an accepted submission keeps its clip.
    backlog = False
    for index, path in enumerate((directory / "pending").glob("*.json")):
        if index >= 128:
            backlog = True
            break
        _pin(eagle, path)
    with database(eagle, create=False) as db:
        if db is None:
            return
        jobs = db.execute("SELECT assignment,due FROM cleanup WHERE completed IS NULL ORDER BY due LIMIT 32").fetchall()
    for job in jobs:
        assignment_id = job["assignment"]
        with eagle._assignment_lock:
            assignment = eagle._load_assignment(assignment_id)
            if assignment and not assignment.get("gradingCompletedAt"):
                with database(eagle, write=True) as db:
                    db.execute("DELETE FROM cleanup WHERE assignment=?", (assignment_id,))
                continue
            legacy.purge(eagle, assignment_id, remove_binding=True)
        with database(eagle, write=True) as db:
            _release_clips(db, assignment_id)
            db.execute("UPDATE cleanup SET completed=? WHERE assignment=?", (now, assignment_id))
        if assignment:
            eagle.socketio.emit("assignment_workflow_updated", {"classId": assignment.get("targetClassId")},
                                to=f"class_{assignment.get('targetClassId')}")
    if backlog or (not rolling and not jobs):
        return
    for _ in range(8):
        with database(eagle, write=True) as db:
            if _rolling_cleanup(db, now - ROLLING_AGE) < 1500:
                break
    with database(eagle) as db:
        db.execute("PRAGMA incremental_vacuum(256)")
        db.execute("PRAGMA wal_checkpoint(TRUNCATE)")


def start_maintenance(eagle):
    global _maintenance_started
    if _maintenance_started:
        return
    _maintenance_started = True
    def run():
        last_rolling = float("-inf")
        last_legacy = float("-inf")
        anchor = None
        while True:
            try:
                path = root(eagle) / "history.sqlite3"
                if anchor is None and path in _initialized and path.is_file():
                    # Keep the journal open across short-lived batch connections.
                    # Closing the last connection would checkpoint on each batch.
                    anchor = sqlite3.connect(path, timeout=.25)
                    anchor.execute("SELECT 1 FROM storage").fetchone()
                now = time.monotonic()
                rolling = now - last_rolling >= 60
                maintenance(eagle, rolling=rolling)
                if rolling:
                    last_rolling = now
                if now - last_legacy >= 3600:
                    last_legacy = now
                    legacy.expire_unsubmitted(eagle, workflow.iso(datetime.fromtimestamp(time.time() - ROLLING_AGE, timezone.utc)))
            except (OSError, sqlite3.Error, ValueError, KeyError):
                eagle._append_server_log("Workspace history cleanup is pending and will be retried.", level="WARN")
            _maintenance_ready.wait(15)
            _maintenance_ready.clear()
    threading.Thread(target=run, name="workspace-history-maintenance", daemon=True).start()


def cleanup_status(eagle, assignment):
    if not assignment.get("gradingCompletedAt"):
        return ""
    try:
        with database(eagle, create=False) as db:
            row = db.execute("SELECT due,completed FROM cleanup WHERE assignment=?", (assignment["id"],)).fetchone() if db else None
        if row and row["completed"] is None:
            return "overdue" if row["due"] < time.time() else "pending"
        return "complete"
    except (sqlite3.Error, OSError):
        return "pending"


def _clock(cls, frame):
    at = datetime.fromtimestamp(frame["edited"], timezone.utc)
    window = workflow.schedule_at(cls, at)
    return {"at": workflow.iso(at), "receivedAt": workflow.iso(datetime.fromtimestamp(frame["received"], timezone.utc)),
            "classTime": "unknown" if window is None else ("inside" if workflow.class_clock(window, at) else "outside"),
            "timeZone": window["timeZone"] if window else "UTC"}


def _clip_page(db, clip, cls, cursor, index):
    file_id, first, last = clip["file"], clip["first"], clip["last"]
    total = last - first + 1
    if index:
        # At most 200 color buckets, mixed buckets are marked explicitly.
        step = max(1, (total + 199) // 200)
        stamps = db.execute("""SELECT seq,edited,received FROM frames WHERE file=? AND seq BETWEEN ? AND ?
                            AND ((seq-?)%?=0 OR seq=?) ORDER BY seq""", (file_id, first, last, first, step, last)).fetchall()
        marks = [{"seq": row["seq"] - first + 1, **_clock(cls, row)} for row in stamps]
        return {"total": total, "frames": [], "path": clip["name"], "marks": marks,
                "firstAt": marks[0]["at"], "lastAt": marks[-1]["at"], "partial": bool(clip["partial"])}
    absolute = min(last, first + cursor - 1)
    base = _state_at(db, file_id, absolute - 1)[0] if absolute > first else ""
    frames, size = [], len(base.encode("utf-8"))
    for row in db.execute("SELECT * FROM frames WHERE file=? AND seq BETWEEN ? AND ? ORDER BY seq LIMIT ?",
                          (file_id, absolute, last, PAGE_FRAMES)):
        change = ({"from": 0, "delete": 0, "insert": _unpack(row["checkpoint"])}
                  if row["seq"] == first else json.loads(_unpack(row["patch"])))
        frame = {"seq": row["seq"] - first + 1, "kind": row["kind"], **_clock(cls, row), **change,
                 "pasteRanges": json.loads(_unpack(row["ranges"])) if row["ranges"] else []}
        size += len(json.dumps(frame, ensure_ascii=False).encode("utf-8"))
        if frames and size > MAX_PAGE:
            break
        frames.append(frame)
    return {"total": total, "base": base, "frames": frames,
            "nextCursor": frames[-1]["seq"] + 1 if frames and frames[-1]["seq"] < total else None}


def register(app, eagle):
    @app.get("/api/admin/workspace-history")
    def workspace_history_usage():
        if not eagle._require_admin(request):
            return jsonify(ok=False, error="Administrator login required"), 401
        with database(eagle, create=False) as db:
            if db is None:
                return jsonify(ok=True, rollingBytes=0, pinnedBytes=0, limit=MAX_STORAGE, assignments=[])
            stored, pinned = db.execute("SELECT bytes,pinned FROM storage WHERE id=1").fetchone()
            rows = db.execute("""SELECT assignment,COUNT(*) clips,MIN(submitted) oldest FROM clips
                                 GROUP BY assignment ORDER BY clips DESC LIMIT 30""").fetchall()
        assignments = []
        for row in rows:
            assignment = eagle._load_assignment(row["assignment"])
            if assignment and not assignment.get("gradingCompletedAt"):
                assignments.append({"name": assignment["name"], "className": assignment.get("targetClassName"),
                                    "clips": row["clips"], "oldest": row["oldest"]})
        return jsonify(ok=True, rollingBytes=stored-pinned, pinnedBytes=pinned, limit=MAX_STORAGE, assignments=assignments)

    @app.post("/api/workspace-history/record", endpoint="record_workspace_history")
    def record():
        user = eagle._require_user_for_files(request)
        if not user or user.get("role") != "student":
            return jsonify(ok=False, error="Student login required"), 401
        if not available() or not eagle._get_user_class_ids(user):
            return jsonify(ok=False, error="Workspace history is unavailable"), 403
        if not request.content_length or request.content_length > MAX_REQUEST:
            return jsonify(ok=False, error="History batch is too large"), 413
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return jsonify(ok=False, error="Invalid history batch"), 400
        file_id, batch = data.get("fileId"), data.get("batchId")
        frames = data.get("frames")
        if (not isinstance(file_id, str) or not HEX.fullmatch(file_id) or not isinstance(batch, str)
                or not re.fullmatch(r"[\w-]{8,64}", batch, re.ASCII) or type(data.get("version")) is not int
                or not isinstance(frames, list) or not 1 <= len(frames) <= MAX_FRAMES):
            return jsonify(ok=False, error="Invalid history batch"), 400
        received = time.time()
        last = received - ROLLING_AGE
        for frame in frames:
            stamp = frame.get("at") if isinstance(frame, dict) else None
            if type(stamp) not in (int, float) or not last <= stamp <= received + 60:
                return jsonify(ok=False, error="History timestamps are out of range"), 400
            last = stamp
            frame["at"] = min(received, stamp)
        workspace = eagle._get_user_dir(user["email"])
        owner = _owner(workspace)
        with _rate_lock:
            previous = _last_batches.get(owner, 0)
            if received - previous < .35:
                return jsonify(ok=False, error="History is catching up"), 429
            _last_batches[owner] = received
            if len(_last_batches) > 4096:
                _last_batches.pop(next(iter(_last_batches)))
        try:
            future = _enqueue(lambda: _record(eagle, owner, file_id, data, received, workspace))
            version = future.result(timeout=2)
            return jsonify(ok=True, version=version)
        except Conflict as exc:
            return jsonify(ok=False, version=exc.version, error="History changed in another editor"), 409
        except (ValueError, TypeError, UnicodeError, OverflowError) as exc:
            return jsonify(ok=False, error=str(exc)), 400
        except Capacity as exc:
            return jsonify(ok=False, error=str(exc)), 507
        except (Full, TimeoutError, sqlite3.Error, OSError):
            return jsonify(ok=False, error="History is busy. You can still save and turn in work."), 503

    @app.get("/api/assignments/workspace-history", endpoint="play_workspace_history")
    def playback():
        assignment, error = legacy._teacher_assignment(eagle, request.args)
        if error:
            return error
        if assignment.get("gradingCompletedAt"):
            return jsonify(ok=True, total=0, frames=[], clips=[], gradingCompletedAt=assignment["gradingCompletedAt"])
        email = str(request.args.get("studentEmail") or "").lower()
        if not email:
            return jsonify(ok=False, error="Choose a student"), 400
        try:
            cursor = max(1, min(100000000, int(request.args.get("cursor", 1))))
            offset = max(0, min(100000, int(request.args.get("offset", 0))))
        except ValueError:
            return jsonify(ok=False, error="Invalid history position"), 400
        revision, attachment = request.args.get("revisionId"), request.args.get("fileId")
        with database(eagle, create=False) as db:
            if db is None:
                return jsonify(ok=True, total=0, frames=[], clips=[])
            if not revision and not attachment:
                clips = db.execute("""SELECT revision,attachment,name,submitted,partial FROM clips
                    WHERE assignment=? AND student=? ORDER BY submitted DESC, attachment LIMIT 101 OFFSET ?""",
                    (assignment["id"], email, offset)).fetchall()
                return jsonify(ok=True, clips=[dict(row) for row in clips[:100]], nextOffset=offset + 100 if len(clips) > 100 else None)
            clip = db.execute("SELECT * FROM clips WHERE assignment=? AND student=? AND revision=? AND attachment=?",
                              (assignment["id"], email, revision, attachment)).fetchone()
            if clip is None and revision and attachment:
                submission = next((s for s in assignment.get("submissions", []) if s.get("email") == email), {})
                reviewed = next((s for s in (submission, *submission.get("history", [])) if s.get("revisionId") == revision), {})
                if any(f.get("id") == attachment for f in workflow.files_for(reviewed)):
                    # Quiz-only resubmissions clone the same attachment ID into
                    # a new protected revision.
                    clip = db.execute("SELECT * FROM clips WHERE assignment=? AND student=? AND attachment=? LIMIT 1",
                                      (assignment["id"], email, attachment)).fetchone()
            if clip is None:
                return jsonify(ok=True, total=0, frames=[])
            cls = eagle._find_class_by_id(assignment.get("targetClassId")) or {}
            return jsonify(ok=True, **_clip_page(db, clip, cls, cursor, request.args.get("index") == "1"))
