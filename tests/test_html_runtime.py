import builtins
import getpass
import tempfile
import unittest
from pathlib import Path


_ORIGINAL_INPUT = builtins.input
_ORIGINAL_GETPASS = getpass.getpass
builtins.input = lambda _prompt="": "admin@eagleide.local"
getpass.getpass = lambda _prompt="": "password"

import app as eagle  # noqa: E402

builtins.input = _ORIGINAL_INPUT
getpass.getpass = _ORIGINAL_GETPASS


class HtmlRuntimeTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.user_files_dir = self.root / "user_files"
        self.sandbox_dir = self.root / "sandboxes"
        self.user_files_dir.mkdir()
        self.sandbox_dir.mkdir()

        self.original_user_files_dir = eagle.USER_FILES_DIR
        self.original_sandbox_dir = eagle.SANDBOX_DIR
        eagle.USER_FILES_DIR = self.user_files_dir
        eagle.SANDBOX_DIR = self.sandbox_dir
        eagle._html_runtime_sessions.clear()

        self.email = "html.student@example.com"
        self.token = "student-token"
        eagle._student_tokens[self.token] = {
            "email": self.email,
            "name": "HTML Student",
            "role": "student",
            "class_id": None,
            "class_ids": [],
        }
        self.user_dir = eagle._get_user_dir(self.email)
        self.user_dir.mkdir(parents=True)
        (self.user_dir / "index.html").write_text(
            '<!doctype html><html><head><title>Runtime</title><link rel="stylesheet" href="styles.css"></head>'
            '<body><h1>Runtime OK</h1><script>console.error("boom");</script></body></html>',
            encoding="utf-8",
        )
        (self.user_dir / "styles.css").write_text("h1 { color: red; }\n", encoding="utf-8")
        (self.user_dir / "large.txt").write_text("x" * 1024, encoding="utf-8")

        self.client = eagle.app.test_client()

    def tearDown(self):
        eagle._student_tokens.pop(self.token, None)
        eagle._html_runtime_sessions.clear()
        eagle.USER_FILES_DIR = self.original_user_files_dir
        eagle.SANDBOX_DIR = self.original_sandbox_dir
        self.tmp.cleanup()

    def _start_runtime(self, file_path="index.html"):
        return self.client.post(
            "/api/html-runtime/start",
            headers={"X-User-Token": self.token},
            json={"file_path": file_path},
        )

    def test_start_uses_live_user_root_without_copying_workspace(self):
        response = self._start_runtime()

        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertTrue(data["ok"])
        self.assertIn("/api/html-runtime/view/", data["view_url"])
        self.assertFalse(list(self.sandbox_dir.glob("html_runtime_*")))

        session = eagle._html_runtime_sessions[data["runtime_id"]]
        self.assertEqual(Path(session["runtime_root"]), self.user_dir.resolve())
        self.assertEqual(session["entry_file"], "index.html")
        self.assertNotIn("runtime_dir", session)

    def test_view_injects_bridge_and_serves_relative_assets(self):
        start_data = self._start_runtime().get_json()

        html_response = self.client.get(start_data["view_url"])
        self.assertEqual(html_response.status_code, 200)
        html = html_response.get_data(as_text=True)
        self.assertIn("__eagleHtmlRuntime", html)
        self.assertIn("Runtime OK", html)
        self.assertIn("Content-Security-Policy", html_response.headers)

        css_response = self.client.get(f"/api/html-runtime/view/{start_data['runtime_id']}/styles.css")
        self.assertEqual(css_response.status_code, 200)
        self.assertIn("color: red", css_response.get_data(as_text=True))

    def test_view_rejects_path_traversal(self):
        start_data = self._start_runtime().get_json()
        secret = self.root / "secret.html"
        secret.write_text("<h1>secret</h1>", encoding="utf-8")

        response = self.client.get(f"/api/html-runtime/view/{start_data['runtime_id']}/../secret.html")

        self.assertEqual(response.status_code, 404)

    def test_cleanup_removes_session_without_deleting_user_files(self):
        start_data = self._start_runtime().get_json()
        runtime_id = start_data["runtime_id"]

        response = self.client.post("/api/html-runtime/cleanup", json={"runtime_id": runtime_id})

        self.assertEqual(response.status_code, 200)
        self.assertNotIn(runtime_id, eagle._html_runtime_sessions)
        self.assertTrue((self.user_dir / "index.html").exists())

    def test_popup_shell_is_channel_based_and_cross_opener_isolated(self):
        response = self.client.get("/api/html-runtime/popup/testchannel")

        self.assertEqual(response.status_code, 200)
        body = response.get_data(as_text=True)
        self.assertIn("BroadcastChannel", body)
        self.assertIn("sandbox=\"allow-scripts\"", body)
        self.assertEqual(response.headers.get("Cross-Origin-Opener-Policy"), "same-origin")


if __name__ == "__main__":
    unittest.main()
