const assert = require('node:assert/strict');
const test = require('node:test');
const { build: cabling } = require('../static/js/wifi-cabling-model.js');
const { coverageModel } = require('../static/js/wifi-site-model.js');
const { INTERNET, INTERNET_IP, DEFAULT_SSID, DEFAULT_DHCP, coverageAps, dhcpPool, address, radio,
  build, ping, serviceId, reachableServices } =
  require('../static/js/wifi-site-client-model.js');

const eth = (count, extras = {}) => ({ prefix: 'ETH', count, media: 'ethernet', speed: 1000, ...extras });
const catalog = {
  equipment: {
    home_router: { groups: [eth(4, { speed: 100 }), eth(1, { prefix: 'WAN', speed: 100, wan: true })] },
    smart_tv: { groups: [eth(1)] }, game_console: { groups: [eth(1)] },
    smart_speaker: { groups: [] }, smart_light_switch: { groups: [] },
    router: { groups: [eth(4), eth(1, { prefix: 'WAN', wan: true })] },
    distribution_switch: { groups: [eth(24, { poe: true })], poe_budget: 200 },
    desktop: { groups: [eth(1)] }, phone: { groups: [] }, access_point: { groups: [eth(1)], poe_draw: 20 },
    poe_camera: { groups: [eth(1)], poe_draw: 12 }, voip_phone: { groups: [eth(1)], poe_draw: 7 },
    pos_terminal: { groups: [eth(1)] }, copy_machine: { groups: [eth(1)] },
    access_switch: { groups: [eth(8)] }, server: { groups: [eth(1)] },
  },
  isps: { primary: { name: 'Primary', speed: 300, media: 'ethernet', rtt_ms: 40 } },
  epsilon: .0002, crossing_tolerance: .075, pass_spacing: 6.096, pass_capacity: 10,
};
const end = (device_id, port = 'ETH1') => ({ device_id, port });
const wire = (id, source, target, waypoints = []) => ({ id, source, target, waypoints, media: 'ethernet' });

function layout() {
  return {
    band: '5', walls: [{ id: 'wall', a: { x: 0, y: 0 }, b: { x: 4, y: 0 }, material: 'drywall' }],
    pass_throughs: [], openings: [], decor: [],
    access_points: [{ id: 'ap', x: 15, y: 2, mount: 'ceiling', angle: 0, power_db: 0 }],
    equipment: [
      { id: 'router', kind: 'router', x: 5, y: 2 },
      { id: 'switch', kind: 'distribution_switch', x: 10, y: 2 },
      { id: 'isp', kind: 'demarc', isp: 'primary', wall_id: 'wall', t: .5 },
      { id: 'desktop', kind: 'desktop', x: 10, y: 7 },
      { id: 'near', kind: 'phone', x: 16, y: 2 },
      { id: 'far', kind: 'phone', x: 57, y: 2 },
    ],
    cables: [
      wire('wan', end('router', 'WAN1'), end('isp', 'ISP')),
      wire('lan', end('router'), end('switch')),
      wire('poe', end('switch', 'ETH2'), end('ap'), [{ x: 15, y: 4 }]),
      wire('desktop-link', end('switch', 'ETH3'), end('desktop')),
    ],
  };
}

function graph(plan, prior) {
  const data = cabling(plan, catalog, { bends: 40, total_bends: 6000 });
  assert.equal(data.error, '');
  return build(plan, data, coverageModel, prior);
}

test('a residential router bridges wired and Wi-Fi clients and caps both at 100 Mb/s', () => {
  const plan = layout();
  plan.access_points = [];
  const home = { id: 'home', kind: 'home_router', x: 3, y: 2, wifi_ssid: 'default' };
  plan.equipment = [home, plan.equipment.find(device => device.id === 'isp'),
    { id: 'tv', kind: 'smart_tv', x: 3, y: 3 },
    { id: 'console', kind: 'game_console', x: 4, y: 3 },
    { id: 'speaker', kind: 'smart_speaker', x: 3.5, y: 2.5 },
    { id: 'light', kind: 'smart_light_switch', wall_id: 'wall', t: .75 },
    { id: 'camera', kind: 'poe_camera', x: 3, y: 1 },
  ];
  plan.cables = [
    wire('wan', end('home', 'WAN1'), end('isp', 'ISP')),
    wire('tv-wire', end('home', 'ETH1'), end('tv')),
    wire('camera-wire', end('home', 'ETH2'), end('camera')),
  ];
  const network = graph(plan);
  for (const id of ['tv', 'console', 'speaker', 'light']) {
    const client = network.clients.get(id);
    assert.equal(client.lease.router, 'home');
    assert.equal(client.upstream.speed, 100);
    assert.equal(client.speed, 100);
    assert.equal(Boolean(client.wired), id === 'tv');
    assert.ok(ping(network, id, 'home', () => 1).rtt);
  }
  assert.equal(network.clients.get('camera').speed, 0);
  assert.ok(ping(network, 'tv', 'speaker', () => 1).rtt);
  assert.ok(ping(network, 'speaker', INTERNET, () => 1).stages.some(stage => stage.nat));

  home.firewall = [{ action: 'deny', destination_ip: INTERNET_IP }];
  assert.match(ping(graph(plan), 'light', INTERNET, () => 1).reason, /firewall/);
  assert.ok(ping(graph(plan), 'light', 'tv', () => 1).rtt);
  plan.cables.splice(1, 1);
  assert.equal(graph(plan).clients.get('tv').ap.id, 'home');
  home.wifi_ssid = '';
  assert.equal(graph(plan).clients.get('tv').speed, 0);
});

