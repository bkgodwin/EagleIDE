/* Client inspector and timed packet playback for Infra Sim. */
(function () {
  'use strict';

  const model = window.WifiSiteClientModel;
  const speedName = window.WifiCablingModel.speedName;
  const distance = window.WifiCablingModel.distance;
  const svgNS = 'http://www.w3.org/2000/svg';

  function stagePoints(points) {
    let length = 0;
    return points.map((point, i) => {
      if (i) length += distance(points[i - 1], point);
      return { ...point, length };
    });
  }

  function position(points, fraction) {
    const length = points.at(-1).length * fraction;
    const i = points.findIndex(point => point.length >= length);
    if (i <= 0) return points[0];
    const a = points[i - 1], b = points[i];
    const t = (length - a.length) / (b.length - a.length);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }

  function create({ plan, cabling, escape, selected }) {
    const layer = document.getElementById('wifiPingLayer');
    const preferences = new Map(), summaries = new Map(), packets = new Set();
    let graph, sources, run, timer, frame;

    function network() {
      const layout = plan(), cables = cabling();
      const next = [cables, layout.band, layout.openings, layout.decor];
      if (!sources || next.some((source, i) => source !== sources[i])) {
        graph = model.build(layout, cables, window.WifiSiteModel.coverageModel);
        sources = next;
      }
      return graph;
    }

    function stats(id) {
      const summary = summaries.get(id);
      if (!summary) return '';
      const { sent, received, total, min, max } = summary;
      const loss = sent ? Math.round(100 * (sent - received) / sent) : 0;
      const time = received ? ` · RTT ${(total / received).toFixed(1)} ms avg (${min.toFixed(1)}–${max.toFixed(1)} ms)` : '';
      return `${received} arrived · ${sent - received} dropped (${loss}%) · ${sent} sent${time}`;
    }

    function refresh() {
      const id = selected();
      const button = document.getElementById('wifiPingToggle');
      if (!button) return;
      const target = document.getElementById('wifiPingTarget');
      button.textContent = run?.id === id ? 'Stop Ping' : 'Start Ping';
      button.disabled = !target.value && run?.id !== id;
      target.disabled = run?.id === id;
      const output = document.getElementById('wifiPingStats');
      const text = run?.id === id ? '' : stats(id);
      if (output.textContent !== text) output.textContent = text;
    }

    function inspector(device) {
      const data = network();
      const { speed, upstream, signal, ap } = data.clients.get(device.id);
      const internet = upstream ? `${speedName(upstream.speed)} · ${upstream.provider}` : 'Disconnected';
      const uplink = speed ? speedName(speed) : 'Disconnected';
      const targets = [...data.devices.values()].filter(other => other.id !== device.id &&
        (model.isClient(other) || other.kind === 'router'));
      const preferred = preferences.get(device.id);
      const options = [[model.INTERNET, 'google.com'], ...targets.map(item => [item.id, cabling().name(item)])];
      const target = options.some(([id]) => id === preferred) ? preferred : model.INTERNET;
      return `<dl class="wifi-device-status"><div><dt>Uplink</dt><dd>${uplink}</dd></div>
        <div><dt>Internet</dt><dd>${escape(internet)}</dd></div>
        ${device.kind === 'phone' ? `<div><dt>Signal</dt><dd>${signal === undefined ? 'No signal' : `${Math.round(signal)} dBm · ${window.WifiSiteModel.signalLevel(signal).label}`}</dd></div>
          <div><dt>Wi-Fi</dt><dd>${ap ? escape(cabling().name(data.devices.get(ap.id))) : 'Not associated'}</dd></div>` : ''}</dl>
        <div class="wifi-ping-controls">
          <label>Ping target<select id="wifiPingTarget"${run?.id === device.id ? ' disabled' : ''}>${options.map(([id, label]) =>
            `<option value="${escape(id)}"${id === target ? ' selected' : ''}>${escape(label)}</option>`).join('')}</select></label>
          <button type="button" class="wifi-control" id="wifiPingToggle">${run?.id === device.id ? 'Stop Ping' : 'Start Ping'}</button>
          <output id="wifiPingStats" aria-live="polite">${run?.id === device.id ? '' : stats(device.id)}</output>
        </div>`;
    }

    function paint(now) {
      frame = 0;
      for (const packet of packets) {
        let elapsed = now - packet.start;
        const stage = packet.stages.find(item => {
          if (elapsed < item.duration) return true;
          elapsed -= item.duration;
          return false;
        });
        const dropping = !stage && packet.dropPoint && elapsed < 440;
        if (!stage && !dropping) {
          packet.node.remove();
          packets.delete(packet);
          continue;
        }
        packet.node.style.display = stage && !stage.points ? 'none' : '';
        if (stage && !stage.points) continue;
        const point = dropping ? packet.dropPoint : position(stage.points, Math.max(0, elapsed / stage.duration));
        packet.node.setAttribute('transform', `translate(${point.x} ${point.y})`);
        packet.node.classList.toggle('is-reply', !!stage?.reply);
        packet.node.classList.toggle('is-dropped', !!dropping);
        packet.node.style.opacity = dropping ? String(1 - elapsed / 440) : '';
      }
      if (packets.size) frame = requestAnimationFrame(paint);
    }

    function transmit() {
      const { id, target, summary } = run;
      const packet = model.ping(network(), id, target);
      summary.sent += 1;
      if (packet.rtt !== null) {
        summary.received += 1;
        summary.total += packet.rtt;
        summary.min = Math.min(summary.min, packet.rtt);
        summary.max = Math.max(summary.max, packet.rtt);
      }
      const node = document.createElementNS(svgNS, 'g');
      node.classList.add('wifi-ping-packet');
      node.style.display = 'none';
      node.innerHTML = '<g class="wifi-marker"><path d="M-8-5H8V5H-8ZM-8-5L0 1L8-5"/><text text-anchor="middle" y="5">💀</text></g>';
      layer.append(node);
      const weights = packet.stages.map(stage => stage.points ? 52 + Math.min(155, stage.length * 4) : 0);
      const scale = Math.min(1, 1500 / weights.reduce((sum, weight) => sum + weight, 0));
      const stages = packet.stages.map((stage, i) => ({ ...stage, points: stage.points && stagePoints(stage.points),
        duration: stage.duration || weights[i] * scale }));
      packets.add({ node, start: performance.now(), stages, dropPoint: packet.dropPoint });
      if (!frame) frame = requestAnimationFrame(paint);
    }

    function stop() {
      clearTimeout(timer);
      run = null;
      refresh();
    }

    function tick() {
      const now = performance.now();
      if (now >= run.end || !network().clients.has(run.id)) { stop(); return; }
      transmit();
      run.next += model.INTERVAL;
      // Skip elapsed slots when a background tab throttles its timers.
      if (run.next <= now) run.next += Math.ceil((now - run.next + 1) / model.INTERVAL) * model.INTERVAL;
      timer = setTimeout(tick, Math.max(0, Math.min(run.next, run.end) - performance.now()));
    }

    function toggle(id) {
      if (run?.id === id) { stop(); return; }
      const target = document.getElementById('wifiPingTarget')?.value;
      if (!target || !network().clients.has(id)) return;
      stop();
      const summary = { sent: 0, received: 0, total: 0, min: Infinity, max: 0 };
      summaries.set(id, summary);
      const now = performance.now();
      run = { id, target, summary, next: now, end: now + model.RUN_TIME };
      tick();
      refresh();
    }

    function suspend() {
      stop();
      cancelAnimationFrame(frame);
      frame = 0;
      packets.clear();
      layer.replaceChildren();
    }

    function reset() {
      suspend();
      sources = graph = null;
      preferences.clear();
      summaries.clear();
    }

    return { inspector, toggle, suspend, reset, setTarget: (id, target) => { preferences.set(id, target); refresh(); } };
  }

  window.WifiSiteClients = { create };
})();
