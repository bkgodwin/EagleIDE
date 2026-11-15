/* Association, DHCP, and simulated packet routes for Infra Sim. */
(function (root) {
  'use strict';

  const INTERNET = ':internet';
  const INTERNET_IP = '203.0.113.10'; // A documentation address for the simulated google.com target.
  const INTERVAL = 500;
  const RUN_TIME = 60_000;
  const DEFAULT_SSID = { id: 'default', name: 'Default', band: 'both', vlan: 0 };
  const DEFAULT_DHCP = { gateway: '192.168.0.1/24', dns: '1.1.1.1', fallback_dns: '8.8.8.8' };
  const isClient = device => device?.kind === 'desktop' || device?.kind === 'phone';
  const managed = device => ['core_switch', 'distribution_switch'].includes(device.kind);
  const portVlans = (device, port) => device.port_vlans?.[port] ?? [0];
  const apSsids = (ap, ssids) => ap.ssid_ids ?? ssids.slice(0, 1).map(ssid => ssid.id);
  const hasBand = (ssid, band) => ssid.band === 'both' || ssid.band === band;

  function coverageAps(accessPoints, ssids, band, filter = '') {
    const matching = new Set(ssids.filter(ssid => (!filter || ssid.id === filter) && hasBand(ssid, band)).map(ssid => ssid.id));
    return accessPoints.filter(ap => apSsids(ap, ssids).some(id => matching.has(id)));
  }

  function ipNumber(value) {
    if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) return null;
    const octets = value.split('.').map(Number);
    return octets.some(octet => octet > 255) ? null : octets.reduce((ip, octet) => ip * 256 + octet, 0);
  }

  const address = ip => [24, 16, 8, 0].map(shift => (ip >>> shift) & 255).join('.');

  function parseCidr(value, defaultPrefix = 32) {
    const parts = value.trim().split('/');
    const ip = ipNumber(parts[0]);
    if (ip === null || parts.length > 2 || (parts.length === 2 && !/^(?:0|[1-9]\d?)$/.test(parts[1]))) return null;
    const prefix = parts.length === 2 ? Number(parts[1]) : defaultPrefix;
    if (prefix > 32) return null;
    const size = 2 ** (32 - prefix);
    const first = Math.floor(ip / size) * size;
    return { ip, first, last: first + size - 1, prefix };
  }

  function dhcpPool({ gateway, dns, fallback_dns }) {
    if (!gateway.includes('/') || ipNumber(dns) === null || ipNumber(fallback_dns) === null) return null;
    const subnet = parseCidr(gateway);
    if (!subnet) return null;
    const { ip, prefix, first, last } = subnet;
    if (prefix > 30 || ip === first || ip === last || first < 2 ** 24 || last >= 224 * 2 ** 24 ||
        (last >= 127 * 2 ** 24 && first < 128 * 2 ** 24)) return null;
    return { first, last, gateway: ip, prefix, dns, fallback_dns, capacity: last - first - 2 };
  }

  function usable(pool, ip) {
    return ip !== null && ip > pool.first && ip < pool.last && ip !== pool.gateway;
  }

  function radio(signal, band) {
    if (signal < -90) return { speed: 0, loss: 1 };
    const quality = Math.min(1, (signal + 90) / 40);
    const peak = band === '2.4' ? 200 : 600;
    return { speed: Math.max(1, Math.round(peak * quality ** 2)), loss: 0.85 * (1 - quality) ** 3 };
  }

  function desktopVlan(network, id) {
    // The first managed switch port sets the desktop's untagged access VLAN.
    // Keystone jacks and the unmanaged switch carry the access segment.
    const visited = new Set([id]), queue = [id];
    for (const node of queue) {
      for (const link of network.links.get(node)) {
        if (link.wan || link.media === 'wireless' || visited.has(link.to)) continue;
        visited.add(link.to);
        const peer = network.devices.get(link.to);
        if (managed(peer)) return portVlans(peer, link.toPort)[0] ?? null;
        if (peer.kind === 'router') return 0;
        if (peer.kind === 'keystone' || peer.kind === 'access_switch') queue.push(peer.id);
      }
    }
    return 0;
  }

  function lanPaths(network, from, vlan) {
    const queue = [from], visited = new Map([[from, null]]);
    if (vlan === null) return visited;
    for (const id of queue) {
      const device = network.devices.get(id);
      if (id !== from && (isClient(device) || device.kind === 'router')) continue;
      for (const hop of network.links.get(id)) {
        if (hop.wan || visited.has(hop.to)) continue;
        const peer = network.devices.get(hop.to);
        if ((managed(device) && !portVlans(device, hop.fromPort).includes(vlan)) ||
            (managed(peer) && !portVlans(peer, hop.toPort).includes(vlan)) ||
            (hop.media === 'wireless' && hop.vlan !== vlan) ||
            (isClient(peer) && network.clients.get(peer.id).vlan !== vlan)) continue;
        visited.set(hop.to, { previous: id, hop });
        queue.push(hop.to);
      }
    }
    return visited;
  }

  function path(paths, to) {
    if (!paths?.has(to)) return null;
    const hops = [];
    for (let current = to; paths.get(current);) {
      const { previous, hop } = paths.get(current);
      hops.push(hop);
      current = previous;
    }
    return hops.reverse();
  }

  function reversePath(hops) {
    return [...hops].reverse().map(hop => ({ ...hop, points: [...hop.points].reverse() }));
  }

  function leaseClients(network, prior) {
    const { clients, devices, routers } = network;
    const occupied = new Map([...routers.keys()].map(id => [id, new Set()]));
    for (const [id, client] of clients) {
      const reserved = devices.get(id).reservation;
      const router = routers.get(reserved?.router_id);
      const ip = reserved ? ipNumber(reserved.ip) : null;
      if (!router || !usable(router.pool, ip)) continue;
      occupied.get(router.id).add(ip);
      client.lease = { ip, router: router.id, static: true };
    }
    for (const [id, client] of clients) {
      if (!client.speed) continue;
      client.paths = lanPaths(network, id, client.vlan);
      if (client.lease) {
        if (client.paths.has(client.lease.router)) client.router = routers.get(client.lease.router);
        continue;
      }
      const router = [...client.paths.keys()].map(peer => routers.get(peer)).find(Boolean);
      if (!router) continue;
      client.router = router;
      router.waiting.push(client);
      const before = prior?.clients.get(id);
      const ip = before?.lease?.ip;
      const used = occupied.get(router.id);
      if (before?.lease?.router === router.id && before.vlan === client.vlan && usable(router.pool, ip) && !used.has(ip)) {
        client.lease = { ip, router: router.id, static: false };
        used.add(ip);
      }
    }
    for (const router of routers.values()) {
      const { first, last, gateway, capacity } = router.pool;
      const used = occupied.get(router.id);
      const before = prior?.routers.get(router.id);
      let cursor = before?.pool.first === first && before.pool.last === last && before.pool.gateway === gateway
        ? before.cursor : first + 1;
      const next = ip => ip + 1 === last ? first + 1 : ip + 1;
      for (const client of router.waiting) {
        if (client.lease) continue;
        if (used.size === capacity) { router.unassigned += 1; continue; }
        while (cursor === gateway || used.has(cursor)) cursor = next(cursor);
        client.lease = { ip: cursor, router: router.id, static: false };
        used.add(cursor);
        cursor = next(cursor);
      }
      router.cursor = cursor;
      router.available = capacity - used.size;
    }
  }

  function build(plan, cables, coverageModel, prior) {
    const { devices, location, poweredAps, activeLinks } = cables;
    const links = new Map([...activeLinks].map(([id, edges]) => [id, [...edges]]));
    const accessPoints = plan.access_points.filter(ap => poweredAps.has(ap.id));
    const ssids = plan.ssids ?? [DEFAULT_SSID];
    const surveys = new Map();
    const clients = new Map(), routers = new Map();
    const network = { devices, links, location, clients, routers };
    for (const device of devices.values()) {
      if (device.kind === 'router') {
        const pool = dhcpPool(device.dhcp ?? DEFAULT_DHCP);
        const { isp } = cables.status(device.id);
        routers.set(device.id, { id: device.id, pool, isp, waiting: [], unassigned: 0 });
      }
      if (!isClient(device)) continue;
      if (device.kind === 'desktop') {
        clients.set(device.id, { speed: cables.status(device.id).speed, vlan: desktopVlan(network, device.id) });
        continue;
      }
      const ssid = device.ssid_id ? ssids.find(item => item.id === device.ssid_id) : ssids[0];
      let best = { speed: 0 };
      if (ssid) {
        if (!surveys.has(ssid.id)) {
          surveys.set(ssid.id, ['5', '2.4'].filter(band => hasBand(ssid, band)).map(band => ({
            band, estimate: coverageModel(plan.walls, coverageAps(accessPoints, ssids, band, ssid.id),
              band, plan.openings, plan.decor),
          })));
        }
        for (const { band, estimate } of surveys.get(ssid.id)) {
          const result = estimate(device, true);
          if (!result) continue;
          const { speed, loss } = radio(result.signal, band);
          if (speed > best.speed || (speed === best.speed && result.signal > (best.signal ?? -Infinity))) {
            best = { speed, loss, band, signal: result.signal, ap: speed ? result.ap : null, distance: result.distance };
          }
        }
      }
      clients.set(device.id, { ...best, vlan: ssid?.vlan ?? null });
      if (!best.ap) continue;
      const points = [location(device), location(best.ap)];
      const link = { media: 'wireless', length: best.distance, speed: best.speed, signal: best.signal, loss: best.loss, vlan: ssid.vlan };
      links.get(device.id).push({ ...link, to: best.ap.id, points });
      links.get(best.ap.id).push({ ...link, to: device.id, points: [...points].reverse() });
    }
    leaseClients(network, prior);
    for (const client of clients.values()) {
      if (!client.lease || !client.router?.isp) continue;
      const isp = client.router.isp;
      const route = path(client.paths, client.router.id);
      client.upstream = { ...isp, speed: Math.min(isp.speed, ...route.map(hop => hop.speed)) };
    }
    return network;
  }

  function firewall(device, source, destination) {
    const matches = (rule, side, endpoint) => {
      const vlan = rule[side + '_vlan'];
      const cidr = rule[side + '_ip'];
      if (vlan != null && vlan !== endpoint.vlan) return false;
      if (!cidr) return true;
      const { first, last } = parseCidr(cidr);
      return endpoint.ip >= first && endpoint.ip <= last;
    };
    const index = (device.firewall || []).findIndex(rule =>
      matches(rule, 'source', source) && matches(rule, 'destination', destination));
    return device.firewall?.[index]?.action === 'deny' ? index + 1 : 0;
  }

  function latency(hop) {
    if (hop.media === 'internet') return hop.rtt / 2;
    if (hop.media === 'wireless') return 1.4 + hop.length * .027 + Math.max(0, -hop.signal - 50) * .12;
    return (hop.media === 'fiber' ? .16 : .35) + hop.length * .003;
  }

  function ping(network, from, target, random = Math.random) {
    const source = network.clients.get(from);
    const destination = network.clients.get(target);
    const origin = network.location(network.devices.get(from));
    const drop = reason => ({ stages: [], dropPoint: origin, rtt: null, reason });
    if (!source?.speed || !source.lease) return drop('The source needs a connected IPv4 address.');
    const router = source.router;
    let outbound, policyDrop = 0;
    if (destination) {
      if (!destination.speed || !destination.lease) return drop('The target needs a connected IPv4 address.');
      if (source.vlan === destination.vlan) outbound = path(source.paths, target);
      else if (router) {
        const destinationPath = path(destination.paths, router.id);
        if (destinationPath) {
          outbound = path(source.paths, router.id);
          policyDrop = firewall(network.devices.get(router.id), { vlan: source.vlan, ip: source.lease.ip },
            { vlan: destination.vlan, ip: destination.lease.ip });
          if (!policyDrop) outbound.push(...reversePath(destinationPath));
        }
      }
    } else if (target === INTERNET && source.upstream) {
      outbound = path(source.paths, router.id);
      policyDrop = firewall(network.devices.get(router.id), { vlan: source.vlan, ip: source.lease.ip },
        { vlan: null, ip: ipNumber(INTERNET_IP) });
      if (!policyDrop) outbound.push({ media: 'internet', rtt: source.upstream.rtt ?? 30 });
    } else if (network.routers.has(target)) {
      outbound = path(source.paths, target);
      policyDrop = firewall(network.devices.get(target), { vlan: source.vlan, ip: source.lease.ip },
        { vlan: source.vlan, ip: network.routers.get(target).pool.gateway });
    }
    if (!outbound?.length) return drop(target === INTERNET ? 'No connected Internet gateway.' : 'No path for the selected VLANs.');
    const stages = [];
    for (const reply of [false, true]) {
      const hops = reply ? [...outbound].reverse() : outbound;
      for (const hop of hops) {
        const points = reply && hop.points ? [...hop.points].reverse() : hop.points;
        stages.push({ points, reply, media: hop.media, length: hop.length,
          duration: hop.media === 'internet' ? Math.min(650, Math.max(160, hop.rtt ?? 30)) / 2 : 0 });
        if (hop.media === 'wireless' && random() < hop.loss) {
          return { stages, dropPoint: points.at(-1), rtt: null, reason: 'Wireless packet loss.' };
        }
      }
      if (policyDrop) {
        return { stages, dropPoint: stages.at(-1).points.at(-1), rtt: null, reason: `Router firewall rule ${policyDrop} denied the request.` };
      }
    }
    return { stages, dropPoint: null, rtt: 2 * outbound.reduce((sum, hop) => sum + latency(hop), 0) };
  }

  const model = { INTERNET, INTERNET_IP, INTERVAL, RUN_TIME, DEFAULT_SSID, DEFAULT_DHCP, isClient, managed,
    portVlans, apSsids, coverageAps, ipNumber, address, parseCidr, dhcpPool, usable, radio, build, ping };
  if (typeof module === 'object' && module.exports) module.exports = model;
  else root.WifiSiteClientModel = model;
})(globalThis);
