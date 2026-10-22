import io
import json
import struct
import unittest
import zlib
from email.message import Message
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image
from security_controls import AttemptLimiter, client_ip, secure_request, SessionTokens, AdministratorTokens
from media_security import clean_image, ImageValidationError
from tests import test_html_runtime as runtime_fixture
from tests.test_html_runtime import eagle
from tests import test_file_browser as file_fixture
from tests import test_lesson_plans as plan_fixture
from tests import test_notebook as notebook_fixture
from lesson_plan_features import fetch_external_link_metadata


class ControlTests(unittest.TestCase):
    def test_link_preview_connects_to_the_checked_address_without_resolving_twice(self):
        headers = Message(); headers["Content-Type"] = "text/html; charset=utf-8"
        with patch("lesson_plan_features.socket.getaddrinfo", return_value=[(2, 1, 6, "", ("8.8.8.8", 443))]) as dns, \
             patch("lesson_plan_features._PinnedPublicConnection") as connection:
            response = connection.return_value.getresponse.return_value
            response.status = 200; response.headers = headers
            response.getheader.return_value = "identity"
            response.read1.side_effect = [b"<title>Public title</title>", b""]
            result = fetch_external_link_metadata("https://public.example.invalid/page")
            self.assertEqual(result["title"], "Public title")
            self.assertEqual(dns.call_count, 1)
            self.assertEqual(connection.call_args.args[1], "8.8.8.8")
            self.assertEqual(connection.call_args.args[0].hostname, "public.example.invalid")
            connection.return_value.close.assert_called_once()

    def test_generated_grading_identity_is_removed_without_truncating_source(self):
        source = "# File: private-label.py\n# Submitted by: Fixture Identity\n# Submitted at: fixture time\nprint('all source retained')\n"
        result = eagle._anonymous_assignment_model_source({"files": [{"name": "private-label.py"}]}, source)
        self.assertNotIn("Fixture Identity", result)
        self.assertNotIn("private-label.py", result)
        self.assertIn("print('all source retained')", result)
        self.assertEqual(result.count("\n"), source.count("\n"))

    def test_only_explicit_proxies_can_supply_client_identity_or_scheme(self):
        for peer in ("10.0.0.12", "192.168.1.8", "203.0.113.2"):
            req = SimpleNamespace(remote_addr=peer, is_secure=False, headers={"CF-Connecting-IP": "8.8.8.8", "X-Forwarded-Proto": "https"})
            self.assertEqual(client_ip(req), peer)
            self.assertFalse(secure_request(req))
        req = SimpleNamespace(remote_addr="127.0.0.1", is_secure=False, headers={"CF-Connecting-IP": "8.8.8.8", "X-Forwarded-Proto": "https"})
        self.assertEqual(client_ip(req), "8.8.8.8")
        self.assertTrue(secure_request(req))
        req.headers["CF-Connecting-IP"] = "malformed"
        self.assertEqual(client_ip(req), "127.0.0.1")

    def test_limits_are_bounded_and_rotating_keys_cannot_evict_live_windows(self):
        limits = AttemptLimiter(2, 10, capacity=2)
        self.assertTrue(limits.admit("a", now=0))
        self.assertTrue(limits.admit("a", now=1))
        self.assertFalse(limits.admit("a", now=2))
        self.assertTrue(limits.admit("b", now=2))
        self.assertFalse(limits.admit("c", now=3))
        self.assertFalse(limits.admit("a", now=3))
        self.assertTrue(limits.admit("a", now=12))

    def test_access_tokens_expire_at_idle_and_absolute_boundaries(self):
        sessions = SessionTokens(absolute=100, idle=20)
        with patch("security_controls.monotonic", return_value=0):
            sessions["first"] = {"role": "student"}
        with patch("security_controls.monotonic", return_value=19):
            self.assertIn("first", sessions)
        with patch("security_controls.monotonic", return_value=39):
            self.assertNotIn("first", sessions)
        with patch("security_controls.monotonic", return_value=0):
            sessions["second"] = {"role": "teacher"}
        for now in range(10, 100, 10):
            with patch("security_controls.monotonic", return_value=now):
                self.assertIsNotNone(sessions.get("second"))
                sessions["second"] = {"role": "teacher", "updated_profile": True}
        with patch("security_controls.monotonic", return_value=100):
            self.assertNotIn("second", sessions)
        admin = AdministratorTokens()
        with patch("security_controls.monotonic", return_value=0):
            admin.add("admin")
        with patch("security_controls.monotonic", return_value=9 * 3600):
            self.assertNotIn("admin", admin)

    def test_admin_migration_preserves_the_password_and_unrelated_settings(self):
        cfg = {"admin_email": "admin@example.invalid", "admin_password_encrypted": "legacy-ciphertext", "page_title": "Keep this"}
        with patch.object(eagle, "ADMIN_ACCOUNT_EMAIL"), patch.object(eagle, "ADMIN_ACCOUNT_PASSWORD"), patch.object(eagle, "ADMIN_ACCOUNT_PASSWORD_HASH"), patch.object(eagle, "ADMIN_ACCOUNT_PASSWORD_SCHEME"), \
             patch.object(eagle, "_load_config", return_value=cfg), patch.object(eagle, "_decrypt_admin_password", return_value="fixture-only-password"), patch.object(eagle, "_save_config") as save:
            eagle._bootstrap_admin_credentials()
            updated = save.call_args.args[0]
            self.assertNotIn("admin_password_encrypted", updated)
            self.assertEqual(updated["page_title"], "Keep this")
            self.assertTrue(eagle.verify_admin_password("fixture-only-password", updated["admin_password_hash"], updated["admin_password_scheme"]))
            self.assertEqual(eagle.ADMIN_ACCOUNT_PASSWORD, "")

    def test_public_config_cannot_expose_or_replace_the_admin_hash(self):
        token = "security-admin"
        eagle._admin_tokens.add(token)
        self.addCleanup(eagle._admin_tokens.discard, token)
        config = {"admin_password_hash": "private-hash", "admin_email": "admin@example.invalid"}
        with patch.object(eagle, "_load_config", return_value=config.copy()):
            self.assertNotIn("admin_password_hash", eagle.app.test_client().get("/api/config").json["data"])
        with patch.object(eagle, "_update_config", return_value={}) as save:
            response = eagle.app.test_client().post("/api/config/save", headers={"X-Admin-Token": token}, json={"data": {"admin_password_hash": "attacker"}})
            self.assertEqual(response.status_code, 200)
            self.assertNotIn("admin_password_hash", save.call_args.args[0])

    def test_unauthenticated_ai_never_reaches_the_dispatcher(self):
        with patch.object(eagle, "_load_config", return_value={"ai_explainer_enabled": True}), patch.object(eagle, "call_ollama_generate") as dispatch:
            client = eagle.app.test_client()
            for route in ("/api/explain", "/api/assistant/chat"):
                self.assertEqual(client.post(route, json={"code": "print(1)", "sid": "new-client"}).status_code, 403)
            dispatch.assert_not_called()

    def test_cleaning_removes_metadata_and_preserves_animation_and_format(self):
        for extension, format_name in ((".jpg", "JPEG"), (".png", "PNG"), (".webp", "WEBP")):
            image = Image.new("RGB", (12, 8), "red")
            exif = Image.Exif(); exif[270] = "private camera metadata"
            original = io.BytesIO(); image.save(original, format=format_name, exif=exif)
            with Image.open(io.BytesIO(clean_image(original.getvalue(), extension))) as result:
                self.assertEqual(result.format, format_name)
                self.assertFalse(result.getexif())
                self.assertEqual(result.size, (12, 8))
        original = io.BytesIO()
        Image.new("RGB", (8, 8), "red").save(original, format="GIF", save_all=True,
            append_images=[Image.new("RGB", (8, 8), "blue")], duration=[100, 200], loop=2, comment=b"private")
        with Image.open(io.BytesIO(clean_image(original.getvalue(), ".gif"))) as result:
            self.assertEqual(result.n_frames, 2)
            self.assertEqual(result.info["loop"], 2)
            self.assertNotIn("comment", result.info)

    def test_apng_dimensions_are_rejected_before_canvas_allocation(self):
        def chunk(kind, data):
            return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

        # Tiny frame data with a huge claimed canvas exercises the APNG open path.
        # Intercept native allocation so a vulnerable Pillow fails without allocating it.
        payload = b"\x89PNG\r\n\x1a\n" + b"".join((
            chunk(b"IHDR", struct.pack(">IIBBBBB", 30000, 30000, 8, 6, 0, 0, 0)),
            chunk(b"acTL", struct.pack(">II", 2, 0)),
            chunk(b"fcTL", struct.pack(">IIIIIHHBB", 0, 1, 1, 0, 0, 1, 10, 1, 0)),
            chunk(b"IDAT", zlib.compress(b"\x00\x00\x00\x00\x00")),
            chunk(b"IEND", b""),
        ))
        with patch.object(Image.core, "fill", side_effect=AssertionError("canvas allocated before dimension check")) as allocate:
            with self.assertRaises(ImageValidationError) as error:
                clean_image(payload, ".png")
            self.assertIsInstance(error.exception.__cause__, Image.DecompressionBombError)
            allocate.assert_not_called()


