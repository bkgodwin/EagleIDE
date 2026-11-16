/* Equipment racks, front-panel patching, and the bill of materials. */
(function (root) {
  'use strict';

  const cableModel = root.WifiCablingModel;
  const face = { width: 944, top: 16, unit: 44, left: 53, right: 856 };
  const hardware = {
    router: ['#b8c9d6', '#162c40', 'Gateway'],
    core_switch: ['#9eb0c2', '#14273b', '48-port PoE'],
    distribution_switch: ['#c6d1dc', '#15283b', '24-port PoE'],
    patch_panel: ['#3c5670', '#f0f6fc', 'Rear terminations'],
    server: ['#31465c', '#eff5fb', 'Rack server'],
    ups: ['#273c50', '#eff5fb', 'Battery backup'],
  };

  function slotY(units, device, size) {
    return face.top + (units + 1 - device.u - size) * face.unit;
  }

  function portPositions(device, units) {
    const y = slotY(units, device, device.size);
    const lan = device.ports.filter(port => port.media === 'ethernet' && !port.wan);
    const uplink = device.ports.filter(port => port.media === 'fiber' || port.wan);
    return [...lan.map((port, i) => ({ ...port, x: device.kind === 'server' ? 811 : 276 + (i % 24) * 20,
      y: y + (device.kind === 'server' ? 43 : lan.length > 24 ? 11 + Math.floor(i / 24) * 20 : 18) })),
      ...uplink.map((port, i) => ({ ...port, x: 819 - (uplink.length - i - 1) * 20, y: y + 18 }))];
  }

  function rackData(rack, plan, data, catalog) {
    const gear = data.racks.get(rack.id) || [];
    const patches = plan.cables.filter(cable => cable.rack_patch && data.devices.get(cable.source.device_id)?.rack_id === rack.id);
    return {
      name: data.name(rack),
      power: data.rackPower(rack.id),
      devices: gear.map(item => ({
        id: item.id, kind: item.kind, name: data.name(item), u: item.rack_u, size: catalog.equipment[item.kind].rack_units,
        ports: data.ports.get(item.id).filter(port => !port.id.startsWith('BACK')).map(port => {
          const far = data.remoteEnd(item.id, port.id);
          const rear = item.kind === 'patch_panel' && data.remoteEnd(item.id, 'BACK' + port.id.slice(5));
          const rearDevice = rear && data.devices.get(rear.device_id);
          return { id: port.id, media: port.media, wan: port.wan,
            destination: rearDevice ? data.name(rearDevice) : '',
            rearLabel: rearDevice?.name || '',
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


  function faceplate(device, y, power) {
    if (device.kind === 'ups') {
      const runtime = power.overloaded ? 'OVERLOAD' : power.watts ? `${power.minutes} MIN` : 'NO LOAD';
      return `<rect x="526" y="${y + 16}" width="204" height="55" rx="5" fill="#0b171d" stroke="#7895a9"/>
        <g fill="#a2f0d6" font-family="monospace"><text x="542" y="${y + 39}" font-size="18">${runtime}</text>
        <text x="542" y="${y + 59}" font-size="12">LOAD ${power.watts} W</text></g>
        <circle cx="760" cy="${y + 44}" r="12" fill="#1d2b39" stroke="#8da3b5"/>
        <path d="M760 ${y + 39}v5m-4-3a5 5 0 1 0 8 0" fill="none" stroke="#a2f0d6"/>
        <rect x="784" y="${y + 20}" width="47" height="48" rx="3" fill="url(#wifiRackVents)"/>`;
    }
    if (device.kind === 'server') {
      return Array.from({ length: 6 }, (_, i) => {
        const x = 281 + i * 76;
        return `<rect x="${x}" y="${y + 14}" width="68" height="59" rx="4" fill="#233243" stroke="#7790a5"/>
          <rect x="${x + 8}" y="${y + 21}" width="52" height="36" rx="2" fill="url(#wifiRackVents)"/>
          <path d="M${x + 10} ${y + 64}h29" stroke="#8195a7" stroke-width="3"/>
          <circle cx="${x + 58}" cy="${y + 64}" r="2" fill="#8fe6ae"/>`;
      }).join('') + `<rect x="747" y="${y + 14}" width="81" height="59" rx="4" fill="#203244" stroke="#7790a5"/>
        <circle cx="776" cy="${y + 43}" r="10" fill="#132638" stroke="#8195a7"/>
        <circle cx="776" cy="${y + 43}" r="3" fill="#8fe6ae"/>`;
    }
    if (device.kind === 'router') {
      return `<rect x="385" y="${y + 7}" width="275" height="29" rx="3" fill="url(#wifiRackVents)"/>`;
    }
    return '';
  }

  function create(ctx) {
    const dialog = document.getElementById('wifiRackDialog');
    const body = document.getElementById('wifiRackBody');
    const title = document.getElementById('wifiRackTitle');
    const subtitle = document.getElementById('wifiRackSubtitle');
    const materials = document.getElementById('wifiMaterialsDialog');
    const materialBody = document.getElementById('wifiMaterialsBody');
    const { escape, inspector } = ctx;
    const inspectorHome = inspector.parentElement;
    const endKey = end => cableModel.portKey(end);
    let rackId, mode, selected, source, zoom, drag, dragFrame, returnFocus;
    let message = '';

    body.innerHTML = `<div class="wifi-rack-toolbar">
      <div class="wifi-rack-tools" role="group" aria-label="Rack tools">
        <button class="wifi-control" type="button" data-rack-mode="inspect">Select</button>
        <button class="wifi-control" type="button" data-rack-mode="install">Install Equipment</button>
        <button class="wifi-control" type="button" data-rack-mode="cable">Cable</button>
        <button class="wifi-control" type="button" data-rack-settings>Rack Settings</button>
      </div>
      <div class="wifi-rack-zoom" role="group" aria-label="Rack zoom">
        <button class="wifi-control" type="button" data-rack-zoom="out" aria-label="Zoom out">−</button>
        <output aria-label="Rack zoom level" data-rack-scale></output>
        <button class="wifi-control" type="button" data-rack-zoom="in" aria-label="Zoom in">+</button>
        <button class="wifi-control" type="button" data-rack-zoom="fit">Fit width</button>
      </div>
    </div>
    <div class="wifi-rack-patching" hidden>
      <label>Media <select data-rack-media><option value="ethernet">Ethernet</option><option value="fiber">SFP fiber</option></select></label>
      <button class="wifi-control" type="button" data-rack-cancel-cable>Clear Port</button>
    </div>
    <p class="wifi-rack-status" role="status"></p>
    <div class="wifi-rack-layout">
      <div class="wifi-rack-elevation">
        <div class="wifi-rack-face-wrap" tabindex="0" role="region" aria-label="Front elevation of the rack"></div>
        <div class="wifi-rack-tooltip" role="tooltip" hidden></div>
      </div>
      <aside class="wifi-rack-details" aria-label="Rack details">
        <section class="wifi-rack-config" data-rack-config hidden>
          <div class="wifi-rack-config-heading"><h3></h3>
            <button class="wifi-control" type="button" data-rack-overview>Overview</button>
          </div>
          <label data-rack-mount>Mounting position<select data-rack-move aria-label="Mounting position"></select></label>
          <div data-rack-properties></div>
        </section>
        <section data-rack-install hidden>
          <h3>Install equipment</h3>
          <label>Equipment type<select data-rack-kind aria-label="Equipment type"></select></label>
          <label>Bottom unit<select data-rack-unit></select></label>
          <button class="wifi-control" type="button" data-rack-add>Install</button>
        </section>
        <section data-rack-summary></section>
        <section data-rack-terminations></section>
        <section data-rack-patches></section>
      </aside>
    </div>`;

    const $ = selector => body.querySelector(selector);
    const view = $('.wifi-rack-face-wrap');
    const tooltip = $('.wifi-rack-tooltip');
    const details = $('.wifi-rack-details');
    const config = $('[data-rack-config]');
    const install = $('[data-rack-install]');
    const kindInput = $('[data-rack-kind]');
    const unitInput = $('[data-rack-unit]');
    const media = $('[data-rack-media]');
    const isOpen = () => dialog.open;
    const inspectedId = () => mode === 'inspect' ? selected : null;
    const focusTools = () => $('[data-rack-mode="inspect"]').focus({ preventScroll: true });

    function announce(text = '') {
      message = text;
      const prompt = mode === 'cable'
        ? source ? 'Choose a matching port on another device.' : 'Choose a highlighted front port.'
        : mode === 'install' ? 'Choose a device and an open mounting position.'
          : 'Select equipment to configure it. Drag a chassis to move it.';
      const status = $('.wifi-rack-status');
      const next = message || prompt;
      if (status.textContent !== next) status.textContent = next;
    }

    function open(id, deviceId) {
      const data = ctx.data();
      if (data.devices.get(id)?.kind !== 'rack') return;
      rackId = id;
      mode = 'inspect';
      selected = data.devices.get(deviceId)?.rack_id === id ? deviceId : null;
      source = null;
      message = '';
      zoom = 1;
      media.value = 'ethernet';
      kindInput.innerHTML = options(Object.entries(ctx.catalog().equipment).filter(([, entry]) => entry.rack_units)
        .map(([kind, entry]) => [kind, `${entry.name} · ${entry.rack_units}U`]), 'patch_panel');
      unitInput.replaceChildren();
      returnFocus = document.activeElement?.matches('[data-wifi-open-rack]');
      $('[data-rack-properties]').append(inspector);
      if (!dialog.open) dialog.showModal();
      refresh();
      view.scrollTop = view.scrollLeft = details.scrollTop = 0;
      ctx.renderInspector();
    }

    function restoreInspector() {
      if (inspector.parentElement === inspectorHome) return;
      inspectorHome.append(inspector);
      if (ctx.plan()) ctx.renderInspector();
    }

    function reset() {
      finishDrag();
      if (dialog.open) dialog.close();
      if (materials.open) materials.close();
      rackId = selected = source = null;
      restoreInspector();
    }

    dialog.addEventListener('close', () => {
      if (dialog.open) return;
      finishDrag();
      tooltip.hidden = true;
      restoreInspector();
      if (returnFocus) inspector.querySelector('[data-wifi-open-rack]')?.focus({ preventScroll: true });
      returnFocus = false;
    });

    function renderFace(sheet, units) {
      const height = units * face.unit + face.top * 2;
      const ports = new Map();
      const rails = Array.from({ length: units }, (_, i) => {
        const y = face.top + i * face.unit;
        return `<rect x="37" y="${y}" width="826" height="${face.unit}" fill="${i % 2 ? '#172638' : '#1a2a3d'}"/>
          <path d="M37 ${y}H870" stroke="#425972"/>
          <text class="wifi-rack-unit-number" x="30" y="${y + 27}" text-anchor="end" fill="#c9d6e5">U${units - i}</text>
          <path d="M41 ${y + 8}h6m-6 14h6m-6 14h6m815-28h6m-6 14h6m-6 14h6" stroke="#7d91a8" stroke-width="2"/>`;
      }).join('');
      const devices = sheet.devices.map(device => {
        const y = slotY(units, device, device.size);
        const height = device.size * face.unit;
        const [color, ink, badge] = hardware[device.kind];
        const rows = portPositions(device, units).map(port => {
          const key = endKey({ device_id: device.id, port: port.id });
          ports.set(key, port);
          const chosen = source && endKey(source) === key;
          const valid = port.media === media.value && !port.connected && !port.wan && source?.device_id !== device.id;
          const descriptor = `${device.name} · ${port.id}${port.rearLabel ? ' · Rear to ' + port.rearLabel : ''}${port.peer ? ' · Patched to ' + port.peer : ''}`;
          const indicator = port.connected ? '#8ef0b5' : port.destination ? '#ffd182' : '#889fb2';
          const portNum = (port.wan ? port.media === 'fiber' ? 'WF' : 'W' : port.media === 'fiber' ? 'S' : '') + (port.id.match(/\d+$/)?.[0] || port.id);
          const x = port.x, y = port.y;
          return `<g class="wifi-rack-port${chosen ? ' is-active' : ''}${mode === 'cable' && valid ? ' is-available' : ''}"
            data-rack-port="${escape(key)}" data-rack-tooltip="${escape(descriptor)}" aria-label="${escape(descriptor)}"
            ${mode === 'cable' ? `role="button" tabindex="${valid || chosen ? 0 : -1}" aria-disabled="${!valid && !chosen}"` : ''}>
            <rect class="wifi-rack-port-hit" x="${x - 10}" y="${y - 9}" width="20" height="20" fill="transparent"/>
            <rect class="wifi-rack-jack" x="${x - 8}" y="${y - 7}" width="16" height="13" rx="2" fill="#101e2c" stroke="${indicator}"/>
            ${port.media === 'fiber'
              ? `<rect x="${x - 5}" y="${y - 4}" width="10" height="7" rx="1" fill="#52697c"/><path d="M${x - 3} ${y}h2m2 0h2" stroke="#c8e0ed"/>`
              : `<path d="M${x - 5} ${y - 4}h10v6h-3v2h-4v-2h-3z" fill="#31495e"/>
                <path d="M${x - 3} ${y - 3}h6" stroke="#d8b063" stroke-dasharray="1 1"/>`}
            <circle cx="${x + 5}" cy="${y - 4}" r="1.25" fill="${indicator}"/>
            <text x="${x}" y="${y + 12}" text-anchor="middle" fill="${ink}" font-size="8">${escape(portNum)}</text>
            </g>`;
        }).join('');
        const label = device.name.length > 24 ? device.name.slice(0, 23) + '…' : device.name;
        return `<g class="wifi-rack-gear${selected === device.id ? ' is-selected' : ''}" data-rack-device="${escape(device.id)}"
            ${mode === 'inspect' ? `role="button" tabindex="0" aria-label="${escape(device.name)} at U${device.u}" aria-pressed="${selected === device.id}"` : ''}>
          <rect class="wifi-rack-chassis" x="${face.left}" y="${y + 1}" width="${face.right - face.left}"
            height="${height - 2}" rx="4" fill="${color}" stroke="#8499af"/>
          <path d="M58 ${y + 4}H850M58 ${y + height - 4}H850" stroke="${ink}" opacity=".32"/>
          <path d="M57 ${y + 4}h17v${height - 8}H57zm777 0h17v${height - 8}h-17z" fill="#142537" opacity=".34">
            <title>${escape(device.name)} · U${device.u}</title>
          </path>
          <g fill="#9aaebf" stroke="#344b5d" stroke-width="1.2">
            <circle cx="65" cy="${y + 10}" r="3"/><circle cx="65" cy="${y + height - 10}" r="3"/>
            <circle cx="842" cy="${y + 10}" r="3"/><circle cx="842" cy="${y + height - 10}" r="3"/>
          </g>
          <path class="wifi-rack-grip" d="M61 ${y + height / 2 - 4}h8m-8 4h8m-8 4h8" stroke="${ink}" stroke-width="1.5" opacity=".9"/>
          <text x="85" y="${y + 18}" fill="${ink}" font-size="13" font-weight="700">${escape(label)}</text>
          <text x="85" y="${y + 33}" fill="${ink}" font-size="10" opacity=".86">${badge}</text>
          ${faceplate(device, y, sheet.power)}${rows}</g>`;
      }).join('');
      const lines = sheet.patches.map((wire, i) => {
        const a = ports.get(endKey(wire.source)), b = ports.get(endKey(wire.target));
        if (!a || !b) return '';
        const gutter = face.right + 16 + (i % 16) * 4;
        const drop = 15 + (i % 3) * 3;
        const path = `M${a.x},${a.y + 5} q0,${drop} 12,${drop} H${gutter}
          C${gutter + 14},${a.y + 5 + drop} ${gutter + 14},${b.y + 5 + drop} ${gutter},${b.y + 5 + drop}
          H${b.x + 12} q-12,0 -12,${-drop}`;
        return `<g class="wifi-rack-cord" data-rack-cord="${escape(wire.id)}"><path d="${path}" stroke="#0c1a25" stroke-width="4.3"/>
          <path d="${path}" stroke="${escape(wire.color)}" stroke-width="2.5"${wire.media === 'fiber' ? ' stroke-dasharray="6 2"' : ''}/></g>`;
      }).join('');
      return `<svg class="wifi-rack-face" viewBox="0 0 ${face.width} ${height}" aria-label="Rack mounting units and front ports">
        <defs><pattern id="wifiRackVents" width="6" height="6" patternUnits="userSpaceOnUse">
          <rect width="6" height="6" fill="#25394b"/><circle cx="3" cy="3" r="1.65" fill="#0d1d2c"/>
        </pattern></defs>
        <rect x="1" y="1" width="${face.width - 2}" height="${height - 2}" rx="9" fill="#172637" stroke="#50667e"/>
        <path d="M35 13h836v${height - 26}H35z" fill="#0e1d2b" stroke="#516981"/>
        <g font-family="system-ui, sans-serif" font-size="12">${rails}${devices}${lines}</g>
        <rect class="wifi-rack-drop" x="${face.left}" width="${face.right - face.left}" rx="4" visibility="hidden"/>
      </svg>`;
    }

    function options(entries, value) {
      return entries.map(([key, label]) => `<option value="${escape(key)}"${String(key) === String(value) ? ' selected' : ''}>${escape(label)}</option>`).join('');
    }

    function refresh() {
      if (!dialog.open) return;
      finishDrag();
      const data = ctx.data(), catalog = ctx.catalog();
      const rack = data.devices.get(rackId);
      if (!rack) { reset(); return; }
      const sheet = rackData(rack, ctx.plan(), data, catalog);
      title.textContent = sheet.name;
      const installed = sheet.devices.reduce((used, device) => used + device.size, 0);
      subtitle.textContent = `Equipment rack · ${installed} of ${catalog.rack_units}U occupied`;
      if (selected && !data.devices.has(selected)) selected = null;
      const device = data.devices.get(inspectedId());
      const move = $('[data-rack-move]');
      config.hidden = !device;
      if (device) {
        config.querySelector('h3').textContent = device.rack_id ? data.name(device) : 'Rack Settings';
        $('[data-rack-mount]').hidden = !device.rack_id;
        if (device.rack_id) {
          const available = data.availableUnits(rackId, device.kind, device.id);
          move.innerHTML = options(unitOptions(available, catalog.equipment[device.kind].rack_units), device.rack_u);
        }
      }
      install.hidden = mode !== 'install';
      if (mode === 'install') {
        const available = data.availableUnits(rackId, kindInput.value);
        unitInput.innerHTML = available.length ? options(unitOptions(available, catalog.equipment[kindInput.value].rack_units), unitInput.value)
          : '<option>No space available</option>';
        unitInput.disabled = $('[data-rack-add]').disabled = !available.length;
      }
      $('.wifi-rack-patching').hidden = mode !== 'cable';
      $('[data-rack-cancel-cable]').disabled = !source;
      for (const button of body.querySelectorAll('[data-rack-mode]')) {
        button.setAttribute('aria-pressed', String(button.dataset.rackMode === mode));
      }
      $('[data-rack-settings]').setAttribute('aria-pressed', String(device?.id === rackId));
      $('[data-rack-summary]').innerHTML = `<h3>Rack power</h3><p>${sheet.power.watts} W load · ${sheet.power.units} UPS${sheet.power.units === 1 ? '' : ' units'}</p>
        ${sheet.power.overloaded ? '<p class="wifi-poe-warning">UPS load exceeds output capacity.</p>' :
          sheet.power.units && sheet.power.watts ? `<p>Estimated runtime ${sheet.power.minutes} min</p>` : ''}`;
      const rear = sheet.devices.flatMap(item => item.ports.filter(port => port.destination)
        .map(port => `<li><strong>${escape(item.name)} · ${escape(port.id.slice(5))}</strong><span>${escape(port.destination)}</span></li>`)).join('');
      $('[data-rack-terminations]').innerHTML = `<h3>Rear terminations</h3>${rear ? `<ul class="wifi-rack-list">${rear}</ul>` : '<p>No building runs connected.</p>'}`;
      const patches = sheet.patches.map(wire => `<li><span><i style="--cord:${escape(wire.color)}"></i>${escape(data.endName(wire.source))}
        ↔ ${escape(data.endName(wire.target))}</span><button class="wifi-control" type="button" data-rack-remove-cable="${escape(wire.id)}">Disconnect</button></li>`).join('');
      $('[data-rack-patches]').innerHTML = `<h3>Patch cables</h3>${patches ? `<ul class="wifi-rack-list">${patches}</ul>` : '<p>No patch cables connected.</p>'}`;
      const { rackPort, rackDevice } = document.activeElement?.dataset ?? {};
      const { scrollTop, scrollLeft } = view;
      tooltip.hidden = true;
      view.innerHTML = renderFace(sheet, catalog.rack_units);
      view.scrollTop = scrollTop;
      view.scrollLeft = scrollLeft;
      const focus = rackPort ? `[data-rack-port="${CSS.escape(rackPort)}"]` : rackDevice ? `[data-rack-device="${CSS.escape(rackDevice)}"]` : '';
      if (focus) view.querySelector(focus)?.focus({ preventScroll: true });
      updateZoom();
      announce(message);
    }

    function unitOptions(units, size) {
      return units.map(u => [u, size === 1 ? `U${u}` : `U${u}–U${u + size - 1}`]);
    }

    function updateZoom() {
      view.style.setProperty('--rack-zoom', zoom);
      $('[data-rack-scale]').textContent = `${Math.round(zoom * 100)}%`;
      $('[data-rack-zoom="out"]').disabled = zoom <= .3;
      $('[data-rack-zoom="in"]').disabled = zoom >= 2.5;
    }

    function changeZoom(action) {
      const svg = view.querySelector('svg');
      const previous = svg.getBoundingClientRect().width;
      const edge = view.clientWidth / 2;
      const middle = view.clientHeight / 2;
      const ratio = action === 'fit' ? Math.min(1, zoom * view.clientWidth / previous) : zoom * (action === 'in' ? 1.25 : .8);
      const anchorX = view.scrollLeft + edge;
      const anchorY = view.scrollTop + middle;
      zoom = Math.max(.3, Math.min(2.5, ratio));
      updateZoom();
      const factor = svg.getBoundingClientRect().width / previous;
      view.scrollLeft = anchorX * factor - edge;
      view.scrollTop = anchorY * factor - middle;
      tooltip.hidden = true;
    }

    function select(id, nextMode = 'inspect') {
      selected = id;
      mode = nextMode;
      source = null;
      details.scrollTop = 0;
      message = '';
      refresh();
      ctx.renderInspector();
    }

    function patchPort(value) {
      const [device_id, port] = value.split(':');
      const next = { device_id, port };
      const data = ctx.data();
      if (source && endKey(next) === endKey(source)) {
        source = null;
      } else if (!data.availablePorts(device_id, media.value, source?.device_id).some(profile => profile.id === port && !profile.wan)) {
        message = 'Choose an unused front port on a different device for the selected medium.';
      } else if (!source) {
        source = next;
      } else {
        const cable = { id: ctx.id('wire'), media: media.value, color: cableModel.COLORS[media.value], label: '', waypoints: [],
          rack_patch: true, source, target: next };
        const error = data.checkCable(cable).error;
        if (error) message = error;
        else if (ctx.add('cables', [cable])) {
          source = null;
          message = 'Patch cable connected.';
        }
      }
      refresh();
    }

    function moveDevice(id, unit) {
      const data = ctx.data();
      const device = data.devices.get(id);
      if (!device || unit === device.rack_u) { announce(); return; }
      if (!data.availableUnits(rackId, device.kind, id).includes(unit)) {
        announce('Choose an open mounting position that fits this device.');
        return;
      }
      selected = id;
      if (ctx.replace('equipment', { ...device, rack_u: unit })) announce(`${data.name(device)} moved to U${unit}.`);
    }

    body.addEventListener('click', event => {
      const control = event.target.closest('button, [data-rack-port], [data-rack-device]');
      if (!control) return;
      const { rackMode, rackDevice, rackPort, rackZoom, rackRemoveCable } = control.dataset;
      if (rackMode) {
        select(selected, rackMode);
      } else if (control.hasAttribute('data-rack-settings')) {
        select(rackId);
      } else if (control.hasAttribute('data-rack-overview')) {
        select(null);
        focusTools();
      } else if (rackZoom) {
        changeZoom(rackZoom);
      } else if (control.hasAttribute('data-rack-cancel-cable')) {
        source = null;
        message = '';
        refresh();
      } else if (control.hasAttribute('data-rack-add')) {
        const data = ctx.data();
        const rack = data.devices.get(rackId);
        const unit = Number(unitInput.value);
        if (!data.availableUnits(rackId, kindInput.value).includes(unit)) return;
        const equipment = { id: ctx.id('device'), kind: kindInput.value, name: '', rack_id: rackId, rack_u: unit, x: rack.x, y: rack.y };
        if (ctx.add('equipment', [equipment])) {
          select(equipment.id);
          $('[data-rack-move]').focus({ preventScroll: true });
          announce('Equipment installed.');
        }
      } else if (rackRemoveCable) {
        if (ctx.removeCable(rackRemoveCable)) {
          focusTools();
          announce('Patch cable disconnected.');
        }
      } else if (mode === 'cable' && rackPort) {
        message = '';
        patchPort(rackPort);
      } else if (mode === 'inspect') {
        const gear = rackDevice || control.closest('[data-rack-device]')?.dataset.rackDevice;
        if (gear) select(gear);
      }
    });

    body.addEventListener('change', event => {
      const input = event.target;
      if (input === kindInput || input === media) {
        source = null;
        message = '';
        refresh();
      } else if (input.hasAttribute('data-rack-move')) {
        moveDevice(selected, Number(input.value));
      }
    });

    view.addEventListener('keydown', event => {
      if (['Enter', ' '].includes(event.key) && event.target.matches('svg [tabindex]')) {
        event.preventDefault();
        event.target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }
    });

    function showTooltip(port) {
      if (!port || drag?.moved) return;
      tooltip.textContent = port.dataset.rackTooltip;
      tooltip.hidden = false;
      const boundary = tooltip.parentElement.getBoundingClientRect();
      const target = port.getBoundingClientRect();
      const left = target.left + target.width / 2 - boundary.left - tooltip.offsetWidth / 2;
      tooltip.style.left = `${Math.max(4, Math.min(left, boundary.width - tooltip.offsetWidth - 4))}px`;
      const above = target.top - boundary.top - tooltip.offsetHeight - 6;
      tooltip.style.top = `${above >= 4 ? above : target.bottom - boundary.top + 6}px`;
    }

    view.addEventListener('pointerover', event => showTooltip(event.target.closest('[data-rack-port]')));
    view.addEventListener('pointerout', event => {
      const port = event.target.closest('[data-rack-port]');
      if (port && !port.contains(event.relatedTarget)) tooltip.hidden = true;
    });
    view.addEventListener('focusin', event => showTooltip(event.target.closest('[data-rack-port]')));
    view.addEventListener('focusout', () => { tooltip.hidden = true; });
    view.addEventListener('scroll', () => { tooltip.hidden = true; }, { passive: true });

    function rackY(svg, x, y) {
      return new DOMPoint(x, y).matrixTransform(svg.getScreenCTM().inverse()).y;
    }

    function updateDrop() {
      const { svg, unit, size, units, startY, x, y, available } = drag;
      const rect = view.getBoundingClientRect();
      const drop = svg.querySelector('.wifi-rack-drop');
      const next = unit - Math.round((rackY(svg, x, y) - startY) / face.unit);
      const inside = x >= rect.left && x < rect.left + view.clientWidth && y >= rect.top && y < rect.top + view.clientHeight;
      drag.valid = inside && available.includes(next);
      drag.next = next;
      const withinSlots = inside && next >= 1 && next + size - 1 <= units;
      drop.setAttribute('visibility', withinSlots ? 'visible' : 'hidden');
      drop.setAttribute('y', slotY(units, { u: next }, size) + 2);
      drop.setAttribute('height', size * face.unit - 4);
      drop.classList.toggle('is-valid', drag.valid);
      announce(drag.valid ? `Release to mount at U${next}.` : 'Drag to an open mounting position.');
    }

    function scrollDuringDrag() {
      const rect = view.getBoundingClientRect();
      if (drag.x >= rect.left && drag.x < rect.left + view.clientWidth && drag.y >= rect.top && drag.y < rect.top + view.clientHeight) {
        const y = drag.y - rect.top;
        const distance = y < 28 ? y - 28 : y > view.clientHeight - 28 ? y - view.clientHeight + 28 : 0;
        const before = view.scrollTop;
        view.scrollTop += Math.sign(distance) * Math.ceil(Math.abs(distance) / 3);
        if (before !== view.scrollTop) updateDrop();
      }
      dragFrame = requestAnimationFrame(scrollDuringDrag);
    }

    function finishDrag() {
      const previous = drag;
      if (!previous) return;
      drag = null;
      cancelAnimationFrame(dragFrame);
      if (view.hasPointerCapture(previous.pointer)) view.releasePointerCapture(previous.pointer);
      view.removeAttribute('data-dragging');
      previous.svg.querySelector('.wifi-rack-drop').setAttribute('visibility', 'hidden');
      announce();
    }

    view.addEventListener('pointerdown', event => {
      if (mode !== 'inspect' || drag || !event.isPrimary || event.button !== 0 || event.target.closest('[data-rack-port]')) return;
      const gear = event.target.closest('[data-rack-device]');
      if (!gear) return;
      const data = ctx.data(), catalog = ctx.catalog();
      const id = gear.dataset.rackDevice;
      const device = data.devices.get(id);
      const svg = gear.ownerSVGElement;
      drag = { id, svg, startX: event.clientX, startClientY: event.clientY, pointer: event.pointerId,
        startY: rackY(svg, event.clientX, event.clientY), unit: device.rack_u, size: catalog.equipment[device.kind].rack_units,
        units: catalog.rack_units, available: data.availableUnits(rackId, device.kind, id) };
    });

    view.addEventListener('pointermove', event => {
      if (event.pointerId !== drag?.pointer) return;
      drag.x = event.clientX;
      drag.y = event.clientY;
      if (!drag.moved) {
        if (Math.hypot(drag.x - drag.startX, drag.y - drag.startClientY) < 5) return;
        drag.moved = true;
        view.setPointerCapture(event.pointerId);
        view.setAttribute('data-dragging', '');
        tooltip.hidden = true;
        dragFrame = requestAnimationFrame(scrollDuringDrag);
      }
      updateDrop();
    });

    view.addEventListener('pointerup', event => {
      if (event.pointerId !== drag?.pointer) return;
      const { id, next, moved, valid } = drag;
      finishDrag();
      if (moved && valid) moveDevice(id, next);
      else if (moved) announce('Choose an open mounting position that fits this device.');
    });

    for (const type of ['pointercancel', 'lostpointercapture', 'pointerleave']) {
      view.addEventListener(type, event => {
        if (event.pointerId === drag?.pointer && (type !== 'pointerleave' || !drag.moved)) finishDrag();
      });
    }

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

    return { open, reset, refresh, isOpen, inspectedId, focusTools, announce, inspectMaterials, exportData };
  }

  root.WifiSiteRacks = { create, rackData, quantities, materialRows };
}(typeof window === 'object' ? window : globalThis));
