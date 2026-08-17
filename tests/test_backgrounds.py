import builtins
import getpass
import io
import json
import tempfile
import unittest
from pathlib import Path

from PIL import Image


_ORIGINAL_INPUT = builtins.input
_ORIGINAL_GETPASS = getpass.getpass
builtins.input = lambda _prompt="": "admin@eagleide.local"
getpass.getpass = lambda _prompt="": "password"

import app as eagle  # noqa: E402

builtins.input = _ORIGINAL_INPUT
getpass.getpass = _ORIGINAL_GETPASS


def image_upload(color=(40, 90, 150)):
    stream = io.BytesIO()
    Image.new("RGB", (32, 18), color).save(stream, format="PNG")
    stream.seek(0)
    return stream


class BackgroundRouteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.original = {
            "PERSIST_FILE": eagle.PERSIST_FILE,
            "BACKGROUND_ASSETS_DIR": eagle.BACKGROUND_ASSETS_DIR,
            "CLASSES_FILE": eagle.CLASSES_FILE,
        }
        eagle.PERSIST_FILE = self.root / "config.json"
        eagle.BACKGROUND_ASSETS_DIR = self.root / "background_assets"
        eagle.BACKGROUND_ASSETS_DIR.mkdir()
        eagle.CLASSES_FILE = self.root / "classes.json"
        eagle.PERSIST_FILE.write_text(json.dumps(eagle.DEFAULT_CONFIG), encoding="utf-8")
        eagle.CLASSES_FILE.write_text(json.dumps({"classes": [{
            "id": "class-one",
            "name": "Class One",
            "teacher_email": "teacher@example.com",
            "students": ["student@example.com"],
            "settings": {},
        }]}), encoding="utf-8")
        eagle._cfg_cache = None
        eagle._cfg_cache_mtime_ns = None
        eagle._classes_cache = None
        self.admin_token = "background-admin-token"
        self.teacher_token = "background-teacher-token"
        eagle._admin_tokens.add(self.admin_token)
        eagle._teacher_tokens[self.teacher_token] = {
            "email": "teacher@example.com", "name": "Teacher", "role": "teacher",
        }
        self.client = eagle.app.test_client()

    def tearDown(self):
        eagle._admin_tokens.discard(self.admin_token)
        eagle._teacher_tokens.pop(self.teacher_token, None)
        for key, value in self.original.items():
            setattr(eagle, key, value)
        eagle._cfg_cache = None
        eagle._cfg_cache_mtime_ns = None
        eagle._classes_cache = None
        self.temp.cleanup()

    def test_admin_replacement_applies_and_deletes_previous_asset(self):
        headers = {"X-Admin-Token": self.admin_token}
        first = self.client.post(
            "/api/admin/backgrounds/ide-light",
            data={"image": (image_upload(), "first.png")},
            headers=headers,
            content_type="multipart/form-data",
        )
        self.assertEqual(first.status_code, 200)
        first_name = first.json["asset"]
        self.assertTrue((eagle.BACKGROUND_ASSETS_DIR / first_name).is_file())
        second = self.client.post(
            "/api/admin/backgrounds/ide-light",
            data={"image": (image_upload((90, 40, 20)), "second.png")},
            headers=headers,
            content_type="multipart/form-data",
        )
        self.assertEqual(second.status_code, 200)
        self.assertFalse((eagle.BACKGROUND_ASSETS_DIR / first_name).exists())
        served = self.client.get(second.json["data"]["ide_background_light_url"])
        self.assertEqual(served.status_code, 200)
        served.close()

    def test_uploads_require_auth_and_valid_decodable_images(self):
        unauthorized = self.client.post(
            "/api/admin/backgrounds/home",
            data={"image": (image_upload(), "home.png")},
            content_type="multipart/form-data",
        )
        self.assertEqual(unauthorized.status_code, 401)
        invalid = self.client.post(
            "/api/admin/backgrounds/home",
            data={"image": (io.BytesIO(b"not an image"), "home.png")},
            headers={"X-Admin-Token": self.admin_token},
            content_type="multipart/form-data",
        )
        self.assertEqual(invalid.status_code, 400)

    def test_teacher_can_replace_and_reset_only_owned_class_background(self):
        headers = {"X-Teacher-Token": self.teacher_token}
        uploaded = self.client.post(
            "/api/teacher/classes/class-one/home-background",
            data={"image": (image_upload(), "class.png")},
            headers=headers,
            content_type="multipart/form-data",
        )
        self.assertEqual(uploaded.status_code, 200)
        filename = uploaded.json["classData"]["settings"]["home_background_asset"]
        self.assertTrue((eagle.BACKGROUND_ASSETS_DIR / filename).is_file())
        denied = self.client.post(
            "/api/teacher/classes/not-owned/home-background",
            data={"image": (image_upload(), "class.png")},
            headers=headers,
            content_type="multipart/form-data",
        )
        self.assertEqual(denied.status_code, 404)
        reset = self.client.delete(
            "/api/teacher/classes/class-one/home-background",
            headers=headers,
        )
        self.assertEqual(reset.status_code, 200)
        self.assertFalse((eagle.BACKGROUND_ASSETS_DIR / filename).exists())
        self.assertEqual(reset.json["classData"]["settings"]["home_background_asset"], "")


if __name__ == "__main__":
    unittest.main()
