(function () {
  'use strict';

  const state = {
    tree: [],
    home: null,
    currentNode: null,
    selectedClassId: '',
    expanded: new Set(),
    embeddedHistory: [],
    embeddedNode: null,
    contextSignature: '',
    searchTimer: null,
    searchQuery: '',
    searchResults: [],
    searchAbort: null,
    statusTimer: null,
    previewTimer: null,
    previewAbort: null,
    lastPointerType: 'mouse',
    touchArmedHref: '',
    classAction: null,
    treeDragId: '',
    drawerResizeFrame: 0,
  };

  const $ = (id) => document.getElementById(id);

  function context() {
    try { return window.EagleIDE?.getContext?.() || {}; } catch { return {}; }
  }

  function authHeaders(json = false) {
    const ctx = context();
    const headers = {};
    if (json) headers['Content-Type'] = 'application/json';
    if (ctx.USER_TOKEN) headers['X-User-Token'] = ctx.USER_TOKEN;
    else if (ctx.TEACHER_TOKEN) headers['X-Teacher-Token'] = ctx.TEACHER_TOKEN;
    else if (ctx.ADMIN_TOKEN) headers['X-Admin-Token'] = ctx.ADMIN_TOKEN;
    return headers;
  }

  function isTeacher() { return !!context().TEACHER_TOKEN; }
  function isStudent() { return !!context().USER_TOKEN; }
  function isAdmin() { return !!context().ADMIN_TOKEN; }
  function isSignedIn() { return isTeacher() || isStudent() || isAdmin(); }

  function availableClasses() {
    const ctx = context();
    return isTeacher() ? (ctx.teacherClasses || []) : isStudent() ? (ctx.studentClasses || []) : [];
  }

  function defaultClassId() {
    const ctx = context();
    const classes = availableClasses();
    const preferred = isTeacher() ? ctx.currentTeacherClassId : ctx.currentStudentClassId;
    return classes.some(item => item.id === preferred) ? preferred : (classes[0]?.id || '');
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function showStatus(message, error = false, timeout = 2600) {
    const el = $('wikiStatus');
    if (!el) return;
    clearTimeout(state.statusTimer);
    el.textContent = String(message || '');
    el.classList.toggle('is-error', !!error);
    el.classList.toggle('is-visible', !!message);
    if (message && timeout) {
      state.statusTimer = setTimeout(() => el.classList.remove('is-visible'), timeout);
    }
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
      const error = new Error(payload?.error || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function setView(mode, { push = true, path = '' } = {}) {
    const wiki = mode === 'wiki';
    document.body.classList.toggle('wiki-mode', wiki);
    document.body.classList.remove('network-mode');
    document.body.classList.remove('wiki-drawer-open');
    syncSidebarControls();
    $('wikiHomeBtn')?.setAttribute('aria-current', wiki ? 'page' : 'false');
    $('wikiViewBtn')?.setAttribute('aria-current', wiki ? 'page' : 'false');
    $('ideViewBtn')?.setAttribute('aria-current', wiki ? 'false' : 'page');
    $('networkViewBtn')?.setAttribute('aria-current', 'false');
    closeFloatingPanels();
    if (!push) return;
    const destination = wiki ? (path || '/') : '/ide';
    const current = `${location.pathname}${location.hash}`;
    if (current !== destination) history.pushState({ eagleView: mode }, '', destination);
  }

  function showIDE(push = true) {
    setView('ide', { push });
    try { window.eagleEditor?.refresh?.(); } catch {}
  }

  function closeFloatingPanels() {
    ['wikiSearchPanel', 'wikiBookmarksPanel', 'wikiLinkPreview'].forEach(id => {
      const el = $(id);
      if (el) el.hidden = true;
    });
    $('wikiBookmarksBtn')?.setAttribute('aria-expanded', 'false');
    state.touchArmedHref = '';
  }

  function compactSidebar() {
    return window.matchMedia('(max-width: 820px)').matches;
  }

  function sidebarOpen() {
    return compactSidebar()
      ? document.body.classList.contains('wiki-drawer-open')
      : !document.body.classList.contains('wiki-sidebar-hidden');
  }

  function syncSidebarControls() {
    const open = sidebarOpen();
    const button = $('wikiNavBtn');
    if (button) {
      button.setAttribute('aria-expanded', String(open));
      button.title = open ? 'Hide wiki contents' : 'Show wiki contents';
      const label = button.querySelector('.wiki-nav-label');
      if (label) label.textContent = open ? 'Hide Contents' : 'Show Contents';
    }
    const close = $('wikiNavCloseBtn');
    if (close) close.setAttribute('aria-label', compactSidebar() ? 'Close wiki contents' : 'Hide wiki contents');
  }

  function openDrawer() {
    if (!document.body.classList.contains('wiki-mode')) setView('wiki', { push: true, path: '/' });
    if (compactSidebar()) document.body.classList.add('wiki-drawer-open');
    else document.body.classList.remove('wiki-sidebar-hidden');
    syncSidebarControls();
    setTimeout(() => $('wikiTreeFilter')?.focus(), 120);
  }

  function closeDrawer() {
    if (compactSidebar()) document.body.classList.remove('wiki-drawer-open');
    else document.body.classList.add('wiki-sidebar-hidden');
    syncSidebarControls();
  }

  function iconFor(node, open = false) {
    const kind = typeof node === 'string' ? node : node?.kind;
    if (['folder', 'page'].includes(kind) && node?.icon) return node.icon;
    if (kind === 'folder') return open ? '📂' : '📁';
    if (kind === 'page') return '📄';
    if (kind === 'image') return '🖼️';
    if (kind === 'video') return '▶️';
    if (kind === 'pdf') return '📕';
    return '📎';
  }

  function flattenTree(nodes, output = []) {
    for (const node of nodes || []) {
      output.push(node);
      flattenTree(node.children || [], output);
    }
    return output;
  }

  function findTreeNode(id, nodes = state.tree) {
    for (const node of nodes || []) {
      if (node.id === id) return node;
      const found = findTreeNode(id, node.children || []);
      if (found) return found;
    }
    return null;
  }

  function pathToNode(id, nodes = state.tree, path = []) {
    for (const node of nodes || []) {
      const next = [...path, node.id];
      if (node.id === id) return next;
      const found = pathToNode(id, node.children || [], next);
      if (found) return found;
    }
    return [];
  }

  function filterTreeNodes(nodes, query) {
    const normalized = String(query || '').trim().toLocaleLowerCase();
    if (!normalized) return nodes;
    const visit = (node) => {
      const children = (node.children || []).map(visit).filter(Boolean);
      const matches = `${node.title} ${node.description || ''}`.toLocaleLowerCase().includes(normalized);
      if (!matches && !children.length) return null;
      return { ...node, children, __filterOpen: true };
    };
    return (nodes || []).map(visit).filter(Boolean);
  }

  function renderTree(target, nodes, { admin = false, embedded = false, filter = '', expandAll = false, selectedId = '' } = {}) {
    if (!target) return;
    const displayed = filterTreeNodes(nodes, filter);
    target.textContent = '';
    if (!displayed.length) {
      const empty = document.createElement('p');
      empty.className = 'wiki-tree-empty';
      empty.textContent = filter ? 'No topics match this filter.' : (admin ? 'No wiki items yet.' : 'No topics have been published yet.');
      target.appendChild(empty);
      return;
    }
    const selectedPath = new Set(selectedId ? pathToNode(selectedId, displayed) : []);
    selectedPath.delete(selectedId);
    const buildList = (items, depth = 0) => {
      const list = document.createElement('ul');
      list.className = 'wiki-tree-list';
      list.setAttribute('role', depth ? 'group' : 'tree');
      for (const node of items || []) {
        const li = document.createElement('li');
        li.className = 'wiki-tree-node';
        li.dataset.nodeId = node.id;
        li.dataset.nodeKind = node.kind;
        li.setAttribute('role', 'treeitem');
        li.setAttribute('aria-level', String(depth + 1));
        const hasChildren = !!node.children?.length;
        const open = hasChildren && (expandAll || node.__filterOpen || selectedPath.has(node.id) || state.expanded.has(node.id));
        if (hasChildren) li.setAttribute('aria-expanded', String(open));

        const row = document.createElement('div');
        row.className = 'wiki-tree-row' + ((selectedId || state.currentNode?.id) === node.id ? ' is-active' : '');
        const toggleFolder = () => {
          if (!hasChildren && node.kind !== 'folder') return;
          if (state.expanded.has(node.id)) state.expanded.delete(node.id);
          else state.expanded.add(node.id);
          renderAllTrees();
        };
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'wiki-tree-toggle' + (hasChildren ? '' : ' is-empty');
        toggle.tabIndex = hasChildren ? 0 : -1;
        toggle.setAttribute('aria-label', hasChildren ? `${open ? 'Collapse' : 'Expand'} ${node.title}` : '');
        toggle.textContent = hasChildren ? (open ? '▾' : '▸') : '·';
        toggle.addEventListener('click', (event) => {
          event.stopPropagation();
          if (!hasChildren) return;
          toggleFolder();
        });

        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'wiki-tree-link';
        link.title = node.title;
        if (node.kind !== 'folder') link.dataset.wikiNode = node.id;
        if (node.kind === 'folder') link.classList.add('is-folder');
        const meta = admin && node.status === 'draft' ? `${node.kind} · draft` : node.kind;
        link.innerHTML = `<span class="wiki-tree-icon" aria-hidden="true">${escapeHtml(iconFor(node, open))}</span><span class="wiki-tree-title">${escapeHtml(node.title)}</span><span class="wiki-tree-meta${node.status === 'draft' ? ' is-draft' : ''}">${escapeHtml(meta)}</span>`;
        link.addEventListener('click', () => {
          if (node.kind === 'folder') {
            toggleFolder();
            if (admin) window.WikiAdmin?.selectNode?.(node.id);
          } else if (admin) {
            window.WikiAdmin?.selectNode?.(node.id);
          } else if (embedded) {
            openEmbeddedNode(node.slug || node.id);
          } else {
            openNode(node.slug || node.id);
            closeDrawer();
          }
        });
        if (admin) {
          const dragHandle = document.createElement('span');
          dragHandle.className = 'wiki-tree-drag-handle';
          dragHandle.draggable = true;
          dragHandle.tabIndex = 0;
          dragHandle.title = 'Drag to reorder or move this item';
          dragHandle.setAttribute('aria-label', `Drag ${node.title} to reorder`);
          dragHandle.textContent = '⋮⋮';
          dragHandle.addEventListener('dragstart', event => {
            state.treeDragId = node.id;
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', node.id);
            li.classList.add('is-dragging');
          });
          dragHandle.addEventListener('dragend', () => {
            state.treeDragId = '';
            li.classList.remove('is-dragging');
            document.querySelectorAll('.wiki-tree-row.is-drop-before,.wiki-tree-row.is-drop-after,.wiki-tree-row.is-drop-inside')
              .forEach(item => item.classList.remove('is-drop-before', 'is-drop-after', 'is-drop-inside'));
          });
          let touchDrop = null;
          dragHandle.addEventListener('pointerdown', event => {
            if (event.pointerType === 'mouse') return;
            event.preventDefault();
            dragHandle.setPointerCapture?.(event.pointerId);
            state.treeDragId = node.id;
            li.classList.add('is-dragging');
          });
          dragHandle.addEventListener('pointermove', event => {
            if (event.pointerType === 'mouse' || state.treeDragId !== node.id) return;
            event.preventDefault();
            const targetRow = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('.wiki-tree-row');
            document.querySelectorAll('.wiki-tree-row.is-drop-before,.wiki-tree-row.is-drop-after,.wiki-tree-row.is-drop-inside')
              .forEach(item => item.classList.remove('is-drop-before', 'is-drop-after', 'is-drop-inside'));
            const targetLi = targetRow?.closest?.('.wiki-tree-node');
            if (!targetRow || !targetLi || targetLi.dataset.nodeId === node.id) {
              touchDrop = null;
              return;
            }
            const rect = targetRow.getBoundingClientRect();
            const ratio = rect.height ? (event.clientY - rect.top) / rect.height : 0.5;
            const position = targetLi.dataset.nodeKind === 'folder' && ratio >= 0.28 && ratio <= 0.72
              ? 'inside'
              : (ratio < 0.5 ? 'before' : 'after');
            targetRow.classList.add(`is-drop-${position}`);
            touchDrop = { targetId: targetLi.dataset.nodeId, position };
          });
          const endTouchDrag = event => {
            if (event.pointerType === 'mouse' || state.treeDragId !== node.id) return;
            event.preventDefault();
            dragHandle.releasePointerCapture?.(event.pointerId);
            state.treeDragId = '';
            li.classList.remove('is-dragging');
            document.querySelectorAll('.wiki-tree-row.is-drop-before,.wiki-tree-row.is-drop-after,.wiki-tree-row.is-drop-inside')
              .forEach(item => item.classList.remove('is-drop-before', 'is-drop-after', 'is-drop-inside'));
            if (touchDrop) window.WikiAdmin?.handleTreeDrop?.(node.id, touchDrop.targetId, touchDrop.position);
            touchDrop = null;
          };
          dragHandle.addEventListener('pointerup', endTouchDrag);
          dragHandle.addEventListener('pointercancel', endTouchDrag);
          const dropPosition = event => {
            const rect = row.getBoundingClientRect();
            const ratio = rect.height ? (event.clientY - rect.top) / rect.height : 0.5;
            if (node.kind === 'folder' && ratio >= 0.28 && ratio <= 0.72) return 'inside';
            return ratio < 0.5 ? 'before' : 'after';
          };
          row.addEventListener('dragover', event => {
            const draggedId = state.treeDragId || event.dataTransfer.getData('text/plain');
            if (!draggedId || draggedId === node.id) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            const position = dropPosition(event);
            row.classList.remove('is-drop-before', 'is-drop-after', 'is-drop-inside');
            row.classList.add(`is-drop-${position}`);
            row.dataset.dropPosition = position;
          });
          row.addEventListener('dragleave', event => {
            if (!row.contains(event.relatedTarget)) row.classList.remove('is-drop-before', 'is-drop-after', 'is-drop-inside');
          });
          row.addEventListener('drop', event => {
            event.preventDefault();
            const draggedId = state.treeDragId || event.dataTransfer.getData('text/plain');
            const position = row.dataset.dropPosition || dropPosition(event);
            row.classList.remove('is-drop-before', 'is-drop-after', 'is-drop-inside');
            if (draggedId && draggedId !== node.id) window.WikiAdmin?.handleTreeDrop?.(draggedId, node.id, position);
          });
          row.append(dragHandle);
        }
        row.append(toggle, link);

        if (!admin && isTeacher()) {
          const feature = document.createElement('button');
          feature.type = 'button';
          feature.className = 'wiki-tree-admin-action';
          feature.title = `Feature ${node.title} for a class`;
          feature.setAttribute('aria-label', `Feature ${node.title} for a class`);
          feature.textContent = '☆';
          feature.addEventListener('click', (event) => {
            event.stopPropagation();
            openClassAction('feature', node);
          });
          row.appendChild(feature);
        }

        li.appendChild(row);
        if (hasChildren) {
          const children = buildList(node.children, depth + 1);
          children.classList.add('wiki-tree-children');
          children.hidden = !open;
          li.appendChild(children);
        }
        list.appendChild(li);
      }
      return list;
    };
    target.appendChild(buildList(displayed));
    bindTreeKeyboard(target);
  }

  function bindTreeKeyboard(target) {
    if (target.dataset.keyboardReady === '1') return;
    target.dataset.keyboardReady = '1';
    target.addEventListener('keydown', (event) => {
      const links = [...target.querySelectorAll('.wiki-tree-link')].filter(el => el.offsetParent !== null);
      const currentIndex = links.indexOf(document.activeElement);
      if (currentIndex < 0) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        let next = currentIndex;
        if (event.key === 'ArrowDown') next = Math.min(links.length - 1, currentIndex + 1);
        if (event.key === 'ArrowUp') next = Math.max(0, currentIndex - 1);
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = links.length - 1;
        links[next]?.focus();
      } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        const item = document.activeElement.closest('.wiki-tree-node');
        const toggle = item?.querySelector(':scope > .wiki-tree-row .wiki-tree-toggle');
        const expanded = item?.getAttribute('aria-expanded') === 'true';
        if ((event.key === 'ArrowRight' && !expanded) || (event.key === 'ArrowLeft' && expanded)) {
          event.preventDefault();
          toggle?.click();
        }
      }
    });
  }

  function renderAllTrees() {
    renderTree($('wikiNavTree'), state.tree, { filter: $('wikiTreeFilter')?.value || '' });
    scheduleContentsDrawerResize();
    window.WikiAdmin?.renderTree?.();
  }

  function scheduleContentsDrawerResize() {
    if (state.drawerResizeFrame) return;
    state.drawerResizeFrame = requestAnimationFrame(() => {
      state.drawerResizeFrame = 0;
      resizeContentsDrawer();
    });
  }

  function resizeContentsDrawer() {
    const drawer = $('wikiNavDrawer');
    if (!drawer) return;
    const titles = [...drawer.querySelectorAll('.wiki-tree-title')];
    const viewportLimit = Math.max(320, Math.min(640, window.innerWidth - (window.innerWidth <= 600 ? 16 : 28)));
    if (!titles.length) {
      drawer.style.setProperty('--wiki-nav-drawer-width', `${Math.min(420, viewportLimit)}px`);
      return;
    }
    const canvas = resizeContentsDrawer.canvas || (resizeContentsDrawer.canvas = document.createElement('canvas'));
    const context2d = canvas.getContext('2d');
    if (context2d) context2d.font = getComputedStyle(titles[0]).font;
    let idealWidth = 400;
    for (const title of titles) {
      const textWidth = context2d
        ? context2d.measureText(title.textContent || '').width
        : (title.textContent || '').length * 7;
      const level = Math.max(1, Number(title.closest('.wiki-tree-node')?.getAttribute('aria-level') || 1));
      idealWidth = Math.max(idealWidth, textWidth + ((level - 1) * 22) + 174);
    }
    drawer.style.setProperty(
      '--wiki-nav-drawer-width',
      `${Math.round(Math.min(viewportLimit, idealWidth))}px`,
    );
  }

  function renderCards(target, items, { bookmark = false } = {}) {
    if (!target) return;
    target.textContent = '';
    for (const item of items || []) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'wiki-card';
      const labels = bookmark ? (item.labels || []) : ['Featured'];
      const classNames = bookmark ? (item.lesson_classes || []).map(cls => cls.name) : [];
      card.innerHTML = `
        <span class="wiki-kind-label">${escapeHtml(item.kind || item.node_kind || 'topic')}</span>
        <h3>${escapeHtml(item.title)}</h3>
        <p>${escapeHtml(item.description || (classNames.length ? classNames.join(', ') : 'Open this wiki topic.'))}</p>
        <span class="wiki-card-labels">${labels.map(label => `<span class="wiki-badge ${label === 'Lesson Material' ? 'lesson' : ''}">${escapeHtml(label)}</span>`).join('')}</span>`;
      card.addEventListener('click', () => openNode(item.slug || item.node_id));
      target.appendChild(card);
    }
  }

  function renderHomeStandards(standards) {
    const target = $('wikiHomeStandardsBody');
    if (!target) return;
    target.textContent = '';
    const items = Array.isArray(standards) ? standards : [];
    if (!items.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 2;
      cell.className = 'wiki-home-info-empty';
      cell.textContent = 'Standards have not been posted yet.';
      row.appendChild(cell);
      target.appendChild(row);
      return;
    }
    for (const standard of items) {
      const row = document.createElement('tr');
      const id = document.createElement('td');
      id.textContent = standard.standard_id || '';
      const description = document.createElement('td');
      description.textContent = standard.description || '';
      row.append(id, description);
      target.appendChild(row);
    }
  }

  function renderHomeResources(resources) {
    const target = $('wikiHomeResourcesBody');
    if (!target) return;
    target.textContent = '';
    const items = Array.isArray(resources) ? resources : [];
    if (!items.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 2;
      cell.className = 'wiki-home-info-empty';
      cell.textContent = 'External resources have not been posted yet.';
      row.appendChild(cell);
      target.appendChild(row);
      return;
    }
    for (const resource of items) {
      if (!/^https?:\/\//i.test(resource.url || '')) continue;
      const row = document.createElement('tr');
      const name = document.createElement('td');
      const link = document.createElement('a');
      link.href = resource.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = resource.title || resource.url;
      name.appendChild(link);
      const description = document.createElement('td');
      description.textContent = resource.description || '';
      row.append(name, description);
      target.appendChild(row);
    }
  }

  function renderFooterText(text) {
    const target = $('wikiSiteFooter');
    if (!target) return;
    const value = String(text || 'Created by Ben Godwin | Computer Science Department ARCA High School | Youngsville Louisiana | Contact bgodwin@acadianacharter.org');
    target.textContent = '';
    const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
    let last = 0;
    for (const match of value.matchAll(emailPattern)) {
      target.append(document.createTextNode(value.slice(last, match.index)));
      const link = document.createElement('a');
      link.href = `mailto:${match[0]}`;
      link.textContent = match[0];
      target.appendChild(link);
      last = match.index + match[0].length;
    }
    target.append(document.createTextNode(value.slice(last)));
  }

  function renderHomeData() {
    const data = state.home || { tree: [], featured: [] };
    const homeSettings = data.home_settings || {};
    if ($('wikiHomeTitle')) $('wikiHomeTitle').textContent = homeSettings.title || 'Learn it. Try it. Build it.';
    if ($('wikiHomeSubtitle')) $('wikiHomeSubtitle').textContent = homeSettings.subtitle || 'Browse classroom-ready programming topics, open examples directly in the IDE, and keep important lessons close at hand.';
    renderFooterText(homeSettings.footer_text);
    renderHomeStandards(homeSettings.standards || []);
    renderHomeResources(homeSettings.external_resources || []);
    state.tree = data.tree || [];
    renderAllTrees();
    const featuredSection = $('wikiFeaturedSection');
    if (featuredSection) featuredSection.hidden = !(data.featured || []).length;
    renderCards($('wikiFeaturedList'), data.featured || []);
    renderEmbeddedHome();
  }

  function syncClassSelector() {
    const classes = availableClasses();
    const wrap = $('wikiClassContext');
    const select = $('wikiClassSelector');
    if (!wrap || !select) return;
    wrap.hidden = !classes.length;
    if (!classes.length) {
      state.selectedClassId = '';
      select.textContent = '';
      return;
    }
    if (!classes.some(cls => cls.id === state.selectedClassId)) state.selectedClassId = defaultClassId();
    select.textContent = '';
    for (const cls of classes) {
      const option = document.createElement('option');
      option.value = cls.id;
      option.textContent = cls.name || 'Class';
      option.selected = cls.id === state.selectedClassId;
      select.appendChild(option);
    }
  }

  async function loadHome({ quiet = false } = {}) {
    syncClassSelector();
    if (!quiet) showStatus('Loading wiki…', false, 0);
    try {
      const suffix = state.selectedClassId ? `?class_id=${encodeURIComponent(state.selectedClassId)}` : '';
      state.home = await fetchJson(`/api/wiki/home${suffix}`, { headers: authHeaders() });
      state.tree = state.home.tree || [];
      renderHomeData();
      if (!quiet) showStatus('');
      return state.home;
    } catch (error) {
      showStatus(error.message || 'Could not load the wiki', true);
      throw error;
    }
  }

  async function selectClass(classId, { show = false } = {}) {
    const nextId = String(classId || '');
    if (availableClasses().some(cls => cls.id === nextId)) state.selectedClassId = nextId;
    syncClassSelector();
    if (show) return showHome();
    return loadHome({ quiet: true });
  }

  async function showHome({ push = true } = {}) {
    setView('wiki', { push, path: '/' });
    state.currentNode = null;
    $('wikiHomePanel').hidden = false;
    $('wikiArticlePanel').hidden = true;
    $('wikiHomeBtn')?.setAttribute('aria-current', 'page');
    if (!state.home) await loadHome().catch(() => {});
    else renderHomeData();
    $('wikiReaderShell')?.scrollTo?.({ top: 0, behavior: 'instant' });
  }

  function updatePathForNode(node, push, anchor = '') {
    if (!push) return;
    const hash = anchor ? `#${encodeURIComponent(anchor)}` : '';
    const path = `/wiki/${encodeURIComponent(node.slug)}${hash}`;
    if (`${location.pathname}${location.hash}` !== path) history.pushState({ eagleView: 'wiki', node: node.id }, '', path);
  }

  async function openNode(identifier, { push = true, anchor = '', highlight = '' } = {}) {
    setView('wiki', { push: false });
    showStatus('Loading topic…', false, 0);
    try {
      const data = await fetchJson(`/api/wiki/nodes/${encodeURIComponent(identifier)}`);
      if (data.node.kind === 'folder') {
        for (const id of pathToNode(data.node.id)) state.expanded.add(id);
        await showHome({ push });
        renderAllTrees();
        openDrawer();
        if (!push && location.pathname.startsWith('/wiki/')) history.replaceState({ eagleView: 'wiki' }, '', '/');
        showStatus('');
        return data.node;
      }
      state.currentNode = data.node;
      for (const id of pathToNode(data.node.id)) state.expanded.add(id);
      renderNode(data.node, $('wikiArticleBody'), { embedded: false });
      $('wikiHomePanel').hidden = true;
      $('wikiArticlePanel').hidden = false;
      $('wikiHomeBtn')?.setAttribute('aria-current', 'false');
      updatePathForNode(data.node, push, anchor);
      renderAllTrees();
      updateArticleActions();
      showStatus('');
      const requestedAnchor = anchor || (push ? '' : decodeURIComponent(location.hash.replace(/^#/, '')));
      requestAnimationFrame(() => {
        const firstHit = highlightSearchTerm($('wikiArticleBody'), highlight);
        const target = requestedAnchor ? document.getElementById(requestedAnchor) : null;
        if (firstHit) firstHit.scrollIntoView({ block: 'center' });
        else if (target) target.scrollIntoView({ block: 'start' });
        else document.querySelector('.wiki-reader-shell')?.scrollTo?.({ top: 0, behavior: 'instant' });
      });
      return data.node;
    } catch (error) {
      showStatus(error.message || 'Could not load this topic', true);
      if (error.status === 404) await showHome({ push: false });
      return null;
    }
  }

  function highlightSearchTerm(container, term) {
    const query = String(term || '').trim();
    if (!container || query.length < 2) return null;
    const regex = new RegExp(escapeRegExp(query), 'gi');
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode() && nodes.length < 5000) {
      const node = walker.currentNode;
      if (!node.parentElement?.closest('pre,code,a,button,script,style') && regex.test(node.nodeValue || '')) nodes.push(node);
      regex.lastIndex = 0;
    }
    let first = null;
    let count = 0;
    for (const textNode of nodes) {
      if (count >= 100) break;
      const fragment = document.createDocumentFragment();
      let last = 0;
      const value = textNode.nodeValue || '';
      regex.lastIndex = 0;
      for (const match of value.matchAll(regex)) {
        fragment.append(document.createTextNode(value.slice(last, match.index)));
        const mark = document.createElement('mark');
        mark.className = 'wiki-search-hit';
        mark.textContent = match[0];
        fragment.appendChild(mark);
        if (!first) first = mark;
        last = match.index + match[0].length;
        count += 1;
        if (count >= 100) break;
      }
      fragment.append(document.createTextNode(value.slice(last)));
      textNode.replaceWith(fragment);
    }
    return first;
  }

  function renderBreadcrumbs(node) {
    const target = $('wikiBreadcrumbs');
    target.textContent = '';
    const home = document.createElement('button');
    home.type = 'button';
    home.textContent = 'Wiki Home';
    home.addEventListener('click', () => showHome());
    target.appendChild(home);
    for (const crumb of node.breadcrumbs || []) {
      if (crumb.id === node.id) continue;
      const wrap = document.createElement('span');
      wrap.textContent = crumb.title;
      target.appendChild(wrap);
    }
  }

  function renderNode(node, target, { embedded = false } = {}) {
    if (!target) return;
    target.textContent = '';
    if (!embedded) {
      renderBreadcrumbs(node);
      $('wikiArticleTitle').textContent = `${node.icon ? `${node.icon} ` : ''}${node.title || 'Wiki'}`;
      $('wikiArticleKind').textContent = node.kind || 'Topic';
      $('wikiArticleDescription').textContent = node.description || '';
      $('wikiArticleBookmarkBtn').hidden = (!isStudent() && !isTeacher()) || (node.kind === 'folder' && !(node.children || []).length);
      $('wikiArticleFeatureBtn').hidden = !isTeacher();
    }
    if (node.kind === 'page') {
      renderMarkdown(target, node.markdown || '', node, { embedded });
      if (!embedded) renderPageStandards(node.standards || []);
    } else if (node.kind === 'folder') {
      const intro = document.createElement('p');
      intro.textContent = node.description || 'Choose a topic from this folder.';
      target.appendChild(intro);
      const grid = document.createElement('div');
      grid.className = 'wiki-card-grid';
      renderCards(grid, node.children || []);
      target.appendChild(grid);
      if (!embedded) renderToc([]);
      if (!embedded) renderPageStandards([]);
    } else {
      renderMediaNode(target, node);
      if (!embedded) renderToc([]);
      if (!embedded) renderPageStandards([]);
    }
    if (embedded) {
      const heading = document.createElement('div');
      heading.className = 'wiki-embedded-heading';
      heading.innerHTML = `<span class="wiki-kind-label">${escapeHtml(node.kind)}</span><h2>${escapeHtml(node.title)}</h2>${node.description ? `<p>${escapeHtml(node.description)}</p>` : ''}`;
      target.prepend(heading);
    }
  }

  function renderMediaNode(target, node) {
    const view = document.createElement('div');
    view.className = 'wiki-file-view';
    if (node.kind === 'image') {
      const image = document.createElement('img');
      image.src = node.media_url;
      image.alt = node.description || node.title;
      image.loading = 'eager';
      view.appendChild(image);
    } else if (node.kind === 'video') {
      const video = document.createElement('video');
      video.src = node.media_url;
      video.controls = true;
      video.preload = 'metadata';
      video.playsInline = true;
      view.appendChild(video);
    } else if (node.kind === 'pdf') {
      const frame = document.createElement('iframe');
      frame.className = 'wiki-pdf-frame';
      frame.src = node.media_url;
      frame.title = node.title;
      view.appendChild(frame);
    } else {
      const card = document.createElement('div');
      card.className = 'wiki-download-card';
      card.innerHTML = `<span class="wiki-file-icon" aria-hidden="true">📎</span><strong>${escapeHtml(node.file_name || node.title)}</strong><a class="btn run" href="${escapeHtml(node.download_url)}">Download file</a>`;
      view.appendChild(card);
    }
    if (node.kind !== 'file') {
      const download = document.createElement('a');
      download.className = 'btn secondary';
      download.href = node.download_url;
      download.textContent = 'Download';
      view.appendChild(download);
    }
    target.appendChild(view);
  }

  function directiveOptions(raw) {
    const result = {};
    for (const part of String(raw || '').split('|')) {
      const index = part.indexOf('=');
      if (index < 1) continue;
      const key = part.slice(0, index).trim().toLowerCase();
      const value = part.slice(index + 1).trim().slice(0, 300);
      if (['alt', 'caption', 'align', 'width'].includes(key)) result[key] = value;
    }
    return result;
  }

  function preprocessDirectives(markdown) {
    return String(markdown || '').replace(/\{\{(image|video|file):([0-9a-f]{32})(?:\|([^}]*))?\}\}/gi, (_all, type, id, raw) => {
      const options = directiveOptions(raw);
      if (type.toLowerCase() === 'image') {
        const align = ['left', 'right', 'center', 'full'].includes(options.align) ? options.align : 'center';
        let width = Math.round((parseInt(options.width, 10) || 70) / 10) * 10;
        width = Math.max(20, Math.min(100, width));
        return `<figure class="wiki-image align-${align} width-${width}"><img src="/api/wiki/media/${id}" alt="${escapeHtml(options.alt || '')}" loading="lazy">${options.caption ? `<figcaption>${escapeHtml(options.caption)}</figcaption>` : ''}</figure>`;
      }
      if (type.toLowerCase() === 'video') {
        return `<figure class="wiki-embedded-media"><video src="/api/wiki/media/${id}" controls preload="metadata" playsinline></video>${options.caption ? `<figcaption>${escapeHtml(options.caption)}</figcaption>` : ''}</figure>`;
      }
      return `<p><a class="wiki-file-directive" href="/api/wiki/media/${id}?download=1">${escapeHtml(options.caption || 'Download file')}</a></p>`;
    });
  }

  function extractFenceMetadata(markdown) {
    const metadata = [];
    const lines = String(markdown || '').split(/\r?\n/);
    let fence = null;
    for (const line of lines) {
      const match = /^\s*(```|~~~)(.*)$/.exec(line);
      if (!match) continue;
      if (!fence) {
        fence = match[1];
        const info = match[2].trim();
        const language = (info.match(/^([\w+-]+)/) || [])[1] || '';
        const filename = (info.match(/(?:^|\s)filename=(?:"([^"]+)"|'([^']+)'|([^\s]+))/i) || []).slice(1).find(Boolean) || '';
        metadata.push({ language, filename });
      } else if (match[1] === fence) {
        fence = null;
      }
    }
    return metadata;
  }

  function renderMarkdown(target, markdown, node = {}, { embedded = false } = {}) {
    if (!window.marked || !window.DOMPurify) {
      target.textContent = markdown || '';
      return;
    }
    try {
      marked.setOptions({ breaks: true, gfm: true, mangle: false, headerIds: false });
      const parsed = marked.parse(preprocessDirectives(markdown));
      target.innerHTML = DOMPurify.sanitize(parsed, {
        USE_PROFILES: { html: true },
        FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'option'],
        FORBID_ATTR: ['style', 'srcdoc'],
      });
      const headings = [...target.querySelectorAll('h1,h2,h3,h4,h5,h6')];
      headings.forEach((heading, index) => {
        const section = node.sections?.[index];
        const base = section?.anchor || `section-${index + 1}`;
        heading.id = embedded ? `embedded-${base}` : base;
      });
      let tocSections = node.sections || [];
      const firstHeading = headings[0];
      if (!embedded && firstHeading?.tagName === 'H1' && firstHeading.textContent.trim().toLocaleLowerCase() === String(node.title || '').trim().toLocaleLowerCase()) {
        firstHeading.classList.add('wiki-redundant-page-title');
        tocSections = tocSections.slice(1);
      }
      postProcessLinks(target, node);
      postProcessCode(target, markdown, node);
      applyAutoLinks(target, node.link_candidates || []);
      if (!embedded) renderToc(tocSections);
    } catch (error) {
      console.warn('Wiki Markdown render failed', error);
      target.textContent = markdown || '';
    }
  }

  function postProcessLinks(target, node) {
    for (const anchor of target.querySelectorAll('a[href]')) {
      const raw = anchor.getAttribute('href') || '';
      if (/^https?:\/\//i.test(raw)) {
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        continue;
      }
      if (/^[^/#][^#]*\.md(?:#.*)?$/i.test(raw)) {
        const [file, hash] = raw.split('#');
        const slug = file.split('/').pop().replace(/\.md$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        anchor.href = `/wiki/${slug}${hash ? `#${encodeURIComponent(hash)}` : ''}`;
      }
      if (anchor.getAttribute('href')?.startsWith('/wiki/')) anchor.classList.add('wiki-internal-link');
    }
  }

  function languageInfo(raw) {
    const key = String(raw || '').trim().toLowerCase();
    if (['python', 'py'].includes(key)) return { language: 'python', extension: '.py' };
    if (['javascript', 'js', 'node'].includes(key)) return { language: 'javascript', extension: '.js' };
    if (['html', 'xml', 'htmlmixed'].includes(key)) return { language: 'html', extension: '.html' };
    if (key === 'css') return { language: 'css', extension: '.css' };
    return null;
  }

  async function copyText(text, button) {
    try {
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        if (!document.execCommand('copy')) throw new Error('Copy command was rejected');
        textarea.remove();
      }
      button.textContent = 'Copied!';
    } catch {
      button.textContent = 'Select & copy';
      showStatus('Clipboard access is unavailable. Select the code and copy it manually.', true);
    }
    setTimeout(() => { button.textContent = 'Copy'; }, 1400);
  }

  function postProcessCode(target, markdown, node) {
    const metadata = extractFenceMetadata(markdown);
    [...target.querySelectorAll('pre > code')].forEach((code, index) => {
      const rawClass = [...code.classList].find(value => value.startsWith('language-')) || '';
      const classLanguage = rawClass.replace(/^language-/, '').split(/\s/)[0];
      const meta = metadata[index] || {};
      const info = languageInfo(meta.language || classLanguage);
      try { window.hljs?.highlightElement?.(code); } catch {}
      const pre = code.parentElement;
      const toolbar = document.createElement('span');
      toolbar.className = 'wiki-code-toolbar';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = 'Copy';
      copy.addEventListener('click', () => copyText(code.textContent || '', copy));
      toolbar.appendChild(copy);
      if (info) {
        const open = document.createElement('button');
        open.type = 'button';
        open.textContent = 'Open in IDE';
        open.addEventListener('click', async () => {
          const fileName = String(meta.filename || `${node.slug || 'wiki'}-example-${index + 1}${info.extension}`)
            .split(/[\\/]/).pop().replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
          const result = await context().setEditorSnapshot?.({
            code: code.textContent || '',
            language: info.language,
            fileName,
            source: 'wiki',
            draft: true,
            wikiSource: { id: node.id, slug: node.slug, title: node.title },
          });
          if (result !== false) showIDE(true);
        });
        toolbar.appendChild(open);
      }
      pre.appendChild(toolbar);
    });
  }

  function applyAutoLinks(target, candidates) {
    if (!candidates?.length) return;
    const unique = new Map();
    for (const item of candidates) {
      const key = String(item.term || '').toLocaleLowerCase();
      if (key && !unique.has(key)) unique.set(key, item);
    }
    const terms = [...unique.keys()].sort((a, b) => b.length - a.length).slice(0, 250);
    if (!terms.length) return;
    let matcher;
    try {
      matcher = new RegExp(`(^|[^\\p{L}\\p{N}_])(${terms.map(escapeRegExp).join('|')})(?=$|[^\\p{L}\\p{N}_])`, 'iu');
    } catch {
      matcher = new RegExp(`(^|[^A-Za-z0-9_])(${terms.map(escapeRegExp).join('|')})(?=$|[^A-Za-z0-9_])`, 'i');
    }
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT, {
      acceptNode(textNode) {
        const parent = textNode.parentElement;
        if (!parent || !textNode.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
        if (parent.closest('a,pre,code,h1,h2,h3,h4,h5,h6,button,textarea,input,select,kbd,samp,.wiki-code-toolbar')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const linked = new Set();
    let count = 0;
    for (const textNode of nodes) {
      if (count >= 40) break;
      let remaining = textNode.nodeValue || '';
      const fragment = document.createDocumentFragment();
      let changed = false;
      while (remaining && count < 40) {
        const match = matcher.exec(remaining);
        if (!match) break;
        const prefix = match[1] || '';
        const matched = match[2] || '';
        const key = matched.toLocaleLowerCase();
        const item = unique.get(key);
        const beforeLength = match.index + prefix.length;
        fragment.append(document.createTextNode(remaining.slice(0, beforeLength)));
        if (!item || linked.has(key)) {
          fragment.append(document.createTextNode(matched));
        } else {
          const anchor = document.createElement('a');
          anchor.href = `/wiki/${item.slug}${item.anchor ? `#${encodeURIComponent(item.anchor)}` : ''}`;
          anchor.textContent = matched;
          anchor.className = 'wiki-internal-link wiki-auto-link';
          anchor.dataset.wikiId = item.node_id;
          fragment.appendChild(anchor);
          linked.add(key);
          count += 1;
        }
        remaining = remaining.slice(match.index + match[0].length);
        changed = true;
      }
      if (changed) {
        fragment.append(document.createTextNode(remaining));
        textNode.replaceWith(fragment);
      }
    }
  }

  function renderToc(sections) {
    const toc = $('wikiToc');
    const contents = $('wikiTocContents');
    const links = $('wikiTocLinks');
    links.textContent = '';
    const visible = (sections || []).filter(section => Number(section.level) <= 3);
    contents.hidden = !visible.length;
    toc.hidden = !visible.length && $('wikiPageStandards')?.hidden !== false;
    for (const section of visible) {
      const anchor = document.createElement('a');
      anchor.href = `#${encodeURIComponent(section.anchor)}`;
      anchor.dataset.level = String(section.level);
      anchor.textContent = section.heading;
      anchor.addEventListener('click', (event) => {
        event.preventDefault();
        document.getElementById(section.anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        history.replaceState(history.state, '', `${location.pathname}#${encodeURIComponent(section.anchor)}`);
      });
      links.appendChild(anchor);
    }
  }

  function renderPageStandards(standards) {
    const toc = $('wikiToc');
    const section = $('wikiPageStandards');
    const target = $('wikiPageStandardsList');
    if (!toc || !section || !target) return;
    const items = Array.isArray(standards) ? standards : [];
    target.textContent = '';
    section.hidden = !items.length;
    for (const standard of items) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = standard.standard_id || 'Standard';
      const description = document.createElement('p');
      description.textContent = standard.description || '';
      details.append(summary, description);
      target.appendChild(details);
    }
    toc.hidden = !$('wikiTocLinks')?.childElementCount && !items.length;
  }

  function renderEmbeddedHome() {
    const target = $('wikiEmbeddedContent');
    if (!target) return;
    target.textContent = '';
    const heading = document.createElement('div');
    heading.innerHTML = '<span class="wiki-eyebrow">EagleIDE Coding Wiki</span><h2>Wiki Home</h2><p>Browse featured class material and all coding topics.</p>';
    target.appendChild(heading);
    if (state.home?.featured?.length) {
      const title = document.createElement('h3');
      title.textContent = 'Featured for this class';
      target.appendChild(title);
      const grid = document.createElement('div');
      grid.className = 'wiki-card-grid';
      renderEmbeddedCards(grid, state.home.featured);
      target.appendChild(grid);
    }
    const title = document.createElement('h3');
    title.textContent = 'All topics';
    target.appendChild(title);
    const tree = document.createElement('div');
    tree.className = 'wiki-tree';
    renderTree(tree, state.tree, { embedded: true });
    target.appendChild(tree);
    state.embeddedNode = null;
  }

  function renderEmbeddedCards(target, items) {
    target.textContent = '';
    for (const item of items || []) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'wiki-card';
      card.innerHTML = `<span class="wiki-kind-label">${escapeHtml(item.kind || 'topic')}</span><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.description || 'Open this topic.')}</p>`;
      card.addEventListener('click', () => openEmbeddedNode(item.slug || item.node_id));
      target.appendChild(card);
    }
  }

  async function openEmbeddedNode(identifier, { fromHistory = false } = {}) {
    const target = $('wikiEmbeddedContent');
    if (!target) return;
    target.innerHTML = '<div class="skeleton" style="height:90px"></div>';
    try {
      const data = await fetchJson(`/api/wiki/nodes/${encodeURIComponent(identifier)}`);
      if (data.node.kind === 'folder') {
        for (const id of pathToNode(data.node.id)) state.expanded.add(id);
        renderEmbeddedHome();
        return;
      }
      if (state.embeddedNode && !fromHistory) state.embeddedHistory.push(state.embeddedNode.slug || state.embeddedNode.id);
      state.embeddedNode = data.node;
      renderNode(data.node, target, { embedded: true });
      target.scrollTop = 0;
    } catch (error) {
      target.textContent = error.message || 'Could not load this topic.';
    }
  }

  async function performSearch(query) {
    const panel = $('wikiSearchPanel');
    const target = $('wikiSearchResults');
    const normalized = String(query || '').trim();
    if (normalized.length < 2) {
      state.searchAbort?.abort?.();
      panel.hidden = true;
      target.textContent = '';
      return;
    }
    panel.hidden = false;
    target.innerHTML = '<div class="skeleton" style="height:50px;margin-top:8px"></div>';
    state.searchAbort?.abort?.();
    const controller = new AbortController();
    state.searchAbort = controller;
    try {
      const data = await fetchJson(`/api/wiki/search?q=${encodeURIComponent(normalized)}&limit=8`, { signal: controller.signal });
      if (controller.signal.aborted || String($('wikiSearchInput')?.value || '').trim() !== normalized) return [];
      state.searchQuery = normalized;
      state.searchResults = data.results || [];
      target.textContent = '';
      if (!data.results?.length) {
        target.innerHTML = '<p style="padding:14px;color:#9fb2c5">No matching wiki topics.</p>';
        return;
      }
      for (const result of data.results) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'wiki-search-result';
        const heading = result.location_heading ? `<span class="wiki-search-location">${escapeHtml(result.location_heading)}</span>` : '';
        const excerpt = escapeHtml(result.excerpt || result.description || result.kind).replace(new RegExp(`(${escapeRegExp(normalized)})`, 'gi'), '<mark>$1</mark>');
        button.innerHTML = `<strong>${escapeHtml(result.title)}</strong>${heading}<p>${excerpt}</p>`;
        button.addEventListener('click', () => {
          panel.hidden = true;
          completeSearch(normalized, result);
        });
        target.appendChild(button);
      }
      return state.searchResults;
    } catch (error) {
      if (error?.name === 'AbortError') return [];
      target.textContent = error.message || 'Search failed.';
      state.searchResults = [];
      return [];
    }
  }

  async function completeSearch(query, result = null) {
    const normalized = String(query || '').trim();
    if (normalized.length < 2) return;
    try {
      await fetchJson('/api/wiki/search/complete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: normalized, result_id: result?.id || '' }),
      });
    } catch {}
    if (result) {
      $('wikiSearchPanel').hidden = true;
      openNode(result.slug || result.id, { anchor: result.anchor || '', highlight: normalized });
    } else {
      showStatus('No matching wiki topics.', true);
    }
  }

  async function submitSearch() {
    const query = $('wikiSearchInput')?.value || '';
    const normalized = query.trim();
    if (normalized.length < 2) return;
    const results = state.searchQuery === normalized ? state.searchResults : await performSearch(normalized);
    await completeSearch(normalized, results?.[0] || null);
  }

  async function loadBookmarksPanel() {
    const panel = $('wikiBookmarksPanel');
    const target = $('wikiBookmarksList');
    panel.hidden = false;
    $('wikiBookmarksBtn')?.setAttribute('aria-expanded', 'true');
    target.textContent = '';
    if (!isSignedIn() || isAdmin()) {
      const p = document.createElement('p');
      p.style.padding = '12px';
      p.textContent = isAdmin() ? 'Student and teacher accounts have bookmarks.' : 'Sign in to bookmark pages and see Lesson Material from your teacher.';
      target.appendChild(p);
      if (!isSignedIn()) {
        const button = document.createElement('button');
        button.className = 'btn run';
        button.textContent = 'Sign In';
        button.addEventListener('click', () => { panel.hidden = true; $('loginBtn')?.click(); });
        target.appendChild(button);
      }
      return;
    }
    target.innerHTML = '<div class="skeleton" style="height:50px;margin-top:8px"></div>';
    try {
      const suffix = isTeacher() && state.selectedClassId ? `?class_id=${encodeURIComponent(state.selectedClassId)}` : '';
      const data = await fetchJson(`/api/wiki/bookmarks${suffix}`, { headers: authHeaders() });
      target.textContent = '';
      if (!data.bookmarks?.length) {
        target.innerHTML = '<p style="padding:12px;color:#9fb2c5">No bookmarks yet.</p>';
        return;
      }
      for (const item of data.bookmarks) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'wiki-bookmark-item';
        button.innerHTML = `<strong>${escapeHtml(item.title)}</strong><p>${(item.labels || []).map(label => `<span class="wiki-badge ${label === 'Lesson Material' ? 'lesson' : ''}">${escapeHtml(label)}</span>`).join(' ')} ${(item.lesson_classes || []).map(cls => escapeHtml(cls.name)).join(', ')}</p>`;
        button.addEventListener('click', () => { panel.hidden = true; openNode(item.slug || item.node_id); });
        target.appendChild(button);
      }
    } catch (error) {
      target.textContent = error.message || 'Could not load bookmarks.';
    }
  }

  function openClassAction(type, node = state.currentNode) {
    const classes = availableClasses();
    if (!isTeacher() || !classes.length) {
      showStatus('A teacher account with a class is required.', true);
      return;
    }
    state.classAction = { type, node, marked: false };
    const select = $('wikiClassActionSelect');
    select.textContent = '';
    for (const cls of classes) {
      const option = document.createElement('option');
      option.value = cls.id;
      option.textContent = cls.name || 'Class';
      option.selected = cls.id === (state.selectedClassId || defaultClassId());
      select.appendChild(option);
    }
    $('wikiClassActionTitle').textContent = type === 'bookmark' ? 'Lesson Material bookmark' : 'Feature content for a class';
    $('wikiClassActionDescription').textContent = type === 'bookmark'
      ? 'Choose the class whose students should see this page under Lesson Material.'
      : 'Choose the class that should feature this page or folder. Featured folders automatically include future children.';
    $('wikiClassActionModal').style.display = 'flex';
    refreshClassActionState();
  }

  async function refreshClassActionState() {
    const action = state.classAction;
    const classId = $('wikiClassActionSelect')?.value || '';
    const status = $('wikiClassActionState');
    const confirm = $('wikiClassActionConfirmBtn');
    if (!action?.node || !classId || !status || !confirm) return;
    const cls = availableClasses().find(item => item.id === classId);
    const requestKey = `${action.type}:${classId}:${Date.now()}`;
    action.statusRequest = requestKey;
    status.textContent = 'Checking current status…';
    status.classList.remove('is-selected');
    confirm.disabled = true;
    try {
      const nodeId = action.node.id || action.node.node_id;
      if (action.type === 'bookmark') {
        const existing = await fetchJson(`/api/wiki/bookmarks?class_id=${encodeURIComponent(classId)}`, { headers: authHeaders() });
        if (state.classAction !== action || action.statusRequest !== requestKey) return;
        action.marked = !!existing.bookmarks?.some(item => item.node_id === nodeId && item.labels?.includes('Lesson Material') && item.lesson_classes?.some(itemClass => itemClass.id === classId));
        status.textContent = action.marked
          ? `Currently shared as Lesson Material with ${cls?.name || 'this class'}.`
          : `Not currently Lesson Material for ${cls?.name || 'this class'}.`;
        confirm.textContent = action.marked ? 'Remove Lesson Material' : 'Add Lesson Material';
      } else {
        const existing = await fetchJson(`/api/wiki/classes/${encodeURIComponent(classId)}/features`, { headers: authHeaders() });
        if (state.classAction !== action || action.statusRequest !== requestKey) return;
        action.marked = !!existing.featured?.some(item => item.node_id === nodeId);
        status.textContent = action.marked
          ? `Currently featured for ${cls?.name || 'this class'}.`
          : `Not currently featured for ${cls?.name || 'this class'}.`;
        confirm.textContent = action.marked ? 'Remove from Featured' : 'Add to Featured';
      }
      status.classList.toggle('is-selected', action.marked);
      confirm.classList.toggle('btn--danger', action.marked);
      confirm.classList.toggle('run', !action.marked);
      confirm.disabled = false;
    } catch (error) {
      if (state.classAction !== action || action.statusRequest !== requestKey) return;
      status.textContent = error.message || 'Could not check current status.';
      confirm.disabled = true;
    }
  }

  async function confirmClassAction() {
    const action = state.classAction;
    const classId = $('wikiClassActionSelect').value;
    if (!action?.node || !classId) return;
    const nodeId = action.node.id || action.node.node_id;
    const headers = authHeaders(true);
    try {
      $('wikiClassActionConfirmBtn').disabled = true;
      if (action.type === 'bookmark') {
        const marked = !!action.marked;
        await fetchJson(`/api/wiki/bookmarks/${nodeId}`, {
          method: marked ? 'DELETE' : 'PUT', headers, body: JSON.stringify({ class_id: classId }),
        });
        showStatus(marked ? 'Lesson Material bookmark removed.' : 'Lesson Material shared with the selected class.');
      } else {
        const featured = !!action.marked;
        await fetchJson(`/api/wiki/classes/${encodeURIComponent(classId)}/features/${nodeId}`, {
          method: featured ? 'DELETE' : 'PUT', headers,
        });
        showStatus(featured ? 'Content removed from class features.' : 'Content featured for the selected class.');
      }
      state.selectedClassId = classId;
      $('wikiClassActionModal').style.display = 'none';
      await loadHome({ quiet: true });
      updateArticleActions();
    } catch (error) {
      showStatus(error.message || 'Could not update the class.', true);
      refreshClassActionState();
    }
  }

  async function toggleStudentBookmark() {
    const node = state.currentNode;
    if (!node) return;
    if (!isStudent()) {
      if (isTeacher()) openClassAction('bookmark', node);
      else $('loginBtn')?.click();
      return;
    }
    const existing = state.home?.bookmarks?.some(item => item.node_id === node.id && item.labels?.includes('Bookmarked'));
    const button = $('wikiArticleBookmarkBtn');
    if (button) button.disabled = true;
    try {
      await fetchJson(`/api/wiki/bookmarks/${node.id}`, {
        method: existing ? 'DELETE' : 'PUT', headers: authHeaders(true), body: JSON.stringify({}),
      });
      showStatus(existing ? 'Bookmark removed.' : 'Page bookmarked.');
      await loadHome({ quiet: true });
      updateArticleActions();
    } catch (error) {
      showStatus(error.message || 'Could not update bookmark.', true);
    } finally {
      if (button) button.disabled = false;
    }
  }

  function updateArticleActions() {
    const node = state.currentNode;
    if (!node) return;
    const personal = state.home?.bookmarks?.some(item => item.node_id === node.id && item.labels?.includes('Bookmarked'));
    const lesson = state.home?.bookmarks?.some(item => item.node_id === node.id && item.labels?.includes('Lesson Material'));
    const bookmark = $('wikiArticleBookmarkBtn');
    if (bookmark) {
      bookmark.hidden = (!isStudent() && !isTeacher()) || (node.kind === 'folder' && !(node.children || []).length);
      if (isTeacher()) bookmark.textContent = lesson ? '✓ Lesson Material added' : '+ Add Lesson Material';
      else bookmark.textContent = personal ? '★ Bookmarked' : '☆ Bookmark';
      bookmark.classList.toggle('is-selected', !!(isTeacher() ? lesson : personal));
      bookmark.setAttribute('aria-pressed', String(!!(isTeacher() ? lesson : personal)));
      bookmark.title = isTeacher()
        ? (lesson ? 'This is Lesson Material for the selected class. Open to remove it.' : 'Add this page as Lesson Material for a class.')
        : (personal ? 'This page is bookmarked. Select to remove it.' : 'Bookmark this page.');
    }
    const feature = $('wikiArticleFeatureBtn');
    if (feature) {
      const featured = state.home?.featured?.some(item => item.node_id === node.id);
      feature.textContent = featured ? '✓ Featured for class' : '+ Feature for class';
      feature.classList.toggle('is-selected', !!featured);
      feature.setAttribute('aria-pressed', String(!!featured));
    }
  }

  function internalWikiTarget(anchor) {
    const href = anchor.getAttribute('href') || '';
    if (!href.startsWith('/wiki/')) return null;
    try {
      const url = new URL(href, location.origin);
      const slug = decodeURIComponent(url.pathname.replace(/^\/wiki\//, ''));
      return { href: `${url.pathname}${url.hash}`, slug, anchor: decodeURIComponent(url.hash.replace(/^#/, '')) };
    } catch { return null; }
  }

  async function showLinkPreview(anchor) {
    const target = internalWikiTarget(anchor);
    if (!target) return;
    clearTimeout(state.previewTimer);
    state.previewAbort?.abort?.();
    state.previewAbort = new AbortController();
    try {
      const identifier = anchor.dataset.wikiId || target.slug;
      const params = new URLSearchParams({ term: anchor.textContent.trim(), anchor: target.anchor || '' });
      const data = await fetchJson(`/api/wiki/previews/${encodeURIComponent(identifier)}?${params}`, { signal: state.previewAbort.signal });
      const panel = $('wikiLinkPreview');
      const preview = data.preview;
      const locations = preview.locations?.length ? preview.locations : [{ heading: '', excerpt: preview.summary || 'Open this wiki topic.' }];
      let locationIndex = 0;
      panel.innerHTML = `<span class="wiki-preview-path">${escapeHtml((preview.breadcrumbs || []).map(item => item.title).join(' / '))}</span><h4>${escapeHtml(preview.title)}</h4><div class="wiki-preview-location"></div>${locations.length > 1 ? '<div class="wiki-preview-controls"><button type="button" data-direction="-1" aria-label="Previous match">←</button><span></span><button type="button" data-direction="1" aria-label="Next match">→</button></div>' : ''}`;
      const renderLocation = () => {
        const location = locations[locationIndex];
        const linkedTerm = String(anchor.textContent || '').trim();
        let excerpt = escapeHtml(location.excerpt || preview.summary || '');
        if (linkedTerm) {
          excerpt = excerpt.replace(new RegExp(`(${escapeRegExp(linkedTerm)})`, 'gi'), '<mark>$1</mark>');
        }
        panel.querySelector('.wiki-preview-location').innerHTML = `${location.heading ? `<strong>${escapeHtml(location.heading)}</strong>` : ''}<p>${excerpt}</p>`;
        const counter = panel.querySelector('.wiki-preview-controls span');
        if (counter) counter.textContent = `${locationIndex + 1} of ${locations.length}`;
      };
      renderLocation();
      panel.querySelectorAll('.wiki-preview-controls button').forEach(button => button.addEventListener('click', event => {
        event.preventDefault(); event.stopPropagation();
        locationIndex = (locationIndex + Number(button.dataset.direction) + locations.length) % locations.length;
        renderLocation();
      }));
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(430, window.innerWidth - 24);
      const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.left));
      let top = rect.bottom + 10;
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.hidden = false;
      requestAnimationFrame(() => {
        const panelRect = panel.getBoundingClientRect();
        if (panelRect.bottom > window.innerHeight - 12) {
          top = Math.max(12, rect.top - panelRect.height - 10);
          panel.style.top = `${top}px`;
        }
      });
    } catch (error) {
      if (error.name !== 'AbortError') console.debug('Wiki preview unavailable', error);
    }
  }

  function handleDocumentClick(event) {
    if (!$('wikiSearchPanel')?.hidden && !event.target.closest?.('#wikiSearchPanel,.wiki-top-search')) {
      state.searchAbort?.abort?.();
      $('wikiSearchPanel').hidden = true;
    }
    const anchor = event.target.closest?.('a[href^="/wiki/"]');
    if (anchor && (anchor.closest('#wikiView') || anchor.closest('#wikiEmbeddedReader'))) {
      const target = internalWikiTarget(anchor);
      if (!target) return;
      if (state.lastPointerType === 'touch' && state.touchArmedHref !== target.href) {
        event.preventDefault();
        state.touchArmedHref = target.href;
        showLinkPreview(anchor);
        return;
      }
      event.preventDefault();
      state.touchArmedHref = '';
      $('wikiLinkPreview').hidden = true;
      if (anchor.closest('#wikiEmbeddedReader')) openEmbeddedNode(target.slug);
      else openNode(target.slug, { anchor: target.anchor });
      return;
    }
    if (!event.target.closest?.('#wikiLinkPreview')) {
      $('wikiLinkPreview').hidden = true;
      state.touchArmedHref = '';
    }
  }

  function refreshContext() {
    const ctx = context();
    const signature = JSON.stringify({
      user: ctx.currentUser?.email || '', teacher: ctx.currentTeacher?.email || '',
      admin: !!ctx.ADMIN_TOKEN, classes: availableClasses().map(cls => cls.id),
      selected: defaultClassId(),
    });
    $('adminWikiBtn').style.display = isAdmin() ? '' : 'none';
    $('wikiArticleFeatureBtn').hidden = !isTeacher();
    if (signature === state.contextSignature) return;
    state.contextSignature = signature;
    if (!availableClasses().some(cls => cls.id === state.selectedClassId)) state.selectedClassId = defaultClassId();
    syncClassSelector();
    if (state.home) loadHome({ quiet: true }).then(updateArticleActions).catch(() => {});
  }

  function attachEvents() {
    $('wikiNavBtn')?.addEventListener('click', () => sidebarOpen() ? closeDrawer() : openDrawer());
    $('wikiNavCloseBtn')?.addEventListener('click', closeDrawer);
    $('wikiDrawerScrim')?.addEventListener('click', closeDrawer);
    $('wikiHomeBtn')?.addEventListener('click', () => showHome());
    $('wikiArticleHomeBtn')?.addEventListener('click', () => showHome());
    $('wikiHeroIdeBtn')?.addEventListener('click', () => showIDE());
    $('ideViewBtn')?.addEventListener('click', () => showIDE());
    $('wikiViewBtn')?.addEventListener('click', () => showHome());
    $('wikiTreeFilter')?.addEventListener('input', () => renderAllTrees());
    window.addEventListener('resize', scheduleContentsDrawerResize, { passive: true });
    $('wikiClassSelector')?.addEventListener('change', async (event) => {
      state.selectedClassId = event.target.value || '';
      await loadHome().catch(() => {});
      updateArticleActions();
    });
    $('wikiSearchInput')?.addEventListener('input', (event) => {
      clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(() => performSearch(event.target.value), 300);
    });
    $('wikiSearchInput')?.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { state.searchAbort?.abort?.(); $('wikiSearchPanel').hidden = true; }
      if (event.key === 'Enter') { event.preventDefault(); submitSearch(); }
    });
    $('wikiSearchSubmitBtn')?.addEventListener('click', submitSearch);
    $('wikiSearchCloseBtn')?.addEventListener('click', () => { state.searchAbort?.abort?.(); $('wikiSearchPanel').hidden = true; $('wikiSearchInput').value = ''; });
    $('wikiBookmarksBtn')?.addEventListener('click', () => {
      if (!document.body.classList.contains('wiki-mode')) setView('wiki', { push: true, path: '/' });
      $('wikiBookmarksPanel').hidden ? loadBookmarksPanel() : closeFloatingPanels();
    });
    $('wikiBookmarksCloseBtn')?.addEventListener('click', closeFloatingPanels);
    $('wikiArticleBookmarkBtn')?.addEventListener('click', toggleStudentBookmark);
    $('wikiArticleFeatureBtn')?.addEventListener('click', () => openClassAction('feature'));
    $('wikiClassActionCancelBtn')?.addEventListener('click', () => { $('wikiClassActionModal').style.display = 'none'; });
    $('wikiClassActionConfirmBtn')?.addEventListener('click', confirmClassAction);
    $('wikiClassActionSelect')?.addEventListener('change', refreshClassActionState);
    $('wikiEmbeddedHomeBtn')?.addEventListener('click', renderEmbeddedHome);
    $('wikiEmbeddedBackBtn')?.addEventListener('click', () => {
      const previous = state.embeddedHistory.pop();
      if (previous) openEmbeddedNode(previous, { fromHistory: true });
      else renderEmbeddedHome();
    });
    $('wikiEmbeddedFullBtn')?.addEventListener('click', () => state.embeddedNode ? openNode(state.embeddedNode.slug || state.embeddedNode.id) : showHome());
    $('lessonTabBtn')?.addEventListener('click', () => { if (!state.embeddedNode && !state.home) loadHome({ quiet: true }); });
    document.addEventListener('pointerdown', event => { state.lastPointerType = event.pointerType || 'mouse'; }, true);
    document.addEventListener('click', handleDocumentClick, true);
    document.addEventListener('pointerover', event => {
      if (event.pointerType && event.pointerType !== 'mouse') return;
      const anchor = event.target.closest?.('a[href^="/wiki/"]');
      if (!anchor) return;
      clearTimeout(state.previewTimer);
      state.previewTimer = setTimeout(() => showLinkPreview(anchor), 320);
    });
    document.addEventListener('pointerout', event => {
      if (!event.target.closest?.('a[href^="/wiki/"]')) return;
      clearTimeout(state.previewTimer);
      state.previewTimer = setTimeout(() => { if (!$('wikiLinkPreview')?.matches(':hover')) $('wikiLinkPreview').hidden = true; }, 180);
    });
    window.addEventListener('eagle-context-updated', refreshContext);
    window.addEventListener('resize', syncSidebarControls);
    window.addEventListener('popstate', routeFromLocation);
    window.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        $('wikiSearchInput')?.focus();
      }
      if (event.key === 'Escape') {
        closeDrawer(); closeFloatingPanels();
        if ($('wikiClassActionModal')?.style.display !== 'none') $('wikiClassActionModal').style.display = 'none';
      }
    });
  }

  function routeFromLocation() {
    const path = location.pathname;
    if (path === '/network') {
      window.NetworkSim?.show?.({ push: false });
      return;
    }
    if (path === '/ide') {
      showIDE(false);
      return;
    }
    if (path.startsWith('/wiki/')) {
      const slug = decodeURIComponent(path.slice('/wiki/'.length));
      openNode(slug, { push: false, anchor: decodeURIComponent(location.hash.replace(/^#/, '')) });
      return;
    }
    showHome({ push: false });
  }

  async function initialize() {
    attachEvents();
    syncSidebarControls();
    refreshContext();
    await loadHome({ quiet: true }).catch(() => {});
    routeFromLocation();
  }

  window.WikiReader = {
    authHeaders,
    context,
    escapeHtml,
    fetchJson,
    findTreeNode,
    flattenTree,
    getState: () => state,
    loadHome,
    openClassAction,
    openNode,
    renderMarkdown,
    renderTree,
    selectClass,
    showHome,
    showIDE,
    showStatus,
  };

  initialize();
})();
