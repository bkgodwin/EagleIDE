const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'static/js/student-notebook.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'static/css/features/student-notebook.css'), 'utf8');

test('slow notebook saves retain newer edits, serialize writes, and pause offline', async () => {
  const requests = [];
  let lost = false;
  const context = { window: { EagleIDE: { connection: { isLost: () => lost, request(url, options) {
    return new Promise(resolve => requests.push({ body: JSON.parse(options.body), resolve }));
  } } } }, console, clearTimeout, setTimeout };
  const saveSource = source.slice(source.indexOf('  async function saveNotebook('), source.indexOf('  function scheduleSave('));
  vm.runInNewContext(`
    let notebook = { value: 'first' }, activeClassId = 'class-1', dirty = false, saving = null, saveTimer = null;
    const SAVE_DELAY_MS = 1;
    function isStudentInClass() { return true; }
    function currentClassId() { return activeClassId; }
    function persistActivePageFromDom() {}
    function userJsonHeaders() { return {}; }
    function setStatus() {}
    function ensureNotebookShape(value) { return value; }
    ${saveSource}
    globalThis.api = { saveNotebook, edit(value) { notebook.value = value; dirty = true; },
      state() { return { value: notebook.value, dirty }; } };
  `, context);
  const first = context.api.saveNotebook({ immediate: true });
  context.api.edit('newer');
  const second = context.api.saveNotebook({ immediate: true });
  assert.equal(requests.length, 1);
  requests[0].resolve({ json: async () => ({ ok: true, notebook: { value: 'first' } }) });
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.notebook.value, 'newer');
  assert.equal(context.api.state().dirty, true);
  requests[1].resolve({ json: async () => ({ ok: true, notebook: { value: 'newer' } }) });
  await second;
  assert.equal(context.api.state().value, 'newer');
  assert.equal(context.api.state().dirty, false);
  lost = true; context.api.edit('offline');
  await context.api.saveNotebook({ immediate: true });
  assert.equal(requests.length, 2);
  assert.equal(context.api.state().dirty, true);
});

test('notebook toggle closes the drawer and tracks the visible iPad viewport', async () => {
  const properties = {};
  const style = { setProperty(name, value) { properties[name] = value; } };
  const classes = new Set();
  const classList = { add(name) { classes.add(name); }, remove(name) { classes.delete(name); }, contains(name) { return classes.has(name); } };
  const home = { insertBefore(node) { node.parentNode = home; } };
  const body = { classList, appendChild(node) { node.parentNode = body; } };
  const button = { parentNode: home, nextSibling: null, listeners: {}, style: {},
    addEventListener(type, callback) { this.listeners[type] = callback; },
    setAttribute(name, value) { this[name] = value; } };
  const drawer = { classList: { add(name) { this[name] = true; }, remove(name) { this[name] = false; } },
    setAttribute(name, value) { this[name] = value; } };
  const overlay = { hidden: true };
  const nodes = { notebookOpenBtn: button, studentNotebookDrawer: drawer, studentNotebookOverlay: overlay };
  const viewportListeners = {};
  const viewport = { width: 700, offsetLeft: 30, addEventListener(name, callback) { viewportListeners[name] = callback; } };
  const context = {
    window: { innerWidth: 1024, visualViewport: viewport, addEventListener() {}, EagleIDE: { getContext() {
      return { USER_TOKEN: 'token', getCurrentClassContext: () => ({ id: 'class-1' }) };
    } } },
    document: { body, documentElement: { style }, getElementById: id => nodes[id] || null, querySelectorAll: () => [] },
    fetch: async () => { throw new Error('offline test'); },
    console: { warn() {} },
    alert() {},
  };
  vm.runInNewContext(source, context);
  button.listeners.click();
  assert.equal(drawer.classList.open, true);
  assert.equal(button.parentNode, body);
  assert.equal(button['aria-expanded'], 'true');
  assert.equal(properties['--notebook-viewport-width'], '700px');
  assert.equal(properties['--notebook-viewport-right'], '294px');
  viewport.width = 620;
  viewportListeners.resize();
  assert.equal(properties['--notebook-viewport-right'], '374px');
  button.listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(drawer.classList.open, false);
  assert.equal(button.parentNode, home);
  assert.equal(button['aria-expanded'], 'false');
  assert.match(css, /right: calc\(var\(--notebook-viewport-right/);
  assert.match(css, /width: min\(860px, calc\(var\(--notebook-viewport-width/);
});

test('long editable code scrolls inside its notebook block without widening the page', () => {
  assert.match(css, /\.student-notebook-page\s*\{[^}]*overflow-x:\s*hidden/s);
  assert.match(css, /\.student-notebook-editor\s*\{[^}]*width:\s*100%/s);
  assert.match(css, /\.student-notebook-code-lines\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(css, /\.student-notebook-code-lines\s*\{[^}]*font-size:\s*16px/s);
  assert.match(css, /\.student-notebook-code-actions\s*\{[^}]*max-width:\s*100%/s);
});
