(function () {
  'use strict';

  const DAYS = window.LessonPlanRenderer?.DAYS || ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
  const state = {
    teacherClassId: '',
    teacherWeek: mondayFor(new Date()),
    teacherData: null,
    teacherLoading: false,
    teacherRequest: 0,
    pickerDay: '',
    externalLinkDay: '',
    homeClassId: '',
    homeData: null,
    homeRequest: 0,
  };
  const $ = (id) => document.getElementById(id);

  function context() {
    try { return window.EagleIDE?.getContext?.() || {}; } catch { return {}; }
  }

  function mondayFor(value) {
    const parsed = value instanceof Date ? new Date(value) : new Date(`${value}T12:00:00`);
    parsed.setHours(12, 0, 0, 0);
    const day = parsed.getDay() || 7;
    parsed.setDate(parsed.getDate() - day + 1);
    return parsed.toISOString().slice(0, 10);
  }

  function shiftWeek(week, amount) {
    const parsed = new Date(`${week}T12:00:00`);
    parsed.setDate(parsed.getDate() + amount * 7);
    return parsed.toISOString().slice(0, 10);
  }

  function readableWeek(week) {
    const monday = new Date(`${week}T12:00:00`);
    const friday = new Date(monday);
    friday.setDate(friday.getDate() + 4);
    const start = monday.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const end = friday.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    return `${start} - ${end}`;
  }

  function dayDate(week, index) {
    const parsed = new Date(`${week}T12:00:00`);
    parsed.setDate(parsed.getDate() + index);
    return parsed.toISOString().slice(0, 10);
  }

  function authHeaders(role, json = false) {
    const ctx = context();
    const headers = json ? { 'Content-Type': 'application/json' } : {};
    if (role === 'teacher' && ctx.TEACHER_TOKEN) headers['X-Teacher-Token'] = ctx.TEACHER_TOKEN;
    if (role === 'student' && ctx.USER_TOKEN) headers['X-User-Token'] = ctx.USER_TOKEN;
    return headers;
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }

  function setTeacherStatus(message, error = false) {
    const target = $('lessonPlanTeacherStatus');
    if (!target) return;
    target.textContent = message || '';
    target.classList.toggle('is-error', !!error);
  }

  function teacherClasses() { return context().teacherClasses || []; }

  function buildTeacherShell() {
    const host = $('lessonPlanTeacherHost');
    if (!host || host.dataset.ready) return;
    host.dataset.ready = 'true';
    host.innerHTML = `
      <div class="lesson-plan-teacher-shell">
        <div class="lesson-plan-teacher-toolbar">
          <div class="lesson-plan-week-nav">
            <label>Class <select id="lessonPlanTeacherClass"></select></label>
            <label>Plan source <select id="lessonPlanTeacherSource"></select></label>
            <button class="btn secondary" id="lessonPlanTeacherPrevious" type="button">← Previous</button>
            <button class="btn secondary" id="lessonPlanTeacherCurrent" type="button">Current week</button>
            <span class="lesson-plan-week-label" id="lessonPlanTeacherWeekLabel"></span>
            <button class="btn secondary" id="lessonPlanTeacherNext" type="button">Next →</button>
          </div>
          <div class="lesson-plan-week-nav">
            <button class="btn secondary" id="lessonPlanCopyPublic" type="button">Copy Public Link</button>
            <button class="btn secondary" id="lessonPlanCopyEmbed" type="button">Copy Embed</button>
            <button class="btn secondary" id="lessonPlanPrint" type="button">Print / Save PDF</button>
            <button class="btn secondary" id="lessonPlanResetLink" type="button" title="Disable the old public and embed links">Reset Link</button>
          </div>
        </div>
        <div class="lesson-plan-source-note" id="lessonPlanTeacherSourceNote"></div>
        <div class="lesson-plan-editor-scroll"><div class="lesson-plan-editor-grid" id="lessonPlanEditorGrid"></div></div>
        <div>
          <label class="lesson-plan-notes-editor"><strong>Additional notes</strong><textarea id="lessonPlanNotes" maxlength="20000" placeholder="Notes for the whole week (Markdown supported)"></textarea></label>
          <div class="lesson-plan-editor-actions" style="margin-top:10px;">
            <span class="lesson-plan-status" id="lessonPlanTeacherStatus" role="status" aria-live="polite"></span>
            <button class="btn run" id="lessonPlanPublish" type="button">Apply &amp; Publish</button>
          </div>
        </div>
      </div>`;
    $('lessonPlanTeacherClass').addEventListener('change', (event) => {
      state.teacherClassId = event.target.value || '';
      loadTeacherPlan();
    });
    $('lessonPlanTeacherSource').addEventListener('change', changePlanSource);
    $('lessonPlanTeacherPrevious').addEventListener('click', () => changeTeacherWeek(-1));
    $('lessonPlanTeacherNext').addEventListener('click', () => changeTeacherWeek(1));
    $('lessonPlanTeacherCurrent').addEventListener('click', () => { state.teacherWeek = mondayFor(new Date()); loadTeacherPlan(); });
    $('lessonPlanPublish').addEventListener('click', saveTeacherPlan);
    $('lessonPlanCopyPublic').addEventListener('click', () => copySharing('public_url', 'Public link copied.'));
    $('lessonPlanCopyEmbed').addEventListener('click', () => copySharing('embed_code', 'Embed code copied.'));
    $('lessonPlanPrint').addEventListener('click', printTeacherPlan);
    $('lessonPlanResetLink').addEventListener('click', resetSharing);
    syncTeacherClasses();
  }

  function syncTeacherClasses() {
    buildTeacherShell();
    const select = $('lessonPlanTeacherClass');
    if (!select) return;
    const classes = teacherClasses();
    const preferred = state.teacherClassId || context().currentTeacherClassId;
    state.teacherClassId = classes.some((item) => item.id === preferred) ? preferred : (classes[0]?.id || '');
    select.textContent = '';
    classes.forEach((item) => {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.name || 'Class';
      option.selected = item.id === state.teacherClassId;
      select.appendChild(option);
    });
    $('lessonPlanPublish').disabled = !state.teacherClassId;
    syncPlanSourceControl();
  }

  function syncPlanSourceControl() {
    const select = $('lessonPlanTeacherSource');
    const note = $('lessonPlanTeacherSourceNote');
    if (!select) return;
    const sourceId = state.teacherData?.class?.id === state.teacherClassId
      ? state.teacherData?.plan_source?.id || state.teacherClassId
      : state.teacherClassId;
    select.textContent = '';
    const own = document.createElement('option');
    own.value = '';
    own.textContent = 'This class (independent plan)';
    select.appendChild(own);
    teacherClasses().filter((item) => item.id !== state.teacherClassId).forEach((item) => {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = `Use ${item.name || 'class'} plan`;
      select.appendChild(option);
    });
    select.value = sourceId && sourceId !== state.teacherClassId ? sourceId : '';
    select.disabled = !state.teacherClassId;
    if (note) {
      const sourceName = state.teacherData?.plan_source?.name || 'this class';
      note.textContent = select.value
        ? `Shared plan: this section uses ${sourceName}. Publishing from either section updates the same weekly plan.`
        : 'Independent plan: link this section to another class to reuse one weekly plan across sections.';
      note.classList.toggle('is-shared', !!select.value);
    }
  }

  async function changePlanSource(event) {
    if (!state.teacherClassId) return;
    const select = event.currentTarget;
    const previous = state.teacherData?.plan_source?.id !== state.teacherClassId
      ? state.teacherData?.plan_source?.id || ''
      : '';
    const next = select.value || '';
    if (next === previous) return;
    if (!window.confirm('Switch this class to a different lesson plan source? Any unsaved editor changes will be discarded.')) {
      select.value = previous;
      return;
    }
    select.disabled = true;
    setTeacherStatus('Linking lesson plans…');
    try {
      state.teacherData = await fetchJson(
        `/api/teacher/classes/${encodeURIComponent(state.teacherClassId)}/lesson-plans/source`,
        {
          method: 'PUT',
          headers: authHeaders('teacher', true),
          body: JSON.stringify({ source_class_id: next, week: state.teacherWeek }),
        },
      );
      state.teacherWeek = state.teacherData.selected_week;
      renderTeacherEditor();
      setTeacherStatus(next ? 'Lesson plans linked. Both sections now use the same plan.' : 'This class now has an independent lesson plan.');
    } catch (error) {
      select.value = previous;
      setTeacherStatus(error.message || 'Could not link lesson plans.', true);
    } finally {
      select.disabled = false;
    }
  }

  function changeTeacherWeek(amount) {
    state.teacherWeek = shiftWeek(state.teacherWeek, amount);
    loadTeacherPlan();
  }

  async function loadTeacherPlan() {
    if (!state.teacherClassId) return;
    const classId = state.teacherClassId;
    const week = state.teacherWeek;
    const requestId = ++state.teacherRequest;
    state.teacherLoading = true;
    setTeacherStatus('Loading…');
    try {
      const data = await fetchJson(`/api/teacher/classes/${encodeURIComponent(classId)}/lesson-plans?week=${encodeURIComponent(week)}`, { headers: authHeaders('teacher') });
      if (requestId !== state.teacherRequest || classId !== state.teacherClassId) return;
      state.teacherData = data;
      state.teacherWeek = state.teacherData.selected_week;
      renderTeacherEditor();
      setTeacherStatus(state.teacherData.plan?.published_at ? 'Published plan loaded.' : 'Start a new weekly plan.');
    } catch (error) {
      if (requestId !== state.teacherRequest) return;
      setTeacherStatus(error.message || 'Could not load lesson plan.', true);
    } finally {
      if (requestId === state.teacherRequest) state.teacherLoading = false;
    }
  }

  function renderTeacherEditor() {
    const plan = state.teacherData?.plan;
    const grid = $('lessonPlanEditorGrid');
    if (!plan || !grid) return;
    $('lessonPlanTeacherWeekLabel').textContent = readableWeek(plan.week_start);
    syncPlanSourceControl();
    $('lessonPlanNotes').value = plan.notes_markdown || '';
    grid.textContent = '';
    DAYS.forEach((day, index) => {
      const item = plan.days?.[day] || {};
      const column = document.createElement('section');
      column.className = 'lesson-plan-editor-day';
      column.dataset.day = day;
      const date = new Date(`${item.date || dayDate(plan.week_start, index)}T12:00:00`);
      column.innerHTML = `<header><strong>${day.charAt(0).toUpperCase() + day.slice(1)}</strong><time>${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time></header>`;
      const textarea = document.createElement('textarea');
      textarea.dataset.lessonPlanDay = day;
      textarea.maxLength = 20000;
      textarea.placeholder = '- Learning objective\n- Activity or assignment\n- Assessment';
      textarea.value = item.markdown || '';
      column.appendChild(textarea);
      const pages = document.createElement('div');
      pages.className = 'lesson-plan-editor-pages';
      (item.wiki_pages || []).forEach((page) => pages.appendChild(editorPageRow(day, page)));
      (item.external_links || []).forEach((link) => pages.appendChild(editorExternalLinkRow(day, link)));
      column.appendChild(pages);
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'btn secondary lesson-plan-editor-add';
      add.textContent = '+ Add Wiki Page';
      add.addEventListener('click', () => openPicker(day));
      column.appendChild(add);
      const addExternal = document.createElement('button');
      addExternal.type = 'button';
      addExternal.className = 'btn secondary lesson-plan-editor-add lesson-plan-editor-add--external';
      addExternal.textContent = '+ Add External Link';
      addExternal.addEventListener('click', () => openExternalLinkModal(day));
      column.appendChild(addExternal);
      if (item.standards?.length) {
        const standards = window.LessonPlanRenderer.createStandardsPopover(
          day.charAt(0).toUpperCase() + day.slice(1), item.standards,
        );
        standards.classList.add('lesson-plan-editor-standards');
        column.appendChild(standards);
      } else {
        const standards = document.createElement('div');
        standards.className = 'lesson-plan-editor-standards';
        standards.textContent = '0 standards from linked pages';
        column.appendChild(standards);
      }
      grid.appendChild(column);
    });
  }

  function editorPageRow(day, page) {
    const row = document.createElement('div');
    row.className = 'lesson-plan-editor-page';
    row.dataset.nodeId = page.id;
    const label = document.createElement('span');
    label.textContent = page.title || 'Wiki page';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = `Remove ${label.textContent}`;
    remove.addEventListener('click', () => {
      captureEditorDraft();
      const item = state.teacherData.plan.days[day];
      item.wiki_pages = (item.wiki_pages || []).filter((entry) => entry.id !== page.id);
      item.wiki_node_ids = item.wiki_pages.map((entry) => entry.id);
      item.standards = mergedStandards(item.wiki_pages);
      renderTeacherEditor();
    });
    row.append(label, remove);
    return row;
  }

  function editorExternalLinkRow(day, link) {
    const row = document.createElement('div');
    row.className = 'lesson-plan-editor-page lesson-plan-editor-link';
    const label = document.createElement('a');
    label.href = link.url;
    label.target = '_blank';
    label.rel = 'noopener';
    label.textContent = link.title || link.url;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = `Remove ${label.textContent}`;
    remove.addEventListener('click', () => {
      captureEditorDraft();
      const item = state.teacherData.plan.days[day];
      item.external_links = (item.external_links || []).filter((entry) => entry.url !== link.url);
      renderTeacherEditor();
    });
    row.append(label, remove);
    return row;
  }

  function mergedStandards(pages) {
    const seen = new Set();
    const standards = [];
    (pages || []).forEach((page) => (page.standards || []).forEach((standard) => {
      const key = standard.id || String(standard.standard_id || '').toLowerCase();
      if (key && !seen.has(key)) { seen.add(key); standards.push(standard); }
    }));
    return standards;
  }

  function captureEditorDraft() {
    const plan = state.teacherData?.plan;
    if (!plan) return;
    DAYS.forEach((day) => {
      const textarea = document.querySelector(`[data-lesson-plan-day="${day}"]`);
      if (textarea && plan.days?.[day]) plan.days[day].markdown = textarea.value || '';
    });
    if ($('lessonPlanNotes')) plan.notes_markdown = $('lessonPlanNotes').value || '';
  }

  async function saveTeacherPlan() {
    const plan = state.teacherData?.plan;
    if (!plan || !state.teacherClassId) return;
    captureEditorDraft();
    setTeacherStatus('Publishing…');
    $('lessonPlanPublish').disabled = true;
    try {
      state.teacherData = await fetchJson(`/api/teacher/classes/${encodeURIComponent(state.teacherClassId)}/lesson-plans/${encodeURIComponent(state.teacherWeek)}`, {
        method: 'PUT', headers: authHeaders('teacher', true), body: JSON.stringify({
          expected_version: plan.version,
          days: Object.fromEntries(DAYS.map((day) => [day, {
            markdown: plan.days[day].markdown,
            wiki_node_ids: (plan.days[day].wiki_pages || []).map((page) => page.id),
            external_links: plan.days[day].external_links || [],
          }])),
          notes_markdown: plan.notes_markdown,
        }),
      });
      renderTeacherEditor();
      setTeacherStatus('Published. Students and public viewers now see these changes.');
      if (state.homeClassId === state.teacherClassId) loadHomePlan(state.homeData?.selected_week || '');
    } catch (error) {
      setTeacherStatus(error.message || 'Could not publish lesson plan.', true);
    } finally {
      $('lessonPlanPublish').disabled = false;
    }
  }

  async function sharing(reset = false) {
    return fetchJson(`/api/teacher/classes/${encodeURIComponent(state.teacherClassId)}/lesson-plans/sharing${reset ? '/reset' : ''}`, {
      method: 'POST', headers: authHeaders('teacher', true), body: '{}',
    });
  }

  function escapeAttribute(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function browserSharingPayload(data) {
    const publicPath = data.public_path || new URL(data.public_url).pathname;
    const embedPath = data.embed_path || new URL(data.embed_url).pathname;
    const publicUrl = new URL(publicPath, window.location.origin).toString();
    const embedUrl = new URL(embedPath, window.location.origin).toString();
    const title = escapeAttribute(`${data.class?.name || 'Class'} lesson plan`);
    return {
      ...data,
      public_url: publicUrl,
      embed_url: embedUrl,
      embed_code: `<iframe src="${escapeAttribute(embedUrl)}" title="${title}" style="width:100%;aspect-ratio:16/9;border:0" loading="lazy"></iframe>`,
    };
  }

  async function copyText(value) {
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(value); return; } catch (_error) { /* fallback below */ }
    }
    const textarea = document.createElement('textarea');
    textarea.value = value; textarea.style.position = 'fixed'; textarea.style.opacity = '0';
    document.body.appendChild(textarea); textarea.select(); document.execCommand('copy'); textarea.remove();
  }

  async function copySharing(field, message) {
    if (!state.teacherClassId) return;
    try {
      const data = browserSharingPayload(await sharing());
      await copyText(data[field]);
      setTeacherStatus(message);
    }
    catch (error) { setTeacherStatus(error.message || 'Could not copy link.', true); }
  }

  async function printTeacherPlan() {
    if (!state.teacherClassId) return;
    const printWindow = window.open('about:blank', '_blank');
    if (printWindow) printWindow.opener = null;
    try {
      const data = await fetchJson(
        `/api/teacher/classes/${encodeURIComponent(state.teacherClassId)}/lesson-plans/${encodeURIComponent(state.teacherWeek)}/print`,
        { method: 'POST', headers: authHeaders('teacher', true), body: '{}' },
      );
      const url = new URL(data.print_path, window.location.origin);
      if (printWindow) printWindow.location.href = url.toString();
      else await copyText(url.toString());
      setTeacherStatus(printWindow
        ? 'Opened the landscape print view. Choose “Save as PDF” in the print dialog.'
        : 'The print link was copied because the browser blocked the new window.');
    } catch (error) {
      printWindow?.close?.();
      setTeacherStatus(error.message || 'Could not open print view.', true);
    }
  }

  async function resetSharing() {
    if (!state.teacherClassId || !window.confirm('Reset the public link? Existing public and embed links will stop working.')) return;
    try { await sharing(true); setTeacherStatus('Public and embed links reset. Copy the new links when ready.'); }
    catch (error) { setTeacherStatus(error.message || 'Could not reset link.', true); }
  }

  function openPicker(day) {
    captureEditorDraft();
    state.pickerDay = day;
    $('lessonPlanWikiPickerTitle').textContent = `Add Wiki Content - ${day.charAt(0).toUpperCase() + day.slice(1)}`;
    $('lessonPlanWikiPickerTree').innerHTML = '<p class="lesson-plan-picker-message">Loading wiki contents…</p>';
    $('lessonPlanWikiPickerModal').style.display = 'flex';
    loadPickerTree();
  }

  function closePicker() {
    $('lessonPlanWikiPickerModal').style.display = 'none';
    state.pickerDay = '';
  }

  function treeHasPage(node) {
    return node?.kind === 'page' || (node?.children || []).some(treeHasPage);
  }

  function renderPickerNodes(nodes, target, depth = 0) {
    (nodes || []).filter(treeHasPage).forEach((node) => {
      if (node.kind === 'folder') {
        const folder = document.createElement('details');
        folder.className = 'lesson-plan-picker-folder';
        folder.open = depth < 1;
        const summary = document.createElement('summary');
        const icon = document.createElement('span');
        icon.className = 'lesson-plan-picker-icon';
        icon.textContent = node.icon || '📁';
        const title = document.createElement('strong');
        title.textContent = node.title || 'Folder';
        summary.append(icon, title);
        const children = document.createElement('div');
        children.className = 'lesson-plan-picker-children';
        renderPickerNodes(node.children || [], children, depth + 1);
        folder.append(summary, children);
        target.appendChild(folder);
        return;
      }
      if (node.kind !== 'page') return;
      const selected = state.teacherData?.plan?.days?.[state.pickerDay]?.wiki_pages || [];
      const alreadyLinked = selected.some((page) => page.id === node.id);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'lesson-plan-picker-page';
      button.disabled = alreadyLinked;
      button.setAttribute('role', 'treeitem');
      const icon = document.createElement('span');
      icon.className = 'lesson-plan-picker-icon';
      icon.textContent = node.icon || '📄';
      const copy = document.createElement('span');
      const title = document.createElement('strong');
      title.textContent = node.title || 'Wiki page';
      const description = document.createElement('small');
      description.textContent = alreadyLinked ? 'Already linked to this day' : (node.description || 'Published wiki page');
      copy.append(title, description);
      button.append(icon, copy);
      button.addEventListener('click', () => addWikiPage(node.id));
      target.appendChild(button);
    });
  }

  async function loadPickerTree() {
    const target = $('lessonPlanWikiPickerTree');
    target.classList.remove('is-error');
    try {
      const data = await fetchJson('/api/wiki/tree');
      if (!state.pickerDay || $('lessonPlanWikiPickerModal').style.display === 'none') return;
      target.textContent = '';
      renderPickerNodes(data.tree || [], target);
      if (!target.children.length) target.innerHTML = '<p class="lesson-plan-picker-message">No published wiki pages are available yet.</p>';
    } catch (error) {
      target.textContent = error.message || 'Could not load wiki contents.';
      target.classList.add('is-error');
    }
  }

  async function addWikiPage(nodeId) {
    const day = state.pickerDay;
    const item = state.teacherData?.plan?.days?.[day];
    if (!item) return;
    if ((item.wiki_pages || []).some((page) => page.id === nodeId)) { closePicker(); return; }
    try {
      const data = await fetchJson(`/api/wiki/nodes/${encodeURIComponent(nodeId)}`);
      const node = data.node;
      if (!node || node.kind !== 'page') throw new Error('That wiki page is unavailable.');
      item.wiki_pages = [...(item.wiki_pages || []), {
        id: node.id, title: node.title, slug: node.slug, url: `/wiki/${node.slug}`,
        description: node.description || '', standards: node.standards || [],
      }];
      item.wiki_node_ids = item.wiki_pages.map((page) => page.id);
      item.standards = mergedStandards(item.wiki_pages);
      closePicker(); renderTeacherEditor();
    } catch (error) { $('lessonPlanWikiPickerTree').textContent = error.message || 'Could not add wiki page.'; }
  }

  function openExternalLinkModal(day) {
    captureEditorDraft();
    state.externalLinkDay = day;
    $('lessonPlanExternalLinkTitle').textContent = `Add External Link - ${day.charAt(0).toUpperCase() + day.slice(1)}`;
    $('lessonPlanExternalLinkUrl').value = '';
    $('lessonPlanExternalLinkStatus').textContent = '';
    $('lessonPlanExternalLinkStatus').classList.remove('is-error');
    $('lessonPlanExternalLinkModal').style.display = 'flex';
    setTimeout(() => $('lessonPlanExternalLinkUrl').focus(), 0);
  }

  function closeExternalLinkModal() {
    $('lessonPlanExternalLinkModal').style.display = 'none';
    state.externalLinkDay = '';
  }

  async function addExternalLink() {
    const day = state.externalLinkDay;
    const input = $('lessonPlanExternalLinkUrl');
    const status = $('lessonPlanExternalLinkStatus');
    const submit = $('lessonPlanExternalLinkAdd');
    const url = String(input?.value || '').trim();
    if (!day || !url) {
      status.textContent = 'Enter an HTTP or HTTPS link.';
      status.classList.add('is-error');
      return;
    }
    submit.disabled = true;
    status.textContent = 'Reading the page title…';
    status.classList.remove('is-error');
    try {
      const data = await fetchJson('/api/teacher/lesson-plans/link-preview', {
        method: 'POST',
        headers: authHeaders('teacher', true),
        body: JSON.stringify({ url }),
      });
      const item = state.teacherData?.plan?.days?.[day];
      if (!item) throw new Error('Reload the lesson plan and try again.');
      item.external_links = item.external_links || [];
      if (!item.external_links.some((entry) => entry.url === data.link.url)) {
        item.external_links.push(data.link);
      }
      closeExternalLinkModal();
      renderTeacherEditor();
    } catch (error) {
      status.textContent = error.message || 'Could not add that external link.';
      status.classList.add('is-error');
    } finally {
      submit.disabled = false;
    }
  }

  function selectedHomeClass(classIdHint = '') {
    const ctx = context();
    const wikiSelected = window.WikiReader?.getState?.().selectedClassId;
    const teacher = !!ctx.TEACHER_TOKEN && !ctx.USER_TOKEN && !ctx.ADMIN_TOKEN;
    const classes = teacher ? (ctx.teacherClasses || []) : (ctx.studentClasses || []);
    const preferred = classIdHint || wikiSelected || (teacher ? ctx.currentTeacherClassId : ctx.currentStudentClassId);
    return classes.some((item) => item.id === preferred) ? preferred : (classes[0]?.id || '');
  }

  async function loadHomePlan(week = '', classIdHint = '') {
    const ctx = context();
    const section = $('studentLessonPlanSection');
    if (!section) return;
    const isStudent = !!ctx.USER_TOKEN && !ctx.TEACHER_TOKEN && !ctx.ADMIN_TOKEN;
    const isTeacher = !!ctx.TEACHER_TOKEN && !ctx.USER_TOKEN && !ctx.ADMIN_TOKEN;
    section.hidden = !isStudent && !isTeacher;
    if (!isStudent && !isTeacher) return;
    const classId = selectedHomeClass(classIdHint);
    state.homeClassId = classId;
    if (!classId) { section.hidden = true; return; }
    const requestId = ++state.homeRequest;
    $('studentLessonPlanStatus').textContent = 'Loading lesson plan…';
    $('studentLessonPlanStatus').classList.remove('is-error');
    try {
      const suffix = week ? `?week=${encodeURIComponent(week)}` : '';
      const endpoint = isTeacher
        ? `/api/teacher/classes/${encodeURIComponent(classId)}/lesson-plans${suffix}`
        : `/api/classes/${encodeURIComponent(classId)}/lesson-plans${suffix}`;
      const data = await fetchJson(endpoint, { headers: authHeaders(isTeacher ? 'teacher' : 'student') });
      if (requestId !== state.homeRequest) return;
      state.homeData = data;
      $('studentLessonPlanStatus').textContent = '';
      $('studentLessonPlanHeading').textContent = `${data.class?.name || 'Class'} Lesson Plan`;
      $('studentLessonPlanWeekLabel').textContent = readableWeek(data.selected_week);
      $('studentLessonPlanPrevious').disabled = !data.previous_week;
      $('studentLessonPlanNext').disabled = !data.next_week;
      window.LessonPlanRenderer.render($('studentLessonPlanHost'), data);
    } catch (error) {
      if (requestId !== state.homeRequest) return;
      $('studentLessonPlanStatus').textContent = error.message || 'Could not load lesson plan.';
      $('studentLessonPlanStatus').classList.add('is-error');
    }
  }

  function attach() {
    buildTeacherShell();
    document.querySelector('[data-view="dash-lesson-plans"]')?.addEventListener('click', () => {
      syncTeacherClasses();
      if (!state.teacherData || state.teacherData.class?.id !== state.teacherClassId) loadTeacherPlan();
    });
    $('lessonPlanWikiPickerCancel')?.addEventListener('click', closePicker);
    $('lessonPlanWikiPickerModal')?.addEventListener('click', (event) => { if (event.target === $('lessonPlanWikiPickerModal')) closePicker(); });
    $('lessonPlanExternalLinkCancel')?.addEventListener('click', closeExternalLinkModal);
    $('lessonPlanExternalLinkAdd')?.addEventListener('click', addExternalLink);
    $('lessonPlanExternalLinkUrl')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); addExternalLink(); }
    });
    $('lessonPlanExternalLinkModal')?.addEventListener('click', (event) => {
      if (event.target === $('lessonPlanExternalLinkModal')) closeExternalLinkModal();
    });
    $('studentLessonPlanPrevious')?.addEventListener('click', () => state.homeData?.previous_week && loadHomePlan(state.homeData.previous_week));
    $('studentLessonPlanNext')?.addEventListener('click', () => state.homeData?.next_week && loadHomePlan(state.homeData.next_week));
    window.addEventListener('eagle-context-updated', () => { syncTeacherClasses(); loadHomePlan(); });
    window.addEventListener('wiki-home-rendered', (event) => loadHomePlan('', event.detail?.classId));
    loadHomePlan();
  }

  attach();
  window.LessonPlans = { loadHomePlan, loadStudentPlan: loadHomePlan, loadTeacherPlan };
})();
