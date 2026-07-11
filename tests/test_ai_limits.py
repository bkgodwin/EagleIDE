import builtins
import getpass
import unittest
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
        self.assertIn("invalid", result["error"].lower())


if __name__ == "__main__":
    unittest.main()
