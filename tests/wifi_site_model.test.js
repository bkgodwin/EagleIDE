const assert = require('node:assert/strict');
const test = require('node:test');
const { coverageModel, displayDistance, metersFrom, gridStep, signalColor,
  createHeatSource, SAMPLES, PADDING } = require('../static/js/wifi-site-model.js');
const { bounds, fitCamera, viewportBounds, zoomAt, screenToWorld, gridSpacing,
  snapConstruction } = require('../static/js/wifi-site-view.js');

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
  assert.equal(winning.alternate.ap, ceiling);
  assert.equal(winning.alternate.signal, coverageModel([barrier], [ceiling], '5')(probe));
});

test('a door or window changes only the rays through its span', () => {
  const wall = { ...barrier, id: 'wall', material: 'concrete' };
  const opening = { wall_id: 'wall', t: 0.5, width: 2, kind: 'door', material: 'wood' };
  const baseline = coverageModel([wall], [ceiling], '5');
  const throughDoor = coverageModel([wall], [ceiling], '5', [opening]);
  const throughWindow = coverageModel([wall], [ceiling], '5', [{ ...opening, kind: 'window', material: 'glass' }]);
  assert.deepEqual(throughDoor(probe, true).walls, ['Wood door']);
  assert.ok(throughWindow(probe) > throughDoor(probe) && throughDoor(probe) > baseline(probe));
  assert.equal(throughDoor({ x: 15, y: 16 }), baseline({ x: 15, y: 16 }));
  const tile = { x: 0, y: 0, level: 0 };
  const plan = { walls: [wall], access_points: [ceiling], band: '5' };
  assert.notDeepEqual(createHeatSource(plan)(tile), createHeatSource({ ...plan, openings: [opening] })(tile));
});

test('wall mount rotation and power change the signal at the probe and on the map', () => {
  const forward = { ...ceiling, mount: 'wall' };
  const reversed = { ...forward, angle: 180 };
  assert.ok(coverageModel([], [forward], '5')(probe) > coverageModel([], [reversed], '5')(probe));
  const high = { ...forward, power_db: 6 };
  assert.equal(coverageModel([], [high], '5')(probe) - coverageModel([], [forward], '5')(probe), 6);
  const tile = { x: 0, y: 0, level: 0 };
  const base = createHeatSource({ walls: [], access_points: [forward], band: '5' })(tile);
  const boosted = createHeatSource({ walls: [], access_points: [high], band: '5' })(tile);
  assert.notDeepEqual(base, boosted);
});

test('coverage fades continuously and adjacent tiles share their interpolation samples', () => {
  assert.equal(signalColor(-100)[3], 0);
  assert.ok(signalColor(-99)[3] > 0 && signalColor(-99)[3] < signalColor(-94)[3]);
  assert.notDeepEqual(signalColor(-70), signalColor(-71));
  const tile = createHeatSource({ walls: [barrier], access_points: [ceiling], band: '5' });
  const left = tile({ x: -1, y: 0, level: 0 });
  const right = tile({ x: 0, y: 0, level: 0 });
  const size = SAMPLES + 2 * PADDING;
  assert.equal(left.length, size * size * 4);
  for (let row = 0; row < size; row += 1) {
    const start = row * size * 4;
    assert.deepEqual(left.slice(start + SAMPLES * 4, start + size * 4), right.slice(start, start + 2 * PADDING * 4));
  }
  assert.equal(tile({ x: 100_000, y: -200_000, level: 0 }), null);
});

test('grid adapts as the camera zooms and construction can snap to existing endpoints', () => {
  assert.equal(metersFrom(displayDistance(10, 'ft'), 'ft'), 10);
  assert.equal(displayDistance(gridStep('ft'), 'ft'), 5);
  assert.ok(gridSpacing(0.1, 1) > gridSpacing(20, 1));
  const config = { origin: { x: -20, y: 2.2 }, orthogonal: true, step: 1, tolerance: 0.4,
    endpoints: [{ x: -12.5, y: 2.2, wallId: 'existing' }, { x: -12.4, y: 2.35 }] };
  const point = { x: -12.4, y: 2.4 };
  assert.deepEqual(snapConstruction(point, config), { point: { x: -12.5, y: 2.2 }, joined: true });
  assert.deepEqual(snapConstruction(point, { ...config, exclude: 'existing' }), { point: { x: -12, y: 2.2 }, joined: false });
});

test('zoom holds the point under the cursor and fit includes geometry far outside the old floor', () => {
  const start = { x: -8, y: -12, scale: 14 };
  const cursor = { x: 210, y: 190 };
  const zoomed = zoomAt(start, cursor, 0.01);
  const anchored = screenToWorld(zoomed, cursor);
  const original = screenToWorld(start, cursor);
  assert.ok(Math.hypot(anchored.x - original.x, anchored.y - original.y) < 1e-10);
  const site = bounds([{ x: -1500, y: -800 }, { x: 2400, y: 1600 }]);
  const fitted = fitCamera(site, 950, 620);
  const visible = viewportBounds(fitted, 950, 620);
  assert.ok(visible.left < site.left && visible.top < site.top);
  assert.ok(visible.right > site.right && visible.bottom > site.bottom);
});
