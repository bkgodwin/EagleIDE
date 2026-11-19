/* Association, DHCP, and simulated packet routes for Infra Sim. */
(function (root) {
  'use strict';

  const INTERNET = ':internet';
  const INTERNET_IP = '203.0.113.10'; // A documentation address for the simulated google.com target.
  const INTERVAL = 500;
  const RUN_TIME = 60_000;
  const DEFAULT_SSID = { id: 'default', name: 'Default', band: 'both', vlan: 0 };
  const DEFAULT_DHCP = { gateway: '192.168.0.1/24', dns: '1.1.1.1', fallback_dns: '8.8.8.8' };
  const { CLIENTS, WIRELESS_CLIENTS, isRouter } = typeof module === 'object' && module.exports ? require('./wifi-cabling-model.js') : root.WifiCablingModel;
  const isClient = device => CLIENTS.has(device?.kind);
  const wirelessClient = device => WIRELESS_CLIENTS.has(device?.kind);
  const clientSsid = (device, ssids) => device.ssid_id ? ssids.find(ssid => ssid.id === device.ssid_id) : ssids[0];
  const managed = device => ['core_switch', 'distribution_switch'].includes(device.kind);
  const portVlans = (device, port) => device.port_vlans?.[port] ?? [0];
  const serviceId = (hostId, kind) => `:vm:${hostId}:${kind}`;
  const apSsids = (ap, ssids) => ap.ssid_ids ?? ssids.slice(0, 1).map(ssid => ssid.id);
  const rateLimit = value => value > 0 ? value : Infinity;
  const routedLimit = (device, vlan) => rateLimit(device.vlan_limits?.[vlan]);
  const hasBand = (ssid, band) => ssid.band === 'both' || ssid.band === band;

  function radioSources(plan, cables, preview = '') {
    const accessPoints = plan.access_points.filter(ap => cables.poweredAps.has(ap.id) || ap.id === preview);
    const defaultSsid = (plan.ssids ?? [DEFAULT_SSID]).find(ssid => ssid.vlan === 0)?.id;
    for (const device of plan.equipment ?? []) {
      if (device.kind !== 'home_router') continue;
      const ssid = device.wifi_ssid ?? defaultSsid;
      const linkLimit = cables.ports.get(device.id).find(port => !port.wan).speed;
      accessPoints.push({ ...device, ...cables.location(device), mount: 'table', angle: 0, power_db: 0,
        ssid_ids: ssid ? [ssid] : [], linkLimit });
    }
    return accessPoints;
  }

  function coverageAps(accessPoints, ssids, band, filter = '', includeInterferers = false) {
    const enabled = new Set(ssids.filter(ssid => hasBand(ssid, band)).map(ssid => ssid.id));
    return accessPoints.flatMap(ap => {
      const ids = apSsids(ap, ssids);
      if (ids.some(id => enabled.has(id) && (!filter || id === filter))) return [ap];
      return includeInterferers && ids.some(id => enabled.has(id)) ? [{ ...ap, interfererOnly: true }] : [];
    });
  }

  function ipNumber(value) {
    if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) return null;
    const octets = value.split('.').map(Number);
    return octets.some(octet => octet > 255) ? null : octets.reduce((ip, octet) => ip * 256 + octet, 0);
  }

  const address = ip => [24, 16, 8, 0].map(shift => (ip >>> shift) & 255).join('.');

  function serviceAddress(value) {
    const ip = ipNumber(value);
    const first = ip >>> 24;
    return first > 0 && first < 224 && first !== 127 ? ip : null;
  }

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

  function radio(signal, band, width = 20) {
    if (signal < -90) return { speed: 0, loss: 1 };
    const quality = Math.min(1, (signal + 90) / 40);
    const peak = band === '2.4' ? 200 : 240 * (width / 20) ** .75;
    return { speed: Math.max(1, Math.round(peak * quality ** 2)), loss: 0.85 * (1 - quality) ** 3 };
  }

  function wiredVlan(network, id) {
    // The first managed switch port sets the client's untagged access VLAN.
    // Keystone jacks and the unmanaged switch carry the access segment.
    const visited = new Set([id]), queue = [id];
    for (const node of queue) {
      for (const link of network.links.get(node)) {
        if (link.wan || link.media === 'wireless' || visited.has(link.to)) continue;
        visited.add(link.to);
        const peer = network.devices.get(link.to);
        if (managed(peer)) return portVlans(peer, link.toPort)[0] ?? null;
        if (isRouter(peer)) return 0;
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
      if (id !== from && (network.clients.has(id) || device.kind === 'router')) continue;
      for (const hop of network.links.get(id)) {
        if (hop.wan || visited.has(hop.to)) continue;
        const peer = network.devices.get(hop.to);
        const endpoint = network.clients.get(hop.to);
        if ((managed(device) && !portVlans(device, hop.fromPort).includes(vlan)) ||
            (managed(peer) && !portVlans(peer, hop.toPort).includes(vlan)) ||
            (hop.media === 'wireless' && hop.vlan !== vlan) ||
            (peer.kind === 'home_router' && vlan !== 0) ||
            (endpoint && endpoint.vlan !== vlan)) continue;
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
    return [...hops].reverse().map(hop => ({ ...hop, points: hop.points && [...hop.points].reverse() }));
  }

  function attachServices(network) {
    const hosts = [...network.devices.values()].filter(device => device.kind === 'server' && device.services?.length);
    if (!hosts.length) return;
    const bridges = new Map(hosts.map(host => [host.id, `:bridge:${host.id}`]));
    network.devices = new Map(network.devices);
    // The host and guests share a virtual switch on the physical NIC. They remain separate VLAN endpoints.
    network.links = new Map([...network.links].map(([id, hops]) => [bridges.get(id) ?? id, hops.map(hop =>
      bridges.has(hop.to) ? { ...hop, to: bridges.get(hop.to) } : hop)]));
    for (const host of hosts) {
      const bridge = bridges.get(host.id);
      const { speed } = network.clients.get(host.id);
      const hop = { media: 'virtual', length: 0, speed };
      const attach = id => {
        network.links.set(id, [{ ...hop, to: bridge }]);
        network.links.get(bridge).push({ ...hop, to: id });
      };
      network.devices.set(bridge, { id: bridge, kind: 'vm_bridge', hostId: host.id });
      attach(host.id);
      for (const service of host.services) {
        const id = serviceId(host.id, service.kind);
        network.services.set(id, { ...service, id, hostId: host.id, bridge });
        network.devices.set(id, { id, kind: 'service_vm', hostId: host.id });
        network.clients.set(id, { speed, vlan: service.vlan });
        attach(id);
      }
    }
  }

  function leaseClients(network, prior) {
    const { clients, devices, routers, services } = network;
    const occupied = new Map([...routers.keys()].map(id => [id, new Set()]));
    const bridgePaths = new Map();
    // Keep configured VM addresses out of compatible DHCP pools, even while a guest is disconnected.
    for (const service of services.values()) {
      if (!service.ip) continue;
      const ip = serviceAddress(service.ip);
      for (const router of routers.values()) {
        if (usable(router.pool, ip)) occupied.get(router.id).add(ip);
      }
    }
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
      const guest = services.get(id);
      if (guest) {
        // Guests on the same bridge and VLAN differ only by a local virtual hop.
        const key = `${guest.bridge}:${client.vlan}`;
        if (!bridgePaths.has(key)) bridgePaths.set(key, lanPaths(network, guest.bridge, client.vlan));
        client.paths = bridgePaths.get(key);
      } else {
        client.paths = lanPaths(network, id, client.vlan);
      }
      if (client.lease) {
        if (client.paths.has(client.lease.router)) client.router = routers.get(client.lease.router);
        continue;
      }
      const staticIp = guest?.ip ? serviceAddress(guest.ip) : null;
      const router = [...client.paths.keys()].map(peer => routers.get(peer))
        .find(candidate => candidate && (!guest?.ip || usable(candidate.pool, staticIp)));
      if (!router) continue;
      client.router = router;
      if (guest?.ip) {
        client.lease = { ip: staticIp, router: router.id, static: true };
        continue;
      }
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
    const { devices, location, activeLinks } = cables;
    const links = new Map([...activeLinks].map(([id, edges]) => [id, edges.map(hop => ({
      ...hop, speed: Math.min(hop.speed, rateLimit(devices.get(id).port_limits?.[hop.fromPort]),
        rateLimit(devices.get(hop.to).port_limits?.[hop.toPort])),
    }))]));
    const accessPoints = radioSources(plan, cables);
    const ssids = plan.ssids ?? [DEFAULT_SSID];
    const surveys = new Map();
    const clients = new Map(), routers = new Map();
    const network = { devices, links, clients, routers, services: new Map(),
      location: device => location(device?.hostId ? devices.get(device.hostId) : device) };
    for (const device of devices.values()) {
      if (isRouter(device)) {
        const pool = dhcpPool(device.dhcp ?? DEFAULT_DHCP);
        const { isp } = cables.status(device.id);
        routers.set(device.id, { id: device.id, pool, isp, waiting: [], unassigned: 0 });
      }
      if (!isClient(device)) continue;
      const cableSpeed = cables.status(device.id).speed;
      if (cableSpeed || !wirelessClient(device)) {
        clients.set(device.id, { speed: cableSpeed, wired: Boolean(cableSpeed), vlan: wiredVlan(network, device.id) });
        continue;
      }
      const ssid = clientSsid(device, ssids);
      let best = { speed: 0 };
      if (ssid) {
        if (!surveys.has(ssid.id)) {
          surveys.set(ssid.id, ['5', '2.4'].filter(band => hasBand(ssid, band)).map(band => ({
            band, estimate: coverageModel(plan.walls, coverageAps(accessPoints, ssids, band, ssid.id, true),
              band, plan.openings, plan.decor),
          })));
        }
        for (const { band, estimate } of surveys.get(ssid.id)) {
          const result = estimate(location(device), true);
          if (!result) continue;
          const link = radio(result.signal, band, result.ap.radios?.[band]?.width);
          const speed = Math.min(link.speed, result.ap.linkLimit ?? Infinity);
          if (speed > best.speed || (speed === best.speed && result.signal > (best.signal ?? -Infinity))) {
            best = { speed, loss: link.loss, band, signal: result.signal, ap: speed ? result.ap : null, distance: result.distance };
          }
        }
      }
      best.speed = Math.min(best.speed, rateLimit(best.ap?.ssid_limits?.[ssid?.id]));
      clients.set(device.id, { ...best, vlan: ssid?.vlan ?? null });
      if (!best.ap) continue;
      const points = [location(device), location(best.ap)];
      const link = { media: 'wireless', length: best.distance, speed: best.speed, signal: best.signal, loss: best.loss, vlan: ssid.vlan };
      links.get(device.id).push({ ...link, to: best.ap.id, points });
      links.get(best.ap.id).push({ ...link, to: device.id, points: [...points].reverse() });
    }
    attachServices(network);
    leaseClients(network, prior);
    for (const client of clients.values()) {
      if (!client.lease || !client.router) continue;
      const route = path(client.paths, client.router.id);
      client.speed = Math.min(client.speed, ...route.map(hop => hop.speed));
      if (client.router.isp) {
        const isp = client.router.isp;
        client.upstream = { ...isp, speed: Math.min(isp.speed, client.speed,
          routedLimit(devices.get(client.router.id), client.vlan)) };
      }
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
    if (hop.media === 'virtual') return 0;
    if (hop.media === 'internet') return hop.rtt / 2;
    if (hop.media === 'wireless') return 1.4 + hop.length * .027 + Math.max(0, -hop.signal - 50) * .12;
    return (hop.media === 'fiber' ? .16 : .35) + hop.length * .003;
  }

  function clientRoute(network, source, target) {
    const destination = network.clients.get(target);
    if (!destination?.speed || !destination.lease) return {};
    if (source.vlan === destination.vlan) return { outbound: path(source.paths, target) };
    const router = source.router;
    const returnPath = path(destination.paths, router?.id);
    if (!returnPath) return {};
    const outbound = path(source.paths, router.id);
    const policyDrop = firewall(network.devices.get(router.id), { vlan: source.vlan, ip: source.lease.ip },
      { vlan: destination.vlan, ip: destination.lease.ip });
    if (!policyDrop) outbound.push(...reversePath(returnPath));
    return { outbound, policyDrop };
  }

  function routeSpeed(network, source, target, outbound) {
    const destination = network.clients.get(target);
    const caps = [source.speed, ...outbound.map(hop => hop.speed ?? Infinity)];
    if (target === INTERNET) caps.push(source.upstream?.speed ?? 0);
    if (destination) {
      caps.push(destination.speed);
      if (source.vlan !== destination.vlan) {
        const router = network.devices.get(source.router.id);
        caps.push(routedLimit(router, source.vlan), routedLimit(router, destination.vlan));
      }
    }
    return Math.min(...caps);
  }

  function reachableServices(network, from) {
    const source = network.clients.get(from);
    if (!source?.speed || !source.lease) return [];
    return [...network.services.values()].filter(service => {
      const { outbound, policyDrop } = clientRoute(network, source, service.id);
      return service.id !== from && outbound?.length && !policyDrop;
    });
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
      ({ outbound, policyDrop } = clientRoute(network, source, target));
    } else if (target === INTERNET && source.upstream) {
      outbound = path(source.paths, router.id);
      policyDrop = firewall(network.devices.get(router.id), { vlan: source.vlan, ip: source.lease.ip },
        { vlan: null, ip: ipNumber(INTERNET_IP) });
      if (!policyDrop) {
        const wan = network.links.get(router.id)?.find(hop => hop.wan && hop.to === source.upstream.id);
        if (wan) outbound.push({ ...wan, nat: true });
        outbound.push({ media: 'internet', rtt: source.upstream.rtt ?? 30 });
      }
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
        if (hop.media === 'virtual') continue;
        const points = reply && hop.points ? [...hop.points].reverse() : hop.points;
        stages.push({ points, reply, media: hop.media, length: hop.length, nat: Boolean(hop.nat),
          duration: hop.media === 'internet' ? Math.min(650, Math.max(160, hop.rtt ?? 30)) / 2 : 0 });
        if (hop.media === 'wireless' && random() < hop.loss) {
          return { stages, dropPoint: points.at(-1), rtt: null, reason: 'Wireless packet loss.' };
        }
      }
      if (policyDrop) {
        return { stages, dropPoint: stages.at(-1).points.at(-1), rtt: null, reason: `Router firewall rule ${policyDrop} denied the request.` };
      }
    }
    return { stages, dropPoint: null, bandwidth: routeSpeed(network, source, target, outbound), rtt: 2 * outbound.reduce((sum, hop) => sum + latency(hop), 0) };
  }

  const model = { INTERNET, INTERNET_IP, INTERVAL, RUN_TIME, DEFAULT_SSID, DEFAULT_DHCP, isClient, isRouter, wirelessClient, clientSsid, radioSources, managed,
    portVlans, apSsids, coverageAps, ipNumber, address, serviceAddress, serviceId, reachableServices,
    parseCidr, dhcpPool, usable, radio, build, ping };
  if (typeof module === 'object' && module.exports) module.exports = model;
  else root.WifiSiteClientModel = model;
})(globalThis);
