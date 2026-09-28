import builtins
import csv
import getpass
import io
import json
import tempfile
import time
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


class AssignmentWorkflowTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.assignments_dir = self.root / "assignments"
        self.submissions_dir = self.root / "assignment_submissions"
        self.user_files_dir = self.root / "user_files"
        self.users_file = self.root / "users.json"
        self.classes_file = self.root / "classes.json"
        for directory in (self.assignments_dir, self.submissions_dir, self.user_files_dir):
            directory.mkdir(parents=True)

        self.originals = {
            "ASSIGNMENTS_DIR": eagle.ASSIGNMENTS_DIR,
            "ASSIGNMENT_SUBMISSIONS_DIR": eagle.ASSIGNMENT_SUBMISSIONS_DIR,
            "USER_FILES_DIR": eagle.USER_FILES_DIR,
            "USERS_FILE": eagle.USERS_FILE,
            "CLASSES_FILE": eagle.CLASSES_FILE,
            "recovery": eagle._assignment_ai_recovery_checked,
        }
        eagle.ASSIGNMENTS_DIR = self.assignments_dir
        eagle.ASSIGNMENT_SUBMISSIONS_DIR = self.submissions_dir
        eagle.USER_FILES_DIR = self.user_files_dir
        eagle.USERS_FILE = self.users_file
        eagle.CLASSES_FILE = self.classes_file
        eagle._assignment_ai_recovery_checked = True
        eagle._users_cache = None
        eagle._classes_cache = None

        self.teacher_email = "teacher@example.com"
        self.student_email = "123456@example.com"
        self.missing_email = "654321@example.com"
        self.class_one = "class-one"
        self.class_two = "class-two"
        self.teacher_token = "assignment-teacher-token"
        self.student_token = "assignment-student-token"

        self.users_file.write_text(json.dumps({"users": [
            {"email": self.teacher_email, "name": "Teacher", "role": "teacher", "enabled": True},
            {"email": self.student_email, "name": "Student One", "role": "student", "enabled": True, "class_id": self.class_one, "class_ids": [self.class_one]},
            {"email": self.missing_email, "name": "Student Two", "role": "student", "enabled": True, "class_id": self.class_one, "class_ids": [self.class_one]},
        ]}), encoding="utf-8")
        self.classes_file.write_text(json.dumps({"classes": [
            {"id": self.class_one, "name": "Period One", "teacher_email": self.teacher_email, "join_code": "ONE111", "settings": {}, "students": [self.student_email, self.missing_email]},
            {"id": self.class_two, "name": "Period Two", "teacher_email": self.teacher_email, "join_code": "TWO222", "settings": {}, "students": []},
        ]}), encoding="utf-8")
        eagle._teacher_tokens[self.teacher_token] = {"email": self.teacher_email, "name": "Teacher", "role": "teacher"}
        eagle._student_tokens[self.student_token] = {"email": self.student_email, "name": "Student One", "role": "student", "class_id": self.class_one, "class_ids": [self.class_one]}
        self.client = eagle.app.test_client()

    def tearDown(self):
        eagle._teacher_tokens.pop(self.teacher_token, None)
        eagle._student_tokens.pop(self.student_token, None)
        for name, value in self.originals.items():
            if name == "recovery":
                eagle._assignment_ai_recovery_checked = value
            else:
                setattr(eagle, name, value)
        eagle._users_cache = None
        eagle._classes_cache = None
        self.tmp.cleanup()

    @property
    def teacher_headers(self):
        return {"X-Teacher-Token": self.teacher_token}

    @property
    def student_headers(self):
        return {"X-User-Token": self.student_token}

    def create_assignment(self, class_id=None, name="Loops", active=False):
        response = self.client.post(
            "/api/assignments/create",
            headers=self.teacher_headers,
            json={"name": name, "task": "Write a loop", "maxScore": 10, "classId": class_id or self.class_one},
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        assignment = response.get_json()["assignment"]
        if active:
            response = self.client.post(
                "/api/assignments/update",
                headers=self.teacher_headers,
                json={"assignmentId": assignment["id"], "active": True},
            )
            self.assertEqual(response.status_code, 200)
            assignment = response.get_json()["assignment"]
        return assignment

    def submit_code(self, assignment):
        student_root = eagle._get_user_dir(self.student_email)
        student_root.mkdir(parents=True, exist_ok=True)
        (student_root / "answer.py").write_text("for i in range(3):\n    print(i)\n", encoding="utf-8")
        response = self.client.post(
            "/api/assignments/submit",
            headers=self.student_headers,
            json={"assignmentId": assignment["id"], "filePath": "answer.py"},
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return response.get_json()["submission"]

    def test_same_name_is_allowed_in_different_classes_but_not_same_class(self):
        first = self.create_assignment(self.class_one, "Shared Title")
        second = self.create_assignment(self.class_two, "Shared Title")
        self.assertNotEqual(first["id"], second["id"])
        duplicate = self.client.post(
            "/api/assignments/create",
            headers=self.teacher_headers,
            json={"name": "shared title", "task": "Duplicate", "classId": self.class_one},
        )
        self.assertEqual(duplicate.status_code, 409)

    def test_locked_assignments_are_hidden_from_student_assignment_list(self):
        locked = self.create_assignment(name="Locked")
        active = self.create_assignment(name="Active", active=True)
        response = self.client.get("/api/assignments", headers=self.student_headers)
        self.assertEqual(response.status_code, 200)
        returned = response.get_json()["assignments"]
        self.assertEqual([row["id"] for row in returned], [active["id"]])
        self.assertNotIn(locked["id"], [row["id"] for row in returned])

    def test_submission_storage_is_separate_and_not_counted_in_teacher_workspace(self):
        assignment = self.create_assignment(active=True)
        teacher_root = eagle._get_user_dir(self.teacher_email)
        teacher_root.mkdir(parents=True)
        (teacher_root / "teacher.py").write_text("print('teacher')", encoding="utf-8")
        before = eagle._count_all_files_for_user(teacher_root)

        submission = self.submit_code(assignment)

        after = eagle._count_all_files_for_user(teacher_root)
        self.assertEqual(before, after)
        self.assertFalse(submission.get("adminFilePath"))
        stored = self.submissions_dir / submission["submissionPath"]
        self.assertTrue(stored.is_file())
        self.assertEqual(stored.parents[1].name, self.class_one)

    def test_legacy_assignment_and_teacher_workspace_file_migrate_on_load(self):
        teacher_root = eagle._get_user_dir(self.teacher_email)
        legacy_folder = teacher_root / "Legacy Work"
        legacy_folder.mkdir(parents=True)
        legacy_file = legacy_folder / "Student One.py"
        legacy_file.write_text("print('legacy')", encoding="utf-8")
        legacy_metadata = {
            "name": "Legacy Work",
            "task": "Legacy task",
            "maxScore": 10,
            "active": True,
            "allowFileSubmission": True,
            "targetClassId": self.class_one,
            "targetClassName": "Period One",
            "createdByEmail": self.teacher_email,
            "submissions": [{
                "name": "Student One",
                "email": self.student_email,
                "adminFilePath": "Legacy Work/Student One.py",
                "submittedFileName": "Student One.py",
                "code": "print('legacy')",
            }],
        }
        legacy_path = self.assignments_dir / "Legacy Work.json"
        legacy_path.write_text(json.dumps(legacy_metadata), encoding="utf-8")

        assignments = eagle._list_assignments()

        self.assertEqual(len(assignments), 1)
        migrated = assignments[0]
        self.assertRegex(migrated["id"], r"^[a-f0-9]{32}$")
        self.assertFalse(legacy_path.exists())
        self.assertTrue((self.assignments_dir / f"{migrated['id']}.json").exists())
        self.assertFalse(legacy_file.exists())
        self.assertTrue((self.submissions_dir / migrated["submissions"][0]["submissionPath"]).exists())
        self.assertEqual(eagle._count_all_files_for_user(teacher_root), 0)

    def test_background_ai_grade_saves_feedback_without_replacing_manual_override(self):
        assignment = self.create_assignment(active=True)
        self.submit_code(assignment)
        manual = self.client.post(
            "/api/assignments/score",
            headers=self.teacher_headers,
            json={"assignmentId": assignment["id"], "studentEmail": self.student_email, "score": 7},
        )
        self.assertEqual(manual.status_code, 200)

        with patch.object(eagle, "_effective_ai_enabled", return_value=(True, None)), patch.object(
            eagle,
            "call_ollama_generate",
            return_value={"ok": True, "text": '{"score": 9, "feedback": "The loop produces the required output correctly. Clear structure supports the strong score."}'},
        ):
            queued = self.client.post(
                "/api/assignments/grade-ai",
                headers=self.teacher_headers,
                json={"assignmentId": assignment["id"], "studentEmail": self.student_email},
            )
            self.assertEqual(queued.status_code, 202)
            deadline = time.time() + 3
            graded = None
            while time.time() < deadline:
                graded = eagle._load_assignment(assignment["id"])
                if graded["submissions"][0].get("aiGradingStatus") in {"completed", "failed"}:
                    break
                time.sleep(0.02)

        submission = graded["submissions"][0]
        self.assertEqual(submission["aiGradingStatus"], "completed")
        self.assertEqual(submission["aiSuggestedScore"], 9)
        self.assertEqual(submission["codeScore"], 7)
        self.assertTrue(submission["manualScoreOverride"])
        self.assertIn("required output", submission["aiFeedback"])

    def test_grade_export_supports_points_and_one_decimal_percent(self):
        assignment = self.create_assignment(active=True)
        self.submit_code(assignment)
        scored = self.client.post(
            "/api/assignments/score",
            headers=self.teacher_headers,
            json={"assignmentId": assignment["id"], "studentEmail": self.student_email, "score": 8},
        )
        self.assertEqual(scored.status_code, 200)

        points = self.client.get(f"/api/assignments/{assignment['id']}/csv?format=points", headers=self.teacher_headers)
        percent = self.client.get(f"/api/assignments/{assignment['id']}/csv?format=percent", headers=self.teacher_headers)
        self.assertEqual(points.status_code, 200)
        self.assertEqual(percent.status_code, 200)
        points_rows = list(csv.reader(io.StringIO(points.get_data(as_text=True))))
        percent_rows = list(csv.reader(io.StringIO(percent.get_data(as_text=True))))
        self.assertEqual(points_rows[0], ["Student Number", "Score"])
        self.assertIn(["123456", "8"], points_rows)
        self.assertIn(["654321", ""], points_rows)
        self.assertIn(["123456", "80.0%"], percent_rows)


if __name__ == "__main__":
    unittest.main()
