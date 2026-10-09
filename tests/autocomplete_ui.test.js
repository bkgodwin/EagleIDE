// Run with node --test tests/autocomplete_ui.test.js (no packages required).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const autocomplete = require('../static/js/autocomplete.js');

test('Python analysis collects functions, methods, attributes, types, and docstrings', () => {
  const source = [
    'def greet(name: str) -> str:',
    '    """Build a friendly greeting."""',
    '    return "Hello " + name',
    '',
    'class Robot:',
    '    """A classroom robot."""',
    '    def __init__(self, label: str):',
    '        self.label: str = label',
    '    def speak(self, words: str, loud=False) -> str:',
    '        """Return the words the robot should say."""',
    '        return words',
    '',
    'bot = Robot("Eagle")',
    'lines: list[str] = []',
    'handle = open("notes.txt")',
    'bot.status = "ready"',
  ].join('\n');
  const result = autocomplete.analyzePython(source);

  assert.equal(result.functions.find(item => item.name === 'greet').description, 'Build a friendly greeting.');
  assert.equal(result.classes.find(item => item.name === 'Robot').description, 'A classroom robot.');
  const speak = result.methods.get('Robot').find(item => item.name === 'speak');
  assert.equal(speak.signature, '(words: str, loud=False)');
  assert.equal(speak.returns, 'str');
  assert.equal(speak.description, 'Return the words the robot should say.');
  assert.equal(result.attributes.get('Robot').find(item => item.name === 'label').returns, 'str');
  assert.equal(result.objectAttributes.get('bot').find(item => item.name === 'status').returns, 'str');
  assert.equal(result.varTypes.get('bot'), 'Robot');
  assert.equal(result.varTypes.get('lines'), 'list');
  assert.equal(result.varTypes.get('handle'), 'file');
  assert.equal(result.varTypes.get('words'), 'str');
});

test('Python analysis propagates input, string, and list result types through aliases', () => {
  const result = autocomplete.analyzePython([
    'answer = input("Answer: ")',
    'copied_answer = answer',
    'words = copied_answer.split()',
    'copied_words = words',
  ].join('\n'));

  assert.equal(result.varTypes.get('answer'), 'str');
  assert.equal(result.varTypes.get('copied_answer'), 'str');
  assert.equal(result.varTypes.get('words'), 'list');
  assert.equal(result.varTypes.get('copied_words'), 'list');

  const catalog = autocomplete.catalogIndex([
    { language: 'python', owner: 'str', name: 'upper', kind: 'method', signature: '()', returns: 'str', description: 'Uppercase text.' },
    { language: 'python', owner: 'list', name: 'append', kind: 'method', signature: '(item)', returns: 'None', description: 'Append an item.' },
  ]);
  const suggestions = object => autocomplete.buildSuggestionSet({
    language: 'python', analysis: result, catalog,
    context: { mode: 'member', object, partial: '', fromCh: 0 },
  }).map(item => item.name);
  assert.ok(suggestions('copied_answer').includes('upper'));
  assert.ok(suggestions('copied_words').includes('append'));
});

test('import and from contexts suggest available modules and module members', () => {
  const analysis = autocomplete.analyzePython('');
  const modules = [
    { name: 'datetime', description: 'Date and time helpers.' },
    { name: 'time', description: 'Clock helpers.' },
  ];
  const catalog = autocomplete.catalogIndex([
    { language: 'python', owner: 'datetime', name: 'date', kind: 'class', signature: '(year, month, day)', returns: 'datetime.date', description: 'A calendar date.' },
  ]);
  const importContext = autocomplete.contextAt('import dat', 10);
  assert.deepEqual(importContext, { mode: 'module', object: '', partial: 'dat', fromCh: 7 });
  const importItems = autocomplete.buildSuggestionSet({ language: 'python', analysis, catalog, modules, context: importContext });
  assert.deepEqual(importItems.map(item => item.name), ['datetime']);
  assert.equal(importItems[0].kind, 'module');

  const fromContext = autocomplete.contextAt('from ti', 7);
  assert.deepEqual(fromContext, { mode: 'module', object: '', partial: 'ti', fromCh: 5 });
  assert.deepEqual(
    autocomplete.buildSuggestionSet({ language: 'python', analysis, catalog, modules, context: fromContext }).map(item => item.name),
    ['time'],
  );

  const memberContext = autocomplete.contextAt('from datetime import da', 23);
  assert.deepEqual(memberContext, { mode: 'import-member', object: 'datetime', partial: 'da', fromCh: 21 });
  assert.deepEqual(
    autocomplete.buildSuggestionSet({ language: 'python', analysis, catalog, modules, context: memberContext }).map(item => item.name),
    ['date'],
  );
  assert.deepEqual(
    autocomplete.buildSuggestionSet({ language: 'javascript', analysis: autocomplete.analyzeJavascript(''), catalog, modules, context: importContext }),
    [],
  );
});

