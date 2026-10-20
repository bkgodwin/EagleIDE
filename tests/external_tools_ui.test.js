const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../static/js/external-tools.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness({ signed = true } = {}) {
  const events = {}, calls = [], intervals = [], elements = new Map(), classes = new Set(['wiki-mode']);
  const tool = { id: 'fixture', name: 'Generic fixture', label: 'Open fixture', slug: 'fixture' };
  const launches = [];
  let context = signed ? { USER_TOKEN: 'account-one', currentStudentClassId: 'one' } : {}, failure = 0, confirm = true;
  function element(tag = 'div') {
    return { tag, children: [], handlers: {}, attributes: {}, isConnected: true, textContent: '', style: {},
      append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
      setAttribute(key, value) { this.attributes[key] = value; }, addEventListener(key, fn) { this.handlers[key] = fn; },
      querySelector() { return this; }, querySelectorAll() { return []; } };
  }
  const document = { hidden: false, body: { classList: { add: (...items) => items.forEach(item => classes.add(item)), remove: (...items) => items.forEach(item => classes.delete(item)) } },
    getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    createElement: element, createTextNode: text => ({ textContent: text }), addEventListener: (type, fn) => { events[`document:${type}`] = fn; } };
  const location = { pathname: '/' };
  const history = { pushState(_state, _unused, path) { location.pathname = path; } };
  class BroadcastChannel { constructor() { this.messages = []; } postMessage(message) { this.messages.push(message); } }
  const window = { EagleIDE: { getContext: () => context }, WikiReader: { showHome() { location.pathname = '/'; }, disposeActiveContent() {} },
    addEventListener: (type, fn) => { events[type] = fn; }, dispatchEvent(event) { events[event.type]?.(event); },
    confirm: () => confirm, alert() {} };
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/tools') return { ok: true, json: async () => ({ ok: true, tools: [tool] }) };
    if (url.endsWith('/launch')) return new Promise(resolve => { launches.push(result => resolve({ ok: true, json: async () => result })); });
    return { ok: !failure, status: failure || 200, json: async () => failure ? { ok: false, error: 'Unavailable' } : { ok: true } };
  };
  vm.runInNewContext(source, { window, document, location, history, navigator: {}, fetch, BroadcastChannel,
    setInterval: fn => intervals.push(fn), CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } } });
  return { window, document, elements, calls, events, intervals, location, tool, classes,
    changeAuth(value) { context = value; events['eagle-context-updated'](); }, setFailure(value) { failure = value; },
    confirm(value) { confirm = value; }, completeLaunch() { launches.shift()({ ok: true, instance_id: 'instance', url: '/_tools/fixture/scoped-capability/app/', preview: false, forms: false }); } };
}

test('guest startup never requests tools or creates an application frame', async () => {
  const h = harness({ signed: false }); await flush();
  assert.equal(h.calls.length, 0);
  assert.equal(h.window.ExternalTools.active(), false);
});

test('launch uses restricted iframe, preserves view on canceled departure and revokes on close', async () => {
  const h = harness(); await flush();
  const opened = h.window.ExternalTools.open(h.tool); h.completeLaunch(); await opened;
  const frame = h.elements.get('externalToolFrameHost').children[0];
  assert.equal(frame.attributes.sandbox, 'allow-scripts allow-downloads');
  assert.equal(frame.referrerPolicy, 'no-referrer');
  assert.ok(!frame.src.includes('account-one'));
  h.confirm(false); assert.equal(h.window.ExternalTools.leave(), false);
  assert.equal(h.elements.get('externalToolFrameHost').children[0], frame);
  h.confirm(true); assert.equal(h.window.ExternalTools.leave(), true); await flush();
  assert.equal(h.elements.get('externalToolFrameHost').children.length, 0);
  assert.ok(h.calls.some(call => call.url.endsWith('/instances/instance') && call.options.method === 'DELETE'));
});

test('late launch cannot mount after account change and is revoked using its original credential', async () => {
  const h = harness(); await flush();
  const opened = h.window.ExternalTools.open(h.tool);
  h.changeAuth({ USER_TOKEN: 'account-two' }); await flush();
  h.completeLaunch(); await opened; await flush();
  assert.equal(h.elements.get('externalToolFrameHost').children.length, 0);
  const revoke = h.calls.find(call => call.options.method === 'DELETE');
  assert.equal(revoke.options.headers['X-User-Token'], 'account-one');
});

test('transient heartbeat outage retains work; confirmed revocation disposes it', async () => {
  const h = harness(); await flush();
  const opened = h.window.ExternalTools.open(h.tool); h.completeLaunch(); await opened;
  h.setFailure(502); h.intervals[0](); await flush();
  assert.equal(h.window.ExternalTools.active(), true);
  assert.match(h.elements.get('externalToolStatus').textContent, /Connection unavailable/);
  h.setFailure(403); h.intervals[0](); await flush();
  assert.equal(h.window.ExternalTools.active(), false);
  assert.equal(h.elements.get('externalToolFrameHost').children.length, 0);
});

test('page suspension disposes the iframe and warns while a tool is active', async () => {
  const h = harness(); await flush();
  const opened = h.window.ExternalTools.open(h.tool); h.completeLaunch(); await opened;
  let warned = false; h.events.beforeunload({ preventDefault() { warned = true; } }); assert.equal(warned, true);
  h.events.pagehide(); assert.equal(h.window.ExternalTools.active(), false);
});
