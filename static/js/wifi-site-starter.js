/* Starter Lab checklist and passive guidance. The server owns completion. */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  function create({ workspace, escape, fit, locate, icon, resolve, recheck, reset, findTarget, selectedId }) {
    const panel = $('wifiStarterChecklist');
    const rack = $('wifiRackDialog');
    const layer = $('wifiStarterGhost');
    const rackTip = $('wifiStarterRackTip');
    const rackGuide = $('wifiStarterRackGuide');
    const theory = $('wifiStarterTheory');
    const rackTheory = $('wifiStarterRackTheory');
    const picker = document.createElement('div');
    picker.className = 'wifi-starter-picker';
    picker.setAttribute('role', 'listbox');
    picker.setAttribute('aria-label', 'Guided choices');
    let pickerSelect, pickerChoice;
    let suggested = new Set();
    const hint = $('wifiStarterTip');
    const checks = $('wifiStarterChecks');
    const toggle = $('wifiStarterHint');
    const next = $('wifiStarterNext');
    const restart = $('wifiStarterRestart');
    let course, progress, index, showHint, busy, guest, focused, slot, rackLink, rackLinkKey, frame = 0, ghostSignature;

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

    function locateControl(scope, selector) {
      for (const node of scope.querySelectorAll(selector)) {
        if (visible(node) && !node.disabled) return node;
        const parent = node.closest('details:not([open])');
        const summary = parent?.querySelector('summary');
        if (visible(summary)) return summary;
      }
      return null;
    }

    function recommendation(item, select) {
      const choice = item?.choices?.find(entry => select.matches(entry.selector));
      if (!choice) return null;
      return [...select.options].find(option => !option.disabled && (
        choice.value !== null ? option.value === choice.value :
          choice.suffix ? option.value.endsWith(choice.suffix) : option.textContent.trim().startsWith(choice.label)
      ));
    }

    function contextControl(item, scope) {
      const required = item.focus.find(selector => selector.startsWith('[data-wifi-tool="'));
      if (required && !rack.open && !workspace.querySelector(`${required}[aria-pressed="true"]`)) {
        return locateControl(scope, required);
      }
      if (item.rack) {
        if (!rack.open) return workspace.querySelector('#wifiEquipmentLayer .wifi-gear-rack');
        const chassis = rack.querySelector(`[data-rack-profile="${item.rack}"]`);
        if (chassis && !chassis.classList.contains('is-selected')) {
          return rack.querySelector('[data-rack-mode="inspect"][aria-pressed="false"]') || chassis;
        }
      }
      if (item.target && !rack.open) {
        const id = findTarget(item.target);
        if (id && id !== selectedId()) {
          return workspace.querySelector(`[data-wifi-object="${CSS.escape(id)}"] .wifi-marker`);
        }
      }
      return null;
    }

    function control(item, scope, choices) {
      const context = contextControl(item, scope);
      if (context) return context;
      // Options that still need to change take priority over the action button.
      if (item.id === 'ssid-workshop' && choices[0]?.select.id === 'wifiApSsid' &&
          choices[0].select.value !== choices[0].option.value) return choices[0].select;
      if (item.id === 'ssid-workshop') {
        const name = scope.querySelector('#wifiSsidName');
        if (visible(name) && name.value.trim().toLowerCase() !== 'studio guest') return name;
      }
      if (item.id === 'guest') {
        const name = scope.querySelector('#wifiVlanName'), id = scope.querySelector('#wifiVlanId');
        if (visible(name) && name.value.trim().toLowerCase() === 'guest') {
          return id.value !== '20' ? id : scope.querySelector('[data-wifi-network="save-vlan"]');
        }
      }
      const nextChoice = choices.find(({select, option}) => select.value !== option.value);
      if (nextChoice) return nextChoice.select;
      const target = item.focus.map(selector => locateControl(scope, selector)).find(Boolean);
      if (target && (target.tagName !== 'SELECT' || !target.disabled)) return target;
      if (!rack.open && (['unit', 'rack-link'].includes(item.ghost?.kind) || item.focus.some(selector => selector.includes('rack')))) {
        return workspace.querySelector('#wifiEquipmentLayer .wifi-gear-rack');
      }
      return choices[0]?.select || null;
    }

    function closePicker(restore = false) {
      const select = pickerSelect;
      picker.remove();
      pickerSelect = pickerChoice = null;
      if (restore && visible(select)) select.focus({ preventScroll: true });
    }

    function showPicker(select) {
      if (!course || !showHint || !visible(select) || select.disabled) return false;
      const option = recommendation(pending(), select);
      if (!option) return false;
      if (pickerSelect === select) return true;
      closePicker();
      pickerSelect = select;
      pickerChoice = option.value;
      const rect = select.getBoundingClientRect();
      const width = Math.min(Math.max(rect.width, 200), innerWidth - 16);
      const below = innerHeight - rect.bottom - 8;
      const above = rect.top - 8;
      const opensAbove = below < 170 && above > below;
      picker.style.width = `${width}px`;
      picker.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`;
      picker.style.top = opensAbove ? 'auto' : `${rect.bottom + 4}px`;
      picker.style.bottom = opensAbove ? `${innerHeight - rect.top + 4}px` : 'auto';
      picker.style.maxHeight = `${Math.min(270, opensAbove ? above : below)}px`;
      let recommended;
      picker.replaceChildren(...[...select.options].map(entry => {
        const row = document.createElement('button');
        row.type = 'button';
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(select.value === entry.value));
        row.dataset.value = entry.value;
        row.disabled = entry.disabled;
        row.textContent = entry.textContent.trim();
        if (entry === option) {
          recommended = row;
          row.dataset.recommended = '';
          const badge = document.createElement('small');
          badge.textContent = 'Recommended';
          row.append(badge);
        }
        return row;
      }));
      (rack.open && rack.contains(select) ? rack : workspace).append(picker);
      recommended.focus();
      return true;
    }

    function chooseOption(row) {
      const select = pickerSelect;
      if (!select || !row || row.disabled) return;
      select.value = row.dataset.value;
      closePicker();
      select.dispatchEvent(new Event('change', { bubbles: true }));
      if (select.id !== 'wifiCableToPort' && visible(select)) select.focus({ preventScroll: true });
      schedule();
    }

    function guidance() {
      const task = pending();
      const scope = rack.open ? rack : workspace;
      const targetContext = task && showHint ? contextControl(task, scope) : null;
      const choices = task && showHint && !targetContext ? (task.choices || []).flatMap(({selector}) => {
        const select = scope.querySelector(selector);
        if (!visible(select) || select.disabled || select.tagName !== 'SELECT') return [];
        const option = recommendation(task, select);
        return option ? [{select, option}] : [];
      }) : [];
      const target = task && showHint ? control(task, scope, choices) : null;
      const nextSuggested = new Set(choices.map(row => row.select));
      for (const select of suggested) if (!nextSuggested.has(select)) select.removeAttribute('data-wifi-starter-choice');
      for (const select of nextSuggested) select.setAttribute('data-wifi-starter-choice', '');
      suggested = nextSuggested;
      if (pickerSelect && (!showHint || !visible(pickerSelect) ||
          recommendation(task, pickerSelect)?.value !== pickerChoice)) closePicker();
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
      rackGuide.hidden = !rack.open || !lesson();
      rackTheory.hidden = rackGuide.hidden;
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
      $('wifiStarterGoal').textContent = step?.goal || (guest
        ? 'Download a copy of your studio before leaving, or repeat the lessons.'
        : 'Your studio is saved. Try a scenario or start your own design from Network Lab.');
      checks.innerHTML = step?.tasks.map(item => `<li data-checked="${done(item.id)}"${item === task ? ' aria-current="step"' : ''}>
        <span aria-hidden="true">${done(item.id) ? '✓' : '○'}</span><span><span class="sr-only">${done(item.id) ? 'Complete. ' : ''}</span>${escape(item.label)}</span></li>`).join('') || '';
      $('wifiStarterRackHeading').textContent = step?.title || '';
      $('wifiStarterRackChecks').innerHTML = checks.innerHTML;
      const background = task?.theory || step?.theory;
      for (const box of [theory, rackTheory]) {
        box.hidden = !background || (box === rackTheory && !rack.open);
        if (background) box.innerHTML = `<strong>How it works</strong><p>${escape(background)}</p>`;
        else box.replaceChildren();
      }
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
      guest = data.guest;
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
      panel.hidden = rackTip.hidden = rackGuide.hidden = rackTheory.hidden = true;
      closePicker();
      for (const select of suggested) select.removeAttribute('data-wifi-starter-choice');
      suggested.clear();
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
        : guest ? 'Start over from lesson 1? Download your current studio first if you want to keep it.'
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
    picker.addEventListener('click', event => chooseOption(event.target.closest('[role="option"]')));
    picker.addEventListener('keydown', event => {
      const rows = [...picker.querySelectorAll('[role="option"]:not(:disabled)')];
      const index = rows.indexOf(document.activeElement);
      if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') event.preventDefault();
        event.stopPropagation();
        closePicker(true);
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const target = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
          : Math.min(rows.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)));
        rows[target]?.focus();
      }
    });
    workspace.addEventListener('pointerdown', event => {
      const select = event.target.closest('select');
      if (select && showPicker(select)) {
        event.preventDefault();
      } else if (pickerSelect && !picker.contains(event.target)) closePicker();
    }, true);
    workspace.addEventListener('click', event => {
      if (pickerSelect === event.target) event.preventDefault();
    }, true);
    window.addEventListener('resize', () => closePicker());
    workspace.addEventListener('keydown', event => {
      const select = event.target.closest('select');
      if (select && ['Enter', ' ', 'ArrowDown'].includes(event.key) && showPicker(select)) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, true);
    for (const event of ['click', 'change', 'input', 'toggle']) workspace.addEventListener(event, schedule, true);
    rack.addEventListener('close', schedule);
    return {
      open, close, update, draw, schedule, snap, showPicker,
      accepts: event => Boolean(lesson()?.tasks.some(item => item.event === event && !done(item.id))),
      ghost: () => geometry(pending()),
    };
  }

  window.WifiStarterGuide = { create };
})();
