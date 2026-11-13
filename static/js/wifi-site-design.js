/* Plan symbols in meters and bounded faces for the Infra Sim paint bucket. */
(function (root) {
  'use strict';

  const symbols = {
    tree: ['Tree', 3.7, 3.7, '<path fill="#d2e6cc" stroke="#4d7454" d="M-1.7-.4Q-1.9-1.2-.9-1.5Q-.5-2 .2-1.66Q1-1.94 1.27-1.16Q2-.94 1.67-.2Q2 .55 1.38.95Q1.2 1.75.45 1.64Q-.2 2-1 1.43Q-1.74 1.4-1.56.64Q-2 .24-1.7-.4Z"/><path fill="none" stroke="#789b75" d="M0 0l-.8-.9M0 0l1-.5M0 0l.2 1.1"/><circle r=".17" fill="#74936e"/>'],
    desk: ['Desk', 1.6, .85, '<rect x="-.8" y="-.425" width="1.6" height=".85" rx=".06"/><path fill="none" d="M-.46-.425V.425M-.68-.13h.11m-.11.26h.11"/>'],
    chair: ['Chair', .62, .65, '<rect x="-.29" y="-.29" width=".58" height=".54" rx=".1"/><rect x="-.3" y=".14" width=".6" height=".17" rx=".06" fill="#b9c6ce"/>'],
    table: ['Table', 1.8, .9, '<rect x="-.9" y="-.45" width="1.8" height=".9" rx=".12"/><rect x="-.8" y="-.35" width="1.6" height=".7" rx=".08" fill="none" stroke="#9e8e7a"/>'],
    bench: ['Bench', 1.75, .65, '<rect x="-.875" y="-.325" width="1.75" height=".65" rx=".04"/><path fill="none" d="M-.8-.11H.8M-.8.11H.8M-.63-.325V.325M.63-.325V.325"/>'],
    car: ['Car', 1.85, 4.55, '<path fill="#dce8f0" d="M-.91 1.7V-1.65Q-.9-2.27-.48-2.27H.48Q.9-2.27.91-1.65V1.7Q.9 2.27.48 2.27H-.48Q-.9 2.27-.91 1.7Z"/><path fill="#9db6c8" d="M-.74-1.2Q0-1.55.74-1.2L.59-.57H-.59ZM-.59.87H.59L.72 1.51Q0 1.67-.72 1.51Z"/><path fill="none" d="M-.72-.38V.7M.72-.38V.7M-.74-1.93h.27m.94 0h.27"/>'],
    bed: ['Bed', 1.4, 2.1, '<rect x="-.7" y="-1.05" width="1.4" height="2.1" rx=".08"/><path fill="#cbdde7" d="M-.62-.35H.62V.97H-.62Z"/><rect x="-.55" y="-.86" width="1.1" height=".39" rx=".1" fill="#fff"/>'],
    lamp: ['Lamp post', .75, .75, '<circle r=".34" fill="#f7ebbc"/><circle r=".11" fill="#677686"/><path fill="none" d="M-.24 0h.48M0-.24v.48"/>'],
    parking_bay: ['Parking bay', 2.5, 5.2, '<path fill="none" stroke="#fff" d="M-1.25 2.6v-5.2h2.5v5.2"/>'],
  };
  const surfaces = { floor: 'Room floor', sidewalk: 'Sidewalk', pavement: 'Pavement', landscape: 'Landscape' };
  const choices = { sidewalk: '#dedbd1', pavement: '#a5acb2', landscape: '#d7e8cc' };
  const polygon = points => points.map(p => `${p.x},${p.y}`).join(' ');
  const rings = item => [item.points, ...(item.holes || [])];
  const surfacePath = item => rings(item).map(points => `M${polygon(points)}Z`).join(' ');
  const ringKey = points => points.map(key).sort().join(';');
  const surfaceKey = item => rings(item).map(ringKey).sort().join('|');
  const key = p => `${p.x.toFixed(4)},${p.y.toFixed(4)}`;
  const cross = (a, b) => a.x * b.y - a.y * b.x;
  const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
  const area = points => points.reduce((sum, p, i) => sum + cross(sub(p, points[0]), sub(points[(i + 1) % points.length], points[0])), 0) / 2;
  const contains = (points, p) => points.reduce((inside, a, i) => {
    const b = points[(i + 1) % points.length];
    return (a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x ? !inside : inside;
  }, false);

  function bounds(item) {
    const [, width, height] = symbols[item.kind];
    const rad = item.angle * Math.PI / 180;
    const x = (width * Math.abs(Math.cos(rad)) + height * Math.abs(Math.sin(rad))) / 2;
    const y = (width * Math.abs(Math.sin(rad)) + height * Math.abs(Math.cos(rad))) / 2;
    return [{ x: item.x - x, y: item.y - y }, { x: item.x + x, y: item.y + y }];
  }

  function decorMarkup(item, attr = '', style = '') {
    const [name, width, height, drawing] = symbols[item.kind];
    return `<g class="wifi-decor ${style}" transform="translate(${item.x} ${item.y}) rotate(${item.angle})" ${attr}><title>${name}</title>
      <rect class="wifi-decor-hit" x="${-width / 2}" y="${-height / 2}" width="${width}" height="${height}"/>${drawing}</g>`;
  }

  function surfaceMarkup(item, attr = '') {
    return `<path class="wifi-surface wifi-surface-${item.kind}" d="${surfacePath(item)}" fill="${item.color}" fill-rule="evenodd" ${attr}/>`;
  }

  function simple(points) {
    if (points.length < 3 || points.length > 320 || new Set(points.map(key)).size !== points.length || Math.abs(area(points)) < .005) return false;
    const intersects = (a, b, c, d) => {
      const r = sub(b, a), s = sub(d, c), q = sub(c, a), den = cross(r, s);
      if (Math.abs(den) < 1e-9) return Math.abs(cross(q, r)) < 1e-7
        && Math.max(Math.min(a.x,b.x),Math.min(c.x,d.x)) <= Math.min(Math.max(a.x,b.x),Math.max(c.x,d.x))
        && Math.max(Math.min(a.y,b.y),Math.min(c.y,d.y)) <= Math.min(Math.max(a.y,b.y),Math.max(c.y,d.y));
      const t = cross(q, s) / den, u = cross(q, r) / den;
      return t >= 0 && t <= 1 && u >= 0 && u <= 1;
    };
    return !points.some((a, i) => points.some((c, j) => j > i + 1 && !(i === 0 && j === points.length - 1)
      && intersects(a, points[i + 1], c, points[(j + 1) % points.length])));
  }

  function rooms(walls) {
    const segments = walls.map(({ a, b }) => ({ a, b, d: sub(b, a), splits: [0, 1] }));
    const project = (p, line) => {
      const q = sub(p, line.a);
      if (Math.abs(cross(q, line.d)) > 1e-7) return;
      const t = (q.x * line.d.x + q.y * line.d.y) / (line.d.x ** 2 + line.d.y ** 2);
      if (t > 0 && t < 1) line.splits.push(t);
    };
    let cuts = 0;
    for (let i = 0; i < segments.length; i += 1) for (let j = i + 1; j < segments.length; j += 1) {
      const a = segments[i], b = segments[j];
      if (Math.max(a.a.x, a.b.x) < Math.min(b.a.x, b.b.x) || Math.max(b.a.x, b.b.x) < Math.min(a.a.x, a.b.x)
        || Math.max(a.a.y, a.b.y) < Math.min(b.a.y, b.b.y) || Math.max(b.a.y, b.b.y) < Math.min(a.a.y, a.b.y)) continue;
      const den = cross(a.d, b.d), q = sub(b.a, a.a);
      if (Math.abs(den) < 1e-9) {
        project(b.a, a); project(b.b, a); project(a.a, b); project(a.b, b);
      } else {
        const t = cross(q, b.d) / den, u = cross(q, a.d) / den;
        if (t < -1e-8 || t > 1 + 1e-8 || u < -1e-8 || u > 1 + 1e-8) continue;
        if (t > 0 && t < 1) a.splits.push(t);
        if (u > 0 && u < 1) b.splits.push(u);
      }
      if ((cuts += 1) > 20000) return null;
    }
    const graph = new Map();
    const node = p => {
      const id = key(p);
      if (!graph.has(id)) graph.set(id, { id, x: Number(p.x.toFixed(4)), y: Number(p.y.toFixed(4)), links: new Set() });
      return graph.get(id);
    };
    for (const line of segments) {
      let before;
      for (const t of line.splits.sort((a,b) => a-b)) {
        const next = node({ x: line.a.x + t * line.d.x, y: line.a.y + t * line.d.y });
        if (before && before !== next) { before.links.add(next); next.links.add(before); }
        before = next;
      }
    }
    for (const p of graph.values()) {
      const angle = a => Math.atan2(a.y - p.y, a.x - p.x);
      p.links = [...p.links].sort((a,b) => angle(a) - angle(b));
    }
    const visited = new Set(), faces = [];
    const edge = (a,b) => `${a.id}:${b.id}`;
    for (const start of graph.values()) for (const end of start.links) {
      let a = start, b = end;
      const walk = [], positions = new Map();
      while (!visited.has(edge(a,b))) {
        visited.add(edge(a,b));
        positions.set(a, walk.length);
        walk.push(a);
        if (positions.has(b)) {
          const i = positions.get(b), cycle = walk.splice(i);
          for (const p of cycle) positions.delete(p);
          if (cycle.length > 2) {
            const points = cycle.map(({x,y}) => ({x,y})), size = area(points);
            if (Math.abs(size) >= .005) faces.push({ points, size });
          }
        }
        const next = b.links[(b.links.indexOf(a) + b.links.length - 1) % b.links.length];
        a = b; b = next;
      }
    }
    const enclosed = faces.filter(face => face.size > 0).sort((a,b) => a.size - b.size);
    for (const face of enclosed) face.holes = [];
    for (const outside of faces.filter(face => face.size < 0)) {
      const parent = enclosed.find(face => face.size > -outside.size + .005 && outside.points.every(p => contains(face.points, p)));
      if (parent) parent.holes.push(outside.points);
    }
    return enclosed;
  }

  const design = { symbols, surfaces, choices, bounds, decorMarkup, surfaceMarkup, surfacePath, polygon, surfaceKey, rooms, contains, simple };
  if (typeof module === 'object' && module.exports) module.exports = design;
  else root.WifiSiteDesign = design;
})(globalThis);