test('member suggestions combine catalog methods with user class members', () => {
  const source = [
    'class Robot:',
    '    def reset(self, force=False) -> bool:',
    '        """Reset the robot."""',
    '        self.ready = True',
    '        return True',
    'bot = Robot()',
    'handle = open("data.txt")',
  ].join('\n');
  const analysis = autocomplete.analyzePython(source);
  const catalog = autocomplete.catalogIndex([
    { language: 'python', owner: 'file', name: 'readline', kind: 'method', signature: '(size=-1)', returns: 'str', description: 'Read one line.' },
  ]);
  const robotItems = autocomplete.buildSuggestionSet({
    language: 'python', analysis, catalog,
    context: { mode: 'member', object: 'bot', partial: 're', fromCh: 4 },
  });
  assert.deepEqual(robotItems.map(item => item.name), ['reset', 'ready']);
  assert.equal(robotItems[0].description, 'Reset the robot.');

  const fileItems = autocomplete.buildSuggestionSet({
    language: 'python', analysis, catalog,
    context: { mode: 'member', object: 'handle', partial: 'read', fromCh: 7 },
  });
  assert.deepEqual(fileItems.map(item => item.name), ['readline']);
  assert.equal(fileItems[0].signature, '(size=-1)');
});

test('Python imports expose CSV, JSON, random, and direct open-file members from the catalog', () => {
  const source = [
    'import csv',
    'import json as JSON',
    'import random',
    'with open("records.txt") as handle:',
    '    pass',
  ].join('\n');
  const analysis = autocomplete.analyzePython(source);
  const catalog = autocomplete.catalogIndex([
    { language: 'python', owner: 'csv', name: 'DictReader', kind: 'class', signature: '(f, fieldnames=None)', returns: 'csv.DictReader', description: 'Reads CSV rows as dictionaries.' },
    { language: 'python', owner: 'json', name: 'loads', kind: 'function', signature: '(s, **kwargs)', returns: 'Any', description: 'Parses JSON text.' },
    { language: 'python', owner: 'random', name: 'randint', kind: 'function', signature: '(a, b)', returns: 'int', description: 'Returns an inclusive random integer.' },
    { language: 'python', owner: 'file', name: 'read', kind: 'method', signature: '(size=-1)', returns: 'str', description: 'Reads file text.' },
  ]);
  assert.equal(analysis.varTypes.get('csv'), 'csv');
  assert.equal(analysis.varTypes.get('JSON'), 'json');
  assert.equal(analysis.varTypes.get('random'), 'random');
  assert.equal(analysis.varTypes.get('handle'), 'file');

  const csvItems = autocomplete.buildSuggestionSet({
    language: 'python', analysis, catalog,
    context: { mode: 'member', object: 'csv', partial: 'Dict', fromCh: 4 },
  });
  assert.equal(csvItems[0].name, 'DictReader');
  assert.equal(csvItems[0].description, 'Reads CSV rows as dictionaries.');

  const jsonItems = autocomplete.buildSuggestionSet({
    language: 'python', analysis, catalog,
    context: { mode: 'member', object: 'JSON', partial: 'lo', fromCh: 5 },
  });
  assert.equal(jsonItems[0].name, 'loads');

  const randomItems = autocomplete.buildSuggestionSet({
    language: 'python', analysis, catalog,
    context: { mode: 'member', object: 'random', partial: 'rand', fromCh: 7 },
  });
  assert.equal(randomItems[0].name, 'randint');

  const directFileContext = autocomplete.contextAt('open("records.txt").rea', 23);
  assert.deepEqual(directFileContext, { mode: 'member', object: 'open("records.txt")', partial: 'rea', fromCh: 20 });
  const directFileItems = autocomplete.buildSuggestionSet({ language: 'python', analysis, catalog, context: directFileContext });
  assert.equal(directFileItems[0].name, 'read');
});

