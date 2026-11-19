/* Infra Sim network settings in the selected object's inspector. */
(function () {
  'use strict';

  const model = window.WifiSiteClientModel;
  const $ = id => document.getElementById(id);
  const ADD = ':add';
  const bands = [['2.4', '2.4 GHz'], ['5', '5 GHz'], ['both', 'Both bands']];

  function create({ plan, cabling, graph, update, replace, render, hint, escape, choices, id, limits, serviceNames, radioFields }) {
    let apEdit, portEdit, vlanEdit = ADD, ruleEdit;

    const option = (entries, value) => choices(entries.map(([key, name]) => [String(key), name]), String(value));
    const vlans = () => [[0, '0 · Untagged LAN'], ...[...plan().vlans].sort((a, b) => a.id - b.id).map(vlan => [vlan.id, `${vlan.id} · ${vlan.name}`])];
    const vlanSelect = value => option(vlans(), value);
    const button = (action, text, extra = '') => `<button class="wifi-control" type="button" data-wifi-network="${action}"${extra}>${text}</button>`;
    const checked = value => value ? ' checked' : '';
    function selectedPort(device) {
      const { ports, occupancy } = cabling();
      const candidates = ports.get(device.id);
      return (portEdit?.device === device.id && candidates.find(port => port.id === portEdit.port))
        || candidates.find(port => occupancy.has(`${device.id}:${port.id}`)) || candidates[0];
    }

    const bandwidthField = (field, key, value, label = 'Bandwidth limit (Mb/s)') =>
      `<label>${label}<input type="number" min="0" max="10000" step="1" value="${value ?? 0}"
        id="${field === 'ssid_limits' ? 'wifiSsidLimit' : field === 'port_limits' ? 'wifiPortLimit' : 'wifiVlanLimit-' + key}"
        data-wifi-rate-field="${field}" data-wifi-rate-key="${escape(String(key))}"></label>`;

    function apInspector(ap) {
      const { ssids } = plan();
      const enabled = model.apSsids(ap, ssids);
      const choice = apEdit?.ap === ap.id ? apEdit.ssid : enabled[0] ?? ssids[0]?.id ?? ADD;
      const settings = ssids.find(ssid => ssid.id === choice);
      const selected = settings?.id ?? ADD;
      const on = enabled.includes(selected);
      return `<section class="wifi-network-settings">
        <h3>Wi-Fi networks on this AP</h3>
        <div class="wifi-ssid-list" role="group" aria-label="Networks on this AP">
          ${ssids.map(ssid => button('pick-ssid', escape(ssid.name),
            ` data-ssid="${escape(ssid.id)}" aria-pressed="${selected === ssid.id}"`)).join('')}
          ${button('new-ssid', '+ Create SSID', ` aria-pressed="${selected === ADD}"`)}
        </div>
        <label>Shared SSID<select id="wifiApSsid">${option([...ssids.map(ssid => [ssid.id,
          `${ssid.name}${enabled.includes(ssid.id) ? ' · On' : ''}`]), [ADD, 'Add SSID…']], selected)}</select></label>
        <p>${enabled.length} of 4 SSIDs enabled. Select a network to edit it, or choose Create SSID.</p>
        ${settings ? `<label class="wifi-estimate-toggle"><input type="checkbox" id="wifiApSsidEnabled"${checked(on)}
          ${!on && enabled.length >= 4 ? ' disabled' : ''}> Broadcast on this AP</label>` : ''}
        <label>SSID name<input id="wifiSsidName" maxlength="32" value="${escape(settings?.name ?? '')}"></label>
        <div class="wifi-two-fields"><label>Radio band<select id="wifiSsidBand">${option(bands, settings?.band ?? 'both')}</select></label>
        <label>VLAN ID<select id="wifiSsidVlan">${vlanSelect(settings?.vlan ?? 0)}</select></label></div>
        ${settings ? bandwidthField('ssid_limits', settings.id, ap.ssid_limits?.[settings.id], 'Per-client limit on this AP (Mb/s)') +
          '<p>0 means unlimited. Each client on this SSID is limited in both directions.</p>' : ''}
        <div class="wifi-object-actions">${button('save-ssid', settings ? 'Save SSID' : 'Create and Broadcast')}
        ${settings ? button('remove-ssid', 'Remove SSID') : ''}</div>
        ${settings ? '' : '<p>New SSIDs join the shared list. This AP broadcasts the new SSID if it has a free slot.</p>'}
      </section>`;
    }

    function homeWifiInspector(router) {
      const ssids = plan().ssids.filter(ssid => ssid.vlan === 0);
      const choice = apEdit?.ap === router.id ? apEdit.ssid : router.wifi_ssid ?? ssids[0]?.id ?? '';
      const selected = ssids.find(ssid => ssid.id === choice);
      return `<details class="wifi-network-settings" data-wifi-config="home-wifi"><summary>Built-in Wi-Fi</summary>
        <p>Broadcasts one SSID on the same LAN as the four Ethernet ports.</p>
        <label>Wi-Fi network<select id="wifiHomeSsid">${option([
          ['', 'Wi-Fi off'], ...ssids.map(ssid => [ssid.id, ssid.name]), [ADD, 'Create SSID…'],
        ], choice)}</select></label>
        ${choice ? `<label>SSID name<input id="wifiHomeSsidName" maxlength="32" value="${escape(selected?.name ?? '')}"></label>
          <label>Radio band<select id="wifiHomeSsidBand">${option(bands, selected?.band ?? 'both')}</select></label>
          ${button('save-home-ssid', selected ? 'Save SSID' : 'Create and Broadcast')}` : ''}
        ${selected ? bandwidthField('ssid_limits', selected.id, router.ssid_limits?.[selected.id], 'Per-client Wi-Fi limit (Mb/s)') : ''}
        ${choice && choice !== ADD ? radioFields(router) : ''}
      </details>`;
    }

    function routerInspector(router) {
      const home = router.kind === 'home_router';
      const dhcp = router.dhcp ?? model.DEFAULT_DHCP;
      const rules = router.firewall ?? [];
      const { available, unassigned, pool } = graph().routers.get(router.id);
      const editing = ruleEdit?.router === router.id && rules[ruleEdit.index] === ruleEdit.rule ? ruleEdit : null;
      const rule = editing?.rule;
      const vlan = vlanEdit === ADD ? null : plan().vlans.find(item => item.id === vlanEdit);
      const endpoint = (rule, side) => {
        const vid = rule[side + '_vlan'];
        const vlan = vid == null ? 'Any VLAN' : `VLAN ${vid}`;
        return `${home ? '' : vlan + ' · '}${rule[side + '_ip'] || 'Any IP'}`;
      };
      return `<details class="wifi-network-settings" data-wifi-config="dhcp"${available ? '' : ' open'}>
        <summary>DHCP</summary>
        ${available ? `<p>${available} of ${pool.capacity} client addresses available${home ? '' : ' · shared across VLANs'}</p>`
          : `<p class="wifi-poe-warning" role="alert">DHCP pool exhausted.${unassigned ? ` ${unassigned} connected ${unassigned === 1 ? 'client is' : 'clients are'} waiting for an address.` : ''}</p>`}
        <label>Gateway and prefix<input id="wifiDhcpGateway" maxlength="18" value="${escape(dhcp.gateway)}" placeholder="192.168.0.1/24"></label>
        <div class="wifi-two-fields"><label>Primary DNS<input id="wifiDhcpDns" maxlength="15" value="${escape(dhcp.dns)}"></label>
        <label>Fallback DNS<input id="wifiDhcpFallback" maxlength="15" value="${escape(dhcp.fallback_dns)}"></label></div>
        <p class="wifi-settings-feedback" role="status">Changes save automatically when you leave a valid field.</p>
      </details>
      ${home ? homeWifiInspector(router) : `<details class="wifi-network-settings" data-wifi-config="vlans"><summary>VLANs</summary>
        <p>VLAN 0 is the untagged LAN. VLAN names are shared throughout this site.</p>
        <label>VLAN<select id="wifiRouterVlan">${option([[ADD, 'New VLAN…'], ...vlans().slice(1)], vlan?.id ?? ADD)}</select></label>
        <div class="wifi-two-fields"><label>Name<input id="wifiVlanName" maxlength="60" value="${escape(vlan?.name ?? '')}"></label>
        <label>VLAN ID<input id="wifiVlanId" type="number" min="1" max="4094" step="1" value="${vlan?.id ?? ''}"${vlan ? ' readonly' : ''}></label></div>
        <div class="wifi-object-actions">${button('save-vlan', vlan ? 'Save Name' : 'Add VLAN')}
          ${vlan ? button('remove-vlan', 'Remove VLAN') : ''}</div>
      </details>`}
      <details class="wifi-network-settings" data-wifi-config="bandwidth"><summary>Routed bandwidth</summary>
        <p>Caps each routed connection for the selected VLAN in both directions. Local traffic stays on the LAN. 0 means unlimited.</p>
        ${(home ? [[0, 'Home LAN']] : vlans()).map(([vid, name]) =>
          bandwidthField('vlan_limits', String(vid), router.vlan_limits?.[vid], name + ' · limit (Mb/s)')).join('')}
      </details>
      <details class="wifi-network-settings" data-wifi-config="firewall"><summary>Firewall</summary>
        <p>First matching rule wins. Unmatched router traffic is allowed. ${home ? 'Traffic within the home LAN stays on the switch.' : 'Same-VLAN traffic stays on the switch.'}</p>
        ${rules.length ? `<ol class="wifi-firewall-list">${rules.map((item, i) => `<li class="${editing?.index === i ? 'is-editing' : ''}">
          <strong class="wifi-rule-action wifi-rule-${item.action}">${i + 1} · ${item.action === 'allow' ? 'Allow' : 'Deny'}</strong>
          <p>From ${escape(endpoint(item, 'source'))}<br>To ${escape(endpoint(item, 'destination'))}</p>
          <div class="wifi-object-actions">
            ${button('edit-rule', 'Edit', ` data-index="${i}" aria-label="Edit firewall rule ${i + 1}"`)}
            ${button('rule-up', '↑', ` data-index="${i}" aria-label="Move rule ${i + 1} up"${i ? '' : ' disabled'}`)}
            ${button('rule-down', '↓', ` data-index="${i}" aria-label="Move rule ${i + 1} down"${i < rules.length - 1 ? '' : ' disabled'}`)}
            ${button('remove-rule', 'Remove', ` data-index="${i}" aria-label="Remove firewall rule ${i + 1}"`)}
          </div></li>`).join('')}</ol>` : '<p>No firewall rules.</p>'}
        <fieldset class="wifi-rule-editor"><legend>${editing ? `Edit rule ${editing.index + 1}` : 'New rule'}</legend>
          <label>Action<select id="wifiFirewallAction">${option([['allow', 'Allow'], ['deny', 'Deny']], rule?.action ?? 'allow')}</select></label>
          ${home ? '' : `<div class="wifi-two-fields"><label>Source VLAN<select id="wifiFirewallSourceVlan">${option([['', 'Any VLAN'], ...vlans()], rule?.source_vlan ?? '')}</select></label>
          <label>Destination VLAN<select id="wifiFirewallDestinationVlan">${option([['', 'Any VLAN'], ...vlans()], rule?.destination_vlan ?? '')}</select></label></div>`}
          <div class="wifi-two-fields"><label>Source IP or CIDR<input id="wifiFirewallSourceIp" maxlength="18" placeholder="Any" value="${escape(rule?.source_ip ?? '')}"></label>
          <label>Destination IP or CIDR<input id="wifiFirewallDestinationIp" maxlength="18" placeholder="Any" value="${escape(rule?.destination_ip ?? '')}"></label></div>
          <div class="wifi-object-actions">${button('save-rule', editing ? 'Save Rule' : 'Add Rule')}
            ${editing ? button('cancel-rule', 'Cancel') : ''}</div>
        </fieldset>
      </details>`;
    }

    function switchInspector(device) {
      const port = selectedPort(device);
      const enabled = model.portVlans(device, port.id);
      const data = cabling();
      const cables = new Map(plan().cables.map(cable => [cable.id, cable]));
      const connected = candidate => cables.get(data.occupancy.get(`${device.id}:${candidate.id}`));
      const cable = connected(port);
      const peer = cable && (cable.source.device_id === device.id ? cable.target : cable.source);
      return `<details class="wifi-network-settings" data-wifi-config="ports"><summary>Switch ports</summary>
        <p>Click a front-panel port in the rack or choose it below. ${model.managed(device) ? 'The access VLAN carries untagged traffic. Add tags to carry extra VLANs.' : 'Set a bandwidth limit for this port.'}</p>
        <details class="wifi-port-picker"><summary>Choose another port · ${escape(port.id)}</summary>
        <div class="wifi-port-grid" role="group" aria-label="Switch port">
          ${data.ports.get(device.id).map(candidate => {
            const used = Boolean(connected(candidate));
            return button('pick-port', escape(candidate.id), ` data-port="${escape(candidate.id)}"
              id="wifiPort-${escape(candidate.id)}" aria-pressed="${candidate === port}"
              aria-label="${escape(candidate.id)} · ${used ? 'Connected' : 'Free'}" data-connected="${used}"`);
          }).join('')}
        </div></details>
        <div class="wifi-wire-summary"><strong>${escape(port.id)} · ${window.WifiCablingModel.speedName(port.speed)}${port.poe ? ' · PoE' : ''}</strong>
          <span>${peer ? `Connected to ${escape(data.endName(peer))}` : 'Free port'}</span></div>
        <h3>${escape(port.id)} configuration</h3>
        ${bandwidthField('port_limits', port.id, device.port_limits?.[port.id], 'Port limit (Mb/s)')}
        <p>0 means unlimited up to the physical port speed. Changes save automatically.</p>
        ${model.managed(device) ? `<label>Access VLAN<select id="wifiPortAccess">${option([['', 'Disabled'], ...vlans()], enabled[0] ?? '')}</select></label>
        ${enabled.length ? `<fieldset class="wifi-tagged-vlans"><legend>Tagged VLANs on this port</legend>
          ${vlans().filter(([vid]) => vid !== enabled[0]).map(([vid, label]) =>
            `<label class="wifi-estimate-toggle"><input type="checkbox" id="wifiTagged-${vid}" data-wifi-port-vlan="${vid}"
            ${checked(enabled.includes(vid))}> ${escape(label)}</label>`).join('') || '<p>Add site VLANs in the router settings.</p>'}
          </fieldset>` : '<p>This port carries no VLAN traffic.</p>'}` : ''}
      </details>`;
    }

    function clientInspector(device, info) {
      const { ssids } = plan();
      const lease = info.lease;
      const connected = lease && info.speed;
      const pool = lease && graph().routers.get(lease.router).pool;
      return `${model.wirelessClient(device) ? `<label>Wi-Fi SSID<select id="wifiPhoneSsid">${option([
        ['', ssids.length ? `Default (${ssids[0].name})` : 'No SSIDs'], ...ssids.map(ssid => [ssid.id, ssid.name]),
      ], device.ssid_id ?? '')}</select></label>` : ''}
        <dl class="wifi-device-status">
        <div><dt>VLAN</dt><dd>${info.vlan ?? '—'}</dd></div>
        <div><dt>IPv4</dt><dd>${lease ? `${model.address(lease.ip)}/${pool.prefix}${lease.static ? ' · Reserved' : ' · DHCP'}` : 'No address'}</dd></div>
        ${(connected || lease?.static) ? `<div><dt>Gateway</dt><dd>${model.address(pool.gateway)}</dd></div>
          <div><dt>DNS</dt><dd>${pool.dns} · ${pool.fallback_dns}</dd></div>` : ''}</dl>
        ${lease ? `<label class="wifi-estimate-toggle"><input type="checkbox" id="wifiStaticIp"${checked(lease.static)}> Reserve as static IP</label>`
          : info.speed ? '<p>Waiting for DHCP. Check the VLAN path and router pool.</p>' : ''}`;
    }

    function serverInspector(device) {
      const services = new Map((device.services ?? []).map(service => [service.kind, service]));
      const network = graph();
      const catalog = Object.entries(serviceNames() ?? {});
      return `<details class="wifi-network-settings" data-wifi-config="service-vms"><summary>Service VMs</summary>
        <p>Enable the services this server hosts. Each VM gets its own IPv4 address on its selected VLAN.</p>
        <ul class="wifi-service-vms">${catalog.map(([kind, name]) => {
          const service = services.get(kind);
          const lease = network.clients.get(model.serviceId(device.id, kind))?.lease;
          return `<li class="wifi-service-vm">
            <label class="wifi-estimate-toggle"><input type="checkbox" id="wifiVm-${escape(kind)}"
              data-wifi-service-toggle="${escape(kind)}"${checked(service)}> ${escape(name)}</label>
            ${service ? `<div class="wifi-two-fields">
              <label>VLAN<select data-wifi-service-vlan aria-label="${escape(name)} VLAN">${vlanSelect(service.vlan)}</select></label>
              <label>IPv4<input data-wifi-service-ip aria-label="${escape(name)} IPv4" inputmode="decimal" maxlength="15"
                placeholder="DHCP" value="${escape(service.ip)}"></label></div>
              <p>${lease ? `${model.address(lease.ip)} · ${lease.static ? 'Static' : 'DHCP'}` :
                service.ip ? 'Waiting for a router on this VLAN with a matching subnet.' : 'Waiting for an IPv4 lease.'}</p>
              ${button('save-vm', 'Save VM', ` data-service="${escape(kind)}"`)}` : ''}
            </li>`;
        }).join('')}</ul>
        <p>Leave IPv4 blank for DHCP. The switch port to the server must carry each VM’s VLAN.</p>
      </details>`;
    }

    function deviceInspector(device) {
      if (model.isRouter(device)) return routerInspector(device);
      if (device.kind === 'server') return serverInspector(device);
      return model.managed(device) || device.kind === 'access_switch' ? switchInspector(device) : '';
    }

    function saveService(device, kind, row) {
      const ip = row.querySelector('[data-wifi-service-ip]').value.trim();
      if (ip && model.serviceAddress(ip) === null) return hint('Enter a unicast IPv4 address or leave the field blank for DHCP.');
      if (ip && plan().equipment.some(item => item.reservation?.ip === ip ||
          (model.isRouter(item) && (item.dhcp ?? model.DEFAULT_DHCP).gateway.split('/')[0] === ip) ||
          item.services?.some(vm => vm.ip === ip && (item.id !== device.id || vm.kind !== kind)))) {
        return hint('That IPv4 address is already configured on this site.');
      }
      const vlan = Number(row.querySelector('[data-wifi-service-vlan]').value);
      const services = device.services.map(vm => vm.kind === kind ? { ...vm, vlan, ip } : vm);
      if (replace('equipment', { ...device, services })) hint('Service VM saved.');
    }

    function change(device, input) {
      const { ssids } = plan();
      if (input.dataset.wifiRateField) {
        const rate = Number(input.value);
        const valid = input.value.trim() !== '' && Number.isInteger(rate) && rate >= 0 && rate <= 10000;
        input.setCustomValidity(valid ? '' : 'Enter a whole Mb/s value from 0 to 10000.');
        if (!valid) { input.reportValidity(); return true; }
        const field = input.dataset.wifiRateField, key = input.dataset.wifiRateKey;
        const limits = { ...device[field] };
        if (rate) limits[key] = rate;
        else delete limits[key];
        replace(device.mount ? 'access_points' : 'equipment', { ...device, [field]: limits });
      } else if (['wifiDhcpGateway', 'wifiDhcpDns', 'wifiDhcpFallback'].includes(input.id)) {
        saveDhcp(device, input);
      } else if (input.dataset.wifiServiceToggle) {
        const kind = input.dataset.wifiServiceToggle;
        const services = (device.services ?? []).filter(vm => vm.kind !== kind);
        if (input.checked) services.push({ kind, vlan: graph().clients.get(device.id).vlan ?? 0, ip: '' });
        const next = { ...device, services };
        if (!services.length) delete next.services;
        replace('equipment', next);
      } else if (input.id === 'wifiHomeSsid') {
        apEdit = input.value === ADD ? { ap: device.id, ssid: ADD } : null;
        if (apEdit) render();
        else replace('equipment', { ...device, wifi_ssid: input.value });
        $('wifiHomeSsid').focus({ preventScroll: true });
      } else if (input.id === 'wifiApSsid') {
        apEdit = { ap: device.id, ssid: input.value };
        render();
        $('wifiApSsid').focus({ preventScroll: true });
      } else if (input.id === 'wifiApSsidEnabled') {
        const ssid = $('wifiApSsid').value;
        const enabled = model.apSsids(device, ssids);
        if (!input.checked || enabled.length < 4) {
          replace('access_points', { ...device, ssid_ids: input.checked ? [...enabled, ssid] : enabled.filter(id => id !== ssid) });
        }
      } else if (input.id === 'wifiRouterVlan') {
        vlanEdit = input.value === ADD ? ADD : Number(input.value);
        render();
      } else if (input.id === 'wifiPortAccess') {
        const { id: port } = selectedPort(device);
        const vid = Number(input.value);
        const previous = model.portVlans(device, port);
        const values = input.value ? [vid, ...previous.filter(value => value !== vid)] : [];
        replace('equipment', { ...device, port_vlans: { ...device.port_vlans, [port]: values } });
      } else if (input.dataset.wifiPortVlan !== undefined) {
        const { id: port } = selectedPort(device);
        const vid = Number(input.dataset.wifiPortVlan);
        const enabled = model.portVlans(device, port);
        const values = input.checked ? [...enabled, vid] : enabled.filter(value => value !== vid);
        replace('equipment', { ...device, port_vlans: { ...device.port_vlans, [port]: values } });
      } else if (input.id === 'wifiPhoneSsid') {
        replace('equipment', { ...device, ssid_id: input.value });
      } else if (input.id === 'wifiStaticIp') {
        const lease = graph().clients.get(device.id).lease;
        if (!lease) return true;
        const next = { ...device };
        if (input.checked) next.reservation = { router_id: lease.router, ip: model.address(lease.ip) };
        else delete next.reservation;
        replace('equipment', next);
      } else return false;
      return true;
    }

    function saveSsid(ap) {
      const layout = plan();
      const old = layout.ssids.find(ssid => ssid.id === $('wifiApSsid').value);
      const name = $('wifiSsidName').value.trim().replace(/\s+/g, ' ');
      if (!name || layout.ssids.some(ssid => ssid.name === name && ssid !== old)) return hint('Enter a unique SSID name.');
      if (!old && layout.ssids.length >= limits().ssids) return hint('The shared SSID list is full.');
      const ssid = { id: old?.id ?? id('ssid'), name, band: $('wifiSsidBand').value, vlan: Number($('wifiSsidVlan').value) };
      if (ssid.vlan && layout.equipment.some(device => device.wifi_ssid === ssid.id)) {
        return hint('Choose a different SSID on the residential router before assigning this SSID a VLAN.');
      }
      const ssids = old ? layout.ssids.map(item => item === old ? ssid : item) : [...layout.ssids, ssid];
      const enabled = model.apSsids(ap, layout.ssids);
      const access_points = !old && enabled.length < 4 ? layout.access_points.map(item =>
        item === ap ? { ...ap, ssid_ids: [...enabled, ssid.id] } : item) : layout.access_points;
      apEdit = { ap: ap.id, ssid: ssid.id };
      update({ ...layout, ssids, access_points });
    }

    function saveHomeSsid(router) {
      const layout = plan();
      const old = layout.ssids.find(ssid => ssid.id === $('wifiHomeSsid').value);
      const name = $('wifiHomeSsidName').value.trim().replace(/\s+/g, ' ');
      if (!name || layout.ssids.some(ssid => ssid.name === name && ssid !== old)) return hint('Enter a unique SSID name.');
      if (!old && layout.ssids.length >= limits().ssids) return hint('The shared SSID list is full.');
      const ssid = { id: old?.id ?? id('ssid'), name, band: $('wifiHomeSsidBand').value, vlan: 0 };
      const ssids = old ? layout.ssids.map(item => item === old ? ssid : item) : [...layout.ssids, ssid];
      const equipment = layout.equipment.map(device => device === router ? { ...device, wifi_ssid: ssid.id } : device);
      apEdit = null;
      update({ ...layout, ssids, equipment });
    }

    function removeSsid() {
      const layout = plan(), sid = $('wifiApSsid').value;
      if (!layout.ssids.some(ssid => ssid.id === sid)) return;
      const ssids = layout.ssids.filter(ssid => ssid.id !== sid);
      const access_points = layout.access_points.map(ap => {
        const limits = { ...ap.ssid_limits };
        delete limits[sid];
        return { ...ap, ssid_limits: limits, ssid_ids: model.apSsids(ap, layout.ssids).filter(id => id !== sid) };
      });
      const equipment = layout.equipment.map(device => {
        if (device.ssid_id === sid) return { ...device, ssid_id: '' };
        if (device.wifi_ssid === sid) return { ...device, wifi_ssid: '' };
        return device;
      });
      apEdit = null;
      update({ ...layout, ssids, access_points, equipment });
    }

    function saveDhcp(router, input) {
      const dhcp = { gateway: $('wifiDhcpGateway').value.trim(), dns: $('wifiDhcpDns').value.trim(),
        fallback_dns: $('wifiDhcpFallback').value.trim() };
      const pool = model.dhcpPool(dhcp);
      const error = !pool ? 'Enter a valid gateway with a subnet prefix and two IPv4 DNS addresses.' : '';
      if (input) {
        input.setCustomValidity(error);
        if (error) { input.reportValidity(); return; }
      }
      if (error) return hint(error);
      const layout = plan();
      if (layout.equipment.some(item => item.services?.some(vm => vm.ip === model.address(pool.gateway)))) {
        return hint('A service VM already uses that gateway address. Change the VM address first.');
      }
      let released = 0;
      const equipment = layout.equipment.map(device => {
        if (device === router) return { ...router, dhcp };
        if (device.reservation?.router_id !== router.id || model.usable(pool, model.ipNumber(device.reservation.ip))) return device;
        const { reservation, ...client } = device;
        released += 1;
        return client;
      });
      if (update({ ...layout, equipment })) hint(released
        ? `DHCP saved. Released ${released} static ${released === 1 ? 'reservation' : 'reservations'} outside the new pool.`
        : 'DHCP settings saved.');
    }

    function saveVlan() {
      const layout = plan(), vid = Number($('wifiVlanId').value);
      const name = $('wifiVlanName').value.trim().replace(/\s+/g, ' ');
      const existing = layout.vlans.find(vlan => vlan.id === vid);
      if (!name || !Number.isInteger(vid) || vid < 1 || vid > 4094 || (existing && vlanEdit !== vid)) {
        return hint('Enter a name and an unused VLAN ID from 1 to 4094.');
      }
      if (!existing && layout.vlans.length >= limits().vlans) return hint('The VLAN list is full.');
      vlanEdit = vid;
      const vlans = existing ? layout.vlans.map(vlan => vlan === existing ? { id: vid, name } : vlan)
        : [...layout.vlans, { id: vid, name }];
      if (update({ ...layout, vlans })) hint('VLAN saved.');
    }

    function removeVlan() {
      const layout = plan(), vid = vlanEdit;
      const inUse = layout.ssids.some(ssid => ssid.vlan === vid) || layout.equipment.some(item =>
        Object.values(item.port_vlans || {}).some(tags => tags.includes(vid)) ||
        item.services?.some(vm => vm.vlan === vid) || item.vlan_limits?.[vid] ||
        item.firewall?.some(rule => rule.source_vlan === vid || rule.destination_vlan === vid));
      if (inUse) return hint('This VLAN is in use. Check SSIDs, switch ports, service VMs, bandwidth limits, and firewall rules.');
      vlanEdit = ADD;
      if (update({ ...layout, vlans: layout.vlans.filter(vlan => vlan.id !== vid) })) hint('VLAN removed.');
    }

    function saveRule(router) {
      const rules = [...(router.firewall ?? [])];
      const editing = ruleEdit?.router === router.id && rules[ruleEdit.index] === ruleEdit.rule;
      if (!editing && rules.length >= limits().firewall_rules) return hint('The firewall rule list is full.');
      const rule = { action: $('wifiFirewallAction').value };
      for (const side of ['source', 'destination']) {
        const prefix = side === 'source' ? 'Source' : 'Destination';
        const ip = $(`wifiFirewall${prefix}Ip`).value.trim();
        const vlan = $(`wifiFirewall${prefix}Vlan`)?.value ?? '';
        const cidr = ip && model.parseCidr(ip);
        if (ip && !cidr) return hint(`Enter a valid ${side} IPv4 address or CIDR, or leave it blank for any address.`);
        rule[side + '_ip'] = cidr ? (cidr.prefix === 32 ? model.address(cidr.first) : `${model.address(cidr.first)}/${cidr.prefix}`) : '';
        rule[side + '_vlan'] = vlan === '' ? null : Number(vlan);
      }
      if (editing) rules[ruleEdit.index] = rule;
      else rules.push(rule);
      ruleEdit = null;
      if (replace('equipment', { ...router, firewall: rules })) hint('Firewall rule saved.');
    }

    function click(device, target) {
      const action = target.dataset.wifiNetwork;
      if (action === 'pick-ssid' || action === 'new-ssid') {
        apEdit = { ap: device.id, ssid: action === 'new-ssid' ? ADD : target.dataset.ssid };
        render();
      } else if (action === 'save-ssid') saveSsid(device);
      else if (action === 'save-home-ssid') saveHomeSsid(device);
      else if (action === 'remove-ssid') removeSsid();
      else if (action === 'save-dhcp') saveDhcp(device);
      else if (action === 'save-vm') saveService(device, target.dataset.service, target.closest('.wifi-service-vm'));
      else if (action === 'save-vlan') saveVlan();
      else if (action === 'remove-vlan') removeVlan();
      else if (action === 'save-rule') saveRule(device);
      else if (action === 'pick-port') {
        portEdit = { device: device.id, port: target.dataset.port };
        render();
      } else if (action === 'cancel-rule') {
        ruleEdit = null;
        render();
      } else if (action === 'edit-rule') {
        const index = Number(target.dataset.index);
        ruleEdit = { router: device.id, index, rule: device.firewall[index] };
        render();
        $('wifiFirewallAction').focus();
      } else if (['rule-up', 'rule-down', 'remove-rule'].includes(action)) {
        const index = Number(target.dataset.index);
        const firewall = [...device.firewall];
        if (action === 'remove-rule') firewall.splice(index, 1);
        else {
          const to = index + (action === 'rule-up' ? -1 : 1);
          [firewall[index], firewall[to]] = [firewall[to], firewall[index]];
        }
        ruleEdit = null;
        replace('equipment', { ...device, firewall });
      }
    }

    function inspectPort(device, port) {
      if (!model.managed(device)) return;
      portEdit = { device: device.id, port };
      render();
      const section = document.querySelector('#wifiProperties [data-wifi-config="ports"]');
      if (section) section.open = true;
      $('wifiPortAccess')?.focus({ preventScroll: true });
    }

    return { apInspector, deviceInspector, clientInspector, change, click, inspectPort,
      reset: () => { apEdit = portEdit = ruleEdit = null; vlanEdit = ADD; } };
  }

  window.WifiSiteNetwork = { create };
})();
