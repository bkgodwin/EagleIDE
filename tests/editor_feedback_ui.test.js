const test = require('node:test');
const assert = require('node:assert/strict');
const feedback = require('../static/js/editor-feedback.js');
const autocomplete = require('../static/js/autocomplete.js');
const analyze = (source, language = 'python') => feedback.analyze(source, language, autocomplete);

test('caret occurrences use whole user names, exclude strings/comments and builtins', () => {
  const source = 'name = input("name")\nnames = [name]\n# name\ndef greet(person):\n\treturn name + person\nclass Eagle:\n\tpass\ngreet(name)\n';
  const model = analyze(source);
  assert.equal(feedback.occurrences(model, 0).length, 4);
  assert.equal(feedback.occurrences(model, 4).length, 4);
  assert.equal(feedback.occurrences(model, source.indexOf('input')).length, 0);
  assert.equal(feedback.occurrences(model, source.indexOf('greet')).length, 2);
  assert.equal(feedback.occurrences(model, source.indexOf('Eagle')).length, 1);
  assert.equal(feedback.occurrences(model, source.indexOf('"name"') + 2).length, 0);
  assert.equal(feedback.occurrences(model, source.indexOf('# name') + 3).length, 0);
  const instance = analyze('class Eagle:\n\tdef greet(self):\n\t\tself.name = 1\n');
  assert.equal(feedback.occurrences(instance, instance.source.indexOf('self')).length, 2);
});

test('literal selections find all text types and work in HTML, CSS and JavaScript', () => {
  for (const language of ['python', 'javascript', 'css', 'html']) {
    const model = analyze('value = "42"; // 42\n42\n42', language);
    assert.equal(feedback.occurrences(model, 0, '42').length, 4);
    assert.equal(feedback.occurrences(model, 0, '42\n42').length, 1);
    assert.equal(feedback.occurrences(model, 0, ' ').length, 0);
  }
});

test('nested bracket shading matches both directions and carries an open group to EOF', () => {
  const source = 'print((name + 2))';
  const model = analyze(source);
  assert.deepEqual(feedback.bracketRange(model, 7), { start: 6, char: '(', end: 15, closed: true });
  assert.equal(feedback.bracketRange(model, 16).start, 6);
  const open = analyze('print(\n\tname\n');
  assert.equal(feedback.bracketRange(open, 6).end, open.source.length);
  assert.equal(feedback.bracketRange(open, 6).closed, false);
  assert.match(open.diagnostics[0].message, /Unclosed '\('/);
  assert.equal(analyze('print("(") # )').diagnostics.length, 0);
  assert.ok(analyze('print([1, 2)').diagnostics.some(item => /Unexpected/.test(item.message)));
  const orphan = analyze(')\nprint(1)');
  assert.equal(feedback.bracketRange(orphan, 1).end, orphan.source.length);
});

test('hints identify spelling mistakes, strings and missing block colons without flagging bindings', () => {
  const source = 'import math as m\nfrom math import pi, sqrt\na, b = 1, 2\ndef greet(person, suffix="!"):\n\tfor i in range(2):\n\t\tprint(person, suffix, i, a, b, m.pi, sqrt(pi))\nprint(nmae)\n';
  const issues = analyze(source).diagnostics;
  assert.equal(issues.length, 1, JSON.stringify(issues));
  assert.match(issues[0].message, /'nmae' may be undefined/);
  assert.equal(issues[0].severity, 'warning');
  assert.ok(analyze('if True\n\tprint(1)').diagnostics.some(item => /block header/.test(item.message)));
  assert.ok(analyze('name = "hello').diagnostics.some(item => /Unclosed string/.test(item.message)));
  assert.equal(analyze('text = """\nclass Fake:\n    missing\n"""\nprint(text)').diagnostics.length, 0);
  assert.equal(analyze('from module import *\nprint(dynamic_name)').diagnostics.length, 0);
  assert.equal(analyze('items = [n for n in range(4)]\nprint(items)').diagnostics.length, 0);
  assert.equal(analyze('if True: print(1)\nclass Eagle: pass').diagnostics.length, 0);
  assert.equal(analyze('raise ConnectionError("hello")').diagnostics.length, 0);
  assert.equal(analyze('from math import (\n\tpi,\n\tsqrt\n)\nprint(sqrt(pi))').diagnostics.length, 0);
  assert.equal(analyze('first, *rest = [1, 2]\nprint(first, rest)').diagnostics.length, 0);
});

