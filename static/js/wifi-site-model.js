/* Indoor coverage estimates for the Wi-Fi Site Simulator. Distances are meters. */
(function (root) {
  'use strict';

  const MATERIALS = Object.freeze({
    drywall: { name: 'Drywall', color: '#60758b', loss: { '2.4': 3, '5': 5 } },
    concrete: { name: 'Concrete', color: '#a35e36', loss: { '2.4': 12, '5': 17 } },
    metal: { name: 'Metal', color: '#7752a8', loss: { '2.4': 22, '5': 27 } },
    glass: { name: 'Glass', color: '#15848e', loss: { '2.4': 2, '5': 4 } },
  });
  const MOUNTS = Object.freeze({ ceiling: 'Ceiling-mounted access point', wall: 'Wall-mounted access point' });
  const FEET = 0.3048;
  const gridStep = units => units === 'ft' ? 5 * FEET : 1;
  const displayDistance = (meters, units) => meters / (units === 'ft' ? FEET : 1);
  const metersFrom = (value, units) => value * (units === 'ft' ? FEET : 1);
  const roundPoint = ({ x, y }) => ({ x: roundDistance(x), y: roundDistance(y) });
  const roundDistance = value => Math.round(value * 10000) / 10000;
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function snapPoint(point, width, height, step = 0) {
    const snap = value => step ? Math.round(value / step) * step : value;
    return roundPoint({
      x: Math.max(0, Math.min(width, snap(point.x))),
      y: Math.max(0, Math.min(height, snap(point.y))),
    });
  }

  function wallIntersection(ap, dx, dy, wall) {
    const denominator = dx * wall.dy - dy * wall.dx;
    if (Math.abs(denominator) < 1e-8) return -1;
    const wx = wall.a.x - ap.x;
    const wy = wall.a.y - ap.y;
    const along = (wx * wall.dy - wy * wall.dx) / denominator;
    if (along <= 1e-7 || along >= 1 - 1e-7) return -1;
    const across = (wx * dy - wy * dx) / denominator;
    return across >= -1e-7 && across <= 1 + 1e-7 ? along : -1;
  }

  function coverageModel(walls, accessPoints, band) {
    const segments = walls.map(wall => ({
      a: wall.a, dx: wall.b.x - wall.a.x, dy: wall.b.y - wall.a.y,
      loss: MATERIALS[wall.material].loss[band], material: wall.material,
    }));
    const transmitters = accessPoints.map(ap => {
      const radians = ap.angle * Math.PI / 180;
      return { ap, facingX: Math.cos(radians), facingY: Math.sin(radians) };
    });
    const reference = band === '5' ? -42 : -35;
    // Reuse crossing arrays for heatmap samples. The probe copies its winning path.
    const crossings = [];
    const obstacles = [];
    return (point, detailed = false) => {
      let bestSignal = -Infinity;
      let best = null;
      for (const { ap, facingX, facingY } of transmitters) {
        const dx = point.x - ap.x;
        const dy = point.y - ap.y;
        const length = Math.hypot(dx, dy);
        const directionLoss = ap.mount === 'wall' && length > 0.01
          ? 9 * (1 - (dx * facingX + dy * facingY) / length) : 0;
        let signal = reference - 25 * Math.log10(Math.max(1, length)) - directionLoss;
        if (signal <= bestSignal) continue;
        crossings.length = 0;
        obstacles.length = 0;
        for (const wall of segments) {
          const crossing = wallIntersection(ap, dx, dy, wall);
          if (crossing < 0) continue;
          // Joined or coincident segments at the same crossing count as one barrier.
          const previous = crossings.findIndex(value => Math.abs(value - crossing) < 1e-7);
          if (previous < 0) {
            crossings.push(crossing);
            obstacles.push(wall);
            signal -= wall.loss;
          } else if (wall.loss > obstacles[previous].loss) {
            signal -= wall.loss - obstacles[previous].loss;
            obstacles[previous] = wall;
          }
        }
        if (signal <= bestSignal) continue;
        bestSignal = signal;
        if (detailed) {
          const path = crossings.map((crossing, i) => ({ crossing, wall: obstacles[i] }));
          path.sort((a, b) => a.crossing - b.crossing);
          best = { ap, signal, distance: length, walls: path.map(item => item.wall.material) };
        }
      }
      return detailed ? best : bestSignal;
    };
  }

  const LEVELS = [
    { min: -58, label: 'Strong', color: [15, 171, 114, 143] },
    { min: -67, label: 'Good', color: [124, 190, 57, 138] },
    { min: -75, label: 'Fair', color: [239, 182, 46, 147] },
    { min: -85, label: 'Weak', color: [225, 100, 66, 138] },
    { min: -Infinity, label: 'Very weak', color: [142, 81, 159, 95] },
  ];
  const signalLevel = signal => LEVELS.find(level => signal >= level.min) || LEVELS.at(-1);

  function heatmap({ width, height, walls, access_points, band }) {
    const step = Math.max(0.35, Math.max(width, height) / 144);
    const columns = Math.min(144, Math.ceil(width / step));
    const rows = Math.min(144, Math.ceil(height / step));
    const pixels = new Uint8ClampedArray(columns * rows * 4);
    const estimate = coverageModel(walls, access_points, band);
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const signal = estimate({ x: (column + 0.5) * width / columns, y: (row + 0.5) * height / rows });
        if (signal < -96) continue;
        pixels.set(signalLevel(signal).color, (row * columns + column) * 4);
      }
    }
    return { columns, rows, pixels };
  }

  const model = {
    MATERIALS, MOUNTS, LEVELS, gridStep, displayDistance, metersFrom,
    roundDistance, distance, snapPoint, coverageModel, signalLevel, heatmap,
  };
  if (typeof module === 'object' && module.exports) module.exports = model;
  else root.WifiSiteModel = model;
})(globalThis);
