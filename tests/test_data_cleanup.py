"""Opt-in retention, permanent receipts, isolation and store-aware cleanup."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from flask import Flask
import assignment_development
import classroom_features
from cleanup_files import checked_path
from cleanup_store import KINDS, default_policy
from data_cleanup import AccountCleanupBusy, CleanupManager, register
from network_store import NetworkStore
from tool_storage import ToolStorage
from wiki_history import WikiHistory
from wiki_store import WikiStore
from tests.test_html_runtime import eagle


class DataCleanupTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        for name, value in {
            "USERS_FILE": self.root / "users.json", "CLASSES_FILE": self.root / "classes.json",
            "USER_FILES_DIR": self.root / "files", "NOTEBOOKS_DIR": self.root / "notebooks",
            "ASSIGNMENTS_DIR": self.root / "assignments", "ASSIGNMENT_SUBMISSIONS_DIR": self.root / "submissions",
            "SANDBOX_DIR": self.root / "sandboxes", "BACKGROUND_ASSETS_DIR": self.root / "backgrounds",
            "PERSIST_FILE": self.root / "config.txt", "APP_LOG_FILE": self.root / "server.log",
            "SIGN_IN_EVENTS_FILE": self.root / "signins.json", "SERVER_EVENTS_FILE": self.root / "events.json",
            "CHALLENGE_SCORE_FILE": self.root / "scores.json", "_users_cache": None, "_classes_cache": None,
        }.items():
            context = patch.object(eagle, name, value); context.start(); self.addCleanup(context.stop)
        for name in ("CLASSROOM_EVENTS_FILE", "CLASSROOM_SIGNALS_FILE"):
            context = patch.object(classroom_features, name, self.root / (name.lower() + ".json"))
            context.start(); self.addCleanup(context.stop)
        for name in ("USER_FILES_DIR", "NOTEBOOKS_DIR", "ASSIGNMENTS_DIR", "ASSIGNMENT_SUBMISSIONS_DIR", "SANDBOX_DIR", "BACKGROUND_ASSETS_DIR"):
            getattr(eagle, name).mkdir()
        self.student = {"email": "cleanup-student@example.invalid", "role": "student", "enabled": True, "class_id": "class-one"}
        self.disabled = {"email": "disabled@example.invalid", "role": "student", "enabled": False}
        eagle._save_users({"users": [self.student, self.disabled]})
        eagle._save_classes({"classes": [{"id": "class-one", "students": [self.student["email"]], "settings": {}}]})
        eagle.PERSIST_FILE.write_text("{}")
        wiki = WikiStore(self.root / "wiki", backup_dir=self.root / "backups", managed_retention=True)
        context = patch.object(eagle, "_wiki_store", wiki); context.start(); self.addCleanup(context.stop)
        storage = ToolStorage(self.root / "tools")
        context = patch.object(eagle, "_external_tools", SimpleNamespace(storage=storage)); context.start(); self.addCleanup(context.stop)
        self.manager = CleanupManager(eagle, self.root / "cleanup")
        self.addCleanup(self.manager.close)
        self.manager.start_scheduler = lambda: None
        context = patch.object(eagle, "_data_cleanup", self.manager); context.start(); self.addCleanup(context.stop)
        history = WikiHistory(wiki, retention_provider=lambda: self.manager.retention("wiki_recovery"))
        context = patch.dict(eagle.app.extensions, {"eagle_wiki_history": history, "network_store": NetworkStore(self.root / "network")})
        context.start(); self.addCleanup(context.stop)
        self.app = Flask(__name__)
        register(self.app, eagle, self.manager)
        self.client = self.app.test_client()
        self.token = "cleanup-admin-fixture"
        eagle._admin_tokens.add(self.token); self.addCleanup(eagle._admin_tokens.discard, self.token)
        self.headers = {"X-Admin-Token": self.token}
        self.now = time.time()

    def enable(self, *kinds, days=1):
        revision, policy = self.manager.store.policy()
        policy["enabled"] = True
        for kind in kinds: policy["rules"][kind] = {"enabled": True, "days": days}
        self.manager.save(revision, policy)

    def run_cleanup(self, now=None):
        return self.manager.request_run(synchronous=True, now=self.now if now is None else now)

    def test_defaults_auth_validation_and_stale_settings(self):
        for header in ({}, {"X-User-Token": "student"}, {"X-Teacher-Token": "teacher"}, {"X-Wiki-Manager-Token": "manager"}):
            self.assertEqual(self.client.get("/api/admin/cleanup", headers=header).status_code, 401)
            self.assertEqual(self.client.post("/api/admin/cleanup/run", headers=header, json={}).status_code, 401)
        result = self.client.get("/api/admin/cleanup", headers=self.headers)
        self.assertEqual(result.status_code, 200)
        self.assertIn("no-store", result.headers["Cache-Control"])
        self.assertFalse(result.json["policy"]["enabled"])
        self.assertEqual(set(result.json["policy"]["rules"]), set(KINDS))
        self.assertTrue(all(not row["enabled"] for row in result.json["policy"]["rules"].values()))
        self.assertEqual(self.client.post("/api/admin/cleanup/run", headers=self.headers, json={}).status_code, 409)
        data = {"revision": 0, "policy": default_policy()}
        for value in (True, 0, -1, 3651, "30", 1.5):
            policy = default_policy(); policy["rules"]["workspace_trash"]["days"] = value
            self.assertEqual(self.client.post("/api/admin/cleanup/policy", headers=self.headers,
                json={"revision": 0, "policy": policy}).status_code, 400)
        self.assertEqual(self.client.post("/api/admin/cleanup/policy", headers=self.headers, json=data).status_code, 200)
        self.assertEqual(self.client.post("/api/admin/cleanup/policy", headers=self.headers, json=data).status_code, 409)
        self.assertEqual(self.client.post("/api/admin/cleanup/run", headers=self.headers, json={"path": str(self.root)}).status_code, 400)
        for cursor in ("-1", "not-a-number", str(2**100)):
            self.assertEqual(self.client.get("/api/admin/cleanup?before=" + cursor, headers=self.headers).status_code, 400)

    def make_trash(self, name, days):
        workspace = eagle._get_user_dir(self.student["email"])
        eagle._ensure_workspace_system_dirs(workspace)
        path = workspace / name; path.write_text("fixture work")
        target, _ = eagle._move_workspace_item_to_trash(workspace, path)
        items = eagle._load_trash_metadata(workspace)
        items[target.relative_to(workspace).as_posix()]["deleted_at"] = self.now - days * 86400
        eagle._save_trash_metadata(workspace, items)
        return workspace, target

    def test_trash_rules_preserve_recent_active_and_disabled_types_and_audit_every_file(self):
        workspace, old = self.make_trash("old.py", 40)
        _, recent = self.make_trash("recent.py", 1)
        active = workspace / "active.py"; active.write_text("old but active")
        os.utime(active, (1, 1))
        self.assertEqual(eagle._purge_expired_trash(workspace, now=self.now), 0)
        self.assertTrue(old.exists())
        self.enable("workspace_trash", days=30)
        self.run_cleanup()
        self.assertFalse(old.exists()); self.assertTrue(recent.exists()); self.assertTrue(active.exists())
        receipts = self.manager.store.history()["entries"]
        deleted = [row for row in receipts if row["action"] == "delete_file"]
        self.assertEqual([(row["name"], row["path"], row["status"]) for row in deleted], [(old.name, str(old), "deleted")])
        self.assertNotIn("fixture work", json.dumps(receipts))
        self.assertNotIn(old.relative_to(workspace).as_posix(), eagle._load_trash_metadata(workspace))
        self.assertEqual(eagle._trash_expires_at(self.now), int(self.now) + 30 * 86400)

    def test_unknown_trash_age_gets_a_fresh_grace_period(self):
        workspace = eagle._get_user_dir(self.student["email"]); eagle._ensure_workspace_system_dirs(workspace)
        path = workspace / "Trash" / "legacy.py"; path.write_text("legacy"); os.utime(path, (1, 1))
        eagle._save_trash_metadata(workspace, {"Trash/legacy.py": {"original_path": "legacy.py"}})
        self.enable("workspace_trash")
        self.run_cleanup(); self.assertTrue(path.exists())
        self.run_cleanup(self.now + 86401); self.assertFalse(path.exists())

    def test_corrupt_trash_path_cannot_select_an_active_workspace(self):
        workspace, path = self.make_trash("old.py", 40)
        live = workspace / "live.py"; live.write_text("keep")
        eagle._save_trash_metadata(workspace, {"Trash/..": {"deleted_at": 1}})
        self.enable("workspace_trash"); self.run_cleanup()
        self.assertTrue(live.exists()); self.assertTrue(path.exists())
        self.assertEqual(self.manager.store.history()["runs"][0]["status"], "partial")

    def test_audit_failure_and_changed_policy_stop_deletion(self):
        _, first = self.make_trash("a.py", 40); _, second = self.make_trash("b.py", 40)
        self.enable("workspace_trash")
        with patch.object(self.manager.store, "plan", side_effect=sqlite3.OperationalError("unavailable")):
            self.run_cleanup()
        self.assertTrue(first.exists()); self.assertTrue(second.exists())
        original = Path.unlink
        def unlink(path, *args, **kwargs):
            result = original(path, *args, **kwargs)
            if path == first:
                revision, policy = self.manager.store.policy(); policy["enabled"] = False
                self.manager.save(revision, policy)
            return result
        with patch.object(Path, "unlink", unlink): self.run_cleanup()
        self.assertFalse(first.exists()); self.assertTrue(second.exists())
        self.assertEqual(self.manager.store.history()["runs"][0]["status"], "stopped")
        self.enable("workspace_trash")
        self.run_cleanup()
        self.assertFalse(second.exists())
        self.assertFalse(eagle._load_trash_metadata(first.parent.parent))

    def test_ledger_outcome_failure_aborts_other_enabled_types(self):
        _, old = self.make_trash("old.py", 40)
        archive = eagle._wiki_store.create_backup(); os.utime(archive, (1, 1))
        self.enable("workspace_trash", "wiki_backups")
        with patch.object(self.manager.store, "result", side_effect=sqlite3.OperationalError("unavailable")):
            self.run_cleanup()
        self.assertFalse(old.exists()); self.assertTrue(archive.exists())
        state = self.manager.store.history()
        self.assertEqual(state["runs"][0]["status"], "failed")
        self.assertEqual(state["entries"][0]["status"], "planned")

    def test_log_retention_keeps_new_records_current_state_and_cleanup_ledger(self):
        old = "2000-01-01 00:00:00 [INFO] old event\n"
        fresh = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(self.now)) + " [INFO] current event\n"
        eagle.APP_LOG_FILE.write_text(old + fresh + "unknown-format preserved\n")
        rotated = eagle.APP_LOG_FILE.with_name("server.log.1"); rotated.write_text("old rotated"); os.utime(rotated, (1, 1))
        eagle.SIGN_IN_EVENTS_FILE.write_text(json.dumps([{"ts": 1}, {"ts": self.now}]))
        state = self.root / "server_state.json"; state.write_text("keep state"); os.utime(state, (1, 1))
        self.enable("application_logs")
        self.run_cleanup()
        self.assertNotIn("old event", eagle.APP_LOG_FILE.read_text())
        self.assertIn("current event", eagle.APP_LOG_FILE.read_text())
        self.assertIn("unknown-format", eagle.APP_LOG_FILE.read_text())
        self.assertFalse(rotated.exists()); self.assertEqual(json.loads(eagle.SIGN_IN_EVENTS_FILE.read_text()), [{"ts": self.now}])
        self.assertTrue(state.exists()); self.assertTrue(self.manager.store.path.exists())

    def test_wiki_trash_and_backups_do_not_touch_published_material_or_recent_deletes(self):
        wiki = eagle._wiki_store
        old = wiki.create_page("Old deleted", "# delete", status="published")
        keep = wiki.create_page("Published", "# keep", status="published")
        fresh = wiki.create_page("Recent deleted", "# recent", status="published")
        wiki.soft_delete(old["id"]); wiki.soft_delete(fresh["id"])
        with wiki._connect() as db:
            db.execute("UPDATE nodes SET deleted_at='2000-01-01T00:00:00Z' WHERE id=?", (old["id"],))
            storage_name = db.execute("SELECT storage_name FROM nodes WHERE id=?", (old["id"],)).fetchone()[0]
        archive = wiki.create_backup(); os.utime(archive, (1, 1))
        recent_archive = wiki.create_backup()
        unrelated = wiki.backup_dir / "operator-notes.txt"; unrelated.write_text("keep")
        self.enable("wiki_trash", "wiki_backups")
        self.run_cleanup()
        self.assertFalse((wiki.content_dir / storage_name).exists())
        self.assertEqual(wiki.get_node(keep["id"])["markdown"], "# keep")
        wiki.restore_deleted(fresh["id"])
        self.assertIsNotNone(wiki.get_node(fresh["id"]))
        self.assertFalse(archive.exists()); self.assertTrue(recent_archive.exists()); self.assertTrue(unrelated.exists())
        self.assertTrue(any(row["path"] == str(wiki.content_dir / storage_name) for row in self.manager.store.history()["entries"]))

    def test_managed_wiki_recovery_is_off_until_enabled_and_preserves_shared_blobs(self):
        wiki, history = eagle._wiki_store, eagle.app.extensions["eagle_wiki_history"]
        wiki.create_page("Recovery", "# unchanged", status="published")
        first = history.capture({"role": "admin"}, "fixture")
        second = history.capture({"role": "admin"}, "fixture")
        with history.connect() as db:
            db.execute("UPDATE milestones SET created=? WHERE id=?", (self.now - 40 * 86400, first))
            shared = {row[0] for row in db.execute("SELECT digest FROM refs WHERE id=?", (second,))}
        history.prune()
        self.assertTrue((history.manifests / (first + ".json")).exists())
        self.enable("wiki_recovery", days=14)
        self.run_cleanup()
        self.assertFalse((history.manifests / (first + ".json")).exists())
        self.assertTrue((history.manifests / (second + ".json")).exists())
        self.assertTrue(all((history.blobs / digest).exists() for digest in shared))

    def test_disabled_and_recreated_accounts_are_never_auto_deleted(self):
        for record in (self.student, self.disabled):
            workspace = eagle._get_user_dir(record["email"]); workspace.mkdir()
            (workspace / "work.py").write_text("keep active or disabled")
            self.manager.store.remember_deleted(record["email"], self.now - 100 * 86400)
        self.enable("deleted_users")
        self.run_cleanup()
        self.assertTrue(all((eagle._get_user_dir(row["email"]) / "work.py").exists() for row in (self.student, self.disabled)))
        self.assertEqual(len(eagle._load_users()["users"]), 2)

    def test_orphan_workspace_waits_for_observation_and_identity_store_failure_is_safe(self):
        orphan = eagle.USER_FILES_DIR / "deleted_person"; orphan.mkdir(); (orphan / "work.py").write_text("orphan")
        self.enable("deleted_users")
        self.run_cleanup(); self.assertTrue(orphan.exists())
        eagle.USERS_FILE.write_text("broken")
        self.run_cleanup(self.now + 3 * 86400); self.assertTrue(orphan.exists())
        eagle._save_users({"users": [self.student, self.disabled]})
        self.run_cleanup(self.now + 3 * 86400); self.assertFalse(orphan.exists())

    def test_manual_run_is_serialized_and_reports_progress(self):
        self.enable("workspace_trash")
        entered, release = threading.Event(), threading.Event()
        def block(run): entered.set(); release.wait(5)
        with patch.object(self.manager, "_trash", block):
            first = self.client.post("/api/admin/cleanup/run", headers=self.headers, json={})
            self.assertEqual(first.status_code, 202); self.assertTrue(entered.wait(2))
            second = self.client.post("/api/admin/cleanup/run", headers=self.headers, json={})
            self.assertEqual(first.json["run"], second.json["run"])
            self.assertEqual(self.client.get("/api/admin/cleanup", headers=self.headers).json["active_run"], first.json["run"])
            release.set()
            deadline = time.time() + 3
            while self.manager.active_run and time.time() < deadline: time.sleep(.01)
        self.assertIsNone(self.manager.active_run)

    def test_deleted_account_cleanup_across_owned_stores_preserves_other_accounts(self):
        email, other = "removed@example.invalid", self.student["email"]
        key = eagle._sanitize_email_for_path(email)
        workspace = eagle._get_user_dir(email); workspace.mkdir(); (workspace / "private.py").write_text("removed fixture")
        notebook = eagle.NOTEBOOKS_DIR / "class-one"; notebook.mkdir()
        (notebook / (key + ".json")).write_text("{}")
        keep_notebook = notebook / (eagle._sanitize_email_for_path(other) + ".json"); keep_notebook.write_text("keep")
        assignment = {"id": "a" * 32, "name": "Fixture", "targetClassId": "class-one", "submissions": [],
                      "studentExtensions": {email: {}, other: {}}, "studentAccess": {email: {}, other: {}}}
        directory = eagle._assignment_submission_directory(assignment); directory.mkdir(parents=True)
        own = directory / "removed.py"; own.write_text("private fixture")
        # A retained snapshot may reference a file in an old bundle. Preserve
        # that file even when the bundle name belongs to the deleted identity.
        shared_bundle = directory / ("student--" + hashlib.sha256(email.encode()).hexdigest()[:20]); shared_bundle.mkdir()
        kept = shared_bundle / "current.py"; kept.write_text("current fixture")
        assignment["submissions"] = [{"email": who, "submissionPath": path.relative_to(eagle.ASSIGNMENT_SUBMISSIONS_DIR).as_posix()}
                                     for who, path in ((email, own), (other, kept))]
        metadata = eagle.ASSIGNMENTS_DIR / (assignment["id"] + ".json"); metadata.write_text(json.dumps(assignment))
        with assignment_development._history(eagle, assignment["id"]) as db:
            for who in (email, other):
                db.execute("INSERT INTO streams(email,version,content) VALUES(?,1,?)", (who, b"fixture"))
                db.execute("INSERT INTO frames(email,seq) VALUES(?,1)", (who,))
                db.execute("INSERT INTO batches(email,id) VALUES(?,'fixture')", (who,))
        with assignment_development._catalog(eagle) as db:
            db.execute("INSERT INTO bindings VALUES(?,?,?,?)", (assignment["id"], email, "removed.py", "workspace"))
        network = eagle.app.extensions["network_store"]
        for who in (email, other):
            network._user_path(who).write_text("{}")
        eagle.CHALLENGE_SCORE_FILE.write_text(json.dumps({"students": {email: {"score": 1}, other: {"score": 2}}}))
        page = eagle._wiki_store.create_page("Bookmark", "keep", status="published")
        for who in (email, other): eagle._wiki_store.add_personal_bookmark(who, page["id"])
        eagle.SIGN_IN_EVENTS_FILE.write_text(json.dumps([{"email": email, "ts": 1}, {"email": other, "ts": 1}]))
        classroom_features.CLASSROOM_SIGNALS_FILE.write_text(json.dumps({"classes": {"class-one": {
            "hands": [{"student_email": email}, {"student_email": other}], "questions": [], "silenced": {email: True}}}}))
        self.manager.store.remember_deleted(email, self.now - 40 * 86400)
        self.enable("deleted_users", days=30)
        self.run_cleanup()
        self.assertEqual(self.manager.store.history()["runs"][0]["status"], "completed")
        self.assertFalse(workspace.exists()); self.assertFalse((notebook / (key + ".json")).exists()); self.assertTrue(keep_notebook.exists())
        self.assertFalse(own.exists()); self.assertTrue(kept.exists())
        saved = json.loads(metadata.read_text()); self.assertEqual([row["email"] for row in saved["submissions"]], [other])
        self.assertNotIn(email, saved["studentExtensions"]); self.assertIn(other, saved["studentAccess"])
        with assignment_development._history(eagle, assignment["id"]) as db:
            self.assertEqual([row[0] for row in db.execute("SELECT email FROM streams")], [other])
            self.assertEqual([row[0] for row in db.execute("SELECT email FROM frames")], [other])
            self.assertEqual([row[0] for row in db.execute("SELECT email FROM batches")], [other])
        self.assertFalse(network._user_path(email).exists()); self.assertTrue(network._user_path(other).exists())
        self.assertEqual(list(json.loads(eagle.CHALLENGE_SCORE_FILE.read_text())["students"]), [other])
        with eagle._wiki_store._connect() as db:
            self.assertEqual([row[0] for row in db.execute("SELECT owner_email FROM bookmarks")], [other])
        self.assertEqual(json.loads(eagle.SIGN_IN_EVENTS_FILE.read_text())[0]["email"], other)
        self.assertEqual(json.loads(classroom_features.CLASSROOM_SIGNALS_FILE.read_text())["classes"]["class-one"]["hands"], [{"student_email": other}])

    def test_account_recreation_is_blocked_only_while_its_owned_data_is_being_cleaned(self):
        email = "removed@example.invalid"
        with self.manager.absent_account(email=email) as absent:
            self.assertTrue(absent)
            with self.assertRaises(AccountCleanupBusy):
                eagle._save_users({"users": [self.student, {"email": email, "role": "student"}]})
            eagle._save_users({"users": [self.student]})
        eagle._save_users({"users": [self.student, {"email": email, "role": "student"}]})
        self.assertIn(email, self.manager.accounts()[0])

    def test_orphan_tool_profiles_wait_for_grace_and_keep_live_ids(self):
        storage = eagle._external_tools.storage
        eagle._save_users({"users": [{**self.student, "tool_storage_id": "live-profile"}]})
        with storage._connect() as db:
            for identity in ("live-profile", "orphan-profile"):
                db.execute("INSERT INTO accounts(id) VALUES(?)", (identity,))
                db.execute("INSERT INTO entries VALUES(?,'tool','draft',?,7)", (identity, b"fixture"))
        self.enable("deleted_users")
        self.run_cleanup()
        with storage._connect() as db: self.assertEqual(db.execute("SELECT COUNT(*) FROM accounts").fetchone()[0], 2)
        self.run_cleanup(self.now + 86401)
        with storage._connect() as db:
            self.assertEqual([row[0] for row in db.execute("SELECT id FROM accounts")], ["live-profile"])
            self.assertEqual(db.execute("SELECT COUNT(*) FROM entries").fetchone()[0], 1)

    def test_analytics_audit_retention_keeps_recent_and_recoverable_history(self):
        wiki, history = eagle._wiki_store, eagle.app.extensions["eagle_wiki_history"]
        wiki.create_page("Keep", "active", status="published")
        first = history.capture({"role": "admin"}, "fixture")
        second = history.capture({"role": "admin"}, "fixture")
        with history.connect() as db:
            db.execute("UPDATE audit SET created=1 WHERE id IN (?,?)", (first, second))
            db.execute("DELETE FROM milestones WHERE id=?", (first,))
        with wiki._connect() as db:
            db.execute("INSERT INTO analytics_daily VALUES('2000-01-01','search_completed','old query',1)")
            db.execute("INSERT INTO analytics_daily VALUES('2099-01-01','search_completed','recent query',1)")
        self.enable("wiki_analytics", "wiki_audit")
        self.run_cleanup()
        with wiki._connect() as db: self.assertEqual([row[0] for row in db.execute("SELECT event_key FROM analytics_daily")], ["recent query"])
        with history.connect() as db: self.assertEqual([row[0] for row in db.execute("SELECT id FROM audit")], [second])

    def test_background_references_and_live_temporary_work_are_protected(self):
        active = eagle.BACKGROUND_ASSETS_DIR / ("a" * 32 + ".png"); active.write_text("live")
        unused = eagle.BACKGROUND_ASSETS_DIR / ("b" * 32 + ".png"); unused.write_text("unused")
        for path in (active, unused): os.utime(path, (1, 1))
        eagle.PERSIST_FILE.write_text(json.dumps({next(iter(eagle._BACKGROUND_CONFIG_KEYS.values())): active.name}))
        staging = eagle._wiki_store.staging_dir / "abandoned.tmp"; staging.write_text("temporary"); os.utime(staging, (1, 1))
        uploading = eagle._wiki_store.staging_dir / ("d" * 32 + ".json")
        uploading.write_text("{}"); os.utime(uploading, (1, 1))
        uploading.with_suffix(".part").write_text("active upload")
        old = eagle.SANDBOX_DIR / "pyide_old"; old.mkdir(); (old / "work.py").write_text("old"); os.utime(old, (1, 1))
        live = eagle.SANDBOX_DIR / "pyide_live"; live.mkdir(); os.utime(live, (1, 1))
        current = eagle.SANDBOX_DIR / "pyide_current"; current.mkdir(); os.utime(current, (1, 1))
        self.enable("unused_backgrounds", "temporary_files")
        # POSIX ctime cannot be backdated: use a future startup epoch to model
        # prior-generation folders, but retain the explicitly active one.
        with patch.object(eagle, "SERVER_START_EPOCH", time.time() + 100), patch.dict(eagle._runners, {"fixture": SimpleNamespace(sandbox_dir=live)}):
            self.run_cleanup()
        self.assertFalse(staging.exists()); self.assertFalse(old.exists()); self.assertTrue(live.exists())
        self.assertTrue(uploading.exists()); self.assertTrue(uploading.with_suffix(".part").exists())
        self.assertFalse(unused.exists()); self.assertTrue(active.exists())
        newer = eagle.SANDBOX_DIR / "pyide_newer"; newer.mkdir(); os.utime(newer, (1, 1))
        self.run_cleanup(); self.assertTrue(newer.exists())
        eagle.PERSIST_FILE.unlink()
        orphan = eagle.BACKGROUND_ASSETS_DIR / ("c" * 32 + ".png"); orphan.write_text("keep unknown"); os.utime(orphan, (1, 1))
        self.run_cleanup(); self.assertTrue(orphan.exists())

    def test_ledger_survives_restart_and_pages_without_leaking_file_contents(self):
        identity = self.manager.store.begin_run("fixture")
        for index in range(105):
            receipt = self.manager.store.plan(identity, "workspace_trash", "fixture-" + str(index), "delete_file")
            self.manager.store.result(receipt, "deleted")
        from cleanup_store import CleanupStore
        reopened = CleanupStore(self.manager.store.root)
        first = reopened.history(); second = reopened.history(first["next_before"])
        self.assertEqual(len(first["entries"]), 100); self.assertEqual(len(second["entries"]), 5)
        self.assertFalse(set(row["seq"] for row in first["entries"]) & set(row["seq"] for row in second["entries"]))
        self.assertEqual(first["runs"][0]["status"], "interrupted")

    def test_containment_and_permanent_ledger_protection(self):
        with self.assertRaises(ValueError): checked_path(self.root, self.root)
        with self.assertRaises(ValueError): checked_path(self.root, self.root.parent / "outside.txt")
        with self.assertRaises(ValueError): checked_path(self.root, self.root / "Trash" / ".." / "active.py")
        outside = self.root / "outside"; outside.mkdir(); (outside / "keep.txt").write_text("keep")
        link = eagle.USER_FILES_DIR / "linked"
        try: link.symlink_to(outside, target_is_directory=True)
        except OSError: self.skipTest("Symlink creation unavailable")
        self.enable("deleted_users")
        self.run_cleanup(self.now + 100 * 86400)
        self.assertTrue((outside / "keep.txt").exists())
