const assert = require('node:assert/strict');
const test = require('node:test');
const { coverageModel, displayDistance, metersFrom, heatmap, gridStep, snapPoint } = require('../static/js/wifi-site-model.js');

const ceiling = { x: 5, y: 10, angle: 0, mount: 'ceiling' };
const probe = { x: 15, y: 10 };
const barrier = { a: { x: 10, y: 2 }, b: { x: 10, y: 18 }, material: 'drywall' };

test('wall material and band change the signal at the same physical location', () => {
  const drywall = coverageModel([barrier], [ceiling], '5')(probe, true);
  const concreteWall = { ...barrier, material: 'concrete' };
  const concrete = coverageModel([concreteWall], [ceiling], '5')(probe, true);
  const lowBand = coverageModel([concreteWall], [ceiling], '2.4')(probe, true);
  const unobstructed = coverageModel([], [ceiling], '5')(probe, true);
  assert.deepEqual(concrete.walls, ['concrete']);
  assert.equal(concrete.distance, 10);
  assert.ok(unobstructed.signal > drywall.signal && drywall.signal > concrete.signal);
  assert.ok(lowBand.signal > concrete.signal);
  assert.equal(coverageModel([concreteWall], [ceiling], '5')({ x: 5, y: 8 }, true).walls.length, 0);
});

test('joined segments count once and the strongest access point wins', () => {
  const firstHalf = { ...barrier, b: { x: 10, y: 10 } };
  const secondHalf = { ...barrier, a: firstHalf.b };
  const split = coverageModel([firstHalf, secondHalf], [ceiling], '5')(probe, true);
  assert.deepEqual(split.walls, ['drywall']);
  assert.equal(split.signal, coverageModel([barrier], [ceiling], '5')(probe));
  const nearby = { x: 14, y: 9, angle: 0, mount: 'ceiling' };
  const winning = coverageModel([barrier], [ceiling, nearby], '5')(probe, true);
  assert.equal(winning.ap, nearby);
  assert.deepEqual(winning.walls, []);
});

test('wall mount rotation changes its directional estimate and heatmaps are bounded', () => {
  const forward = { ...ceiling, mount: 'wall' };
  const reversed = { ...forward, angle: 180 };
  assert.ok(coverageModel([], [forward], '5')(probe) > coverageModel([], [reversed], '5')(probe));
  const result = heatmap({ width: 120, height: 120, walls: [], access_points: [forward], band: '5' });
  assert.ok(result.columns <= 144 && result.rows <= 144);
  assert.equal(result.pixels.length, result.columns * result.rows * 4);
  assert.ok(result.pixels.some(value => value > 0));
});

test('changing display units preserves distances and snap keeps points within the plan', () => {
  assert.equal(metersFrom(displayDistance(10, 'ft'), 'ft'), 10);
  assert.equal(displayDistance(gridStep('ft'), 'ft'), 5);
  assert.deepEqual(snapPoint({ x: 9.8, y: -2 }, 10, 12, gridStep('ft')), { x: 9.144, y: 0 });
});
