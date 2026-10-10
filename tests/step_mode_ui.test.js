const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  clampStepDelay,
  findPlaybackPosition,
  selectStepIndexes,
} = require('../static/js/step-mode.js');

test('line playback includes every recorded event in order', () => {
  const steps = [{event:'line'}, {event:'call'}, {event:'return'}, {event:'exception'}];
  assert.deepEqual(selectStepIndexes(steps, 'line'), [0, 1, 2, 3]);
});

test('function playback keeps calls, returns, recorded input, and exceptions', () => {
  const steps = [
    {event:'line'}, {event:'call'}, {event:'line'}, {event:'input'},
    {event:'return'}, {event:'exception'},
  ];
  assert.deepEqual(selectStepIndexes(steps, 'function'), [1, 3, 4, 5]);
});

test('function playback falls back to line events for programs without functions', () => {
  const steps = [{event:'line'}, {event:'line'}];
  assert.deepEqual(selectStepIndexes(steps, 'function'), [0, 1]);
});

test('step over lands on the first visible event at or after the recorded resume point', () => {
  assert.equal(findPlaybackPosition([0, 1, 2, 8, 9], 8), 3);
  assert.equal(findPlaybackPosition([0, 3, 7], 5), 2);
  assert.equal(findPlaybackPosition([0, 3, 7], 99), 2);
  assert.equal(findPlaybackPosition([], 1), -1);
});

test('autoplay delay is bounded to half-second increments from 0.5 to 5 seconds', () => {
  assert.equal(clampStepDelay(0.1), 0.5);
  assert.equal(clampStepDelay(0.74), 0.5);
  assert.equal(clampStepDelay(0.76), 1);
  assert.equal(clampStepDelay(3.26), 3.5);
  assert.equal(clampStepDelay(9), 5);
});

test('playback renders output by line and exposes class and object members', () => {
  const source = fs.readFileSync(path.join(__dirname, '../static/js/step-mode.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../static/js/app-core.js'), 'utf8');
  assert.match(source, /Inspect members/);
  assert.match(source, /Dataclass fields/);
  assert.match(source, /setStepShellOutput/);
  assert.match(app, /className = 'step-shell-output-line'/);
  assert.match(app, /value\.split\('\\n'\)/);
});

test('connection loss exits recording and playback so the editor is unlocked', () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../static/js/step-mode.js'), 'utf8');
  const handler = source.slice(source.indexOf('  function onConnectionLost()'), source.indexOf('  function bindSocket()'));
  for (const state of ['generating', 'playback']) {
    const context = { state, exits: 0, locked: true,
      exit() { this.exits++; this.state = 'idle'; this.locked = false; }, setStatus() {} };
    // Bind the UI collaborators to the harness, as the real exit restores readOnly.
    context.exit = context.exit.bind(context);
    vm.runInNewContext(handler + 'onConnectionLost();', context);
    assert.equal(context.exits, 1);
    assert.equal(context.locked, false);
    assert.equal(context.state, 'idle');
  }
});
