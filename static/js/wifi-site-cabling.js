/* Equipment placement, cable drafting, and wire selection in the floor plan. */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const model = window.WifiCablingModel;
  const KINDS = ['equipment', 'pass_throughs', 'cables'];
  const ICONS = {
    router: '<rect x="2.5" y="9" width="19" height="10" rx="2"/><path d="M7 9V4m10 5V4M6 14h1m3 0h1m3 0h4"/>',
    core_switch: '<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M6 9h2m3 0h2m3 0h2M6 14h2m3 0h2m3 0h2"/>',
    distribution_switch: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 12h2m3 0h2m3 0h2m-6-6v2"/>',
    access_switch: '<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 12h2m3 0h2m3 0h1"/>',
    keystone: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 9h8v5h-2v2h-4v-2H8z"/>',
    demarc: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18m0-18a14 14 0 0 0 0 18"/>',
    cable: '<path d="M5 4v4m4-4v4M4 8h6v4a3 3 0 0 1-6 0zm3 7v2a4 4 0 1 0 8 0v-3m-3 0h6v-4a3 3 0 1 0-6 0zm1-7V4m4 3V4"/>',
    pass: '<path d="M3 4h18v16H3zM3 9h5m8 0h5M3 15h5m8 0h5"/><circle cx="12" cy="12" r="3"/>',
  };
  const icon = type => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${ICONS[type]}</svg>`;

  function create(ctx) {
    let draft, hover, routeError;
    let cached, sourceArrays, renderedIndex, renderedSelection, renderedVisibility;
    let segments = [];
    let mode = 'select';
    const catalog = () => ctx.catalog();
    const plan = () => ctx.getPlan();
    const limit = () => ctx.limits();
    const e = value => ctx.escape(value);
    const menu = $('wifiCableBundleMenu');

    function index(layout = plan()) {
      const arrays = [layout.walls, layout.access_points, ...KINDS.map(kind => layout[kind])];
      if (!sourceArrays || arrays.some((array, i) => array !== sourceArrays[i])) {
        cached = model.build(layout, catalog(), limit(), ctx.apNames);
        sourceArrays = arrays;
      }
      return cached;
    }

    function choices(entries, value, blank = '') {
      const options = blank ? `<option value="">${e(blank)}</option>` : '';
      return options + entries.map(([key, label]) => `<option value="${e(key)}"${value === key ? ' selected' : ''}>${e(label)}</option>`).join('');
    }

    function ispChoices(value) {
      return choices(Object.entries(catalog().isps).map(([key, isp]) =>
        [key, `${isp.name} · ${model.speedName(isp.speed)} ${model.mediaName(isp.media)}`]), value);
    }

    function equipmentSpecs(kind) {
      if (kind === 'demarc') {
        const isp = catalog().isps[$('wifiEquipmentIsp').value];
        return isp ? `${model.speedName(isp.speed)} ${model.mediaName(isp.media)} to the router WAN` : '';
      }
      if (kind === 'keystone') return 'Wall mount · rear termination and front patch port';
      return catalog().equipment[kind].groups.map(group => {
        const role = group.wan ? ' WAN' : kind === 'router' ? ' LAN' : '';
        return `${group.count} × ${model.speedName(group.speed)} ${model.mediaName(group.media)}${role}${group.poe ? ' with PoE' : ''}`;
      }).join(' · ');
    }

    function equipmentControls() {
      const kind = $('wifiEquipmentType').value;
      $('wifiEquipmentIcon').innerHTML = icon(kind);
      $('wifiEquipmentIspField').hidden = kind !== 'demarc';
      $('wifiEquipmentSpecs').textContent = equipmentSpecs(kind);
    }

    function reset() {
      draft = hover = routeError = null;
      menu.hidden = true;
      sourceArrays = cached = renderedIndex = null;
      segments = [];
    }

    function setTool(tool) {
      if (tool !== mode) draft = hover = routeError = null;
      mode = tool;
      menu.hidden = true;
      $('wifiEquipmentControls').hidden = mode !== 'equipment';
      $('wifiCableControls').hidden = mode !== 'cable';
      if (mode === 'equipment') equipmentControls();
      if (mode === 'cable') {
        $('wifiShowCables').checked = true;
        ctx.draw();
        refreshDraft();
      }
    }

    function place(raw) {
      const kind = $('wifiEquipmentType').value;
      const data = catalog().equipment[kind];
      const penetration = mode === 'pass';
      if (penetration || data.wall_mount) {
        const anchor = model.closestWall(raw, plan().walls, Math.min(3, 19 / ctx.scale()), penetration);
        if (!anchor) {
          ctx.hint(penetration ? 'Choose a point on a concrete wall.' : 'Choose a point on a wall.');
          return;
        }
        const { wall_id, t } = anchor;
        if (penetration) {
          if (ctx.add('pass_throughs', [{ id: ctx.id('pass'), wall_id, t }])) ctx.hint('Pass-through added · capacity 10 cables.');
          return;
        }
        const item = { id: ctx.id('device'), kind, name: '', wall_id, t };
        if (kind === 'demarc') item.isp = $('wifiEquipmentIsp').value;
        if (ctx.add('equipment', [item])) ctx.hint(`${data.name} placed. Use Cable to connect its ports.`);
        return;
      }
      const count = plan().equipment.filter(item => item.kind === kind).length + 1;
      if (ctx.add('equipment', [{ id: ctx.id('device'), kind, name: `${data.name} ${count}`, ...ctx.snap(raw).point }])) {
        ctx.hint(`${data.name} placed. Use Cable to connect its ports.`);
      }
    }

    function beginDraft() {
      draft ||= { id: ctx.id('wire'), media: $('wifiCableMedia').value, label: '', color: model.COLORS[$('wifiCableMedia').value], waypoints: [] };
      return draft;
    }

    function chooseDevice(role, id) {
      const current = beginDraft();
      const other = role === 'source' ? 'target' : 'source';
      if (!id) {
        delete current[role];
        if (role === 'source') { delete current.target; current.waypoints = []; }
      } else {
        const data = index();
        const available = data.availablePorts(id, current.media, current[other]?.device_id, current.id);
        if (!available.length) {
          ctx.hint(`No compatible, free ${model.mediaName(current.media)} ports on ${data.name(data.devices.get(id))} for this connection.`);
          return;
        }
        current[role] = { device_id: id, port: available[0].id };
      }
      refreshDraft();
    }

    function refreshDraft() {
      if (!plan() || mode !== 'cable') return;
      const data = index();
      const media = draft?.media || $('wifiCableMedia').value;
      const updating = [['source', 'From', 'target'], ['target', 'To', 'source']];
      for (const [role, prefix, other] of updating) {
        const opposite = draft?.[other]?.device_id;
        const entries = [...data.devices].filter(([id]) => data.availablePorts(id, media, opposite, draft?.id).length)
          .map(([id, device]) => [id, data.name(device)]);
        const picker = $(`wifiCable${prefix}Device`);
        picker.innerHTML = choices(entries, draft?.[role]?.device_id, role === 'source' ? 'Choose device' : 'Choose destination');
        const portPicker = $(`wifiCable${prefix}Port`);
        const available = data.availablePorts(draft?.[role]?.device_id, media, opposite, draft?.id);
        if (draft?.[role] && available.length && !available.some(port => port.id === draft[role].port)) draft[role].port = available[0].id;
        portPicker.innerHTML = choices(available.map(port => [port.id, port.wan ? `${port.id} (WAN)` : port.id]), draft?.[role]?.port, available.length ? '' : '—');
        picker.disabled = role === 'target' && !draft?.source;
        portPicker.disabled = !available.length;
      }
      $('wifiCableMedia').disabled = !!draft?.editing;
      $('wifiCableUndoBend').disabled = !draft?.waypoints.length;
      const ready = draft?.source && draft?.target;
      routeError = ready ? data.checkCable(draft) : null;
      const atLimit = !draft?.editing && plan().cables.length >= limit().cables;
      $('wifiCableConnect').disabled = !ready || !!routeError.error || atLimit;
      if (routeError?.error) ctx.hint(routeError.error);
      else if (atLimit) ctx.hint(`This site can contain up to ${limit().cables} cables.`);
      else if (ready) ctx.hint(`${model.speedName(routeError.speed)} ${model.mediaName(media)} · ${ctx.fmt(routeError.length)} · Select Connect to finish.`);
      else if (draft?.source) ctx.hint('Click the floor to add bends, a pass-through to cross concrete, or a device to end the route. Hold Shift for right angles.');
      else ctx.hint('Select a source device on the plan or in the From menu.');
      ctx.frame();
    }

    function nearbyPass(raw) {
      const data = index();
      let best;
      let gap = Math.min(2, 12 / ctx.scale());
      for (const pass of data.passages.values()) {
        const nextGap = model.distance(raw, data.location(pass));
        if (nextGap <= gap) { gap = nextGap; best = pass; }
      }
      return best;
    }

    function closestDevice(raw) {
      const data = index();
      let best;
      let gap = Math.min(3, 15 / ctx.scale());
      for (const [id, device] of data.devices) {
        const nextGap = model.distance(raw, data.location(device));
        if (nextGap <= gap) { gap = nextGap; best = id; }
      }
      return best;
    }

    function draftWaypoint(raw, shift) {
      const pass = nearbyPass(raw);
      if (pass) return { pass_id: pass.id };
      const data = index();
      const origin = draft.waypoints.length ? data.waypoint(draft.waypoints.at(-1)) : data.location(data.devices.get(draft.source.device_id));
      return ctx.snap(raw, { origin, rightAngles: shift || $('wifiOrthogonal').checked }).point;
    }

    function use(raw, hit, shift) {
      if (mode !== 'cable') { place(raw); return; }
      const data = index();
      const device = data.devices.has(hit) ? hit : !hit ? closestDevice(raw) : null;
      if (device) {
        if (device === draft?.source?.device_id) { ctx.hint('Choose a different destination device.'); return; }
        chooseDevice(draft?.source ? 'target' : 'source', device);
        return;
      }
      if (!draft?.source) return;
      if (draft.waypoints.length >= limit().bends) { ctx.hint(`A cable supports up to ${limit().bends} bends.`); return; }
      const bend = data.passages.has(hit) ? { pass_id: hit } : draftWaypoint(raw, shift);
      const previous = draft.waypoints.length ? data.waypoint(draft.waypoints.at(-1)) : data.location(data.devices.get(draft.source.device_id));
      if (model.distance(data.waypoint(bend), previous) <= catalog().epsilon) return;
      draft.waypoints.push(bend);
      hover = null;
      refreshDraft();
    }

    function finish() {
      if (!draft?.source || !draft?.target || index().checkCable(draft).error) return;
      const { editing, ...cable } = draft;
      const saved = editing ? ctx.replace('cables', cable) : ctx.add('cables', [cable]);
      if (!saved) return;
      ctx.changeTool('select');
      ctx.select(cable.id);
      ctx.hint('Cable connected. Select a bend to drag it or use Reroute in the inspector.');
    }

    function reroute(cable) {
      ctx.changeTool('cable');
      draft = { ...cable, waypoints: [], editing: true };
      $('wifiCableMedia').value = cable.media;
      refreshDraft();
      if (!routeError?.error) ctx.hint('Add new bends, then select Connect to replace the route.');
    }

    function cancel() {
      if (!draft && menu.hidden) return false;
      draft = hover = routeError = null;
      menu.hidden = true;
      refreshDraft();
      ctx.frame();
      return true;
    }

    function pointForEdit(item, raw) {
      const wall = index().walls.get(item.wall_id);
      const anchor = model.closestWall(raw, [wall], Infinity);
      return { ...item, t: anchor.t };
    }

    function moveBend(cable, number, raw, shift) {
      const pass = nearbyPass(raw);
      const bend = pass ? { pass_id: pass.id } : ctx.snap(raw, { origin: index().route(cable)[number], rightAngles: shift }).point;
      return { ...cable, waypoints: cable.waypoints.map((item, i) => i === number ? bend : item) };
    }

    function name(kind, item, number) {
      if (kind === 'equipment') return index().name(item);
      if (kind === 'pass_throughs') return `Pass-through ${number + 1}`;
      return model.cableName(item, number);
    }

    function locationPoints(match) {
      const data = index();
      return match.kind === 'cables' ? data.route(match.item) : [data.location(match.item)];
    }

    function drawEquipment(item, kind, ghost = false) {
      const point = index().location(item);
      if (!point) return '';
      const pass = kind === 'pass_throughs';
      const type = pass ? 'pass' : item.kind;
      const selected = item.id === ctx.selected() ? ' is-selected' : '';
      const object = ghost ? 'class="wifi-ghost"' : `data-wifi-object="${e(item.id)}"`;
      let title = pass ? `Concrete pass-through · ${index().usage.get(item.id) || 0}/10 cables` : index().name(item);
      if (item.kind === 'demarc' && item.name) title = `${item.name} · ${catalog().isps[item.isp].name}`;
      const label = title.length > 38 ? `${title.slice(0, 37)}…` : title;
      return `<g transform="translate(${point.x} ${point.y})" ${object}><g class="wifi-marker wifi-gear wifi-gear-${type}${selected}">
        <title>${e(title)}</title><rect class="wifi-gear-body" x="${pass ? -9 : -14}" y="${pass ? -9 : -12}" width="${pass ? 18 : 28}" height="${pass ? 18 : 24}" rx="${pass ? 3 : 5}"/>
        <g class="wifi-gear-icon" transform="translate(${pass ? -7 : -10} ${pass ? -7 : -10}) scale(${pass ? 0.58 : 0.83})">${ICONS[type]}</g>
        ${pass ? '' : `<text class="wifi-equipment-text" x="17" y="-7">${e(label)}</text>`}
        </g></g>`;
    }

    function badge(point, text, cls) {
      return `<g transform="translate(${point.x} ${point.y})" class="wifi-wire-badge"><g class="wifi-marker"><text class="${cls}" text-anchor="middle" dy="-6">${e(text)}</text></g></g>`;
    }

    function draw() {
      const data = index();
      const visible = $('wifiShowCables').checked;
      const selected = ctx.selected();
      if (data !== renderedIndex) segments = model.bundledSegments(plan().cables, data.inspections);
      if (data === renderedIndex && selected === renderedSelection && visible === renderedVisibility) return;
      renderedIndex = data;
      renderedSelection = selected;
      renderedVisibility = visible;
      const equipment = $('wifiEquipmentLayer');
      equipment.innerHTML = plan().equipment.map(item => drawEquipment(item, 'equipment')).join('')
        + plan().pass_throughs.map(item => drawEquipment(item, 'pass_throughs')).join('');
      const wireLayer = $('wifiWireLayer');
      wireLayer.style.display = visible ? '' : 'none';
      if (!visible) return;
      const byId = new Map(plan().cables.map((cable, number) => [cable.id, { cable, number }]));
      const labeled = new Map();
      wireLayer.innerHTML = segments.map(({ a, b, cableIds }, i) => {
        const { cable, number } = byId.get(cableIds[0]);
        const bundle = cableIds.length > 1;
        const width = bundle ? 5 + Math.min(9, 2 * Math.log2(cableIds.length)) : 3;
        const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        if (!bundle && cable.label) {
          const length = model.distance(a, b);
          if (length > (labeled.get(cable.id)?.length || 0)) labeled.set(cable.id, { center, length, label: cable.label });
        }
        const fiber = cable.media === 'fiber';
        const color = bundle ? '#39556e' : cable.color;
        const colors = bundle ? [...new Set(cableIds.map(id => byId.get(id).cable.color))].slice(0, 3) : [];
        const stripe = colors.length === 1 ? ctx.line(a, b, 'class="wifi-wire wifi-wire-stripe" stroke="#dcecff" stroke-width="1.3"')
          : colors.map((color, index) => ctx.line(a, b, `class="wifi-wire" stroke="${color}" stroke-width="2.5" stroke-dasharray="6 ${6 * (colors.length - 1)}" stroke-dashoffset="${-6 * index}"`)).join('');
        return ctx.line(a, b, `class="wifi-wire wifi-wire-casing" stroke-width="${width + 2}"`)
          + ctx.line(a, b, `class="wifi-wire${fiber && !bundle ? ' wifi-wire-fiber' : ''}" stroke="${color}" stroke-width="${width}"`)
          + stripe + (bundle ? badge(center, `×${cableIds.length}`, 'wifi-bundle-count') : '')
          + ctx.line(a, b, `class="wifi-wire-hit" data-wifi-bundle="${i}" aria-label="${e(bundle ? `${cableIds.length} cables` : model.cableName(cable, number))}"`);
      }).join('') + [...labeled.values()].map(item => badge(item.center, item.label, 'wifi-wire-label')).join('');
    }

    function polyline(points, cls, color) {
      const path = points.filter(Boolean).map(point => `${point.x},${point.y}`).join(' ');
      return `<polyline points="${path}" class="${cls}"${color ? ` stroke="${color}"` : ''}/>`;
    }

    function overlay(ghost, ghostKind) {
      const data = index();
      const parts = [];
      if (draft?.source && mode === 'cable') {
        const start = data.location(data.devices.get(draft.source.device_id));
        const end = draft.target ? data.location(data.devices.get(draft.target.device_id)) : hover;
        const points = [start, ...draft.waypoints.map(data.waypoint), end];
        parts.push(polyline(points, routeError?.error ? 'wifi-wire-draft is-invalid' : 'wifi-wire-draft', draft.color));
        for (const bend of points.slice(1, -1).filter(Boolean)) parts.push(ctx.dot(bend, 3, 'wifi-cursor'));
        if (routeError?.point) parts.push(ctx.dot(routeError.point, 7, 'wifi-wire-warning'));
      } else if ($('wifiShowCables').checked) {
        const cable = ghostKind === 'cables' ? ghost : plan().cables.find(item => item.id === ctx.selected());
        if (cable) {
          const points = data.route(cable);
          parts.push(polyline(points, 'wifi-wire-selection', cable.color));
          if (cable.label) {
            let length = 0, center;
            for (let i = 1; i < points.length; i += 1) {
              const a = points[i - 1], b = points[i];
              const span = model.distance(a, b);
              if (span > length) { length = span; center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
            }
            if (center) parts.push(badge(center, cable.label, 'wifi-wire-label'));
          }
          cable.waypoints.forEach((bend, i) => parts.push(ctx.dot(data.waypoint(bend), 5, 'wifi-handle wifi-bend-handle',
            `data-wifi-object="${e(cable.id)}" data-wifi-bend="${i}"`)));
        }
      }
      if (ghost && ['equipment', 'pass_throughs'].includes(ghostKind)) parts.push(drawEquipment(ghost, ghostKind, true));
      if (hover && (mode === 'pass' || mode === 'equipment')) parts.push(ctx.dot(hover, 6, 'wifi-cursor wifi-join-point'));
      return parts.join('');
    }

    function hoverAt(raw, shift) {
      if (mode === 'cable' && draft?.source && !draft.target) hover = index().waypoint(draftWaypoint(raw, shift));
      else if (mode === 'pass' || (mode === 'equipment' && catalog().equipment[$('wifiEquipmentType').value].wall_mount)) {
        hover = model.closestWall(raw, plan().walls, Math.min(3, 19 / ctx.scale()), mode === 'pass')?.point;
      }
    }

    function pick(segment, screen) {
      const ids = segments[segment]?.cableIds || [];
      if (!ids.length) return;
      if (ids.length === 1) { menu.hidden = true; ctx.select(ids[0]); return; }
      ctx.select('');
      const cables = plan().cables;
      $('wifiCableBundleHeading').textContent = `Bundle · ${ids.length} cables`;
      $('wifiCableBundleChoice').innerHTML = choices(ids.map(id => {
        const number = cables.findIndex(cable => cable.id === id);
        const cable = cables[number];
        return [id, `${model.cableName(cable, number)} · ${index().endName(cable.source)}`];
      }), '', 'Choose a cable');
      const viewport = $('wifiViewport');
      menu.style.left = `${Math.max(6, Math.min(screen.x + 8, viewport.clientWidth - 245))}px`;
      menu.style.top = `${Math.max(6, Math.min(screen.y + 8, viewport.clientHeight - 94))}px`;
      menu.hidden = false;
      $('wifiCableBundleChoice').focus();
    }

    function inspector(kind, item) {
      const data = index();
      if (kind === 'cables') {
        const result = data.inspections.get(item.id);
        const poe = item.media === 'fiber' ? 'Fiber · no PoE' : data.powered.has(item.id) ? 'Ethernet · PoE available' : 'Ethernet · no PoE source';
        return `<div class="wifi-wire-summary"><strong>${model.speedName(result.speed)}</strong><span>${poe} · ${ctx.fmt(result.length)}</span>
          <span>${e(data.endName(item.source))} → ${e(data.endName(item.target))}</span></div>
          <div class="wifi-two-fields"><label>Cable label<input data-wifi-wire-field="label" maxlength="80" value="${e(item.label)}" placeholder="Optional"></label>
          <label>Color<input type="color" data-wifi-wire-field="color" value="${e(item.color)}"></label></div>
          <div class="wifi-object-actions"><button class="wifi-control" id="wifiRerouteCable" type="button">Reroute</button>
          <button class="wifi-control" id="wifiRemoveCableBend" type="button"${item.waypoints.length ? '' : ' disabled'}>Remove Last Bend</button></div>`;
      }
      if (kind === 'pass_throughs') {
        const used = data.usage.get(item.id) || 0;
        return `<div class="wifi-wire-summary"><strong>Concrete pass-through</strong><span>${used} of 10 cables · 20 ft minimum spacing</span><progress value="${used}" max="10" aria-label="Pass-through capacity"></progress></div>
          ${wallField(item)}`;
      }
      const ports = data.ports.get(item.id);
      const used = ports.filter(port => data.occupancy.has(model.portKey({ device_id: item.id, port: port.id })));
      const isp = item.kind === 'demarc' ? catalog().isps[item.isp] : null;
      return `<div class="wifi-wire-summary"><strong>${e(catalog().equipment[item.kind].name)}</strong>
        <span>${used.length} of ${ports.length} ports in use${item.kind === 'access_switch' ? ' · data only' : ''}</span>
        ${used.length ? `<span class="wifi-ports-used">${used.map(port => e(port.id)).join(', ')}</span>` : ''}</div>
        <label>Equipment label<input data-wifi-wire-field="name" maxlength="60" value="${e(item.name)}" placeholder="Optional"></label>
        ${isp ? `<label>Provider<select data-wifi-wire-field="isp">${ispChoices(item.isp)}</select></label>
          <p>${e(isp.name)} · ${model.speedName(isp.speed)} ${model.mediaName(isp.media)}</p>` : ''}
        ${item.wall_id ? wallField(item) : ctx.pointFields(item)}`;
    }

    function wallField(item) {
      const length = index().walls.get(item.wall_id).length;
      return `<label>Distance from wall start (${plan().units})<input type="number" min="0" max="${ctx.display(length)}" step="any" data-wifi-wire-field="offset" value="${Number(ctx.display(length * item.t).toFixed(4))}"></label>`;
    }

    function edit(match, input) {
      const { kind, item } = match;
      const field = input.dataset.wifiWireField;
      if (!field) return;
      const next = { ...item };
      if (field === 'offset') {
        if (input.value === '') { input.value = Number(ctx.display(index().walls.get(item.wall_id).length * item.t).toFixed(4)); return; }
        const length = index().walls.get(item.wall_id).length;
        next.t = Number(Math.max(0, Math.min(1, ctx.toMeters(Number(input.value)) / length)).toFixed(10));
      } else {
        next[field] = ctx.tidy(input.value);
      }
      if (!ctx.replace(kind, next, field !== 'label' && field !== 'name')) {
        input.value = field === 'offset' ? Number(ctx.display(index().walls.get(item.wall_id).length * item.t).toFixed(4)) : item[field];
      }
    }

    function removePlan(match) {
      const { kind, item } = match;
      const current = plan();
      const next = { ...current, [kind]: current[kind].filter(object => object.id !== item.id) };
      if (kind === 'labels' || kind === 'cables') return { next };
      const devices = new Set(), passes = new Set();
      if (kind === 'access_points' || kind === 'equipment') devices.add(item.id);
      if (kind === 'pass_throughs') passes.add(item.id);
      if (kind === 'walls') {
        for (const device of current.equipment) if (device.wall_id === item.id) devices.add(device.id);
        for (const pass of current.pass_throughs) if (pass.wall_id === item.id) passes.add(pass.id);
        next.equipment = current.equipment.filter(device => !devices.has(device.id));
        next.pass_throughs = current.pass_throughs.filter(pass => !passes.has(pass.id));
      }
      const data = index();
      next.cables = current.cables.filter(cable =>
        !devices.has(cable.source.device_id) && !devices.has(cable.target.device_id) &&
        ![...data.inspections.get(cable.id).usedPasses].some(pass => passes.has(pass)));
      const attached = current.cables.length - next.cables.length + (kind === 'walls' ? devices.size + passes.size : 0);
      return { next, attached };
    }

    function init() {
      document.querySelectorAll('[data-wifi-icon]').forEach(el => { el.innerHTML = icon(el.dataset.wifiIcon); });
      $('wifiEquipmentType').innerHTML = choices(model.TYPES.map(type => [type, catalog().equipment[type].name]), 'router');
      $('wifiEquipmentIsp').innerHTML = ispChoices('alderline');
      $('wifiEquipmentType').addEventListener('change', equipmentControls);
      $('wifiEquipmentIsp').addEventListener('change', equipmentControls);
      $('wifiCableMedia').addEventListener('change', () => { draft = hover = null; refreshDraft(); });
      $('wifiShowCables').addEventListener('change', ctx.draw);
      $('wifiCableFromDevice').addEventListener('change', event => chooseDevice('source', event.target.value));
      $('wifiCableToDevice').addEventListener('change', event => chooseDevice('target', event.target.value));
      $('wifiCableFromPort').addEventListener('change', event => { draft.source.port = event.target.value; refreshDraft(); });
      $('wifiCableToPort').addEventListener('change', event => { draft.target.port = event.target.value; refreshDraft(); });
      $('wifiCableUndoBend').addEventListener('click', () => { draft.waypoints.pop(); refreshDraft(); });
      $('wifiCableCancel').addEventListener('click', () => { cancel(); ctx.changeTool('select'); });
      $('wifiCableConnect').addEventListener('click', finish);
      $('wifiCableBundleChoice').addEventListener('change', event => {
        if (event.target.value) { menu.hidden = true; ctx.select(event.target.value); $('wifiViewport').focus({ preventScroll: true }); }
      });
      $('wifiCableBundleClose').addEventListener('click', () => { menu.hidden = true; $('wifiViewport').focus({ preventScroll: true }); });
    }

    return { init, reset, index, setTool, use, cancel, draw, overlay, hoverAt, pick, name, locationPoints,
      moveBend, pointForEdit, inspector, edit, removePlan, reroute, refreshDraft,
      hideMenu: () => { menu.hidden = true; }, clearHover: () => { hover = null; } };
  }

  window.WifiSiteCabling = { create, kinds: KINDS };
})();
