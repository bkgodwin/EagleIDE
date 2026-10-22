import re
import unittest
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[1]


class StartupScriptTests(unittest.TestCase):
    def setUp(self):
        self.script = (BASE_DIR / "start.sh").read_text(encoding="utf-8")
        self.requirements = (BASE_DIR / "requirements.txt").read_text(encoding="utf-8")

    def test_launcher_uses_isolated_verified_virtual_environment(self):
        self.assertIn("set -Eeuo pipefail", self.script)
        self.assertIn('readonly VENV_DIR="$SCRIPT_DIR/.venv"', self.script)
        self.assertIn("--only-binary=:all:", self.script)
        self.assertIn("include-system-site-packages", self.script)
        self.assertIn("venv_imports_are_healthy", self.script)
        self.assertIn('exec "$venv_python" "$SCRIPT_DIR/app.py"', self.script)
        self.assertNotIn("source \"$VENV_DIR/bin/activate\"", self.script)

    def test_installs_pin_hashes_for_runtime_transitives_and_installer(self):
        self.assertIn("--require-hashes", self.script)
        self.assertNotIn("--upgrade pip", self.script)
        locked = (BASE_DIR / "requirements.lock").read_text(encoding="utf-8")
        bootstrap = (BASE_DIR / "requirements-bootstrap.lock").read_text(encoding="utf-8")
        declared = re.findall(r"(?m)^([A-Za-z0-9_.-]+)==([A-Za-z0-9_.+-]+)", self.requirements)
        pins = {name.lower().replace("_", "-"): version for name, version in re.findall(r"(?m)^([A-Za-z0-9_.-]+)==([A-Za-z0-9_.+-]+)", locked)}
        for name, version in declared:
            self.assertEqual(pins[name.lower().replace("_", "-")], version)
        for text in (locked, bootstrap):
            for entry in re.split(r"\n(?=[A-Za-z0-9_.-]+==)", text):
                if re.search(r"(?m)^[A-Za-z0-9_.-]+==", entry):
                    self.assertRegex(entry, r"--hash=sha256:[a-f0-9]{64}")
        self.assertRegex(bootstrap, r"(?m)^pip==[0-9.]+")
        workflow = (BASE_DIR / ".github/workflows/tests.yml").read_text(encoding="utf-8")
        for action in re.findall(r"uses:\s+(\S+)", workflow):
            self.assertRegex(action, r"@[a-f0-9]{40}$")
        self.assertIn('node-version: "24"', workflow)

    def test_launcher_covers_fresh_lxc_system_requirements(self):
        for value in (
            "apt-get",
            "dnf",
            "python3-venv",
            "nodejs",
            "fontconfig",
            "fonts-dejavu-core",
            "landlock_status",
            "EAGLEIDE_SETUP_ONLY",
        ):
            self.assertIn(value, self.script)

    def test_runtime_dependencies_are_reproducibly_pinned(self):
        expected = {
            "Flask": "3.1.3",
            "Flask-SocketIO": "5.6.1",
            "simple-websocket": "1.1.0",
            "requests": "2.34.2",
            "bcrypt": "5.0.0",
            "cryptography": "48.0.1",
            "numpy": "2.5.1",
            "matplotlib": "3.11.1",
            "Pillow": "12.3.0",
            "reportlab": "5.0.1",
        }
        for package, version in expected.items():
            pattern = rf"(?mi)^{re.escape(package)}=={re.escape(version)}(?:\s|$)"
            self.assertRegex(self.requirements, pattern)
        for raw_line in self.requirements.splitlines():
            requirement = raw_line.partition("#")[0].strip()
            if requirement:
                self.assertRegex(requirement, r"^[A-Za-z0-9_.-]+==[A-Za-z0-9_.+-]+$")


if __name__ == "__main__":
    unittest.main()
