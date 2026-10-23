"""Bounded, link-refusing file operations used only by registered cleanup types."""
import json
import os
from pathlib import Path
import stat
import sqlite3
import uuid


class PolicyChanged(RuntimeError):
    pass


class LedgerUnavailable(RuntimeError):
    pass


def checked_path(root, path):
    if ".." in Path(path).parts:
        raise ValueError("Invalid cleanup path")
    root, path = Path(root).absolute(), Path(path).absolute()
    if root == Path(root.anchor) or path == root:
        raise ValueError("Cleanup refuses a root directory")
    relative = path.relative_to(root)
    if any(part in {"..", "."} for part in relative.parts):
        raise ValueError("Invalid cleanup path")
    for candidate in (root, *[root.joinpath(*relative.parts[:index]) for index in range(1, len(relative.parts) + 1)]):
        try:
            info = candidate.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError("Filesystem links and junctions are excluded")
    if not path.resolve().is_relative_to(root.resolve()):
        raise ValueError("Cleanup containment failed")
    return path


def children(directory):
    directory = Path(directory)
    if not directory.exists():
        return []
    if directory.is_symlink() or directory.is_junction():
        raise ValueError("Linked directory excluded")
    with os.scandir(directory) as entries:
        result = []
        for entry in entries:
            if len(result) >= 100_000:
                raise ValueError("Directory exceeds the cleanup scan limit")
            result.append(Path(entry.path))
    return sorted(result)


def read_json(path, *, default=None):
    path = Path(path)
    if not path.exists():
        return default
    if path.is_symlink() or path.stat().st_size > 50 * 1024 * 1024:
        raise ValueError("Data file is linked or exceeds cleanup read limits")
    return json.loads(path.read_text(encoding="utf-8"))


def atomic_bytes(path, value):
    path = Path(path)
    permissions = stat.S_IMODE(path.stat().st_mode)
    temporary = path.with_name("." + path.name + "." + uuid.uuid4().hex + ".cleanup-tmp")
    try:
        with temporary.open("xb") as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, permissions)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


class CleanupRun:
    def __init__(self, manager, identity, revision, policy, now):
        self.manager, self.store, self.id = manager, manager.store, identity
        self.revision, self.policy, self.now = revision, policy, now
        self.operations = 0

    def cutoff(self, kind):
        return self.now - self.policy["rules"][kind]["days"] * 86400

    @staticmethod
    def ledger(operation, *args):
        try:
            return operation(*args)
        except (OSError, sqlite3.Error, ValueError) as exc:
            raise LedgerUnavailable("Cleanup ledger unavailable") from exc

    def check(self):
        if self.manager.stop_event.is_set():
            raise PolicyChanged("Service stopping")
        revision, policy = self.ledger(self.store.policy)
        if revision != self.revision or not policy["enabled"]:
            raise PolicyChanged("Cleanup rules changed; start a new run using the saved rules")
        if self.operations >= 20_000:
            raise PolicyChanged("Batch limit reached; Clean now or the next hourly sweep will continue")

    def change(self, kind, path, action, operation, *, size=0, records=0, name=None):
        with self.manager.gate:
            self.check()
            receipt = self.ledger(self.store.plan, self.id, kind, path, action, size, records, name)
            self.operations += 1
            try:
                result = operation()
            except FileNotFoundError:
                self.ledger(self.store.result, receipt, "skipped", "Already absent")
                return None
            except Exception as exc:
                self.ledger(self.store.result, receipt, "failed", type(exc).__name__)
                raise
            self.ledger(self.store.result, receipt, "deleted")
            return result

    def note(self, kind, path, status, message):
        with self.manager.gate:
            self.check()
            receipt = self.ledger(self.store.plan, self.id, kind, path, "inspect")
            self.operations += 1
            self.ledger(self.store.result, receipt, status, message)

    def delete(self, kind, root, path):
        path = checked_path(root, path)
        if path == self.store.root or path.is_relative_to(self.store.root):
            raise ValueError("The permanent cleanup ledger is protected")
        if not path.exists():
            return
        if path.is_dir():
            # No recursive rmtree: each child is checked and receipted before
            # unlink, and a newly introduced link/new child stops this deletion.
            for child in children(path):
                self.delete(kind, root, child)
            self.change(kind, path, "delete_directory", lambda: checked_path(root, path).rmdir())
        else:
            size = path.stat().st_size
            self.change(kind, path, "delete_file", lambda: checked_path(root, path).unlink(), size=size)

    def json(self, kind, root, path, value, records):
        path = checked_path(root, path)
        before = path.stat().st_size
        encoded = json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8")
        return self.change(kind, path, "prune_records", lambda: atomic_bytes(checked_path(root, path), encoded),
                           size=max(0, before - len(encoded)), records=records)