test('wired clients get DHCP, while the camera and desk phone need PoE', () => {
  const plan = layout();
  const kinds = ['poe_camera', 'voip_phone', 'pos_terminal', 'copy_machine'];
  kinds.forEach((kind, i) => {
    plan.equipment.push({ id: kind, kind, x: 9 + i, y: 6 });
    plan.cables.push(wire(kind, end('switch', `ETH${i + 4}`), end(kind)));
  });
  const limits = { bends: 40, total_bends: 6000 };
  const data = cabling(plan, catalog, limits);
  assert.equal(data.poe.get('switch').watts, 20 + 12 + 7);
  const network = build(plan, data, coverageModel);
  for (const id of kinds) {
    assert.equal(network.clients.get(id).speed, 1000);
    assert.ok(network.clients.get(id).lease);
    assert.ok(ping(network, id, 'router').rtt > 0);
  }
  const withoutPoe = { ...plan, equipment: plan.equipment.map(item =>
    item.id === 'switch' ? { ...item, kind: 'access_switch' } : item) };
  const unpowered = cabling(withoutPoe, catalog, limits);
  assert.equal(unpowered.status('poe_camera').power, 'No PoE source');
  assert.equal(unpowered.status('voip_phone').speed, 0);
  assert.equal(unpowered.status('pos_terminal').speed, 1000);
  assert.equal(unpowered.status('copy_machine').speed, 1000);
});

test('powered APs serve phones and Internet speed respects both uplink and ISP bottlenecks', () => {
  const plan = layout();
  const network = graph(plan);
  const desktop = network.clients.get('desktop'), near = network.clients.get('near'), far = network.clients.get('far');
  assert.equal(desktop.speed, 1000);
  assert.equal(desktop.upstream.speed, 300);
  assert.equal(near.ap.id, 'ap');
  assert.ok(near.signal > far.signal);
  assert.ok(near.speed > far.speed);
  assert.ok(near.loss < far.loss);
  assert.equal(far.upstream.speed, far.speed);
  assert.deepEqual(radio(-95, '5'), { speed: 0, loss: 1 });
  plan.cables = plan.cables.filter(cable => cable.id !== 'poe');
  assert.equal(graph(plan).clients.get('near').speed, 0);
});

test('ping traverses cable bends, returns in reverse, and counts request and reply Wi-Fi loss independently', () => {
  const network = graph(layout());
  const success = ping(network, 'far', 'desktop', () => 1);
  assert.equal(success.stages.length, 6);
  assert.deepEqual(success.stages[1].points, [{ x: 15, y: 2 }, { x: 15, y: 4 }, { x: 10, y: 2 }]);
  assert.deepEqual(success.stages.at(-1).points, [{ x: 15, y: 2 }, { x: 57, y: 2 }]);
  assert.deepEqual(success.stages.map(stage => stage.reply), [false, false, false, true, true, true]);
  assert.ok(success.rtt > ping(network, 'near', 'desktop', () => 1).rtt);
  assert.ok(ping(network, 'desktop', 'router').rtt > 0);
  const requestLoss = ping(network, 'far', 'desktop', () => 0);
  assert.equal(requestLoss.stages.length, 1);
  assert.deepEqual(requestLoss.dropPoint, { x: 15, y: 2 });
  const rolls = [1, 0];
  const replyLoss = ping(network, 'far', 'desktop', () => rolls.shift());
  assert.equal(replyLoss.rtt, null);
  assert.deepEqual(replyLoss.dropPoint, { x: 57, y: 2 });
});

