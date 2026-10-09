const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'static', 'js', 'app-core.js'), 'utf8');
const studentDashboard = fs.readFileSync(path.join(root, 'static', 'js', 'student-dashboard.js'), 'utf8');
const resourceCss = fs.readFileSync(path.join(root, 'static', 'css', 'features', 'resources.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('teacher assignment table includes missing, manual, AI, and export controls', () => {
  assert.match(source, /Not turned in/);
  assert.match(source, /assignment-grade-input/);
  assert.match(source, /AI Grade All/);
  assert.match(source, /Additional grading instructions/);
  assert.match(source, /Percent \(1 decimal\)/);
  assert.match(source, /aiFeedback/);
  assert.match(source, /openAssignmentAiQueueBtn/);
  assert.match(source, /assignmentShareAiFeedback/);
  assert.match(source, /Rubric grader \(Beta test\)/);
  assert.match(source, /External AI/);
  assert.match(source, /Download grading package/);
  assert.match(source, /Upload completed CSV/);
  assert.match(source, /external-grading-package/);
  assert.match(source, /external-grades/);
  assert.match(source, /generateAssignmentRubric/);
  assert.match(source, /Accept rubric &amp; save beta grader/);
  assert.match(source, /assignment-criterion-check/);
  assert.match(html, /id="assignmentAiQueueModal"/);
});

test('student dashboard owns locked assignment history and can copy preserved code to a draft editor', () => {
  assert.doesNotMatch(html, /id="studentPastAssignmentList"/);
  assert.match(html, /data-view="student-dash-past"/);
  assert.match(html, /id="studentPastAssignmentsPane"/);
  assert.match(studentDashboard, /\/api\/assignments\/past\?classId=/);
  assert.match(studentDashboard, /source: 'assignment'/);
  assert.match(studentDashboard, /setEditorSnapshot/);
  assert.match(studentDashboard, /View teacher feedback/);
  assert.match(studentDashboard, /renderAssignmentAiFeedback/);
});

test('submission editor navigation and minimized dashboard use stable assignment IDs', () => {
  assert.match(html, /id="previousSubmissionBtn"/);
  assert.match(html, /id="nextSubmissionBtn"/);
  assert.match(html, /id="teacherDashMinimizedBar"/);
  assert.match(html, /id="teacherDashPreviousSubmissionBtn"/);
  assert.match(html, /id="teacherDashNextSubmissionBtn"/);
  assert.ok(html.indexOf('id="submissionScoringPanel"') < html.indexOf('id="fileBrowserTabPane"'));
  assert.match(source, /assignmentId: assignment\?\.id/);
  assert.match(source, /minimizeTeacherDashboardForSubmission/);
  assert.match(source, /navigateAssignmentSubmission/);
  assert.match(source, /submission: true/);
  assert.match(source, /\/api\/assignments\/submission/);
});

