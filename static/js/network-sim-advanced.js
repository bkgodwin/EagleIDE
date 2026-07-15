(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const captures = [];
  const alerts = [];
  const arpTables = new Map();
  const macTables = new Map();
  const sessions = [];
  const selected = new Set();
  const cliHistory = [];
  let cliIndex = 0;
  let worker = null;
  let running = false;
  let snapEnabled = false;
  let multiSelectMode = false;
  let selectedCapture = 0;
  let nextCaptureNumber = 1;
  let clockMs = 0;
  let captureRenderFrame = 0;
  const cliContext = { mode: 'exec', interface: '', device: '' };

  function api() { return window.NetworkSim || null; }
  function state() { return api()?.getState?.() || {}; }
  function topology() { return api()?.getTopology?.() || null; }
  function escapeHtml(value) { return api()?.escapeHtml?.(value) ?? String(value ?? '').replace(/[&<>"']/g, ''); }
  function addresses(device) { return api()?.deviceAddresses?.(device) || []; }
  function primaryAddress(device) { return api()?.primaryDeviceAddress?.(device) || addresses(device)[0] || ''; }
  function mac(device) { return `02:EA:${hash(String(device?.id || '')).slice(0, 2)}:${hash(String(device?.id || '')).slice(2, 4)}:${hash(String(device?.id || '')).slice(4, 6)}:${hash(String(device?.id || '')).slice(6, 8)}`.toUpperCase(); }
  function hash(text) {
    let value = 2166136261;
    for (let index = 0; index < text.length; index += 1) value = Math.imul(value ^ text.charCodeAt(index), 16777619);
    return (value >>> 0).toString(16).padStart(8, '0');
  }
  function download(name, content, type = 'text/plain') {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function formatClock(value) {
    const minutes = Math.floor(value / 60000), seconds = Math.floor((value % 60000) / 1000), millis = value % 1000;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
  }
  function workerTopology() {
    const current = topology() || { devices: [], links: [] };
    const graph = new Map(current.devices.map(device => [device.id, new Set()]));
    current.links.filter(link => api()?.linkForwards?.(link)).forEach(link => { graph.get(link.source)?.add(link.target); graph.get(link.target)?.add(link.source); });
    current.devices.filter(client => ['laptop','phone'].includes(client.type)).forEach(client => {
      const matches = current.devices.filter(wap => {
        const wapBand = String(wap.config?.band || 'dual'), clientBand = String(client.config?.wifi_band || 'auto');
        const bandMatches = clientBand === 'auto' || wapBand === 'dual' || wapBand === clientBand;
        return wap.type === 'wap' && wap.config?.enabled !== false && client.config?.ssid && client.config.ssid === wap.config?.ssid && (client.config?.wifi_password || '') === (wap.config?.wifi_password || '') && bandMatches && Math.hypot((client.x || 0) - (wap.x || 0), (client.y || 0) - (wap.y || 0)) <= Math.max(40, Number(wap.config?.range) || 280);
      }).sort((a,b) => Math.hypot((client.x||0)-(a.x||0),(client.y||0)-(a.y||0)) - Math.hypot((client.x||0)-(b.x||0),(client.y||0)-(b.y||0)));
      const wap = matches[0]; if (wap) { graph.get(client.id)?.add(wap.id); graph.get(wap.id)?.add(client.id); }
    });
    const reachable = device => { const seen = new Set([device.id]), queue = [device.id]; while (queue.length) { const id = queue.shift(); graph.get(id)?.forEach(next => { if (!seen.has(next)) { seen.add(next); queue.push(next); } }); } seen.delete(device.id); return [...seen]; };
    return {
      devices: current.devices.map(device => ({ id: device.id, name: device.name, type: device.type, ip: primaryAddress(device), ipv6: device.config?.ipv6_address || '', services: device.config?.services || [], ssid: device.config?.ssid || '', reachable: reachable(device) })),
      links: current.links.map(link => ({ source: link.source, target: link.target, kind: link.kind })),
    };
  }
  function simulationSettings() {
    return {
      seed: Math.max(1, Number($('networkTrafficSeed')?.value) || 1337),
      profile: $('networkTrafficProfile')?.value || 'classroom',
      speed: Number($('networkTrafficSpeed')?.value) || 1,
    };
  }
  function saveSimulationSettings() {
    const current = topology(); if (!current) return;
    current.metadata ||= {}; current.metadata.simulation = simulationSettings();
    if ($('networkTrafficSeedState')) $('networkTrafficSeedState').textContent = `Seed ${current.metadata.simulation.seed}`;
    api()?.scheduleSave?.();
  }
  function initWorker({ reset = true } = {}) {
    if (!window.Worker) return;
    if (!worker) {
      worker = new Worker('/static/js/network-sim-worker.js?v=20260714-3');
      worker.addEventListener('message', event => {
        const message = event.data || {};
        if (message.type === 'frames') {
          clockMs = Number(message.clock_ms) || clockMs;
          markTrafficProfile(message.profile);
          message.frames?.forEach(addCapture);
          animateBackgroundFrame(message.frames?.[0]);
        } else if (message.type === 'ready') { clockMs = Number(message.clock_ms) || 0; renderTrafficStatus(); }
      });
      worker.addEventListener('error', error => {
        running = false; updateTrafficButton();
        alerts.unshift({ title: 'Traffic engine stopped', detail: error.message || 'The simulation worker could not continue.', severity: 'high', time_ms: clockMs });
        renderAlerts();
      });
    }
    worker.postMessage({ type: 'init', topology: workerTopology(), ...simulationSettings(), reset });
  }
  function toggleTraffic() {
    if (!worker) initWorker();
    running = !running;
    saveSimulationSettings();
    worker?.postMessage({ type: 'settings', ...simulationSettings() });
    worker?.postMessage({ type: running ? 'start' : 'stop' });
    updateTrafficButton();
  }
  function stopTraffic({ terminate = false } = {}) {
    if (worker) worker.postMessage({ type: 'stop' });
    running = false;
    updateTrafficButton();
    if (terminate && worker) { worker.terminate(); worker = null; }
  }
  function markTrafficProfile(profile) {
    const current = topology(), name = String(profile || ''); if (!current || !name) return;
    const completed = current.metadata?.simulation?.completed_profiles || [];
    if (completed.includes(name)) return;
    api()?.mutate?.(() => {
      current.metadata ||= {}; current.metadata.simulation ||= {};
      current.metadata.simulation.completed_profiles = [...completed, name].slice(-20);
    }, `Generated the ${name} traffic profile.`);
  }
  function stepTraffic() {
    if (!worker) initWorker();
    saveSimulationSettings();
    worker?.postMessage({ type: 'settings', ...simulationSettings() });
    worker?.postMessage({ type: 'step' });
  }
  function updateTrafficButton() {
    const button = $('networkTrafficToggleBtn'); if (!button) return;
    button.textContent = running ? '■ Stop traffic' : '▶ Start traffic';
    button.setAttribute('aria-pressed', String(running));
  }
  function renderTrafficStatus() {
    if ($('networkSimulationClock')) $('networkSimulationClock').textContent = formatClock(clockMs);
    if ($('networkTrafficFrameCount')) $('networkTrafficFrameCount').textContent = String(captures.length);
    if ($('networkTrafficAlertCount')) $('networkTrafficAlertCount').textContent = String(alerts.length);
    if ($('networkTrafficSeedState')) $('networkTrafficSeedState').textContent = `Seed ${simulationSettings().seed}`;
  }

  function scheduleCaptureRender() {
    if (captureRenderFrame) return;
    captureRenderFrame = requestAnimationFrame(() => {
      captureRenderFrame = 0;
      renderCaptures(); renderAlerts(); renderTrafficStatus();
    });
  }

  function addCapture(raw) {
    if (!raw) return;
    const item = { ...raw, number: nextCaptureNumber++, time_ms: Number(raw.time_ms) || clockMs };
    captures.push(item);
    if (captures.length > 2000) captures.splice(0, captures.length - 2000);
    if (item.alert) {
      alerts.unshift({ title: item.alert, detail: `${item.source} → ${item.destination} · ${item.info}`, severity: item.severity || 'medium', time_ms: item.time_ms });
      alerts.splice(25);
    }
    learnFromFrame(item);
    scheduleCaptureRender();
  }
  function learnFromFrame(frame) {
    const current = topology(); if (!current) return;
    const source = current.devices.find(device => device.id === frame.source_id);
    const destination = current.devices.find(device => device.id === frame.destination_id);
    if (source && frame.source_address && /^\d+\.\d+/.test(frame.source_address)) {
      (arpTables.get(source.id) || arpTables.set(source.id, new Map()).get(source.id)).set(frame.destination_address?.split(':')[0] || primaryAddress(destination), mac(destination));
    }
    const path = source && destination ? api()?.findPath?.(source.id, destination.id) || [] : [];
    path.forEach((id, index) => {
      const device = current.devices.find(item => item.id === id);
      if (!['switch', 'l3switch'].includes(device?.type) || !source) return;
      const previous = path[index - 1], link = previous ? api()?.linkBetween?.(id, previous) : null;
      const port = link ? api()?.portForLink?.(link, id) : 'local';
      (macTables.get(id) || macTables.set(id, new Map()).get(id)).set(mac(source), { port, vlan: Number(source.config?.vlan) || 1, learned_at: clockMs });
    });
  }
  function manualCapture(result) {
    if (!result) return;
    const current = topology(), source = current?.devices.find(device => device.id === result.source), destination = current?.devices.find(device => device.id === result.target);
    const isIpv6Packet = String(result.protocol || '').toLowerCase() === 'icmp6';
    if (source && destination && isIpv6Packet) {
      addCapture({ time_ms: clockMs, source: source.name, source_id: source.id, source_address: source.config?.ipv6_address || mac(source), destination: 'Solicited-node multicast', destination_address: 'ff02::1:ff00:0', protocol: 'ICMPv6', length: 86, info: `Neighbor Solicitation for ${destination.config?.ipv6_address || destination.name}`, layers: { frame: 'Ethernet multicast', network: 'IPv6 link-local multicast', ndp: `Resolve ${destination.config?.ipv6_address || destination.name}` } });
    } else if (source && destination && !['dhcp', 'web', 'dns'].includes(result.protocol)) {
      addCapture({ time_ms: clockMs, source: source.name, source_id: source.id, source_address: mac(source), destination: 'Broadcast', destination_address: 'ff:ff:ff:ff:ff:ff', protocol: 'ARP', length: 42, info: `Who has ${primaryAddress(destination)}? Tell ${primaryAddress(source)}`, layers: { frame: 'Ethernet broadcast', arp: `Resolve ${primaryAddress(destination)}` } });
    }
    const protocol = isIpv6Packet ? 'ICMPv6' : String(result.protocol || 'packet').toUpperCase();
    addCapture({ time_ms: clockMs += 10, source: source?.name || result.source, source_id: source?.id || '', source_address: isIpv6Packet ? source?.config?.ipv6_address : primaryAddress(source), destination: destination?.name || result.target || 'Broadcast', destination_id: destination?.id || '', destination_address: isIpv6Packet ? destination?.config?.ipv6_address : primaryAddress(destination), protocol, length: ['ICMP', 'ICMPv6'].includes(protocol) ? 98 : 128, info: result.allowed ? `Delivered · ${result.reason}` : `Blocked · ${result.reason}`, layers: result.layers || {}, alert: result.allowed ? '' : 'Packet blocked by network policy', severity: result.allowed ? '' : 'low' });
    if (result.allowed && ['TCP', 'UDP', 'WEB'].includes(protocol)) recordSession(result, source, destination);
  }
  function recordSession(result, source, destination) {
    const path = result.path || [];
    const protocol = result.protocol === 'web' ? 'tcp' : result.protocol;
    const middle = (topology()?.devices || []).filter(device => path.includes(device.id) && ['router', 'firewall'].includes(device.type));
    middle.forEach(device => {
      sessions.unshift({ device: device.id, protocol, source: primaryAddress(source), source_port: 49152 + (nextCaptureNumber % 16000), destination: primaryAddress(destination), destination_port: Number(result.port) || (result.protocol === 'web' ? 80 : 0), translated: device.type === 'router' && device.config?.nat_enabled !== false ? device.config?.wan_ip || 'pending' : '', state: protocol === 'tcp' ? 'ESTABLISHED' : 'ACTIVE', expires: clockMs + 60000 });
    });
    sessions.splice(1000);
  }
  function filteredCaptures() {
    const query = String($('networkCaptureFilter')?.value || '').trim().toLowerCase();
    return query ? captures.filter(item => [item.protocol, item.source, item.destination, item.source_address, item.destination_address, item.info].some(value => String(value || '').toLowerCase().includes(query))) : captures;
  }
  function renderCaptures() {
    const rows = $('networkCaptureRows'); if (!rows) return;
    const items = filteredCaptures().slice(-300).reverse();
    rows.innerHTML = items.length ? items.map(item => `<tr data-capture-number="${item.number}" class="${item.alert ? 'is-alert' : ''} ${selectedCapture === item.number ? 'is-selected' : ''}"><td>${item.number}</td><td>${formatClock(item.time_ms)}</td><td>${escapeHtml(item.source_address || item.source)}</td><td>${escapeHtml(item.destination_address || item.destination)}</td><td>${escapeHtml(item.protocol)}</td><td>${Number(item.length) || 0}</td><td>${escapeHtml(item.info)}</td></tr>`).join('') : '<tr><td colspan="7">No frames captured. Send a packet or start simulated traffic.</td></tr>';
    if ($('networkCaptureCount')) $('networkCaptureCount').textContent = captures.length ? String(captures.length) : '';
  }
  function selectCapture(number) {
    selectedCapture = Number(number) || 0;
    const item = captures.find(frame => frame.number === selectedCapture), detail = $('networkCaptureDetail');
    if (detail && item) detail.textContent = Object.entries({ Frame: `${item.number} · ${formatClock(item.time_ms)} · ${item.length} bytes`, Ethernet: `${item.source} (${item.source_address}) → ${item.destination} (${item.destination_address})`, Protocol: item.protocol, Info: item.info, ...item.layers }).map(([key, value]) => `${key}\n  ${typeof value === 'object' ? JSON.stringify(value) : value}`).join('\n');
    renderCaptures();
  }
  function exportCaptures() {
    const quote = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const rows = [['Number','Time (ms)','Source','Destination','Protocol','Length','Info'], ...captures.map(item => [item.number,item.time_ms,item.source_address || item.source,item.destination_address || item.destination,item.protocol,item.length,item.info])];
    download('eagleide-packet-capture.csv', rows.map(row => row.map(quote).join(',')).join('\r\n'), 'text/csv');
  }
  function clearCaptures() { if (captureRenderFrame) cancelAnimationFrame(captureRenderFrame); captureRenderFrame = 0; captures.length = 0; alerts.length = 0; arpTables.clear(); macTables.clear(); sessions.length = 0; selectedCapture = 0; nextCaptureNumber = 1; renderCaptures(); renderAlerts(); renderTrafficStatus(); }
  function renderAlerts() {
    const panel = $('networkIdsAlerts'); if (!panel) return;
    panel.innerHTML = alerts.length ? alerts.slice(0, 12).map(item => `<div class="network-ids-alert"><strong>${escapeHtml(item.severity.toUpperCase())} · ${escapeHtml(item.title)}</strong><span>${formatClock(item.time_ms)} · ${escapeHtml(item.detail)}</span></div>`).join('') : '<div class="network-objectives-empty">No IDS alerts. Defensive scenarios label simulated indicators without generating real attack traffic.</div>';
  }

  function diagnostics() {
    const current = topology(); if (!current) return [];
    const findings = [], devices = current.devices || [], links = current.links || [];
    const add = (severity, title, detail, device = '') => findings.push({ severity, title, detail, device });
    const byIp = new Map();
    devices.forEach(device => addresses(device).forEach(address => { const list = byIp.get(address) || []; list.push(device); byIp.set(address, list); }));
    byIp.forEach((items, address) => { if (items.length > 1) add('error', `Duplicate IPv4 address ${address}`, items.map(item => item.name).join(', ')); });
    const byIpv6 = new Map();
    devices.forEach(device => { const address = String(device.config?.ipv6_address || '').toLowerCase(); if (!address) return; const list = byIpv6.get(address) || []; list.push(device); byIpv6.set(address, list); });
    byIpv6.forEach((items, address) => { if (items.length > 1) add('error', `Duplicate IPv6 address ${address}`, items.map(item => item.name).join(', ')); });
    const knownIps = new Set([...byIp.keys()]);
    devices.forEach(device => {
      const cfg = device.config || {}, gateway = cfg.gateway;
      if (primaryAddress(device) && gateway && !knownIps.has(gateway)) add('error', `${device.name} has an unknown gateway`, `${gateway} is not configured on a routed interface.`, device.id);
      if (cfg.addressing_mode === 'dhcp' && !cfg.ip) add('warning', `${device.name} is waiting for DHCP`, 'Use Request DHCP Lease or verify the broadcast path and pool.', device.id);
      if (cfg.dns_servers?.some(address => !knownIps.has(address))) add('warning', `${device.name} references external or missing DNS`, cfg.dns_servers.filter(address => !knownIps.has(address)).join(', '), device.id);
      if (cfg.ipv6_mode !== 'disabled' && !cfg.ipv6_address) add('warning', `${device.name} has IPv6 enabled without an address`, 'Configure a static address or select SLAAC.', device.id);
      if (device.type === 'router' && cfg.dhcp_enabled) {
        const start = ipv4Number(cfg.dhcp_start), end = ipv4Number(cfg.dhcp_end);
        if (start === null || end === null || start > end) add('error', `${device.name} has an invalid DHCP pool`, `${cfg.dhcp_start || 'blank'} – ${cfg.dhcp_end || 'blank'}`, device.id);
        const assigned = new Set(devices.flatMap(item => addresses(item)).map(ipv4Number));
        if (assigned.has(start) || assigned.has(end)) add('warning', `${device.name} DHCP pool touches a static address`, 'Move pool bounds away from infrastructure addresses.', device.id);
      }
      if (['router','l3switch'].includes(device.type) && ['rip','ospf'].includes(cfg.routing_protocol) && !cfg.router_id) add('warning', `${device.name} needs a router ID`, `${cfg.routing_protocol.toUpperCase()} is enabled.`, device.id);
      if (device.type === 'wap') {
        devices.filter(other => other.type === 'wap' && other.id > device.id).forEach(other => {
          const distance = Math.hypot((device.x || 0) - (other.x || 0), (device.y || 0) - (other.y || 0));
          if (distance < Math.min(Number(cfg.range) || 280, Number(other.config?.range) || 280) && Number(cfg.channel) === Number(other.config?.channel)) add('warning', 'Overlapping wireless channels', `${device.name} and ${other.name} both use channel ${cfg.channel} within range.`);
        });
      }
    });
    const tree = api()?.spanningTreeState?.();
    tree?.blocked?.forEach(id => { const link = links.find(item => item.id === id); add('ok', 'STP prevented a Layer 2 loop', `${link?.source_port || ''} ↔ ${link?.target_port || ''} is blocking.`); });
    tree?.loopRisk?.forEach(id => { const link = links.find(item => item.id === id); add('error', 'Forwarding loop / broadcast storm risk', `Enable STP on the switches connected by ${link?.source_port || ''} ↔ ${link?.target_port || ''}.`); });
    links.forEach(link => {
      if (link.kind === 'serial' && !Number(link.clock_rate)) add('warning', 'Serial link has no clock rate', 'Configure a DCE clock rate before relying on timing.');
      if (Number(link.loss_percent) >= 5) add('warning', 'High configured packet loss', `${link.loss_percent}% loss on ${link.label || link.id}.`);
      if (!api()?.linkForwards?.(link) && !tree?.blocked?.has(link.id)) add('error', 'Physical link is down', `${link.source_port} ↔ ${link.target_port}; check device and port power.`);
    });
    const protocols = new Map();
    devices.filter(device => ['router','l3switch'].includes(device.type)).forEach(device => { const protocol = device.config?.routing_protocol; if (['rip','ospf'].includes(protocol)) (protocols.get(protocol) || protocols.set(protocol, []).get(protocol)).push(device); });
    protocols.forEach((items, protocol) => { if (items.length === 1) add('warning', `No ${protocol.toUpperCase()} neighbor`, `${items[0].name} is the only device using this protocol.`); });
    if (!findings.length) add('ok', 'No obvious configuration problems', 'Physical, addressing, routing, DNS, VLAN, and wireless checks passed.');
    return findings;
  }
  function ipv4Number(value) {
    const parts = String(value || '').split('.').map(Number);
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    return parts.reduce((sum, part) => ((sum << 8) | part) >>> 0, 0) >>> 0;
  }
  function renderDiagnostics() {
    const panel = $('networkDiagnosticsPanel'); if (!panel) return;
    const items = diagnostics(), problems = items.filter(item => ['error','warning'].includes(item.severity));
    panel.innerHTML = `<div class="network-diagnostics">${items.map(item => `<button type="button" class="network-diagnostic is-${item.severity}" ${item.device ? `data-diagnostic-device="${escapeHtml(item.device)}"` : ''}><span>${item.severity === 'error' ? '!' : item.severity === 'warning' ? '△' : '✓'}</span><div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.detail)}</small></div></button>`).join('')}</div>`;
    if ($('networkDiagnosticCount')) $('networkDiagnosticCount').textContent = problems.length ? String(problems.length) : '✓';
  }

  function connectedNetworks(device) {
    const configs = [...(device.config?.interfaces || []), ...(device.config?.svis || []), ...(device.type === 'server' ? Object.values(device.config?.server_interfaces || {}) : []), { ip: device.config?.ip, mask: device.config?.mask }];
    return [...new Set(configs.map(item => networkCidr(item?.ip, item?.mask)).filter(Boolean))];
  }
  function networkCidr(ip, mask) {
    const address = ipv4Number(ip), maskValue = ipv4Number(mask); if (address === null || maskValue === null) return '';
    let prefix = 0, zero = false; for (let bit = 31; bit >= 0; bit -= 1) { const set = !!(maskValue & (2 ** bit)); if (set && zero) return ''; if (set) prefix += 1; else zero = true; }
    const value = (address & maskValue) >>> 0; return `${[(value>>>24)&255,(value>>>16)&255,(value>>>8)&255,value&255].join('.')}/${prefix}`;
  }
  function dynamicRoutes(device) {
    const protocol = device?.config?.routing_protocol;
    if (!['rip','ospf'].includes(protocol)) return [];
    const peers = (topology()?.devices || []).filter(peer => peer.id !== device.id && peer.config?.routing_protocol === protocol && ['router','l3switch'].includes(peer.type) && (api()?.findPath?.(device.id, peer.id) || []).length);
    const own = new Set(connectedNetworks(device));
    return peers.flatMap(peer => {
      const path = api().findPath(device.id, peer.id);
      const metric = protocol === 'rip' ? path.length - 1 : Math.max(1, Math.round(path.slice(1).reduce((sum, id, index) => sum + (Number(api().linkBetween(path[index], id)?.latency_ms) || 1), 0)));
      return connectedNetworks(peer).filter(network => !own.has(network)).map(network => ({ network, via: peer.config?.router_id || primaryAddress(peer) || peer.name, learned_from: peer.name, protocol: protocol.toUpperCase(), metric }));
    });
  }

  function augmentInspector(detail) {
    const device = detail?.device, form = $('networkConfigForm'); if (!device || !form || form.querySelector('[data-advanced-config]')) return;
    const cfg = device.config || {}, reset = form.querySelector('.network-reset-device');
    const wrapper = document.createElement('div'); wrapper.dataset.advancedConfig = 'true'; wrapper.className = 'network-advanced-config';
    const bridge = ['switch','l3switch','wap'].includes(device.type), routed = ['router','l3switch'].includes(device.type), firewall = ['router','firewall'].includes(device.type);
    wrapper.innerHTML = `<details class="network-config-section"><summary>IPv6 / dual stack <span>${escapeHtml(cfg.ipv6_mode || 'disabled')}</span></summary><label>IPv6 mode<select data-advanced-field="ipv6_mode"><option value="disabled" ${cfg.ipv6_mode === 'disabled' ? 'selected' : ''}>Disabled</option><option value="slaac" ${cfg.ipv6_mode === 'slaac' ? 'selected' : ''}>Automatic (SLAAC)</option><option value="static" ${cfg.ipv6_mode === 'static' ? 'selected' : ''}>Manual (Static)</option></select></label><label>IPv6 address<input data-advanced-field="ipv6_address" value="${escapeHtml(cfg.ipv6_address || '')}" placeholder="2001:db8:10::20" ${cfg.ipv6_mode === 'disabled' ? 'disabled' : ''}></label><div class="network-config-grid"><label>Prefix length<input data-advanced-field="ipv6_prefix" type="number" min="1" max="128" value="${Number(cfg.ipv6_prefix) || 64}"></label><label>IPv6 gateway<input data-advanced-field="ipv6_gateway" value="${escapeHtml(cfg.ipv6_gateway || '')}" placeholder="2001:db8:10::1"></label></div></details>${bridge ? `<details class="network-config-section"><summary>Spanning Tree <span>${cfg.stp_enabled === false ? 'disabled' : 'RSTP enabled'}</span></summary><label class="network-switch"><input type="checkbox" data-advanced-field="stp_enabled" ${cfg.stp_enabled !== false ? 'checked' : ''}><span>Enable Rapid Spanning Tree</span></label><label>Bridge priority<select data-advanced-field="stp_priority">${[0,4096,8192,16384,24576,32768,40960,49152,57344,61440].map(value => `<option value="${value}" ${Number(cfg.stp_priority) === value ? 'selected' : ''}>${value}${value === 32768 ? ' (default)' : ''}</option>`).join('')}</select></label></details>` : ''}${routed ? `<details class="network-config-section"><summary>Dynamic routing <span>${escapeHtml(String(cfg.routing_protocol || 'static').toUpperCase())}</span></summary><label>Routing protocol<select data-advanced-field="routing_protocol"><option value="static" ${cfg.routing_protocol === 'static' ? 'selected' : ''}>Static only</option><option value="rip" ${cfg.routing_protocol === 'rip' ? 'selected' : ''}>RIP v2 (distance vector)</option><option value="ospf" ${cfg.routing_protocol === 'ospf' ? 'selected' : ''}>OSPF (link state)</option></select></label><label>Router ID<input data-advanced-field="router_id" value="${escapeHtml(cfg.router_id || '')}" placeholder="1.1.1.1"></label><div class="network-dns-help">Learned routes are derived from reachable peers using the same protocol. Static routes remain preferred.</div><div class="network-route-preview">${dynamicRoutes(device).map(route => `<div>${route.protocol} ${escapeHtml(route.network)} via ${escapeHtml(route.via)} metric ${route.metric}</div>`).join('') || 'No dynamic routes learned.'}</div></details>` : ''}${firewall ? renderSecurityConfig(device) : ''}`;
    reset?.before(wrapper) || form.append(wrapper);
    wrapper.querySelectorAll('[data-advanced-field]').forEach(input => input.addEventListener('change', () => {
      const field = input.dataset.advancedField, value = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value.trim();
      api()?.mutate?.(() => { device.config[field] = value; }, `Updated ${device.name} ${field.replaceAll('_', ' ')}.`);
    }));
    wrapper.querySelector('[data-add-port-forward]')?.addEventListener('click', () => api()?.mutate?.(() => (device.config.port_forwards ||= []).push({ protocol: 'tcp', external_port: 8080, internal_ip: '', internal_port: 80 }), `Added port forwarding rule on ${device.name}.`));
    wrapper.querySelectorAll('[data-forward-index]').forEach(row => {
      row.querySelectorAll('[data-forward-field]').forEach(input => input.addEventListener('change', () => api()?.mutate?.(() => { const rule = device.config.port_forwards[Number(row.dataset.forwardIndex)]; rule[input.dataset.forwardField] = input.type === 'number' ? Number(input.value) : input.value; }, `Updated port forwarding on ${device.name}.`)));
      row.querySelector('[data-remove-forward]')?.addEventListener('click', () => api()?.mutate?.(() => device.config.port_forwards.splice(Number(row.dataset.forwardIndex), 1), `Removed port forwarding from ${device.name}.`));
    });
  }
  function renderSecurityConfig(device) {
    const cfg = device.config || {};
    return `<details class="network-config-section"><summary>NAT / stateful policy <span>${device.type === 'router' ? escapeHtml(String(cfg.nat_mode || 'pat').toUpperCase()) : cfg.stateful === false ? 'stateless' : 'stateful'}</span></summary><label class="network-switch"><input type="checkbox" data-advanced-field="stateful" ${cfg.stateful !== false ? 'checked' : ''}><span>Track established sessions</span></label>${device.type === 'router' ? `<label>NAT behavior<select data-advanced-field="nat_mode"><option value="pat" ${cfg.nat_mode === 'pat' ? 'selected' : ''}>PAT / NAT overload</option><option value="dynamic" ${cfg.nat_mode === 'dynamic' ? 'selected' : ''}>Dynamic one-to-one</option><option value="disabled" ${cfg.nat_mode === 'disabled' ? 'selected' : ''}>Disabled</option></select></label>` : ''}<h4>Port forwarding</h4><div class="network-port-forward-list">${(cfg.port_forwards || []).map((rule, index) => `<div class="network-dns-record" data-forward-index="${index}"><label>Protocol<select data-forward-field="protocol"><option value="tcp" ${rule.protocol === 'tcp' ? 'selected' : ''}>TCP</option><option value="udp" ${rule.protocol === 'udp' ? 'selected' : ''}>UDP</option></select></label><label>External port<input data-forward-field="external_port" type="number" min="1" max="65535" value="${Number(rule.external_port) || 8080}"></label><label>Internal IP<input data-forward-field="internal_ip" value="${escapeHtml(rule.internal_ip || '')}"></label><label>Internal port<input data-forward-field="internal_port" type="number" min="1" max="65535" value="${Number(rule.internal_port) || 80}"></label><button type="button" data-remove-forward aria-label="Remove port forward">×</button></div>`).join('')}</div><button class="btn secondary" type="button" data-add-port-forward>＋ Add port forward</button></details>`;
  }

  function simulateIpv6(sourceId, targetId, protocol = 'icmp6', port = null) {
    const current = topology(), source = current?.devices.find(item => item.id === sourceId), target = current?.devices.find(item => item.id === targetId), path = api()?.findPath?.(sourceId, targetId) || [];
    const result = { source: sourceId, target: targetId, protocol, port, path, allowed: false, reason: '', layers: {} };
    if (!path.length) { result.reason = 'No physical or authenticated wireless path exists.'; return result; }
    if (!isIpv6(source?.config?.ipv6_address) || !isIpv6(target?.config?.ipv6_address)) { result.reason = 'Both endpoints need valid IPv6 addresses.'; return result; }
    const routed = !ipv6SamePrefix(source.config.ipv6_address, target.config.ipv6_address, Math.min(Number(source.config.ipv6_prefix) || 64, Number(target.config.ipv6_prefix) || 64));
    if (routed && !isIpv6(source.config.ipv6_gateway)) { result.reason = `${source.name} needs an IPv6 default gateway.`; return result; }
    if (routed && !isIpv6(target.config.ipv6_gateway)) { result.reason = `${target.name} needs an IPv6 default gateway for the reply path.`; return result; }
    if (routed && !path.slice(1, -1).some(id => ['router','l3switch','firewall'].includes(api()?.deviceById?.(id)?.type))) { result.reason = 'The IPv6 prefixes differ and no Layer 3 device is on the path.'; return result; }
    result.allowed = true; result.reason = 'IPv6 packet delivered successfully.';
    result.layers = { link: 'Ethernet / 802.11', network: `IPv6 ${source.config.ipv6_address} → ${target.config.ipv6_address}`, transport: protocol === 'icmp6' ? 'ICMPv6 Echo' : `${protocol.toUpperCase()} ${port || ''}`, neighbor_discovery: 'NDP simulated', hops: path.length - 1 };
    return result;
  }
  function ipv6Parts(value) {
    const text = String(value || '').trim().toLowerCase();
    if (!text || text.length > 39 || !/^[0-9a-f:]+$/.test(text) || (text.match(/::/g) || []).length > 1) return null;
    const compressed = text.includes('::'), halves = text.split('::');
    const left = halves[0] ? halves[0].split(':') : [], right = halves[1] ? halves[1].split(':') : [];
    if ([...left, ...right].some(part => !/^[0-9a-f]{1,4}$/.test(part))) return null;
    const missing = 8 - left.length - right.length;
    if ((!compressed && missing !== 0) || (compressed && missing < 1)) return null;
    return [...left, ...Array(compressed ? missing : 0).fill('0'), ...right].map(part => parseInt(part, 16));
  }
  function isIpv6(value) { return !!ipv6Parts(value); }
  function ipv6SamePrefix(first, second, prefix) {
    const a = ipv6Parts(first), b = ipv6Parts(second); if (!a || !b) return false;
    let bits = Math.max(1, Math.min(128, Number(prefix) || 64));
    for (let index = 0; index < 8 && bits > 0; index += 1) {
      const used = Math.min(16, bits), mask = used === 16 ? 0xffff : (0xffff << (16 - used)) & 0xffff;
      if ((a[index] & mask) !== (b[index] & mask)) return false;
      bits -= used;
    }
    return true;
  }
  function evaluatePacket(context) {
    const { result, path = [], source, target, protocol, port } = context || {};
    const devices = topology()?.devices || [];
    const firewall = devices.find(device => path.includes(device.id) && device.type === 'firewall');
    if (firewall?.config?.stateful !== false) {
      const reverse = sessions.find(session => session.device === firewall.id && session.protocol === protocol && session.source === primaryAddress(target) && session.destination === primaryAddress(source) && session.state === 'ESTABLISHED');
      if (reverse) return { allowed: true, reason: 'Permitted by the state table.' };
    }
    return result;
  }
  function allowsEstablished(firewall, source, target, protocol, port) {
    if (firewall?.config?.stateful === false) return false;
    return sessions.some(session => session.device === firewall.id && session.protocol === protocol && session.source === primaryAddress(target) && session.destination === primaryAddress(source) && (!port || Number(session.source_port) === Number(port) || Number(session.destination_port) === Number(port)) && session.expires > clockMs);
  }
  function resolvePortForward(sourceId, targetId, protocol, port) {
    const device = api()?.deviceById?.(targetId); if (!device || !['router','firewall'].includes(device.type)) return null;
    const rule = (device.config?.port_forwards || []).find(item => String(item.protocol || 'tcp').toLowerCase() === String(protocol || '').toLowerCase() && Number(item.external_port) === Number(port));
    if (!rule) return null;
    const target = (topology()?.devices || []).find(item => addresses(item).includes(String(rule.internal_ip || '')));
    return target ? { target: target.id, port: Number(rule.internal_port) || Number(port), device: device.id } : null;
  }

  function applySelectionClasses() { $('networkNodeLayer')?.querySelectorAll('[data-device-id]').forEach(node => node.classList.toggle('is-multi-selected', selected.has(node.dataset.deviceId))); }
  function toggleMultiSelection(id) { if (selected.has(id)) selected.delete(id); else selected.add(id); applySelectionClasses(); }
  function duplicateSelected() {
    const current = topology(); if (!current) return;
    const ids = selected.size ? [...selected] : [state().selectedId].filter(Boolean); if (!ids.length) return;
    api()?.mutate?.(() => {
      const mapping = new Map();
      ids.forEach(id => { const original = current.devices.find(device => device.id === id); if (!original) return; const copy = JSON.parse(JSON.stringify(original)); copy.id = api().makeId(`copy-${original.type}`); copy.name = `${original.name} Copy`; copy.x = Math.min(888, Number(original.x) + 42); copy.y = Math.min(530, Number(original.y) + 42); mapping.set(id, copy.id); current.devices.push(copy); });
      current.links.filter(link => mapping.has(link.source) && mapping.has(link.target)).forEach(link => current.links.push({ ...JSON.parse(JSON.stringify(link)), id: api().makeId('link'), source: mapping.get(link.source), target: mapping.get(link.target) }));
      selected.clear(); mapping.forEach(id => selected.add(id));
    }, `Duplicated ${ids.length} device${ids.length === 1 ? '' : 's'}.`);
  }
  function autoLayout() {
    const current = topology(); if (!current?.devices.length) return;
    api()?.mutate?.(() => {
      const groups = [['cloud'],['router','firewall'],['l3switch'],['switch','wap'],['server'],['pc','laptop','phone']];
      groups.forEach((types, column) => { const items = current.devices.filter(device => types.includes(device.type)); items.forEach((device, row) => { device.x = 45 + column * 155; device.y = 45 + row * Math.min(105, 490 / Math.max(1, items.length)); }); });
      if (snapEnabled) snapTopology();
    }, 'Automatically arranged the topology.');
  }
  function alignSelected(axis) {
    const current = topology(), devices = current?.devices.filter(device => selected.has(device.id)) || []; if (devices.length < 2) return;
    const average = devices.reduce((sum, device) => sum + Number(device[axis] || 0), 0) / devices.length;
    api()?.mutate?.(() => devices.forEach(device => { device[axis] = Math.round(average / 24) * 24; }), `Aligned ${devices.length} devices.`);
  }
  function snapTopology() {
    if (!snapEnabled) return;
    const current = topology(); if (!current) return;
    current.devices.forEach(device => { const point = snapPoint(device.x, device.y); device.x = point.x; device.y = point.y; });
  }
  function snapPoint(x, y) { return snapEnabled ? { x: Math.max(0, Math.min(888, Math.round(Number(x || 0) / 24) * 24)), y: Math.max(0, Math.min(530, Math.round(Number(y || 0) / 24) * 24)) } : { x, y }; }
  function exportPng() {
    const current = topology(); if (!current) return;
    const canvas = document.createElement('canvas'); canvas.width = 1400; canvas.height = 900; const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0,0,1400,900); gradient.addColorStop(0,'#07111d'); gradient.addColorStop(1,'#1a2637'); ctx.fillStyle = gradient; ctx.fillRect(0,0,1400,900);
    ctx.fillStyle = '#eef6ff'; ctx.font = 'bold 28px system-ui'; ctx.fillText(current.title || 'EagleIDE Network', 48, 55); ctx.font = '14px system-ui'; ctx.fillStyle = '#a5c8f0'; ctx.fillText('EagleIDE Network Simulator', 48, 80);
    ctx.save(); ctx.translate(60,120); ctx.scale(1.25,1.25);
    current.links.forEach(link => { const a = api().deviceById(link.source), b = api().deviceById(link.target); if (!a || !b) return; ctx.strokeStyle = link.kind === 'fiber' ? '#4ed5ff' : link.kind === 'serial' ? '#e5ad5b' : '#6d9bc7'; ctx.lineWidth = link.kind === 'fiber' ? 4 : 2; ctx.setLineDash(link.kind === 'serial' ? [10,5] : []); ctx.beginPath(); ctx.moveTo(a.x+56,a.y+35); ctx.lineTo(b.x+56,b.y+35); ctx.stroke(); });
    ctx.setLineDash([]); current.devices.forEach(device => { ctx.fillStyle = '#10263a'; ctx.strokeStyle = '#a5c8f0'; ctx.lineWidth = 2; ctx.fillRect(device.x,device.y,112,70); ctx.strokeRect(device.x,device.y,112,70); ctx.fillStyle = '#fff'; ctx.font = 'bold 11px system-ui'; ctx.fillText(device.name.slice(0,18),device.x+9,device.y+29); ctx.fillStyle = '#9ab4cc'; ctx.font = '9px system-ui'; ctx.fillText((primaryAddress(device) || device.type).slice(0,20),device.x+9,device.y+47); }); ctx.restore();
    canvas.toBlob(blob => { if (!blob) return; const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = `${(current.title || 'network').replace(/[^a-z0-9]+/gi,'-').toLowerCase()}.png`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url),1000); }, 'image/png');
  }
  function animateBackgroundFrame(frame) {
    if (!frame?.source_id || !frame?.destination_id) return;
    const path = api()?.findPath?.(frame.source_id, frame.destination_id) || []; if (path.length < 2) return;
    const overlay = $('networkPacketOverlayLayer'); if (!overlay) return;
    const token = document.createElement('span'); token.className = `network-background-packet ${frame.alert ? 'is-alert' : ''}`; token.title = `${frame.protocol}: ${frame.info}`; overlay.append(token);
    const points = path.map(id => api().deviceById(id)).filter(Boolean).map(device => ({ x: device.x + 56, y: device.y + 35 }));
    token.animate(points.map(point => ({ transform: `translate(${point.x}px, ${point.y}px)` })), { duration: Math.max(450, 1600 / simulationSettings().speed), easing: 'linear' }).finished.finally(() => token.remove());
  }

  function cliPrint(text) { const output = $('networkCliOutput'); if (!output) return; output.textContent += `\n${text}`; output.scrollTop = output.scrollHeight; }
  function updateCliPrompt(device) {
    const prompt = $('networkCliPrompt'); if (!prompt) return;
    const name = String(device?.name || 'device').replace(/\s+/g, '-').toLowerCase();
    prompt.textContent = cliContext.mode === 'interface' ? `${name}(config-if:${cliContext.interface})#` : cliContext.mode === 'config' ? `${name}(config)#` : '$';
  }
  function handleCli(lower, input, device) {
    if (cliContext.device && cliContext.device !== device.id) { cliContext.mode = 'exec'; cliContext.interface = ''; }
    cliContext.device = device.id;
    if (lower === 'configure terminal' || lower === 'conf t') { cliContext.mode = 'config'; cliContext.interface = ''; updateCliPrompt(device); cliPrint('Enter configuration commands. Use interface <port>, exit, or end.'); return true; }
    if (lower === 'end') { cliContext.mode = 'exec'; cliContext.interface = ''; updateCliPrompt(device); return true; }
    if (lower === 'exit' && cliContext.mode !== 'exec') { cliContext.mode = cliContext.mode === 'interface' ? 'config' : 'exec'; cliContext.interface = ''; updateCliPrompt(device); return true; }
    if (lower.startsWith('interface ') && cliContext.mode !== 'exec') {
      const wanted = input.split(/\s+/).slice(1).join('');
      const port = Object.keys(device.config?.ports || {}).find(name => name.toLowerCase() === wanted.toLowerCase());
      if (!port) cliPrint(`Unknown interface ${wanted}. Use show ports.`); else { cliContext.mode = 'interface'; cliContext.interface = port; updateCliPrompt(device); cliPrint(`Configuring ${port}.`); }
      return true;
    }
    if (cliContext.mode === 'interface' && ['shutdown', 'no shutdown'].includes(lower)) { const enabled = lower === 'no shutdown'; api().mutate(() => { device.config.ports[cliContext.interface].enabled = enabled; }, `CLI set ${device.name} ${cliContext.interface} ${enabled ? 'up' : 'down'}.`); cliPrint(`${cliContext.interface} administratively ${enabled ? 'enabled' : 'disabled'}.`); return true; }
    if (cliContext.mode === 'interface' && lower.startsWith('speed ')) { const value = input.split(/\s+/).slice(1).join(' '), speeds = ['1.544 Mbps','10 Mbps','100 Mbps','1 Gbps','10 Gbps','40 Gbps']; const speed = speeds.find(item => item.toLowerCase() === value.toLowerCase()); if (!speed) cliPrint(`Use one of: ${speeds.join(', ')}`); else api().mutate(() => { device.config.ports[cliContext.interface].speed = speed; }, `CLI set ${device.name} ${cliContext.interface} speed.`); return true; }
    if (cliContext.mode === 'interface' && lower.startsWith('ip address ')) {
      const [, , address, mask = '255.255.255.0'] = input.split(/\s+/);
      if (ipv4Number(address) === null || ipv4Number(mask) === null) cliPrint('Usage: ip address <IPv4> <mask>');
      else api().mutate(() => { const list = device.config.interfaces ||= []; let iface = list.find(item => String(item.name).toLowerCase() === cliContext.interface.toLowerCase()); if (!iface) { iface = { name: cliContext.interface }; list.push(iface); } Object.assign(iface,{ ip: address, mask }); }, `CLI addressed ${device.name} ${cliContext.interface}.`);
      return true;
    }
    if (lower === 'arp' || lower === 'show arp') { const table = arpTables.get(device.id); cliPrint(table?.size ? [...table].map(([ip, address]) => `${String(ip || 'incomplete').padEnd(39)} ${address}`).join('\n') : 'ARP/NDP table is empty. Send traffic to learn neighbors.'); return true; }
    if (lower === 'show mac-table') { const table = macTables.get(device.id); cliPrint(table?.size ? [...table].map(([address, item]) => `${address}  VLAN ${String(item.vlan).padEnd(4)} ${item.port}  dynamic`).join('\n') : 'MAC address table is empty. Send traffic through this switch.'); return true; }
    if (lower === 'show stp') { const tree = api()?.spanningTreeState?.(), links = topology()?.links || []; cliPrint(links.filter(link => [link.source,link.target].includes(device.id)).map(link => `${api().portForLink(link,device.id).padEnd(7)} ${tree.blocked.has(link.id) ? 'BLOCKING' : tree.loopRisk.has(link.id) ? 'FORWARDING (LOOP RISK)' : api().linkForwards(link) ? 'FORWARDING' : 'DOWN'}`).join('\n') || 'No connected ports.'); return true; }
    if (lower === 'show ip route' || lower === 'show route protocols') { const routes = dynamicRoutes(device), staticRoutes = device.config?.routes || []; cliPrint([...(connectedNetworks(device).map(network => `C  ${network} directly connected`)), ...staticRoutes.map(route => `S  ${route.network} via ${route.gateway}`), ...routes.map(route => `${route.protocol === 'OSPF' ? 'O' : 'R'}  ${route.network} via ${route.via} metric ${route.metric}`)].join('\n') || 'Routing table is empty.'); return true; }
    if (lower.startsWith('router protocol ')) { const value = lower.split(/\s+/)[2]; if (!['static','rip','ospf'].includes(value)) cliPrint('Usage: router protocol <static|rip|ospf>'); else api().mutate(() => { device.config.routing_protocol = value; }, `CLI enabled ${value.toUpperCase()} on ${device.name}.`); return true; }
    if (lower === 'show ipv6') { cliPrint(`Mode ${device.config?.ipv6_mode || 'disabled'}\nAddress ${device.config?.ipv6_address || 'not configured'}/${device.config?.ipv6_prefix || 64}\nGateway ${device.config?.ipv6_gateway || 'not configured'}`); return true; }
    if (lower.startsWith('ipv6 set ')) { const [, , address, prefix = '64'] = input.split(/\s+/); if (!isIpv6(address)) cliPrint('Usage: ipv6 set <valid-address> [prefix]'); else api().mutate(() => Object.assign(device.config, { ipv6_mode: 'static', ipv6_address: address, ipv6_prefix: Math.max(1,Math.min(128,Number(prefix)||64)) }), `CLI configured IPv6 on ${device.name}.`); return true; }
    if (lower.startsWith('ping6 ')) { const address = input.split(/\s+/)[1], target = topology()?.devices.find(item => String(item.config?.ipv6_address || '').toLowerCase() === String(address).toLowerCase()); if (!target) cliPrint(`IPv6 destination ${address} was not found.`); else { const result = simulateIpv6(device.id,target.id); api().renderPacketResult(result); cliPrint(result.allowed ? `Reply from ${address}: simulated time <1 ms` : `Request failed: ${result.reason}`); } return true; }
    if (lower === 'show sessions' || lower === 'show nat') { const rows = sessions.filter(item => item.device === device.id && item.expires > clockMs); cliPrint(rows.length ? rows.map(item => `${item.protocol.toUpperCase()} ${item.source}:${item.source_port} → ${item.destination}:${item.destination_port}${item.translated ? ` PAT ${item.translated}:${item.source_port}` : ''} ${item.state}`).join('\n') : 'No active state/NAT sessions.'); return true; }
    if (lower === 'show ids') { cliPrint(alerts.length ? alerts.slice(0,20).map(item => `${item.severity.toUpperCase()} ${formatClock(item.time_ms)} ${item.title} · ${item.detail}`).join('\n') : 'No IDS alerts.'); return true; }
    if (lower === 'capture start') { if (!running) toggleTraffic(); cliPrint('Background packet capture started.'); return true; }
    if (lower === 'capture stop') { if (running) toggleTraffic(); cliPrint('Background packet capture stopped.'); return true; }
    if (lower === 'capture clear') { clearCaptures(); cliPrint('Capture buffer cleared.'); return true; }
    return false;
  }
  function bindCliKeys() {
    $('networkCliInput')?.addEventListener('keydown', event => {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); if (!cliHistory.length) return; cliIndex = Math.max(0, Math.min(cliHistory.length, cliIndex + (event.key === 'ArrowUp' ? -1 : 1))); event.currentTarget.value = cliHistory[cliIndex] || ''; }
      if (event.key === 'Tab') { event.preventDefault(); const commands = ['help','ip addr','show interfaces','show ports','show arp','show mac-table','show stp','show ip route','show ipv6','show sessions','show ids','show dhcp','show wan','show vlans','show acl','show firewall','capture start','capture stop','capture clear','ping','ping6','traceroute','nslookup','http get','scan']; const matches = commands.filter(command => command.startsWith(event.currentTarget.value.toLowerCase())); if (matches.length === 1) event.currentTarget.value = matches[0]; else if (matches.length) cliPrint(matches.join('  ')); }
      if (event.key === 'Enter' && event.currentTarget.value.trim()) { cliHistory.push(event.currentTarget.value.trim()); cliHistory.splice(100); cliIndex = cliHistory.length; }
    });
  }

  function onTopologyOpened(event) {
    stopTraffic();
    cliContext.mode = 'exec'; cliContext.interface = ''; cliContext.device = ''; updateCliPrompt(null);
    selected.clear(); arpTables.clear(); macTables.clear(); sessions.length = 0; clearCaptures();
    const saved = event.detail?.topology?.metadata?.simulation || {};
    if ($('networkTrafficSeed')) $('networkTrafficSeed').value = saved.seed || 1337;
    if ($('networkTrafficProfile')) $('networkTrafficProfile').value = saved.profile || 'classroom';
    if ($('networkTrafficSpeed')) $('networkTrafficSpeed').value = saved.speed || 1;
    initWorker(); renderDiagnostics();
  }
  function onTopologyChanged() { worker?.postMessage({ type: 'topology', topology: workerTopology() }); renderDiagnostics(); }
  function onCanvasRendered() { applySelectionClasses(); }
  function attach() {
    window.addEventListener('network-sim:topology-opened', onTopologyOpened);
    window.addEventListener('network-sim:topology-changed', onTopologyChanged);
    window.addEventListener('network-sim:canvas-rendered', onCanvasRendered);
    window.addEventListener('network-sim:inspector-rendered', event => augmentInspector(event.detail));
    window.addEventListener('network-sim:packet', event => manualCapture(event.detail?.result));
    $('networkTrafficToggleBtn')?.addEventListener('click', toggleTraffic);
    $('networkTrafficStepBtn')?.addEventListener('click', stepTraffic);
    $('networkTrafficProfile')?.addEventListener('change', () => { saveSimulationSettings(); initWorker({ reset: false }); });
    $('networkTrafficSpeed')?.addEventListener('change', () => { saveSimulationSettings(); worker?.postMessage({ type: 'settings', ...simulationSettings() }); });
    $('networkTrafficSeed')?.addEventListener('change', () => { saveSimulationSettings(); clearCaptures(); clockMs = 0; initWorker(); });
    $('networkCaptureFilter')?.addEventListener('input', renderCaptures);
    $('networkCaptureRows')?.addEventListener('click', event => { const row = event.target.closest('[data-capture-number]'); if (row) selectCapture(row.dataset.captureNumber); });
    $('networkCaptureExportBtn')?.addEventListener('click', exportCaptures);
    $('networkCaptureClearBtn')?.addEventListener('click', clearCaptures);
    $('networkDiagnosticsPanel')?.addEventListener('click', event => { const item = event.target.closest('[data-diagnostic-device]'); if (item) api()?.selectDevice?.(item.dataset.diagnosticDevice); });
    $('networkDuplicateBtn')?.addEventListener('click', duplicateSelected);
    $('networkAutoLayoutBtn')?.addEventListener('click', autoLayout);
    $('networkMultiSelectBtn')?.addEventListener('click', event => { multiSelectMode = !multiSelectMode; event.currentTarget.setAttribute('aria-pressed', String(multiSelectMode)); event.currentTarget.classList.toggle('is-active', multiSelectMode); });
    $('networkAlignHBtn')?.addEventListener('click', () => alignSelected('y'));
    $('networkAlignVBtn')?.addEventListener('click', () => alignSelected('x'));
    $('networkSnapBtn')?.addEventListener('click', event => { snapEnabled = !snapEnabled; event.currentTarget.setAttribute('aria-pressed',String(snapEnabled)); event.currentTarget.classList.toggle('is-active',snapEnabled); if (snapEnabled) api()?.mutate?.(() => snapTopology(), 'Snapped devices to the grid.', { inspector: false }); });
    $('networkExportImageBtn')?.addEventListener('click', exportPng);
    $('networkNodeLayer')?.addEventListener('pointerdown', event => { const node = event.target.closest('[data-device-id]'); if (!node || (!event.ctrlKey && !event.metaKey && !multiSelectMode)) return; event.preventDefault(); event.stopPropagation(); toggleMultiSelection(node.dataset.deviceId); }, true);
    $('networkCanvas')?.addEventListener('pointerdown', event => { if (!event.target.closest('.network-node,.network-link-hit,.network-port-picker')) { selected.clear(); applySelectionClasses(); } });
    $('networkBackBtn')?.addEventListener('click', () => stopTraffic());
    [$('wikiViewBtn'), $('ideViewBtn')].forEach(button => button?.addEventListener('click', () => stopTraffic()));
    window.addEventListener('pagehide', () => stopTraffic({ terminate: true }));
    window.addEventListener('keydown', event => { if (!document.body.classList.contains('network-mode') || event.target.matches('input,textarea,select')) return; if (event.key.toLowerCase() === 'm') { multiSelectMode = !multiSelectMode; $('networkMultiSelectBtn')?.setAttribute('aria-pressed', String(multiSelectMode)); $('networkMultiSelectBtn')?.classList.toggle('is-active', multiSelectMode); } if (event.shiftKey && event.key.toLowerCase() === 'h') alignSelected('y'); if (event.shiftKey && event.key.toLowerCase() === 'v') alignSelected('x'); });
    bindCliKeys(); renderCaptures(); renderAlerts(); renderDiagnostics(); renderTrafficStatus();
  }

  window.NetworkSimAdvanced = { handleCli, simulateIpv6, evaluatePacket, allowsEstablished, resolvePortForward, captures, alerts, arpTables, macTables, dynamicRoutes, diagnostics, alignSelected, stopTraffic, snapPoint };
  attach();
})();
