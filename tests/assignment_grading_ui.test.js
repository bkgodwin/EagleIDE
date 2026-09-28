const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'static', 'js', 'app-core.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('teacher assignment table includes missing, manual, AI, and export controls', () => {
  assert.match(source, /Not turned in/);
  assert.match(source, /assignment-grade-input/);
  assert.match(source, /AI Grade All/);
  assert.match(source, /Additional grading instructions/);
  assert.match(source, /Percent \(1 decimal\)/);
  assert.match(source, /aiFeedback/);
});

test('submission editor navigation and minimized dashboard use stable assignment IDs', () => {
  assert.match(html, /id="previousSubmissionBtn"/);
  assert.match(html, /id="nextSubmissionBtn"/);
  assert.match(html, /id="teacherDashMinimizedBar"/);
  assert.match(source, /assignmentId: assignment\?\.id/);
  assert.match(source, /minimizeTeacherDashboardForSubmission/);
  assert.match(source, /navigateAssignmentSubmission/);
});

test('student assignment actions target IDs instead of ambiguous duplicate names', () => {
  assert.match(source, /data-id="\$\{escapeHtml\(a\.id \|\| a\.name\)\}"/);
  assert.match(source, /assignmentRequestPayload\(assignment/);
});
