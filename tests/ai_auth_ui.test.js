const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'static/js/app-core.js'), 'utf8');

function functionSource(name) {
  const start = source.search(new RegExp('^    (?:async )?function ' + name + '\\(', 'm'));
  return start < 0 ? '' : source.slice(start, source.indexOf('\n    }', start) + 6);
}

function fixture(role) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {textContent: '', value: 'Explain this loop', disabled: false,
      addEventListener(_event, callback) { this.handler = callback; }});
    return elements.get(id);
  };
  const calls = [];
  const context = vm.createContext({
    USER_TOKEN: role === 'student' ? 'student-fixture' : null,
    TEACHER_TOKEN: ['teacher', 'coteacher'].includes(role) ? role + '-fixture' : null,
    ADMIN_TOKEN: role === 'admin' ? 'admin-fixture' : null,
    WIKI_MANAGER_TOKEN: role === 'wiki_manager' ? 'manager-fixture' : null,
    isCoTeacher: () => role === 'coteacher',
    document: {getElementById: element}, window: {mySid: 'public-socket-id'}, mySid: 'public-socket-id',
    editor: {getValue: () => 'print(1)'}, getActiveLanguageInfo: () => ({highlight: 'python'}),
    buildAiContext: extra => ({classId: 'fixture-class', language: 'python', ...extra}),
    explainCooldownUntil: 0, assistantCooldownUntil: 0, assistantMessages: [],
    MAX_ASSISTANT_MESSAGES: 16, MAX_ASSISTANT_CODE_CHARS: 12000,
    ensureAssistantSid: () => 'public-socket-id', renderAssistantMessages() {},
    startAssistantCooldown() {}, startExplainCooldown() {},
    renderMarkdownTo: (target, text) => {target.textContent = text;},
    fetch: async (url, options) => {
      calls.push({url, options});
      return {json: async () => ({ok: true, text: 'Explain fixture response', reply: 'Assistant fixture response'})};
    },
  });
  // Run the real handlers. Before the fix these execute but omit auth headers.
  vm.runInContext(functionSource('aiRequestHeaders') + '\n' + functionSource('sendAssistantMessage'), context);
  const start = source.indexOf("    document.getElementById('aiExplainBtn').addEventListener('click', async () => {");
  assert.ok(start >= 0);
  vm.runInContext(source.slice(start, source.indexOf('\n    });', start) + 8), context);
  return {context, calls, element};
}

const expected = {
  student: ['X-User-Token', 'student-fixture'], teacher: ['X-Teacher-Token', 'teacher-fixture'],
  admin: ['X-Admin-Token', 'admin-fixture'], wiki_manager: ['X-Wiki-Manager-Token', 'manager-fixture'],
  coteacher: ['X-User-Token', 'coteacher-fixture'],
};
for (const [role, [header, token]] of Object.entries(expected)) {
  test(`Explain and Assistant send the active ${role} identity`, async () => {
    const {context, calls, element} = fixture(role);
    await element('aiExplainBtn').handler();
    await vm.runInContext('sendAssistantMessage()', context);
    assert.deepEqual(calls.map(call => call.url), ['/api/explain', '/api/assistant/chat']);
    for (const {options} of calls) {
      assert.equal(options.headers[header], token);
      assert.equal(options.headers['Content-Type'], 'application/json');
      assert.deepEqual(Object.keys(options.headers).filter(key => key.endsWith('-Token')), [header]);
      assert.ok(!options.body.includes(token), 'credentials belong in headers, not prompts/payloads');
    }
    assert.equal(element('aiOutput').textContent, 'Explain fixture response');
    assert.equal(element('aiStatus').textContent, 'Done');
  });
}

test('AI headers are computed for each click and never retain a prior account', async () => {
  const {context, calls, element} = fixture('student');
  await element('aiExplainBtn').handler();
  context.USER_TOKEN = null;
  context.WIKI_MANAGER_TOKEN = 'new-manager-fixture';
  await vm.runInContext('sendAssistantMessage()', context);
  assert.equal(calls[1].options.headers['X-Wiki-Manager-Token'], 'new-manager-fixture');
  assert.equal(calls[1].options.headers['X-User-Token'], undefined);
});

test('guest AI requests do not fabricate an account from a socket ID', async () => {
  const {context, calls, element} = fixture('guest');
  await element('aiExplainBtn').handler();
  await vm.runInContext('sendAssistantMessage()', context);
  for (const {options} of calls) assert.deepEqual(Object.keys(options.headers).filter(key => key.endsWith('-Token')), []);
});
