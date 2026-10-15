"""Bounded editor paste ranges, kept outside student-accessible workspaces.

Ranges use UTF-16 offsets to agree with browser strings. This is an editing
signal, not source attribution, AI detection, or tamper-proof evidence.
"""
import hashlib
import shutil
import threading

_LOCKS = [threading.RLock() for _ in range(64)]
MAX_RANGES = 512


def lock(user_dir):
    # Bounded lock striping keeps different classrooms' saves independent.
    return _LOCKS[int(hashlib.sha256(user_dir.name.encode()).hexdigest()[:8], 16) % len(_LOCKS)]


def length(text):
    return len(text.encode("utf-16-le")) // 2


def normalize(value, text):
    if not isinstance(value, list) or len(value) > MAX_RANGES:
        raise ValueError("Invalid editor ranges")
    limit = length(text)
    result = []
    for item in value:
        if not isinstance(item, list) or len(item) != 2 or any(type(n) is not int for n in item) or not 0 <= item[0] < item[1] <= limit:
            raise ValueError("Invalid editor ranges")
        result.append(item[:])
    merged = []
    for start, end in sorted(result):
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(end, merged[-1][1])
        else:
            merged.append([start, end])
    return merged


def directory(eagle, user_dir):
    return eagle.USER_FILES_DIR.parent / "file_provenance" / user_dir.name


def location(eagle, user_dir, target):
    key = target.resolve().relative_to(user_dir.resolve()).as_posix()
    return directory(eagle, user_dir) / (hashlib.sha256(key.encode()).hexdigest() + ".json"), key


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def read(eagle, user_dir, target, content):
    with lock(user_dir):
        path, _ = location(eagle, user_dir, target)
        record = eagle._read_json_file(path, {})
        if not isinstance(record, dict) or not record.get("sha256") or record["sha256"] != digest(content):
            return []
        try:
            return normalize(record.get("ranges", []), content)
        except ValueError:
            return []


def remap(ranges, old, new):
    """Linear fallback for API writes without browser edit positions."""
    if not ranges or not new:
        return []
    if old == new:
        return normalize(ranges, new)
    if old and new.endswith(old):
        shift = length(new[:-len(old)])
        return [[start + shift, end + shift] for start, end in ranges]
    prefix = 0
    while prefix < min(len(old), len(new)) and old[prefix] == new[prefix]:
        prefix += 1
    suffix = 0
    while suffix < min(len(old), len(new)) - prefix and old[-suffix - 1] == new[-suffix - 1]:
        suffix += 1
    start = length(old[:prefix])
    end = length(old[:len(old) - suffix])
    delta = length(new) - length(old)
    result = []
    for left, right in ranges:
        if left < start:
            result.append([left, min(right, start)])
        if right > end:
            result.append([max(left, end) + delta, right + delta])
    return normalize(result, new)


def write(eagle, user_dir, target, content, ranges):
    with lock(user_dir):
        path, key = location(eagle, user_dir, target)
        if not ranges:
            path.unlink(missing_ok=True)
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        eagle._write_json_file_atomic(path, {"path": key, "sha256": digest(content), "ranges": ranges})


def move(eagle, user_dir, source, destination, *, keep_source=False):
    """Follow folder/file moves, including Trash and restore."""
    with lock(user_dir):
        root = directory(eagle, user_dir)
        if not root.exists():
            return
        old = source.relative_to(user_dir.resolve()).as_posix()
        new = destination.relative_to(user_dir.resolve()).as_posix()
        for path in root.glob("*.json"):
            record = eagle._read_json_file(path, {})
            if not isinstance(record, dict):
                continue
            key = record.get("path", "")
            if key == old or key.startswith(old + "/"):
                record["path"] = new + key[len(old):]
                target = root / (hashlib.sha256(record["path"].encode()).hexdigest() + ".json")
                eagle._write_json_file_atomic(target, record)
                if target != path and not keep_source:
                    path.unlink(missing_ok=True)


def remove(eagle, user_dir, target):
    with lock(user_dir):
        root = directory(eagle, user_dir)
        if not root.exists():
            return
        key = target.relative_to(user_dir.resolve()).as_posix()
        for path in root.glob("*.json"):
            record = eagle._read_json_file(path, {})
            if not isinstance(record, dict):
                continue
            if record.get("path") == key or str(record.get("path", "")).startswith(key + "/"):
                path.unlink(missing_ok=True)


def clear(eagle, user_dir):
    with lock(user_dir):
        root = (eagle.USER_FILES_DIR.parent / "file_provenance").resolve()
        target = directory(eagle, user_dir)
        if target.resolve().parent != root:
            raise ValueError("Invalid provenance directory")
        if target.exists():
            shutil.rmtree(target)
