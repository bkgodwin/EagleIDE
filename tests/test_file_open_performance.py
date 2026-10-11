"""Workspace permission checks stay cheap without caching stale permissions."""
import builtins
import getpass
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

with patch.object(builtins, "input", return_value="admin@eagleide.local"), patch.object(getpass, "getpass", return_value="password"):
    import app as eagle


class FileOpenPerformanceTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        for name, value in [("CLASSES_FILE", root / "classes.json"), ("USER_FILES_DIR", root / "files"), ("_classes_cache", None)]:
            context = patch.object(eagle, name, value)
            context.start()
            self.addCleanup(context.stop)
        self.classes = [{"id": "selected", "students": ["files@example.test"], "settings": {}}]
        self.classes += [{"id": f"unrelated-{i}", "students": [f"student-{i}-{j}@example.test" for j in range(30)]} for i in range(100)]
        eagle._save_classes({"classes": self.classes})
        eagle._student_tokens["file-open-perf"] = {"email": "files@example.test", "class_id": "selected", "class_ids": ["selected"]}
        self.addCleanup(eagle._student_tokens.pop, "file-open-perf", None)
        folder = eagle._get_user_dir("files@example.test")
        folder.mkdir(parents=True)
        (folder / "main.py").write_text("print('hello')", encoding="utf-8")
        self.client = eagle.app.test_client()
        self.headers = {"X-User-Token": "file-open-perf", "X-Class-ID": "selected"}

    def read(self):
        return self.client.get("/api/files/read?path=main.py", headers=self.headers)

    def test_warm_file_open_does_not_copy_unrelated_classes(self):
        self.assertEqual(self.read().status_code, 200)
        original_copy = eagle.copy.deepcopy
        copied_classes = []

        def track_copy(value, *args, **kwargs):
            if isinstance(value, dict) and "classes" in value:
                copied_classes.extend(c["id"] for c in value["classes"])
            return original_copy(value, *args, **kwargs)

        with patch.object(eagle.copy, "deepcopy", side_effect=track_copy):
            response = self.read()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["content"], "print('hello')")
        self.assertEqual(copied_classes, ["selected"])

    def test_class_snapshot_cannot_mutate_cached_permissions_or_roster(self):
        cls = eagle._find_class_by_id("selected")
        cls["settings"]["student_ide_access_enabled"] = False
        cls["students"].clear()
        fresh = eagle._find_class_by_id("selected")
        self.assertTrue(fresh["settings"]["student_ide_access_enabled"])
        self.assertEqual(fresh["students"], ["files@example.test"])
        self.assertEqual(len(eagle._load_classes()["classes"]), 101)
        self.assertIsNone(eagle._find_class_by_id("missing"))

    def test_saved_permission_change_applies_on_next_open(self):
        self.assertEqual(self.read().status_code, 200)
        self.classes[0]["settings"]["student_ide_access_enabled"] = False
        eagle._save_classes({"classes": self.classes})
        self.assertEqual(self.read().status_code, 403)

    def test_external_permission_change_invalidates_cached_snapshot(self):
        self.assertEqual(self.read().status_code, 200)
        previous_mtime = eagle.CLASSES_FILE.stat().st_mtime_ns
        self.classes[0]["settings"]["student_ide_access_enabled"] = False
        eagle.CLASSES_FILE.write_text(json.dumps({"classes": self.classes}), encoding="utf-8")
        os.utime(eagle.CLASSES_FILE, ns=(previous_mtime + 1_000_000, previous_mtime + 1_000_000))
        self.assertEqual(self.read().status_code, 403)


if __name__ == "__main__":
    unittest.main()