class RuntimeSecurityTests(unittest.TestCase):
    setUp = runtime_fixture.HtmlRuntimeTestCase.setUp
    tearDown = runtime_fixture.HtmlRuntimeTestCase.tearDown
    _start_runtime = runtime_fixture.HtmlRuntimeTestCase._start_runtime

    def test_htm_and_svg_direct_navigation_cannot_execute_on_main_origin(self):
        (self.user_dir / "page.htm").write_text("<script>alert(1)</script>")
        (self.user_dir / "drawing.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
        data = self._start_runtime("page.htm").json
        for name in ("page.htm", "drawing.svg", "styles.css"):
            response = self.client.get(f"/api/html-runtime/view/{data['runtime_id']}/{name}")
            self.assertEqual(response.status_code, 200)
            self.assertIn("script-src 'none'", response.headers["Content-Security-Policy"])
            self.assertIn("sandbox", response.headers["Content-Security-Policy"])
            response.close()

    def test_leaderboard_has_only_the_authorized_roster_and_no_email_fields(self):
        user = {"email": self.email, "name": "Student A", "role": "student", "class_id": "a", "class_ids": ["a"]}
        other = {"email": "other@example.invalid", "name": "Student B", "role": "student", "class_id": "b"}
        eagle._student_tokens[self.token] = user
        classes = {"a": {"id": "a", "students": [self.email]}, "b": {"id": "b", "students": [other["email"]]}}
        with patch.object(eagle, "_load_users", return_value={"users": [user, other]}), \
             patch.object(eagle, "_find_class_by_id", side_effect=classes.get), patch.object(eagle, "_load_challenge_scores", return_value={}):
            result = self.client.get("/api/challenge/leaderboard?classId=a", headers={"X-User-Token": self.token})
            self.assertEqual(result.status_code, 200)
            self.assertEqual([entry["name"] for entry in result.json["leaderboard"]], ["Student A"])
            self.assertNotIn('"email"', json.dumps(result.json))
            self.assertEqual(self.client.get("/api/challenge/leaderboard?classId=b", headers={"X-User-Token": self.token}).status_code, 403)

    def test_private_files_and_unknown_document_types_are_not_capability_assets(self):
        data = self._start_runtime().json
        for name in (".eagleide/private.json", "Trash/deleted.txt", "private.xhtml"):
            target = self.user_dir / name; target.parent.mkdir(exist_ok=True)
            target.write_text("private")
            self.assertEqual(self.client.get(f"/api/html-runtime/view/{data['runtime_id']}/{name}").status_code, 404)

    def test_isolated_preview_cannot_be_navigated_on_main_host(self):
        eagle.HTML_RUNTIME_PREVIEW_ORIGIN = "https://preview.example.invalid"
        eagle.HTML_RUNTIME_PREVIEW_ISOLATED = True
        data = self._start_runtime().json
        self.assertEqual(self.client.get(f"/api/html-runtime/view/{data['runtime_id']}/index.html").status_code, 404)
        with patch.object(eagle, "_load_config", return_value={"html_runtime_allow_external_internet": True}):
            response = self.client.get(data["view_url"])
        self.assertEqual(response.status_code, 200)
        self.assertIn("sandbox allow-scripts", response.headers["Content-Security-Policy"])


class UploadSecurityTests(unittest.TestCase):
    setUp = file_fixture.FileBrowserTests.setUp
    _clear_workspace_cache = staticmethod(file_fixture.FileBrowserTests._clear_workspace_cache)

    def test_workspace_upload_strips_exif_and_nonimages_remain_unchanged(self):
        image = Image.new("RGB", (12, 8), "red")
        exif = Image.Exif(); exif[270] = "private metadata"
        source = io.BytesIO(); image.save(source, format="JPEG", exif=exif); source.seek(0)
        response = self.client.post("/api/files/upload", headers=self.headers,
            data={"file": (source, "photo.jpg")}, content_type="multipart/form-data")
        self.assertEqual(response.status_code, 200)
        with Image.open(self.workspace / response.json["path"]) as result:
            self.assertFalse(result.getexif())
        response = self.client.post("/api/files/upload", headers=self.headers,
            data={"file": (io.BytesIO(b"print('saved')\n"), "work.py")}, content_type="multipart/form-data")
        self.assertEqual(response.status_code, 200)
        self.assertEqual((self.workspace / response.json["path"]).read_bytes(), b"print('saved')\n")


class PublicNoteSecurityTests(unittest.TestCase):
    setUp = plan_fixture.LessonPlanRouteTests.setUp
    tearDown = plan_fixture.LessonPlanRouteTests.tearDown
    publish = plan_fixture.LessonPlanRouteTests.publish

    def test_public_notes_require_explicit_opt_in_without_deleting_saved_notes(self):
        self.publish()
        token = self.store.ensure_public_token("class-1")
        endpoint = f"/api/lesson-plans/public/{token}?week={self.current_week}"
        self.assertNotIn("notes_markdown", self.client.get(endpoint).json["plan"])
        stored = self.store.get_plan("class-1", self.current_week)
        self.assertEqual(stored["notes_markdown"], "Bring headphones.")
        stored["notes_public"] = True
        self.store.save_plan("class-1", self.current_week, stored, expected_version=stored["version"])
        self.assertEqual(self.client.get(endpoint).json["plan"]["notes_markdown"], "Bring headphones.")


class DeletionSafetyTests(unittest.TestCase):
    setUp = notebook_fixture.NotebookTestCase.setUp
    tearDown = notebook_fixture.NotebookTestCase.tearDown

    def test_storage_failure_keeps_a_disabled_account_for_retry(self):
        workspace = eagle._get_user_dir(self.student_email)
        workspace.mkdir(parents=True, exist_ok=True)
        (workspace / "saved.py").write_text("print('retain')")
        with patch.object(eagle.shutil, "rmtree", side_effect=OSError("fixture storage unavailable")):
            with self.assertRaises(eagle.AccountCleanupError):
                eagle._delete_user_by_email(self.student_email)
        self.assertFalse(eagle._find_user(self.student_email)["enabled"])
        self.assertTrue((workspace / "saved.py").exists())
        self.assertTrue(eagle._delete_user_by_email(self.student_email))
        self.assertIsNone(eagle._find_user(self.student_email))

    def test_owner_cannot_be_removed_while_their_classes_would_be_orphaned(self):
        before = eagle._load_classes()
        with self.assertRaises(eagle.AccountCleanupError) as error:
            eagle._delete_user_by_email(self.teacher_email)
        self.assertEqual(error.exception.status, 409)
        self.assertIsNotNone(eagle._find_user(self.teacher_email))
        self.assertEqual(eagle._load_classes(), before)
