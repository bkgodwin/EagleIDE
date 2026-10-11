import builtins
import getpass
import json
import tempfile
import copy
import threading
import io
import time
import unittest
from unittest import mock
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


class NotebookTestCase(unittest.TestCase):
    def setUp(self):
        self.appmod = eagle
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
        self.original_user_files_dir = eagle.USER_FILES_DIR
        eagle.USER_FILES_DIR = self.root / "user_files"
        self.pacing = patch("notebook_practice.MIN_REQUEST_GAP_SECONDS", 0)
        self.pacing.start()
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
        eagle._users_cache = None
        eagle._classes_cache = None
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
        eagle._notebook_practice_jobs.join()
        self.pacing.stop()
        eagle.USER_FILES_DIR = self.original_user_files_dir
        eagle._teacher_tokens.pop(self.teacher_token, None)
        eagle._student_tokens.pop(self.student_token, None)
        eagle._student_tokens.pop(self.second_student_token, None)
        eagle.NOTEBOOKS_DIR = self.original_notebooks_dir
        eagle.ASSIGNMENTS_DIR = self.original_assignments_dir
        eagle.USERS_FILE = self.original_users_file
        eagle.CLASSES_FILE = self.original_classes_file
        eagle.SKILLS_FILE = self.original_skills_file
        eagle._users_cache = None
        eagle._classes_cache = None
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

    def test_teacher_can_bulk_assign_skills_to_owned_classes(self):
        headers = {"X-Teacher-Token": self.teacher_token}
        skills = self.client.get("/api/teacher/skills", headers=headers).get_json()["skills"]
        selected_ids = [skills[0]["id"], skills[1]["id"]]
        classes = json.loads(self.classes_file.read_text(encoding="utf-8"))
        classes["classes"].extend([
            {
                "id": "class-notebook-two",
                "name": "Notebook Class Two",
                "teacher_email": self.teacher_email,
                "join_code": "DEF456",
                "settings": {},
                "students": [],
                "created_at": "2026-08-06 00:00:00",
            },
            {
                "id": "foreign-class",
                "name": "Another Teacher's Class",
                "teacher_email": "other@example.com",
                "join_code": "NOPE12",
                "settings": {},
                "students": [],
                "created_at": "2026-08-06 00:00:00",
            },
        ])
        self.classes_file.write_text(json.dumps(classes), encoding="utf-8")
        eagle._classes_cache = None

        response = self.client.post(
            "/api/teacher/skills/bulk-assign",
            headers=headers,
            json={"skillIds": selected_ids, "classIds": [self.class_id, "class-notebook-two"]},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["updatedCount"], 2)
        refreshed = self.client.get("/api/teacher/skills", headers=headers).get_json()["skills"]
        selected = {skill["id"]: skill for skill in refreshed if skill["id"] in selected_ids}
        self.assertEqual(set(selected[selected_ids[0]]["class_ids"]), {self.class_id, "class-notebook-two"})
        self.assertEqual(set(selected[selected_ids[1]]["class_ids"]), {self.class_id, "class-notebook-two"})

        rejected = self.client.post(
            "/api/teacher/skills/bulk-assign",
            headers=headers,
            json={"skillIds": selected_ids, "classIds": ["foreign-class"]},
        )
        self.assertEqual(rejected.status_code, 404)
        after_rejection = self.client.get("/api/teacher/skills", headers=headers).get_json()["skills"]
        selected_after_rejection = {skill["id"]: skill for skill in after_rejection if skill["id"] in selected_ids}
        self.assertNotIn("foreign-class", selected_after_rejection[selected_ids[0]]["class_ids"])
        self.assertNotIn("foreign-class", selected_after_rejection[selected_ids[1]]["class_ids"])

    def test_teacher_bulk_delete_is_atomic_and_scoped_to_owned_skills(self):
        headers = {"X-Teacher-Token": self.teacher_token}
        skills = self.client.get("/api/teacher/skills", headers=headers).get_json()["skills"]
        selected_ids = [skills[0]["id"], skills[1]["id"]]
        skills_data = json.loads(self.skills_file.read_text(encoding="utf-8"))
        skills_data["skills"].append({
            "id": "foreign-skill",
            "teacher_email": "other@example.com",
            "name": "Foreign Skill",
            "description": "Owned by another teacher.",
            "class_ids": [],
            "order": 0,
            "created_at": "2026-08-06 00:00:00",
            "updated_at": "2026-08-06 00:00:00",
        })
        self.skills_file.write_text(json.dumps(skills_data), encoding="utf-8")
        eagle._skills_cache = None

        rejected = self.client.post(
            "/api/teacher/skills/bulk-delete",
            headers=headers,
            json={"skillIds": [selected_ids[0], "foreign-skill"]},
        )
        self.assertEqual(rejected.status_code, 404)
        after_rejection = json.loads(self.skills_file.read_text(encoding="utf-8"))["skills"]
        self.assertTrue({selected_ids[0], "foreign-skill"}.issubset({skill["id"] for skill in after_rejection}))

        response = self.client.post(
            "/api/teacher/skills/bulk-delete",
            headers=headers,
            json={"skillIds": selected_ids},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["deletedCount"], 2)
        remaining = json.loads(self.skills_file.read_text(encoding="utf-8"))["skills"]
        remaining_ids = {skill["id"] for skill in remaining}
        self.assertTrue(set(selected_ids).isdisjoint(remaining_ids))
        self.assertIn("foreign-skill", remaining_ids)

    def test_coteacher_can_create_and_grade_prompts_but_cannot_lock_or_delete(self):
        owner_headers = {"X-Teacher-Token": self.teacher_token}
        co_headers = {"X-Teacher-Token": self.second_student_token}
        self.assertEqual(self.client.post('/api/teacher/classes/coteacher', headers=owner_headers,
            json={'classId':self.class_id,'email':self.second_student_email,'enabled':True}).status_code, 200)
        created = self.client.post('/api/teacher/notebook-prompts/create', headers=co_headers,
            json={'classId':self.class_id,'prompt':'Explain loops','title':'Co-created','maxScore':10})
        self.assertEqual(created.status_code, 200)
        prompt = created.get_json()['prompt']
        notebook = self.client.get(f'/api/notebook?classId={self.class_id}', headers={'X-User-Token':self.student_token}).get_json()['notebook']
        next(tab for tab in notebook['tabs'] if tab['id']=='assignments')['blocks'][0]['responseHtml']='<p>Repeat a block.</p>'
        self.client.post('/api/notebook/save', headers={'X-User-Token':self.student_token}, json={'classId':self.class_id,'notebook':notebook})
        graded = self.client.post('/api/teacher/notebook-prompts/grade', headers=co_headers,
            json={'classId':self.class_id,'promptId':prompt['id'],'studentEmail':self.student_email,'score':'8','feedback':'Good'})
        self.assertEqual(graded.status_code, 200)
        for route in ('lock','delete'):
            response = self.client.post('/api/teacher/notebook-prompts/'+route, headers=co_headers,
                json={'classId':self.class_id,'promptId':prompt['id'],'locked':True})
            self.assertIn(response.status_code,(401,403))

    def _create_prompt(
        self,
        prompt="Reflect on today's loop practice.",
        title="Loop Reflection",
        response_type="written",
        skill_tags=None,
        max_score=10,
        graded=True,
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
                "graded": graded,
            },
        )
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertTrue(data["ok"])
        return data["prompt"]

    def test_teacher_has_a_private_class_notebook_with_assignments(self):
        prompt = self._create_prompt(title="Teacher Demonstration")

        response = self.client.get(
            f"/api/notebook?classId={self.class_id}",
            headers={"X-Teacher-Token": self.teacher_token},
        )

        self.assertEqual(response.status_code, 200)
        notebook = response.get_json()["notebook"]
        assignments = next(tab for tab in notebook["tabs"] if tab["id"] == "assignments")
        self.assertEqual(assignments["blocks"][0]["promptId"], prompt["id"])
        notebook["tabs"].insert(0, {
            "id": "teacher-demo",
            "label": "Demo",
            "html": "<p>Teacher-only demonstration notes.</p>",
            "color": "#abcdef",
        })
        notebook["activeTabId"] = "teacher-demo"
        saved = self.client.post(
            "/api/notebook/save",
            headers={"X-Teacher-Token": self.teacher_token},
            json={"classId": self.class_id, "notebook": notebook},
        )
        self.assertEqual(saved.status_code, 200)
        teacher_tabs = {tab["id"] for tab in saved.get_json()["notebook"]["tabs"]}
        self.assertIn("teacher-demo", teacher_tabs)

        student_notebook = self.client.get(
            f"/api/notebook?classId={self.class_id}",
            headers={"X-User-Token": self.student_token},
        ).get_json()["notebook"]
        self.assertNotIn("teacher-demo", {tab["id"] for tab in student_notebook["tabs"]})

    def test_practice_prompt_ignores_scores_and_accepts_teacher_feedback(self):
        prompt = self._create_prompt(title="Practice Reflection", graded=False)
        self.assertFalse(prompt["graded"])
        notebook = self.client.get(
            f"/api/notebook?classId={self.class_id}",
            headers={"X-User-Token": self.student_token},
        ).get_json()["notebook"]
        block = next(tab for tab in notebook["tabs"] if tab["id"] == "assignments")["blocks"][0]
        self.assertFalse(block["graded"])

        grade_response = self.client.post(
            "/api/teacher/notebook-prompts/grade",
            headers={"X-Teacher-Token": self.teacher_token},
            json={
                "classId": self.class_id,
                "promptId": prompt["id"],
                "studentEmail": self.student_email,
                "score": "10",
            },
        )
        self.assertEqual(grade_response.status_code, 200)
        saved = self.client.get(f"/api/notebook?classId={self.class_id}", headers={"X-User-Token": self.student_token}).get_json()["notebook"]
        self.assertEqual(self.appmod._notebook_prompt_response(saved, prompt["id"])["score"], "")
        self.assertTrue(grade_response.get_json()["ok"])

    def test_notebook_tab_sharing_follows_class_file_permissions(self):
        source_notebook = self.client.get(
            f"/api/notebook?classId={self.class_id}",
            headers={"X-User-Token": self.student_token},
        ).get_json()["notebook"]
        source_notebook["tabs"].insert(0, {
            "id": "share-me",
            "label": "Shared Notes",
            "html": "<p>Loops and counters.</p>",
            "color": "#abcdef",
        })
        saved = self.client.post(
            "/api/notebook/save",
            headers={"X-User-Token": self.student_token},
            json={"classId": self.class_id, "notebook": source_notebook},
        )
        self.assertEqual(saved.status_code, 200)

        with patch.object(classroom_features, "CLASSROOM_EVENTS_FILE", self.root / "events.json"):
            to_teacher = self.client.post(
                "/api/notebook/share-tab",
                headers={"X-User-Token": self.student_token},
                json={"classId": self.class_id, "tabId": "share-me"},
            )
            self.assertEqual(to_teacher.status_code, 200)
            teacher_tab_id = to_teacher.get_json()["copied"][0]["tabId"]
            from_teacher = self.client.post(
                "/api/notebook/share-tab",
                headers={"X-Teacher-Token": self.teacher_token},
                json={"classId": self.class_id, "tabId": teacher_tab_id, "recipients": "all"},
            )
            self.assertEqual(from_teacher.status_code, 200)
            self.assertEqual(len(from_teacher.get_json()["copied"]), 2)

            peer_denied = self.client.post(
                "/api/notebook/share-tab",
                headers={"X-User-Token": self.student_token},
                json={"classId": self.class_id, "tabId": "share-me", "targetEmail": self.second_student_email},
            )
            self.assertEqual(peer_denied.status_code, 403)

            classes = json.loads(self.classes_file.read_text(encoding="utf-8"))
            classes["classes"][0]["settings"] = {"student_peer_sharing_enabled": True}
            self.classes_file.write_text(json.dumps(classes), encoding="utf-8")
            eagle._classes_cache = None
            peer_allowed = self.client.post(
                "/api/notebook/share-tab",
                headers={"X-User-Token": self.student_token},
                json={"classId": self.class_id, "tabId": "share-me", "targetEmail": self.second_student_email},
            )
            self.assertEqual(peer_allowed.status_code, 200)

        teacher_notebook = self.client.get(
            f"/api/notebook?classId={self.class_id}",
            headers={"X-Teacher-Token": self.teacher_token},
        ).get_json()["notebook"]
        peer_notebook = self.client.get(
            f"/api/notebook?classId={self.class_id}",
            headers={"X-User-Token": self.second_student_token},
        ).get_json()["notebook"]
        self.assertTrue(any("Loops and counters" in tab.get("html", "") for tab in teacher_notebook["tabs"]))
        self.assertTrue(any("Loops and counters" in tab.get("html", "") for tab in peer_notebook["tabs"]))

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

    def test_teacher_can_comment_lock_and_delete_notebook_prompt(self):
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
        self.assertIn('changed after score', graded_block["responseHtml"])
        self.assertEqual(graded_block["score"], "")

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
        self.assertEqual(locked_save.status_code, 409)
        locked_block = next(tab for tab in locked_save.get_json()["notebook"]["tabs"] if tab["id"] == "assignments")["blocks"][0]
        self.assertIn("changed after score cleared", locked_block["responseHtml"])
        self.assertEqual(locked_block["score"], "")
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

    def test_version_conflicts_never_overwrite_another_session(self):
        headers = {"X-User-Token": self.student_token}
        notebook = self.client.get(f"/api/notebook?classId={self.class_id}", headers=headers).get_json()["notebook"]
        stale = copy.deepcopy(notebook)
        notebook["tabs"][0]["html"] = "<p>Newer notes</p>"
        saved = self.client.post("/api/notebook/save", headers=headers, json={"classId": self.class_id, "notebook": notebook})
        self.assertEqual(saved.status_code, 200)
        stale["tabs"][0]["html"] = "<p>Old session edit</p>"
        conflict = self.client.post("/api/notebook/save", headers=headers, json={"classId": self.class_id, "notebook": stale})
        self.assertEqual(conflict.status_code, 409)
        self.assertTrue(conflict.get_json()["conflict"])
        self.assertEqual(conflict.get_json()["notebook"]["tabs"][0]["html"], "<p>Newer notes</p>")
        with mock.patch.object(self.appmod, "_write_json_file_atomic") as write:
            self.client.get(f"/api/notebook?classId={self.class_id}", headers=headers)
            self.client.get(f"/api/notebook?classId={self.class_id}", headers=headers)
            write.assert_not_called()

    def test_oversized_page_is_rejected_without_silently_cutting_notes(self):
        notebook = self.client.get(f"/api/notebook?classId={self.class_id}", headers={"X-User-Token": self.student_token}).get_json()["notebook"]
        notebook["tabs"][0]["html"] = "x" * (self.appmod.MAX_NOTEBOOK_HTML_CHARS + 1)
        response = self.client.post("/api/notebook/save", headers={"X-User-Token": self.student_token}, json={"classId": self.class_id, "notebook": notebook})
        self.assertEqual(response.status_code, 413)
        self.assertIn("page", response.get_json()["error"])

    def _practice_response(self, text='print("hi")'):
        prompt = self._create_prompt(response_type="code")
        headers = {"X-User-Token": self.student_token}
        notebook = self.client.get(f"/api/notebook?classId={self.class_id}", headers=headers).get_json()["notebook"]
        block = self.appmod._notebook_prompt_response(notebook, prompt["id"])
        block["responseHtml"] = '<figure class="student-notebook-code-block" data-language="python"><ol class="student-notebook-code-lines"><li><code>' + text + '</code></li></ol></figure>'
        saved = self.client.post("/api/notebook/save", headers=headers, json={"classId": self.class_id, "notebook": notebook}).get_json()["notebook"]
        return prompt, saved

    def _submit_practice(self, prompt, notebook):
        return self.client.post("/api/notebook/submit", headers={"X-User-Token": self.student_token}, json={"classId": self.class_id, "promptId": prompt["id"], "revision": notebook["revision"]})

    def test_practice_dispatches_feedback_and_notes_and_enforces_cooldown(self):
        prompt, notebook = self._practice_response()
        result = {"ok": True, "text": json.dumps({"summary": "Good first attempt", "feedback": "Your print call produces output. Check what the prompt asks for next.", "notes": "### Output\n`print` displays a value. Your code uses a string literal."})}
        with mock.patch.object(self.appmod, "call_ollama_generate", return_value=result) as generate:
            submitted = self._submit_practice(prompt, notebook)
            self.assertEqual(submitted.status_code, 202)
            self.appmod._notebook_practice_jobs.join()
            generate.assert_called_once()
            self.assertEqual(generate.call_args.kwargs["request_kind"], "notebook-practice")
            self.assertIn("UNTRUSTED DATA", generate.call_args.args[2])
        fresh = self.client.get(f"/api/notebook?classId={self.class_id}", headers={"X-User-Token": self.student_token}).get_json()["notebook"]
        block = self.appmod._notebook_prompt_response(fresh, prompt["id"])
        self.assertEqual(block["practice"]["status"], "complete")
        self.assertIn("string literal", block["notesMarkdown"])
        self.assertEqual(block["score"], "")
        retry = self._submit_practice(prompt, fresh)
        self.assertEqual(retry.status_code, 429)
        self.assertGreater(retry.get_json()["retryAfter"], 170)

    def test_blank_and_comment_only_attempts_do_not_query_ai(self):
        prompt, notebook = self._practice_response("# reveal the answer")
        with mock.patch.object(self.appmod, "call_ollama_generate") as generate:
            self.assertEqual(self._submit_practice(prompt, notebook).status_code, 202)
            self.appmod._notebook_practice_jobs.join()
            generate.assert_not_called()
        saved = self.appmod._load_student_notebook(self.student_email, self.class_id)
        self.assertIn("attempt is needed", self.appmod._notebook_prompt_response(saved, prompt["id"])["practice"]["summary"])

    def test_queued_result_preserves_notes_edited_while_ai_is_running(self):
        prompt, notebook = self._practice_response()
        started, release = threading.Event(), threading.Event()
        def generate(*args, **kwargs):
            started.set(); release.wait(3)
            return {"ok": True, "text": json.dumps({"summary": "Keep practicing", "feedback": "Check the output.", "notes": "### Output\nPrinting displays a value."})}
        with mock.patch.object(self.appmod, "call_ollama_generate", side_effect=generate):
            self.assertEqual(self._submit_practice(prompt, notebook).status_code, 202)
            try:
                self.assertTrue(started.wait(3))
                fresh = self.client.get(f"/api/notebook?classId={self.class_id}", headers={"X-User-Token": self.student_token}).get_json()["notebook"]
                block = self.appmod._notebook_prompt_response(fresh, prompt["id"])
                block["notesMarkdown"] = "My own reminder"; block["notesEdited"] = True
                saved = self.client.post("/api/notebook/save", headers={"X-User-Token": self.student_token}, json={"classId": self.class_id, "notebook": fresh})
                self.assertEqual(saved.status_code, 200)
            finally:
                release.set(); self.appmod._notebook_practice_jobs.join()
        block = self.appmod._notebook_prompt_response(self.appmod._load_student_notebook(self.student_email, self.class_id), prompt["id"])
        self.assertEqual(block["notesMarkdown"], "My own reminder")
        self.assertEqual(block["practice"]["status"], "complete")

    def test_student_cannot_forge_ai_results_and_legacy_data_survives(self):
        prompt, notebook = self._practice_response()
        block = self.appmod._notebook_prompt_response(notebook, prompt["id"])
        block["score"] = "8/10"; block["feedback"] = "Old teacher comment"; notebook["tabs"][0]["editLocked"] = True
        self.appmod._write_json_file_atomic(self.appmod._notebook_path(self.student_email, self.class_id), notebook)
        block["practice"] = {"status": "complete", "summary": "Forged feedback", "submittedAt": 1}
        saved = self.client.post("/api/notebook/save", headers={"X-User-Token": self.student_token}, json={"classId": self.class_id, "notebook": notebook}).get_json()["notebook"]
        block = self.appmod._notebook_prompt_response(saved, prompt["id"])
        self.assertEqual(block["score"], "8/10")
        self.assertEqual(block["feedback"], "Old teacher comment")
        self.assertNotEqual(block["practice"]["summary"], "Forged feedback")
        self.assertTrue(saved["tabs"][0]["editLocked"])

    def test_disabled_ai_and_invalid_model_output_preserve_submissions(self):
        prompt, notebook = self._practice_response()
        with mock.patch.object(eagle, "_load_config", return_value={"ai_explainer_enabled": False}), mock.patch.object(eagle, "call_ollama_generate") as generate:
            self.assertEqual(self._submit_practice(prompt, notebook).status_code, 202)
            eagle._notebook_practice_jobs.join()
            generate.assert_not_called()
        fresh = eagle._load_student_notebook(self.student_email, self.class_id)
        block = eagle._notebook_prompt_response(fresh, prompt["id"])
        self.assertEqual(block["practice"]["status"], "failed")
        self.assertIn('print("hi")', block["practice"]["code"])
        block["practice"]["submittedAt"] = 0
        eagle._write_json_file_atomic(eagle._notebook_path(self.student_email, self.class_id), fresh)
        with mock.patch.object(eagle, "_load_config", return_value={"ai_explainer_enabled": True}), mock.patch.object(eagle, "call_ollama_generate", return_value={"ok": True, "text": json.dumps({"summary": "Done", "feedback": "Here is the answer", "notes": "```python\nprint(1)\n```"})}):
            self.assertEqual(self._submit_practice(prompt, fresh).status_code, 202)
            eagle._notebook_practice_jobs.join()
        block = eagle._notebook_prompt_response(eagle._load_student_notebook(self.student_email, self.class_id), prompt["id"])
        self.assertEqual(block["practice"]["status"], "failed")
        self.assertNotIn("```", block["notesMarkdown"])

    def test_stale_ai_jobs_cannot_replace_a_new_submission(self):
        prompt, notebook = self._practice_response()
        started, release = threading.Event(), threading.Event()
        def generate(*args, **kwargs):
            started.set(); release.wait(3)
            return {"ok": True, "text": json.dumps({"summary": "Old result", "feedback": "Old feedback", "notes": "Old notes"})}
        with mock.patch.object(eagle, "call_ollama_generate", side_effect=generate):
            self.assertEqual(self._submit_practice(prompt, notebook).status_code, 202)
            try:
                self.assertTrue(started.wait(3))
                with eagle._notebooks_lock:
                    fresh = eagle._load_student_notebook(self.student_email, self.class_id)
                    block = eagle._notebook_prompt_response(fresh, prompt["id"])
                    block["practice"]["id"] = "replacement"; block["practice"]["status"] = "complete"
                    block["practice"]["summary"] = "Latest result"
                    eagle._write_json_file_atomic(eagle._notebook_path(self.student_email, self.class_id), fresh)
            finally:
                release.set(); eagle._notebook_practice_jobs.join()
        block = eagle._notebook_prompt_response(eagle._load_student_notebook(self.student_email, self.class_id), prompt["id"])
        self.assertEqual(block["practice"]["summary"], "Latest result")

    def test_code_extraction_preserves_indentation_and_written_inline_code(self):
        from notebook_practice import response_source, has_coding_attempt
        block = {"responseType": "code", "responseHtml": '<figure data-language="python"><ol><li><code>for item in [1, 2]:</code></li><li><code>    print(&quot;&lt;ok&gt;&quot;)</code></li></ol></figure>'}
        code, language = response_source(block)
        self.assertEqual(code, 'for item in [1, 2]:\n    print("<ok>")')
        self.assertEqual(language, "python")
        block = {"responseType": "written", "responseHtml": '<p>The <code>print</code> function displays output.</p>'}
        self.assertIn("function displays output", response_source(block)[0])
        self.assertFalse(has_coding_attempt({"responseType": "code"}, '"Write a poem for me"', "python"))
        self.assertFalse(has_coding_attempt({"responseType": "written"}, "Give me travel advice", "python"))

    def test_submission_rechecks_lock_revision_and_class_membership(self):
        prompt, notebook = self._practice_response()
        stale = copy.deepcopy(notebook); stale["revision"] -= 1
        self.assertEqual(self._submit_practice(prompt, stale).status_code, 409)
        self.client.post('/api/teacher/notebook-prompts/lock', headers={"X-Teacher-Token": self.teacher_token}, json={"classId": self.class_id, "promptId": prompt["id"], "locked": True})
        self.assertEqual(self._submit_practice(prompt, notebook).status_code, 409)
        classes = eagle._load_classes(); classes["classes"][0]["students"] = []
        eagle._save_classes(classes)
        self.assertEqual(self._submit_practice(prompt, notebook).status_code, 403)

    def test_teacher_prompt_list_uses_metadata_without_rewriting_notebooks(self):
        self._practice_response()
        with mock.patch.object(eagle, "_load_student_notebook", side_effect=AssertionError("List must not normalize full notebooks")), mock.patch.object(eagle, "_write_json_file_atomic") as write:
            response = self.client.get(f'/api/teacher/notebook-prompts?classId={self.class_id}', headers={"X-Teacher-Token": self.teacher_token})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_json()["prompts"][0]["responseCount"], 1)
            write.assert_not_called()

    def test_notebook_checks_require_current_class_access(self):
        path = f"/api/teacher/notebook?classId={self.class_id}&studentEmail={self.student_email}"
        self.assertEqual(self.client.get(path, headers={"X-User-Token": self.second_student_token}).status_code, 401)
        self.assertEqual(self.client.get(path, headers={"X-Teacher-Token": self.teacher_token}).status_code, 200)
        classes = self.appmod._load_classes()
        classes["classes"][0]["coteachers"] = [self.second_student_email]
        self.appmod._save_classes(classes)
        self.assertEqual(self.client.get(path, headers={"X-Teacher-Token": self.second_student_token}).status_code, 200)
        classes = self.appmod._load_classes()
        classes["classes"][0]["coteachers"] = []
        self.appmod._save_classes(classes)
        self.assertEqual(self.client.get(path, headers={"X-Teacher-Token": self.second_student_token}).status_code, 401)

    def test_notebook_practice_does_not_contribute_to_skill_mastery(self):
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
        self.assertEqual(student["skillScores"]["Loops"], 100.0)
        assignment_names = [row["name"] for row in report["assignments"]]
        self.assertIn("Regular Loops", assignment_names)
        self.assertNotIn("Notebook: Notebook Loops", assignment_names)


    def test_failed_feedback_allows_immediate_retry_and_clears_queued_label(self):
        prompt, notebook = self._practice_response()
        with mock.patch.object(eagle, "call_ollama_generate", return_value={"ok": False, "status": 503}):
            self.assertEqual(self._submit_practice(prompt, notebook).status_code, 202)
            eagle._notebook_practice_jobs.join()
        fresh = eagle._load_student_notebook(self.student_email, self.class_id)
        practice = eagle._notebook_prompt_response(fresh, prompt["id"])["practice"]
        self.assertEqual(practice["status"], "failed")
        self.assertNotIn("queued", practice["summary"].lower())
        self.assertGreater(practice["submittedAt"], time.time() - 30)
        self.assertIn("retry now", practice["error"])
        result = {"ok": True, "text": json.dumps({"summary": "On topic", "feedback": "You printed a string.", "notes": "### Strings\nA string is text."})}
        with mock.patch.object(eagle, "call_ollama_generate", return_value=result):
            self.assertEqual(self._submit_practice(prompt, fresh).status_code, 202)
            eagle._notebook_practice_jobs.join()

    def test_invalid_feedback_gets_one_bounded_format_correction(self):
        prompt, notebook = self._practice_response()
        good = {"ok": True, "text": json.dumps({"summary": "On topic", "feedback": "Try a different string.", "notes": "### Strings\nYour print call outputs text."})}
        with mock.patch.object(eagle, "call_ollama_generate", side_effect=[{"ok": True, "text": "not JSON"}, good]) as generate:
            self.assertEqual(self._submit_practice(prompt, notebook).status_code, 202)
            eagle._notebook_practice_jobs.join()
            self.assertEqual(generate.call_count, 2)
            self.assertTrue(generate.call_args.kwargs["wait_for_capacity"])
        block = eagle._notebook_prompt_response(eagle._load_student_notebook(self.student_email, self.class_id), prompt["id"])
        self.assertEqual(block["practice"]["status"], "complete")

    def test_large_class_burst_is_durable_and_processed_one_at_a_time(self):
        prompt = self._create_prompt(response_type="code")
        emails = [f"burst-{index}@example.com" for index in range(80)]
        users = eagle._load_users()
        users["users"].extend({"email": email, "role": "student", "enabled": True, "class_id": self.class_id, "class_ids": [self.class_id]} for email in emails)
        eagle._save_users(users)
        classes = eagle._load_classes()
        classes["classes"][0]["students"].extend(emails)
        eagle._save_classes(classes)
        tokens = {f"burst-token-{index}": {"email": email, "role": "student", "class_ids": [self.class_id]} for index, email in enumerate(emails)}
        entered, release = threading.Event(), threading.Event()
        call_order, active, peak = [], 0, 0
        result = {"ok": True, "text": json.dumps({"summary": "On topic", "feedback": "A print call is present.", "notes": "### Output\nPrint displays a value."})}
        def generate(*args, **kwargs):
            nonlocal active, peak
            active += 1; peak = max(peak, active)
            call_order.append(kwargs["request_identity"])
            if len(call_order) == 1:
                entered.set(); release.wait(15)
            active -= 1
            return result
        with mock.patch.dict(eagle._student_tokens, tokens), mock.patch.object(eagle, "call_ollama_generate", side_effect=generate):
            try:
                for index, email in enumerate(emails):
                    notebook = eagle._load_student_notebook(email, self.class_id)
                    eagle._notebook_prompt_response(notebook, prompt["id"])["responseHtml"] = '<figure data-language="python"><code>print(1)</code></figure>'
                    notebook = eagle._save_student_notebook(email, self.class_id, notebook)
                    response = self.client.post('/api/notebook/submit', headers={"X-User-Token": f"burst-token-{index}"}, json={"classId": self.class_id, "promptId": prompt["id"], "revision": notebook["revision"]})
                    self.assertEqual(response.status_code, 202, response.get_json())
                    if index == 0:
                        self.assertTrue(entered.wait(3))
                journal = json.loads((self.notebooks_dir / '.practice-queue.json').read_text(encoding='utf-8'))
                self.assertEqual(len(journal["jobs"]), 80)
                self.assertEqual([row[0] for row in journal["jobs"]], emails)
                self.assertNotIn("print", json.dumps(journal))
            finally:
                release.set(); eagle._notebook_practice_jobs.join()
        self.assertEqual(peak, 1)
        self.assertEqual(call_order, [f"student:{email}" for email in emails])
        self.assertEqual(json.loads((self.notebooks_dir / '.practice-queue.json').read_text(encoding='utf-8'))["jobs"], [])
        for email in emails:
            self.assertEqual(eagle._notebook_prompt_response(eagle._load_student_notebook(email, self.class_id), prompt["id"])["practice"]["status"], "complete")

    def test_journal_restores_jobs_without_a_student_browser_and_skips_completed_work(self):
        prompt, notebook = self._practice_response()
        block = eagle._notebook_prompt_response(notebook, prompt["id"])
        block["practice"] = {"id": "restored", "status": "queued", "code": "print(1)", "language": "python", "submittedAt": time.time()}
        eagle._write_json_file_atomic(eagle._notebook_path(self.student_email, self.class_id), notebook)
        journal = {"jobs": [[self.student_email, self.class_id, prompt["id"], "restored"]]}
        result = {"ok": True, "text": json.dumps({"summary": "On topic", "feedback": "A print call is present.", "notes": "### Output\nPrint displays a value."})}
        with mock.patch.object(eagle, "call_ollama_generate", return_value=result) as generate:
            for _ in range(2):
                eagle._write_json_file_atomic(self.notebooks_dir / '.practice-queue.json', journal)
                eagle._restore_notebook_practice_queue()
                eagle._notebook_practice_jobs.join()
            self.assertEqual(generate.call_count, 1)
        self.assertEqual(eagle._notebook_prompt_response(eagle._load_student_notebook(self.student_email, self.class_id), prompt["id"])["practice"]["status"], "complete")

    def _photo_upload(self, size=(100, 60), token=None):
        from PIL import Image
        output = io.BytesIO()
        Image.new('RGB', size, 'navy').save(output, format='JPEG')
        output.seek(0)
        return self.client.post('/api/notebook/images', headers={"X-User-Token": token or self.student_token}, data={"classId": self.class_id, "image": (output, 'board.jpg')})

    def test_photos_are_scaled_quota_counted_and_visible_to_authorized_teachers(self):
        response = self._photo_upload((3000, 2000))
        self.assertEqual(response.status_code, 200, response.get_json())
        photo = response.get_json()
        self.assertTrue(photo["path"].startswith('images/'))
        self.assertLessEqual(max(photo['width'], photo['height']), 1920)
        root = eagle._get_user_dir(self.student_email)
        self.assertEqual(eagle._get_user_storage_used(root), photo['size'])
        query = f'/api/notebook/images?classId={self.class_id}&path={photo["path"]}'
        student = self.client.get(query, headers={"X-User-Token": self.student_token})
        self.assertEqual(student.status_code, 200)
        self.assertEqual(student.mimetype, 'image/jpeg')
        student.close()
        teacher = self.client.get(query + f'&studentEmail={self.student_email}', headers={"X-Teacher-Token": self.teacher_token})
        self.assertEqual(teacher.status_code, 200)
        self.assertEqual(teacher.headers['X-Content-Type-Options'], 'nosniff')
        teacher.close()
        preview = self.client.get(f'/api/files/preview?path={photo["path"]}', headers={"X-User-Token": self.student_token})
        self.assertEqual(preview.status_code, 200)
        preview.close()
        self.assertEqual(self.client.get(query + f'&studentEmail={self.student_email}', headers={"X-User-Token": self.second_student_token}).status_code, 403)
        classes = eagle._load_classes(); classes['classes'][0]['coteachers'] = [self.second_student_email]; eagle._save_classes(classes)
        co = self.client.get(query + f'&studentEmail={self.student_email}', headers={"X-Teacher-Token": self.second_student_token})
        self.assertEqual(co.status_code, 200); co.close()
        classes = eagle._load_classes(); classes['classes'][0]['coteachers'] = []; eagle._save_classes(classes)
        self.assertEqual(self.client.get(query + f'&studentEmail={self.student_email}', headers={"X-Teacher-Token": self.second_student_token}).status_code, 403)
        classes = eagle._load_classes(); classes['classes'][0]['students'].remove(self.student_email); eagle._save_classes(classes)
        self.assertEqual(self.client.get(query + f'&studentEmail={self.student_email}', headers={"X-Teacher-Token": self.teacher_token}).status_code, 403)

    def test_photo_upload_rejects_over_quota_unsupported_content_and_traversal(self):
        with mock.patch.object(eagle, 'USER_STORAGE_LIMIT_MB', 0):
            self.assertEqual(self._photo_upload().status_code, 413)
        self.assertFalse(list(eagle.USER_FILES_DIR.rglob('*.jpg')))
        bad = self.client.post('/api/notebook/images', headers={"X-User-Token": self.student_token}, data={"classId": self.class_id, "image": (io.BytesIO(b'<svg onload="alert(1)"/>'), 'x.svg')})
        self.assertEqual(bad.status_code, 422)
        for path in ['images/../../users.json', '../board.jpg', 'Trash/board.jpg', 'images/nested/board.jpg']:
            response = self.client.get('/api/notebook/images', query_string={"classId": self.class_id, "path": path}, headers={"X-User-Token": self.student_token})
            self.assertEqual(response.status_code, 404)

    def test_shared_notebook_tabs_copy_photos_into_the_recipients_workspace(self):
        photo = self._photo_upload().get_json()
        notebook = eagle._load_student_notebook(self.student_email, self.class_id)
        notebook['tabs'][0]['html'] = f'<figure data-notebook-image="{photo["path"]}"><img alt="Board notes"></figure>'
        eagle._save_student_notebook(self.student_email, self.class_id, notebook)
        ok, error, tab = eagle._copy_notebook_tab_to_user(self.student_email, self.second_student_email, self.class_id, notebook['tabs'][0]['id'], 'Student')
        self.assertTrue(ok, error)
        self.assertIn(photo['path'], tab['html'])
        original = eagle._get_user_dir(self.student_email) / photo['path']
        copied = eagle._get_user_dir(self.second_student_email) / photo['path']
        self.assertEqual(copied.read_bytes(), original.read_bytes())
        self.assertGreater(eagle._get_user_storage_used(copied.parent.parent), 0)

    def test_concurrent_photos_cannot_bypass_the_storage_limit(self):
        from PIL import Image
        from notebook_media import photo_bytes
        from concurrent.futures import ThreadPoolExecutor
        output = io.BytesIO(); Image.new('RGB', (100, 60), 'navy').save(output, format='JPEG')
        raw = output.getvalue(); encoded, _, _ = photo_bytes(raw)
        def upload():
            with eagle.app.test_client() as client:
                return client.post('/api/notebook/images', headers={"X-User-Token": self.student_token}, data={"classId": self.class_id, "image": (io.BytesIO(raw), 'board.jpg')}).status_code
        with mock.patch.object(eagle, 'USER_STORAGE_LIMIT_MB', len(encoded) * 1.5 / (1024 * 1024)), ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: upload(), range(2)))
        self.assertEqual(sorted(results), [200, 413])
        self.assertEqual(eagle._get_user_storage_used(eagle._get_user_dir(self.student_email)), len(encoded))

    def test_photo_orientation_is_applied_and_camera_metadata_is_removed(self):
        from PIL import Image
        from notebook_media import photo_bytes
        for mode, format in [('RGB', 'JPEG'), ('RGBA', 'PNG')]:
            image = Image.new(mode, (4, 2), 'navy')
            exif = Image.Exif(); exif[274] = 6; exif[315] = 'Private camera owner'
            output = io.BytesIO(); image.save(output, format=format, exif=exif)
            encoded, _, dimensions = photo_bytes(output.getvalue())
            self.assertEqual(dimensions, (2, 4))
            with Image.open(io.BytesIO(encoded)) as stored:
                self.assertFalse(stored.getexif())

    def test_photo_size_limit_applies_to_the_saved_encoding(self):
        from PIL import Image
        output = io.BytesIO(); Image.new('RGB', (4, 2), 'navy').save(output, format='PNG'); output.seek(0)
        with mock.patch.object(eagle, 'MAX_UPLOAD_FILE_BYTES', 512):
            response = self.client.post('/api/notebook/images', headers={"X-User-Token": self.student_token}, data={"classId": self.class_id, "image": (output, 'board.png')})
        self.assertEqual(response.status_code, 413)
        self.assertIn('resized photo', response.get_json()['error'])


if __name__ == "__main__":
    unittest.main()
