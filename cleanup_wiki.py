"""Catalog-aware wiki cleanup; never infer liveness from file modification age."""
from datetime import datetime, timezone
import re

from cleanup_files import checked_path, children


def stamp(value, *, local=False):
    if type(value) in (int, float):
        return float(value)
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if local and parsed.tzinfo is None:
            return parsed.timestamp()
        return (parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)).timestamp()
    except (ValueError, TypeError):
        return float("inf")


def archives(run, store):
    kind = "wiki_backups"
    with store._write_lock:
        for path in children(store.backup_dir):
            if re.fullmatch(r"(?:wiki_backup|pre_restore)_\d{8}_\d{6}_[0-9a-f]{8}\.zip", path.name):
                path = checked_path(store.backup_dir, path)
                if path.stat().st_mtime <= run.cutoff(kind):
                    run.delete(kind, store.backup_dir, path)


def trash(run, store):
    kind, cutoff = "wiki_trash", run.cutoff("wiki_trash")
    with store._write_lock, store._connect() as db:
        rows = [dict(row) for row in db.execute("SELECT * FROM nodes WHERE deleted_at IS NOT NULL")]
        deleted = {row["id"] for row in rows}
        for root in rows:
            if root["parent_id"] in deleted or stamp(root["deleted_at"]) > cutoff:
                continue
            ids = store._descendant_ids(db, root["id"], include_root=True)
            placeholders = ",".join("?" for _ in ids)
            nodes = [dict(row) for row in db.execute(f"SELECT * FROM nodes WHERE id IN ({placeholders})", ids)]
            if any(not row["deleted_at"] or stamp(row["deleted_at"]) > cutoff for row in nodes):
                continue
            files = []
            for row in nodes:
                if row["storage_name"]:
                    directory = store.content_dir if row["kind"] == "page" else store.media_dir
                    shared = db.execute(f"SELECT 1 FROM nodes WHERE storage_name=? AND id NOT IN ({placeholders})",
                                        [row["storage_name"], *ids]).fetchone()
                    if not shared:
                        files.append((directory, checked_path(directory, directory / row["storage_name"])))
            for table, directory in (("revisions", store.revisions_dir), ("page_drafts", store.drafts_dir)):
                for row in db.execute(f"SELECT storage_name FROM {table} WHERE page_id IN ({placeholders})", ids):
                    shared = db.execute(f"SELECT 1 FROM {table} WHERE storage_name=? AND page_id NOT IN ({placeholders})",
                                        [row["storage_name"], *ids]).fetchone()
                    if not shared:
                        files.append((directory, checked_path(directory, directory / row["storage_name"])))
            # Validate the complete file set before the first irreversible unlink.
            for directory, path in files:
                run.delete(kind, directory, path)
            def remove_nodes():
                db.execute("PRAGMA secure_delete=ON")
                if db.execute("SELECT value FROM settings WHERE key='fts5'").fetchone()[0] == "1":
                    db.executemany("DELETE FROM wiki_fts WHERE node_id=?", [(identity,) for identity in ids])
                for identity in reversed(ids):
                    db.execute("DELETE FROM nodes WHERE id=?", (identity,))
                store._bump_version(db)
                db.commit()
            run.change(kind, str(store.db_path) + "#deleted-nodes/" + root["id"], "prune_records", remove_nodes,
                       records=len(nodes), name=root["title"])


def analytics(run, store):
    cutoff = datetime.fromtimestamp(run.cutoff("wiki_analytics"), timezone.utc).strftime("%Y-%m-%d")
    with store._write_lock, store._connect() as db:
        count = db.execute("SELECT COUNT(*) FROM analytics_daily WHERE day<?", (cutoff,)).fetchone()[0]
        if count:
            def remove():
                db.execute("PRAGMA secure_delete=ON")
                db.execute("DELETE FROM analytics_daily WHERE day<?", (cutoff,))
                db.commit()
            run.change("wiki_analytics", str(store.db_path) + "#analytics_daily", "prune_records", remove, records=count)


def recovery(run, history):
    with history.lock:
        with history.connect() as db:
            count = db.execute("SELECT COUNT(*) FROM milestones WHERE created<=?", (run.cutoff("wiki_recovery"),)).fetchone()[0]
        # The receipt is committed before catalog/file changes. Every physical
        # manifest/blob unlink receives a separate permanent filename receipt.
        def prune():
            return history.prune(max_age_seconds=run.policy["rules"]["wiki_recovery"]["days"] * 86400, now=run.now,
                                 delete_file=lambda path: run.delete("wiki_recovery", history.root, path))
        if count:
            run.change("wiki_recovery", str(history.root / "history.sqlite3") + "#recovery", "prune_records", prune, records=count)
        else:
            prune()


def audit(run, history):
    with history.lock, history.connect() as db:
        cutoff = run.cutoff("wiki_audit")
        condition = "created<=? AND id NOT IN (SELECT id FROM milestones)"
        count = db.execute("SELECT COUNT(*) FROM audit WHERE " + condition, (cutoff,)).fetchone()[0]
        if count:
            def remove():
                db.execute("PRAGMA secure_delete=ON")
                db.execute("DELETE FROM audit WHERE " + condition, (cutoff,))
                db.commit()
            run.change("wiki_audit", str(history.root / "history.sqlite3") + "#audit", "prune_records", remove, records=count)