test('student assignment actions target IDs instead of ambiguous duplicate names', () => {
  assert.match(source, /data-id="\$\{escapeHtml\(a\.id \|\| a\.name\)\}"/);
  assert.match(source, /assignmentRequestPayload\(assignment/);
});

function assignmentViewHarness(assignments) {
  const start = source.indexOf('function sortAssignmentsChronologically(assignments)');
  const end = source.indexOf('function renderStudentAssignments()', start);
  assert.ok(start >= 0 && end > start);
  const detail = { innerHTML: '', dataset: {}, querySelector: () => null, querySelectorAll: () => [] };
  const list = {
    innerHTML: '', buttons: [],
    querySelector(selector) { return selector === '#assignmentDetailPanel' && this.innerHTML.includes('id="assignmentDetailPanel"') ? detail : null; },
    querySelectorAll(selector) {
      if (selector !== '.assignment-title-row') return [];
      this.buttons = [...this.innerHTML.matchAll(/class="assignment-title-row" data-id="([^"]+)"/g)].map(match => ({
        dataset: { id: match[1] },
        addEventListener(_event, handler) { this.click = handler; },
      }));
      return this.buttons;
    },
  };
  const reference = { innerHTML: '' };
  const heading = { textContent: '' };
  const nodes = { assignmentList: list, teacherReferenceAssignmentList: reference, teacherReferenceAssignmentsTitle: heading };
  const context = {
    currentAssignments: assignments,
    teacherClasses: [{ id: 'class-a', name: 'Period A', students: [] }, { id: 'class-b', name: 'Period B', students: [] }],
    currentTeacherClassId: 'class-a', activeAssignmentsClassId: 'class-a', currentAdminAssignmentName: null,
    TEACHER_TOKEN: 'teacher-token', window: { EagleIDE: {} }, document: { getElementById: id => nodes[id] || null },
    assignmentGradingCriteria: [
      { id: 'comments', rigorLevel: 6, label: 'Use of comments', description: 'Comments explain intent.' },
      { id: 'objectives', rigorLevel: 2, label: 'All outlined objectives met', description: 'All required outcomes are present.' },
      { id: 'validation', rigorLevel: 8, label: 'Input validation', description: 'Validate input.' },
      { id: 'security', rigorLevel: 10, label: 'Security', description: 'Safe handling.' },
    ],
    escapeHtml: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    getAssignmentByName: id => assignments.find(a => a.id === id),
    assignmentScoreValue: submission => submission.totalScore ?? submission.codeScore ?? null,
    assignmentTotalMaxScore: assignment => assignment.maxScore || 0,
    assignmentPercentValue: () => '80.0%',
    rigorLevelLabel: () => 'High School', assignmentRigorSummary: () => 'Core objectives',
  };
  vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.views = { renderAdminAssignments, renderTeacherReferenceAssignments, renderAssignmentAiFeedback };`, context);
  return { context, list, detail, reference, heading };
}

test('teacher assignment titles sort chronologically and expand into grading', () => {
  const assignments = [
    { id: 'later', name: 'A Later Task', task: 'Second task text', createdAt: '2026-09-29T10:00:00', targetClassId: 'class-a', submissions: [], maxScore: 10, active: true },
    { id: 'earlier', name: 'Z Earlier Task', task: 'First task text', createdAt: '2026-09-28T10:00:00', targetClassId: 'class-a', submissions: [], maxScore: 10, active: false },
  ];
  const { context, list, detail } = assignmentViewHarness(assignments);
  context.views.renderAdminAssignments();
  assert.ok(list.innerHTML.indexOf('Z Earlier Task') < list.innerHTML.indexOf('A Later Task'));
  assert.doesNotMatch(list.innerHTML, /First task text|Second task text|scores-table/);
  list.buttons[0].click();
  assert.equal(context.currentAdminAssignmentName, 'earlier');
  assert.match(detail.innerHTML, /First task text/);
  assert.match(detail.innerHTML, /scores-table/);
  assert.match(detail.innerHTML, /AI Grade All/);
  assert.match(detail.innerHTML, /Legacy grader/);
  assert.match(detail.innerHTML, /All outlined objectives met/);
  assert.ok(detail.innerHTML.indexOf('Foundation') < detail.innerHTML.indexOf('Working and clear code'));
  assert.ok(detail.innerHTML.indexOf('Working and clear code') < detail.innerHTML.indexOf('Robustness and maintainability'));
  assert.ok(detail.innerHTML.indexOf('Robustness and maintainability') < detail.innerHTML.indexOf('Advanced quality'));
  assert.ok(detail.innerHTML.indexOf('All outlined objectives met') < detail.innerHTML.indexOf('Use of comments'));
  assert.doesNotMatch(detail.innerHTML, /class="assignment-criterion-check"[^>]*checked/);
});

test('assignment feedback is structured for teachers and simplified for students', () => {
  const { context } = assignmentViewHarness([]);
  const feedback = [
    'Score: 8/10', '', 'Rubric Beta', '',
    'Academic integrity note', 'A comment attempts to influence the grader.', '',
    'What worked', 'The loop processes each requested value.', '',
    'Criterion evidence', '• Correct logic — 4/5: The range stops one value early.', '',
    'Rubric gaps', '• Include the final requested value.', '',
    'Points deducted', '• −1 point — Correct logic: The final value is skipped.',
  ].join('\n');
  const teacher = context.views.renderAssignmentAiFeedback(feedback);
  assert.match(teacher, /8\/10/);
  assert.match(teacher, /Academic integrity review/);
  assert.match(teacher, /Criterion breakdown/);
  assert.match(teacher, /Correct logic/);
  const student = context.views.renderAssignmentAiFeedback(feedback, { audience: 'student' });
  assert.match(student, /Teacher feedback/);
  assert.match(student, /What you did well/);
  assert.match(student, /How your work was scored/);
  assert.match(student, /Next steps/);
  assert.doesNotMatch(student, /integrity|influence the grader/i);
});

test('teacher feedback expands in a full-width row below the submission', () => {
  const assignments = [{
    id: 'feedback-row', name: 'Feedback Row', task: 'Task', targetClassId: 'class-a', maxScore: 10,
    submissions: [{ email: 'student@example.com', name: 'Student', code: 'print(1)', codeScore: 8,
      aiSuggestedScore: 8, aiFeedback: 'Score: 8/10\n\nExternal grading\n\nFeedback\nGood start.', submittedAt: 'today' }],
  }];
  const { context, list, detail } = assignmentViewHarness(assignments);
  context.teacherClasses[0].students = [{ email: 'student@example.com', name: 'Student' }];
  context.views.renderAdminAssignments();
  list.buttons[0].click();
  assert.match(detail.innerHTML, /class="assignment-feedback-row"/);
  assert.match(detail.innerHTML, /colspan="6"/);
  assert.match(detail.innerHTML, /View feedback for student@example\.com/);
  assert.match(detail.innerHTML, /External grading result/);
  assert.doesNotMatch(detail.innerHTML, /<th>AI feedback<\/th>/);
  assert.match(resourceCss, /\.assignment-feedback-view\{[^}]*grid-template-columns:repeat\(auto-fit/);
  assert.match(resourceCss, /\.assignment-feedback-row>td\{[^}]*white-space:normal/);
});

test('external mode exposes package workflow and hides the built-in queue controls', () => {
  const assignments = [{
    id: 'external', name: 'External', task: 'Task', targetClassId: 'class-a', maxScore: 10,
    aiGradingMode: 'external', aiGradingCriteria: ['objectives'], aiGradingRubric: 'Rubric',
    aiGradingRubricContext: 'context', submissions: [{ email: 'student@example.com', code: 'print(1)' }],
  }];
  const { context, list, detail } = assignmentViewHarness(assignments);
  context.views.renderAdminAssignments();
  list.buttons[0].click();
  assert.match(detail.innerHTML, /value="external" selected/);
  assert.match(detail.innerHTML, /id="assignmentExternalGraderPanel" class="assignment-grader-panel assignment-external-grader" >/);
  assert.match(detail.innerHTML, /id="assignmentInternalAiActions" class="assignment-ai-rigor" hidden/);
  assert.match(detail.innerHTML, /Student identity metadata is limited to email addresses/);
  assert.doesNotMatch(detail.innerHTML, /class="btn secondary ai-grade-submission-btn"/);
});

test('teacher reference panel shows only unlocked assignments for active class', () => {
  const assignments = [
    { id: 'other', name: 'Other Class', task: 'Wrong class', createdAt: '2026-09-25', targetClassId: 'class-b', active: true },
    { id: 'locked', name: 'Locked Task', task: 'Hidden task', createdAt: '2026-09-26', targetClassId: 'class-a', active: false },
    { id: 'newer', name: 'Newer Task', task: 'Newer content', createdAt: '2026-09-29', targetClassId: 'class-a', active: true },
    { id: 'older', name: 'Older Task', task: 'Present <this>', createdAt: '2026-09-28', targetClassId: 'class-a', active: true },
  ];
  const { context, reference, heading } = assignmentViewHarness(assignments);
  context.views.renderTeacherReferenceAssignments();
  assert.equal(heading.textContent, 'Unlocked Assignments · Period A');
  assert.ok(reference.innerHTML.indexOf('Older Task') < reference.innerHTML.indexOf('Newer Task'));
  assert.doesNotMatch(reference.innerHTML, /Locked Task|Other Class|Hidden task|Wrong class/);
  assert.match(reference.innerHTML, /Present &lt;this&gt;/);
  assert.match(html, /id="teacherReferenceAssignmentList"/);
});

test('assignment refresh preserves an unsaved grader draft until it is saved', () => {
  const assignments = [{ id: 'draft', name: 'Draft', task: 'Task', targetClassId: 'class-a', submissions: [], maxScore: 10 }];
  const { context, list, detail } = assignmentViewHarness(assignments);
  context.views.renderAdminAssignments();
  list.buttons[0].click();
  detail.dataset.aiSettingsDirty = 'true';
  detail.innerHTML = 'Unsaved rubric draft';
  context.views.renderAdminAssignments();
  assert.equal(detail.innerHTML, 'Unsaved rubric draft');
  detail.dataset.aiSettingsDirty = 'false';
  context.views.renderAdminAssignments();
  assert.match(detail.innerHTML, /Teacher-approved rubric/);
});

function rubricRequestHarness(fetch) {
  const start = source.indexOf('function selectedAssignmentGradingCriteria(detail)');
  const end = source.indexOf('async function saveAssignmentAiSettings(', start);
  const controls = {
    '#generateAssignmentRubricBtn': { disabled: false, textContent: 'Generate rubric' },
    '#assignmentAiRubric': { disabled: false, value: 'Existing accepted rubric' },
    '#assignmentRubricStatus': { textContent: '' },
    '#acceptAssignmentRubricBtn': { disabled: false },
    '#assignmentAiGradingMode': { disabled: false },
    '#gradeAllSubmissionsBtn': { disabled: false },
  };
  const criterion = { value: 'objectives', disabled: false };
  const detail = {
    dataset: { rubricContext: 'original-context' }, isConnected: true,
    querySelector: selector => controls[selector] || null,
    querySelectorAll: selector => selector.startsWith('.assignment-criterion-check') ? [criterion] : [],
  };
  const context = {
    fetch, document: { getElementById: () => detail },
    getAssignmentByName: () => ({ id: 'assignment-id' }),
    assignmentManagerHeaders: () => ({}), buildAiContext: value => value,
    assignmentRequestPayload: (assignment, extra) => ({ assignmentId: assignment.id, ...extra }),
  };
  vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.rubric = { generateAssignmentRubric, readAssignmentAiResponse };`, context);
  return { context, controls, criterion, detail };
}