test('Internet ping follows the physical ISP handoff and marks translated traffic in both directions', () => {
  const plan = layout(), network = graph(plan);
  const local = ping(network, 'desktop', 'router'), internet = ping(network, 'desktop', INTERNET);
  const translated = internet.stages.filter(stage => stage.nat);
  assert.deepEqual(translated.map(stage => stage.reply), [false, true]);
  assert.deepEqual(translated[0].points, [{ x: 5, y: 2 }, { x: 2, y: 0 }]);
  assert.deepEqual(translated[1].points, [...translated[0].points].reverse());
  assert.ok(internet.rtt > local.rtt + 40);
  assert.ok(local.stages.every(stage => !stage.nat));
  const transit = internet.stages.filter(stage => stage.media === 'internet');
  assert.deepEqual(transit.map(stage => stage.reply), [false, true]);
  assert.ok(transit.every(stage => !stage.points && stage.duration > 0));
  plan.cables.shift();
  assert.equal(ping(graph(plan), 'desktop', INTERNET).rtt, null);
});

test('SSID and radio filters agree with association, while switch port VLANs gate DHCP', () => {
  const plan = layout();
  plan.ssids = [DEFAULT_SSID, { id: 'guest', name: 'Guest', band: '2.4', vlan: 20 }];
  plan.access_points[0].ssid_ids = ['default', 'guest'];
  plan.equipment.find(device => device.id === 'near').ssid_id = 'guest';
  const s = plan.equipment.find(device => device.id === 'switch');
  const filtered = band => coverageAps(plan.access_points, plan.ssids, band, 'guest');
  assert.deepEqual(filtered('5'), []);
  assert.equal(filtered('2.4')[0].id, 'ap');

  let near = graph(plan).clients.get('near');
  assert.equal(near.ap.id, 'ap');
  assert.equal(near.band, '2.4');
  assert.equal(near.vlan, 20);
  assert.equal(near.lease, undefined);
  s.port_vlans = { ETH1: [0, 20], ETH2: [0, 20] };
  const routed = graph(plan);
  near = routed.clients.get('near');
  assert.equal(near.lease.router, 'router');
  assert.notEqual(near.lease.ip, routed.clients.get('desktop').lease.ip);
  assert.equal(ping(routed, 'near', 'far', () => 1).stages.length, 12);
  plan.access_points[0].ssid_ids = ['default'];
  assert.equal(graph(plan).clients.get('near').ap, undefined);
});

test('DHCP keeps connected leases, frees detached leases and retains static reservations', () => {
  const plan = layout();
  const last = plan.equipment.find(device => device.id === 'far');
  const router = plan.equipment.find(device => device.id === 'router');
  router.dhcp = { ...DEFAULT_DHCP, gateway: '192.168.0.1/29' };
  const initial = graph(plan);
  const desktop = initial.clients.get('desktop').lease;
  const near = initial.clients.get('near').lease;
  const far = initial.clients.get('far').lease;
  assert.equal(address(desktop.ip), '192.168.0.2');
  assert.equal(initial.routers.get('router').available, 2);
  last.reservation = { router_id: 'router', ip: address(far.ip) };
  last.x = 1000;
  const wire = plan.cables.pop();
  const disconnected = graph(plan, initial);
  assert.equal(disconnected.clients.get('desktop').lease, undefined);
  assert.deepEqual(disconnected.clients.get('near').lease, near);
  assert.deepEqual(disconnected.clients.get('far').lease, { ...far, static: true });
  assert.equal(disconnected.routers.get('router').available, 3);
  plan.cables.push(wire);
  const reconnected = graph(plan, disconnected);
  assert.equal(address(reconnected.clients.get('desktop').lease.ip), '192.168.0.5');
  assert.equal(reconnected.clients.get('near').lease.ip, near.ip);
  assert.equal(reconnected.clients.get('far').lease.ip, far.ip);

  delete last.reservation;
  router.dhcp.gateway = '192.168.0.2/30';
  last.x = 57;
  const exhausted = graph(plan, reconnected);
  assert.equal(address(exhausted.clients.get('desktop').lease.ip), '192.168.0.1');
  assert.equal(exhausted.routers.get('router').available, 0);
  assert.equal(exhausted.routers.get('router').unassigned, 2);
  for (const gateway of ['192.168.0.0/24', '192.168.0.255/24', '192.168.0.1/31', '127.1.0.1/24', '224.0.0.1/24']) {
    assert.equal(dhcpPool({ ...DEFAULT_DHCP, gateway }), null);
  }
});

