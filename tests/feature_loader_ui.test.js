const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'static', 'js', 'feature-loader.js'),
  'utf8',
);

function createHarness() {
  const scripts = [];
  const documentListeners = new Map();
  const windowListeners = new Map();
  const buttons = Object.fromEntries(['networkViewBtn', 'wikiHeroNetworkBtn'].map(id => [id, { hidden: true }]));
  const accessRequests = [];
  const document = {
    querySelector(selector) {
      const match = selector.match(/data-eagle-feature-src="([^"]+)"/);
      return match ? scripts.find(script => script.dataset.eagleFeatureSrc === match[1]) || null : null;
    },
    createElement(tag) {
      assert.equal(tag, 'script');
      const listeners = new Map();
      return {
        dataset: {},
        addEventListener(name, callback) {
          listeners.set(name, callback);
        },
        _dispatch(name) {
          listeners.get(name)?.();
        },
      };
    },
    addEventListener(name, callback) {
      documentListeners.set(name, callback);
    },
    getElementById(id) {
      return buttons[id] || null;
    },
    head: {
      appendChild(script) {
        scripts.push(script);
        queueMicrotask(() => script._dispatch('load'));
      },
    },
  };
  const window = { alert() {}, addEventListener: (name, callback) => windowListeners.set(name, callback) };
  vm.runInNewContext(source, {
    window,
    document,
    console,
    Promise,
    Map,
    Error,
    AbortSignal,
    fetch(url, options) {
      assert.equal(url, '/api/network/access');
      assert.equal(options.cache, 'no-store');
      return new Promise(resolve => accessRequests.push({
        headers: options.headers,
        respond: ok => resolve({ ok, json: async () => ({ ok }) }),
      }));
    },
    queueMicrotask,
  });
  return { window, scripts, documentListeners, windowListeners, buttons, accessRequests };
}

test('student launchers follow current class access without loading the simulator', async () => {
  const { window, scripts, windowListeners, buttons, accessRequests } = createHarness();
  let ctx = { USER_TOKEN: 'student-a', currentConfig: { network_sim_enabled: true } };
  window.EagleIDE = { getContext: () => ctx };
  const contextUpdated = windowListeners.get('eagle-context-updated');
  const focus = windowListeners.get('focus');
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const hidden = () => Object.values(buttons).map(button => button.hidden);

  contextUpdated();
  contextUpdated();
  assert.equal(accessRequests.length, 1);
  assert.equal(accessRequests[0].headers['X-User-Token'], 'student-a');
  assert.deepEqual(hidden(), [true, true]);
  accessRequests[0].respond(false);
  await flush();
  assert.deepEqual(hidden(), [true, true]);

  focus();
  accessRequests[1].respond(true);
  await flush();
  assert.deepEqual(hidden(), [false, false]);

  focus();
  ctx = { ...ctx, USER_TOKEN: 'student-b' };
  contextUpdated();
  assert.equal(accessRequests[3].headers['X-User-Token'], 'student-b');
  assert.deepEqual(hidden(), [true, true]);
  accessRequests[3].respond(false);
  accessRequests[2].respond(true);
  await flush();
  assert.deepEqual(hidden(), [true, true]);
  assert.equal(scripts.length, 0);
});

test('network feature loads in dependency order and deduplicates concurrent requests', async () => {
  const { window, scripts } = createHarness();
  await Promise.all([
    window.EagleFeatures.load('network'),
    window.EagleFeatures.load('network'),
  ]);

  assert.deepEqual(
    scripts.map(script => script.src.split('?')[0]),
    [
      '/static/js/network-sim.js',
      '/static/js/network-sim-advanced.js',
    ],
  );
  assert.ok(scripts.every(script => script.dataset.loaded === 'true'));
});

test('unknown lazy features reject without adding scripts', async () => {
  const { window, scripts } = createHarness();
  await assert.rejects(window.EagleFeatures.load('missing'), /Unknown EagleIDE feature/);
  assert.equal(scripts.length, 0);
});
