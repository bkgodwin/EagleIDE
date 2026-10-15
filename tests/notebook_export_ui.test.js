const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../static/js/student-notebook.js'), 'utf8');
const exportSource = source.slice(source.indexOf('  async function exportTeacherNotebookScores('), source.indexOf('  async function setTeacherPromptLocked('));

function harness(response) {
  const downloads = [], requests = [], revoked = [];
  const context = {
    token: 'teacher', URLSearchParams, ctx: () => ({ TEACHER_TOKEN: context.token }),
    teacherHeaders: () => ({ 'X-Teacher-Token': context.token }),
    fetch: async (url, options) => { requests.push({ url, options }); return typeof response === 'function' ? response() : response; },
    URL: { createObjectURL: () => 'blob:csv', revokeObjectURL: url => revoked.push(url) },
    document: { body: { appendChild() {} }, createElement: () => ({ click() { downloads.push({ href: this.href, name: this.download }); }, remove() {} }) },
    setTimeout: callback => callback(),
  };
  vm.runInNewContext(`${exportSource}\nglobalThis.exportScores = exportTeacherNotebookScores;`, context);
  return { context, downloads, requests, revoked };
}

test('notebook CSV downloads the selected prompt and format with teacher authentication', async () => {
  const h = harness({ ok: true, blob: async () => 'csv blob' });
  const button = { isConnected: true }, status = {};
  await h.context.exportScores('class & 1', 'prompt/2', 'Reflection / loops', 'points', button, status);
  const url = new URL(h.requests[0].url, 'https://eagle.test');
  assert.equal(url.pathname, '/api/teacher/notebook-prompts/csv');
  assert.equal(url.searchParams.get('classId'), 'class & 1');
  assert.equal(url.searchParams.get('promptId'), 'prompt/2');
  assert.equal(url.searchParams.get('format'), 'points');
  assert.equal(h.requests[0].options.headers['X-Teacher-Token'], 'teacher');
  assert.equal(h.downloads.length, 1);
  assert.equal(h.downloads[0].name, 'Reflection _ loops_completion_scores.csv');
  assert.deepEqual(h.revoked, ['blob:csv']);
  assert.equal(status.textContent, 'CSV downloaded.');
  assert.equal(button.disabled, false);
});

test('export failures show an error and reenable the button without downloading', async () => {
  for (const response of [
    { ok: false, json: async () => ({ error: 'Class not found' }) },
    () => { throw new Error('Network unavailable'); },
  ]) {
    const h = harness(response), button = { isConnected: true }, status = {};
    await h.context.exportScores('class', 'prompt', 'Title', 'percent', button, status);
    assert.match(status.textContent, /Class not found|Network unavailable/);
    assert.equal(button.disabled, false);
    assert.equal(h.downloads.length, 0);
  }
});

test('switching account or leaving the selected prompt cancels a late download', async () => {
  for (const change of ['account', 'prompt']) {
    let finish;
    const h = harness({ ok: true, blob: () => new Promise(resolve => { finish = resolve; }) });
    const button = { isConnected: true }, status = {};
    const pending = h.context.exportScores('class', 'prompt', 'Title', 'percent', button, status);
    await new Promise(resolve => setImmediate(resolve));
    if (change === 'account') h.context.token = 'another teacher';
    else button.isConnected = false;
    finish('csv blob');
    await pending;
    assert.equal(h.downloads.length, 0);
  }
});

test('a slower previous prompt cannot replace the current export controls', async () => {
  const requests = [];
  const list = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
  const title = {};
  const context = {
    document: { getElementById: id => id === 'teacherNotebookResponseTitle' ? title : list, querySelectorAll: () => [] },
    ctx: () => ({ TEACHER_TOKEN: 'teacher' }), teacherHeaders: () => ({}),
    fetch: () => new Promise(resolve => requests.push(resolve)),
    escapeHtml: value => value || '', sanitizeHtml: value => value || '',
    skillTagsHtml: () => '', formatLocalDateTime: () => '', highlightCodeBlocks() {},
    encodeURIComponent,
  };
  const loader = source.slice(source.indexOf('  async function loadTeacherPromptResponses('), source.indexOf('  function onAuthChanged('));
  vm.runInNewContext(`let teacherResponseSequence = 0, selectedTeacherPromptId = null; ${loader}; globalThis.load = loadTeacherPromptResponses;`, context);
  const first = context.load('class', 'first'), second = context.load('class', 'second');
  requests[1]({ json: async () => ({ ok: true, prompt: { title: 'Second prompt' }, responses: [], missing: [] }) });
  await second;
  assert.equal(title.textContent, 'Second prompt');
  const current = list.innerHTML;
  requests[0]({ json: async () => ({ ok: true, prompt: { title: 'First prompt' }, responses: [], missing: [] }) });
  await first;
  assert.equal(title.textContent, 'Second prompt');
  assert.equal(list.innerHTML, current);
});
