"""Cleanup of confirmed absent accounts; never classify disabled users as deleted."""
import hashlib
from pathlib import Path
import re

import assignment_development
import assignment_workflow
import classroom_features
import file_provenance
from cleanup_files import checked_path, children, read_json


def assignment_files(eagle):
    for path in children(eagle.ASSIGNMENTS_DIR):
        if path.suffix == ".json" and not path.name.startswith("."):
            checked_path(eagle.ASSIGNMENTS_DIR, path)
            data = read_json(path)
            if not isinstance(data, dict) or not isinstance(data.get("submissions", []), list):
                raise ValueError("Invalid assignment store; deleted-user cleanup stopped")
            yield path, data


def discover_emails(eagle):
    result = set()
    with eagle._assignment_lock:
        for _, assignment in assignment_files(eagle):
            result.update(str(row.get("email") or "").strip().lower() for row in assignment.get("submissions", []) if isinstance(row, dict))
            for field in ("studentExtensions", "studentAccess"):
                if isinstance(assignment.get(field), dict): result.update(assignment[field])
        directory = assignment_development._directory(eagle)
        for path in children(directory):
            if re.fullmatch(r"[a-f0-9]{32}\.sqlite3", path.name):
                checked_path(directory, path)
                with assignment_development._database(path) as db:
                    result.update(row[0] for row in db.execute("SELECT DISTINCT email FROM streams"))
        if (directory / "index.sqlite3").exists():
            checked_path(directory, directory / "index.sqlite3")
            with assignment_development._catalog(eagle) as db:
                result.update(row[0] for row in db.execute("SELECT DISTINCT email FROM bindings"))
    with eagle._lb_lock:
        scores = read_json(eagle.CHALLENGE_SCORE_FILE, default={"students": {}})
        result.update(scores.get("students", {}))
    network = eagle.app.extensions["network_store"]
    with network._lock:
        for class_dir in children(network.progress_dir):
            checked_path(network.progress_dir, class_dir)
            if not class_dir.is_dir(): continue
            for lab in children(class_dir):
                checked_path(network.progress_dir, lab)
                if not lab.is_dir(): continue
                for path in children(lab):
                    if path.suffix == ".json":
                        checked_path(network.progress_dir, path)
                        data = read_json(path)
                        result.add(str(data.get("student_email") or "").strip().lower())
    with eagle._wiki_store._write_lock, eagle._wiki_store._connect() as db:
        result.update(row[0] for row in db.execute("SELECT DISTINCT owner_email FROM bookmarks"))
    for path, lock in ((eagle.SIGN_IN_EVENTS_FILE, eagle._server_health_lock), (eagle.SERVER_EVENTS_FILE, eagle._server_health_lock),
                       (classroom_features.CLASSROOM_EVENTS_FILE, classroom_features._classroom_events_lock)):
        with lock:
            for row in read_json(checked_path(path.parent, path), default=[]):
                result.update(str(row.get(field) or "").strip().lower() for field in ("email", "actor_email", "student_email"))
    return {str(email).strip().lower() for email in result if isinstance(email, str) and re.fullmatch(r"[^\s@]+@[^\s@]+", email)}


def _prune_list(run, root, path, lock, email):
    with lock:
        rows = read_json(checked_path(root, path), default=[])
        if not isinstance(rows, list): raise ValueError("Invalid event store")
        remaining = [row for row in rows if not any(str(row.get(field) or "").lower() == email
                     for field in ("email", "actor_email", "student_email"))]
        if remaining != rows:
            run.json("deleted_users", root, path, remaining, len(rows) - len(remaining))


