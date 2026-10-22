import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import bcrypt
from cryptography.fernet import Fernet
from PIL import Image, PngImagePlugin
from wiki_store import WikiStore
from credential_security import verify_password

ROOT = Path(__file__).resolve().parents[1]


class SecurityMaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def run_tool(self, name, *args, cwd=None):
        env = dict(os.environ)
        env.pop("EAGLEIDE_ADMIN_KEY_FILE", None)
        return subprocess.run([sys.executable, str(ROOT / "tools" / name), *map(str, args)],
                              cwd=cwd or self.root, env=env, text=True, capture_output=True, timeout=30)

    def test_device_rotation_is_explicit_and_preserves_configuration(self):
        old = Fernet.generate_key()
        key = self.root / ".admin_key"; key.write_bytes(old)
        config = {"admin_email": "admin@example.invalid", "admin_password_hash": bcrypt.hashpw(b"fixture-only-password", bcrypt.gensalt(rounds=4)).decode(), "page_title": "Keep this"}
        encoded = json.dumps(config)
        (self.root / "config.txt").write_text(encoded)
        preflight = self.run_tool("rotate_device_key.py", "--root", self.root)
        self.assertEqual(preflight.returncode, 0, preflight.stderr)
        self.assertEqual(key.read_bytes(), old)
        result = self.run_tool("rotate_device_key.py", "--root", self.root, "--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotEqual(key.read_bytes(), old)
        Fernet(key.read_bytes())
        self.assertEqual((self.root / "config.txt").read_text(), encoded)
        self.assertNotIn(old.decode(), result.stdout + result.stderr)

    def test_rotation_refuses_legacy_encrypted_credentials_without_changing_key(self):
        old = Fernet.generate_key()
        (self.root / ".admin_key").write_bytes(old)
        (self.root / "config.txt").write_text(json.dumps({"admin_email": "admin@example.invalid", "admin_password_encrypted": "legacy"}))
        result = self.run_tool("rotate_device_key.py", "--root", self.root, "--apply")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.root / ".admin_key").read_bytes(), old)

    def test_combined_admin_migration_and_rotation_keeps_a_long_unicode_password(self):
        old = Fernet.generate_key()
        password = "long-fixture-" + "é" * 80
        (self.root / ".admin_key").write_bytes(old)
        original = {"admin_email": "admin@example.invalid", "admin_password_encrypted": Fernet(old).encrypt(password.encode()).decode(), "page_title": "Keep this"}
        (self.root / "config.txt").write_text(json.dumps(original))
        preflight = self.run_tool("rotate_device_key.py", "--root", self.root, "--migrate-admin")
        self.assertEqual(preflight.returncode, 0, preflight.stderr)
        self.assertEqual(json.loads((self.root / "config.txt").read_text()), original)
        result = self.run_tool("rotate_device_key.py", "--root", self.root, "--migrate-admin", "--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        saved = json.loads((self.root / "config.txt").read_text())
        self.assertNotIn("admin_password_encrypted", saved)
        self.assertEqual(saved["page_title"], "Keep this")
        self.assertTrue(verify_password(password, saved["admin_password_hash"], saved["admin_password_scheme"]))
        self.assertNotEqual((self.root / ".admin_key").read_bytes(), old)

    def test_legacy_user_migration_is_explicit_and_keeps_profiles_and_passwords(self):
        password = "long-fixture-" + "é" * 80
        original = {"users": [{"email": "student@example.invalid", "password": password, "student_id": "00042", "class_ids": ["one"]}]}
        path = self.root / "users.json"; path.write_text(json.dumps(original))
        preflight = self.run_tool("migrate_legacy_passwords.py", "--root", self.root)
        self.assertEqual(preflight.returncode, 0, preflight.stderr)
        self.assertEqual(json.loads(path.read_text()), original)
        result = self.run_tool("migrate_legacy_passwords.py", "--root", self.root, "--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        saved = json.loads(path.read_text())["users"][0]
        self.assertNotIn("password", saved)
        self.assertEqual(saved["student_id"], "00042")
        self.assertEqual(saved["class_ids"], ["one"])
        self.assertTrue(verify_password(password, saved["password_hash"], saved["password_hash_scheme"]))

    def test_wiki_image_migration_preserves_ids_and_updates_quota_bytes(self):
        store = WikiStore(self.root / "wiki", backup_dir=self.root / "backups")
        image = Image.new("RGB", (4, 4), "blue")
        source = self.root / "source.png"; image.save(source)
        node = store.create_asset_from_file(source, "diagram.png")
        target = store.media_path(node["id"])[1]
        metadata = PngImagePlugin.PngInfo(); metadata.add_text("private", "fixture metadata " * 200)
        image.save(target, pnginfo=metadata)
        original = target.read_bytes()
        preflight = self.run_tool("strip_image_metadata.py", store.media_dir)
        self.assertEqual(preflight.returncode, 0, preflight.stderr)
        self.assertEqual(target.read_bytes(), original)
        refused = self.run_tool("strip_image_metadata.py", store.media_dir, "--apply")
        self.assertNotEqual(refused.returncode, 0)
        self.assertEqual(target.read_bytes(), original)
        applied = self.run_tool("strip_image_metadata.py", store.media_dir, "--wiki-catalog", store.db_path, "--apply")
        self.assertEqual(applied.returncode, 0, applied.stderr)
        self.assertEqual(json.loads(applied.stdout)["written"], 1)
        with Image.open(target) as cleaned:
            self.assertNotIn("private", cleaned.info)
            self.assertEqual(cleaned.size, (4, 4))
        self.assertEqual(store.get_node(node["id"], include_drafts=True)["size_bytes"], target.stat().st_size)

    def test_force_staged_private_data_is_rejected_without_printing_its_content(self):
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        target = self.root / "assignment_submissions" / "probe.py"
        target.parent.mkdir(); target.write_text("fixture-private-content")
        subprocess.run(["git", "-C", str(self.root), "add", "-f", "assignment_submissions/probe.py"], check=True)
        result = self.run_tool("check_private_data.py", "--staged", cwd=self.root)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("private runtime path", result.stderr)
        self.assertNotIn("fixture-private-content", result.stdout + result.stderr)

    def test_history_guard_rejects_unrelated_or_precleanup_ancestry(self):
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        (self.root / "safe.py").write_text("print('fixture')")
        subprocess.run(["git", "-C", str(self.root), "add", "safe.py"], check=True)
        subprocess.run(["git", "-C", str(self.root), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], check=True)
        result = self.run_tool("check_private_data.py", "--history", cwd=self.root)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("root ancestry", result.stderr)
