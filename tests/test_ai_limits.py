import builtins
import getpass
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


_ORIGINAL_INPUT = builtins.input
_ORIGINAL_GETPASS = getpass.getpass
builtins.input = lambda _prompt="": "admin@eagleide.local"
getpass.getpass = lambda _prompt="": "password"

import app as eagle  # noqa: E402

builtins.input = _ORIGINAL_INPUT
getpass.getpass = _ORIGINAL_GETPASS


class _Response:
    headers = {}
    status_code = 200

    def raise_for_status(self):
        return None

    def iter_content(self, chunk_size=16384):
        yield b'{"response":"bounded response"}'

    def close(self):
        return None


class AiLimitTestCase(unittest.TestCase):
    def setUp(self):
        self.client = eagle.app.test_client()
        self.original_limit = eagle.MAX_AI_REQUESTS_PER_MINUTE
        self.original_prompt_limit = eagle.MAX_AI_PROMPT_CHARS
        with eagle._ai_lock:
            eagle._ai_request_history.clear()
            eagle._ai_cache.clear()
            eagle._ai_consecutive_failures = 0
            eagle._ai_circuit_open_until = 0.0
            for key in eagle._ai_metrics:
                eagle._ai_metrics[key] = 0

    def tearDown(self):
        eagle.MAX_AI_REQUESTS_PER_MINUTE = self.original_limit
        eagle.MAX_AI_PROMPT_CHARS = self.original_prompt_limit
        with eagle._ai_lock:
            eagle._ai_request_history.clear()
            eagle._ai_cache.clear()
            eagle._ai_consecutive_failures = 0
            eagle._ai_circuit_open_until = 0.0

    def test_duplicate_ai_prompt_uses_bounded_cache(self):
        with eagle.app.test_request_context("/api/explain", method="POST"):
            with mock.patch.object(eagle.requests, "post", return_value=_Response()) as post:
                first = eagle.call_ollama_generate("http://127.0.0.1:11434", "model", "prompt")
                second = eagle.call_ollama_generate("http://127.0.0.1:11434", "model", "prompt")

        self.assertTrue(first["ok"])
        self.assertTrue(second["ok"])
        self.assertTrue(second["cached"])
        self.assertEqual(post.call_count, 1)

    def test_ai_rate_and_prompt_limits_reject_before_network(self):
        eagle.MAX_AI_REQUESTS_PER_MINUTE = 1
        eagle.MAX_AI_PROMPT_CHARS = 10
        with eagle.app.test_request_context("/api/explain", method="POST"):
            with mock.patch.object(eagle.requests, "post", return_value=_Response()) as post:
                too_large = eagle.call_ollama_generate("http://127.0.0.1:11434", "model", "x" * 11)
                accepted = eagle.call_ollama_generate("http://127.0.0.1:11434", "model", "one")
                rejected = eagle.call_ollama_generate("http://127.0.0.1:11434", "model", "two")

        self.assertFalse(too_large["ok"])
        self.assertTrue(accepted["ok"])
        self.assertFalse(rejected["ok"])
        self.assertIn("limit", rejected["error"].lower())
        self.assertEqual(post.call_count, 1)

    def test_ai_url_rejects_credentials(self):
        with eagle.app.test_request_context("/api/explain", method="POST"):
            result = eagle.call_ollama_generate("http://user:secret@127.0.0.1:11434", "model", "prompt")
        self.assertFalse(result["ok"])
        self.assertIn("without embedded credentials", result["error"].lower())

    def test_admin_model_setting_persists_and_drives_generation(self):
        original_persist_file = eagle.PERSIST_FILE
        original_cache = eagle._cfg_cache
        original_cache_mtime = eagle._cfg_cache_mtime_ns
        admin_token = "ai-settings-admin-token"
        eagle._admin_tokens.add(admin_token)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                eagle.PERSIST_FILE = Path(tmp) / "config.txt"
                eagle._cfg_cache = None
                eagle._cfg_cache_mtime_ns = None
                eagle._save_config(dict(eagle.DEFAULT_CONFIG))

                saved = self.client.post(
                    "/api/config/save",
                    headers={"X-Admin-Token": admin_token},
                    json={
                        "data": {
                            "ai_ollama_url": "http://127.0.0.1:11434/",
                            "ai_model": "deepseek-coder:6.7b",
                            "ai_request_timeout_seconds": 180,
                        }
                    },
                )
                self.assertEqual(saved.status_code, 200)
                self.assertEqual(saved.get_json()["data"]["ai_model"], "deepseek-coder:6.7b")
                stored = json.loads(eagle.PERSIST_FILE.read_text(encoding="utf-8"))
                self.assertEqual(stored["ai_model"], "deepseek-coder:6.7b")
                self.assertEqual(stored["ai_ollama_url"], "http://127.0.0.1:11434")
                self.assertEqual(stored["ai_request_timeout_seconds"], 180)

                with mock.patch.object(eagle.requests, "post", return_value=_Response()) as post:
                    explained = self.client.post("/api/explain", json={"code": "print('hello')"})
                self.assertEqual(explained.status_code, 200)
                request_kwargs = post.call_args.kwargs
                self.assertEqual(request_kwargs["json"]["model"], "deepseek-coder:6.7b")
                self.assertEqual(request_kwargs["timeout"], (3.0, 180.0))
        finally:
            eagle._admin_tokens.discard(admin_token)
            eagle.PERSIST_FILE = original_persist_file
            eagle._cfg_cache = original_cache
            eagle._cfg_cache_mtime_ns = original_cache_mtime

    def test_ai_timeout_and_connection_errors_do_not_expose_server_details(self):
        with eagle.app.test_request_context("/api/explain", method="POST"):
            with mock.patch.object(
                eagle.requests,
                "post",
                side_effect=eagle.requests.exceptions.Timeout("/root/EagleIDE/private"),
            ):
                result = eagle.call_ollama_generate(
                    "http://127.0.0.1:11434",
                    "deepseek-coder:6.7b",
                    "prompt",
                    timeout=30,
                )
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], 504)
        self.assertNotIn("/root", result["error"])
        self.assertIn("30 seconds", result["error"])

    def test_admin_ai_test_validates_model_name(self):
        token = "ai-test-admin-token"
        eagle._admin_tokens.add(token)
        try:
            response = self.client.post(
                "/api/admin/ai/test",
                headers={"X-Admin-Token": token},
                json={
                    "ai_ollama_url": "http://127.0.0.1:11434",
                    "ai_model": "../invalid model",
                    "ai_request_timeout_seconds": 120,
                },
            )
        finally:
            eagle._admin_tokens.discard(token)
        self.assertEqual(response.status_code, 400)
        self.assertIn("valid ollama model", response.get_json()["error"].lower())


if __name__ == "__main__":
    unittest.main()
