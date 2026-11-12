const assert = require('node:assert/strict');
const test = require('node:test');
const { build, bundledSegments } = require('../static/js/wifi-cabling-model.js');

const group = (prefix, count, poe = false) => ({ prefix, count, poe, media: 'ethernet', speed: 1000 });
const catalog = {
  equipment: {
    core_switch: { name: 'Core', groups: [group('ETH', 48, true)] },
    access_switch: { name: 'Access', groups: [group('ETH', 8)] },
    keystone: { name: 'Jack', groups: [group('FRONT', 0), group('BACK', 0)] },
    access_point: { name: 'AP', groups: [group('ETH', 1)] },
  },
  isps: {}, pass_capacity: 10, pass_spacing: 6.096, epsilon: 0.0002, crossing_tolerance: 0.075,
};
const limits = { bends: 40, total_bends: 6000 };
const endpoint = (device_id, port) => ({ device_id, port });
const wire = (id, source, target, waypoints = []) => ({ id, source, target, waypoints, media: 'ethernet' });
const layout = () => ({
  walls: [{ id: 'wall', a: { x: 0, y: 0 }, b: { x: 0, y: 30 }, material: 'concrete' }],
  pass_throughs: [],
  access_points: [{ id: 'ap', x: 10, y: 10 }],
  equipment: [{ id: 'switch', kind: 'core_switch', x: -8, y: 10 }],
  cables: [],
});

test('wall-side transitions need a pass and capacity counts each cable once', () => {
  const plan = layout();
  const candidate = wire('new', endpoint('switch', 'ETH1'), endpoint('ap', 'ETH1'), [{ x: 0, y: 10 }]);
  const invalid = build(plan, catalog, limits).checkCable(candidate);
  assert.match(invalid.error, /without a pass-through/);
  assert.deepEqual(invalid.point, { x: 0, y: 10 });
  plan.pass_throughs.push({ id: 'pass', wall_id: 'wall', t: 1 / 3 });
  candidate.waypoints = [{ pass_id: 'pass' }, { x: 5, y: 10 }, { pass_id: 'pass' }];
  plan.cables = [candidate];
  const valid = build(plan, catalog, limits);
  assert.equal(valid.error, '');
  assert.equal(valid.usage.get('pass'), 1);
  assert.equal(valid.wired.has('ap'), true);
});

test('an AP is wired by Ethernet and a passive jack carries PoE only from a source switch', () => {
  const plan = layout();
  plan.equipment.push({ id: 'jack', kind: 'keystone', wall_id: 'wall', t: 1 / 3 });
  plan.cables = [
    wire('rear', endpoint('switch', 'ETH1'), endpoint('jack', 'BACK')),
    wire('front', endpoint('jack', 'FRONT'), endpoint('ap', 'ETH1')),
  ];
  assert.equal(build(plan, catalog, limits).powered.has('front'), true);
  plan.equipment[0].kind = 'access_switch';
  const access = build(plan, catalog, limits);
  assert.equal(access.powered.has('front'), false);
  assert.equal(access.wired.has('ap'), true);
  plan.cables.pop();
  assert.equal(build(plan, catalog, limits).wired.has('ap'), false);
});

test('partial, reversed cable overlap makes a bundle only along the shared route', () => {
  const path = (...xs) => xs.map(x => ({ x, y: 2 }));
  const data = new Map([
    ['left', { points: path(-8, 0, 8) }],
    ['right', { points: path(16, 2) }],
    ['cross', { points: [{ x: 4, y: 0 }, { x: 4, y: 4 }] }],
  ]);
  const bundles = bundledSegments([...data.keys()].map(id => ({ id })), data).filter(segment => segment.cableIds.length > 1);
  assert.deepEqual(bundles, [{ a: { x: 2, y: 2 }, b: { x: 8, y: 2 }, cableIds: ['left', 'right'] }]);
});
