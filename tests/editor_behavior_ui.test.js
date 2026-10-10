const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const behavior = require('../static/js/editor-behavior.js');
const vm = require('node:vm');

test('textarea keyboard edits mark progress dirty and honor read-only and composition states', () => {
  const source = fs.readFileSync(path.join(__dirname, '../static/js/editor-init.js'), 'utf8');
  const listeners = {}, inputs = [];
  const ta = { value: 'if ready:', selectionStart: 9, selectionEnd: 9, style: {},
    addEventListener(type, callback) { listeners[type] = callback; },
    dispatchEvent(event) { inputs.push(event.type); } };
  const context = { window: { EagleEditorBehavior: behavior }, Event,
    document: { getElementById: () => ta }, localStorage: { getItem: () => null } };
  vm.runInNewContext(source.slice(0, source.indexOf('var editor = initEditor();')) + 'initEditor();', context);
  const press = (key, extra = {}) => listeners.keydown({ key, preventDefault() {}, ...extra });
  press('Enter'); press('Tab');
  assert.equal(ta.value, 'if ready:\n\t\t');
  assert.deepEqual(inputs, ['input', 'input']);
  ta.readOnly = true;
  press('Enter'); press('Tab');
  listeners.paste({ clipboardData: { getData: () => '    changed' }, preventDefault() {} });
  ta.readOnly = false; press('Enter', { isComposing: true });
  assert.equal(ta.value, 'if ready:\n\t\t');
  assert.equal(inputs.length, 2);
});

test('Enter preserves existing indentation and clears it after a blank line', () => {
  assert.deepEqual(behavior.nextPythonIndent('\t\tprint("hi")', 13), { clearBlankLine: false, text: '\n\t\t' });
  assert.deepEqual(behavior.nextPythonIndent('\tif ready:', 10), { clearBlankLine: false, text: '\n\t\t' });
  assert.deepEqual(behavior.nextPythonIndent('\t\t', 2), { clearBlankLine: true, text: '\n' });
  assert.equal(behavior.nextPythonIndent('\tvalue = {"x": 1}', 17).text, '\n\t');

  const edits = [];
  const cm = {
    getOption: () => 'python', getCursor: () => ({ line: 2, ch: 2 }), getLine: () => '\t\t',
    somethingSelected: () => false,
    replaceRange(...args) { edits.push(args); },
    setCursor(pos) { this.cursor = pos; },
  };
  behavior.enter(cm);
  assert.deepEqual(edits[0], ['\n', { line: 2, ch: 0 }, { line: 2, ch: 2 }, '+input']);
  assert.deepEqual(cm.cursor, { line: 3, ch: 0 });
});

test('pasted Python indentation converts consistent leading spaces to tabs', () => {
  const pasted = 'if ready:\n    print("yes")\n    if nested:\n        print("done")';
  assert.equal(
    behavior.normalizePastedIndentation(pasted),
    'if ready:\n\tprint("yes")\n\tif nested:\n\t\tprint("done")',
  );
  assert.equal(behavior.normalizePastedIndentation('  one\n    two'), '\tone\n\t\ttwo');
  assert.equal(behavior.normalizePastedIndentation(' a sentence\n continues'), ' a sentence\n continues');
});

test('only real Python block headers fold and hidden error lines unfold', () => {
  const lines = ['if ready:', '    print("yes")', 'print("done")', 'value = 3'];
  const cm = { getOption: () => 'python', getLine: line => lines[line] };
  const codeMirror = { fold: { indent: (_cm, start) => ({ from: start, to: { line: 1, ch: 16 } }) } };
  assert.ok(behavior.foldRange(cm, { line: 0, ch: 0 }, codeMirror));
  assert.equal(behavior.foldRange(cm, { line: 3, ch: 0 }, codeMirror), null);
  const hidden = [{ __isFold: true, clear() { this.cleared = true; } }];
  const editor = {
    findMarksAt() { return hidden.filter(mark => !mark.cleared); },
    scrollIntoView(pos) { this.scrolledTo = pos; },
  };
  behavior.unfoldLine(editor, 1);
  assert.equal(hidden[0].cleared, true);
  assert.deepEqual(editor.scrolledTo, { line: 1, ch: 0 });

  const editorSource = fs.readFileSync(path.join(__dirname, '../static/js/editor-init.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(__dirname, '../static/js/app-core.js'), 'utf8');
  assert.match(editorSource, /foldGutter: \{ rangeFinder: eagleFoldRange/);
  assert.match(appSource, /EagleEditorBehavior\?\.unfoldLine\(cm, lineNum\)/);
});

test('fold controls have visible gutter icons and a compact collapsed marker', () => {
  const css = fs.readFileSync(path.join(__dirname, '../static/css/features/editor.css'), 'utf8');
  const editorSource = fs.readFileSync(path.join(__dirname, '../static/js/editor-init.js'), 'utf8');
  assert.match(css, /\.CodeMirror \.eagle-fold-open::after\s*\{\s*content:\s*'−'/);
  assert.match(css, /\.CodeMirror \.eagle-fold-closed::after\s*\{\s*content:\s*'\+'/);
  assert.doesNotMatch(css, /\.CodeMirror-foldgutter \.eagle-fold-/);
  assert.match(css, /\.CodeMirror-foldmarker\s*\{[^}]*border-radius:\s*999px/s);
  assert.equal((editorSource.match(/widget: '⋯'/g) || []).length, 2);
});
