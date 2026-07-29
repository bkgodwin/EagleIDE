import builtins
import getpass
import json
import signal
import tempfile
import unittest
from pathlib import Path


_ORIGINAL_INPUT = builtins.input
_ORIGINAL_GETPASS = getpass.getpass
builtins.input = lambda _prompt="": "admin@eagleide.local"
getpass.getpass = lambda _prompt="": "password"

import app as eagle  # noqa: E402

builtins.input = _ORIGINAL_INPUT
getpass.getpass = _ORIGINAL_GETPASS


class ServerLifecycleTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.original_state_file = eagle.SERVER_STATE_FILE
        self.original_events_file = eagle.SERVER_EVENTS_FILE
        self.original_log_file = eagle.APP_LOG_FILE
        self.original_start_recorded = eagle._server_start_recorded
        self.original_stop_recorded = eagle._server_stop_recorded
        eagle.SERVER_STATE_FILE = self.root / "server_state.json"
        eagle.SERVER_EVENTS_FILE = self.root / "server_events.json"
        eagle.APP_LOG_FILE = self.root / "server.log"
        eagle._server_start_recorded = False
        eagle._server_stop_recorded = False

    def tearDown(self):
        eagle.SERVER_STATE_FILE = self.original_state_file
        eagle.SERVER_EVENTS_FILE = self.original_events_file
        eagle.APP_LOG_FILE = self.original_log_file
        eagle._server_start_recorded = self.original_start_recorded
        eagle._server_stop_recorded = self.original_stop_recorded
        self.tmp.cleanup()

    def test_sigterm_records_one_clean_stop_and_next_start_has_no_crash_alert(self):
        eagle._record_server_startup_event()
        with self.assertRaises(SystemExit) as stopped:
            eagle._handle_server_termination(signal.SIGTERM, None)
        self.assertEqual(stopped.exception.code, 0)

        # The normal finally and atexit paths may both run after the signal handler.
        eagle._record_server_stop_event()
        eagle._record_server_stop_event()
        state = json.loads(eagle.SERVER_STATE_FILE.read_text(encoding="utf-8"))
        self.assertFalse(state["running"])

        eagle._server_start_recorded = False
        eagle._record_server_startup_event()
        events = json.loads(eagle.SERVER_EVENTS_FILE.read_text(encoding="utf-8"))
        event_types = [event["type"] for event in events]
        self.assertEqual(event_types, ["server_start", "server_stop", "server_start"])
        self.assertNotIn("server_crash", event_types)
        self.assertEqual(
            eagle.APP_LOG_FILE.read_text(encoding="utf-8").count("Server stopped."),
            1,
        )
        eagle._record_server_stop_event()
