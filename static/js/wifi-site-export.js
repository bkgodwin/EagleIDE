/* Offscreen, grid-free artwork and label data for the three printed sheets. */
(function () {
  'use strict';

  function layout(bounds, outlines) {
    const box = { ...(bounds || { left: 0, top: 0, right: 24, bottom: 16 }) };
    for (const points of outlines.values()) for (const { x, y } of points) {
      box.left = Math.min(box.left, x);
      box.right = Math.max(box.right, x);
      box.top = Math.min(box.top, y);
      box.bottom = Math.max(box.bottom, y);
    }
    const span = Math.max(6, box.right - box.left, box.bottom - box.top);
    const padding = span * .028;
    const worldWidth = Math.max(span / 8, box.right - box.left) + 2 * padding;
    const worldHeight = Math.max(span / 8, box.bottom - box.top) + 2 * padding;
    const scale = Math.min(1500 / Math.max(worldWidth, worldHeight), 100);
    const width = Math.ceil(worldWidth * scale), height = Math.ceil(worldHeight * scale);
    return { width, height, scale, x: (box.left + box.right - width / scale) / 2,
      y: (box.top + box.bottom - height / scale) / 2 };
  }

  function cleanLayer(group) {
    const copy = group.cloneNode(true);
    copy.querySelectorAll('title, .wifi-selected-wall, .wifi-wall-hit, .wifi-opening-hit, .wifi-decor-hit')
      .forEach(node => node.remove());
    copy.querySelectorAll('.is-selected, .wifi-moving-source').forEach(node =>
      node.classList.remove('is-selected', 'wifi-moving-source'));
    return new XMLSerializer().serializeToString(copy);
  }

  function svgImage(frame, content, styles, ratio) {
    const { width, height, x, y, scale } = frame;
    const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="${width * ratio}" height="${height * ratio}"
      viewBox="${x} ${y} ${width / scale} ${height / scale}">
      <style><![CDATA[${styles}
        .wifi-wall { stroke-width: ${1.4 * ratio}; }
        .wifi-wall-reinforced_concrete { stroke-width: ${2.8 * ratio}; }
        .wifi-opening-gap { stroke-width: ${2.8 * ratio}; }
        .wifi-window-rail, .wifi-door-leaf { stroke-width: ${1.1 * ratio}; }
      ]]></style>${content}</svg>`;
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }));
      const image = new Image();
      image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not render the floor plan.')); };
      image.src = url;
    });
  }

  function drawCoverage(frame, plan, signal) {
    if (!plan.radios.length) return Promise.resolve(null);
    signal?.throwIfAborted();
    const canvas = document.createElement('canvas');
    return new Promise((resolve, reject) => {
      let finished = false;
      const painter = window.WifiSiteHeatmap.create(canvas, updating => {
        if (updating || finished) return;
        const copy = document.createElement('canvas');
        copy.width = canvas.width;
        copy.height = canvas.height;
        copy.getContext('2d').drawImage(canvas, 0, 0);
        finish();
        resolve(copy);
      });
      const timeout = setTimeout(() => {
        finish();
        reject(new Error('Wi-Fi coverage took too long to render for export.'));
      }, 30000);
      const abort = () => { finish(); reject(signal.reason); };
      signal?.addEventListener('abort', abort, { once: true });
      function finish() {
        finished = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        painter.clear();
      }
      painter.setPlan(plan);
      painter.setView(frame, frame.width, frame.height, true);
    });
  }

  function annotations(frame, plan, cabling, network, cameraOutlines, serviceNames) {
    const clientModel = window.WifiSiteClientModel;
    const point = item => [item.x, item.y].map((coordinate, i) => Number(
      ((coordinate - (i ? frame.y : frame.x)) * frame.scale / (i ? frame.height : frame.width)).toFixed(7)));
    const ssidById = new Map(plan.ssids.map(ssid => [ssid.id, ssid]));
    const hosted = new Map();
    for (const vm of network.services.values()) {
      const lease = network.clients.get(vm.id)?.lease;
      const address = lease ? clientModel.address(lease.ip) : vm.ip ? `${vm.ip} (offline)` : 'IPv4 unassigned';
      const lines = hosted.get(vm.hostId) ?? [];
      lines.push(`${serviceNames?.[vm.kind] ?? vm.kind} · ${address} · VLAN ${vm.vlan}`);
      hosted.set(vm.hostId, lines);
    }
    const cameraData = item => ({ cone: (cameraOutlines.get(item.id) || []).map(point),
      powered: cabling.poweredDevices.has(item.id) });
    const details = item => {
      const client = network.clients.get(item.id);
      if (!client) return [];
      const lease = client.lease;
      const pool = lease && network.routers.get(lease.router).pool;
      const info = [lease ? `IP ${clientModel.address(lease.ip)}/${pool.prefix}` : 'IP unassigned',
        pool ? `Subnet ${clientModel.address(pool.first)}/${pool.prefix}` : 'Subnet unassigned'];
      if (item.kind === 'phone') {
        const ssid = item.ssid_id ? ssidById.get(item.ssid_id) : plan.ssids[0];
        info.push(ssid ? `SSID ${ssid.name}${client.ap ? '' : ' (not associated)'}` : 'SSID unassigned');
      }
      return info;
    };
    const notes = plan.labels.map(note => ({ point: point(note), name: note.text }));
    const equipment = plan.equipment.map(item => ({ point: point(cabling.location(item)),
      name: cabling.name(item), kind: item.kind, details: details(item), mounted: Boolean(item.rack_id),
      ...(item.kind === 'rack' ? { rack_id: item.id } : {}),
      ...(hosted.has(item.id) ? { services: hosted.get(item.id) } : {}),
      ...(item.kind === 'poe_camera' ? cameraData(item) : {}) }));
    const passes = plan.pass_throughs.map(item => ({ point: point(cabling.location(item)),
      name: 'Concrete pass-through', kind: 'pass_through', details: [] }));
    const aps = plan.access_points.map(ap => {
      const ssids = clientModel.apSsids(ap, plan.ssids).map(id => ssidById.get(id)).filter(Boolean);
      const powered = cabling.poweredAps.has(ap.id);
      return { point: point(ap), name: ap.name || (ap.mount === 'wall' ? 'Wall-mounted AP' : 'Ceiling-mounted AP'),
        kind: 'access_point', radio_plan: ['2.4', '5'].map(band => {
          const radio = ap.radios[band];
          return `${band} GHz ch ${radio.channel} / ${radio.width} MHz`;
        }).join(' · '), details: powered ? ssids.map(ssid => `${ssid.name} (${ssid.band === 'both' ? '2.4 / 5' : ssid.band} GHz)`) : [], powered };
    });
    const cables = plan.cables.filter(cable => !cable.rack_patch).map(cable => {
      const route = cabling.inspections.get(cable.id);
      return { name: cable.label, media: cable.media, color: cable.color,
        source: cabling.endName(cable.source), target: cabling.endName(cable.target), points: route.points.map(point),
        length: Number(window.WifiSiteModel.displayDistance(route.length, plan.units).toFixed(1)) };
    });
    return { notes, equipment: [...equipment, ...passes], aps, cables };
  }

  function rasterRatio(width, height) {
    return Math.min(2, 2400 / Math.max(width, height), Math.sqrt(4_950_000 / (width * height)));
  }

  async function render({ bounds, plan, cabling, network, cameraOutlines, background, surfaces, decor, structure, signal, serviceNames }) {
    const frame = layout(bounds, cameraOutlines);
    const data = annotations(frame, plan, cabling, network, cameraOutlines, serviceNames);
    const radioAps = plan.access_points.filter(ap => cabling.poweredAps.has(ap.id));
    const radios = ['2.4', '5'].map(band => ({ band,
      access_points: window.WifiSiteClientModel.coverageAps(radioAps, plan.ssids, band) }))
      .filter(layer => layer.access_points.length);
    const ratio = rasterRatio(frame.width, frame.height);
    const styles = Array.from(document.styleSheets).filter(sheet => sheet.href?.includes('/features/wifi-site.css'))
      .flatMap(sheet => Array.from(sheet.cssRules).map(rule => rule.cssText)).join('\n');
    const base = (background?.hasAttribute('href') ? `<g opacity=".58">${cleanLayer(background)}</g>` : '')
      + Array.from(surfaces.children).map(cleanLayer).join('') + cleanLayer(decor);
    const [under, over, heat] = await Promise.all([
      svgImage(frame, base, styles, ratio), svgImage(frame, structure.map(cleanLayer).join(''), styles, ratio),
      drawCoverage(frame, { walls: plan.walls, openings: plan.openings, decor: plan.decor, radios }, signal),
    ]);
    signal?.throwIfAborted();
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(frame.width * ratio);
    canvas.height = Math.ceil(frame.height * ratio);
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    const draw = coverage => {
      ctx.fillStyle = plan.background_color || '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(under, 0, 0, width, height);
      if (coverage) {
        ctx.globalAlpha = .78;
        ctx.drawImage(coverage, 0, 0, width, height);
        ctx.globalAlpha = 1;
      }
      ctx.drawImage(over, 0, 0, width, height);
      const encode = quality => canvas.toDataURL('image/jpeg', quality).split(',')[1];
      let image = encode(.95);
      if (image.length > 2_400_000) image = encode(.82);
      if (image.length > 2_400_000) image = encode(.66);
      if (image.length > 2_400_000) image = encode(.48);
      return image;
    };
    return { ...data, image: draw(null), coverage_image: heat ? draw(heat) : null,
      drawing_width: frame.width / frame.scale, units: plan.units };
  }

  window.WifiSiteExport = { render };
})();