test('block guides follow nested blocks and multiline groups, stopping at the dedent', () => {
  const model = analyze('def greet():\n\tif True:\n\t\tprint(\n\t\t\t1\n\t\t)\n\treturn 1\nprint(greet())');
  assert.ok(model.guides.some(guide => guide.from === 1 && guide.to === 5 && guide.column === 0));
  assert.ok(model.guides.some(guide => guide.from === 2 && guide.to === 4 && guide.column === 4));
  assert.ok(model.guides.some(guide => guide.from === 3 && guide.to === 4 && guide.column === 8));
  assert.ok(model.guides.every(guide => guide.to < 6));
  assert.equal(analyze('value = 1\n\nprint(value)').guides.length, 0);
  assert.ok(analyze('def greet(\n\tperson\n):\n\tprint(person)\nprint(1)').guides.some(guide => guide.from === 1 && guide.to === 3 && guide.column === 0));
});

test('JavaScript caret symbols and delimiter analysis ignore regexes and comments', () => {
  const source = 'const count = 1;\nfunction add(value) { return value + count; }\nadd(count);\nconst pattern = /[()]/;\n// unmatched (\n';
  const model = analyze(source, 'javascript');
  assert.equal(model.diagnostics.length, 0);
  assert.equal(feedback.occurrences(model, source.indexOf('count')).length, 3);
  assert.equal(feedback.occurrences(model, source.indexOf('value')).length, 2);
  const destructured = analyze('const {name: person} = data;\nconst [first, second] = items;\nconsole.log(person, first, second);', 'javascript');
  assert.equal(feedback.occurrences(destructured, destructured.source.indexOf('person')).length, 2);
  const issues = analyze('const name = "Eagle";\nfunction greet(person) { return person + name; }\nconsole.log(nmae);', 'javascript').diagnostics;
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /'nmae' may be undefined/);
  assert.equal(analyze('class Eagle { greet(name) { return name; } }\ntry { new Eagle().greet("hi"); } catch (error) { console.log(error.message); }', 'javascript').diagnostics.length, 0);
  assert.equal(analyze('let a = 1,\n b = 2;\nconsole.log(a, b);\nimport {\n greet\n} from "helpers";\ngreet();', 'javascript').diagnostics.length, 0);
});

test('large documents pause analysis and occurrence searches', () => {
  const model = analyze('x'.repeat(feedback.MAX_SOURCE + 1));
  assert.equal(model.tooLarge, true);
  assert.deepEqual(model.diagnostics, []);
  assert.deepEqual(feedback.occurrences(model, 0, 'x'), []);
  assert.equal(feedback.bracketRange(model, 0), null);
});

function editorHarness(source) {
  function node() {
    return {
      children: [], attrs: {}, events: {}, style: {}, hidden: false,
      set textContent(value) { this.text = value; this.children = []; },
      get textContent() { return this.text || ''; },
      append(...items) { this.children.push(...items); },
      appendChild(item) { this.children.push(item); },
      setAttribute(key, value) { this.attrs[key] = value; },
      addEventListener(name, action) { this.events[name] = action; },
      focus() {},
    };
  }
  const handlers = {}, wrapper = node(), marks = [];
  const cm = {
    source, cursor: { line: 0, ch: 0 }, selection: '', selections: [{}], mode: 'python', viewport: { from: 0, to: 3 },
    getValue() { return this.source; }, getOption(name) { return name === 'mode' ? this.mode : 4; },
    getWrapperElement: () => wrapper,
    getLine(line) { return this.source.split('\n')[line] || ''; },
    lineCount() { return this.source.split('\n').length; },
    getLineTokens(line) { return [{ start: 0, end: this.getLine(line).length, type: null }]; },
    getLineNumber: line => line, defaultCharWidth: () => 8,
    getViewport() { return this.viewport; },
    getCursor() { return this.cursor; }, getSelection() { return this.selection; },
    listSelections() { return this.selections; },
    lineClasses: new Map(),
    addLineClass(line, _where, name) {
      this.lineClasses.set(`${line}:${name}`, true);
      if (name === 'eagle-active-line') this.active = { line, name };
      return line;
    },
    removeLineClass(line, _where, name) {
      this.lineClasses.delete(`${line}:${name}`);
      if (name === 'eagle-active-line') this.active = null;
    },
    markText(from, to, options) {
      const mark = { from, to, ...options, clear() { this.cleared = true; } };
      marks.push(mark); return mark;
    },
    operation(action) { action(); },
    on(event, action) { (handlers[event] ||= []).push(action); },
    emit(event, ...args) { (handlers[event] || []).forEach(action => action(this, ...args)); },
    refresh() { for (let line = 0; line < this.lineCount(); line++) this.emit('renderLine', line, node()); },
    addKeyMap(map) { this.keyMap = map; }, toggleOverwrite(value) { this.overwrite = value; },
    setCursor(pos) { this.cursor = pos; this.emit('cursorActivity'); },
    scrollIntoView(pos) { this.scrolled = pos; }, focus() { this.focused = true; },
  };
  const controller = feedback.attach(cm, { document: { createElement: node }, autocomplete });
  return { cm, controller, wrapper, marks: () => marks.filter(mark => !mark.cleared) };
}

