import json
import shutil
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from flask import Flask
import requests
from werkzeug.serving import make_server

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

    def test_order_is_persistent_filters_class_grants_and_preserves_credentials_and_revisions(self):
        first = self.store.save_server({"hostname": "One", "ip": "10.0.0.2", "password": "one", "pin": "1234"})
        second = self.store.save_server({"hostname": "Two", "ip": "10.0.0.3", "password": "two"})
        third = self.store.save_server({"hostname": "Three", "ip": "10.0.0.4", "password": "three"})
        self.store.set_class_rule("class-a", {"enabled": True, "server_ids": [first["id"], third["id"]]})
        before = json.loads(self.store.catalog_path.read_text(encoding="utf-8"))
        desired = [third["id"], second["id"], first["id"]]
        self.store.reorder_servers(desired)
        reopened = EagleLabStore(self.root / "lab")
        self.assertEqual([item["id"] for item in reopened.list_servers()], desired)
        self.assertEqual([item["id"] for item in reopened.servers_for_class("class-a")], [third["id"], first["id"]])
        after = json.loads(self.store.catalog_path.read_text(encoding="utf-8"))
        self.assertEqual({item["id"]: item for item in before["servers"]}, {item["id"]: item for item in after["servers"]})
        self.assertEqual(before["class_rules"], after["class_rules"])
        self.assertTrue(reopened.verify_pin(first["id"], "1234"))
        for invalid in (None, [first["id"]], [first["id"]]*3, desired + ["missing"], [{"id": "bad"}]):
            with self.subTest(order=invalid), self.assertRaises(EagleLabDataError):
                reopened.reorder_servers(invalid)
            self.assertEqual([item["id"] for item in reopened.list_servers()], desired)


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
            gateway_settings={"EAGLEIDE_LAB_PROXY_DOMAIN": "pve.school.test", "EAGLEIDE_PUBLIC_ORIGIN": "https://ide.school.test"},
        )
        self.gateway = app.extensions["eagle_lab_gateway"]
        self.client = app.test_client()
        self.admin_headers = {"X-Admin-Token": "valid"}
        self.teacher_headers = {"X-Teacher-Token": "valid"}
        self.student_headers = {"X-User-Token": "valid"}

    def tearDown(self):
        self.temp.cleanup()

    @patch("eagle_lab_features._probe", return_value={"status": "up"})
    def test_only_admin_can_reorder_and_students_receive_catalog_order(self, _probe):
        first = self.store.save_server({"hostname": "One", "ip": "10.0.0.2", "password": "one"})
        second = self.store.save_server({"hostname": "Two", "ip": "10.0.0.3", "password": "two"})
        order = [second["id"], first["id"]]
        route = "/api/eagle-lab/admin/server-order"
        for headers in ({}, self.student_headers, self.teacher_headers):
            self.assertEqual(self.client.put(route, headers=headers, json={"server_ids": order}).status_code, 401)
        self.assertEqual(self.client.put(route, headers=self.admin_headers, json={"server_ids": [first["id"]]}).status_code, 409)
        self.assertEqual(self.client.put(route, headers=self.admin_headers, json={"server_ids": order*2}).status_code, 400)
        saved = self.client.put(route, headers=self.admin_headers, json={"server_ids": order})
        self.assertEqual(saved.status_code, 200)
        self.config["eagle_lab_enabled"] = True
        self.store.set_class_rule("class-a", {"enabled": True, "server_ids": list(reversed(order))})
        result = self.client.get("/api/eagle-lab/bootstrap?class_id=class-a", headers=self.student_headers).get_json()["data"]
        self.assertEqual([item["id"] for item in result["servers"]], order)

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
        self.assertNotIn("username", payload["servers"][0])
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

    def pin_server(self):
        self.config["eagle_lab_enabled"] = True
        server = self.store.save_server({"hostname": "Private node", "ip": "10.0.0.50", "password": "pve-secret", "pin": "123456"})
        self.store.set_class_rule("class-a", {"enabled": True, "show_credentials": True, "server_ids": [server["id"]]})
        return server

    def test_pin_is_hashed_required_for_credentials_and_launch_and_is_rate_limited(self):
        server = self.pin_server()
        self.assertNotIn("123456", self.store.catalog_path.read_text())
        credentials = f"/api/eagle-lab/servers/{server['id']}/credentials?class_id=class-a"
        self.assertEqual(self.client.get(credentials, headers=self.student_headers).status_code, 403)
        path = f"/api/eagle-lab/servers/{server['id']}/launch"
        wrong = self.client.post(path, headers=self.student_headers, json={"class_id": "class-a", "pin": "000000"})
        self.assertEqual(wrong.status_code, 403)
        launch = self.client.post(path, headers=self.student_headers, json={"class_id": "class-a", "pin": "123456"})
        self.assertEqual(launch.status_code, 200)
        self.assertTrue(launch.get_json()["data"]["url"].startswith("https://s-"))
        self.assertEqual(self.client.get(credentials, headers=self.student_headers).get_json()["data"]["password"], "pve-secret")
        for _ in range(8):
            self.client.post(path, headers=self.student_headers, json={"class_id": "class-a", "pin": "000000"})
        # A new account cannot use another student's unlock.
        self.student["email"] = "another@example.com"
        for _ in range(8):
            self.client.post(path, headers=self.student_headers, json={"class_id": "class-a", "pin": "000000"})
        self.assertEqual(self.client.post(path, headers=self.student_headers, json={"class_id": "class-a", "pin": "123456"}).status_code, 429)

    def test_one_time_gateway_ticket_and_pin_edits_revoke_existing_connections(self):
        server = self.pin_server()
        launched = self.client.post(f"/api/eagle-lab/servers/{server['id']}/launch", headers=self.student_headers,
                                    json={"class_id": "class-a", "pin": "123456"}).get_json()["data"]
        endpoint = "/api/eagle-lab/gateway/authorize"
        trusted = {"X-Lab-Gateway-Key": self.gateway.secret}
        body = {"server_id": server["id"], "ticket": launched["ticket"]}
        self.assertEqual(self.client.post(endpoint, json=body).status_code, 403)
        exchange = self.client.post(endpoint, headers=trusted, json=body)
        self.assertEqual(exchange.status_code, 200)
        session = exchange.get_json()["data"]["session"]
        self.assertNotIn("password", exchange.get_data(as_text=True))
        self.assertEqual(self.client.post(endpoint, headers=trusted, json=body).status_code, 403)
        session_body = {"server_id": server["id"], "session": session}
        self.assertEqual(self.client.post(endpoint, headers=trusted, json=session_body).status_code, 200)
        self.store.save_server({**server, "pin": "654321"}, server["id"])
        self.assertEqual(self.client.post(endpoint, headers=trusted, json=session_body).status_code, 403)
        self.assertFalse(self.store.verify_pin(server["id"], "123456"))
        self.assertTrue(self.store.verify_pin(server["id"], "654321"))

    def test_class_revocation_and_disconnect_revoke_gateway_sessions(self):
        server = self.pin_server()
        endpoint = "/api/eagle-lab/gateway/authorize"
        trusted = {"X-Lab-Gateway-Key": self.gateway.secret}
        def launch():
            ticket = self.client.post(f"/api/eagle-lab/servers/{server['id']}/launch", headers=self.student_headers,
                                      json={"class_id": "class-a", "pin": "123456"}).get_json()["data"]["ticket"]
            return self.client.post(endpoint, headers=trusted, json={"server_id": server["id"], "ticket": ticket}).get_json()["data"]["session"]
        session = launch()
        self.client.post(f"/api/eagle-lab/servers/{server['id']}/disconnect", headers=self.student_headers)
        self.assertEqual(self.client.post(endpoint, headers=trusted, json={"server_id": server["id"], "session": session}).status_code, 403)
        session = launch()
        self.store.set_class_rule("class-a", {"enabled": False, "server_ids": [], "show_credentials": False})
        self.assertEqual(self.client.post(endpoint, headers=trusted, json={"server_id": server["id"], "session": session}).status_code, 403)

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for the gateway lifecycle check")
    def test_real_node_process_exchanges_ticket_with_flask_and_rejects_revoked_session(self):
        server = self.pin_server()
        http_server = make_server("127.0.0.1", 0, self.client.application, threaded=True)
        thread = threading.Thread(target=http_server.serve_forever, daemon=True)
        thread.start()
        with socket.socket() as reserved:
            reserved.bind(("127.0.0.1", 0))
            self.gateway.port = reserved.getsockname()[1]
        try:
            self.gateway.start(port=http_server.server_port)
            deadline = time.monotonic() + 5
            while True:
                try:
                    with socket.create_connection(("127.0.0.1", self.gateway.port), timeout=.2):
                        break
                except OSError:
                    if time.monotonic() > deadline or self.gateway.process.poll() is not None:
                        self.fail("The embedded gateway did not start")
                    time.sleep(.025)
            launched = self.client.post(f"/api/eagle-lab/servers/{server['id']}/launch", headers=self.student_headers,
                                        json={"class_id": "class-a", "pin": "123456"}).get_json()["data"]
            with requests.Session() as client:
                client.trust_env = False
                address = f"http://127.0.0.1:{self.gateway.port}"
                host = f"s-{server['id']}.pve.school.test"
                response = client.post(address + "/_eagle/launch", data={"ticket": launched["ticket"]},
                                       headers={"Host": host, "Origin": "https://ide.school.test"}, allow_redirects=False, timeout=5)
                self.assertEqual(response.status_code, 303, response.text)
                cookie = response.cookies.get("__Host-EagleLab")
                self.assertTrue(cookie)
                self.assertEqual(len(self.gateway.sessions), 1)
                self.store.save_server({**server, "pin": "654321"}, server["id"])
                denied = client.get(address + "/", headers={"Host": host, "Cookie": f"__Host-EagleLab={cookie}"}, timeout=5)
                self.assertEqual(denied.status_code, 403)
                self.assertEqual(len(self.gateway.sessions), 0)
        finally:
            self.gateway.close()
            http_server.shutdown()
            http_server.server_close()
            thread.join(timeout=2)


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
