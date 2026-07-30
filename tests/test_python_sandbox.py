import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from sandbox_containment import landlock_status
from sandbox_policy import (
    CONTAINMENT_REQUIRED_MODULES,
    MODULE_CATALOG,
    SECURITY_LOCKED_MODULES,
    STUDENT_THIRD_PARTY_MODULES,
    disabled_module_roots,
    normalize_module_access,
)
from sandbox_worker import ChartArtifactManager, MAX_CHART_ARTIFACTS_PER_SOURCE


BASE_DIR = Path(__file__).resolve().parents[1]
WORKER = BASE_DIR / "sandbox_worker.py"


class PythonSandboxPolicyTests(unittest.TestCase):
    def _run_worker(
        self,
        workspace: Path,
        source: str,
        *,
        disabled_modules: tuple[str, ...] = (),
        run_dir: Path | None = None,
        timeout: float = 45.0,
    ) -> subprocess.CompletedProcess[str]:
        run_dir = run_dir or workspace
        run_dir.mkdir(parents=True, exist_ok=True)
        code_path = run_dir / "student.py"
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
            cwd=run_dir,
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
        self.assertIn("mpl_toolkits", disabled_module_roots({"matplotlib": False}))
        self.assertIn("subprocess", SECURITY_LOCKED_MODULES)
        self.assertIn("ctypes", SECURITY_LOCKED_MODULES)
        self.assertIn("_socket", SECURITY_LOCKED_MODULES)
        self.assertTrue(
            {"PIL", "contourpy", "kiwisolver", "matplotlib", "mpl_toolkits", "numpy"}.issubset(
                CONTAINMENT_REQUIRED_MODULES
            )
        )

    def test_chart_artifacts_increment_and_rotate_at_the_history_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            for index in range(1, MAX_CHART_ARTIFACTS_PER_SOURCE + 1):
                (workspace / f"lesson-figure-{index}.png").write_bytes(b"old")
            with mock.patch.dict(os.environ, {"EAGLE_RUN_SOURCE_NAME": "lesson.py"}):
                manager = ChartArtifactManager(str(workspace))
                target = manager._reserve_target()
            target.write_bytes(b"new")

            artifacts = sorted(workspace.glob("lesson-figure-*.png"))
            self.assertEqual(target.name, "lesson-figure-21.png")
            self.assertEqual(len(artifacts), MAX_CHART_ARTIFACTS_PER_SOURCE)
            self.assertFalse((workspace / "lesson-figure-1.png").exists())
            self.assertTrue((workspace / "lesson-figure-20.png").exists())

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
                    "for name in ('flask', 'ctypes', 'subprocess', 'socket', '_socket'):\n"
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
                    "assert sys.modules['socket']._socket is None\n"
                    "print('nested socket extension removed')\n"
                ),
            )

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("flask blocked", result.stdout)
        self.assertIn("reload blocked", result.stdout)
        self.assertIn("process blocked", result.stdout)
        self.assertIn("socket blocked", result.stdout)
        self.assertIn("_socket blocked", result.stdout)
        self.assertIn("nested socket extension removed", result.stdout)
        self.assertNotIn("unsafe", result.stdout)

    @unittest.skipUnless(sys.platform == "linux", "Landlock is a Linux security boundary")
    def test_landlock_sqlite_matplotlib_and_inspect_integration(self):
        status = landlock_status()
        self.assertTrue(status.get("available"), status.get("reason"))
        with tempfile.TemporaryDirectory() as tmp:
            test_root = Path(tmp)
            workspace = test_root / "workspace"
            workspace.mkdir()
            lesson_dir = workspace / "lesson"
            escaped_database = test_root / "outside.sqlite3"
            escaped_literal = repr(str(escaped_database))
            managed_imports = "\n".join(
                f"import {row['name']}"
                for row in MODULE_CATALOG
            )
            dependency_imports = "\n".join(
                f"import {name}"
                for name in sorted(STUDENT_THIRD_PARTY_MODULES)
            )
            result = self._run_worker(
                workspace,
                (
                    "import sys\n"
                    "if sys.version_info >= (3, 13):\n"
                    "    from types import CapsuleType\n"
                    "    assert CapsuleType.__name__ == 'PyCapsule'\n"
                    "for locked_name in ('socket', '_socket'):\n"
                    "    try:\n"
                    "        __import__(locked_name)\n"
                    "    except ImportError:\n"
                    "        pass\n"
                    "    else:\n"
                    "        raise AssertionError(locked_name + ' became importable')\n"
                    f"{managed_imports}\n"
                    f"{dependency_imports}\n"
                    "from PIL import Image\n"
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
                    "from mpl_toolkits.mplot3d import Axes3D\n"
                    "figure = plt.figure()\n"
                    "axes = figure.add_subplot(111, projection='3d')\n"
                    "axes.plot([0, 1, 2], [0, 1, 0], [0, 2, 1])\n"
                    "axes.set_title('Contained 3D chart')\n"
                    "plt.show()\n"
                    "print('managed and native modules complete')\n"
                ),
                run_dir=lesson_dir,
            )

            chart = lesson_dir / "student-figure-1.png"
            database = lesson_dir / "lesson.sqlite3"
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("attach blocked", result.stdout)
            self.assertIn("managed and native modules complete", result.stdout)
            self.assertNotIn("Unable to import Axes3D", result.stderr)
            self.assertTrue(database.is_file())
            self.assertEqual(database.read_bytes()[:16], b"SQLite format 3\x00")
            self.assertTrue(chart.is_file())
            self.assertEqual(chart.read_bytes()[:8], b"\x89PNG\r\n\x1a\n")
            self.assertFalse((workspace / "charts").exists())
            self.assertFalse(escaped_database.exists())

    @unittest.skipIf(sys.platform == "linux", "Linux integration test covers enabled native modules")
    def test_native_modules_fail_closed_without_landlock(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = self._run_worker(
                Path(tmp),
                (
                    "for name in ('PIL', 'contourpy', 'inspect', 'kiwisolver', "
                    "'matplotlib', 'mpl_toolkits', 'numpy', 'sqlite3'):\n"
                    "    try:\n"
                    "        __import__(name)\n"
                    "    except ImportError:\n"
                    "        print(name, 'fail closed')\n"
                    "    else:\n"
                    "        raise AssertionError(name + ' enabled without native containment')\n"
                ),
            )

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("PIL fail closed", result.stdout)
        self.assertIn("sqlite3 fail closed", result.stdout)


if __name__ == "__main__":
    unittest.main()
