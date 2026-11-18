const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const lab = fs.readFileSync(path.join(root, 'static/js/eagle-lab.js'), 'utf8');
const core = fs.readFileSync(path.join(root, 'static/js/app-core.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('native lab view is lazy loaded and keeps only the Eagle Lab name', () => {
  assert.match(html, /id="eagleLabView"/);
  assert.match(html, /class="eagle-lab-name">Eagle Lab</);
  assert.doesNotMatch(html, /Eagle Lab[^<]*(motto|empower|innovate)/i);
  assert.doesNotMatch(html, /<script[^>]+eagle-lab\.js/);
});

test('lab reports render one continuous page and autosave with revision guards', () => {
  assert.match(lab, /class="lab-report-page"/);
  assert.match(lab, /page\.addEventListener\('input', \(\) => edited\(700\)\)/);
  assert.match(lab, /method:'PUT'.*revision,responses/);
  assert.match(lab, /error\.status === 409/);
  assert.match(lab, /question\.type==='procedure'/);
  assert.match(lab, /question\.type==='fill_blank'/);
});

test('teacher composer exposes only report controls for lab report assignments', () => {
  assert.match(core, /<option value="lab_report"/);
  assert.match(core, /<option value="fill_blank">Fill in the Blank/);
  assert.match(core, /<option value="procedure">Procedure Checklist/);
  assert.match(core, /showAddQuestionModal\([^\n]+lab_report/);
});

function reportFixture(writeDraft, submitReport = () => { throw new Error('Unexpected submission'); }) {
  const events = {}, closeButtons = [{}, {}], submit = {}, status = {}, submitStatus = {};
  const field = { value: 'My observation' };
  const page = { addEventListener(name, callback) { events[name] = callback; } };
  const overlay = {
    isConnected: false, innerHTML: '',
    querySelector(selector) {
      if (selector === '.lab-report-save-state') return status;
      if (selector === '.lab-report-page') return page;
      if (selector === '[data-report-submit]') return submit;
      if (selector === '[data-report-status]') return submitStatus;
      if (selector === '[data-report-reset]') return null;
      return field;
    },
    querySelectorAll(selector) { return selector === '[data-report-close]' ? closeButtons : [submit, field]; },
    remove() { this.isConnected = false; },
  };
  const ctx = { USER_TOKEN: 'session-one', currentConfig: { eagle_lab_enabled: true } };
  const sent = [];
  const windowEvents = {};
  const sandbox = {
    window: { EagleIDE: { getContext: () => ctx }, addEventListener(name, fn) { (windowEvents[name] ||= []).push(fn); } },
    document: {
      getElementById: id => id === 'eagleLabReportList' ? {addEventListener() {}, replaceChildren() {}} : null,
      addEventListener() {},
      createElement: () => overlay,
      body: { append(element) { element.isConnected = true; }, classList: { contains: () => false } },
      querySelectorAll: () => [],
    },
    CSS: { escape: String },
    setTimeout: () => 1, clearTimeout() {},
    alert() {}, confirm: () => true,
    fetch: async (url, options) => {
      const body = options.body && JSON.parse(options.body);
      if (options.method === 'PUT') {
        sent.push(body);
        return writeDraft(body);
      }
      if (url === '/api/quiz/submit') return submitReport(body);
      const data = url.startsWith('/api/quiz/')
        ? { ok: true, quiz: { questions: [{ id: 'q1', type: 'written', question: 'Observation', points: 5 }] } }
        : { ok: true, data: { revision: 0, responses: [{ questionId: 'q1', answer: 'Restored observation' }] } };
      return { ok: true, json: async () => data };
    },
  };
  vm.runInNewContext(lab, sandbox);
  return { api: sandbox.window.EagleLab, overlay, field, status, events, closeButtons, submit, submitStatus, ctx, windowEvents, sent };
}

test('failed autosave keeps report edits and the report window open', async () => {
  const fixture = reportFixture(async () => { throw new Error('Offline'); });
  await fixture.api.openReportById('assignment', { name: 'Lab report' });
  assert.match(fixture.overlay.innerHTML, /Restored observation/);
  fixture.events.input();
  await fixture.closeButtons[0].onclick();
  assert.equal(fixture.overlay.isConnected, true);
  assert.equal(fixture.field.value, 'My observation');
  assert.equal(fixture.status.textContent, 'Offline');
});

test('edits made during a draft write remain dirty and closing saves the newest text', async () => {
  let finish;
  let calls = 0;
  const fixture = reportFixture(body => {
    calls++;
    const response = { ok: true, json: async () => ({ ok: true, data: { revision: body.revision + 1 } }) };
    return calls === 1 ? new Promise(resolve => { finish = () => resolve(response); }) : Promise.resolve(response);
  });
  await fixture.api.openReportById('assignment', { name: 'Lab report' });
  fixture.events.input();
  const saving = fixture.api.getState().report.save();
  await Promise.resolve();
  fixture.field.value = 'Newer observation';
  fixture.events.input();
  finish();
  await saving;
  assert.equal(fixture.api.getState().report.dirty(), true);
  await fixture.closeButtons[0].onclick();
  assert.equal(fixture.sent.at(-1).responses[0].answer, 'Newer observation');
  assert.equal(fixture.sent.at(-1).revision, 1);
  assert.equal(fixture.overlay.isConnected, false);
});

test('account changes cancel the old report before another draft request can be sent', async () => {
  const fixture = reportFixture(async () => { throw new Error('Unexpected save'); });
  await fixture.api.openReportById('assignment', { name: 'Lab report' });
  fixture.ctx.USER_TOKEN = 'session-two';
  fixture.windowEvents['eagle-context-updated'].forEach(callback => callback());
  assert.equal(fixture.overlay.isConnected, false);
  assert.equal(fixture.api.getState().report, null);
  assert.equal(fixture.sent.length, 0);
});

test('a conflicting draft still allows submission and a failed submission can be retried', async () => {
  const submitted = [];
  const fixture = reportFixture(
    async () => ({ok: false, status: 409, json: async () => ({
      ok: false, data: {revision: 2, responses: [{questionId: 'q1', answer: 'Other session'}]},
    })}),
    async body => {
      submitted.push(body);
      return submitted.length === 1
        ? {ok: false, status: 503, json: async () => ({ok: false, error: 'Try again shortly.'})}
        : {ok: true, json: async () => ({ok: true})};
    },
  );
  await fixture.api.openReportById('assignment', { name: 'Lab report' });
  fixture.events.input();
  assert.equal(await fixture.api.getState().report.save(), false);
  assert.match(fixture.status.textContent, /another session/);
  await fixture.submit.onclick();
  assert.match(fixture.submitStatus.textContent, /Could not submit. Try again shortly/);
  assert.equal(fixture.field.disabled, false);
  assert.equal(fixture.overlay.isConnected, true);

  fixture.field.value = 'Latest observation';
  fixture.events.input();
  await fixture.submit.onclick();
  assert.equal(submitted[1].quizResponses[0].answer, 'Latest observation');
  assert.equal(fixture.overlay.isConnected, false);
  assert.equal(fixture.sent.length, 1);
});

test('a draft save whose response was lost recovers from the matching server revision', async () => {
  let saved;
  const fixture = reportFixture(async body => {
    if (!saved) {
      saved = {revision: 1, responses: body.responses};
      throw new Error('Lost response');
    }
    if (body.revision === 0) {
      return {ok: false, status: 409, json: async () => ({ok: false, data: saved})};
    }
    return {ok: true, json: async () => ({ok: true, data: {revision: 2}})};
  });
  await fixture.api.openReportById('assignment', { name: 'Lab report' });
  const report = fixture.api.getState().report;
  fixture.events.input();
  assert.equal(await report.save(), false);
  assert.equal(await report.save(), true);
  assert.equal(report.dirty(), false);
  fixture.field.value = 'Next edit';
  fixture.events.input();
  assert.equal(await report.save(), true);
  assert.equal(fixture.sent.at(-1).revision, 1);
});
