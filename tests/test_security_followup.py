"""Round-two session, background-ingestion and configuration regressions."""
import ast
from concurrent.futures import ThreadPoolExecutor
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
import threading
from unittest.mock import patch

from PIL import Image, PngImagePlugin
from werkzeug.datastructures import FileStorage

from security_controls import AdministratorTokens, SessionTokens
from tests.test_html_runtime import eagle


class SecurityFollowupTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for name, value in {
            "USERS_FILE": self.root / "users.json", "CLASSES_FILE": self.root / "classes.json",
            "USER_FILES_DIR": self.root / "files", "BACKGROUND_ASSETS_DIR": self.root / "backgrounds",
            "PERSIST_FILE": self.root / "config.txt", "_cfg_cache": None, "_cfg_cache_mtime_ns": None,
            "_student_tokens": SessionTokens(), "_teacher_tokens": SessionTokens(),
            "_wiki_manager_tokens": SessionTokens(), "_admin_tokens": AdministratorTokens(),
        }.items():
            context = patch.object(eagle, name, value)
            context.start()
            self.addCleanup(context.stop)
        self.records = [{"email": role + "@example.invalid", "name": role, "role": role, "enabled": True,
                         "class_id": "fixture", "class_ids": ["fixture"]}
                        for role in ("student", "teacher", "wiki_manager")]
        eagle._save_users({"users": self.records})
        eagle._save_classes({"classes": [{"id": "fixture", "teacher_email": self.records[1]["email"],
                                           "students": [self.records[0]["email"]], "coteachers": [self.records[0]["email"]]}]})
        self.client = eagle.app.test_client()

    def test_session_cap_disconnects_only_evicted_token_for_every_role(self):
        for role in ("student", "teacher", "wiki_manager", "admin"):
            with self.subTest(role=role):
                record = next((r for r in self.records if r["role"] == role), {})
                clients = []
                for index in range(5):
                    token = eagle._issue_access_token(role, record, f"{role}-{index}")
                    client = eagle.socketio.test_client(eagle.app)
                    self.addCleanup(lambda c=client: c.disconnect() if c.is_connected() else None)
                    sid = eagle.socketio.server.manager.sid_from_eio_sid(client.eio_sid, "/")
                    field = "user_token" if role == "student" else role + "_token"
                    context, error = eagle._resolve_execution_context({field: token, "class_id": "fixture"}, sid)
                    self.assertIsNone(error)
                    self.assertEqual(context["role"], role)
                    clients.append(client)
                # A new sign-in may evict one old token, never the whole account.
                original = eagle._revoke_socket_sessions
                def revoke(**kwargs):
                    self.assertEqual(kwargs, {"tokens": {f"{role}-0"}})
                    self.assertTrue(eagle._session_issue_lock.acquire(blocking=False))
                    eagle._session_issue_lock.release()
                    original(**kwargs)
                with patch.object(eagle, "_revoke_socket_sessions", side_effect=revoke):
                    eagle._issue_access_token(role, record, f"{role}-5")
                self.assertFalse(clients[0].is_connected())
                self.assertTrue(all(c.is_connected() for c in clients[1:]))
                store = getattr(eagle, "_" + ("student" if role == "student" else role) + "_tokens")
                self.assertNotIn(f"{role}-0", store)
                self.assertEqual(len(store), 5)

    def test_http_rejection_disconnects_the_bound_socket(self):
        for role, header in (("student", "X-User-Token"), ("teacher", "X-Teacher-Token"),
                             ("wiki_manager", "X-Wiki-Manager-Token")):
            with self.subTest(role=role):
                eagle._save_users({"users": self.records})
                record = next(r for r in self.records if r["role"] == role)
                token = eagle._issue_access_token(role, record)
                client = eagle.socketio.test_client(eagle.app)
                self.addCleanup(lambda c=client: c.disconnect() if c.is_connected() else None)
                sid = eagle.socketio.server.manager.sid_from_eio_sid(client.eio_sid, "/")
                field = "user_token" if role == "student" else role + "_token"
                _, error = eagle._resolve_execution_context({field: token, "class_id": "fixture"}, sid)
                self.assertIsNone(error)
                eagle._save_users({"users": [r for r in self.records if r["role"] != role]})
                self.assertEqual(self.client.get("/api/auth/me", headers={header: token}).status_code, 401)
                self.assertFalse(client.is_connected())

    def test_classroom_sessions_restore_concurrently_after_restart(self):
        credentials = "fixture-hash"
        students = [{**self.records[0], "email": f"student{i}@example.invalid", "password_hash": credentials}
                    for i in range(30)]
        eagle._save_users({"users": students})
        eagle._save_classes({"classes": [{"id": "fixture", "students": [student["email"] for student in students]}]})
        cipher = eagle.Fernet(eagle.Fernet.generate_key())
        barrier = threading.Barrier(len(students))

        def make_client(student, token):
            client = eagle.app.test_client()
            with eagle.app.test_request_context():
                response = eagle.jsonify(ok=True)
                eagle._set_device_session_cookie(response, "student", student["email"], token)
            cookie = response.headers["Set-Cookie"].split(";", 1)[0].split("=", 1)[1]
            client.set_cookie(eagle.AUTH_DEVICE_COOKIE, cookie)
            return client

        def restore(client, token):
            barrier.wait(timeout=10)
            self.assertEqual(client.get("/api/auth/me", headers={"X-User-Token": token}).status_code, 401)
            response = client.post("/api/auth/restore")
            self.assertEqual(response.status_code, 200, response.get_json())
            self.assertEqual(response.get_json()["token"], token)
            headers = {"X-User-Token": token, "X-Class-ID": "fixture"}
            self.assertEqual(client.get("/api/files/list", headers=headers).status_code, 200)

        with patch.object(eagle, "_admin_cipher", return_value=cipher), \
             patch.object(eagle.bcrypt, "checkpw", side_effect=AssertionError("restore must not verify passwords")), \
             patch.object(eagle, "_load_users", side_effect=AssertionError("restore must not copy the account catalog")):
            clients = [(make_client(student, f"{i:032x}"), f"{i:032x}") for i, student in enumerate(students)]
            with ThreadPoolExecutor(max_workers=len(clients)) as pool:
                for future in [pool.submit(restore, *entry) for entry in clients]:
                    future.result(timeout=20)
            self.assertEqual(len(eagle._student_tokens), 30)

            # An unreadable account store is temporary and keeps the signed cookie.
            client, token = clients[0]
            eagle._student_tokens.clear()
            eagle.USERS_FILE.write_text("{", encoding="utf-8")
            eagle._users_cache = None
            unavailable = client.post("/api/auth/restore")
            self.assertEqual(unavailable.status_code, 503)
            self.assertNotIn("Set-Cookie", unavailable.headers)
            eagle._save_users({"users": students})
            self.assertEqual(client.post("/api/auth/restore").get_json()["token"], token)

    def test_room_reconnects_coalesce_presence_and_check_current_membership(self):
        students = [{**self.records[0], "email": f"student{i}@example.invalid"} for i in range(30)]
        teacher = self.records[1]
        eagle._save_users({"users": [*students, teacher]})
        classroom = {"id": "fixture", "teacher_email": teacher["email"], "students": [item["email"] for item in students]}
        eagle._save_classes({"classes": [classroom]})
        self.addCleanup(eagle._pending_presence_updates.discard, "fixture")
        with patch.object(eagle.socketio, "start_background_task") as enqueue:
            listeners = []
            for account in [teacher, *students]:
                client = eagle.socketio.test_client(eagle.app)
                self.addCleanup(lambda c=client: c.disconnect() if c.is_connected() else None)
                token = eagle._issue_access_token(account["role"], account)
                client.emit("join_class_room", {"role": account["role"], "token": token, "class_id": "fixture",
                                                "open_file": "main.py"})
                listeners.append(client)
            enqueue.assert_called_once_with(eagle._flush_class_presence, "fixture")
            with patch.object(eagle.socketio, "sleep"), patch.object(eagle, "_find_class_by_id", wraps=eagle._find_class_by_id) as find:
                eagle._flush_class_presence("fixture")
                self.assertEqual(find.call_count, 2)
            messages = [item for item in listeners[0].get_received() if item["name"] == "class_presence_updated"]
            self.assertEqual(len(messages), 1)
            self.assertEqual(len(messages[0]["args"][0]["activeStudents"]), 30)
            self.assertTrue(all(name == "main.py" for name in messages[0]["args"][0]["openFilesByEmail"].values()))
            for student in listeners[1:]:
                student.get_received()
            classroom["students"].remove(students[0]["email"])
            eagle._save_classes({"classes": [classroom]})
            eagle.socketio.emit("fixture_delivery", {}, to="class_fixture_students")
            self.assertFalse(listeners[1].get_received())
            self.assertTrue(any(item["name"] == "fixture_delivery" for item in listeners[2].get_received()))

    def test_http_validation_uses_current_account_for_each_separate_role(self):
        for role, header, validator in (
            ("student", "X-User-Token", eagle._require_user),
            ("teacher", "X-Teacher-Token", eagle._require_teacher),
            ("wiki_manager", "X-Wiki-Manager-Token", eagle._require_wiki_manager),
        ):
            store = getattr(eagle, "_" + role + "_tokens")
            record = next(r for r in self.records if r["role"] == role)
            request = SimpleNamespace(headers={header: "current-state"})
            for invalid in ("missing", "disabled", "role"):
                with self.subTest(role=role, invalid=invalid):
                    current = dict(record)
                    if invalid == "disabled": current["enabled"] = False
                    if invalid == "role": current["role"] = "teacher" if role != "teacher" else "student"
                    eagle._save_users({"users": [] if invalid == "missing" else [current]})
                    store["current-state"] = dict(record)
                    self.assertIsNone(validator(request))
                    self.assertNotIn("current-state", store)
            current = {**record, "name": "Current profile", "first_name": "Current", "last_name": "Profile", "class_id": None, "class_ids": []}
            eagle._save_users({"users": [current]})
            store["current-state"] = dict(record)
            actor = validator(request)
            self.assertEqual(actor["name"], "Current Profile")
            if role == "student": self.assertEqual(actor["class_ids"], [])
            store.pop("current-state")

    def test_coteacher_requires_opt_in_current_student_role_and_membership(self):
        token = eagle._issue_access_token("student", self.records[0])
        request = SimpleNamespace(headers={"X-Teacher-Token": token})
        self.assertIsNone(eagle._require_teacher(request))
        self.assertTrue(eagle._require_teacher(request, allow_coteacher=True)["is_coteacher"])
        self.assertIn(token, eagle._student_tokens)
        eagle._save_classes({"classes": [{"id": "fixture", "coteachers": [self.records[0]["email"]], "students": []}]})
        self.assertIsNone(eagle._require_teacher(request, allow_coteacher=True))
        eagle._save_users({"users": [{**self.records[0], "role": "wiki_manager"}]})
        self.assertIsNone(eagle._require_teacher(request, allow_coteacher=True))

    def test_role_headers_cannot_be_interchanged(self):
        for record in self.records:
            token = eagle._issue_access_token(record["role"], record)
            for role, validator, header in (("student", eagle._require_user, "X-User-Token"),
                                           ("teacher", eagle._require_teacher, "X-Teacher-Token"),
                                           ("wiki_manager", eagle._require_wiki_manager, "X-Wiki-Manager-Token")):
                if role != record["role"]:
                    self.assertIsNone(validator(SimpleNamespace(headers={header: token})))
            self.assertIn(token, getattr(eagle, "_" + record["role"] + "_tokens"))

    def test_background_upload_cleans_metadata_preserves_format_orientation_and_animation(self):
        for format_name, suffix in (("JPEG", "jpg"), ("PNG", "png"), ("WEBP", "webp")):
            with self.subTest(format=format_name):
                image = Image.new("RGB", (12, 8), "red")
                exif = Image.Exif(); exif[270] = "synthetic camera metadata"; exif[274] = 6
                payload = io.BytesIO(); image.save(payload, format=format_name, exif=exif)
                asset = eagle._store_background_upload(FileStorage(stream=io.BytesIO(payload.getvalue()), filename="camera." + suffix))
                with Image.open(eagle.BACKGROUND_ASSETS_DIR / asset) as cleaned:
                    self.assertEqual(cleaned.format, format_name)
                    self.assertFalse(cleaned.getexif())
                    self.assertEqual(cleaned.size, (8, 12))
        metadata = PngImagePlugin.PngInfo(); metadata.add_text("location", "synthetic metadata")
        payload = io.BytesIO()
        Image.new("RGBA", (8, 8), "red").save(payload, format="PNG", save_all=True,
            append_images=[Image.new("RGBA", (8, 8), "blue")], duration=[100, 200], loop=2, pnginfo=metadata)
        asset = eagle._store_background_upload(FileStorage(stream=io.BytesIO(payload.getvalue()), filename="animation.png"))
        with Image.open(eagle.BACKGROUND_ASSETS_DIR / asset) as cleaned:
            self.assertEqual(cleaned.n_frames, 2)
            self.assertEqual(cleaned.info["loop"], 2)
            self.assertNotIn("location", cleaned.info)

    def test_rejected_backgrounds_do_not_modify_saved_settings_or_existing_assets(self):
        eagle.BACKGROUND_ASSETS_DIR.mkdir()
        existing = eagle.BACKGROUND_ASSETS_DIR / ("a" * 32 + ".png")
        existing.write_bytes(b"existing fixture bytes")
        config = {"home_background_asset": existing.name, "page_title": "Keep this"}
        eagle._save_config(config)
        eagle._admin_tokens.add("fixture-admin")
        for payload in (b"", b"not an image"):
            response = self.client.post("/api/admin/backgrounds/home", headers={"X-Admin-Token": "fixture-admin"},
                data={"image": (io.BytesIO(payload), "bad.png")})
            self.assertEqual(response.status_code, 400)
        payload = io.BytesIO(); Image.new("RGB", (8, 8), "red").save(payload, format="PNG")
        with patch.object(eagle, "MAX_BACKGROUND_PIXELS", 63):
            with self.assertRaises(ValueError):
                eagle._store_background_upload(FileStorage(stream=io.BytesIO(payload.getvalue()), filename="large.png"))
        with patch.object(eagle, "MAX_UPLOAD_FILE_BYTES", 8):
            with self.assertRaises(ValueError):
                eagle._store_background_upload(FileStorage(stream=io.BytesIO(payload.getvalue()), filename="large.png"))
        with patch.object(eagle, "clean_image", return_value=b"x" * (len(payload.getvalue()) + 1)), \
             patch.object(eagle, "MAX_UPLOAD_FILE_BYTES", len(payload.getvalue())):
            with self.assertRaises(ValueError):
                eagle._store_background_upload(FileStorage(stream=io.BytesIO(payload.getvalue()), filename="large.png"))
        self.assertEqual(existing.read_bytes(), b"existing fixture bytes")
        self.assertEqual(json.loads(eagle.PERSIST_FILE.read_text()), config)
        self.assertEqual(list(eagle.BACKGROUND_ASSETS_DIR.iterdir()), [existing])

    def test_ollama_defaults_agree_and_loading_never_overwrites_explicit_endpoint(self):
        tree = ast.parse((eagle.BASE_DIR / "app.py").read_text(encoding="utf-8"))
        fallback = next(n.value for n in ast.walk(tree) if isinstance(n, ast.Assign)
                        and any(isinstance(t, ast.Name) and t.id == "DEFAULT_CONFIG" for t in n.targets))
        default_url = next(ast.literal_eval(v) for k, v in zip(fallback.keys, fallback.values)
                           if ast.literal_eval(k) == "ai_ollama_url")
        self.assertEqual(default_url, "http://127.0.0.1:11434")
        self.assertEqual(eagle.DEFAULT_CONFIG["ai_ollama_url"], default_url)
        for stored, expected in (({"ai_ollama_url": "http://ollama.internal:11434"}, "http://ollama.internal:11434"),
                                 ({"page_title": "Legacy config"}, default_url)):
            eagle._save_config(stored)
            eagle._cfg_cache = None
            self.assertEqual(eagle._load_config()["ai_ollama_url"], expected)
            self.assertEqual(json.loads(eagle.PERSIST_FILE.read_text()), stored)
