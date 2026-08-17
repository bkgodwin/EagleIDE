import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch

from flask import Flask

from lesson_plan_features import fetch_external_link_metadata, register
from lesson_plan_store import (
    LessonPlanConflictError,
    LessonPlanDataError,
    LessonPlanStore,
    normalize_week_start,
)


class FakeWikiStore:
    def __init__(self):
        self.nodes = {
            "a" * 32: {
                "id": "a" * 32,
                "kind": "page",
                "title": "Loops",
                "slug": "loops",
                "description": "Looping concepts",
                "standards": [
                    {"id": "s1", "standard_id": "CS.1", "description": "Use iteration"},
                    {"id": "s2", "standard_id": "CS.2", "description": "Trace programs"},
                ],
            },
            "b" * 32: {
                "id": "b" * 32,
                "kind": "page",
                "title": "More Loops",
                "slug": "more-loops",
                "description": "Loop practice",
                "standards": [
                    {"id": "s1", "standard_id": "CS.1", "description": "Use iteration"},
                ],
            },
        }

    def get_node(self, identifier, **_kwargs):
        return self.nodes.get(identifier)


def plan_payload(*node_ids):
    return {
        "days": {
            "monday": {"markdown": "- Introduce loops", "wiki_node_ids": list(node_ids)},
            "tuesday": {"markdown": "Practice", "wiki_node_ids": []},
        },
        "notes_markdown": "Bring headphones.",
    }


class LessonPlanStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = LessonPlanStore(Path(self.temp.name))

    def tearDown(self):
        self.temp.cleanup()

    def test_week_dates_are_normalized_to_monday(self):
        self.assertEqual(normalize_week_start("2026-08-06"), "2026-08-03")

    def test_save_is_versioned_and_conflicts_are_rejected(self):
        first = self.store.save_plan("class-1", "2026-08-03", plan_payload(), expected_version=0)
        self.assertEqual(first["version"], 1)
        with self.assertRaises(LessonPlanConflictError):
            self.store.save_plan("class-1", "2026-08-03", plan_payload(), expected_version=0)

    def test_invalid_wiki_ids_and_oversized_markdown_are_rejected(self):
        with self.assertRaises(LessonPlanDataError):
            self.store.save_plan("class-1", "2026-08-03", plan_payload("not-an-id"))
        payload = plan_payload()
        payload["days"]["monday"]["markdown"] = "x" * 20_001
        with self.assertRaises(LessonPlanDataError):
            self.store.save_plan("class-1", "2026-08-03", payload)

    def test_public_tokens_can_be_reset_and_deleted(self):
        first = self.store.ensure_public_token("class-1")
        self.assertEqual(self.store.class_id_for_token(first), "class-1")
        second = self.store.reset_public_token("class-1")
        self.assertNotEqual(first, second)
        self.assertIsNone(self.store.class_id_for_token(first))
        self.assertEqual(self.store.class_id_for_token(second), "class-1")
        self.store.delete_class("class-1")
        self.assertIsNone(self.store.class_id_for_token(second))

    def test_external_links_are_validated_deduplicated_and_limited(self):
        payload = plan_payload()
        payload["days"]["monday"]["external_links"] = [
            {"url": "https://example.org/loops", "title": "Loops Reference"},
            {"url": "https://example.org/loops", "title": "Duplicate"},
        ]
        saved = self.store.save_plan("class-1", "2026-08-03", payload)
        self.assertEqual(
            saved["days"]["monday"]["external_links"],
            [{"url": "https://example.org/loops", "title": "Loops Reference"}],
        )
        payload["days"]["monday"]["external_links"] = [
            {"url": "javascript:alert(1)", "title": "Unsafe"}
        ]
        with self.assertRaises(LessonPlanDataError):
            self.store.save_plan("class-1", "2026-08-10", payload)

    def test_plan_sources_resolve_reject_cycles_and_clear_on_delete(self):
        self.store.set_plan_source("class-2", "class-1")
        self.store.set_plan_source("class-3", "class-2")
        self.assertEqual(self.store.resolve_plan_source("class-3"), "class-1")
        with self.assertRaises(LessonPlanDataError):
            self.store.set_plan_source("class-1", "class-3")
        self.store.delete_class("class-1")
        self.assertEqual(self.store.resolve_plan_source("class-2"), "class-2")

    def test_link_preview_rejects_private_networks_before_fetch(self):
        with self.assertRaises(LessonPlanDataError):
            fetch_external_link_metadata("http://127.0.0.1/private")


class LessonPlanRouteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = Flask(__name__)
        self.classes = {
            "class-1": {"id": "class-1", "name": "Computer Science", "teacher_email": "teacher@example.com"},
            "class-2": {"id": "class-2", "name": "Other Class", "teacher_email": "other@example.com"},
            "class-3": {"id": "class-3", "name": "Computer Science - Section 2", "teacher_email": "teacher@example.com"},
        }
        self.users = {
            "student@example.com": {"email": "student@example.com", "role": "student", "class_ids": ["class-1"]},
        }
        self.store = register(
            self.app,
            base_dir=Path(self.temp.name) / "plans",
            public_dir=Path(__file__).resolve().parents[1],
            wiki_store=FakeWikiStore(),
            require_teacher=lambda req: {"email": "teacher@example.com"} if req.headers.get("X-Teacher-Token") == "teacher-token" else None,
            require_user=lambda req: self.users["student@example.com"] if req.headers.get("X-User-Token") == "student-token" else None,
            find_user=lambda email: self.users.get(email),
            get_user_class_ids=lambda user: list((user or {}).get("class_ids") or []),
            find_class=lambda class_id: self.classes.get(class_id),
        )
        self.client = self.app.test_client()
        self.teacher_headers = {"X-Teacher-Token": "teacher-token"}
        self.student_headers = {"X-User-Token": "student-token"}
        self.current_week = normalize_week_start()

    def tearDown(self):
        self.temp.cleanup()

    def publish(self, week=None):
        selected = week or self.current_week
        return self.client.put(
            f"/api/teacher/classes/class-1/lesson-plans/{selected}",
            json={"expected_version": 0, **plan_payload("a" * 32, "b" * 32)},
            headers=self.teacher_headers,
        )

    def test_teacher_auth_ownership_and_empty_plan(self):
        self.assertEqual(self.client.get("/api/teacher/classes/class-1/lesson-plans").status_code, 401)
        self.assertEqual(self.client.get("/api/teacher/classes/class-2/lesson-plans", headers=self.teacher_headers).status_code, 404)
        response = self.client.get("/api/teacher/classes/class-1/lesson-plans?week=2026-08-06", headers=self.teacher_headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["plan"]["week_start"], "2026-08-03")
        self.assertEqual(response.json["plan"]["version"], 0)

    def test_publish_hydrates_pages_and_deduplicates_standards_per_day(self):
        response = self.publish()
        self.assertEqual(response.status_code, 200)
        monday = response.json["plan"]["days"]["monday"]
        self.assertEqual([page["title"] for page in monday["wiki_pages"]], ["Loops", "More Loops"])
        self.assertEqual([item["standard_id"] for item in monday["standards"]], ["CS.1", "CS.2"])
        self.assertNotIn("updated_by", response.json["plan"])

    def test_students_must_belong_to_class_and_cannot_view_future_weeks(self):
        self.publish()
        allowed = self.client.get(f"/api/classes/class-1/lesson-plans?week={self.current_week}", headers=self.student_headers)
        self.assertEqual(allowed.status_code, 200)
        denied = self.client.get("/api/classes/class-2/lesson-plans", headers=self.student_headers)
        self.assertEqual(denied.status_code, 404)
        future = (date.fromisoformat(self.current_week) + timedelta(days=7)).isoformat()
        hidden = self.client.get(f"/api/classes/class-1/lesson-plans?week={future}", headers=self.student_headers)
        self.assertEqual(hidden.status_code, 404)

    def test_public_link_is_unlisted_navigable_and_revocable(self):
        previous = (date.fromisoformat(self.current_week) - timedelta(days=7)).isoformat()
        older_published = (date.fromisoformat(self.current_week) - timedelta(days=14)).isoformat()
        self.publish(older_published)
        self.publish(self.current_week)
        shared = self.client.post("/api/teacher/classes/class-1/lesson-plans/sharing", headers=self.teacher_headers).json
        self.assertTrue(shared["public_path"].startswith("/lesson-plans/public/"))
        self.assertTrue(shared["current_path"].startswith("/lesson-plans/current/"))
        self.assertTrue(shared["embed_path"].startswith("/lesson-plans/embed/"))
        token = shared["public_url"].rsplit("/", 1)[-1]
        response = self.client.get(f"/api/lesson-plans/public/{token}?week={self.current_week}")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["previous_week"], previous)
        rolling = self.client.get(f"/api/lesson-plans/current/{token}?week={older_published}")
        self.assertEqual(rolling.status_code, 200)
        self.assertEqual(rolling.json["selected_week"], self.current_week)
        current_page = self.client.get(shared["current_path"])
        self.assertEqual(current_page.status_code, 200)
        current_page.close()
        empty_week = self.client.get(f"/api/lesson-plans/public/{token}?week={previous}")
        self.assertEqual(empty_week.status_code, 200)
        self.assertEqual(empty_week.json["plan"]["version"], 0)
        self.assertEqual(empty_week.json["next_week"], self.current_week)
        self.assertEqual(
            empty_week.json["previous_week"],
            (date.fromisoformat(previous) - timedelta(days=7)).isoformat(),
        )
        reset = self.client.post("/api/teacher/classes/class-1/lesson-plans/sharing/reset", headers=self.teacher_headers)
        self.assertEqual(reset.status_code, 200)
        self.assertEqual(self.client.get(f"/api/lesson-plans/public/{token}").status_code, 404)
        self.assertEqual(self.client.get(f"/api/lesson-plans/current/{token}").status_code, 404)

    def test_embed_code_escapes_class_name(self):
        self.classes["class-1"]["name"] = 'Programming "A" <Lab>'
        shared = self.client.post(
            "/api/teacher/classes/class-1/lesson-plans/sharing",
            headers=self.teacher_headers,
        ).json
        self.assertIn("Programming &quot;A&quot; &lt;Lab&gt; lesson plan", shared["embed_code"])
        self.assertNotIn('<Lab>', shared["embed_code"])

    def test_teacher_can_create_short_lived_print_export_for_future_week(self):
        future = (date.fromisoformat(self.current_week) + timedelta(days=7)).isoformat()
        self.assertEqual(self.publish(future).status_code, 200)
        endpoint = f"/api/teacher/classes/class-1/lesson-plans/{future}/print"
        self.assertEqual(self.client.post(endpoint).status_code, 401)
        export = self.client.post(endpoint, headers=self.teacher_headers)
        self.assertEqual(export.status_code, 200)
        self.assertEqual(export.json["expires_in_seconds"], 600)
        print_path = export.json["print_path"]
        self.assertTrue(print_path.startswith("/lesson-plans/print/"))
        token = print_path.rsplit("/", 1)[-1]
        data = self.client.get(f"/api/lesson-plans/print/{token}")
        self.assertEqual(data.status_code, 200)
        self.assertEqual(data.json["selected_week"], future)
        self.assertEqual(data.json["plan"]["version"], 1)
        self.assertIsNone(data.json["previous_week"])
        self.assertIsNone(data.json["next_week"])
        page = self.client.get(print_path)
        self.assertEqual(page.status_code, 200)
        page.close()

        shared = self.client.post(
            "/api/teacher/classes/class-1/lesson-plans/sharing",
            headers=self.teacher_headers,
        ).json
        public_token = shared["public_path"].rsplit("/", 1)[-1]
        self.assertEqual(
            self.client.get(f"/api/lesson-plans/public/{public_token}?week={future}").status_code,
            404,
        )

    def test_teacher_can_link_sections_to_one_canonical_plan(self):
        published = self.publish()
        self.assertEqual(published.status_code, 200)
        linked = self.client.put(
            "/api/teacher/classes/class-3/lesson-plans/source",
            json={"source_class_id": "class-1", "week": self.current_week},
            headers=self.teacher_headers,
        )
        self.assertEqual(linked.status_code, 200)
        self.assertEqual(linked.json["class"]["id"], "class-3")
        self.assertEqual(linked.json["plan_source"]["id"], "class-1")
        self.assertEqual(linked.json["plan"]["version"], 1)

        changed = plan_payload("a" * 32)
        changed["days"]["monday"]["markdown"] = "- Shared update"
        saved = self.client.put(
            f"/api/teacher/classes/class-3/lesson-plans/{self.current_week}",
            json={"expected_version": 1, **changed},
            headers=self.teacher_headers,
        )
        self.assertEqual(saved.status_code, 200)
        source = self.client.get(
            f"/api/teacher/classes/class-1/lesson-plans?week={self.current_week}",
            headers=self.teacher_headers,
        )
        self.assertEqual(source.json["plan"]["version"], 2)
        self.assertEqual(source.json["plan"]["days"]["monday"]["markdown"], "- Shared update")

        self.users["student@example.com"]["class_ids"].append("class-3")
        student = self.client.get(
            f"/api/classes/class-3/lesson-plans?week={self.current_week}",
            headers=self.student_headers,
        )
        self.assertEqual(student.status_code, 200)
        self.assertEqual(student.json["class"]["id"], "class-3")
        self.assertEqual(student.json["plan"]["days"]["monday"]["markdown"], "- Shared update")
        self.assertNotIn("plan_source", student.json)
        shared = self.client.post(
            "/api/teacher/classes/class-3/lesson-plans/sharing",
            headers=self.teacher_headers,
        ).json
        public_token = shared["public_path"].rsplit("/", 1)[-1]
        public = self.client.get(
            f"/api/lesson-plans/public/{public_token}?week={self.current_week}"
        )
        self.assertEqual(public.status_code, 200)
        self.assertEqual(public.json["class"]["id"], "class-3")
        self.assertEqual(public.json["plan"]["days"]["monday"]["markdown"], "- Shared update")
        self.assertNotIn("plan_source", public.json)

        denied = self.client.put(
            "/api/teacher/classes/class-3/lesson-plans/source",
            json={"source_class_id": "class-2"},
            headers=self.teacher_headers,
        )
        self.assertEqual(denied.status_code, 404)
        cycle = self.client.put(
            "/api/teacher/classes/class-1/lesson-plans/source",
            json={"source_class_id": "class-3"},
            headers=self.teacher_headers,
        )
        self.assertEqual(cycle.status_code, 400)

    def test_external_link_preview_and_storage(self):
        self.assertEqual(
            self.client.post(
                "/api/teacher/lesson-plans/link-preview",
                json={"url": "https://example.org/lesson"},
            ).status_code,
            401,
        )
        with patch(
            "lesson_plan_features.fetch_external_link_metadata",
            return_value={"url": "https://example.org/lesson", "title": "Example Lesson"},
        ):
            preview = self.client.post(
                "/api/teacher/lesson-plans/link-preview",
                json={"url": "https://example.org/lesson"},
                headers=self.teacher_headers,
            )
        self.assertEqual(preview.status_code, 200)
        self.assertEqual(preview.json["link"]["title"], "Example Lesson")
        payload = plan_payload()
        payload["days"]["monday"]["external_links"] = [preview.json["link"]]
        saved = self.client.put(
            f"/api/teacher/classes/class-1/lesson-plans/{self.current_week}",
            json={"expected_version": 0, **payload},
            headers=self.teacher_headers,
        )
        self.assertEqual(saved.status_code, 200)
        self.assertEqual(
            saved.json["plan"]["days"]["monday"]["external_links"][0]["title"],
            "Example Lesson",
        )


if __name__ == "__main__":
    unittest.main()
