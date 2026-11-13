/* Indoor coverage estimates for the Wi-Fi Site Simulator. Distances are meters. */
(function (root) {
  'use strict';

  const MATERIALS = Object.freeze({
    drywall: { name: 'Drywall', color: '#60758b', loss: { '2.4': 3, '5': 5 } },
    concrete: { name: 'Concrete', color: '#a35e36', loss: { '2.4': 12, '5': 17 } },
    reinforced_concrete: { name: 'Thick reinforced concrete', color: '#684735', loss: { '2.4': 20, '5': 28 } },
    metal: { name: 'Metal', color: '#7752a8', loss: { '2.4': 22, '5': 27 } },
    glass: { name: 'Glass', color: '#15848e', loss: { '2.4': 2, '5': 4 } },
    wood: { name: 'Wood', color: '#966835', loss: { '2.4': 4, '5': 6 } },
    brick: { name: 'Brick', color: '#b34a4a', loss: { '2.4': 8, '5': 12 } },
  });
  const MOUNTS = Object.freeze({ ceiling: 'Ceiling-mounted access point', wall: 'Wall-mounted access point' });
  const OPENINGS = {
    door: { wood: { name: 'Wood door', loss: { '2.4': 2, '5': 4 } }, glass: { name: 'Glass door', loss: { '2.4': 1, '5': 3 } },
      metal: { name: 'Metal door', loss: { '2.4': 5, '5': 8 } } },
    window: { glass: { name: 'Clear glass', loss: { '2.4': 1, '5': 2 } },
      coated_glass: { name: 'Coated glass', loss: { '2.4': 3, '5': 5 } } },
  };
  const FEET = 0.3048;
  const gridStep = units => units === 'ft' ? 5 * FEET : 1;
  const displayDistance = (meters, units) => meters / (units === 'ft' ? FEET : 1);
  const metersFrom = (value, units) => value * (units === 'ft' ? FEET : 1);
  const roundDistance = value => Math.round(value * 10000) / 10000;
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const FADE_START = -90;
  const FADE_END = -100;
  const SAMPLES = 64;
  const PADDING = 1;
  const referenceSignal = (band, ap) => (band === '5' ? -42 : -35) + (ap.power_db || 0);
  const OBSTACLES = { tree: { name: 'Tree canopy', rx: 1.75, ry: 1.75, loss: { '2.4': 2, '5': 4 } },
    car: { name: 'Parked car', rx: .9, ry: 2.2, loss: { '2.4': 3, '5': 5 } } };
  const radius = (band, ap) => 10 ** ((referenceSignal(band, ap) - FADE_END) / 25);

  function wallIntersection(ap, dx, dy, wall) {
    const denominator = dx * wall.dy - dy * wall.dx;
    if (Math.abs(denominator) < 1e-8) return null;
    const wx = wall.a.x - ap.x;
    const wy = wall.a.y - ap.y;
    const along = (wx * wall.dy - wy * wall.dx) / denominator;
    if (along <= 1e-7 || along >= 1 - 1e-7) return null;
    const across = (wx * dy - wy * dx) / denominator;
    return across >= -1e-7 && across <= 1 + 1e-7 ? along : null;
  }

  function transmittersFor(walls, accessPoints, band, heat = false, openings = [], decor = []) {
    const byWall = new Map();
    for (const opening of openings) {
      if (!byWall.has(opening.wall_id)) byWall.set(opening.wall_id, []);
      byWall.get(opening.wall_id).push(opening);
    }
    const segments = walls.map(wall => ({
      a: wall.a, dx: wall.b.x - wall.a.x, dy: wall.b.y - wall.a.y,
      left: Math.min(wall.a.x, wall.b.x), right: Math.max(wall.a.x, wall.b.x),
      top: Math.min(wall.a.y, wall.b.y), bottom: Math.max(wall.a.y, wall.b.y),
      loss: MATERIALS[wall.material].loss[band], material: wall.material,
      openings: (byWall.get(wall.id) || []).map(opening => {
        const half = opening.width / (2 * distance(wall.a, wall.b));
        const profile = OPENINGS[opening.kind][opening.material];
        return { start: opening.t - half, end: opening.t + half, loss: profile.loss[band], material: profile.name };
      }),
    }));
    const objects = decor.flatMap(item => {
      const profile = OBSTACLES[item.kind];
      if (!profile) return [];
      const angle = (item.angle || 0) * Math.PI / 180;
      const c = Math.cos(angle), s = Math.sin(angle), extent = Math.max(profile.rx, profile.ry);
      return [{ ...profile, x: item.x, y: item.y, c, s, left: item.x - extent, right: item.x + extent,
        top: item.y - extent, bottom: item.y + extent, material: profile.name, loss: profile.loss[band] }];
    });
    const nearby = (items, ap, range) => heat ? items.filter(item => item.left <= ap.x + range && item.right >= ap.x - range
      && item.top <= ap.y + range && item.bottom >= ap.y - range) : items;
    return accessPoints.map(ap => {
      const radians = ap.angle * Math.PI / 180;
      const range = heat ? radius(band, ap) : Infinity;
      return { ap, facingX: Math.cos(radians), facingY: Math.sin(radians), range,
        walls: nearby(segments, ap, range), objects: nearby(objects, ap, range), reference: referenceSignal(band, ap) };
    });
  }

  function estimateWith(transmitters) {
    // Reuse crossing arrays for heatmap samples. The probe copies its winning path.
    const crossings = [];
    const obstacles = [];
    return (point, detailed = false) => {
      let bestSignal = -Infinity;
      let best = null;
      let alternate = null;
      for (const { ap, facingX, facingY, range, walls, objects, reference } of transmitters) {
        const dx = point.x - ap.x;
        const dy = point.y - ap.y;
        const squared = dx * dx + dy * dy;
        if (squared >= range * range) continue;
        const length = Math.sqrt(squared);
        const directionLoss = ap.mount === 'wall' && length > 0.01
          ? 9 * (1 - (dx * facingX + dy * facingY) / length) : 0;
        let signal = reference - 25 * Math.log10(Math.max(1, length)) - directionLoss;
        const cutoff = detailed ? (alternate?.signal ?? -Infinity) : bestSignal;
        if (signal <= cutoff) continue;
        crossings.length = 0;
        obstacles.length = 0;
        const left = Math.min(ap.x, point.x), right = Math.max(ap.x, point.x);
        const top = Math.min(ap.y, point.y), bottom = Math.max(ap.y, point.y);
        for (const wall of walls) {
          if (wall.left > right || wall.right < left || wall.top > bottom || wall.bottom < top) continue;
          const crossing = wallIntersection(ap, dx, dy, wall);
          if (crossing === null) continue;
          let barrier = wall;
          if (wall.openings.length) {
            const wx = ap.x + dx * crossing - wall.a.x, wy = ap.y + dy * crossing - wall.a.y;
            const across = (wx * wall.dx + wy * wall.dy) / (wall.dx * wall.dx + wall.dy * wall.dy);
            barrier = wall.openings.find(opening => across >= opening.start && across <= opening.end) || wall;
          }
          // Joined or coincident segments at the same crossing count as one barrier.
          const previous = crossings.findIndex(value => Math.abs(value - crossing) * length < 0.0001);
          if (previous < 0) {
            crossings.push(crossing);
            obstacles.push(barrier);
            signal -= barrier.loss;
          } else if (barrier.loss > obstacles[previous].loss) {
            signal -= barrier.loss - obstacles[previous].loss;
            obstacles[previous] = barrier;
          }
          if (signal <= cutoff) break;
        }
        if (signal <= cutoff) continue;
        if (squared > 0) for (const object of objects) {
          if (object.left > right || object.right < left || object.top > bottom || object.bottom < top) continue;
          const x = ap.x - object.x, y = ap.y - object.y;
          const u = (x * object.c + y * object.s) / object.rx, v = (y * object.c - x * object.s) / object.ry;
          const du = (dx * object.c + dy * object.s) / object.rx, dv = (dy * object.c - dx * object.s) / object.ry;
          const t = Math.max(0, Math.min(1, -(u * du + v * dv) / (du * du + dv * dv)));
          if ((u + du * t) ** 2 + (v + dv * t) ** 2 >= 1) continue;
          signal -= object.loss;
          if (detailed) { crossings.push(t); obstacles.push(object); }
          if (signal <= cutoff) break;
        }
        if (signal <= cutoff) continue;
        if (signal <= bestSignal) {
          if (detailed) alternate = { ap, signal };
          continue;
        }
        bestSignal = signal;
        if (detailed) {
          if (best) alternate = { ap: best.ap, signal: best.signal };
          const path = crossings.map((crossing, i) => ({ crossing, wall: obstacles[i] }));
          path.sort((a, b) => a.crossing - b.crossing);
          best = { ap, signal, distance: length, walls: path.map(item => item.wall.material) };
        }
      }
      return detailed && best ? { ...best, alternate } : detailed ? null : bestSignal;
    };
  }

  function coverageModel(walls, accessPoints, band, openings, decor) {
    return estimateWith(transmittersFor(walls, accessPoints, band, false, openings, decor));
  }

  const LEVELS = [
    { min: -58, label: 'Strong', color: [15, 171, 114, 143] },
    { min: -67, label: 'Good', color: [124, 190, 57, 138] },
    { min: -75, label: 'Fair', color: [239, 182, 46, 147] },
    { min: -85, label: 'Weak', color: [225, 100, 66, 138] },
    { min: -Infinity, label: 'Very weak', color: [142, 81, 159, 95] },
  ];
  const signalLevel = signal => LEVELS.find(level => signal >= level.min) || LEVELS.at(-1);

  const stops = [
    { signal: FADE_END, color: [142, 81, 159, 0] },
    { signal: FADE_START, color: LEVELS[4].color },
    { signal: -83, color: LEVELS[3].color },
    { signal: -73, color: LEVELS[2].color },
    { signal: -65, color: LEVELS[1].color },
    { signal: -55, color: LEVELS[0].color },
  ];
  const ramp = Array.from({ length: 181 }, (_, index) => {
    const signal = FADE_END + index / 4;
    const end = stops.findIndex(stop => stop.signal >= signal);
    if (end <= 0) return stops[0].color;
    const low = stops[end - 1], high = stops[end];
    const amount = (signal - low.signal) / (high.signal - low.signal);
    return low.color.map((channel, i) => Math.round(channel + (high.color[i] - channel) * amount));
  });
  const signalColor = signal => ramp[Math.max(0, Math.min(ramp.length - 1, Math.round((signal - FADE_END) * 4)))];
  const tileStep = level => 2 ** level;
  const tileSize = level => SAMPLES * tileStep(level);
  const tileLevel = scale => Math.floor(Math.log2(4 / scale));

  function tileBounds({ x, y, level }, padding = 0) {
    const size = tileSize(level);
    const extra = padding * tileStep(level);
    return { left: x * size - extra, top: y * size - extra, right: (x + 1) * size + extra, bottom: (y + 1) * size + extra };
  }

  function inRange({ x, y }, range, bounds) {
    const dx = Math.max(bounds.left - x, 0, x - bounds.right);
    const dy = Math.max(bounds.top - y, 0, y - bounds.bottom);
    return dx * dx + dy * dy < range * range;
  }

  function heatAreas(accessPoints, band) {
    return accessPoints.map(ap => ({ ap, range: radius(band, ap) }));
  }

  function tileHasCoverage(areas, tile) {
    const bounds = tileBounds(tile, PADDING);
    return areas.some(({ ap, range }) => inRange(ap, range, bounds));
  }

  function createHeatSource({ walls, access_points, band, openings, decor }) {
    const transmitters = transmittersFor(walls, access_points, band, true, openings, decor);
    return tile => {
      const bounds = tileBounds(tile, PADDING);
      const local = transmitters.filter(({ ap, range }) => inRange(ap, range, bounds));
      if (!local.length) return null;
      const estimate = estimateWith(local);
      const step = tileStep(tile.level);
      const size = SAMPLES + PADDING * 2;
      const pixels = new Uint8ClampedArray(size * size * 4);
      const point = { x: 0, y: 0 };
      let visible = false;
      for (let row = 0; row < size; row += 1) {
        point.y = bounds.top + (row + 0.5) * step;
        for (let column = 0; column < size; column += 1) {
          point.x = bounds.left + (column + 0.5) * step;
          const signal = estimate(point);
          if (signal <= FADE_END) continue;
          const color = signalColor(signal);
          pixels.set(color, (row * size + column) * 4);
          visible ||= color[3] > 0;
        }
      }
      return visible ? pixels : null;
    };
  }

  const model = {
    MATERIALS, MOUNTS, OPENINGS, OBSTACLES, LEVELS, gridStep, displayDistance, metersFrom,
    roundDistance, distance, coverageModel, signalLevel, signalColor, SAMPLES, PADDING,
    tileLevel, tileSize, tileStep, tileBounds, tileHasCoverage, heatAreas, createHeatSource,
  };
  if (typeof module === 'object' && module.exports) module.exports = model;
  else root.WifiSiteModel = model;
})(globalThis);
