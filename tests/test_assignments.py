import builtins
import csv
import getpass
import io
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch


_ORIGINAL_INPUT = builtins.input
_ORIGINAL_GETPASS = getpass.getpass
builtins.input = lambda _prompt="": "admin@eagleide.local"
getpass.getpass = lambda _prompt="": "password"

import app as eagle  # noqa: E402

builtins.input = _ORIGINAL_INPUT
getpass.getpass = _ORIGINAL_GETPASS


class AssignmentWorkflowTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.assignments_dir = self.root / "assignments"
        self.submissions_dir = self.root / "assignment_submissions"
        self.user_files_dir = self.root / "user_files"
        self.users_file = self.root / "users.json"
        self.classes_file = self.root / "classes.json"
        for directory in (self.assignments_dir, self.submissions_dir, self.user_files_dir):
            directory.mkdir(parents=True)

        self.originals = {
            "ASSIGNMENTS_DIR": eagle.ASSIGNMENTS_DIR,
            "ASSIGNMENT_SUBMISSIONS_DIR": eagle.ASSIGNMENT_SUBMISSIONS_DIR,
            "USER_FILES_DIR": eagle.USER_FILES_DIR,
            "USERS_FILE": eagle.USERS_FILE,
            "CLASSES_FILE": eagle.CLASSES_FILE,
            "recovery": eagle._assignment_ai_recovery_checked,
        }
        eagle.ASSIGNMENTS_DIR = self.assignments_dir
        eagle.ASSIGNMENT_SUBMISSIONS_DIR = self.submissions_dir
        eagle.USER_FILES_DIR = self.user_files_dir
        eagle.USERS_FILE = self.users_file
        eagle.CLASSES_FILE = self.classes_file
        eagle._assignment_ai_recovery_checked = True
        eagle._users_cache = None
        eagle._classes_cache = None

        self.teacher_email = "teacher@example.com"
        self.student_email = "123456@example.com"
        self.missing_email = "654321@example.com"
        self.class_one = "class-one"
        self.class_two = "class-two"
        self.teacher_token = "assignment-teacher-token"
        self.student_token = "assignment-student-token"

        self.users_file.write_text(json.dumps({"users": [
            {"email": self.teacher_email, "name": "Teacher", "role": "teacher", "enabled": True},
            {"email": self.student_email, "name": "Student One", "role": "student", "enabled": True, "class_id": self.class_one, "class_ids": [self.class_one]},
            {"email": self.missing_email, "name": "Student Two", "role": "student", "enabled": True, "class_id": self.class_one, "class_ids": [self.class_one]},
        ]}), encoding="utf-8")
        self.classes_file.write_text(json.dumps({"classes": [
            {"id": self.class_one, "name": "Period One", "teacher_email": self.teacher_email, "join_code": "ONE111", "settings": {}, "students": [self.student_email, self.missing_email]},
            {"id": self.class_two, "name": "Period Two", "teacher_email": self.teacher_email, "join_code": "TWO222", "settings": {}, "students": []},
        ]}), encoding="utf-8")
        eagle._teacher_tokens[self.teacher_token] = {"email": self.teacher_email, "name": "Teacher", "role": "teacher"}
        eagle._student_tokens[self.student_token] = {"email": self.student_email, "name": "Student One", "role": "student", "class_id": self.class_one, "class_ids": [self.class_one]}
        self.client = eagle.app.test_client()

    def tearDown(self):
        eagle._teacher_tokens.pop(self.teacher_token, None)
        eagle._student_tokens.pop(self.student_token, None)
        for name, value in self.originals.items():
            if name == "recovery":
                eagle._assignment_ai_recovery_checked = value
            else:
                setattr(eagle, name, value)
        eagle._users_cache = None
        eagle._classes_cache = None
        self.tmp.cleanup()

    @property
    def teacher_headers(self):
        return {"X-Teacher-Token": self.teacher_token}

    @property
    def student_headers(self):
        return {"X-User-Token": self.student_token}

    def create_assignment(self, class_id=None, name="Loops", active=False):
        response = self.client.post(
            "/api/assignments/create",
            headers=self.teacher_headers,
            json={"name": name, "task": "Write a loop", "maxScore": 10, "classId": class_id or self.class_one},
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        assignment = response.get_json()["assignment"]
        if active:
            response = self.client.post(
                "/api/assignments/update",
                headers=self.teacher_headers,
                json={"assignmentId": assignment["id"], "active": True},
            )
            self.assertEqual(response.status_code, 200)
            assignment = response.get_json()["assignment"]
        return assignment

    def submit_code(self, assignment):
        student_root = eagle._get_user_dir(self.student_email)
        student_root.mkdir(parents=True, exist_ok=True)
        (student_root / "answer.py").write_text("for i in range(3):\n    print(i)\n", encoding="utf-8")
        response = self.client.post(
            "/api/assignments/submit",
            headers=self.student_headers,
            json={"assignmentId": assignment["id"], "filePath": "answer.py"},
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return response.get_json()["submission"]

    def test_same_name_is_allowed_in_different_classes_but_not_same_class(self):
        first = self.create_assignment(self.class_one, "Shared Title")
        second = self.create_assignment(self.class_two, "Shared Title")
        self.assertNotEqual(first["id"], second["id"])
        duplicate = self.client.post(
            "/api/assignments/create",
            headers=self.teacher_headers,
            json={"name": "shared title", "task": "Duplicate", "classId": self.class_one},
        )
        self.assertEqual(duplicate.status_code, 409)

    def test_assignment_creation_time_survives_edits_and_legacy_migration(self):
        assignment = self.create_assignment()
        self.assertTrue(assignment.get("createdAt"))
        self.assertEqual(assignment["aiGradingRigor"], 6)
        changed = self.client.post(
            "/api/assignments/update",
            headers=self.teacher_headers,
            json={"assignmentId": assignment["id"], "task": "Revised instructions"},
        )
        self.assertEqual(changed.status_code, 200)
        self.assertEqual(changed.get_json()["assignment"]["createdAt"], assignment["createdAt"])

        legacy = dict(assignment)
        legacy["id"] = "a" * 32
        legacy["name"] = "Older work"
        legacy.pop("createdAt", None)
        legacy_path = self.assignments_dir / f"{legacy['id']}.json"
        legacy_path.write_text(json.dumps(legacy), encoding="utf-8")
        migrated = eagle._load_assignment(legacy["id"])
        self.assertTrue(migrated.get("createdAt"))
        self.assertEqual(json.loads(legacy_path.read_text(encoding="utf-8"))["createdAt"], migrated["createdAt"])
        self.assertEqual(eagle._load_assignment(legacy["id"])["createdAt"], migrated["createdAt"])

    def test_locked_assignments_are_hidden_from_student_assignment_list(self):
        locked = self.create_assignment(name="Locked")
        active = self.create_assignment(name="Active", active=True)
        response = self.client.get("/api/assignments", headers=self.student_headers)
        self.assertEqual(response.status_code, 200)
        returned = response.get_json()["assignments"]
        self.assertEqual([row["id"] for row in returned], [active["id"]])
        self.assertNotIn(locked["id"], [row["id"] for row in returned])

    def test_submission_storage_is_separate_and_not_counted_in_teacher_workspace(self):
        assignment = self.create_assignment(active=True)
        teacher_root = eagle._get_user_dir(self.teacher_email)
        teacher_root.mkdir(parents=True)
        (teacher_root / "teacher.py").write_text("print('teacher')", encoding="utf-8")
        before = eagle._count_all_files_for_user(teacher_root)

        submission = self.submit_code(assignment)

        after = eagle._count_all_files_for_user(teacher_root)
        self.assertEqual(before, after)
        self.assertFalse(submission.get("adminFilePath"))
        stored = self.submissions_dir / submission["submissionPath"]
        self.assertTrue(stored.is_file())
        self.assertEqual(stored.parents[1].name, self.class_one)

    def test_legacy_assignment_and_teacher_workspace_file_migrate_on_load(self):
        teacher_root = eagle._get_user_dir(self.teacher_email)
        legacy_folder = teacher_root / "Legacy Work"
        legacy_folder.mkdir(parents=True)
        legacy_file = legacy_folder / "Student One.py"
        legacy_file.write_text("print('legacy')", encoding="utf-8")
        legacy_metadata = {
            "name": "Legacy Work",
            "task": "Legacy task",
            "maxScore": 10,
            "active": True,
            "allowFileSubmission": True,
            "targetClassId": self.class_one,
            "targetClassName": "Period One",
            "createdByEmail": self.teacher_email,
            "submissions": [{
                "name": "Student One",
                "email": self.student_email,
                "adminFilePath": "Legacy Work/Student One.py",
                "submittedFileName": "Student One.py",
                "code": "print('legacy')",
            }],
        }
        legacy_path = self.assignments_dir / "Legacy Work.json"
        legacy_path.write_text(json.dumps(legacy_metadata), encoding="utf-8")

        assignments = eagle._list_assignments()

        self.assertEqual(len(assignments), 1)
        migrated = assignments[0]
        self.assertRegex(migrated["id"], r"^[a-f0-9]{32}$")
        self.assertFalse(legacy_path.exists())
        self.assertTrue((self.assignments_dir / f"{migrated['id']}.json").exists())
        self.assertFalse(legacy_file.exists())
        self.assertTrue((self.submissions_dir / migrated["submissions"][0]["submissionPath"]).exists())
        self.assertEqual(eagle._count_all_files_for_user(teacher_root), 0)

    def test_missing_canonical_submission_path_recovers_legacy_workspace_file(self):
        assignment_id = "a" * 32
        teacher_root = eagle._get_user_dir(self.teacher_email)
        legacy_folder = teacher_root / "Legacy Work"
        legacy_folder.mkdir(parents=True)
        legacy_file = legacy_folder / "Student One.py"
        legacy_file.write_text("print('recovered')", encoding="utf-8")
        metadata = {
            "id": assignment_id,
            "name": "Legacy Work",
            "task": "Legacy task",
            "maxScore": 10,
            "active": True,
            "allowFileSubmission": True,
            "targetClassId": self.class_one,
            "targetClassName": "Period One",
            "createdByEmail": self.teacher_email,
            "storageVersion": 2,
            "submissions": [{
                "name": "Student One",
                "email": self.student_email,
                "adminFilePath": "",
                "submittedFileName": "Student One.py",
                "code": "",
            }],
        }
        expected = eagle._assignment_submission_directory(metadata) / "Student One--123456.py"
        metadata["submissions"][0]["submissionPath"] = expected.relative_to(self.submissions_dir).as_posix()
        (self.assignments_dir / f"{assignment_id}.json").write_text(json.dumps(metadata), encoding="utf-8")

        migrated = eagle._list_assignments()[0]

        self.assertFalse(legacy_file.exists())
        self.assertTrue(expected.is_file())
        self.assertEqual(expected.read_text(encoding="utf-8"), "print('recovered')")
        self.assertEqual(migrated["submissions"][0]["submissionPath"], expected.relative_to(self.submissions_dir).as_posix())

    def test_teacher_can_edit_submission_in_protected_store(self):
        assignment = self.create_assignment(active=True)
        submission = self.submit_code(assignment)
        changed = "for value in range(5):\n    print(value)\n"

        response = self.client.post(
            "/api/assignments/submission",
            headers=self.teacher_headers,
            json={"assignmentId": assignment["id"], "studentEmail": self.student_email, "content": changed},
        )

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual((self.submissions_dir / submission["submissionPath"]).read_text(encoding="utf-8"), changed)
        loaded = eagle._load_assignment(assignment["id"])
        self.assertEqual(loaded["submissions"][0]["code"], changed)
        opened = self.client.get(
            f"/api/assignments/submission?assignmentId={assignment['id']}&studentEmail={self.student_email}",
            headers=self.teacher_headers,
        )
        self.assertEqual(opened.get_json()["content"], changed)

    def test_background_ai_regrade_replaces_feedback_and_manual_override(self):
        assignment = self.create_assignment(active=True)
        self.submit_code(assignment)
        manual = self.client.post(
            "/api/assignments/score",
            headers=self.teacher_headers,
            json={"assignmentId": assignment["id"], "studentEmail": self.student_email, "score": 7},
        )
        self.assertEqual(manual.status_code, 200)

        with patch.object(eagle, "_effective_ai_enabled", return_value=(True, None)), patch.object(
            eagle,
            "call_ollama_generate",
            return_value={"ok": True, "text": '{"effort":"clear","strength":"The loop prints each value in the sequence.","deductions":[{"points":1,"category":"core","reason":"The task requires the last value too, but range stops before it."}]}'},
        ) as grader:
            queued = self.client.post(
                "/api/assignments/grade-ai",
                headers=self.teacher_headers,
                json={"assignmentId": assignment["id"], "studentEmail": self.student_email},
            )
            self.assertEqual(queued.status_code, 202)
            deadline = time.time() + 3
            graded = None
            while time.time() < deadline:
                graded = eagle._load_assignment(assignment["id"])
                if graded["submissions"][0].get("aiGradingStatus") in {"completed", "failed"}:
                    break
                time.sleep(0.02)

        self.assertEqual(grader.call_args.kwargs["request_identity"], f"teacher:{self.teacher_email}")
        self.assertTrue(grader.call_args.kwargs["json_response"])
        self.assertEqual(grader.call_args.kwargs["temperature"], 0)
        self.assertEqual(grader.call_args.kwargs["request_kind"], "assignment-grading")
        self.assertEqual(grader.call_args.kwargs["request_metadata"]["assignmentId"], assignment["id"])

        submission = graded["submissions"][0]
        self.assertEqual(submission["aiGradingStatus"], "completed")
        self.assertEqual(submission["aiSuggestedScore"], 9)
        self.assertEqual(submission["codeScore"], 9)
        self.assertFalse(submission["manualScoreOverride"])
        self.assertIsNone(submission["manualScore"])
        self.assertIn("−1 points — The task requires", submission["aiFeedback"])
        self.assertIn("Score: 9/10", submission["aiFeedback"])

    def test_grade_all_ai_uses_alphabetical_batches_of_three(self):
        assignment = self.create_assignment(active=True)
        first = self.submit_code(assignment)
        loaded = eagle._load_assignment(assignment["id"])
        loaded["submissions"][0]["name"] = "Zebra"
        loaded["submissions"][0]["code"] = "print('Zebra')"
        for name in ("Charlie", "Anna", "Foxtrot", "Beta", "Echo", "Delta"):
            row = dict(first)
            row.update({"name": name, "email": f"{name.lower()}@example.com", "code": f"print('{name}')", "submissionPath": ""})
            loaded["submissions"].append(row)
        self.assertTrue(eagle._save_assignment(loaded))
        active = 0
        maximum_active = 0
        guard = threading.Lock()
        started = []
        completed = []
        events = []
        first_batch = threading.Barrier(3)
        second_batch = threading.Barrier(3)

        def grade_one(_url, _model, prompt, **_kwargs):
            nonlocal active, maximum_active
            name = next(name for name in ("Anna", "Beta", "Charlie", "Delta", "Echo", "Foxtrot", "Zebra") if f"print('{name}')" in prompt)
            with guard:
                active += 1
                maximum_active = max(maximum_active, active)
                started.append(name)
                events.append(("start", name))
            if name in {"Anna", "Beta", "Charlie"}:
                first_batch.wait(timeout=5)
            elif name in {"Delta", "Echo", "Foxtrot"}:
                second_batch.wait(timeout=5)
            time.sleep(0.02)
            with guard:
                active -= 1
                completed.append(name)
                events.append(("done", name))
            return {"ok": True, "text": '{"effort":"clear","strength":"The solution includes the required print call.","deductions":[{"points":2,"category":"core","reason":"The loop required by the task is absent from the code."}]}'}

        with patch.object(eagle, "_effective_ai_enabled", return_value=(True, None)), patch.object(
            eagle, "call_ollama_generate", side_effect=grade_one
        ) as grader:
            queued = self.client.post(
                "/api/assignments/grade-all-ai",
                headers=self.teacher_headers,
                json={"assignmentId": assignment["id"]},
            )
            self.assertEqual(queued.status_code, 202)
            self.assertEqual(queued.get_json()["queued"], 7)
            deadline = time.time() + 8
            while time.time() < deadline:
                statuses = [row.get("aiGradingStatus") for row in eagle._load_assignment(assignment["id"])["submissions"]]
                if statuses == ["completed"] * 7:
                    break
                time.sleep(0.02)

        self.assertEqual(grader.call_count, 7)
        self.assertEqual(maximum_active, 3)
        self.assertEqual(set(started[:3]), {"Anna", "Beta", "Charlie"})
        self.assertEqual(set(started[3:6]), {"Delta", "Echo", "Foxtrot"})
        self.assertEqual(started[6], "Zebra")
        self.assertLess(
            max(events.index(("done", name)) for name in ("Anna", "Beta", "Charlie")),
            min(events.index(("start", name)) for name in ("Delta", "Echo", "Foxtrot")),
        )
        self.assertEqual(statuses, ["completed"] * 7)

    def test_ai_grade_rejects_unsupported_or_unexplained_scores(self):
        for raw in ("9 because it looks fine", '{"score":9,"feedback":"Good"}',
                    '{"strength":"The code has a loop.","deductions":[{"points":11,"reason":"The loop has an incorrect range."}]}',
                    '{"strength":"The code has a loop.","deductions":[{"points":1,"reason":"bad"}]}'):
            with self.assertRaises(ValueError):
                eagle._parse_assignment_ai_result(raw, 10)

    def test_rigor_scales_core_objective_execution_and_incidental_deductions(self):
        raw = json.dumps({
            "effort": "clear", "strength": "The code includes a loop and an output statement.",
            "deductions": [
                {"points": 40, "category": "core", "reason": "The required loop does not process the input list."},
                {"points": 20, "category": "objective", "reason": "The requested summary is absent from the result."},
                {"points": 10, "category": "execution", "reason": "An undefined name prevents the main function from running."},
                {"points": 8, "category": "incidental", "reason": "The variable names make the code harder to follow."},
            ],
        })
        low, low_feedback = eagle._parse_assignment_ai_result(raw, 100, rigor=1)
        middle, _ = eagle._parse_assignment_ai_result(raw, 100, rigor=6)
        high, high_feedback = eagle._parse_assignment_ai_result(raw, 100, rigor=10)
        self.assertEqual(low, 70)
        self.assertNotIn("undefined name", low_feedback)
        self.assertEqual(middle, 24)
        self.assertEqual(high, 22)
        self.assertIn("• −2 points — The variable names", high_feedback)

    def test_low_rigor_ignores_mislabeled_syntax_and_secondary_objectives(self):
        raw = json.dumps({
            "effort": "clear", "strength": "The code demonstrates a loop over the input list.",
            "deductions": [
                {"points": 20, "category": "core", "reason": "A syntax error prevents the program from running."},
                {"points": 15, "category": "objective", "reason": "The optional summary is not printed at the end."},
                {"points": 20, "category": "core", "reason": "The required loop never processes any input values."},
            ],
        })
        for rigor in (1, 2, 3, 4):
            score, feedback = eagle._parse_assignment_ai_result(raw, 100, rigor=rigor, syntax_error="invalid syntax")
            self.assertGreaterEqual(score, 75)
            self.assertNotIn("syntax error", feedback.lower())
            self.assertNotIn("optional summary", feedback.lower())
            self.assertIn("required loop", feedback)
            self.assertIn("Points deducted\n•", feedback)

    def test_no_effort_is_low_at_all_rigor_levels_and_high_rigor_checks_syntax(self):
        raw = json.dumps({"effort": "none", "strength": "No demonstrated requirements", "deductions": []})
        for rigor in (1, 5, 10):
            score, feedback = eagle._parse_assignment_ai_result(raw, 100, rigor=rigor)
            self.assertEqual(score, 20)
            self.assertIn("No substantive attempt", feedback)
        attempt = json.dumps({"effort": "clear", "strength": "The code uses a loop to print values.", "deductions": []})
        self.assertEqual(eagle._parse_assignment_ai_result(attempt, 100, rigor=1, syntax_error="invalid syntax")[0], 100)
        strict_score, strict_feedback = eagle._parse_assignment_ai_result(attempt, 100, rigor=10, syntax_error="invalid syntax")
        self.assertEqual(strict_score, 55)
        self.assertIn("program cannot run", strict_feedback)

    def test_rigor_guidance_moves_from_effort_to_all_objectives(self):
        self.assertIn("genuine attempt", eagle._assignment_rigor_guidance(1))
        self.assertIn("most stated objectives", eagle._assignment_rigor_guidance(6))
        self.assertIn("every stated objective", eagle._assignment_rigor_guidance(10))
        self.assertIn("at most 2 points", eagle._assignment_rigor_guidance(10))

    def test_student_assignment_list_exposes_scores_but_not_ai_feedback(self):
        assignment = self.create_assignment(active=True)
        self.submit_code(assignment)
        loaded = eagle._load_assignment(assignment["id"])
        loaded["submissions"][0].update({"codeScore": 8, "totalScore": 8, "aiFeedback": "Teacher-only rationale"})
        self.assertTrue(eagle._save_assignment(loaded))
        response = self.client.get("/api/assignments", headers=self.student_headers)
        self.assertEqual(response.status_code, 200)
        student_assignment = response.get_json()["assignments"][0]
        self.assertEqual(student_assignment["studentSubmissionSummary"]["codeScore"], 8)
        self.assertNotIn("Teacher-only rationale", response.get_data(as_text=True))

        shared = self.client.post(
            "/api/assignments/update",
            headers=self.teacher_headers,
            json={"assignmentId": assignment["id"], "shareAiFeedback": True},
        )
        self.assertEqual(shared.status_code, 200)
        response = self.client.get("/api/assignments", headers=self.student_headers)
        self.assertEqual(response.get_json()["assignments"][0]["studentSubmissionSummary"]["aiFeedback"], "Teacher-only rationale")

    def test_past_assignments_include_preserved_submission_but_never_unreleased_drafts(self):
        draft = self.create_assignment(name="Teacher Draft")
        released = self.create_assignment(name="Released Work", active=True)
        self.submit_code(released)
        source = eagle._get_user_dir(self.student_email) / "answer.py"
        source.unlink()
        loaded = eagle._load_assignment(released["id"])
        loaded["submissions"][0].update({"codeScore": 9, "totalScore": 9, "aiFeedback": "Private first"})
        self.assertTrue(eagle._save_assignment(loaded))
        locked = self.client.post(
            "/api/assignments/update",
            headers=self.teacher_headers,
            json={"assignmentId": released["id"], "active": False},
        )
        self.assertEqual(locked.status_code, 200)

        history = self.client.get(f"/api/assignments/past?classId={self.class_one}", headers=self.student_headers)
        self.assertEqual(history.status_code, 200)
        rows = history.get_json()["assignments"]
        self.assertEqual([row["id"] for row in rows], [released["id"]])
        self.assertNotEqual(rows[0]["id"], draft["id"])
        self.assertIn("for i in range(3)", rows[0]["studentSubmission"]["code"])
        self.assertEqual(rows[0]["studentSubmission"]["totalScore"], 9)
        self.assertEqual(rows[0]["studentSubmission"]["aiFeedback"], "")

        shared = self.client.post(
            "/api/assignments/update",
            headers=self.teacher_headers,
            json={"assignmentId": released["id"], "shareAiFeedback": True},
        )
        self.assertEqual(shared.status_code, 200)
        history = self.client.get(f"/api/assignments/past?classId={self.class_one}", headers=self.student_headers)
        self.assertEqual(history.get_json()["assignments"][0]["studentSubmission"]["aiFeedback"], "Private first")

    def test_teacher_can_view_and_cancel_one_grading_queue_item(self):
        assignment = self.create_assignment(active=True)
        self.submit_code(assignment)
        loaded = eagle._load_assignment(assignment["id"])
        loaded["submissions"][0]["aiGradingStatus"] = "queued"
        loaded["submissions"][0]["aiQueuedAt"] = "2026-09-29T12:00:00+00:00"
        self.assertTrue(eagle._save_assignment(loaded))
        key = (assignment["id"], self.student_email)
        with eagle._assignment_ai_queue_lock:
            eagle._assignment_ai_queued_keys.add(key)
        try:
            queue = self.client.get("/api/assignments/ai-queue", headers=self.teacher_headers)
            self.assertEqual(queue.status_code, 200)
            self.assertEqual(queue.get_json()["jobs"][0]["studentEmail"], self.student_email)
            canceled = self.client.post(
                "/api/assignments/ai-queue/cancel",
                headers=self.teacher_headers,
                json={"assignmentId": assignment["id"], "studentEmail": self.student_email},
            )
            self.assertEqual(canceled.status_code, 200)
            self.assertTrue(canceled.get_json()["canceled"])
            self.assertEqual(eagle._load_assignment(assignment["id"])["submissions"][0]["aiGradingStatus"], "canceled")
        finally:
            with eagle._assignment_ai_queue_lock:
                eagle._assignment_ai_queued_keys.discard(key)
                eagle._assignment_ai_cancelled_keys.discard(key)

    def test_student_submission_response_excludes_ai_grading_fields(self):
        assignment = self.create_assignment(active=True)
        submission = self.submit_code(assignment)
        self.assertNotIn("aiFeedback", submission)
        self.assertNotIn("aiGradingError", submission)
        self.assertNotIn("aiSuggestedScore", submission)

    def test_grade_export_supports_points_and_one_decimal_percent(self):
        assignment = self.create_assignment(active=True)
        self.submit_code(assignment)
        scored = self.client.post(
            "/api/assignments/score",
            headers=self.teacher_headers,
            json={"assignmentId": assignment["id"], "studentEmail": self.student_email, "score": 8},
        )
        self.assertEqual(scored.status_code, 200)

        points = self.client.get(f"/api/assignments/{assignment['id']}/csv?format=points", headers=self.teacher_headers)
        percent = self.client.get(f"/api/assignments/{assignment['id']}/csv?format=percent", headers=self.teacher_headers)
        self.assertEqual(points.status_code, 200)
        self.assertEqual(percent.status_code, 200)
        points_rows = list(csv.reader(io.StringIO(points.get_data(as_text=True))))
        percent_rows = list(csv.reader(io.StringIO(percent.get_data(as_text=True))))
        self.assertEqual(points_rows[0], ["Student Number", "Score"])
        self.assertIn(["123456", "8"], points_rows)
        self.assertIn(["654321", ""], points_rows)
        self.assertIn(["123456", "80.0%"], percent_rows)


if __name__ == "__main__":
    unittest.main()
