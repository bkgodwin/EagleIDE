/* Client association and simulated packet routes for Infra Sim. */
(function (root) {
  'use strict';

  const INTERNET = ':internet';
  const INTERVAL = 500;
  const RUN_TIME = 60_000;
  const isClient = device => device?.kind === 'desktop' || device?.kind === 'phone';

  function radio(signal, band) {
    if (signal < -90) return { speed: 0, loss: 1 };
    const quality = Math.min(1, (signal + 90) / 40);
    const peak = band === '2.4' ? 200 : 600;
    return { speed: Math.max(1, Math.round(peak * quality ** 2)), loss: 0.85 * (1 - quality) ** 3 };
  }

  function build(plan, cables, coverageModel) {
    const { devices, location, poweredAps, activeLinks } = cables;
    const links = new Map([...activeLinks].map(([id, edges]) => [id, [...edges]]));
    const accessPoints = plan.access_points.filter(ap => poweredAps.has(ap.id));
    const estimate = coverageModel(plan.walls, accessPoints, plan.band, plan.openings, plan.decor);
    const clients = new Map();
    for (const device of devices.values()) {
      if (!isClient(device)) continue;
      const physical = cables.status(device.id);
      if (device.kind === 'desktop') {
        clients.set(device.id, { speed: physical.speed, upstream: physical.upstream });
        continue;
      }
      const result = estimate(device, true);
      const signal = result?.signal;
      const { speed, loss } = radio(signal ?? -Infinity, plan.band);
      const ap = speed ? result.ap : null;
      const upstream = ap && cables.status(ap.id).upstream;
      clients.set(device.id, { signal, ap, speed, loss,
        upstream: upstream ? { ...upstream, speed: Math.min(upstream.speed, speed) } : null });
      if (!ap) continue;
      const points = [location(device), location(ap)];
      const link = { media: 'wireless', length: result.distance, speed, signal, loss };
      links.get(device.id).push({ ...link, to: ap.id, points });
      links.get(ap.id).push({ ...link, to: device.id, points: [...points].reverse() });
    }
    return { devices, links, location, clients };
  }

  function path(network, from, to) {
    if (!from || !to || from === to) return null;
    const queue = [from], visited = new Map([[from, null]]);
    for (let i = 0; i < queue.length; i += 1) {
      const id = queue[i];
      if (id === to) {
        const hops = [];
        for (let current = id; current !== from;) {
          const { previous, hop } = visited.get(current);
          hops.push(hop);
          current = previous;
        }
        return hops.reverse();
      }
      if (id !== from && (isClient(network.devices.get(id)) || network.devices.get(id).kind === 'demarc')) continue;
      for (const hop of network.links.get(id) || []) {
        if (visited.has(hop.to)) continue;
        visited.set(hop.to, { previous: id, hop });
        queue.push(hop.to);
      }
    }
    return null;
  }

  function latency(hop) {
    if (hop.media === 'internet') return hop.rtt / 2;
    if (hop.media === 'wireless') return 1.4 + hop.length * .027 + Math.max(0, -hop.signal - 50) * .12;
    return (hop.media === 'fiber' ? .16 : .35) + hop.length * .003;
  }

  function ping(network, from, target, random = Math.random) {
    const upstream = target === INTERNET ? network.clients.get(from)?.upstream : null;
    const outbound = path(network, from, target === INTERNET ? upstream?.router : target);
    const origin = network.location(network.devices.get(from));
    if (!outbound) return { stages: [], dropPoint: origin, rtt: null };
    if (upstream) outbound.push({ media: 'internet', rtt: upstream.rtt ?? 30 });
    const stages = [];
    for (const reply of [false, true]) {
      const hops = reply ? [...outbound].reverse() : outbound;
      for (const hop of hops) {
        const points = reply && hop.points ? [...hop.points].reverse() : hop.points;
        const dropped = hop.media === 'wireless' && random() < hop.loss;
        stages.push({ points, reply, media: hop.media, length: hop.length,
          duration: hop.media === 'internet' ? Math.min(650, Math.max(160, hop.rtt ?? 30)) / 2 : 0 });
        if (dropped) return { stages, dropPoint: points.at(-1), rtt: null };
      }
    }
    return { stages, dropPoint: null, rtt: 2 * outbound.reduce((sum, hop) => sum + latency(hop), 0) };
  }

  const model = { INTERNET, INTERVAL, RUN_TIME, isClient, radio, build, path, ping };
  if (typeof module === 'object' && module.exports) module.exports = model;
  else root.WifiSiteClientModel = model;
})(globalThis);
