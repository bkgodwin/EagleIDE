import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from sandbox_containment import landlock_status
from sandbox_policy import (
    SECURITY_LOCKED_MODULES,
    disabled_module_roots,
    normalize_module_access,
)


BASE_DIR = Path(__file__).resolve().parents[1]
WORKER = BASE_DIR / "sandbox_worker.py"


class PythonSandboxPolicyTests(unittest.TestCase):
    def _run_worker(
        self,
        workspace: Path,
        source: str,
        *,
        disabled_modules: tuple[str, ...] = (),
        timeout: float = 45.0,
    ) -> subprocess.CompletedProcess[str]:
        code_path = workspace / "student.py"
        code_path.write_text(source, encoding="utf-8")
        env = dict(os.environ)
        env.update(
            {
                "HOME": str(workspace),
                "USERPROFILE": str(workspace),
                "TEMP": str(workspace),
                "TMP": str(workspace),
                "MPLBACKEND": "Agg",
                "EAGLE_MAX_CPU_SECONDS": "8",
                "EAGLE_MAX_MEMORY_BYTES": str(750 * 1024 * 1024),
                "EAGLE_MAX_FILE_BYTES": str(10 * 1024 * 1024),
                "EAGLE_RUN_WRITE_BUDGET_BYTES": str(10 * 1024 * 1024),
                "EAGLE_DISABLED_MODULES": json.dumps(list(disabled_modules)),
                "EAGLE_RUN_SOURCE_NAME": "student.py",
                "EAGLE_NATIVE_CONTAINMENT_DIAGNOSTIC": "1",
                "OMP_NUM_THREADS": "1",
                "OPENBLAS_NUM_THREADS": "1",
                "MKL_NUM_THREADS": "1",
                "NUMEXPR_NUM_THREADS": "1",
            }
        )
        return subprocess.run(
            [sys.executable, "-u", str(WORKER), str(code_path), str(workspace)],
            cwd=workspace,
            env=env,
            text=True,
            capture_output=True,
            timeout=timeout,
            check=False,
        )

    def test_module_policy_keeps_dependencies_consistent_and_security_locked(self):
        access = normalize_module_access({"inspect": False, "matplotlib": True, "unittest": True})

        self.assertFalse(access["inspect"])
        self.assertFalse(access["matplotlib"])
        self.assertFalse(access["unittest"])
        self.assertIn("_sqlite3", disabled_module_roots({"sqlite3": False}))
        self.assertIn("subprocess", SECURITY_LOCKED_MODULES)
        self.assertIn("ctypes", SECURITY_LOCKED_MODULES)
        self.assertIn("_socket", SECURITY_LOCKED_MODULES)

    def test_worker_honors_admin_acl_and_allows_workspace_modules(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            (workspace / "helper.py").write_text("VALUE = 42\n", encoding="utf-8")
            result = self._run_worker(
                workspace,
                (
                    "import helper\n"
                    "print('local', helper.VALUE)\n"
                    "try:\n"
                    "    import time\n"
                    "except ImportError:\n"
                    "    print('time blocked')\n"
                    "else:\n"
                    "    raise AssertionError('disabled time module was imported')\n"
                ),
                disabled_modules=("time",),
            )

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("local 42", result.stdout)
        self.assertIn("time blocked", result.stdout)

    def test_server_only_packages_and_cached_privileged_modules_are_blocked(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            result = self._run_worker(
                workspace,
                (
                    "import importlib, sys\n"
                    "for name in ('flask', 'ctypes', 'subprocess', 'socket'):\n"
                    "    try:\n"
                    "        __import__(name)\n"
                    "    except ImportError:\n"
                    "        print(name, 'blocked')\n"
                    "    else:\n"
                    "        raise AssertionError(name + ' import bypassed policy')\n"
                    "try:\n"
                    "    importlib.reload(sys.modules['subprocess'])\n"
                    "except PermissionError:\n"
                    "    print('reload blocked')\n"
                    "else:\n"
                    "    raise AssertionError('module reload bypassed hardening')\n"
                    "try:\n"
                    "    sys.modules['subprocess'].run(['echo', 'unsafe'])\n"
                    "except PermissionError:\n"
                    "    print('process blocked')\n"
                    "else:\n"
                    "    raise AssertionError('cached subprocess bypassed hardening')\n"
                    "try:\n"
                    "    sys.modules['socket'].socket()\n"
                    "except PermissionError:\n"
                    "    print('socket blocked')\n"
                    "else:\n"
                    "    raise AssertionError('cached socket bypassed hardening')\n"
                ),
            )

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("flask blocked", result.stdout)
        self.assertIn("reload blocked", result.stdout)
        self.assertIn("process blocked", result.stdout)
        self.assertIn("socket blocked", result.stdout)
        self.assertNotIn("unsafe", result.stdout)

    @unittest.skipUnless(sys.platform == "linux", "Landlock is a Linux security boundary")
    def test_landlock_sqlite_matplotlib_and_inspect_integration(self):
        status = landlock_status()
        self.assertTrue(status.get("available"), status.get("reason"))
        with tempfile.TemporaryDirectory() as tmp:
            test_root = Path(tmp)
            workspace = test_root / "workspace"
            workspace.mkdir()
            escaped_database = test_root / "outside.sqlite3"
            escaped_literal = repr(str(escaped_database))
            result = self._run_worker(
                workspace,
                (
                    "from dataclasses import dataclass\n"
                    "import inspect, sqlite3\n"
                    "@dataclass\n"
                    "class Record:\n"
                    "    value: int\n"
                    "assert inspect.isclass(Record)\n"
                    "connection = sqlite3.connect('lesson.sqlite3')\n"
                    "connection.execute('CREATE TABLE scores (name TEXT, score INTEGER)')\n"
                    "connection.execute(\"INSERT INTO scores VALUES ('Ava', 95)\")\n"
                    "connection.commit()\n"
                    "assert connection.execute('SELECT score FROM scores').fetchone()[0] == 95\n"
                    "try:\n"
                    f"    connection.execute('ATTACH DATABASE ? AS escaped', ({escaped_literal},))\n"
                    "except sqlite3.OperationalError:\n"
                    "    print('attach blocked')\n"
                    "else:\n"
                    "    raise AssertionError('SQLite escaped the workspace')\n"
                    "connection.close()\n"
                    "import matplotlib.pyplot as plt\n"
                    "plt.plot([1, 2, 3], [2, 4, 3])\n"
                    "plt.title('Contained chart')\n"
                    "plt.show()\n"
                    "print('native modules complete')\n"
                ),
            )

            chart = workspace / "charts" / "student-figure-1.png"
            database = workspace / "lesson.sqlite3"
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("attach blocked", result.stdout)
            self.assertIn("native modules complete", result.stdout)
            self.assertTrue(database.is_file())
            self.assertEqual(database.read_bytes()[:16], b"SQLite format 3\x00")
            self.assertTrue(chart.is_file())
            self.assertEqual(chart.read_bytes()[:8], b"\x89PNG\r\n\x1a\n")
            self.assertFalse(escaped_database.exists())

    @unittest.skipIf(sys.platform == "linux", "Linux integration test covers enabled native modules")
    def test_native_modules_fail_closed_without_landlock(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = self._run_worker(
                Path(tmp),
                (
                    "try:\n"
                    "    import sqlite3\n"
                    "except ImportError:\n"
                    "    print('sqlite fail closed')\n"
                    "else:\n"
                    "    raise AssertionError('SQLite enabled without native containment')\n"
                ),
            )

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("sqlite fail closed", result.stdout)


if __name__ == "__main__":
    unittest.main()