test('first-match firewall denies or allows routed requests while same-VLAN pings stay local', () => {
  const plan = layout();
  plan.ssids = [DEFAULT_SSID, { id: 'guest', name: 'Guest', band: '5', vlan: 20 }];
  plan.access_points[0].ssid_ids = ['default', 'guest'];
  plan.equipment.find(device => device.id === 'near').ssid_id = 'guest';
  plan.equipment.find(device => device.id === 'switch').port_vlans = { ETH1: [0, 20], ETH2: [0, 20] };
  const router = plan.equipment.find(device => device.id === 'router');
  const deny = { action: 'deny', source_vlan: 20, destination_vlan: 0 };
  const denyInternet = { action: 'deny', destination_ip: INTERNET_IP };
  router.firewall = [deny, denyInternet];
  const blockedNetwork = graph(plan);
  const blocked = ping(blockedNetwork, 'near', 'desktop', () => 1);
  assert.equal(blocked.rtt, null);
  assert.equal(blocked.stages.length, 3);
  assert.deepEqual(blocked.dropPoint, { x: router.x, y: router.y });
  assert.match(blocked.reason, /firewall rule 1/);
  assert.match(ping(blockedNetwork, 'near', INTERNET, () => 1).reason, /firewall rule 2/);
  assert.ok(ping(blockedNetwork, 'far', 'desktop', () => 1).rtt > 0);
  assert.ok(ping(blockedNetwork, 'desktop', 'near', () => 1).rtt > 0); // Established reply.

  router.firewall.unshift({ action: 'allow', source_vlan: 20, destination_ip: `${address(blockedNetwork.clients.get('desktop').lease.ip)}/32` });
  const allowed = ping(graph(plan), 'near', 'desktop', () => 1);
  assert.equal(allowed.stages.length, 10);
  assert.ok(allowed.rtt > 0);
});

test('service VMs share a wired host and lease independently on their configured VLANs', () => {
  const plan = layout();
  const router = plan.equipment.find(device => device.id === 'router');
  const switchDevice = plan.equipment.find(device => device.id === 'switch');
  switchDevice.port_vlans = { ETH1: [0, 20], ETH2: [0, 20], ETH4: [0, 20] };
  plan.ssids = [DEFAULT_SSID, { id: 'guest', name: 'Guest', band: '5', vlan: 20 }];
  plan.access_points[0].ssid_ids = ['default', 'guest'];
  plan.equipment.find(device => device.id === 'near').ssid_id = 'guest';
  const host = { id: 'server', kind: 'server', x: 12, y: 5, services: [
    { kind: 'dns', vlan: 0, ip: '192.168.0.2' }, { kind: 'web', vlan: 20, ip: '' },
  ] };
  plan.equipment.push(host);
  plan.cables.push(wire('host-link', end('switch', 'ETH4'), end(host.id)));

  const dns = serviceId(host.id, 'dns'), web = serviceId(host.id, 'web');
  const serviceKinds = (network, client) => reachableServices(network, client).map(service => service.kind);
  let network = graph(plan);
  assert.equal(network.clients.get(host.id).vlan, 0);
  assert.equal(network.clients.get(web).vlan, 20);
  assert.equal(address(network.clients.get(dns).lease.ip), '192.168.0.2');
  assert.equal(network.clients.get(dns).lease.static, true);
  assert.equal(network.clients.get(web).lease.static, false);
  const addresses = [host.id, dns, web, 'desktop', 'near'].map(id => network.clients.get(id).lease.ip);
  assert.equal(new Set(addresses).size, addresses.length);
  assert.deepEqual(serviceKinds(network, 'desktop'), ['dns', 'web']);
  const pingWeb = ping(network, 'desktop', web);
  assert.ok(pingWeb.rtt > 0);
  assert.ok(pingWeb.stages.every(stage => stage.points?.length && stage.media !== 'virtual'));

  router.firewall = [{ action: 'deny', source_vlan: 20, destination_ip: '192.168.0.2' }];
  network = graph(plan, network);
  assert.deepEqual(serviceKinds(network, 'near'), ['web']);
  assert.match(ping(network, 'near', dns, () => 1).reason, /firewall rule 1/);
  assert.ok(ping(network, 'near', web, () => 1).rtt > 0);

  switchDevice.port_vlans.ETH4 = [0];
  network = graph(plan, network);
  assert.equal(network.clients.get(web).lease, undefined);
  assert.deepEqual(serviceKinds(network, 'desktop'), ['dns']);
  plan.cables.pop();
  network = graph(plan, network);
  assert.equal(network.clients.get(dns).lease, undefined);
  assert.deepEqual(serviceKinds(network, 'desktop'), []);
  assert.notEqual(address(network.clients.get('desktop').lease.ip), '192.168.0.2');
});
