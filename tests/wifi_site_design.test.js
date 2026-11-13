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
