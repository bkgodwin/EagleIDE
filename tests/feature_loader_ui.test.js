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
    getElementById() {
      return null;
    },
    head: {
      appendChild(script) {
        scripts.push(script);
        queueMicrotask(() => script._dispatch('load'));
      },
    },
  };
  const window = { alert() {} };
  vm.runInNewContext(source, {
    window,
    document,
    console,
    Promise,
    Map,
    Error,
    queueMicrotask,
  });
  return { window, scripts, documentListeners };
}

test('network feature loads in dependency order and deduplicates concurrent requests', async () => {
  const { window, scripts } = createHarness();
  await Promise.all([
    window.EagleFeatures.load('network'),
    window.EagleFeatures.load('network'),
  ]);

  assert.deepEqual(
    scripts.map(script => script.src),
    [
      '/static/js/network-sim.js?v=20260714-18',
      '/static/js/network-sim-advanced.js?v=20260714-4',
    ],
  );
  assert.ok(scripts.every(script => script.dataset.loaded === 'true'));
});

test('unknown lazy features reject without adding scripts', async () => {
  const { window, scripts } = createHarness();
  await assert.rejects(window.EagleFeatures.load('missing'), /Unknown EagleIDE feature/);
  assert.equal(scripts.length, 0);
});
