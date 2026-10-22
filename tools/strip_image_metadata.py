"""Explicit image metadata migration. Back up first; run while uploads are paused.

Keeps image paths, formats, dimensions and animation. Default is read-only.
Prints counts only, never filenames or embedded metadata.
"""

import argparse
import json
import os
from pathlib import Path
import sys
import sqlite3
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from media_security import clean_image, FORMATS


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path, help="workspace or wiki media directory")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--wiki-catalog", type=Path, help="wiki.db for a wiki media migration; keeps quota accounting synchronized")
    args = parser.parse_args()
    root = args.root.resolve(strict=True)
    catalog = args.wiki_catalog.resolve(strict=True) if args.wiki_catalog else None
    if catalog and (root.name != "media" or catalog != root.parent / "wiki.db"):
        raise SystemExit("The wiki catalog must be the wiki.db immediately above its media directory.")
    if args.apply and root.name == "media" and (root.parent / "wiki.db").exists() and not catalog:
        raise SystemExit("Pass --wiki-catalog for wiki media so quota metadata stays consistent.")
    counts = {"images": 0, "written": 0, "skipped": 0, "failed": 0}
    for target in root.rglob("*"):
        if target.is_symlink() or not target.is_file() or target.suffix.lower() not in FORMATS:
            continue
        temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
        try:
            target.resolve().relative_to(root)
            stat = target.stat()
            if stat.st_size > 10 * 1024 * 1024:
                counts["skipped"] += 1
                continue
            original = target.read_bytes()
            cleaned = clean_image(original, target.suffix)
            counts["images"] += 1
            # Do not push an existing account or asset over its current quota.
            if len(cleaned) > stat.st_size or len(cleaned) > 10 * 1024 * 1024:
                counts["skipped"] += 1
                continue
            if args.apply:
                database = sqlite3.connect(catalog) if catalog else None
                backup = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
                try:
                    if database:
                        database.execute("BEGIN IMMEDIATE")
                        row = database.execute("SELECT id FROM nodes WHERE storage_name=? AND kind='image'", (target.name,)).fetchone()
                        if not row:
                            raise ValueError("Image is absent from the wiki catalog")
                    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    with os.fdopen(descriptor, "wb") as output:
                        output.write(cleaned)
                        output.flush()
                        os.fsync(output.fileno())
                    if target.stat().st_mtime_ns != stat.st_mtime_ns:
                        raise ValueError("Image changed during migration")
                    os.replace(target, backup)
                    os.replace(temporary, target)
                    if database:
                        database.execute("UPDATE nodes SET size_bytes=? WHERE id=?", (len(cleaned), row[0]))
                        database.execute("UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='catalog_version'")
                        database.commit()
                    try:
                        backup.unlink()
                    except OSError:
                        counts["failed"] += 1
                    counts["written"] += 1
                except BaseException:
                    if database:
                        database.rollback()
                    if backup.exists():
                        os.replace(backup, target)
                    raise
                finally:
                    if database:
                        database.close()
        except (OSError, ValueError, sqlite3.Error):
            counts["failed"] += 1
        finally:
            temporary.unlink(missing_ok=True)
    print(json.dumps({"apply": args.apply, **counts}))
    return int(bool(counts["failed"] or counts["skipped"]))


if __name__ == "__main__":
    raise SystemExit(main())
