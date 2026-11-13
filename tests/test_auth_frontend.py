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
    def test_wiki_manager_session_restores_as_its_own_role(self):
        self.run_javascript(["waitForAuthRetry", "fetchAuthRequest", "validateRestoredAuthSession"], r"""
USER_TOKEN = null;
WIKI_MANAGER_TOKEN = 'manager-token';
fetch = async (url, options) => {
  assert.equal(url, '/api/auth/me');
  assert.equal(options.headers['X-Wiki-Manager-Token'], 'manager-token');
  assert.equal(options.headers['X-Teacher-Token'], undefined);
  return {status:200,ok:true,json:async()=>({ok:true,user:{email:'manager@example.invalid',role:'wiki_manager'}})};
};
assert.equal(await validateRestoredAuthSession(),true);
assert.equal(currentUser.role,'wiki_manager');
assert.equal(USER_TOKEN,null);
assert.equal(TEACHER_TOKEN,null);
assert.equal(WIKI_MANAGER_TOKEN,'manager-token');
""")

    def run_javascript(self, functions, checks, *, setup=""):
        source = (ROOT / "static/js/app-core.js").read_text(encoding="utf-8")
        extracted = []
        for name in functions:
            match = re.search(r"^    (?:async )?function " + re.escape(name) + r"\(", source, re.MULTILINE)
            self.assertIsNotNone(match, name)
            end = source.index("\n    }", match.start()) + len("\n    }")
            extracted.append(source[match.start():end])
        program = r"""
const assert = require('node:assert/strict');
let USER_TOKEN = 'student-token', TEACHER_TOKEN = null, ADMIN_TOKEN = null, WIKI_MANAGER_TOKEN = null;
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
""" + setup + "\n" + "\n".join(extracted) + "\n(async () => {\n" + checks + "\n})().catch(err => { console.error(err); process.exitCode = 1; });"
        result = subprocess.run([NODE, "-"], input=program, text=True, capture_output=True, timeout=20, cwd=ROOT)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_session_validation_preserves_transient_failures_but_rejects_invalid_tokens(self):
        self.run_javascript(["waitForAuthRetry", "fetchAuthRequest", "validateRestoredAuthSession"], r"""
for (const response of [
  { status: 503, ok: false },
  { status: 200, ok: true, json: async () => { throw new SyntaxError('proxy HTML'); } },
  { status: 200, ok: true, json: async () => ({}) },
]) {
  fetch = async () => response;
  assert.equal(await validateRestoredAuthSession(), null);
  assert.equal(USER_TOKEN, 'student-token');
}
fetch = async () => { throw new Error('offline'); };
assert.equal(await validateRestoredAuthSession(), null);
assert.equal(USER_TOKEN, 'student-token');
for (const status of [401, 403]) {
  USER_TOKEN = 'expired-token';
  fetch = async () => ({ status, ok: false });
  assert.equal(await validateRestoredAuthSession(), false);
  assert.equal(USER_TOKEN, 'expired-token');
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

    def test_password_login_waits_for_queue_and_retries_only_explicit_busy(self):
        self.run_javascript(["fetchAuthRequest"], r"""
let calls = 0;
fetch = async () => {
  calls += 1;
  return new Response('{}', { status: 503, headers: { 'Retry-After': '2' } });
};
assert.equal((await fetchAuthRequest('/api/auth/login')).status, 503);
assert.equal(calls, 2);
assert.deepEqual(deadlines, [20000, 20000]);
assert.equal(waits.length, 1);
assert.ok(waits[0] >= 2000 && waits[0] < 2500);

for (const status of [429, 502, 503, 504]) {
  calls = 0;
  fetch = async () => { calls += 1; return new Response('{}', { status }); };
  assert.equal((await fetchAuthRequest('/api/auth/login')).status, status);
  assert.equal(calls, 1);
}
calls = 0;
fetch = async () => { calls += 1; throw new DOMException('timed out', 'AbortError'); };
await assert.rejects(fetchAuthRequest('/api/admin/login'), { code: 'timeout' });
assert.equal(calls, 1);
""", setup="""
const waits = [], deadlines = [];
const waitForAuthRetry = async delay => waits.push(delay);
const setTimeout = (_, delay) => deadlines.push(delay);
const clearTimeout = () => {};
""")

    def test_restart_restores_once_per_tab_and_keeps_session_on_transient_failure(self):
        self.run_javascript(["prepareWorkspaceSession"], r"""
const pending = prepareWorkspaceSession({ restarted: true, reconnecting: true });
assert.equal(prepareWorkspaceSession({ restarted: true, reconnecting: true }), pending);
release(new Response('{}', { status: 503 }));
assert.equal(await pending, false);
assert.equal(USER_TOKEN, 'student-token');
assert.equal(sessionRecoveryPending, true);
const retry = prepareWorkspaceSession({ restarted: true, reconnecting: true });
release(Response.json({ ok: true, role: 'student', token: USER_TOKEN, user: currentUser }));
assert.equal(await retry, true);
assert.equal(sessionRecoveryPending, false);
assert.equal(classLoads, 1);
assert.equal(requests, 2);
assert.equal(prepareWorkspaceSession({ restarted: false, reconnecting: false }), true);

const stale = prepareWorkspaceSession({ restarted: true, reconnecting: true });
authGeneration++;
release(Response.json({ ok: true, role: 'student', token: 'other', user: { email: 'other@school.test' } }));
assert.equal(await stale, true);
assert.equal(USER_TOKEN, 'student-token');
""", setup="""
let authGeneration = 0, sessionRestore = null, bootSessionPending = false, sessionRecoveryPending = false;
let authSubmitPending = false, release, requests = 0, classLoads = 0;
let socketClassRooms = new Set();
const endUnrestorableWorkspaceSession = () => { throw new Error('must preserve the current account'); };
const validateRestoredAuthSession = () => { throw new Error('do not validate a lost token after a confirmed restart'); };
const fetchAuthRequest = url => { assert.equal(url, '/api/auth/restore'); requests++; return new Promise(resolve => { release = resolve; }); };
const loadStudentClassData = async () => { classLoads++; };
const updateAuthUI = () => {};
""")


if __name__ == "__main__":
    unittest.main()
