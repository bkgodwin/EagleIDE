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
    homeScope: '',
    activeDay: DAYS[Math.min(4, (new Date().getDay() + 6) % 7)],
    caret: {}, drafts: new Map(), dirty: false, scope: '', previewTimer: null,
    publishing: new Set(),
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
    if(role==='account') {
      if(ctx.USER_TOKEN) headers['X-User-Token']=ctx.USER_TOKEN;
      else if(ctx.TEACHER_TOKEN) headers['X-Teacher-Token']=ctx.TEACHER_TOKEN;
      else if(ctx.ADMIN_TOKEN) headers['X-Admin-Token']=ctx.ADMIN_TOKEN;
      return headers;
    }
    if (role === 'teacher' && ctx.TEACHER_TOKEN) headers['X-Teacher-Token'] = ctx.TEACHER_TOKEN;
    if (role === 'student' && ctx.USER_TOKEN) headers['X-User-Token'] = ctx.USER_TOKEN;
    return headers;
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, {signal:AbortSignal.timeout(30000), ...options});
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
        <header class="agenda-workspace-heading"><div><span class="agenda-eyebrow">CLASSROOM PLANNING</span><h2>Plan your week</h2><p>Your agenda, examples, and assignments in one place.</p></div><button class="btn run" id="lessonPlanPublish" type="button">Publish week</button></header>
        <div class="lesson-plan-teacher-toolbar">
          <div class="lesson-plan-week-nav">
            <label>Class <select id="lessonPlanTeacherClass"></select></label>
            <button class="btn secondary" id="lessonPlanTeacherPrevious" type="button">← Previous</button>
            <button class="btn secondary" id="lessonPlanTeacherCurrent" type="button">Current week</button>
            <span class="lesson-plan-week-label" id="lessonPlanTeacherWeekLabel"></span>
            <button class="btn secondary" id="lessonPlanTeacherNext" type="button">Next →</button>
            <button class="btn secondary" id="lessonPlanReload" type="button" title="Discard this week’s draft and reload the published version">Reload published</button>
            <button class="btn secondary" id="lessonPlanPrintAll" type="button" title="Open a PDF of this published week for every class you teach">Print Week (all classes)</button>
          </div>
        </div>
        <details class="agenda-settings"><summary>Sharing &amp; plan settings</summary><div class="lesson-plan-week-nav">
            <label>Plan source <select id="lessonPlanTeacherSource"></select></label>
            <button class="btn secondary" id="lessonPlanCopyPublic" type="button">Copy Public Link</button>
            <button class="btn secondary" id="lessonPlanCopyCurrent" type="button" title="This link always opens whichever lesson plan week is current">Copy Current Week Link</button>
            <button class="btn secondary" id="lessonPlanCopyEmbed" type="button">Copy Embed</button>
            <button class="btn secondary" id="lessonPlanPrint" type="button">Print / Save PDF</button>
            <button class="btn secondary" id="lessonPlanResetLink" type="button" title="Disable the old public and embed links">Reset Link</button>
          </div><div class="lesson-plan-source-note" id="lessonPlanTeacherSourceNote"></div></details>
        <div class="agenda-day-tabs" id="lessonPlanDayTabs" role="tablist" aria-label="Plan a day"></div>
        <div class="lesson-plan-editor-scroll"><div class="lesson-plan-editor-grid" id="lessonPlanEditorGrid"></div></div>
        <div class="agenda-workspace-footer">
          <label class="lesson-plan-notes-editor"><strong>Additional notes</strong><textarea id="lessonPlanNotes" maxlength="20000" placeholder="Notes for the whole week (Markdown supported)"></textarea></label>
          <aside class="agenda-featured"><div><strong>Featured class wiki</strong><button type="button" class="btn secondary" id="lessonPlanFeatureAdd">+ Change content</button></div><p>Shown on your class home page.</p><div id="lessonPlanFeaturedList"></div></aside>
        </div><span class="lesson-plan-status" id="lessonPlanTeacherStatus" role="status" aria-live="polite"></span>
      </div>`;
    $('lessonPlanTeacherClass').addEventListener('change', (event) => {
      if(!retainDraft()) {event.target.value=state.teacherClassId; return;}
      state.teacherClassId = event.target.value || '';
      loadTeacherPlan();
    });
    $('lessonPlanTeacherSource').addEventListener('change', changePlanSource);
    $('lessonPlanReload').onclick=()=>{
      if((state.dirty || state.drafts.has(teacherScope())) && !window.confirm('Discard this week’s unpublished edits and reload the published plan?')) return;
      state.drafts.delete(teacherScope()); state.dirty=false; loadTeacherPlan();
    };
    $('lessonPlanTeacherPrevious').addEventListener('click', () => changeTeacherWeek(-1));
    $('lessonPlanTeacherNext').addEventListener('click', () => changeTeacherWeek(1));
    $('lessonPlanTeacherCurrent').addEventListener('click', () => { if(!retainDraft()) return; state.teacherWeek = mondayFor(new Date()); loadTeacherPlan(); });
    $('lessonPlanNotes').addEventListener('input', markDirty);
    $('lessonPlanFeatureAdd').addEventListener('click', () => openPicker('featured'));
    $('lessonPlanPublish').addEventListener('click', saveTeacherPlan);
    $('lessonPlanCopyPublic').addEventListener('click', () => copySharing('public_url', 'Public link copied.'));
    $('lessonPlanCopyCurrent').addEventListener('click', () => copySharing('current_url', 'Current-week link copied.'));
    $('lessonPlanCopyEmbed').addEventListener('click', () => copySharing('embed_code', 'Embed code copied.'));
    $('lessonPlanPrint').addEventListener('click', printTeacherPlan);
    $('lessonPlanPrintAll').addEventListener('click', printAllClasses);
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
    $('lessonPlanPublish').disabled = !state.teacherClassId || state.scope!==teacherScope() || state.teacherLoading || state.publishing.has(teacherScope());
    syncPlanSourceControl();
  }

  function syncPlanSourceControl() {
    const select = $('lessonPlanTeacherSource');
    const note = $('lessonPlanTeacherSourceNote');
    if (!select) return;
    const coTeacher = !!context().currentTeacher?.is_coteacher;
    ['lessonPlanCopyPublic', 'lessonPlanCopyCurrent', 'lessonPlanCopyEmbed', 'lessonPlanResetLink'].forEach(id => { $(id).hidden = coTeacher; });
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
    select.disabled = !state.teacherClassId || coTeacher;
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
    const scope=teacherScope();
    setTeacherStatus('Linking lesson plans…');
    try {
      const data = await fetchJson(
        `/api/teacher/classes/${encodeURIComponent(state.teacherClassId)}/lesson-plans/source`,
        {
          method: 'PUT',
          headers: authHeaders('teacher', true),
          body: JSON.stringify({ source_class_id: next, week: state.teacherWeek }),
        },
      );
      if(scope!==teacherScope()) return;
      state.teacherData=data; state.scope=scope; state.dirty=false; state.drafts.delete(scope);
      state.teacherWeek = state.teacherData.selected_week;
      renderTeacherEditor();
      setTeacherStatus(next ? 'Lesson plans linked. Both sections now use the same plan.' : 'This class now has an independent lesson plan.');
    } catch (error) {
      if(scope===teacherScope()) {select.value = previous; setTeacherStatus(error.message || 'Could not link lesson plans.', true);}
    } finally {
      select.disabled = false;
    }
  }

  function changeTeacherWeek(amount) {
    if(!retainDraft()) return;
    state.teacherWeek = shiftWeek(state.teacherWeek, amount);
    loadTeacherPlan();
  }

  async function loadTeacherPlan() {
    if (!state.teacherClassId) return;
    const classId = state.teacherClassId;
    const week = state.teacherWeek;
    const requestId = ++state.teacherRequest;
    const scope = teacherScope();
    $('lessonPlanPublish').disabled = true;
    state.teacherLoading = true;
    $('lessonPlanEditorGrid').inert=true; $('lessonPlanNotes').disabled=true;
    setTeacherStatus('Loading…');
    try {
      const data = await fetchJson(`/api/teacher/classes/${encodeURIComponent(classId)}/lesson-plans?week=${encodeURIComponent(week)}`, { headers: authHeaders('teacher') });
      if (requestId !== state.teacherRequest || classId !== state.teacherClassId || scope !== teacherScope()) return;
      state.teacherData = state.drafts.get(scope) || data;
      state.dirty = state.drafts.has(scope);
      state.scope = scope;
      $('lessonPlanEditorGrid').inert=false; $('lessonPlanNotes').disabled=false;
      state.teacherWeek = state.teacherData.selected_week;
      renderTeacherEditor();
      loadFeatured();
      setTeacherStatus(state.dirty ? 'Restored unpublished changes.' : state.teacherData.plan?.published_at ? 'Published plan loaded.' : 'Start a new weekly plan.');
    } catch (error) {
      if (requestId !== state.teacherRequest) return;
      setTeacherStatus(error.message || 'Could not load lesson plan.', true);
    } finally {
      if (requestId === state.teacherRequest) {state.teacherLoading = false; $('lessonPlanPublish').disabled = state.scope!==teacherScope() || state.publishing.has(teacherScope());}
    }
  }

  function renderTeacherEditor() {
    const focusedDay=document.activeElement?.dataset?.lessonPlanDay;
    const plan = state.teacherData?.plan;
    const grid = $('lessonPlanEditorGrid');
    if (!plan || !grid) return;
    $('lessonPlanTeacherWeekLabel').textContent = readableWeek(plan.week_start);
    syncPlanSourceControl();
    $('lessonPlanNotes').value = plan.notes_markdown || '';
    grid.textContent = '';
    const tabs = $('lessonPlanDayTabs'); tabs.textContent = '';
    DAYS.forEach((day, index) => {
      const item = plan.days?.[day] || {};
      const column = document.createElement('section');
      column.className = 'lesson-plan-editor-day';
      column.dataset.day = day;
      column.hidden = state.activeDay !== day;
      column.id = `agenda-day-${day}`;
      column.setAttribute('role','tabpanel');
      const tab = document.createElement('button'); tab.type='button'; tab.className='agenda-day-tab'; tab.textContent=day.charAt(0).toUpperCase()+day.slice(1);
      tab.setAttribute('role','tab'); tab.setAttribute('aria-selected', String(state.activeDay === day)); tab.setAttribute('aria-controls',column.id); tab.tabIndex = state.activeDay === day ? 0 : -1;
      if (item.color) tab.style.setProperty('--agenda-color',item.color);
      tab.onclick = () => {captureEditorDraft(); state.activeDay=day; renderTeacherEditor(); $('lessonPlanDayTabs').children[index]?.focus();};
      tab.onkeydown = event => {if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return; event.preventDefault(); const next=event.key==='Home'?0:event.key==='End'?4:(index+(event.key==='ArrowRight'?1:4))%5; tabs.children[next].click();};
      tabs.appendChild(tab);
      const date = new Date(`${item.date || dayDate(plan.week_start, index)}T12:00:00`);
      column.innerHTML = `<header><strong>${day.charAt(0).toUpperCase() + day.slice(1)}</strong><time>${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time></header>`;
      const textarea = document.createElement('textarea');
      textarea.dataset.lessonPlanDay = day;
      textarea.maxLength = 20000;
      textarea.placeholder = '- Learning objective\n- Activity or assignment\n- Assessment';
      textarea.value = item.markdown || '';
      textarea.setAttribute('aria-label', `${day} agenda (Markdown)`);
      const rememberCaret = () => {state.caret[day] = [textarea.selectionStart, textarea.selectionEnd];};
      ['click','keyup','select','blur'].forEach(type => textarea.addEventListener(type, rememberCaret));
      textarea.addEventListener('input', () => {rememberCaret(); item.markdown=textarea.value; markDirty(); schedulePreview(day);});
      textarea.addEventListener('paste', event => {const image=[...(event.clipboardData?.items || [])].find(item => item.kind==='file' && item.type.startsWith('image/')); if(image) {event.preventDefault(); rememberCaret(); insertImage(day,image.getAsFile());}});
      textarea.addEventListener('drop', () => setTimeout(() => {rememberCaret(); item.markdown=textarea.value; markDirty(); schedulePreview(day);},0));
      const toolbar = document.createElement('div'); toolbar.className='agenda-day-tools';
      const action = (label, run) => {const button=document.createElement('button'); button.type='button'; button.className='btn secondary'; button.textContent=label; button.addEventListener('mousedown', event => event.preventDefault()); button.onclick=run; toolbar.appendChild(button);};
      action('+ Image', () => chooseImage(day)); action('+ Wiki / section', () => openPicker(day));
      action('+ IDE file', () => chooseFile(day)); action('+ Assignment', () => chooseAssignment(day)); action('+ Web link', () => openExternalLinkModal(day));
      const colorLabel=document.createElement('label'); colorLabel.className='agenda-color-label'; colorLabel.textContent='Day color';
      const color=document.createElement('input'); color.type='color'; color.value=item.color || '#4d8fb6'; color.setAttribute('aria-label',`${day} background color`);
      color.oninput=() => {item.color=color.value; tab.style.setProperty('--agenda-color',item.color); markDirty(); schedulePreview(day);}; colorLabel.appendChild(color); toolbar.appendChild(colorLabel);
      action('Clear color', () => {item.color=''; tab.style.removeProperty('--agenda-color'); markDirty(); schedulePreview(day);});
      column.appendChild(toolbar);
      const split=document.createElement('div'); split.className='agenda-composer';
      const source=document.createElement('label'); source.className='agenda-source'; source.innerHTML='<span>Agenda <small>Markdown · paste images · drag wiki tiles into the text</small></span>'; source.appendChild(textarea);
      const preview=document.createElement('div'); preview.className='agenda-day-preview lesson-plan-markdown wiki-markdown'; preview.id=`agenda-preview-${day}`;
      const previewWrap=document.createElement('div'); previewWrap.className='agenda-preview-wrap'; previewWrap.innerHTML='<span class="agenda-preview-caption">STUDENT PREVIEW</span>'; previewWrap.appendChild(preview);
      split.append(source,previewWrap); column.appendChild(split);
      const pages = document.createElement('div');
      pages.className = 'lesson-plan-editor-pages';
      (item.wiki_pages || []).forEach((page) => pages.appendChild(editorPageRow(day, page)));
      (item.external_links || []).forEach((link) => pages.appendChild(editorExternalLinkRow(day, link)));
      (item.attachments || []).forEach(file => pages.appendChild(removableResource(file.name, () => {item.attachments=item.attachments.filter(x=>x.id!==file.id); item.attachment_ids=item.attachments.map(x=>x.id);})));
      (item.assignments || []).forEach(assignment => pages.appendChild(removableResource(`Assignment · ${assignment.name}`, () => {item.assignments=item.assignments.filter(x=>x.id!==assignment.id); item.assignment_ids=item.assignments.map(x=>x.id);})));
      column.appendChild(pages);
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'btn secondary lesson-plan-editor-add';
      add.textContent = '+ Add Wiki Page';
      add.hidden = true;
      add.addEventListener('click', () => openPicker(day));
      column.appendChild(add);
      const addExternal = document.createElement('button');
      addExternal.type = 'button';
      addExternal.className = 'btn secondary lesson-plan-editor-add lesson-plan-editor-add--external';
      addExternal.textContent = '+ Add External Link';
      addExternal.hidden = true;
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
      if (!column.hidden) schedulePreview(day);
    });
    if (state.dirty) setTeacherStatus('Unpublished changes · retained while you switch days, weeks, or classes.');
    if(focusedDay===state.activeDay) {const textarea=document.querySelector(`[data-lesson-plan-day="${focusedDay}"]`); textarea?.focus(); if(textarea && state.caret[focusedDay]) textarea.setSelectionRange(...state.caret[focusedDay]);}
  }

  function teacherScope() { return `${context().TEACHER_TOKEN || ''}:${state.teacherClassId}:${state.teacherWeek}`; }
  function markDirty() {state.dirty=true; setTeacherStatus('Unpublished changes · publish when ready.');}
  function retainDraft() {
    if (!state.teacherData || !state.scope) return true;
    captureEditorDraft();
    if (state.dirty) {
      if(!state.drafts.has(state.scope) && state.drafts.size>=24) {setTeacherStatus('24 drafts are retained. Publish a draft before opening another week or class.',true); return false;}
      state.drafts.set(state.scope, structuredClone(state.teacherData));
    }
    return true;
  }
  function schedulePreview(day) {
    clearTimeout(state.previewTimer);
    state.previewTimer=setTimeout(() => {
      const item=state.teacherData?.plan?.days?.[day], host=$(`agenda-preview-${day}`);
      if (!item || !host) return;
      host.style.removeProperty('--agenda-color');
      window.LessonPlanRenderer.renderDayContent(host,item,state.teacherData,{preview:true});
    },120);
  }
  function insertText(day, text) {
    const textarea=document.querySelector(`[data-lesson-plan-day="${day}"]`);
    if (!textarea || state.scope !== teacherScope()) return;
    const caret=state.caret[day] || [textarea.value.length,textarea.value.length];
    if (textarea.value.length + text.length - (caret[1]-caret[0]) > 20000) {setTeacherStatus('This day has reached the 20,000 character limit.',true); return;}
    textarea.setSelectionRange(...caret); textarea.setRangeText(text,caret[0],caret[1],'end');
    textarea.dispatchEvent(new Event('input')); textarea.focus();
  }
  function removableResource(label, remove, planEdit=true) {
    const row=document.createElement('div'); row.className='lesson-plan-editor-page';
    const text=document.createElement('span'); text.textContent=label;
    const button=document.createElement('button'); button.type='button'; button.textContent='×'; button.title=`Remove ${label}`;
    button.onclick=async() => {if(!planEdit) {button.disabled=true; try {await remove();} finally {button.disabled=false;} return;} captureEditorDraft(); remove(); markDirty(); renderTeacherEditor();}; row.append(text,button); return row;
  }
  function modalKey(event, root, close) {
    if(event.key==='Escape') {event.preventDefault();event.stopPropagation();close();return;}
    if(event.key!=='Tab') return;
    const items=[...root.querySelectorAll('button,input,select,textarea,a[href],summary')].filter(el=>!el.disabled && el.offsetParent!==null);
    if(!items.length) return;
    if(event.shiftKey && document.activeElement===items[0]) {event.preventDefault();items.at(-1).focus();}
    else if(!event.shiftKey && document.activeElement===items.at(-1)) {event.preventDefault();items[0].focus();}
  }
  function resourceDialog(title) {
    const previous=document.activeElement, root=document.createElement('div'); root.className='modal agenda-resource-modal';
    root.innerHTML='<div class="modal-content" role="dialog" aria-modal="true"><header><h3></h3><button type="button" class="btn secondary">Close</button></header><input type="search" placeholder="Filter resources…" aria-label="Filter resources"><div class="agenda-resource-list"></div><p role="status"></p></div>';
    root.querySelector('h3').textContent=title; root.querySelector('[role="dialog"]').setAttribute('aria-label',title);
    document.body.appendChild(root);
    const close=() => {root.remove(); if(previous?.isConnected) previous.focus();}; root.querySelector('button').onclick=close;
    root.querySelector('input').oninput=event=>{const query=event.target.value.toLowerCase().trim(); root.querySelectorAll('.agenda-resource-list button').forEach(button=>{button.hidden=!button.textContent.toLowerCase().includes(query);});};
    root.onclick=event => {if(event.target===root) close();};
    root.onkeydown=event=>modalKey(event,root,close);
    root.querySelector('input').focus();
    return {root,close,list:root.querySelector('.agenda-resource-list'),status:root.querySelector('[role="status"]')};
  }
  async function insertImage(day, file) {
    if (!file || file.size>5*1024*1024) {setTeacherStatus('Choose an image smaller than 5 MB.',true); return;}
    const scope=teacherScope(), form=new FormData(); form.append('image',file);
    setTeacherStatus('Uploading image…');
    try {
      const data=await fetchJson(`/api/teacher/classes/${encodeURIComponent(state.teacherClassId)}/lesson-plans/${state.teacherWeek}/assets`,{method:'POST',headers:authHeaders('teacher'),body:form});
      if(scope!==teacherScope()) return;
      const item=state.teacherData.plan.days[day]; item.images=item.images || [];
      item.images.push({id:data.asset.id,url:`/api/lesson-plans/${state.teacherClassId}/${state.teacherWeek}/assets/${data.asset.id}`});
      insertText(day,`\n![Agenda image](agenda-image:${data.asset.id})\n`);
    } catch(error) {if(scope===teacherScope()) setTeacherStatus(error.message,true);}
  }
  function chooseImage(day) {const input=document.createElement('input'); input.type='file'; input.accept='image/jpeg,image/png,image/webp,image/gif'; input.onchange=()=>insertImage(day,input.files[0]); input.click();}
  async function addFile(day,path) {
    const scope=teacherScope();
    const data=await fetchJson(`/api/teacher/classes/${encodeURIComponent(state.teacherClassId)}/lesson-plans/${state.teacherWeek}/assets`,{method:'POST',headers:authHeaders('teacher',true),body:JSON.stringify({path})});
    if(scope!==teacherScope()) return false;
    captureEditorDraft(); const item=state.teacherData.plan.days[day]; item.attachments=[...(item.attachments || []),data.asset]; item.attachment_ids=item.attachments.map(file=>file.id);
    markDirty(); renderTeacherEditor(); return true;
  }
  async function chooseFile(day) {
    const dialog=resourceDialog('Attach an IDE file'), scope=teacherScope(); dialog.status.textContent='Loading workspace files…';
    try {
      const data=await fetchJson('/api/files/list',{headers:authHeaders('teacher')});
      if(scope!==teacherScope() || !dialog.root.isConnected) return;
      const visit=nodes => (nodes || []).forEach(node => {if(node.type==='folder') {if(node.name!=='Trash') visit(node.children);} else if(/\.(py|js|html|css|txt|md|json|csv|svg)$/i.test(node.name || '')) {
        const button=document.createElement('button'); button.type='button'; button.className='lesson-plan-picker-page'; button.textContent=node.path || node.name;
        button.onclick=async()=>{button.disabled=true; try {if(await addFile(day,node.path)) dialog.close();} catch(error) {dialog.status.textContent=error.message;button.disabled=false;}}; dialog.list.appendChild(button);
      }}); visit(data.files || []);
      dialog.status.textContent=dialog.list.children.length ? 'A snapshot is attached. Later edits to your file stay in your workspace.' : 'No supported files found. Save an IDE file first.';
    } catch(error) {dialog.status.textContent=error.message;}
  }
  function chooseAssignment(day) {
    const dialog=resourceDialog('Link an assignment'), item=state.teacherData.plan.days[day];
    for (const assignment of state.teacherData.assignment_choices || []) {
      const button=document.createElement('button'); button.type='button'; button.className='lesson-plan-picker-page'; button.textContent=assignment.name;
      button.disabled=(item.assignment_ids || []).includes(assignment.id);
      button.onclick=()=>{captureEditorDraft(); item.assignments=[...(item.assignments || []),assignment]; item.assignment_ids=item.assignments.map(x=>x.id); markDirty(); dialog.close(); renderTeacherEditor();}; dialog.list.appendChild(button);
    }
    if(!dialog.list.children.length) dialog.status.textContent='Create an assignment for this class first.';
  }
  async function loadFeatured() {
    const scope=teacherScope(), host=$('lessonPlanFeaturedList'); if(!host) return;
    $('lessonPlanFeatureAdd').hidden=!!context().currentTeacher?.is_coteacher;
    try {
      const data=await fetchJson(`/api/wiki/classes/${encodeURIComponent(state.teacherClassId)}/features`,{headers:context().currentTeacher?.is_coteacher ? {'X-User-Token':context().TEACHER_TOKEN} : authHeaders('teacher')});
      if(scope!==teacherScope()) return; host.textContent='';
      for (const page of data.featured || []) {
        const row=removableResource(page.title, () => changeFeatured(page.node_id,'DELETE'),false);
        row.querySelector('button').hidden=!!context().currentTeacher?.is_coteacher; host.appendChild(row);
      }
      if(!host.children.length) host.textContent='No featured content yet. Choose a wiki page to put it here.';
    } catch(error) {if(scope===teacherScope()) host.textContent=error.message;}
  }
  async function changeFeatured(nodeId, method='PUT') {
    const scope=teacherScope();
    try {
      await fetchJson(`/api/wiki/classes/${encodeURIComponent(state.teacherClassId)}/features/${encodeURIComponent(nodeId)}`,{method,headers:authHeaders('teacher')});
      if(scope!==teacherScope()) return; await loadFeatured(); window.WikiReader?.loadHome?.({quiet:true});
    } catch(error) {if(scope===teacherScope()) setTeacherStatus(error.message,true);}
  }

  function editorPageRow(day, page) {
    const row = document.createElement('div');
    row.className = 'lesson-plan-editor-page';
    row.dataset.nodeId = page.id;
    const label = document.createElement('span');
    label.textContent = page.section_title ? `${page.title} › ${page.section_title}` : page.title || 'Wiki page';
    const markdown=`[${label.textContent.replace(/[\[\]\\]/g,'')}](${page.url || `/wiki/${page.slug}`})`;
    row.draggable=true; row.title='Drag this tile into the agenda, or choose Insert';
    row.addEventListener('dragstart', event => event.dataTransfer.setData('text/plain',markdown));
    const insert=document.createElement('button'); insert.type='button'; insert.textContent='Insert'; insert.title='Insert this wiki tile at the agenda cursor'; insert.onclick=()=>insertText(day,markdown);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = `Remove ${label.textContent}`;
    remove.addEventListener('click', () => {
      captureEditorDraft();
      const item = state.teacherData.plan.days[day];
      item.wiki_pages = (item.wiki_pages || []).filter((entry) => entry.id !== page.id || (entry.anchor || '') !== (page.anchor || ''));
      item.markdown=item.markdown.split(markdown).join('');
      item.wiki_node_ids = item.wiki_pages.map((entry) => entry.id);
      item.standards = mergedStandards(item.wiki_pages);
      markDirty();
      renderTeacherEditor();
    });
    row.append(label, insert, remove);
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
      markDirty();
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
    if (!plan || !state.teacherClassId || state.scope!==teacherScope() || state.teacherLoading || state.publishing.has(teacherScope())) return false;
    captureEditorDraft();
    const scope=teacherScope(), submitted=JSON.stringify(plan), classId=state.teacherClassId, week=state.teacherWeek;
    state.publishing.add(scope);
    setTeacherStatus('Publishing…');
    $('lessonPlanPublish').disabled = true;
    try {
      const data = await fetchJson(`/api/teacher/classes/${encodeURIComponent(classId)}/lesson-plans/${encodeURIComponent(week)}`, {
        method: 'PUT', headers: authHeaders('teacher', true), body: JSON.stringify({
          expected_version: plan.version,
          days: Object.fromEntries(DAYS.map((day) => [day, {
            markdown: plan.days[day].markdown,
            wiki_node_ids: (plan.days[day].wiki_pages || []).map((page) => page.id),
            wiki_links: (plan.days[day].wiki_pages || []).map(page=>({node_id:page.id,anchor:page.anchor || ''})),
            color: plan.days[day].color || '',
            attachment_ids: plan.days[day].attachment_ids || [],
            assignment_ids: plan.days[day].assignment_ids || [],
            external_links: plan.days[day].external_links || [],
          }])),
          notes_markdown: plan.notes_markdown,
        }),
      });
      if(scope!==teacherScope()) {
        const retained=state.drafts.get(scope);
        if(retained) {if(JSON.stringify(retained.plan)===submitted) state.drafts.delete(scope); else retained.plan.version=data.plan.version;}
        return true;
      }
      captureEditorDraft();
      if(JSON.stringify(state.teacherData.plan)!==submitted) {
        state.teacherData.plan.version=data.plan.version; markDirty(); retainDraft();
        setTeacherStatus('Published. Newer edits are still unpublished.'); return true;
      }
      state.teacherData = data; state.dirty=false; state.drafts.delete(scope);
      renderTeacherEditor();
      setTeacherStatus('Published. Students and public viewers now see these changes.');
      if (state.homeClassId === state.teacherClassId) loadHomePlan(state.homeData?.selected_week || '');
      window.WikiReader?.loadReferenceAgenda?.({force:true});
      return true;
    } catch (error) {
      if(scope===teacherScope()) setTeacherStatus(error.message || 'Could not publish lesson plan.', true);
      return false;
    } finally {
      state.publishing.delete(scope);
      $('lessonPlanPublish').disabled = state.scope!==teacherScope() || state.teacherLoading || state.publishing.has(teacherScope());
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
    const currentPath = data.current_path || new URL(data.current_url).pathname;
    const embedPath = data.embed_path || new URL(data.embed_url).pathname;
    const publicUrlObject = new URL(publicPath, window.location.origin);
    publicUrlObject.searchParams.set('week', state.teacherWeek);
    const publicUrl = publicUrlObject.toString();
    const currentUrl = new URL(currentPath, window.location.origin).toString();
    const embedUrl = new URL(embedPath, window.location.origin).toString();
    const title = escapeAttribute(`${data.class?.name || 'Class'} lesson plan`);
    return {
      ...data,
      public_url: publicUrl,
      current_url: currentUrl,
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

  async function printAllClasses() {
    const scope=teacherScope(), button=$('lessonPlanPrintAll'), popup=window.open('about:blank','_blank');
    if(popup) popup.opener=null;
    button.disabled=true;setTeacherStatus('Preparing the published week for all your classes…');
    try {
      const response=await fetch(`/api/teacher/lesson-plans/${encodeURIComponent(state.teacherWeek)}/print-all`,{method:'POST',headers:authHeaders('teacher'),signal:AbortSignal.timeout(60000)});
      if(!response.ok) {const data=await response.json().catch(()=>({}));throw new Error(data.error || 'Could not prepare the PDF.');}
      const blob=await response.blob();if(scope!==teacherScope()) {popup?.close();return;}
      const url=URL.createObjectURL(blob);
      if(popup) popup.location.href=url;
      else {const link=document.createElement('a');link.href=url;link.download=`lesson-plans-${state.teacherWeek}.pdf`;link.click();}
      setTimeout(()=>URL.revokeObjectURL(url),300000);
      setTeacherStatus('Opened the all-class PDF. It includes published plans for the selected week.');
    } catch(error) {popup?.close();if(scope===teacherScope()) setTeacherStatus(error.message,true);}
    finally {button.disabled=false;}
  }

  async function resetSharing() {
    if (!state.teacherClassId || !window.confirm('Reset the public link? Existing public and embed links will stop working.')) return;
    try { await sharing(true); setTeacherStatus('Public and embed links reset. Copy the new links when ready.'); }
    catch (error) { setTeacherStatus(error.message || 'Could not reset link.', true); }
  }

  function openPicker(day) {
    captureEditorDraft();
    state.pickerFocus=document.activeElement;
    state.pickerDay = day;
    $('lessonPlanWikiPickerTitle').textContent = day==='featured' ? 'Feature wiki content for your class' : `Link Wiki Page or Section - ${day.charAt(0).toUpperCase() + day.slice(1)}`;
    $('lessonPlanWikiPickerTree').innerHTML = '<p class="lesson-plan-picker-message">Loading wiki contents…</p>';
    $('lessonPlanWikiPickerModal').style.display = 'flex';
    $('lessonPlanWikiSearch').value=''; $('lessonPlanWikiSearch').focus();
    loadPickerTree();
  }

  function closePicker() {
    $('lessonPlanWikiPickerModal').style.display = 'none';
    if(state.pickerFocus?.isConnected) state.pickerFocus.focus();
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
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'lesson-plan-picker-page';
      button.setAttribute('role', 'treeitem');
      const icon = document.createElement('span');
      icon.className = 'lesson-plan-picker-icon';
      icon.textContent = node.icon || '📄';
      const copy = document.createElement('span');
      const title = document.createElement('strong');
      title.textContent = node.title || 'Wiki page';
      const description = document.createElement('small');
      description.textContent = node.description || 'Published wiki page · choose a section next';
      copy.append(title, description);
      button.append(icon, copy);
      button.addEventListener('click', async () => {
        if(state.pickerDay==='featured') {await changeFeatured(node.id); closePicker(); return;}
        const scope=teacherScope(), day=state.pickerDay;
        button.disabled=true;
        try {
          const data=await fetchJson(`/api/wiki/nodes/${encodeURIComponent(node.id)}`);
          if(scope!==teacherScope() || state.pickerDay!==day) return;
          const dialog=resourceDialog(`Link ${data.node.title}`);
          for(const section of [{anchor:'',heading:'Whole page'},...(data.node.sections || [])]) {
            const choose=document.createElement('button'); choose.type='button'; choose.className='lesson-plan-picker-page'; choose.textContent=section.heading;
            choose.onclick=()=>{dialog.close(); addWikiPage(node.id,section.anchor || '',data.node);}; dialog.list.appendChild(choose);
          }
        } catch(error) {setTeacherStatus(error.message,true);} finally {button.disabled=false;}
      });
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

  async function addWikiPage(nodeId, anchor = '', loadedNode = null) {
    const day = state.pickerDay;
    const item = state.teacherData?.plan?.days?.[day];
    if (!item) return;
    if ((item.wiki_pages || []).some((page) => page.id === nodeId && (page.anchor || '')===anchor)) { closePicker(); return; }
    const scope=teacherScope();
    try {
      const data = loadedNode ? {node:loadedNode} : await fetchJson(`/api/wiki/nodes/${encodeURIComponent(nodeId)}`);
      if(scope!==teacherScope() || day!==state.pickerDay) return;
      const node = data.node;
      if (!node || node.kind !== 'page') throw new Error('That wiki page is unavailable.');
      item.wiki_pages = [...(item.wiki_pages || []), {
        id: node.id, title: node.title, slug: node.slug, url: `/wiki/${node.slug}${anchor ? `#${anchor}` : ''}`,
        anchor, section_title: (node.sections || []).find(section=>section.anchor===anchor)?.heading || '',
        description: node.description || '', standards: node.standards || [],
      }];
      item.wiki_node_ids = item.wiki_pages.map((page) => page.id);
      item.standards = mergedStandards(item.wiki_pages);
      markDirty();
      closePicker(); renderTeacherEditor();
    } catch (error) { $('lessonPlanWikiPickerTree').textContent = error.message || 'Could not add wiki page.'; }
  }

  function openExternalLinkModal(day) {
    captureEditorDraft();
    state.externalFocus=document.activeElement;
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
    if(state.externalFocus?.isConnected) state.externalFocus.focus();
    state.externalLinkDay = '';
  }

  async function addExternalLink() {
    const day = state.externalLinkDay;
    const input = $('lessonPlanExternalLinkUrl');
    const status = $('lessonPlanExternalLinkStatus');
    const submit = $('lessonPlanExternalLinkAdd');
    const url = String(input?.value || '').trim();
    const scope=teacherScope();
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
      if(scope!==teacherScope() || state.externalLinkDay!==day) return;
      if (!item) throw new Error('Reload the lesson plan and try again.');
      item.external_links = item.external_links || [];
      if (!item.external_links.some((entry) => entry.url === data.link.url)) {
        item.external_links.push(data.link);
      }
      closeExternalLinkModal();
      markDirty();
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

  async function attachCurrentFile() {
    const ctx=context(), file=ctx.getCurrentFile?.(), token=ctx.TEACHER_TOKEN;
    const button=$('teacherAttachAgendaBtn'); button.disabled=true;
    try {
      if(!file?.path || file.audit || file.submission || file.notebook) throw new Error('Open a file from your own IDE workspace first.');
      if(!await ctx.saveCurrentFile?.()) throw new Error('Save the file before attaching it.');
      if(context().TEACHER_TOKEN!==token || context().getCurrentFile?.()!==file) return;
      const cls=(ctx.teacherClasses || []).find(item=>item.id===ctx.currentTeacherClassId) || ctx.teacherClasses?.[0];
      if(!cls) throw new Error('Choose a class first.');
      const zone=cls.settings?.assignment_submission_window?.timeZone;
      const parts=new Intl.DateTimeFormat('en-CA',{year:'numeric',month:'2-digit',day:'2-digit',...(zone?{timeZone:zone}:{})}).formatToParts(new Date());
      const part=type=>parts.find(item=>item.type===type)?.value;
      const today=`${part('year')}-${part('month')}-${part('day')}`, index=(new Date(`${today}T12:00:00`).getDay()+6)%7;
      if(index>4) throw new Error('Today is outside the Monday–Friday agenda. Choose a day in Lesson plans to attach this file.');
      if(!retainDraft()) return; state.teacherClassId=cls.id; state.teacherWeek=mondayFor(today); state.activeDay=DAYS[index];
      ctx.openLessonPlanDashboard?.(); await loadTeacherPlan();
      if(token!==context().TEACHER_TOKEN || state.scope!==teacherScope()) return;
      if(await addFile(DAYS[index],file.path)) await saveTeacherPlan();
    } catch(error) {alert(error.message || 'Could not attach the file.');}
    finally {button.disabled=false;}
  }

  async function openAgendaResource(event) {
    const button=event.target.closest?.('.lesson-plan-file,.lesson-plan-assignment');
    if(!button || button.disabled) return;
    const host=button.closest('[data-agenda-class]'), classId=host?.dataset.agendaClass, week=host?.dataset.agendaWeek;
    if(!classId || !week) return;
    event.preventDefault(); const ctx=context(), scope=JSON.stringify(authHeaders('account'));
    const selectedClass=ctx.currentStudentClassId, wikiClass=window.WikiReader?.getState?.().selectedClassId;
    button.disabled=true;
    try {
      if(button.dataset.assignmentId) {await ctx.openAgendaAssignment?.(button.dataset.assignmentId,classId); return;}
      if(!ctx.USER_TOKEN && !ctx.TEACHER_TOKEN && !ctx.ADMIN_TOKEN) throw new Error('Sign in to open this file in the IDE.');
      if(!await ctx.saveCurrentFile?.()) throw new Error('Save your current file before opening an agenda example.');
      const data=await fetchJson(`/api/classes/${encodeURIComponent(classId)}/lesson-plans/${week}/files/${encodeURIComponent(button.dataset.assetId)}/open`,{method:'POST',headers:authHeaders('account')});
      if(scope!==JSON.stringify(authHeaders('account')) || context().currentStudentClassId!==selectedClass || window.WikiReader?.getState?.().selectedClassId!==wikiClass) return;
      if(ctx.USER_TOKEN) ctx.selectAgendaClass?.(classId);
      if(window.WikiReader?.showIDE(true)===false) return;
      await ctx.openWorkspacePath?.(data.path);
    } catch(error) {alert(error.message || 'Could not open the agenda resource.');}
    finally {if(button.isConnected) button.disabled=false;}
  }

  async function loadHomePlan(week = '', classIdHint = '') {
    const ctx = context();
    const section = $('studentLessonPlanSection');
    if (!section) return;
    const isStudent = !!ctx.USER_TOKEN && !ctx.TEACHER_TOKEN && !ctx.ADMIN_TOKEN;
    const isTeacher = !!ctx.TEACHER_TOKEN && !ctx.USER_TOKEN && !ctx.ADMIN_TOKEN;
    section.hidden = !isStudent && !isTeacher;
    if (!isStudent && !isTeacher) {state.homeRequest++; state.homeScope='';state.homeData=null; $('studentLessonPlanHost').textContent='';return;}
    const classId = selectedHomeClass(classIdHint);
    state.homeClassId = classId;
    if (!classId) {state.homeRequest++;state.homeData=null;state.homeScope='';$('studentLessonPlanHost').textContent=''; section.hidden = true; return; }
    const scope=JSON.stringify([ctx.USER_TOKEN || '',ctx.TEACHER_TOKEN || '',classId]);
    if(scope!==state.homeScope) {state.homeScope=scope;state.homeData=null;$('studentLessonPlanHost').textContent='';$('studentLessonPlanWeekLabel').textContent='';}
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
    $('lessonPlanWikiPickerModal').addEventListener('keydown',event=>modalKey(event,$('lessonPlanWikiPickerModal'),closePicker));
    $('lessonPlanExternalLinkModal').addEventListener('keydown',event=>modalKey(event,$('lessonPlanExternalLinkModal'),closeExternalLinkModal));
    $('teacherAttachAgendaBtn')?.addEventListener('click', attachCurrentFile);
    $('lessonPlanWikiSearch')?.addEventListener('input',event=>{
      const query=event.target.value.trim().toLowerCase();
      $('lessonPlanWikiPickerTree').querySelectorAll('.lesson-plan-picker-page').forEach(button=>{button.hidden=!button.textContent.toLowerCase().includes(query);});
      if(query) $('lessonPlanWikiPickerTree').querySelectorAll('details').forEach(folder=>{folder.open=true;});
    });
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
    let authScope=context().TEACHER_TOKEN || '';
    window.addEventListener('eagle-context-updated', () => {
      const next=context().TEACHER_TOKEN || '';
      $('teacherAttachAgendaBtn').hidden=!next;
      if(next!==authScope) {
        authScope=next; state.teacherRequest++; state.homeRequest++; state.teacherData=null; state.scope=''; state.drafts.clear(); state.dirty=false;
        $('lessonPlanEditorGrid').textContent=''; $('lessonPlanDayTabs').textContent=''; $('lessonPlanNotes').value=''; $('lessonPlanFeaturedList').textContent='';
        closePicker(); closeExternalLinkModal(); document.querySelectorAll('.agenda-resource-modal').forEach(modal=>modal.remove());
      }
      syncTeacherClasses(); loadHomePlan();
    });
    $('teacherAttachAgendaBtn').hidden=!authScope;
    document.addEventListener('click',openAgendaResource);
    const openPendingFile=async()=>{
      const ctx=context();if(!ctx.USER_TOKEN && !ctx.TEACHER_TOKEN && !ctx.ADMIN_TOKEN) return;
      let pending;
      try {pending=JSON.parse(sessionStorage.getItem('eagle-agenda-open-file') || 'null');} catch {return;}
      if(!pending) return;
      const email=ctx.currentUser?.email || ctx.currentTeacher?.email || (ctx.ADMIN_TOKEN ? 'admin' : '');
      if(!email) return;
      sessionStorage.removeItem('eagle-agenda-open-file');
      if(pending.email!==email || Date.now()-pending.at>60000 || typeof pending.path!=='string') return;
      if(window.WikiReader?.showIDE(true)===false) return;
      await ctx.openWorkspacePath?.(pending.path);
    };
    window.addEventListener('eagle-context-updated',()=>openPendingFile().catch(()=>{}));
    openPendingFile().catch(()=>{});
    window.addEventListener('beforeunload',event=>{if(context().TEACHER_TOKEN && (state.dirty || state.drafts.size)) {event.preventDefault();event.returnValue='';}});
    window.addEventListener('wiki-home-rendered', (event) => loadHomePlan('', event.detail?.classId));
    loadHomePlan();
  }

  attach();
  window.LessonPlans = { loadHomePlan, loadStudentPlan: loadHomePlan, loadTeacherPlan, hasUnsavedChanges:()=>!!(state.dirty || state.drafts.size) };
})();
