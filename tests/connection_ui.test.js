const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('static/js/connection.js', 'utf8');
function harness(fetch) {
  const events = new Map(), timers = new Map(), classes = new Set(), nodes = new Map();
  let id = 0;
  const on = (name, fn) => { const list = events.get(name) || []; list.push(fn); events.set(name, list); };
  for (const name of ['connectionWarning', 'fileConnectionWarning', 'shellConnectionWarning', 'runBtn', 'stepModeBtn', 'sendBtn', 'executionQueueCancelBtn', 'fileBrowserTabPane', 'connectionRetryBtn']) {
    nodes.set(name, { hidden: true, disabled: false, setAttribute() {}, addEventListener: on });
  }
  const window = { EagleIDE: {}, addEventListener: on, dispatchEvent: event => fire(event.type, event) };
  const navigator = { onLine: true };
  const document = { hidden: false, addEventListener: on, getElementById: name => nodes.get(name),
    body: { classList: { toggle(name, value) { if (value) classes.add(name); else classes.delete(name); } } } };
  const context = vm.createContext({ window, document, navigator, fetch, Response, AbortController,
    CustomEvent: class { constructor(type, payload) { this.type = type; this.detail = payload.detail; } },
    setTimeout: (fn, delay) => { timers.set(++id, { fn, delay }); return id; }, clearTimeout: id => timers.delete(id) });
  function fire(type, event = {}) { for (const fn of events.get(type) || []) fn(event); }
  vm.runInContext(source, context);
  const handlers = {};
  const socket = { connected: true, on(name, fn) { handlers[name] = fn; }, connect() {} };
  fire('eagle-socket-ready', { detail: { socket } });
  return { api: window.EagleIDE.connection, fire, navigator, nodes, socket, handlers, timers, classes };
}

test('offline warning blocks all file input while editor keys remain local', async () => {
  let requests = 0;
  const h = harness(async () => { requests++; return new Response('{"ok":true}'); });
  await h.api.check();
  assert.equal(h.api.isLost(), false);
  h.navigator.onLine = false; h.fire('offline');
  assert.equal(h.api.isLost(), true);
  for (const name of ['connectionWarning', 'fileConnectionWarning', 'shellConnectionWarning']) assert.equal(h.nodes.get(name).hidden, false);
  assert.equal(h.nodes.get('runBtn').disabled, true);
  const event = selector => ({ target: { closest: query => query.includes(selector) }, prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } });
  for (const type of ['click', 'contextmenu', 'drop', 'change', 'keydown']) {
    const file = event('#fileBrowserTabPane'); h.fire(type, file); assert.equal(file.prevented, true); assert.equal(file.stopped, true);
    for (const key of ['Enter', 'ArrowRight', 'a']) {
      const editor = event('#editor'); editor.key = key; h.fire(type, editor); assert.equal(editor.prevented, false);
    }
  }
  const before = requests;
  await assert.rejects(h.api.request('/api/files/delete'), /Keep this tab open/);
  assert.equal(requests, before, 'offline operations must never reach fetch or replay later');
  const closing = { preventDefault() { this.prevented = true; } };
  h.fire('beforeunload', closing); assert.equal(closing.prevented, true);
});

test('HTTP recovery alone cannot enable execution when the socket is unavailable', async () => {
  const h = harness(async () => new Response('{"ok":true}'));
  h.socket.connected = false; h.handlers.disconnect();
  await h.api.check(); assert.equal(h.api.isLost(), true);
  h.socket.connected = true; h.handlers.connect();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.api.isLost(), false); assert.equal(h.api.canRun(), true);
  assert.equal(h.nodes.get('connectionWarning').hidden, true);
  const closing = { preventDefault() { this.prevented = true; } };
  h.fire('beforeunload', closing); assert.equal(closing.prevented, undefined);
});

test('a late health success cannot clear a newer offline or socket failure', async () => {
  let release;
  const h = harness(() => new Promise(resolve => { release = resolve; }));
  const checking = h.api.check(); h.handlers.disconnect();
  release(new Response('{"ok":true}')); await checking;
  assert.equal(h.api.isLost(), true);
});

test('probes coalesce and stalled bodies time out without blocking typing', async () => {
  let requests = 0;
  const h = harness(async () => { requests++; return { ok: true, json: () => new Promise(() => {}) }; });
  const first = h.api.check(), second = h.api.check();
  assert.equal(requests, 1);
  [...h.timers.values()].find(timer => timer.delay === 8000).fn();
  assert.equal(await first, false); assert.equal(await second, false);
  assert.equal(h.api.isLost(), true);
});

test('workspace requests cover stalled response bodies and distinguish HTTP errors', async () => {
  const h = harness(async () => new Response('{"ok":false,"error":"File missing"}', { status: 404 }));
  const response = await h.api.request('/api/files/read');
  assert.equal(response.status, 404); assert.equal(h.api.isLost(), false);
  const stalled = harness(async () => ({ arrayBuffer: () => new Promise(() => {}) }));
  const saving = stalled.api.request('/api/files/write', {}, 1234);
  [...stalled.timers.values()].find(timer => timer.delay === 1234).fn();
  await assert.rejects(saving, /Connection lost/); assert.equal(stalled.api.isLost(), true);
});
