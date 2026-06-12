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

    def _create_prompt(self, prompt="Reflect on today's loop practice.", title="Loop Reflection", response_type="written"):
        response = self.client.post(
            "/api/teacher/notebook-prompts/create",
            headers={"X-Teacher-Token": self.teacher_token},
            json={"classId": self.class_id, "prompt": prompt, "title": title, "responseType": response_type},
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
        self.assertEqual(assignments["blocks"][0]["title"], "Loop Reflection")
        self.assertEqual(assignments["blocks"][0]["responseType"], "written")

        save_response = self.client.post(
            "/api/notebook/save",
            headers={"X-User-Token": self.student_token},
            json={
                "classId": self.class_id,
                "notebook": {
                    "activeTabId": "custom",
                    "tabs": [{
                        "id": "custom",
                        "label": "Mine",
                        "html": "<p>hello</p>",
                        "color": "#123abc",
                        "bookmarked": True,
                    }],
                },
            },
        )

        self.assertEqual(save_response.status_code, 200)
        saved = save_response.get_json()["notebook"]
        saved_assignments = next(tab for tab in saved["tabs"] if tab["id"] == "assignments")
        saved_custom = next(tab for tab in saved["tabs"] if tab["id"] == "custom")
        self.assertEqual(saved_custom["color"], "#123abc")
        self.assertTrue(saved_custom["bookmarked"])
        self.assertTrue(saved_assignments["locked"])
        self.assertEqual(saved_assignments["blocks"][0]["promptId"], prompt["id"])

    def test_notebook_tab_metadata_and_limit_are_normalized(self):
        raw_tabs = [
            {
                "id": f"tab-{idx}",
                "label": f"Tab {idx}",
                "html": f"<p>{idx}</p>",
                "color": "#abcdef" if idx == 0 else "not-a-color",
                "bookmarked": idx == 0,
            }
            for idx in range(90)
        ]

        response = self.client.post(
            "/api/notebook/save",
            headers={"X-User-Token": self.student_token},
            json={
                "classId": self.class_id,
                "notebook": {
                    "activeTabId": "tab-0",
                    "tabs": raw_tabs,
                },
            },
        )

        self.assertEqual(response.status_code, 200)
        saved = response.get_json()["notebook"]
        self.assertEqual(len(saved["tabs"]), eagle.MAX_NOTEBOOK_TABS)
        first = saved["tabs"][0]
        second = saved["tabs"][1]
        self.assertEqual(first["color"], "#abcdef")
        self.assertTrue(first["bookmarked"])
        self.assertEqual(second["color"], eagle.DEFAULT_NOTEBOOK_TAB_COLOR)
        self.assertFalse(second["bookmarked"])
        self.assertEqual(saved["tabs"][-1]["id"], "assignments")

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

    def test_teacher_can_lock_grade_and_delete_notebook_prompt(self):
        prompt = self._create_prompt(title="Code Trace", response_type="code")
        notebook = self.client.get(
            f"/api/notebook?classId={self.class_id}",
            headers={"X-User-Token": self.student_token},
        ).get_json()["notebook"]
        assignments = next(tab for tab in notebook["tabs"] if tab["id"] == "assignments")
        assignments["blocks"][0]["responseHtml"] = (
            '<figure class="student-notebook-code-block" data-language="python">'
            '<ol class="student-notebook-code-lines"><li><code>print("hi")</code></li></ol>'
            '</figure>'
        )

        save_response = self.client.post(
            "/api/notebook/save",
            headers={"X-User-Token": self.student_token},
            json={"classId": self.class_id, "notebook": notebook},
        )
        self.assertEqual(save_response.status_code, 200)

        grade_response = self.client.post(
            "/api/teacher/notebook-prompts/grade",
            headers={"X-Teacher-Token": self.teacher_token},
            json={
                "classId": self.class_id,
                "promptId": prompt["id"],
                "studentEmail": self.student_email,
                "score": "9/10",
                "feedback": "Great trace.",
            },
        )
        self.assertEqual(grade_response.status_code, 200)

        lock_response = self.client.post(
            "/api/teacher/notebook-prompts/lock",
            headers={"X-Teacher-Token": self.teacher_token},
            json={"classId": self.class_id, "promptId": prompt["id"], "locked": True},
        )
        self.assertEqual(lock_response.status_code, 200)
        self.assertTrue(lock_response.get_json()["prompt"]["locked"])

        stale = self.client.get(
            f"/api/notebook?classId={self.class_id}",
            headers={"X-User-Token": self.student_token},
        ).get_json()["notebook"]
        locked_assignments = next(tab for tab in stale["tabs"] if tab["id"] == "assignments")
        locked_assignments["blocks"][0]["responseHtml"] = "<p>changed after lock</p>"
        locked_assignments["blocks"][0]["score"] = ""
        locked_assignments["blocks"][0]["feedback"] = ""
        locked_save = self.client.post(
            "/api/notebook/save",
            headers={"X-User-Token": self.student_token},
            json={"classId": self.class_id, "notebook": stale},
        )
        self.assertEqual(locked_save.status_code, 200)
        locked_block = next(tab for tab in locked_save.get_json()["notebook"]["tabs"] if tab["id"] == "assignments")["blocks"][0]
        self.assertIn('print("hi")', locked_block["responseHtml"])
        self.assertEqual(locked_block["score"], "9/10")
        self.assertEqual(locked_block["feedback"], "Great trace.")

        delete_response = self.client.post(
            "/api/teacher/notebook-prompts/delete",
            headers={"X-Teacher-Token": self.teacher_token},
            json={"classId": self.class_id, "promptId": prompt["id"]},
        )
        self.assertEqual(delete_response.status_code, 200)
        after_delete = self.client.get(
            f"/api/notebook?classId={self.class_id}",
            headers={"X-User-Token": self.student_token},
        ).get_json()["notebook"]
        assignments_after_delete = next(tab for tab in after_delete["tabs"] if tab["id"] == "assignments")
        self.assertEqual(assignments_after_delete["blocks"], [])


if __name__ == "__main__":
    unittest.main()
