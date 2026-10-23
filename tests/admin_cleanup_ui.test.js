const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../static/js/admin-cleanup.js'), 'utf8');
function element(tag = 'div') {
  const node = {tag, children: [], dataset: {}, attrs: {}, events: {}, style: {}, checked: false, disabled: false,
    textContent: '', classList: {contains: () => true}, append(...items) {this.children.push(...items);},
    replaceChildren(...items) {this.children = items;}, setAttribute(k,v) {this.attrs[k] = v;}, getAttribute(k) {return this.attrs[k];},
    addEventListener(k,fn) {this.events[k] = fn;}, focus() {this.focused = true;},
    querySelectorAll(selector) {
      const all = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
      if (selector === '*') return all;
      if (selector === 'input, button') return all.filter(child => ['input','button'].includes(child.tag));
      const [, key, value] = selector.match(/\[data-cleanup-(toggle|days)(?:="([^"]+)")?\]/) || [];
      return all.filter(child => key && child.dataset['cleanup' + key[0].toUpperCase() + key.slice(1)] !== undefined &&
        (!value || child.dataset['cleanup' + key[0].toUpperCase() + key.slice(1)] === value));
    }, querySelector(selector) {return this.querySelectorAll(selector)[0];}};
  return node;
}
function setup() {
  let token = 'fixture-admin'; const nodes = {}, requests = [], timers = new Map(); let nextTimer = 0;
  const get = id => nodes[id] ||= element();
  const context = {window: {EagleIDE: {getContext: () => ({ADMIN_TOKEN: token})}, confirm: () => true},
    document: {getElementById: get, createElement: element}, AbortController, Date,
    setTimeout(fn) {timers.set(++nextTimer, fn); return nextTimer;}, clearTimeout(id) {timers.delete(id);},
    fetch(url, options) {return new Promise(resolve => requests.push({url, options, resolve}));}};
  vm.runInNewContext(source, context);
  const api = context.window.AdminCleanup;
  return {api, get, requests, timers, switchToken(value) {token = value; api.onAuthChanged();}};
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function payload(revision = 0, enabled = false) {
  return {ok: true, revision, policy: {enabled, rules: {workspace_trash: {enabled, days: 30}}},
    types: [{id: 'workspace_trash', label: 'Trash', description: 'Old files'}], entries: [], runs: [], next_before: 0, active_run: null};
}
function respond(request, body = payload(), ok = true) {request.resolve({ok, json: async () => body});}
async function open(state) {const promise = state.api.open(); respond(state.requests.at(-1)); await promise;}
test('cleanup defaults prevent running; saving is explicit and contains only retention settings', async () => {
  const state = setup(); await open(state);
  assert.equal(state.get('cleanupRunNow').disabled, true);
  state.get('cleanupEnabled').checked = true; state.get('cleanupEnabled').events.change();
  state.get('cleanupRules').querySelector('[data-cleanup-toggle]').events.click();
  assert.equal(state.get('cleanupRunNow').disabled, true);
  const saving = state.api.save(), request = state.requests.at(-1);
  assert.equal(request.options.headers['X-Admin-Token'], 'fixture-admin');
  assert.equal(request.url, '/api/admin/cleanup/policy');
  assert.deepEqual(JSON.parse(request.options.body), {revision: 0, policy: {enabled: true, rules: {workspace_trash: {enabled: true, days: 30}}}});
  assert.equal(state.get('cleanupEnabled').disabled, true);
  respond(request, payload(1, true)); await saving;
  assert.equal(state.get('cleanupRunNow').disabled, false);
});
test('late account and same-account responses cannot overwrite a newer page or leak history', async () => {
  const state = setup(); const old = state.api.open();
  state.switchToken('another-admin'); const fresh = state.api.open();
  respond(state.requests[1], payload(2)); await fresh;
  const privateData = payload(); privateData.entries = [{name: '<img src=x>', path: '/private/path', started: 1, kind: 'trash', action: 'delete', status: 'deleted'}];
  respond(state.requests[0], privateData); await old;
  assert.match(state.get('cleanupLog').children[0].children[0].textContent, /No cleanup entries/);
  const first = state.api.open(), second = state.api.open();
  respond(state.requests[3], payload(4)); await second; respond(state.requests[2], privateData); await first;
  assert.match(state.get('cleanupLog').children[0].children[0].textContent, /No cleanup entries/);
  state.switchToken(''); assert.equal(state.get('cleanupLog').children.length, 0);
});
test('background refresh preserves a draft and its original compare-and-swap revision', async () => {
  const state = setup(); await open(state);
  const days = state.get('cleanupRules').querySelector('[data-cleanup-days]'); days.value = '45'; days.events.input();
  const loading = state.api.open(); respond(state.requests.at(-1), payload(8)); await loading;
  assert.equal(days.value, '45');
  const saving = state.api.save(); const request = state.requests.at(-1);
  assert.equal(JSON.parse(request.options.body).revision, 0);
  respond(request, {ok:false, error:'Settings changed; reload'}, false); await saving;
  assert.match(state.get('cleanupStatus').textContent, /reload/);
  assert.equal(state.get('cleanupRunNow').disabled, true);
});
test('invalid retention prevents writes and filenames are rendered as plain text', async () => {
  const state = setup(); const opening = state.api.open(), body = payload();
  body.entries = [{name: '<script>bad()</script>', path: '/fixture/<b>name</b>', started: 1, kind: 'trash', action: 'delete', status: 'deleted'}];
  respond(state.requests[0], body); await opening;
  const cell = state.get('cleanupLog').children[0].children[2];
  assert.equal(cell.children[0].textContent, '<script>bad()</script>');
  const input = state.get('cleanupRules').querySelector('[data-cleanup-days]'); input.value = '0'; input.events.input();
  await state.api.save(); assert.equal(state.requests.length, 1); assert.equal(input.focused, true);
});