def purge_account(run, email):
    eagle, kind = run.manager.eagle, "deleted_users"
    key = eagle._sanitize_email_for_path(email)
    # Deletion and registration are serialized for this identity/workspace by
    # the manager's busy guard, without holding the global users lock on disk IO.
    run.delete(kind, eagle.USER_FILES_DIR, eagle._get_user_dir(email))
    provenance_root = eagle.USER_FILES_DIR.parent / "file_provenance"
    with file_provenance.lock(eagle._get_user_dir(email)):
        run.delete(kind, provenance_root, provenance_root / key)
    drop_practice = getattr(eagle, "_drop_notebook_practice_account", None)
    if drop_practice:
        journal = Path(eagle.NOTEBOOKS_DIR) / ".practice-queue.json"
        run.change(kind, journal, "prune_pending_jobs", lambda: drop_practice(email))
    with eagle._notebooks_lock:
        for directory in children(eagle.NOTEBOOKS_DIR):
            checked_path(eagle.NOTEBOOKS_DIR, directory)
            if directory.is_dir():
                run.delete(kind, eagle.NOTEBOOKS_DIR, directory / (key + ".json"))
    # A canceled/in-flight grade must not restore a removed submission later.
    eagle._cancel_ai_jobs(lambda job: job.get("kind") == "assignment-grading"
                          and str((job.get("metadata") or {}).get("studentEmail") or "").lower() == email)
    with eagle._assignment_lock:
        for path, assignment in assignment_files(eagle):
            removed = [row for row in assignment.get("submissions", []) if str(row.get("email") or "").lower() == email]
            access = any(isinstance(assignment.get(field), dict) and email in assignment[field] for field in ("studentExtensions", "studentAccess"))
            if not removed and not access: continue
            identity = assignment.get("id", "")
            with eagle._assignment_ai_queue_lock:
                eagle._assignment_ai_cancelled_keys.add((identity, email))
            kept = [row for row in assignment.get("submissions", []) if row not in removed]
            retained_paths = {f.get("path") for row in kept for snapshot in [row, *(row.get("history") or [])]
                              for f in assignment_workflow.files_for(snapshot)}
            file_paths = set()
            for row in removed:
                for snapshot in [row, *(row.get("history") or [])]:
                    for item in assignment_workflow.files_for(snapshot):
                        if item.get("path") and item["path"] not in retained_paths:
                            # Validate the unresolved path first: the normal
                            # helper resolves links for request handling.
                            checked_path(eagle.ASSIGNMENT_SUBMISSIONS_DIR, eagle.ASSIGNMENT_SUBMISSIONS_DIR / item["path"])
                            target = eagle._assignment_submission_path(assignment, item["path"])
                            if not target: raise ValueError("Invalid deleted-user submission path")
                            file_paths.add(checked_path(eagle.ASSIGNMENT_SUBMISSIONS_DIR, target))
            # New bundles have a deterministic private per-account directory,
            # which includes all retained revisions, not just the current files.
            component = eagle._sanitize_storage_component
            raw_directory = (eagle.ASSIGNMENT_SUBMISSIONS_DIR / component(assignment.get("targetClassId") or "unassigned", fallback="unassigned", max_length=80) /
                (component(assignment.get("name") or "Assignment", fallback="Assignment", max_length=80) + "--" +
                 component(assignment.get("id") or "legacy", fallback="legacy", max_length=80)[:12]))
            checked_path(eagle.ASSIGNMENT_SUBMISSIONS_DIR, raw_directory)
            bundle = raw_directory / ("student--" + hashlib.sha256(email.encode()).hexdigest()[:20])
            checked_path(eagle.ASSIGNMENT_SUBMISSIONS_DIR, bundle)
            shared_bundle = any(checked_path(eagle.ASSIGNMENT_SUBMISSIONS_DIR, eagle.ASSIGNMENT_SUBMISSIONS_DIR / relative).is_relative_to(bundle)
                                for relative in retained_paths if relative)
            for target in file_paths:
                run.delete(kind, eagle.ASSIGNMENT_SUBMISSIONS_DIR, target)
            if not shared_bundle: run.delete(kind, eagle.ASSIGNMENT_SUBMISSIONS_DIR, bundle)
            for row in removed:
                assignment["submissions"].remove(row)
            for field in ("studentExtensions", "studentAccess"):
                if isinstance(assignment.get(field), dict): assignment[field].pop(email, None)
            run.json(kind, eagle.ASSIGNMENTS_DIR, path, assignment, len(removed))
        development = assignment_development._directory(eagle)
        for path in children(development):
            if re.fullmatch(r"[a-f0-9]{32}\.sqlite3", path.name):
                checked_path(development, path)
                with assignment_development._database(path) as db:
                    count = db.execute("SELECT COUNT(*) FROM streams WHERE email=?", (email,)).fetchone()[0]
                    if count:
                        def remove():
                            db.execute("PRAGMA secure_delete=ON")
                            for table in ("streams", "frames", "batches"):
                                db.execute("DELETE FROM " + table + " WHERE email=?", (email,))
                            db.commit()
                        run.change(kind, str(path) + "#account", "prune_records", remove, records=count)
        if (development / "index.sqlite3").exists():
            checked_path(development, development / "index.sqlite3")
            with assignment_development._catalog(eagle) as db:
                count = db.execute("SELECT COUNT(*) FROM bindings WHERE email=?", (email,)).fetchone()[0]
                if count:
                    def remove_bindings():
                        db.execute("PRAGMA secure_delete=ON")
                        db.execute("DELETE FROM bindings WHERE email=?", (email,)); db.commit()
                    run.change(kind, str(development / "index.sqlite3") + "#bindings", "prune_records", remove_bindings, records=count)
        assignment_development._storage_cache.pop(str(development), None)
        assignment_development.invalidate_policy()
    network = eagle.app.extensions["network_store"]
    with network._lock:
        run.delete(kind, network.users_dir, network._user_path(email))
        digest = network._user_key(email) + ".json"
        for class_dir in children(network.progress_dir):
            checked_path(network.progress_dir, class_dir)
            if class_dir.is_dir():
                for lab in children(class_dir):
                    checked_path(network.progress_dir, lab)
                    if lab.is_dir(): run.delete(kind, network.progress_dir, lab / digest)
    with eagle._lb_lock:
        path = eagle.CHALLENGE_SCORE_FILE
        scores = read_json(path, default={"students": {}})
        if email in scores.get("students", {}):
            scores["students"].pop(email)
            run.json(kind, path.parent, path, scores, 1)
    wiki = eagle._wiki_store
    with wiki._write_lock, wiki._connect() as db:
        count = db.execute("SELECT COUNT(*) FROM bookmarks WHERE lower(owner_email)=?", (email,)).fetchone()[0]
        if count:
            def remove_bookmarks():
                db.execute("PRAGMA secure_delete=ON")
                db.execute("DELETE FROM bookmarks WHERE lower(owner_email)=?", (email,)); db.commit()
            run.change(kind, str(wiki.db_path) + "#bookmarks", "prune_records", remove_bookmarks, records=count)
    for path in (eagle.SIGN_IN_EVENTS_FILE, eagle.SERVER_EVENTS_FILE):
        _prune_list(run, path.parent, path, eagle._server_health_lock, email)
    _prune_list(run, classroom_features.CLASSROOM_EVENTS_FILE.parent, classroom_features.CLASSROOM_EVENTS_FILE,
                classroom_features._classroom_events_lock, email)
    with classroom_features._classroom_signals_lock:
        path = classroom_features.CLASSROOM_SIGNALS_FILE
        signals = read_json(path, default={"classes": {}})
        changed = 0
        for bucket in signals.get("classes", {}).values():
            for field in ("hands", "questions"):
                old = bucket.get(field, [])
                bucket[field] = [row for row in old if str(row.get("student_email") or "").lower() != email]
                changed += len(old) - len(bucket[field])
            if email in bucket.get("silenced", {}): bucket["silenced"].pop(email); changed += 1
        if changed: run.json(kind, path.parent, path, signals, changed)
