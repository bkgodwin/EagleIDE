"""Execute the classic-script authentication helpers without browser dependencies."""

import os
from pathlib import Path
import re
import shutil
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[1]
NODE = os.environ.get("EAGLEIDE_TEST_NODE") or shutil.which("node")


@unittest.skipUnless(NODE, "Node.js is required for frontend authentication checks")
class AuthFrontendTests(unittest.TestCase):
    def run_javascript(self, functions, checks):
        source = (ROOT / "static/js/app-core.js").read_text(encoding="utf-8")
        extracted = []
        for name in functions:
            match = re.search(r"^    (?:async )?function " + re.escape(name) + r"\(", source, re.MULTILINE)
            self.assertIsNotNone(match, name)
            end = source.index("\n    }", match.start()) + len("\n    }")
            extracted.append(source[match.start():end])
        program = r"""
const assert = require('node:assert/strict');
let USER_TOKEN = 'student-token', TEACHER_TOKEN = null, ADMIN_TOKEN = null;
let currentUser = { role: 'student', email: 'student@school.test' }, currentTeacher = null;
let savedSessions = 0;
const saveAuthSession = () => { savedSessions++; };
const isAuthenticated = () => !!(USER_TOKEN || TEACHER_TOKEN || ADMIN_TOKEN);
const clearAuthStateMemory = () => { USER_TOKEN = TEACHER_TOKEN = ADMIN_TOKEN = currentUser = currentTeacher = null; };
let studentClasses = [{ id: 'one', settings: {} }], studentClassData = studentClasses[0], currentStudentClassId = 'one';
let teacherClasses = [{ id: 'two' }], currentTeacherClassId = 'two', activeAssignmentsClassId = 'two';
const mergeClassroomSettings = settings => settings;
const normalizeTeacherClasses = classes => classes;
const syncStudentClassSelection = () => { studentClassData = studentClasses.find(c => c.id === currentStudentClassId) || null; };
const emitJoinClassRoom = () => {};
const refreshEagleIDEContext = () => {};
const window = {};
let fetch;
""" + "\n".join(extracted) + "\n(async () => {\n" + checks + "\n})().catch(err => { console.error(err); process.exitCode = 1; });"
        result = subprocess.run([NODE, "-"], input=program, text=True, capture_output=True, timeout=20, cwd=ROOT)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_session_validation_preserves_transient_failures_but_rejects_invalid_tokens(self):
        self.run_javascript(["validateRestoredAuthSession"], r"""
for (const response of [
  { status: 503, ok: false },
  { status: 200, ok: true, json: async () => { throw new SyntaxError('proxy HTML'); } },
  { status: 200, ok: true, json: async () => ({}) },
]) {
  fetch = async () => response;
  assert.equal(await validateRestoredAuthSession(), true);
  assert.equal(USER_TOKEN, 'student-token');
}
fetch = async () => { throw new Error('offline'); };
assert.equal(await validateRestoredAuthSession(), true);
assert.equal(USER_TOKEN, 'student-token');
for (const status of [401, 403]) {
  USER_TOKEN = 'expired-token';
  fetch = async () => ({ status, ok: false });
  assert.equal(await validateRestoredAuthSession(), false);
  assert.equal(USER_TOKEN, null);
}
USER_TOKEN = 'old-token';
let release;
fetch = () => new Promise(resolve => { release = resolve; });
const pending = validateRestoredAuthSession();
USER_TOKEN = 'new-token';
release({ status: 401, ok: false });
assert.equal(await pending, true);
assert.equal(USER_TOKEN, 'new-token');
""")

    def test_class_refresh_preserves_selection_during_network_failures(self):
        self.run_javascript(["loadStudentClassData", "loadTeacherClasses"], r"""
fetch = async () => { throw new Error('offline'); };
await loadStudentClassData();
assert.equal(currentStudentClassId, 'one');
assert.equal(studentClasses.length, 1);
assert.equal(studentClassData.id, 'one');
TEACHER_TOKEN = 'teacher-token';
await loadTeacherClasses();
assert.equal(currentTeacherClassId, 'two');
assert.equal(teacherClasses.length, 1);
fetch = async () => ({ ok: false, json: async () => ({ ok: false }) });
await loadStudentClassData();
await loadTeacherClasses();
assert.equal(studentClasses.length, 1);
assert.equal(teacherClasses.length, 1);
fetch = async () => ({ ok: true, json: async () => ({ ok: true, classList: [{ id: 'one' }, { id: 'other' }], classData: { id: 'other' } }) });
await loadStudentClassData();
assert.equal(currentStudentClassId, 'one');
let release;
fetch = () => new Promise(resolve => { release = resolve; });
const pending = loadStudentClassData();
USER_TOKEN = null;
studentClasses = []; studentClassData = null; currentStudentClassId = null;
release({ ok: true, json: async () => ({ ok: true, classList: [{ id: 'old-account-class' }] }) });
await pending;
assert.deepEqual(studentClasses, []);
""")

    def test_login_does_not_mask_server_or_disabled_account_errors(self):
        self.run_javascript(["waitForAuthRetry", "fetchAuthRequest", "tryUnifiedSignIn"], r"""
for (const status of [403, 500]) {
  const calls = [];
  fetch = async url => { calls.push(url); return { status, ok: false, json: async () => ({ ok: false, error: 'specific error' }) }; };
  assert.deepEqual(await tryUnifiedSignIn('student@school.test', 'password'), { ok: false, error: 'specific error' });
  assert.deepEqual(calls, ['/api/auth/login']);
}
const calls = [];
fetch = async url => { calls.push(url); return { status: 401, ok: false, json: async () => ({ ok: false, error: 'Invalid email or password' }) }; };
assert.equal((await tryUnifiedSignIn('student@school.test', 'wrong')).ok, false);
assert.deepEqual(calls, ['/api/auth/login', '/api/admin/login']);
const passwordCalls = [];
fetch = async url => { passwordCalls.push(url); return { status: 401, ok: false, json: async () => ({ ok: false, code: 'incorrect_password', error: 'Incorrect password' }) }; };
assert.deepEqual(await tryUnifiedSignIn('student@school.test', 'wrong'), { ok: false, error: 'Incorrect password' });
assert.deepEqual(passwordCalls, ['/api/auth/login', '/api/admin/login']);
""")


if __name__ == "__main__":
    unittest.main()
