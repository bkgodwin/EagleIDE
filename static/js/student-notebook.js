/**
 * Student notebook drawer, teacher prompts, search, PDF export, and inline code runs.
 */
(function () {
  'use strict';

  const INPUT_TOKEN = '[[_IDE_INPUT_]]';
  const ASSIGNMENTS_TAB_ID = 'assignments';
  const DEFAULT_RESPONSE_HTML = '<ul><li><br></li></ul>';
  const SAVE_DELAY_MS = 900;
  const MAX_TABS = 12;
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
        ADD_ATTR: ['data-language', 'data-file-name', 'data-code-id'],
      });
    }
    return String(html || '').replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '');
  }

  function stripHtml(html) {
    const div = document.createElement('div');
    div.innerHTML = sanitizeHtml(html);
    return div.textContent.replace(/\s+/g, ' ').trim();
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

  function ensureNotebookShape(raw) {
    const shaped = raw && typeof raw === 'object' ? raw : {};
    const tabs = Array.isArray(shaped.tabs) ? shaped.tabs : [];
    if (!tabs.some(tab => tab.id === ASSIGNMENTS_TAB_ID)) {
      tabs.push({ id: ASSIGNMENTS_TAB_ID, label: 'Assignments', locked: true, blocks: [] });
    }
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
        if (block) {
          block.responseHtml = sanitizeHtml(el.innerHTML || DEFAULT_RESPONSE_HTML);
          block.updatedAt = new Date().toISOString();
        }
      });
      return;
    }
    const editor = document.getElementById('studentNotebookEditor');
    if (editor) tab.html = sanitizeHtml(editor.innerHTML || '');
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

  function scheduleSave() {
    if (!notebook) return;
    persistActivePageFromDom();
    dirty = true;
    setStatus('Unsaved');
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveNotebook({ immediate: true }), SAVE_DELAY_MS);
  }

  function switchTab(tabId) {
    if (!notebook || notebook.activeTabId === tabId) return;
    persistActivePageFromDom();
    notebook.activeTabId = tabId;
    scheduleSave();
    renderNotebook(true);
  }

  function addTab() {
    if (!notebook) return;
    if ((notebook.tabs || []).length >= MAX_TABS) {
      alert(`Notebook limit reached (${MAX_TABS} tabs).`);
      return;
    }
    const label = prompt('Tab label:', 'New Tab');
    if (!label || !label.trim()) return;
    const id = `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const assignmentsIndex = notebook.tabs.findIndex(tab => tab.id === ASSIGNMENTS_TAB_ID);
    const insertAt = assignmentsIndex >= 0 ? assignmentsIndex : notebook.tabs.length;
    notebook.tabs.splice(insertAt, 0, {
      id,
      label: label.trim().slice(0, 32),
      locked: false,
      html: '<h2>New Notes</h2><p><br></p>',
    });
    notebook.activeTabId = id;
    scheduleSave();
    renderNotebook(true);
  }

  function renameActiveTab() {
    const tab = activeTab();
    if (!tab || tab.locked) return;
    const label = prompt('Rename tab:', tab.label || 'Notes');
    if (!label || !label.trim()) return;
    tab.label = label.trim().slice(0, 32);
    scheduleSave();
    renderNotebook();
  }

  function deleteActiveTab() {
    const tab = activeTab();
    if (!tab || tab.locked) return;
    if (!confirm(`Delete the "${tab.label}" tab?`)) return;
    notebook.tabs = notebook.tabs.filter(t => t.id !== tab.id);
    notebook.activeTabId = notebook.tabs[0]?.id || ASSIGNMENTS_TAB_ID;
    scheduleSave();
    renderNotebook(true);
  }

  function renderTabRail() {
    const rail = document.getElementById('studentNotebookTabRail');
    if (!rail || !notebook) return;
    rail.innerHTML = '';
    (notebook.tabs || []).forEach(tab => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `student-notebook-tab${tab.id === notebook.activeTabId ? ' active' : ''}${tab.locked ? ' locked' : ''}`;
      btn.textContent = tab.label || 'Tab';
      btn.title = tab.locked ? `${tab.label} (locked)` : `Open ${tab.label}`;
      btn.addEventListener('click', () => switchTab(tab.id));
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
    if (animate) {
      page.classList.remove('turning');
      requestAnimationFrame(() => page.classList.add('turning'));
    }
    if (tab.id === ASSIGNMENTS_TAB_ID) renderAssignmentsPage(page, tab);
    else renderEditablePage(page, tab);
    bindCodeBlockActions();
    highlightCodeBlocks(page);
  }

  function renderEditablePage(page, tab) {
    page.innerHTML = `
      <div class="student-notebook-tab-actions">
        <h3 class="student-notebook-tab-title">${escapeHtml(tab.label || 'Notes')}</h3>
        <button class="btn secondary" id="studentNotebookRenameTabBtn">Rename Tab</button>
        <button class="btn secondary" id="studentNotebookDeleteTabBtn">Delete Tab</button>
      </div>
      <div id="studentNotebookEditor" class="student-notebook-editor" contenteditable="true" spellcheck="true"></div>
    `;
    activeEditorEl = page.querySelector('#studentNotebookEditor');
    activeEditorEl.innerHTML = sanitizeHtml(tab.html || '<p><br></p>');
    activeEditorEl.addEventListener('input', scheduleSave);
    activeEditorEl.addEventListener('focus', () => { activeEditorEl = page.querySelector('#studentNotebookEditor'); });
    page.querySelector('#studentNotebookRenameTabBtn')?.addEventListener('click', renameActiveTab);
    page.querySelector('#studentNotebookDeleteTabBtn')?.addEventListener('click', deleteActiveTab);
  }

  function renderAssignmentsPage(page, tab) {
    const blocks = Array.isArray(tab.blocks) ? tab.blocks : [];
    page.innerHTML = `
      <div class="student-notebook-tab-actions">
        <h3 class="student-notebook-tab-title">Assignments</h3>
        <span style="color:rgba(48,40,30,.65);font-size:13px;">Teacher prompts are locked. Your response bullets are editable.</span>
      </div>
      <div class="student-notebook-assignment-list">
        ${blocks.length ? blocks.map(block => `
          <section class="student-notebook-prompt-card" data-prompt-id="${escapeHtml(block.promptId)}">
            <div class="student-notebook-prompt-meta">${escapeHtml(block.createdAt || '')}</div>
            <div class="student-notebook-prompt-text">${escapeHtml(block.prompt || '')}</div>
            <div class="student-notebook-prompt-response" contenteditable="true" spellcheck="true" data-prompt-id="${escapeHtml(block.promptId)}">${sanitizeHtml(block.responseHtml || DEFAULT_RESPONSE_HTML)}</div>
          </section>
        `).join('') : '<div class="student-notebook-empty">No teacher notebook prompts yet.</div>'}
      </div>
    `;
    page.querySelectorAll('.student-notebook-prompt-response').forEach(el => {
      el.addEventListener('input', () => {
        const block = blocks.find(b => b.promptId === el.dataset.promptId);
        if (block) {
          block.responseHtml = sanitizeHtml(el.innerHTML || DEFAULT_RESPONSE_HTML);
          block.updatedAt = new Date().toISOString();
        }
        scheduleSave();
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

  function buildCodeBlockHtml(snapshot) {
    const codeId = `code_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const language = normalizeLanguage(snapshot.language);
    const fileName = snapshot.fileName || (language === 'javascript' ? 'snippet.js' : 'snippet.py');
    return `
      <figure class="student-notebook-code-block" contenteditable="false" data-code-id="${escapeHtml(codeId)}" data-language="${escapeHtml(language)}" data-file-name="${escapeHtml(fileName)}">
        <figcaption class="student-notebook-code-head">
          <span>${escapeHtml(fileName)} · ${escapeHtml(language)}</span>
          <span class="student-notebook-code-actions">
            <button type="button" data-code-action="open">Open in Editor</button>
            <button type="button" data-code-action="run">Run Here</button>
            <button type="button" data-code-action="copy">Copy</button>
          </span>
        </figcaption>
        <pre><code class="language-${escapeHtml(highlightLanguage(language))}">${escapeHtml(snapshot.code || '')}</code></pre>
        <div class="student-notebook-inline-shell" hidden>
          <div class="notebook-shell-output"></div>
          <div class="notebook-shell-input">
            <input type="text" placeholder="Program input" autocomplete="off">
            <button type="button" data-code-action="send-input">Send</button>
            <button type="button" data-code-action="stop">Stop</button>
          </div>
        </div>
      </figure><p><br></p>
    `;
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

  function highlightCodeBlocks(root = document) {
    if (!window.hljs) return;
    root.querySelectorAll('.student-notebook-code-block code').forEach(codeEl => {
      try {
        codeEl.removeAttribute('data-highlighted');
        window.hljs.highlightElement(codeEl);
      } catch {}
    });
  }

  function getCodeBlockText(block) {
    return block.querySelector('pre code')?.textContent || '';
  }

  function ensureCodeBlockControls(block) {
    if (!block.dataset.codeId) {
      block.dataset.codeId = `code_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    }
    const language = normalizeLanguage(block.dataset.language || 'python');
    block.dataset.language = language;
    const fileName = block.dataset.fileName || (language === 'javascript' ? 'snippet.js' : 'snippet.py');
    block.dataset.fileName = fileName;
    let head = block.querySelector('.student-notebook-code-head');
    if (!head) {
      head = document.createElement('figcaption');
      head.className = 'student-notebook-code-head';
      block.insertBefore(head, block.firstChild);
    }
    if (!head.querySelector('.student-notebook-code-actions')) {
      head.innerHTML = `
        <span>${escapeHtml(fileName)} · ${escapeHtml(language)}</span>
        <span class="student-notebook-code-actions">
          <button type="button" data-code-action="open">Open in Editor</button>
          <button type="button" data-code-action="run">Run Here</button>
          <button type="button" data-code-action="copy">Copy</button>
        </span>
      `;
    }
    let shell = block.querySelector('.student-notebook-inline-shell');
    if (!shell || !shell.querySelector('input') || !shell.querySelector('[data-code-action="send-input"]')) {
      if (shell) shell.remove();
      shell = document.createElement('div');
      shell.className = 'student-notebook-inline-shell';
      shell.hidden = true;
      shell.innerHTML = `
        <div class="notebook-shell-output"></div>
        <div class="notebook-shell-input">
          <input type="text" placeholder="Program input" autocomplete="off">
          <button type="button" data-code-action="send-input">Send</button>
          <button type="button" data-code-action="stop">Stop</button>
        </div>
      `;
      block.appendChild(shell);
    }
  }

  function appendNotebookOutput(shell, text) {
    const out = shell.querySelector('.notebook-shell-output');
    if (!out) return;
    let s = String(text || '');
    if (s.includes(INPUT_TOKEN)) {
      s = s.replace(INPUT_TOKEN, '');
      waitingForNotebookInput = true;
      setTimeout(() => shell.querySelector('input')?.focus(), 0);
    }
    out.textContent += s;
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
        runBtn.disabled = disabled;
        runBtn.textContent = source === 'notebook' && runningCodeId === codeId ? 'Running...' : 'Run Here';
      }
      if (openBtn) openBtn.disabled = running;
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
      if (block.dataset.bound === '1') return;
      block.dataset.bound = '1';
      block.querySelector('[data-code-action="open"]')?.addEventListener('click', async () => {
        await ctx().setEditorSnapshot?.({
          code: getCodeBlockText(block),
          language: block.dataset.language || 'python',
          fileName: block.dataset.fileName || '',
        });
      });
      block.querySelector('[data-code-action="run"]')?.addEventListener('click', () => runCodeBlock(block));
      block.querySelector('[data-code-action="copy"]')?.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(getCodeBlockText(block));
        } catch {
          alert('Copy failed.');
        }
      });
      block.querySelector('[data-code-action="send-input"]')?.addEventListener('click', () => {
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
      block.querySelector('[data-code-action="stop"]')?.addEventListener('click', () => ctx().stopNotebookRun?.());
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
    if (overlay) overlay.hidden = false;
    loadNotebook().catch(err => console.warn(err));
  }

  async function closeDrawer() {
    if (dirty) await saveNotebook({ immediate: true });
    drawerOpen = false;
    document.getElementById('studentNotebookDrawer')?.classList.remove('open');
    document.getElementById('studentNotebookDrawer')?.setAttribute('aria-hidden', 'true');
    const overlay = document.getElementById('studentNotebookOverlay');
    if (overlay) overlay.hidden = true;
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
    const keywords = language === 'javascript'
      ? /\b(const|let|var|function|return|if|else|for|while|class|new|await|async|import|from|console|true|false|null)\b/g
      : /\b(def|return|if|elif|else|for|while|class|import|from|as|with|try|except|True|False|None|print|range|in)\b/g;
    const parts = [];
    let i = 0;
    const pattern = /("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|#.*$|\/\/.*$|\b\d+(?:\.\d+)?\b)/g;
    let match;
    while ((match = pattern.exec(line))) {
      if (match.index > i) parts.push({ text: line.slice(i, match.index), type: 'plain' });
      const token = match[0];
      parts.push({ text: token, type: token.startsWith('#') || token.startsWith('//') ? 'comment' : (/^\d/.test(token) ? 'number' : 'string') });
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
              addText(`${block.createdAt || ''} - ${block.prompt || ''}`, 11, [128, 75, 20]);
              addText(stripHtml(block.responseHtml || ''), 11);
            });
          } else {
            const holder = document.createElement('div');
            holder.innerHTML = sanitizeHtml(tab.html || '');
            holder.querySelectorAll('.student-notebook-code-block').forEach(block => {
              const marker = document.createElement('p');
              marker.textContent = `[[CODE:${block.dataset.codeId || Math.random()}]]`;
              block.replaceWith(marker);
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

  function openTeacherPromptModal() {
    if (!isTeacher()) return;
    const c = ctx();
    const classId = c.currentTeacherClassId || c.teacherClasses?.[0]?.id;
    if (!classId) return alert('Create or select a class first.');
    const cls = (c.teacherClasses || []).find(row => row.id === classId);
    const modal = document.getElementById('teacherNotebookPromptModal');
    document.getElementById('teacherNotebookPromptClassLabel').textContent = cls ? `Class: ${cls.name}` : 'Selected class';
    document.getElementById('teacherNotebookPromptInput').value = '';
    document.getElementById('teacherNotebookPromptStatus').textContent = '';
    modal.style.display = 'flex';
    setTimeout(() => document.getElementById('teacherNotebookPromptInput')?.focus(), 0);
  }

  async function submitTeacherPrompt() {
    const c = ctx();
    const classId = c.currentTeacherClassId || c.teacherClasses?.[0]?.id;
    const prompt = document.getElementById('teacherNotebookPromptInput')?.value?.trim() || '';
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
        body: JSON.stringify({ classId, prompt }),
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
          <strong>${escapeHtml(prompt.prompt)}</strong>
          <div class="meta">${escapeHtml(prompt.createdAt || '')} · ${prompt.responseCount || 0}/${prompt.studentCount || 0} responded</div>
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
      if (title) title.textContent = data.prompt?.prompt || 'Notebook responses';
      const responsesHtml = (data.responses || []).map(row => `
        <article class="teacher-notebook-response-card">
          <strong>${escapeHtml(row.studentName || row.studentEmail)}</strong>
          <div class="meta">${escapeHtml(row.studentEmail || '')}${row.updatedAt ? ` · ${escapeHtml(row.updatedAt)}` : ''}</div>
          <div class="teacher-notebook-response-body">${sanitizeHtml(row.responseHtml || '')}</div>
        </article>
      `).join('');
      const missing = data.missing || [];
      list.innerHTML = `
        ${responsesHtml || '<div style="color:#888;">No responses yet.</div>'}
        <div class="teacher-notebook-missing">
          <strong>Not responded (${missing.length})</strong>
          <div>${missing.map(s => escapeHtml(s.studentName || s.studentEmail)).join(', ') || 'Everyone has responded.'}</div>
        </div>
      `;
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
    document.getElementById('studentNotebookOverlay')?.addEventListener('click', closeDrawer);
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
        if (drawerOpen && msg?.class_id === currentClassId()) loadNotebook(true).catch(() => {});
      });
    } else {
      window.addEventListener('eagle-socket-ready', event => {
        event.detail?.socket?.on('notebook_prompt_created', msg => {
          if (drawerOpen && msg?.class_id === currentClassId()) loadNotebook(true).catch(() => {});
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
