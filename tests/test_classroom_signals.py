"""Concurrent classroom activity must not overwrite another student's signals."""
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

import classroom_features as classroom


class ClassroomSignalPersistenceTests(unittest.TestCase):
    def test_simultaneous_hands_and_questions_are_preserved(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(
            classroom, "CLASSROOM_SIGNALS_FILE", Path(folder) / "signals.json"
        ):
            def add_student(index):
                with classroom._edit_class_bucket("class-one") as bucket:
                    time.sleep(0.001)
                    bucket["hands"].append({"student_email": f"student{index}@example.test"})
                    bucket["questions"].append({"id": str(index), "status": "open"})

            with ThreadPoolExecutor(max_workers=20) as pool:
                list(pool.map(add_student, range(60)))
            bucket = classroom._class_bucket("class-one")
            self.assertEqual(len(bucket["hands"]), 60)
            self.assertEqual({q["id"] for q in bucket["questions"]}, {str(i) for i in range(60)})
            self.assertEqual(classroom._class_bucket("class-two"), {"hands": [], "questions": [], "silenced": {}})

    def test_failed_update_does_not_persist_partial_state(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(
            classroom, "CLASSROOM_SIGNALS_FILE", Path(folder) / "signals.json"
        ):
            with self.assertRaises(ValueError):
                with classroom._edit_class_bucket("class-one") as bucket:
                    bucket["hands"].append({"student_email": "student@example.test"})
                    raise ValueError("abort")
            self.assertEqual(classroom._class_bucket("class-one")["hands"], [])


if __name__ == "__main__":
    unittest.main()
