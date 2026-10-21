const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../static/js/external-tool-runtime.js'), 'utf8');
function harness({ entries = {}, failure = 0 } = {}) {
  const events = {}, reports = [], calls = [], chunks = [];
  const parent = { postMessage: value => reports.push(value) };
  const window = { open: () => null, addEventListener: (key, fn) => { events[key] = fn; } };
  let revision = 0;
  const context = { window, parent, Storage: class {}, TextEncoder, Uint8Array, DOMException, AbortController,
    document: { addEventListener() {} }, setTimeout: () => 1, clearTimeout() {},
    config: { instance: 'visit', tool: 'cad', prefix: '/scoped/', parentOrigin: 'https://eagle.test', snapshot: { enabled: true, entries, epoch: 0, revision: 0, used_bytes: 0, quota_bytes: 4e6, max_value_bytes: 2e6, max_profile_bytes: 4e6, max_keys: 2048, chunk_bytes: 512 * 1024 } },
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (failure) return { ok: false, status: failure, json: async () => ({ error: 'Conflict or quota' }) };
      if (url.endsWith('begin')) return { ok: true, json: async () => ({ upload_id: 'upload' }) };
      if (url.includes('chunk?')) chunks.push(Buffer.from(options.body));
      return { ok: true, json: async () => ({ revision: ++revision, epoch: 0, used_bytes: chunks.reduce((n, b) => n + b.length, 0) }) };
    }
  };
  vm.runInNewContext(`(function(config){${source}; globalThis.runtime={sync,dirty};})(config);`, context);
  return { ...context, calls, chunks, reports, events };
}
test('picker fallback precedes startup; storage keys and named properties stay scoped', () => {
  const h = harness({ entries: { saved: 'cloud project' } }), storage = h.window.localStorage;
  assert.equal(h.window.showOpenFilePicker, undefined);
  assert.equal(storage.getItem('saved'), 'cloud project');
  storage.newProject = 'new data';
  assert.deepEqual(Object.keys(storage).sort(), ['newProject', 'saved']);
  assert.equal(storage.length, 2); assert.equal(storage.key(0), 'saved');
  delete storage.newProject; assert.equal(storage.getItem('newProject'), null);
  assert.ok(h.calls.length === 0);
});
test('large multibyte values cross chunk boundaries losslessly with no ambient credentials', async () => {
  const h = harness(), value = '☃'.repeat(400000);
  h.window.localStorage.setItem('project', value);
  await h.runtime.sync();
  assert.equal(Buffer.concat(h.chunks).toString(), value);
  assert.equal(h.chunks.length, 3);
  assert.ok(h.chunks.every(chunk => chunk.length <= 512 * 1024));
  assert.ok(h.calls.every(call => call.options.credentials === 'omit' && !call.options.headers.Authorization));
  assert.equal(h.runtime.dirty(), false);
  assert.equal(h.reports.at(-1).state, 'saved');
});
test('conflicts retain local work and stop automatic overwrite', async () => {
  const h = harness({ failure: 409 });
  h.window.localStorage.setItem('project', 'retain this'); await h.runtime.sync();
  assert.equal(h.runtime.dirty(), true); assert.equal(h.reports.at(-1).state, 'conflict');
  const count = h.calls.length; await h.runtime.sync(); assert.equal(h.calls.length, count);
  assert.equal(h.window.localStorage.getItem('project'), 'retain this');
});
test('changes made during an upload remain dirty and commit in the following batch', async () => {
  const h = harness(); h.window.localStorage.setItem('project', 'older snapshot');
  const first = h.runtime.sync(); h.window.localStorage.setItem('project', 'newer edit');
  await first; assert.equal(h.runtime.dirty(), true);
  await h.runtime.sync(); assert.equal(h.runtime.dirty(), false);
  assert.equal(h.chunks.at(-1).toString(), 'newer edit');
});
test('only the authenticated parent can invalidate or dispose a tool runtime', async () => {
  const h = harness();
  h.events.message({ source: {}, origin: h.config.parentOrigin, data: { instance: 'visit', type: 'eagle-tool-dispose' } });
  h.window.localStorage.setItem('project', 'work'); await h.runtime.sync();
  assert.equal(h.runtime.dirty(), false);
  h.window.localStorage.setItem('project', 'unsaved work');
  h.events.message({ source: h.parent, origin: h.config.parentOrigin, data: { instance: 'visit', type: 'eagle-tool-invalidated' } });
  const count = h.calls.length; await h.runtime.sync();
  assert.equal(h.calls.length, count); assert.equal(h.runtime.dirty(), true);
  assert.equal(h.reports.at(-1).state, 'conflict');
});
test('quota failures throw before mutation and failed saves never report success', async () => {
  const h = harness({ failure: 413 });
  assert.throws(() => h.window.localStorage.setItem('huge', 'x'.repeat(2000001)), { name: 'QuotaExceededError' });
  assert.equal(h.window.localStorage.length, 0);
  h.window.localStorage.setItem('small', 'unsaved'); await h.runtime.sync();
  assert.equal(h.reports.at(-1).state, 'error'); assert.equal(h.runtime.dirty(), true);
});
