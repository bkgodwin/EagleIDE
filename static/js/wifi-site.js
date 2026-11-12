/* Scaled floor plan editor for EagleIDE Network Simulator. */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const model = window.WifiSiteModel;
  const workspace = $('wifiWorkspace');
  const library = $('wifiSiteLibrary');
  const viewport = $('wifiViewport');
  const stage = $('wifiStage');
  const objects = $('wifiObjects');
  const heatmap = $('wifiHeatmap');
  const endpoint = '/api/network/wifi-sites';
  const kinds = ['walls', 'access_points', 'labels'];
  const drawTools = new Set(['room', 'wall', 'measure']);
  const toolHints = {
    select: 'Select an object to edit it. Drag to move it, or drag a selected wall’s end to resize it.',
    pan: 'Drag the plan to pan. Use Fit to see the whole floor.',
    room: 'Choose two opposite corners, or drag to draw a rectangular room.',
    wall: 'Choose the start and end, or drag to draw a wall.',
    ap: 'Choose a mount, then click or tap to place the access point.',
    label: 'Click or tap to place a note, then edit its text in Objects.',
    measure: 'Choose two points to measure the distance.',
    probe: 'Click or tap a spot to see the strongest access point and the walls in its path.',
  };

  let options;
  let account;
  let viewRequest = 0;
  let session;
  let tool = 'select';
  let selected = '';
  let anchor;
  let hover;
  let drag;
  let measure;
  let probe;
  let keyboardPoint;
  let pixelsPerMeter = 16;
  let worker;
  let workerUnavailable = false;
  let heatJob = 0;
  let heatInFlight = false;
  let queuedHeat;
  let lastCoverageKey = '';
  let initialized = false;

  const current = () => session?.plan;
  const active = () => !workspace.hidden && !!session;
  const sameAccount = () => options && options.authKey() === account;
  const escape = value => options.escapeHtml(value);
  const id = kind => options.makeId(kind);
  const dirty = project => project.sequence > project.savedSequence;
  const cleanText = (value, fallback = '') => value.trim().replace(/\s+/g, ' ') || fallback;
  const siteUrl = siteId => `${endpoint}/${encodeURIComponent(siteId)}`;
  const display = meters => model.displayDistance(meters, current().units);
  const fmt = meters => `${Number(display(meters).toFixed(2))} ${current().units}`;

  function blankPlan() {
    return {
      schema_version: 1, title: 'Untitled Wi-Fi Site', width: 40, height: 28,
      units: 'm', band: '5', walls: [], access_points: [], labels: [],
    };
  }

  function line(a, b, material = $('wifiMaterial').value) {
    return { id: id('wall'), a, b, material };
  }

  function rectangle(a, b, material) {
    const c = { x: b.x, y: a.y };
    const d = { x: a.x, y: b.y };
    return [line(a, c, material), line(c, b, material), line(b, d, material), line(d, a, material)];
  }

  function samplePlan() {
    const plan = blankPlan();
    plan.title = 'Two-Room Wi-Fi Activity';
    plan.walls = [
      ...rectangle({ x: 4, y: 4 }, { x: 36, y: 24 }, 'concrete'),
      line({ x: 20, y: 4 }, { x: 20, y: 24 }, 'drywall'),
    ];
    plan.access_points = [{ id: id('ap'), x: 11, y: 14, mount: 'ceiling', angle: 0, name: 'Classroom AP' }];
    plan.labels = [
      { id: id('label'), x: 8, y: 7, text: 'Room 1' },
      { id: id('label'), x: 25, y: 7, text: 'Room 2' },
    ];
    return plan;
  }

  function status(message, kind = '') {
    $('wifiSaveStatus').textContent = message;
    $('wifiSaveStatus').dataset.kind = kind;
    $('wifiSaveSite').textContent = kind === 'error' && !session?.conflict ? 'Retry Save' : 'Save';
    $('wifiSaveSite').disabled = !!session?.conflict;
    $('wifiDiscardSite').hidden = kind !== 'error';
  }

  function hint(message) {
    $('wifiToolHint').textContent = message || toolHints[tool];
  }

  function changeTool(value) {
    tool = value;
    anchor = hover = keyboardPoint = null;
    viewport.dataset.tool = value;
    workspace.querySelectorAll('[data-wifi-tool]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.wifiTool === value));
    });
    $('wifiMaterialField').hidden = !['wall', 'room'].includes(value);
    $('wifiMountField').hidden = value !== 'ap';
    hint();
    if (current()) drawObjects();
  }

  function startProject(plan, { activity = false } = {}) {
    const { id: siteId, revision, updated_at, ...layout } = plan;
    session = {
      id: siteId || id('site'), revision: revision || 0, plan: layout, account,
      sequence: 0, savedSequence: 0, undo: [], redo: [],
    };
    selected = '';
    anchor = hover = drag = measure = probe = keyboardPoint = null;
    lastCoverageKey = '';
    library.hidden = true;
    workspace.hidden = false;
    $('wifiActivity').hidden = !activity;
    $('wifiActivity').open = activity;
    $('wifiSaveSite').hidden = $('wifiCopySite').hidden = !options.canSave;
    $('wifiCoverage').checked = $('wifiSnap').checked = true;
    status(options.canSave ? (revision ? 'Saved' : 'New project') : 'Guest preview');
    changeTool(activity ? 'probe' : 'select');
    render();
    fit();
    viewport.focus({ preventScroll: true });
  }

  function scheduleSave() {
    if (!options.canSave || session.conflict) return;
    const project = session;
    clearTimeout(project.timer);
    status('Unsaved changes');
    project.timer = setTimeout(() => flushSave(project), 650);
  }

  function flushSave(project = session) {
    if (!project || !options.canSave || project.account !== options.authKey()) return Promise.resolve(false);
    clearTimeout(project.timer);
    if (project.conflict) return Promise.resolve(false);
    if (project.pending) return project.pending;
    if (!dirty(project)) return Promise.resolve(true);
    project.pending = (async () => {
      while (dirty(project) && project.account === options.authKey()) {
        const attempt = project.attempt ||= { sequence: project.sequence, plan: project.plan };
        if (session === project) status('Saving…');
        try {
          const saved = await options.api(siteUrl(project.id), {
            method: 'PUT', body: JSON.stringify({ site: attempt.plan, revision: project.revision }),
          });
          project.revision = saved.revision;
          project.savedSequence = attempt.sequence;
          project.attempt = null;
          if (session === project && !dirty(project)) status('Saved', 'good');
        } catch (error) {
          project.conflict = error.status === 409;
          if (!project.conflict && error.status >= 400 && error.status < 500) project.attempt = null;
          if (session === project) status(`Save failed. ${error.message}`, 'error');
          return false;
        }
      }
      return !dirty(project);
    })().finally(() => { project.pending = null; });
    return project.pending;
  }

  function saveNow() {
    if (!session.revision && !dirty(session)) session.sequence += 1;
    return flushSave();
  }

  async function saveCopy() {
    const project = session;
    clearTimeout(project.timer);
    if (project.pending) await project.pending;
    if (session !== project || !sameAccount()) return;
    const suffix = ' — Copy';
    project.id = id('site');
    project.revision = project.savedSequence = 0;
    project.sequence = 1;
    project.conflict = false;
    project.attempt = null;
    const title = Array.from(project.plan.title).slice(0, 120 - suffix.length).join('');
    project.plan = { ...project.plan, title: title + suffix };
    $('wifiSiteTitle').value = project.plan.title;
    await flushSave(project);
  }

  async function leave() {
    if (active() && options.canSave && sameAccount() && dirty(session) && !await flushSave()) return false;
    hide();
    return true;
  }

  function hide() {
    viewRequest += 1;
    if (session) clearTimeout(session.timer);
    workspace.hidden = library.hidden = true;
    session = null;
    selected = '';
    drag = null;
    queuedHeat = null;
    heatJob += 1;
    heatmap.hidden = true;
    $('wifiSavedSites').replaceChildren();
    $('wifiProperties').replaceChildren();
    objects.replaceChildren();
    $('wifiSiteTitle').value = '';
    $('wifiProbeResult').textContent = '';
    $('wifiProbeSummary').textContent = '';
  }

  async function loadSites() {
    const request = ++viewRequest;
    const saved = $('wifiSavedSites');
    const message = $('wifiLibraryStatus');
    const retry = $('wifiReloadSites');
    retry.hidden = true;
    message.textContent = 'Loading sites…';
    try {
      const sites = await options.api(endpoint);
      if (viewRequest !== request || !sameAccount() || library.hidden) return;
      message.textContent = sites.length ? '' : 'Create a site or try the two-room activity to get started.';
      saved.innerHTML = sites.map(site => `
        <article class="network-card wifi-site-card">
          <h3><button type="button" data-wifi-open="${escape(site.id)}">${escape(site.title)}</button></h3>
          <p>Edited ${escape(new Date(site.updated_at * 1000).toLocaleDateString())}</p>
          <button class="btn secondary" type="button" data-wifi-delete="${escape(site.id)}" aria-label="Delete ${escape(site.title)}">Delete</button>
        </article>`).join('');
    } catch (error) {
      if (viewRequest !== request || !sameAccount() || library.hidden) return;
      message.textContent = error.message;
      retry.hidden = false;
    }
  }

  async function openSaved(siteId) {
    const request = ++viewRequest;
    $('wifiLibraryStatus').textContent = 'Opening site…';
    try {
      const plan = await options.api(siteUrl(siteId));
      if (viewRequest === request && sameAccount() && !library.hidden) startProject(plan);
    } catch (error) {
      if (viewRequest === request && sameAccount() && !library.hidden) $('wifiLibraryStatus').textContent = error.message;
    }
  }

  async function deleteSaved(siteId) {
    if (!window.confirm('Delete this saved Wi-Fi site?')) return;
    const request = ++viewRequest;
    try {
      await options.api(siteUrl(siteId), { method: 'DELETE' });
      if (viewRequest === request && sameAccount() && !library.hidden) await loadSites();
    } catch (error) {
      if (viewRequest === request && sameAccount() && !library.hidden) $('wifiLibraryStatus').textContent = error.message;
    }
  }

  function showSites() {
    hide();
    library.hidden = false;
    $('wifiGuestNotice').hidden = options.canSave;
    $('wifiSavedSection').hidden = !options.canSave;
    $('wifiSiteHeading').focus();
    if (options.canSave) loadSites();
  }

  function objectById(objectId) {
    for (const kind of kinds) {
      const item = current()[kind].find(object => object.id === objectId);
      if (item) return { kind, item };
    }
    return null;
  }

  function objectName(kind, item, index) {
    if (kind === 'walls') return `${model.MATERIALS[item.material].name} wall ${index + 1}`;
    if (kind === 'labels') return item.text;
    return item.name || model.MOUNTS[item.mount];
  }

  function selectObject(objectId) {
    selected = objectId;
    renderInspector();
    drawObjects();
  }

  function update(next, { inspector = true } = {}) {
    session.undo.push(session.plan);
    if (session.undo.length > 45) session.undo.shift();
    session.redo = [];
    setPlan(next, inspector);
  }

  function setPlan(plan, inspector = true) {
    session.plan = plan;
    session.sequence += 1;
    if (!objectById(selected)) selected = '';
    scheduleSave();
    render({ inspector });
  }

  function history(backward) {
    const from = backward ? session.undo : session.redo;
    const to = backward ? session.redo : session.undo;
    if (!from.length) return;
    to.push(session.plan);
    setPlan(from.pop());
  }

  function replaceObject(kind, item, refresh = true) {
    update({ ...current(), [kind]: current()[kind].map(object => object.id === item.id ? item : object) }, { inspector: refresh });
  }

  function addObjects(kind, additions) {
    const existing = current()[kind];
    const limit = options.limits[kind];
    if (existing.length + additions.length > limit) {
      hint(`This site can contain up to ${limit} ${kind.replace('_', ' ')}.`);
      return false;
    }
    selected = additions.at(-1).id;
    update({ ...current(), [kind]: [...existing, ...additions] });
    return true;
  }

  function removeObject() {
    const match = objectById(selected);
    if (!match) return;
    const { kind, item } = match;
    update({ ...current(), [kind]: current()[kind].filter(object => object.id !== item.id) });
    $('wifiSelection').focus();
  }

  function render({ inspector = true } = {}) {
    const plan = current();
    if (document.activeElement !== $('wifiSiteTitle')) $('wifiSiteTitle').value = plan.title;
    $('wifiUnits').value = plan.units;
    $('wifiBand').value = plan.band;
    $('wifiWidth').value = Number(display(plan.width).toFixed(3));
    $('wifiHeight').value = Number(display(plan.height).toFixed(3));
    $('wifiGridLabel').textContent = `Grid squares are ${fmt(model.gridStep(plan.units))} wide.`;
    $('wifiUndo').disabled = !session.undo.length;
    $('wifiRedo').disabled = !session.redo.length;
    drawGrid();
    if (inspector) renderInspector();
    else renderObjectOptions();
    renderProbe();
    drawObjects();
    requestCoverage();
  }

  function renderObjectOptions() {
    $('wifiSelection').innerHTML = '<option value="">None selected</option>' + kinds.map(kind =>
      current()[kind].map((item, index) => `<option value="${escape(item.id)}">${escape(objectName(kind, item, index))}</option>`).join('')
    ).join('');
    $('wifiSelection').value = selected;
  }

  function pointFields(point, prefix = '', label = '') {
    const input = axis => `<label>${label}${axis.toUpperCase()} (${current().units})<input type="number" inputmode="decimal" step="any" data-wifi-field="${prefix}${axis}" value="${Number(display(point[axis]).toFixed(3))}"></label>`;
    return `<div class="wifi-two-fields">${input('x')}${input('y')}</div>`;
  }

  function choiceList(entries, value) {
    return entries.map(([key, label]) => `<option value="${key}"${key === value ? ' selected' : ''}>${label}</option>`).join('');
  }

  function renderInspector() {
    renderObjectOptions();
    const match = objectById(selected);
    const panel = $('wifiProperties');
    if (!match) {
      panel.innerHTML = '<p>Select a wall, access point, or note to edit it.</p>';
      return;
    }
    const { kind, item } = match;
    let fields;
    if (kind === 'walls') {
      fields = `<label>Wall material<select data-wifi-field="material">${choiceList(materialEntries(), item.material)}</select></label>
        ${pointFields(item.a, 'a', 'Start ')}${pointFields(item.b, 'b', 'End ')}`;
    } else if (kind === 'access_points') {
      fields = `<label>Access point label<input data-wifi-field="name" value="${escape(item.name)}" maxlength="60" placeholder="Optional"></label>
        <label>Mount<select data-wifi-field="mount">${choiceList(Object.entries(model.MOUNTS), item.mount)}</select></label>
        ${pointFields(item)}${item.mount === 'wall' ? `<label>Direction in degrees (0° points right)<input type="number" min="0" max="360" step="1" data-wifi-field="angle" value="${item.angle}"></label>` : ''}`;
    } else {
      fields = `<label>Note text<input data-wifi-field="text" value="${escape(item.text)}" maxlength="160"></label>${pointFields(item)}`;
    }
    panel.innerHTML = fields + '<button class="wifi-control" id="wifiDeleteObject" type="button">Delete selected</button>';
  }

  function materialEntries() {
    return Object.entries(model.MATERIALS).map(([key, material]) => [key, material.name]);
  }

  function editObject(input) {
    const match = objectById(selected);
    if (!match || !input.dataset.wifiField) return;
    const { kind, item } = match;
    const field = input.dataset.wifiField;
    const next = { ...item };
    if (/^[ab]?[xy]$/.test(field)) {
      const axis = field.at(-1);
      const bound = axis === 'x' ? current().width : current().height;
      const part = field.length === 2 ? field[0] : null;
      const before = part ? item[part][axis] : item[axis];
      const value = input.value === '' ? before : Math.min(bound, Math.max(0, model.metersFrom(Number(input.value), current().units)));
      if (part) next[part] = { ...next[part], [axis]: model.roundDistance(value) };
      else next[axis] = model.roundDistance(value);
      if (part && model.distance(next.a, next.b) < 0.05) {
        input.value = Number(display(before).toFixed(3));
        hint('Keep the wall at least 5 centimeters long.');
        return;
      }
      input.value = Number(display(value).toFixed(3));
    } else if (field === 'angle') {
      next.angle = Math.min(360, Math.max(0, Number(input.value))) % 360;
      input.value = next.angle;
    } else {
      next[field] = cleanText(input.value, field === 'text' ? 'New note' : '');
      input.value = next[field];
    }
    replaceObject(kind, next, field === 'mount');
  }

  function resizePlan(input, key) {
    const layout = current();
    const proposed = model.roundDistance(model.metersFrom(Number(input.value), layout.units));
    const axis = key === 'width' ? 'x' : 'y';
    const occupied = Math.max(0, ...layout.walls.flatMap(wall => [wall.a[axis], wall.b[axis]]),
      ...layout.access_points.map(ap => ap[axis]), ...layout.labels.map(label => label[axis]));
    if (proposed < 8 || proposed > 120 || proposed < occupied) {
      input.value = Number(display(layout[key]).toFixed(3));
      hint(proposed < occupied ? 'Move objects inside the proposed floor dimensions first.' :
        `Choose a dimension between ${fmt(8)} and ${fmt(120)}.`);
      return;
    }
    update({ ...layout, [key]: proposed });
    hint();
    fit();
  }

  function drawGrid() {
    const { width, height, units } = current();
    const box = `0 0 ${width} ${height}`;
    stage.style.width = `${width * pixelsPerMeter}px`;
    stage.style.height = `${height * pixelsPerMeter}px`;
    $('wifiGrid').setAttribute('viewBox', box);
    objects.setAttribute('viewBox', box);
    const spacing = model.gridStep(units);
    const major = spacing * 5;
    $('wifiGrid').innerHTML = `<defs>
      <pattern id="wifiMinorGrid" width="${spacing}" height="${spacing}" patternUnits="userSpaceOnUse"><path class="wifi-minor-line" d="M ${spacing} 0 H 0 V ${spacing}"/></pattern>
      <pattern id="wifiMajorGrid" width="${major}" height="${major}" patternUnits="userSpaceOnUse"><path class="wifi-major-line" d="M ${major} 0 H 0 V ${major}"/></pattern>
    </defs><rect width="100%" height="100%" fill="url(#wifiMinorGrid)"/><rect width="100%" height="100%" fill="url(#wifiMajorGrid)"/>`;
    const target = 100 / pixelsPerMeter;
    const scale = [1, 2, 5, 10, 20, 50, 100].map(value => model.metersFrom(value, units))
      .filter(value => value <= target && value <= width).at(-1) || model.metersFrom(1, units);
    $('wifiScale').querySelector('span').style.width = `${scale * pixelsPerMeter}px`;
    $('wifiScale').querySelector('strong').textContent = fmt(scale);
  }

  function lineSvg(a, b, attrs = '') {
    return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" ${attrs}/>`;
  }

  function dot(point, radius, className, extra = '') {
    return `<circle cx="${point.x}" cy="${point.y}" r="${radius / pixelsPerMeter}" class="${className}" ${extra}/>`;
  }

  function drawObjects() {
    const plan = current();
    const parts = [];
    const unit = 1 / pixelsPerMeter;
    const ghost = drag?.preview;
    for (const wall of plan.walls) {
      const item = ghost?.id === wall.id ? ghost : wall;
      const object = `data-wifi-object="${escape(item.id)}"`;
      if (selected === item.id) parts.push(lineSvg(item.a, item.b, 'class="wifi-selected-wall"'));
      parts.push(lineSvg(item.a, item.b, `class="wifi-wall" stroke="${model.MATERIALS[item.material].color}"`));
      parts.push(lineSvg(item.a, item.b, `class="wifi-wall-hit" ${object}`));
      if (selected === item.id) {
        parts.push(dot(item.a, 6, 'wifi-handle', `${object} data-wifi-end="a"`),
          dot(item.b, 6, 'wifi-handle', `${object} data-wifi-end="b"`));
      }
    }
    for (const ap of plan.access_points) {
      const item = ghost?.id === ap.id ? ghost : ap;
      const object = `data-wifi-object="${escape(item.id)}"`;
      const cls = selected === item.id ? 'wifi-ap is-selected' : 'wifi-ap';
      const direction = item.mount === 'wall' ? `<path class="wifi-direction" transform="rotate(${item.angle})" d="M 9 0 L 20 0 M 16 -4 L 20 0 L 16 4"/>` : '';
      parts.push(`<g transform="translate(${item.x} ${item.y}) scale(${unit})" ${object}>
        <circle r="11" class="${cls}"/>${direction}
        <path class="wifi-radio" d="M -6 -2 Q 0 -8 6 -2 M -3 1 Q 0 -2 3 1 M 0 4 h .1"/>
        ${item.name ? `<text class="wifi-ap-text" x="14" y="-8">${escape(item.name)}</text>` : ''}
      </g>`);
    }
    for (const label of plan.labels) {
      const item = ghost?.id === label.id ? ghost : label;
      const alignRight = item.x * pixelsPerMeter > plan.width * pixelsPerMeter - Math.min(220, item.text.length * 7 + 14);
      const text = item.text.length > 32 ? `${item.text.slice(0, 31)}…` : item.text;
      parts.push(`<g transform="translate(${item.x} ${item.y}) scale(${unit})" data-wifi-object="${escape(item.id)}">
        <title>${escape(item.text)}</title><circle r="5" class="wifi-note-pin ${selected === item.id ? 'is-selected' : ''}"/>
        <text class="wifi-note-text" x="${alignRight ? -8 : 8}" y="${item.y * pixelsPerMeter < 15 ? 16 : -7}" text-anchor="${alignRight ? 'end' : 'start'}">${escape(text)}</text>
      </g>`);
    }
    if (probe) {
      if (probe.result) parts.push(lineSvg(probe.result.ap, probe.point, 'class="wifi-probe-path"'));
      parts.push(dot(probe.point, 6, 'wifi-probe-point'));
    }
    if (measure) parts.push(lineSvg(measure.a, measure.b, 'class="wifi-preview-line"'), dot(measure.b, 4, 'wifi-cursor'));
    const start = drag?.draw ? drag.start : anchor;
    const end = drag?.draw ? drag.point : hover || keyboardPoint;
    if (start) {
      parts.push(dot(start, 5, 'wifi-cursor'));
      if (end && tool === 'room') {
        parts.push(`<rect class="wifi-preview-line" x="${Math.min(start.x, end.x)}" y="${Math.min(start.y, end.y)}" width="${Math.abs(end.x - start.x)}" height="${Math.abs(end.y - start.y)}"/>`);
      } else if (end) parts.push(lineSvg(start, end, 'class="wifi-preview-line"'));
    }
    if (keyboardPoint) parts.push(dot(keyboardPoint, 6, 'wifi-cursor'));
    objects.innerHTML = parts.join('');
    $('wifiMeasureResult').textContent = measure ? `Distance: ${fmt(model.distance(measure.a, measure.b))}` : '';
  }

  function fit() {
    if (!active()) return;
    const { width, height } = current();
    pixelsPerMeter = Math.max(1, Math.min((viewport.clientWidth - 34) / width, (viewport.clientHeight - 34) / height, 38));
    drawGrid();
    drawObjects();
    viewport.scrollLeft = viewport.scrollTop = 0;
  }

  function zoom(factor) {
    const visible = viewport.getBoundingClientRect();
    const box = stage.getBoundingClientRect();
    const cx = (visible.left + viewport.clientWidth / 2 - box.left) / pixelsPerMeter;
    const cy = (visible.top + viewport.clientHeight / 2 - box.top) / pixelsPerMeter;
    pixelsPerMeter = Math.max(1, Math.min(96, pixelsPerMeter * factor));
    drawGrid();
    drawObjects();
    const updated = stage.getBoundingClientRect();
    viewport.scrollLeft += updated.left + cx * pixelsPerMeter - visible.left - viewport.clientWidth / 2;
    viewport.scrollTop += updated.top + cy * pixelsPerMeter - visible.top - viewport.clientHeight / 2;
  }

  function renderProbe() {
    const readout = $('wifiProbeResult');
    const summary = $('wifiProbeSummary');
    summary.textContent = '';
    if (!probe) {
      readout.textContent = 'Use Check Signal and choose a spot on the plan.';
      return;
    }
    const plan = current();
    const estimate = model.coverageModel(plan.walls, plan.access_points, plan.band);
    probe.result = estimate(probe.point, true);
    if (!probe.result) {
      readout.textContent = 'Place an access point to estimate the signal here.';
      return;
    }
    const { ap, signal, distance, walls } = probe.result;
    const crossed = walls.map(material => model.MATERIALS[material].name).join(', ');
    summary.textContent = `${Math.round(signal)} dBm · ${model.signalLevel(signal).label}`;
    readout.innerHTML = `<strong>${summary.textContent}</strong>
      <p>${escape(ap.name || model.MOUNTS[ap.mount])} · ${fmt(distance)} away</p>
      <p>Walls crossed: ${crossed || 'None'}</p>`;
  }

  function paintCoverage({ id: jobId, columns, rows, pixels }) {
    if (jobId !== heatJob || !active()) return;
    heatmap.width = columns;
    heatmap.height = rows;
    heatmap.getContext('2d').putImageData(new ImageData(pixels, columns, rows), 0, 0);
    heatmap.hidden = !$('wifiCoverage').checked;
  }

  function sendCoverage() {
    if (!queuedHeat || heatInFlight) return;
    const job = queuedHeat;
    queuedHeat = null;
    if (!workerUnavailable && !worker) {
      try {
        worker = new Worker('/static/js/wifi-site-worker.js?v=20261112-site');
        worker.onmessage = ({ data }) => {
          heatInFlight = false;
          paintCoverage(data);
          sendCoverage();
        };
        worker.onerror = () => {
          worker.terminate();
          worker = null;
          workerUnavailable = true;
          heatInFlight = false;
          lastCoverageKey = '';
          if (active()) requestCoverage();
          sendCoverage();
        };
      } catch {
        workerUnavailable = true;
      }
    }
    if (worker) {
      heatInFlight = true;
      worker.postMessage(job);
    } else {
      requestAnimationFrame(() => {
        if (job.id === heatJob && active()) paintCoverage({ id: job.id, ...model.heatmap(job.plan) });
      });
    }
  }

  function requestCoverage() {
    const { width, height, walls, access_points, band } = current();
    const plan = { width, height, walls, access_points: access_points.map(({ x, y, mount, angle }) => ({ x, y, mount, angle })), band };
    const show = $('wifiCoverage').checked && access_points.length > 0;
    const key = show ? JSON.stringify(plan) : '';
    if (key === lastCoverageKey) return;
    lastCoverageKey = key;
    heatmap.hidden = true;
    heatJob += 1;
    queuedHeat = show ? { id: heatJob, plan } : null;
    sendCoverage();
  }

  function pointerPoint(event, snap = false) {
    const box = stage.getBoundingClientRect();
    return boundPoint({ x: (event.clientX - box.left) / pixelsPerMeter, y: (event.clientY - box.top) / pixelsPerMeter }, snap);
  }

  function boundPoint(point, snap = false) {
    const plan = current();
    return model.snapPoint(point, plan.width, plan.height, snap && $('wifiSnap').checked ? model.gridStep(plan.units) : 0);
  }

  function drawFrom(a, b) {
    if (tool === 'measure') {
      measure = { a, b };
      drawObjects();
      return;
    }
    if (tool === 'wall' && model.distance(a, b) >= 0.05) addObjects('walls', [line(a, b)]);
    else if (tool === 'room' && Math.min(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) >= 0.05) {
      addObjects('walls', rectangle(a, b));
    } else hint('Choose two distinct points to draw.');
  }

  function useTool(point) {
    if (drawTools.has(tool)) {
      if (anchor) {
        const start = anchor;
        anchor = hover = null;
        hint();
        drawFrom(start, point);
      } else {
        anchor = point;
        hint(tool === 'room' ? 'Choose the opposite corner.' : 'Choose the end point.');
      }
    } else if (tool === 'ap') {
      addObjects('access_points', [{ id: id('ap'), ...point, name: '', mount: $('wifiMount').value, angle: 0 }]);
    } else if (tool === 'label') {
      if (addObjects('labels', [{ id: id('label'), ...point, text: 'New note' }])) {
        changeTool('select');
        const text = $('wifiProperties').querySelector('[data-wifi-field="text"]');
        text.focus();
        text.select();
      }
    } else if (tool === 'probe') {
      probe = { point };
      renderProbe();
    }
    drawObjects();
  }

  function movedObject(item, end, start, point) {
    const plan = current();
    const dx = point.x - start.x;
    const dy = point.y - start.y;
    if (!item.a) return { ...item, ...boundPoint({ x: item.x + dx, y: item.y + dy }, true) };
    if (end) {
      const changed = { ...item, [end]: boundPoint({ x: item[end].x + dx, y: item[end].y + dy }, true) };
      return model.distance(changed.a, changed.b) >= 0.05 ? changed : item;
    }
    const aim = boundPoint({ x: item.a.x + dx, y: item.a.y + dy }, true);
    const tx = Math.min(plan.width - Math.max(item.a.x, item.b.x), Math.max(-Math.min(item.a.x, item.b.x), aim.x - item.a.x));
    const ty = Math.min(plan.height - Math.max(item.a.y, item.b.y), Math.max(-Math.min(item.a.y, item.b.y), aim.y - item.a.y));
    const shift = p => boundPoint({ x: p.x + tx, y: p.y + ty });
    return { ...item, a: shift(item.a), b: shift(item.b) };
  }

  function pointerDown(event) {
    if (event.button !== 0 || drag) return;
    if (tool !== 'pan' && !stage.contains(event.target)) return;
    event.preventDefault();
    viewport.focus({ preventScroll: true });
    viewport.setPointerCapture(event.pointerId);
    keyboardPoint = null;
    const hit = event.target.closest('[data-wifi-object]');
    const point = pointerPoint(event);
    drag = {
      id: event.pointerId, clientX: event.clientX, clientY: event.clientY, start: point,
      left: viewport.scrollLeft, top: viewport.scrollTop,
      match: tool === 'select' && hit ? objectById(hit.dataset.wifiObject) : null,
      end: hit?.dataset.wifiEnd, draw: drawTools.has(tool) && !anchor,
    };
    if (tool === 'select') selectObject(drag.match?.item.id || '');
  }

  function pointerMove(event) {
    if (!drag) {
      if (anchor && stage.contains(event.target)) {
        hover = pointerPoint(event, tool !== 'measure');
        drawObjects();
      }
      return;
    }
    if (drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.clientX;
    const dy = event.clientY - drag.clientY;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true;
    const point = pointerPoint(event, drag.draw && tool !== 'measure');
    if (tool === 'pan') {
      viewport.scrollLeft = drag.left - dx;
      viewport.scrollTop = drag.top - dy;
    } else if (drag.match) {
      drag.preview = movedObject(drag.match.item, drag.end, drag.start, point);
    } else if (drag.draw) {
      drag.point = point;
      if (tool !== 'measure') drag.start = boundPoint(drag.start, true);
    }
    if (drag.match || drag.draw) drawObjects();
  }

  function pointerUp(event) {
    if (drag?.id !== event.pointerId) return;
    const gesture = drag;
    drag = null;
    if (event.type === 'pointercancel') {
      drawObjects();
      return;
    }
    const point = pointerPoint(event, !['select', 'measure', 'probe', 'pan'].includes(tool));
    if (gesture.preview && JSON.stringify(gesture.preview) !== JSON.stringify(gesture.match.item)) {
      replaceObject(gesture.match.kind, gesture.preview);
    } else if (gesture.draw && gesture.moved) {
      drawFrom(gesture.start, point);
    } else if (!gesture.moved) useTool(point);
    drawObjects();
  }

  function keyboard(event) {
    if (!active() || !document.body.classList.contains('network-mode')) return;
    const typing = event.target.matches('input,textarea,select');
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && options.canSave) {
      event.preventDefault();
      saveNow();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !typing) {
      event.preventDefault();
      history(!event.shiftKey);
    } else if (event.key === 'Delete' && !typing && workspace.contains(event.target)) {
      removeObject();
    } else if (event.key === 'Escape') {
      changeTool('select');
    } else if (event.target === viewport && !event.altKey && !event.ctrlKey && !event.metaKey && tool !== 'pan') {
      const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const direction = arrows[event.key];
      if (!direction && event.key !== 'Enter') return;
      event.preventDefault();
      const point = keyboardPoint || boundPoint({ x: current().width / 2, y: current().height / 2 }, true);
      if (direction) {
        const step = model.gridStep(current().units) * (event.shiftKey ? 5 : 1);
        keyboardPoint = boundPoint({ x: point.x + direction[0] * step, y: point.y + direction[1] * step });
        hover = null;
        drawObjects();
        const x = stage.offsetLeft + keyboardPoint.x * pixelsPerMeter;
        const y = stage.offsetTop + keyboardPoint.y * pixelsPerMeter;
        viewport.scrollLeft = Math.max(x - viewport.clientWidth + 20, Math.min(viewport.scrollLeft, x - 20));
        viewport.scrollTop = Math.max(y - viewport.clientHeight + 20, Math.min(viewport.scrollTop, y - 20));
      } else useTool(point);
    }
  }

  function initialize() {
    if (initialized) return;
    initialized = true;
    $('wifiMaterial').innerHTML = choiceList(materialEntries(), 'drywall');
    $('wifiMount').innerHTML = choiceList(Object.entries(model.MOUNTS), 'ceiling');
    $('wifiLegend').innerHTML = model.LEVELS.map(level => `<span><i style="background:rgb(${level.color.slice(0, 3).join(',')})"></i>${level.label}</span>`).join('');
    $('wifiNewSite').addEventListener('click', () => startProject(blankPlan()));
    $('wifiSampleSite').addEventListener('click', () => startProject(samplePlan(), { activity: true }));
    $('wifiReloadSites').addEventListener('click', loadSites);
    $('wifiSavedSites').addEventListener('click', event => {
      const button = event.target.closest('button');
      if (button?.dataset.wifiOpen) openSaved(button.dataset.wifiOpen);
      if (button?.dataset.wifiDelete) deleteSaved(button.dataset.wifiDelete);
    });
    $('wifiNetworkBack').addEventListener('click', () => { hide(); options.onBack(); });
    $('wifiSiteBack').addEventListener('click', async () => { if (await leave()) showSites(); });
    $('wifiSiteTitle').addEventListener('input', event => {
      const title = cleanText(event.target.value, 'Untitled Wi-Fi Site');
      if (title === current().title) return;
      if (!session.titleEditing) {
        session.undo.push(session.plan);
        if (session.undo.length > 45) session.undo.shift();
        session.redo = [];
        session.titleEditing = true;
      }
      session.plan = { ...session.plan, title };
      session.sequence += 1;
      $('wifiUndo').disabled = false;
      $('wifiRedo').disabled = true;
      scheduleSave();
    });
    $('wifiSiteTitle').addEventListener('blur', event => {
      if (!active()) return;
      event.target.value = current().title;
      session.titleEditing = false;
    });
    $('wifiSaveSite').addEventListener('click', saveNow);
    $('wifiCopySite').addEventListener('click', saveCopy);
    $('wifiDiscardSite').addEventListener('click', () => {
      if (window.confirm('Discard the unsaved edits to this site?')) showSites();
    });
    $('wifiUndo').addEventListener('click', () => history(true));
    $('wifiRedo').addEventListener('click', () => history(false));
    $('wifiFit').addEventListener('click', fit);
    $('wifiZoomIn').addEventListener('click', () => zoom(1.25));
    $('wifiZoomOut').addEventListener('click', () => zoom(0.8));
    $('wifiCoverage').addEventListener('change', requestCoverage);
    $('wifiBand').addEventListener('change', event => update({ ...current(), band: event.target.value }));
    $('wifiUnits').addEventListener('change', event => update({ ...current(), units: event.target.value }));
    $('wifiWidth').addEventListener('change', event => resizePlan(event.target, 'width'));
    $('wifiHeight').addEventListener('change', event => resizePlan(event.target, 'height'));
    $('wifiSelection').addEventListener('change', event => { changeTool('select'); selectObject(event.target.value); });
    $('wifiProperties').addEventListener('change', event => editObject(event.target));
    $('wifiProperties').addEventListener('click', event => { if (event.target.id === 'wifiDeleteObject') removeObject(); });
    workspace.querySelectorAll('[data-wifi-tool]').forEach(button => {
      button.addEventListener('click', () => changeTool(button.dataset.wifiTool));
    });
    viewport.addEventListener('pointerdown', pointerDown);
    viewport.addEventListener('pointermove', pointerMove);
    viewport.addEventListener('pointerup', pointerUp);
    viewport.addEventListener('pointercancel', pointerUp);
    window.addEventListener('keydown', keyboard);
    window.addEventListener('eagle-context-updated', () => {
      if (!sameAccount() && (!library.hidden || !workspace.hidden)) { hide(); options.onBack(); }
    });
    new MutationObserver(() => {
      if (active() && !document.body.classList.contains('network-mode')) flushSave();
    }).observe(document.body, { attributeFilter: ['class'] });
    window.addEventListener('beforeunload', event => {
      if (active() && options.canSave && dirty(session)) {
        event.preventDefault();
        event.returnValue = '';
      }
    });
  }

  window.WifiSite = {
    async open(config) {
      options = config;
      account = options.authKey();
      initialize();
      showSites();
    },
    hide, leave,
  };
})();
