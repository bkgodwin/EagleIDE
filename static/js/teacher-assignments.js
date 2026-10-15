/* Teacher dashboard presentation. Existing assignment handlers own all mutations. */
(function () {
  'use strict';
  let scope = '', classId = null;
  const drafts = new Map(), views = new Map();
  let folderContext = '', folderRequest = 0, folders = [], folderAssignments = {}, canOrganize = false, folderBusy = false, editingFolder = null;
  const collapsedFolders = new Map();
  const DRAG_TYPE = 'application/x-eagle-assignment';
  const byId = id => document.getElementById(id);
  const fingerprint = a => JSON.stringify([a.task, a.maxScore, a.aiGradingMode, a.aiGradingCriteria,
    a.aiGradingRubric, a.aiGradingRubricContext, a.aiGradingInstructions, a.aiGradingRigor, a.shareAiFeedback]);
  const emptyWorkspace = '<div class="assignment-workspace-empty"><span aria-hidden="true">▤</span><h3>Select an assignment</h3><p>Review submissions, plan grading, or update assignment details here.</p></div>';

  function setScope(next) {
    if (scope === next) return;
    scope = next;
    drafts.clear(); views.clear(); classId = null;
    folders = []; folderAssignments = {}; canOrganize = false; folderBusy = false; folderContext = ''; folderRequest++;
    collapsedFolders.clear();
    updateFolderChooser();
    const workspace = byId('assignmentWorkspace');
    if (workspace) workspace.innerHTML = emptyWorkspace;
  }

  function remember() {
    const detail = byId('assignmentDetailPanel');
    if (!detail) return;
    const id = detail.dataset.assignmentId;
    if (detail.dataset.aiSettingsDirty !== 'true') { drafts.delete(id); return; }
    drafts.set(id, {
      base: detail.dataset.settingsBase, context: detail.dataset.rubricContext,
      fields: [...detail.querySelectorAll('.assignment-ai-controls input, .assignment-ai-controls select, .assignment-ai-controls textarea')]
        .map(el => ({ id: el.id, value: el.value, checked: el.checked, criterion: el.classList.contains('assignment-criterion-check') })),
      status: detail.querySelector('#generateAssignmentRubricBtn')?.disabled
        ? 'You left this view during rubric generation. Generate again to load a new draft here.'
        : detail.querySelector('#assignmentRubricStatus')?.textContent,
    });
  }

  function prepare(nextScope, nextClass) {
    if (scope === nextScope) remember();
    setScope(nextScope);
    if (classId !== nextClass) {
      classId = nextClass;
      if (byId('assignmentLibrarySearch')) byId('assignmentLibrarySearch').value = '';
      if (byId('assignmentLibraryFilter')) byId('assignmentLibraryFilter').value = 'all';
      if (byId('assignmentLibrarySort')) byId('assignmentLibrarySort').value = 'newest';
      if (byId('assignmentFolderForm')) byId('assignmentFolderForm').hidden = true;
    }
    const context = `${scope}\n${classId}`;
    if (folderContext !== context) {
      folderContext = context; folders = []; folderAssignments = {}; canOrganize = false; folderBusy = false;
      loadFolders();
    }
  }

  function folderMessage(message) { if (byId('assignmentFolderStatus')) byId('assignmentFolderStatus').textContent = message; }

  async function folderRequestJson(payload) {
    const headers = JSON.parse(scope);
    const response = await fetch(payload ? '/api/assignments/folders' : `/api/assignments/folders?classId=${encodeURIComponent(classId)}`, payload
      ? { method:'POST', headers:{...headers,'Content-Type':'application/json'}, body:JSON.stringify({classId,...payload}) }
      : { headers });
    const result = await response.json().catch(()=>({}));
    if (!response.ok || !result.ok) throw new Error(result.error || `Assignment folders could not be loaded (HTTP ${response.status}).`);
    return result;
  }

  async function loadFolders() {
    if (!classId || typeof fetch !== 'function') return;
    const context = folderContext, ticket = ++folderRequest;
    folderMessage('Loading folders…');
    if (byId('assignmentNewFolderBtn')) byId('assignmentNewFolderBtn').hidden = true;
    try {
      const result = await folderRequestJson();
      if (context !== folderContext || ticket !== folderRequest) return;
      folders = result.folders || []; folderAssignments = result.assignments || {}; canOrganize = !!result.canOrganize;
      folderMessage(canOrganize ? '' : 'Folders are organized by the class owner.');
      filterLibrary(); updateFolderChooser();
    } catch(error) {
      if (context === folderContext && ticket === folderRequest) folderMessage(`${error.message} Reload this page to retry.`);
    }
  }

  async function mutateFolder(payload) {
    if (!canOrganize || folderBusy) return;
    const context = folderContext, ticket = ++folderRequest;
    folderBusy = true; folderMessage('Saving folder organization…'); filterLibrary(); updateFolderChooser();
    try {
      const result = await folderRequestJson(payload);
      if (context !== folderContext || ticket !== folderRequest) return;
      folders = result.folders || []; folderAssignments = result.assignments || {}; canOrganize = !!result.canOrganize;
      if (byId('assignmentFolderForm')) byId('assignmentFolderForm').hidden = true;
      folderMessage(payload.action === 'move' ? 'Assignment moved.' : 'Folder organization saved.');
    } catch(error) {
      if (context === folderContext && ticket === folderRequest) folderMessage(error.message);
    } finally {
      if (context === folderContext && ticket === folderRequest) { folderBusy = false; filterLibrary(); updateFolderChooser(); }
    }
  }

  function editFolder(folder = null) {
    if (!canOrganize || folderBusy) return;
    editingFolder = folder?.id || null;
    byId('assignmentFolderNameLabel').textContent = folder ? 'Rename folder' : 'New folder';
    byId('assignmentFolderName').value = folder?.name || '';
    byId('assignmentFolderForm').hidden = false;
    byId('assignmentFolderName').focus();
  }

  function updateFolderChooser() {
    const create = byId('assignmentNewFolderBtn');
    if (create) { create.hidden = !canOrganize; create.disabled = folderBusy; }
    if (byId('assignmentFolderHelp')) byId('assignmentFolderHelp').textContent = canOrganize ? 'Drag assignments into folders to organize them.' : 'Assignment folders';
    const select = byId('assignmentMoveFolderSelect'), detail = byId('assignmentDetailPanel');
    if (!select || !detail) return;
    select.replaceChildren();
    [{id:'',name:'Unfiled'},...folders].forEach(folder=>{
      const option = document.createElement('option'); option.value = folder.id; option.textContent = folder.name; select.append(option);
    });
    select.value = folderAssignments[detail.dataset.assignmentId] || '';
    select.disabled = !canOrganize || folderBusy;
    select.onchange = ()=>mutateFolder({action:'move',assignmentId:detail.dataset.assignmentId,folderId:select.value});
  }

  function groupLibrary(list, cards, filtering) {
    let collapsed = collapsedFolders.get(classId);
    if (!collapsed) { collapsed = new Set(); collapsedFolders.set(classId,collapsed); }
    const groups = [...folders].sort((a,b)=>a.name.localeCompare(b.name)).concat([{id:'',name:'Unfiled'}]);
    list.replaceChildren();
    groups.forEach(folder=>{
      const children = cards.filter(card=>(folderAssignments[card.querySelector('.assignment-title-row').dataset.id] || '') === folder.id);
      const visible = children.filter(card=>!card.hidden).length;
      const section = document.createElement('section'); section.className = 'assignment-folder'; section.dataset.folderId = folder.id;
      section.hidden = filtering && !visible;
      const header = document.createElement('div'); header.className = 'assignment-folder-header';
      const toggle = document.createElement('button'); toggle.className = 'assignment-folder-toggle'; toggle.type = 'button';
      const expanded = filtering || !collapsed.has(folder.id);
      toggle.setAttribute('aria-expanded',String(expanded));
      const label = document.createElement('span'); label.textContent = `${expanded ? '▾' : '▸'} ${folder.id ? '📁' : '▤'} ${folder.name}`;
      const count = document.createElement('small'); count.textContent = String(visible); toggle.append(label,count); header.append(toggle);
      const body = document.createElement('div'); body.className = 'assignment-folder-cards'; body.hidden = !expanded;
      toggle.onclick = ()=>{ if (collapsed.has(folder.id)) collapsed.delete(folder.id); else collapsed.add(folder.id); filterLibrary(); list.querySelector(`[data-folder-id="${folder.id}"] .assignment-folder-toggle`)?.focus(); };
      if (folder.id && canOrganize) {
        const rename = document.createElement('button'); rename.className = 'assignment-folder-tool'; rename.type = 'button'; rename.textContent = 'Rename'; rename.disabled = folderBusy;
        rename.setAttribute('aria-label',`Rename ${folder.name}`); rename.onclick = ()=>editFolder(folder);
        const remove = document.createElement('button'); remove.className = 'assignment-folder-tool'; remove.type = 'button'; remove.textContent = '×'; remove.disabled = folderBusy;
        remove.setAttribute('aria-label',`Delete folder ${folder.name}`);
        remove.onclick = ()=>{ if (confirm(`Delete folder "${folder.name}"? Its assignments will move to Unfiled. No assignments or submission files will be deleted.`)) mutateFolder({action:'delete',folderId:folder.id}); };
        header.append(rename,remove);
      }
      children.forEach(card=>{
        card.draggable = canOrganize && !folderBusy;
        card.ondragstart = event=>{
          if (!canOrganize || folderBusy) { event.preventDefault(); return; }
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData(DRAG_TYPE,JSON.stringify({classId,assignmentId:card.querySelector('.assignment-title-row').dataset.id}));
        };
        card.ondragend = ()=>list.querySelectorAll('.is-drop-target').forEach(el=>el.classList.remove('is-drop-target'));
        body.append(card);
      });
      if (!children.length) { const empty = document.createElement('p'); empty.className = 'assignment-folder-empty'; empty.textContent = canOrganize ? 'Drop assignments here' : 'No assignments'; body.append(empty); }
      section.ondragover = event=>{ if (canOrganize && !folderBusy && [...event.dataTransfer.types].includes(DRAG_TYPE)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; section.classList.add('is-drop-target'); } };
      section.ondragleave = event=>{ if (!section.contains(event.relatedTarget)) section.classList.remove('is-drop-target'); };
      section.ondrop = event=>{
        event.preventDefault(); section.classList.remove('is-drop-target');
        try {
          const item = JSON.parse(event.dataTransfer.getData(DRAG_TYPE));
          if (item.classId === classId && cards.some(card=>card.querySelector('.assignment-title-row').dataset.id === item.assignmentId)) mutateFolder({action:'move',assignmentId:item.assignmentId,folderId:folder.id});
        } catch(_) { /* Ignore unrelated drags. Server authorization still applies. */ }
      };
      section.append(header,body); list.append(section);
    });
  }

  function filterLibrary() {
    const list = byId('assignmentList');
    if (!list) return;
    const query = (byId('assignmentLibrarySearch')?.value || '').trim().toLocaleLowerCase();
    const status = byId('assignmentLibraryFilter')?.value || 'all';
    const sort = byId('assignmentLibrarySort')?.value || 'newest';
    const cards = [...list.querySelectorAll('.assignment-list-item')];
    cards.forEach((card, index) => { if (!card.dataset.order) card.dataset.order = String(index + 1); });
    cards.sort((a, b) => sort === 'name' ? a.dataset.name.localeCompare(b.dataset.name) :
      (Number(a.dataset.order) - Number(b.dataset.order)) * (sort === 'newest' ? -1 : 1));
    let visible = 0;
    cards.forEach(card => {
      card.hidden = !card.dataset.name.toLocaleLowerCase().includes(query) || (status !== 'all' && card.dataset.status !== status);
      if (!card.hidden) visible++;
    });
    const scrollRegion = byId('assignmentLibraryItems');
    if (scrollRegion) {
      const scrollTop = scrollRegion.scrollTop, parentTop = scrollRegion.parentElement.scrollTop;
      groupLibrary(list,cards,!!query || status !== 'all');
      scrollRegion.scrollTop = scrollTop; scrollRegion.parentElement.scrollTop = parentTop;
    }
    else cards.forEach(card=>list.append(card));
    updateFolderChooser();
    if (byId('assignmentLibraryCount')) byId('assignmentLibraryCount').textContent = `${visible} / ${cards.length}`;
    if (byId('assignmentLibraryEmpty')) byId('assignmentLibraryEmpty').hidden = visible > 0 || cards.length === 0;
  }

  function clear() {
    if (byId('assignmentWorkspace')) byId('assignmentWorkspace').innerHTML = emptyWorkspace;
    filterLibrary();
  }

  function bindTabs(root, selector, panelSelector, initial, changed) {
    const buttons = [...root.querySelectorAll(selector)];
    const panels = [...root.querySelectorAll(panelSelector)];
    const activate = value => {
      buttons.forEach(button => {
        const selected = button.dataset.section === value;
        button.setAttribute('aria-selected', String(selected));
        button.tabIndex = selected ? 0 : -1;
      });
      panels.forEach(panel => { panel.hidden = panel.dataset.section !== value; });
      changed?.(value);
    };
    buttons.forEach((button, index) => {
      button.onclick = () => activate(button.dataset.section);
      button.onkeydown = event => {
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
          event.key === 'ArrowRight' ? (index + 1) % buttons.length : event.key === 'ArrowLeft' ? (index + buttons.length - 1) % buttons.length : -1;
        if (next < 0) return;
        event.preventDefault();
        activate(buttons[next].dataset.section); buttons[next].focus();
      };
    });
    activate(buttons.some(b => b.dataset.section === initial) ? initial : buttons[0].dataset.section);
  }

  function restoreDraft(detail, assignment) {
    const draft = drafts.get(assignment.id || assignment.name);
    if (!draft) return;
    if (draft.base !== fingerprint(assignment)) {
      drafts.delete(assignment.id || assignment.name);
      const notice = document.createElement('p'); notice.className = 'assignment-draft-notice';
      notice.textContent = 'Saved assignment settings changed. The grading form now shows the current saved settings; review them before grading.';
      detail.querySelector('[data-assignment-panel="grading"]').prepend(notice);
      return;
    }
    const controls = [...detail.querySelectorAll('.assignment-ai-controls input, .assignment-ai-controls select, .assignment-ai-controls textarea')];
    draft.fields.forEach(field => {
      const el = controls.find(el => field.criterion ? el.classList.contains('assignment-criterion-check') && el.value === field.value : el.id === field.id);
      if (el) { el.value = field.value; if (el.type === 'checkbox') el.checked = field.checked; }
    });
    detail.querySelector('#assignmentAiGradingMode')?.dispatchEvent(new Event('change'));
    detail.dataset.rubricContext = draft.context || '';
    detail.dataset.aiSettingsDirty = 'true';
    const status = detail.querySelector('#assignmentRubricStatus');
    if (status && draft.status) status.textContent = draft.status;
    detail.querySelectorAll('#gradeAllSubmissionsBtn, #downloadExternalGradingBtn, #uploadExternalGradesBtn, .ai-grade-submission-btn').forEach(button => { button.disabled = true; });
  }

  function decorate({ list, detail, assignment, roster, owner, scoreOf }) {
    const workspace = byId('assignmentWorkspace');
    if (!workspace) return;
    const id = assignment.id || assignment.name;
    const changedAssignment = workspace.querySelector('#assignmentDetailPanel')?.dataset.assignmentId !== id;
    const state = views.get(id) || { section: 'submissions', query: '', status: 'all' };
    views.set(id, state);
    detail.dataset.settingsBase = fingerprint(assignment);
    const original = [...detail.children];
    const title = detail.querySelector('h4');
    const tools = detail.querySelector('.assignment-review-tools');
    const manage = detail.querySelector('.assignment-manage-actions');
    const development = detail.querySelector('.assignment-development-actions');
    const ai = detail.querySelector('.assignment-ai-controls');
    const table = detail.querySelector('.scores-table');
    const exportBar = table.previousElementSibling;
    detail.replaceChildren();
    detail.innerHTML = `<header class="assignment-workspace-header"><div class="assignment-workspace-heading"><span class="assignment-eyebrow">Assignment workspace</span></div><div class="assignment-header-actions"></div></header>
      <div class="assignment-summary-strip"></div>
      <div class="assignment-section-tabs" role="tablist" aria-label="Assignment sections">${[['submissions','Submissions'],['overview','Overview'],['grading','Grading setup'],['manage','Manage']].map(([key,label]) => `<button type="button" role="tab" id="assignment-tab-${key}" aria-controls="assignment-pane-${key}" data-section="${key}">${label}${key === 'grading' ? '<span class="assignment-unsaved-dot" title="Unsaved grading settings" hidden>Unsaved</span>' : ''}</button>`).join('')}</div>
      <div class="assignment-section-body">${['submissions','overview','grading','manage'].map(key => `<section id="assignment-pane-${key}" class="assignment-section-panel" role="tabpanel" tabindex="0" aria-labelledby="assignment-tab-${key}" data-section="${key}" data-assignment-panel="${key}" hidden></section>`).join('')}</div>`;
    const panel = key => detail.querySelector(`[data-assignment-panel="${key}"]`);
    detail.querySelector('.assignment-workspace-heading').append(title);
    const edit = manage.querySelector('.edit-assignment-btn'), lock = manage.querySelector('.lock-assignment-btn');
    edit.textContent = 'Edit assignment'; lock.textContent = assignment.gradingCompletedAt ? 'Grading complete' : assignment.active ? 'Lock submissions' : 'Unlock submissions';
    edit.hidden = lock.hidden = !owner;
    detail.querySelector('.assignment-header-actions').append(edit, lock);
    const subs = assignment.submissions || [];
    const submitted = roster.filter(student => subs.some(sub => !sub.withdrawn && String(sub.email).toLowerCase() === String(student.email).toLowerCase())).length;
    const graded = roster.filter(student => subs.some(sub => !sub.withdrawn && String(sub.email).toLowerCase() === String(student.email).toLowerCase() && scoreOf(sub) != null)).length;
    const summary = detail.querySelector('.assignment-summary-strip');
    [['Turned in',submitted],['Needs grading',submitted - graded],['Missing',roster.length - submitted]].forEach(([label,value]) => {
      const metric = document.createElement('div'); const number = document.createElement('strong'); number.textContent = value;
      const text = document.createElement('span'); text.textContent = label; metric.append(number,text); summary.append(metric);
    });
    const overviewHeading = document.createElement('h3'); overviewHeading.textContent = 'Assignment brief'; panel('overview').append(overviewHeading);
    original.filter(el => ![title,tools,manage,development,ai,exportBar,table].includes(el)).forEach(el => panel('overview').append(el));
    if (ai) panel('grading').append(ai);
    else panel('grading').innerHTML = '<h3>Quiz grading</h3><p>This assignment uses quiz questions only. Review and score responses from the Submissions section.</p>';
    const manageIntro = document.createElement('div'); manageIntro.innerHTML = '<h3>Manage assignment</h3><p>Copy this assignment to another class or manage its lifecycle.</p>';
    panel('manage').append(manageIntro,manage);
    if (owner) {
      const placement = document.createElement('div'); placement.className = 'assignment-folder-placement';
      placement.innerHTML = '<label for="assignmentMoveFolderSelect">Move to folder</label><select id="assignmentMoveFolderSelect" disabled><option>Loading folders…</option></select>';
      panel('manage').insertBefore(placement,manage);
    }
    if (!owner) { const note = document.createElement('p'); note.textContent = 'Assignment management is available to the class owner.'; panel('manage').append(note); }
    if (development) panel('manage').append(development);
    const submissionsPanel = panel('submissions');
    submissionsPanel.innerHTML = `<div class="assignment-section-heading"><div><h3>Student submissions</h3><p>Review work, enter scores, and share feedback.</p></div></div><div class="assignment-submission-actions"></div>
      <div class="assignment-roster-filters"><label><span class="sr-only">Search students</span><input type="search" class="assignment-student-search" placeholder="Search students…" autocomplete="off"></label><label><span class="sr-only">Submission status</span><select class="assignment-submission-filter"><option value="all">All students</option><option value="submitted">Turned in</option><option value="ungraded">Needs grading</option><option value="graded">Graded</option><option value="missing">Missing / un-submitted</option></select></label><span class="assignment-roster-count" role="status"></span></div>`;
    const commonActions = submissionsPanel.querySelector('.assignment-submission-actions');
    if (ai) {
      commonActions.append(ai.querySelector('#assignmentInternalAiActions'),ai.querySelector('#assignmentInternalAiNote'));
      const shortcut = document.createElement('button'); shortcut.className = 'btn secondary'; shortcut.type = 'button'; shortcut.textContent = 'Grading setup';
      shortcut.onclick = () => { detail.querySelector('#assignment-tab-grading').click(); detail.querySelector('#assignment-tab-grading').focus(); };
      commonActions.prepend(shortcut);
    }
    if (tools) submissionsPanel.append(tools);
    if (development) { const watch = development.querySelector('.assignment-development-open'); if (watch) commonActions.append(watch); }
    exportBar.classList.add('assignment-export-tools');
    submissionsPanel.querySelector('.assignment-section-heading').append(exportBar);
    const tableWrap = document.createElement('div'); tableWrap.className = 'assignment-table-scroll'; tableWrap.tabIndex = 0;
    tableWrap.setAttribute('role','region'); tableWrap.setAttribute('aria-label','Student submissions and grades'); tableWrap.append(table); submissionsPanel.append(tableWrap);
    const rows = [...table.tBodies[0].children].filter(row => !row.classList.contains('assignment-feedback-row'));
    const noResults = document.createElement('p'); noResults.className = 'assignment-roster-empty'; noResults.textContent = 'No students match these filters.'; noResults.hidden = true; submissionsPanel.append(noResults);
    rows.forEach((row,index) => {
      if (!roster[index]) return;
      const student = roster[index], sub = subs.find(s => String(s.email).toLowerCase() === String(student.email).toLowerCase());
      row.dataset.search = `${student.name || ''} ${student.first_name || ''} ${student.last_name || ''} ${student.email || ''}`.toLocaleLowerCase();
      row.dataset.state = !sub || sub.withdrawn ? 'missing' : scoreOf(sub) != null ? 'graded' : 'ungraded';
      const actions = row.lastElementChild?.querySelector('div');
      if (!actions) return;
      const buttons = [...actions.querySelectorAll('button')];
      const primary = actions.querySelector('.open-submission-btn') || actions.querySelector('.grade-quiz-btn');
      const secondary = buttons.filter(b => b !== primary);
      actions.classList.add('assignment-row-actions');
      if (secondary.length) {
        const more = document.createElement('details'); more.className = 'assignment-row-more';
        const toggle = document.createElement('summary'); toggle.textContent = 'More'; toggle.setAttribute('aria-label',`More actions for ${student.name || student.email}`);
        const content = document.createElement('div'); content.append(...secondary); more.append(toggle,content); actions.append(more);
      }
    });
    const search = submissionsPanel.querySelector('.assignment-student-search'), status = submissionsPanel.querySelector('.assignment-submission-filter');
    search.value = state.query; status.value = state.status;
    const filterRows = () => {
      state.query = search.value; state.status = status.value;
      let visible = 0;
      rows.forEach(row => {
        if (!row.dataset.state) return;
        const matchesStatus = state.status === 'all' || row.dataset.state === state.status || (state.status === 'submitted' && row.dataset.state !== 'missing');
        row.hidden = !matchesStatus || !row.dataset.search.includes(state.query.trim().toLocaleLowerCase());
        if (!row.hidden) visible++;
        if (row.nextElementSibling?.classList.contains('assignment-feedback-row')) row.nextElementSibling.hidden = row.hidden;
      });
      submissionsPanel.querySelector('.assignment-roster-count').textContent = `${visible} of ${roster.length} students`;
      noResults.hidden = visible > 0 || roster.length === 0;
    };
    search.oninput = filterRows; status.onchange = filterRows; filterRows();
    workspace.replaceChildren(detail);
    if (changedAssignment) workspace.scrollTop = 0;
    bindTabs(detail,'.assignment-section-tabs [role="tab"]','.assignment-section-panel',state.section,value => { state.section = value; });
    restoreDraft(detail,assignment);
    const showDirty = () => { detail.querySelector('.assignment-unsaved-dot').hidden = detail.dataset.aiSettingsDirty !== 'true'; };
    detail.addEventListener('input',showDirty); detail.addEventListener('change',showDirty); showDirty();
    // Generating a rubric marks the form dirty without an input event.
    detail.querySelector('#generateAssignmentRubricBtn')?.addEventListener('click',showDirty);
    filterLibrary();
  }

  function enhanceComposer(modal) {
    const body = modal.querySelector('.workspace-modal-body');
    const children = [...body.children];
    const due = children.findIndex(el => el.getAttribute('for') === 'modalAssignmentDueAt');
    const skills = children.findIndex(el => el.id === 'modalAssignmentSkillTags') - 1;
    const classSelect = modal.querySelector('#modalAssignmentClassId');
    const classLabel = classSelect?.previousElementSibling;
    const footer = body.querySelector('.modal-actions');
    const groups = [children.slice(0,due),children.slice(due,skills),children.slice(skills).filter(el=>el!==footer)];
    if (classSelect) {
      groups[1] = groups[1].filter(el=>el!==classSelect && el!==classLabel);
      groups[0].unshift(classLabel,classSelect);
    }
    body.replaceChildren();
    body.innerHTML = `<div class="assignment-composer-tabs" role="tablist" aria-label="Assignment editor sections">${[['details','1','Details'],['rules','2','Submission rules'],['questions','3','Skills & questions']].map(([key,num,label])=>`<button type="button" role="tab" id="composer-tab-${key}" aria-controls="composer-pane-${key}" data-section="${key}"><span>${num}</span>${label}</button>`).join('')}</div><div class="assignment-composer-sections"></div>`;
    [['details','Give students a clear starting point'],['rules','Choose how and when students submit'],['questions','Connect skills and add a quiz']].forEach(([key,title],index)=>{
      const section=document.createElement('section'); section.className='assignment-composer-section'; section.dataset.section=key;
      section.id=`composer-pane-${key}`; section.setAttribute('role','tabpanel'); section.setAttribute('aria-labelledby',`composer-tab-${key}`);
      const heading=document.createElement('h4'); heading.textContent=title; section.append(heading,...groups[index]);
      body.querySelector('.assignment-composer-sections').append(section);
    });
    modal.querySelector('.modal-content').append(footer);
    footer.classList.add('assignment-composer-footer');
    const hint=document.createElement('span'); hint.textContent='Details, submission rules, and questions save together.'; footer.prepend(hint);
    body.querySelectorAll('label').forEach(label=>{
      if (!label.htmlFor && !label.querySelector('input,select,textarea')) {
        const input=label.nextElementSibling;
        if (input?.matches('input[id],select[id],textarea[id]')) label.htmlFor=input.id;
      }
    });
    bindTabs(body,'.assignment-composer-tabs [role="tab"]','.assignment-composer-section','details');
    modal.querySelector('.modal-exit-btn').textContent='Cancel';
    modal.querySelector('.modal-content').setAttribute('role','dialog');
    modal.querySelector('.modal-content').setAttribute('aria-modal','true');
    modal.querySelector('.modal-content').setAttribute('aria-label',modal.querySelector('h3').textContent);
    const previous=document.activeElement;
    modal.addEventListener('keydown',event=>{
      if(event.key==='Escape' && event.target===document.activeElement) {event.preventDefault(); modal.remove(); previous?.focus();}
      if(event.key!=='Tab') return;
      const controls=[...modal.querySelectorAll('button,input,select,textarea,summary')].filter(el=>!el.disabled && el.getClientRects().length);
      if(event.shiftKey && document.activeElement===controls[0]) {event.preventDefault(); controls.at(-1)?.focus();}
      else if(!event.shiftKey && document.activeElement===controls.at(-1)) {event.preventDefault(); controls[0]?.focus();}
    });
    modal.querySelector('#modalAssignmentName')?.focus();
  }

  document.addEventListener('DOMContentLoaded',()=>{
    byId('assignmentLibrarySearch')?.addEventListener('input',filterLibrary);
    byId('assignmentLibraryFilter')?.addEventListener('change',filterLibrary);
    byId('assignmentLibrarySort')?.addEventListener('change',()=>{
      const region = byId('assignmentLibraryItems');
      if (region) { region.scrollTop = 0; region.parentElement.scrollTop = 0; }
      filterLibrary();
    });
    byId('assignmentNewFolderBtn')?.addEventListener('click',()=>editFolder());
    byId('assignmentFolderCancelBtn')?.addEventListener('click',()=>{ byId('assignmentFolderForm').hidden = true; });
    byId('assignmentFolderForm')?.addEventListener('submit',event=>{
      event.preventDefault();
      mutateFolder({action:editingFolder ? 'rename' : 'create',folderId:editingFolder || '',name:byId('assignmentFolderName').value});
    });
  });
  window.TeacherAssignments = { prepare, setScope, clear, decorate, enhanceComposer };
})();
