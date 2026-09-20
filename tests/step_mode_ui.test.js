const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectStepIndexes } = require('../static/js/step-mode.js');

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
