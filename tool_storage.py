"""Account-owned tool storage; opaque frames receive only their own scoped profile.

SQLite commits complete batches with revision/epoch checks. Uploads are bounded,
resumable temporary files; names supplied by tools never become filesystem paths.
"""
from __future__ import annotations

import json
import os
from contextlib import contextmanager
from pathlib import Path
import shutil
import sqlite3
import threading
import time
import uuid

from tool_store import ToolError

MIB = 1024 * 1024
DEFAULT_QUOTA = 64 * MIB
MAX_VALUE = 32 * MIB
MAX_PROFILE = 64 * MIB
MAX_KEYS = 2048
CHUNK = 512 * 1024
UPLOAD_SECONDS = 300
SERVER_BUDGET = 2 * 1024 * MIB


class ToolStorage:
    def __init__(self, directory):
        self.root = Path(directory) / 'storage'
        self.lock = threading.RLock()

    @contextmanager
    def _connect(self):
        self.root.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.root / 'catalog.sqlite3', timeout=10)
        try:
            db.row_factory = sqlite3.Row
            db.execute('PRAGMA foreign_keys=ON')
            db.executescript('''
                CREATE TABLE IF NOT EXISTS accounts (
                  id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1,
                  quota INTEGER NOT NULL DEFAULT 67108864, epoch INTEGER NOT NULL DEFAULT 0,
                  version INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS profiles (
                  account TEXT NOT NULL, tool TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
                  PRIMARY KEY(account,tool));
                CREATE TABLE IF NOT EXISTS entries (
                  account TEXT NOT NULL, tool TEXT NOT NULL, key TEXT NOT NULL,
                  value BLOB NOT NULL, size INTEGER NOT NULL, PRIMARY KEY(account,tool,key));
                CREATE TABLE IF NOT EXISTS uploads (
                  id TEXT PRIMARY KEY, account TEXT NOT NULL, tool TEXT NOT NULL, owner TEXT NOT NULL,
                  epoch INTEGER NOT NULL, revision INTEGER NOT NULL, manifest TEXT NOT NULL,
                  total INTEGER NOT NULL, received INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL,
                  UNIQUE(account,tool));
            ''')
            with db:
                yield db
        finally:
            db.close()

    def _account(self, db, account):
        db.execute('INSERT OR IGNORE INTO accounts(id) VALUES(?)', (account,))
        return dict(db.execute('SELECT * FROM accounts WHERE id=?', (account,)).fetchone())

    def _profile(self, db, account, tool):
        db.execute('INSERT OR IGNORE INTO profiles(account,tool) VALUES(?,?)', (account, tool))
        return db.execute('SELECT revision FROM profiles WHERE account=? AND tool=?', (account, tool)).fetchone()[0]

    def _spool(self, upload_id):
        # IDs originate here, not from file names or storage keys.
        if not isinstance(upload_id, str) or len(upload_id) != 32 or any(c not in '0123456789abcdef' for c in upload_id):
            raise ToolError('Invalid tool storage upload')
        return self.root / (upload_id + '.upload')

    def _drop(self, db, upload_id):
        self._spool(upload_id).unlink(missing_ok=True)
        db.execute('DELETE FROM uploads WHERE id=?', (upload_id,))

    def _prune(self, db):
        for row in db.execute('SELECT id FROM uploads WHERE created<?', (time.time() - UPLOAD_SECONDS,)).fetchall():
            self._drop(db, row['id'])
        # A crash between creation/removal and metadata commit can leave a spool.
        known = {row[0] for row in db.execute('SELECT id FROM uploads')}
        for path in self.root.glob('*.upload'):
            if path.stem not in known and time.time() - path.stat().st_mtime > UPLOAD_SECONDS:
                path.unlink(missing_ok=True)

    def summary(self, account):
        with self.lock, self._connect() as db:
            policy = self._account(db, account)
            rows = [dict(row) for row in db.execute('SELECT tool, SUM(size) AS used_bytes, COUNT(*) AS keys FROM entries WHERE account=? GROUP BY tool', (account,))]
            return {'enabled': bool(policy['enabled']), 'quota_bytes': policy['quota'],
                    'epoch': policy['epoch'], 'version': policy['version'],
                    'used_bytes': sum(row['used_bytes'] for row in rows), 'tools': rows,
                    'pending_bytes': db.execute('SELECT COALESCE(SUM(received),0) FROM uploads WHERE account=?', (account,)).fetchone()[0]}

    def snapshot(self, account, tool, *, export=False):
        with self.lock, self._connect() as db:
            policy = self._account(db, account)
            existing = db.execute('SELECT revision FROM profiles WHERE account=? AND tool=?', (account, tool)).fetchone()
            revision = existing[0] if existing else 0
            entries = {row['key']: bytes(row['value']).decode('utf-8') for row in db.execute('SELECT key,value FROM entries WHERE account=? AND tool=? ORDER BY key', (account, tool))} if policy['enabled'] or export else {}
            used = db.execute('SELECT COALESCE(SUM(size),0) FROM entries WHERE account=?', (account,)).fetchone()[0]
            return {'enabled': bool(policy['enabled']), 'epoch': policy['epoch'], 'revision': revision,
                    'quota_bytes': policy['quota'], 'used_bytes': used, 'entries': entries,
                    'max_value_bytes': MAX_VALUE, 'max_profile_bytes': MAX_PROFILE, 'max_keys': MAX_KEYS, 'chunk_bytes': CHUNK}

    def policy(self, account, raw):
        quota = raw.get('quota_mib')
        if type(quota) is not int or not 1 <= quota <= 1024 or type(raw.get('enabled')) is not bool:
            raise ToolError('Choose a storage quota from 1 to 1024 MiB and an enabled setting')
        with self.lock, self._connect() as db:
            current = self._account(db, account)
            if type(raw.get('version')) is not int or raw['version'] != current['version']:
                raise ToolError('Storage settings changed. Load them again before saving', 409)
            db.execute('UPDATE accounts SET enabled=?,quota=?,epoch=epoch+1,version=version+1 WHERE id=?', (int(raw['enabled']), quota * MIB, account))
            for row in db.execute('SELECT id FROM uploads WHERE account=?', (account,)).fetchall():
                self._drop(db, row['id'])
        return self.summary(account)

    def clear(self, account, epoch, tool=None):
        with self.lock, self._connect() as db:
            current = self._account(db, account)
            if type(epoch) is not int or epoch != current['epoch']:
                raise ToolError('Storage changed. Refresh before clearing', 409)
            if tool is None:
                db.execute('DELETE FROM entries WHERE account=?', (account,))
                db.execute('UPDATE profiles SET revision=revision+1 WHERE account=?', (account,))
            else:
                db.execute('DELETE FROM entries WHERE account=? AND tool=?', (account, tool))
                db.execute('UPDATE profiles SET revision=revision+1 WHERE account=? AND tool=?', (account, tool))
            # Any old device must explicitly reopen, never upload its old cache.
            db.execute('UPDATE accounts SET epoch=epoch+1 WHERE id=?', (account,))
            for row in db.execute('SELECT id FROM uploads WHERE account=?', (account,)).fetchall():
                self._drop(db, row['id'])
        return self.summary(account)

    def _check(self, db, account, tool, epoch, revision):
        policy = self._account(db, account)
        if type(epoch) is not int or epoch != policy['epoch']:
            raise ToolError('Tool storage was cleared or its settings changed. Download unsaved work and reopen the tool', 409)
        if not policy['enabled']:
            raise ToolError('Persistent tool storage is disabled for this account', 403)
        if type(revision) is not int or revision != self._profile(db, account, tool):
            raise ToolError('This tool was saved on another tab or device. Download your unsaved work before reopening', 409)
        return policy

    def begin(self, account, tool, owner, raw):
        manifest = raw.get('changes')
        if not isinstance(manifest, list) or not 1 <= len(manifest) <= MAX_KEYS:
            raise ToolError('Invalid tool storage changes')
        keys, total = set(), 0
        for item in manifest:
            if not isinstance(item, dict) or set(item) != {'key', 'size'}:
                raise ToolError('Invalid storage entry')
            key, size = item['key'], item['size']
            try:
                key_size = len(key.encode('utf-8')) if isinstance(key, str) else 513
            except UnicodeError as exc:
                raise ToolError('Storage keys must be valid UTF-8') from exc
            if not isinstance(key, str) or key_size > 512 or '\0' in key or key in keys:
                raise ToolError('Storage keys must be unique and at most 512 bytes')
            if size is not None and (type(size) is not int or not 0 <= size <= MAX_VALUE):
                raise ToolError('A tool storage value is limited to 32 MiB', 413)
            keys.add(key)
            total += size or 0
        if total > MAX_PROFILE:
            raise ToolError('Tool storage batches are limited to 64 MiB', 413)
        with self.lock, self._connect() as db:
            self._prune(db)
            policy = self._check(db, account, tool, raw.get('epoch'), raw.get('revision'))
            if db.execute('SELECT 1 FROM uploads WHERE account=? AND tool=?', (account, tool)).fetchone():
                raise ToolError('Another save for this tool is still uploading. Retry shortly', 423)
            if db.execute('SELECT COUNT(*) FROM uploads').fetchone()[0] >= 32:
                raise ToolError('Tool storage is busy. Retry shortly', 429)
            current = {row['key']: row['size'] for row in db.execute('SELECT key,size FROM entries WHERE account=? AND tool=?', (account, tool))}
            resulting = dict(current)
            for item in manifest:
                if item['size'] is None:
                    resulting.pop(item['key'], None)
                else:
                    resulting[item['key']] = item['size']
            profile_size = sum(resulting.values())
            account_size = db.execute('SELECT COALESCE(SUM(size),0) FROM entries WHERE account=?', (account,)).fetchone()[0]
            if len(resulting) > MAX_KEYS or profile_size > MAX_PROFILE or account_size - sum(current.values()) + profile_size > policy['quota']:
                raise ToolError('External tool storage is full. Download work, clear saved data, or ask an administrator to increase your quota', 413)
            global_size = db.execute('SELECT COALESCE(SUM(size),0) FROM entries').fetchone()[0]
            reserved = db.execute('SELECT COALESCE(SUM(total),0) FROM uploads').fetchone()[0]
            if global_size + reserved + total > SERVER_BUDGET or shutil.disk_usage(self.root).free < total * 3 + 64 * MIB:
                raise ToolError('The server has insufficient external-tool storage space', 507)
            upload_id = uuid.uuid4().hex
            self._spool(upload_id).write_bytes(b'')
            db.execute('INSERT INTO uploads(id,account,tool,owner,epoch,revision,manifest,total,created) VALUES(?,?,?,?,?,?,?,?,?)',
                       (upload_id, account, tool, owner, policy['epoch'], raw['revision'], json.dumps(manifest), total, time.time()))
            return {'upload_id': upload_id, 'chunk_bytes': CHUNK}

    def chunk(self, account, tool, owner, upload_id, offset, body):
        if type(offset) is not int or offset < 0 or not body or len(body) > CHUNK:
            raise ToolError('Invalid tool storage chunk')
        with self.lock, self._connect() as db:
            row = db.execute('SELECT * FROM uploads WHERE id=? AND account=? AND tool=? AND owner=?', (upload_id, account, tool, owner)).fetchone()
            if not row or time.time() - row['created'] > UPLOAD_SECONDS:
                raise ToolError('Tool storage upload expired. Retry the save', 410)
            self._check(db, account, tool, row['epoch'], row['revision'])
            if offset + len(body) > row['total']:
                raise ToolError('Tool storage chunk exceeds the accepted size', 413)
            path = self._spool(upload_id)
            if offset < row['received']:
                with path.open('rb') as file:
                    file.seek(offset)
                    if offset + len(body) <= row['received'] and file.read(len(body)) == body:
                        return row['received']
                raise ToolError('Conflicting tool storage retry', 409)
            if offset != row['received']:
                raise ToolError('Tool storage chunks must arrive in order', 409)
            with path.open('r+b') as file:
                file.seek(offset)
                file.write(body)
                file.truncate(offset + len(body))
                file.flush()
                os.fsync(file.fileno())
            db.execute('UPDATE uploads SET received=? WHERE id=?', (offset + len(body), upload_id))
            return offset + len(body)

    def commit(self, account, tool, owner, upload_id):
        with self.lock, self._connect() as db:
            row = db.execute('SELECT * FROM uploads WHERE id=? AND account=? AND tool=? AND owner=?', (upload_id, account, tool, owner)).fetchone()
            if not row or time.time() - row['created'] > UPLOAD_SECONDS:
                raise ToolError('Tool storage upload expired', 410)
            policy = self._check(db, account, tool, row['epoch'], row['revision'])
            if row['received'] != row['total']:
                raise ToolError('Tool storage upload is incomplete', 409)
            # Recheck quota against other tools saved since admission.
            manifest = json.loads(row['manifest'])
            current = {item['key']: item['size'] for item in db.execute('SELECT key,size FROM entries WHERE account=? AND tool=?', (account, tool))}
            delta = sum((item['size'] or 0) - current.get(item['key'], 0) for item in manifest)
            used = db.execute('SELECT COALESCE(SUM(size),0) FROM entries WHERE account=?', (account,)).fetchone()[0]
            if used + delta > policy['quota']:
                raise ToolError('External tool storage quota was reached during this save', 413)
            with self._spool(upload_id).open('rb') as file:
                for item in manifest:
                    key, size = item['key'], item['size']
                    if size is None:
                        db.execute('DELETE FROM entries WHERE account=? AND tool=? AND key=?', (account, tool, key))
                    else:
                        value = file.read(size)
                        if len(value) != size:
                            raise ToolError('Incomplete storage value', 409)
                        try:
                            value.decode('utf-8')
                        except UnicodeError as exc:
                            raise ToolError('Tool storage values must be valid UTF-8') from exc
                        db.execute('INSERT INTO entries(account,tool,key,value,size) VALUES(?,?,?,?,?) ON CONFLICT(account,tool,key) DO UPDATE SET value=excluded.value,size=excluded.size', (account, tool, key, value, size))
            db.execute('UPDATE profiles SET revision=revision+1 WHERE account=? AND tool=?', (account, tool))
            db.execute('DELETE FROM uploads WHERE id=?', (upload_id,))
        self._spool(upload_id).unlink(missing_ok=True)
        return {'revision': row['revision'] + 1, 'epoch': row['epoch'], 'used_bytes': used + delta}

    def abort(self, account, tool, owner, upload_id):
        with self.lock, self._connect() as db:
            if db.execute('SELECT 1 FROM uploads WHERE id=? AND account=? AND tool=? AND owner=?', (upload_id, account, tool, owner)).fetchone():
                self._drop(db, upload_id)

    def delete_account(self, account):
        with self.lock, self._connect() as db:
            for row in db.execute('SELECT id FROM uploads WHERE account=?', (account,)).fetchall():
                self._drop(db, row['id'])
            for table in ('entries', 'profiles'):
                db.execute('DELETE FROM ' + table + ' WHERE account=?', (account,))
            db.execute('DELETE FROM accounts WHERE id=?', (account,))
