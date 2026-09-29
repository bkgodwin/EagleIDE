const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'static', 'js', 'app-core.js'), 'utf8');
const studentDashboard = fs.readFileSync(path.join(root, 'static', 'js', 'student-dashboard.js'), 'utf8');
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
  assert.match(html, /id="assignmentAiQueueModal"/);
});

test('student dashboard owns locked assignment history and can copy preserved code to a draft editor', () => {
  assert.doesNotMatch(html, /id="studentPastAssignmentList"/);
  assert.match(html, /data-view="student-dash-past"/);
  assert.match(html, /id="studentPastAssignmentsPane"/);
  assert.match(studentDashboard, /\/api\/assignments\/past\?classId=/);
  assert.match(studentDashboard, /source: 'assignment'/);
  assert.match(studentDashboard, /setEditorSnapshot/);
  assert.match(studentDashboard, /Teacher-shared AI feedback/);
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
  const detail = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
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
    TEACHER_TOKEN: 'teacher-token', document: { getElementById: id => nodes[id] || null },
    escapeHtml: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    getAssignmentByName: id => assignments.find(a => a.id === id),
    rigorLevelLabel: () => 'High School', assignmentRigorSummary: () => 'Core objectives',
  };
  vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.views = { renderAdminAssignments, renderTeacherReferenceAssignments };`, context);
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