test('Python object and dotted-module completions retain specific helper text', () => {
  const source = [
    'import csv as data_csv',
    'import matplotlib.pyplot as plt',
    'import numpy as np',
    'import sqlite3',
    'import math as m',
    'from pathlib import Path',
    'from math import sqrt as root',
    'with open("records.csv") as handle:',
    '    rows = data_csv.DictReader(handle)',
    '    for row in rows:',
    '        pass',
    'output = data_csv.writer(handle)',
    'values = np.zeros(4)',
    'file_path = Path("records.csv")',
    'with file_path.open() as stream:',
    '    pass',
    'figure, axes = plt.subplots()',
    'database = sqlite3.connect("data.db")',
    'cursor = database.cursor()',
  ].join('\n');
  const analysis = autocomplete.analyzePython(source);
  assert.equal(analysis.varTypes.get('rows'), 'csv.DictReader');
  assert.equal(analysis.varTypes.get('row'), 'dict');
  assert.equal(analysis.varTypes.get('output'), 'csv.writer');
  assert.equal(analysis.varTypes.get('values'), 'numpy.ndarray');
  assert.equal(analysis.varTypes.get('file_path'), 'pathlib.Path');
  assert.equal(analysis.varTypes.get('stream'), 'file');
  assert.equal(analysis.varTypes.get('figure'), 'matplotlib.figure.Figure');
  assert.equal(analysis.varTypes.get('axes'), 'matplotlib.axes.Axes');
  assert.equal(analysis.varTypes.get('cursor'), 'sqlite3.Cursor');
  const catalog = autocomplete.catalogIndex([
    { language: 'python', owner: 'csv.DictReader', name: 'fieldnames', kind: 'attribute', returns: 'list', description: 'CSV column names.' },
    { language: 'python', owner: 'csv.writer', name: 'writerow', kind: 'method', signature: '(row)', returns: 'int', description: 'Write one CSV row.' },
    { language: 'python', owner: 'dict', name: 'get', kind: 'method', signature: '(key)', returns: 'Any', description: 'Read a value safely.' },
    { language: 'python', owner: 'numpy.ndarray', name: 'reshape', kind: 'method', signature: '(shape)', returns: 'numpy.ndarray', description: 'Change array shape.' },
    { language: 'python', owner: 'matplotlib.pyplot', name: 'plot', kind: 'function', signature: '(x, y)', returns: 'list', description: 'Draw a line chart.' },
    { language: 'python', owner: 'matplotlib.axes.Axes', name: 'set_title', kind: 'method', signature: '(label)', returns: 'Text', description: 'Label the axes.' },
    { language: 'python', owner: 'math', name: 'sqrt', kind: 'function', signature: '(x)', returns: 'float', description: 'Compute a square root.' },
  ]);
  const names = (object, partial) => autocomplete.buildSuggestionSet({
    language: 'python', analysis, catalog, context: { mode: 'member', object, partial, fromCh: 0 },
  });
  assert.equal(names('rows', 'field')[0].description, 'CSV column names.');
  assert.equal(names('output', 'writer')[0].name, 'writerow');
  assert.equal(names('row', 'get')[0].name, 'get');
  assert.equal(names('values', 'res')[0].name, 'reshape');
  assert.equal(names('plt', 'plot')[0].description, 'Draw a line chart.');
  assert.equal(names('axes', 'set')[0].name, 'set_title');
  assert.equal(names('m', 'sq')[0].description, 'Compute a square root.');
  assert.equal(names('data_csv.DictReader(handle)', 'field')[0].name, 'fieldnames');
  const imported = autocomplete.buildSuggestionSet({
    language: 'python', analysis, catalog, context: { mode: 'global', object: '', partial: 'root', fromCh: 0 },
  });
  assert.equal(imported[0].description, 'Compute a square root.');
  assert.equal(imported[0].name, 'root');
  assert.equal(autocomplete.contextAt('plt.plot', 8).object, 'plt');
  assert.equal(autocomplete.contextAt('matplotlib.pyplot.plot', 22).object, 'matplotlib.pyplot');
  assert.equal(autocomplete.contextAt('data_csv.DictReader(handle).field', 33).object, 'data_csv.DictReader(handle)');
  assert.equal(autocomplete.contextAt('np.zeros(4).reshape', 19).object, 'np.zeros(4)');
});

