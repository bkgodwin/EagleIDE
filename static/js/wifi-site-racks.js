/* Equipment racks, front-panel patching, and the bill of materials. */
(function (root) {
  'use strict';

  const cableModel = root.WifiCablingModel;
  const face = { width: 760, height: 586, top: 13, unit: 35, left: 43, right: 705 };
  const palette = { router: '#e7edf2', core_switch: '#adbfc9', distribution_switch: '#cedbe2',
    patch_panel: '#33546a', server: '#38506a', ups: '#23384b' };

  function slotY(units, device, size) {
    return face.top + (units + 1 - device.u - size) * face.unit;
  }

  function portPositions(device, units) {
    const y = slotY(units, device, device.size);
    const lan = device.ports.filter(port => port.media === 'ethernet' && !port.wan);
    const uplink = device.ports.filter(port => port.media === 'fiber' || port.wan);
    return [...lan.map((port, i) => ({ ...port, x: face.left + 204 + (i % 24) * 16,
      y: y + (lan.length > 24 ? 9 + Math.floor(i / 24) * 16 : 16) })),
      ...uplink.map((port, i) => ({ ...port, x: face.right - 20 - (uplink.length - i - 1) * 18, y: y + 14 }))];
  }

  function rackData(rack, plan, data, catalog) {
    const gear = data.racks.get(rack.id) || [];
    const patches = plan.cables.filter(cable => cable.rack_patch && data.devices.get(cable.source.device_id).rack_id === rack.id);
    return {
      name: data.name(rack),
      power: data.rackPower(rack.id),
      devices: gear.map(item => ({
        id: item.id, kind: item.kind, name: data.name(item), u: item.rack_u, size: catalog.equipment[item.kind].rack_units,
        ports: data.ports.get(item.id).filter(port => !port.id.startsWith('BACK')).map(port => {
          const far = data.remoteEnd(item.id, port.id);
          const rear = item.kind === 'patch_panel' && data.remoteEnd(item.id, 'BACK' + port.id.slice(5));
          return { id: port.id, media: port.media, wan: port.wan,
            destination: rear ? data.name(data.devices.get(rear.device_id)) : '',
            connected: Boolean(far), peer: far ? data.endName(far) : '' };
        }),
      })),
      patches: patches.map(cable => ({ id: cable.id, media: cable.media, color: cable.color, source: cable.source,
        target: cable.target, label: cable.label })),
    };
  }

  function quantities(plan, data) {
    const totals = {};
    const add = (key, amount) => { totals[key] = (totals[key] || 0) + amount; };
    for (const equipment of plan.equipment) add(equipment.kind, 1);
    if (plan.access_points.length) add('access_point', plan.access_points.length);
    if (plan.pass_throughs.length) add('pass', plan.pass_throughs.length);
    for (const cable of plan.cables) {
      const route = data.inspections.get(cable.id);
      if (route) add((cable.rack_patch ? 'patch_' : '') + cable.media, route.length);
    }
    return totals;
  }

  function formatCost(cents) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
  }

  function materialRows(catalog, totals, units) {
    return Object.entries(catalog.costs).filter(([key]) => totals[key] > 0).map(([key, item]) => ({
      name: item.name,
      quantity: item.unit === 'each' ? totals[key] : units === 'ft' ? totals[key] / .3048 : totals[key],
      unit: item.unit === 'each' ? 'each' : units,
      unitCost: item.unit === 'm' && units === 'ft' ? item.cents * .3048 : item.cents,
      total: Math.round(totals[key] * item.cents),
    }));
  }

  function create(ctx) {
    const dialog = document.getElementById('wifiRackDialog');
    const body = document.getElementById('wifiRackBody');
    const title = document.getElementById('wifiRackTitle');
    const materials = document.getElementById('wifiMaterialsDialog');
    const materialBody = document.getElementById('wifiMaterialsBody');
    const escape = ctx.escape;
    let rackId, mode, installing, selected, source, media, message;
    const endKey = end => cableModel.portKey(end);

    function open(id, type) {
      const rack = ctx.data().devices.get(id);
      if (rack?.kind !== 'rack') return;
      rackId = id;
      mode = type ? 'install' : 'inspect';
      installing = type || 'patch_panel';
      selected = source = null;
      media = 'ethernet';
      message = '';
      render();
      if (!dialog.open) dialog.showModal();
    }

    function reset() {
      if (dialog.open) dialog.close();
      if (materials.open) materials.close();
      rackId = selected = source = null;
    }

    function renderFace(sheet, units) {
      const ports = new Map();
      const rails = Array.from({ length: units }, (_, i) => {
        const y = face.top + i * face.unit;
        return `<path d="M29 ${y}H720" stroke="#42566a"/><text x="26" y="${y + 22}" text-anchor="end" fill="#c3d0dc">${units - i}</text>
          <circle cx="34" cy="${y + 16}" r="2" fill="#99aabc"/><circle cx="712" cy="${y + 16}" r="2" fill="#99aabc"/>`;
      }).join('');
      const devices = sheet.devices.map(device => {
        const y = slotY(units, device, device.size);
        const color = palette[device.kind];
        const light = ['router', 'core_switch', 'distribution_switch'].includes(device.kind);
        const ink = light ? '#142b3c' : '#e8f2f8';
        const rows = portPositions(device, units).map(port => {
          const end = { device_id: device.id, port: port.id };
          ports.set(endKey(end), port);
          const chosen = source && endKey(source) === endKey(end);
          const valid = port.media === media && !port.connected && !port.wan;
          const descriptor = `${device.name} ${port.id}${port.destination ? ' · rear to ' + port.destination : ''}${port.peer ? ' · to ' + port.peer : ''}`;
          const indicator = port.connected ? '#61d8a3' : port.destination ? '#e9b155' : '#648398';
          const portNum = (port.wan ? port.media === 'fiber' ? 'WF' : 'W' : port.media === 'fiber' ? 'S' : '') + (port.id.match(/\d+$/)?.[0] || port.id);
          return `<g class="wifi-rack-port${chosen ? ' is-active' : ''}${mode === 'cable' && valid ? ' is-available' : ''}"
            data-rack-port="${escape(endKey(end))}" ${mode === 'cable' ? `role="button" tabindex="0" aria-label="${escape(descriptor)}"` : ''}>
            <title>${escape(descriptor)}</title><rect x="${port.x - 6}" y="${port.y - 5}" width="12" height="11" rx="1.4" fill="#0d202d" stroke="${indicator}"/>
            <path d="M${port.x - 2} ${port.y + 1}h4" stroke="${indicator}"/>
            <text x="${port.x}" y="${port.y + 13}" text-anchor="middle" fill="${ink}" font-size="6.5">${portNum}</text>
            </g>`;
        }).join('');
        const runtime = sheet.power.overloaded ? 'OVERLOAD' : sheet.power.watts ? `${sheet.power.minutes} MIN` : 'NO LOAD';
        const lcd = device.kind === 'ups' ? `<rect x="416" y="${y + 14}" width="173" height="40" rx="4" fill="#071a24" stroke="#446779"/>
          <text x="430" y="${y + 30}" fill="#a7e9d7" font-family="monospace" font-size="15">${runtime}</text>
          <text x="430" y="${y + 45}" fill="#a7e9d7" font-family="monospace" font-size="10">LOAD ${sheet.power.watts} W</text>
          <circle cx="625" cy="${y + 34}" r="7" fill="#58778a"/><path d="M643 ${y + 25}h42m-42 6h42m-42 6h42m-42 6h42" stroke="#6b8798"/>` : '';
        const label = device.name.length > 29 ? device.name.slice(0, 28) + '…' : device.name;
        return `<g class="wifi-rack-gear${selected === device.id ? ' is-selected' : ''}" data-rack-device="${escape(device.id)}"
            ${mode !== 'cable' ? `role="button" tabindex="0" aria-label="${escape(device.name)}"` : ''}>
          <title>${escape(device.name)}</title><rect class="wifi-rack-chassis" x="${face.left}" y="${y + 1}" width="${face.right - face.left}"
            height="${device.size * face.unit - 2}" rx="3" fill="${color}" stroke="#8297a7"/>
          <text x="58" y="${y + 21}" fill="${ink}" font-weight="600">${escape(label)}</text>${lcd}${rows}</g>`;
      }).join('');
      const lines = sheet.patches.map((wire, i) => {
        const a = ports.get(endKey(wire.source)), b = ports.get(endKey(wire.target));
        const gutter = face.right + 5 + (i % 10) * 3.2;
        const swing = Math.max(5, Math.min(11, (b.y - a.y) / 4));
        const path = `M${a.x},${a.y} q0,${swing} 11,${swing} H${gutter} Q${gutter + 4},${a.y + swing} ${gutter + 4},${a.y + swing + 4}
          V${b.y + swing + 4} Q${gutter + 4},${b.y + swing} ${gutter},${b.y + swing} H${b.x + 11} q-11,0 -11,${-swing}`;
        return `<g class="wifi-rack-cord"><path d="${path}" stroke="#102536" stroke-width="3.6"/>
          <path d="${path}" stroke="${escape(wire.color)}" stroke-width="2.1"${wire.media === 'fiber' ? ' stroke-dasharray="5 2"' : ''}/></g>`;
      }).join('');
      return `<svg class="wifi-rack-face" viewBox="0 0 ${face.width} ${face.height}" aria-label="Front elevation of the rack">
        <rect x="2" y="2" width="756" height="582" rx="8" fill="#182b3b" stroke="#52697f"/>
        <rect x="43" y="13" width="662" height="560" fill="#102030"/>
        <g font-family="system-ui, sans-serif" font-size="11">${rails}${devices}${lines}</g></svg>`;
    }

    function options(entries, value) {
      return entries.map(([key, label]) => `<option value="${escape(key)}"${String(key) === String(value) ? ' selected' : ''}>${escape(label)}</option>`).join('');
    }

    function render() {
      const data = ctx.data(), catalog = ctx.catalog(), plan = ctx.plan();
      const rack = data.devices.get(rackId);
      if (!rack) { reset(); return; }
      const sheet = rackData(rack, plan, data, catalog);
      title.textContent = sheet.name;
      const allowed = Object.entries(catalog.equipment).filter(([, entry]) => entry.rack_units);
      const openUnits = data.availableUnits(rackId, installing);
      const device = data.devices.get(selected);
      const occupied = device && data.isConnected(device.id);
      const moveUnits = device ? data.availableUnits(rackId, device.kind, device.id) : [];
      const rear = sheet.devices.flatMap(item => item.ports.filter(port => port.destination)
        .map(port => `<li><strong>${escape(item.name)} · ${port.id.slice(5)}</strong><span>${escape(port.destination)}</span></li>`)).join('');
      const patches = sheet.patches.map(wire => `<li><span><i style="--cord:${escape(wire.color)}"></i>${escape(data.endName(wire.source))}
        ↔ ${escape(data.endName(wire.target))}</span><button class="wifi-control" type="button" data-rack-remove-cable="${escape(wire.id)}">Disconnect</button></li>`).join('');
      body.innerHTML = `<div class="wifi-rack-toolbar" role="group" aria-label="Rack tools">
        <button class="wifi-control" type="button" data-rack-mode="inspect" aria-pressed="${mode === 'inspect'}">Select</button>
        <button class="wifi-control" type="button" data-rack-mode="install" aria-pressed="${mode === 'install'}">Install Equipment</button>
        <button class="wifi-control" type="button" data-rack-mode="move" aria-pressed="${mode === 'move'}">Move Equipment</button>
        <button class="wifi-control" type="button" data-rack-mode="cable" aria-pressed="${mode === 'cable'}">Cable</button>
        ${mode === 'cable' ? `<label>Media <select data-rack-media><option value="ethernet"${media === 'ethernet' ? ' selected' : ''}>Ethernet</option><option value="fiber"${media === 'fiber' ? ' selected' : ''}>SFP fiber</option></select></label>
          <button class="wifi-control" type="button" data-rack-cancel-cable ${source ? '' : 'disabled'}>Clear Port</button>` : ''}
        <button class="wifi-control wifi-rack-settings" type="button" data-rack-config="${escape(rack.id)}">Rack Settings</button>
      </div><p class="wifi-rack-status" role="status">${escape(message || (mode === 'cable' ?
          source ? 'Select the destination port.' : 'Select an available front port.' : mode === 'move' ?
          'Select a device to change its mounting position.' : 'Select installed equipment to configure it.'))}</p>
      <div class="wifi-rack-layout">
        <div class="wifi-rack-face-wrap">${renderFace(sheet, catalog.rack_units)}</div>
        <aside class="wifi-rack-details">
          <section><h3>Rack power</h3><p>${sheet.power.watts} W load · ${sheet.power.units} UPS${sheet.power.units === 1 ? '' : ' units'}</p>
            ${sheet.power.overloaded ? '<p>UPS load exceeds output capacity.</p>' : sheet.power.units && sheet.power.watts ? `<p>Estimated runtime ${sheet.power.minutes} min</p>` : ''}</section>
          ${mode === 'install' ? `<section><h3>Install equipment</h3>
            <label>Device<select data-rack-kind>${options(allowed.map(([kind, profile]) => [kind, `${profile.name} · ${profile.rack_units}U`]), installing)}</select></label>
            <label>Bottom unit<select data-rack-unit ${openUnits.length ? '' : 'disabled'}>${openUnits.length ? options(openUnits.map(u => [u, 'U' + u])) : '<option>No space available</option>'}</select></label>
            <button class="wifi-control" type="button" data-rack-add ${openUnits.length ? '' : 'disabled'}>Install</button></section>` : ''}
          ${mode === 'move' && device ? `<section><h3>${escape(data.name(device))}</h3>
            <button class="wifi-control" type="button" data-rack-config="${escape(device.id)}">Configure</button>
            <label>Bottom unit<select data-rack-move ${occupied ? 'disabled' : ''}>${options(moveUnits.map(u => [u, 'U' + u]), device.rack_u)}</select></label>
            ${occupied ? '<p>Disconnect all cables to move this device.</p>' : ''}</section>` : ''}
          <section><h3>Rear terminations</h3>${rear ? `<ul class="wifi-rack-list">${rear}</ul>` : '<p>No building runs connected.</p>'}</section>
          <section><h3>Patch cables</h3>${patches ? `<ul class="wifi-rack-list">${patches}</ul>` : '<p>No patch cables connected.</p>'}</section>
        </aside>
      </div>`;
    }

    function patchPort(value) {
      const [device_id, port] = value.split(':');
      const next = { device_id, port };
      const data = ctx.data();
      if (source && endKey(next) === endKey(source)) { source = null; return; }
      if (!data.availablePorts(device_id, media, source?.device_id).some(profile => profile.id === port && !profile.wan)) {
        message = 'Choose an unused front port for the selected medium.';
        return;
      }
      if (!source) { source = next; return; }
      const cable = { id: ctx.id('wire'), media, color: cableModel.COLORS[media], label: '', waypoints: [],
        rack_patch: true, source, target: next };
      const error = data.checkCable(cable).error;
      if (error) { message = error; return; }
      if (ctx.add('cables', [cable])) {
        source = null;
        message = 'Patch cable connected.';
      }
    }

    body.addEventListener('click', event => {
      const target = event.target;
      const control = target.closest('button, [data-rack-device]');
      if (!control) return;
      const { rackMode, rackConfig, rackDevice, rackRemoveCable } = control.dataset;
      message = '';
      if (rackMode) { mode = rackMode; source = null; }
      else if (rackConfig) { dialog.close(); ctx.configure(rackConfig); return; }
      else if (control.hasAttribute('data-rack-cancel-cable')) source = null;
      else if (control.hasAttribute('data-rack-add')) {
        const data = ctx.data();
        const rack = data.devices.get(rackId);
        const catalog = ctx.catalog();
        const unit = Number(body.querySelector('[data-rack-unit]').value);
        if (!data.availableUnits(rackId, installing).includes(unit)) return;
        const equipment = { id: ctx.id('device'), kind: installing, name: '', rack_id: rackId, rack_u: unit, x: rack.x, y: rack.y };
        if (!ctx.add('equipment', [equipment])) return;
        selected = equipment.id;
        mode = 'inspect';
        message = 'Equipment installed.';
      } else if (rackRemoveCable) {
        ctx.removeCable(rackRemoveCable);
      } else if (rackDevice) {
        if (mode === 'cable') {
          const port = target.closest('[data-rack-port]');
          if (port) patchPort(port.dataset.rackPort);
        } else if (mode === 'inspect') {
          dialog.close();
          ctx.configure(rackDevice);
          return;
        } else if (mode === 'move') {
          selected = rackDevice;
        }
      }
      render();
    });
    body.addEventListener('change', event => {
      const input = event.target;
      if (input.hasAttribute('data-rack-kind')) installing = input.value;
      else if (input.hasAttribute('data-rack-media')) { media = input.value; source = null; }
      else if (input.hasAttribute('data-rack-move')) {
        const data = ctx.data(), device = data.devices.get(selected), unit = Number(input.value);
        if (device && !data.isConnected(selected) && data.availableUnits(rackId, device.kind, selected).includes(unit)) {
          ctx.replace('equipment', { ...device, rack_u: unit });
        }
      } else return;
      message = '';
      render();
    });
    body.addEventListener('keydown', event => {
      if (['Enter', ' '].includes(event.key) && event.target.matches('svg [tabindex]')) {
        event.preventDefault();
        event.target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }
    });

    function inspectMaterials() {
      const plan = ctx.plan(), data = ctx.data();
      const rows = materialRows(ctx.catalog(), quantities(plan, data), plan.units);
      const total = rows.reduce((sum, row) => sum + row.total, 0);
      materialBody.innerHTML = `<p>Estimated hardware and cable materials · USD</p>
        <div class="wifi-materials-table"><table><thead><tr><th scope="col">Item</th><th scope="col">Quantity</th><th scope="col">Unit cost</th><th scope="col">Subtotal</th></tr></thead>
        <tbody>${rows.map(row => `<tr><th scope="row">${escape(row.name)}</th><td>${row.quantity.toLocaleString('en-US', { maximumFractionDigits: 2 })}
        ${row.unit === 'each' ? '' : row.unit}</td><td>${formatCost(row.unitCost)}${row.unit === 'each' ? '' : ' / ' + row.unit}</td><td>${formatCost(row.total)}</td></tr>`).join('') ||
        '<tr><td colspan="4">No network materials placed.</td></tr>'}</tbody>
        <tfoot><tr><th colspan="3" scope="row">Estimated total</th><td>${formatCost(total)}</td></tr></tfoot></table></div>
        <p class="wifi-rack-status">Budget estimates exclude labor, tax, and recurring service.</p>`;
      if (!materials.open) materials.showModal();
    }

    function exportData(plan, data) {
      return {
        racks: plan.equipment.filter(item => item.kind === 'rack').map(rack => rackData(rack, plan, data, ctx.catalog())),
        bill: quantities(plan, data),
      };
    }

    return { open, reset, inspectMaterials, exportData };
  }

  root.WifiSiteRacks = { create, rackData, quantities, materialRows };
}(typeof window === 'object' ? window : globalThis));
