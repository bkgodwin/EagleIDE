import builtins
import getpass
import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch


_ORIGINAL_INPUT = builtins.input
_ORIGINAL_GETPASS = getpass.getpass
builtins.input = lambda _prompt="": "admin@eagleide.local"
getpass.getpass = lambda _prompt="": "password"

import app as eagle  # noqa: E402
import classroom_features  # noqa: E402

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
        eagle._login_rate_limit.clear()
        eagle._login_account_rate_limit.clear()
        eagle._admin_login_rate_limit.clear()
        self.generated_tokens = []

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
        for token in self.generated_tokens:
            eagle._student_tokens.pop(token, None)
            eagle._teacher_tokens.pop(token, None)
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
        eagle._login_rate_limit.clear()
        eagle._login_account_rate_limit.clear()
        eagle._admin_login_rate_limit.clear()
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

    def _set_disabled_challenges_class(self):
        eagle.USERS_FILE.write_text(json.dumps({"users": [{
            "email": self.student_email,
            "name": "Student",
            "role": "student",
            "class_id": "class-one",
            "class_ids": ["class-one"],
            "enabled": True,
        }]}), encoding="utf-8")
        eagle.CLASSES_FILE.write_text(json.dumps({"classes": [{
            "id": "class-one",
            "name": "Class One",
            "teacher_email": self.teacher_email,
            "students": [self.student_email],
            "settings": {"challenges_enabled": False},
        }]}), encoding="utf-8")
        eagle._users_cache = None
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

    def test_student_can_join_a_second_class_without_losing_first(self):
        eagle.USERS_FILE.write_text(json.dumps({"users": [{
            "email": self.student_email,
            "name": "Student",
            "role": "student",
            "class_id": "class-one",
            "class_ids": ["class-one"],
            "enabled": True,
        }]}), encoding="utf-8")
        eagle.CLASSES_FILE.write_text(json.dumps({"classes": [
            {"id": "class-one", "name": "Class One", "join_code": "FIRST1", "teacher_email": self.teacher_email, "students": [self.student_email]},
            {"id": "class-two", "name": "Class Two", "join_code": "SECOND", "teacher_email": self.teacher_email, "students": []},
        ]}), encoding="utf-8")
        eagle._users_cache = None
        eagle._classes_cache = None

        response = self.http.post(
            "/api/classes/join",
            headers={"X-User-Token": self.student_token},
            json={"joinCode": "SECOND"},
        )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual([item["id"] for item in payload["classList"]], ["class-one", "class-two"])
        self.assertEqual(payload["classData"]["id"], "class-two")

    def test_admin_user_list_includes_all_class_memberships(self):
        eagle.USERS_FILE.write_text(json.dumps({"users": [{
            "email": self.student_email,
            "name": "Student",
            "role": "student",
            "class_id": "class-two",
            "class_ids": ["class-one", "class-two"],
            "enabled": True,
        }]}), encoding="utf-8")
        eagle.CLASSES_FILE.write_text(json.dumps({"classes": [
            {"id": "class-one", "name": "Class One"},
            {"id": "class-two", "name": "Class Two"},
        ]}), encoding="utf-8")
        eagle._users_cache = None
        eagle._classes_cache = None

        response = self.http.get("/api/admin/users", headers={"X-Admin-Token": self.admin_token})

        self.assertEqual(response.status_code, 200)
        user = response.get_json()["users"][0]
        self.assertEqual(user["class_ids"], ["class-one", "class-two"])
        self.assertEqual(user["class_names"], ["Class One", "Class Two"])

    def test_new_student_gets_examples_immediately(self):
        with patch("app._load_config", return_value={"registration_enabled": True}):
            response = self.http.post(
                "/api/auth/register",
                json={"email": "new.student@example.com", "name": "New Student", "password": "StrongPass123"},
            )

        self.assertEqual(response.status_code, 200)
        examples_dir = eagle._get_user_dir("new.student@example.com") / eagle.EXAMPLES_DIR_NAME
        self.assertEqual({path.name for path in examples_dir.iterdir()}, set(eagle.EXAMPLE_FILES))

    def test_sixty_students_can_register_sign_in_and_join_from_one_network(self):
        shared_ip = "10.20.30.40"
        student_count = 60

        def register(index):
            with eagle.app.test_client() as client:
                response = client.post(
                    "/api/auth/register",
                    json={
                        "email": f"student{index}@school.test",
                        "name": f"Student {index}",
                        "password": "ClassPass123",
                    },
                    environ_base={"REMOTE_ADDR": shared_ip},
                )
                return response.status_code, response.get_json()

        with patch("app._load_config", return_value={"registration_enabled": True}), \
             patch("app.bcrypt.hashpw", return_value=b"test-password-hash"), \
             patch("app._seed_example_files"), \
             patch("app._record_sign_in_event"):
            with ThreadPoolExecutor(max_workers=20) as pool:
                registrations = list(pool.map(register, range(student_count)))

        self.assertTrue(all(status == 200 for status, _ in registrations), registrations)
        self.generated_tokens.extend(payload["token"] for _, payload in registrations)
        saved_users = eagle._load_users()["users"]
        self.assertEqual(len(saved_users), student_count)
        self.assertEqual(len({user["email"] for user in saved_users}), student_count)

        eagle._save_classes({"classes": [{
            "id": "rapid-class",
            "name": "Rapid Class",
            "join_code": "RAPID1",
            "teacher_email": self.teacher_email,
            "students": [],
            "settings": {},
        }]})

        def join(registration):
            _, payload = registration
            with eagle.app.test_client() as client:
                response = client.post(
                    "/api/classes/join",
                    headers={"X-User-Token": payload["token"]},
                    json={"joinCode": "RAPID1"},
                    environ_base={"REMOTE_ADDR": shared_ip},
                )
                return response.status_code, response.get_json()

        with ThreadPoolExecutor(max_workers=20) as pool:
            joins = list(pool.map(join, registrations))

        self.assertTrue(all(status == 200 for status, _ in joins), joins)
        joined_class = eagle._find_class_by_id("rapid-class")
        self.assertEqual(len(joined_class["students"]), student_count)
        self.assertTrue(all("rapid-class" in user["class_ids"] for user in eagle._load_users()["users"]))

        def sign_in(index):
            with eagle.app.test_client() as client:
                response = client.post(
                    "/api/auth/login",
                    json={"email": f"student{index}@school.test", "password": "ClassPass123"},
                    environ_base={"REMOTE_ADDR": shared_ip},
                )
                return response.status_code, response.get_json()

        with patch("app._verify_user_password", return_value=True), \
             patch("app._seed_example_files"), \
             patch("app._record_sign_in_event"):
            with ThreadPoolExecutor(max_workers=20) as pool:
                sign_ins = list(pool.map(sign_in, range(student_count)))

        self.assertTrue(all(status == 200 for status, _ in sign_ins), sign_ins)
        self.generated_tokens.extend(payload["token"] for _, payload in sign_ins)

    def test_teacher_file_send_setting_is_enforced_for_the_selected_class(self):
        eagle.CLASSES_FILE.write_text(json.dumps({"classes": [
            {
                "id": "class-one",
                "name": "Class One",
                "teacher_email": self.teacher_email,
                "students": [self.student_email],
                "settings": {"teacher_file_send_enabled": False},
            },
            {
                "id": "class-two",
                "name": "Class Two",
                "teacher_email": self.teacher_email,
                "students": [self.student_email],
                "settings": {"teacher_file_send_enabled": True},
            },
        ]}), encoding="utf-8")
        eagle._classes_cache = None

        response = self.http.post(
            "/api/classroom/send-file",
            headers={"X-Teacher-Token": self.teacher_token},
            json={"classId": "class-one", "sourcePath": "lesson.py", "recipients": "all"},
        )

        self.assertEqual(response.status_code, 403)
        self.assertIn("disabled", response.get_json()["error"].lower())

    def test_raise_hand_and_streaming_stay_in_the_selected_class(self):
        eagle.USERS_FILE.write_text(json.dumps({"users": [{
            "email": self.student_email,
            "name": "Student",
            "role": "student",
            "class_id": "class-two",
            "class_ids": ["class-two"],
            "enabled": True,
        }]}), encoding="utf-8")
        eagle.CLASSES_FILE.write_text(json.dumps({"classes": [
            {
                "id": "class-one",
                "name": "Class One",
                "teacher_email": self.teacher_email,
                "students": [],
                "settings": {"raise_hand_enabled": True},
            },
            {
                "id": "class-two",
                "name": "Class Two",
                "teacher_email": self.teacher_email,
                "students": [self.student_email],
                "settings": {"raise_hand_enabled": True},
            },
        ]}), encoding="utf-8")
        eagle._users_cache = None
        eagle._classes_cache = None
        signals_file = self.root / "classroom_signals.json"
        events_file = self.root / "classroom_events.json"

        teacher_client = eagle.socketio.test_client(eagle.app, flask_test_client=self.http)
        student_client = eagle.socketio.test_client(eagle.app, flask_test_client=self.http)
        self.socket_clients.extend([teacher_client, student_client])
        teacher_client.get_received()
        student_client.get_received()

        with patch.object(classroom_features, "CLASSROOM_SIGNALS_FILE", signals_file), \
             patch.object(classroom_features, "CLASSROOM_EVENTS_FILE", events_file):
            teacher_client.emit("join_class_room", {
                "role": "teacher", "token": self.teacher_token, "class_id": "class-two",
            })
            student_client.emit("join_class_room", {
                "role": "student", "token": self.student_token, "class_id": "class-two",
            })
            teacher_client.get_received()
            student_client.get_received()

            student_client.emit("classroom_hand_raise", {
                "token": self.student_token, "class_id": "class-two",
            })
            teacher_events = teacher_client.get_received()
            hands_updates = [event for event in teacher_events if event.get("name") == "classroom_hands_update"]
            self.assertTrue(hands_updates)
            hands_payload = hands_updates[-1]["args"][0]
            self.assertEqual(hands_payload["class_id"], "class-two")
            self.assertEqual(hands_payload["hands"][0]["student_email"], self.student_email)

            student_client.emit("classroom_hand_raise", {
                "token": self.student_token, "class_id": "class-one",
            })
            signals = json.loads(signals_file.read_text(encoding="utf-8"))
            self.assertNotIn("class-one", signals["classes"])

            teacher_client.emit("teacher_stream_status", {
                "role": "teacher", "token": self.teacher_token, "class_id": "class-two", "active": True,
            })
            teacher_client.emit("teacher_code_update", {
                "role": "teacher", "token": self.teacher_token, "class_id": "class-two",
                "code": "print('selected')", "language": "python",
            })
            student_events = student_client.get_received()
            code_events = [event for event in student_events if event.get("name") == "teacher_code"]
            self.assertTrue(code_events)
            self.assertEqual(code_events[-1]["args"][0]["class_id"], "class-two")

            teacher_client.emit("teacher_code_update", {
                "role": "teacher", "token": self.teacher_token, "class_id": "class-one",
                "code": "print('other')", "language": "python",
            })
            self.assertFalse(any(
                event.get("name") == "teacher_code" and event["args"][0].get("class_id") == "class-one"
                for event in student_client.get_received()
            ))

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

    def test_class_challenge_switch_restricts_students_but_not_teachers(self):
        self._set_disabled_challenges_class()
        with patch("app._read_challenges", return_value=[{
            "difficulty": 1, "points": 3, "text": "Print hello"
        }]):
            student = self.http.post(
                "/api/challenge/random",
                headers={"X-User-Token": self.student_token},
                json={"classId": "class-one", "difficulty": 1},
            )
            teacher = self.http.post(
                "/api/challenge/random",
                headers={"X-Teacher-Token": self.teacher_token},
                json={"classId": "class-one", "difficulty": 1},
            )
            anonymous = self.http.post(
                "/api/challenge/random", json={"classId": "class-one", "difficulty": 1}
            )

        self.assertEqual(student.status_code, 403)
        self.assertIn("disabled", student.get_json()["error"].lower())
        self.assertEqual(teacher.status_code, 200)
        self.assertEqual(anonymous.status_code, 403)

    def test_teacher_can_update_class_challenge_access(self):
        self._set_disabled_challenges_class()
        response = self.http.post(
            "/api/teacher/classes/settings",
            headers={"X-Teacher-Token": self.teacher_token},
            json={"classId": "class-one", "settings": {"challenges_enabled": True}},
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["classData"]["settings"]["challenges_enabled"])
        saved = json.loads(eagle.CLASSES_FILE.read_text(encoding="utf-8"))
        self.assertTrue(saved["classes"][0]["settings"]["challenges_enabled"])

    def test_teacher_can_update_class_student_ide_access(self):
        self._set_disabled_challenges_class()
        response = self.http.post(
            "/api/teacher/classes/settings",
            headers={"X-Teacher-Token": self.teacher_token},
            json={"classId": "class-one", "settings": {"student_ide_access_enabled": False}},
        )

        self.assertEqual(response.status_code, 200)
        settings = response.get_json()["classData"]["settings"]
        self.assertFalse(settings["student_ide_access_enabled"])
        student = eagle._student_tokens[self.student_token]
        allowed, error = eagle._student_ide_access_allowed(student, "class-one")
        self.assertFalse(allowed)
        self.assertIn("disabled", error.lower())

    def test_student_ai_uses_selected_class_membership(self):
        eagle.USERS_FILE.write_text(json.dumps({"users": [{
            "email": self.student_email,
            "name": "Student",
            "role": "student",
            "class_id": "class-one",
            "class_ids": ["class-one", "class-two"],
            "enabled": True,
        }]}), encoding="utf-8")
        eagle.CLASSES_FILE.write_text(json.dumps({"classes": [
            {"id": "class-one", "settings": {"ai_enabled": False}},
            {"id": "class-two", "settings": {"ai_enabled": True}},
        ]}), encoding="utf-8")
        eagle._users_cache = None
        eagle._classes_cache = None
        with patch("app._load_config", return_value={"ai_explainer_enabled": True}):
            with eagle.app.test_request_context(headers={"X-User-Token": self.student_token}):
                allowed, error = eagle._effective_ai_enabled(eagle.request, {"classId": "class-two"})

        self.assertTrue(allowed)
        self.assertIsNone(error)

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
