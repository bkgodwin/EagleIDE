"""Wiki manager isolation and server-side classroom session revocation."""
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from tests.test_html_runtime import eagle


class WikiManagerAccountTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for name, value in {"USERS_FILE":self.root/"users.json", "CLASSES_FILE":self.root/"classes.json",
                            "USER_FILES_DIR":self.root/"files", "SIGN_IN_EVENTS_FILE":self.root/"signins.json"}.items():
            context = patch.object(eagle, name, value)
            context.start(); self.addCleanup(context.stop)
        self.client = eagle.app.test_client()
        self.admin = {"X-Admin-Token":"wiki-manager-test-admin"}
        eagle._admin_tokens.add(self.admin["X-Admin-Token"])
        self.addCleanup(eagle._admin_tokens.discard, self.admin["X-Admin-Token"])
        self.student = {"email":"revocation-student@example.invalid", "name":"Student", "role":"student", "enabled":True,
                        "class_id":"revoke-class", "class_ids":["revoke-class"]}
        self.teacher = {"email":"revocation-teacher@example.invalid", "name":"Teacher", "role":"teacher", "enabled":True}
        eagle._save_users({"users":[self.student,self.teacher]})
        eagle._save_classes({"classes":[{"id":"revoke-class","teacher_email":self.teacher["email"],"students":[self.student["email"]],"settings":{}}]})
        for tokens, token, record in ((eagle._student_tokens,"revocation-student",self.student),(eagle._teacher_tokens,"revocation-teacher",self.teacher)):
            tokens[token] = dict(record)
            self.addCleanup(tokens.pop,token,None)

    def socket(self, token="revocation-student", role="student"):
        client = eagle.socketio.test_client(eagle.app)
        self.addCleanup(lambda: client.disconnect() if client.is_connected() else None)
        client.emit("join_class_room", {"class_id":"revoke-class","role":role,"token":token})
        client.get_received()
        return client

    def broadcast(self):
        teacher = eagle.socketio.test_client(eagle.app)
        self.addCleanup(lambda: teacher.disconnect() if teacher.is_connected() else None)
        eagle._teacher_stream_last_emit.clear()
        teacher.emit("teacher_code_update", {"role":"teacher","token":"revocation-teacher","class_id":"revoke-class","code":"new private lesson"})

    def test_disabled_account_is_disconnected_before_the_next_broadcast(self):
        student = self.socket()
        response = self.client.post("/api/admin/users/toggle", headers=self.admin, json={"email":self.student["email"],"enabled":False})
        self.assertEqual(response.status_code,200)
        self.assertFalse(student.is_connected())
        self.broadcast()
        self.assertEqual(self.client.get("/api/auth/me",headers={"X-User-Token":"revocation-student"}).status_code,401)

    def test_bulk_disable_reset_and_delete_also_disconnect_sockets(self):
        for route, data in (("bulk-toggle",{"emails":[self.student["email"]],"enabled":False}),
                            ("reset-password",{"email":self.student["email"]}),
                            ("delete",{"email":self.student["email"]})):
            with self.subTest(route=route):
                eagle._save_users({"users":[self.student,self.teacher]})
                eagle._student_tokens["revocation-student"] = dict(self.student)
                student = self.socket()
                response = self.client.post("/api/admin/users/"+route,headers=self.admin,json=data)
                self.assertEqual(response.status_code,200,response.json)
                self.assertFalse(student.is_connected())

    def test_logout_revokes_only_its_socket_session(self):
        first = self.socket()
        eagle._student_tokens["revocation-second"] = dict(self.student)
        self.addCleanup(eagle._student_tokens.pop,"revocation-second",None)
        second = self.socket("revocation-second")
        self.assertEqual(self.client.post("/api/auth/logout",headers={"X-User-Token":"revocation-student"}).status_code,200)
        self.assertFalse(first.is_connected())
        self.assertTrue(second.is_connected())
        self.broadcast()
        self.assertTrue(any(item["name"]=="teacher_code" for item in second.get_received()))

    def test_token_expiry_is_checked_without_a_new_http_request(self):
        student = self.socket()
        now = time.monotonic()
        eagle._student_tokens.times["revocation-student"] = (now-eagle._student_tokens.absolute-1,now)
        self.broadcast()
        self.assertFalse(student.is_connected())

    def test_removed_membership_cannot_receive_the_next_broadcast(self):
        student = self.socket()
        classes = eagle._load_classes(); classes["classes"][0]["students"] = []
        eagle._save_classes(classes)
        self.broadcast()
        self.assertFalse(any(item["name"]=="teacher_code" for item in student.get_received()))

    def create_manager(self):
        response = self.client.post("/api/admin/wiki-managers/create",headers=self.admin,
            json={"name":"Wiki Editor","email":"wiki-manager@example.invalid","password":"long-fixture-"+"é"*80})
        self.assertEqual(response.status_code,200,response.json)
        login = self.client.post("/api/auth/login",json={"email":"wiki-manager@example.invalid","password":"long-fixture-"+"é"*80})
        self.assertEqual(login.status_code,200,login.json)
        self.addCleanup(eagle._wiki_manager_tokens.pop,login.json["token"],None)
        return {"X-Wiki-Manager-Token":login.json["token"]}

    def test_admin_created_role_has_workspace_but_no_teacher_or_admin_privileges(self):
        self.assertEqual(self.client.post("/api/admin/wiki-managers/create",json={}).status_code,401)
        headers = self.create_manager()
        self.assertEqual(self.client.get("/api/auth/me",headers=headers).json["user"]["role"],"wiki_manager")
        restored = self.client.post("/api/auth/restore")
        self.assertEqual(restored.status_code,200,restored.json)
        self.assertEqual(restored.json["role"],"wiki_manager")
        created = self.client.post("/api/files/create",headers=headers,json={"name":"manager.py"})
        self.assertEqual(created.status_code,200,created.json)
        self.assertEqual(self.client.get("/api/admin/users",headers=headers).status_code,401)
        self.assertEqual(self.client.post("/api/teacher/classes/create",headers=headers,json={"name":"Forbidden"}).status_code,401)
        token = headers["X-Wiki-Manager-Token"]
        self.assertIsNone(eagle._require_teacher(type("Request",(),{"headers":{"X-Teacher-Token":token}})()))
        context, error = eagle._resolve_execution_context({"wiki_manager_token":token},"manager-run")
        self.assertIsNone(error)
        self.assertEqual(context["role"],"wiki_manager")
        self.assertEqual(context["allowed_root"],eagle._get_user_dir("wiki-manager@example.invalid"))

    def test_manager_current_state_and_disable_are_enforced(self):
        headers = self.create_manager()
        record = eagle._find_user("wiki-manager@example.invalid")
        data = eagle._load_users()
        for user in data["users"]:
            if user["email"]==record["email"]: user["role"]="student"
        eagle._save_users(data)
        self.assertEqual(self.client.get("/api/auth/me",headers=headers).status_code,401)


if __name__ == "__main__":
    unittest.main()
