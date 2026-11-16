const { test } = require('node:test');
const assert = require('node:assert/strict');
const design = require('../static/js/wifi-site-design');
const model = require('../static/js/wifi-site-model');

const p = (x, y) => ({ x, y });
const wall = (a, b) => ({ a, b });
const rectangle = (x, y, w, h) => {
  const points = [p(x, y), p(x + w, y), p(x + w, y + h), p(x, y + h)];
  return points.map((a, i) => wall(a, points[(i + 1) % 4]));
};

test('paint bucket finds separate rooms at junctions and leaves outside unbounded', () => {
  const walls = [...rectangle(0, 0, 10, 8), wall(p(5, 0), p(5, 8)), wall(p(5, 4), p(10, 4))];
  const faces = design.rooms(walls);
  assert.deepEqual(faces.map(face => face.size), [20, 20, 40]);
  assert.equal(faces.filter(face => design.contains(face.points, p(7, 5))).length, 1);
  assert.equal(faces.some(face => design.contains(face.points, p(12, 5))), false);
  assert.deepEqual(design.rooms(walls.slice(0, 3)), []);
});

test('nested walls create a hole in the surrounding room and polygon tool rejects crossings', () => {
  const faces = design.rooms([...rectangle(0, 0, 10, 10), ...rectangle(3, 3, 4, 4)]);
  assert.equal(faces[1].holes.length, 1);
  assert.equal(design.contains(faces[1].holes[0], p(5, 5)), true);
  assert.equal(design.simple([p(0, 0), p(4, 4), p(0, 4), p(3, 0)]), false);
  assert.equal(design.simple([p(0, 0), p(4, 0), p(4, 4), p(2, 2), p(0, 4)]), true);
});

test('scaled sports, industrial, and hospital symbols render when rotated', () => {
  const sizes = [
    ['football_field', 109.728, 48.768], ['stadium_seating', 14, 14],
    ['tennis_court', 23.77, 10.97], ['lap_pool', 25, 16],
    ['cnc_mill', 4.3, 3.6], ['cnc_lathe', 5.6, 2.8], ['assembly_conveyor', 12, 2.8],
    ['semi_truck', 2.65, 19.5], ['mobile_crane', 4.25, 15.8], ['service_bay', 7.8, 13.2],
    ['hospital_bed', 1.28, 2.46], ['operating_table', 1.52, 2.64], ['ct_scanner', 3.6, 4.25],
    ['ambulance', 2.68, 7.5], ['helipad', 24, 24], ['diesel_generator', 8.6, 3.3],
  ];
  for (const [kind, width, height] of sizes) {
    const item = { kind, x: 0, y: 0, angle: 90 };
    const [min, max] = design.bounds(item);
    assert.ok(Math.abs(max.x - min.x - height) < 1e-8);
    assert.ok(Math.abs(max.y - min.y - width) < 1e-8);
    assert.ok(design.decorMarkup(item).includes('rotate(90)'));
  }
});

test('only trees and cars contribute decor losses to the signal path', () => {
  const ap = { ...p(0, 0), angle: 0, mount: 'ceiling' };
  const target = p(10, 0);
  const estimate = decor => model.coverageModel([], [ap], '5', [], decor)(target, true);
  const base = estimate([{ ...p(4, 0), kind: 'desk' }]);
  const blockers = estimate([{ ...p(4, 0), kind: 'tree' }, { ...p(7, 1.5), angle: 0, kind: 'car' }]);
  assert.equal(base.signal - blockers.signal, 9);
  assert.deepEqual(blockers.walls, ['Tree canopy', 'Parked car']);
  assert.equal(estimate([{ ...p(7, 1.5), angle: 90, kind: 'car' }]).signal, base.signal);
});
