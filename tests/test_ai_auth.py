"""AI admission, legacy accounts and non-destructive auth failure diagnostics."""
import hashlib
import json
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from security_controls import AttemptLimiter
from tests import test_security_followup as session_fixture
from tests.test_html_runtime import eagle


class AiAuthTests(unittest.TestCase):
    def setUp(self):
        session_fixture.SecurityFollowupTests.setUp(self)
        for name, value in (("APP_LOG_FILE", self.root / "server.log"),
                            ("_auth_rejection_log_limits", AttemptLimiter(1, 60)),
                            ("_ai_request_limits", AttemptLimiter(50, 60)), ("_ASSISTANT_LAST", {})):
            context = patch.object(eagle, name, value)
            context.start(); self.addCleanup(context.stop)
        eagle._save_config({**eagle.DEFAULT_CONFIG, "ai_explainer_enabled": True})
        self.payload = {"code": "print(1)", "classId": "fixture", "messages": [{"role": "user", "content": "Explain this code"}]}

    def headers(self, role):
        record = next((r for r in self.records if r["role"] == role), {})
        token = eagle._issue_access_token(role, record)
        header = {"student": "X-User-Token", "teacher": "X-Teacher-Token",
                  "wiki_manager": "X-Wiki-Manager-Token", "admin": "X-Admin-Token"}[role]
        return {header: token}, token

    def test_both_routes_accept_every_authenticated_role(self):
        with patch.object(eagle, "call_ollama_generate", return_value={"ok": True, "text": "Fixture response"}) as model:
            for role in ("student", "teacher", "wiki_manager", "admin"):
                with self.subTest(role=role):
                    headers, _ = self.headers(role)
                    for route, field in (("/api/explain", "text"), ("/api/assistant/chat", "reply")):
                        response = self.client.post(route, headers=headers, json=self.payload)
                        self.assertEqual(response.status_code, 200, response.json)
                        self.assertEqual(response.json[field], "Fixture response")
            self.assertEqual(model.call_count, 8)

    def test_actual_legacy_json_records_reach_ai_without_profile_migration(self):
        for role in ("student", "teacher", "wiki_manager"):
            with self.subTest(role=role):
                record = next(r for r in self.records if r["role"] == role)
                # Bypass _save_users: production legacy JSON has no first/last
                # names, enabled field, student ID or plural class_ids field.
                legacy = {"email": record["email"], "name": "Legacy fixture", "class_id": "fixture"}
                if role != "student": legacy["role"] = " " + role.upper() + " "
                original = json.dumps({"users": [legacy]})
                eagle.USERS_FILE.write_text(original)
                eagle._users_cache = None
                headers, _ = self.headers(role)
                with patch.object(eagle, "call_ollama_generate", return_value={"ok": True, "text": "Legacy response"}) as model:
                    for route in ("/api/explain", "/api/assistant/chat"):
                        response = self.client.post(route, headers=headers, json=self.payload)
                        self.assertEqual(response.status_code, 200, response.json)
                    self.assertEqual(model.call_count, 2)
                self.assertEqual(eagle.USERS_FILE.read_text(), original)

    def test_sid_and_body_identity_cannot_replace_an_auth_header(self):
        headers, token = self.headers("student")
        with patch.object(eagle, "call_ollama_generate") as model:
            for route in ("/api/explain", "/api/assistant/chat"):
                response = self.client.post(route, headers={"X-SID": "public-socket-id"},
                    json={**self.payload, "user_token": token, "email": self.records[0]["email"], "role": "student"})
                self.assertEqual(response.status_code, 403)
                self.assertEqual(response.json["error"], "Sign in to use AI features")
            model.assert_not_called()
        self.assertIn(token, eagle._student_tokens)
        self.assertIn('"reason":"missing_auth_header"', eagle.APP_LOG_FILE.read_text())

    def test_coteacher_ai_still_obeys_student_class_policy(self):
        headers, _ = self.headers("student")
        classes = eagle._load_classes()
        classes["classes"][0]["settings"] = {"ai_enabled": False}
        eagle._save_classes(classes)
        with patch.object(eagle, "call_ollama_generate") as model:
            for route in ("/api/explain", "/api/assistant/chat"):
                response = self.client.post(route, headers=headers, json=self.payload)
                self.assertEqual(response.status_code, 403)
                self.assertIn("disabled for your class", response.json["error"])
            model.assert_not_called()

    def test_known_rejections_are_logged_before_revocation_without_record_contents(self):
        for invalid, reason in (("missing", "account_missing"), ("disabled", "account_disabled"), ("role", "role_mismatch")):
            with self.subTest(invalid=invalid):
                eagle._save_users({"users": self.records})
                headers, token = self.headers("student")
                current = {**self.records[0], "name": "private fixture name", "password": "private fixture credential"}
                if invalid == "disabled": current["enabled"] = False
                if invalid == "role": current["role"] = "teacher"
                eagle._save_users({"users": [] if invalid == "missing" else [current]})
                events = []
                with patch.object(eagle, "_append_server_log", side_effect=lambda text, level: events.append(text)), \
                     patch.object(eagle, "_revoke_socket_sessions", side_effect=lambda **kw: events.append("revoke")):
                    response = self.client.post("/api/explain", headers=headers, json=self.payload)
                self.assertEqual(response.status_code, 403)
                self.assertNotIn(token, eagle._student_tokens)
                self.assertIn('"reason":"' + reason + '"', events[0])
                self.assertEqual(events[1], "revoke")
                message = events[0]
                self.assertIn(hashlib.sha256(self.records[0]["email"].encode()).hexdigest()[:12], message)
                for private in (self.records[0]["email"], token, current["name"], current["password"]):
                    self.assertNotIn(private, message)
                if invalid != "missing":
                    self.assertIn('"enabled_type":"bool"', message)
                    self.assertIn('"class_ids_type":"list"', message)

    def test_unavailable_store_returns_retryable_error_without_revoking_and_recovers(self):
        for failure in ("missing", "invalid_json", "invalid_structure", "invalid_records", "unreadable"):
            with self.subTest(failure=failure):
                eagle._save_users({"users": self.records})
                headers, token = self.headers("student")
                if failure == "missing": eagle.USERS_FILE.unlink()
                if failure == "invalid_json": eagle.USERS_FILE.write_text('{"users":[')
                if failure == "invalid_structure": eagle.USERS_FILE.write_text('{"users":{}}')
                if failure == "invalid_records": eagle.USERS_FILE.write_text(json.dumps({"users": [{**self.records[0], "class_ids": 42}]}))
                eagle._users_cache = None
                original_read = Path.read_text
                def read(path, *args, **kwargs):
                    if failure == "unreadable" and path == eagle.USERS_FILE:
                        raise PermissionError("private fixture path and credentials")
                    return original_read(path, *args, **kwargs)
                with patch.object(Path, "read_text", read), patch.object(eagle, "_revoke_socket_sessions") as revoke, \
                     patch.object(eagle, "call_ollama_generate") as model:
                    response = self.client.post("/api/explain", headers=headers, json=self.payload)
                    restored = self.client.get("/api/auth/me", headers=headers)
                    for result in (response, restored):
                        self.assertEqual(result.status_code, 503)
                        self.assertEqual(result.json["code"], "account_store_unavailable")
                        self.assertEqual(result.headers["Retry-After"], "5")
                    self.assertIn(token, eagle._student_tokens)
                    revoke.assert_not_called()
                    model.assert_not_called()
                log = eagle.APP_LOG_FILE.read_text()
                self.assertIn('"reason":"account_store_' + failure + '"', log)
                self.assertNotIn("private fixture path and credentials", log)
                self.assertNotIn(token, log)
                eagle._save_users({"users": self.records})
                with patch.object(eagle, "call_ollama_generate", return_value={"ok": True, "text": "Recovered response"}):
                    response = self.client.post("/api/explain", headers=headers, json=self.payload)
                    self.assertEqual(response.status_code, 200, response.json)

    def test_invalid_permissive_read_cannot_cache_away_the_strict_failure(self):
        headers, token = self.headers("student")
        eagle.USERS_FILE.write_text('{"users":["invalid-record"]}')
        eagle._users_cache = None
        self.assertEqual(eagle._load_users(), {"users": []})
        response = self.client.get("/api/auth/me", headers=headers)
        self.assertEqual(response.status_code, 503)
        self.assertIn(token, eagle._student_tokens)

    def test_repeated_rejection_diagnostics_are_bounded(self):
        headers, _ = self.headers("student")
        eagle.USERS_FILE.write_text("not JSON")
        eagle._users_cache = None
        for _ in range(4): self.assertEqual(self.client.get("/api/auth/me", headers=headers).status_code, 503)
        self.assertEqual(eagle.APP_LOG_FILE.read_text().count('"reason":"account_store_invalid_json"'), 1)

    def test_expired_session_log_identifies_account_without_preserving_the_token(self):
        headers, token = self.headers("student")
        now = time.monotonic()
        eagle._student_tokens.times[token] = (now - eagle._student_tokens.absolute - 1, now)
        with patch.object(eagle, "_revoke_socket_sessions") as revoke:
            self.assertEqual(self.client.post("/api/explain", headers=headers, json=self.payload).status_code, 403)
            revoke.assert_called_once_with(tokens={token})
        log = eagle.APP_LOG_FILE.read_text()
        self.assertIn('"reason":"session_expired"', log)
        self.assertIn(hashlib.sha256(self.records[0]["email"].encode()).hexdigest()[:12], log)
        self.assertNotIn(token, log)
        self.assertNotIn(token, eagle._student_tokens)
