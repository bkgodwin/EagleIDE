"""Student workspace operations, including first-use and stale-path regressions."""
import builtins
import getpass
import io
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

with patch.object(builtins, "input", return_value="admin@eagleide.local"), patch.object(getpass, "getpass", return_value="password"):
    import app as eagle


class FileBrowserTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.patch = patch.object(eagle, "USER_FILES_DIR", self.root / "files")
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.token = "file-browser-test-student"
        self.other = "file-browser-test-other"
        for token, email in [(self.token, "files@school.test"), (self.other, "other@school.test")]:
            eagle._student_tokens[token] = {"email": email, "role": "student", "class_ids": [], "class_id": None}
            self.addCleanup(eagle._student_tokens.pop, token, None)
        self.headers = {"X-User-Token": self.token}
        self.client = eagle.app.test_client()
        self.workspace = eagle._get_user_dir("files@school.test")

    def post(self, route, data, **kwargs):
        return self.client.post("/api/files/" + route, json=data, headers=self.headers, **kwargs)

    def test_new_student_can_create_folder_and_nested_file(self):
        self.assertEqual(self.post("create", {"name": "Week One", "type": "folder"}).status_code, 200)
        created = self.post("create", {"name": "main.py", "parent": "Week One"})
        self.assertEqual(created.status_code, 200)
        self.assertEqual(created.get_json()["path"], "Week One/main.py")
        self.assertTrue((self.workspace / "Week One/main.py").is_file())
        written = self.post("write", {"path": "Week One/main.py", "content": "print('hello')", "require_existing": True})
        self.assertEqual(written.status_code, 200)
        read = self.client.get("/api/files/read?path=Week%20One/main.py", headers=self.headers)
        self.assertEqual(read.get_json()["content"], "print('hello')")
        other = self.client.get("/api/files/read?path=Week%20One/main.py", headers={"X-User-Token": self.other})
        self.assertEqual(other.status_code, 404)

    def test_duplicate_create_returns_conflict_without_overwriting(self):
        self.post("create", {"name": "main.py"})
        (self.workspace / "main.py").write_text("keep me", encoding="utf-8")
        self.assertEqual(self.post("create", {"name": "main.py"}).status_code, 409)
        self.assertEqual((self.workspace / "main.py").read_text(), "keep me")

    def test_concurrent_creation_reports_exactly_one_success(self):
        def create(_):
            with eagle.app.test_client() as client:
                response = client.post("/api/files/create", json={"name": "same.py"}, headers=self.headers)
                return response.status_code, response.get_json()
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(create, range(12)))
        statuses = [status for status, _ in results]
        self.assertEqual(statuses.count(200), 1, results)
        self.assertEqual(statuses.count(409), 11, results)

    def test_invalid_names_missing_parents_and_payloads_are_client_errors(self):
        for name in ["../bad.py", "a/b.py", "a\\b.py", ".", "..", ".eagleide", "bad\0.py", "bad.", 42]:
            with self.subTest(name=name):
                self.assertEqual(self.post("create", {"name": name}).status_code, 400)
        self.assertEqual(self.post("create", {"name": "file.py", "parent": "missing"}).status_code, 404)
        for route in ["create", "rename", "move", "duplicate", "write"]:
            self.assertEqual(self.post(route, ["not-an-object"]).status_code, 400)
        self.assertEqual(self.post("write", {"path": 7, "content": "test"}).status_code, 400)

    def test_root_metadata_and_outside_paths_cannot_be_mutated(self):
        self.post("create", {"name": "keep.py"})
        for target in [".", "..", "../outside.py", ".eagleide", "nested/../.eagleide/file.py"]:
            deleted = self.client.delete("/api/files/delete", json={"path": target}, headers=self.headers)
            self.assertIn(deleted.status_code, [400, 404])
            self.assertIn(self.post("duplicate", {"src": target}).status_code, [400, 404])
        self.assertTrue((self.workspace / "keep.py").exists())
        self.assertEqual(self.post("write", {"path": ".eagleide/secret.py", "content": "test"}).status_code, 400)

    def test_rename_move_and_delete_preserve_content_and_paths(self):
        self.post("create", {"name": "dest", "type": "folder"})
        self.post("create", {"name": "main.py"})
        self.post("write", {"path": "main.py", "content": "saved"})
        self.assertEqual(self.post("rename", {"old_path": "main.py", "new_name": "hidden.exe"}).status_code, 400)
        renamed = self.post("rename", {"old_path": "main.py", "new_name": "renamed.py"})
        self.assertEqual(renamed.get_json()["new_path"], "renamed.py")
        moved = self.post("move", {"src": "renamed.py", "dest": "dest"})
        self.assertEqual(moved.get_json()["new_path"], "dest/renamed.py")
        self.assertEqual((self.workspace / "dest/renamed.py").read_text(), "saved")
        self.assertEqual(self.client.delete("/api/files/delete", json={"path": "dest"}, headers=self.headers).status_code, 200)
        stale = self.post("write", {"path": "dest/renamed.py", "content": "old", "require_existing": True})
        self.assertEqual(stale.status_code, 404)
        self.assertFalse((self.workspace / "dest").exists())

    def test_upload_normalizes_windows_filename_and_rejects_folder_collision(self):
        self.post("create", {"name": "folder.py", "type": "folder"})
        uploaded = self.client.post("/api/files/upload", headers=self.headers,
            data={"file": (io.BytesIO(b"print('hello')"), "C:\\fakepath\\upload.py")})
        self.assertEqual(uploaded.status_code, 200)
        self.assertTrue((self.workspace / "upload.py").is_file())
        collision = self.client.post("/api/files/upload", headers=self.headers,
            data={"file": (io.BytesIO(b"test"), "folder.py")})
        self.assertEqual(collision.status_code, 409)

    def test_anonymous_users_cannot_mutate_workspaces(self):
        response = self.client.post("/api/files/create", json={"name": "main.py"})
        self.assertEqual(response.status_code, 401)


if __name__ == "__main__":
    unittest.main()
