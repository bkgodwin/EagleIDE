import builtins
import getpass
import io
import json
import shutil
import tempfile
import time
import unittest
from pathlib import Path


_ORIGINAL_INPUT = builtins.input
_ORIGINAL_GETPASS = getpass.getpass
builtins.input = lambda _prompt="": "admin@eagleide.local"
getpass.getpass = lambda _prompt="": "password"

import app as eagle  # noqa: E402

builtins.input = _ORIGINAL_INPUT
getpass.getpass = _ORIGINAL_GETPASS


class ExecutionLimitTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.user_files_dir = self.root / "user_files"
        self.sandbox_dir = self.root / "sandboxes"
        self.user_files_dir.mkdir()
        self.sandbox_dir.mkdir()

        self.original_user_files_dir = eagle.USER_FILES_DIR
        self.original_sandbox_dir = eagle.SANDBOX_DIR
        self.original_classes_file = eagle.CLASSES_FILE
        self.original_output_bytes = eagle.MAX_OUTPUT_BYTES
        self.original_wall_time = eagle.MAX_WALL_TIME
        self.original_interactive_wall_time = eagle.MAX_INTERACTIVE_WALL_TIME
        self.original_max_concurrent_runs = eagle.MAX_CONCURRENT_RUNS
        self.original_run_write_bytes = eagle.MAX_RUN_WRITE_BYTES
        self.original_editor_bytes = eagle.MAX_EDITOR_FILE_BYTES
        self.original_teacher_stream_bytes = eagle.MAX_TEACHER_STREAM_CODE_BYTES
        eagle.USER_FILES_DIR = self.user_files_dir
        eagle.SANDBOX_DIR = self.sandbox_dir
        eagle.CLASSES_FILE = self.root / "classes.json"
        eagle._stop_all_runners()
        eagle._run_start_history.clear()
        eagle._run_history_last_seen.clear()
        eagle._stdin_event_history.clear()

        self.email = "runner.student@example.com"
        self.token = "runner-student-token"
        eagle._student_tokens[self.token] = {
            "email": self.email,
            "name": "Runner Student",
            "role": "student",
            "class_id": None,
            "class_ids": [],
        }
        self.user_dir = eagle._get_user_dir(self.email)
        self.user_dir.mkdir(parents=True, exist_ok=True)
        self.teacher_token = "runner-teacher-token"
        self.teacher_email = "runner.teacher@example.com"
        eagle._teacher_tokens[self.teacher_token] = {
            "email": self.teacher_email,
            "name": "Runner Teacher",
            "role": "teacher",
        }
        eagle.CLASSES_FILE.write_text(
            json.dumps({
                "classes": [{
                    "id": "owned-class",
                    "name": "Owned Class",
                    "teacher_email": self.teacher_email,
                    "join_code": "RUN123",
                    "students": [],
                    "settings": {},
                }, {
                    "id": "other-class",
                    "name": "Other Class",
                    "teacher_email": "other.teacher@example.com",
                    "join_code": "OTH123",
                    "students": [],
                    "settings": {},
                }]
            }),
            encoding="utf-8",
        )
        self.http = eagle.app.test_client()
        self.socket_clients = []

    def tearDown(self):
        for client in self.socket_clients:
            try:
                if client.is_connected():
                    client.disconnect()
            except Exception:
                pass
        eagle._stop_all_runners()
        eagle._student_tokens.pop(self.token, None)
        eagle._teacher_tokens.pop(self.teacher_token, None)
        eagle._teacher_code_snapshots.pop("owned-class", None)
        eagle._teacher_code_snapshots.pop("other-class", None)
        eagle._teacher_stream_last_emit.clear()
        eagle._run_start_history.clear()
        eagle._run_history_last_seen.clear()
        eagle._stdin_event_history.clear()
        eagle.MAX_OUTPUT_BYTES = self.original_output_bytes
        eagle.MAX_WALL_TIME = self.original_wall_time
        eagle.MAX_INTERACTIVE_WALL_TIME = self.original_interactive_wall_time
        eagle.MAX_CONCURRENT_RUNS = self.original_max_concurrent_runs
        eagle.MAX_RUN_WRITE_BYTES = self.original_run_write_bytes
        eagle.MAX_EDITOR_FILE_BYTES = self.original_editor_bytes
        eagle.MAX_TEACHER_STREAM_CODE_BYTES = self.original_teacher_stream_bytes
        eagle.USER_FILES_DIR = self.original_user_files_dir
        eagle.SANDBOX_DIR = self.original_sandbox_dir
        eagle.CLASSES_FILE = self.original_classes_file
        self.tmp.cleanup()

    def _socket(self):
        client = eagle.socketio.test_client(eagle.app, flask_test_client=self.http)
        self.assertTrue(client.is_connected())
        client.get_received()
        self.socket_clients.append(client)
        return client

    @staticmethod
    def _collect_until_finished(client, timeout=8.0):
        events = []
        deadline = time.time() + timeout
        while time.time() < deadline:
            events.extend(client.get_received())
            if any(event.get("name") == "finished" for event in events):
                break
            eagle.socketio.sleep(0.02)
        return events

    @staticmethod
    def _output(events):
        return "".join(
            str((event.get("args") or [{}])[0].get("data") or "")
            for event in events
            if event.get("name") == "output"
        )

    def _payload(self, code, token=None):
        return {
            "code": code,
            "language": "python",
            "user_token": self.token if token is None else token,
            "teacher_token": "",
            "admin_token": "",
            "file_path": "",
        }

    def _javascript_payload(self, code):
        payload = self._payload(code)
        payload["language"] = "javascript"
        return payload

    def test_valid_python_run_finishes_and_releases_capacity(self):
        client = self._socket()
        client.emit("run_code", self._payload("print('safe hello')"))
        events = self._collect_until_finished(client)

        self.assertIn("safe hello", self._output(events))
        self.assertTrue(any(event.get("name") == "run_ack" for event in events))
        names = [event.get("name") for event in events]
        self.assertLess(names.index("run_ack"), names.index("finished"))
        self.assertNotIn(client.eio_sid, eagle._active_runs_by_sid)

    @unittest.skipUnless(eagle.NODE_EXECUTABLE != "node" or shutil.which("node"), "Node.js is not installed")
    def test_valid_javascript_run_finishes_and_releases_capacity(self):
        client = self._socket()
        client.emit("run_code", self._javascript_payload("console.log('safe javascript')"))
        events = self._collect_until_finished(client)

        self.assertIn("safe javascript", self._output(events))
        self.assertTrue(any(event.get("name") == "run_ack" for event in events))
        self.assertFalse(eagle._active_runs_by_sid)

    @unittest.skipUnless(eagle.NODE_EXECUTABLE != "node" or shutil.which("node"), "Node.js is not installed")
    def test_infinite_javascript_loop_is_stopped(self):
        eagle.MAX_WALL_TIME = 0.25
        eagle.MAX_INTERACTIVE_WALL_TIME = 1.0
        client = self._socket()
        client.emit("run_code", self._javascript_payload("while (true) {}"))
        events = self._collect_until_finished(client, timeout=4.0)

        self.assertTrue(any(event.get("name") == "finished" for event in events))
        self.assertFalse(eagle._active_runs_by_sid)

    def test_invalid_token_cannot_fall_back_to_guest_execution(self):
        client = self._socket()
        client.emit("run_code", self._payload("print('must not run')", token="invalid-token"))
        events = self._collect_until_finished(client)

        output = self._output(events)
        self.assertIn("invalid or expired student session", output)
        self.assertNotIn("must not run", output)
        self.assertFalse(eagle._active_runs_by_sid)

    def test_alternate_file_api_cannot_read_outside_workspace(self):
        secret = self.root / "outside-secret.txt"
        secret.write_text("OUTSIDE_SECRET_VALUE", encoding="utf-8")
        client = self._socket()
        code = f"from pathlib import Path\nprint(Path({str(secret)!r}).read_text())"
        client.emit("run_code", self._payload(code))
        events = self._collect_until_finished(client)

        output = self._output(events)
        self.assertNotIn("OUTSIDE_SECRET_VALUE", output)
        self.assertIn("PermissionError", output)

    def test_pathlib_still_reads_and_writes_inside_workspace(self):
        client = self._socket()
        code = "from pathlib import Path\np = Path('pathlib-safe.txt')\np.write_text('pathlib safe')\nprint(p.read_text())"
        client.emit("run_code", self._payload(code))
        events = self._collect_until_finished(client)

        self.assertIn("pathlib safe", self._output(events))
        self.assertEqual((self.user_dir / "pathlib-safe.txt").read_text(encoding="utf-8"), "pathlib safe")

    def test_common_imports_os_listing_home_and_tempfiles_still_work(self):
        client = self._socket()
        code = (
            "import csv, json, math, os, random, tempfile\n"
            "from pathlib import Path\n"
            "with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.txt') as handle:\n"
            "    handle.write('temporary safe')\n"
            "    temp_name = handle.name\n"
            "print(math.sqrt(9), Path.home() == Path.cwd(), Path(temp_name).read_text(), isinstance(os.listdir('.'), list))\n"
            "Path(temp_name).unlink()\n"
        )
        client.emit("run_code", self._payload(code))
        events = self._collect_until_finished(client)

        self.assertIn("3.0 True temporary safe True", self._output(events))

    def test_pathlib_cannot_bypass_per_run_write_budget(self):
        eagle.MAX_RUN_WRITE_BYTES = 1024
        client = self._socket()
        client.emit(
            "run_code",
            self._payload("from pathlib import Path\nPath('too-large.bin').write_bytes(b'x' * 2048)"),
        )
        events = self._collect_until_finished(client)

        self.assertIn("OSError", self._output(events))
        target = self.user_dir / "too-large.bin"
        self.assertLessEqual(target.stat().st_size if target.exists() else 0, 1024)

    def test_sys_modules_cannot_bypass_process_restrictions(self):
        client = self._socket()
        client.emit("run_code", self._payload("import sys\nsys.modules['os'].system('echo unsafe')"))
        events = self._collect_until_finished(client)

        output = self._output(events)
        self.assertNotIn("\nunsafe\n", output)
        self.assertIn("PermissionError", output)

    def test_hard_link_destination_cannot_escape_workspace(self):
        outside_link = self.root / "outside-hardlink.txt"
        client = self._socket()
        code = (
            "import os\n"
            "with open('link-source.txt', 'w') as handle:\n"
            "    handle.write('safe source')\n"
            f"os.link('link-source.txt', {str(outside_link)!r})\n"
        )
        client.emit("run_code", self._payload(code))
        events = self._collect_until_finished(client)

        self.assertIn("PermissionError", self._output(events))
        self.assertFalse(outside_link.exists())

    def test_same_account_cannot_run_in_two_tabs(self):
        first = self._socket()
        second = self._socket()
        first.emit("run_code", self._payload("input('Waiting: ')"))

        first_events = []
        deadline = time.time() + 5
        while time.time() < deadline and eagle.INPUT_TOKEN not in self._output(first_events):
            first_events.extend(first.get_received())
            eagle.socketio.sleep(0.02)
        self.assertIn(eagle.INPUT_TOKEN, self._output(first_events))

        second.emit("run_code", self._payload("print('second tab')"))
        second_events = self._collect_until_finished(second)
        self.assertIn("already has a program running in another tab", self._output(second_events))
        self.assertNotIn("second tab", self._output(second_events))

        first.emit("stop", {})
        self._collect_until_finished(first)

    def test_global_execution_capacity_is_bounded(self):
        eagle.MAX_CONCURRENT_RUNS = 1
        first = {"identity": "account:first@example.com", "role": "student", "guest_ip": ""}
        second = {"identity": "account:second@example.com", "role": "student", "guest_ip": ""}

        admitted, _ = eagle._try_acquire_execution_slot("first-sid", first)
        second_admitted, error = eagle._try_acquire_execution_slot("second-sid", second)

        self.assertTrue(admitted)
        self.assertFalse(second_admitted)
        self.assertIn("capacity is busy", error)
        eagle._release_execution_slot("first-sid")

    def test_newline_free_output_is_bounded(self):
        eagle.MAX_OUTPUT_BYTES = 1024
        client = self._socket()
        client.emit("run_code", self._payload("print('x' * 5000, end='')"))
        events = self._collect_until_finished(client)

        self.assertIn("Output limit exceeded", self._output(events))
        self.assertFalse(eagle._active_runs_by_sid)

    def test_sparse_flushed_output_arrives_before_process_finishes(self):
        client = self._socket()
        client.emit(
            "run_code",
            self._payload("import time\nprint('first chunk', flush=True)\ntime.sleep(0.5)\nprint('second chunk')"),
        )
        early_events = []
        deadline = time.time() + 0.35
        while time.time() < deadline and "first chunk" not in self._output(early_events):
            early_events.extend(client.get_received())
            eagle.socketio.sleep(0.01)

        self.assertIn("first chunk", self._output(early_events))
        self.assertFalse(any(event.get("name") == "finished" for event in early_events))
        remaining = self._collect_until_finished(client)
        self.assertIn("second chunk", self._output(remaining))

    def test_infinite_loop_is_stopped_by_parent_deadline(self):
        eagle.MAX_WALL_TIME = 0.25
        eagle.MAX_INTERACTIVE_WALL_TIME = 1.0
        client = self._socket()
        client.emit("run_code", self._payload("while True:\n    pass"))
        events = self._collect_until_finished(client, timeout=4.0)

        self.assertIn("active wall-time limit", self._output(events))
        self.assertFalse(eagle._active_runs_by_sid)

    def test_file_write_rejects_oversized_editor_content(self):
        eagle.MAX_EDITOR_FILE_BYTES = 32
        response = self.http.post(
            "/api/files/write",
            headers={"X-User-Token": self.token},
            json={"path": "large.py", "content": "x" * 33},
        )

        self.assertEqual(response.status_code, 413)
        self.assertFalse((self.user_dir / "large.py").exists())

    def test_multipart_upload_above_form_memory_threshold_still_streams(self):
        content = b"x" * (3 * 1024 * 1024)
        stream = io.BytesIO(content)
        try:
            response = self.http.post(
                "/api/files/upload",
                headers={"X-User-Token": self.token},
                data={"file": (stream, "streamed.txt"), "parent": ""},
                content_type="multipart/form-data",
            )
        finally:
            stream.close()

        self.assertEqual(response.status_code, 200)
        self.assertEqual((self.user_dir / "streamed.txt").stat().st_size, len(content))
        response.request.close()
        response.request.environ["wsgi.input"].close()
        response.close()

    def test_teacher_stream_requires_class_ownership_and_size_limit(self):
        client = self._socket()
        client.emit("teacher_code_update", {
            "token": self.teacher_token,
            "role": "teacher",
            "class_id": "other-class",
            "code": "print('not owned')",
            "language": "python",
        })
        self.assertNotIn("other-class", eagle._teacher_code_snapshots)

        eagle.MAX_TEACHER_STREAM_CODE_BYTES = 8
        client.emit("teacher_code_update", {
            "token": self.teacher_token,
            "role": "teacher",
            "class_id": "owned-class",
            "code": "print('too large')",
            "language": "python",
        })
        self.assertNotIn("owned-class", eagle._teacher_code_snapshots)

        client.emit("teacher_code_update", {
            "token": self.teacher_token,
            "role": "teacher",
            "class_id": "owned-class",
            "code": "x = 1",
            "language": "python",
        })
        self.assertEqual(eagle._teacher_code_snapshots.get("owned-class"), "x = 1")


if __name__ == "__main__":
    unittest.main()
