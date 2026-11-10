"""Workspace history, submission pins, deadlines, and cleanup regressions."""
import time
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import assignment_development as legacy
import assignment_workflow as workflow
import workspace_history as history
import test_assignment_workflow as fixtures

eagle = fixtures.eagle


class WorkspaceHistoryTests(unittest.TestCase):
    setUp = fixtures.AssignmentSubmissionTestCase.setUp
    tearDown = fixtures.AssignmentSubmissionTestCase.tearDown
    teacher_headers = fixtures.AssignmentSubmissionTestCase.teacher_headers
    student_headers = fixtures.AssignmentSubmissionTestCase.student_headers
    create_assignment = fixtures.AssignmentSubmissionTestCase.create_assignment
    update = fixtures.AssignmentSubmissionTestCase.update
    configure_class = fixtures.AssignmentSubmissionTestCase.configure_class

    def open_file(self, name, content):
        root = eagle._get_user_dir(self.student_email)
        target = root / name
        target.write_text(content, encoding="utf-8")
        response = self.client.get("/api/files/read", query_string={"path": name}, headers=self.student_headers)
        self.assertEqual(response.status_code, 200)
        return root, response.json["workspaceHistory"]["id"]

    def record(self, file_id, base, content, received, version=0, ranges=None):
        return {"fileId": file_id, "version": version, "batchId": uuid.uuid4().hex, "base": base,
                "frames": [{**legacy.splice(base, content), "at": received, "pasteRanges": ranges or []}]}

    def submit(self, assignment, *files):
        response = self.client.post("/api/assignments/submit", headers=self.student_headers,
                                    json={"assignmentId": assignment["id"], "filePaths": files})
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return response.json["submission"]

    def playback(self, assignment, submission=None, **extra):
        params = {"assignmentId": assignment["id"], "studentEmail": self.student_email, **extra}
        if submission:
            params.update(revisionId=submission["revisionId"], fileId=submission["files"][0]["id"])
        return self.client.get("/api/assignments/workspace-history", query_string=params, headers=self.teacher_headers)

    def test_pinned_history_follows_rename_and_keeps_paste_ranges_and_class_times(self):
        self.configure_class(window={"enabled": False, "start": "08:00", "end": "11:00", "timeZone": "UTC",
                                     "meetingDays": list(range(7))})
        assignment = self.update(self.create_assignment(active=True), allowMultiFileSubmission=True)
        stored = eagle._load_assignment(assignment["id"])
        stored["releasedAt"] = "2020-01-01T00:00:00Z"
        self.assertTrue(eagle._save_assignment(stored))
        root, file_id = self.open_file("answer.py", "x = 0")
        yesterday = datetime.now(timezone.utc) - timedelta(days=1)
        inside = yesterday.replace(hour=9, minute=0, second=0, microsecond=0).timestamp()
        outside = inside + 10 * 3600
        owner = history._owner(root)
        before = self.record(file_id, "x = 0", "x = 1", inside)
        version = history._record(eagle, owner, file_id, before, inside)
        self.assertEqual(history._record(eagle, owner, file_id, before, inside), version)
        self.assertEqual(self.playback(assignment).json["clips"], [])
        self.assertEqual(self.client.post("/api/files/rename", headers=self.student_headers,
                                         json={"old_path": "answer.py", "new_name": "renamed.py"}).status_code, 200)
        reopened = self.client.get("/api/files/read", query_string={"path": "renamed.py"}, headers=self.student_headers)
        self.assertEqual(reopened.json["workspaceHistory"]["id"], file_id)
        after = self.record(file_id, "x = 1", "x = 22", outside, version, [[4, 6]])
        version = history._record(eagle, owner, file_id, after, outside)
        (root / "renamed.py").write_text("x = 22", encoding="utf-8")
        (root / "notes.txt").write_text("A second file", encoding="utf-8")
        submitted = self.submit(assignment, "renamed.py", "notes.txt")
        history._record(eagle, owner, file_id, self.record(file_id, "x = 22", "private next edit", time.time(), version), time.time())
        history.maintenance(eagle)
        page = self.playback(assignment, submitted).json
        self.assertEqual(page["frames"][-1]["pasteRanges"], [[4, 6]])
        self.assertEqual({frame["classTime"] for frame in page["frames"]}, {"inside", "outside"})
        content = page["base"]
        for frame in page["frames"]:
            content = legacy.apply_patch(content, frame)
        self.assertEqual(content, "x = 22")
        self.assertFalse(self.playback(assignment).json["clips"][0]["partial"])
        denied = self.client.get("/api/assignments/workspace-history", headers=self.student_headers,
                                 query_string={"assignmentId": assignment["id"], "studentEmail": self.student_email})
        self.assertEqual(denied.status_code, 401)

        history.maintenance(eagle, time.time() + history.ROLLING_AGE + 1)
        self.assertEqual(self.playback(assignment, submitted).json["total"], page["total"])
        with history.database(eagle) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM frames").fetchone()[0], page["total"])
        result = self.client.post("/api/assignments/grading-complete", headers=self.teacher_headers,
                                  json={"assignmentId": assignment["id"]})
        self.assertEqual(result.json["historyCleanup"], "pending")
        self.assertEqual(self.playback(assignment, submitted).json["total"], 0)
        history.maintenance(eagle, time.time() + history.ROLLING_AGE + 2)
        with history.database(eagle) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM frames").fetchone()[0], 0)
            self.assertIsNotNone(db.execute("SELECT completed FROM cleanup").fetchone()[0])
        self.assertTrue((root / "renamed.py").exists())
        self.assertTrue(eagle._load_assignment(assignment["id"])["submissions"])

    def test_finalize_removes_recent_exclusive_frames_but_preserves_shared_history(self):
        a = self.create_assignment(active=True)
        other = self.create_assignment(active=True, name="Shared follow-up")
        root, file_id = self.open_file("shared.py", "x = 0")
        now = time.time()
        for assignment, release in [(a, now - 120), (other, now - 45)]:
            stored = eagle._load_assignment(assignment["id"])
            stored["releasedAt"] = workflow.iso(datetime.fromtimestamp(release, timezone.utc))
            self.assertTrue(eagle._save_assignment(stored))
        owner = history._owner(root)
        version = history._record(eagle, owner, file_id, self.record(file_id, "x = 0", "x = 1", now - 90), now - 90)
        version = history._record(eagle, owner, file_id, self.record(file_id, "x = 1", "x = 2", now - 30, version), now - 30)
        (root / "shared.py").write_text("x = 2", encoding="utf-8")
        self.submit(a, "shared.py")
        shared = self.submit(other, "shared.py")
        history.maintenance(eagle)
        self.assertEqual(self.client.post("/api/assignments/grading-complete", headers=self.teacher_headers,
                                         json={"assignmentId": a["id"]}).status_code, 200)
        history.maintenance(eagle)
        with history.database(eagle) as db:
            self.assertEqual([r["seq"] for r in db.execute("SELECT seq FROM frames WHERE file=?", (file_id,))], [version])
        remaining = self.playback(other, shared).json
        self.assertEqual(remaining["total"], 1)
        self.assertEqual(remaining["frames"][0]["insert"], "x = 2")

    def test_turn_in_captures_latest_saved_text_when_editor_samples_are_behind(self):
        assignment = self.create_assignment(active=True)
        root, file_id = self.open_file("late.py", "x = 0")
        stamp = time.time()
        history._record(eagle, history._owner(root), file_id, self.record(file_id, "x = 0", "x = 1", stamp), stamp)
        (root / "late.py").write_text("x = 2", encoding="utf-8")
        submitted = self.submit(assignment, "late.py")
        history.maintenance(eagle)
        index = self.playback(assignment, submitted, index=1).json
        self.assertTrue(index["partial"])
        page = self.playback(assignment, submitted).json
        content = page["base"]
        for frame in page["frames"]:
            content = legacy.apply_patch(content, frame)
        self.assertEqual(content, "x = 2")

    def test_record_route_checks_revision_capacity_and_keeps_saves_available(self):
        root, file_id = self.open_file("work.txt", "starter")
        data = self.record(file_id, "starter", "worked", time.time())
        with patch.object(history, "MAX_FILE", 1):
            response = self.client.post("/api/workspace-history/record", headers=self.student_headers, json=data)
            self.assertEqual(response.status_code, 507)
            saved = self.client.post("/api/files/write", headers=self.student_headers,
                                     json={"path": "work.txt", "content": "worked", "workspaceHistorySampled": True})
            self.assertEqual(saved.status_code, 200)
        self.assertEqual((root / "work.txt").read_text(encoding="utf-8"), "worked")
        with patch.object(history, "_last_batches", {}):
            response = self.client.post("/api/workspace-history/record", headers=self.student_headers, json=data)
        self.assertEqual(response.status_code, 200)
        with patch.object(history, "_last_batches", {}):
            conflict = self.client.post("/api/workspace-history/record", headers=self.student_headers,
                                        json={**data, "batchId": uuid.uuid4().hex})
        self.assertEqual(conflict.status_code, 409)
        self.assertNotIn("content", conflict.json)
        trashed = self.client.delete("/api/files/delete", headers=self.student_headers, json={"path": "work.txt"}).json
        self.assertTrue(trashed["trashed"])
        restored = self.client.post("/api/files/restore", headers=self.student_headers, json={"path": trashed["trash_path"]})
        self.assertEqual(restored.status_code, 200)
        self.assertEqual(self.client.get("/api/files/read", headers=self.student_headers,
                                         query_string={"path": "work.txt"}).json["workspaceHistory"]["id"], file_id)

    def test_extension_requests_and_school_day_grants(self):
        self.configure_class(window={"enabled": True, "start": "08:00", "end": "10:00", "dismissal": "15:15",
                                     "timeZone": "America/Chicago", "meetingDays": [0, 2, 4]})
        assignment = self.update(self.create_assignment(active=True), submissionAccess="class")
        friday = datetime(2026, 11, 6, 18, 0, tzinfo=timezone.utc)
        self.assertEqual(workflow.extension_grant(eagle, assignment, self.student_email, 0, friday)["until"],
                         "2026-11-06T21:15:00.000Z")
        self.assertEqual(workflow.extension_grant(eagle, assignment, self.student_email, 1, friday)["until"],
                         "2026-11-09T21:15:00.000Z")
        with self.assertRaises(ValueError):
            workflow.extension_grant(eagle, assignment, self.student_email, 0, friday + timedelta(hours=5))
        endpoint = "/api/assignments/extension-requests"
        body = {"assignmentId": assignment["id"], "reason": "I need another school day.", "days": 2}
        request = self.client.post(endpoint, headers=self.student_headers, json=body)
        self.assertEqual(request.status_code, 200)
        self.assertEqual(self.client.post(endpoint, headers=self.student_headers, json=body).status_code, 409)
        row = self.client.get(endpoint, headers=self.teacher_headers, query_string={"assignmentId": assignment["id"]}).json["requests"][0]
        self.assertEqual(row["reason"], body["reason"])
        decision = {"assignmentId": assignment["id"], "studentEmail": self.student_email,
                    "action": "approve", "requestId": row["id"], "days": 1}
        first = self.client.post("/api/assignments/extend-student", headers=self.teacher_headers, json=decision)
        repeated = self.client.post("/api/assignments/extend-student", headers=self.teacher_headers, json=decision)
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json["request"], repeated.json["request"])
        self.assertEqual(first.json["request"]["approvedDays"], 1)
        saved = eagle._load_assignment(assignment["id"])
        payload = eagle._student_assignment_payload(saved, self.missing_email)
        self.assertIsNone(payload["extensionRequest"])
        self.assertNotIn("extensionRequests", payload)
        self.assertTrue(saved["studentExtensions"][self.student_email]["respectClassHours"])