test('completion context rejects comments and unfinished strings but supports a bare dot', () => {
  assert.deepEqual(
    autocomplete.contextAt('handle.', 7),
    { mode: 'member', object: 'handle', partial: '', fromCh: 7 },
  );
  assert.equal(autocomplete.contextAt('# handle.re', 11), null);
  assert.equal(autocomplete.contextAt('message = "handle.re', 20), null);
  assert.deepEqual(
    autocomplete.contextAt('message.upper', 13),
    { mode: 'member', object: 'message', partial: 'upper', fromCh: 8 },
  );
});

test('disabled engine does not fetch metadata or schedule analysis work', async () => {
  const handlers = {};
  let fetches = 0;
  let reads = 0;
  const cm = {
    on(name, handler) { handlers[name] = handler; },
    getOption() { return 'python'; },
    getValue() { reads += 1; return 'pri'; },
    getCursor() { return { line: 0, ch: 3 }; },
    getLine() { return 'pri'; },
    somethingSelected() { return false; },
  };
  const engine = autocomplete.createEngine(cm, {
    enabled: false,
    document: null,
    window: { addEventListener() {} },
    fetch: async () => { fetches += 1; return { ok: true, json: async () => ({ entries: [] }) }; },
    debounceMs: 0,
  });
  handlers.inputRead();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(fetches, 0);
  assert.equal(reads, 0);

  engine.setEnabled(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetches, 1);
  engine.setEnabled(false);
});

test('Enter and Tab accept the highlighted suggestion without a mouse click', () => {
  const handlers = {};
  const makeNode = () => ({
    children: [], style: {}, className: '', textContent: '',
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild(child) { this.children.push(child); return child; },
    append(...children) { this.children.push(...children); },
    setAttribute() {}, addEventListener() {}, scrollIntoView() {},
    querySelectorAll() { return this.children; },
    getBoundingClientRect() { return { right: 200, bottom: 200, width: 180, height: 180 }; },
  });
  const document = { body: makeNode(), createElement: makeNode, addEventListener() {} };
  let replacements = 0;
  const cm = {
    on(name, handler) { handlers[name] = handler; },
    getOption: () => 'python', getValue: () => 'pri', getCursor: () => ({ line: 0, ch: 3 }),
    getLine: () => 'pri', somethingSelected: () => false,
    cursorCoords: () => ({ left: 10, top: 10, bottom: 25 }),
    replaceRange() { replacements += 1; }, focus() {},
  };
  const engine = autocomplete.createEngine(cm, { enabled: true, document, window: { innerWidth: 800, innerHeight: 600, addEventListener() {} } });
  engine.check();
  let prevented = 0;
  handlers.keydown(cm, { key: 'Enter', preventDefault() { prevented += 1; } });
  assert.equal(prevented, 1);
  assert.equal(replacements, 1);
  engine.check();
  handlers.keydown(cm, { key: 'Tab', preventDefault() { prevented += 1; } });
  assert.equal(prevented, 2);
  assert.equal(replacements, 2);
  engine.check();
  handlers.keydown(cm, { key: 'Tab', shiftKey: true, preventDefault() { prevented += 1; } });
  assert.equal(prevented, 2, 'Shift+Tab remains available for editor indentation');
  engine.check();
  handlers.keydown(cm, { key: 'ArrowDown', preventDefault() { prevented += 1; } });
  handlers.keydown(cm, { key: 'Enter', preventDefault() { prevented += 1; } });
  assert.equal(replacements, 3);
});

test('analysis refuses oversized editor buffers', () => {
  const oversized = 'value = 1\n'.repeat(autocomplete.MAX_ANALYSIS_LENGTH / 5);
  const result = autocomplete.analyzePython(oversized);
  assert.equal(result.tooLarge, true);
  assert.equal(result.variables.length, 0);
});
