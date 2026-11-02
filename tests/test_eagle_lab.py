import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from flask import Flask

from eagle_lab_features import register
from eagle_lab_store import EagleLabDataError, EagleLabStore
from lab_reports import LabReportDraftStore, _clean_responses


class EagleLabStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.store = EagleLabStore(self.root / "lab")

    def tearDown(self):
        self.temp.cleanup()

    def test_credentials_are_encrypted_and_rfc1918_addresses_are_required(self):
        server = self.store.save_server({
            "hostname": "PVE 01", "ip": "192.168.10.20", "port": 8006,
            "username": "student@pve", "password": "not-plaintext",
            "allow_self_signed": True,
        })
        raw = (self.root / "lab" / "catalog.json").read_text(encoding="utf-8")
        self.assertNotIn("not-plaintext", raw)
        self.assertEqual(self.store.get_server(server["id"], credentials=True)["password"], "not-plaintext")
        for address in ("127.0.0.1", "169.254.1.2", "8.8.8.8", "192.0.0.1", "::1"):
            with self.subTest(address=address), self.assertRaises(EagleLabDataError):
                self.store.save_server({"hostname": "bad", "ip": address, "password": "x"})

    def test_class_rules_are_additive_and_server_deletion_prunes_them(self):
        first = self.store.save_server({"hostname": "One", "ip": "10.0.0.2", "password": "one"})
        second = self.store.save_server({"hostname": "Two", "ip": "172.16.0.2", "password": "two"})
        self.store.set_class_rule("class-a", {
            "enabled": True, "show_credentials": False,
            "server_ids": [first["id"], second["id"]],
        })
        self.store.delete_server(first["id"])
        self.assertEqual(self.store.class_rule("class-a")["server_ids"], [second["id"]])
        self.assertEqual([item["id"] for item in self.store.servers_for_class("class-a")], [second["id"]])


class EagleLabRouteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.config = {"eagle_lab_enabled": False}
        self.teacher = {"email": "teacher@example.com"}
        self.student = {"email": "student@example.com", "class_ids": ["class-a"]}
        self.classroom = {"id": "class-a", "name": "Networking", "teacher_email": "teacher@example.com"}
        app = Flask(__name__)

        def token(req, header, record):
            return record if req.headers.get(header) == "valid" else None

        self.store = register(
            app,
            base_dir=Path(self.temp.name) / "lab",
            require_admin=lambda req: req.headers.get("X-Admin-Token") == "valid",
            require_teacher=lambda req: token(req, "X-Teacher-Token", self.teacher),
            require_user=lambda req: token(req, "X-User-Token", self.student),
            find_user=lambda email: self.student if email == self.student["email"] else None,
            get_user_class_ids=lambda user: user.get("class_ids", []) if user else [],
            find_class=lambda class_id: self.classroom if class_id == "class-a" else None,
            config_provider=lambda: self.config,
        )
        self.client = app.test_client()
        self.admin_headers = {"X-Admin-Token": "valid"}
        self.teacher_headers = {"X-Teacher-Token": "valid"}
        self.student_headers = {"X-User-Token": "valid"}

    def tearDown(self):
        self.temp.cleanup()

    @patch("eagle_lab_features._probe", return_value={"status": "up", "http_status": 200, "latency_ms": 2, "status_reason": "ready"})
    def test_global_and_class_rules_gate_students_and_credentials(self, _probe):
        created = self.client.post("/api/eagle-lab/admin/servers", headers=self.admin_headers, json={
            "hostname": "PVE Lab", "ip": "192.168.50.10", "port": 8006,
            "username": "lab@pve", "password": "secret", "allow_self_signed": True,
        })
        self.assertEqual(created.status_code, 201)
        server_id = created.get_json()["data"]["id"]

        disabled = self.client.get("/api/eagle-lab/bootstrap?class_id=class-a", headers=self.student_headers)
        self.assertEqual(disabled.status_code, 403)
        preview = self.client.get("/api/eagle-lab/bootstrap", headers=self.admin_headers)
        self.assertTrue(preview.get_json()["data"]["admin_preview"])

        self.config["eagle_lab_enabled"] = True
        saved = self.client.put("/api/eagle-lab/teacher/classes/class-a", headers=self.teacher_headers, json={
            "enabled": True, "show_credentials": False, "server_ids": [server_id],
        })
        self.assertEqual(saved.status_code, 200)
        bootstrap = self.client.get("/api/eagle-lab/bootstrap?class_id=class-a", headers=self.student_headers)
        payload = bootstrap.get_json()["data"]
        self.assertEqual([item["id"] for item in payload["servers"]], [server_id])
        self.assertNotIn("password", payload["servers"][0])
        hidden = self.client.get(
            f"/api/eagle-lab/servers/{server_id}/credentials?class_id=class-a",
            headers=self.student_headers,
        )
        self.assertEqual(hidden.status_code, 403)

        self.client.put("/api/eagle-lab/teacher/classes/class-a", headers=self.teacher_headers, json={
            "enabled": True, "show_credentials": True, "server_ids": [server_id],
        })
        revealed = self.client.get(
            f"/api/eagle-lab/servers/{server_id}/credentials?class_id=class-a",
            headers=self.student_headers,
        )
        self.assertEqual(revealed.get_json()["data"]["password"], "secret")

    def test_only_the_class_owner_can_change_rules(self):
        self.teacher["email"] = "other@example.com"
        response = self.client.put("/api/eagle-lab/teacher/classes/class-a", headers=self.teacher_headers, json={
            "enabled": True, "show_credentials": False, "server_ids": [],
        })
        self.assertEqual(response.status_code, 403)


class LabReportDraftTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = LabReportDraftStore(Path(self.temp.name) / "drafts")
        self.assignment_id = "a" * 32

    def tearDown(self):
        self.temp.cleanup()

    def test_drafts_are_account_isolated_atomic_and_revision_checked(self):
        saved = self.store.save(self.assignment_id, "one@example.com", [
            {"questionId": "q1", "answer": "draft", "questionType": "written"}
        ], 0)
        self.assertEqual(saved["revision"], 1)
        self.assertEqual(self.store.get(self.assignment_id, "two@example.com")["revision"], 0)
        with self.assertRaisesRegex(ValueError, "another session") as caught:
            self.store.save(self.assignment_id, "one@example.com", [], 0)
        self.assertEqual(caught.exception.current["revision"], 1)
        self.store.delete(self.assignment_id, "one@example.com")
        self.assertEqual(self.store.get(self.assignment_id, "one@example.com")["revision"], 0)

    def test_lab_response_schema_accepts_all_supported_controls(self):
        assignment = {"quiz": {"questions": [
            {"id": "written", "type": "written"},
            {"id": "blank", "type": "fill_blank"},
            {"id": "steps", "type": "procedure", "steps": ["One", "Two"]},
        ]}}
        cleaned = _clean_responses(assignment, [
            {"questionId": "written", "answer": "Observation"},
            {"questionId": "blank", "answer": "42"},
            {"questionId": "steps", "answer": [True, False]},
        ])
        self.assertEqual([item["questionType"] for item in cleaned], ["written", "fill_blank", "procedure"])
        with self.assertRaises(ValueError):
            _clean_responses(assignment, [{"questionId": "steps", "answer": [True]}])


if __name__ == "__main__":
    unittest.main()
