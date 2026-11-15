/* Infra Sim network settings in the selected object's inspector. */
(function () {
  'use strict';

  const model = window.WifiSiteClientModel;
  const $ = id => document.getElementById(id);
  const ADD = ':add';
  const bands = [['2.4', '2.4 GHz'], ['5', '5 GHz'], ['both', 'Both bands']];

  function create({ plan, cabling, graph, update, replace, render, hint, escape, choices, id, limits }) {
    let apEdit, portEdit;

    const option = (entries, value) => choices(entries.map(([key, name]) => [String(key), name]), String(value));
    const vlans = () => [[0, '0 · Untagged LAN'], ...plan().vlans.map(vlan => [vlan.id, `${vlan.id} · ${vlan.name}`])];
    const vlanSelect = value => option(vlans(), value);
    const button = (action, text, extra = '') => `<button class="wifi-control" type="button" data-wifi-network="${action}"${extra}>${text}</button>`;
    const checked = value => value ? ' checked' : '';
    function selectedPort(device) {
      const { ports, occupancy } = cabling();
      const candidates = ports.get(device.id);
      return (portEdit?.device === device.id && candidates.find(port => port.id === portEdit.port))
        || candidates.find(port => occupancy.has(`${device.id}:${port.id}`)) || candidates[0];
    }

    function apInspector(ap) {
      const { ssids } = plan();
      const enabled = model.apSsids(ap, ssids);
      const choice = apEdit?.ap === ap.id ? apEdit.ssid : enabled[0] ?? ssids[0]?.id ?? ADD;
      const settings = ssids.find(ssid => ssid.id === choice);
      const selected = settings?.id ?? ADD;
      const on = enabled.includes(selected);
      return `<section class="wifi-network-settings">
        <label>Shared SSID<select id="wifiApSsid">${option([...ssids.map(ssid => [ssid.id,
          `${ssid.name}${enabled.includes(ssid.id) ? ' · On' : ''}`]), [ADD, 'Add SSID…']], selected)}</select></label>
        <p>${enabled.length} of 4 SSIDs enabled on this AP</p>
        ${settings ? `<label class="wifi-estimate-toggle"><input type="checkbox" id="wifiApSsidEnabled"${checked(on)}
          ${!on && enabled.length >= 4 ? ' disabled' : ''}> Broadcast on this AP</label>` : ''}
        <label>SSID name<input id="wifiSsidName" maxlength="32" value="${escape(settings?.name ?? '')}"></label>
        <div class="wifi-two-fields"><label>Radio band<select id="wifiSsidBand">${option(bands, settings?.band ?? 'both')}</select></label>
        <label>VLAN ID<select id="wifiSsidVlan">${vlanSelect(settings?.vlan ?? 0)}</select></label></div>
        <div class="wifi-object-actions">${button('save-ssid', settings ? 'Save SSID' : 'Add SSID')}
        ${settings ? button('remove-ssid', 'Remove SSID') : ''}</div>
        ${settings ? '' : '<p>New SSIDs join the shared list. This AP broadcasts the new SSID if it has a free slot.</p>'}
      </section>`;
    }

    function routerInspector(router) {
      const dhcp = router.dhcp ?? model.DEFAULT_DHCP;
      const rules = router.firewall ?? [];
      const { available, unassigned, pool } = graph().routers.get(router.id);
      const vlanOptions = option([['', 'Any VLAN'], ...vlans()], '');
      const endpoint = (rule, side) => {
        const vid = rule[side + '_vlan'];
        const vlan = vid == null ? 'Any VLAN' : `VLAN ${vid}`;
        return `${vlan} · ${rule[side + '_ip'] || 'Any IP'}`;
      };
      return `<details class="wifi-network-settings" data-wifi-config="dhcp"${available ? '' : ' open'}>
        <summary>DHCP</summary>
        ${available ? `<p>${available} of ${pool.capacity} client addresses available · shared across VLANs</p>`
          : `<p class="wifi-poe-warning" role="alert">DHCP pool exhausted.${unassigned ? ` ${unassigned} connected ${unassigned === 1 ? 'client is' : 'clients are'} waiting for an address.` : ''}</p>`}
        <label>Gateway and prefix<input id="wifiDhcpGateway" maxlength="18" value="${escape(dhcp.gateway)}" placeholder="192.168.0.1/24"></label>
        <div class="wifi-two-fields"><label>Primary DNS<input id="wifiDhcpDns" maxlength="15" value="${escape(dhcp.dns)}"></label>
        <label>Fallback DNS<input id="wifiDhcpFallback" maxlength="15" value="${escape(dhcp.fallback_dns)}"></label></div>
        ${button('save-dhcp', 'Save DHCP')}
      </details>
      <details class="wifi-network-settings" data-wifi-config="vlans"><summary>VLANs</summary>
        <ul class="wifi-vlan-list">${vlans().map(([, label]) => `<li>${escape(label)}</li>`).join('')}</ul>
        <div class="wifi-two-fields"><label>Name<input id="wifiVlanName" maxlength="60"></label>
        <label>VLAN ID<input id="wifiVlanId" type="number" min="1" max="4094" step="1"></label></div>
        ${button('add-vlan', 'Add VLAN')}
      </details>
      <details class="wifi-network-settings" data-wifi-config="firewall"><summary>Firewall</summary>
        <p>First matching rule wins. Unmatched router traffic is allowed. Same-VLAN traffic stays on the switch.</p>
        ${rules.length ? `<ol class="wifi-firewall-list">${rules.map((rule, i) => `<li>
          <strong>${rule.action === 'allow' ? 'Allow' : 'Deny'}</strong>
          <p>From ${escape(endpoint(rule, 'source'))}<br>To ${escape(endpoint(rule, 'destination'))}</p>
          <div class="wifi-object-actions">
            ${button('move-rule', 'Move up', ` data-index="${i}"${i ? '' : ' disabled'}`)}
            ${button('remove-rule', 'Remove', ` data-index="${i}" aria-label="Remove firewall rule ${i + 1}"`)}
          </div></li>`).join('')}</ol>` : ''}
        <label>Action<select id="wifiFirewallAction"><option value="allow">Allow</option><option value="deny">Deny</option></select></label>
        <div class="wifi-two-fields"><label>Source VLAN<select id="wifiFirewallSourceVlan">${vlanOptions}</select></label>
        <label>Destination VLAN<select id="wifiFirewallDestinationVlan">${vlanOptions}</select></label></div>
        <div class="wifi-two-fields"><label>Source IP or CIDR<input id="wifiFirewallSourceIp" maxlength="18" placeholder="Any"></label>
        <label>Destination IP or CIDR<input id="wifiFirewallDestinationIp" maxlength="18" placeholder="Any"></label></div>
        ${button('add-rule', 'Add Rule')}
      </details>`;
    }

    function switchInspector(device) {
      const port = selectedPort(device);
      const enabled = model.portVlans(device, port.id);
      const data = cabling();
      return `<details class="wifi-network-settings" data-wifi-config="ports"><summary>Port VLANs</summary>
        <label>Switch port<select id="wifiVlanPort">${option(data.ports.get(device.id).map(port => [
          port.id, `${port.id}${data.occupancy.has(`${device.id}:${port.id}`) ? ' · Connected' : ''}`,
        ]), port.id)}</select></label>
        <p>Enable every VLAN the port should carry. The first enabled VLAN is the access VLAN for wired clients.</p>
        ${vlans().map(([vid, label]) => `<label class="wifi-estimate-toggle"><input type="checkbox" data-wifi-port-vlan="${vid}"
          ${checked(enabled.includes(vid))}> ${escape(label)}${enabled[0] === vid ? ' · Access' : ''}</label>`).join('')}
      </details>`;
    }

    function clientInspector(device, info) {
      const { ssids } = plan();
      const lease = info.lease;
      const connected = lease && info.speed;
      const pool = lease && graph().routers.get(lease.router).pool;
      return `${device.kind === 'phone' ? `<label>Wi-Fi SSID<select id="wifiPhoneSsid">${option([
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

    function deviceInspector(device) {
      if (device.kind === 'router') return routerInspector(device);
      return model.managed(device) ? switchInspector(device) : '';
    }

    function change(device, input) {
      const { ssids } = plan();
      if (input.id === 'wifiApSsid') {
        apEdit = { ap: device.id, ssid: input.value };
        render();
        $('wifiApSsid').focus({ preventScroll: true });
      } else if (input.id === 'wifiApSsidEnabled') {
        const ssid = $('wifiApSsid').value;
        const enabled = model.apSsids(device, ssids);
        if (!input.checked || enabled.length < 4) {
          replace('access_points', { ...device, ssid_ids: input.checked ? [...enabled, ssid] : enabled.filter(id => id !== ssid) });
        }
      } else if (input.id === 'wifiVlanPort') {
        portEdit = { device: device.id, port: input.value };
        render();
        $('wifiVlanPort').focus({ preventScroll: true });
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
      const ssids = old ? layout.ssids.map(item => item === old ? ssid : item) : [...layout.ssids, ssid];
      const enabled = model.apSsids(ap, layout.ssids);
      const access_points = !old && enabled.length < 4 ? layout.access_points.map(item =>
        item === ap ? { ...ap, ssid_ids: [...enabled, ssid.id] } : item) : layout.access_points;
      apEdit = { ap: ap.id, ssid: ssid.id };
      update({ ...layout, ssids, access_points });
    }

    function removeSsid() {
      const layout = plan(), sid = $('wifiApSsid').value;
      if (!layout.ssids.some(ssid => ssid.id === sid)) return;
      const ssids = layout.ssids.filter(ssid => ssid.id !== sid);
      const access_points = layout.access_points.map(ap =>
        ({ ...ap, ssid_ids: model.apSsids(ap, layout.ssids).filter(id => id !== sid) }));
      const equipment = layout.equipment.map(device => device.ssid_id === sid ? { ...device, ssid_id: '' } : device);
      apEdit = null;
      update({ ...layout, ssids, access_points, equipment });
    }

    function saveDhcp(router) {
      const dhcp = { gateway: $('wifiDhcpGateway').value.trim(), dns: $('wifiDhcpDns').value.trim(),
        fallback_dns: $('wifiDhcpFallback').value.trim() };
      const pool = model.dhcpPool(dhcp);
      if (!pool) return hint('Enter a usable IPv4 gateway with a prefix that leaves room for clients, and two IPv4 DNS addresses.');
      const layout = plan();
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

    function addVlan() {
      const layout = plan(), vid = Number($('wifiVlanId').value);
      const name = $('wifiVlanName').value.trim().replace(/\s+/g, ' ');
      if (!name || !Number.isInteger(vid) || vid < 1 || vid > 4094 || layout.vlans.some(vlan => vlan.id === vid)) {
        return hint('Enter a name and an unused VLAN ID from 1 to 4094.');
      }
      if (layout.vlans.length >= limits().vlans) return hint('The VLAN list is full.');
      update({ ...layout, vlans: [...layout.vlans, { id: vid, name }] });
    }

    function addRule(router) {
      const rules = router.firewall ?? [];
      if (rules.length >= limits().firewall_rules) return hint('The firewall rule list is full.');
      const rule = { action: $('wifiFirewallAction').value };
      for (const side of ['source', 'destination']) {
        const prefix = side === 'source' ? 'Source' : 'Destination';
        const ip = $(`wifiFirewall${prefix}Ip`).value.trim();
        const vlan = $(`wifiFirewall${prefix}Vlan`).value;
        const cidr = ip && model.parseCidr(ip);
        if (ip && !cidr) return hint(`Enter a valid ${side} IPv4 address or CIDR, or leave it blank for any address.`);
        rule[side + '_ip'] = cidr ? (cidr.prefix === 32 ? model.address(cidr.first) : `${model.address(cidr.first)}/${cidr.prefix}`) : '';
        rule[side + '_vlan'] = vlan === '' ? null : Number(vlan);
      }
      replace('equipment', { ...router, firewall: [...rules, rule] });
    }

    function click(device, target) {
      const action = target.dataset.wifiNetwork;
      if (action === 'save-ssid') saveSsid(device);
      else if (action === 'remove-ssid') removeSsid();
      else if (action === 'save-dhcp') saveDhcp(device);
      else if (action === 'add-vlan') addVlan();
      else if (action === 'add-rule') addRule(device);
      else if (action === 'move-rule' || action === 'remove-rule') {
        const index = Number(target.dataset.index);
        const firewall = [...device.firewall];
        if (action === 'remove-rule') firewall.splice(index, 1);
        else [firewall[index - 1], firewall[index]] = [firewall[index], firewall[index - 1]];
        replace('equipment', { ...device, firewall });
      }
    }

    return { apInspector, deviceInspector, clientInspector, change, click,
      reset: () => { apEdit = portEdit = null; } };
  }

  window.WifiSiteNetwork = { create };
})();
