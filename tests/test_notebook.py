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
        self.assignments_dir = self.root / "assignments"
        self.users_file = self.root / "users.json"
        self.classes_file = self.root / "classes.json"
        self.skills_file = self.root / "skills.json"
        self.notebooks_dir.mkdir()
        self.assignments_dir.mkdir()

        self.original_notebooks_dir = eagle.NOTEBOOKS_DIR
        self.original_assignments_dir = eagle.ASSIGNMENTS_DIR
        self.original_users_file = eagle.USERS_FILE
        self.original_classes_file = eagle.CLASSES_FILE
        self.original_skills_file = eagle.SKILLS_FILE
        eagle.NOTEBOOKS_DIR = self.notebooks_dir
        eagle.ASSIGNMENTS_DIR = self.assignments_dir
        eagle.USERS_FILE = self.users_file
        eagle.CLASSES_FILE = self.classes_file
        eagle.SKILLS_FILE = self.skills_file

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
        self.skills_file.write_text(json.dumps({"skills": []}), encoding="utf-8")
        eagle._skills_cache = None

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
        eagle.ASSIGNMENTS_DIR = self.original_assignments_dir
        eagle.USERS_FILE = self.original_users_file
        eagle.CLASSES_FILE = self.original_classes_file
        eagle.SKILLS_FILE = self.original_skills_file
        eagle._skills_cache = None
        self.tmp.cleanup()

    def test_default_python_and_javascript_skills_seed_once_and_remain_deletable(self):
        headers = {"X-Teacher-Token": self.teacher_token}
        response = self.client.get("/api/teacher/skills", headers=headers)
        self.assertEqual(response.status_code, 200)
        skills = response.get_json()["skills"]
        by_name = {skill["name"]: skill for skill in skills}
        self.assertIn("Python-Print", by_name)
        self.assertIn("Python-Elif", by_name)
        self.assertIn("JavaScript-Console-Log", by_name)
        self.assertIn("JavaScript-DOM-Events", by_name)
        self.assertTrue(all(not skill["class_ids"] for skill in skills))

        deleted = by_name["Python-Print"]
        delete_response = self.client.post(
            "/api/teacher/skills/delete", headers=headers, json={"skillId": deleted["id"]}
        )
        self.assertEqual(delete_response.status_code, 200)
        refreshed = self.client.get("/api/teacher/skills", headers=headers).get_json()["skills"]
        self.assertNotIn("Python-Print", {skill["name"] for skill in refreshed})
        saved = json.loads(self.skills_file.read_text(encoding="utf-8"))
        self.assertIn(self.teacher_email, saved["default_skills_seeded_for"])

    def _create_prompt(
        self,
        prompt="Reflect on today's loop practice.",
        title="Loop Reflection",
        response_type="written",
        skill_tags=None,
        max_score=10,
    ):
        response = self.client.post(
            "/api/teacher/notebook-prompts/create",
            headers={"X-Teacher-Token": self.teacher_token},
            json={
                "classId": self.class_id,
                "prompt": prompt,
                "title": title,
                "responseType": response_type,
                "skillTags": skill_tags or [],
                "maxScore": max_score,
            },
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

    def test_prompt_skill_tags_use_teacher_catalog_and_attach_to_class(self):
        self.skills_file.write_text(json.dumps({
            "skills": [{
                "id": "skill-conditionals",
                "teacher_email": self.teacher_email,
                "name": "Conditionals",
                "description": "Choose a branch using boolean conditions.",
                "order": 0,
                "class_ids": [],
            }],
            "default_skills_seeded_for": [self.teacher_email],
        }), encoding="utf-8")
        eagle._skills_cache = None

        prompt = self._create_prompt(skill_tags=["Conditionals"])

        self.assertEqual(prompt["skillTags"], ["Conditionals"])
        skills = self.client.get(
            "/api/teacher/skills", headers={"X-Teacher-Token": self.teacher_token}
        ).get_json()["skills"]
        selected = next(skill for skill in skills if skill["name"] == "Conditionals")
        self.assertEqual(selected["description"], "Choose a branch using boolean conditions.")
        self.assertIn(self.class_id, selected["class_ids"])

        unknown = self.client.post(
            "/api/teacher/notebook-prompts/create",
            headers={"X-Teacher-Token": self.teacher_token},
            json={"classId": self.class_id, "prompt": "Test", "skillTags": ["Not In Catalog"]},
        )
        self.assertEqual(unknown.status_code, 400)
        self.assertIn("unknown skill", unknown.get_json()["error"].lower())

    def test_notebook_tab_metadata_and_limit_are_normalized(self):
        raw_tabs = [
            {
                "id": f"tab-{idx}",
                "label": "This label is intentionally far too long" if idx == 0 else f"Tab {idx}",
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
        self.assertEqual(first["label"], "This label is intent")
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

        graded = self.client.get(
            f"/api/notebook?classId={self.class_id}",
            headers={"X-User-Token": self.student_token},
        ).get_json()["notebook"]
        graded_assignments = next(tab for tab in graded["tabs"] if tab["id"] == "assignments")
        graded_assignments["blocks"][0]["responseHtml"] = "<p>changed after score</p>"
        graded_save = self.client.post(
            "/api/notebook/save",
            headers={"X-User-Token": self.student_token},
            json={"classId": self.class_id, "notebook": graded},
        )
        self.assertEqual(graded_save.status_code, 200)
        graded_block = next(tab for tab in graded_save.get_json()["notebook"]["tabs"] if tab["id"] == "assignments")["blocks"][0]
        self.assertIn('print("hi")', graded_block["responseHtml"])
        self.assertEqual(graded_block["score"], "9/10")

        clear_grade_response = self.client.post(
            "/api/teacher/notebook-prompts/grade",
            headers={"X-Teacher-Token": self.teacher_token},
            json={
                "classId": self.class_id,
                "promptId": prompt["id"],
                "studentEmail": self.student_email,
                "score": "",
                "feedback": "",
            },
        )
        self.assertEqual(clear_grade_response.status_code, 200)
        reopened = self.client.get(
            f"/api/notebook?classId={self.class_id}",
            headers={"X-User-Token": self.student_token},
        ).get_json()["notebook"]
        reopened_assignments = next(tab for tab in reopened["tabs"] if tab["id"] == "assignments")
        reopened_assignments["blocks"][0]["responseHtml"] = "<p>changed after score cleared</p>"
        reopened_save = self.client.post(
            "/api/notebook/save",
            headers={"X-User-Token": self.student_token},
            json={"classId": self.class_id, "notebook": reopened},
        )
        self.assertEqual(reopened_save.status_code, 200)
        reopened_block = next(tab for tab in reopened_save.get_json()["notebook"]["tabs"] if tab["id"] == "assignments")["blocks"][0]
        self.assertIn("changed after score cleared", reopened_block["responseHtml"])
        self.assertEqual(reopened_block["score"], "")

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
        self.assertIn("changed after score cleared", locked_block["responseHtml"])
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

    def test_notebook_prompt_scores_contribute_to_skill_mastery(self):
        self.skills_file.write_text(
            json.dumps({
                "skills": [{
                    "id": "skill-loops",
                    "teacher_email": self.teacher_email,
                    "name": "Loops",
                    "description": "Loop basics",
                    "order": 0,
                    "class_ids": [self.class_id],
                    "created_at": "2026-06-11 00:00:00",
                    "updated_at": "2026-06-11 00:00:00",
                }]
            }),
            encoding="utf-8",
        )
        (self.assignments_dir / "Regular Loops.json").write_text(
            json.dumps({
                "name": "Regular Loops",
                "task": "Practice loops.",
                "allowFileSubmission": True,
                "maxScore": 10,
                "targetClassId": self.class_id,
                "targetClassName": "Notebook Class",
                "createdByEmail": self.teacher_email,
                "skillTags": ["Loops"],
                "submissions": [{
                    "email": self.student_email,
                    "name": "Student One",
                    "totalScore": 10,
                    "score": 10,
                }],
            }),
            encoding="utf-8",
        )
        prompt = self._create_prompt(title="Notebook Loops", skill_tags=["Loops"], max_score=10)
        notebook = self.client.get(
            f"/api/notebook?classId={self.class_id}",
            headers={"X-User-Token": self.student_token},
        ).get_json()["notebook"]
        assignments = next(tab for tab in notebook["tabs"] if tab["id"] == "assignments")
        assignments["blocks"][0]["responseHtml"] = "<ul><li>I can trace loop counters.</li></ul>"
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
                "score": "6",
                "feedback": "Keep practicing.",
            },
        )
        self.assertEqual(grade_response.status_code, 200)

        response = self.client.get(
            f"/api/teacher/classes/{self.class_id}/mastery",
            headers={"X-Teacher-Token": self.teacher_token},
        )

        self.assertEqual(response.status_code, 200)
        report = response.get_json()["report"]
        student = next(row for row in report["students"] if row["email"] == self.student_email)
        self.assertEqual(student["skillScores"]["Loops"], 80.0)
        assignment_names = [row["name"] for row in report["assignments"]]
        self.assertIn("Regular Loops", assignment_names)
        self.assertIn("Notebook: Notebook Loops", assignment_names)


if __name__ == "__main__":
    unittest.main()
