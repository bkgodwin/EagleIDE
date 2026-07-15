(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const DEVICE_TYPES = [
    ['pc', '🖥️', 'PC'], ['laptop', '💻', 'Laptop'], ['phone', '📱', 'Phone'],
    ['server', '▣', 'Server'], ['switch', '⇄', 'Layer 2 Switch'], ['l3switch', '⤢', 'Layer 3 Switch'], ['router', '⬡', 'Router'],
    ['firewall', '🛡️', 'Firewall'], ['wap', '⌁', 'Wireless AP'], ['cloud', '☁️', 'Cloud'],
  ];
  const ICONS = Object.fromEntries(DEVICE_TYPES.map(item => [item[0], item[1]]));
  const LABELS = Object.fromEntries(DEVICE_TYPES.map(item => [item[0], item[2]]));
  const SERVICES = ['http', 'https', 'dns', 'dhcp', 'ssh'];
  const DHCP_CLIENT_TYPES = new Set(['pc', 'laptop', 'phone', 'server']);
  const DEVICE_PORTS = {
    pc: ['LAN1'], laptop: ['LAN1'], phone: [], server: ['LAN1', 'LAN2', 'LAN3', 'LAN4'],
    switch: ['Eth1', 'Eth2', 'Eth3', 'Eth4', 'Eth5', 'Eth6', 'Eth7', 'Eth8'],
    l3switch: ['Eth1', 'Eth2', 'Eth3', 'Eth4', 'Eth5', 'Eth6', 'Eth7', 'Eth8'],
    router: ['WAN', 'LAN1', 'LAN2', 'LAN3', 'LAN4'], firewall: ['WAN', 'LAN', 'DMZ', 'OPT1'],
    wap: ['LAN1'], cloud: ['WAN1', 'WAN2', 'WAN3', 'WAN4'],
  };
  const PORT_CAPABILITIES = {
    pc: { LAN1: ['ethernet'] }, laptop: { LAN1: ['ethernet'] }, phone: {},
    server: { LAN1: ['ethernet'], LAN2: ['ethernet'], LAN3: ['ethernet', 'fiber'], LAN4: ['ethernet', 'fiber'] },
    switch: { Eth1: ['ethernet'], Eth2: ['ethernet'], Eth3: ['ethernet'], Eth4: ['ethernet'], Eth5: ['ethernet'], Eth6: ['ethernet'], Eth7: ['ethernet', 'fiber'], Eth8: ['ethernet', 'fiber'] },
    l3switch: { Eth1: ['ethernet'], Eth2: ['ethernet'], Eth3: ['ethernet'], Eth4: ['ethernet'], Eth5: ['ethernet'], Eth6: ['ethernet'], Eth7: ['ethernet', 'fiber'], Eth8: ['ethernet', 'fiber'] },
    router: { WAN: ['ethernet', 'fiber', 'serial'], LAN1: ['ethernet'], LAN2: ['ethernet'], LAN3: ['ethernet', 'fiber'], LAN4: ['ethernet', 'serial'] },
    firewall: { WAN: ['ethernet', 'fiber'], LAN: ['ethernet'], DMZ: ['ethernet'], OPT1: ['ethernet', 'fiber'] },
    wap: { LAN1: ['ethernet'] },
    cloud: { WAN1: ['ethernet', 'fiber'], WAN2: ['ethernet', 'fiber'], WAN3: ['fiber', 'serial'], WAN4: ['fiber', 'serial'] },
  };
  const PORT_SPEEDS = ['1.544 Mbps', '10 Mbps', '100 Mbps', '1 Gbps', '10 Gbps', '40 Gbps'];
  const MEDIA_SPEEDS = {
    serial: ['1.544 Mbps'],
    ethernet: ['10 Mbps', '100 Mbps', '1 Gbps', '10 Gbps'],
    fiber: ['1 Gbps', '10 Gbps', '40 Gbps'],
  };
  const COMMON_MASKS = ['255.255.255.252', '255.255.255.248', '255.255.255.240', '255.255.255.224', '255.255.255.192', '255.255.255.128', '255.255.255.0', '255.255.254.0', '255.255.252.0', '255.255.248.0', '255.255.240.0', '255.255.0.0', '255.0.0.0'];
  const COMMON_VLANS = [1, 10, 20, 30, 40, 50, 99, 100, 200, 999];
  const COMMON_PORTS = [22, 53, 67, 68, 80, 123, 443, 3389, 8000, 8080];
  const LEASE_MINUTES = [30, 60, 120, 240, 480, 720, 1440, 10080];
  const DNS_TTLS = [30, 60, 300, 600, 1800, 3600, 86400];
  const LIMITS = { devices: 100, links: 200 };
  const state = {
    bootstrap: null,
    bootstrapKey: '',
    bootstrapPromise: null,
    bootstrapPromiseKey: '',
    topology: null,
    selectedId: '',
    selectedLinkId: '',
    connectMode: false,
    connectSource: '',
    connectSourcePort: '',
    connectKind: '',
    zoom: 1,
    undo: [],
    redo: [],
    events: [],
    lastPacket: null,
    lab: null,
    labClassId: '',
    grade: null,
    mode: 'personal',
    saveTimer: 0,
    savedOnce: false,
    initialized: false,
    teacherClassId: '',
    packetStep: -1,
    packetTimer: 0,
    dnsCache: new Map(),
    objectiveActions: new Set(),
    packetSequence: 0,
    topologyRevision: 0,
    stpCacheRevision: -1,
    stpCache: null,
    graphCacheRevision: -1,
    graphCache: null,
    saveInFlight: false,
    saveQueued: false,
    labSaveInFlight: false,
    labSaveQueued: false,
  };

  function context() { return window.EagleIDE?.getContext?.() || {}; }
  function authHeaders(json = false) {
    const ctx = context();
    const headers = json ? { 'Content-Type': 'application/json' } : {};
    if (ctx.USER_TOKEN) headers['X-User-Token'] = ctx.USER_TOKEN;
    if (ctx.TEACHER_TOKEN) headers['X-Teacher-Token'] = ctx.TEACHER_TOKEN;
    if (ctx.ADMIN_TOKEN) headers['X-Admin-Token'] = ctx.ADMIN_TOKEN;
    return headers;
  }
  function currentAuthKey() {
    const ctx = context();
    if (ctx.ADMIN_TOKEN) return `admin:${ctx.ADMIN_TOKEN}`;
    if (ctx.TEACHER_TOKEN) return `teacher:${ctx.TEACHER_TOKEN}`;
    if (ctx.USER_TOKEN) return `student:${ctx.USER_TOKEN}`;
    return 'guest';
  }
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  }
  async function api(url, options = {}) {
    options.headers = { ...authHeaders(!!options.body), ...(options.headers || {}) };
    const response = await fetch(url, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
      const error = new Error(payload?.error || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return payload.data;
  }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function makeId(prefix) { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
  function clearTopologyCaches() {
    state.stpCacheRevision = -1; state.stpCache = null;
    state.graphCacheRevision = -1; state.graphCache = null;
  }
  function invalidateTopology() { state.topologyRevision += 1; clearTopologyCaches(); }
  function deviceById(id) { return state.topology?.devices?.find(item => item.id === id) || null; }
  function selectedDevice() { return deviceById(state.selectedId); }
  function selectedLink() { return state.topology?.links?.find(item => item.id === state.selectedLinkId) || null; }
  function setStatus(text, kind = '') {
    const el = $('networkSaveState');
    if (!el) return;
    el.textContent = text || '';
    el.dataset.kind = kind;
  }
  function logEvent(message) {
    state.events.unshift({ at: new Date(), message: String(message) });
    state.events = state.events.slice(0, 80);
    renderEvents();
  }

  function blankTopology() {
    return {
      schema_version: 2,
      id: makeId('network'),
      title: 'Untitled Network',
      description: '',
      category: 'My Networks',
      devices: [], links: [], metadata: {},
    };
  }
  function defaultConfig(type) {
    const automatic = ['pc', 'laptop', 'phone'].includes(type);
    const ports = Object.fromEntries((DEVICE_PORTS[type] || []).map(name => [name, { enabled: true, speed: '1 Gbps', auto_negotiate: true }]));
    const base = { ip: '', mask: '255.255.255.0', gateway: '', dns_servers: [], vlan: 1, enabled: true, addressing_mode: automatic ? 'dhcp' : 'static', dhcp: automatic, ports, ipv6_mode: 'disabled', ipv6_address: '', ipv6_prefix: 64, ipv6_gateway: '', ipv6_dns_servers: [] };
    if (['router', 'firewall', 'l3switch'].includes(type)) Object.assign(base, { interfaces: [], routes: [] });
    if (type === 'router') Object.assign(base, { addressing_mode: 'static', dhcp: false, dhcp_enabled: false, dhcp_interface: 'LAN1', dhcp_start: '', dhcp_end: '', dhcp_mask: '255.255.255.0', dhcp_gateway: '', dhcp_dns_primary: '', dhcp_dns_secondary: '', dhcp_domain: '', dhcp_lease_minutes: 480, dhcp_vlan: 1, wan_mode: 'dhcp', wan_ip: '', wan_mask: '255.255.255.0', wan_gateway: '', wan_dns_servers: [], wan_state: 'disconnected', nat_enabled: true, nat_mode: 'pat', routing_protocol: 'static', router_id: '', acl_rules: [], acl_default_deny: false, port_forwards: [] });
    if (type === 'firewall') Object.assign(base, { firewall_rules: [], stateful: true, port_forwards: [] });
    if (['switch', 'l3switch'].includes(type)) Object.assign(base, { vlans: [1], trunk_ports: [], trunk_vlans: [], port_vlans: {}, stp_enabled: true, stp_priority: 32768 });
    if (type === 'l3switch') Object.assign(base, { ip_routing: true, routing_protocol: 'static', router_id: '', svis: [], acl_rules: [], acl_default_deny: false });
    if (type === 'server') Object.assign(base, { services: [], dns_records: [], dns_forwarders: [], dns_recursion: true, server_interfaces: Object.fromEntries(DEVICE_PORTS.server.map(name => [name, { ip: '', mask: '255.255.255.0' }])) });
    if (type === 'wap') Object.assign(base, { ssid: 'Eagle-Lab', wifi_password: '', security: 'WPA2', band: 'dual', channel: 6, range: 280, stp_enabled: true, stp_priority: 32768 });
    if (['laptop', 'phone'].includes(type)) Object.assign(base, { ssid: '', wifi_password: '', wifi_band: 'auto' });
    if (type === 'cloud') Object.assign(base, { isp_dhcp_enabled: true, isp_dhcp_start: '203.0.113.100', isp_dhcp_end: '203.0.113.199', isp_mask: '255.255.255.0', isp_gateway: '203.0.113.1', isp_dns_primary: '198.51.100.53', isp_dns_secondary: '198.51.100.54', isp_lease_minutes: 1440 });
    return base;
  }
  function normalizeAclRule(rule = {}) {
    return {
      action: String(rule.action || 'deny').toLowerCase() === 'allow' ? 'allow' : 'deny',
      protocol: ['any', 'icmp', 'tcp', 'udp'].includes(String(rule.protocol || '').toLowerCase()) ? String(rule.protocol).toLowerCase() : 'any',
      source: String(rule.source || 'any').trim() || 'any',
      destination: String(rule.destination || 'any').trim() || 'any',
      port: Math.max(-1, Math.min(65535, Number(rule.port) || -1)),
      interface: String(rule.interface || 'any'),
      direction: ['in', 'out', 'both'].includes(String(rule.direction || '').toLowerCase()) ? String(rule.direction).toLowerCase() : 'both',
    };
  }
  function normalizeDeviceConfig(device) {
    const raw = device?.config && typeof device.config === 'object' ? device.config : {};
    const config = { ...defaultConfig(device?.type), ...raw };
    config.dns_servers = Array.isArray(config.dns_servers) ? config.dns_servers.filter(Boolean).slice(0, 4) : [];
    config.wan_dns_servers = Array.isArray(config.wan_dns_servers) ? config.wan_dns_servers.filter(Boolean).slice(0, 4) : [];
    config.dns_forwarders = Array.isArray(config.dns_forwarders) ? config.dns_forwarders.filter(Boolean).slice(0, 8) : [];
    config.dns_records = Array.isArray(config.dns_records) ? config.dns_records.filter(item => item && typeof item === 'object').slice(0, 100).map(item => ({ name: String(item.name || '').toLowerCase(), type: ['A', 'CNAME', 'NS'].includes(String(item.type || '').toUpperCase()) ? String(item.type).toUpperCase() : 'A', value: String(item.value || ''), ttl: Math.max(30, Math.min(86400, Number(item.ttl) || 300)) })) : [];
    config.trunk_ports = Array.isArray(config.trunk_ports) ? config.trunk_ports.filter(port => (DEVICE_PORTS[device?.type] || []).includes(port)).slice(0, 8) : [];
    if (['router', 'l3switch'].includes(device?.type)) config.acl_rules = Array.isArray(config.acl_rules) ? config.acl_rules.filter(item => item && typeof item === 'object').slice(0, 50).map(normalizeAclRule) : [];
    if (device?.type === 'l3switch') config.svis = Array.isArray(config.svis) ? config.svis.filter(item => item && typeof item === 'object').slice(0, 32).map(item => ({ vlan: Math.max(1, Math.min(4094, Number(item.vlan) || 1)), ip: String(item.ip || ''), mask: String(item.mask || '255.255.255.0') })) : [];
    config.ports = Object.fromEntries((DEVICE_PORTS[device?.type] || []).map(name => {
      const saved = raw.ports?.[name] || {};
      return [name, { enabled: saved.enabled !== false, speed: PORT_SPEEDS.includes(saved.speed) ? saved.speed : '1 Gbps', auto_negotiate: saved.auto_negotiate !== false }];
    }));
    if (DHCP_CLIENT_TYPES.has(device?.type)) {
      const explicitMode = raw.addressing_mode === 'dhcp' || raw.addressing_mode === 'static' ? raw.addressing_mode : '';
      const newDeviceDefault = ['pc', 'laptop', 'phone'].includes(device?.type) ? 'dhcp' : 'static';
      config.addressing_mode = explicitMode || (raw.dhcp === true ? 'dhcp' : (raw.dhcp === false || raw.ip ? 'static' : newDeviceDefault));
      config.dhcp = config.addressing_mode === 'dhcp';
    }
    if (device?.type === 'server') {
      const savedInterfaces = raw.server_interfaces && typeof raw.server_interfaces === 'object' ? raw.server_interfaces : {};
      config.server_interfaces = Object.fromEntries(DEVICE_PORTS.server.map((name, index) => {
        const saved = savedInterfaces[name] && typeof savedInterfaces[name] === 'object' ? savedInterfaces[name] : {};
        const legacyIp = index === 0 && !Object.keys(savedInterfaces).length ? raw.ip : '';
        const legacyMask = index === 0 && !Object.keys(savedInterfaces).length ? raw.mask : '';
        return [name, { ip: String(saved.ip || legacyIp || ''), mask: String(saved.mask || legacyMask || '255.255.255.0') }];
      }));
      config.ip = config.server_interfaces.LAN1.ip;
      config.mask = config.server_interfaces.LAN1.mask;
      config.addressing_mode = 'static';
      config.dhcp = false;
    }
    if (device?.type === 'router') {
      const byName = new Map((Array.isArray(raw.interfaces) ? raw.interfaces : []).filter(item => item && typeof item === 'object').map(item => [String(item.name || '').toUpperCase(), item]));
      if (!byName.size && raw.ip) byName.set('LAN1', { name: 'LAN1', ip: raw.ip, mask: raw.mask, vlan: raw.vlan });
      const physicalInterfaces = DEVICE_PORTS.router.filter(name => name !== 'WAN').map(name => {
        const saved = byName.get(name) || {};
        return { name, ip: String(saved.ip || ''), mask: String(saved.mask || '255.255.255.0'), vlan: Math.max(1, Math.min(4094, Number(saved.vlan) || 1)) };
      });
      const virtualInterfaces = (Array.isArray(raw.interfaces) ? raw.interfaces : []).filter(item => item && typeof item === 'object' && !DEVICE_PORTS.router.includes(String(item.name || '').toUpperCase())).map(item => ({ name: String(item.name || '').trim(), ip: String(item.ip || ''), mask: String(item.mask || '255.255.255.0'), ...(Number(item.vlan) ? { vlan: Math.max(1, Math.min(4094, Number(item.vlan))) } : {}) }));
      config.interfaces = [...physicalInterfaces, ...virtualInterfaces];
      config.dhcp_interface = DEVICE_PORTS.router.includes(raw.dhcp_interface) && raw.dhcp_interface !== 'WAN' ? raw.dhcp_interface : 'LAN1';
      const primary = physicalInterfaces.find(item => item.name === 'LAN1') || physicalInterfaces[0];
      config.ip = primary?.ip || '';
      config.mask = primary?.mask || '255.255.255.0';
      const dhcpInterface = config.interfaces.find(item => item.name === config.dhcp_interface);
      if (dhcpInterface?.ip) {
        config.dhcp_gateway = dhcpInterface.ip;
        config.dhcp_mask = dhcpInterface.mask;
        config.dhcp_vlan = dhcpInterface.vlan;
      }
    }
    device.config = config;
  }
  function normalizePhysicalLinks() {
    const used = Object.fromEntries((state.topology?.devices || []).map(device => [device.id, new Set()]));
    state.topology.links = (state.topology.links || []).filter(link => {
      const source = deviceById(link.source), target = deviceById(link.target);
      if (!source || !target) return false;
      const sourcePorts = DEVICE_PORTS[source?.type] || [], targetPorts = DEVICE_PORTS[target?.type] || [];
      let kind = ['ethernet', 'fiber', 'serial'].includes(String(link.kind || '').toLowerCase()) ? String(link.kind).toLowerCase() : 'ethernet';
      const sourceCandidate = sourcePorts.includes(link.source_port) && !used[source.id].has(link.source_port) ? link.source_port : '';
      const targetCandidate = targetPorts.includes(link.target_port) && !used[target.id].has(link.target_port) ? link.target_port : '';
      const pairSupportsKind = (sourcePort, targetPort, medium) => portMedia(source, sourcePort).includes(medium) && portMedia(target, targetPort).includes(medium);
      let sourcePort = sourceCandidate, targetPort = targetCandidate;
      if (!sourcePort || !targetPort || !pairSupportsKind(sourcePort, targetPort, kind)) {
        const pairs = sourcePorts.filter(port => !used[source.id].has(port)).flatMap(sourcePortName => targetPorts.filter(port => !used[target.id].has(port)).map(targetPortName => [sourcePortName, targetPortName]));
        let pair = pairs.find(([a, b]) => pairSupportsKind(a, b, kind));
        if (!pair) {
          pair = pairs.find(([a, b]) => compatibleMedia(source, a, target, b).length);
          kind = pair ? compatibleMedia(source, pair[0], target, pair[1])[0] : kind;
        }
        if (pair) [sourcePort, targetPort] = pair;
      }
      if (!sourcePort || !targetPort) return false;
      link.source_port = sourcePort; link.target_port = targetPort;
      link.kind = pairSupportsKind(sourcePort, targetPort, kind) ? kind : compatibleMedia(source, sourcePort, target, targetPort)[0];
      if (!link.kind) return false;
      link.label = String(link.label || '').slice(0, 80);
      link.latency_ms = Math.max(0, Math.min(10000, Number(link.latency_ms) || 1));
      link.loss_percent = Math.max(0, Math.min(100, Number(link.loss_percent) || 0));
      link.mtu = Math.max(576, Math.min(9216, Number(link.mtu) || 1500));
      link.clock_rate = Math.max(0, Math.min(10000000, Number(link.clock_rate) || 0));
      used[source.id].add(sourcePort); used[target.id].add(targetPort);
      return true;
    });
    state.topology.schema_version = 2;
    state.topology.metadata = state.topology.metadata && typeof state.topology.metadata === 'object' ? state.topology.metadata : {};
    state.topology.metadata.simulation = { seed: 1337, profile: 'classroom', speed: 1, ...(state.topology.metadata.simulation || {}) };
  }

  function showMode({ push = true } = {}) {
    document.body.classList.remove('wiki-mode');
    document.body.classList.add('network-mode');
    $('networkViewBtn')?.setAttribute('aria-current', 'page');
    $('wikiViewBtn')?.setAttribute('aria-current', 'false');
    $('ideViewBtn')?.setAttribute('aria-current', 'false');
    if (push && location.pathname !== '/network') history.pushState({ eagleView: 'network' }, '', '/network');
  }
  async function show({ push = true } = {}) {
    showMode({ push });
    showLibrary();
    try {
      await loadBootstrap();
    } catch (error) {
      if (error.status === 403) {
        alert(error.message);
        window.WikiReader?.showHome?.();
      } else {
        $('networkLoading').textContent = error.message;
      }
    }
  }
  function showLibrary() {
    const pendingSave = flushPendingSave();
    $('networkLibrary').hidden = false;
    $('networkWorkspace').hidden = true;
    state.connectMode = false;
    state.connectSource = '';
    state.connectSourcePort = '';
    state.connectKind = '';
    closePortPicker();
    stopPacketPlayback();
    $('networkConnectBtn')?.setAttribute('aria-pressed', 'false');
    return pendingSave;
  }
  async function requestBootstrap({ force = false } = {}) {
    const key = currentAuthKey();
    if (!force && state.bootstrap && state.bootstrapKey === key) return state.bootstrap;
    if (!force && state.bootstrapPromise && state.bootstrapPromiseKey === key) return state.bootstrapPromise;
    let pending;
    pending = api('/api/network/bootstrap').then(data => {
      if (currentAuthKey() === key) { state.bootstrap = data; state.bootstrapKey = key; }
      return data;
    }).finally(() => {
      if (state.bootstrapPromise === pending) { state.bootstrapPromise = null; state.bootstrapPromiseKey = ''; }
    });
    state.bootstrapPromise = pending;
    state.bootstrapPromiseKey = key;
    return pending;
  }
  async function loadBootstrap({ force = false } = {}) {
    $('networkLoading').hidden = false;
    const data = await requestBootstrap({ force });
    $('networkLoading').hidden = true;
    $('networkPreviewWarning').hidden = !data.admin_preview;
    $('networkGuestNote').hidden = data.role !== 'guest';
    renderLibrary();
    renderCommandReference();
    return data;
  }
  function applyConfig(config = {}) {
    const ctx = context();
    const available = !!(config.network_sim_enabled || ctx.ADMIN_TOKEN);
    [$('networkViewBtn'), $('wikiHeroNetworkBtn')].forEach(button => { if (button) button.hidden = !available; });
  }
  async function refreshAvailability() {
    let config = context().currentConfig;
    if (!config && window.EagleIDE?.configReady) {
      await window.EagleIDE.configReady;
      config = context().currentConfig;
    }
    if (!config) {
      try {
        const response = await fetch('/api/config');
        const payload = await response.json();
        config = payload?.data || {};
      } catch { config = {}; }
    }
    applyConfig(config);
    const ctx = context();
    if (config.network_sim_enabled && ctx.USER_TOKEN && !ctx.TEACHER_TOKEN && !ctx.ADMIN_TOKEN) {
      try { await requestBootstrap(); }
      catch (error) {
        if (error.status === 403) [$('networkViewBtn'), $('wikiHeroNetworkBtn')].forEach(button => { if (button) button.hidden = true; });
      }
    }
  }

  function renderLibrary() {
    const data = state.bootstrap || {};
    const assigned = data.assigned_labs || [];
    $('networkAssignedSection').hidden = !assigned.length;
    $('networkAssignedList').innerHTML = assigned.map(lab => `
      <button class="network-card is-lab" type="button" data-open-lab="${escapeHtml(lab.id)}" data-class-id="${escapeHtml(lab.class_id)}">
        <div class="network-card-meta"><span>${escapeHtml(lab.class_name)}</span><span>${escapeHtml(lab.level)}</span><span>${Number(lab.estimated_minutes) || 0} min</span></div>
        <h3>${escapeHtml(lab.title)}</h3><p>${escapeHtml(lab.description)}</p>
        <div class="network-card-actions"><strong>Open assigned lab</strong><span>→</span></div>
      </button>`).join('');
    $('networkExampleList').innerHTML = (data.examples || []).map(example => `
      <button class="network-card" type="button" data-open-example="${escapeHtml(example.id)}">
        <div class="network-card-meta"><span>${escapeHtml(example.category)}</span><span>${Number(example.objective_count) || 0} guided task${Number(example.objective_count) === 1 ? '' : 's'}</span></div>
        <h3>${escapeHtml(example.title)}</h3><p>${escapeHtml(example.description)}</p>
        <div class="network-card-actions"><strong>Open editable copy</strong><span>→</span></div>
      </button>`).join('');
    const saved = data.saved || [];
    $('networkSavedSection').hidden = !data.can_save;
    $('networkSavedList').innerHTML = saved.length ? saved.map(item => `
      <article class="network-card" tabindex="0" role="button" data-open-saved="${escapeHtml(item.id)}">
        <div class="network-card-meta"><span>Saved network</span><span>${formatTimestamp(item.updated_at)}</span></div>
        <h3>${escapeHtml(item.title || 'Untitled Network')}</h3><p>${escapeHtml(item.description || 'Open this topology to continue building.')}</p>
        <div class="network-card-actions"><strong>Continue</strong><button class="network-card-delete" type="button" data-delete-saved="${escapeHtml(item.id)}" aria-label="Delete ${escapeHtml(item.title)}">✕</button></div>
      </article>`).join('') : '<div class="network-objectives-empty">No saved networks yet. Create one or save an example.</div>';
  }
  function formatTimestamp(value) {
    if (!value) return '';
    try { return new Date(Number(value) * 1000).toLocaleDateString(); } catch { return ''; }
  }

  async function openExample(id) {
    try {
      const topology = await api(`/api/network/examples/${encodeURIComponent(id)}`);
      topology.id = makeId('network');
      topology.title = `${topology.title} — Copy`;
      topology.metadata = { ...(topology.metadata || {}), source_example: id };
      openTopology(topology, { mode: 'personal', saved: false });
    } catch (error) { alert(error.message); }
  }
  async function openSaved(id) {
    try { openTopology(await api(`/api/network/topologies/${encodeURIComponent(id)}`), { mode: 'personal', saved: true }); }
    catch (error) { alert(error.message); }
  }
  async function openLab(id, classId) {
    try {
      const lab = await api(`/api/network/labs/${encodeURIComponent(id)}?class_id=${encodeURIComponent(classId)}`);
      const progress = await api(`/api/network/student/labs/${encodeURIComponent(classId)}/${encodeURIComponent(id)}`);
      state.lab = lab;
      state.labClassId = classId;
      openTopology(progress.topology || lab.starter_topology, { mode: 'lab', saved: true, grade: progress.grade });
      logEvent(`Opened ${lab.title}. Progress saves automatically.`);
    } catch (error) { alert(error.message); }
  }
  function openTopology(topology, options = {}) {
    flushPendingSave();
    state.topology = clone(topology || blankTopology());
    (state.topology.devices || []).forEach(normalizeDeviceConfig);
    normalizePhysicalLinks();
    state.mode = options.mode || 'personal';
    state.savedOnce = !!options.saved;
    state.grade = options.grade || null;
    if (!['lab', 'demo'].includes(state.mode)) { state.lab = null; state.labClassId = ''; }
    state.selectedId = '';
    state.selectedLinkId = '';
    state.connectMode = false;
    state.connectSource = '';
    state.connectSourcePort = '';
    state.undo = [];
    state.redo = [];
    state.events = [];
    state.lastPacket = null;
    state.packetStep = -1;
    clearInterval(state.packetTimer); state.packetTimer = 0;
    invalidateTopology();
    state.dnsCache.clear();
    state.objectiveActions.clear();
    if ($('networkPacketOverlayLayer')) $('networkPacketOverlayLayer').innerHTML = '';
    if ($('networkPacketResult')) $('networkPacketResult').textContent = 'Choose devices and a protocol to trace simulated traffic.';
    state.zoom = 1;
    $('networkLibrary').hidden = true;
    $('networkWorkspace').hidden = false;
    $('networkTitleInput').value = state.topology.title || 'Untitled Network';
    if ($('networkPacketDomain')) $('networkPacketDomain').value = state.topology.metadata?.default_domain || '';
    $('networkSaveBtn').hidden = ['lab', 'demo'].includes(state.mode) || !state.bootstrap?.can_save;
    $('networkLabGuideTab').hidden = !['lab', 'demo'].includes(state.mode);
    setStatus(state.mode === 'lab' ? 'Auto-save on' : state.mode === 'demo' ? 'Teacher demonstration' : (state.bootstrap?.can_save ? '' : 'Guest—export only'));
    autoAssignWanLeases({ render: false, recordHistory: false });
    autoAssignDhcpLeases({ render: false, recordHistory: false });
    renderAll();
    requestAnimationFrame(fitCanvas);
    window.dispatchEvent(new CustomEvent('network-sim:topology-opened', { detail: { topology: state.topology, mode: state.mode } }));
  }

  function snapshot() { return clone(state.topology); }
  function remember(before = snapshot()) {
    state.undo.push(before);
    state.undo = state.undo.slice(-50);
    state.redo = [];
  }
  function mutate(callback, label, { inspector = true } = {}) {
    if (!state.topology) return;
    const before = snapshot();
    callback();
    remember(before);
    afterMutation(label, { inspector });
  }
  function afterMutation(label, { inspector = true } = {}) {
    state.topology.title = $('networkTitleInput')?.value.trim() || state.topology.title || 'Untitled Network';
    invalidateTopology();
    renderCanvas();
    if (inspector) renderInspector();
    renderPacketOptions();
    gradeCurrentLab();
    if (label) logEvent(label);
    scheduleSave();
    window.dispatchEvent(new CustomEvent('network-sim:topology-changed', { detail: { label, topology: state.topology } }));
  }
  function undo() {
    const prior = state.undo.pop();
    if (!prior) return;
    state.redo.push(snapshot());
    state.topology = prior;
    if (!deviceById(state.selectedId)) state.selectedId = '';
    $('networkTitleInput').value = state.topology.title || 'Untitled Network';
    afterMutation('Undid last change.');
  }
  function redo() {
    const next = state.redo.pop();
    if (!next) return;
    state.undo.push(snapshot());
    state.topology = next;
    if (!deviceById(state.selectedId)) state.selectedId = '';
    $('networkTitleInput').value = state.topology.title || 'Untitled Network';
    afterMutation('Redid change.');
  }

  function addDevice(type) {
    if (!state.topology || state.topology.devices.length >= (state.bootstrap?.limits?.devices || LIMITS.devices)) return alert('This topology has reached its device limit.');
    const scroll = $('networkCanvasScroll');
    const x = Math.max(25, Math.min(850, ((scroll?.scrollLeft || 0) + (scroll?.clientWidth || 600) / 2) / state.zoom - 55));
    const y = Math.max(25, Math.min(500, ((scroll?.scrollTop || 0) + (scroll?.clientHeight || 400) / 2) / state.zoom - 35));
    mutate(() => {
      const count = state.topology.devices.filter(item => item.type === type).length + 1;
      const device = { id: makeId(type), type, name: `${LABELS[type]} ${count}`, x, y, config: defaultConfig(type) };
      state.topology.devices.push(device);
      state.selectedId = device.id;
      state.selectedLinkId = '';
    }, `Added ${LABELS[type]}.`);
  }
  function portForLink(link, deviceId) {
    return link.source === deviceId ? link.source_port : link.target === deviceId ? link.target_port : '';
  }
  function usedPorts(deviceId) {
    return new Set((state.topology?.links || []).map(link => portForLink(link, deviceId)).filter(Boolean));
  }
  function portMedia(device, port) {
    return PORT_CAPABILITIES[device?.type]?.[port] || [];
  }
  function portSpeedOptions(device, port) {
    const peer = portPeer(device?.id, port);
    const media = peer?.link?.kind ? [peer.link.kind] : portMedia(device, port);
    const options = [...new Set(media.flatMap(kind => MEDIA_SPEEDS[kind] || []))];
    const current = device?.config?.ports?.[port]?.speed;
    if (current && !options.includes(current)) options.push(current);
    return options.length ? options : ['1 Gbps'];
  }
  function applyLinkMediaDefaults(link, kind) {
    const speeds = MEDIA_SPEEDS[kind] || MEDIA_SPEEDS.ethernet;
    [[link.source, link.source_port], [link.target, link.target_port]].forEach(([deviceId, port]) => {
      const settings = deviceById(deviceId)?.config?.ports?.[port];
      if (settings && !speeds.includes(settings.speed)) settings.speed = kind === 'serial' ? '1.544 Mbps' : kind === 'fiber' ? '10 Gbps' : '1 Gbps';
    });
    link.clock_rate = kind === 'serial' ? (Number(link.clock_rate) || 1544000) : 0;
  }
  function compatibleMedia(first, firstPort, second, secondPort) {
    const wanted = new Set(portMedia(first, firstPort));
    return portMedia(second, secondPort).filter(kind => wanted.has(kind));
  }
  function selectedCableKind() {
    if (state.connectSource && state.connectKind) return state.connectKind;
    return ['ethernet', 'fiber', 'serial'].includes($('networkCableMediaSelect')?.value) ? $('networkCableMediaSelect').value : 'ethernet';
  }
  function availablePorts(deviceId, kind = selectedCableKind()) {
    const device = deviceById(deviceId), used = usedPorts(deviceId);
    return (DEVICE_PORTS[device?.type] || []).filter(port => !used.has(port) && device.config?.ports?.[port]?.enabled !== false && portMedia(device, port).includes(kind));
  }
  function portPeer(deviceId, port) {
    const link = state.topology?.links?.find(item => portForLink(item, deviceId) === port);
    if (!link) return null;
    const peerId = link.source === deviceId ? link.target : link.source;
    return { link, device: deviceById(peerId), port: portForLink(link, peerId) };
  }
  function portIsEnabled(device, port) {
    return !!device && device.config?.enabled !== false && device.config?.ports?.[port]?.enabled !== false;
  }
  function linkIsUp(link) {
    return portIsEnabled(deviceById(link?.source), link?.source_port) && portIsEnabled(deviceById(link?.target), link?.target_port);
  }
  function spanningTreeState() {
    if (state.stpCache && state.stpCacheRevision === state.topologyRevision) return state.stpCache;
    const parent = new Map((state.topology?.devices || []).map(device => [device.id, device.id]));
    const find = id => { let root = id; while (parent.get(root) !== root) root = parent.get(root); while (parent.get(id) !== id) { const next = parent.get(id); parent.set(id, root); id = next; } return root; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra === rb) return false; parent.set(rb, ra); return true; };
    const bridge = device => ['switch', 'l3switch', 'wap'].includes(device?.type);
    const priority = device => Math.max(0, Number(device?.config?.stp_priority) || 32768);
    const blocked = new Set(), loopRisk = new Set();
    const links = (state.topology?.links || []).filter(link => linkIsUp(link) && [deviceById(link.source), deviceById(link.target)].every(bridge)).slice().sort((a, b) => {
      const aEnds = [deviceById(a.source), deviceById(a.target)], bEnds = [deviceById(b.source), deviceById(b.target)];
      return Math.min(...aEnds.map(priority)) - Math.min(...bEnds.map(priority)) || speedMbps(effectiveLinkSpeed(b)) - speedMbps(effectiveLinkSpeed(a)) || a.id.localeCompare(b.id);
    });
    links.forEach(link => {
      if (union(link.source, link.target)) return;
      const ends = [deviceById(link.source), deviceById(link.target)];
      const stpEnabled = ends.some(device => device?.config?.stp_enabled !== false);
      if (stpEnabled) blocked.add(link.id); else loopRisk.add(link.id);
    });
    state.stpCache = { blocked, loopRisk };
    state.stpCacheRevision = state.topologyRevision;
    return state.stpCache;
  }
  function linkForwards(link) { return linkIsUp(link) && !spanningTreeState().blocked.has(link?.id); }
  function effectiveLinkSpeed(link) {
    const first = deviceById(link?.source)?.config?.ports?.[link?.source_port]?.speed || '1 Gbps';
    const second = deviceById(link?.target)?.config?.ports?.[link?.target_port]?.speed || '1 Gbps';
    return speedMbps(first) <= speedMbps(second) ? first : second;
  }
  function speedMbps(value) {
    const match = String(value || '').match(/[\d.]+/), amount = Number(match?.[0]) || 1000;
    return /gbps/i.test(value) ? amount * 1000 : amount;
  }
  function linkSpeedClass(link) {
    const speed = speedMbps(effectiveLinkSpeed(link));
    return `network-link--speed-${speed >= 10000 ? 'very-fast' : speed >= 1000 ? 'fast' : speed >= 100 ? 'medium' : 'slow'}`;
  }
  function wirelessAssociations() {
    const devices = state.topology?.devices || [];
    const waps = devices.filter(device => device.type === 'wap' && device.config?.enabled !== false);
    return devices.filter(device => ['laptop', 'phone'].includes(device.type) && device.config?.enabled !== false).flatMap(client => {
      const matches = waps.filter(wap => {
        const distance = Math.hypot((Number(wap.x) || 0) - (Number(client.x) || 0), (Number(wap.y) || 0) - (Number(client.y) || 0));
        const band = String(wap.config?.band || 'dual'), wantedBand = String(client.config?.wifi_band || 'auto');
        const bandMatches = wantedBand === 'auto' || band === 'dual' || band === wantedBand;
        return client.config?.ssid && client.config.ssid === wap.config?.ssid && (client.config?.wifi_password || '') === (wap.config?.wifi_password || '') && distance <= Math.max(40, Number(wap.config?.range) || 280) && bandMatches;
      });
      matches.sort((first, second) => {
        const firstDistance = ((Number(first.x) || 0) - (Number(client.x) || 0)) ** 2 + ((Number(first.y) || 0) - (Number(client.y) || 0)) ** 2;
        const secondDistance = ((Number(second.x) || 0) - (Number(client.x) || 0)) ** 2 + ((Number(second.y) || 0) - (Number(client.y) || 0)) ** 2;
        return firstDistance - secondDistance || first.id.localeCompare(second.id);
      });
      const wap = matches[0];
      return wap ? [{ id: `wireless:${client.id}:${wap.id}`, client, wap, source: client.id, target: wap.id, source_port: 'Wi-Fi', target_port: 'Radio', kind: 'wireless' }] : [];
    });
  }
  function wirelessAssociationBetween(first, second) {
    return wirelessAssociations().find(item => (item.source === first && item.target === second) || (item.source === second && item.target === first)) || null;
  }
  function closePortPicker() {
    const picker = $('networkPortPicker');
    if (picker) { picker.hidden = true; picker.innerHTML = ''; }
  }
  function openPortPicker(id, event) {
    const device = deviceById(id), kind = selectedCableKind(), ports = availablePorts(id, kind);
    if (!device) return;
    if (!ports.length) {
      alert((DEVICE_PORTS[device.type] || []).length ? `${device.name} has no available enabled ${kind} ports.` : `${device.name} has no physical cable ports.`);
      return;
    }
    if (state.connectSource && id === state.connectSource) return alert('Choose a different device for the other end of the cable.');
    const canvas = $('networkCanvas'), rect = canvas.getBoundingClientRect();
    const x = Math.max(8, Math.min(750, (event.clientX - rect.left) / state.zoom));
    const y = Math.max(8, Math.min(430, (event.clientY - rect.top) / state.zoom));
    const picker = $('networkPortPicker');
    picker.style.left = `${x}px`; picker.style.top = `${y}px`;
    picker.innerHTML = `<strong>${escapeHtml(device.name)}</strong><span>${state.connectSource ? 'Choose destination port' : 'Choose source port'} · ${escapeHtml(kind)}</span><div>${ports.map(port => `<button type="button" data-connect-port="${escapeHtml(port)}"><b>${escapeHtml(port)}</b><small>${escapeHtml(device.config?.ports?.[port]?.speed || '1 Gbps')} · ${escapeHtml(portMedia(device, port).join('/'))}</small></button>`).join('')}</div><button class="network-port-picker-cancel" type="button" data-port-cancel>Cancel</button>`;
    picker.hidden = false;
    picker.querySelectorAll('[data-connect-port]').forEach(button => button.addEventListener('click', pickEvent => {
      pickEvent.stopPropagation();
      connectDevicePort(id, button.dataset.connectPort);
    }));
    picker.querySelector('[data-port-cancel]')?.addEventListener('click', pickEvent => { pickEvent.stopPropagation(); closePortPicker(); });
  }
  function connectDevicePort(id, port) {
    closePortPicker();
    if (!state.connectSource) {
      state.connectSource = id; state.connectSourcePort = port;
      state.connectKind = selectedCableKind();
      state.selectedId = id; state.selectedLinkId = '';
      renderCanvas(); setStatus(`${port} selected · choose the second device`);
      return;
    }
    if (state.topology.links.length >= (state.bootstrap?.limits?.links || LIMITS.links)) return alert('This topology has reached its cable limit.');
    const first = state.connectSource, firstPort = state.connectSourcePort;
    mutate(() => {
      const kind = state.connectKind || selectedCableKind();
      if (!compatibleMedia(deviceById(first), firstPort, deviceById(id), port).includes(kind)) throw new Error(`The selected ports do not support ${kind}.`);
      state.topology.links.push({ id: makeId('link'), source: first, target: id, source_port: firstPort, target_port: port, kind, label: '', latency_ms: kind === 'serial' ? 20 : 1, loss_percent: 0, mtu: 1500, clock_rate: kind === 'serial' ? 1544000 : 0 });
      if (kind === 'serial') {
        deviceById(first).config.ports[firstPort].speed = '1.544 Mbps';
        deviceById(id).config.ports[port].speed = '1.544 Mbps';
      }
      [deviceById(first), deviceById(id)].filter(device => device?.type === 'router' && device.config?.wan_mode === 'static').forEach(router => { router.config.wan_state = portPeer(router.id, 'WAN') && ipNumber(router.config.wan_ip) !== null ? 'connected' : 'disconnected'; });
    }, `Connected ${deviceById(first)?.name} ${firstPort} to ${deviceById(id)?.name} ${port}.`);
    state.connectSource = ''; state.connectSourcePort = ''; state.connectKind = ''; state.connectMode = false;
    $('networkConnectBtn').setAttribute('aria-pressed', 'false'); setStatus(''); renderCanvas();
    setTimeout(() => { autoAssignDhcpLeases(); autoAssignWanLeases(); }, 0);
  }
  function deleteSelected() {
    if (state.selectedLinkId) {
      const link = selectedLink();
      mutate(() => {
        state.topology.links = state.topology.links.filter(item => item.id !== state.selectedLinkId);
        [[link?.source, link?.source_port], [link?.target, link?.target_port]].forEach(([deviceId, port]) => { const device = deviceById(deviceId); if (device?.type === 'router' && port === 'WAN') disconnectWan(device); });
        state.selectedLinkId = '';
      }, `Deleted cable between ${deviceById(link?.source)?.name || 'device'} and ${deviceById(link?.target)?.name || 'device'}.`);
      return;
    }
    if (!state.selectedId) return;
    const device = selectedDevice();
    mutate(() => {
      const removedId = state.selectedId;
      const affectedWanRouters = state.topology.links.flatMap(link => [[link.source, link.source_port], [link.target, link.target_port]]).filter(([deviceId, port]) => deviceId !== removedId && port === 'WAN').map(([deviceId]) => deviceById(deviceId)).filter(item => item?.type === 'router' && state.topology.links.some(link => [link.source, link.target].includes(removedId) && [link.source, link.target].includes(item.id)));
      state.topology.devices = state.topology.devices.filter(item => item.id !== state.selectedId);
      state.topology.links = state.topology.links.filter(link => link.source !== state.selectedId && link.target !== state.selectedId);
      affectedWanRouters.forEach(disconnectWan);
      state.selectedId = '';
    }, `Deleted ${device?.name || 'device'}.`);
  }

  function renderAll() {
    renderPalette();
    renderCanvas();
    renderInspector();
    renderPacketOptions();
    renderEvents();
    renderLabGuide();
    gradeCurrentLab();
    updateZoom();
  }
  function renderPalette() {
    $('networkDevicePalette').innerHTML = DEVICE_TYPES.map(([type, icon, label]) => `<button class="network-palette-device" type="button" data-add-device="${type}"><span>${icon}</span><span>${label}</span></button>`).join('');
  }
  function linkPairKey(link) { return [String(link?.source || ''), String(link?.target || '')].sort().join('\u0000'); }
  function linkPeerGroups() {
    const groups = new Map();
    (state.topology?.links || []).forEach(link => {
      const key = linkPairKey(link), peers = groups.get(key) || [];
      peers.push(link); groups.set(key, peers);
    });
    return groups;
  }
  function linkCoordinates(link, peerGroups = null) {
    const source = deviceById(link?.source), target = deviceById(link?.target);
    if (!source || !target) return null;
    let x1 = source.x + 56, y1 = source.y + 35, x2 = target.x + 56, y2 = target.y + 35;
    const peers = (peerGroups || linkPeerGroups()).get(linkPairKey(link)) || [];
    if (peers.length > 1) {
      const index = peers.findIndex(item => item.id === link.id), offset = (index - (peers.length - 1) / 2) * 13;
      const length = Math.hypot(x2 - x1, y2 - y1) || 1, ox = -(y2 - y1) / length * offset, oy = (x2 - x1) / length * offset;
      x1 += ox; x2 += ox; y1 += oy; y2 += oy;
    }
    return { x1, y1, x2, y2 };
  }
  function renderCanvas() {
    const topology = state.topology;
    if (!topology) return;
    const emptyCanvas = $('networkEmptyCanvas'), linksLayer = $('networkLinks'), nodeLayer = $('networkNodeLayer');
    if (!emptyCanvas || !linksLayer || !nodeLayer) return;
    emptyCanvas.hidden = topology.devices.length > 0;
    const tree = spanningTreeState(), peerGroups = linkPeerGroups();
    const physicalLinks = topology.links.map(link => {
      const source = deviceById(link.source), target = deviceById(link.target);
      if (!source || !target) return '';
      const selected = link.id === state.selectedLinkId ? ' is-selected' : '', down = linkIsUp(link) ? '' : ' is-down', stp = tree.blocked.has(link.id) ? ' is-stp-blocked' : '', loop = tree.loopRisk.has(link.id) ? ' has-loop-risk' : '';
      const kind = ['ethernet', 'fiber', 'serial'].includes(link.kind) ? link.kind : 'ethernet';
      const status = tree.blocked.has(link.id) ? 'STP blocking' : tree.loopRisk.has(link.id) ? 'loop risk' : linkIsUp(link) ? 'forwarding' : 'down';
      const title = `${source.name} ${link.source_port} to ${target.name} ${link.target_port} · ${kind} · ${effectiveLinkSpeed(link)} · ${status}`;
      const { x1, y1, x2, y2 } = linkCoordinates(link, peerGroups);
      const label = link.label ? `<text class="network-link-label" x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 7}">${escapeHtml(link.label)}</text>` : '';
      return `<g><line class="network-link-hit" data-link-select="${escapeHtml(link.id)}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"><title>${escapeHtml(title)}</title></line><line class="network-link network-link--${kind} ${linkSpeedClass(link)}${selected}${down}${stp}${loop}" data-link-id="${escapeHtml(link.id)}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"></line>${label}</g>`;
    }).join('');
    const wirelessLinks = wirelessAssociations().map(item => `<line class="network-link network-link--wireless" data-wireless-client="${escapeHtml(item.client.id)}" data-wireless-wap="${escapeHtml(item.wap.id)}" x1="${item.client.x + 56}" y1="${item.client.y + 35}" x2="${item.wap.x + 56}" y2="${item.wap.y + 35}"><title>${escapeHtml(item.client.name)} associated to ${escapeHtml(item.wap.name)} · ${escapeHtml(item.wap.config?.ssid || '')}</title></line>`).join('');
    linksLayer.innerHTML = physicalLinks + wirelessLinks;
    nodeLayer.innerHTML = topology.devices.map(device => {
      const automatic = isDhcpClient(device);
      const clientCapable = DHCP_CLIENT_TYPES.has(device.type);
      const primaryAddress = primaryDeviceAddress(device);
      const address = primaryAddress ? `${primaryAddress}${device.type === 'server' ? ` · ${deviceAddresses(device).length} NIC${deviceAddresses(device).length === 1 ? '' : 's'}` : clientCapable ? (automatic ? ' · DHCP' : ' · Static') : ''}` : (automatic ? 'DHCP · no lease' : (clientCapable ? 'Manual · no address' : ((device.type === 'wap' ? device.config?.ssid : '') || device.type)));
      const classes = ['network-node', device.id === state.selectedId ? 'is-selected' : '', device.id === state.connectSource ? 'is-connect-source' : ''].filter(Boolean).join(' ');
      return `<button class="${classes}" type="button" data-device-id="${escapeHtml(device.id)}" style="left:${Number(device.x) || 0}px;top:${Number(device.y) || 0}px" aria-label="${escapeHtml(device.name)}">
        <span class="network-node-icon" aria-hidden="true">${ICONS[device.type] || '□'}</span><span class="network-node-label"><strong>${escapeHtml(device.name)}</strong><span>${escapeHtml(address)}</span></span><i class="network-node-status ${device.config?.enabled === false ? 'off' : ''}"></i>
      </button>`;
    }).join('');
    linksLayer.querySelectorAll('[data-link-select]').forEach(line => line.addEventListener('pointerdown', event => {
      event.preventDefault();
      const linkId = line.dataset.linkSelect;
      state.selectedLinkId = state.selectedLinkId === linkId ? '' : linkId;
      state.selectedId = '';
      renderCanvas();
      renderInspector();
    }));
    bindNodePointers();
    if (state.lastPacket && state.packetStep >= 0) renderPacketStep(state.packetStep);
    window.dispatchEvent(new CustomEvent('network-sim:canvas-rendered', { detail: { topology: state.topology } }));
  }
  function bindNodePointers() {
    const nodeLayer = $('networkNodeLayer'), linksLayer = $('networkLinks');
    if (!nodeLayer || !linksLayer) return;
    nodeLayer.querySelectorAll('.network-node').forEach(node => {
      node.addEventListener('pointerdown', event => {
        const id = node.dataset.deviceId;
        if (state.connectMode) { event.preventDefault(); openPortPicker(id, event); return; }
        state.selectedId = id;
        state.selectedLinkId = '';
        linksLayer.querySelectorAll('.network-link.is-selected').forEach(line => line.classList.remove('is-selected'));
        renderInspector();
        nodeLayer.querySelectorAll('.network-node').forEach(item => item.classList.toggle('is-selected', item === node));
        const device = deviceById(id);
        if (!device) return;
        const before = snapshot();
        const start = { x: event.clientX, y: event.clientY, left: device.x, top: device.y };
        let moved = false;
        node.setPointerCapture?.(event.pointerId);
        const move = moveEvent => {
          const dx = (moveEvent.clientX - start.x) / state.zoom;
          const dy = (moveEvent.clientY - start.y) / state.zoom;
          if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
          const raw = { x: Math.max(0, Math.min(888, start.left + dx)), y: Math.max(0, Math.min(530, start.top + dy)) };
          const position = window.NetworkSimAdvanced?.snapPoint?.(raw.x, raw.y) || raw;
          device.x = position.x; device.y = position.y;
          node.style.left = `${device.x}px`; node.style.top = `${device.y}px`;
          renderLinksOnly();
        };
        const up = () => {
          node.removeEventListener('pointermove', move);
          node.removeEventListener('pointerup', up);
          node.removeEventListener('pointercancel', up);
          if (moved) { remember(before); afterMutation(`Moved ${device.name}.`, { inspector: false }); }
        };
        node.addEventListener('pointermove', move);
        node.addEventListener('pointerup', up);
        node.addEventListener('pointercancel', up);
      });
    });
  }
  function renderLinksOnly() {
    const linksLayer = $('networkLinks');
    if (!linksLayer || !state.topology) return;
    const peerGroups = linkPeerGroups();
    linksLayer.querySelectorAll('[data-link-id],[data-link-select]').forEach(line => {
      const linkId = line.dataset.linkId || line.dataset.linkSelect;
      const link = state.topology.links.find(item => item.id === linkId);
      const source = deviceById(link?.source), target = deviceById(link?.target);
      if (!source || !target) return;
      const points = linkCoordinates(link, peerGroups);
      line.setAttribute('x1', points.x1); line.setAttribute('y1', points.y1);
      line.setAttribute('x2', points.x2); line.setAttribute('y2', points.y2);
    });
    linksLayer.querySelectorAll('[data-wireless-client][data-wireless-wap]').forEach(line => {
      const client = deviceById(line.dataset.wirelessClient), wap = deviceById(line.dataset.wirelessWap);
      if (!client || !wap) return;
      line.setAttribute('x1', client.x + 56); line.setAttribute('y1', client.y + 35);
      line.setAttribute('x2', wap.x + 56); line.setAttribute('y2', wap.y + 35);
    });
  }

  function csv(value) { return Array.isArray(value) ? value.join(', ') : ''; }
  function interfaceLines(value) {
    return (Array.isArray(value) ? value : []).map(item => [item.name || 'eth0', item.ip || '', item.mask || '255.255.255.0', item.vlan || ''].join(', ')).join('\n');
  }
  function routeLines(value) {
    return (Array.isArray(value) ? value : []).map(item => [item.network || '', item.gateway || ''].join(' via ')).join('\n');
  }
  function maskPrefix(mask) {
    const value = ipNumber(mask);
    if (value === null) return null;
    let prefix = 0, sawZero = false;
    for (let bit = 31; bit >= 0; bit -= 1) {
      const enabled = !!(value & (2 ** bit));
      if (enabled && sawZero) return null;
      if (enabled) prefix += 1; else sawZero = true;
    }
    return prefix;
  }
  function networkCidr(ip, mask) {
    const address = ipNumber(ip), maskValue = ipNumber(mask), prefix = maskPrefix(mask);
    if (address === null || maskValue === null || prefix === null) return '';
    return `${ipString((address & maskValue) >>> 0)}/${prefix}`;
  }
  function orderedNumbers(values) {
    return [...new Set(values.map(Number).filter(Number.isFinite))].sort((first, second) => first - second);
  }
  function orderedAddresses(values) {
    return [...new Set(values.filter(Boolean))].sort((first, second) => {
      const a = ipNumber(first), b = ipNumber(second);
      if (a !== null && b !== null) return a - b;
      if (a !== null) return -1;
      if (b !== null) return 1;
      return first.localeCompare(second);
    });
  }
  function topologySuggestions() {
    const masks = new Set(COMMON_MASKS), networks = new Set(['any', '0.0.0.0/0']), vlans = new Set(COMMON_VLANS);
    const ssids = new Set(), domains = new Set();
    const addAddress = (address, mask = '') => {
      if (ipNumber(address) === null) return;
      if (ipNumber(mask) !== null) {
        masks.add(mask);
        const cidr = networkCidr(address, mask);
        if (cidr) networks.add(cidr);
      }
    };
    (state.topology?.devices || []).forEach(device => {
      const cfg = device.config || {};
      addAddress(cfg.ip, cfg.mask, { gateway: ['router', 'firewall', 'l3switch'].includes(device.type), resolver: device.type === 'server' && (cfg.services || []).includes('dns') });
      addAddress(cfg.gateway, '', { gateway: true }); addAddress(cfg.wan_ip, cfg.wan_mask); addAddress(cfg.wan_gateway, '', { gateway: true });
      addAddress(cfg.dhcp_start, cfg.dhcp_mask); addAddress(cfg.dhcp_end, cfg.dhcp_mask);
      addAddress(cfg.isp_dhcp_start, cfg.isp_mask); addAddress(cfg.isp_dhcp_end, cfg.isp_mask);
      addAddress(cfg.isp_gateway, cfg.isp_mask, { gateway: true });
      (cfg.dns_servers || []).forEach(value => addAddress(value, '', { resolver: true }));
      (cfg.wan_dns_servers || []).forEach(value => addAddress(value, '', { resolver: true }));
      (cfg.dns_forwarders || []).forEach(value => addAddress(value, '', { resolver: true }));
      ['dhcp_dns_primary', 'dhcp_dns_secondary', 'isp_dns_primary', 'isp_dns_secondary'].forEach(key => addAddress(cfg[key], '', { resolver: true }));
      Object.values(cfg.server_interfaces || {}).forEach(iface => addAddress(iface?.ip, iface?.mask));
      (cfg.interfaces || []).forEach(iface => { addAddress(iface?.ip, iface?.mask, { gateway: ['router', 'firewall'].includes(device.type) }); if (Number(iface?.vlan)) vlans.add(Number(iface.vlan)); });
      (cfg.svis || []).forEach(iface => { addAddress(iface?.ip, iface?.mask, { gateway: true }); if (Number(iface?.vlan)) vlans.add(Number(iface.vlan)); });
      [cfg.vlan, ...(cfg.vlans || []), ...(cfg.trunk_vlans || []), ...Object.values(cfg.port_vlans || {})].forEach(value => { if (Number(value) >= 1 && Number(value) <= 4094) vlans.add(Number(value)); });
      if (cfg.ssid) ssids.add(String(cfg.ssid));
      if (cfg.dhcp_domain) domains.add(String(cfg.dhcp_domain).toLowerCase());
      (cfg.dns_records || []).forEach(record => {
        if (record?.name) domains.add(String(record.name).toLowerCase());
        if (ipNumber(record?.value) !== null) addAddress(record.value); else if (record?.value) domains.add(String(record.value).toLowerCase());
      });
    });
    return {
      masks: orderedAddresses([...masks]), networks: orderedAddresses([...networks]), vlans: orderedNumbers([...vlans]),
      ssids: [...ssids].sort(), domains: [...domains].sort(), ports: COMMON_PORTS,
    };
  }
  function dataList(id, values) {
    return `<datalist id="${id}">${values.map(value => `<option value="${escapeHtml(value)}"></option>`).join('')}</datalist>`;
  }
  function renderSuggestionLists(suggestions) {
    return `<div class="network-suggestion-lists">${dataList('networkMasks', suggestions.masks)}${dataList('networkCidrChoices', suggestions.networks)}${dataList('networkRouteChoices', suggestions.networks.filter(value => value !== 'any'))}${dataList('networkDomainChoices', suggestions.domains)}${dataList('networkPortChoices', suggestions.ports)}</div>`;
  }
  function optionSet(values, current, label = value => String(value), emptyLabel = '') {
    const choices = [...new Set([...(emptyLabel ? [''] : []), ...values, ...(current !== '' && current !== undefined && current !== null ? [current] : [])].map(value => String(value)))];
    return choices.map(value => `<option value="${escapeHtml(value)}" ${String(current ?? '') === value ? 'selected' : ''}>${escapeHtml(value === '' ? emptyLabel : label(value))}</option>`).join('');
  }
  function renderResolverInputs(values, key, disabled = false, limit = 2) {
    const entries = Array.from({ length: limit }, (_, index) => values?.[index] || '');
    return `<div class="network-config-grid">${entries.map((value, index) => `<label>${index ? 'Secondary' : 'Primary'} DNS<input data-address-list="${escapeHtml(key)}" data-address-index="${index}" value="${escapeHtml(value)}" placeholder="${index ? '1.1.1.1' : '192.168.1.53'}" ${disabled ? 'disabled' : ''}></label>`).join('')}</div>`;
  }
  function renderLeaseSelect(key, current) {
    return `<select data-config="${escapeHtml(key)}" data-value-type="integer" data-number-min="1" data-number-max="10080">${optionSet(LEASE_MINUTES, Number(current) || 480, value => `${value} minutes`)}</select>`;
  }
  function labelInspectorSections(form) {
    const labels = [
      ['Internet / WAN', 'wan'], ['LAN interfaces', 'lan'], ['ISP DHCP service', 'isp-dhcp'],
      ['DHCP server', 'dhcp'], ['Routed traffic ACLs', 'acl'], ['DNS server', 'dns'],
      ['Physical ports', 'ports'], ['Static routes', 'routes'],
    ];
    form?.querySelectorAll('details.network-config-section').forEach(section => {
      if (section.dataset.networkSection) return;
      const text = section.querySelector(':scope > summary')?.textContent?.trim() || '';
      const match = labels.find(([label]) => text.startsWith(label));
      if (match) section.dataset.networkSection = match[1];
    });
  }
  function prepareDirectAddressInputs(form) {
    const configKeys = new Set(['ip', 'gateway', 'wan_ip', 'wan_gateway', 'isp_dhcp_start', 'isp_dhcp_end', 'isp_gateway', 'isp_dns_primary', 'isp_dns_secondary', 'dhcp_start', 'dhcp_end', 'dhcp_dns_primary', 'dhcp_dns_secondary']);
    form?.querySelectorAll('input').forEach(input => {
      const directAddress = configKeys.has(input.dataset.config) || input.hasAttribute('data-address-list') || input.dataset.serverInterfaceField === 'ip' || input.dataset.routerInterfaceField === 'ip' || input.dataset.sviField === 'ip' || input.dataset.firewallInterfaceField === 'ip' || input.dataset.routeField === 'gateway';
      if (!directAddress) return;
      input.inputMode = 'decimal';
      input.autocomplete = 'off';
      input.spellcheck = false;
    });
  }
  function renderInspector() {
    const device = selectedDevice();
    const link = selectedLink();
    const previousForm = $('networkConfigForm');
    labelInspectorSections(previousForm);
    const previousSections = previousForm && device && previousForm.dataset.inspectorDevice === device.id
      ? Object.fromEntries([...previousForm.querySelectorAll('details[data-network-section]')].map(section => [section.dataset.networkSection, section.open]))
      : {};
    if (!device && link) {
      const source = deviceById(link.source), target = deviceById(link.target);
      const media = compatibleMedia(source, link.source_port, target, link.target_port);
      const tree = spanningTreeState(), isBlocked = tree.blocked.has(link.id), loopRisk = tree.loopRisk.has(link.id);
      $('networkInspectorHint').textContent = `Cable · ${source?.name || link.source} to ${target?.name || link.target}`;
      $('networkInspector').innerHTML = `<form class="network-config-form" id="networkLinkConfigForm"><h4>Physical Connection</h4><label>From<input value="${escapeHtml(source?.name || link.source)} · ${escapeHtml(link.source_port)}" disabled></label><label>To<input value="${escapeHtml(target?.name || link.target)} · ${escapeHtml(link.target_port)}" disabled></label><div class="network-link-status ${linkIsUp(link) && !isBlocked ? 'is-up' : 'is-down'}"><strong>${!linkIsUp(link) ? 'LINK DOWN' : isBlocked ? 'STP BLOCKING' : loopRisk ? 'FORWARDING · LOOP RISK' : 'FORWARDING'}</strong><span>${escapeHtml(effectiveLinkSpeed(link))} negotiated</span></div><label>Media<select data-link-field="kind">${media.map(kind => `<option value="${kind}" ${link.kind === kind ? 'selected' : ''}>${kind[0].toUpperCase() + kind.slice(1)}</option>`).join('')}</select></label><label>Link label<input data-link-field="label" maxlength="80" value="${escapeHtml(link.label || '')}" placeholder="Core uplink"></label><div class="network-config-grid"><label>Latency (ms)<input data-link-field="latency_ms" data-link-number min="0" max="10000" type="number" value="${Number(link.latency_ms) || 1}"></label><label>Loss (%)<input data-link-field="loss_percent" data-link-number min="0" max="100" step="0.1" type="number" value="${Number(link.loss_percent) || 0}"></label><label>MTU<input data-link-field="mtu" data-link-number min="576" max="9216" type="number" value="${Number(link.mtu) || 1500}"></label>${link.kind === 'serial' ? `<label>Clock rate (bps)<input data-link-field="clock_rate" data-link-number min="0" type="number" value="${Number(link.clock_rate) || 1544000}"></label>` : ''}</div></form>`;
      $('networkLinkConfigForm')?.querySelectorAll('[data-link-field]').forEach(input => input.addEventListener('change', () => mutate(() => {
        const field = input.dataset.linkField;
        link[field] = input.hasAttribute('data-link-number') ? Number(input.value) : input.value.trim();
        if (field === 'kind') applyLinkMediaDefaults(link, link.kind);
      }, 'Updated cable configuration.', { inspector: input.dataset.linkField === 'kind' })));
      window.dispatchEvent(new CustomEvent('network-sim:inspector-rendered', { detail: { link } }));
      return;
    }
    $('networkInspectorHint').textContent = device ? `${LABELS[device.type]} · ${device.id}` : 'Select a device';
    if (!device) {
      $('networkInspector').innerHTML = '<div class="network-empty-inspector">Select a device to configure its name, addressing, services, VLAN, or wireless settings.</div>';
      return;
    }
    const cfg = device.config || (device.config = defaultConfig(device.type));
    const endpoint = !['switch', 'l3switch', 'server', 'router', 'firewall', 'cloud'].includes(device.type);
    const clientCapable = DHCP_CLIENT_TYPES.has(device.type);
    const automatic = clientCapable && addressingMode(device) === 'dhcp';
    const suggestions = topologySuggestions();
    cfg.addressing_mode = automatic ? 'dhcp' : 'static';
    cfg.dhcp = automatic;
    const leaseExpiry = Number(cfg.dhcp_lease_expires_at) ? new Date(Number(cfg.dhcp_lease_expires_at)).toLocaleString() : '';
    const sections = [`<form class="network-config-form" id="networkConfigForm" data-inspector-device="${escapeHtml(device.id)}">${renderSuggestionLists(suggestions)}<div class="network-choice-note">Short finite menus update from this topology. IP addresses, gateways, DNS addresses, and pool ranges stay direct-entry fields.</div><h4>Device</h4>
      <label>Name<input data-device-name value="${escapeHtml(device.name)}" maxlength="100"></label>
      <label class="network-switch"><input type="checkbox" data-config="enabled" ${cfg.enabled !== false ? 'checked' : ''}><span>Device powered on</span></label>`];
    if ((DEVICE_PORTS[device.type] || []).length) sections.push(renderPhysicalPorts(device));
    if (endpoint && clientCapable) sections.push(`<h4>IPv4 Addressing</h4><label>Configuration<select data-addressing-mode><option value="dhcp" ${automatic ? 'selected' : ''}>Automatic (DHCP)</option><option value="static" ${!automatic ? 'selected' : ''}>Manual (Static)</option></select></label>${automatic ? `<div class="network-dhcp-client-status ${cfg.ip ? 'is-bound' : ''}"><strong>${cfg.ip ? `Lease active · ${escapeHtml(cfg.ip)}` : 'Waiting for a DHCP lease'}</strong><span>${cfg.dhcp_server_name ? `Server: ${escapeHtml(cfg.dhcp_server_name)}` : 'Broadcast DHCP Discover to find a server.'}${leaseExpiry ? ` · Expires ${escapeHtml(leaseExpiry)}` : ''}</span><div><button class="btn run" id="networkDhcpRequestBtn" type="button">Request DHCP Lease</button>${cfg.ip ? '<button class="btn secondary" id="networkDhcpReleaseBtn" type="button">Release Lease</button>' : ''}</div></div>` : ''}`);
    if (endpoint) sections.push(`<div class="network-config-grid">
      <label>Address<input data-config="ip" value="${escapeHtml(cfg.ip || '')}" placeholder="${automatic ? 'Assigned by DHCP' : '192.168.1.10'}" ${automatic ? 'disabled' : ''}></label>
      <label>Subnet mask<input data-config="mask" list="networkMasks" value="${escapeHtml(cfg.mask || '255.255.255.0')}" ${automatic ? 'disabled' : ''}></label></div>
      <label>Default gateway<input data-config="gateway" value="${escapeHtml(cfg.gateway || '')}" placeholder="${automatic ? 'Assigned by DHCP' : '192.168.1.1'}" ${automatic ? 'disabled' : ''}></label>
      ${renderResolverInputs(cfg.dns_servers || [], 'dns_servers', automatic)}`);
    if (device.type === 'server') sections.push(`<h4>IPv4 Interfaces</h4><div class="network-dns-help">Each server NIC has its own address and subnet mask. The default gateway and DNS resolver list are shared by the server.</div><div class="network-server-interfaces">${renderServerInterfaces(device, suggestions)}</div><label>Default gateway<input data-config="gateway" value="${escapeHtml(cfg.gateway || '')}" placeholder="192.168.1.1"></label>${renderResolverInputs(cfg.dns_servers || [], 'dns_servers')}`);
    if (device.type === 'router') {
      const wanAutomatic = cfg.wan_mode !== 'static', carrier = !!portPeer(device.id, 'WAN');
      sections.push(`<details class="network-config-section" data-network-section="wan" open><summary>Internet / WAN <span>${escapeHtml(cfg.wan_state || (carrier ? 'not configured' : 'no carrier'))}</span></summary><label>External addressing<select data-wan-mode><option value="dhcp" ${wanAutomatic ? 'selected' : ''}>Automatic (ISP DHCP)</option><option value="static" ${!wanAutomatic ? 'selected' : ''}>Manual (Static)</option></select></label><div class="network-wan-status ${cfg.wan_state === 'connected' || (!wanAutomatic && cfg.wan_ip && carrier) ? 'is-up' : ''}"><strong>${carrier ? (cfg.wan_state === 'connected' || (!wanAutomatic && cfg.wan_ip) ? 'WAN CONNECTED' : 'WAN NOT ADDRESSED') : 'NO WAN CARRIER'}</strong><span>${cfg.wan_ip ? `${escapeHtml(cfg.wan_ip)} via ${escapeHtml(cfg.wan_gateway || 'no gateway')}` : 'Connect the WAN port to an ISP Cloud.'}</span></div><div class="network-config-grid"><label>External IPv4<input data-config="wan_ip" value="${escapeHtml(cfg.wan_ip || '')}" ${wanAutomatic ? 'disabled' : ''}></label><label>WAN mask<input data-config="wan_mask" list="networkMasks" value="${escapeHtml(cfg.wan_mask || '255.255.255.0')}" ${wanAutomatic ? 'disabled' : ''}></label></div><label>ISP gateway<input data-config="wan_gateway" value="${escapeHtml(cfg.wan_gateway || '')}" ${wanAutomatic ? 'disabled' : ''}></label>${renderResolverInputs(cfg.wan_dns_servers || [], 'wan_dns_servers', wanAutomatic)}${wanAutomatic ? `<div class="network-inline-actions"><button class="btn run" id="networkWanRequestBtn" type="button">Request WAN Lease</button>${cfg.wan_ip ? '<button class="btn secondary" id="networkWanReleaseBtn" type="button">Release</button>' : ''}</div>` : ''}<label class="network-switch"><input type="checkbox" data-config="nat_enabled" ${cfg.nat_enabled !== false ? 'checked' : ''}><span>Enable IPv4 NAT for LAN clients</span></label></details>`);
      sections.push(`<details class="network-config-section" data-network-section="lan" open><summary>LAN interfaces <span>One subnet per physical LAN port</span></summary><div class="network-router-interfaces">${renderRouterInterfaces(device, suggestions)}</div></details>`);
    }
    if (device.type === 'cloud') sections.push(`<details class="network-config-section" open><summary>ISP DHCP service <span>${cfg.isp_dhcp_enabled ? 'enabled' : 'disabled'}</span></summary><label class="network-switch"><input type="checkbox" data-config="isp_dhcp_enabled" ${cfg.isp_dhcp_enabled ? 'checked' : ''}><span>Provide addresses to connected router WAN ports</span></label><div class="network-config-grid"><label>Pool start<input data-config="isp_dhcp_start" value="${escapeHtml(cfg.isp_dhcp_start || '')}"></label><label>Pool end<input data-config="isp_dhcp_end" value="${escapeHtml(cfg.isp_dhcp_end || '')}"></label><label>WAN mask<input data-config="isp_mask" list="networkMasks" value="${escapeHtml(cfg.isp_mask || '255.255.255.0')}"></label><label>ISP gateway<input data-config="isp_gateway" value="${escapeHtml(cfg.isp_gateway || '')}"></label><label>Primary DNS<input data-config="isp_dns_primary" value="${escapeHtml(cfg.isp_dns_primary || '')}"></label><label>Secondary DNS<input data-config="isp_dns_secondary" value="${escapeHtml(cfg.isp_dns_secondary || '')}"></label><label>Lease time${renderLeaseSelect('isp_lease_minutes', cfg.isp_lease_minutes || 1440)}</label></div></details>`);
    if (!['router', 'firewall', 'cloud', 'switch', 'l3switch'].includes(device.type)) sections.push(`<label>Access VLAN<select data-config="vlan" data-value-type="vlan">${optionSet(suggestions.vlans, Number(cfg.vlan) || 1, value => `VLAN ${value}`)}</select></label>`);
    if (['switch', 'l3switch'].includes(device.type)) sections.push(`<h4>Layer 2 switching</h4>${renderSwitchingConfig(device, suggestions)}`);
    if (device.type === 'l3switch') sections.push(`<h4>Layer 3 routing</h4><label class="network-switch"><input type="checkbox" data-config="ip_routing" ${cfg.ip_routing !== false ? 'checked' : ''}><span>Enable inter-VLAN IP routing</span></label><div class="network-svi-list">${renderSvis(cfg.svis || [], suggestions)}</div><button class="btn secondary" id="networkAddSviBtn" type="button">＋ Add VLAN interface (SVI)</button>${renderRoutes(cfg.routes || [])}`);
    if (device.type === 'firewall') sections.push(`<h4>Interfaces</h4>${renderFirewallInterfaces(device, suggestions)}`);
    if (['router', 'firewall'].includes(device.type)) sections.push(renderRoutes(cfg.routes || []));
    if (device.type === 'router') {
      const dhcpInterface = cfg.interfaces.find(item => item.name === cfg.dhcp_interface) || cfg.interfaces[0] || {};
      sections.push(`<details class="network-config-section" open><summary>DHCP server <span>${cfg.dhcp_enabled ? `enabled on ${escapeHtml(cfg.dhcp_interface)}` : 'disabled'}</span></summary><label class="network-switch"><input type="checkbox" data-config="dhcp_enabled" ${cfg.dhcp_enabled ? 'checked' : ''}><span>Enable DHCP service</span></label><label>Serve clients on<select data-dhcp-interface>${cfg.interfaces.filter(item => DEVICE_PORTS.router.includes(item.name) && item.name !== 'WAN').map(item => `<option value="${escapeHtml(item.name)}" ${item.name === cfg.dhcp_interface ? 'selected' : ''}>${escapeHtml(item.name)} · ${escapeHtml(item.ip || 'unaddressed')}</option>`).join('')}</select></label><div class="network-dhcp-server-summary">Gateway ${escapeHtml(dhcpInterface.ip || 'not configured')} · Mask ${escapeHtml(dhcpInterface.mask || 'not configured')} · VLAN ${Number(dhcpInterface.vlan) || 1}</div><button class="btn secondary" id="networkDhcpQuickFillBtn" type="button">Suggest pool for ${escapeHtml(cfg.dhcp_interface || 'LAN1')}</button><div class="network-config-grid"><label>Pool start<input data-config="dhcp_start" value="${escapeHtml(cfg.dhcp_start || '')}" placeholder="192.168.1.100"></label><label>Pool end<input data-config="dhcp_end" value="${escapeHtml(cfg.dhcp_end || '')}" placeholder="192.168.1.199"></label><label>Primary DNS<input data-config="dhcp_dns_primary" value="${escapeHtml(cfg.dhcp_dns_primary || '')}" placeholder="192.168.1.1"></label><label>Secondary DNS<input data-config="dhcp_dns_secondary" value="${escapeHtml(cfg.dhcp_dns_secondary || '')}" placeholder="1.1.1.1"></label><label>Lease time${renderLeaseSelect('dhcp_lease_minutes', cfg.dhcp_lease_minutes || 480)}</label></div><label>Domain name<input data-config="dhcp_domain" list="networkDomainChoices" value="${escapeHtml(cfg.dhcp_domain || '')}" placeholder="classroom.local"></label><div class="network-dhcp-server-summary">Active leases: ${state.topology.devices.filter(item => item.config?.dhcp_server_id === device.id && item.config?.ip).length}</div></details>`);
    }
    if (['router', 'l3switch'].includes(device.type)) sections.push(`<details class="network-config-section"><summary>Routed traffic ACLs <span>${(cfg.acl_rules || []).length} ordered rule${(cfg.acl_rules || []).length === 1 ? '' : 's'}</span></summary><div class="network-dns-help">Rules are checked top-to-bottom on routed traffic. Choose an ingress or egress physical interface. “Implicit deny” blocks unmatched routed traffic, like an applied production ACL.</div><label class="network-switch"><input type="checkbox" data-config="acl_default_deny" ${cfg.acl_default_deny ? 'checked' : ''}><span>Implicitly deny unmatched routed traffic</span></label><div class="network-acl-rules">${renderAclRules(device)}</div><button class="btn secondary" id="networkAddAclRuleBtn" type="button">＋ Add ACL rule</button></details>`);
    if (device.type === 'server') sections.push(`<h4>Services</h4><div class="network-config-checks">${SERVICES.map(service => `<label><input type="checkbox" data-service="${service}" ${(cfg.services || []).includes(service) ? 'checked' : ''}>${service.toUpperCase()}</label>`).join('')}</div>`);
    if (device.type === 'server') sections.push(`<details class="network-config-section" ${(cfg.services || []).includes('dns') ? 'open' : ''}><summary>DNS server <span>${(cfg.services || []).includes('dns') ? `${cfg.dns_records.length} records` : 'service disabled'}</span></summary><label class="network-switch"><input type="checkbox" data-config="dns_recursion" ${cfg.dns_recursion !== false ? 'checked' : ''}><span>Allow recursive lookups</span></label><div class="network-dns-help">Fallback resolvers are tried in order when this server does not have an answer.</div>${renderResolverInputs(cfg.dns_forwarders || [], 'dns_forwarders', false, 4)}<div class="network-dns-help">Use A records for final IPv4 answers, CNAME for aliases, and NS records whose value is the downstream DNS server's IPv4 address.</div><div class="network-dns-records">${renderDnsRecords(cfg.dns_records || [])}</div><button class="btn secondary" id="networkAddDnsRecordBtn" type="button">＋ Add DNS record</button></details>`);
    if (device.type === 'firewall') sections.push(`<h4>Firewall rules</h4><div id="networkFirewallRules">${renderFirewallRules(cfg.firewall_rules || [])}</div><button class="btn secondary" id="networkAddFirewallRule" type="button">＋ Add rule</button>`);
    if (device.type === 'wap') sections.push(`<h4>Wireless</h4><label>SSID<input data-config="ssid" list="networkSsidChoices" value="${escapeHtml(cfg.ssid || '')}"></label><datalist id="networkSsidChoices">${suggestions.ssids.map(value => `<option value="${escapeHtml(value)}"></option>`).join('')}</datalist><label>Security<select data-config="security"><option ${cfg.security === 'WPA2' ? 'selected' : ''}>WPA2</option><option ${cfg.security === 'WPA3' ? 'selected' : ''}>WPA3</option><option ${cfg.security === 'Open' ? 'selected' : ''}>Open</option></select></label><label>Band<select data-config="band"><option value="dual" ${cfg.band === 'dual' ? 'selected' : ''}>Dual band</option><option value="2.4" ${cfg.band === '2.4' ? 'selected' : ''}>2.4 GHz</option><option value="5" ${cfg.band === '5' ? 'selected' : ''}>5 GHz</option></select></label><div class="network-config-grid"><label>Channel<select data-config="channel">${[1,6,11,36,40,44,48,149,153,157,161].map(value => `<option value="${value}" ${Number(cfg.channel) === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label>Range<input data-config="range" type="range" min="40" max="500" step="10" value="${Number(cfg.range) || 280}"></label></div><label>Wi-Fi password<input data-config="wifi_password" value="${escapeHtml(cfg.wifi_password || '')}"></label>`);
    if (['laptop', 'phone'].includes(device.type)) sections.push(`<h4>Wireless client</h4><label>SSID<select data-config="ssid">${optionSet(suggestions.ssids, cfg.ssid || '', value => value, 'Not connected')}</select></label><label>Preferred band<select data-config="wifi_band"><option value="auto" ${cfg.wifi_band === 'auto' ? 'selected' : ''}>Automatic</option><option value="2.4" ${cfg.wifi_band === '2.4' ? 'selected' : ''}>2.4 GHz</option><option value="5" ${cfg.wifi_band === '5' ? 'selected' : ''}>5 GHz</option></select></label><label>Wi-Fi password<input data-config="wifi_password" value="${escapeHtml(cfg.wifi_password || '')}"></label>`);
    sections.push(`<button class="btn secondary network-reset-device" id="networkResetDeviceBtn" type="button">Reset ${escapeHtml(LABELS[device.type] || 'device')} settings</button>`);
    sections.push('</form>');
    $('networkInspector').innerHTML = sections.join('');
    labelInspectorSections($('networkConfigForm'));
    prepareDirectAddressInputs($('networkConfigForm'));
    Object.entries(previousSections).forEach(([key, open]) => {
      const section = $('networkConfigForm')?.querySelector(`details[data-network-section="${CSS.escape(key)}"]`);
      if (section) section.open = open;
    });
    bindInspector(device);
    window.dispatchEvent(new CustomEvent('network-sim:inspector-rendered', { detail: { device } }));
  }
  function renderSwitchingConfig(device, suggestions) {
    const cfg = device.config || {}, ports = DEVICE_PORTS[device.type] || [];
    const vlans = orderedNumbers([1, ...(cfg.vlans || []), ...Object.values(cfg.port_vlans || {}), ...(cfg.trunk_vlans || [])].filter(value => value >= 1 && value <= 4094));
    const addChoices = suggestions.vlans.filter(value => !vlans.includes(value));
    const chips = vlans.map(value => `<span class="network-vlan-chip">VLAN ${value}<button type="button" data-remove-vlan="${value}" ${value === 1 ? 'disabled' : ''} aria-label="Remove VLAN ${value}">×</button></span>`).join('');
    const rows = ports.map(port => {
      const trunk = (cfg.trunk_ports || []).includes(port), accessVlan = Number(cfg.port_vlans?.[port]) || 1;
      return `<div class="network-switch-port-row" data-switch-port="${escapeHtml(port)}"><strong>${escapeHtml(port)}</strong><label>Mode<select data-switch-port-mode="${escapeHtml(port)}"><option value="access" ${!trunk ? 'selected' : ''}>Access</option><option value="trunk" ${trunk ? 'selected' : ''}>Trunk</option></select></label><label>Access VLAN<select data-switch-port-vlan="${escapeHtml(port)}" ${trunk ? 'disabled' : ''}>${optionSet(vlans, accessVlan, value => `VLAN ${value}`)}</select></label></div>`;
    }).join('');
    const allowed = vlans.map(value => `<label class="network-check-chip"><input type="checkbox" data-trunk-vlan="${value}" ${(cfg.trunk_vlans || []).map(Number).includes(value) ? 'checked' : ''}><span>VLAN ${value}</span></label>`).join('');
    return `<div class="network-vlan-manager"><div class="network-vlan-chips">${chips}</div><div class="network-vlan-add"><select id="networkVlanQuickAdd"><option value="">Choose suggested VLAN…</option>${addChoices.map(value => `<option value="${value}">VLAN ${value}</option>`).join('')}</select><span>or</span><input id="networkCustomVlan" type="number" min="2" max="4094" inputmode="numeric" placeholder="Custom ID"><button class="btn secondary" id="networkAddVlanBtn" type="button">Add VLAN</button></div></div><div class="network-switch-port-grid">${rows}</div><div class="network-field-group"><strong>VLANs allowed on trunk ports</strong><small>Leave all unselected to allow every configured VLAN.</small><div class="network-config-checks">${allowed}</div></div>`;
  }
  function renderRoutes(routes) {
    const rows = routes.length ? routes.map((route, index) => `<div class="network-route-row" data-route-row="${index}"><label>Destination network<input data-route-field="network" list="networkRouteChoices" value="${escapeHtml(route.network || '')}" placeholder="10.20.0.0/16"></label><label>Next-hop gateway<input data-route-field="gateway" value="${escapeHtml(route.gateway || '')}" placeholder="10.10.0.2"></label><button class="network-icon-button" type="button" data-remove-route="${index}" aria-label="Remove static route">×</button></div>`).join('') : '<div class="network-objectives-empty">No static routes. Directly connected networks are still reachable.</div>';
    return `<details class="network-config-section" data-network-section="routes"><summary>Static routes <span>${routes.length} configured</span></summary><div class="network-route-list">${rows}</div><button class="btn secondary" id="networkAddRouteBtn" type="button">＋ Add static route</button></details>`;
  }
  function renderFirewallInterfaces(device, suggestions) {
    const interfaces = device.config?.interfaces || [], physical = DEVICE_PORTS.firewall;
    const rows = interfaces.length ? interfaces.map((iface, index) => `<section class="network-interface-card" data-firewall-interface="${index}"><header><strong>${escapeHtml(iface.name || `Interface ${index + 1}`)}</strong><button class="network-icon-button" type="button" data-remove-firewall-interface="${index}" aria-label="Remove interface">×</button></header><div class="network-config-grid"><label>Physical port<select data-firewall-interface-field="name">${optionSet(physical, String(iface.name || '').toUpperCase(), value => value)}</select></label><label>IPv4 address<input data-firewall-interface-field="ip" value="${escapeHtml(iface.ip || '')}"></label><label>Subnet mask<input data-firewall-interface-field="mask" list="networkMasks" value="${escapeHtml(iface.mask || '255.255.255.0')}"></label><label>VLAN<select data-firewall-interface-field="vlan">${optionSet(suggestions.vlans, Number(iface.vlan) || 1, value => `VLAN ${value}`)}</select></label></div></section>`).join('') : '<div class="network-objectives-empty">No Layer 3 interfaces. Add one and assign it to a physical port.</div>';
    return `<div class="network-firewall-interface-list">${rows}</div><button class="btn secondary" id="networkAddFirewallInterfaceBtn" type="button">＋ Add interface</button>`;
  }
  function renderFirewallRules(rules) {
    if (!rules.length) return '<div class="network-objectives-empty">No rules. Traffic through this firewall is blocked by default.</div>';
    return rules.map((rule, index) => `<div class="network-config-grid" data-rule-row="${index}">
      <label>Action<select data-rule-field="action"><option value="allow" ${rule.action === 'allow' ? 'selected' : ''}>Allow</option><option value="deny" ${rule.action === 'deny' ? 'selected' : ''}>Deny</option></select></label>
      <label>Protocol<select data-rule-field="protocol"><option value="tcp" ${rule.protocol === 'tcp' ? 'selected' : ''}>TCP</option><option value="udp" ${rule.protocol === 'udp' ? 'selected' : ''}>UDP</option><option value="icmp" ${rule.protocol === 'icmp' ? 'selected' : ''}>ICMP</option><option value="any" ${rule.protocol === 'any' ? 'selected' : ''}>Any</option></select></label>
      <label>Port<input type="number" min="1" max="65535" list="networkPortChoices" data-rule-field="port" value="${Number(rule.port) > 0 ? Number(rule.port) : ''}" placeholder="Any"></label><div class="network-rule-actions"><button class="network-icon-button" type="button" data-rule-move="up" ${index === 0 ? 'disabled' : ''} aria-label="Move firewall rule up">↑</button><button class="network-icon-button" type="button" data-rule-move="down" ${index === rules.length - 1 ? 'disabled' : ''} aria-label="Move firewall rule down">↓</button><button class="btn secondary" type="button" data-remove-rule="${index}">Remove</button></div>
    </div>`).join('');
  }
  function renderDnsRecords(records) {
    if (!records.length) return '<div class="network-objectives-empty">No DNS records. Add an A, CNAME, or NS record.</div>';
    return records.map((record, index) => `<div class="network-dns-record" data-dns-record="${index}"><label>Name<input data-dns-record-field="name" list="networkDomainChoices" value="${escapeHtml(record.name || '')}" placeholder="www.school.test"></label><label>Type<select data-dns-record-field="type"><option ${record.type === 'A' ? 'selected' : ''}>A</option><option ${record.type === 'CNAME' ? 'selected' : ''}>CNAME</option><option ${record.type === 'NS' ? 'selected' : ''}>NS</option></select></label><label>Answer / server<input data-dns-record-field="value" value="${escapeHtml(record.value || '')}" placeholder="192.168.1.20"></label><label>TTL<select data-dns-record-field="ttl">${optionSet(DNS_TTLS, Number(record.ttl) || 300, value => `${value} seconds`)}</select></label><button class="network-icon-button" type="button" data-remove-dns-record="${index}" aria-label="Remove DNS record">×</button></div>`).join('');
  }
  function renderServerInterfaces(device) {
    return DEVICE_PORTS.server.map(port => {
      const iface = device.config?.server_interfaces?.[port] || { ip: '', mask: '255.255.255.0' };
      const peer = portPeer(device.id, port);
      return `<section class="network-interface-card"><header><strong>${escapeHtml(port)}</strong><span>${peer ? `${escapeHtml(peer.device?.name || 'Connected')} · ${linkIsUp(peer.link) ? 'link up' : 'link down'}` : 'not connected'}</span></header><div class="network-config-grid"><label>IPv4 address<input data-server-interface="${escapeHtml(port)}" data-server-interface-field="ip" value="${escapeHtml(iface.ip || '')}" placeholder="192.168.1.10"></label><label>Subnet mask<input data-server-interface="${escapeHtml(port)}" data-server-interface-field="mask" list="networkMasks" value="${escapeHtml(iface.mask || '255.255.255.0')}"></label></div></section>`;
    }).join('');
  }
  function renderRouterInterfaces(device, suggestions) {
    return DEVICE_PORTS.router.filter(port => port !== 'WAN').map(port => {
      const iface = (device.config?.interfaces || []).find(item => item.name === port) || { name: port, ip: '', mask: '255.255.255.0', vlan: 1 };
      const peer = portPeer(device.id, port);
      return `<section class="network-interface-card"><header><strong>${escapeHtml(port)}</strong><span>${peer ? `${escapeHtml(peer.device?.name || 'Connected')} · ${linkIsUp(peer.link) ? 'link up' : 'link down'}` : 'not connected'}</span></header><div class="network-config-grid"><label>Gateway IPv4<input data-router-interface="${escapeHtml(port)}" data-router-interface-field="ip" value="${escapeHtml(iface.ip || '')}" placeholder="192.168.1.1"></label><label>Subnet mask<input data-router-interface="${escapeHtml(port)}" data-router-interface-field="mask" list="networkMasks" value="${escapeHtml(iface.mask || '255.255.255.0')}"></label><label>VLAN<select data-router-interface="${escapeHtml(port)}" data-router-interface-field="vlan">${optionSet(suggestions.vlans, Number(iface.vlan) || 1, value => `VLAN ${value}`)}</select></label></div></section>`;
    }).join('');
  }
  function renderSvis(svis, suggestions) {
    if (!svis.length) return '<div class="network-objectives-empty">No VLAN interfaces. Add an SVI to make the switch a gateway for that VLAN.</div>';
    return svis.map((svi, index) => `<section class="network-interface-card" data-svi-row="${index}"><header><strong>VLAN ${Number(svi.vlan) || 1} interface</strong><button class="network-icon-button" type="button" data-remove-svi="${index}" aria-label="Remove VLAN interface">×</button></header><div class="network-config-grid"><label>VLAN ID<select data-svi-field="vlan">${optionSet(suggestions.vlans, Number(svi.vlan) || 1, value => `VLAN ${value}`)}</select></label><label>Gateway IPv4<input data-svi-field="ip" value="${escapeHtml(svi.ip || '')}" placeholder="192.168.20.1"></label><label>Subnet mask<input data-svi-field="mask" list="networkMasks" value="${escapeHtml(svi.mask || '255.255.255.0')}"></label></div></section>`).join('');
  }
  function renderAclRules(device) {
    const rules = device.config?.acl_rules || [];
    if (!rules.length) return '<div class="network-objectives-empty">No ACL rules. Routed traffic is permitted unless implicit deny is enabled.</div>';
    const sviInterfaces = device.type === 'l3switch' ? (device.config?.svis || []).map(svi => `VLAN${Number(svi.vlan) || 1}`) : [];
    const interfaces = [...new Set(['any', ...sviInterfaces, ...(DEVICE_PORTS[device.type] || [])])];
    return rules.map((rule, index) => `<section class="network-acl-rule" data-acl-row="${index}"><header><strong>Rule ${index + 1}</strong><div><button type="button" class="network-icon-button" data-acl-move="up" ${index === 0 ? 'disabled' : ''} aria-label="Move rule up">↑</button><button type="button" class="network-icon-button" data-acl-move="down" ${index === rules.length - 1 ? 'disabled' : ''} aria-label="Move rule down">↓</button><button type="button" class="network-icon-button" data-remove-acl="${index}" aria-label="Remove ACL rule">×</button></div></header><div class="network-config-grid"><label>Action<select data-acl-field="action"><option value="allow" ${rule.action === 'allow' ? 'selected' : ''}>Permit</option><option value="deny" ${rule.action !== 'allow' ? 'selected' : ''}>Deny</option></select></label><label>Protocol<select data-acl-field="protocol">${['any', 'icmp', 'tcp', 'udp'].map(value => `<option value="${value}" ${rule.protocol === value ? 'selected' : ''}>${value.toUpperCase()}</option>`).join('')}</select></label><label>Source network<input data-acl-field="source" list="networkCidrChoices" value="${escapeHtml(rule.source || 'any')}" placeholder="192.168.20.0/24 or any"></label><label>Destination network<input data-acl-field="destination" list="networkCidrChoices" value="${escapeHtml(rule.destination || 'any')}" placeholder="192.168.30.0/24 or any"></label><label>Destination port<input type="number" min="1" max="65535" list="networkPortChoices" data-acl-field="port" value="${Number(rule.port) > 0 ? Number(rule.port) : ''}" placeholder="Any"></label><label>Interface<select data-acl-field="interface">${interfaces.map(value => `<option value="${escapeHtml(value)}" ${rule.interface === value ? 'selected' : ''}>${value === 'any' ? 'Any interface' : escapeHtml(value)}</option>`).join('')}</select></label><label>Direction<select data-acl-field="direction"><option value="in" ${rule.direction === 'in' ? 'selected' : ''}>Inbound</option><option value="out" ${rule.direction === 'out' ? 'selected' : ''}>Outbound</option><option value="both" ${rule.direction === 'both' ? 'selected' : ''}>Both</option></select></label></div></section>`).join('');
  }
  function renderPhysicalPorts(device) {
    const rows = (DEVICE_PORTS[device.type] || []).map(port => {
      const settings = device.config?.ports?.[port] || { enabled: true, speed: '1 Gbps' };
      const peer = portPeer(device.id, port);
      const speeds = portSpeedOptions(device, port);
      return `<div class="network-port-row ${settings.enabled === false ? 'is-disabled' : ''}"><div><strong>${escapeHtml(port)}</strong><span>${peer ? `${escapeHtml(peer.device?.name || 'Unknown')} · ${escapeHtml(peer.port)} · ${escapeHtml(peer.link?.kind || 'ethernet')}` : `Available · ${escapeHtml(portMedia(device, port).join('/'))}`}</span></div><label title="Enable or disable this physical port"><input type="checkbox" data-port-name="${escapeHtml(port)}" data-port-setting="enabled" ${settings.enabled !== false ? 'checked' : ''}><span>${settings.enabled !== false ? (peer ? 'Up' : 'On') : 'Off'}</span></label><select data-port-name="${escapeHtml(port)}" data-port-setting="speed" aria-label="${escapeHtml(port)} speed">${speeds.map(speed => `<option ${settings.speed === speed ? 'selected' : ''}>${speed}</option>`).join('')}</select></div>`;
    }).join('');
    return `<details class="network-config-section" data-network-section="ports" open><summary>Physical ports <span>${usedPorts(device.id).size}/${(DEVICE_PORTS[device.type] || []).length} connected</span></summary><div class="network-port-list">${rows}</div></details>`;
  }
  function bindInspector(device) {
    const form = $('networkConfigForm');
    form?.querySelectorAll('[data-device-name],[data-config],[data-config-list],[data-port-vlans],[data-trunk-ports],[data-interfaces],[data-routes],[data-addressing-mode],[data-dns-servers],[data-wan-mode],[data-wan-dns],[data-dns-forwarders]').forEach(input => input.addEventListener('change', () => {
      const changingMode = input.hasAttribute('data-addressing-mode');
      const changingWanMode = input.hasAttribute('data-wan-mode');
      const reconnectDhcp = isDhcpClient(device) && ['vlan', 'ssid', 'wifi_password', 'enabled'].includes(input.dataset.config || '');
      mutate(() => {
        if (input.hasAttribute('data-device-name')) device.name = input.value.trim() || LABELS[device.type];
        else if (changingMode) {
          const mode = input.value === 'dhcp' ? 'dhcp' : 'static';
          device.config.addressing_mode = mode;
          device.config.dhcp = mode === 'dhcp';
          if (mode === 'dhcp') clearDhcpLease(device);
          else {
            device.config.dhcp_state = 'static';
            ['dhcp_server_id', 'dhcp_server_name', 'dhcp_domain', 'dhcp_lease_obtained_at', 'dhcp_lease_expires_at'].forEach(key => delete device.config[key]);
          }
        } else if (changingWanMode) {
          device.config.wan_mode = input.value === 'static' ? 'static' : 'dhcp';
          if (device.config.wan_mode === 'dhcp') clearWanLease(device);
          else {
            device.config.wan_state = portPeer(device.id, 'WAN') && device.config.wan_ip ? 'connected' : 'disconnected';
            ['wan_dhcp_server_id', 'wan_lease_obtained_at', 'wan_lease_expires_at'].forEach(key => delete device.config[key]);
          }
        } else if (input.hasAttribute('data-dns-servers')) device.config.dns_servers = input.value.split(',').map(item => item.trim()).filter(Boolean).slice(0, 4);
        else if (input.hasAttribute('data-wan-dns')) device.config.wan_dns_servers = input.value.split(',').map(item => item.trim()).filter(Boolean).slice(0, 4);
        else if (input.hasAttribute('data-dns-forwarders')) device.config.dns_forwarders = input.value.split(',').map(item => item.trim()).filter(Boolean).slice(0, 8);
        else if (input.dataset.config) {
          let value = input.type === 'checkbox' ? input.checked : input.value.trim();
          if (input.dataset.valueType === 'vlan') value = Math.max(1, Math.min(4094, Number(value) || 1));
          if (input.dataset.valueType === 'integer') value = Math.max(Number(input.dataset.numberMin) || 0, Math.min(Number(input.dataset.numberMax) || Number.MAX_SAFE_INTEGER, Math.round(Number(value) || 0)));
          device.config[input.dataset.config] = value;
          if (device.type === 'router' && device.config.wan_mode === 'static' && input.dataset.config.startsWith('wan_')) device.config.wan_state = portPeer(device.id, 'WAN') && ipNumber(device.config.wan_ip) !== null ? 'connected' : 'disconnected';
          if (reconnectDhcp) clearDhcpLease(device);
        } else if (input.dataset.configList) device.config[input.dataset.configList] = input.value.split(',').map(item => Number(item.trim())).filter(item => item >= 1 && item <= 4094);
        else if (input.hasAttribute('data-trunk-ports')) device.config.trunk_ports = input.value.split(',').map(item => item.trim()).filter(port => (DEVICE_PORTS[device.type] || []).includes(port));
        else if (input.hasAttribute('data-port-vlans')) {
          const ports = {};
          input.value.split(/\r?\n/).forEach(line => {
            const [port, vlanText] = line.split('=').map(item => item.trim());
            const vlan = Number(vlanText);
            if ((DEVICE_PORTS[device.type] || []).includes(port) && Number.isInteger(vlan) && vlan >= 1 && vlan <= 4094) ports[port] = vlan;
          });
          device.config.port_vlans = ports;
        } else if (input.hasAttribute('data-interfaces')) device.config.interfaces = parseInterfaces(input.value);
        else if (input.hasAttribute('data-routes')) device.config.routes = parseRoutes(input.value);
      }, changingMode ? `${device.name} switched to ${input.value === 'dhcp' ? 'Automatic (DHCP)' : 'Manual (Static)'} addressing.` : changingWanMode ? `${device.name} WAN switched to ${input.value === 'dhcp' ? 'Automatic (ISP DHCP)' : 'Manual (Static)'}.` : `Updated ${device.name}.`, { inspector: changingMode || changingWanMode || reconnectDhcp });
      if (changingMode && input.value === 'dhcp') setTimeout(() => requestDhcpLease(device.id), 0);
      else if (changingWanMode && input.value === 'dhcp') setTimeout(() => requestWanLease(device.id), 0);
      else if (reconnectDhcp && device.config.enabled !== false) setTimeout(() => requestDhcpLease(device.id, { quiet: true }), 0);
      if (device.type === 'router') setTimeout(() => autoAssignDhcpLeases({ renewAll: true }), 0);
      if (device.type === 'router' && device.config.wan_mode === 'dhcp') setTimeout(() => autoAssignWanLeases({ renewAll: true }), 0);
      if (device.type === 'cloud') setTimeout(() => autoAssignWanLeases({ renewAll: true }), 0);
      if (input.hasAttribute('data-dns-forwarders') || input.hasAttribute('data-dns-servers') || input.dataset.config === 'dns_recursion') state.dnsCache.clear();
    }));
    form?.querySelectorAll('[data-address-list]').forEach(input => input.addEventListener('change', () => {
      const key = input.dataset.addressList, index = Number(input.dataset.addressIndex);
      mutate(() => {
        const values = [...(device.config[key] || [])];
        values[index] = input.value.trim();
        device.config[key] = values.filter(Boolean).slice(0, key === 'dns_forwarders' ? 8 : 4);
      }, `Updated resolver settings on ${device.name}.`, { inspector: true });
      state.dnsCache.clear();
    }));
    form?.querySelectorAll('[data-switch-port-mode]').forEach(input => input.addEventListener('change', () => {
      const port = input.dataset.switchPortMode;
      mutate(() => {
        const trunks = new Set(device.config.trunk_ports || []);
        input.value === 'trunk' ? trunks.add(port) : trunks.delete(port);
        device.config.trunk_ports = [...trunks].filter(value => (DEVICE_PORTS[device.type] || []).includes(value));
        if (input.value === 'access' && !device.config.port_vlans?.[port]) (device.config.port_vlans ||= {})[port] = 1;
      }, `${device.name} ${port} set to ${input.value} mode.`, { inspector: true });
    }));
    form?.querySelectorAll('[data-switch-port-vlan]').forEach(input => input.addEventListener('change', () => {
      const port = input.dataset.switchPortVlan;
      mutate(() => { (device.config.port_vlans ||= {})[port] = Math.max(1, Math.min(4094, Number(input.value) || 1)); }, `${device.name} ${port} assigned to VLAN ${input.value}.`, { inspector: false });
    }));
    form?.querySelectorAll('[data-trunk-vlan]').forEach(input => input.addEventListener('change', () => {
      const vlan = Number(input.dataset.trunkVlan);
      mutate(() => {
        const allowed = new Set((device.config.trunk_vlans || []).map(Number));
        input.checked ? allowed.add(vlan) : allowed.delete(vlan);
        device.config.trunk_vlans = orderedNumbers([...allowed]);
      }, `VLAN ${vlan} ${input.checked ? 'allowed' : 'removed'} on ${device.name} trunks.`, { inspector: false });
    }));
    form?.querySelectorAll('[data-remove-vlan]').forEach(button => button.addEventListener('click', () => {
      const vlan = Number(button.dataset.removeVlan);
      if (vlan === 1) return;
      mutate(() => {
        device.config.vlans = (device.config.vlans || []).map(Number).filter(value => value !== vlan);
        device.config.trunk_vlans = (device.config.trunk_vlans || []).map(Number).filter(value => value !== vlan);
        Object.entries(device.config.port_vlans || {}).forEach(([port, value]) => { if (Number(value) === vlan) device.config.port_vlans[port] = 1; });
      }, `Removed VLAN ${vlan} from ${device.name}.`);
    }));
    $('networkAddVlanBtn')?.addEventListener('click', () => {
      const selected = Number($('networkVlanQuickAdd')?.value), custom = Number($('networkCustomVlan')?.value), vlan = custom || selected;
      if (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094) return alert('Choose a suggested VLAN or enter a custom VLAN ID from 1 to 4094.');
      mutate(() => { device.config.vlans = orderedNumbers([...(device.config.vlans || []), vlan]); }, `Added VLAN ${vlan} to ${device.name}.`);
    });
    form?.querySelectorAll('[data-route-field]').forEach(input => input.addEventListener('change', () => {
      const index = Number(input.closest('[data-route-row]').dataset.routeRow), field = input.dataset.routeField;
      mutate(() => { device.config.routes[index][field] = input.value.trim(); }, `Updated static route on ${device.name}.`, { inspector: false });
    }));
    form?.querySelectorAll('[data-remove-route]').forEach(button => button.addEventListener('click', () => mutate(() => device.config.routes.splice(Number(button.dataset.removeRoute), 1), `Removed static route from ${device.name}.`)));
    $('networkAddRouteBtn')?.addEventListener('click', () => mutate(() => (device.config.routes ||= []).push({ network: '', gateway: '' }), `Added static route to ${device.name}.`));
    form?.querySelectorAll('[data-firewall-interface-field]').forEach(input => input.addEventListener('change', () => {
      const index = Number(input.closest('[data-firewall-interface]').dataset.firewallInterface), field = input.dataset.firewallInterfaceField;
      mutate(() => { device.config.interfaces[index][field] = field === 'vlan' ? Math.max(1, Math.min(4094, Number(input.value) || 1)) : input.value.trim(); }, `Updated ${device.name} interface.`, { inspector: field === 'name' });
    }));
    form?.querySelectorAll('[data-remove-firewall-interface]').forEach(button => button.addEventListener('click', () => mutate(() => device.config.interfaces.splice(Number(button.dataset.removeFirewallInterface), 1), `Removed interface from ${device.name}.`)));
    $('networkAddFirewallInterfaceBtn')?.addEventListener('click', () => mutate(() => {
      const used = new Set((device.config.interfaces || []).map(item => String(item.name || '').toUpperCase()));
      const name = DEVICE_PORTS.firewall.find(port => !used.has(port)) || 'OPT1';
      (device.config.interfaces ||= []).push({ name, ip: '', mask: '255.255.255.0', vlan: 1 });
    }, `Added interface to ${device.name}.`));
    form?.querySelectorAll('[data-service]').forEach(input => input.addEventListener('change', () => {
      mutate(() => {
        const services = new Set(device.config.services || []);
        input.checked ? services.add(input.dataset.service) : services.delete(input.dataset.service);
        device.config.services = [...services];
      }, `${input.dataset.service.toUpperCase()} ${input.checked ? 'enabled' : 'disabled'} on ${device.name}.`, { inspector: input.dataset.service === 'dns' });
      if (input.dataset.service === 'dns') state.dnsCache.clear();
    }));
    form?.querySelectorAll('[data-server-interface-field]').forEach(input => input.addEventListener('change', () => {
      const port = input.dataset.serverInterface, field = input.dataset.serverInterfaceField;
      mutate(() => {
        const iface = device.config.server_interfaces[port] ||= { ip: '', mask: '255.255.255.0' };
        iface[field] = input.value.trim();
        if (port === 'LAN1') { device.config.ip = iface.ip; device.config.mask = iface.mask; }
      }, `Updated ${device.name} ${port} IPv4 configuration.`, { inspector: false });
      state.dnsCache.clear();
    }));
    form?.querySelectorAll('[data-router-interface-field]').forEach(input => input.addEventListener('change', () => {
      const port = input.dataset.routerInterface, field = input.dataset.routerInterfaceField;
      mutate(() => {
        const iface = device.config.interfaces.find(item => item.name === port);
        if (!iface) return;
        iface[field] = field === 'vlan' ? Math.max(1, Math.min(4094, Number(input.value) || 1)) : input.value.trim();
        if (port === 'LAN1') { device.config.ip = iface.ip; device.config.mask = iface.mask; }
        if (port === device.config.dhcp_interface) {
          device.config.dhcp_gateway = iface.ip;
          device.config.dhcp_mask = iface.mask;
          device.config.dhcp_vlan = iface.vlan;
        }
      }, `Updated ${device.name} ${port}.`, { inspector: true });
      setTimeout(() => autoAssignDhcpLeases({ renewAll: true }), 0);
    }));
    form?.querySelectorAll('[data-dhcp-interface]').forEach(input => input.addEventListener('change', () => {
      mutate(() => {
        device.config.dhcp_interface = input.value;
        const iface = device.config.interfaces.find(item => item.name === input.value) || {};
        device.config.dhcp_gateway = iface.ip || '';
        device.config.dhcp_mask = iface.mask || '255.255.255.0';
        device.config.dhcp_vlan = Number(iface.vlan) || 1;
      }, `${device.name} DHCP service bound to ${input.value}.`, { inspector: true });
      setTimeout(() => autoAssignDhcpLeases({ renewAll: true }), 0);
    }));
    form?.querySelectorAll('[data-svi-field]').forEach(input => input.addEventListener('change', () => {
      const index = Number(input.closest('[data-svi-row]').dataset.sviRow), field = input.dataset.sviField;
      mutate(() => { device.config.svis[index][field] = field === 'vlan' ? Math.max(1, Math.min(4094, Number(input.value) || 1)) : input.value.trim(); }, `Updated ${device.name} VLAN interface.`, { inspector: true });
    }));
    form?.querySelectorAll('[data-remove-svi]').forEach(button => button.addEventListener('click', () => mutate(() => device.config.svis.splice(Number(button.dataset.removeSvi), 1), `Removed VLAN interface from ${device.name}.`)));
    $('networkAddSviBtn')?.addEventListener('click', () => mutate(() => (device.config.svis ||= []).push({ vlan: 1, ip: '', mask: '255.255.255.0' }), `Added VLAN interface to ${device.name}.`));
    form?.querySelectorAll('[data-acl-field]').forEach(input => input.addEventListener('change', () => {
      const index = Number(input.closest('[data-acl-row]').dataset.aclRow), field = input.dataset.aclField;
      mutate(() => { device.config.acl_rules[index][field] = field === 'port' ? (Number(input.value) || -1) : input.value.trim(); }, `Updated ACL rule on ${device.name}.`, { inspector: false });
    }));
    form?.querySelectorAll('[data-remove-acl]').forEach(button => button.addEventListener('click', () => mutate(() => device.config.acl_rules.splice(Number(button.dataset.removeAcl), 1), `Removed ACL rule from ${device.name}.`)));
    form?.querySelectorAll('[data-acl-move]').forEach(button => button.addEventListener('click', () => {
      const index = Number(button.closest('[data-acl-row]').dataset.aclRow), next = button.dataset.aclMove === 'up' ? index - 1 : index + 1;
      if (next < 0 || next >= device.config.acl_rules.length) return;
      mutate(() => { const [rule] = device.config.acl_rules.splice(index, 1); device.config.acl_rules.splice(next, 0, rule); }, `Reordered ACL rules on ${device.name}.`);
    }));
    $('networkAddAclRuleBtn')?.addEventListener('click', () => mutate(() => (device.config.acl_rules ||= []).push(normalizeAclRule()), `Added ACL rule to ${device.name}.`));
    form?.querySelectorAll('[data-dns-record-field]').forEach(input => input.addEventListener('change', () => {
      const index = Number(input.closest('[data-dns-record]').dataset.dnsRecord), field = input.dataset.dnsRecordField;
      mutate(() => { device.config.dns_records[index][field] = field === 'ttl' ? Math.max(30, Math.min(86400, Number(input.value) || 300)) : field === 'type' ? input.value : input.value.trim().toLowerCase(); }, `Updated DNS record on ${device.name}.`, { inspector: false });
      state.dnsCache.clear();
    }));
    form?.querySelectorAll('[data-remove-dns-record]').forEach(button => button.addEventListener('click', () => { mutate(() => device.config.dns_records.splice(Number(button.dataset.removeDnsRecord), 1), `Removed DNS record from ${device.name}.`); state.dnsCache.clear(); }));
    $('networkAddDnsRecordBtn')?.addEventListener('click', () => mutate(() => device.config.dns_records.push({ name: '', type: 'A', value: '', ttl: 300 }), `Added DNS record to ${device.name}.`));
    form?.querySelectorAll('[data-port-setting]').forEach(input => input.addEventListener('change', () => {
      const port = input.dataset.portName, setting = input.dataset.portSetting;
      const peer = portPeer(device.id, port);
      mutate(() => {
        device.config.ports[port][setting] = setting === 'enabled' ? input.checked : input.value;
        if (setting === 'enabled' && !input.checked) {
          if (device.type === 'router' && port === 'WAN') disconnectWan(device);
          if (peer?.device?.type === 'router' && peer.port === 'WAN') disconnectWan(peer.device);
        }
      }, `${device.name} ${port} ${setting === 'enabled' ? (input.checked ? 'enabled' : 'disabled') : `set to ${input.value}`}.`);
      if (setting === 'enabled' && input.checked) setTimeout(() => { autoAssignDhcpLeases({ renewAll: true }); autoAssignWanLeases({ renewAll: true }); }, 0);
    }));
    form?.querySelectorAll('[data-rule-field]').forEach(input => input.addEventListener('change', () => mutate(() => {
      const index = Number(input.closest('[data-rule-row]').dataset.ruleRow);
      const rule = device.config.firewall_rules[index];
      rule[input.dataset.ruleField] = input.dataset.ruleField === 'port' ? (Number(input.value) || -1) : input.value;
    }, `Updated firewall rule on ${device.name}.`, { inspector: false })));
    form?.querySelectorAll('[data-remove-rule]').forEach(button => button.addEventListener('click', () => mutate(() => device.config.firewall_rules.splice(Number(button.dataset.removeRule), 1), `Removed firewall rule from ${device.name}.`)));
    form?.querySelectorAll('[data-rule-move]').forEach(button => button.addEventListener('click', () => {
      const index = Number(button.closest('[data-rule-row]').dataset.ruleRow), next = button.dataset.ruleMove === 'up' ? index - 1 : index + 1;
      if (next < 0 || next >= device.config.firewall_rules.length) return;
      mutate(() => { const [rule] = device.config.firewall_rules.splice(index, 1); device.config.firewall_rules.splice(next, 0, rule); }, `Reordered firewall rules on ${device.name}.`);
    }));
    $('networkAddFirewallRule')?.addEventListener('click', () => mutate(() => (device.config.firewall_rules ||= []).push({ action: 'allow', protocol: 'tcp', port: 443 }), `Added firewall rule to ${device.name}.`));
    $('networkDhcpRequestBtn')?.addEventListener('click', () => requestDhcpLease(device.id, { showPacket: true }));
    $('networkDhcpReleaseBtn')?.addEventListener('click', () => releaseDhcpLease(device.id));
    $('networkDhcpQuickFillBtn')?.addEventListener('click', () => suggestDhcpConfig(device));
    $('networkWanRequestBtn')?.addEventListener('click', () => requestWanLease(device.id));
    $('networkWanReleaseBtn')?.addEventListener('click', () => releaseWanLease(device.id));
    $('networkResetDeviceBtn')?.addEventListener('click', () => {
      if (!confirm(`Reset all settings on ${device.name}? Cables will remain connected.`)) return;
      mutate(() => { device.config = defaultConfig(device.type); normalizeDeviceConfig(device); }, `Reset ${device.name} to default settings.`);
      state.dnsCache.clear();
      setTimeout(() => { autoAssignDhcpLeases({ renewAll: true }); autoAssignWanLeases({ renewAll: true }); }, 0);
    });
  }
  function parseInterfaces(text) {
    return text.split(/\r?\n/).map(line => line.split(',').map(item => item.trim())).filter(parts => parts[0] && parts[1]).map(parts => ({ name: parts[0], ip: parts[1], mask: parts[2] || '255.255.255.0', ...(Number(parts[3]) ? { vlan: Number(parts[3]) } : {}) }));
  }
  function parseRoutes(text) {
    return text.split(/\r?\n/).map(line => line.split(/\s+via\s+/i).map(item => item.trim())).filter(parts => parts[0] && parts[1]).map(parts => ({ network: parts[0], gateway: parts[1] }));
  }

  function graphData() {
    if (state.graphCache && state.graphCacheRevision === state.topologyRevision) return state.graphCache;
    const devices = Object.fromEntries(state.topology.devices.map(item => [item.id, item]));
    const graph = Object.fromEntries(state.topology.devices.map(item => [item.id, new Set()]));
    state.topology.links.forEach(link => {
      if (graph[link.source] && graph[link.target] && linkForwards(link)) { graph[link.source].add(link.target); graph[link.target].add(link.source); }
    });
    wirelessAssociations().forEach(item => { graph[item.client.id].add(item.wap.id); graph[item.wap.id].add(item.client.id); });
    state.graphCache = { devices, graph };
    state.graphCacheRevision = state.topologyRevision;
    return state.graphCache;
  }
  function findPath(source, target) {
    const { devices, graph } = graphData();
    if (!devices[source] || !devices[target]) return [];
    const queue = [[source, [source]]], seen = new Set([source]);
    while (queue.length) {
      const [node, path] = queue.shift();
      if (node === target) return path;
      [...(graph[node] || [])].sort().forEach(next => {
        if (!seen.has(next) && devices[next]?.config?.enabled !== false) { seen.add(next); queue.push([next, [...path, next]]); }
      });
    }
    return [];
  }
  function ipNumber(value) {
    const parts = String(value || '').split('.').map(Number);
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    return parts.reduce((sum, part) => ((sum << 8) | part) >>> 0, 0) >>> 0;
  }
  function deviceAddresses(device) {
    if (!device) return [];
    const values = [device.config?.ip];
    if (device.type === 'server') Object.values(device.config?.server_interfaces || {}).forEach(item => values.push(item?.ip));
    (device.config?.interfaces || []).forEach(item => values.push(item?.ip));
    (device.config?.svis || []).forEach(item => values.push(item?.ip));
    if (device.type === 'router') values.push(device.config?.wan_ip);
    return [...new Set(values.filter(value => ipNumber(value) !== null))];
  }
  function primaryDeviceAddress(device) { return deviceAddresses(device)[0] || ''; }
  function deviceByNetworkIp(address) { return state.topology?.devices?.find(device => deviceAddresses(device).includes(address)) || null; }
  function endpointConfigForPath(device, path) {
    const config = device?.config || {};
    if (!Array.isArray(path) || path.length < 2) return config;
    const neighbor = path[0] === device.id ? path[1] : path[path.length - 2];
    const link = linkBetween(device.id, neighbor);
    const port = link ? portForLink(link, device.id) : '';
    if (device?.type === 'router' && port === 'WAN') return { ...config, ip: config.wan_ip || '', mask: config.wan_mask || '255.255.255.0', gateway: config.wan_gateway || '' };
    const iface = device?.type === 'server' ? config.server_interfaces?.[port] : ['router', 'firewall'].includes(device?.type) ? (config.interfaces || []).find(item => String(item.name || '').toUpperCase() === String(port).toUpperCase()) : null;
    return iface?.ip ? { ...config, ip: iface.ip, mask: iface.mask || '255.255.255.0' } : config;
  }
  function sameSubnetConfigs(first, second) {
    const a = ipNumber(first?.ip), b = ipNumber(second?.ip), maskA = ipNumber(first?.mask || '255.255.255.0'), maskB = ipNumber(second?.mask || '255.255.255.0');
    return a !== null && b !== null && maskA !== null && maskB !== null && ((a & maskA) >>> 0) === ((b & maskA) >>> 0) && ((a & maskB) >>> 0) === ((b & maskB) >>> 0);
  }
  function ipInCidr(address, value) {
    const ip = ipNumber(address), text = String(value || 'any').trim().toLowerCase();
    if (ip === null) return false;
    if (!text || text === 'any' || text === '0.0.0.0/0') return true;
    const [networkText, prefixText] = text.split('/');
    const network = ipNumber(networkText), prefix = prefixText === undefined ? 32 : Number(prefixText);
    if (network === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return ((ip & mask) >>> 0) === ((network & mask) >>> 0);
  }
  function validCidr(value) {
    const parts = String(value || '').trim().split('/');
    if (parts.length !== 2 || ipNumber(parts[0]) === null) return false;
    const prefix = Number(parts[1]);
    return Number.isInteger(prefix) && prefix >= 0 && prefix <= 32;
  }
  function routedNetworks(device) {
    const config = device?.config || {};
    const interfaces = [...(config.interfaces || []), ...(config.svis || []), { ip: config.ip, mask: config.mask }, { ip: config.wan_ip, mask: config.wan_mask }];
    return interfaces.map(item => networkCidr(item?.ip, item?.mask)).filter(Boolean);
  }
  function deviceKnowsRoute(device, address) {
    return routedNetworks(device).some(network => ipInCidr(address, network)) || (device?.config?.routes || []).some(route => ipInCidr(address, route?.network));
  }
  function switchPortCarries(device, port, vlan) {
    const config = device?.config || {};
    if ((config.trunk_ports || []).includes(port)) {
      const allowed = config.trunk_vlans?.length ? config.trunk_vlans : config.vlans;
      return (allowed || [1]).map(Number).includes(Number(vlan));
    }
    return Number(config.port_vlans?.[port] || 1) === Number(vlan);
  }
  function aclDecision(device, path, protocol, port, sourceIp, destinationIp) {
    const index = path.indexOf(device.id), previous = path[index - 1], next = path[index + 1];
    const ingressLink = previous ? linkBetween(previous, device.id) : null, egressLink = next ? linkBetween(device.id, next) : null;
    const ingress = ingressLink ? portForLink(ingressLink, device.id) : '', egress = egressLink ? portForLink(egressLink, device.id) : '';
    const sourceVlan = Number(device.config?.port_vlans?.[ingress] || deviceById(path[0])?.config?.vlan || 1);
    const destinationVlan = Number(device.config?.port_vlans?.[egress] || deviceById(path[path.length - 1])?.config?.vlan || 1);
    const ingressInterfaces = new Set([ingress, ...(device.type === 'l3switch' ? [`VLAN${sourceVlan}`] : [])].map(value => String(value).toLowerCase()));
    const egressInterfaces = new Set([egress, ...(device.type === 'l3switch' ? [`VLAN${destinationVlan}`] : [])].map(value => String(value).toLowerCase()));
    const rules = device.config?.acl_rules || [];
    for (let index = 0; index < rules.length; index += 1) {
      const rule = rules[index], ruleProtocol = String(rule.protocol || 'any').toLowerCase(), wantedPort = Number(rule.port) || -1;
      if (!['any', String(protocol).toLowerCase()].includes(ruleProtocol)) continue;
      if (wantedPort > 0 && wantedPort !== Number(port)) continue;
      if (!ipInCidr(sourceIp, rule.source) || !ipInCidr(destinationIp, rule.destination)) continue;
      const iface = String(rule.interface || 'any').toLowerCase(), direction = String(rule.direction || 'both').toLowerCase();
      const interfaceMatches = iface === 'any' || (['in', 'both'].includes(direction) && ingressInterfaces.has(iface)) || (['out', 'both'].includes(direction) && egressInterfaces.has(iface));
      if (!interfaceMatches) continue;
      return { allowed: rule.action === 'allow', matched: true, rule, index, ingress, egress };
    }
    return { allowed: !device.config?.acl_default_deny, matched: false, rule: null, index: -1, ingress, egress };
  }
  function ipString(value) {
    const number = Number(value) >>> 0;
    return [(number >>> 24) & 255, (number >>> 16) & 255, (number >>> 8) & 255, number & 255].join('.');
  }
  function addressingMode(device) {
    const configured = device?.config?.addressing_mode;
    if (configured === 'dhcp' || configured === 'static') return configured;
    return device?.config?.dhcp ? 'dhcp' : 'static';
  }
  function isDhcpClient(device) {
    return !!device && DHCP_CLIENT_TYPES.has(device.type) && addressingMode(device) === 'dhcp';
  }
  function dhcpCandidates(client) {
    if (!client || !state.topology) return [];
    const vlan = Number(client.config?.vlan || 1);
    return state.topology.devices
      .filter(server => server.type === 'router' && server.config?.enabled !== false && server.config?.dhcp_enabled)
      .map(server => ({ server, path: findPath(client.id, server.id) }))
      .filter(item => item.path.length && !item.path.slice(1, -1).some(id => ['router', 'firewall'].includes(deviceById(id)?.type)))
      .filter(item => {
        const previous = item.path[item.path.length - 2], link = linkBetween(previous, item.server.id);
        const incomingPort = link ? portForLink(link, item.server.id) : '';
        return incomingPort && incomingPort !== 'WAN' && incomingPort === (item.server.config?.dhcp_interface || 'LAN1');
      })
      .filter(item => Number(item.server.config?.dhcp_vlan || vlan) === vlan)
      .sort((first, second) => first.path.length - second.path.length || first.server.id.localeCompare(second.server.id));
  }
  function dhcpFailure(client, reason, path = []) {
    return {
      source: client?.id || '', target: '', protocol: 'dhcp', port: null, path,
      allowed: false, reason, layers: { link: 'Ethernet broadcast', source_ip: '0.0.0.0', destination_ip: '255.255.255.255', transport: 'UDP 68 → 67' },
      dhcp: { steps: [{ type: 'DHCPDISCOVER', detail: `${client?.name || 'Client'} broadcast a request.` }, { type: 'NO OFFER', detail: reason }] },
    };
  }
  function assignDhcpLease(clientId) {
    const client = deviceById(clientId);
    if (!client || !DHCP_CLIENT_TYPES.has(client.type)) return dhcpFailure(client, 'The selected device cannot act as a DHCP client.');
    if (client.config?.enabled === false) return dhcpFailure(client, `${client.name} is powered off.`);
    if (!isDhcpClient(client)) return dhcpFailure(client, 'Switch the device to Automatic (DHCP) before requesting a lease.');
    const candidate = dhcpCandidates(client)[0];
    if (!candidate) return dhcpFailure(client, 'No enabled DHCP server answered this broadcast domain.');
    const { server, path } = candidate;
    const start = ipNumber(server.config?.dhcp_start), end = ipNumber(server.config?.dhcp_end);
    if (start === null || end === null || start > end) return dhcpFailure(client, `${server.name} has an invalid DHCP pool.`, path);
    const configuredMask = server.config?.dhcp_mask || '255.255.255.0';
    const mask = ipNumber(configuredMask) === null ? '255.255.255.0' : configuredMask;
    const boundInterface = (server.config?.interfaces || []).find(iface => iface.name === (server.config?.dhcp_interface || 'LAN1')) || {};
    const gateway = server.config?.dhcp_gateway || boundInterface.ip || server.config?.ip || '';
    const gatewayNumber = ipNumber(gateway), maskNumber = ipNumber(mask);
    const networkAddress = gatewayNumber !== null && maskNumber !== null ? (gatewayNumber & maskNumber) >>> 0 : null;
    const broadcastAddress = networkAddress !== null ? (networkAddress | (~maskNumber >>> 0)) >>> 0 : null;
    const usableOffer = address => networkAddress === null || (((address & maskNumber) >>> 0) === networkAddress && address !== networkAddress && address !== broadcastAddress && address !== gatewayNumber);
    const used = new Set();
    state.topology.devices.forEach(device => {
      if (device.id !== client.id && ipNumber(device.config?.ip) !== null) used.add(device.config.ip);
      (device.config?.interfaces || []).forEach(iface => { if (ipNumber(iface?.ip) !== null) used.add(iface.ip); });
      Object.values(device.config?.server_interfaces || {}).forEach(iface => { if (ipNumber(iface?.ip) !== null) used.add(iface.ip); });
    });
    let offer = '';
    const current = ipNumber(client.config?.ip);
    if (client.config?.dhcp_server_id === server.id && current !== null && current >= start && current <= end && usableOffer(current) && !used.has(client.config.ip)) offer = client.config.ip;
    const cappedEnd = Math.min(end, start + 65535);
    for (let address = start; !offer && address <= cappedEnd; address += 1) {
      const value = ipString(address);
      if (usableOffer(address) && !used.has(value)) offer = value;
    }
    if (!offer) return dhcpFailure(client, `${server.name}'s DHCP pool has no available addresses.`, path);
    const interfaces = server.config?.interfaces || [];
    const matchingInterface = interfaces.find(iface => {
      const candidateIp = ipNumber(iface?.ip), offerIp = ipNumber(offer), maskIp = ipNumber(mask);
      return candidateIp !== null && offerIp !== null && maskIp !== null && ((candidateIp & maskIp) >>> 0) === ((offerIp & maskIp) >>> 0);
    })?.ip || '';
    const assignedGateway = gateway || matchingInterface;
    const dns = [server.config?.dhcp_dns_primary, server.config?.dhcp_dns_secondary].filter(value => ipNumber(value) !== null);
    const leaseMinutes = Math.max(1, Math.min(10080, Number(server.config?.dhcp_lease_minutes) || 480));
    const obtained = Date.now();
    Object.assign(client.config, {
      addressing_mode: 'dhcp', dhcp: true, ip: offer, mask, gateway: assignedGateway,
      dns_servers: dns, dhcp_domain: String(server.config?.dhcp_domain || ''),
      dhcp_server_id: server.id, dhcp_server_name: server.name, dhcp_state: 'bound',
      dhcp_lease_obtained_at: obtained, dhcp_lease_expires_at: obtained + leaseMinutes * 60 * 1000,
    });
    return {
      source: client.id, target: server.id, protocol: 'dhcp', port: null, path, allowed: true,
      reason: `${server.name} assigned ${offer} to ${client.name}.`,
      layers: { link: `${pathMediaLabel(path)} broadcast`, source_ip: '0.0.0.0', destination_ip: '255.255.255.255', transport: 'UDP 68 → 67', offered_ip: offer, subnet_mask: mask, gateway: assignedGateway || 'none', dns: dns.join(', ') || 'none', lease: `${leaseMinutes} minutes` },
      dhcp: { server_id: server.id, offered_ip: offer, steps: [
        { type: 'DHCPDISCOVER', detail: `${client.name} broadcast from 0.0.0.0.` },
        { type: 'DHCPOFFER', detail: `${server.name} offered ${offer}.` },
        { type: 'DHCPREQUEST', detail: `${client.name} requested ${offer}.` },
        { type: 'DHCPACK', detail: `${server.name} confirmed the lease, gateway, and DNS options.` },
      ] },
    };
  }
  function clearDhcpLease(device) {
    if (!device) return;
    Object.assign(device.config, { ip: '', gateway: '', dns_servers: [], dhcp_state: 'init' });
    ['dhcp_server_id', 'dhcp_server_name', 'dhcp_domain', 'dhcp_lease_obtained_at', 'dhcp_lease_expires_at'].forEach(key => delete device.config[key]);
  }
  function requestDhcpLease(clientId, { quiet = false, showPacket = false } = {}) {
    const before = snapshot();
    const result = assignDhcpLease(clientId);
    state.lastPacket = result;
    if (result.allowed) {
      remember(before);
      afterMutation(result.reason);
    } else if (!quiet) logEvent(`DHCP failed: ${result.reason}`);
    if (showPacket) renderPacketResult(result);
    return result;
  }
  function releaseDhcpLease(clientId) {
    const client = deviceById(clientId);
    if (!client || !isDhcpClient(client)) return;
    mutate(() => clearDhcpLease(client), `${client.name} released its DHCP lease.`);
  }
  function autoAssignDhcpLeases({ render = true, recordHistory = true, renewAll = false } = {}) {
    if (!state.topology) return [];
    const before = snapshot();
    const results = [];
    state.topology.devices.filter(device => isDhcpClient(device) && (renewAll || !device.config?.ip || Number(device.config?.dhcp_lease_expires_at || 0) <= Date.now())).forEach(device => {
      const result = assignDhcpLease(device.id);
      if (result.allowed) results.push(result);
    });
    if (results.length && recordHistory) remember(before);
    if (results.length && render) afterMutation(`${results.length} DHCP lease${results.length === 1 ? '' : 's'} assigned.`);
    return results;
  }
  function suggestDhcpConfig(router) {
    const iface = router.config?.interfaces?.find(item => item.name === (router.config?.dhcp_interface || 'LAN1'));
    const address = iface?.ip || '';
    const addressNumber = ipNumber(address), mask = iface?.mask || '255.255.255.0', maskNumber = ipNumber(mask);
    if (addressNumber === null || maskNumber === null) return alert(`Set a valid IPv4 address on ${router.config?.dhcp_interface || 'LAN1'} first.`);
    const network = (addressNumber & maskNumber) >>> 0;
    const broadcast = (network | (~maskNumber >>> 0)) >>> 0;
    if (broadcast - network < 3) return alert('This subnet is too small for a DHCP pool.');
    const firstHost = network + 1, lastHost = broadcast - 1;
    const start = Math.min(firstHost + 99, lastHost);
    const end = Math.min(start + 99, lastHost);
    mutate(() => Object.assign(router.config, {
      dhcp_enabled: true, dhcp_start: ipString(start), dhcp_end: ipString(end), dhcp_mask: mask,
      dhcp_gateway: address, dhcp_dns_primary: router.config.dhcp_dns_primary || address,
      dhcp_lease_minutes: Number(router.config.dhcp_lease_minutes) || 480,
      dhcp_vlan: Number(iface.vlan || 1),
    }), `Configured a suggested DHCP pool on ${router.name}.`);
    setTimeout(() => autoAssignDhcpLeases(), 0);
  }
  function wanProvider(router) {
    if (!router || router.type !== 'router') return null;
    const peer = portPeer(router.id, 'WAN');
    return peer && peer.device?.type === 'cloud' && peer.device.config?.enabled !== false && peer.device.config?.isp_dhcp_enabled && linkIsUp(peer.link) ? peer.device : null;
  }
  function clearWanLease(router) {
    if (!router) return;
    Object.assign(router.config, { wan_ip: '', wan_gateway: '', wan_dns_servers: [], wan_state: portPeer(router.id, 'WAN') ? 'requesting' : 'no carrier' });
    ['wan_dhcp_server_id', 'wan_lease_obtained_at', 'wan_lease_expires_at'].forEach(key => delete router.config[key]);
  }
  function disconnectWan(router) {
    if (router?.config?.wan_mode === 'static') router.config.wan_state = 'no carrier';
    else clearWanLease(router);
  }
  function assignWanLease(routerId) {
    const router = deviceById(routerId);
    if (!router || router.type !== 'router') return { allowed: false, reason: 'Select a router.' };
    if (router.config?.wan_mode !== 'dhcp') return { allowed: false, reason: 'Set the WAN interface to Automatic (ISP DHCP).' };
    const provider = wanProvider(router);
    if (!provider) { router.config.wan_state = portPeer(router.id, 'WAN') ? 'no offer' : 'no carrier'; return { allowed: false, reason: router.config.wan_state === 'no carrier' ? 'Connect the router WAN port to an ISP Cloud.' : 'No connected ISP DHCP service answered.' }; }
    const start = ipNumber(provider.config?.isp_dhcp_start), end = ipNumber(provider.config?.isp_dhcp_end);
    if (start === null || end === null || start > end) { router.config.wan_state = 'no offer'; return { allowed: false, reason: `${provider.name} has an invalid ISP address pool.` }; }
    const maskNumber = ipNumber(provider.config?.isp_mask || '255.255.255.0'), gatewayNumber = ipNumber(provider.config?.isp_gateway);
    const networkAddress = gatewayNumber !== null && maskNumber !== null ? (gatewayNumber & maskNumber) >>> 0 : null;
    const broadcastAddress = networkAddress !== null ? (networkAddress | (~maskNumber >>> 0)) >>> 0 : null;
    const usableOffer = address => networkAddress === null || (((address & maskNumber) >>> 0) === networkAddress && address !== networkAddress && address !== broadcastAddress && address !== gatewayNumber);
    const used = new Set(state.topology.devices.filter(item => item.id !== router.id).map(item => item.config?.wan_ip).filter(Boolean));
    const current = ipNumber(router.config?.wan_ip);
    let offer = router.config?.wan_dhcp_server_id === provider.id && current !== null && current >= start && current <= end && usableOffer(current) ? router.config.wan_ip : '';
    for (let address = start; !offer && address <= Math.min(end, start + 65535); address += 1) { const candidate = ipString(address); if (usableOffer(address) && !used.has(candidate)) offer = candidate; }
    if (!offer) { router.config.wan_state = 'no offer'; return { allowed: false, reason: `${provider.name}'s ISP pool is exhausted.` }; }
    const obtained = Date.now(), leaseMinutes = Math.max(1, Math.min(10080, Number(provider.config?.isp_lease_minutes) || 1440));
    Object.assign(router.config, { wan_ip: offer, wan_mask: provider.config?.isp_mask || '255.255.255.0', wan_gateway: provider.config?.isp_gateway || '', wan_dns_servers: [provider.config?.isp_dns_primary, provider.config?.isp_dns_secondary].filter(value => ipNumber(value) !== null), wan_state: 'connected', wan_dhcp_server_id: provider.id, wan_lease_obtained_at: obtained, wan_lease_expires_at: obtained + leaseMinutes * 60000 });
    return { allowed: true, reason: `${provider.name} assigned external address ${offer}.`, provider };
  }
  function requestWanLease(routerId, { quiet = false } = {}) {
    const before = snapshot(), result = assignWanLease(routerId);
    if (result.allowed) { remember(before); afterMutation(result.reason); }
    else if (!quiet) { renderInspector(); logEvent(`WAN DHCP failed: ${result.reason}`); }
    return result;
  }
  function releaseWanLease(routerId) {
    const router = deviceById(routerId);
    if (!router || router.type !== 'router' || router.config?.wan_mode !== 'dhcp') return;
    mutate(() => clearWanLease(router), `${router.name} released its ISP DHCP lease.`);
  }
  function autoAssignWanLeases({ render = true, recordHistory = true, renewAll = false } = {}) {
    if (!state.topology) return [];
    const before = snapshot(), results = [];
    state.topology.devices.filter(device => device.type === 'router' && device.config?.wan_mode === 'dhcp' && (renewAll || !device.config?.wan_ip || Number(device.config?.wan_lease_expires_at || 0) <= Date.now())).forEach(device => { const result = assignWanLease(device.id); if (result.allowed) results.push(result); });
    if (results.length && recordHistory) remember(before);
    if (results.length && render) afterMutation(`${results.length} WAN lease${results.length === 1 ? '' : 's'} assigned.`);
    return results;
  }
  function normalizedDomain(value) {
    return String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/\.$/, '');
  }
  function dnsServerByIp(address) {
    const device = deviceByNetworkIp(address);
    return device && (device.config?.services || []).includes('dns') ? device : null;
  }
  function resolveDns(sourceId, requestedDomain) {
    const source = deviceById(sourceId), domain = normalizedDomain(requestedDomain), transactions = [], visited = new Set();
    if (!source || !domain || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)) return { allowed: false, reason: 'Enter a valid domain name.', domain, transactions };
    const cached = state.dnsCache.get(`${sourceId}|${domain}`);
    if (cached && cached.expires > Date.now()) return { allowed: true, reason: `DNS cache returned ${cached.address}.`, domain, address: cached.address, ttl: Math.ceil((cached.expires - Date.now()) / 1000), transactions: [{ title: 'DNS cache hit', detail: `${domain} → ${cached.address}`, path: [] }], cached: true };
    const query = (requesterId, serverIp, name, depth = 0) => {
      if (depth > 8) return { allowed: false, reason: 'DNS resolution exceeded the maximum referral depth.' };
      const key = `${serverIp}|${name}`;
      if (visited.has(key)) return { allowed: false, reason: 'A DNS forwarding or delegation loop was detected.' };
      visited.add(key);
      const server = dnsServerByIp(serverIp);
      if (!server) return { allowed: false, reason: `No DNS service is available at ${serverIp}.` };
      const packet = simulatePacket(requesterId, server.id, 'udp', 53);
      transactions.push({ title: `DNS query · ${name}`, detail: `${deviceById(requesterId)?.name || 'Client'} asks ${server.name} (${serverIp}).`, path: packet.path });
      if (!packet.allowed) return { allowed: false, reason: `DNS query to ${server.name} failed: ${packet.reason}` };
      const records = server.config?.dns_records || [];
      const exact = records.find(record => record.name === name && ['A', 'CNAME'].includes(record.type));
      if (exact?.type === 'A') {
        if (ipNumber(exact.value) === null) return { allowed: false, reason: `${server.name} has an invalid A record for ${name}.` };
        transactions.push({ title: 'DNS answer', detail: `${server.name} returns ${name} → ${exact.value} (TTL ${exact.ttl || 300}s).`, path: [...packet.path].reverse() });
        return { allowed: true, address: exact.value, ttl: Number(exact.ttl) || 300, server };
      }
      if (exact?.type === 'CNAME') {
        const alias = normalizedDomain(exact.value);
        transactions.push({ title: 'CNAME answer', detail: `${name} is an alias for ${alias}.`, path: [...packet.path].reverse() });
        return query(requesterId, serverIp, alias, depth + 1);
      }
      const delegation = records.filter(record => record.type === 'NS' && (name === record.name || name.endsWith(`.${record.name}`)) && ipNumber(record.value) !== null).sort((a, b) => b.name.length - a.name.length)[0];
      if (delegation) {
        transactions.push({ title: 'DNS referral', detail: `${server.name} delegates ${delegation.name} to DNS server ${delegation.value}.`, path: [...packet.path].reverse() });
        return query(server.config?.dns_recursion === false ? sourceId : server.id, delegation.value, name, depth + 1);
      }
      for (const forwarder of server.config?.dns_recursion === false ? [] : (server.config?.dns_forwarders || [])) {
        if (ipNumber(forwarder) === null) continue;
        transactions.push({ title: 'DNS forwarder', detail: `${server.name} forwards the unresolved query to ${forwarder}.`, path: [] });
        const forwarded = query(server.id, forwarder, name, depth + 1);
        if (forwarded.allowed) return forwarded;
      }
      return { allowed: false, reason: `${server.name} returned NXDOMAIN for ${name}.` };
    };
    const servers = (source.config?.dns_servers || []).filter(value => ipNumber(value) !== null);
    if (!servers.length) return { allowed: false, reason: `${source.name} has no DNS servers configured.`, domain, transactions };
    let answer = null;
    for (const serverIp of servers) { answer = query(sourceId, serverIp, domain); if (answer.allowed) break; transactions.push({ title: 'Fallback DNS', detail: `Trying the next client DNS server after: ${answer.reason}`, path: [] }); }
    if (!answer?.allowed) return { allowed: false, reason: answer?.reason || 'No DNS server answered.', domain, transactions };
    if (state.dnsCache.size >= 200) state.dnsCache.delete(state.dnsCache.keys().next().value);
    state.dnsCache.set(`${sourceId}|${domain}`, { address: answer.address, expires: Date.now() + answer.ttl * 1000 });
    return { allowed: true, reason: `${domain} resolved to ${answer.address}.`, domain, address: answer.address, ttl: answer.ttl, transactions };
  }
  function simulateWebRequest(sourceId, domain) {
    const dns = resolveDns(sourceId, domain);
    if (!dns.allowed) return { source: sourceId, target: '', protocol: 'web', port: 80, path: [], allowed: false, reason: dns.reason, layers: { application: 'DNS resolution failed', domain: dns.domain || domain }, dns, transactions: dns.transactions || [] };
    const target = deviceByNetworkIp(dns.address);
    if (!target) return { source: sourceId, target: '', protocol: 'web', port: 80, path: [], allowed: false, reason: `DNS returned ${dns.address}, but no simulated device has that address.`, layers: { application: 'DNS succeeded; HTTP host missing', domain: dns.domain, resolved_ip: dns.address }, dns, transactions: dns.transactions };
    const http = simulatePacket(sourceId, target.id, 'tcp', 80);
    const tcpPath = http.allowed ? http.path : (http.blocked_path || http.path);
    const transactions = [...dns.transactions, { title: 'TCP connection · port 80', detail: `${deviceById(sourceId)?.name} opens a connection to ${target.name} at ${dns.address}.`, path: tcpPath }, ...(http.allowed ? [{ title: 'HTTP GET', detail: `GET / HTTP/1.1\nHost: ${dns.domain}\n${target.name} returns HTTP/1.1 200 OK.`, path: [...http.path].reverse() }] : [])];
    return { source: sourceId, target: target.id, protocol: 'web', port: 80, path: http.path, blocked_at: http.blocked_at, blocked_path: http.blocked_path, acl: http.acl, allowed: http.allowed, reason: http.allowed ? `${dns.domain} resolved to ${dns.address}; HTTP returned 200 OK.` : `DNS succeeded, but HTTP failed: ${http.reason}`, layers: { application: 'DNS → TCP → HTTP', domain: dns.domain, resolved_ip: dns.address, transport: 'TCP 80', dns_cache: dns.cached ? 'hit' : 'miss', ...(http.layers?.policy ? { policy: http.layers.policy } : {}), ...(http.layers?.blocked_at ? { blocked_at: http.layers.blocked_at } : {}) }, dns, http, transactions };
  }
  function linkBetween(first, second) {
    const matches = state.topology.links.filter(link => (link.source === first && link.target === second) || (link.source === second && link.target === first));
    return matches.find(linkForwards) || matches.find(linkIsUp) || matches[0];
  }
  function pathMediaLabel(path) {
    const media = (path || []).slice(1).map((deviceId, index) => {
      if (wirelessAssociationBetween(path[index], deviceId)) return '802.11 wireless';
      const kind = linkBetween(path[index], deviceId)?.kind || 'ethernet';
      return kind.charAt(0).toUpperCase() + kind.slice(1);
    });
    return [...new Set(media)].join(' / ') || 'Unknown link';
  }
  function deterministicRoll(key) {
    let value = 2166136261;
    for (const char of String(key)) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
    return (value >>> 0) / 4294967296;
  }
  function simulatePacket(source, target, protocol = 'icmp', port = null, size = null, options = {}) {
    if (protocol === 'icmp6' && window.NetworkSimAdvanced?.simulateIpv6) return window.NetworkSimAdvanced.simulateIpv6(source, target, protocol, port);
    const forwarded = window.NetworkSimAdvanced?.resolvePortForward?.(source, target, protocol, port);
    const requestedTarget = target, requestedPort = port;
    if (forwarded) { target = forwarded.target; port = forwarded.port; }
    const devices = Object.fromEntries(state.topology.devices.map(item => [item.id, item]));
    const path = findPath(source, target);
    const packetSize = Math.max(42, Math.min(9216, Number(size) || (protocol === 'icmp' || protocol === 'icmp6' ? 98 : 128)));
    const sequence = options.ignoreQuality ? 0 : ++state.packetSequence;
    const result = { source, target, protocol, port, size: packetSize, path, allowed: false, reason: '', layers: {}, ...(forwarded ? { port_forward: { device: requestedTarget, external_port: requestedPort, internal_target: target, internal_port: port } } : {}) };
    if (!path.length) { result.reason = 'No physical or authenticated wireless path exists.'; return result; }
    const first = devices[source], last = devices[target];
    const firstConfig = endpointConfigForPath(first, path), lastConfig = endpointConfigForPath(last, path);
    const block = (reason, deviceId, policy = 'Network policy') => {
      const index = path.indexOf(deviceId);
      result.reason = reason; result.blocked_at = deviceId || source; result.blocked_path = index >= 0 ? path.slice(0, index + 1) : [source];
      result.layers = { ...result.layers, policy, blocked_at: devices[deviceId]?.name || deviceId || first?.name || source };
      return result;
    };
    let totalLatency = 0;
    for (let index = 1; index < path.length; index += 1) {
      if (wirelessAssociationBetween(path[index - 1], path[index])) { totalLatency += 3; continue; }
      const link = linkBetween(path[index - 1], path[index]); if (!link) continue;
      totalLatency += Math.max(0, Number(link.latency_ms) || 1);
      if (!options.ignoreQuality && packetSize > Math.max(576, Number(link.mtu) || 1500)) return block(`${packetSize}-byte packet exceeds the ${link.mtu || 1500}-byte MTU on ${link.label || 'this link'}.`, path[index - 1], 'Maximum transmission unit');
      const loss = Math.max(0, Math.min(100, Number(link.loss_percent) || 0));
      const seed = state.topology.metadata?.simulation?.seed || 1337;
      if (!options.ignoreQuality && loss && deterministicRoll(`${seed}|${sequence}|${link.id}`) * 100 < loss) return block(`Simulated packet loss occurred on ${link.label || link.id} (${loss}% configured loss).`, path[index - 1], 'Link quality');
    }
    if (ipNumber(firstConfig.ip) === null) return block(`${first.name}'s transmitting interface needs a valid IPv4 address.`, source, 'Source configuration');
    if (ipNumber(lastConfig.ip) === null) return block(`${last.name}'s receiving interface needs a valid IPv4 address.`, target, 'Destination configuration');
    const middle = path.slice(1, -1).map(id => devices[id]);
    const sourceVlan = Number(first.config?.vlan || 1), destinationVlan = Number(last.config?.vlan || 1);
    let activeVlan = sourceVlan;
    for (let index = 1; index < path.length - 1; index += 1) {
      const device = devices[path[index]];
      if (['switch', 'l3switch'].includes(device.type)) {
        const ingressLink = linkBetween(path[index - 1], device.id), egressLink = linkBetween(device.id, path[index + 1]);
        const ingress = portForLink(ingressLink, device.id), egress = portForLink(egressLink, device.id);
        const routesHere = device.type === 'l3switch' && device.config?.ip_routing !== false && activeVlan !== destinationVlan;
        const outgoingVlan = routesHere ? destinationVlan : activeVlan;
        if (!switchPortCarries(device, ingress, activeVlan)) return block(`${device.name} ${ingress} does not carry VLAN ${activeVlan}.`, device.id, 'VLAN ingress');
        if (!switchPortCarries(device, egress, outgoingVlan)) return block(`${device.name} ${egress} does not carry VLAN ${outgoingVlan}.`, device.id, 'VLAN egress');
        if (routesHere) activeVlan = destinationVlan;
      } else if (['router', 'firewall'].includes(device.type) && activeVlan !== destinationVlan) activeVlan = destinationVlan;
    }
    const needsRouting = !sameSubnetConfigs(firstConfig, lastConfig) || sourceVlan !== destinationVlan;
    if (needsRouting) {
      const routers = middle.filter(item => ['router', 'firewall'].includes(item.type) || (item.type === 'l3switch' && item.config?.ip_routing !== false));
      const natRouter = routers.find(router => {
        if (router.type !== 'router' || router.config?.nat_enabled === false || ipNumber(router.config?.wan_ip) === null || router.config?.wan_state !== 'connected') return false;
        const index = path.indexOf(router.id), next = path[index + 1], wanLink = linkBetween(router.id, next);
        return wanLink && portForLink(wanLink, router.id) === 'WAN';
      });
      if (!routers.length) return block('The endpoints require routing, but the path has no router, firewall, or Layer 3 switch with IP routing enabled.', middle[0]?.id || source, 'Layer 3 routing');
      if (routers.length > 1) {
        const protocols = routers.map(item => String(item.config?.routing_protocol || 'static').toLowerCase());
        const dynamicReady = ['rip', 'ospf'].includes(protocols[0]) && protocols.every((value, index) => value === protocols[0] && (!['router', 'l3switch'].includes(routers[index].type) || routers[index].config?.router_id));
        const staticReady = routers.every(item => deviceKnowsRoute(item, firstConfig.ip) && deviceKnowsRoute(item, lastConfig.ip));
        if (!dynamicReady && !staticReady) return block('Multiple routing devices need matching RIP/OSPF configuration or static routes for both endpoint networks.', routers.find(item => !deviceKnowsRoute(item, lastConfig.ip))?.id || routers[0].id, 'Routing table');
      }
      if (ipNumber(firstConfig.gateway) === null || (!natRouter && ipNumber(lastConfig.gateway) === null)) return block('A routed path requires valid default gateways on both endpoints.', source, 'Default gateway');
      const addresses = routers.flatMap(item => (item.config?.interfaces || []).map(iface => iface.ip).concat((item.config?.svis || []).map(svi => svi.ip), [item.config?.ip, item.config?.wan_ip])).filter(Boolean);
      if (!addresses.includes(firstConfig.gateway)) return block(`${first.name}'s default gateway does not match a routed interface on this path.`, source, 'Default gateway');
      if (!natRouter && !addresses.includes(lastConfig.gateway)) return block(`${last.name}'s default gateway does not match a routed interface on this path.`, target, 'Default gateway');
      for (const routedDevice of routers.filter(item => ['router', 'l3switch'].includes(item.type))) {
        const decision = aclDecision(routedDevice, path, protocol, port, firstConfig.ip, lastConfig.ip);
        if (!decision.allowed) {
          const detail = decision.matched ? `ACL rule ${decision.index + 1} denies ${String(protocol).toUpperCase()}${port ? `/${port}` : ''} from ${firstConfig.ip} to ${lastConfig.ip}.` : `The implicit ACL deny on ${routedDevice.name} blocks unmatched routed traffic.`;
          result.acl = { device: routedDevice.id, rule_index: decision.index, matched: decision.matched, ingress: decision.ingress, egress: decision.egress };
          return block(detail, routedDevice.id, 'Access control list');
        }
      }
      if (natRouter) result.nat = { router: natRouter.id, private_ip: firstConfig.ip, public_ip: natRouter.config.wan_ip };
    }
    for (const firewall of middle.filter(item => item.type === 'firewall')) {
        if (window.NetworkSimAdvanced?.allowsEstablished?.(firewall, first, last, protocol, port)) continue;
        const match = (firewall.config?.firewall_rules || []).find(rule => {
          const protocolMatches = ['any', protocol].includes(String(rule.protocol || 'tcp').toLowerCase());
          const portMatches = !['tcp', 'udp'].includes(protocol) || !port || [-1, Number(port)].includes(Number(rule.port));
          return protocolMatches && portMatches;
        });
        const traffic = `${protocol.toUpperCase()}${port ? ` port ${port}` : ''}`;
        if (!match || String(match.action).toLowerCase() !== 'allow') return block(match ? `${firewall.name} explicitly denies ${traffic}.` : `${firewall.name} has no allow rule for ${traffic}.`, firewall.id, match ? 'Firewall rule' : 'Firewall default deny');
    }
    if (['tcp', 'udp'].includes(protocol) && port) {
      const service = ({ 80: 'http', 443: 'https', 22: 'ssh', 53: 'dns' })[Number(port)];
      if (service && !(last.config?.services || []).includes(service)) return block(`${service.toUpperCase()} is not enabled on ${last.name}.`, target, 'Destination service');
    }
    const advancedDecision = window.NetworkSimAdvanced?.evaluatePacket?.({ result, path, source: first, target: last, protocol, port });
    if (advancedDecision?.allowed === false) return block(advancedDecision.reason || 'Blocked by stateful security policy.', advancedDecision.device || source, advancedDecision.policy || 'Stateful security');
    result.allowed = true;
    result.reason = 'Packet delivered successfully.';
    result.layers = { link: pathMediaLabel(path), source_ip: firstConfig.ip, destination_ip: lastConfig.ip, protocol: protocol.toUpperCase(), port: port || null, bytes: packetSize, latency: `${totalLatency} ms`, hops: path.length - 1, ...(result.nat ? { nat: `${result.nat.private_ip} → ${result.nat.public_ip}` } : {}), ...(forwarded ? { port_forward: `${requestedPort} → ${lastConfig.ip}:${port}` } : {}) };
    return result;
  }

  function gradeCurrentLab() {
    const objectiveDefinitions = state.lab?.objectives || state.topology?.objectives || [];
    if (!objectiveDefinitions.length) {
      state.grade = null;
      $('networkObjectivesPanel').innerHTML = '<div class="network-objectives-empty">This is a free-build network. Use Packet Test and the CLI to test your design.</div>';
      $('networkObjectiveCount').textContent = '';
      return;
    }
    const devices = Object.fromEntries(state.topology.devices.map(item => [item.id, item]));
    const objectives = objectiveDefinitions.map(objective => {
      let complete = false;
      const device = devices[objective.device];
      if (objective.kind === 'link') complete = state.topology.links.some(link => new Set([link.source, link.target]).has(objective.source) && new Set([link.source, link.target]).has(objective.target));
      else if (objective.kind === 'link_ports') complete = state.topology.links.some(link => (link.source === objective.source && link.target === objective.target && link.source_port === objective.source_port && link.target_port === objective.target_port) || (link.source === objective.target && link.target === objective.source && link.source_port === objective.target_port && link.target_port === objective.source_port));
      else if (objective.kind === 'device_config' && device) complete = Object.entries(objective.values || {}).every(([key, value]) => String(device.config?.[key] ?? '') === String(value));
      else if (objective.kind === 'interfaces' && device) complete = (objective.addresses || []).every(address => (device.config?.interfaces || []).some(iface => iface.ip === address));
      else if (objective.kind === 'svis' && device) complete = (objective.values || []).every(wanted => (device.config?.svis || []).some(svi => Number(svi.vlan) === Number(wanted.vlan) && svi.ip === wanted.ip));
      else if (objective.kind === 'interface_config' && device) complete = Object.entries(objective.values || {}).every(([key, value]) => String(device.config?.server_interfaces?.[objective.interface]?.[key] ?? '') === String(value));
      else if (objective.kind === 'switch_vlans' && device) complete = (objective.vlans || []).every(vlan => (device.config?.vlans || []).includes(vlan)) && Object.entries(objective.port_vlans || {}).every(([port, vlan]) => Number(device.config?.port_vlans?.[port]) === Number(vlan));
      else if (objective.kind === 'dns_record' && device) complete = (device.config?.dns_records || []).some(record => record.name === String(objective.name || '').toLowerCase() && record.type === String(objective.type || 'A').toUpperCase() && String(record.value || '').toLowerCase() === String(objective.value || '').toLowerCase());
      else if (objective.kind === 'dhcp_bound' && device) complete = device.config?.addressing_mode === 'dhcp' && device.config?.dhcp_state === 'bound' && ipNumber(device.config?.ip) !== null;
      else if (objective.kind === 'wan_connected' && device) complete = device.config?.wan_state === 'connected' && ipNumber(device.config?.wan_ip) !== null && (!objective.nat_required || device.config?.nat_enabled !== false);
      else if (objective.kind === 'service' && device) complete = (device.config?.services || []).includes(objective.service);
      else if (objective.kind === 'firewall_rule' && device) complete = (device.config?.firewall_rules || []).some(rule => rule.action === objective.action && rule.protocol === objective.protocol && Number(rule.port) === Number(objective.port));
      else if (objective.kind === 'acl_rule' && device) complete = (device.config?.acl_rules || []).some(rule => Object.entries(objective.values || {}).every(([key, value]) => String(rule[key] ?? '').toLowerCase() === String(value).toLowerCase()));
      else if (objective.kind === 'stp_blocked') complete = spanningTreeState().blocked.size >= Math.max(1, Number(objective.minimum) || 1);
      else if (objective.kind === 'routing_protocol' && device) complete = String(device.config?.routing_protocol || 'static').toLowerCase() === String(objective.protocol || 'static').toLowerCase() && (!objective.router_id || String(device.config?.router_id || '') === String(objective.router_id));
      else if (objective.kind === 'ipv6_config' && device) complete = String(device.config?.ipv6_address || '').toLowerCase() === String(objective.address || '').toLowerCase() && Number(device.config?.ipv6_prefix || 64) === Number(objective.prefix || 64) && (!objective.gateway || String(device.config?.ipv6_gateway || '').toLowerCase() === String(objective.gateway).toLowerCase());
      else if (objective.kind === 'ipv6_reachability') complete = window.NetworkSimAdvanced?.simulateIpv6?.(objective.source, objective.target)?.allowed === (objective.expected !== false);
      else if (objective.kind === 'port_forward' && device) complete = (device.config?.port_forwards || []).some(rule => String(rule.protocol || 'tcp').toLowerCase() === String(objective.protocol || 'tcp').toLowerCase() && Number(rule.external_port) === Number(objective.external_port) && String(rule.internal_ip || '') === String(objective.internal_ip || '') && Number(rule.internal_port) === Number(objective.internal_port));
      else if (objective.kind === 'wireless_association' && device) complete = wirelessAssociations().some(item => item.client.id === device.id && (!objective.wap || item.wap.id === objective.wap));
      else if (objective.kind === 'traffic_profile') complete = (state.topology.metadata?.simulation?.completed_profiles || []).includes(objective.profile);
      else if (objective.kind === 'reachability') complete = simulatePacket(objective.source, objective.target, objective.protocol, objective.port, null, { ignoreQuality: true }).allowed === (objective.expected !== false);
      else if (objective.kind === 'packet_test') complete = state.objectiveActions.has(objective.id);
      return { id: objective.id, label: objective.label, complete };
    });
    const completed = objectives.filter(item => item.complete).length;
    state.grade = { objectives, completed, total: objectives.length, percent: objectives.length ? Math.round(completed / objectives.length * 100) : 100, passed: completed === objectives.length };
    $('networkObjectivesPanel').innerHTML = `<div class="network-objectives">${objectives.map(item => `<div class="network-objective ${item.complete ? 'complete' : ''}">${escapeHtml(item.label)}</div>`).join('')}</div>`;
    $('networkObjectiveCount').textContent = `${completed}/${objectives.length}`;
  }
  function recordPacketObjective(result, domain = '') {
    const objectives = state.lab?.objectives || state.topology?.objectives || [];
    objectives.filter(objective => objective.kind === 'packet_test').forEach(objective => {
      const protocolMatches = String(objective.protocol || 'icmp') === String(result.protocol || 'icmp');
      const sourceMatches = !objective.source || objective.source === result.source;
      const targetMatches = !objective.target || objective.target === result.target;
      const portMatches = objective.port === undefined || Number(objective.port) === Number(result.port);
      const outcomeMatches = (objective.expected !== false) === !!result.allowed;
      const domainMatches = !objective.domain || normalizedDomain(objective.domain) === normalizedDomain(domain);
      if (protocolMatches && sourceMatches && targetMatches && portMatches && outcomeMatches && domainMatches) state.objectiveActions.add(objective.id);
    });
    gradeCurrentLab();
  }
  function renderPacketOptions() {
    const protocol = $('networkPacketProtocol')?.value || 'icmp';
    const isDhcp = protocol === 'dhcp';
    const isWeb = protocol === 'web';
    const devices = (state.topology?.devices || []).filter(item => (isDhcp || isWeb) ? DHCP_CLIENT_TYPES.has(item.type) : !['switch', 'l3switch', 'wap'].includes(item.type));
    const options = devices.map(item => { const address = primaryDeviceAddress(item); return `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}${address ? ` — ${escapeHtml(address)}` : ''}</option>`; }).join('');
    const source = $('networkPacketSource'), target = $('networkPacketTarget');
    const oldSource = source.value, oldTarget = target.value;
    source.innerHTML = options;
    target.innerHTML = isDhcp ? '<option value="broadcast">255.255.255.255 — Broadcast</option>' : isWeb ? '<option value="dns">Resolved by DNS</option>' : options;
    if ([...source.options].some(option => option.value === oldSource)) source.value = oldSource;
    if (!isDhcp && [...target.options].some(option => option.value === oldTarget)) target.value = oldTarget;
    if (!isDhcp && !target.value && target.options.length > 1) target.selectedIndex = 1;
    target.disabled = isDhcp || isWeb;
    $('networkPacketTargetLabel')?.classList.toggle('is-broadcast', isDhcp);
    $('networkPacketPortLabel')?.toggleAttribute('hidden', isDhcp || isWeb || ['icmp', 'icmp6'].includes(protocol));
    $('networkPacketSizeLabel')?.toggleAttribute('hidden', isDhcp || isWeb);
    $('networkPacketDomainLabel')?.toggleAttribute('hidden', !isWeb);
    if ($('networkPacketSendBtn')) $('networkPacketSendBtn').textContent = isDhcp ? 'Send DHCP Discover' : isWeb ? 'Resolve & Request Page' : 'Send Packet';
  }
  function pathAnimationSteps(path, title, detail) {
    return (path || []).slice(1).map((id, index) => ({ from: path[index], to: id, title, detail: detail || `${deviceById(path[index])?.name || path[index]} → ${deviceById(id)?.name || id}` }));
  }
  function packetAnimationSteps(result) {
    let steps;
    if (Array.isArray(result.transactions)) steps = result.transactions.flatMap(transaction => pathAnimationSteps(transaction.path, transaction.title, transaction.detail));
    else if (result.dhcp?.steps?.length) steps = result.dhcp.steps.flatMap(step => {
      const path = ['DHCPOFFER', 'DHCPACK'].includes(step.type) ? [...(result.path || [])].reverse() : (result.path || []);
      return pathAnimationSteps(path, step.type, step.detail);
    });
    else steps = pathAnimationSteps(result.allowed ? (result.path || []) : (result.blocked_path || result.path || []), `${String(result.protocol || 'packet').toUpperCase()}${result.port ? `/${result.port}` : ''}`, result.reason);
    if (!result.allowed && steps.length) Object.assign(steps[steps.length - 1], { failed: true, title: `BLOCKED · ${steps[steps.length - 1].title}`, detail: result.reason });
    return steps;
  }
  function renderPacketStep(index) {
    const steps = state.lastPacket?.animation_steps || [];
    if (!steps.length) { $('networkPacketOverlayLayer').innerHTML = ''; return; }
    state.packetStep = Math.max(0, Math.min(steps.length - 1, Number(index) || 0));
    const step = steps[state.packetStep], first = deviceById(step.from), second = deviceById(step.to), link = linkBetween(step.from, step.to), wireless = link ? null : wirelessAssociationBetween(step.from, step.to);
    $('networkLinks').querySelectorAll('.network-link').forEach(line => line.classList.remove('is-active', 'is-blocked-hop'));
    const activeLine = link
      ? $('networkLinks')?.querySelector(`[data-link-id="${CSS.escape(link.id)}"]`)
      : [...($('networkLinks')?.querySelectorAll('[data-wireless-client][data-wireless-wap]') || [])].find(line => new Set([line.dataset.wirelessClient, line.dataset.wirelessWap]).has(step.from) && new Set([line.dataset.wirelessClient, line.dataset.wirelessWap]).has(step.to));
    activeLine?.classList.add(step.failed ? 'is-blocked-hop' : 'is-active');
    const overlay = $('networkPacketOverlayLayer');
    if (first && second && (link || wireless)) {
      const x = (first.x + second.x) / 2 + 56, y = (first.y + second.y) / 2 + 35;
      const startX = first.x + 56, startY = first.y + 35, dx = second.x - first.x, dy = second.y - first.y;
      const firstPort = link ? portForLink(link, first.id) : (first.type === 'wap' ? 'Radio' : 'Wi-Fi');
      const secondPort = link ? portForLink(link, second.id) : (second.type === 'wap' ? 'Radio' : 'Wi-Fi');
      overlay.innerHTML = `<span class="network-packet-token ${step.failed ? 'is-blocked' : ''}" style="left:${startX}px;top:${startY}px;--network-hop-x:${dx}px;--network-hop-y:${dy}px" aria-hidden="true"><i></i></span><div class="network-link-action ${step.failed ? 'is-blocked' : ''} ${y < 115 ? 'is-below' : ''}" style="left:${Math.max(135, Math.min(865, x))}px;top:${y}px"><strong>${escapeHtml(step.title)}</strong><span>${escapeHtml(step.detail)}</span><small>${escapeHtml(first.name)} ${escapeHtml(firstPort)} → ${escapeHtml(second.name)} ${escapeHtml(secondPort)}</small></div>`;
    } else overlay.innerHTML = '';
    if ($('networkPacketStepCount')) $('networkPacketStepCount').textContent = `Step ${state.packetStep + 1} of ${steps.length}`;
    if ($('networkPacketPrevBtn')) $('networkPacketPrevBtn').disabled = state.packetStep === 0;
    if ($('networkPacketNextBtn')) $('networkPacketNextBtn').disabled = state.packetStep === steps.length - 1;
  }
  function stopPacketPlayback() {
    clearInterval(state.packetTimer); state.packetTimer = 0;
    const button = $('networkPacketPlayBtn');
    if (button) { button.textContent = '▶ Play loop'; button.setAttribute('aria-pressed', 'false'); }
  }
  function togglePacketPlayback() {
    if (state.packetTimer) { stopPacketPlayback(); return; }
    const steps = state.lastPacket?.animation_steps || [];
    if (!steps.length) return;
    if (state.packetStep >= steps.length - 1) renderPacketStep(0);
    $('networkPacketPlayBtn').textContent = '■ Stop';
    $('networkPacketPlayBtn').setAttribute('aria-pressed', 'true');
    state.packetTimer = setInterval(() => {
      renderPacketStep(state.packetStep >= steps.length - 1 ? 0 : state.packetStep + 1);
    }, 1200);
  }
  function bindPacketPlayback() {
    $('networkPacketPrevBtn')?.addEventListener('click', () => { stopPacketPlayback(); renderPacketStep(state.packetStep - 1); });
    $('networkPacketNextBtn')?.addEventListener('click', () => { stopPacketPlayback(); renderPacketStep(state.packetStep + 1); });
    $('networkPacketPlayBtn')?.addEventListener('click', togglePacketPlayback);
  }
  function renderPacketResult(result) {
    if (!result) return;
    const shownPath = result.allowed ? result.path : (result.blocked_path || result.path);
    const path = Array.isArray(shownPath) ? shownPath : [];
    const hops = path.map(id => `<span class="network-packet-hop">${escapeHtml(deviceById(id)?.name || id)}</span>`).join('<span> → </span>');
    const layers = Object.entries(result.layers || {}).map(([key, value]) => `<span class="network-packet-hop">${escapeHtml(key)}: ${escapeHtml(value)}</span>`).join('');
    const steps = (result.dhcp?.steps || []).map((step, index) => `<div class="network-dhcp-step ${result.allowed || index === 0 ? 'complete' : 'failed'}"><span>${index + 1}</span><div><strong>${escapeHtml(step.type)}</strong><small>${escapeHtml(step.detail)}</small></div></div>`).join('');
    const transactions = (result.transactions || []).map((transaction, index) => `<div class="network-transaction"><span>${index + 1}</span><div><strong>${escapeHtml(transaction.title)}</strong><small>${escapeHtml(transaction.detail)}</small></div></div>`).join('');
    const heading = result.protocol === 'dhcp' ? (result.allowed ? 'LEASE ASSIGNED' : 'NO DHCP OFFER') : result.protocol === 'web' ? (result.allowed ? 'HTTP 200 OK' : 'REQUEST FAILED') : (result.allowed ? 'DELIVERED' : 'BLOCKED');
    result.animation_steps = packetAnimationSteps(result); state.lastPacket = result; stopPacketPlayback(); state.packetStep = result.animation_steps.length ? 0 : -1;
    const playback = result.animation_steps.length ? `<div class="network-packet-playback"><button class="btn secondary" id="networkPacketPrevBtn" type="button">← Previous</button><span id="networkPacketStepCount"></span><button class="btn secondary" id="networkPacketNextBtn" type="button">Next →</button><button class="btn run" id="networkPacketPlayBtn" type="button" aria-pressed="false" title="Repeat packet hops until stopped">▶ Play loop</button></div>` : '';
    const blockedNotice = !result.allowed && result.blocked_at ? `<div class="network-blocked-callout"><strong>Transmission stopped at ${escapeHtml(deviceById(result.blocked_at)?.name || result.blocked_at)}</strong><span>${escapeHtml(result.reason)}</span></div>` : '';
    $('networkPacketResult').innerHTML = `<div class="${result.allowed ? 'allowed' : 'blocked'}">${heading} — ${escapeHtml(result.reason)}</div>${blockedNotice}${playback}${steps ? `<div class="network-dhcp-steps">${steps}</div>` : ''}${transactions ? `<div class="network-transactions">${transactions}</div>` : ''}<div>${hops || (transactions ? '' : 'No path')}</div><div>${layers}</div>`;
    bindPacketPlayback();
    if (state.packetStep >= 0) renderPacketStep(state.packetStep); else $('networkPacketOverlayLayer').innerHTML = '';
    window.dispatchEvent(new CustomEvent('network-sim:packet', { detail: { result } }));
  }
  function sendPacket() {
    const source = $('networkPacketSource').value;
    const protocol = $('networkPacketProtocol').value;
    if (!source) return alert(protocol === 'dhcp' ? 'Choose a DHCP client.' : 'Choose a source device.');
    if (protocol === 'dhcp') {
      const client = deviceById(source);
      if (addressingMode(client) !== 'dhcp') {
        const before = snapshot();
        client.config.addressing_mode = 'dhcp'; client.config.dhcp = true; clearDhcpLease(client);
        remember(before);
      }
      const result = requestDhcpLease(source, { showPacket: true });
      recordPacketObjective(result);
      logEvent(`DHCP Discover from ${client?.name}: ${result.allowed ? `lease ${client.config.ip} assigned` : 'no offer'}.`);
      return;
    }
    if (protocol === 'web') {
      const domain = $('networkPacketDomain').value;
      const result = simulateWebRequest(source, domain);
      state.lastPacket = result; renderPacketResult(result);
      recordPacketObjective(result, domain);
      logEvent(`DNS + HTTP from ${deviceById(source)?.name} for ${normalizedDomain(domain) || domain}: ${result.allowed ? 'HTTP 200' : 'failed'}.`);
      return;
    }
    const target = $('networkPacketTarget').value;
    if (!target || source === target) return alert('Choose two different endpoint devices.');
    const port = ['icmp', 'icmp6'].includes(protocol) ? null : (Number($('networkPacketPort').value) || null);
    const result = simulatePacket(source, target, protocol, port, Number($('networkPacketSize')?.value) || 128);
    state.lastPacket = result;
    renderPacketResult(result);
    recordPacketObjective(result);
    logEvent(`${protocol.toUpperCase()}${port ? `/${port}` : ''} ${deviceById(source)?.name} → ${deviceById(target)?.name}: ${result.allowed ? 'delivered' : 'blocked'}.`);
  }

  function renderEvents() {
    const el = $('networkEventLog');
    if (!el) return;
    el.innerHTML = state.events.length ? state.events.map(item => `<div class="network-event-entry"><time>${item.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time><span>${escapeHtml(item.message)}</span></div>`).join('') : '<div class="network-objectives-empty">Configuration changes and simulated traffic will appear here.</div>';
  }
  function renderLabGuide() {
    const panel = $('networkLabGuidePanel');
    if (!state.lab) { panel.innerHTML = ''; return; }
    panel.innerHTML = `<div class="network-lab-guide"><div><h3>${escapeHtml(state.lab.title)}</h3><ol>${(state.lab.instructions || []).map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ol></div><div><h3>Skills covered</h3><div class="network-card-meta">${(state.lab.covers || []).map(item => `<span>${escapeHtml(item)}</span>`).join('')}</div><p>${escapeHtml(state.lab.description)}</p>${state.mode === 'demo' && state.lab.solution ? `<h3>Teacher solution</h3><ol>${state.lab.solution.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ol>` : ''}</div></div>`;
  }

  function cliPrint(text) {
    const output = $('networkCliOutput');
    output.textContent += `\n${text}`;
    output.scrollTop = output.scrollHeight;
  }
  function runCli(command) {
    const input = String(command || '').trim();
    if (!input) return;
    cliPrint(`$ ${input}`);
    const lower = input.toLowerCase();
    if (lower === 'clear') { $('networkCliOutput').textContent = ''; return; }
    if (lower === 'help') {
      const commands = (state.bootstrap?.command_reference || []).map(item => item.command);
      cliPrint(commands.length ? commands.join(' | ') : 'help | ip addr | ip set <IP> <MASK> | dhcp request | dhcp release | show dhcp | show ports | wan dhcp | show wan | nslookup <DOMAIN> | http get <DOMAIN> | gateway set <IP> | ip route | route add <NETWORK> via <GATEWAY> | ping <IP> | traceroute <IP> | arp | show interfaces | show mac-table | show vlans | show acl | vlan set <ID> | show routes | show firewall | scan <IP> | inspect last | clear');
      return;
    }
    const device = selectedDevice();
    if (!device) { cliPrint('Error: select a device first.'); return; }
    if (window.NetworkSimAdvanced?.handleCli?.(lower, input, device)) return;
    if (lower === 'ip addr') cliPrint(`${device.name}\n  mode    ${addressingMode(device) === 'dhcp' ? 'automatic (DHCP)' : 'manual (static)'}\n  address ${device.config?.ip || 'not configured'}\n  mask    ${device.config?.mask || 'not configured'}\n  gateway ${device.config?.gateway || 'not configured'}\n  DNS     ${(device.config?.dns_servers || []).join(', ') || 'not configured'}\n  state   ${device.config?.enabled === false ? 'DOWN' : 'UP'}`);
    else if (lower.startsWith('ip set ')) {
      const [, , ip, mask = '255.255.255.0'] = input.split(/\s+/);
      if (ipNumber(ip) === null || ipNumber(mask) === null) cliPrint('Usage: ip set <valid IPv4 address> <valid subnet mask>');
      else {
        mutate(() => {
          Object.assign(device.config, { addressing_mode: 'static', dhcp: false, dhcp_state: 'static', ip, mask });
          if (device.type === 'server' && device.config.server_interfaces?.LAN1) Object.assign(device.config.server_interfaces.LAN1, { ip, mask });
          ['dhcp_server_id', 'dhcp_server_name', 'dhcp_domain', 'dhcp_lease_obtained_at', 'dhcp_lease_expires_at'].forEach(key => delete device.config[key]);
        }, `CLI set ${device.name} to Manual (Static) as ${ip}.`);
        cliPrint(`Manual (Static) address set to ${ip} ${mask}`);
      }
    } else if (lower === 'dhcp request' || lower === 'dhclient') {
      if (!DHCP_CLIENT_TYPES.has(device.type)) cliPrint('This device cannot act as a DHCP client.');
      else {
        if (addressingMode(device) !== 'dhcp') {
          mutate(() => { Object.assign(device.config, { addressing_mode: 'dhcp', dhcp: true }); clearDhcpLease(device); }, `CLI switched ${device.name} to Automatic (DHCP).`);
        }
        const result = requestDhcpLease(device.id, { showPacket: true });
        cliPrint((result.dhcp?.steps || []).map(step => `${step.type.padEnd(13)} ${step.detail}`).join('\n'));
        cliPrint(result.allowed ? `Bound to ${device.config.ip}\nGateway ${device.config.gateway || 'none'}\nDNS ${(device.config.dns_servers || []).join(', ') || 'none'}` : `DHCP failed: ${result.reason}`);
      }
    } else if (lower === 'dhcp release' || lower === 'dhclient -r') {
      if (!isDhcpClient(device)) cliPrint('The selected device is not using Automatic (DHCP).');
      else { releaseDhcpLease(device.id); cliPrint('DHCP lease released. The device remains in Automatic mode.'); }
    } else if (lower === 'show dhcp') {
      if (device.type === 'router') {
        const leases = state.topology.devices.filter(item => item.config?.dhcp_server_id === device.id && item.config?.ip);
        cliPrint(`DHCP server ${device.config?.dhcp_enabled ? 'ENABLED' : 'DISABLED'}\nPool ${device.config?.dhcp_start || 'not configured'} - ${device.config?.dhcp_end || 'not configured'}\nMask ${device.config?.dhcp_mask || 'not configured'}\nGateway ${device.config?.dhcp_gateway || device.config?.ip || 'not configured'}\nDNS ${[device.config?.dhcp_dns_primary, device.config?.dhcp_dns_secondary].filter(Boolean).join(', ') || 'not configured'}\nDomain ${device.config?.dhcp_domain || 'none'}\nLease ${Number(device.config?.dhcp_lease_minutes) || 480} minutes\nVLAN ${Number(device.config?.dhcp_vlan) || 1}\nActive leases ${leases.length}${leases.length ? `\n${leases.map(item => `  ${item.config.ip}  ${item.name}`).join('\n')}` : ''}`);
      } else cliPrint(`Mode ${addressingMode(device) === 'dhcp' ? 'Automatic (DHCP)' : 'Manual (Static)'}\nState ${device.config?.dhcp_state || 'not bound'}\nAddress ${device.config?.ip || 'not assigned'}\nServer ${device.config?.dhcp_server_name || 'none'}\nDNS ${(device.config?.dns_servers || []).join(', ') || 'none'}\nLease expires ${device.config?.dhcp_lease_expires_at ? new Date(Number(device.config.dhcp_lease_expires_at)).toLocaleString() : 'not applicable'}`);
    } else if (lower === 'show ports') {
      cliPrint((DEVICE_PORTS[device.type] || []).map(port => { const peer = portPeer(device.id, port), cfg = device.config?.ports?.[port] || {}; return `${port.padEnd(6)} ${cfg.enabled === false ? 'DOWN' : peer && linkIsUp(peer.link) ? 'UP  ' : 'OPEN'}  ${(cfg.speed || '1 Gbps').padEnd(8)}  ${peer ? `${peer.device?.name} ${peer.port}` : 'not connected'}`; }).join('\n') || 'This device has no physical Ethernet ports.');
    } else if (lower === 'wan dhcp') {
      if (device.type !== 'router') cliPrint('WAN DHCP is available on routers.');
      else { if (device.config.wan_mode !== 'dhcp') mutate(() => { device.config.wan_mode = 'dhcp'; clearWanLease(device); }, `CLI switched ${device.name} WAN to Automatic (ISP DHCP).`); const result = requestWanLease(device.id); cliPrint(result.allowed ? `WAN lease acquired: ${device.config.wan_ip}\nGateway ${device.config.wan_gateway}\nDNS ${device.config.wan_dns_servers.join(', ') || 'none'}` : `WAN DHCP failed: ${result.reason}`); }
    } else if (lower === 'show wan') {
      if (device.type !== 'router') cliPrint('Select a router to inspect WAN state.');
      else cliPrint(`Mode ${device.config?.wan_mode === 'static' ? 'Manual (Static)' : 'Automatic (ISP DHCP)'}\nState ${device.config?.wan_state || 'disconnected'}\nAddress ${device.config?.wan_ip || 'not assigned'}\nMask ${device.config?.wan_mask || 'not configured'}\nGateway ${device.config?.wan_gateway || 'not configured'}\nDNS ${(device.config?.wan_dns_servers || []).join(', ') || 'none'}\nNAT ${device.config?.nat_enabled === false ? 'disabled' : 'enabled'}`);
    } else if (lower.startsWith('nslookup ')) {
      const domain = input.split(/\s+/).slice(1).join(''), result = resolveDns(device.id, domain); state.lastPacket = { ...result, source: device.id, target: '', protocol: 'dns', port: 53, path: result.transactions?.at(-1)?.path || [], layers: { application: 'DNS', domain: result.domain, answer: result.address || 'none' } };
      cliPrint((result.transactions || []).map(item => `${item.title}: ${item.detail}`).join('\n')); cliPrint(result.allowed ? `Answer: ${result.domain} = ${result.address}` : `Lookup failed: ${result.reason}`); renderPacketResult(state.lastPacket);
    } else if (lower.startsWith('http get ')) {
      const domain = input.split(/\s+/).slice(2).join(''), result = simulateWebRequest(device.id, domain); state.lastPacket = result; renderPacketResult(result); cliPrint((result.transactions || []).map(item => `${item.title}: ${item.detail}`).join('\n')); cliPrint(result.allowed ? 'HTTP/1.1 200 OK' : `Request failed: ${result.reason}`);
    } else if (lower.startsWith('gateway set ')) {
      const gateway = input.split(/\s+/)[2] || ''; if (ipNumber(gateway) === null) cliPrint('Usage: gateway set <valid IPv4 address>'); else { mutate(() => { device.config.gateway = gateway; }, `CLI set the gateway on ${device.name}.`); cliPrint(`Default gateway set to ${gateway}`); }
    } else if (lower === 'ip route' || lower === 'show routes') cliPrint([`default via ${device.config?.gateway || 'not configured'}`, ...(device.config?.routes || []).map(route => `${route.network} via ${route.gateway}`)].join('\n'));
    else if (lower.startsWith('route add ')) {
      const match = input.match(/^route add\s+(\S+)\s+via\s+(\S+)$/i); if (!match || !validCidr(match[1]) || ipNumber(match[2]) === null) cliPrint('Usage: route add <valid-network>/<prefix> via <valid-gateway>'); else { mutate(() => (device.config.routes ||= []).push({ network: match[1], gateway: match[2] }), `CLI added a route on ${device.name}.`); cliPrint('Route added.'); }
    } else if (lower.startsWith('ping ') || lower.startsWith('traceroute ')) {
      const destination = input.split(/\s+/)[1]; const target = deviceByNetworkIp(destination);
      if (!target) cliPrint(`Destination ${destination} was not found.`); else { const result = simulatePacket(device.id, target.id, 'icmp'); state.lastPacket = result; cliPrint(lower.startsWith('ping') ? (result.allowed ? `Reply from ${destination}: simulated time <1 ms` : `Request failed: ${result.reason}`) : (result.path.length ? result.path.map((id, i) => `${i + 1}  ${deviceById(id)?.config?.ip || deviceById(id)?.name}`).join('\n') : result.reason)); logEvent(`CLI ${lower.startsWith('ping') ? 'ping' : 'traceroute'} from ${device.name} to ${destination}.`); }
    } else if (lower === 'arp') cliPrint(state.topology.devices.filter(item => item.id !== device.id && primaryDeviceAddress(item)).map(item => `${primaryDeviceAddress(item).padEnd(16)} SIM:${item.id.slice(-8).toUpperCase()}`).join('\n') || 'ARP table is empty.');
    else if (lower === 'show interfaces') {
      const interfaces = device.type === 'server' ? Object.entries(device.config?.server_interfaces || {}).map(([name, item]) => ({ name, ...item })) : device.type === 'l3switch' ? (device.config?.svis || []).map(item => ({ name: `VLAN${item.vlan}`, ...item })) : (device.config?.interfaces || []);
      cliPrint(interfaces.length ? interfaces.map(item => `${item.name}: ${item.ip || 'unconfigured'}/${item.mask || '255.255.255.0'}${item.vlan ? ` VLAN ${item.vlan}` : ''}`).join('\n') : `LAN1: ${primaryDeviceAddress(device) || 'unconfigured'} ${device.config?.enabled === false ? 'DOWN' : 'UP'}`);
    }
    else if (lower === 'show mac-table') cliPrint(state.topology.links.filter(link => [link.source, link.target].includes(device.id)).map(link => `SIM:${(link.source === device.id ? link.target : link.source).slice(-8).toUpperCase()}  ${portForLink(link, device.id)}`).join('\n') || 'No learned devices.');
    else if (lower === 'show vlans') cliPrint(`Access VLAN: ${device.config?.vlan || 1}\nVLANs: ${csv(device.config?.vlans) || device.config?.vlan || 1}\nTrunk ports: ${csv(device.config?.trunk_ports) || 'none'}\nAllowed trunk VLANs: ${csv(device.config?.trunk_vlans) || 'none'}`);
    else if (lower === 'show acl') cliPrint((device.config?.acl_rules || []).map((rule, index) => `${index + 1}. ${rule.action === 'allow' ? 'PERMIT' : 'DENY'} ${String(rule.protocol || 'any').toUpperCase()} ${rule.source || 'any'} → ${rule.destination || 'any'}${Number(rule.port) > 0 ? ` port ${rule.port}` : ''} ${rule.interface || 'any'}/${rule.direction || 'both'}`).join('\n') || `No ACL rules. Unmatched routed traffic is ${device.config?.acl_default_deny ? 'DENIED' : 'PERMITTED'}.`);
    else if (lower.startsWith('vlan set ')) { const vlan = Math.max(1, Math.min(4094, Number(input.split(/\s+/)[2]) || 1)); mutate(() => { device.config.vlan = vlan; }, `CLI set ${device.name} to VLAN ${vlan}.`); cliPrint(`Access VLAN set to ${vlan}`); }
    else if (lower === 'show firewall') cliPrint((device.config?.firewall_rules || []).map((rule, i) => `${i + 1}. ${String(rule.action).toUpperCase()} ${String(rule.protocol).toUpperCase()} port ${rule.port}`).join('\n') || 'No firewall rules. Default simulated policy: deny transit traffic.');
    else if (lower.startsWith('scan ')) {
      const destination = input.split(/\s+/)[1], target = deviceByNetworkIp(destination);
      if (!target) cliPrint(`Host ${destination} not found.`); else { const ports = { http: 80, https: 443, ssh: 22, dns: 53 }; const findings = (target.config?.services || []).map(service => `${ports[service] || 'dynamic'}/tcp open ${service}`); cliPrint(`Simulated scan of ${destination}\n${findings.join('\n') || 'No common services detected.'}`); logEvent(`${device.name} scanned ${target.name}.`); }
    } else if (lower === 'inspect last') cliPrint(state.lastPacket ? JSON.stringify(state.lastPacket, null, 2) : 'No packet has been simulated yet.');
    else cliPrint(`Unknown command: ${input}. Type help.`);
  }

  async function saveCurrent() {
    if (!state.topology || !state.bootstrap?.can_save || ['lab', 'demo'].includes(state.mode)) return;
    if (state.saveInFlight) { state.saveQueued = true; return; }
    clearTimeout(state.saveTimer); state.saveTimer = 0;
    state.topology.title = $('networkTitleInput').value.trim() || 'Untitled Network';
    const topology = clone(state.topology), topologyId = topology.id, revision = state.topologyRevision;
    state.saveInFlight = true; state.saveQueued = false;
    setStatus('Saving…');
    try {
      const saved = await api(`/api/network/topologies/${encodeURIComponent(topologyId)}`, { method: 'PUT', body: JSON.stringify({ topology }) });
      if (state.bootstrap) {
        const summary = Object.fromEntries(['id', 'title', 'description', 'created_at', 'updated_at'].map(key => [key, saved[key]]));
        state.bootstrap.saved = [...(state.bootstrap.saved || []).filter(item => item.id !== saved.id), summary].sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0));
      }
      if (state.topology?.id === topologyId) {
        state.savedOnce = true;
        state.topology.created_at = saved.created_at; state.topology.updated_at = saved.updated_at;
        if (state.topologyRevision === revision) setStatus('Saved', 'good');
        else { setStatus('Saving latest changes…'); scheduleSave(); }
        logEvent('Network saved.');
      }
    } catch (error) {
      if (state.topology?.id === topologyId) setStatus('Save failed', 'error');
      alert(`Could not save ${topology.title}: ${error.message}`);
    } finally {
      state.saveInFlight = false;
      const queued = state.saveQueued; state.saveQueued = false;
      if (queued) setTimeout(saveCurrent, 0);
    }
  }
  function scheduleSave() {
    clearTimeout(state.saveTimer);
    const callback = state.mode === 'lab' ? saveLabProgress : state.savedOnce && state.bootstrap?.can_save ? saveCurrent : null;
    state.saveTimer = callback ? setTimeout(() => { state.saveTimer = 0; callback(); }, state.mode === 'lab' ? 700 : 900) : 0;
  }
  function flushPendingSave() {
    if (!state.saveTimer) return null;
    clearTimeout(state.saveTimer); state.saveTimer = 0;
    if (state.mode === 'lab') return saveLabProgress();
    if (state.savedOnce && state.bootstrap?.can_save) return saveCurrent();
    return null;
  }
  async function saveLabProgress() {
    if (!state.lab || !state.labClassId) return;
    if (state.labSaveInFlight) { state.labSaveQueued = true; return; }
    clearTimeout(state.saveTimer); state.saveTimer = 0;
    const labId = state.lab.id, classId = state.labClassId, topology = clone(state.topology);
    state.labSaveInFlight = true; state.labSaveQueued = false;
    setStatus('Saving progress…');
    try {
      const progress = await api(`/api/network/student/labs/${encodeURIComponent(classId)}/${encodeURIComponent(labId)}`, { method: 'PUT', body: JSON.stringify({ topology }) });
      if (state.mode === 'lab' && state.lab?.id === labId && state.labClassId === classId) {
        state.grade = progress.grade; setStatus(progress.grade?.passed ? 'Lab complete' : `Saved · ${progress.grade?.percent || 0}%`, 'good');
      }
    } catch (error) {
      if (state.mode === 'lab' && state.lab?.id === labId && state.labClassId === classId) setStatus('Progress save failed', 'error');
    } finally {
      state.labSaveInFlight = false;
      const queued = state.labSaveQueued; state.labSaveQueued = false;
      if (queued) setTimeout(saveLabProgress, 0);
    }
  }
  async function deleteSaved(id) {
    if (!confirm('Delete this saved network? This cannot be undone.')) return;
    try { await api(`/api/network/topologies/${encodeURIComponent(id)}`, { method: 'DELETE' }); await loadBootstrap({ force: true }); }
    catch (error) { alert(error.message); }
  }
  function exportCurrent() {
    if (!state.topology) return;
    const blob = new Blob([JSON.stringify(state.topology, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url; anchor.download = `${(state.topology.title || 'network').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'network'}.json`;
    anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importTopology(file) {
    try {
      const byteLimit = state.bootstrap?.limits?.topology_bytes || 512000;
      if (!file || file.size > byteLimit) throw new Error(`Network JSON must be smaller than ${Math.floor(byteLimit / 1000)} KB.`);
      const topology = JSON.parse(await file.text());
      if (!Array.isArray(topology.devices) || !Array.isArray(topology.links) || topology.devices.length > LIMITS.devices || topology.links.length > LIMITS.links) throw new Error('This file is not a valid EagleIDE network topology.');
      if (Number(topology.schema_version || 1) > 2) throw new Error('This network was created by a newer EagleIDE topology format and cannot be imported safely.');
      topology.id = makeId('network'); topology.metadata = { ...(topology.metadata || {}), imported: true };
      openTopology(topology, { mode: 'personal', saved: false });
    } catch (error) { alert(error.message || 'Could not import that network.'); }
  }

  function updateZoom() {
    document.documentElement.style.setProperty('--network-canvas-width', `${1000 * state.zoom}px`);
    document.documentElement.style.setProperty('--network-canvas-height', `${600 * state.zoom}px`);
    $('networkCanvas').style.transform = `scale(${state.zoom})`;
    $('networkZoomOutput').textContent = `${Math.round(state.zoom * 100)}%`;
  }
  function zoomBy(delta) { state.zoom = Math.max(.5, Math.min(1.5, Math.round((state.zoom + delta) * 10) / 10)); updateZoom(); }
  function fitCanvas() {
    const pane = $('networkCanvasScroll');
    if (!pane) return;
    state.zoom = Math.max(.5, Math.min(1, Math.min((pane.clientWidth - 10) / 1000, (pane.clientHeight - 10) / 600)));
    updateZoom();
  }

  function switchConsole(name) {
    document.querySelectorAll('.network-console-tabs [data-network-panel]').forEach(button => button.classList.toggle('active', button.dataset.networkPanel === name));
    document.querySelectorAll('[data-network-panel-content]').forEach(panel => panel.classList.toggle('active', panel.dataset.networkPanelContent === name));
  }
  function referenceMarkup() {
    const commands = state.bootstrap?.command_reference || [];
    const ports = state.bootstrap?.port_reference || [];
    const acronyms = state.bootstrap?.acronym_reference || [];
    return `<div class="network-reference">
      <section class="network-reference-section"><header><h3>CLI commands</h3><p>Vendor-neutral commands supported by the selected simulated device.</p></header><div class="network-command-list">${commands.map(item => `<div class="network-command-row"><code>${escapeHtml(item.command)}</code><span>${escapeHtml(item.description)}</span></div>`).join('')}</div></section>
      <section class="network-reference-section"><header><h3>Common ports</h3><p>Well-known and frequently encountered service ports.</p></header><div class="network-reference-table-wrap"><table><thead><tr><th scope="col">Port</th><th scope="col">Transport</th><th scope="col">Service</th><th scope="col">Purpose</th></tr></thead><tbody>${ports.map(item => `<tr><th scope="row">${escapeHtml(item.port)}</th><td>${escapeHtml(item.transport)}</td><td><strong>${escapeHtml(item.service)}</strong></td><td>${escapeHtml(item.description)}</td></tr>`).join('')}</tbody></table></div></section>
      <section class="network-reference-section"><header><h3>Common acronyms</h3><p>Terms used throughout networking and cybersecurity.</p></header><div class="network-reference-table-wrap"><table><thead><tr><th scope="col">Term</th><th scope="col">Meaning</th><th scope="col">Definition</th></tr></thead><tbody>${acronyms.map(item => `<tr><th scope="row">${escapeHtml(item.term)}</th><td><strong>${escapeHtml(item.meaning)}</strong></td><td>${escapeHtml(item.description)}</td></tr>`).join('')}</tbody></table></div></section>
    </div>`;
  }
  function renderCommandReference() {
    const markup = referenceMarkup();
    if ($('networkCommandList')) $('networkCommandList').innerHTML = markup;
    if ($('networkReferencePanel')) $('networkReferencePanel').innerHTML = markup;
  }

  async function openTeacherPanel() {
    const ctx = context();
    const classes = ctx.teacherClasses || [];
    const select = $('networkTeacherClassSelect');
    select.innerHTML = classes.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('');
    if (!classes.length) { $('networkTeacherLabList').innerHTML = '<div class="network-objectives-empty">Create a class before assigning network labs.</div>'; return; }
    state.teacherClassId = classes.some(item => item.id === state.teacherClassId) ? state.teacherClassId : (ctx.currentTeacherClassId || classes[0].id);
    select.value = state.teacherClassId;
    await loadTeacherClass();
  }
  async function loadTeacherClass() {
    const classId = $('networkTeacherClassSelect').value || state.teacherClassId;
    if (!classId) return;
    state.teacherClassId = classId;
    $('networkTeacherStatus').textContent = 'Loading labs…';
    try {
      const data = await api(`/api/network/teacher/classes/${encodeURIComponent(classId)}`);
      $('networkTeacherAccessToggle').checked = !!data.enabled;
      $('networkTeacherStatus').textContent = data.enabled ? `${data.class_name} can use Network Simulator when it is globally enabled.` : `${data.class_name} cannot currently open Network Simulator.`;
      renderTeacherLabs(data.labs || []);
    } catch (error) { $('networkTeacherStatus').textContent = error.message; $('networkTeacherLabList').innerHTML = ''; }
  }
  function renderTeacherLabs(labs) {
    $('networkTeacherLabList').innerHTML = labs.map(lab => {
      const students = lab.progress?.students || [];
      const rows = students.map(student => {
        const updated = student.updated_at ? new Date(Number(student.updated_at) * 1000).toLocaleString() : '—';
        const status = student.status === 'completed' ? 'Completed' : student.status === 'in_progress' ? 'In progress' : 'Not started';
        return `<tr><th scope="row"><strong>${escapeHtml(student.name)}</strong><span>${escapeHtml(student.email)}</span></th><td><span class="network-student-status is-${escapeHtml(student.status)}">${status}</span></td><td><strong>${Number(student.score) || 0}%</strong><span>${Number(student.objectives_completed) || 0}/${Number(student.objectives_total) || 0} objectives</span></td><td>${escapeHtml(updated)}</td></tr>`;
      }).join('');
      const studentProgress = `<details class="network-student-progress"><summary>Student progress · ${lab.progress?.passed || 0}/${lab.progress?.roster_count || students.length} completed</summary>${students.length ? `<div class="network-student-results-scroll"><table><thead><tr><th>Student</th><th>Status</th><th>Score / progress</th><th>Last saved</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="network-objectives-empty">No students are enrolled in this class.</div>'}</details>`;
      return `<article class="network-teacher-lab ${lab.assigned ? 'is-assigned' : ''}">
        <div><h3>${escapeHtml(lab.title)}</h3><p>${escapeHtml(lab.description)}</p><div class="network-teacher-lab-meta"><span>${escapeHtml(lab.level)}</span><span>${Number(lab.estimated_minutes) || 0} min</span>${(lab.covers || []).map(item => `<span>${escapeHtml(item)}</span>`).join('')}</div></div>
        <div class="network-lab-progress"><div>${lab.progress?.started || 0}/${lab.progress?.roster_count || students.length} started · ${lab.progress?.passed || 0} completed</div><div>Class average ${lab.progress?.average_percent || 0}%</div><button class="btn run" type="button" data-teacher-demo-lab="${escapeHtml(lab.id)}">Open to Demonstrate</button><button class="btn ${lab.assigned ? 'secondary' : 'run'}" type="button" data-teacher-lab="${escapeHtml(lab.id)}" data-assigned="${lab.assigned ? 'true' : 'false'}">${lab.assigned ? 'Remove Assignment' : 'Assign Lab'}</button></div>
        ${studentProgress}
        <details><summary>Instructions and step-by-step solution</summary><h4>Student instructions</h4><ol>${(lab.instructions || []).map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ol><h4>Teacher solution</h4><ol>${(lab.solution || []).map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ol></details>
      </article>`;
    }).join('');
  }
  async function toggleTeacherLab(button) {
    const classId = state.teacherClassId, labId = button.dataset.teacherLab, assigned = button.dataset.assigned === 'true';
    button.disabled = true;
    try { await api(`/api/network/teacher/classes/${encodeURIComponent(classId)}/labs/${encodeURIComponent(labId)}`, { method: assigned ? 'DELETE' : 'PUT', body: assigned ? undefined : '{}' }); await loadTeacherClass(); }
    catch (error) { $('networkTeacherStatus').textContent = error.message; button.disabled = false; }
  }
  async function openTeacherLabDemo(labId) {
    if (!state.teacherClassId || !labId) return;
    $('networkTeacherStatus').textContent = 'Opening demonstration copy…';
    try {
      const lab = await api(`/api/network/labs/${encodeURIComponent(labId)}?class_id=${encodeURIComponent(state.teacherClassId)}`);
      state.lab = lab; state.labClassId = '';
      showMode();
      openTopology(lab.starter_topology, { mode: 'demo', saved: false });
      logEvent(`Opened teacher demonstration for ${lab.title}. Changes are temporary.`);
    } catch (error) { $('networkTeacherStatus').textContent = error.message; }
  }
  async function setTeacherAccess(enabled) {
    if (!state.teacherClassId) return;
    $('networkTeacherStatus').textContent = 'Saving class access…';
    try { await api(`/api/network/teacher/classes/${encodeURIComponent(state.teacherClassId)}/access`, { method: 'PUT', body: JSON.stringify({ enabled }) }); await loadTeacherClass(); }
    catch (error) { $('networkTeacherStatus').textContent = error.message; $('networkTeacherAccessToggle').checked = !enabled; }
  }

  function setupPanelResizers() {
    const workspace = $('networkWorkspace');
    const inspectorHandle = $('networkInspectorResizer');
    const consoleHandle = $('networkConsoleResizer');
    if (!workspace || !inspectorHandle || !consoleHandle) return;
    const readSaved = (key, fallback) => {
      try { const value = Number(localStorage.getItem(key)); return Number.isFinite(value) && value > 0 ? value : fallback; }
      catch (_) { return fallback; }
    };
    const save = (key, value) => { try { localStorage.setItem(key, String(Math.round(value))); } catch (_) {} };
    let inspectorWidth = readSaved('eagle-network-inspector-width', 330);
    let consoleHeight = readSaved('eagle-network-console-height', 245);
    const applyInspector = value => {
      const maximum = Math.max(280, Math.min(560, workspace.clientWidth - 560));
      inspectorWidth = Math.max(280, Math.min(maximum, Number(value) || 330));
      workspace.style.setProperty('--network-inspector-width', `${inspectorWidth}px`);
      inspectorHandle.setAttribute('aria-valuemin', '280'); inspectorHandle.setAttribute('aria-valuemax', String(maximum)); inspectorHandle.setAttribute('aria-valuenow', String(Math.round(inspectorWidth)));
    };
    const applyConsole = value => {
      const maximum = Math.max(180, Math.min(620, workspace.clientHeight - 285));
      consoleHeight = Math.max(180, Math.min(maximum, Number(value) || 245));
      workspace.style.setProperty('--network-console-height', `${consoleHeight}px`);
      consoleHandle.setAttribute('aria-valuemin', '180'); consoleHandle.setAttribute('aria-valuemax', String(maximum)); consoleHandle.setAttribute('aria-valuenow', String(Math.round(consoleHeight)));
    };
    const bindPointerResize = (handle, startValue, update, storageKey, deltaForEvent) => {
      handle.addEventListener('pointerdown', event => {
        if (event.button !== undefined && event.button !== 0) return;
        event.preventDefault();
        const initial = startValue(), startX = event.clientX, startY = event.clientY;
        handle.classList.add('is-resizing');
        handle.setPointerCapture?.(event.pointerId);
        const move = moveEvent => update(initial + deltaForEvent(moveEvent, startX, startY));
        const finish = () => {
          handle.classList.remove('is-resizing');
          handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', finish); handle.removeEventListener('pointercancel', finish);
          save(storageKey, startValue());
        };
        handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', finish); handle.addEventListener('pointercancel', finish);
      });
    };
    applyInspector(inspectorWidth); applyConsole(consoleHeight);
    bindPointerResize(inspectorHandle, () => inspectorWidth, applyInspector, 'eagle-network-inspector-width', (event, startX) => startX - event.clientX);
    bindPointerResize(consoleHandle, () => consoleHeight, applyConsole, 'eagle-network-console-height', (event, _startX, startY) => startY - event.clientY);
    inspectorHandle.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
      event.preventDefault(); applyInspector(event.key === 'Home' ? 330 : inspectorWidth + (event.key === 'ArrowLeft' ? 20 : -20)); save('eagle-network-inspector-width', inspectorWidth);
    });
    consoleHandle.addEventListener('keydown', event => {
      if (!['ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
      event.preventDefault(); applyConsole(event.key === 'Home' ? 245 : consoleHeight + (event.key === 'ArrowUp' ? 24 : -24)); save('eagle-network-console-height', consoleHeight);
    });
    inspectorHandle.addEventListener('dblclick', () => { applyInspector(330); save('eagle-network-inspector-width', inspectorWidth); });
    consoleHandle.addEventListener('dblclick', () => { applyConsole(245); save('eagle-network-console-height', consoleHeight); });
    window.addEventListener('resize', () => { applyInspector(inspectorWidth); applyConsole(consoleHeight); });
  }

  function attachEvents() {
    $('networkViewBtn')?.addEventListener('click', () => show());
    $('wikiHeroNetworkBtn')?.addEventListener('click', () => show());
    $('networkNewBtn')?.addEventListener('click', () => openTopology(blankTopology(), { mode: 'personal', saved: false }));
    $('networkBackBtn')?.addEventListener('click', async () => { const pendingSave = showLibrary(); await Promise.resolve(pendingSave); await loadBootstrap({ force: true }).catch(error => { $('networkLoading').textContent = error.message; }); });
    $('networkDevicePalette')?.addEventListener('click', event => { const button = event.target.closest('[data-add-device]'); if (button) addDevice(button.dataset.addDevice); });
    $('networkCanvas')?.addEventListener('pointerdown', event => {
      if (state.connectMode || event.target.closest?.('[data-device-id],[data-link-select],[data-link-id],#networkPortPicker')) return;
      if (!state.selectedId && !state.selectedLinkId) return;
      state.selectedId = '';
      state.selectedLinkId = '';
      renderCanvas();
      renderInspector();
    });
    $('networkConnectBtn')?.addEventListener('click', () => { state.connectMode = !state.connectMode; state.connectSource = ''; state.connectSourcePort = ''; state.connectKind = ''; closePortPicker(); $('networkConnectBtn').setAttribute('aria-pressed', String(state.connectMode)); setStatus(state.connectMode ? `Select a device, then choose one of its available ${selectedCableKind()} ports` : ''); renderCanvas(); });
    $('networkDeleteBtn')?.addEventListener('click', deleteSelected);
    $('networkUndoBtn')?.addEventListener('click', undo);
    $('networkRedoBtn')?.addEventListener('click', redo);
    $('networkSaveBtn')?.addEventListener('click', saveCurrent);
    $('networkExportBtn')?.addEventListener('click', exportCurrent);
    $('networkTitleInput')?.addEventListener('change', () => mutate(() => { state.topology.title = $('networkTitleInput').value.trim() || 'Untitled Network'; }, 'Renamed network.', { inspector: false }));
    $('networkZoomInBtn')?.addEventListener('click', () => zoomBy(.1));
    $('networkZoomOutBtn')?.addEventListener('click', () => zoomBy(-.1));
    $('networkZoomFitBtn')?.addEventListener('click', fitCanvas);
    $('networkPacketSendBtn')?.addEventListener('click', sendPacket);
    $('networkPacketProtocol')?.addEventListener('change', renderPacketOptions);
    $('networkCliForm')?.addEventListener('submit', event => { event.preventDefault(); runCli($('networkCliInput').value); $('networkCliInput').value = ''; });
    document.querySelectorAll('.network-console-tabs [data-network-panel]').forEach(button => button.addEventListener('click', () => switchConsole(button.dataset.networkPanel)));
    $('networkLibrary')?.addEventListener('click', event => {
      const lab = event.target.closest('[data-open-lab]'); if (lab) return openLab(lab.dataset.openLab, lab.dataset.classId);
      const example = event.target.closest('[data-open-example]'); if (example) return openExample(example.dataset.openExample);
      const remove = event.target.closest('[data-delete-saved]'); if (remove) { event.stopPropagation(); return deleteSaved(remove.dataset.deleteSaved); }
      const saved = event.target.closest('[data-open-saved]'); if (saved) return openSaved(saved.dataset.openSaved);
    });
    $('networkImportInput')?.addEventListener('change', event => { importTopology(event.target.files?.[0]); event.target.value = ''; });
    $('networkCommandRefBtn')?.addEventListener('click', () => { $('networkCommandModal').style.display = 'flex'; });
    $('networkCommandCloseBtn')?.addEventListener('click', () => { $('networkCommandModal').style.display = 'none'; });
    $('networkCommandModal')?.addEventListener('click', event => { if (event.target === $('networkCommandModal')) $('networkCommandModal').style.display = 'none'; });
    $('networkTeacherClassSelect')?.addEventListener('change', loadTeacherClass);
    $('networkTeacherRefreshBtn')?.addEventListener('click', loadTeacherClass);
    $('networkTeacherAccessToggle')?.addEventListener('change', event => setTeacherAccess(event.target.checked));
    $('networkTeacherLabList')?.addEventListener('click', event => {
      const demo = event.target.closest('[data-teacher-demo-lab]'); if (demo) return openTeacherLabDemo(demo.dataset.teacherDemoLab);
      const button = event.target.closest('[data-teacher-lab]'); if (button) toggleTeacherLab(button);
    });
    $('settingsOpenNetworkSimBtn')?.addEventListener('click', () => { $('adminSettingsModal').style.display = 'none'; show(); });
    [$('wikiViewBtn'), $('ideViewBtn')].forEach(button => button?.addEventListener('click', () => { stopPacketPlayback(); flushPendingSave(); }));
    window.addEventListener('eagle-context-updated', refreshAvailability);
    window.addEventListener('pagehide', stopPacketPlayback);
    window.addEventListener('keydown', event => {
      if (!document.body.classList.contains('network-mode')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (state.mode === 'lab') saveLabProgress(); else if (state.mode !== 'demo') saveCurrent(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
      if ((event.key === 'Delete' || event.key === 'Backspace') && !event.target.matches('input,textarea,select')) deleteSelected();
      if (event.key === 'Escape') { state.connectMode = false; state.connectSource = ''; state.connectSourcePort = ''; state.connectKind = ''; closePortPicker(); $('networkConnectBtn').setAttribute('aria-pressed', 'false'); renderCanvas(); }
    });
  }

  function initialize() {
    if (state.initialized) return;
    state.initialized = true;
    attachEvents();
    setupPanelResizers();
    refreshAvailability();
  }

  window.NetworkSim = {
    applyConfig, openTeacherPanel, refreshAvailability, show,
    getState: () => state,
    getTopology: () => state.topology,
    mutate, renderAll, renderCanvas, renderInspector, renderPacketResult,
    simulatePacket, findPath, deviceById, deviceAddresses, primaryDeviceAddress,
    linkBetween, linkForwards, spanningTreeState, effectiveLinkSpeed, portForLink,
    defaultConfig, normalizeDeviceConfig, makeId, escapeHtml, runCli, scheduleSave,
    selectDevice: id => { state.selectedId = id || ''; state.selectedLinkId = ''; renderCanvas(); renderInspector(); },
  };
  initialize();
})();
