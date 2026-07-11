import builtins
import getpass
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


_ORIGINAL_INPUT = builtins.input
_ORIGINAL_GETPASS = getpass.getpass
builtins.input = lambda _prompt="": "admin@eagleide.local"
getpass.getpass = lambda _prompt="": "password"

import app as eagle  # noqa: E402

builtins.input = _ORIGINAL_INPUT
getpass.getpass = _ORIGINAL_GETPASS


class RolePermissionTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.original_user_files_dir = eagle.USER_FILES_DIR
        self.original_users_file = eagle.USERS_FILE
        self.original_classes_file = eagle.CLASSES_FILE
        self.original_admin_email = eagle.ADMIN_ACCOUNT_EMAIL
        self.original_admin_password = eagle.ADMIN_ACCOUNT_PASSWORD

        eagle.USER_FILES_DIR = self.root / "user_files"
        eagle.USER_FILES_DIR.mkdir()
        eagle.USERS_FILE = self.root / "users.json"
        eagle.CLASSES_FILE = self.root / "classes.json"
        eagle.USERS_FILE.write_text(json.dumps({"users": []}), encoding="utf-8")
        eagle.CLASSES_FILE.write_text(json.dumps({"classes": []}), encoding="utf-8")
        eagle._users_cache = None
        eagle._classes_cache = None
        eagle._reg_rate_limit.clear()

        self.admin_token = "role-admin-token"
        self.teacher_token = "role-teacher-token"
        self.student_token = "role-student-token"
        self.teacher_email = "teacher@example.com"
        self.student_email = "student@example.com"
        eagle._admin_tokens.add(self.admin_token)
        eagle._teacher_tokens[self.teacher_token] = {
            "email": self.teacher_email,
            "name": "Teacher",
            "role": "teacher",
        }
        eagle._student_tokens[self.student_token] = {
            "email": self.student_email,
            "name": "Student",
            "role": "student",
            "class_id": "class-one",
            "class_ids": ["class-one"],
        }
        self.http = eagle.app.test_client()
        self.socket_clients = []

    def tearDown(self):
        for client in self.socket_clients:
            if client.is_connected():
                client.disconnect()
        eagle._admin_tokens.discard(self.admin_token)
        eagle._teacher_tokens.pop(self.teacher_token, None)
        eagle._student_tokens.pop(self.student_token, None)
        eagle._teacher_code_snapshots.clear()
        eagle._teacher_stream_last_emit.clear()
        eagle._live_teacher_stream_sids_by_class.clear()
        eagle.USER_FILES_DIR = self.original_user_files_dir
        eagle.USERS_FILE = self.original_users_file
        eagle.CLASSES_FILE = self.original_classes_file
        eagle.ADMIN_ACCOUNT_EMAIL = self.original_admin_email
        eagle.ADMIN_ACCOUNT_PASSWORD = self.original_admin_password
        eagle._users_cache = None
        eagle._classes_cache = None
        eagle._reg_rate_limit.clear()
        self.tmp.cleanup()

    def _set_disabled_ai_class(self):
        eagle.CLASSES_FILE.write_text(
            json.dumps({
                "classes": [{
                    "id": "class-one",
                    "name": "Class One",
                    "teacher_email": self.teacher_email,
                    "students": [self.student_email],
                    "settings": {"ai_enabled": False},
                }]
            }),
            encoding="utf-8",
        )
        eagle._classes_cache = None

    def test_admin_file_listing_repairs_missing_examples(self):
        response = self.http.get("/api/files/list", headers={"X-Admin-Token": self.admin_token})

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        examples = next(item for item in payload["files"] if item["name"] == eagle.EXAMPLES_DIR_NAME)
        self.assertEqual(
            {item["name"] for item in examples["children"]},
            set(eagle.EXAMPLE_FILES),
        )

    def test_new_teacher_gets_examples_immediately(self):
        response = self.http.post(
            "/api/admin/teachers/create",
            headers={"X-Admin-Token": self.admin_token},
            json={"email": "new.teacher@example.com", "name": "New Teacher", "password": "StrongPass123"},
        )

        self.assertEqual(response.status_code, 200)
        examples_dir = eagle._get_user_dir("new.teacher@example.com") / eagle.EXAMPLES_DIR_NAME
        self.assertEqual({path.name for path in examples_dir.iterdir()}, set(eagle.EXAMPLE_FILES))

    def test_new_student_gets_examples_immediately(self):
        with patch("app._load_config", return_value={"registration_enabled": True}):
            response = self.http.post(
                "/api/auth/register",
                json={"email": "new.student@example.com", "name": "New Student", "password": "StrongPass123"},
            )

        self.assertEqual(response.status_code, 200)
        examples_dir = eagle._get_user_dir("new.student@example.com") / eagle.EXAMPLES_DIR_NAME
        self.assertEqual({path.name for path in examples_dir.iterdir()}, set(eagle.EXAMPLE_FILES))

    def test_class_ai_switch_restricts_student_but_not_owner_teacher(self):
        self._set_disabled_ai_class()
        with patch("app._load_config", return_value={"ai_explainer_enabled": True}):
            with eagle.app.test_request_context(headers={"X-User-Token": self.student_token}):
                student_allowed, student_error = eagle._effective_ai_enabled(
                    eagle.request,
                    {"classId": "class-one"},
                )
            with eagle.app.test_request_context(headers={"X-Teacher-Token": self.teacher_token}):
                teacher_allowed, teacher_error = eagle._effective_ai_enabled(
                    eagle.request,
                    {"classId": "class-one"},
                )

        self.assertFalse(student_allowed)
        self.assertIn("disabled", student_error.lower())
        self.assertTrue(teacher_allowed)
        self.assertIsNone(teacher_error)

    def test_admin_cannot_publish_teacher_stream(self):
        self._set_disabled_ai_class()
        client = eagle.socketio.test_client(eagle.app, flask_test_client=self.http)
        self.socket_clients.append(client)
        client.emit("teacher_code_update", {
            "token": self.admin_token,
            "role": "admin",
            "class_id": "class-one",
            "code": "print('admin stream')",
            "language": "python",
        })
        client.emit("teacher_stream_status", {
            "token": self.admin_token,
            "role": "admin",
            "class_id": "class-one",
            "active": True,
        })

        self.assertNotIn("class-one", eagle._teacher_code_snapshots)
        self.assertFalse(eagle._teacher_stream_active_for_class("class-one"))

    def test_frontend_keeps_teacher_ai_and_hides_admin_streaming(self):
        source = (Path(eagle.BASE_DIR) / "static/js/app-core.js").read_text(encoding="utf-8")

        self.assertIn("ADMIN_TOKEN || TEACHER_TOKEN || aiEnabledForClass", source)
        self.assertIn("streamingToggleBtn.style.display = TEACHER_TOKEN ? '' : 'none'", source)
        self.assertIn("const next = !!enabled && !!TEACHER_TOKEN", source)
        self.assertNotIn("role: ADMIN_TOKEN ? 'admin' : 'teacher'", source)


if __name__ == "__main__":
    unittest.main()
