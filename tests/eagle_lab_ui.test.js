const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
  assert.match(lab, /setTimeout\(save,700\)/);
  assert.match(lab, /method:'PUT'.*revision,responses/);
  assert.match(lab, /error\.status===409/);
  assert.match(lab, /question\.type==='procedure'/);
  assert.match(lab, /question\.type==='fill_blank'/);
});

test('teacher composer exposes only report controls for lab report assignments', () => {
  assert.match(core, /<option value="lab_report"/);
  assert.match(core, /<option value="fill_blank">Fill in the Blank/);
  assert.match(core, /<option value="procedure">Procedure Checklist/);
  assert.match(core, /showAddQuestionModal\([^\n]+lab_report/);
});
