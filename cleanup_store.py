"""Private cleanup rules and permanent deletion-intent/outcome receipts."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import sqlite3
import threading
import time
import uuid


KINDS = {
    "workspace_trash": ("User file Trash", 30, "Files and folders moved to workspace Trash; age starts when deleted."),
    "deleted_users": ("Deleted-user retained data", 30, "Remaining private records of deleted accounts. Disabled and recreated accounts are protected; older orphans get a new observation clock."),
    "wiki_trash": ("Deleted wiki content", 30, "Soft-deleted wiki pages, folders, attachments, drafts and revisions."),
    "wiki_backups": ("Wiki backup archives", 30, "Server-created wiki and pre-restore ZIP backups. External copies are outside this policy."),
    "wiki_recovery": ("Automatic wiki recovery points", 14, "Old recovery manifests and unreferenced deduplicated blobs; current wiki content is preserved."),
    "application_logs": ("Application logs and event history", 30, "Old server log lines, rotated server logs, sign-in/server/classroom event rows. Current state and unresolved signals are preserved."),
    "wiki_analytics": ("Wiki analytics and search history", 90, "Old daily analytics, including recorded search terms."),
    "wiki_audit": ("Wiki edit audit history", 180, "Old edit-audit rows after their recovery points have expired or been removed."),
    "temporary_files": ("Abandoned uploads and run sandboxes", 1, "Old wiki upload staging and abandoned runner sandboxes. Active runs and live application storage are excluded."),
    "unused_backgrounds": ("Unused uploaded backgrounds", 7, "Generated background images no longer referenced by site or class settings."),
}


def default_policy():
    return {"enabled": False, "rules": {key: {"enabled": False, "days": row[1]} for key, row in KINDS.items()}}


def validate_policy(raw):
    if not isinstance(raw, dict) or set(raw) != {"enabled", "rules"} or type(raw["enabled"]) is not bool:
        raise ValueError("Provide an enable switch and the complete cleanup rules")
    if not isinstance(raw["rules"], dict) or set(raw["rules"]) != set(KINDS):
        raise ValueError("Unknown or missing cleanup data type")
    for value in raw["rules"].values():
        if not isinstance(value, dict) or set(value) != {"enabled", "days"} or type(value["enabled"]) is not bool:
            raise ValueError("Each cleanup rule needs an enable switch and retention days")
        if type(value["days"]) is not int or not 1 <= value["days"] <= 3650:
            raise ValueError("Retention must be a whole number from 1 to 3650 days")
    return json.loads(json.dumps(raw))


class CleanupStore:
    def __init__(self, root):
        self.root = Path(root).absolute()
        self.path = self.root / "cleanup.sqlite3"
        self.lock = threading.RLock()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.root.is_symlink() or self.root.is_junction() or self.path.is_symlink():
            raise OSError("Cleanup storage must not be a filesystem link")
        fd = os.open(self.path, os.O_CREAT | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o600)
        os.close(fd)
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS policy (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, trigger TEXT NOT NULL, started REAL NOT NULL,
                    finished REAL, status TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
                    bytes INTEGER NOT NULL DEFAULT 0, message TEXT NOT NULL DEFAULT '');
                CREATE TABLE IF NOT EXISTS receipts (seq INTEGER PRIMARY KEY, run TEXT NOT NULL, kind TEXT NOT NULL,
                    name TEXT NOT NULL, path TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL,
                    bytes INTEGER NOT NULL, records INTEGER NOT NULL, started REAL NOT NULL, finished REAL, error TEXT NOT NULL DEFAULT '');
                CREATE INDEX IF NOT EXISTS receipts_run ON receipts(run,seq);
                CREATE TABLE IF NOT EXISTS deleted_accounts (email TEXT PRIMARY KEY, deleted REAL NOT NULL, source TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS observations (kind TEXT NOT NULL, identity TEXT NOT NULL, seen REAL NOT NULL,
                    PRIMARY KEY(kind,identity));
            """)
            db.execute("INSERT OR IGNORE INTO policy VALUES(1,0,?)", (json.dumps(default_policy()),))
            # Single-process Flask application: a previous process cannot have
            # completed an in-memory worker after this service restarted.
            db.execute("UPDATE runs SET status='interrupted',finished=?,message='Service restarted; inspect planned receipts and retry.' WHERE status='running'", (time.time(),))

    @contextmanager
    def connect(self):
        with self.lock:
            if self.path.is_symlink() or self.root.is_symlink() or self.root.is_junction():
                raise OSError("Cleanup storage link refused")
            db = sqlite3.connect(self.path, timeout=10)
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA synchronous=FULL")
            db.execute("PRAGMA secure_delete=ON")
            try:
                with db:
                    yield db
            finally:
                db.close()

    def policy(self):
        with self.connect() as db:
            row = db.execute("SELECT revision,data FROM policy WHERE id=1").fetchone()
        return row["revision"], validate_policy(json.loads(row["data"]))

    def save_policy(self, revision, raw):
        if type(revision) is not int:
            raise ValueError("A cleanup settings revision is required")
        policy = validate_policy(raw)
        with self.connect() as db:
            changed = db.execute("UPDATE policy SET revision=revision+1,data=? WHERE id=1 AND revision=?",
                                 (json.dumps(policy), revision)).rowcount
            if not changed:
                raise FileExistsError("Cleanup settings changed in another tab; reload them before saving")
        return self.policy()

    def begin_run(self, trigger):
        identity = uuid.uuid4().hex
        with self.connect() as db:
            db.execute("INSERT INTO runs(id,trigger,started,status) VALUES(?,?,?,'running')", (identity, trigger, time.time()))
        return identity

    def finish_run(self, identity, status, message=""):
        with self.connect() as db:
            db.execute("UPDATE runs SET finished=?,status=?,message=? WHERE id=?", (time.time(), status, message, identity))

    def plan(self, run, kind, path, action, size=0, records=0, name=None):
        path = str(path)
        with self.connect() as db:
            cursor = db.execute("INSERT INTO receipts(run,kind,name,path,action,status,bytes,records,started) VALUES(?,?,?,?,?,'planned',?,?,?)",
                                (run, kind, name or Path(path).name, path, action, max(0, size), max(0, records), time.time()))
            return cursor.lastrowid

    def result(self, identity, status, error=""):
        with self.connect() as db:
            row = db.execute("SELECT run,bytes FROM receipts WHERE seq=?", (identity,)).fetchone()
            db.execute("UPDATE receipts SET status=?,finished=?,error=? WHERE seq=?", (status, time.time(), error, identity))
            if status == "deleted":
                db.execute("UPDATE runs SET deleted=deleted+1,bytes=bytes+? WHERE id=?", (row["bytes"], row["run"]))
            elif status == "failed":
                db.execute("UPDATE runs SET failed=failed+1 WHERE id=?", (row["run"],))

    def history(self, before=0):
        with self.connect() as db:
            rows = [dict(row) for row in db.execute("SELECT * FROM receipts WHERE (?=0 OR seq<?) ORDER BY seq DESC LIMIT 100", (before, before))]
            runs = [dict(row) for row in db.execute("SELECT * FROM runs ORDER BY started DESC LIMIT 10")]
        return {"entries": rows, "next_before": rows[-1]["seq"] if len(rows) == 100 else 0, "runs": runs}

    def remember_deleted(self, email, now=None, source="account_delete"):
        with self.connect() as db:
            conflict = "DO NOTHING" if source == "first_observed_absent" else "DO UPDATE SET deleted=excluded.deleted,source=excluded.source"
            db.execute("INSERT INTO deleted_accounts VALUES(?,?,?) ON CONFLICT(email) " + conflict,
                       (email, time.time() if now is None else now, source))

    def deleted_accounts(self):
        with self.connect() as db:
            return [dict(row) for row in db.execute("SELECT * FROM deleted_accounts ORDER BY deleted LIMIT 1000")]

    def forget_account(self, email):
        with self.connect() as db:
            db.execute("DELETE FROM deleted_accounts WHERE email=?", (email,))

    def observe(self, kind, identity, now):
        with self.connect() as db:
            db.execute("INSERT OR IGNORE INTO observations VALUES(?,?,?)", (kind, identity, now))
            return db.execute("SELECT seen FROM observations WHERE kind=? AND identity=?", (kind, identity)).fetchone()[0]

    def forget_observation(self, kind, identity):
        with self.connect() as db:
            db.execute("DELETE FROM observations WHERE kind=? AND identity=?", (kind, identity))
