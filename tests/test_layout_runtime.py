"""Dependency-free browser-layout controller regressions, using Node when available."""
import os
from pathlib import Path
import shutil
import subprocess
import unittest


BASE_DIR = Path(__file__).resolve().parents[1]


class LayoutRuntimeTestCase(unittest.TestCase):
    def test_touch_and_desktop_layout_controllers(self):
        node = os.environ.get("NODE_BINARY") or shutil.which("node")
        if not node:
            self.skipTest("Node.js is not installed")
        result = subprocess.run(
            [node, str(BASE_DIR / "tests" / "layout_runtime_checks.js")],
            cwd=BASE_DIR, capture_output=True, text=True, timeout=20,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
