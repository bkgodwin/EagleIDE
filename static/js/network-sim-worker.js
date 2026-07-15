'use strict';

let running = false;
let timer = 0;
let seed = 1337;
let randomState = seed;
let clockMs = 0;
let sequence = 0;
let speed = 1;
let profile = 'classroom';
let topology = { devices: [], links: [] };

function random() {
  randomState |= 0;
  randomState = (randomState + 0x6d2b79f5) | 0;
  let value = Math.imul(randomState ^ (randomState >>> 15), 1 | randomState);
  value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

function pick(items) { return items.length ? items[Math.floor(random() * items.length)] : null; }
function ip(device) { return device?.ip || device?.ipv6 || `SIM:${String(device?.id || '').slice(-8).toUpperCase()}`; }
function hosts() { return topology.devices.filter(device => !['switch', 'l3switch', 'wap', 'cloud'].includes(device.type)); }
function servers() { return topology.devices.filter(device => device.type === 'server'); }
function routers() { return topology.devices.filter(device => ['router', 'firewall', 'l3switch'].includes(device.type)); }
function pair() {
  const source = pick(hosts()) || pick(topology.devices);
  const reachable = new Set(source?.reachable || []);
  let destination = pick(hosts().filter(device => device.id !== source?.id && reachable.has(device.id))) || pick(topology.devices.filter(device => device.id !== source?.id && reachable.has(device.id)));
  if (!destination) destination = source;
  return [source, destination];
}
function frame(protocol, source, destination, info, options = {}) {
  return {
    number: ++sequence,
    time_ms: clockMs,
    source: source?.name || options.source || 'Unknown',
    source_id: source?.id || '',
    source_address: options.source_address || ip(source),
    destination: destination?.name || options.destination || 'Broadcast',
    destination_id: destination?.id || '',
    destination_address: options.destination_address || (destination ? ip(destination) : 'ff:ff:ff:ff:ff:ff'),
    protocol,
    length: options.length || 64 + Math.floor(random() * 900),
    info,
    layers: options.layers || { frame: 'Ethernet II', network: protocol, payload: info },
    alert: options.alert || '',
    severity: options.severity || '',
  };
}
function normalFrame(mode) {
  const [source, destination] = pair();
  const reachable = new Set(source?.reachable || []);
  const dns = pick(servers().filter(device => reachable.has(device.id) && (device.services || []).includes('dns'))) || destination;
  const router = pick(routers().filter(device => reachable.has(device.id))) || destination;
  const choices = mode === 'startup'
    ? ['arp', 'dhcp', 'dhcp', 'dns', 'icmp']
    : mode === 'busy'
      ? ['arp', 'dns', 'tcp', 'tls', 'http', 'ntp', 'icmp', 'mdns']
      : ['arp', 'dns', 'tcp', 'tls', 'http', 'icmp'];
  switch (pick(choices)) {
    case 'arp': return frame('ARP', source, null, `Who has ${ip(destination)}? Tell ${ip(source)}`, { length: 42, layers: { frame: 'Ethernet broadcast', arp: `Request for ${ip(destination)}` } });
    case 'dhcp': return frame('DHCP', source, null, pick(['DHCP Discover · transaction ID seeded', 'DHCP Request · requested address', 'DHCP ACK · lease and DNS options']), { source_address: '0.0.0.0:68', destination_address: '255.255.255.255:67', length: 342, layers: { frame: 'Ethernet broadcast', network: 'IPv4 0.0.0.0 → 255.255.255.255', transport: 'UDP 68 → 67', application: 'BOOTP / DHCP' } });
    case 'dns': return frame('DNS', source, dns, pick(['Standard query A wiki.school.test', 'Standard query AAAA wiki.school.test', 'Standard query response A 192.0.2.80']), { destination_address: `${ip(dns)}:53`, layers: { network: 'IPv4 / IPv6', transport: 'UDP 53', application: 'Domain Name System' } });
    case 'tcp': return frame('TCP', source, destination, pick(['SYN', 'SYN, ACK', 'ACK', 'PSH, ACK']), { destination_address: `${ip(destination)}:${pick([22, 80, 443, 8000])}`, layers: { network: 'IPv4', transport: 'TCP flags and sequence numbers', application: 'Connection setup or data' } });
    case 'tls': return frame('TLS', source, destination, pick(['Client Hello · TLS 1.3', 'Server Hello · TLS 1.3', 'Application Data']), { destination_address: `${ip(destination)}:443`, length: 512, layers: { network: 'IPv4', transport: 'TCP 443', application: 'TLS 1.3 encrypted record' } });
    case 'http': return frame('HTTP', source, destination, pick(['GET / HTTP/1.1', 'HTTP/1.1 200 OK', 'GET /assets/app.css HTTP/1.1']), { destination_address: `${ip(destination)}:80`, layers: { network: 'IPv4', transport: 'TCP 80', application: 'Hypertext Transfer Protocol' } });
    case 'ntp': return frame('NTP', source, router, 'Client request · synchronize clock', { destination_address: `${ip(router)}:123`, length: 90, layers: { network: 'IPv4', transport: 'UDP 123', application: 'Network Time Protocol' } });
    case 'mdns': return frame('mDNS', source, null, 'Standard query PTR _services._dns-sd._udp.local', { destination_address: '224.0.0.251:5353', length: 110 });
    default: return frame('ICMP', source, destination, pick(['Echo request', 'Echo reply', 'Time exceeded']), { length: 98, layers: { network: 'IPv4', control: 'Internet Control Message Protocol' } });
  }
}
function attackFrame(mode) {
  const [source, destination] = pair();
  const victim = destination || source;
  const gateway = pick(routers()) || victim;
  if (mode === 'rogue-dhcp') return frame('DHCP', source, null, 'Unauthorized DHCP Offer · gateway 10.66.6.1 · DNS 10.66.6.53', { source_address: `${ip(source)}:67`, destination_address: '255.255.255.255:68', length: 342, alert: 'Rogue DHCP server behavior detected', severity: 'high', layers: { frame: 'Broadcast', transport: 'UDP 67 → 68', application: 'DHCP Offer with untrusted server identifier' } });
  if (mode === 'arp-spoof') return frame('ARP', source, victim, `${ip(gateway)} is-at SIM:${String(source?.id || '').slice(-8).toUpperCase()}`, { length: 42, alert: 'Possible ARP cache poisoning', severity: 'high', layers: { frame: 'Unsolicited ARP reply', arp: `Gateway address ${ip(gateway)} claimed by ${source?.name}` } });
  if (mode === 'dns-poison') return frame('DNS', source, victim, 'Forged response · portal.school.test A 10.66.6.66', { source_address: `${ip(source)}:53`, destination_address: `${ip(victim)}:${53000 + Math.floor(random() * 1000)}`, alert: 'Unsolicited or conflicting DNS answer', severity: 'high', layers: { network: 'IPv4', transport: 'UDP 53', application: 'DNS answer with unexpected source/transaction' } });
  if (mode === 'port-scan') return frame('TCP', source, victim, `SYN · destination port ${pick([21,22,23,25,53,80,110,135,139,443,445,3389,8000])}`, { length: 60, alert: 'Horizontal/vertical port scan pattern', severity: 'medium', layers: { network: 'IPv4', transport: 'TCP SYN without completed handshake', detection: 'Multiple destination ports in a short interval' } });
  return frame('TCP', source, victim, `SYN flood · sequence ${Math.floor(random() * 0xffffffff).toString(16)}`, { length: 60, alert: 'SYN flood threshold exceeded', severity: 'critical', layers: { network: 'IPv4', transport: 'High-rate TCP SYN', detection: 'Incomplete connection rate exceeds baseline' } });
}
function createBatch() {
  clockMs += Math.round(250 / Math.max(.25, speed));
  const attack = ['rogue-dhcp', 'arp-spoof', 'dns-poison', 'port-scan', 'syn-flood'].includes(profile);
  const count = attack ? 2 + Math.floor(random() * 3) : 1 + (profile === 'busy' ? Math.floor(random() * 3) : 0);
  const frames = Array.from({ length: count }, (_, index) => attack && index === 0 ? attackFrame(profile) : normalFrame(profile === 'startup' ? 'startup' : profile === 'busy' ? 'busy' : 'classroom')).filter(Boolean);
  postMessage({ type: 'frames', frames, clock_ms: clockMs, seed, profile });
}
function stop() { running = false; clearInterval(timer); timer = 0; }
function start() {
  stop(); running = true;
  timer = setInterval(createBatch, Math.max(70, 500 / Math.max(.25, speed)));
}

self.onmessage = event => {
  const message = event.data || {};
  if (message.type === 'init') {
    topology = message.topology || topology;
    seed = Math.max(1, Number(message.seed) || 1337);
    randomState = seed; profile = message.profile || 'classroom'; speed = Math.max(.25, Math.min(4, Number(message.speed) || 1));
    if (message.reset !== false) { clockMs = 0; sequence = 0; }
    postMessage({ type: 'ready', seed, profile, clock_ms: clockMs });
  } else if (message.type === 'topology') topology = message.topology || topology;
  else if (message.type === 'settings') { profile = message.profile || profile; speed = Math.max(.25, Math.min(4, Number(message.speed) || speed)); if (running) start(); }
  else if (message.type === 'start') start();
  else if (message.type === 'stop') stop();
  else if (message.type === 'step') createBatch();
  else if (message.type === 'reset') { stop(); randomState = seed; clockMs = 0; sequence = 0; postMessage({ type: 'ready', seed, profile, clock_ms: clockMs }); }
};
