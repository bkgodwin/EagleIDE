/* Starter Lab checklist and passive guidance. The server owns completion. */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  function create({ workspace, escape, fit, locate, icon, resolve, recheck, reset }) {
    const panel = $('wifiStarterChecklist');
    const rack = $('wifiRackDialog');
    const layer = $('wifiStarterGhost');
    const rackTip = $('wifiStarterRackTip');
    const hint = $('wifiStarterTip');
    const checks = $('wifiStarterChecks');
    const toggle = $('wifiStarterHint');
    const next = $('wifiStarterNext');
    const restart = $('wifiStarterRestart');
    let course, progress, index, showHint, busy, focused, slot, rackLink, rackLinkKey, frame = 0, ghostSignature;

    const lesson = () => course?.[index];
    const done = id => index < progress.completed || progress.checked.includes(id);
    const pending = () => lesson()?.tasks.find(item => !done(item.id));
    const geometry = task => task?.ghost && resolve(task.id, task.ghost);
    function visible(node) {
      if (!node?.getClientRects().length || node.closest('[hidden], dialog:not([open])')) return false;
      const closed = node.closest('details:not([open])');
      return !closed || node.closest('summary')?.parentElement === closed;
    }

    function clearFocus() {
      focused?.removeAttribute('data-wifi-starter-focus');
      slot?.removeAttribute('data-wifi-starter-focus');
      focused = slot = null;
    }

    function control(item, scope) {
      for (const selector of item.focus) {
        const all = [...scope.querySelectorAll(selector)];
        const target = all.find(el => visible(el) && !el.disabled &&
          !(el.matches('[data-wifi-field], input, select') && el.closest('[hidden]')));
        if (target) return target;
      }
      for (const selector of item.focus) {
        const parent = scope.querySelector(selector)?.closest('details:not([open])');
        const summary = parent?.querySelector('summary');
        if (visible(summary)) return summary;
      }
      if (!rack.open && (['unit', 'rack-link'].includes(item.ghost?.kind) || item.focus.some(selector => selector.includes('rack') ||
          selector.includes('config=') || selector === '#wifiDhcpGateway' || selector === '#wifiVlanId'))) {
        return workspace.querySelector('#wifiEquipmentLayer .wifi-gear-rack');
      }
      return null;
    }

    function guidance() {
      const task = pending();
      const target = task && showHint ? control(task, rack.open ? rack : workspace) : null;
      const unit = rack.open && showHint && task?.ghost?.kind === 'unit' ?
        rack.querySelector(`[data-rack-unit-number="${task.ghost.unit}"]`) : null;
      if (target !== focused || slot !== unit) {
        clearFocus();
        focused = target;
        slot = unit;
        focused?.setAttribute('data-wifi-starter-focus', '');
        slot?.setAttribute('data-wifi-starter-focus', '');
      }
      const link = rack.open && showHint && task?.ghost?.kind === 'rack-link' ? task.ghost : null;
      const ports = link?.ends.map(([profile, port]) => rack.querySelector(
        `[data-rack-profile="${profile}"] [data-rack-port$=":${port}"]`));
      const key = ports?.every(Boolean) ? task.id : null;
      if (key !== rackLinkKey || (key && !rackLink?.isConnected)) {
        rackLink?.remove();
        rackLinkKey = key;
        if (key) {
          const [[ax, ay], [bx, by]] = ports.map(port => [Number(port.dataset.rackX), Number(port.dataset.rackY)]);
          const edge = Math.max(ax, bx) + 22;
          rackLink = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
          rackLink.classList.add('wifi-starter-rack-link');
          rackLink.setAttribute('points', `${ax},${ay} ${edge},${ay} ${edge},${by} ${bx},${by}`);
          ports[0].ownerSVGElement.append(rackLink);
        }
      }
      const rackMessage = showHint && task ? task.hint : lesson() && !task
        ? index < progress.completed ? 'Lesson complete. Close the rack to continue.' : 'Close the rack to check this lesson.'
        : '';
      rackTip.hidden = !rack.open || !rackMessage;
      if (!rackTip.hidden && rackTip.textContent !== rackMessage) rackTip.textContent = rackMessage;
    }

    function schedule() {
      if (!course || frame) return;
      frame = requestAnimationFrame(() => { frame = 0; guidance(); });
    }

    function render() {
      if (!course) return;
      const step = lesson();
      const task = pending();
      panel.hidden = false;
      const attempt = progress.attempt > 1 ? ` · Attempt ${progress.attempt}` : '';
      $('wifiStarterStep').textContent = (step ? `Lesson ${index + 1} of ${course.length}` : 'Starter Labs complete') + attempt;
      $('wifiStarterHeading').textContent = step?.title || 'Studio ready';
      $('wifiStarterGoal').textContent = step?.goal || 'Your studio is saved. Try a scenario or start your own design from Network Lab.';
      checks.innerHTML = step?.tasks.map(item => `<li data-checked="${done(item.id)}"${item === task ? ' aria-current="step"' : ''}>
        <span aria-hidden="true">${done(item.id) ? '✓' : '○'}</span><span><span class="sr-only">${done(item.id) ? 'Complete. ' : ''}</span>${escape(item.label)}</span></li>`).join('') || '';
      hint.hidden = !showHint || !step;
      const finished = index < progress.completed;
      const message = task?.hint || (finished ? 'Lesson complete. Continue on the same plan.' : 'The checklist is ready. Check this lesson to record your work.');
      if (hint.textContent !== message) hint.textContent = message;
      toggle.hidden = !step || !task;
      toggle.textContent = showHint ? 'Hide hint' : 'Show hint';
      toggle.setAttribute('aria-pressed', String(showHint));
      $('wifiStarterFit').hidden = !task?.ghost || ['unit', 'rack-link'].includes(task.ghost.kind);
      next.hidden = Boolean(task) || !step;
      next.textContent = !finished ? 'Check lesson' : index + 1 === course.length ? 'Finish Starter Labs' : 'Next lesson';
      next.disabled = busy;
      restart.hidden = step ? !progress.can_restart || finished : false;
      restart.disabled = busy;
      restart.textContent = step ? 'Restart lesson' : 'Repeat Starter Labs';
      guidance();
    }

    function open(data) {
      close();
      if (!data) return;
      course = data.lessons;
      progress = data.progress;
      index = progress.completed;
      showHint = true;
      busy = false;
      render();
    }

    function close() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      course = progress = null;
      panel.hidden = rackTip.hidden = true;
      clearFocus();
      rackLink?.remove();
      rackLink = rackLinkKey = null;
      layer.replaceChildren();
      ghostSignature = null;
    }

    function update(data) {
      if (!course || !data) return;
      const changed = data.completed !== progress.completed || data.checked.join() !== progress.checked.join()
        || data.can_restart !== progress.can_restart;
      progress = data;
      if (changed) render();
    }

    function draw(scale) {
      if (!course) return;
      const task = pending();
      const ghost = geometry(task);
      const signature = ghost && `${task.id}:${scale}:${JSON.stringify(ghost)}`;
      if (signature === ghostSignature) return;
      ghostSignature = signature;
      if (!ghost || ['unit', 'rack-link'].includes(ghost.kind)) {
        layer.replaceChildren();
      } else if (ghost.kind === 'point') {
        const [x, y] = ghost.at;
        layer.innerHTML = `<g class="wifi-starter-point" transform="translate(${x} ${y}) scale(${1 / scale})">
          <circle class="wifi-starter-target" r="17"/><path d="M-23 0h9m28 0h9M0-23v9m0 28v9"/>
          ${ghost.icon ? `<g transform="translate(-11 -11)">${icon(ghost.icon)}</g>` : '<circle r="3" fill="#3157cc"/>'}
          <text x="21" y="-16">${escape(ghost.label)}</text>
        </g>`;
      } else {
        const endpoints = task.id === 'shell' ? [ghost.points[0], ghost.points[2]] : ghost.points;
        layer.innerHTML = `<polyline class="wifi-starter-path" points="${ghost.points.map(point => point.join(',')).join(' ')}"/>
          ${endpoints.map(([x, y], i) => `<g class="wifi-starter-point" transform="translate(${x} ${y}) scale(${1 / scale})">
            <circle class="wifi-starter-target" r="10"/><text text-anchor="middle" y="4">${i + 1}</text></g>`).join('')}`;
      }
    }

    function snap(point, tool, scale) {
      const task = pending();
      if (!task?.focus.includes(`[data-wifi-tool="${tool}"]`)) return point;
      const ghost = geometry(task);
      const targets = task.id === 'shell' ? [ghost.points[0], ghost.points[2]] :
        task.id === 'wall' ? ghost.points : ghost?.kind === 'point' ? [ghost.at] : [];
      const target = targets.find(([x, y]) => Math.hypot(point.x - x, point.y - y) <= Math.max(.85, 15 / scale));
      return target ? { x: target[0], y: target[1] } : point;
    }

    next.addEventListener('click', async () => {
      if (!course || busy || pending()) return;
      if (index >= progress.completed) {
        const shown = course;
        busy = next.disabled = true;
        await recheck();
        if (course === shown) {
          busy = false;
          render();
        }
        return;
      }
      index += 1;
      showHint = true;
      render();
      fit();
    });
    restart.addEventListener('click', async () => {
      if (!course || busy || restart.hidden) return;
      const step = lesson();
      const message = step ? 'Restore the floor plan from the start of this lesson? Earlier lessons will stay complete.'
        : 'Start over from lesson 1? Your current studio will be kept in Saved Sites.';
      if (!window.confirm(message)) return;
      const shown = course;
      busy = restart.disabled = true;
      await reset(step ? 'lesson' : 'course', step ? index : null);
      if (course === shown) {
        busy = false;
        render();
      }
    });
    toggle.addEventListener('click', () => { showHint = !showHint; render(); });
    $('wifiStarterFit').addEventListener('click', () => locate(geometry(pending())));
    for (const event of ['click', 'change', 'toggle']) workspace.addEventListener(event, schedule, true);
    rack.addEventListener('close', schedule);
    return {
      open, close, update, draw, schedule, snap,
      accepts: event => Boolean(lesson()?.tasks.some(item => item.event === event && !done(item.id))),
      ghost: () => geometry(pending()),
    };
  }

  window.WifiStarterGuide = { create };
})();
