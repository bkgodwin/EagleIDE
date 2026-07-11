/**
 * Student notebook drawer, teacher prompts, search, PDF export, and inline code runs.
 */
(function () {
  'use strict';

  const INPUT_TOKEN = '[[_IDE_INPUT_]]';
  const ASSIGNMENTS_TAB_ID = 'assignments';
  const DEFAULT_RESPONSE_HTML = '<ul><li><br></li></ul>';
  const DEFAULT_CODE_RESPONSE_HTML = '<div class="student-notebook-code-placeholder"></div>';
  const SAVE_DELAY_MS = 900;
  const MAX_TABS = 80;
  const MAX_TAB_LABEL_LENGTH = 20;
  const MAX_INLINE_OUTPUT_CHARS = 120000;
  const DEFAULT_TAB_COLORS = ['#fff2a8', '#b9e4ff', '#ffc4d6', '#c9f2c7', '#dcc8ff', '#ffd5a6', '#c5f3e8', '#f5c9ff'];
  const DEFAULT_ASSIGNMENTS_COLOR = '#f3c74d';
  let notebook = null;
  let activeClassId = null;
  let loadedClassId = null;
  let drawerOpen = false;
  let saveTimer = null;
  let dirty = false;
  let activeEditorEl = null;
  let runningCodeId = null;
  let waitingForNotebookInput = false;
  let selectedTeacherPromptId = null;
  const collapsedAssignmentIds = new Set();
  const boundCodeBlocks = new WeakSet();
  let colorPaletteOpen = false;
  let teacherNotebookSkills = [];

  function ctx() {
    return window.EagleIDE?.getContext?.() || {};
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function sanitizeHtml(html) {
    if (window.DOMPurify) {
      return DOMPurify.sanitize(String(html || ''), {
        ADD_ATTR: ['contenteditable', 'data-language', 'data-file-name', 'data-code-id', 'hidden'],
      });
    }
    return String(html || '').replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '');
  }

  function stripHtml(html) {
    const div = document.createElement('div');
    div.innerHTML = sanitizeHtml(html);
    return div.textContent.replace(/\s+/g, ' ').trim();
  }

  function formatLocalDateTime(value) {
    if (!value) return '';
    const text = String(value).trim();
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text) ? text.replace(' ', 'T') : text;
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) return text;
    return date.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  function currentClassId() {
    const c = ctx();
    return c.getCurrentClassContext?.()?.id || c.currentStudentClassId || null;
  }

  function isStudentInClass() {
    const c = ctx();
    return !!(c.USER_TOKEN && !c.TEACHER_TOKEN && !c.ADMIN_TOKEN && currentClassId());
  }

  function isTeacher() {
    const c = ctx();
    return !!(c.TEACHER_TOKEN && !c.ADMIN_TOKEN);
  }

  function userHeaders() {
    return { 'X-User-Token': ctx().USER_TOKEN || '' };
  }

  function userJsonHeaders() {
    return { 'Content-Type': 'application/json', ...userHeaders() };
  }

  function teacherJsonHeaders() {
    return { 'Content-Type': 'application/json', 'X-Teacher-Token': ctx().TEACHER_TOKEN || '' };
  }

  function teacherHeaders() {
    return { 'X-Teacher-Token': ctx().TEACHER_TOKEN || '' };
  }

  function setStatus(text, tone = '') {
    const el = document.getElementById('studentNotebookSaveStatus');
    if (!el) return;
    el.textContent = text;
    el.dataset.tone = tone;
  }

  function tabById(tabId) {
    return (notebook?.tabs || []).find(tab => tab.id === tabId) || null;
  }

  function activeTab() {
    return tabById(notebook?.activeTabId) || notebook?.tabs?.[0] || null;
  }

  function assignmentsTab() {
    return tabById(ASSIGNMENTS_TAB_ID);
  }

  function defaultTabColor(index = 0) {
    return DEFAULT_TAB_COLORS[Math.abs(index) % DEFAULT_TAB_COLORS.length];
  }

  function normalizeTabColor(color, index = 0) {
    const value = String(color || '').trim();
    return /^#[0-9a-f]{6}$/i.test(value) ? value : defaultTabColor(index);
  }

  function tabColorPaletteHtml(activeColor) {
    const active = normalizeTabColor(activeColor).toLowerCase();
    return `
      <div class="student-notebook-color-palette" role="group" aria-label="Choose tab color">
        ${DEFAULT_TAB_COLORS.map(color => `
          <button type="button" class="student-notebook-color-swatch${color.toLowerCase() === active ? ' active' : ''}" data-tab-color="${escapeHtml(color)}" style="--swatch-color:${escapeHtml(color)}" title="${escapeHtml(color)}" aria-label="Set tab color ${escapeHtml(color)}"></button>
        `).join('')}
      </div>
    `;
  }

  function skillTagsHtml(tags) {
    const rows = Array.isArray(tags) ? tags.filter(Boolean) : [];
    if (!rows.length) return '';
    return `<span class="student-notebook-skill-chips">${rows.map(tag => `<span class="student-notebook-skill-chip">#${escapeHtml(tag)}</span>`).join('')}</span>`;
  }

  function trimTabLabel(label) {
    return String(label || '').trim().slice(0, MAX_TAB_LABEL_LENGTH);
  }

  function assignmentDefaultHtml(block) {
    return block?.responseType === 'code' ? DEFAULT_CODE_RESPONSE_HTML : DEFAULT_RESPONSE_HTML;
  }

  function assignmentResponseHtml(block) {
    const html = sanitizeHtml(block?.responseHtml || assignmentDefaultHtml(block));
    if (block?.responseType !== 'code') return html;
    const holder = document.createElement('div');
    holder.innerHTML = html;
    holder.querySelectorAll('ul, ol, p').forEach(el => {
      if (!el.textContent.trim() && !el.querySelector('.student-notebook-code-block')) el.remove();
    });
    return holder.innerHTML || DEFAULT_CODE_RESPONSE_HTML;
  }

  function isAssignmentResponseLocked(block) {
    return !!(block?.locked || String(block?.score || '').trim());
  }

  function ensureNotebookShape(raw) {
    const shaped = raw && typeof raw === 'object' ? raw : {};
    const tabs = Array.isArray(shaped.tabs) ? shaped.tabs : [];
    if (!tabs.some(tab => tab.id === ASSIGNMENTS_TAB_ID)) {
      tabs.push({ id: ASSIGNMENTS_TAB_ID, label: 'Assignments', locked: true, blocks: [], color: DEFAULT_ASSIGNMENTS_COLOR, bookmarked: false });
    }
    tabs.forEach((tab, index) => {
      if (!tab || typeof tab !== 'object') return;
      if (tab.id === ASSIGNMENTS_TAB_ID) {
        tab.locked = true;
        tab.label = 'Assignments';
        tab.color = DEFAULT_ASSIGNMENTS_COLOR;
        tab.bookmarked = false;
      } else {
        tab.locked = false;
        tab.color = normalizeTabColor(tab.color, index);
        tab.bookmarked = !!tab.bookmarked;
      }
    });
    shaped.tabs = tabs;
    shaped.activeTabId = shaped.activeTabId || tabs[0]?.id || ASSIGNMENTS_TAB_ID;
    return shaped;
  }

  function persistActivePageFromDom() {
    if (!notebook) return;
    const tab = activeTab();
    if (!tab) return;
    if (tab.id === ASSIGNMENTS_TAB_ID) {
      document.querySelectorAll('.student-notebook-prompt-response[data-prompt-id]').forEach(el => {
        const promptId = el.dataset.promptId;
        const block = (tab.blocks || []).find(b => b.promptId === promptId);
        if (block && !isAssignmentResponseLocked(block)) {
          const cleanCopy = el.cloneNode(true);
          cleanCopy.querySelectorAll('.student-notebook-code-block').forEach(cleanCodeBlockForSave);
          block.responseHtml = sanitizeHtml(cleanCopy.innerHTML || assignmentDefaultHtml(block));
          block.updatedAt = new Date().toISOString();
        }
      });
      return;
    }
    const editor = document.getElementById('studentNotebookEditor');
    if (editor) {
      const cleanCopy = editor.cloneNode(true);
      cleanCopy.querySelectorAll('.student-notebook-code-block').forEach(cleanCodeBlockForSave);
      tab.html = sanitizeHtml(cleanCopy.innerHTML || '');
    }
  }

  async function loadNotebook(force = false) {
    if (!isStudentInClass()) return null;
    activeClassId = currentClassId();
    if (!force && notebook && loadedClassId === activeClassId) return notebook;
    setStatus('Loading...');
    const res = await fetch(`/api/notebook?classId=${encodeURIComponent(activeClassId)}`, {
      headers: userHeaders(),
    });
    const data = await res.json().catch(() => ({}));
    if (!data?.ok) {
      setStatus(data?.error || 'Load failed', 'error');
      throw new Error(data?.error || 'Notebook load failed');
    }
    notebook = ensureNotebookShape(data.notebook);
    loadedClassId = activeClassId;
    dirty = false;
    setStatus('Saved');
    renderNotebook();
    return notebook;
  }

  async function saveNotebook({ immediate = false } = {}) {
    if (!notebook || !isStudentInClass()) return;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    persistActivePageFromDom();
    dirty = true;
    const doSave = async () => {
      setStatus('Saving...');
      try {
        const res = await fetch('/api/notebook/save', {
          method: 'POST',
          headers: userJsonHeaders(),
          body: JSON.stringify({ classId: activeClassId || currentClassId(), notebook }),
        });
        const data = await res.json().catch(() => ({}));
        if (!data?.ok) throw new Error(data?.error || 'Save failed');
        notebook = ensureNotebookShape(data.notebook);
        dirty = false;
        setStatus('Saved');
      } catch (err) {
        setStatus('Save failed', 'error');
        console.warn('Notebook save failed:', err);
      }
    };
    if (immediate) {
      await doSave();
    } else {
      saveTimer = setTimeout(doSave, SAVE_DELAY_MS);
    }
  }

  function scheduleSave({ persist = true } = {}) {
    if (!notebook) return;
    if (persist) persistActivePageFromDom();
    dirty = true;
    setStatus('Unsaved');
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveNotebook({ immediate: true }), SAVE_DELAY_MS);
  }

  function switchTab(tabId) {
    if (!notebook || notebook.activeTabId === tabId) return;
    hideAllCodeBlockShells({ stop: true });
    persistActivePageFromDom();
    notebook.activeTabId = tabId;
    colorPaletteOpen = false;
    renderNotebook(true);
    scheduleSave({ persist: false });
  }

  function addTab() {
    if (!notebook) return;
    if ((notebook.tabs || []).length >= MAX_TABS) {
      alert(`Notebook limit reached (${MAX_TABS} tabs).`);
      return;
    }
    const label = prompt('Tab label:', 'New Tab');
    if (!label || !label.trim()) return;
    hideAllCodeBlockShells({ stop: true });
    persistActivePageFromDom();
    const id = `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const assignmentsIndex = notebook.tabs.findIndex(tab => tab.id === ASSIGNMENTS_TAB_ID);
    const insertAt = assignmentsIndex >= 0 ? assignmentsIndex : notebook.tabs.length;
    notebook.tabs.splice(insertAt, 0, {
      id,
      label: trimTabLabel(label),
      locked: false,
      color: defaultTabColor(insertAt),
      bookmarked: false,
      html: '<h2>New Notes</h2><p><br></p>',
    });
    notebook.activeTabId = id;
    renderNotebook(true);
    scheduleSave({ persist: false });
  }

  function renameActiveTab() {
    const tab = activeTab();
    if (!tab || tab.locked) return;
    const label = prompt('Rename tab:', tab.label || 'Notes');
    if (!label || !label.trim()) return;
    tab.label = trimTabLabel(label);
    renderNotebook();
    scheduleSave({ persist: false });
  }

  function deleteActiveTab() {
    const tab = activeTab();
    if (!tab || tab.locked) return;
    if (!confirm(`Delete the "${tab.label}" tab?`)) return;
    hideAllCodeBlockShells({ stop: true });
    persistActivePageFromDom();
    notebook.tabs = notebook.tabs.filter(t => t.id !== tab.id);
    notebook.activeTabId = notebook.tabs[0]?.id || ASSIGNMENTS_TAB_ID;
    renderNotebook(true);
    scheduleSave({ persist: false });
  }

  function toggleActiveTabBookmark() {
    const tab = activeTab();
    if (!tab || tab.locked) return;
    persistActivePageFromDom();
    tab.bookmarked = !tab.bookmarked;
    renderNotebook();
    scheduleSave({ persist: false });
  }

  function toggleTabColorPalette() {
    colorPaletteOpen = !colorPaletteOpen;
    renderNotebook();
  }

  function updateActiveTabColor(color) {
    const tab = activeTab();
    if (!tab || tab.locked) return;
    persistActivePageFromDom();
    tab.color = normalizeTabColor(color);
    colorPaletteOpen = false;
    renderNotebook();
    scheduleSave({ persist: false });
  }

  function moveTab(sourceId, targetId) {
    if (!notebook || !sourceId || !targetId || sourceId === targetId) return;
    const sourceIndex = notebook.tabs.findIndex(tab => tab.id === sourceId);
    const targetIndex = notebook.tabs.findIndex(tab => tab.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const sourceTab = notebook.tabs[sourceIndex];
    const targetTab = notebook.tabs[targetIndex];
    if (sourceTab.locked || targetTab.locked) return;
    persistActivePageFromDom();
    notebook.tabs.splice(sourceIndex, 1);
    const adjustedTarget = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
    notebook.tabs.splice(adjustedTarget, 0, sourceTab);
    renderTabRail();
    scheduleSave({ persist: false });
  }

  function renderTabRail() {
    const rail = document.getElementById('studentNotebookTabRail');
    if (!rail || !notebook) return;
    rail.innerHTML = '';
    (notebook.tabs || []).forEach((tab, index) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `student-notebook-tab${tab.id === notebook.activeTabId ? ' active' : ''}${tab.locked ? ' locked' : ''}${tab.bookmarked ? ' bookmarked' : ''}`;
      const label = trimTabLabel(tab.label || 'Tab');
      btn.innerHTML = `<span class="student-notebook-tab-label">${escapeHtml(label)}</span>`;
      btn.title = tab.locked ? `${tab.label} (locked)` : `Open ${tab.label}`;
      btn.dataset.tabId = tab.id;
      btn.style.setProperty('--tab-label-chars', String(Math.max(3, label.length)));
      btn.style.setProperty('--tab-color', tab.id === ASSIGNMENTS_TAB_ID ? DEFAULT_ASSIGNMENTS_COLOR : normalizeTabColor(tab.color, index));
      btn.draggable = !tab.locked;
      btn.addEventListener('click', () => switchTab(tab.id));
      btn.addEventListener('dragstart', event => {
        if (tab.locked || !event.dataTransfer) return;
        event.dataTransfer.setData('text/plain', tab.id);
        event.dataTransfer.effectAllowed = 'move';
        btn.classList.add('dragging');
      });
      btn.addEventListener('dragend', () => btn.classList.remove('dragging'));
      btn.addEventListener('dragover', event => {
        if (tab.locked) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      });
      btn.addEventListener('drop', event => {
        event.preventDefault();
        moveTab(event.dataTransfer?.getData('text/plain'), tab.id);
      });
      rail.appendChild(btn);
    });
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'student-notebook-add-tab';
    addBtn.textContent = '+';
    addBtn.title = 'Add notebook tab';
    addBtn.addEventListener('click', addTab);
    rail.appendChild(addBtn);
  }

  function renderNotebook(animate = false) {
    renderTabRail();
    const page = document.getElementById('studentNotebookPage');
    if (!page || !notebook) return;
    const tab = activeTab();
    if (!tab) {
      page.innerHTML = '<div class="student-notebook-empty">No notebook tab selected.</div>';
      return;
    }
    updateNotebookToolbarMode(tab);
    if (animate) {
      page.classList.remove('turning');
      void page.offsetWidth;
      page.classList.add('turning');
      page.addEventListener('animationend', () => page.classList.remove('turning'), { once: true });
    }
    if (tab.id === ASSIGNMENTS_TAB_ID) renderAssignmentsPage(page, tab);
    else renderEditablePage(page, tab);
    bindCodeBlockActions();
    highlightCodeBlocks(page);
  }

  function updateNotebookToolbarMode(tab) {
    const toolbar = document.querySelector('.student-notebook-toolbar');
    if (!toolbar) return;
    toolbar.classList.toggle('assignments-active', tab?.id === ASSIGNMENTS_TAB_ID);
  }

  function renderEditablePage(page, tab) {
    page.innerHTML = `
      <div class="student-notebook-tab-actions">
        <h3 class="student-notebook-tab-title">
          <button class="student-notebook-bookmark-btn${tab.bookmarked ? ' active' : ''}" id="studentNotebookBookmarkTabBtn" type="button" title="${tab.bookmarked ? 'Remove bookmark' : 'Bookmark tab'}" aria-label="${tab.bookmarked ? 'Remove bookmark' : 'Bookmark tab'}">🔖</button>
          <span>${escapeHtml(tab.label || 'Notes')}</span>
        </h3>
        <div class="student-notebook-color-picker${colorPaletteOpen ? ' open' : ''}">
          <button class="student-notebook-tab-icon-btn student-notebook-color-toggle" id="studentNotebookTabColorToggle" type="button" title="Choose tab color" aria-label="Choose tab color" aria-expanded="${colorPaletteOpen ? 'true' : 'false'}">🎨</button>
          ${colorPaletteOpen ? tabColorPaletteHtml(tab.color) : ''}
        </div>
        <button class="student-notebook-tab-icon-btn" id="studentNotebookRenameTabBtn" type="button" title="Rename tab" aria-label="Rename tab">✎</button>
        <button class="student-notebook-tab-icon-btn danger" id="studentNotebookDeleteTabBtn" type="button" title="Delete tab" aria-label="Delete tab">🗑</button>
      </div>
      <div id="studentNotebookEditor" class="student-notebook-editor" contenteditable="true" spellcheck="true"></div>
    `;
    activeEditorEl = page.querySelector('#studentNotebookEditor');
    activeEditorEl.innerHTML = sanitizeHtml(tab.html || '<p><br></p>');
    activeEditorEl.addEventListener('input', scheduleSave);
    activeEditorEl.addEventListener('focus', () => { activeEditorEl = page.querySelector('#studentNotebookEditor'); });
    page.querySelector('#studentNotebookBookmarkTabBtn')?.addEventListener('click', toggleActiveTabBookmark);
    page.querySelector('#studentNotebookTabColorToggle')?.addEventListener('click', toggleTabColorPalette);
    page.querySelectorAll('[data-tab-color]').forEach(btn => {
      btn.addEventListener('click', () => {
        updateActiveTabColor(btn.dataset.tabColor);
      });
    });
    page.querySelector('#studentNotebookRenameTabBtn')?.addEventListener('click', renameActiveTab);
    page.querySelector('#studentNotebookDeleteTabBtn')?.addEventListener('click', deleteActiveTab);
  }

  function assignmentGradeHtml(block) {
    const score = String(block.score || '').trim();
    const feedback = String(block.feedback || '').trim();
    if (!score && !feedback) return '';
    return `
      <aside class="student-notebook-grade-note">
        ${score ? `<strong>Score: ${escapeHtml(score)}</strong>` : ''}
        ${feedback ? `<span>${escapeHtml(feedback)}</span>` : ''}
      </aside>
    `;
  }

  function renderAssignmentsPage(page, tab) {
    const blocks = Array.isArray(tab.blocks) ? tab.blocks : [];
    page.innerHTML = `
      <div class="student-notebook-tab-actions">
        <h3 class="student-notebook-tab-title">Assignments</h3>
        <span class="student-notebook-assignment-help">Respond to prompts given by your teacher here by either typing in your response or submitting your editor code.</span>
      </div>
      <div class="student-notebook-assignment-list">
        ${blocks.length ? blocks.map(block => `
          <section class="student-notebook-prompt-card${collapsedAssignmentIds.has(block.promptId) ? ' collapsed' : ''}${isAssignmentResponseLocked(block) ? ' locked' : ''}${String(block.score || '').trim() ? ' scored' : ''}" data-prompt-id="${escapeHtml(block.promptId)}">
            <button type="button" class="student-notebook-assignment-toggle" data-assignment-toggle="${escapeHtml(block.promptId)}" aria-expanded="${collapsedAssignmentIds.has(block.promptId) ? 'false' : 'true'}">
              <span class="student-notebook-prompt-meta">${escapeHtml(formatLocalDateTime(block.createdAt) || block.createdAt || '')}</span>
              <span class="student-notebook-assignment-title-wrap"><strong>${escapeHtml(block.title || 'Notebook Assignment')}</strong>${skillTagsHtml(block.skillTags)}</span>
              <span class="student-notebook-assignment-badges">
                <span>${block.responseType === 'code' ? 'Code response' : 'Written response'}</span>
                ${Number(block.maxScore || 0) > 0 ? `<span>${escapeHtml(block.maxScore)} pts</span>` : ''}
                ${isAssignmentResponseLocked(block) ? '<span>Locked</span>' : ''}
              </span>
            </button>
            <div class="student-notebook-assignment-body">
              <div class="student-notebook-prompt-text">${escapeHtml(block.prompt || '')}</div>
              ${block.responseType === 'code' && !isAssignmentResponseLocked(block) ? `<button type="button" class="btn secondary student-notebook-assignment-code-btn" data-assignment-code="${escapeHtml(block.promptId)}">${sanitizeHtml(block.responseHtml || '').includes('student-notebook-code-block') ? 'Update Code' : 'Insert Code'}</button>` : ''}
              <div class="student-notebook-response-wrap${block.responseType === 'code' ? ' code-response-wrap' : ''}">
                <div class="student-notebook-prompt-response${block.responseType === 'code' ? ' code-response' : ''}" contenteditable="${block.responseType === 'code' || isAssignmentResponseLocked(block) ? 'false' : 'true'}" spellcheck="true" data-prompt-id="${escapeHtml(block.promptId)}">${assignmentResponseHtml(block)}</div>
                ${assignmentGradeHtml(block)}
              </div>
            </div>
          </section>
        `).join('') : '<div class="student-notebook-empty">No teacher notebook prompts yet.</div>'}
      </div>
    `;
    page.querySelectorAll('[data-assignment-toggle]').forEach(btn => {
      btn.addEventListener('click', () => {
        const promptId = btn.dataset.assignmentToggle;
        if (!promptId) return;
        const nextCollapsed = !collapsedAssignmentIds.has(promptId);
        if (nextCollapsed) collapsedAssignmentIds.add(promptId);
        else collapsedAssignmentIds.delete(promptId);
        btn.closest('.student-notebook-prompt-card')?.classList.toggle('collapsed', nextCollapsed);
        btn.setAttribute('aria-expanded', nextCollapsed ? 'false' : 'true');
      });
    });
    page.querySelectorAll('[data-assignment-code]').forEach(btn => {
      btn.addEventListener('click', () => insertAssignmentCode(btn.dataset.assignmentCode));
    });
    page.querySelectorAll('.student-notebook-prompt-response').forEach(el => {
      el.addEventListener('input', () => {
        const block = blocks.find(b => b.promptId === el.dataset.promptId);
        if (block && !isAssignmentResponseLocked(block)) {
          block.responseHtml = sanitizeHtml(el.innerHTML || assignmentDefaultHtml(block));
          block.updatedAt = new Date().toISOString();
        }
        if (block && !isAssignmentResponseLocked(block)) scheduleSave();
      });
      el.addEventListener('focus', () => { activeEditorEl = el; });
    });
  }

  function applyFormat(command, value) {
    if (!activeEditorEl) activeEditorEl = document.getElementById('studentNotebookEditor');
    if (!activeEditorEl || activeTab()?.id === ASSIGNMENTS_TAB_ID && !activeEditorEl.classList.contains('student-notebook-prompt-response')) return;
    activeEditorEl.focus();
    document.execCommand(command, false, value || null);
    scheduleSave();
  }

  function normalizeLanguage(language) {
    const raw = String(language || '').toLowerCase();
    if (raw.includes('javascript') || raw === 'js') return 'javascript';
    if (raw.includes('html') || raw === 'xml') return 'html';
    if (raw.includes('css')) return 'css';
    return 'python';
  }

  function highlightLanguage(language) {
    const lang = normalizeLanguage(language);
    if (lang === 'javascript') return 'javascript';
    if (lang === 'html') return 'xml';
    if (lang === 'css') return 'css';
    return 'python';
  }

  function isRunnableLanguage(language) {
    return ['python', 'javascript'].includes(normalizeLanguage(language));
  }

  function fileNameForLanguage(language, fallbackName = '') {
    const name = String(fallbackName || '').trim();
    if (name) return name;
    const lang = normalizeLanguage(language);
    if (lang === 'javascript') return 'snippet.js';
    if (lang === 'html') return 'snippet.html';
    if (lang === 'css') return 'snippet.css';
    return 'snippet.py';
  }

  function isAssignmentCodeBlock(block) {
    return !!block?.closest?.('.student-notebook-prompt-response');
  }

  function codeLinesHtml(code, language, editable = true) {
    const hlLang = highlightLanguage(language);
    const lines = String(code ?? '').split('\n');
    return `<ol class="student-notebook-code-lines" contenteditable="${editable ? 'true' : 'false'}" spellcheck="false">${lines.map(line => `<li><code class="language-${escapeHtml(hlLang)}">${escapeHtml(line)}</code></li>`).join('')}</ol>`;
  }

  function buildCodeBlockHtml(snapshot, options = {}) {
    const trailingParagraph = options.trailingParagraph !== false;
    const editable = options.editable !== false;
    const codeId = `code_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const language = normalizeLanguage(snapshot.language);
    const fileName = fileNameForLanguage(language, snapshot.fileName);
    const runnable = isRunnableLanguage(language);
    return `<figure class="student-notebook-code-block"${editable ? '' : ' contenteditable="false" data-assignment-code="1"'} data-code-id="${escapeHtml(codeId)}" data-language="${escapeHtml(language)}" data-file-name="${escapeHtml(fileName)}">` +
      `<figcaption class="student-notebook-code-head" contenteditable="false"><span class="student-notebook-code-label">${escapeHtml(fileName)} · ${escapeHtml(language)}</span>` +
      `<span class="student-notebook-code-actions"><button type="button" data-code-action="open">Open in Editor</button>` +
      `<button type="button" data-code-action="run"${runnable ? '' : ' disabled'} title="${runnable ? 'Run this code in the notebook' : 'Open HTML or CSS in the editor to preview it'}">Run Here</button>` +
      `<button type="button" data-code-action="copy">Copy</button>${editable ? '<button type="button" class="student-notebook-code-delete" data-code-action="delete" title="Delete code block" aria-label="Delete code block">🗑</button>' : ''}</span></figcaption>` +
      `${codeLinesHtml(snapshot.code || '', language, editable)}` +
      `<div class="student-notebook-inline-shell" contenteditable="false" hidden><div class="notebook-shell-output"></div><div class="notebook-shell-input">` +
      `<input type="text" placeholder="Program input" autocomplete="off"><button type="button" data-code-action="send-input">Send</button>` +
      `<button type="button" data-code-action="stop">Stop</button><button type="button" data-code-action="close-shell">Close</button></div></div></figure>${trailingParagraph ? '<p><br></p>' : ''}`;
  }

  function insertEditorCode() {
    const c = ctx();
    if (!c.getEditorSnapshot) return;
    const tab = activeTab();
    if (!tab || tab.id === ASSIGNMENTS_TAB_ID) {
      alert('Switch to a personal notebook tab before inserting code.');
      return;
    }
    const snapshot = c.getEditorSnapshot();
    if (!snapshot.code.trim()) {
      alert('The editor is empty.');
      return;
    }
    const editorEl = document.getElementById('studentNotebookEditor');
    if (!editorEl) return;
    editorEl.focus();
    document.execCommand('insertHTML', false, buildCodeBlockHtml(snapshot));
    tab.html = sanitizeHtml(editorEl.innerHTML);
    bindCodeBlockActions();
    highlightCodeBlocks(editorEl);
    scheduleSave();
  }

  function insertAssignmentCode(promptId) {
    const c = ctx();
    const tab = assignmentsTab();
    const block = (tab?.blocks || []).find(row => row.promptId === promptId);
    if (!block) return;
    if (isAssignmentResponseLocked(block)) {
      alert('This assignment is locked by your teacher.');
      return;
    }
    const snapshot = c.getEditorSnapshot?.();
    if (!snapshot || !String(snapshot.code || '').trim()) {
      alert('The editor is empty.');
      return;
    }
    const responseEl = Array.from(document.querySelectorAll('.student-notebook-prompt-response[data-prompt-id]'))
      .find(el => el.dataset.promptId === promptId);
    if (!responseEl) return;
    const existing = responseEl.querySelector('.student-notebook-code-block');
    if (existing && !confirm('Replace the code already inserted for this assignment?')) return;
    const holder = document.createElement('div');
    holder.innerHTML = buildCodeBlockHtml(snapshot, { trailingParagraph: false, editable: false });
    responseEl.innerHTML = '';
    Array.from(holder.childNodes).forEach(node => responseEl.appendChild(node));
    block.responseHtml = sanitizeHtml(responseEl.innerHTML || assignmentDefaultHtml(block));
    block.updatedAt = new Date().toISOString();
    bindCodeBlockActions();
    highlightCodeBlocks(responseEl);
    scheduleSave();
    renderAssignmentsPage(document.getElementById('studentNotebookPage'), tab);
  }

  function highlightCodeBlocks(root = document) {
    if (!window.hljs) return;
    root.querySelectorAll('.student-notebook-code-lines code, .student-notebook-code-block pre code').forEach(codeEl => {
      try {
        codeEl.removeAttribute('data-highlighted');
        window.hljs.highlightElement(codeEl);
      } catch {}
    });
  }

  function getCodeBlockText(block) {
    const numberedLines = Array.from(block.querySelectorAll('.student-notebook-code-lines li code'));
    if (numberedLines.length) return numberedLines.map(line => line.textContent || '').join('\n');
    return block.querySelector('pre code')?.textContent || '';
  }

  function ensureCodeBlockLineNumbers(block, language) {
    const editable = !isAssignmentCodeBlock(block);
    const lineList = block.querySelector('.student-notebook-code-lines');
    if (lineList) {
      lineList.contentEditable = editable ? 'true' : 'false';
      lineList.spellcheck = false;
      lineList.querySelectorAll('code').forEach(codeEl => {
        codeEl.className = `language-${highlightLanguage(language)}`;
      });
      return;
    }
    const legacyPre = block.querySelector('pre');
    if (!legacyPre) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = codeLinesHtml(legacyPre.querySelector('code')?.textContent || '', language, editable);
    legacyPre.replaceWith(wrap.firstElementChild);
  }

  function ensureCodeBlockControls(block) {
    if (!block.dataset.codeId) {
      block.dataset.codeId = `code_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    }
    const language = normalizeLanguage(block.dataset.language || 'python');
    block.dataset.language = language;
    const assignmentBlock = isAssignmentCodeBlock(block);
    if (assignmentBlock) {
      block.contentEditable = 'false';
      block.dataset.assignmentCode = '1';
    } else {
      block.removeAttribute('contenteditable');
      block.removeAttribute('data-assignment-code');
    }
    ensureCodeBlockLineNumbers(block, language);
    const fileName = fileNameForLanguage(language, block.dataset.fileName);
    block.dataset.fileName = fileName;
    let head = block.querySelector('.student-notebook-code-head');
    if (!head) {
      head = document.createElement('figcaption');
      head.className = 'student-notebook-code-head';
      block.insertBefore(head, block.firstChild);
    }
    head.contentEditable = 'false';
    let label = head.querySelector('.student-notebook-code-label');
    if (!label) {
      label = document.createElement('span');
      label.className = 'student-notebook-code-label';
      head.insertBefore(label, head.firstChild);
    }
    if (label) label.textContent = `${fileName} · ${language}`;
    let actions = head.querySelector('.student-notebook-code-actions');
    if (!actions) {
      actions = document.createElement('span');
      actions.className = 'student-notebook-code-actions';
      head.appendChild(actions);
    }
    actions.contentEditable = 'false';
    const actionsMissing = !actions.querySelector('[data-code-action="open"]')
      || !actions.querySelector('[data-code-action="run"]')
      || !actions.querySelector('[data-code-action="copy"]')
      || (!assignmentBlock && !actions.querySelector('[data-code-action="delete"]'))
      || (assignmentBlock && !!actions.querySelector('[data-code-action="delete"]'));
    if (actionsMissing) {
      actions.innerHTML = '<button type="button" data-code-action="open">Open in Editor</button>'
        + '<button type="button" data-code-action="run">Run Here</button>'
        + '<button type="button" data-code-action="copy">Copy</button>'
        + (assignmentBlock ? '' : '<button type="button" class="student-notebook-code-delete" data-code-action="delete" title="Delete code block" aria-label="Delete code block">🗑</button>');
      boundCodeBlocks.delete(block);
    }
    const runBtn = head.querySelector('[data-code-action="run"]');
    if (runBtn && !isRunnableLanguage(language)) {
      runBtn.disabled = true;
      runBtn.title = 'Open HTML or CSS in the editor to preview it';
    }
    let shell = block.querySelector('.student-notebook-inline-shell');
    if (!shell || !shell.querySelector('input') || !shell.querySelector('[data-code-action="send-input"]') || !shell.querySelector('[data-code-action="close-shell"]')) {
      if (shell) shell.remove();
      shell = document.createElement('div');
      shell.className = 'student-notebook-inline-shell';
      shell.contentEditable = 'false';
      shell.hidden = true;
      shell.innerHTML = `
        <div class="notebook-shell-output"></div>
        <div class="notebook-shell-input">
          <input type="text" placeholder="Program input" autocomplete="off">
          <button type="button" data-code-action="send-input">Send</button>
          <button type="button" data-code-action="stop">Stop</button>
          <button type="button" data-code-action="close-shell">Close</button>
        </div>
      `;
      block.appendChild(shell);
      boundCodeBlocks.delete(block);
    }
    shell.contentEditable = 'false';
  }

  function resetCodeBlockShell(block) {
    const shell = block?.querySelector?.('.student-notebook-inline-shell');
    if (!shell) return;
    shell.hidden = true;
    const output = shell.querySelector('.notebook-shell-output');
    if (output) output.textContent = '';
    const input = shell.querySelector('.notebook-shell-input input');
    if (input) input.value = '';
  }

  function closeCodeBlockShell(block, { stop = false } = {}) {
    if (stop && block?.dataset?.codeId && block.dataset.codeId === runningCodeId) {
      ctx().stopNotebookRun?.();
      runningCodeId = null;
      waitingForNotebookInput = false;
      updateNotebookRunButtons();
    }
    resetCodeBlockShell(block);
  }

  function hideAllCodeBlockShells({ stop = false } = {}) {
    document.querySelectorAll('.student-notebook-code-block').forEach(block => closeCodeBlockShell(block, { stop }));
  }

  function cleanCodeBlockForSave(block) {
    const language = normalizeLanguage(block?.dataset?.language || 'python');
    block.removeAttribute('data-bound');
    ensureCodeBlockLineNumbers(block, language);
    resetCodeBlockShell(block);
    block.querySelectorAll('.student-notebook-code-lines code, pre code').forEach(codeEl => {
      codeEl.textContent = codeEl.textContent || '';
      codeEl.className = `language-${highlightLanguage(language)}`;
      codeEl.removeAttribute('data-highlighted');
    });
  }

  function appendNotebookOutput(shell, text) {
    const out = shell.querySelector('.notebook-shell-output');
    if (!out) return;
    let s = String(text || '');
    if (s.includes(INPUT_TOKEN)) {
      s = s.split(INPUT_TOKEN).join('');
      waitingForNotebookInput = true;
      setTimeout(() => shell.querySelector('input')?.focus(), 0);
    }
    let textNode = out.lastChild;
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
      textNode = document.createTextNode('');
      out.appendChild(textNode);
    }
    textNode.appendData(s);
    if (textNode.length > MAX_INLINE_OUTPUT_CHARS) {
      const keep = textNode.data.slice(-(MAX_INLINE_OUTPUT_CHARS - 64));
      textNode.data = `[Earlier output removed to keep the browser responsive]\n${keep}`;
    }
    out.scrollTop = out.scrollHeight;
  }

  function updateNotebookRunButtons() {
    const c = ctx();
    const running = !!c.isProgramRunning;
    const source = c.activeRunSource;
    document.querySelectorAll('.student-notebook-code-block').forEach(block => {
      const codeId = block.dataset.codeId;
      const runBtn = block.querySelector('[data-code-action="run"]');
      const openBtn = block.querySelector('[data-code-action="open"]');
      const disabled = running && !(source === 'notebook' && runningCodeId === codeId);
      if (runBtn) {
        const runnable = isRunnableLanguage(block.dataset.language);
        runBtn.disabled = !runnable || disabled;
        runBtn.textContent = source === 'notebook' && runningCodeId === codeId ? 'Running...' : 'Run Here';
        runBtn.title = runnable ? 'Run this code in the notebook' : 'Open HTML or CSS in the editor to preview it';
      }
      if (openBtn) openBtn.disabled = false;
    });
  }

  function runCodeBlock(block) {
    const language = normalizeLanguage(block.dataset.language);
    if (!['python', 'javascript'].includes(language)) {
      alert('Notebook inline runs currently support Python and JavaScript snippets.');
      return;
    }
    const c = ctx();
    if (c.isProgramRunning) return;
    const codeId = block.dataset.codeId;
    const shell = block.querySelector('.student-notebook-inline-shell');
    shell.hidden = false;
    shell.querySelector('.notebook-shell-output').textContent = '[Sending code]\n';
    waitingForNotebookInput = false;
    runningCodeId = codeId;
    const ok = c.runNotebookCode?.({
      code: getCodeBlockText(block),
      language,
      fileName: block.dataset.fileName || '',
      onAck: () => appendNotebookOutput(shell, '[Run acknowledged]\n'),
      onOutput: text => appendNotebookOutput(shell, text),
      onFinished: () => {
        appendNotebookOutput(shell, '\n[Process finished]\n');
        runningCodeId = null;
        waitingForNotebookInput = false;
        updateNotebookRunButtons();
      },
    });
    if (!ok) {
      appendNotebookOutput(shell, '[Could not start run]\n');
      runningCodeId = null;
    }
    updateNotebookRunButtons();
  }

  function bindCodeBlockActions() {
    document.querySelectorAll('.student-notebook-code-block').forEach(block => {
      ensureCodeBlockControls(block);
      block.removeAttribute('data-bound');
      if (boundCodeBlocks.has(block)) return;
      boundCodeBlocks.add(block);
      block.querySelector('[data-code-action="open"]')?.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        await ctx().setEditorSnapshot?.({
          code: getCodeBlockText(block),
          language: block.dataset.language || 'python',
          fileName: block.dataset.fileName || '',
        });
      });
      block.querySelector('[data-code-action="run"]')?.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        runCodeBlock(block);
      });
      block.querySelector('[data-code-action="copy"]')?.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        try {
          await navigator.clipboard.writeText(getCodeBlockText(block));
        } catch {
          alert('Copy failed.');
        }
      });
      block.querySelector('[data-code-action="delete"]')?.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        if (isAssignmentCodeBlock(block)) return;
        block.remove();
        scheduleSave();
      });
      block.querySelector('[data-code-action="send-input"]')?.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        const input = block.querySelector('.notebook-shell-input input');
        const value = input?.value || '';
        if (input) input.value = '';
        if (waitingForNotebookInput) appendNotebookOutput(block, `${value}\n`);
        ctx().sendNotebookInput?.(value);
        waitingForNotebookInput = false;
      });
      block.querySelector('.notebook-shell-input input')?.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          block.querySelector('[data-code-action="send-input"]')?.click();
        }
      });
      block.querySelector('[data-code-action="stop"]')?.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        ctx().stopNotebookRun?.();
      });
      block.querySelector('[data-code-action="close-shell"]')?.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        closeCodeBlockShell(block, { stop: true });
      });
    });
    updateNotebookRunButtons();
  }

  function openDrawer() {
    if (!isStudentInClass()) {
      alert('Join a class to use the notebook.');
      return;
    }
    drawerOpen = true;
    document.getElementById('studentNotebookDrawer')?.classList.add('open');
    document.getElementById('studentNotebookDrawer')?.setAttribute('aria-hidden', 'false');
    const overlay = document.getElementById('studentNotebookOverlay');
    if (overlay) overlay.hidden = true;
    loadNotebook().catch(err => console.warn(err));
  }

  async function closeDrawer() {
    hideAllCodeBlockShells({ stop: true });
    if (dirty) await saveNotebook({ immediate: true });
    drawerOpen = false;
    document.getElementById('studentNotebookDrawer')?.classList.remove('open');
    document.getElementById('studentNotebookDrawer')?.setAttribute('aria-hidden', 'true');
    const overlay = document.getElementById('studentNotebookOverlay');
    if (overlay) overlay.hidden = true;
  }

  async function refreshAssignmentsFromServer() {
    if (!drawerOpen || !isStudentInClass()) return;
    const classId = currentClassId();
    if (!classId) return;
    persistActivePageFromDom();
    const localNotebook = notebook;
    const localAssignments = assignmentsTab();
    const localBlocks = new Map((localAssignments?.blocks || []).map(block => [block.promptId, block]));
    const res = await fetch(`/api/notebook?classId=${encodeURIComponent(classId)}`, { headers: userHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!data?.ok) throw new Error(data?.error || 'Notebook refresh failed');
    const fresh = ensureNotebookShape(data.notebook);
    const freshAssignments = (fresh.tabs || []).find(tab => tab.id === ASSIGNMENTS_TAB_ID);
    if (freshAssignments) {
      (freshAssignments.blocks || []).forEach(block => {
        const local = localBlocks.get(block.promptId);
        if (local && !isAssignmentResponseLocked(block)) {
          block.responseHtml = local.responseHtml || block.responseHtml || assignmentDefaultHtml(block);
          block.updatedAt = local.updatedAt || block.updatedAt || '';
        }
      });
    }
    if (localNotebook) {
      localNotebook.tabs = (localNotebook.tabs || []).filter(tab => tab.id !== ASSIGNMENTS_TAB_ID);
      localNotebook.tabs.push(freshAssignments || { id: ASSIGNMENTS_TAB_ID, label: 'Assignments', locked: true, blocks: [] });
      localNotebook.activeTabId = notebook?.activeTabId || localNotebook.activeTabId;
      notebook = ensureNotebookShape(localNotebook);
    } else {
      notebook = fresh;
    }
    loadedClassId = classId;
    if (activeTab()?.id === ASSIGNMENTS_TAB_ID) renderNotebook(false);
  }

  function updateEntryPoints() {
    const c = ctx();
    const studentShow = !!(c.USER_TOKEN && !c.TEACHER_TOKEN && !c.ADMIN_TOKEN && currentClassId());
    const notebookBtn = document.getElementById('notebookOpenBtn');
    if (notebookBtn) notebookBtn.style.display = studentShow ? '' : 'none';
    const teacherPromptBtn = document.getElementById('teacherNotebookPromptBtn');
    if (teacherPromptBtn) teacherPromptBtn.style.display = isTeacher() ? '' : 'none';
    if (!studentShow && drawerOpen) closeDrawer();
  }

  function searchNotebook(query) {
    const box = document.getElementById('studentNotebookSearchResults');
    if (!box || !notebook) return;
    const q = String(query || '').trim().toLowerCase();
    if (!q) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    const results = [];
    (notebook.tabs || []).forEach(tab => {
      if (tab.id === ASSIGNMENTS_TAB_ID) {
        (tab.blocks || []).forEach(block => {
          const hay = `${block.prompt || ''} ${stripHtml(block.responseHtml || '')}`;
          if (hay.toLowerCase().includes(q)) {
            results.push({ tabId: tab.id, title: `${tab.label}: ${block.createdAt || 'Prompt'}`, body: hay.slice(0, 180) });
          }
        });
      } else {
        const hay = `${tab.label || ''} ${stripHtml(tab.html || '')}`;
        if (hay.toLowerCase().includes(q)) {
          results.push({ tabId: tab.id, title: tab.label || 'Tab', body: hay.slice(0, 180) });
        }
      }
    });
    box.hidden = false;
    box.innerHTML = results.length
      ? results.map((r, idx) => `<button class="student-notebook-search-result" data-result-idx="${idx}"><strong>${escapeHtml(r.title)}</strong><br><span>${escapeHtml(r.body)}</span></button>`).join('')
      : '<div style="padding:8px;color:#6f6254;">No matches.</div>';
    box.querySelectorAll('[data-result-idx]').forEach(btn => {
      btn.addEventListener('click', () => {
        const result = results[Number(btn.dataset.resultIdx)];
        if (result) switchTab(result.tabId);
        box.hidden = true;
      });
    });
  }

  function codeTokens(line, language) {
    const lang = normalizeLanguage(language);
    const keywords = lang === 'javascript'
      ? /\b(const|let|var|function|return|if|else|for|while|class|new|await|async|import|from|console|true|false|null)\b/g
      : lang === 'css'
        ? /\b(display|position|grid|flex|color|background|border|padding|margin|font|width|height|content|media|hover|focus|active)\b/g
        : lang === 'html'
          ? /<\/?[A-Za-z][\w-]*|[A-Za-z:-]+(?=\=)/g
          : /\b(def|return|if|elif|else|for|while|class|import|from|as|with|try|except|True|False|None|print|range|in)\b/g;
    const parts = [];
    let i = 0;
    const pattern = lang === 'css'
      ? /("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\/\*.*?\*\/|#[0-9A-Fa-f]{3,8}\b|\b\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw)?\b)/g
      : lang === 'html'
        ? /(<!--.*?-->|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\b\d+(?:\.\d+)?\b)/g
        : /("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|#.*$|\/\/.*$|\b\d+(?:\.\d+)?\b)/g;
    let match;
    while ((match = pattern.exec(line))) {
      if (match.index > i) parts.push({ text: line.slice(i, match.index), type: 'plain' });
      const token = match[0];
      const type = token.startsWith('//') || token.startsWith('/*') || token.startsWith('<!--') || (lang === 'python' && token.startsWith('#'))
        ? 'comment'
        : (/^#/.test(token) || /^\d/.test(token) ? 'number' : 'string');
      parts.push({ text: token, type });
      i = match.index + token.length;
    }
    if (i < line.length) parts.push({ text: line.slice(i), type: 'plain' });
    return parts.flatMap(part => {
      if (part.type !== 'plain') return [part];
      const out = [];
      let pos = 0;
      let km;
      keywords.lastIndex = 0;
      while ((km = keywords.exec(part.text))) {
        if (km.index > pos) out.push({ text: part.text.slice(pos, km.index), type: 'plain' });
        out.push({ text: km[0], type: 'keyword' });
        pos = km.index + km[0].length;
      }
      if (pos < part.text.length) out.push({ text: part.text.slice(pos), type: 'plain' });
      return out;
    });
  }

  function exportPdf() {
    if (!notebook) return;
    persistActivePageFromDom();
    (async () => {
      try {
        const jspdfGlobal = await window.EagleIDE.ensureJsPDF();
        const JsPDF = jspdfGlobal?.jsPDF || window.jspdf?.jsPDF;
        const doc = new JsPDF({ unit: 'pt', format: 'letter' });
        const margin = 54;
        const width = doc.internal.pageSize.getWidth();
        const height = doc.internal.pageSize.getHeight();
        let y = margin;
        const ensureSpace = needed => {
          if (y + needed > height - margin) {
            doc.addPage();
            y = margin;
          }
        };
        const addText = (text, size = 11, color = [34, 34, 34]) => {
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(size);
          doc.setTextColor(...color);
          const lines = doc.splitTextToSize(String(text || ''), width - margin * 2);
          lines.forEach(line => {
            ensureSpace(size + 8);
            doc.text(line, margin, y);
            y += size + 6;
          });
        };
        const addCode = (code, language, fileName) => {
          const lines = String(code || '').split('\n');
          const lineHeight = 13;
          const startY = y;
          const blockHeight = Math.min((lines.length + 1) * lineHeight + 20, height - margin * 2);
          ensureSpace(Math.min(blockHeight, 280));
          doc.setFillColor(20, 27, 39);
          doc.roundedRect(margin, y, width - margin * 2, Math.max(48, (lines.length + 1) * lineHeight + 20), 6, 6, 'F');
          doc.setFont('courier', 'normal');
          doc.setFontSize(9);
          doc.setTextColor(226, 232, 240);
          doc.text(`${fileName || 'Code'} · ${language || 'python'}`, margin + 12, y + 16);
          y += 32;
          lines.forEach((line, idx) => {
            ensureSpace(lineHeight + 4);
            if (y < startY) return;
            doc.setFont('courier', 'normal');
            doc.setFontSize(8.5);
            doc.setTextColor(148, 163, 184);
            doc.text(String(idx + 1).padStart(3, ' '), margin + 10, y);
            let x = margin + 40;
            codeTokens(line, normalizeLanguage(language)).forEach(part => {
              if (part.type === 'keyword') doc.setTextColor(125, 211, 252);
              else if (part.type === 'string') doc.setTextColor(134, 239, 172);
              else if (part.type === 'comment') doc.setTextColor(148, 163, 184);
              else if (part.type === 'number') doc.setTextColor(216, 180, 254);
              else doc.setTextColor(226, 232, 240);
              doc.text(part.text || ' ', x, y);
              x += doc.getTextWidth(part.text || ' ');
            });
            y += lineHeight;
          });
          y += 16;
        };
        addText('EagleIDE Notebook', 18, [36, 75, 122]);
        addText(new Date().toLocaleString(), 9, [100, 100, 100]);
        (notebook.tabs || []).forEach(tab => {
          ensureSpace(40);
          addText(tab.label || 'Tab', 15, [36, 75, 122]);
          if (tab.id === ASSIGNMENTS_TAB_ID) {
            (tab.blocks || []).forEach(block => {
              addText(`${formatLocalDateTime(block.createdAt) || block.createdAt || ''} - ${block.title || 'Notebook Assignment'}`, 11, [128, 75, 20]);
              addText(block.prompt || '', 11, [36, 75, 122]);
              addText(stripHtml(block.responseHtml || ''), 11);
            });
          } else {
            const holder = document.createElement('div');
            holder.innerHTML = sanitizeHtml(tab.html || '');
            holder.querySelectorAll('.student-notebook-code-block').forEach(block => {
              block.remove();
            });
            addText(holder.textContent || '', 11);
            const codeHolder = document.createElement('div');
            codeHolder.innerHTML = sanitizeHtml(tab.html || '');
            codeHolder.querySelectorAll('.student-notebook-code-block').forEach(block => {
              addCode(getCodeBlockText(block), block.dataset.language || 'python', block.dataset.fileName || 'Code');
            });
          }
        });
        doc.save(`eagleide-notebook-${new Date().toISOString().slice(0, 10)}.pdf`);
      } catch (err) {
        console.warn(err);
        alert('Could not export notebook PDF.');
      }
    })();
  }

  async function loadTeacherNotebookSkills() {
    if (!isTeacher()) {
      teacherNotebookSkills = [];
      return [];
    }
    try {
      const res = await fetch('/api/teacher/skills', { headers: teacherHeaders() });
      const data = await res.json().catch(() => ({}));
      teacherNotebookSkills = Array.isArray(data?.skills) ? data.skills : [];
    } catch {
      teacherNotebookSkills = [];
    }
    return teacherNotebookSkills;
  }

  function renderTeacherNotebookSkillPicker(classId, selectedTags = []) {
    const box = document.getElementById('teacherNotebookSkillTags');
    if (!box) return;
    const selected = new Set(selectedTags || []);
    const skills = teacherNotebookSkills.filter(skill => {
      const classIds = Array.isArray(skill.class_ids) ? skill.class_ids : [];
      return classIds.includes(classId);
    });
    box.innerHTML = skills.length ? skills.map(skill => `
      <label class="teacher-notebook-skill-option">
        <input type="checkbox" class="teacher-notebook-skill-check" value="${escapeHtml(skill.name || '')}" ${selected.has(skill.name) ? 'checked' : ''}>
        <span>#${escapeHtml(skill.name || '')}</span>
      </label>
    `).join('') : '<div class="teacher-notebook-skill-empty">No skill tags are attached to this class yet.</div>';
  }

  function selectedTeacherNotebookSkillTags() {
    return Array.from(document.querySelectorAll('.teacher-notebook-skill-check:checked'))
      .map(input => input.value)
      .filter(Boolean);
  }

  function openTeacherPromptModal() {
    if (!isTeacher()) return;
    const c = ctx();
    const classId = c.currentTeacherClassId || c.teacherClasses?.[0]?.id;
    if (!classId) return alert('Create or select a class first.');
    const cls = (c.teacherClasses || []).find(row => row.id === classId);
    const modal = document.getElementById('teacherNotebookPromptModal');
    document.getElementById('teacherNotebookPromptClassLabel').textContent = cls ? `Class: ${cls.name}` : 'Selected class';
    document.getElementById('teacherNotebookPromptTitleInput').value = '';
    document.getElementById('teacherNotebookPromptInput').value = '';
    const maxScoreInput = document.getElementById('teacherNotebookPromptMaxScoreInput');
    if (maxScoreInput) maxScoreInput.value = '10';
    renderTeacherNotebookSkillPicker(classId);
    loadTeacherNotebookSkills().then(() => renderTeacherNotebookSkillPicker(classId));
    const written = document.querySelector('input[name="teacherNotebookResponseType"][value="written"]');
    if (written) written.checked = true;
    document.getElementById('teacherNotebookPromptStatus').textContent = '';
    modal.style.display = 'flex';
    setTimeout(() => document.getElementById('teacherNotebookPromptTitleInput')?.focus(), 0);
  }

  async function submitTeacherPrompt() {
    const c = ctx();
    const classId = c.currentTeacherClassId || c.teacherClasses?.[0]?.id;
    const title = document.getElementById('teacherNotebookPromptTitleInput')?.value?.trim() || '';
    const prompt = document.getElementById('teacherNotebookPromptInput')?.value?.trim() || '';
    const responseType = document.querySelector('input[name="teacherNotebookResponseType"]:checked')?.value || 'written';
    const maxScoreRaw = document.getElementById('teacherNotebookPromptMaxScoreInput')?.value;
    const maxScore = Math.max(0, Math.min(1000, parseInt(maxScoreRaw || '10', 10) || 0));
    const skillTags = selectedTeacherNotebookSkillTags();
    const status = document.getElementById('teacherNotebookPromptStatus');
    if (!classId) return alert('Select a class first.');
    if (!prompt) {
      status.textContent = 'Type a prompt before sending.';
      return;
    }
    status.textContent = 'Sending...';
    try {
      const res = await fetch('/api/teacher/notebook-prompts/create', {
        method: 'POST',
        headers: teacherJsonHeaders(),
        body: JSON.stringify({ classId, title, prompt, responseType, maxScore, skillTags }),
      });
      const data = await res.json().catch(() => ({}));
      if (!data?.ok) throw new Error(data?.error || 'Send failed');
      status.textContent = 'Prompt sent.';
      document.getElementById('teacherNotebookPromptModal').style.display = 'none';
      await loadTeacherNotebookPrompts();
    } catch (err) {
      status.textContent = err.message || 'Send failed.';
    }
  }

  function populateTeacherNotebookClassSelect() {
    const sel = document.getElementById('teacherNotebookClassSelect');
    if (!sel) return null;
    const c = ctx();
    const classes = c.teacherClasses || [];
    const current = c.currentTeacherClassId || classes[0]?.id || '';
    sel.innerHTML = classes.map(cls => `<option value="${escapeHtml(cls.id)}" ${cls.id === current ? 'selected' : ''}>${escapeHtml(cls.name)} (${escapeHtml(cls.join_code || '')})</option>`).join('');
    return sel.value || current;
  }

  async function loadTeacherNotebookPrompts() {
    if (!isTeacher()) return;
    const classId = populateTeacherNotebookClassSelect();
    const list = document.getElementById('teacherNotebookPromptList');
    const detail = document.getElementById('teacherNotebookResponseList');
    if (!classId || !list) return;
    list.innerHTML = '<div style="color:#888;">Loading prompts...</div>';
    if (detail) detail.innerHTML = '<p style="color:#888;margin:0;">Choose a notebook prompt to review student responses.</p>';
    try {
      const res = await fetch(`/api/teacher/notebook-prompts?classId=${encodeURIComponent(classId)}`, { headers: teacherHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!data?.ok) throw new Error(data?.error || 'Load failed');
      const prompts = data.prompts || [];
      list.innerHTML = prompts.length ? prompts.map(prompt => `
        <button class="teacher-notebook-prompt-row${prompt.id === selectedTeacherPromptId ? ' active' : ''}" data-prompt-id="${escapeHtml(prompt.id)}">
          <span class="teacher-notebook-prompt-title"><strong>${escapeHtml(prompt.title || prompt.prompt || 'Notebook Assignment')}</strong>${skillTagsHtml(prompt.skillTags)}</span>
          <div class="meta">${escapeHtml(formatLocalDateTime(prompt.createdAt) || prompt.createdAt || '')} · ${prompt.responseType === 'code' ? 'Code' : 'Written'} · Max ${escapeHtml(prompt.maxScore || 0)} · ${prompt.responseCount || 0}/${prompt.studentCount || 0} responded${prompt.locked ? ' · Locked' : ''}</div>
        </button>
      `).join('') : '<div style="color:#888;">No notebook prompts have been sent yet.</div>';
      list.querySelectorAll('[data-prompt-id]').forEach(btn => {
        btn.addEventListener('click', () => loadTeacherPromptResponses(classId, btn.dataset.promptId));
      });
      if (selectedTeacherPromptId && prompts.some(p => p.id === selectedTeacherPromptId)) {
        await loadTeacherPromptResponses(classId, selectedTeacherPromptId);
      }
    } catch (err) {
      list.innerHTML = `<div style="color:#ef5350;">${escapeHtml(err.message || 'Could not load prompts.')}</div>`;
    }
  }

  async function setTeacherPromptLocked(classId, promptId, locked) {
    const res = await fetch('/api/teacher/notebook-prompts/lock', {
      method: 'POST',
      headers: teacherJsonHeaders(),
      body: JSON.stringify({ classId, promptId, locked }),
    });
    const data = await res.json().catch(() => ({}));
    if (!data?.ok) throw new Error(data?.error || 'Could not update lock.');
    await loadTeacherNotebookPrompts();
    await loadTeacherPromptResponses(classId, promptId);
  }

  async function deleteTeacherPrompt(classId, promptId) {
    if (!confirm('Delete this notebook assignment and remove student submissions from the Assignments tab?')) return;
    const res = await fetch('/api/teacher/notebook-prompts/delete', {
      method: 'POST',
      headers: teacherJsonHeaders(),
      body: JSON.stringify({ classId, promptId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!data?.ok) throw new Error(data?.error || 'Could not delete assignment.');
    selectedTeacherPromptId = null;
    await loadTeacherNotebookPrompts();
  }

  async function saveTeacherNotebookGrade(classId, promptId, studentEmail, card) {
    const score = card.querySelector('[data-grade-score]')?.value || '';
    const feedback = card.querySelector('[data-grade-feedback]')?.value || '';
    const status = card.querySelector('[data-grade-status]');
    if (status) status.textContent = 'Saving...';
    const res = await fetch('/api/teacher/notebook-prompts/grade', {
      method: 'POST',
      headers: teacherJsonHeaders(),
      body: JSON.stringify({ classId, promptId, studentEmail, score, feedback }),
    });
    const data = await res.json().catch(() => ({}));
    if (!data?.ok) throw new Error(data?.error || 'Could not save feedback.');
    if (status) status.textContent = 'Saved';
  }

  async function loadTeacherPromptResponses(classId, promptId) {
    selectedTeacherPromptId = promptId;
    document.querySelectorAll('.teacher-notebook-prompt-row').forEach(row => row.classList.toggle('active', row.dataset.promptId === promptId));
    const title = document.getElementById('teacherNotebookResponseTitle');
    const list = document.getElementById('teacherNotebookResponseList');
    if (!list) return;
    list.innerHTML = '<div style="color:#888;">Loading responses...</div>';
    try {
      const res = await fetch(`/api/teacher/notebook-prompts/responses?classId=${encodeURIComponent(classId)}&promptId=${encodeURIComponent(promptId)}`, { headers: teacherHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!data?.ok) throw new Error(data?.error || 'Load failed');
      const prompt = data.prompt || {};
      if (title) title.textContent = prompt.title || prompt.prompt || 'Notebook responses';
      const responsesHtml = (data.responses || []).map(row => {
        const scored = !!(String(row.score || '').trim() || String(row.feedback || '').trim());
        return `
        <article class="teacher-notebook-response-card${scored ? ' scored' : ''}" data-student-email="${escapeHtml(row.studentEmail || '')}">
          <div class="teacher-notebook-response-head">
            <div>
              <strong>${escapeHtml(row.studentName || row.studentEmail)}</strong>
              <div class="meta">${escapeHtml(row.studentEmail || '')}${row.updatedAt ? ` · Submitted ${escapeHtml(formatLocalDateTime(row.updatedAt))}` : ''}</div>
            </div>
            <div class="teacher-notebook-score-actions">
              <span class="teacher-notebook-scored-badge" ${scored ? '' : 'hidden'}>Scored</span>
              <button type="button" class="btn secondary" data-grade-toggle>${scored ? 'Edit Score' : 'Score'}</button>
            </div>
          </div>
          <div class="teacher-notebook-response-body">${sanitizeHtml(row.responseHtml || '')}</div>
          ${scored ? `
            <div class="teacher-notebook-feedback-note">
              ${row.score ? `<strong>Score: ${escapeHtml(row.score)}</strong>` : ''}
              ${row.feedback ? `<span>${escapeHtml(row.feedback)}</span>` : ''}
            </div>
          ` : ''}
          <div class="teacher-notebook-grade-controls" hidden>
            <input type="text" data-grade-score value="${escapeHtml(row.score || '')}" placeholder="Score">
            <textarea data-grade-feedback placeholder="Feedback">${escapeHtml(row.feedback || '')}</textarea>
            <button type="button" class="btn secondary" data-grade-save>Save Feedback</button>
            <span data-grade-status></span>
          </div>
        </article>
      `;
      }).join('');
      const missing = data.missing || [];
      list.innerHTML = `
        <div class="teacher-notebook-assignment-actions">
          <div>
            <span class="teacher-notebook-prompt-title"><strong>${escapeHtml(prompt.title || 'Notebook Assignment')}</strong>${skillTagsHtml(prompt.skillTags)}</span>
            <div class="meta">${escapeHtml(formatLocalDateTime(prompt.createdAt) || prompt.createdAt || '')} · ${prompt.responseType === 'code' ? 'Code response' : 'Written response'} · Max ${escapeHtml(prompt.maxScore || 0)}</div>
          </div>
          <button type="button" class="btn secondary" id="teacherNotebookLockPromptBtn">${prompt.locked ? 'Unlock Submissions' : 'Lock Submissions'}</button>
          <button type="button" class="btn danger" id="teacherNotebookDeletePromptBtn">Delete Assignment</button>
        </div>
        ${responsesHtml || '<div style="color:#888;">No responses yet.</div>'}
        <div class="teacher-notebook-missing">
          <strong>Not responded (${missing.length})</strong>
          <div>${missing.map(s => escapeHtml(s.studentName || s.studentEmail)).join(', ') || 'Everyone has responded.'}</div>
        </div>
      `;
      highlightCodeBlocks(list);
      document.getElementById('teacherNotebookLockPromptBtn')?.addEventListener('click', () => {
        setTeacherPromptLocked(classId, promptId, !prompt.locked).catch(err => alert(err.message || 'Could not update lock.'));
      });
      document.getElementById('teacherNotebookDeletePromptBtn')?.addEventListener('click', () => {
        deleteTeacherPrompt(classId, promptId).catch(err => alert(err.message || 'Could not delete assignment.'));
      });
      list.querySelectorAll('[data-grade-toggle]').forEach(btn => {
        btn.addEventListener('click', () => {
          const card = btn.closest('[data-student-email]');
          const controls = card?.querySelector('.teacher-notebook-grade-controls');
          if (!controls) return;
          controls.hidden = !controls.hidden;
        });
      });
      list.querySelectorAll('[data-grade-save]').forEach(btn => {
        btn.addEventListener('click', () => {
          const card = btn.closest('[data-student-email]');
          saveTeacherNotebookGrade(classId, promptId, card.dataset.studentEmail, card)
            .then(() => loadTeacherPromptResponses(classId, promptId))
            .catch(err => {
              const status = card.querySelector('[data-grade-status]');
              if (status) status.textContent = err.message || 'Save failed';
            });
        });
      });
    } catch (err) {
      list.innerHTML = `<div style="color:#ef5350;">${escapeHtml(err.message || 'Could not load responses.')}</div>`;
    }
  }

  function onAuthChanged() {
    const nextClassId = currentClassId();
    updateEntryPoints();
    if (nextClassId !== loadedClassId) {
      notebook = null;
      loadedClassId = null;
      if (drawerOpen && isStudentInClass()) loadNotebook(true).catch(() => {});
    }
  }

  function bindUi() {
    document.getElementById('notebookOpenBtn')?.addEventListener('click', openDrawer);
    document.getElementById('studentNotebookCloseBtn')?.addEventListener('click', closeDrawer);
    document.getElementById('studentNotebookInsertCodeBtn')?.addEventListener('click', insertEditorCode);
    document.getElementById('studentNotebookExportBtn')?.addEventListener('click', exportPdf);
    document.getElementById('studentNotebookSearchInput')?.addEventListener('input', e => searchNotebook(e.target.value));
    document.querySelectorAll('[data-notebook-command]').forEach(btn => {
      btn.addEventListener('click', () => applyFormat(btn.dataset.notebookCommand, btn.dataset.value || null));
    });
    document.getElementById('teacherNotebookPromptBtn')?.addEventListener('click', openTeacherPromptModal);
    document.getElementById('teacherNotebookPromptCancelBtn')?.addEventListener('click', () => {
      document.getElementById('teacherNotebookPromptModal').style.display = 'none';
    });
    document.getElementById('teacherNotebookPromptSubmitBtn')?.addEventListener('click', submitTeacherPrompt);
    document.getElementById('teacherNotebookPromptModal')?.addEventListener('click', e => {
      if (e.target.id === 'teacherNotebookPromptModal') e.currentTarget.style.display = 'none';
    });
    document.getElementById('teacherNotebookRefreshBtn')?.addEventListener('click', loadTeacherNotebookPrompts);
    document.getElementById('teacherNotebookClassSelect')?.addEventListener('change', () => {
      selectedTeacherPromptId = null;
      loadTeacherNotebookPrompts();
    });
    window.addEventListener('eagle-run-state-change', updateNotebookRunButtons);
    window.addEventListener('eagle-context-updated', onAuthChanged);
    window.addEventListener('beforeunload', () => {
      if (dirty) persistActivePageFromDom();
    });
    const socket = window.eagleSocket;
    if (socket) {
      socket.on('notebook_prompt_created', msg => {
        if (drawerOpen && msg?.class_id === currentClassId()) refreshAssignmentsFromServer().catch(() => {});
      });
      socket.on('notebook_prompts_updated', msg => {
        if (drawerOpen && msg?.class_id === currentClassId()) refreshAssignmentsFromServer().catch(() => {});
      });
    } else {
      window.addEventListener('eagle-socket-ready', event => {
        event.detail?.socket?.on('notebook_prompt_created', msg => {
          if (drawerOpen && msg?.class_id === currentClassId()) refreshAssignmentsFromServer().catch(() => {});
        });
        event.detail?.socket?.on('notebook_prompts_updated', msg => {
          if (drawerOpen && msg?.class_id === currentClassId()) refreshAssignmentsFromServer().catch(() => {});
        });
      }, { once: true });
    }
  }

  window.StudentNotebook = {
    onAuthChanged,
    onTeacherDashboardOpen: loadTeacherNotebookPrompts,
    loadTeacherNotebookPrompts,
  };

  bindUi();
  updateEntryPoints();
})();
