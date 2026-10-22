"""Private, deduplicated seven-day wiki recovery points and durable edit audit.

History lives outside the replaceable wiki root. Rollback never rewinds the audit
or imports old bookmarks, class grants, or search analytics.
"""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import threading
import time
import uuid
import weakref
import zipfile

from wiki_store import MAX_BACKUP_ENTRIES, MAX_BACKUP_MANIFEST_BYTES, atomic_write_text

RETENTION_SECONDS = 7 * 24 * 3600
MAX_HISTORY_BYTES = 20 * 1024**3
_stores = weakref.WeakSet()
_maintenance_lock = threading.Lock()
_maintenance_started = False


def _maintenance():
    while True:
        threading.Event().wait(3600)
        with _maintenance_lock:
            stores = list(_stores)
        for history in stores:
            try:
                history.prune()
            except (OSError, sqlite3.Error):
                # Edits and recovery also run this check and surface failures.
                pass
        del stores


class WikiHistory:
    def __init__(self, store):
        self.store = weakref.proxy(store)
        self.root = store.backup_dir / "history"
        if self.root.resolve().is_relative_to(store.base_dir.resolve()):
            self.root = store.base_dir.parent / ("." + store.base_dir.name + "-history")
        self.blobs = self.root / "blobs"
        self.manifests = self.root / "milestones"
        self.lock = store._write_lock
        self._hash_cache = {}
        for path in (self.root, self.blobs, self.manifests):
            path.mkdir(parents=True, exist_ok=True)
        with self.connect() as conn:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS audit (
                    seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL,
                    created REAL NOT NULL, actor TEXT NOT NULL, role TEXT NOT NULL,
                    action TEXT NOT NULL, target TEXT NOT NULL, status TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS milestones (
                    id TEXT PRIMARY KEY, created REAL NOT NULL, bytes INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS blobs (digest TEXT PRIMARY KEY, size INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS refs (id TEXT NOT NULL, digest TEXT NOT NULL,
                    PRIMARY KEY(id,digest));
                CREATE INDEX IF NOT EXISTS refs_digest ON refs(digest);
            """)
            if 'bytes' not in {row['name'] for row in conn.execute('PRAGMA table_info(milestones)')}:
                conn.execute('ALTER TABLE milestones ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0')
                for row in conn.execute('SELECT id FROM milestones').fetchall():
                    path = self.manifests/(row['id']+'.json')
                    conn.execute('UPDATE milestones SET bytes=? WHERE id=?',(path.stat().st_size if path.exists() else 0,row['id']))
        self.prune()
        global _maintenance_started
        with _maintenance_lock:
            _stores.add(self)
            if not _maintenance_started:
                threading.Thread(target=_maintenance, name="wiki-history-retention", daemon=True).start()
                _maintenance_started = True

    @contextmanager
    def connect(self):
        conn = sqlite3.connect(self.root / "history.sqlite3", timeout=10)
        conn.row_factory = sqlite3.Row
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    def prune(self):
        with self.lock, self.connect() as conn:
            expired = [row[0] for row in conn.execute("SELECT id FROM milestones WHERE created<=?", (time.time()-RETENTION_SECONDS,))]
            for identity in expired:
                conn.execute("DELETE FROM refs WHERE id=?", (identity,))
                conn.execute("DELETE FROM milestones WHERE id=?", (identity,))
                (self.manifests / (identity + ".json")).unlink(missing_ok=True)
            for row in conn.execute("SELECT digest FROM blobs WHERE digest NOT IN (SELECT digest FROM refs)").fetchall():
                (self.blobs / row[0]).unlink(missing_ok=True)
                conn.execute("DELETE FROM blobs WHERE digest=?", (row[0],))
            # A crash can leave a file before its catalog transaction committed.
            known = {row[0] for row in conn.execute("SELECT digest FROM blobs")}
            for path in self.blobs.iterdir():
                if path.name not in known:
                    path.unlink(missing_ok=True)
            live = {row[0]+".json" for row in conn.execute("SELECT id FROM milestones")}
            for path in self.manifests.iterdir():
                if path.name not in live:
                    path.unlink(missing_ok=True)

    def capture(self, actor, action, target=""):
        """Persist the state BEFORE an edit, or refuse the edit on failure."""
        with self.lock:
            self.prune()
            identity, created = uuid.uuid4().hex, time.time()
            manifest = self.store.backup_manifest()
            # These are private live state, not wiki authoring history.
            manifest["analytics_daily"] = []
            manifest["class_features"] = []
            checksums, next_cache = {}, {}
            with self.connect() as conn:
                used = conn.execute("SELECT (SELECT COALESCE(SUM(size),0) FROM blobs) + (SELECT COALESCE(SUM(bytes),0) FROM milestones)").fetchone()[0]
                for prefix in ("content", "media", "drafts", "revisions"):
                    for path in (self.store.base_dir / prefix).rglob("*"):
                        if path.is_symlink():
                            raise OSError("Wiki history refuses linked files")
                        if not path.is_file():
                            continue
                        if len(checksums) >= MAX_BACKUP_ENTRIES-1:
                            raise OSError("Wiki history file limit reached")
                        stat = path.stat()
                        cache_key = (str(path), stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
                        key = self._hash_cache.get(cache_key)
                        if not key:
                            digest = hashlib.sha256()
                            with path.open("rb") as source:
                                for chunk in iter(lambda: source.read(1024*1024), b""):
                                    digest.update(chunk)
                            key = digest.hexdigest()
                        if not (self.blobs / key).exists():
                            if used + stat.st_size > MAX_HISTORY_BYTES:
                                raise OSError("Wiki history storage limit reached; preserve backups and free space")
                            temporary = self.blobs / (identity + ".tmp")
                            try:
                                shutil.copyfile(path, temporary)
                                os.replace(temporary, self.blobs / key)
                                conn.execute("INSERT INTO blobs(digest,size) VALUES(?,?)", (key, stat.st_size))
                                used += stat.st_size
                            finally:
                                temporary.unlink(missing_ok=True)
                        next_cache[cache_key] = key
                        checksums[path.relative_to(self.store.base_dir).as_posix()] = key
                manifest["checksums"] = checksums
                raw = json.dumps(manifest, ensure_ascii=False)
                if len(raw.encode("utf-8")) > MAX_BACKUP_MANIFEST_BYTES:
                    raise OSError("Wiki history manifest limit reached")
                manifest_bytes = len(raw.encode("utf-8"))
                if used + manifest_bytes > MAX_HISTORY_BYTES:
                    raise OSError("Wiki history storage limit reached")
                atomic_write_text(self.manifests / (identity + ".json"), raw)
                conn.execute("INSERT INTO milestones VALUES(?,?,?)", (identity, created, manifest_bytes))
                conn.executemany("INSERT INTO refs VALUES(?,?)", [(identity, digest) for digest in set(checksums.values())])
                conn.execute("INSERT INTO audit(id,created,actor,role,action,target,status) VALUES(?,?,?,?,?,?,?)",
                    (identity, created, str(actor.get("email") or "administrator")[:254], actor["role"], action[:100], target[:32], "started"))
            self._hash_cache = next_cache
            return identity

    def finish(self, identity, success):
        with self.lock, self.connect() as conn:
            conn.execute("UPDATE audit SET status=? WHERE id=?", ("completed" if success else "failed", identity))

    def listing(self, before=0):
        with self.lock, self.connect() as conn:
            rows = conn.execute("""SELECT a.*, m.created AS milestone_created FROM audit a
                LEFT JOIN milestones m ON a.id=m.id
                WHERE (?=0 OR a.seq<?) ORDER BY a.seq DESC LIMIT 100""", (before,before)).fetchall()
            now = time.time()
            return [dict(row, can_restore=row["milestone_created"] is not None and row["created"]+RETENTION_SECONDS>now,
                         expires_at=row["created"]+RETENTION_SECONDS) for row in rows]

    def restore(self, identity):
        if not re.fullmatch(r"[0-9a-f]{32}", identity):
            raise ValueError("Invalid milestone")
        with self.lock, self.connect() as conn:
            row = conn.execute("SELECT created FROM milestones WHERE id=?", (identity,)).fetchone()
            if not row or row[0]+RETENTION_SECONDS <= time.time():
                raise ValueError("Milestone is unavailable or older than seven days")
            manifest = json.loads((self.manifests / (identity+".json")).read_text(encoding="utf-8"))
            live = self.store.backup_manifest()
            valid_ids = {node["id"] for node in manifest["nodes"]}
            manifest["class_features"] = [row for row in live["class_features"] if row["node_id"] in valid_ids]
            manifest["analytics_daily"] = live["analytics_daily"]
            archive_path = self.root / (uuid.uuid4().hex+".zip")
            try:
                with zipfile.ZipFile(archive_path, "w", allowZip64=True) as archive:
                    for name, digest in manifest["checksums"].items():
                        if not re.fullmatch(r"[0-9a-f]{64}", digest):
                            raise ValueError("Invalid milestone file")
                        archive.write(self.blobs / digest, name, compress_type=zipfile.ZIP_STORED)
                    archive.writestr("manifest.json", json.dumps(manifest))
                return self.store.restore_archive(archive_path, create_pre_restore=False)
            finally:
                archive_path.unlink(missing_ok=True)
