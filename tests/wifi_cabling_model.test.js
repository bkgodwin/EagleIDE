const assert = require('node:assert/strict');
const test = require('node:test');
const { build, bundledSegments } = require('../static/js/wifi-cabling-model.js');

const group = (prefix, count, poe = false) => ({ prefix, count, poe, media: 'ethernet', speed: 1000 });
const catalog = {
  equipment: {
    core_switch: { name: 'Core', poe_budget: 500, groups: [group('ETH', 48, true)] },
    distribution_switch: { name: 'Distribution', poe_budget: 200, groups: [group('ETH', 24, true)] },
    access_switch: { name: 'Access', groups: [group('ETH', 8)] },
    keystone: { name: 'Jack', groups: [group('FRONT', 0), group('BACK', 0)] },
    access_point: { name: 'AP', poe_draw: 20, groups: [group('ETH', 1)] },
    router: { name: 'Router', groups: [group('ETH', 4), { ...group('WAN', 2), wan: true }] },
  },
  isps: { primary: { name: 'Primary', speed: 1000, media: 'ethernet' },
    backup: { name: 'Satellite', speed: 75, media: 'ethernet' } },
  pass_capacity: 10, pass_channels: 8, pass_spacing: 6.096, epsilon: 0.0002, crossing_tolerance: 0.075,
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
  assert.equal(valid.channels('pass').length, 8);
  assert.deepEqual(valid.channels('pass')[0].map(cable => cable.id), ['new']);
  assert.equal(valid.wired.has('ap'), true);
});

test('internet status follows the fastest connected ISP path and falls back when it is removed', () => {
  const plan = layout();
  plan.equipment.push({ id: 'router', kind: 'router', x: -3, y: 5 },
    { id: 'isp-a', kind: 'demarc', isp: 'primary', wall_id: 'wall', t: 0.2 },
    { id: 'isp-b', kind: 'demarc', isp: 'backup', wall_id: 'wall', t: 0.7 });
  plan.pass_throughs.push({ id: 'pass', wall_id: 'wall', t: 1 / 3 });
  plan.cables = [
    wire('primary', endpoint('isp-a', 'ISP'), endpoint('router', 'WAN1')),
    wire('backup', endpoint('isp-b', 'ISP'), endpoint('router', 'WAN2')),
    wire('lan', endpoint('router', 'ETH1'), endpoint('switch', 'ETH1')),
    wire('ap-link', endpoint('switch', 'ETH2'), endpoint('ap', 'ETH1'), [{ pass_id: 'pass' }]),
  ];
  const first = build(plan, catalog, limits);
  assert.equal(first.status('ap').upstream.speed, 1000);
  assert.equal(first.status('ap').power, 'PoE available');
  plan.cables.shift();
  const fallback = build(plan, catalog, limits).status('ap');
  assert.equal(fallback.upstream.speed, 75);
  assert.equal(fallback.speed, 1000);
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

for (const [kind, budget] of [['core_switch', 500], ['distribution_switch', 200]]) {
  test(`${kind} shuts down above ${budget} W and recovers at the exact budget`, () => {
    const count = budget / 20 + 1;
    const plan = {
      walls: [{ id: 'wall', a: { x: 2, y: 0 }, b: { x: 2, y: 12 }, material: 'drywall' }],
      pass_throughs: [],
      access_points: Array.from({ length: count }, (_, i) => ({ id: `ap${i}`, x: 4, y: i })),
      equipment: [{ id: 'switch', kind, x: 0, y: 0 }, { id: 'jack', kind: 'keystone', wall_id: 'wall', t: .5 },
        { id: 'router', kind: 'router', x: -2, y: 0 }],
      cables: [
        wire('uplink', endpoint('switch', `ETH${count + 1}`), endpoint('router', 'ETH1')),
        wire('patch', endpoint('ap0', 'ETH1'), endpoint('jack', 'FRONT')),
        wire('rear', endpoint('jack', 'BACK'), endpoint('switch', 'ETH1')),
        ...Array.from({ length: count - 1 }, (_, i) =>
          wire(`direct${i}`, endpoint('switch', `ETH${i + 2}`), endpoint(`ap${i + 1}`, 'ETH1'))),
      ],
    };
    const overloaded = build(plan, catalog, limits);
    assert.equal(overloaded.error, '');
    assert.deepEqual(overloaded.status('switch').poe, { watts: budget + 20, budget, overloaded: true });
    assert.equal(overloaded.poweredAps.size, 0);
    assert.equal(overloaded.status('router').speed, 0);
    assert.equal(overloaded.powered.has('patch'), false);
    plan.cables.pop();
    const recovered = build(plan, catalog, limits);
    assert.deepEqual(recovered.status('switch').poe, { watts: budget, budget, overloaded: false });
    assert.equal(recovered.poweredAps.size, count - 1);
    assert.equal(recovered.status('router').speed, 1000);
    assert.equal(recovered.powered.has('patch'), true);
  });
}
