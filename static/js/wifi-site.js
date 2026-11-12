/* Scaled floor plan editor for EagleIDE Network Simulator. */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const model = window.WifiSiteModel;
  const view = window.WifiSiteView;
  const workspace = $('wifiWorkspace');
  const library = $('wifiSiteLibrary');
  const viewport = $('wifiViewport');
  const stage = $('wifiStage');
  const objects = $('wifiObjects');
  const grid = $('wifiGrid');
  const coverage = window.WifiSiteHeatmap.create($('wifiHeatmap'), updating => {
    $('wifiCoverageStatus').hidden = !updating;
  });
  const endpoint = '/api/network/wifi-sites';
  const wireKinds = window.WifiSiteCabling.kinds;
  const kinds = ['walls', 'access_points', 'labels', ...wireKinds];
  const wireTools = new Set(['equipment', 'cable', 'pass']);
  const drawTools = new Set(['room', 'wall', 'measure']);
  const toolHints = {
    select: 'Select an object to edit it. Drag to move it, or drag a selected wall’s end to resize it.',
    pan: 'Drag in any direction. Use Fit Site to return to your drawing.',
    room: 'Choose two opposite corners, or drag to draw a rectangular room.',
    wall: 'Drag a single wall or click to draw connected walls. Hold Shift for right angles.',
    ap: 'Choose a mount, then click or tap to place the access point.',
    label: 'Click or tap to place a note, then edit its text in Objects.',
    measure: 'Choose two points to measure the distance.',
    probe: 'Click or tap a spot to see the strongest access point and the walls in its path.',
    equipment: 'Choose a device and place it on the plan. Keystone jacks and ISP demarcations snap to walls.',
    cable: 'Choose Ethernet or fiber, then select the source device.',
    pass: 'Click a concrete wall to add a pass-through. Each holds 10 cables and needs 20 feet of spacing.',
  };

  let options;
  let account;
  let viewRequest = 0;
  let session;
  let tool = 'select';
  let selected = '';
  let previewAp = '';
  let anchor;
  let hover;
  let drag;
  let measure;
  let probe;
  let keyboardPoint;
  let camera = { x: 0, y: 0, scale: 16 };
  let dimensions = { width: 0, height: 0 };
  let endpoints = [];
  let wallSource;
  let indexedPlan;
  let objectIndex = new Map();
  let drawnWalls;
  let drawnWallSelection;
  let drawnAccessPoints;
  let drawnWiredAps;
  let drawnLabels;
  let drawnMarkerSelection;
  let listedObjects = [];
  let gridSize = 0;
  let gridCamera;
  let gridDimensions;
  let gridUnits;
  let sceneFrame = 0;
  let hoverJoined = false;
  let pinch;
  let spacePan = false;
  const touches = new Map();
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
  const fmt = meters => `${display(meters).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${current().units}`;
  const wires = window.WifiSiteCabling.create({
    catalog: () => options.catalog, limits: () => options.limits, getPlan: current, selected: () => selected, apNames: model.MOUNTS,
    select: selectObject, changeTool, add: addObjects, replace: replaceObject, draw: drawObjects, frame: scheduleScene,
    hint, escape, id, fmt, display, tidy: cleanText, toMeters: value => model.metersFrom(value, current().units),
    scale: () => camera.scale, snap: drawingPoint, line: lineSvg, dot, pointFields,
  });

  function blankPlan() {
    return {
      schema_version: 3, title: 'Untitled Wi-Fi Site',
      units: 'm', band: '5', walls: [], access_points: [], labels: [], equipment: [], pass_throughs: [], cables: [],
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
    plan.access_points = [{ id: id('ap'), x: 11, y: 14, mount: 'ceiling', angle: 0, power_db: 0, name: 'Classroom AP' }];
    plan.equipment = [{ id: id('device'), kind: 'access_switch', name: 'Classroom switch', x: 8, y: 16 }];
    plan.cables = [{
      id: id('wire'), media: 'ethernet', color: '#0879b3', label: '',
      source: { device_id: plan.equipment[0].id, port: 'ETH1' },
      target: { device_id: plan.access_points[0].id, port: 'ETH1' }, waypoints: [],
    }];
    plan.labels = [
      { id: id('label'), x: 8, y: 7, text: 'Room 1' },
      { id: id('label'), x: 25, y: 7, text: 'Room 2' },
    ];
    return plan;
  }

  function wiringSample() {
    const plan = samplePlan();
    plan.title = 'Classroom Cabling Activity';
    plan.walls[4].material = 'concrete';
    plan.access_points[0].x = 29;
    plan.equipment = [
      { id: id('device'), kind: 'router', name: 'Edge router', x: 10, y: 9 },
      { id: id('device'), kind: 'core_switch', name: 'Core switch', x: 10, y: 17 },
      { id: id('device'), kind: 'keystone', name: 'Classroom jack', wall_id: plan.walls[1].id, t: 0.65 },
    ];
    plan.pass_throughs = [{ id: id('pass'), wall_id: plan.walls[4].id, t: 0.55 }];
    plan.cables = [];
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
    $('wifiFinishWall').hidden = tool !== 'wall' || !anchor;
  }

  function changeTool(value) {
    tool = value;
    anchor = hover = keyboardPoint = null;
    hoverJoined = false;
    viewport.dataset.tool = value;
    workspace.querySelectorAll('[data-wifi-tool]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.wifiTool === value));
    });
    $('wifiMaterialField').hidden = !['wall', 'room'].includes(value);
    $('wifiMountField').hidden = value !== 'ap';
    $('wifiOrthogonalField').hidden = value !== 'wall' && value !== 'cable';
    hint();
    wires.setTool(value);
    if (current()) scheduleScene();
  }

  function startProject(plan, { activity = false, wiring = false } = {}) {
    const { id: siteId, revision, updated_at, ...layout } = plan;
    session = {
      id: siteId || id('site'), revision: revision || 0, plan: { ...blankPlan(), ...layout, schema_version: 3 }, account,
      sequence: 0, savedSequence: 0, undo: [], redo: [],
    };
    selected = previewAp = '';
    wires.reset();
    anchor = hover = drag = measure = probe = keyboardPoint = null;
    library.hidden = true;
    workspace.hidden = false;
    $('wifiActivity').hidden = !activity;
    $('wifiActivity').open = activity;
    $('wifiWiringGuide').hidden = !wiring;
    $('wifiWiringGuide').open = wiring;
    $('wifiSaveSite').hidden = $('wifiCopySite').hidden = !options.canSave;
    $('wifiCoverage').checked = $('wifiSnap').checked = $('wifiShowCables').checked = true;
    $('wifiOrthogonal').checked = false;
    status(options.canSave ? (revision ? 'Saved' : 'New project') : 'Guest preview');
    changeTool(activity ? 'probe' : wiring ? 'cable' : 'select');
    fit();
    render();
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
    selected = previewAp = '';
    wires.reset();
    drag = null;
    anchor = hover = measure = probe = keyboardPoint = pinch = null;
    touches.clear();
    if (sceneFrame) cancelAnimationFrame(sceneFrame);
    sceneFrame = 0;
    coverage.clear();
    $('wifiSavedSites').replaceChildren();
    $('wifiProperties').replaceChildren();
    for (const name of ['wifiWalls', 'wifiMarkers', 'wifiOverlay', 'wifiWireLayer', 'wifiEquipmentLayer']) $(name).replaceChildren();
    wallSource = drawnWalls = drawnAccessPoints = drawnWiredAps = drawnLabels = null;
    indexedPlan = null;
    objectIndex.clear();
    listedObjects = [];
    setSpacePan(false);
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
    if (!objectId) return null;
    const plan = current();
    if (indexedPlan !== plan) {
      indexedPlan = plan;
      objectIndex = new Map(kinds.flatMap(kind => plan[kind].map(item => [item.id, { kind, item }])));
    }
    return objectIndex.get(objectId) || null;
  }

  function objectName(kind, item, index) {
    if (wireKinds.includes(kind)) return wires.name(kind, item, index);
    if (kind === 'walls') return `${model.MATERIALS[item.material].name} wall ${index + 1}`;
    if (kind === 'labels') return item.text;
    return item.name || model.MOUNTS[item.mount];
  }

  function selectObject(objectId) {
    if (selected !== objectId) previewAp = '';
    selected = objectId;
    renderInspector();
    drawObjects();
    refreshCoverage();
  }

  function update(next, { inspector = true } = {}) {
    const error = wires.index(next).error;
    if (error) { hint(error); return false; }
    session.undo.push(session.plan);
    if (session.undo.length > 45) session.undo.shift();
    session.redo = [];
    setPlan(next, inspector);
    return true;
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
    wires.cancel();
    to.push(session.plan);
    finishWall();
    setPlan(from.pop());
  }

  function replaceObject(kind, item, refresh = true) {
    return update({ ...current(), [kind]: current()[kind].map(object => object.id === item.id ? item : object) }, { inspector: refresh });
  }

  function addObjects(kind, additions) {
    const existing = current()[kind];
    const limit = options.limits[kind];
    if (existing.length + additions.length > limit) {
      hint(`This site can contain up to ${limit} ${kind.replace('_', ' ')}.`);
      return false;
    }
    const previous = selected;
    selected = additions.at(-1).id;
    if (update({ ...current(), [kind]: [...existing, ...additions] })) return true;
    selected = previous;
    return false;
  }

  function removeObject() {
    const match = objectById(selected);
    if (!match) return;
    const { next, attached } = wires.removePlan(match);
    if (attached && !window.confirm(`Delete this object and ${attached} attached ${attached === 1 ? 'item' : 'items'}? You can undo this change.`)) return;
    if (update(next)) $('wifiSelection').focus();
  }

  function render({ inspector = true } = {}) {
    const plan = current();
    if (document.activeElement !== $('wifiSiteTitle')) $('wifiSiteTitle').value = plan.title;
    $('wifiUnits').value = plan.units;
    $('wifiBand').value = plan.band;
    if (wallSource !== plan.walls) {
      wallSource = plan.walls;
      endpoints = plan.walls.flatMap(wall => [{ ...wall.a, wallId: wall.id }, { ...wall.b, wallId: wall.id }]);
    }
    const extents = planExtents(plan);
    $('wifiSiteExtents').textContent = extents
      ? `Drawing extents: ${fmt(extents.right - extents.left)} × ${fmt(extents.bottom - extents.top)}`
      : 'Start drawing anywhere on the grid.';
    $('wifiUndo').disabled = !session.undo.length;
    $('wifiRedo').disabled = !session.redo.length;
    if (inspector) renderInspector();
    else renderObjectOptions();
    drawObjects();
    refreshCoverage();
    if (tool === 'cable') wires.refreshDraft();
  }

  function renderObjectOptions() {
    const plan = current();
    const input = $('wifiSelection');
    if (kinds.some((kind, index) => listedObjects[index] !== plan[kind])) {
      listedObjects = kinds.map(kind => plan[kind]);
      const groups = { walls: 'Walls', access_points: 'Access points', labels: 'Notes', equipment: 'Equipment',
        pass_throughs: 'Pass-throughs', cables: 'Cables' };
      input.innerHTML = '<option value="">None selected</option>' + kinds.filter(kind => plan[kind].length).map(kind =>
        `<optgroup label="${groups[kind]}">${plan[kind].map((item, index) =>
          `<option value="${escape(item.id)}">${escape(objectName(kind, item, index))}</option>`).join('')}</optgroup>`
      ).join('');
    }
    input.value = selected;
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
      panel.innerHTML = '<p>Select an object on the plan or from the list to edit it.</p>';
      return;
    }
    const { kind, item } = match;
    let fields;
    if (wireKinds.includes(kind)) {
      fields = wires.inspector(kind, item);
    } else if (kind === 'walls') {
      fields = `<label>Wall material<select data-wifi-field="material">${choiceList(materialEntries(), item.material)}</select></label>
        ${pointFields(item.a, 'a', 'Start ')}${pointFields(item.b, 'b', 'End ')}`;
    } else if (kind === 'access_points') {
      const data = wires.index();
      const cable = data.occupancy.get(`${item.id}:ETH1`);
      const connection = cable ? `<div class="wifi-wire-summary"><strong>Ethernet connected</strong><span>${data.powered.has(cable) ? 'PoE available' : 'No PoE source on this path'}</span></div>`
        : `<div class="wifi-wire-summary"><strong>Unwired</strong><span>Connect Ethernet to keep coverage on.</span></div>
          <label class="wifi-estimate-toggle"><input type="checkbox" id="wifiEstimateCoverage"${previewAp === item.id ? ' checked' : ''}> Estimated coverage</label>`;
      fields = connection + `<label>Access point label<input data-wifi-field="name" value="${escape(item.name)}" maxlength="60" placeholder="Optional"></label>
        <label>Mount<select data-wifi-field="mount">${choiceList(Object.entries(model.MOUNTS), item.mount)}</select></label>
        <label>Transmit power adjustment (dB)<input type="number" min="-12" max="6" step="1" data-wifi-field="power_db" value="${item.power_db}"></label>
        ${pointFields(item)}${item.mount === 'wall' ? `<label>Direction in degrees (0° points right)<input type="number" min="0" max="360" step="1" data-wifi-field="angle" value="${item.angle}"></label>` : ''}`;
    } else {
      fields = `<label>Note text<input data-wifi-field="text" value="${escape(item.text)}" maxlength="160"></label>${pointFields(item)}`;
    }
    panel.innerHTML = fields + `<div class="wifi-object-actions">
      <button class="wifi-control" id="wifiLocateObject" type="button">Locate</button>
      ${kind === 'cables' || kind === 'pass_throughs' || (kind === 'equipment' && item.wall_id) ? '' : '<button class="wifi-control" id="wifiDuplicateObject" type="button">Duplicate</button>'}
      <button class="wifi-control" id="wifiDeleteObject" type="button">Delete</button></div>`;
  }

  function materialEntries() {
    return Object.entries(model.MATERIALS).map(([key, material]) => [key, material.name]);
  }

  function editObject(input) {
    const match = objectById(selected);
    if (!match) return;
    if (input.id === 'wifiEstimateCoverage' && match.kind === 'access_points') {
      previewAp = input.checked ? match.item.id : '';
      refreshCoverage();
      return;
    }
    if (input.dataset.wifiWireField) { wires.edit(match, input); return; }
    if (!input.dataset.wifiField) return;
    const { kind, item } = match;
    const field = input.dataset.wifiField;
    const next = { ...item };
    if (/^[ab]?[xy]$/.test(field)) {
      const axis = field.at(-1);
      const part = field.length === 2 ? field[0] : null;
      const before = part ? item[part][axis] : item[axis];
      const value = input.value === '' ? before : coordinate(model.metersFrom(Number(input.value), current().units));
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
    } else if (field === 'power_db') {
      next.power_db = input.value === '' ? item.power_db : Math.max(-12, Math.min(6, Number(input.value)));
      input.value = next.power_db;
    } else {
      next[field] = cleanText(input.value, field === 'text' ? 'New note' : '');
      input.value = next[field];
    }
    if (!replaceObject(kind, next, field === 'mount')) {
      const before = /^[ab][xy]$/.test(field) ? item[field[0]][field[1]] : item[field];
      input.value = /^[ab]?[xy]$/.test(field) ? Number(display(before).toFixed(3)) : before;
    }
  }

  function coordinate(value) {
    return view.clamp(model.roundDistance(value), options.limits.coordinate);
  }

  function planExtents(plan) {
    const data = wires.index(plan);
    return view.bounds([...plan.walls.flatMap(wall => [wall.a, wall.b]), ...plan.access_points, ...plan.labels,
      ...plan.equipment.map(data.location), ...plan.pass_throughs.map(data.location),
      ...[...data.inspections.values()].flatMap(result => result.points)].filter(Boolean));
  }

  function drawGrid() {
    const units = current().units;
    if (gridCamera === camera && gridDimensions === dimensions && gridUnits === units) return;
    const unitsChanged = gridUnits !== units;
    gridCamera = camera;
    gridDimensions = dimensions;
    gridUnits = units;
    const { width, height } = dimensions;
    const visibleWidth = width / camera.scale;
    const visibleHeight = height / camera.scale;
    const box = `${camera.x} ${camera.y} ${visibleWidth} ${visibleHeight}`;
    grid.setAttribute('viewBox', box);
    objects.setAttribute('viewBox', box);
    objects.style.setProperty('--wifi-marker-scale', String(1 / camera.scale));
    viewport.toggleAttribute('data-wifi-overview', camera.scale < 0.8);
    const spacing = view.gridSpacing(camera.scale, model.gridStep(units));
    if (gridSize !== spacing) {
      gridSize = spacing;
      const major = spacing * 5;
      grid.innerHTML = `<defs>
        <pattern id="wifiMinorGrid" width="${spacing}" height="${spacing}" patternUnits="userSpaceOnUse">
          <path class="wifi-minor-line" d="M 0 ${spacing} V 0 H ${spacing}"/>
        </pattern>
        <pattern id="wifiMajorGrid" width="${major}" height="${major}" patternUnits="userSpaceOnUse">
          <path class="wifi-major-line" d="M 0 ${major} V 0 H ${major}"/>
        </pattern>
      </defs><rect fill="url(#wifiMinorGrid)"/><rect fill="url(#wifiMajorGrid)"/><path class="wifi-origin"/>`;
    }
    if (unitsChanged || $('wifiGridLabel').dataset.step !== String(spacing)) {
      $('wifiGridLabel').dataset.step = String(spacing);
      $('wifiGridLabel').textContent = `Grid spacing: ${fmt(spacing)}`;
    }
    for (const rect of grid.querySelectorAll('rect')) {
      rect.setAttribute('x', camera.x);
      rect.setAttribute('y', camera.y);
      rect.setAttribute('width', visibleWidth);
      rect.setAttribute('height', visibleHeight);
    }
    grid.querySelector('.wifi-origin').setAttribute('d',
      `M 0 ${camera.y} V ${camera.y + visibleHeight} M ${camera.x} 0 H ${camera.x + visibleWidth}`);
    const scale = view.scaleBar(camera.scale, model.metersFrom(1, units));
    $('wifiScale').querySelector('span').style.width = `${scale * camera.scale}px`;
    $('wifiScale').querySelector('strong').textContent = fmt(scale);
  }

  function lineSvg(a, b, attrs = '') {
    return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" ${attrs}/>`;
  }

  function dot(point, radius, className, extra = '') {
    return `<circle cx="${point.x}" cy="${point.y}" r="${radius / camera.scale}" class="${className}" ${extra}/>`;
  }

  function marker(item, kind, ghost = false) {
    const object = ghost ? 'class="wifi-ghost"' : `data-wifi-object="${escape(item.id)}"`;
    const selectedClass = selected === item.id ? ' is-selected' : '';
    let content;
    if (kind === 'access_points') {
      const connected = wires.index().wired.has(item.id);
      const direction = item.mount === 'wall' ? `<path class="wifi-direction" transform="rotate(${item.angle})" d="M 9 0 L 20 0 M 16 -4 L 20 0 L 16 4"/>` : '';
      content = `<circle r="11" class="wifi-ap${connected ? '' : ' wifi-ap-unwired'}${selectedClass}"/>${direction}
        <path class="wifi-radio" d="M -6 -2 Q 0 -8 6 -2 M -3 1 Q 0 -2 3 1 M 0 4 h .1"/>
        ${connected ? '<circle class="wifi-ap-connected" cx="8" cy="8" r="3.6"/>' : ''}
        ${item.name ? `<text class="wifi-ap-text" x="14" y="-8">${escape(item.name)}</text>` : ''}`;
    } else {
      const text = item.text.length > 32 ? `${item.text.slice(0, 31)}…` : item.text;
      content = `<title>${escape(item.text)}</title><circle r="5" class="wifi-note-pin${selectedClass}"/>
        <text class="wifi-note-text" x="8" y="-7">${escape(text)}</text>`;
    }
    return `<g transform="translate(${item.x} ${item.y})" ${object}><g class="wifi-marker">${content}</g></g>`;
  }

  function drawObjects() {
    const plan = current();
    const selectionKind = objectById(selected)?.kind;
    const wallSelection = selectionKind === 'walls' ? selected : '';
    const markerSelection = selectionKind && selectionKind !== 'walls' ? selected : '';
    if (drawnWalls !== plan.walls || drawnWallSelection !== wallSelection) {
      $('wifiWalls').innerHTML = plan.walls.map(wall => {
        const object = `data-wifi-object="${escape(wall.id)}"`;
        const highlight = wallSelection === wall.id ? lineSvg(wall.a, wall.b, 'class="wifi-selected-wall"') : '';
        return highlight + lineSvg(wall.a, wall.b, `class="wifi-wall" stroke="${model.MATERIALS[wall.material].color}"`)
          + lineSvg(wall.a, wall.b, `class="wifi-wall-hit" ${object}`);
      }).join('');
      drawnWalls = plan.walls;
      drawnWallSelection = wallSelection;
    }
    const wired = wires.index().wired;
    if (drawnAccessPoints !== plan.access_points || drawnLabels !== plan.labels || drawnMarkerSelection !== markerSelection || drawnWiredAps !== wired) {
      $('wifiMarkers').innerHTML = plan.access_points.map(ap => marker(ap, 'access_points')).join('')
        + plan.labels.map(label => marker(label, 'labels')).join('');
      drawnAccessPoints = plan.access_points;
      drawnWiredAps = wired;
      drawnLabels = plan.labels;
      drawnMarkerSelection = markerSelection;
    }
    wires.draw();
    scheduleScene();
  }

  function drawOverlay() {
    const parts = [];
    const ghost = drag?.preview;
    const match = objectById(selected);
    if (match?.kind === 'walls') {
      const wall = ghost?.id === selected ? ghost : match.item;
      const attr = `data-wifi-object="${escape(wall.id)}"`;
      parts.push(dot(wall.a, 6, 'wifi-handle', `${attr} data-wifi-end="a"`),
        dot(wall.b, 6, 'wifi-handle', `${attr} data-wifi-end="b"`));
    }
    if (ghost && !wireKinds.includes(drag.match.kind)) {
      parts.push(ghost.a ? lineSvg(ghost.a, ghost.b, 'class="wifi-preview-line"') : marker(ghost, drag.match.kind, true));
    }
    parts.push(wires.overlay(ghost, drag?.match?.kind));
    if (probe) {
      if (probe.result) parts.push(lineSvg(probe.result.ap, probe.point, 'class="wifi-probe-path"'));
      parts.push(dot(probe.point, 6, 'wifi-probe-point'));
    }
    if (measure) parts.push(lineSvg(measure.a, measure.b, 'class="wifi-preview-line"'), dot(measure.b, 4, 'wifi-cursor'));
    const start = drag?.draw ? drag.start : anchor;
    const end = drag?.draw ? drag.point : hover || keyboardPoint;
    let readout = measure ? `Distance: ${fmt(model.distance(measure.a, measure.b))}` : '';
    if (start) {
      parts.push(dot(start, 5, 'wifi-cursor'));
      if (end) {
        if (tool === 'room') {
          const width = Math.abs(start.x - end.x), height = Math.abs(start.y - end.y);
          parts.push(`<rect class="wifi-preview-line" x="${Math.min(start.x, end.x)}" y="${Math.min(start.y, end.y)}" width="${width}" height="${height}"/>`);
          readout = `Room: ${fmt(width)} × ${fmt(height)}`;
        } else {
          parts.push(lineSvg(start, end, 'class="wifi-preview-line"'));
          readout = `${tool === 'wall' ? 'Wall' : 'Distance'}: ${fmt(model.distance(start, end))}`;
        }
      }
    }
    if (hover && hoverJoined) parts.push(dot(hover, 6, 'wifi-cursor wifi-join-point'));
    if (keyboardPoint) parts.push(dot(keyboardPoint, 6, 'wifi-cursor'));
    $('wifiOverlay').innerHTML = parts.join('');
    if ($('wifiMeasureResult').textContent !== readout) $('wifiMeasureResult').textContent = readout;
  }

  function scheduleScene() {
    if (!sceneFrame) sceneFrame = requestAnimationFrame(() => {
      sceneFrame = 0;
      if (!active() || !dimensions.width || !dimensions.height) return;
      drawGrid();
      drawOverlay();
      coverage.setView(camera, dimensions.width, dimensions.height, $('wifiCoverage').checked);
    });
  }

  function center() {
    return { x: dimensions.width / 2, y: dimensions.height / 2 };
  }

  function fit() {
    if (!active()) return;
    dimensions = { width: viewport.clientWidth, height: viewport.clientHeight };
    camera = view.fitCamera(planExtents(current()), dimensions.width, dimensions.height);
    scheduleScene();
  }

  function resizeViewport() {
    if (!active()) return;
    const width = viewport.clientWidth, height = viewport.clientHeight;
    if (!width || !height || (width === dimensions.width && height === dimensions.height)) return;
    const point = view.screenToWorld(camera, center());
    dimensions = { width, height };
    camera = view.placeWorldPoint(point, center(), camera.scale);
    scheduleScene();
  }

  function zoom(factor, at = center()) {
    camera = view.zoomAt(camera, at, factor);
    scheduleScene();
  }

  function locateSelected() {
    const match = objectById(selected);
    if (!match) return;
    const { item } = match;
    const points = wireKinds.includes(match.kind) ? wires.locationPoints(match) : item.a ? [item.a, item.b] : [item];
    camera = view.fitCamera(view.bounds(points), dimensions.width, dimensions.height);
    scheduleScene();
    viewport.focus({ preventScroll: true });
  }

  function duplicateSelected() {
    const match = objectById(selected);
    if (!match || match.kind === 'cables' || match.kind === 'pass_throughs' || match.item.wall_id) return;
    const { kind, item } = match;
    const offset = gridSize || model.gridStep(current().units);
    const shift = point => ({ x: coordinate(point.x + offset), y: coordinate(point.y + offset) });
    const copy = { ...item, id: id(kind === 'walls' ? 'wall' : kind === 'access_points' ? 'ap' : 'label'),
      ...(item.a ? { a: shift(item.a), b: shift(item.b) } : shift(item)) };
    if (!item.a || model.distance(copy.a, copy.b) >= 0.05) addObjects(kind, [copy]);
  }

  function transmittingAps() {
    const wired = wires.index().wired;
    if (previewAp !== selected || wired.has(previewAp)) previewAp = '';
    return current().access_points.filter(ap => wired.has(ap.id) || ap.id === previewAp);
  }

  function refreshCoverage() {
    const plan = current();
    const access_points = transmittingAps();
    coverage.setPlan({ ...plan, access_points });
    renderProbe(access_points);
    scheduleScene();
  }

  function renderProbe(accessPoints = transmittingAps()) {
    const readout = $('wifiProbeResult');
    const summary = $('wifiProbeSummary');
    summary.textContent = '';
    if (!probe) {
      readout.textContent = 'Use Check Signal and choose a spot on the plan.';
      return;
    }
    const plan = current();
    const estimate = model.coverageModel(plan.walls, accessPoints, plan.band);
    probe.result = estimate(probe.point, true);
    if (!probe.result) {
      readout.textContent = 'Connect an access point or select an unwired AP and turn on Estimated coverage.';
      return;
    }
    const { ap, signal, distance, walls, alternate } = probe.result;
    const crossed = walls.map(material => model.MATERIALS[material].name).join(', ');
    summary.textContent = `${Math.round(signal)} dBm · ${model.signalLevel(signal).label}${ap.id === previewAp ? ' · preview' : ''}`;
    readout.innerHTML = `<strong>${summary.textContent}</strong>
      <p>${escape(ap.name || model.MOUNTS[ap.mount])} · ${fmt(distance)} away</p>
      <p>Walls crossed: ${crossed || 'None'}</p>
      ${alternate ? `<p>Second AP: ${escape(alternate.ap.name || model.MOUNTS[alternate.ap.mount])} · ${Math.round(alternate.signal)} dBm</p>` : ''}`;
  }

  function screenPoint(event) {
    const box = stage.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }

  function drawingPoint(point, { origin, rightAngles = false, join = false, exclude } = {}) {
    const snap = $('wifiSnap').checked;
    const result = view.snapConstruction(point, {
      origin, orthogonal: rightAngles,
      step: snap ? view.gridSpacing(camera.scale, model.gridStep(current().units)) : 0,
      endpoints: snap && join ? endpoints : [], exclude, tolerance: 10 / camera.scale,
    });
    return { point: { x: coordinate(result.point.x), y: coordinate(result.point.y) }, joined: result.joined };
  }

  function positionFor(raw, origin, shift = false) {
    if (['measure', 'probe', 'select'].includes(tool)) {
      return { point: { x: coordinate(raw.x), y: coordinate(raw.y) }, joined: false };
    }
    return drawingPoint(raw, {
      origin, rightAngles: tool === 'wall' && (shift || $('wifiOrthogonal').checked),
      join: tool === 'wall' || tool === 'room',
    });
  }

  function drawFrom(a, b) {
    if (tool === 'measure') {
      measure = { a, b };
      scheduleScene();
      return true;
    }
    if (tool === 'wall' && model.distance(a, b) >= 0.05) return addObjects('walls', [line(a, b)]);
    if (tool === 'room' && Math.min(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) >= 0.05) {
      return addObjects('walls', rectangle(a, b));
    }
    hint('Choose two distinct points to draw.');
    return false;
  }

  function finishWall() {
    anchor = hover = null;
    hoverJoined = false;
    hint();
    scheduleScene();
  }

  function useTool(point, hit, shift) {
    if (wireTools.has(tool)) { wires.use(point, hit, shift); return; }
    if (drawTools.has(tool)) {
      if (!anchor) {
        anchor = point;
        hint(tool === 'room' ? 'Choose the opposite corner.' : 'Choose the end point.');
      } else if (drawFrom(anchor, point)) {
        if (tool === 'wall') {
          anchor = point;
          hint('Click to continue the wall, or press Escape to finish.');
        } else {
          finishWall();
        }
      }
      hover = null;
      hoverJoined = false;
    } else if (tool === 'ap') {
      addObjects('access_points', [{ id: id('ap'), ...point, name: '', mount: $('wifiMount').value, angle: 0, power_db: 0 }]);
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
    scheduleScene();
  }

  function movedObject(item, end, start, point, bend, shift) {
    if (item.waypoints) return bend === undefined ? item : wires.moveBend(item, bend, point, shift);
    const dx = point.x - start.x, dy = point.y - start.y;
    if (item.wall_id) {
      const location = wires.index().location(item);
      return wires.pointForEdit(item, { x: location.x + dx, y: location.y + dy });
    }
    const aim = part => ({ x: part.x + dx, y: part.y + dy });
    if (!item.a) return { ...item, ...drawingPoint(aim(item)).point };
    if (end) {
      const changed = { ...item, [end]: drawingPoint(aim(item[end]), { join: true, exclude: item.id }).point };
      return model.distance(changed.a, changed.b) >= 0.05 ? changed : item;
    }
    const target = drawingPoint(aim(item.a), { join: true, exclude: item.id }).point;
    const translate = part => ({ x: coordinate(part.x + target.x - item.a.x), y: coordinate(part.y + target.y - item.a.y) });
    const a = translate(item.a), b = translate(item.b);
    return model.distance(a, b) >= 0.05 ? { ...item, a, b } : item;
  }

  function touchPair() {
    const [a, b] = touches.values();
    return { middle: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, distance: model.distance(a, b) };
  }

  function pointerDown(event) {
    if ((event.button !== 0 && event.button !== 1) || event.target.closest('#wifiCableBundleMenu')) return;
    const screen = screenPoint(event);
    if (event.pointerType === 'touch') {
      if (touches.size >= 2) return;
      touches.set(event.pointerId, screen);
      viewport.setPointerCapture(event.pointerId);
      if (touches.size === 2) {
        const { middle, distance } = touchPair();
        pinch = { world: view.screenToWorld(camera, middle), distance: Math.max(1, distance), scale: camera.scale };
        drag = hover = null;
        scheduleScene();
        return;
      }
    }
    if (drag) return;
    event.preventDefault();
    viewport.focus({ preventScroll: true });
    viewport.setPointerCapture(event.pointerId);
    keyboardPoint = null;
    const hit = event.target.closest('[data-wifi-object]');
    const bundle = event.target.closest('[data-wifi-bundle]');
    const raw = view.screenToWorld(camera, screen);
    const pan = tool === 'pan' || spacePan || event.button === 1;
    const draw = !pan && drawTools.has(tool) && !anchor;
    drag = {
      id: event.pointerId, screen, camera, raw, pan, draw,
      start: draw ? positionFor(raw, null).point : null,
      match: !pan && tool === 'select' && hit ? objectById(hit.dataset.wifiObject) : null,
      hit: hit?.dataset.wifiObject,
      bundle: bundle ? Number(bundle.dataset.wifiBundle) : null,
      bend: hit?.dataset.wifiBend === undefined ? undefined : Number(hit.dataset.wifiBend),
      end: hit?.dataset.wifiEnd,
    };
    viewport.toggleAttribute('data-panning', pan);
  }

  function pointerMove(event) {
    const screen = screenPoint(event);
    if (touches.has(event.pointerId)) {
      touches.set(event.pointerId, screen);
      if (pinch && touches.size === 2) {
        const { middle, distance } = touchPair();
        camera = view.placeWorldPoint(pinch.world, middle, pinch.scale * distance / pinch.distance);
        scheduleScene();
        return;
      }
    }
    const raw = view.screenToWorld(camera, screen);
    if (!drag) {
      if (wireTools.has(tool) && event.pointerType !== 'touch') {
        wires.hoverAt(raw, event.shiftKey);
        scheduleScene();
      }
      if (event.pointerType !== 'touch' && (anchor || tool === 'wall' || tool === 'room')) {
        const snap = positionFor(raw, anchor, event.shiftKey);
        hover = snap.point;
        hoverJoined = snap.joined;
        scheduleScene();
      }
      return;
    }
    if (drag.id !== event.pointerId) return;
    const dx = screen.x - drag.screen.x, dy = screen.y - drag.screen.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    if (!drag.moved && drag.match) selectObject(drag.match.item.id);
    drag.moved = true;
    if (drag.pan) {
      camera = { ...drag.camera, x: drag.camera.x - dx / drag.camera.scale, y: drag.camera.y - dy / drag.camera.scale };
    } else if (drag.match) {
      drag.preview = movedObject(drag.match.item, drag.end, drag.raw, raw, drag.bend, event.shiftKey);
    } else if (drag.draw) {
      drag.point = positionFor(raw, drag.start, event.shiftKey).point;
    }
    scheduleScene();
  }

  function pointerUp(event) {
    if (touches.delete(event.pointerId) && pinch) {
      pinch = null;
      return;
    }
    if (drag?.id !== event.pointerId) return;
    const gesture = drag;
    drag = null;
    viewport.toggleAttribute('data-panning', spacePan);
    scheduleScene();
    if (event.type === 'pointercancel' || gesture.pan) return;
    const raw = view.screenToWorld(camera, screenPoint(event));
    if (gesture.preview && JSON.stringify(gesture.preview) !== JSON.stringify(gesture.match.item)) {
      replaceObject(gesture.match.kind, gesture.preview);
    } else if (gesture.draw && gesture.moved) {
      drawFrom(gesture.start, positionFor(raw, gesture.start, event.shiftKey).point);
    } else if (!gesture.moved && tool === 'select') {
      if (gesture.bundle !== null && !gesture.match) wires.pick(gesture.bundle, gesture.screen);
      else { wires.hideMenu(); selectObject(gesture.match?.item.id || ''); }
    } else if (!gesture.moved) {
      const point = wireTools.has(tool) ? raw : positionFor(raw, anchor, event.shiftKey).point;
      useTool(point, gesture.hit, event.shiftKey);
    }
  }

  function wheel(event) {
    if (event.target.closest('#wifiCableBundleMenu')) return;
    event.preventDefault();
    const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? dimensions.height : 1;
    if (!event.ctrlKey && (event.shiftKey || (!event.deltaY && event.deltaX))) {
      camera = { ...camera, x: camera.x + (event.deltaX || event.deltaY) * multiplier / camera.scale };
      scheduleScene();
    } else {
      const delta = Math.max(-240, Math.min(240, event.deltaY * multiplier));
      zoom(Math.exp(-delta * 0.0025), screenPoint(event));
    }
  }

  function setSpacePan(enabled) {
    spacePan = enabled;
    viewport.toggleAttribute('data-panning', enabled || !!drag?.pan);
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
      if (wires.cancel()) return;
      if (anchor) finishWall();
      else if (tool === 'select' && selected) selectObject('');
      else changeTool('select');
    } else if (event.target === viewport && !event.altKey && !event.ctrlKey && !event.metaKey) {
      keyboardOnPlan(event);
    }
  }

  function keyboardOnPlan(event) {
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const direction = arrows[event.key];
    if (event.code === 'Space') {
      event.preventDefault();
      setSpacePan(true);
      return;
    }
    if (event.key === '+' || event.key === '=' || event.key === '-') {
      event.preventDefault();
      zoom(event.key === '-' ? 0.8 : 1.25);
      return;
    }
    if (!direction && event.key !== 'Enter') return;
    event.preventDefault();
    if (tool === 'pan' || spacePan) {
      if (direction) {
        camera = { ...camera, x: camera.x + direction[0] * 80 / camera.scale, y: camera.y + direction[1] * 80 / camera.scale };
        scheduleScene();
      }
      return;
    }
    const point = keyboardPoint || positionFor(view.screenToWorld(camera, center()), anchor).point;
    if (!direction) {
      useTool(positionFor(point, anchor).point);
      return;
    }
    const step = view.gridSpacing(camera.scale, model.gridStep(current().units)) * (event.shiftKey ? 5 : 1);
    keyboardPoint = { x: coordinate(point.x + direction[0] * step), y: coordinate(point.y + direction[1] * step) };
    hover = null;
    const screen = view.worldToScreen(camera, keyboardPoint);
    if (screen.x < 24 || screen.y < 24 || screen.x > dimensions.width - 24 || screen.y > dimensions.height - 24) {
      camera = view.placeWorldPoint(keyboardPoint, center(), camera.scale);
    }
    scheduleScene();
  }

  function initialize() {
    if (initialized) return;
    initialized = true;
    $('wifiMaterial').innerHTML = choiceList(materialEntries(), 'drywall');
    $('wifiMount').innerHTML = choiceList(Object.entries(model.MOUNTS), 'ceiling');
    const levels = [...model.LEVELS].reverse();
    const colors = levels.map(level => `rgb(${level.color.slice(0, 3).join(',')})`).join(',');
    $('wifiLegend').innerHTML = `<div class="wifi-legend-scale" style="background:linear-gradient(90deg,${colors})"></div>
      <div class="wifi-legend-labels">${levels.map(level => `<span>${level.label}</span>`).join('')}</div>`;
    $('wifiNewSite').addEventListener('click', () => startProject(blankPlan()));
    $('wifiSampleSite').addEventListener('click', () => startProject(samplePlan(), { activity: true }));
    $('wifiWiringSample').addEventListener('click', () => startProject(wiringSample(), { wiring: true }));
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
    $('wifiCoverage').addEventListener('change', scheduleScene);
    $('wifiBand').addEventListener('change', event => update({ ...current(), band: event.target.value }));
    $('wifiUnits').addEventListener('change', event => update({ ...current(), units: event.target.value }));
    $('wifiFinishWall').addEventListener('click', () => {
      finishWall();
      viewport.focus({ preventScroll: true });
    });
    $('wifiSelection').addEventListener('change', event => { changeTool('select'); selectObject(event.target.value); });
    $('wifiProperties').addEventListener('change', event => editObject(event.target));
    $('wifiProperties').addEventListener('click', event => {
      if (event.target.id === 'wifiDeleteObject') removeObject();
      if (event.target.id === 'wifiLocateObject') locateSelected();
      if (event.target.id === 'wifiDuplicateObject') duplicateSelected();
      const match = objectById(selected);
      if (match?.kind === 'cables' && event.target.id === 'wifiRerouteCable') wires.reroute(match.item);
      if (match?.kind === 'cables' && event.target.id === 'wifiRemoveCableBend' && match.item.waypoints.length) {
        replaceObject('cables', { ...match.item, waypoints: match.item.waypoints.slice(0, -1) });
      }
    });
    workspace.querySelectorAll('[data-wifi-tool]').forEach(button => {
      button.addEventListener('click', () => changeTool(button.dataset.wifiTool));
    });
    viewport.addEventListener('pointerdown', pointerDown);
    viewport.addEventListener('pointermove', pointerMove);
    viewport.addEventListener('pointerup', pointerUp);
    viewport.addEventListener('pointercancel', pointerUp);
    viewport.addEventListener('pointerleave', () => {
      if (!drag) { hover = null; hoverJoined = false; wires.clearHover(); scheduleScene(); }
    });
    viewport.addEventListener('wheel', wheel, { passive: false });
    viewport.addEventListener('auxclick', event => { if (event.button === 1) event.preventDefault(); });
    new ResizeObserver(resizeViewport).observe(viewport);
    window.addEventListener('keydown', keyboard);
    window.addEventListener('keyup', event => { if (event.code === 'Space' && spacePan) setSpacePan(false); });
    window.addEventListener('blur', () => setSpacePan(false));
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
    wires.init();
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