test('live hints clear stale marks on edits/mode changes and preserve runtime highlights', async () => {
  const harness = editorHarness('name = 1\n    print(nmae)\nprint(name)');
  const { cm, wrapper, controller } = harness;
  assert.ok(harness.marks().some(mark => mark.className === 'eagle-diagnostic-warning'));
  assert.ok(harness.marks().some(mark => mark.className === 'eagle-indent-spaces'));
  const runtime = cm.markText({ line: 0, ch: 0 }, { line: 0, ch: 4 }, { className: 'cm-error-line' });
  wrapper.children[1].children[0].events.click();
  assert.deepEqual(cm.scrolled, { line: 1, ch: 10 });
  assert.equal(cm.focused, true);
  cm.source = 'name = 1\n\tprint(name)';
  cm.emit('changes');
  assert.equal(controller.getModel(), null);
  assert.deepEqual(harness.marks(), [runtime]);
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.equal(controller.getModel().diagnostics.length, 0);
  assert.ok(harness.marks().some(mark => mark.className === 'eagle-occurrence'));
  cm.mode = 'htmlmixed'; cm.emit('optionChange', 'mode');
  assert.equal(controller.getModel(), null);
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.equal(controller.getModel().language, 'html');
  assert.equal(runtime.cleared, undefined);
  cm.keyMap.Insert(cm);
  assert.equal(cm.overwrite, false);
});

test('caret row moves immediately even while source analysis is pending', () => {
  const { cm } = editorHarness('x = 1\nprint(x)');
  cm.setCursor({ line: 1, ch: 0 });
  assert.equal(cm.active.line, 1);
  cm.source = 'x = 1\nprint(x)\nprint(x)'; cm.emit('changes');
  cm.setCursor({ line: 2, ch: 0 });
  assert.equal(cm.active.line, 2);
});

test('arrow-key feedback does not copy the full buffer or refresh the editor', async () => {
  const { cm } = editorHarness('value = 1\nprint(value)');
  cm.getValue = () => { throw new Error('arrow keys must not read the document'); };
  cm.refresh = () => { throw new Error('feedback must not remeasure the viewport'); };
  cm.setCursor({line:1, ch:7});
  await new Promise(resolve => setTimeout(resolve,70));
  assert.equal(cm.active.line,1);
});

test('unfinished groups shade full rows to EOF; single-line strings stop at the row end', async () => {
  const { cm, controller } = editorHarness('values = [\n\t1,\n\t2');
  assert.deepEqual(controller.getModel().openLines, [true, true, true]);
  assert.equal(cm.lineClasses.has('2:eagle-open-range-line'), true);
  cm.source += '\n]'; cm.emit('changes');
  assert.equal(cm.lineClasses.has('2:eagle-open-range-line'), false);
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.ok(controller.getModel().openLines.every(open => !open));
  assert.deepEqual(feedback.analyze('message = "hello\nprint(1)', 'python', autocomplete).openLines, [true, false]);
  assert.deepEqual(feedback.analyze('message = """hello\nworld', 'python', autocomplete).openLines, [true, true]);
});

test('viewport leading-space warnings and multiple-selection handling stay bounded', async () => {
  const { cm, marks } = editorHarness('name = 1\n\t print(name)\n  print(name)');
  assert.equal(marks().filter(mark => mark.className === 'eagle-indent-spaces').length, 2);
  cm.viewport = { from: 0, to: 1 }; cm.emit('viewportChange');
  assert.equal(marks().filter(mark => mark.className === 'eagle-indent-spaces').length, 0);
  cm.selections = [{}, {}]; cm.emit('cursorActivity');
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(marks().filter(mark => mark.className === 'eagle-occurrence').length, 0);
  assert.equal(cm.active.line, cm.cursor.line);
});