test('non-JSON server and proxy failures show status and troubleshooting without rendering HTML', async () => {
  for (const status of [404, 500, 502, 504]) {
    const { context, controls, criterion, detail } = rubricRequestHarness(async () => ({
      ok: false, status, statusText: 'Error', headers: { get: () => 'text/html' },
      json: async () => { throw new SyntaxError('<html>private server traceback</html>'); },
    }));
    await context.rubric.generateAssignmentRubric('assignment-id');
    const message = controls['#assignmentRubricStatus'].textContent;
    assert.match(message, new RegExp(`HTTP ${status}`));
    assert.match(message, /POST \/api\/assignments\/generate-rubric/);
    assert.match(message, /server|proxy/);
    assert.doesNotMatch(message, /private server traceback|<html>/);
    assert.equal(controls['#generateAssignmentRubricBtn'].disabled, false);
    assert.equal(controls['#acceptAssignmentRubricBtn'].disabled, false);
    assert.equal(criterion.disabled, false);
    assert.equal(controls['#assignmentAiRubric'].value, 'Existing accepted rubric');
    assert.equal(detail.dataset.rubricContext, 'original-context');
    assert.equal(controls['#gradeAllSubmissionsBtn'].disabled, false);
  }
});

test('JSON failure shows reference ID and safe model diagnostics', async () => {
  const { context, controls } = rubricRequestHarness(async () => ({
    ok: false, status: 422, headers: { get: () => 'application/json' },
    json: async () => ({ ok: false, error: 'Malformed JSON', errorCode: 'rubric_invalid_output', requestId: 'reference-123',
      details: { stage: 'output_validation', model: 'test-model', attempt: 2, finishReason: 'length', contextTokens: 8192,
        validationError: 'AI returned malformed or truncated JSON', prompt: 'private assignment' } }),
  }));
  await context.rubric.generateAssignmentRubric('assignment-id');
  const message = controls['#assignmentRubricStatus'].textContent;
  assert.match(message, /Malformed JSON/);
  assert.match(message, /Reference: reference-123/);
  assert.match(message, /stage: output_validation/);
  assert.match(message, /model: test-model/);
  assert.match(message, /attempt: 2/);
  assert.match(message, /HTTP 422/);
  assert.match(message, /contextTokens: 8192/);
  assert.match(message, /validationError: AI returned malformed or truncated JSON/);
  assert.doesNotMatch(message, /private assignment/);
});

