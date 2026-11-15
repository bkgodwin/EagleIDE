/* Geometry, port allocation, and cable bundles for the site planner. */
(function (root) {
  'use strict';

  const COLORS = { ethernet: '#0879b3', fiber: '#982fba' };
  const TYPES = ['router', 'core_switch', 'distribution_switch', 'access_switch', 'keystone', 'demarc', 'desktop', 'phone'];
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const isConcrete = wall => ['concrete', 'reinforced_concrete'].includes(wall?.material);
  const portKey = ({ device_id, port }) => `${device_id}:${port}`;
  const mediaName = media => media === 'fiber' ? 'Fiber' : 'Ethernet';
  const speedName = mbps => mbps >= 1000 ? `${mbps / 1000} Gb/s` : `${mbps} Mb/s`;
  const cableName = (cable, index) => cable.label || `${mediaName(cable.media)} ${index + 1}`;

  function wallGeometry(wall) {
    const { a, b } = wall;
    const dx = b.x - a.x, dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    return { ...wall, dx, dy, length, ux: dx / length, uy: dy / length,
      left: Math.min(a.x, b.x), right: Math.max(a.x, b.x), top: Math.min(a.y, b.y), bottom: Math.max(a.y, b.y) };
  }

  function pointAt(wall, t) {
    return { x: wall.a.x + (wall.b.x - wall.a.x) * t, y: wall.a.y + (wall.b.y - wall.a.y) * t };
  }

  function closestWall(point, walls, tolerance, concrete = false) {
    let best = null;
    let gap = tolerance;
    for (const wall of walls) {
      if (concrete && !isConcrete(wall)) continue;
      const dx = wall.b.x - wall.a.x, dy = wall.b.y - wall.a.y;
      const t = Math.max(0, Math.min(1, ((point.x - wall.a.x) * dx + (point.y - wall.a.y) * dy) / (dx * dx + dy * dy)));
      const nearest = pointAt(wall, t);
      const nextGap = distance(point, nearest);
      if (nextGap <= gap) {
        best = { wall_id: wall.id, t: Number(t.toFixed(10)), point: nearest };
        gap = nextGap;
      }
    }
    return best;
  }

  function crossingIntervals(wall, points, epsilon) {
    let previous;
    let onLow = Infinity, onHigh = -Infinity;
    const hits = [];
    for (const point of points) {
      const dx = point.x - wall.a.x, dy = point.y - wall.a.y;
      const along = dx * wall.ux + dy * wall.uy;
      const side = wall.ux * dy - wall.uy * dx;
      if (Math.abs(side) <= epsilon) {
        onLow = Math.min(onLow, along);
        onHigh = Math.max(onHigh, along);
        continue;
      }
      if (previous && (side < 0) !== (previous.side < 0)) {
        const hit = previous.along + (along - previous.along) * previous.side / (previous.side - side);
        const low = onLow <= onHigh ? onLow : hit;
        const high = onLow <= onHigh ? onHigh : hit;
        if (low <= wall.length + epsilon && high >= -epsilon) hits.push([Math.max(0, low), Math.min(wall.length, high)]);
      }
      previous = { side, along };
      onLow = Infinity;
      onHigh = -Infinity;
    }
    return hits;
  }

  function portProfiles(device, catalog) {
    if (device.kind === 'demarc') return [{ ...catalog.isps[device.isp], id: 'ISP' }];
    return catalog.equipment[device.kind].groups.flatMap(group =>
      Array.from({ length: group.count || 1 }, (_, i) => ({ ...group, id: group.prefix + (group.count ? i + 1 : '') })));
  }

  function build(plan, catalog, limits, apNames = {}) {
    const walls = new Map(plan.walls.map(wall => [wall.id, wallGeometry(wall)]));
    const concrete = [...walls.values()].filter(isConcrete);
    const devices = new Map(plan.equipment.map(device => [device.id, device]));
    for (const ap of plan.access_points) devices.set(ap.id, { ...ap, kind: 'access_point' });
    const passages = new Map(plan.pass_throughs.map(pass => [pass.id, pass]));
    const ports = new Map([...devices].map(([id, device]) => [id, portProfiles(device, catalog)]));
    const passesByWall = new Map();
    const occupancy = new Map(), usage = new Map(), inspections = new Map();
    const links = new Map([...devices.keys()].map(id => [id, []]));
    const activeLinks = new Map([...devices.keys()].map(id => [id, []]));
    const internet = new Map(), wan = new Map();
    let totalBends = 0;
    const wired = new Set(), powered = new Set(), poweredAps = new Set(), poe = new Map();
    function name(device) {
      if (device.name) return device.name;
      if (device.kind === 'demarc') return catalog.isps[device.isp].name;
      if (device.kind === 'access_point' && apNames[device.mount]) return apNames[device.mount];
      return catalog.equipment[device.kind].name;
    }
    const location = item => !item ? null : item.wall_id ? (walls.has(item.wall_id) ? pointAt(walls.get(item.wall_id), item.t) : null) : { x: item.x, y: item.y };
    const waypoint = bend => bend.pass_id ? location(passages.get(bend.pass_id)) : bend;
    const route = cable => [location(devices.get(cable.source.device_id)), ...cable.waypoints.map(waypoint), location(devices.get(cable.target.device_id))];
    const findPort = endpoint => ports.get(endpoint.device_id)?.find(port => port.id === endpoint.port);
    const endName = endpoint => `${name(devices.get(endpoint.device_id))} · ${endpoint.port}`;

    function availablePorts(deviceId, media, counterpartId, ignore) {
      const device = devices.get(deviceId);
      const counterpart = devices.get(counterpartId);
      if (!device || deviceId === counterpartId) return [];
      if (counterpart && device.kind === 'demarc' && counterpart.kind !== 'router') return [];
      return ports.get(deviceId).filter(port => {
        if (port.media !== media) return false;
        if (counterpart && device.kind !== 'demarc' && !!port.wan !== (counterpart.kind === 'demarc')) return false;
        const used = occupancy.get(portKey({ device_id: deviceId, port: port.id }));
        return !used || used === ignore;
      });
    }

    function checkCable(cable) {
      const { source, target, media } = cable;
      const fail = (error, point) => ({ error, point });
      const a = devices.get(source.device_id), b = devices.get(target.device_id);
      if (!a || !b || a.id === b.id) return fail('Connect two different devices.');
      const from = findPort(source), to = findPort(target);
      if (!from || !to || from.media !== media || to.media !== media) return fail('Choose a port that supports this cable type.');
      const isWan = from.wan || to.wan;
      const hasIsp = a.kind === 'demarc' || b.kind === 'demarc';
      if (hasIsp && !isWan) return fail('Connect the ISP demarcation to a router WAN port.');
      if (!hasIsp && isWan) return fail('Router WAN ports are reserved for ISP demarcations.');
      for (const endpoint of [source, target]) {
        const used = occupancy.get(portKey(endpoint));
        if (used && used !== cable.id) return fail('Each port can carry only one cable.');
      }
      const points = route(cable);
      if (points.some(point => !point)) return fail('The route uses a missing device or pass-through.');
      if (cable.waypoints.length > limits.bends) return fail(`A cable supports up to ${limits.bends} bends.`);
      const existing = inspections.get(cable.id);
      if (totalBends + cable.waypoints.length - (existing?.bendCount || 0) > limits.total_bends) {
        return fail('This site has reached its total cable bend limit.');
      }
      const bounds = points.reduce((box, { x, y }) => ({
        left: Math.min(box.left, x), right: Math.max(box.right, x),
        top: Math.min(box.top, y), bottom: Math.max(box.bottom, y),
      }), { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity });
      if (Math.hypot(bounds.right - bounds.left, bounds.bottom - bounds.top) <= catalog.epsilon) {
        return fail('The route needs a measurable length.');
      }
      const usedPasses = new Set(cable.waypoints.map(bend => bend.pass_id).filter(Boolean));
      const epsilon = catalog.epsilon;
      for (const wall of concrete) {
        if (wall.left > bounds.right + epsilon || wall.right < bounds.left - epsilon ||
            wall.top > bounds.bottom + epsilon || wall.bottom < bounds.top - epsilon) continue;
        for (const [low, high] of crossingIntervals(wall, points, epsilon)) {
          const pass = passesByWall.get(wall.id)?.find(candidate =>
            candidate.t * wall.length >= low - catalog.crossing_tolerance &&
            candidate.t * wall.length <= high + catalog.crossing_tolerance);
          if (!pass) return fail(`${cable.label || 'Cable route'} crosses concrete without a pass-through.`,
            pointAt(wall, Math.max(0, Math.min(1, (low + high) / (2 * wall.length)))));
          usedPasses.add(pass.id);
        }
      }
      for (const passId of usedPasses) {
        const used = (usage.get(passId) || 0) - (existing?.usedPasses.has(passId) ? 1 : 0);
        if (used >= catalog.pass_capacity) return fail('This concrete pass-through is full (10 cables).', location(passages.get(passId)));
      }
      const length = points.slice(1).reduce((sum, point, i) => sum + distance(points[i], point), 0);
      return { points, usedPasses, length, speed: Math.min(from.speed, to.speed), bendCount: cable.waypoints.length };
    }

    function validate() {
      for (const device of devices.values()) if (!location(device)) return 'Wall-mounted equipment requires a wall.';
      for (const pass of passages.values()) {
        if (!isConcrete(walls.get(pass.wall_id))) return 'Pass-throughs require a concrete wall.';
        if (!passesByWall.has(pass.wall_id)) passesByWall.set(pass.wall_id, []);
        passesByWall.get(pass.wall_id).push(pass);
      }
      for (const [wallId, passes] of passesByWall) {
        passes.sort((a, b) => a.t - b.t);
        for (let i = 1; i < passes.length; i += 1) {
          if ((passes[i].t - passes[i - 1].t) * walls.get(wallId).length < catalog.pass_spacing - catalog.epsilon) {
            return 'Pass-throughs on the same wall must be at least 20 feet (6.096 m) apart.';
          }
        }
      }
      const copper = new Map(), feeds = new Map();
      for (const cable of plan.cables) {
        const result = checkCable(cable);
        if (result.error) return result.error;
        inspections.set(cable.id, result);
        for (const [from, to] of [[cable.source, cable.target], [cable.target, cable.source]]) {
          links.get(from.device_id).push({ to: to.device_id, speed: result.speed, cable: cable.id, media: cable.media,
            fromPort: from.port, toPort: to.port, wan: Boolean(findPort(from).wan || findPort(to).wan),
            length: result.length, points: from === cable.source ? result.points : [...result.points].reverse() });
          if (cable.media !== 'ethernet' || !findPort(from).poe) continue;
          if (!feeds.has(from.device_id)) feeds.set(from.device_id, []);
          feeds.get(from.device_id).push({ cable, end: to });
        }
        totalBends += result.bendCount;
        for (const pass of result.usedPasses) usage.set(pass, (usage.get(pass) || 0) + 1);
        for (const end of [cable.source, cable.target]) {
          occupancy.set(portKey(end), cable.id);
          if (devices.get(end.device_id).kind === 'access_point') wired.add(end.device_id);
        }
        if (cable.media === 'ethernet') copper.set(cable.id, cable);
      }
      for (const [id, device] of devices) {
        const budget = catalog.equipment[device.kind]?.poe_budget;
        if (!budget) continue;
        const routes = new Set(), aps = new Set();
        for (const feed of feeds.get(id) || []) {
          let { cable, end } = feed;
          while (cable && !routes.has(cable.id)) {
            routes.add(cable.id);
            const receiver = devices.get(end.device_id);
            if (receiver.kind === 'access_point') aps.add(receiver.id);
            // A keystone joins its front patch port to its rear termination.
            if (receiver.kind !== 'keystone') break;
            cable = copper.get(occupancy.get(portKey({ device_id: receiver.id, port: end.port === 'FRONT' ? 'BACK' : 'FRONT' })));
            if (cable) end = cable.source.device_id === receiver.id ? cable.target : cable.source;
          }
        }
        const watts = aps.size * catalog.equipment.access_point.poe_draw;
        const overloaded = watts > budget;
        poe.set(id, { watts, budget, overloaded });
        if (overloaded) continue;
        for (const cableId of routes) powered.add(cableId);
        for (const apId of aps) poweredAps.add(apId);
      }
      const online = id => !poe.get(id)?.overloaded &&
        (devices.get(id).kind !== 'access_point' || poweredAps.has(id));
      for (const [id, connections] of links) {
        if (online(id)) activeLinks.set(id, connections.filter(link => online(link.to)));
      }
      const upstream = [...devices].filter(([id, device]) => device.kind === 'demarc' && activeLinks.get(id).length)
        .map(([id, device]) => ({ id, speed: catalog.isps[device.isp].speed, provider: catalog.isps[device.isp].name,
          rtt: catalog.isps[device.isp].rtt_ms, router: activeLinks.get(id)[0].to }));
      for (const handoff of upstream) {
        const speed = Math.min(handoff.speed, activeLinks.get(handoff.id)[0].speed);
        if (speed > (wan.get(handoff.router)?.speed ?? 0)) {
          wan.set(handoff.router, { ...handoff, speed });
        }
      }
      while (upstream.length) {
        upstream.sort((a, b) => b.speed - a.speed);
        const path = upstream.shift();
        if (internet.has(path.id)) continue;
        internet.set(path.id, path);
        if (['access_point', 'desktop', 'phone'].includes(devices.get(path.id).kind)) continue;
        for (const link of activeLinks.get(path.id)) {
          if (!internet.has(link.to)) upstream.push({ ...path, id: link.to, speed: Math.min(path.speed, link.speed) });
        }
      }
      return '';
    }

    const error = validate();
    function status(id) {
      const device = devices.get(id);
      const connected = links.get(id);
      const speed = Math.max(0, ...activeLinks.get(id).map(link => link.speed));
      const upstream = internet.get(id);
      const budget = poe.get(id);
      const power = device.kind === 'keystone' || device.kind === 'demarc' ? 'Passive'
        : budget?.overloaded ? 'Shut down'
        : device.kind !== 'access_point' ? 'Local power'
        : poweredAps.has(id) ? 'PoE available' : wired.has(id) ? 'No PoE source' : 'Unwired';
      return { speed, upstream, isp: wan.get(id), power, count: connected.length, poe: budget };
    }

    function channels(id) {
      const slots = Array.from({ length: catalog.pass_channels || 8 }, () => []);
      const cables = plan.cables.filter(cable => inspections.get(cable.id)?.usedPasses.has(id));
      cables.forEach((cable, index) => slots[index % slots.length].push(cable));
      return slots;
    }
    return { error, walls, devices, passages, ports, occupancy, usage, inspections, wired, powered, poweredAps, poe, activeLinks,
      name, location, waypoint, route, endName, availablePorts, checkCable, status, channels };
  }

  function bundledSegments(cables, inspections) {
    const lines = new Map();
    for (const cable of cables) {
      const points = inspections.get(cable.id)?.points || [];
      for (let i = 1; i < points.length; i += 1) {
        let a = points[i - 1], b = points[i];
        if (distance(a, b) < 0.0002) continue;
        if (a.x > b.x || (a.x === b.x && a.y > b.y)) [a, b] = [b, a];
        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        const ux = Math.cos(angle), uy = Math.sin(angle);
        const key = `${Math.round(angle * 1e8)}:${Math.round((-uy * a.x + ux * a.y) * 1000)}`;
        if (!lines.has(key)) lines.set(key, new Map());
        const events = lines.get(key);
        for (const [point, delta] of [[a, 1], [b, -1]]) {
          const order = Math.round((point.x * ux + point.y * uy) * 10000);
          if (!events.has(order)) events.set(order, { point, changes: [] });
          events.get(order).changes.push([cable.id, delta]);
        }
      }
    }
    const segments = [];
    for (const line of lines.values()) {
      const events = [...line].sort(([a], [b]) => a - b);
      const active = new Map();
      let previous;
      for (const [, { point, changes }] of events) {
        if (previous && active.size) segments.push({ a: previous, b: point, cableIds: [...active.keys()].sort() });
        for (const [id, delta] of changes) {
          const count = (active.get(id) || 0) + delta;
          if (count) active.set(id, count);
          else active.delete(id);
        }
        previous = point;
      }
    }
    return segments;
  }

  const model = { COLORS, TYPES, distance, portKey, mediaName, speedName, cableName, pointAt, closestWall, build, bundledSegments };
  if (typeof module === 'object' && module.exports) module.exports = model;
  else root.WifiCablingModel = model;
})(globalThis);
