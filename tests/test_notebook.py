import builtins
import getpass
import json
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


class NotebookTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.notebooks_dir = self.root / "notebooks"
        self.users_file = self.root / "users.json"
        self.classes_file = self.root / "classes.json"
        self.notebooks_dir.mkdir()

        self.original_notebooks_dir = eagle.NOTEBOOKS_DIR
        self.original_users_file = eagle.USERS_FILE
        self.original_classes_file = eagle.CLASSES_FILE
        eagle.NOTEBOOKS_DIR = self.notebooks_dir
        eagle.USERS_FILE = self.users_file
        eagle.CLASSES_FILE = self.classes_file

        self.class_id = "class-notebook"
        self.teacher_email = "teacher@example.com"
        self.student_email = "student@example.com"
        self.second_student_email = "second@example.com"
        self.teacher_token = "teacher-token"
        self.student_token = "student-token"
        self.second_student_token = "second-student-token"

        users = {
            "users": [
                {
                    "email": self.teacher_email,
                    "name": "Teacher",
                    "role": "teacher",
                    "enabled": True,
                },
                {
                    "email": self.student_email,
                    "name": "Student One",
                    "role": "student",
                    "class_id": self.class_id,
                    "class_ids": [self.class_id],
                    "enabled": True,
                },
                {
                    "email": self.second_student_email,
                    "name": "Student Two",
                    "role": "student",
                    "class_id": self.class_id,
                    "class_ids": [self.class_id],
                    "enabled": True,
                },
            ]
        }
        classes = {
            "classes": [
                {
                    "id": self.class_id,
                    "name": "Notebook Class",
                    "teacher_email": self.teacher_email,
                    "join_code": "ABC123",
                    "settings": {},
                    "students": [self.student_email, self.second_student_email],
                    "created_at": "2026-06-11 00:00:00",
                }
            ]
        }
        self.users_file.write_text(json.dumps(users), encoding="utf-8")
        self.classes_file.write_text(json.dumps(classes), encoding="utf-8")

        eagle._teacher_tokens[self.teacher_token] = {
            "email": self.teacher_email,
            "name": "Teacher",
            "role": "teacher",
        }
        eagle._student_tokens[self.student_token] = {
            "email": self.student_email,
            "name": "Student One",
            "role": "student",
            "class_id": self.class_id,
            "class_ids": [self.class_id],
        }
        eagle._student_tokens[self.second_student_token] = {
            "email": self.second_student_email,
            "name": "Student Two",
            "role": "student",
            "class_id": self.class_id,
            "class_ids": [self.class_id],
        }
        self.client = eagle.app.test_client()

    def tearDown(self):
        eagle._teacher_tokens.pop(self.teacher_token, None)
        eagle._student_tokens.pop(self.student_token, None)
        eagle._student_tokens.pop(self.second_student_token, None)
        eagle.NOTEBOOKS_DIR = self.original_notebooks_dir
        eagle.USERS_FILE = self.original_users_file
        eagle.CLASSES_FILE = self.original_classes_file
        self.tmp.cleanup()

    def _create_prompt(self, prompt="Reflect on today's loop practice."):
        response = self.client.post(
            "/api/teacher/notebook-prompts/create",
            headers={"X-Teacher-Token": self.teacher_token},
            json={"classId": self.class_id, "prompt": prompt},
        )
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertTrue(data["ok"])
        return data["prompt"]

    def test_prompt_is_added_to_locked_assignments_tab(self):
        prompt = self._create_prompt()

        response = self.client.get(
            f"/api/notebook?classId={self.class_id}",
            headers={"X-User-Token": self.student_token},
        )

        self.assertEqual(response.status_code, 200)
        notebook = response.get_json()["notebook"]
        assignments = next(tab for tab in notebook["tabs"] if tab["id"] == "assignments")
        self.assertTrue(assignments["locked"])
        self.assertEqual(assignments["label"], "Assignments")
        self.assertEqual(assignments["blocks"][0]["promptId"], prompt["id"])

        save_response = self.client.post(
            "/api/notebook/save",
            headers={"X-User-Token": self.student_token},
            json={
                "classId": self.class_id,
                "notebook": {
                    "activeTabId": "custom",
                    "tabs": [{"id": "custom", "label": "Mine", "html": "<p>hello</p>"}],
                },
            },
        )

        self.assertEqual(save_response.status_code, 200)
        saved = save_response.get_json()["notebook"]
        saved_assignments = next(tab for tab in saved["tabs"] if tab["id"] == "assignments")
        self.assertTrue(saved_assignments["locked"])
        self.assertEqual(saved_assignments["blocks"][0]["promptId"], prompt["id"])

    def test_teacher_can_view_prompt_responses_and_missing_students(self):
        prompt = self._create_prompt()
        notebook = self.client.get(
            f"/api/notebook?classId={self.class_id}",
            headers={"X-User-Token": self.student_token},
        ).get_json()["notebook"]
        assignments = next(tab for tab in notebook["tabs"] if tab["id"] == "assignments")
        assignments["blocks"][0]["responseHtml"] = "<ul><li>I learned how counters change.</li></ul>"

        save_response = self.client.post(
            "/api/notebook/save",
            headers={"X-User-Token": self.student_token},
            json={"classId": self.class_id, "notebook": notebook},
        )
        self.assertEqual(save_response.status_code, 200)

        response = self.client.get(
            f"/api/teacher/notebook-prompts/responses?classId={self.class_id}&promptId={prompt['id']}",
            headers={"X-Teacher-Token": self.teacher_token},
        )

        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertTrue(data["ok"])
        self.assertEqual([r["studentEmail"] for r in data["responses"]], [self.student_email])
        self.assertEqual([m["studentEmail"] for m in data["missing"]], [self.second_student_email])


if __name__ == "__main__":
    unittest.main()