test('rubric request includes only assignment reference and selected criteria', async () => {
  let sent;
  const { context } = rubricRequestHarness(async (_url, options) => {
    sent = JSON.parse(options.body);
    return { ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => ({ ok: true, rubric: 'Generated scoring rubric', rubricContext: 'new-context' }) };
  });
  context.buildAiContext = () => { throw new Error('Editor context must not be requested'); };
  await context.rubric.generateAssignmentRubric('assignment-id');
  assert.deepEqual(sent, { assignmentId: 'assignment-id', criteria: ['objectives'] });
});

test('context-limit warning preserves rubric draft and exposes only safe size diagnostics', async () => {
  const { context, controls, detail } = rubricRequestHarness(async () => ({
    ok: false, status: 422, headers: { get: () => 'application/json' },
    json: async () => ({ ok: false, error: 'Rubric context/request size limit reached. Nothing was truncated or saved.',
      errorCode: 'rubric_context_limit', details: { contextLimitTokens: 16384, requestBytes: 13000, maxRequestBytes: 12000,
        prompt: 'private source' } }),
  }));
  await context.rubric.generateAssignmentRubric('assignment-id');
  const message = controls['#assignmentRubricStatus'].textContent;
  assert.match(message, /context\/request size limit reached/);
  assert.match(message, /contextLimitTokens: 16384/);
  assert.match(message, /requestBytes: 13000/);
  assert.doesNotMatch(message, /private source/);
  assert.equal(controls['#assignmentAiRubric'].value, 'Existing accepted rubric');
  assert.equal(detail.dataset.rubricContext, 'original-context');
  assert.equal(detail.dataset.aiSettingsDirty, 'false');
  assert.equal(controls['#gradeAllSubmissionsBtn'].disabled, false);
});

