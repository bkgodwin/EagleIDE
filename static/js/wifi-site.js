/* Infra Sim floor plan editor. */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const model = window.WifiSiteModel;
  const cableModel = window.WifiCablingModel;
  const clientModel = window.WifiSiteClientModel;
  const design = window.WifiSiteDesign;
  const view = window.WifiSiteView;
  const workspace = $('wifiWorkspace');
  const library = $('networkLibrary');
  const viewport = $('wifiViewport');
  const stage = $('wifiStage');
  const objects = $('wifiObjects');
  const grid = $('wifiGrid');
  const scenarioDialog = $('wifiScenarioDialog');
  const tutorialDialog = $('wifiTutorialDialog');
  const coverage = window.WifiSiteHeatmap.create($('wifiHeatmap'), updating => {
    $('wifiCoverageStatus').hidden = !updating;
  });
  const endpoint = '/api/network/wifi-sites';
  const starterEndpoint = '/api/network/wifi-starter';
  const schemaVersion = 13;
  const wireKinds = window.WifiSiteCabling.kinds;
  const floorKinds = ['walls', 'openings', 'labels', 'decor', 'surfaces'];
  const floorLayers = [...floorKinds, 'background', 'background_color'];
  const networkKinds = ['access_points', ...wireKinds];
  const kinds = ['walls', 'openings', 'access_points', 'labels', 'decor', 'surfaces', ...wireKinds];
  const floorTools = new Set(['wall', 'room', 'door', 'window', 'label', 'decor', 'paint', 'surface', 'background-move', 'background-scale']);
  const panels = { plan: $('wifiPlanPanel'), background: $('wifiBackgroundPanel'), signal: $('wifiSignalPanel'), object: $('wifiObjectPanel') };
  const wireTools = new Set(['equipment', 'cable', 'pass']);
  const drawTools = new Set(['room', 'wall', 'measure']);
  const toolHints = {
    select: 'Click to edit or drag to move. Shift-click to add or remove objects from a selection.',
    marquee: 'Drag a box to select objects. Hold Shift to add. Drag a selected object to move the group.',
    pan: 'Drag in any direction. Use Fit Site to return to your drawing.',
    room: 'Choose two opposite corners, or drag to draw a rectangular room.',
    wall: 'Drag a single wall or click to draw connected walls. Hold Shift for right angles.',
    door: 'Choose a material, then click a wall. None leaves a clear opening for Wi-Fi.',
    window: 'Click a wall to place a window. Choose its size and glass in the floating inspector.',
    label: 'Click or tap to place a note, then edit its text in Objects.',
    decor: 'Choose a symbol, then click or tap to place it. Select a placed symbol to rotate or move it.',
    paint: 'Choose a color, then click an enclosed room or the open background. Clear Fill removes the color.',
    surface: 'Click the corners of a surface, then choose Finish Surface or click its first corner.',
    measure: 'Choose two points to measure the distance.',
    probe: 'Click or tap a spot to see the strongest access point and the walls in its path.',
    equipment: 'Choose a device, preview its position, then click to place it. Wall-mounted devices snap to walls.',
    cable: 'Choose Ethernet or fiber, then select the source device.',
    pass: 'Click a concrete wall to add a pass-through. Each holds 10 cables and needs 20 feet of spacing.',
  };

  let options;
  let account;
  let session;
  let tool = 'select';
  let selected = '';
  let selection = new Set();
  let openPanel = '';
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
  let drawnBand;
  let drawnWalls, drawnWallOpenings, drawSpans;
  let overlayMarkup = '';
  let markerLabels, markerScale;
  const labelMetrics = document.createElement('canvas').getContext('2d');
  let drawnWallSelection;
  let drawnAccessPoints;
  let drawnPoweredAps;
  let drawnLabels;
  let drawnMarkerSelection;
  let listedObjects = [];
  let listedLocked;
  let listedSsids;
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
  let surfaceDraft = [];
  let roomWalls, roomFaces, drawnDecor, drawnSurfaces, drawnDesignSelection;

  const current = () => session?.plan;
  const floorLocked = () => current()?.floor_locked === true;
  const sameFloor = plan => floorLayers.every(layer => plan[layer] === current()[layer]);
  const selectableKinds = () => floorLocked() ? networkKinds : kinds;
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
    select: selectObject, changeTool, focusPlan: () => viewport.focus({ preventScroll: true }),
    showGuidedPicker: select => starterGuide.showPicker(select),
    placeConfirmation(button, point) {
      const { x, y } = view.worldToScreen(camera, point);
      if (x < 0 || y < 0 || x > dimensions.width || y > dimensions.height) return false;
      button.style.left = `${Math.max(4, Math.min(dimensions.width - 36, x + 15))}px`;
      button.style.top = `${Math.max(4, Math.min(dimensions.height - 35, y - 39))}px`;
      return true;
    }, add: addObjects, replace: replaceObject, draw: drawObjects, frame: scheduleScene,
    hint, escape, id, fmt, display, tidy: cleanText, toMeters: value => model.metersFrom(value, current().units),
    scale: () => camera.scale, snap: drawingPoint, line: lineSvg, dot, pointFields, marker, roundPoint,
    wallSpans: (walls, openings) => structure.wallSpans(walls, openings),
    clientInspector: item => clients.inspector(item),
    deviceInspector: item => networkSettings.deviceInspector(item),
    exhaustedRouters: () => [...clients.network().routers.values()].filter(router => router.available === 0).map(router => router.id),
  });
  const serviceNames = () => options.catalog.server_services;
  const clients = window.WifiSiteClients.create({ plan: current, cabling: () => wires.index(), escape, selected: inspectorId, serviceNames, onPacket: recordStarterPing,
    networkInspector: (item, info) => networkSettings.clientInspector(item, info) });
  const starterGuide = window.WifiStarterGuide.create({ workspace, escape, fit, locate: locateStarterTarget,
    recheck: checkStarterLesson, reset: resetStarter, resolve: projectStarterGhost,
    selectedId: inspectorId, findTarget: findStarterDevice, icon: kind =>
    window.WifiSiteCabling.icon(({ ap1: 'access_point', ap2: 'access_point', camera: 'poe_camera' })[kind] || kind) });
  const racks = window.WifiSiteRacks.create({
    plan: current, data: () => wires.index(), catalog: () => options.catalog, escape, id,
    add: (kind, additions) => addObjects(kind, additions, { select: false }), replace: replaceObject,
    inspector: $('wifiProperties'), renderInspector,
    removeCable: cable => update({ ...current(), cables: current().cables.filter(item => item.id !== cable) }),
  });
  const networkSettings = window.WifiSiteNetwork.create({
    plan: current, cabling: () => wires.index(), graph: clients.network, update, replace: replaceObject,
    render: renderInspector, hint, escape, choices: choiceList, id, limits: () => options.limits, serviceNames,
  });
  const structure = window.WifiSiteStructure.create({
    plan: current, project: () => session, walls: () => wires.index().walls, selected: () => selected,
    scale: () => camera.scale, id, escape, add: addObjects, replace: replaceObject, hint, line: lineSvg, dot,
    frame: scheduleScene, choices: choiceList, fmt, number: meters => Number(display(meters).toFixed(4)),
    toMeters: value => model.metersFrom(value, current().units), coordinate, showPanel, changeTool,
    initialImageBounds: (width, height) => {
      const worldWidth = Math.max(0.1, Math.min(10000, Math.min(dimensions.width * 0.66, dimensions.height * 0.66 * width / height) / camera.scale));
      const point = view.screenToWorld(camera, center());
      return { x: coordinate(point.x - worldWidth / 2), y: coordinate(point.y - worldWidth * height / width / 2), width: worldWidth };
    },
    updateBackground: background => update({ ...current(), background }),
  });

  function blankPlan() {
    return {
      schema_version: schemaVersion, title: 'Untitled Wi-Fi Site',
      units: 'm', band: '5', floor_locked: false, walls: [], openings: [], background: null, access_points: [], labels: [], equipment: [], pass_throughs: [], cables: [],
      decor: [], surfaces: [], background_color: null, ssids: [{ ...clientModel.DEFAULT_SSID }], vlans: [],
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

  function status(message, kind = '') {
    $('wifiSaveStatus').textContent = message;
    $('wifiSaveStatus').dataset.kind = kind;
    $('wifiSaveSite').textContent = kind === 'error' && !session?.conflict ? 'Retry Save' : 'Save';
    $('wifiSaveSite').disabled = !!(session?.conflict || session?.copying);
    $('wifiCopySite').disabled = !!session?.copying;
    $('wifiDiscardSite').hidden = kind !== 'error';
  }

  function hint(message) {
    if (message && racks.isOpen()) racks.announce(message);
    const lockedHint = tool === 'select' ? 'Select or drag networking equipment and cables.' :
      tool === 'marquee' ? 'Drag a box to select networking objects.' : toolHints[tool];
    $('wifiToolHint').textContent = message || (floorLocked() ? `Floor plan locked. ${lockedHint}` : toolHints[tool]);
    $('wifiFinishWall').hidden = tool !== 'wall' || !anchor;
    $('wifiFinishSurface').disabled = surfaceDraft.length < 3;
    $('wifiCancelSurface').disabled = !surfaceDraft.length;
  }

  function changeTool(value) {
    if (floorLocked() && floorTools.has(value)) return;
    cancelCameraRotation();
    if (tool === 'background-scale' && value !== 'background-scale') structure.resetCalibration();
    const selecting = value === 'select' || value === 'marquee';
    const hadPreview = !!previewAp;
    tool = value;
    setSelection(selecting ? selection : new Set());
    if (value === 'marquee') {
      if (selected) setSelection(new Set([selected, ...selection]));
      selected = previewAp = '';
    }
    closeToolMenus();
    surfaceDraft = [];
    anchor = hover = keyboardPoint = null;
    hoverJoined = false;
    viewport.dataset.tool = value;
    workspace.querySelectorAll('[data-wifi-tool]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.wifiTool === value));
    });
    $('wifiMaterialField').hidden = !['wall', 'room'].includes(value);
    $('wifiDoorMaterialField').hidden = value !== 'door';
    $('wifiOrthogonalField').hidden = value !== 'wall' && value !== 'cable';
    updateToolOptions();
    $('wifiDesignControls').hidden = !['decor', 'paint', 'surface'].includes(value);
    $('wifiDecorField').hidden = value !== 'decor';
    $('wifiSurfaceField').hidden = $('wifiFinishSurface').hidden = $('wifiCancelSurface').hidden = value !== 'surface';
    $('wifiFillField').hidden = value === 'decor';
    $('wifiClearPaint').hidden = value !== 'paint';
    if (value === 'surface') $('wifiFillColor').value = design.choices[$('wifiSurfaceType').value];
    hint();
    wires.setTool(value);
    if (value !== 'select') {
      previewAp = '';
      showPanel('');
    }
    if (current()) {
      if (value === 'marquee') { renderObjectOptions(); drawObjects(); }
      if (hadPreview && !previewAp) refreshCoverage();
      scheduleScene();
    }
  }

  function startProject(plan, briefing, { sample = false, imported = false, starter } = {}) {
    if (tutorialDialog.open) tutorialDialog.close();
    const { id: siteId, revision, updated_at, scenario_briefing, ...layout } = plan;
    session = {
      id: siteId || id('site'), revision: revision || 0, plan: { ...blankPlan(), ...layout, schema_version: schemaVersion,
        access_points: (layout.access_points || []).map((ap, i) => ({ radios: model.defaultRadios(i), ...ap })) }, account,
      sequence: 0, savedSequence: 0, starter, evidence: new Set(), undo: [], redo: [], briefing: briefing || scenario_briefing,
    };
    if (starter?.guest) session.guestCheckpoint = { plan: session.plan, progress: starter.progress };
    $('wifiGuestWorkspaceNote').hidden = options.canSave;
    selected = previewAp = '';
    setSelection();
    clients.reset();
    networkSettings.reset();
    wires.reset();
    racks.reset();
    structure.reset();
    showPanel('');
    anchor = hover = drag = measure = probe = keyboardPoint = null;
    library.hidden = true;
    workspace.hidden = false;
    $('wifiScenarioButton').hidden = !session.briefing;
    $('wifiSaveSite').hidden = !options.canSave;
    $('wifiCopySite').hidden = !options.canSave || Boolean(starter);
    starterGuide.open(starter);
    $('wifiSnap').checked = $('wifiShowCables').checked = true;
    $('wifiCoverage').checked = !sample;
    $('wifiCoverageSsid').value = '';
    $('wifiShowCameras').checked = true;
    $('wifiShowLabels').checked = !sample;
    $('wifiCoverageOpacity').value = 75;
    syncLayers();
    $('wifiClearPaint').setAttribute('aria-pressed', 'false');
    $('wifiOrthogonal').checked = false;
    status(options.canSave ? (revision ? 'Saved' : imported ? 'Project file · not saved' : 'New project') : 'Guest preview');
    changeTool('select');
    fit();
    render();
    viewport.focus({ preventScroll: true });
    showBriefing(true);
  }

  function showBriefing(atOpen = false) {
    const briefing = session?.briefing;
    if (!briefing || scenarioDialog.open) return;
    $('wifiScenarioTitle').textContent = briefing.title;
    $('wifiScenarioBriefing').textContent = briefing.briefing;
    $('wifiScenarioTraits').replaceChildren(...briefing.traits.map(trait => {
      const row = document.createElement('li');
      row.textContent = trait;
      return row;
    }));
    $('wifiScenarioPlanNote').textContent = briefing.plan_note;
    $('wifiScenarioContinue').textContent = atOpen ? 'Open floor plan' : 'Back to plan';
    scenarioDialog.showModal();
  }

  function recordStarterEvent(name) {
    if (!active() || !session.starter || !starterGuide.accepts(name) || session.evidence.has(name)) return;
    session.evidence.add(name);
    session.sequence += 1;
    scheduleSave();
  }

  function recordStarterPing(source, target, packet) {
    if (!session?.starter) return;
    const seats = wires.index().devices;
    const origin = seats.get(source), destination = seats.get(target);
    if (origin?.kind === 'desktop' && destination?.kind === 'router' && packet.rtt !== null) {
      recordStarterEvent('wired');
    } else if (origin?.kind === 'phone') {
      if (target === clientModel.INTERNET && packet.rtt !== null) recordStarterEvent('internet');
      if (destination?.kind === 'desktop' && packet.rtt === null && /^Router firewall rule /.test(packet.reason)) {
        recordStarterEvent('blocked');
      }
    }
  }

  function scheduleSave() {
    if ((!options.canSave && !session.starter?.guest) || session.conflict || session.copying) return;
    const project = session;
    clearTimeout(project.timer);
    status(project.starter?.guest ? 'Checking lesson…' : 'Unsaved changes');
    project.timer = setTimeout(() => flushSave(project), 650);
  }

  function flushSave(project = session) {
    if (!project || (!options.canSave && !project.starter?.guest) || project.account !== options.authKey()) return Promise.resolve(false);
    const guest = project.starter?.guest;
    clearTimeout(project.timer);
    if (project.copyPending) return project.copyPending.then(saved => saved && flushSave(project));
    if (project.conflict) return Promise.resolve(false);
    if (project.pending) return project.pending;
    if (!dirty(project)) return Promise.resolve(true);
    project.pending = (async () => {
      while (dirty(project) && project.account === options.authKey()) {
        const attempt = project.attempt ||= {
          sequence: project.sequence, plan: project.plan, evidence: [...project.evidence],
        };
        if (session === project) status(guest ? 'Checking lesson…' : 'Saving…');
        try {
          const data = { site: attempt.plan, evidence: attempt.evidence };
          if (guest) data.progress = project.starter.progress;
          else data.revision = project.revision;
          const url = guest ? starterEndpoint + '/check' : project.starter ? starterEndpoint : siteUrl(project.id) + '?summary=1';
          const saved = await options.api(url, {
            method: guest ? 'POST' : 'PUT', signal: AbortSignal.timeout(20000), body: JSON.stringify(data),
          });
          if (guest) {
            if (saved.progress.completed > project.starter.progress.completed) {
              project.guestCheckpoint = { plan: attempt.plan, progress: saved.progress };
            }
            project.starter.progress = saved.progress;
          } else project.revision = saved.revision;
          project.savedSequence = attempt.sequence;
          project.attempt = null;
          for (const event of attempt.evidence) project.evidence.delete(event);
          if (session === project && project.account === options.authKey() && saved.progress) {
            starterGuide.update(saved.progress);
            scheduleScene();
          }
          if (session === project && !dirty(project)) status(guest ? 'Guest practice' : 'Saved', 'good');
        } catch (error) {
          project.conflict = error.status === 409;
          if (!project.conflict && error.status >= 400 && error.status < 500) project.attempt = null;
          if (session === project) status(`${guest ? 'Check failed' : 'Save failed'}. ${error.message}`, 'error');
          return false;
        }
      }
      return !dirty(project);
    })().finally(() => { project.pending = null; });
    return project.pending;
  }

  function checkStarterLesson() {
    if (!active() || !session.starter) return Promise.resolve(false);
    session.sequence += 1;
    return flushSave();
  }

  async function resetStarter(scope, lesson) {
    const project = session;
    if (!project?.starter || project.resetting || !sameAccount()) return false;
    project.resetting = true;
    try {
      if (!(await flushSave(project)) || session !== project || !sameAccount()) return false;
      workspace.inert = true;
      clients.suspend();
      cancelPdf(project);
      status(scope === 'course' ? 'Starting a new attempt…' : 'Restoring lesson checkpoint…');
      let data;
      if (project.starter.guest && scope === 'lesson') {
        if (project.starter.progress.completed !== lesson) {
          status('The current lesson changed. Continue from the saved task.', 'error');
          return false;
        }
        const checkpoint = project.guestCheckpoint;
        data = { ...project.starter, site: checkpoint.plan, progress: checkpoint.progress };
      } else {
        data = await options.api(starterEndpoint, {
          method: 'POST', signal: AbortSignal.timeout(20000),
          ...(project.starter.guest ? {} : { body: JSON.stringify({ reset: scope, revision: project.revision, lesson }) }),
        });
      }
      if (session !== project || !sameAccount()) return false;
      workspace.inert = false;
      hide();
      startProject(data.site, null, { starter: data });
      return true;
    } catch (error) {
      if (session === project && sameAccount()) status(error.message, 'error');
      return false;
    } finally {
      project.resetting = false;
      workspace.inert = false;
    }
  }

  function saveNow() {
    if (!session.revision && !dirty(session)) session.sequence += 1;
    return flushSave();
  }

  function filename(title) {
    return title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/^[ .]+|[ .]+$/g, '') || 'Infra Sim plan';
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function downloadProject() {
    if (!active() || !sameAccount()) return;
    const { scenario_id, ...project } = current();
    const json = JSON.stringify({ format: 'eagleide-infra-project', project });
    downloadBlob(new Blob([json], { type: 'application/json' }), filename(project.title) + '.infra.json');
    session.downloadedSequence = session.sequence;
    hint('Project file downloaded.');
  }

  function cancelPdf(project = session) {
    if (!project?.pdf) return;
    project.pdf.abort();
    project.pdf = null;
    $('wifiExportPdf').disabled = false;
    $('wifiExportPdf').textContent = 'Export PDF';
  }

  async function exportPdf() {
    const button = $('wifiExportPdf');
    const plan = current();
    const project = session;
    if (!plan || project.pdf) return;
    const controller = new AbortController();
    project.pdf = controller;
    const { signal } = controller;
    button.disabled = true;
    button.textContent = 'Exporting…';
    try {
      if (document.fonts?.status === 'loading') await document.fonts.ready;
      if (signal.aborted || session !== project || current() !== plan || !sameAccount()) return;
      const rackExport = racks.exportData(plan, wires.index(plan));
      hint('Preparing floor plan and coverage…');
      const drawing = await window.WifiSiteExport.render({ bounds: planExtents(plan), plan,
        cabling: wires.index(plan), network: clients.network(), cameraOutlines: wires.cameraOutlines(),
        background: $('wifiBackgroundImage'), surfaces: $('wifiSurfaceLayer'), decor: $('wifiDecorLayer'),
        structure: [$('wifiWalls'), $('wifiOpenings')], signal, serviceNames: serviceNames() });
      if (signal.aborted || !sameAccount() || session !== project) return;
      const today = new Date();
      const date = [today.getFullYear(), today.getMonth() + 1, today.getDate()].map(value => String(value).padStart(2, '0')).join('-');
      const pdf = await options.api('/api/network/wifi-export.pdf', { method: 'POST', signal,
        body: JSON.stringify({ ...drawing, ...rackExport, title: plan.title, date }) }, { download: true });
      if (signal.aborted || session !== project || !sameAccount()) return;
      downloadBlob(pdf, filename(plan.title) + '.pdf');
      hint('PDF downloaded.');
      recordStarterEvent('pdf');
    } catch (error) {
      if (!signal.aborted && session === project) hint(error.message || 'Could not export the floor plan.');
    } finally {
      controller.abort();
      if (session === project && project.pdf === controller) {
        project.pdf = null;
        button.disabled = false;
        button.textContent = 'Export PDF';
      }
    }
  }

  function saveCopy() {
    const project = session;
    if (!project || project.copyPending) return;
    clearTimeout(project.timer);
    project.copying = true;
    status('Saving a copy…');
    project.copyPending = (async () => {
      if (project.pending) await project.pending;
      if (session !== project || !sameAccount()) return false;
      const suffix = ' — Copy';
      const title = Array.from(project.plan.title).slice(0, 120 - suffix.length).join('') + suffix;
      const copy = project.copyAttempt ||= { id: id('site'), sequence: project.sequence, sourceTitle: project.plan.title,
        plan: { ...project.plan, title } };
      try {
        const saved = await options.api(siteUrl(copy.id) + '?summary=1', {
          method: 'PUT', signal: AbortSignal.timeout(20000),
          body: JSON.stringify({ site: copy.plan, revision: 0 }),
        });
        if (session !== project || !sameAccount()) return false;
        project.id = saved.id;
        project.revision = saved.revision;
        project.savedSequence = copy.sequence;
        project.conflict = false;
        project.attempt = project.copyAttempt = null;
        if (project.plan.title === copy.sourceTitle) project.plan = { ...project.plan, title: copy.plan.title };
        $('wifiSiteTitle').value = project.plan.title;
        return true;
      } catch (error) {
        if (error.status >= 400 && error.status < 500) project.copyAttempt = null;
        if (session === project) {
          project.copying = false;
          status(`Copy failed. ${error.message}`, 'error');
        }
        return false;
      }
    })().then(saved => {
      project.copying = false;
      project.copyPending = null;
      if (saved && session === project) {
        if (dirty(project)) scheduleSave();
        else status('Copy saved', 'good');
      }
      return saved;
    });
  }

  async function leave() {
    if (active() && sameAccount()) {
      if (options.canSave && (dirty(session) || session.copyPending) && !await flushSave()) return false;
      if (!options.canSave && dirty(session) && session.downloadedSequence !== session.sequence &&
          !window.confirm('Leave this guest project? Download a project file to keep your edits.')) return false;
    }
    hide();
    return true;
  }

  function hide() {
    if (session) clearTimeout(session.timer);
    cancelPdf();
    workspace.hidden = true;
    starterGuide.close();
    session = null;
    clients.reset();
    setSelection();
    if (scenarioDialog.open) scenarioDialog.close();
    if (tutorialDialog.open) tutorialDialog.close();
    selected = previewAp = '';
    wires.reset();
    racks.reset();
    structure.reset();
    showPanel('');
    endMove(drag);
    drag = null;
    anchor = hover = measure = probe = keyboardPoint = pinch = null;
    touches.clear();
    if (sceneFrame) cancelAnimationFrame(sceneFrame);
    sceneFrame = 0;
    coverage.clear();
    closeToolMenus();
    overlayMarkup = '';
    markerLabels = null;
    $('wifiProperties').replaceChildren();
    for (const name of ['wifiWalls', 'wifiOpenings', 'wifiMarkers', 'wifiOverlay', 'wifiWireLayer', 'wifiEquipmentLayer',
      'wifiSurfaceLayer', 'wifiSurfaceHitLayer', 'wifiCameraLayer', 'wifiDecorLayer']) $(name).replaceChildren();
    drawnDecor = drawnSurfaces = roomWalls = roomFaces = null;
    wallSource = drawnWalls = drawnAccessPoints = drawnPoweredAps = drawnLabels = null;
    indexedPlan = null;
    objectIndex.clear();
    listedObjects = [];
    setSpacePan(false);
    $('wifiSiteTitle').value = '';
    status('');
    $('wifiProbeResult').textContent = '';
    $('wifiProbeSummary').textContent = '';
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
    if (kind === 'openings') return `${item.kind === 'door' ? 'Door' : 'Window'} ${index + 1} · ${model.OPENINGS[item.kind][item.material].name}`;
    if (kind === 'walls') return `${model.MATERIALS[item.material].name} wall ${index + 1}`;
    if (kind === 'labels') return item.text;
    if (kind === 'decor') return design.symbols[item.kind][0];
    if (kind === 'surfaces') return design.surfaces[item.kind];
    return item.name || model.MOUNTS[item.mount];
  }

  function selectable(objectId) {
    const match = objectById(objectId);
    return match && (!floorLocked() || networkKinds.includes(match.kind)) ? match : null;
  }

  function selectObject(objectId) {
    if (!selectable(objectId)) objectId = '';
    const hadPreview = !!previewAp;
    if (selected !== objectId) previewAp = '';
    setSelection();
    selected = objectId;
    renderInspector();
    drawObjects();
    if (hadPreview && !previewAp) refreshCoverage();
    showPanel(selected ? 'object' : '');
  }

  function update(next, { inspector = true } = {}) {
    if (floorLocked() && !sameFloor(next)) {
      hint('Unlock the floor plan to change its geometry.');
      return false;
    }
    if (next.walls !== current().walls) {
      const walls = new Map(next.walls.map(wall => [wall.id, wall]));
      next = { ...next, access_points: next.access_points.map(ap => {
        const wall = walls.get(ap.wall_id);
        return wall ? { ...ap, ...roundPoint(cableModel.pointAt(wall, ap.t)) } : ap;
      }) };
    }
    const vertexCount = next.surfaces.reduce((sum, item) => sum + item.points.length + item.holes.reduce((n, hole) => n + hole.length, 0), 0);
    if (vertexCount > options.limits.surface_vertices) { hint('This plan has reached the limit for surface corners.'); return false; }
    const error = structure.validate(next) || wires.index(next).error;
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
    if (!selectable(selected)) { selected = ''; if (openPanel === 'object') showPanel(''); }
    if (selection.size) setSelection(new Set([...selection].filter(selectable)));
    scheduleSave();
    render({ inspector });
  }

  function toggleFloorLock() {
    const locked = !floorLocked();
    if (locked) {
      structure.cancelBackgroundEdit();
      if (drag && (floorTools.has(tool) || floorKinds.includes(drag.match?.kind) || drag.group)) {
        const { id, background } = drag;
        if (background) {
          $('wifiBackgroundImage').setAttribute('x', background.x);
          $('wifiBackgroundImage').setAttribute('y', background.y);
        }
        endMove(drag);
        drag = null;
        viewport.toggleAttribute('data-panning', spacePan);
        if (viewport.hasPointerCapture(id)) viewport.releasePointerCapture(id);
      }
      if (openPanel === 'background') showPanel('');
    }
    setPlan({ ...current(), floor_locked: locked });
    if (locked && floorTools.has(tool)) changeTool('select');
    hint();
  }

  function updateHistoryButtons() {
    $('wifiUndo').disabled = !canRestore(session.undo.at(-1));
    $('wifiRedo').disabled = !canRestore(session.redo.at(-1));
  }

  function canRestore(plan) {
    return !!plan && (!floorLocked() || sameFloor(plan));
  }

  function history(backward) {
    const from = backward ? session.undo : session.redo;
    const to = backward ? session.redo : session.undo;
    if (!from.length) return;
    if (!canRestore(from.at(-1))) {
      hint('Unlock the floor plan to restore a floor plan edit.');
      return;
    }
    cancelCameraRotation();
    wires.cancel();
    surfaceDraft = [];
    to.push(session.plan);
    finishWall();
    setPlan({ ...from.pop(), floor_locked: floorLocked() });
  }

  function replaceObject(kind, item, refresh = true) {
    return update({ ...current(), [kind]: current()[kind].map(object => object.id === item.id ? item : object) }, { inspector: refresh });
  }

  function addObjects(kind, additions, { select = true } = {}) {
    const existing = current()[kind];
    const limit = options.limits[kind];
    if (existing.length + additions.length > limit) {
      hint(`This site can contain up to ${limit} ${kind.replace('_', ' ')}.`);
      return false;
    }
    if (!select) return update({ ...current(), [kind]: [...existing, ...additions] });
    const previous = selected;
    selected = additions.at(-1).id;
    if (update({ ...current(), [kind]: [...existing, ...additions] })) {
      if (tool === 'select' || ['openings', 'labels', 'equipment', 'access_points', 'pass_throughs'].includes(kind)) {
        showPanel('object');
      }
      return true;
    }
    selected = previous;
    return false;
  }

  function removeObject() {
    const objectId = inspectorId();
    const match = objectById(objectId);
    if (!match) return;
    const { next, attached } = wires.removePlan(new Set([objectId]));
    if (attached && !window.confirm(`Delete this object and ${attached} attached ${attached === 1 ? 'item' : 'items'}? You can undo this change.`)) return;
    if (update(next)) {
      if (racks.isOpen()) racks.focusTools();
      else viewport.focus({ preventScroll: true });
    }
  }

  function updateToolOptions() {
    $('wifiToolOptions').hidden = !selection.size && !['wall', 'room', 'door', 'cable'].includes(tool);
  }

  function setSelection(ids = new Set()) {
    selection = ids;
    const count = $('wifiSelectionCount');
    count.textContent = ids.size ? `${ids.size} selected` : '';
    count.hidden = $('wifiFitSelected').hidden = $('wifiClearSelection').hidden = $('wifiDeleteSelected').hidden = !ids.size;
    updateToolOptions();
  }

  function toggleSelection(ids) {
    const next = new Set(selection);
    if (selected) next.add(selected);
    for (const id of ids) {
      if (next.has(id)) next.delete(id);
      else next.add(id);
    }
    selectObject('');
    setSelection(next);
    scheduleScene();
  }

  function removeSelection() {
    if (!selection.size) return;
    const { next, attached } = wires.removePlan(selection);
    const details = attached ? ` and ${attached} attached ${attached === 1 ? 'item' : 'items'}` : '';
    if (!window.confirm(`Delete ${selection.size} selected ${selection.size === 1 ? 'item' : 'items'}${details}? You can undo this change.`)) return;
    if (update(next)) { hint(); viewport.focus({ preventScroll: true }); }
  }

  function render({ inspector = true } = {}) {
    const plan = current();
    if (document.activeElement !== $('wifiSiteTitle')) $('wifiSiteTitle').value = plan.title;
    $('wifiUnits').value = plan.units;
    $('wifiBand').value = plan.band;
    const ssidFilter = $('wifiCoverageSsid');
    if (listedSsids !== plan.ssids) {
      const filter = plan.ssids.some(ssid => ssid.id === ssidFilter.value) ? ssidFilter.value : '';
      ssidFilter.innerHTML = choiceList([['', 'All SSIDs'], ...plan.ssids.map(ssid => [ssid.id, ssid.name])], filter);
      listedSsids = plan.ssids;
    }
    if (wallSource !== plan.walls) {
      wallSource = plan.walls;
      endpoints = plan.walls.flatMap(wall => [{ ...wall.a, wallId: wall.id }, { ...wall.b, wallId: wall.id }]);
    }
    const extents = planExtents(plan, false);
    $('wifiSiteExtents').textContent = extents
      ? `Drawing extents: ${fmt(extents.right - extents.left)} × ${fmt(extents.bottom - extents.top)}`
      : 'Start drawing anywhere on the grid.';
    updateHistoryButtons();
    const locked = floorLocked();
    viewport.toggleAttribute('data-wifi-floor-locked', locked);
    $('wifiFloorLock').setAttribute('aria-pressed', String(locked));
    $('wifiFloorLock').title = locked ? 'Unlock the floor plan to edit its walls, notes, and furnishings' : 'Lock the floor plan while laying out the network';
    $('wifiFloorLockText').textContent = locked ? 'Floor plan locked' : 'Lock floor plan';
    for (const control of workspace.querySelectorAll('[data-wifi-floor-control]')) control.hidden = locked;
    racks.refresh();
    if (inspector) renderInspector();
    else {
      renderObjectOptions();
      if (selected) renderObjectHeading(objectById(selected));
    }
    drawObjects();
    refreshCoverage();
    if (openPanel === 'background') structure.backgroundControls();
    if (tool === 'cable') wires.refreshDraft();
  }

  function renderObjectOptions() {
    const plan = current();
    const input = $('wifiSelection');
    if (listedLocked !== floorLocked() || kinds.some((kind, index) => listedObjects[index] !== plan[kind])) {
      listedLocked = floorLocked();
      listedObjects = kinds.map(kind => plan[kind]);
      const groups = { walls: 'Walls', openings: 'Doors and windows', access_points: 'Access points', labels: 'Notes', equipment: 'Equipment',
        pass_throughs: 'Pass-throughs', cables: 'Cables', decor: 'Plan symbols', surfaces: 'Surfaces' };
      input.innerHTML = '<option value="">None selected</option>' + selectableKinds().filter(kind => plan[kind].length).map(kind =>
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
    return entries.map(([key, label]) => `<option value="${escape(key)}"${key === value ? ' selected' : ''}>${escape(label)}</option>`).join('');
  }

  function renderObjectHeading({ kind, item }) {
    const caption = kind === 'equipment' ? options.catalog.equipment[item.kind].name
      : { access_points: model.MOUNTS[item.mount], walls: 'Wall', openings: item.kind === 'window' ? 'Window' : 'Door',
        decor: 'Plan symbol', labels: 'Note', surfaces: 'Surface', cables: 'Cable', pass_throughs: 'Pass-through' }[kind];
    const name = objectName(kind, item, current()[kind].findIndex(object => object.id === selected));
    $('wifiObjectHeading').textContent = name;
    $('wifiObjectType').textContent = caption === name ? '' : caption;
    $('wifiObjectIcon').innerHTML = window.WifiSiteCabling.icon(kind === 'equipment' ? item.kind
      : { access_points: 'access_point', cables: 'cable', pass_throughs: 'pass' }[kind]);
  }

  function inspectorId() {
    return racks.isOpen() ? racks.inspectedId() : selected;
  }

  function renderInspector() {
    renderObjectOptions();
    const inRack = racks.isOpen();
    const match = objectById(inspectorId());
    const panel = $('wifiProperties');
    if (!match) {
      delete panel.dataset.objectId;
      panel.innerHTML = inRack ? '' : '<p>Select an object on the plan or from the list to edit it.</p>';
      return;
    }
    const { kind, item } = match;
    const sameObject = panel.dataset.objectId === item.id;
    const openSections = sameObject ? [...panel.querySelectorAll('details[data-wifi-config][open]')]
      .map(detail => detail.dataset.wifiConfig) : item.kind === 'router' ? ['dhcp'] : item.kind === 'rack' && inRack ? ['placement'] :
        ['ports', 'service-vms', 'reachable-services'];
    const focusId = sameObject && panel.contains(document.activeElement) ? document.activeElement.id : '';
    panel.dataset.objectId = item.id;
    if (!inRack) renderObjectHeading(match);
    let fields;
    if (wireKinds.includes(kind)) {
      fields = wires.inspector(kind, item, { inRack });
    } else if (kind === 'openings') {
      fields = structure.inspector(item);
    } else if (kind === 'decor') {
      fields = `${pointFields(item)}<label>Rotation (degrees)<input type="number" min="0" max="360" step="1" data-wifi-field="angle" value="${item.angle}"></label>`;
    } else if (kind === 'surfaces') {
      fields = `<label>Color<input type="color" data-wifi-field="color" value="${item.color}"></label>`;
    } else if (kind === 'walls') {
      fields = `<label>Wall material<select data-wifi-field="material">${choiceList(materialEntries(), item.material)}</select></label>
        ${pointFields(item.a, 'a', 'Start ')}${pointFields(item.b, 'b', 'End ')}`;
    } else if (kind === 'access_points') {
      const data = wires.index();
      const cable = data.occupancy.get(`${item.id}:ETH1`);
      const connection = cable ? `<div class="wifi-wire-summary"><strong>Ethernet connected</strong><span>${data.powered.has(cable) ? 'PoE available' : 'No PoE source on this path'}</span></div>`
        : `<div class="wifi-wire-summary"><strong>Unwired</strong><span>Connect this AP to PoE to enable coverage.</span></div>
          <label class="wifi-estimate-toggle"><input type="checkbox" id="wifiEstimateCoverage"${previewAp === item.id ? ' checked' : ''}> Estimated coverage</label>`;
      fields = wires.deviceStatus(item.id) + connection + networkSettings.apInspector(item) + radioFields(item) + `<label>Access point label<input data-wifi-field="name" value="${escape(item.name)}" maxlength="60" placeholder="Optional"></label>
        <label>Mount<select data-wifi-field="mount">${choiceList(Object.entries(model.MOUNTS), item.mount)}</select></label>
        <label>Transmit power adjustment (dB)<input type="number" min="-12" max="6" step="1" data-wifi-field="power_db" value="${item.power_db}"></label>
        ${item.wall_id ? wires.wallField(item) : pointFields(item)}${item.mount === 'wall' ? `<label>Direction in degrees (0° points right)<input type="number" min="0" max="360" step="1" data-wifi-field="angle" value="${item.angle}"></label>` : ''}`;
    } else {
      fields = `<label>Note text<input data-wifi-field="text" value="${escape(item.text)}" maxlength="160"></label>${pointFields(item)}`;
    }
    panel.innerHTML = fields + `<div class="wifi-object-actions">
      ${inRack ? '' : '<button class="wifi-control" id="wifiLocateObject" type="button">Locate</button>'}
      ${kind === 'cables' || kind === 'pass_throughs' || kind === 'surfaces' || item.wall_id || item.rack_id || item.kind === 'rack' ? '' : '<button class="wifi-control" id="wifiDuplicateObject" type="button">Duplicate</button>'}
      <button class="wifi-control" id="wifiDeleteObject" type="button">Delete</button></div>`;
    for (const detail of panel.querySelectorAll('details[data-wifi-config]')) {
      detail.open = openSections.includes(detail.dataset.wifiConfig);
    }
    if (focusId) $(focusId)?.focus({ preventScroll: true });
    if (!sameObject) panels.object.scrollTop = 0;
  }

  function materialEntries() {
    return Object.entries(model.MATERIALS).map(([key, material]) => [key, material.name]);
  }

  function editObject(input) {
    const match = objectById(inspectorId());
    if (!match) return;
    if (input.dataset.wifiOpening && match.kind === 'openings') { structure.edit(match.item, input); return; }
    if (input.id === 'wifiEstimateCoverage' && match.kind === 'access_points') {
      previewAp = input.checked ? match.item.id : '';
      refreshCoverage();
      return;
    }
    if (input.dataset.wifiWireField) { wires.edit(match, input); return; }
    if (input.id === 'wifiCableBend') { wires.setBend(match.item, Number(input.value)); return; }
    if (input.id === 'wifiPingTarget') { clients.setTarget(match.item.id, input.value); return; }
    if (networkSettings.change(match.item, input)) return;
    if (!input.dataset.wifiField) return;
    const { kind, item } = match;
    const field = input.dataset.wifiField;
    const next = { ...item };
    if (field.startsWith('radio:')) {
      const [, band, setting] = field.split(':');
      next.radios = { ...item.radios, [band]: { ...item.radios[band], [setting]: Number(input.value) } };
      replaceObject(kind, next, true);
      return;
    }
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
    } else if (field === 'mount') {
      next.mount = input.value;
      if (next.mount === 'wall') {
        const anchored = anchorAccessPoint(next, item);
        if (anchored === next) {
          input.value = item.mount;
          hint('Move the access point near a wall before changing its mount.');
          return;
        }
        Object.assign(next, anchored);
      } else {
        delete next.wall_id;
        delete next.t;
      }
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

  function radioFields(item) {
    return Object.entries(item.radios ?? model.defaultRadios()).map(([band, radio]) => `<div class="wifi-radio-fields">
      <strong>${band} GHz radio</strong><div class="wifi-two-fields">
      <label>Channel<select data-wifi-field="radio:${band}:channel">${choiceList(model.radioChannels(band, radio.width)
        .map(channel => [String(channel), channel]), String(radio.channel))}</select></label>
      <label>Channel width<select data-wifi-field="radio:${band}:width">${choiceList(model.radioWidths(band, radio.channel)
        .map(width => [String(width), `${width} MHz`]), String(radio.width))}</select></label>
      </div></div>`).join('');
  }

  function coordinate(value) {
    return view.clamp(model.roundDistance(value), options.limits.coordinate);
  }

  function roundPoint({ x, y }) {
    return { x: coordinate(x), y: coordinate(y) };
  }

  function anchorAccessPoint(ap, point) {
    const anchor = cableModel.closestWall(point, current().walls, Math.min(3, 19 / camera.scale));
    return anchor ? { ...ap, ...roundPoint(anchor.point), wall_id: anchor.wall_id, t: anchor.t } : ap;
  }

  function planExtents(plan, includeImage = true) {
    const data = wires.index(plan);
    const image = plan.background;
    return view.bounds([...plan.walls.flatMap(wall => [wall.a, wall.b]), ...plan.access_points, ...plan.labels,
      ...plan.decor.flatMap(design.bounds), ...plan.surfaces.flatMap(item => item.points),
      ...plan.equipment.map(data.location), ...plan.pass_throughs.map(data.location),
      ...(includeImage && image ? [image, { x: image.x + image.width, y: image.y + structure.height(image) }] : []),
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
    $('wifiBackgroundLayer').setAttribute('viewBox', box);
    $('wifiSurfaceLayer').setAttribute('viewBox', box);
    objects.style.setProperty('--wifi-marker-scale', String(1 / camera.scale));
    viewport.toggleAttribute('data-wifi-overview', camera.scale < 0.8);
    wires.updateBundleBadges(camera.scale);
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
      const powered = wires.index().poweredAps.has(item.id);
      const direction = item.mount === 'wall' ? `<path class="wifi-direction" transform="rotate(${item.angle})" d="M 9 0 L 20 0 M 16 -4 L 20 0 L 16 4"/>` : '';
      content = `<circle r="11" class="wifi-ap${connected ? '' : ' wifi-ap-unwired'}${selectedClass}"/>${direction}
        <path class="wifi-radio" d="M -6 -2 Q 0 -8 6 -2 M -3 1 Q 0 -2 3 1 M 0 4 h .1"/>
        <text class="wifi-ap-channel" x="-12" y="-13">${(item.radios ?? model.defaultRadios())[current().band].channel}</text>
        ${connected ? `<circle class="wifi-ap-connected${powered ? '' : ' is-unpowered'}" cx="8" cy="8" r="3.6"/>` : ''}
        ${item.name ? `<title>${escape(item.name)}</title><text class="wifi-ap-text" x="15" y="4">${escape(item.name.length > 38 ? item.name.slice(0, 37) + '…' : item.name)}</text>` : ''}`;
    } else {
      const text = item.text.length > 32 ? `${item.text.slice(0, 31)}…` : item.text;
      content = `<title>${escape(item.text)}</title><circle r="5" class="wifi-note-pin${selectedClass}"/>
        <text class="wifi-note-text" x="8" y="-7">${escape(text)}</text>`;
    }
    return `<g transform="translate(${item.x} ${item.y})" ${object}${kind === 'labels' ? ' data-wifi-floor-note' : ''}><g class="wifi-marker">${content}</g></g>`;
  }

  function collectMarkerLabels() {
    const plan = current(), data = wires.index();
    const points = new Map([...plan.labels, ...plan.access_points, ...plan.equipment, ...plan.pass_throughs]
      .map(item => [item.id, data.location(item)]));
    markerLabels = [];
    labelMetrics.font = '700 13px system-ui, sans-serif';
    for (const group of [$('wifiMarkers'), $('wifiEquipmentLayer')]) {
      for (const item of group.children) {
        const id = item.dataset.wifiObject;
        const point = points.get(id);
        if (!point) continue;
        const label = item.querySelector('.wifi-note-text, .wifi-ap-text, .wifi-equipment-text');
        markerLabels.push({ id, point, label, node: item, note: label?.classList.contains('wifi-note-text'),
          width: label ? labelMetrics.measureText(label.textContent).width + 5 : 0 });
      }
    }
    markerScale = 0;
  }

  function layoutMarkerLabels() {
    const scale = camera.scale;
    if (!markerLabels) return;
    const compactNetwork = scale < 4 && dimensions.width <= 640 && markerLabels.length > 32;
    if (markerScale === scale && viewport.hasAttribute('data-wifi-compact-network') === compactNetwork) return;
    markerScale = scale;
    viewport.toggleAttribute('data-wifi-compact-network', compactNetwork);
    // Panning preserves overlap because icons and labels have constant pixel sizes.
    const hideDevices = !$('wifiShowLabels').checked;
    const compactNotes = scale < 3.5 && current().labels.length > 50;
    viewport.toggleAttribute('data-wifi-compact-notes', compactNotes);
    const pin = ({ point, note, id }) => {
      const x = point.x * scale, y = point.y * scale;
      const radius = note ? 5 : compactNetwork && id !== selected ? 8 : 14;
      return { left: x - radius, right: x + radius, top: y - radius, bottom: y + radius, id };
    };
    const blocked = view.labelIndex();
    for (const item of markerLabels) {
      if (!compactNotes || !item.note || item.id === selected) blocked.add(pin(item));
    }
    const priority = item => item.id === selected ? 0 : item.note ? 1 : 2;
    for (const item of [...markerLabels].sort((a, b) => priority(a) - priority(b))) {
      if (!item.label) continue;
      const x = item.point.x * scale + Number(item.label.getAttribute('x'));
      const y = item.point.y * scale + Number(item.label.getAttribute('y'));
      const candidates = [[0, 0], [0, 24], [-item.width - 29, 0]];
      let placed = false;
      const compactNote = compactNotes && item.note && item.id !== selected;
      const pinBox = compactNote ? pin(item) : null;
      const showDevice = !hideDevices && (!compactNetwork || item.id === selected);
      if ((item.note || showDevice) && (!pinBox || !blocked.overlaps(pinBox, item.id))) {
        for (const [dx, dy] of candidates) {
          const box = { left: x + dx, right: x + dx + item.width, top: y + dy - 12, bottom: y + dy + 3 };
          if (item.id !== selected && blocked.overlaps(box, item.id)) continue;
          item.label.setAttribute('transform', `translate(${dx} ${dy})`);
          blocked.add(box);
          if (pinBox) blocked.add(pinBox);
          placed = true;
          break;
        }
      }
      item.label.style.visibility = placed ? '' : 'hidden';
      if (item.note) item.node.classList.toggle('wifi-note-overlap', compactNote && !placed);
    }
  }

  function drawObjects() {
    const plan = current();
    const selectionKind = objectById(selected)?.kind;
    const wallSelection = selectionKind === 'walls' ? selected : '';
    const markerSelection = selectionKind && selectionKind !== 'walls' ? selected : '';
    if (drawnWalls !== plan.walls || drawnWallOpenings !== plan.openings || drawnWallSelection !== wallSelection) {
      if (drawnWalls !== plan.walls || drawnWallOpenings !== plan.openings) drawSpans = structure.wallSpans(plan.walls, plan.openings);
      $('wifiWalls').innerHTML = plan.walls.map(wall => {
        const object = `data-wifi-object="${escape(wall.id)}"`;
        const style = `wifi-wall-${wall.material}`;
        return `<g ${object}>${drawSpans.get(wall.id).map(([a, b]) => {
          const highlight = wallSelection === wall.id ? lineSvg(a, b, `class="wifi-selected-wall ${style}"`) : '';
          return highlight + lineSvg(a, b, `class="wifi-wall ${style}" stroke="${model.MATERIALS[wall.material].color}"`)
            + lineSvg(a, b, 'class="wifi-wall-hit"');
        }).join('')}</g>`;
      }).join('');
      drawnWalls = plan.walls;
      drawnWallOpenings = plan.openings;
      drawnWallSelection = wallSelection;
    }
    const powered = wires.index();
    const markersChanged = drawnAccessPoints !== plan.access_points || drawnLabels !== plan.labels || drawnBand !== plan.band ||
      drawnMarkerSelection !== markerSelection || drawnPoweredAps !== powered;
    if (markersChanged) {
      $('wifiMarkers').innerHTML = plan.access_points.map(ap => marker(ap, 'access_points')).join('')
        + plan.labels.map(label => marker(label, 'labels')).join('');
      drawnAccessPoints = plan.access_points;
      drawnBand = plan.band;
      drawnPoweredAps = powered;
      drawnLabels = plan.labels;
      drawnMarkerSelection = markerSelection;
    }
    stage.style.backgroundColor = plan.background_color || '';
    if (drawnSurfaces !== plan.surfaces) {
      const surfaces = [...plan.surfaces.filter(item => item.kind !== 'floor'), ...plan.surfaces.filter(item => item.kind === 'floor')];
      $('wifiSurfaceLayer').innerHTML = surfaces.map(item => design.surfaceMarkup(item)).join('');
    }
    const designSelection = ['decor', 'surfaces'].includes(selectionKind) ? selected : '';
    if (drawnSurfaces !== plan.surfaces || drawnDesignSelection !== designSelection) {
      $('wifiSurfaceHitLayer').innerHTML = [...plan.surfaces.filter(item => item.kind !== 'floor'), ...plan.surfaces.filter(item => item.kind === 'floor')]
        .map(item => `<path class="wifi-surface-hit${item.id === selected ? ' is-selected' : ''}" d="${design.surfacePath(item)}" fill-rule="evenodd" data-wifi-object="${escape(item.id)}"/>`).join('');
    }
    if (drawnDecor !== plan.decor || drawnDesignSelection !== designSelection) {
      $('wifiDecorLayer').innerHTML = plan.decor.map(item => design.decorMarkup(item, `data-wifi-object="${escape(item.id)}"`,
        item.id === selected ? 'is-selected' : '')).join('');
    }
    drawnSurfaces = plan.surfaces;
    drawnDecor = plan.decor;
    drawnDesignSelection = designSelection;
    const equipmentChanged = wires.draw();
    if (markersChanged || equipmentChanged) collectMarkerLabels();
    wires.updateBundleBadges(camera.scale);
    wires.drawCameraCoverage();
    structure.draw();
    scheduleScene();
  }

  function drawOverlay() {
    const parts = [];
    if (drag?.box) {
      const { left, top, right, bottom } = view.bounds([drag.raw, drag.box]);
      parts.push(`<rect class="wifi-selection-box" x="${left}" y="${top}" width="${right - left}" height="${bottom - top}"/>`);
    }
    if (selection.size) {
      const preview = drag?.groupPreview;
      const plan = preview || current();
      const data = preview ? groupGeometry(plan) : wires.index();
      for (const kind of kinds) {
        for (const item of plan[kind]) {
          if (!selection.has(item.id)) continue;
          if (preview) parts.push(groupGhost(kind, item, data));
          if (kind === 'walls') parts.push(lineSvg(item.a, item.b, 'class="wifi-group-line"'));
          else if (kind === 'surfaces') parts.push(`<path class="wifi-group-line" d="${design.surfacePath(item)}"/>`);
          else if (kind === 'cables') {
            parts.push(`<polyline class="wifi-group-line" points="${design.polygon(data.route(item))}"/>`);
          } else {
            const point = data.location(item);
            if (point) parts.push(dot(point, 15, 'wifi-group-ring'));
          }
        }
      }
    }
    const ghost = drag?.preview;
    const match = objectById(selected);
    if (match?.kind === 'walls') {
      const wall = ghost?.id === selected ? ghost : match.item;
      const attr = `data-wifi-object="${escape(wall.id)}"`;
      parts.push(dot(wall.a, 6, 'wifi-handle', `${attr} data-wifi-end="a"`),
        dot(wall.b, 6, 'wifi-handle', `${attr} data-wifi-end="b"`));
    }
    const aimedCamera = tool === 'select' && match?.item.kind === 'poe_camera' ? match.item : null;
    const rotating = Boolean(drag?.rotate && ghost);
    const aimCamera = rotating ? ghost : aimedCamera;
    const aim = wires.cameraAim(aimCamera, rotating);
    if (aim && (!ghost || rotating)) {
      const angle = aimCamera.angle * Math.PI / 180;
      const gap = Math.min(128, Math.max(28, model.distance(aimCamera, aim) * camera.scale * .70)) / camera.scale;
      const handle = { x: aimCamera.x + Math.cos(angle) * gap, y: aimCamera.y + Math.sin(angle) * gap };
      parts.push(lineSvg(aimCamera, handle, 'class="wifi-camera-aim-line"'),
        `<g data-wifi-object="${escape(aimCamera.id)}" data-wifi-rotate>
          <title>Drag to rotate camera</title>${dot(handle, 17, 'wifi-camera-aim-hit')}${dot(handle, 8, 'wifi-camera-aim-dot')}
          ${lineSvg({ x: handle.x - 4 / camera.scale, y: handle.y }, { x: handle.x + 4 / camera.scale, y: handle.y }, 'class="wifi-camera-aim-cross"')}
          ${lineSvg({ x: handle.x, y: handle.y - 4 / camera.scale }, { x: handle.x, y: handle.y + 4 / camera.scale }, 'class="wifi-camera-aim-cross"')}
        </g>`);
    }
    if (ghost && drag.match.kind === 'decor') parts.push(design.decorMarkup(ghost, '', 'wifi-ghost'));
    else if (ghost && drag.match.kind === 'surfaces') parts.push(design.surfaceMarkup(ghost, 'opacity=".65"'));
    else if (ghost && drag.match.kind === 'openings') parts.push(structure.markup(ghost, true));
    else if (ghost && !wireKinds.includes(drag.match.kind)) {
      parts.push(ghost.a ? lineSvg(ghost.a, ghost.b, `class="wifi-wall wifi-wall-${ghost.material} wifi-ghost" stroke="${model.MATERIALS[ghost.material].color}"`)
        : marker(ghost, drag.match.kind, true));
    }
    if (surfaceDraft.length) {
      const points = [...surfaceDraft, ...((hover || keyboardPoint) ? [hover || keyboardPoint] : [])];
      parts.push(`<polyline class="wifi-preview-line" points="${design.polygon(points)}"/>`,
        ...surfaceDraft.map((point, index) => dot(point, index ? 3 : 6, 'wifi-cursor')));
    }
    if (tool === 'decor' && (hover || keyboardPoint)) {
      parts.push(design.decorMarkup({ kind: $('wifiDecorType').value, ...(hover || keyboardPoint), angle: 0 }, '', 'wifi-ghost'));
    }
    parts.push(wires.overlay(rotating ? null : ghost, drag?.match?.kind));
    parts.push(structure.calibrationMarkup());
    if (probe) {
      if (probe.result) parts.push(lineSvg(probe.result.ap, probe.point, 'class="wifi-probe-path"'));
      parts.push(dot(probe.point, 6, 'wifi-probe-point'));
    }
    if (measure) parts.push(lineSvg(measure.a, measure.b, 'class="wifi-preview-line"'), dot(measure.b, 4, 'wifi-cursor'));
    const start = drag?.draw ? drag.start : anchor;
    const end = drag?.draw ? drag.point : hover || keyboardPoint;
    let readout = rotating ? `Camera direction: ${ghost.angle}°` : measure ? `Distance: ${fmt(model.distance(measure.a, measure.b))}` : '';
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
    const markup = parts.join('');
    if (overlayMarkup !== markup) {
      $('wifiOverlay').innerHTML = markup;
      overlayMarkup = markup;
    }
    if ($('wifiMeasureResult').textContent !== readout) $('wifiMeasureResult').textContent = readout;
  }

  function scheduleScene() {
    if (!sceneFrame) sceneFrame = requestAnimationFrame(() => {
      sceneFrame = 0;
      if (!active() || !dimensions.width || !dimensions.height) return;
      if (drag?.motion) {
        const { raw, shift } = drag.motion;
        if (drag.group) drag.groupPreview = moveGroup(drag, raw);
        else drag.preview = movePreview(drag, raw, shift);
        drag.motion = null;
      }
      drawGrid();
      layoutMarkerLabels();
      wires.positionConfirm();
      starterGuide.draw(camera.scale);
      starterGuide.schedule();
      drawOverlay();
      coverage.setView(camera, dimensions.width, dimensions.height, $('wifiCoverage').checked);
    });
  }

  function objectPoints(match) {
    const { item, kind } = match;
    if (wireKinds.includes(kind)) return wires.locationPoints(match);
    if (kind === 'openings') return structure.anchors(item);
    if (kind === 'decor') return design.bounds(item);
    if (kind === 'surfaces') return item.points;
    return item.a ? [item.a, item.b] : [item];
  }

  function groupGeometry(plan) {
    const walls = new Map(plan.walls.map(wall => [wall.id, wall]));
    const objects = new Map([...plan.equipment, ...plan.access_points, ...plan.pass_throughs].map(item => [item.id, item]));
    const location = item => item.rack_id ? objects.get(item.rack_id) : item.wall_id ? cableModel.pointAt(walls.get(item.wall_id), item.t) : item;
    const route = cable => [location(objects.get(cable.source.device_id)),
      ...cable.waypoints.map(bend => bend.pass_id ? location(objects.get(bend.pass_id)) : bend),
      location(objects.get(cable.target.device_id))];
    return { location, route, walls };
  }

  function groupGhost(kind, item, data) {
    if (kind === 'decor') return design.decorMarkup(item, '', 'wifi-ghost');
    if (['labels', 'access_points'].includes(kind)) {
      return marker({ ...item, ...data.location(item) }, kind, true);
    }
    if (kind === 'openings') return structure.markup(item, true, data.walls.get(item.wall_id));
    if (kind === 'equipment' || kind === 'pass_throughs') {
      const { wall_id, ...device } = item;
      return wires.drawEquipment(device, kind, true, data.location(item));
    }
    return '';
  }

  function selectWithin(a, b, add) {
    const box = view.bounds([a, b]);
    const contains = point => point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;
    const plan = current();
    const ids = selectableKinds().flatMap(kind => plan[kind].filter(item => {
      if (kind === 'cables' && (!$('wifiShowCables').checked || item.rack_patch)) return false;
      if (kind === 'equipment' && item.rack_id) return false;
      const points = objectPoints({ kind, item });
      return points.length && points.every(point => point && contains(point));
    }).map(item => item.id));
    if (selected) selectObject('');
    setSelection(new Set(add ? [...selection, ...ids] : ids));
    hint();
  }

  function moveGroup(gesture, raw) {
    const plan = current();
    let dx = raw.x - gesture.raw.x, dy = raw.y - gesture.raw.y;
    if (gesture.groupOrigin) {
      const point = gesture.groupOrigin;
      const snapped = drawingPoint({ x: point.x + dx, y: point.y + dy }).point;
      dx = snapped.x - point.x;
      dy = snapped.y - point.y;
    }
    const move = point => roundPoint({ x: point.x + dx, y: point.y + dy });
    const data = wires.index();
    const next = { ...plan };
    for (const kind of kinds) {
      next[kind] = plan[kind].map(item => {
        if (!selection.has(item.id) || item.rack_id) return item;
        if (item.wall_id) {
          if (selection.has(item.wall_id)) return item;
          const aim = move(data.location(item));
          if (kind === 'openings') return structure.slide(item, aim);
          const adjusted = wires.pointForEdit(item, aim);
          return kind === 'access_points' ? { ...adjusted, ...roundPoint(data.location(adjusted)) } : adjusted;
        }
        if (item.a) return { ...item, a: move(item.a), b: move(item.b) };
        if (item.points) return { ...item, points: item.points.map(move), holes: item.holes.map(ring => ring.map(move)) };
        if (item.waypoints) return { ...item, waypoints: item.waypoints.map(bend => bend.pass_id ? bend : move(bend)) };
        if (kind === 'access_points' && item.mount === 'wall') return anchorAccessPoint(item, move(item));
        return { ...item, ...move(item) };
      });
      if (next[kind].every((item, i) => item === plan[kind][i])) next[kind] = plan[kind];
    }
    return next;
  }

  function showPanel(name) {
    if (name === 'background' && floorLocked()) return;
    if (name && name !== 'object' && selected) {
      selected = previewAp = '';
      renderObjectOptions();
      drawObjects();
      refreshCoverage();
    }
    openPanel = name;
    for (const [key, panel] of Object.entries(panels)) panel.hidden = key !== name;
    for (const button of workspace.querySelectorAll('[data-wifi-panel-button]')) {
      button.setAttribute('aria-expanded', String(button.dataset.wifiPanelButton === name));
    }
    if (name === 'background') structure.backgroundControls();
    scheduleScene();
  }

  function center() {
    return { x: dimensions.width / 2, y: dimensions.height / 2 };
  }

  function fit() {
    if (!active()) return;
    dimensions = { width: viewport.clientWidth, height: viewport.clientHeight };
    const bounds = planExtents(current());
    const fitted = session.starter ? view.bounds([
      { x: 0, y: 0 }, { x: 14, y: 10 },
      ...(bounds ? [{ x: bounds.left, y: bounds.top }, { x: bounds.right, y: bounds.bottom }] : []),
    ]) : bounds;
    camera = view.fitCamera(fitted, dimensions.width, dimensions.height);
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

  function locateStarterTarget(ghost) {
    if (ghost?.kind === 'point') {
      const [x, y] = ghost.at;
      camera = view.placeWorldPoint({ x, y }, center(), camera.scale);
      scheduleScene();
    } else {
      fit();
    }
    viewport.focus({ preventScroll: true });
  }

  function locateSelected() {
    const match = objectById(selected);
    if (!match) return;
    const { item } = match;
    const points = objectPoints(match);
    camera = view.fitCamera(view.bounds(points), dimensions.width, dimensions.height);
    scheduleScene();
    viewport.focus({ preventScroll: true });
  }

  function duplicateSelected() {
    const match = objectById(selected);
    if (!match || ['cables', 'pass_throughs', 'surfaces'].includes(match.kind) || match.item.wall_id) return;
    const { kind, item } = match;
    const offset = gridSize || model.gridStep(current().units);
    const shift = point => ({ x: coordinate(point.x + offset), y: coordinate(point.y + offset) });
    let copy = { ...item, id: id(kind === 'walls' ? 'wall' : kind === 'access_points' ? 'ap' : kind === 'decor' ? 'symbol' : 'label'),
      ...(item.a ? { a: shift(item.a), b: shift(item.b) } : shift(item)) };
    if (clientModel.isClient(copy)) delete copy.reservation;
    if (kind === 'access_points' && item.mount === 'wall') {
      const anchored = anchorAccessPoint(copy, copy);
      if (anchored === copy) { hint('Place the duplicate using Equipment → Wall access point.'); return; }
      copy = anchored;
    }
    if (!item.a || model.distance(copy.a, copy.b) >= 0.05) addObjects(kind, [copy]);
  }

  function transmittingAps() {
    const { wired, poweredAps } = wires.index();
    if (previewAp !== selected || wired.has(previewAp)) previewAp = '';
    const { access_points, ssids, band } = current();
    const available = access_points.filter(ap => poweredAps.has(ap.id) || ap.id === previewAp);
    return clientModel.coverageAps(available, ssids, band, $('wifiCoverageSsid').value, true);
  }

  function refreshCoverage() {
    const plan = current();
    const access_points = transmittingAps();
    coverage.setPlan({ walls: plan.walls, openings: plan.openings, decor: plan.decor, band: plan.band, access_points });
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
    const estimate = model.coverageModel(plan.walls, accessPoints, plan.band, plan.openings, plan.decor);
    probe.result = estimate(probe.point, true);
    if (!probe.result) {
      readout.textContent = 'No AP is broadcasting a matching SSID on this band. Check the coverage filter, SSID settings, and PoE.';
      return;
    }
    const { ap, signal, received, penalty, distance, walls, alternate } = probe.result;
    const crossed = walls.map(material => model.MATERIALS[material]?.name || material).join(', ');
    summary.textContent = `${Math.round(signal)} dBm usable · ${model.signalLevel(signal).label}${ap.id === previewAp ? ' · preview' : ''}`;
    readout.innerHTML = `<strong>${summary.textContent}</strong>
      <p>${escape(ap.name || model.MOUNTS[ap.mount])} · ${fmt(distance)} away</p>
      ${penalty > .25 ? `<p>Received ${Math.round(received)} dBm · interference penalty ${Math.round(penalty)} dB</p>` : ''}
      <p>Barriers crossed: ${crossed || 'None'}</p>
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

  function findStarterDevice({ kind, point }) {
    const [x, y] = point;
    const data = wires.index();
    return [...data.devices.values()].filter(item => item.kind === kind)
      .map(item => ({ id: item.id, distance: model.distance(data.location(item), { x, y }) }))
      .filter(item => item.distance <= 1.5).sort((a, b) => a.distance - b.distance)[0]?.id;
  }

  function projectStarterGhost(task, ghost) {
    if (task === 'desktop') {
      const [x, y] = ghost.at;
      const desk = current().decor.find(item => item.kind === 'desk' && model.distance(item, { x, y }) <= 1.05);
      if (desk) return { ...ghost, at: [desk.x, desk.y] };
    }
    const project = ([x, y], concrete = false) => {
      const point = cableModel.closestWall({ x, y }, current().walls, 1.5, concrete)?.point;
      return point ? [point.x, point.y] : [x, y];
    };
    if (['door', 'pass', 'window', 'isp'].includes(task)) {
      return { ...ghost, at: project(ghost.at, task === 'door' || task === 'pass') };
    }
    if (task === 'wall') return { ...ghost, points: ghost.points.map(point => project(point)) };
    return ghost;
  }

  function positionFor(raw, origin, shift = false) {
    const guided = starterGuide.snap(raw, tool, camera.scale);
    if (guided !== raw) return { point: roundPoint(guided), joined: true };
    if (['measure', 'probe', 'select', 'marquee', 'paint'].includes(tool)) {
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

  function paint(point, hit) {
    const plan = current();
    const color = $('wifiClearPaint').getAttribute('aria-pressed') === 'true' ? null : $('wifiFillColor').value;
    if (roomWalls !== plan.walls) {
      roomWalls = plan.walls;
      roomFaces = design.rooms(plan.walls);
    }
    if (!roomFaces) { hint('Too many crossing walls to identify rooms. Draw a surface instead.'); return; }
    const room = roomFaces.find(face => design.contains(face.points, point) && !face.holes.some(hole => design.contains(hole, point)));
    const match = objectById(hit);
    const key = room && design.surfaceKey(room);
    const filled = room && plan.surfaces.find(item => item.kind === 'floor' && design.surfaceKey(item) === key);
    const old = filled || (match?.kind === 'surfaces' && (!room || match.item.kind === 'floor') ? match.item : null);
    if (old) {
      if (color === null) update({ ...plan, surfaces: plan.surfaces.filter(item => item.id !== old.id) });
      else if (room && old.kind === 'floor') replaceObject('surfaces', { ...old, points: room.points, holes: room.holes, color });
      else replaceObject('surfaces', { ...old, color });
    } else if (!room) {
      if (plan.background_color !== color) update({ ...plan, background_color: color });
    } else if (color !== null) {
      if (room.points.length > 320 || room.holes.length > 40 || room.holes.some(hole => hole.length > 320)) {
        hint('This room boundary is too complex. Draw a surface instead.'); return;
      }
      addObjects('surfaces', [{ id: id('floor'), kind: 'floor', points: room.points, holes: room.holes, color }]);
    }
  }

  function finishSurface() {
    if (!design.simple(surfaceDraft)) { hint('Use at least three distinct corners and avoid crossing edges.'); return; }
    const kind = $('wifiSurfaceType').value;
    if (addObjects('surfaces', [{ id: id(kind), kind, points: surfaceDraft, holes: [], color: $('wifiFillColor').value }])) {
      surfaceDraft = [];
      hover = null;
      hint();
      scheduleScene();
    }
  }

  function useTool(point, hit, shift) {
    point = starterGuide.snap(point, tool, camera.scale);
    if (tool === 'door' || tool === 'window') { structure.place(tool, point); return; }
    if (tool === 'background-scale') { structure.calibrationPoint(point); return; }
    if (wireTools.has(tool)) { wires.use(point, hit, shift); return; }
    if (tool === 'paint') { paint(point, hit); return; }
    if (tool === 'decor') {
      addObjects('decor', [{ id: id('symbol'), kind: $('wifiDecorType').value, ...point, angle: 0 }]);
      return;
    }
    if (tool === 'surface') {
      if (surfaceDraft.length >= 3 && model.distance(point, surfaceDraft[0]) * camera.scale <= 11) finishSurface();
      else if (surfaceDraft.length >= 320) hint('Finish the surface before adding more corners.');
      else if (!surfaceDraft.length || model.distance(surfaceDraft.at(-1), point) >= .01) {
        surfaceDraft.push(point);
        hover = null;
        hint();
      }
      scheduleScene();
      return;
    }
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
      const target = starterGuide.ghost()?.at;
      if (target && probe.result && model.distance(point, { x: target[0], y: target[1] }) <= 1.5) recordStarterEvent('probe');
      showPanel('signal');
    }
    scheduleScene();
  }

  function movePreview(gesture, point, shift) {
    const { item, kind } = gesture.match;
    const { end, raw: start, bend } = gesture;
    if (gesture.rotate) {
      const angle = model.cameraHeading(item, start, point, 8 / gesture.camera.scale, shift);
      return angle === null ? gesture.preview || item : { ...item, angle };
    }
    if (item.waypoints) return bend === undefined ? item : wires.moveBend(item, bend, point, shift);
    const dx = point.x - start.x, dy = point.y - start.y;
    const aim = part => ({ x: part.x + dx, y: part.y + dy });
    if (kind === 'access_points' && item.mount === 'wall') return anchorAccessPoint(item, aim(item));
    if (item.wall_id) {
      const location = wires.index().location(item);
      if (item.kind === 'door' || item.kind === 'window') return structure.slide(item, { x: location.x + dx, y: location.y + dy });
      return wires.pointForEdit(item, aim(location));
    }
    if (item.points) {
      const target = movePoint(aim(item.points[0]));
      const move = p => ({ x: coordinate(p.x + target.x - item.points[0].x), y: coordinate(p.y + target.y - item.points[0].y) });
      return { ...item, points: item.points.map(move), holes: item.holes.map(ring => ring.map(move)) };
    }
    if (!item.a) return { ...item, ...drawingPoint(aim(item)).point };
    if (end) {
      const changed = { ...item, [end]: movePoint(aim(item[end]), item.id) };
      return model.distance(changed.a, changed.b) >= 0.05 ? changed : item;
    }
    const target = movePoint(aim(item.a), item.id);
    const translate = part => ({ x: coordinate(part.x + target.x - item.a.x), y: coordinate(part.y + target.y - item.a.y) });
    const a = translate(item.a), b = translate(item.b);
    return model.distance(a, b) >= 0.05 ? { ...item, a, b } : item;
  }

  function movePoint(raw, wallId) {
    const snapped = drawingPoint(raw, { join: !!wallId, exclude: wallId });
    if (snapped.joined || model.distance(raw, snapped.point) * camera.scale <= 6) return snapped.point;
    return { x: coordinate(raw.x), y: coordinate(raw.y) };
  }

  function startMove(gesture) {
    const id = gesture.match.item.id;
    const changedSelection = selected !== id;
    selected = id;
    showPanel('');
    wires.hideMenu();
    if (changedSelection) {
      previewAp = '';
      drawObjects();
      refreshCoverage();
    }
    gesture.sourceNode = stage.querySelector(`[data-wifi-object="${CSS.escape(id)}"]`);
    gesture.sourceNode?.classList.add('wifi-moving-source');
    viewport.setAttribute('data-wifi-moving', '');
  }

  function endMove(gesture) {
    gesture?.sourceNode?.classList.remove('wifi-moving-source');
    for (const node of gesture?.sourceNodes || []) node.classList.remove('wifi-moving-source');
    viewport.removeAttribute('data-wifi-moving');
    viewport.removeAttribute('data-wifi-camera-rotating');
  }

  function cancelCameraRotation() {
    if (!drag?.rotate) return false;
    const { id } = drag;
    endMove(drag);
    drag = null;
    if (viewport.hasPointerCapture(id)) viewport.releasePointerCapture(id);
    scheduleScene();
    return true;
  }

  function touchPair() {
    const [a, b] = touches.values();
    return { middle: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, distance: model.distance(a, b) };
  }

  function pointerDown(event) {
    if ((event.button !== 0 && event.button !== 1) || event.target.closest('.wifi-float, #wifiCableBundleMenu, #wifiCableConfirm, .wifi-starter-picker')) return;
    const screen = screenPoint(event);
    if (event.pointerType === 'touch') {
      if (touches.size >= 2) return;
      touches.set(event.pointerId, screen);
      viewport.setPointerCapture(event.pointerId);
      if (touches.size === 2) {
        const { middle, distance } = touchPair();
        pinch = { world: view.screenToWorld(camera, middle), distance: Math.max(1, distance), scale: camera.scale };
        if (drag?.background) {
          $('wifiBackgroundImage').setAttribute('x', drag.background.x);
          $('wifiBackgroundImage').setAttribute('y', drag.background.y);
        }
        endMove(drag);
        drag = hover = null;
        scheduleScene();
        return;
      }
    }
    if (drag) return;
    closeToolMenus();
    event.preventDefault();
    viewport.focus({ preventScroll: true });
    viewport.setPointerCapture(event.pointerId);
    keyboardPoint = null;
    const hit = event.target.closest('[data-wifi-object]');
    const bundle = event.target.closest('[data-wifi-bundle]');
    const raw = view.screenToWorld(camera, screen);
    const pan = tool === 'pan' || spacePan || event.button === 1;
    const draw = !pan && drawTools.has(tool) && !anchor;
    const object = hit && selectable(hit.dataset.wifiObject);
    const rotate = !pan && tool === 'select' && hit?.hasAttribute('data-wifi-rotate') && object?.item.kind === 'poe_camera';
    const marquee = !pan && !rotate && (tool === 'marquee' || (tool === 'select' && event.shiftKey));
    const group = !pan && !rotate && (marquee || tool === 'select') &&
      (hit ? selection.has(hit.dataset.wifiObject) : bundle && wires.bundleHas(Number(bundle.dataset.wifiBundle), selection));
    const movable = match => match && !match.item.wall_id && (match.kind === 'equipment' ||
      (match.kind === 'access_points' && match.item.mount !== 'wall') || match.kind === 'decor');
    const groupOrigin = group && (movable(object) ? object : [...selection].map(objectById).find(movable))?.item;
    drag = {
      id: event.pointerId, screen, camera, raw, pan, draw, rotate, marquee, group, groupOrigin,
      start: draw ? positionFor(raw, null).point : null,
      match: !pan && !marquee && !group && tool === 'select' ? object : null,
      hit: object?.item.id,
      bundle: bundle ? Number(bundle.dataset.wifiBundle) : null,
      bend: hit?.dataset.wifiBend === undefined ? undefined : Number(hit.dataset.wifiBend),
      background: !pan && tool === 'background-move' ? current().background : null,
      end: hit?.dataset.wifiEnd,
    };
    if (!pan && (tool === 'equipment' || tool === 'pass')) {
      wires.hoverAt(raw, event.shiftKey);
      scheduleScene();
    }
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
      if (event.pointerType !== 'touch' && (anchor || ['wall', 'room', 'decor'].includes(tool) || surfaceDraft.length)) {
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
    if (!drag.moved && drag.rotate) viewport.setAttribute('data-wifi-camera-rotating', '');
    else if (!drag.moved && drag.match) startMove(drag);
    if (!drag.moved && drag.group) {
      drag.sourceNodes = [...stage.querySelectorAll('[data-wifi-object]')]
        .filter(node => selection.has(node.dataset.wifiObject));
      for (const node of drag.sourceNodes) node.classList.add('wifi-moving-source');
      viewport.setAttribute('data-wifi-moving', '');
    }
    drag.moved = true;
    if (drag.pan) {
      camera = { ...drag.camera, x: drag.camera.x - dx / drag.camera.scale, y: drag.camera.y - dy / drag.camera.scale };
    } else if (drag.background) {
      drag.image = { ...drag.background, x: coordinate(drag.background.x + raw.x - drag.raw.x),
        y: coordinate(drag.background.y + raw.y - drag.raw.y) };
      $('wifiBackgroundImage').setAttribute('x', drag.image.x);
      $('wifiBackgroundImage').setAttribute('y', drag.image.y);
    } else if (drag.match || drag.group) {
      drag.motion = { raw, shift: event.shiftKey };
    } else if (drag.marquee) {
      drag.box = raw;
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
    endMove(gesture);
    viewport.toggleAttribute('data-panning', spacePan);
    scheduleScene();
    if (gesture.background && gesture.image) {
      if (event.type === 'pointercancel') {
        $('wifiBackgroundImage').setAttribute('x', gesture.background.x);
        $('wifiBackgroundImage').setAttribute('y', gesture.background.y);
      } else {
        update({ ...current(), background: gesture.image });
        changeTool('select');
        showPanel('background');
      }
      return;
    }
    if (event.type === 'pointercancel' || gesture.pan) return;
    const raw = view.screenToWorld(camera, screenPoint(event));
    if (gesture.rotate) {
      if (!gesture.moved) return;
      const aimed = movePreview(gesture, raw, event.shiftKey);
      if (aimed.angle !== gesture.match.item.angle) replaceObject('equipment', aimed);
    } else if (gesture.moved && gesture.group) {
      update(moveGroup(gesture, raw));
    } else if (gesture.marquee || gesture.group) {
      if (gesture.moved) selectWithin(gesture.raw, raw, event.shiftKey);
      else if (gesture.hit || gesture.bundle !== null) {
        if (gesture.group && !event.shiftKey && tool === 'select') {
          if (gesture.hit) selectObject(gesture.hit);
          else wires.pick(gesture.bundle, gesture.screen);
        } else toggleSelection(gesture.hit ? [gesture.hit] : wires.bundleIds(gesture.bundle));
      } else if (!event.shiftKey) selectObject('');
    } else if (gesture.moved && gesture.match) {
      const preview = movePreview(gesture, raw, event.shiftKey);
      if (JSON.stringify(preview) !== JSON.stringify(gesture.match.item)) replaceObject(gesture.match.kind, preview);
    } else if (gesture.draw && gesture.moved) {
      drawFrom(gesture.start, positionFor(raw, gesture.start, event.shiftKey).point);
    } else if (!gesture.moved && tool === 'select') {
      if (gesture.bundle !== null && !gesture.match) wires.pick(gesture.bundle, gesture.screen);
      else {
        wires.hideMenu();
        selectObject(gesture.match?.item.id || '');
        if (gesture.match?.item.kind === 'rack') racks.open(gesture.match.item.id);
        if (gesture.bend !== undefined && gesture.match) {
          wires.setBend(gesture.match.item, gesture.bend);
          renderInspector();
        }
      }
    } else if (!gesture.moved) {
      const point = wireTools.has(tool) || ['door', 'window', 'background-scale'].includes(tool) ? raw : positionFor(raw, anchor, event.shiftKey).point;
      useTool(point, gesture.hit, event.shiftKey);
    }
  }

  function wheel(event) {
    if (event.target.closest('.wifi-float, #wifiCableBundleMenu')) return;
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
    if (!active() || workspace.inert || !document.body.classList.contains('network-mode')) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (options.canSave) saveNow();
      else downloadProject();
      return;
    }
    if (scenarioDialog.open || tutorialDialog.open || $('wifiRackDialog').open || $('wifiMaterialsDialog').open) return;
    const typing = event.target.matches('input,textarea,select');
    if (event.defaultPrevented) return;
    if (event.key === 'Enter' && !typing && !event.target.closest('button,summary,[role="option"]') && wires.finish()) {
      event.preventDefault();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !typing) {
      event.preventDefault();
      history(!event.shiftKey);
    } else if (event.key === 'Delete' && !typing && workspace.contains(event.target)) {
      if (selection.size) removeSelection();
      else removeObject();
    } else if (event.key === 'Escape') {
      if (cancelCameraRotation() || closeToolMenus()) return;
      if (selection.size) { setSelection(); hint(); scheduleScene(); return; }
      if (surfaceDraft.length) { surfaceDraft = []; hover = null; hint(); scheduleScene(); return; }
      if (wires.cancel()) return;
      if (openPanel === 'object') { selectObject(''); return; }
      if (openPanel) { showPanel(''); return; }
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
    const centerPoint = view.screenToWorld(camera, center());
    const point = keyboardPoint || (wireTools.has(tool) ? centerPoint : positionFor(centerPoint, anchor).point);
    if (!direction) {
      if (tool !== 'marquee') useTool(wireTools.has(tool) ? point : positionFor(point, anchor).point);
      return;
    }
    const step = view.gridSpacing(camera.scale, model.gridStep(current().units)) * (event.shiftKey ? 5 : 1);
    keyboardPoint = { x: coordinate(point.x + direction[0] * step), y: coordinate(point.y + direction[1] * step) };
    if (tool === 'equipment' || tool === 'pass') wires.hoverAt(keyboardPoint, event.shiftKey);
    hover = null;
    const screen = view.worldToScreen(camera, keyboardPoint);
    if (screen.x < 24 || screen.y < 24 || screen.x > dimensions.width - 24 || screen.y > dimensions.height - 24) {
      camera = view.placeWorldPoint(keyboardPoint, center(), camera.scale);
    }
    scheduleScene();
  }

  function closeToolMenus(except) {
    let closed = false;
    for (const menu of workspace.querySelectorAll('[data-wifi-menu][open]')) {
      if (menu === except) continue;
      menu.open = false;
      closed = true;
    }
    return closed;
  }

  function syncLayers() {
    $('wifiCameraLayer').toggleAttribute('hidden', !$('wifiShowCameras').checked);
    viewport.toggleAttribute('data-hide-device-labels', !$('wifiShowLabels').checked);
    $('wifiHeatmap').style.opacity = Number($('wifiCoverageOpacity').value) / 100;
    $('wifiLegend').hidden = !$('wifiCoverage').checked;
    markerScale = 0;
    scheduleScene();
  }

  function initialize() {
    if (initialized) return;
    initialized = true;
    window.WifiSiteTutorials.create($('wifiTutorialMenu'), tutorialDialog);
    $('wifiMaterial').innerHTML = choiceList(materialEntries(), 'drywall');
    $('wifiDoorMaterial').innerHTML = choiceList(Object.entries(model.OPENINGS.door).map(([key, value]) => [key, value.name]), 'wood');
    workspace.addEventListener('click', event => {
      const menu = event.target.closest('[data-wifi-menu]');
      if (!menu || event.target.closest('[data-wifi-panel-button]')) closeToolMenus();
      else closeToolMenus(menu);
    });
    $('wifiDecorType').innerHTML = choiceList(Object.entries(design.symbols).map(([kind, info]) => [kind, info[0]]).sort((a, b) => a[1].localeCompare(b[1])), 'tree');
    $('wifiDecorType').addEventListener('change', scheduleScene);
    $('wifiSnap').addEventListener('change', scheduleScene);
    $('wifiSurfaceType').innerHTML = choiceList(Object.entries(design.surfaces).filter(([kind]) => kind !== 'floor'), 'sidewalk');
    $('wifiSurfaceType').addEventListener('change', event => { $('wifiFillColor').value = design.choices[event.target.value]; });
    $('wifiFillColor').addEventListener('input', () => $('wifiClearPaint').setAttribute('aria-pressed', 'false'));
    $('wifiClearPaint').addEventListener('click', event => {
      const clear = event.currentTarget.getAttribute('aria-pressed') !== 'true';
      event.currentTarget.setAttribute('aria-pressed', String(clear));
      hint(clear ? 'Click a colored room, surface, or open background to clear its fill.' : undefined);
    });
    $('wifiFinishSurface').addEventListener('click', () => { finishSurface(); viewport.focus({ preventScroll: true }); });
    $('wifiCancelSurface').addEventListener('click', () => { surfaceDraft = []; hover = null; hint(); scheduleScene(); });
    const levels = [...model.LEVELS].reverse();
    const colors = levels.map(level => `rgb(${level.color.slice(0, 3).join(',')})`).join(',');
    $('wifiLegend').innerHTML = `<div class="wifi-legend-scale" style="background:linear-gradient(90deg,${colors})"></div>
      <div class="wifi-legend-labels">${levels.map(level => `<span title="${Number.isFinite(level.min) ? `${level.min} dBm or better` : 'Below −85 dBm'}">${level.label}</span>`).join('')}</div>`;
    workspace.querySelectorAll('[data-wifi-panel-button]').forEach(button => {
      button.addEventListener('click', () => {
        const name = button.dataset.wifiPanelButton;
        const closing = openPanel === name;
        if (tool.startsWith('background-')) changeTool('select');
        showPanel(closing ? '' : name);
      });
    });
    workspace.querySelectorAll('[data-wifi-close-panel]').forEach(button => {
      button.addEventListener('click', () => {
        if (openPanel === 'object' && objectById(selected)?.item.kind !== 'poe_camera') selectObject('');
        else {
          if (tool.startsWith('background-')) changeTool('select');
          showPanel('');
        }
        viewport.focus({ preventScroll: true });
      });
    });
    $('wifiSiteBack').addEventListener('click', async () => { if (await leave()) options.onBack(); });
    $('wifiScenarioButton').addEventListener('click', () => showBriefing());
    $('wifiExportPdf').addEventListener('click', exportPdf);
    $('wifiDownloadProject').addEventListener('click', downloadProject);
    $('wifiMaterials').addEventListener('click', () => {
      racks.inspectMaterials();
      if ($('wifiMaterialsDialog').open) recordStarterEvent('bill');
    });
    $('wifiProperties').addEventListener('click', event => {
      const control = event.target.closest('[data-wifi-open-rack]');
      if (control) racks.open(control.dataset.wifiOpenRack, control.dataset.wifiRackDevice);
    });
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
      updateHistoryButtons();
      scheduleSave();
    });
    $('wifiSiteTitle').addEventListener('blur', event => {
      if (!active()) return;
      event.target.value = current().title;
      session.titleEditing = false;
    });
    $('wifiFloorLock').addEventListener('click', toggleFloorLock);
    $('wifiSaveSite').addEventListener('click', saveNow);
    $('wifiCopySite').addEventListener('click', saveCopy);
    $('wifiDiscardSite').addEventListener('click', () => {
      if (window.confirm('Discard the unsaved edits to this site?')) { hide(); options.onBack(); }
    });
    $('wifiUndo').addEventListener('click', () => history(true));
    $('wifiRedo').addEventListener('click', () => history(false));
    $('wifiFit').addEventListener('click', fit);
    $('wifiZoomIn').addEventListener('click', () => zoom(1.25));
    $('wifiZoomOut').addEventListener('click', () => zoom(0.8));
    $('wifiCoverage').addEventListener('change', syncLayers);
    $('wifiCoverageOpacity').addEventListener('input', () => {
      $('wifiHeatmap').style.opacity = Number($('wifiCoverageOpacity').value) / 100;
    });
    $('wifiShowLabels').addEventListener('change', syncLayers);
    $('wifiShowCameras').addEventListener('change', () => { syncLayers(); wires.drawCameraCoverage(); });
    $('wifiCoverageSsid').addEventListener('change', refreshCoverage);
    $('wifiBand').addEventListener('change', event => update({ ...current(), band: event.target.value }));
    $('wifiUnits').addEventListener('change', event => update({ ...current(), units: event.target.value }));
    $('wifiFinishWall').addEventListener('click', () => {
      finishWall();
      viewport.focus({ preventScroll: true });
    });
    $('wifiSelection').addEventListener('change', event => { changeTool('select'); selectObject(event.target.value); });
    $('wifiDeleteSelected').addEventListener('click', removeSelection);
    $('wifiClearSelection').addEventListener('click', () => { setSelection(); hint(); scheduleScene(); });
    $('wifiFitSelected').addEventListener('click', () => {
      const points = [...selection].flatMap(id => objectPoints(objectById(id))).filter(Boolean);
      if (!points.length) return;
      camera = view.fitCamera(view.bounds(points), dimensions.width, dimensions.height);
      scheduleScene();
    });
    $('wifiProperties').addEventListener('change', event => editObject(event.target));
    $('wifiProperties').addEventListener('click', event => {
      if (event.target.id === 'wifiDeleteObject') removeObject();
      if (event.target.id === 'wifiLocateObject') locateSelected();
      if (event.target.id === 'wifiDuplicateObject') duplicateSelected();
      if (event.target.id === 'wifiPingToggle') clients.toggle(inspectorId());
      const match = objectById(inspectorId());
      if (match && event.target.dataset.wifiNetwork) networkSettings.click(match.item, event.target);
      if (match?.kind === 'cables' && event.target.id === 'wifiRerouteCable') wires.reroute(match.item);
      if (match?.kind === 'cables' && ['wifiAddCableBend', 'wifiRemoveCableBend'].includes(event.target.id)) {
        wires.editBends(match.item, event.target.id === 'wifiAddCableBend');
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
      if (!sameAccount() && !workspace.hidden) { hide(); options.onBack(); }
    });
    new MutationObserver(() => {
      if (active() && !document.body.classList.contains('network-mode')) {
        if (scenarioDialog.open) scenarioDialog.close();
        if (tutorialDialog.open) tutorialDialog.close();
        racks.reset();
        cancelPdf();
        clients.suspend();
        flushSave();
      }
    }).observe(document.body, { attributeFilter: ['class'] });
    window.addEventListener('beforeunload', event => {
      if (active() && ((options.canSave && session.copyPending) ||
          (dirty(session) && (options.canSave || session.downloadedSequence !== session.sequence)))) {
        event.preventDefault();
        event.returnValue = '';
      }
    });
    wires.init();
    structure.init();
  }

  window.WifiSite = {
    open(config, { site, sample, briefing, imported, starter } = {}) {
      options = config;
      account = options.authKey();
      initialize();
      const example = sample && !site;
      startProject(site || (example ? window.wifiCampusExample(blankPlan()) : blankPlan()), briefing, { sample: example, imported, starter });
    },
    canResume: () => active() && sameAccount(),
    resume() {
      resizeViewport();
      viewport.focus({ preventScroll: true });
    },
    hide, leave,
  };
})();
