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

test('analysis refuses oversized editor buffers', () => {
  const oversized = 'value = 1\n'.repeat(autocomplete.MAX_ANALYSIS_LENGTH / 5);
  const result = autocomplete.analyzePython(oversized);
  assert.equal(result.tooLarge, true);
  assert.equal(result.variables.length, 0);
});