test('failed regeneration never enables grading for an unsaved draft', async () => {
  const { context, controls, detail } = rubricRequestHarness(async () => ({
    ok: false, status: 422, headers: { get: () => 'application/json' }, json: async () => ({ ok: false, error: 'Invalid output' }),
  }));
  detail.dataset.aiSettingsDirty = 'true';
  controls['#gradeAllSubmissionsBtn'].disabled = true;
  await context.rubric.generateAssignmentRubric('assignment-id');
  assert.equal(detail.dataset.aiSettingsDirty, 'true');
  assert.equal(controls['#gradeAllSubmissionsBtn'].disabled, true);
});

test('admin rubric context setting is bounded and wired to persisted AI settings', () => {
  assert.match(html, /id="aiRubricContextInputModal" min="2048" max="65536"/);
  assert.match(source, /aiRubricContextInputModal'\)\.value = Number\(currentConfig\?\.ai_rubric_context_tokens/);
  assert.match(source, /ai_rubric_context_tokens = Number\(document\.getElementById\('aiRubricContextInputModal'\)\.value\)/);
  assert.match(source, /ai_request_timeout_seconds,\s*ai_rubric_context_tokens,/);
});

test('network failures include connection guidance and incomplete success never replaces the draft', async () => {
  const network = rubricRequestHarness(async () => { throw new TypeError('Failed to fetch'); });
  await network.context.rubric.generateAssignmentRubric('assignment-id');
  assert.match(network.controls['#assignmentRubricStatus'].textContent, /Check the connection/);
  assert.match(network.controls['#assignmentRubricStatus'].textContent, /Elapsed:/);
  const incomplete = rubricRequestHarness(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
  await incomplete.context.rubric.generateAssignmentRubric('assignment-id');
  assert.match(incomplete.controls['#assignmentRubricStatus'].textContent, /incomplete success response/);
  assert.equal(incomplete.controls['#assignmentAiRubric'].value, 'Existing accepted rubric');
});

test('successful rubric generation locks controls while pending then displays the editable draft', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const { context, controls, criterion, detail } = rubricRequestHarness(() => pending);
  const generation = context.rubric.generateAssignmentRubric('assignment-id');
  assert.equal(criterion.disabled, true);
  assert.equal(controls['#assignmentAiRubric'].disabled, true);
  resolve({ ok: true, status: 200, json: async () => ({ ok: true, rubric: 'New reviewed draft', rubricContext: 'new-context' }) });
  await generation;
  assert.equal(criterion.disabled, false);
  assert.equal(controls['#assignmentAiRubric'].value, 'New reviewed draft');
  assert.equal(detail.dataset.rubricContext, 'new-context');
  assert.equal(controls['#generateAssignmentRubricBtn'].textContent, 'Regenerate rubric');
});
