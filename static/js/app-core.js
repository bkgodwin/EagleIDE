const INPUT_TOKEN = "[[_IDE_INPUT_]]";
    const AUTH_SESSION_KEY = 'eagle-auth-session-v1';
    let ADMIN_TOKEN = null;
    let TEACHER_TOKEN = null;
    let USER_TOKEN = null;
    let currentUser = null;   // { email, name }
    let currentTeacher = null;
    let teacherClasses = [];
    let teacherSkills = [];
    let editingSkillId = null;
    let currentTeacherClassId = null;
    let activeAssignmentsClassId = null;
    let activeStudentsByClass = {};
    let inQuizStudentsByClass = {};
    let lastSignInByClass = {};
    let teacherDashboardRosterPoll = null;
    let studentClasses = [];
    let studentClassData = null;
    let currentStudentClassId = null;
    let teacherStreamLiveClasses = {};
    let currentOpenFile = null; // { path, name } of open file in sidebar
    let registerMode = false;
    let currentConfig = null;
    let mySid = null;
    let isProgramRunning = false;
    let csvEditorActive = false;
    let csvEditorRows = [];
    let csvAutosaveTimer = null;
    let lastTeacherCodeSnapshot = '';
    let errorLineMarkers = []; // Track error line highlights
    let waitingForUserInput = false; // Track if we're waiting for user input
    let _inTraceback = false; // Track if we're currently inside a Python traceback block
    let htmlRuntimeWindow = null;
    let htmlRuntimeId = '';
    let htmlRuntimeCloseMonitor = null;
    const LANGUAGE_INFO = {
      python: { mode: 'python', label: 'Python', highlight: 'python' },
      javascript: { mode: 'javascript', label: 'JavaScript', highlight: 'javascript' },
      html: { mode: 'htmlmixed', label: 'HTML', highlight: 'xml' },
      css: { mode: 'css', label: 'CSS', highlight: 'css' }
    };

    function getLanguageInfoForFileName(fileName) {
      const lower = String(fileName || '').trim().toLowerCase();
      if (lower.endsWith('.js')) return LANGUAGE_INFO.javascript;
      if (lower.endsWith('.html') || lower.endsWith('.htm')) return LANGUAGE_INFO.html;
      if (lower.endsWith('.css')) return LANGUAGE_INFO.css;
      return LANGUAGE_INFO.python;
    }

    function getLanguageInfoForKey(key) {
      const normalized = String(key || '').trim().toLowerCase();
      if (normalized === 'javascript' || normalized === 'js') return LANGUAGE_INFO.javascript;
      if (normalized === 'html' || normalized === 'htmlmixed' || normalized === 'xml') return LANGUAGE_INFO.html;
      if (normalized === 'css') return LANGUAGE_INFO.css;
      return LANGUAGE_INFO.python;
    }

    function getManualLanguageInfo() {
      const sel = document.getElementById('languageSelector');
      const isLoggedIn = isAuthenticated();
      if (isLoggedIn) return getLanguageInfoForFileName(currentOpenFile?.name || '');
      const val = String(sel?.value || 'auto').toLowerCase();
      if (val === 'python') return LANGUAGE_INFO.python;
      if (val === 'javascript') return LANGUAGE_INFO.javascript;
      if (val === 'html') return LANGUAGE_INFO.html;
      return null;
    }

    function isAuthenticated() {
      return !!(USER_TOKEN || TEACHER_TOKEN || ADMIN_TOKEN || currentUser || currentTeacher);
    }

    function clearAuthStateMemory() {
      ADMIN_TOKEN = null;
      TEACHER_TOKEN = null;
      USER_TOKEN = null;
      currentUser = null;
      currentTeacher = null;
    }

    function normalizeExclusiveAuthRole() {
      if (USER_TOKEN) { TEACHER_TOKEN = null; ADMIN_TOKEN = null; currentTeacher = null; return; }
      if (TEACHER_TOKEN) { USER_TOKEN = null; ADMIN_TOKEN = null; currentUser = null; return; }
      if (ADMIN_TOKEN) { USER_TOKEN = null; TEACHER_TOKEN = null; currentUser = null; currentTeacher = null; }
    }

    function saveAuthSession() {
      try {
        normalizeExclusiveAuthRole();
        const payload = {
          adminToken: ADMIN_TOKEN || null,
          teacherToken: TEACHER_TOKEN || null,
          userToken: USER_TOKEN || null,
          currentUser: currentUser || null,
          currentTeacher: currentTeacher || null,
        };
        if (!payload.adminToken && !payload.teacherToken && !payload.userToken) {
          sessionStorage.removeItem(AUTH_SESSION_KEY);
          return;
        }
        sessionStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(payload));
      } catch (err) {
        console.warn('Failed to persist auth session.', err);
      }
    }

    function restoreAuthSession() {
      try {
        const raw = sessionStorage.getItem(AUTH_SESSION_KEY);
        if (!raw) return false;
        const payload = JSON.parse(raw);
        if (!payload || typeof payload !== 'object') return false;
        ADMIN_TOKEN = typeof payload.adminToken === 'string' ? payload.adminToken : null;
        TEACHER_TOKEN = typeof payload.teacherToken === 'string' ? payload.teacherToken : null;
        USER_TOKEN = typeof payload.userToken === 'string' ? payload.userToken : null;
        currentUser = payload.currentUser && typeof payload.currentUser === 'object' ? payload.currentUser : null;
        currentTeacher = payload.currentTeacher && typeof payload.currentTeacher === 'object' ? payload.currentTeacher : null;
        normalizeExclusiveAuthRole();
        return !!(ADMIN_TOKEN || TEACHER_TOKEN || USER_TOKEN);
      } catch (err) {
        console.warn('Failed to restore auth session.', err);
        return false;
      }
    }

    async function validateRestoredAuthSession() {
      try {
        if (USER_TOKEN) {
          const res = await fetch('/api/auth/me', { headers: { 'X-User-Token': USER_TOKEN } });
          const j = await res.json().catch(() => ({}));
          if (!j?.ok || (j.user?.role && j.user.role !== 'student')) {
            clearAuthStateMemory();
            saveAuthSession();
            return false;
          }
          currentUser = j.user || currentUser;
          currentTeacher = null;
          TEACHER_TOKEN = null;
          ADMIN_TOKEN = null;
          saveAuthSession();
          return true;
        }
        if (TEACHER_TOKEN) {
          const res = await fetch('/api/auth/me', { headers: { 'X-Teacher-Token': TEACHER_TOKEN } });
          const j = await res.json().catch(() => ({}));
          if (!j?.ok || j.user?.role !== 'teacher') {
            clearAuthStateMemory();
            saveAuthSession();
            return false;
          }
          currentTeacher = j.user || currentTeacher;
          currentUser = null;
          USER_TOKEN = null;
          ADMIN_TOKEN = null;
          saveAuthSession();
          return true;
        }
        if (ADMIN_TOKEN) {
          const res = await fetch('/api/admin/server-health', { headers: { 'X-Admin-Token': ADMIN_TOKEN } });
          if (!res.ok) {
            clearAuthStateMemory();
            saveAuthSession();
            return false;
          }
          currentUser = null;
          currentTeacher = null;
          USER_TOKEN = null;
          TEACHER_TOKEN = null;
          saveAuthSession();
          return true;
        }
      } catch (err) {
        console.warn('Failed to validate restored auth session.', err);
      }
      clearAuthStateMemory();
      saveAuthSession();
      return false;
    }

    function getActiveLanguageInfo() {
      const manual = getManualLanguageInfo();
      if (manual) return manual;
      const mode = String(window.eagleEditor?.getOption?.('mode') || '').toLowerCase();
      if (mode.includes('javascript')) return LANGUAGE_INFO.javascript;
      if (mode.includes('html')) return LANGUAGE_INFO.html;
      if (mode.includes('css')) return LANGUAGE_INFO.css;
      return getLanguageInfoForFileName(currentOpenFile?.name || '');
    }

    function refreshEditors() {
      try { window.eagleEditor?.refresh?.(); } catch {}
      try { teacherEditor?.refresh?.(); } catch {}
    }

    function syncEditorLanguage(fileName = currentOpenFile?.name || '') {
      const info = getManualLanguageInfo() || getLanguageInfoForFileName(fileName);
      try { window.eagleEditor?.setOption('mode', info.mode); } catch {}
      try { teacherEditor?.setOption('mode', info.mode); } catch {}
      const editorHeader = document.querySelector('#editorPanel header');
      if (editorHeader) {
        editorHeader.setAttribute('aria-label', `Code editor with ${info.label} syntax highlighting`);
      }
      return info;
    }

    function parseCsvContent(text) {
      const src = String(text || '');
      const rows = [];
      let row = [];
      let cell = '';
      let inQuotes = false;
      for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        const next = src[i + 1];
        if (ch === '"') {
          if (inQuotes && next === '"') {
            cell += '"';
            i += 1;
          } else {
            inQuotes = !inQuotes;
          }
        } else if (ch === ',' && !inQuotes) {
          row.push(cell);
          cell = '';
        } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
          if (ch === '\r' && next === '\n') i++;
          row.push(cell);
          rows.push(row);
          row = [];
          cell = '';
        } else {
          cell += ch;
        }
      }
      row.push(cell);
      // Keep one blank row for empty files, but avoid adding a redundant trailing empty row.
      if (row.length > 1 || row[0] !== '' || rows.length === 0) rows.push(row);
      return rows;
    }

    function stringifyCsvRows(rows) {
      const escapeCell = (value) => {
        const text = String(value ?? '');
        if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
        return text;
      };
      return (rows || []).map(r => (r || []).map(escapeCell).join(',')).join('\n');
    }

    function scheduleCsvAutosave() {
      if (!csvEditorActive || !currentOpenFile) return;
      if (csvAutosaveTimer) clearTimeout(csvAutosaveTimer);
      csvAutosaveTimer = setTimeout(() => { saveCurrentFile(); }, 1200);
    }

    function renderCsvEditor() {
      const wrap = document.getElementById('csvEditor');
      if (!wrap) return;
      const maxCols = Math.max(1, ...csvEditorRows.map(r => r.length), 8);
      const colName = (index) => {
        let n = index;
        let out = '';
        while (n >= 0) {
          out = String.fromCharCode(65 + (n % 26)) + out;
          n = Math.floor(n / 26) - 1;
        }
        return out;
      };
      const header = `<tr>${Array.from({ length: maxCols }, (_, i) => `<th>${colName(i)}</th>`).join('')}</tr>`;
      const bodyRows = csvEditorRows.map((row, rIdx) => (
        `<tr>${Array.from({ length: maxCols }, (_, cIdx) => `<td><input data-r="${rIdx}" data-c="${cIdx}" value="${escapeHtml((row || [])[cIdx] || '')}"></td>`).join('')}</tr>`
      )).join('');
      wrap.innerHTML = `<table><thead>${header}</thead><tbody>${bodyRows || `<tr>${Array.from({ length: maxCols }, (_, cIdx) => `<td><input data-r="0" data-c="${cIdx}" value=""></td>`).join('')}</tr>`}</tbody></table>`;
      wrap.querySelectorAll('input[data-r][data-c]').forEach(input => {
        input.addEventListener('input', (e) => {
          const r = Number(e.target.dataset.r);
          const c = Number(e.target.dataset.c);
          if (!csvEditorRows[r]) csvEditorRows[r] = [];
          csvEditorRows[r][c] = e.target.value;
          scheduleCsvAutosave();
        });
      });
    }

    function setCsvMode(enabled, content = '') {
      const csvWrap = document.getElementById('csvEditor');
      const cmWrap = document.querySelector('#editorPanel .CodeMirror');
      const ta = document.getElementById('editor');
      csvEditorActive = !!enabled;
      if (csvEditorActive) {
        csvEditorRows = parseCsvContent(content);
        renderCsvEditor();
        if (csvWrap) csvWrap.classList.remove('hidden');
        if (cmWrap) cmWrap.style.display = 'none';
        if (ta) ta.style.display = 'none';
      } else {
        if (csvWrap) {
          csvWrap.classList.add('hidden');
          csvWrap.innerHTML = '';
        }
        if (cmWrap) cmWrap.style.display = '';
        if (ta) ta.style.display = cmWrap ? 'none' : '';
        syncEditorLanguage();
      }
    }

    function buildAiContext(extra = {}) {
      const info = getActiveLanguageInfo();
      const classCtx = getCurrentClassContext();
      return {
        language: info.mode,
        fileName: currentOpenFile?.name || '',
        classId: classCtx?.id || '',
        aiRigor: classCtx?.settings?.ai_grading_rigor || 5,
        ...extra
      };
    }

    const SYSTEM_MESSAGE_PATTERN = /^\[.*?\]/;
    const TRACEBACK_START_PATTERN = /^Traceback \(most recent call last\):/;
    const TRACEBACK_EXCEPTION_LINE_PATTERN = /^\w[\w.]*(?:Error|Exception|Warning|Interrupt)[:\s]/;
    const TRACEBACK_SPECIAL_END_PATTERN = /^(KeyboardInterrupt|SystemExit|StopIteration|GeneratorExit)\s*$/;
    const STANDALONE_EXCEPTION_PATTERN = /^\w[\w.]*(?:Error|Exception|Warning|Interrupt)[:\s]/;
    const EXCEPTION_TYPE_PATTERN = /^([A-Za-z_][\w.]*(?:Error|Exception|Interrupt))(?::|\s|$)/;
    const EXCEPTION_FLASH_ANIMATION_MS = 400;
    const EXCEPTION_FLASH_ITERATIONS = 5;
    // Small buffer so class removal happens after CSS animation completion.
    const EXCEPTION_FLASH_BUFFER_MS = 200;
    const EXCEPTION_FLASH_DURATION_MS =
      (EXCEPTION_FLASH_ANIMATION_MS * EXCEPTION_FLASH_ITERATIONS) + EXCEPTION_FLASH_BUFFER_MS;
    const outputEl = document.getElementById('output');
    const stdinEl = document.getElementById('stdin');
    const exceptionHelpBtn = document.getElementById('exceptionHelpBtn');
    const exceptionHelpModal = document.getElementById('exceptionHelpModal');
    const exceptionHelpContent = document.getElementById('exceptionHelpContent');
    let exceptionHelpEntries = [];
    let exceptionHelpByName = new Map();
    let lastRunExceptionType = null;
    let lastRunExceptionEntry = null;
    let exceptionInCurrentRun = false;

    async function loadExceptionHelpEntries() {
      try {
        const res = await fetch('/api/exception-help');
        const data = await res.json();
        if (!data?.ok || !Array.isArray(data?.entries)) return;
        exceptionHelpEntries = data.entries;
        exceptionHelpByName = new Map();
        for (const entry of exceptionHelpEntries) {
          const key = String(entry?.exception || '').trim().toLowerCase();
          if (key) exceptionHelpByName.set(key, entry);
        }
      } catch (e) {
        console.warn('Failed to load exception help data:', e);
      }
    }

    function normalizeExceptionType(raw) {
      const val = String(raw || '').trim();
      if (!val) return '';
      const lastSegment = val.split('.').pop() || val;
      return lastSegment.trim();
    }

    function findExceptionHelpEntry(exceptionType) {
      const normalized = normalizeExceptionType(exceptionType);
      if (!normalized) return null;
      return (
        exceptionHelpByName.get(normalized.toLowerCase()) ||
        exceptionHelpByName.get('exception') ||
        null
      );
    }

    function detectExceptionType(line) {
      const m = String(line || '').trim().match(EXCEPTION_TYPE_PATTERN);
      return m ? normalizeExceptionType(m[1]) : null;
    }

    function markExceptionFromLine(line) {
      const exceptionType = detectExceptionType(line);
      if (!exceptionType) return;
      exceptionInCurrentRun = true;
      lastRunExceptionType = exceptionType;
      lastRunExceptionEntry = findExceptionHelpEntry(exceptionType);
    }

    function hideExceptionHelpButton() {
      if (!exceptionHelpBtn) return;
      exceptionHelpBtn.style.display = 'none';
      exceptionHelpBtn.classList.remove('flash');
    }

    function showExceptionHelpButton() {
      if (!exceptionHelpBtn) return;
      exceptionHelpBtn.style.display = 'inline-flex';
      exceptionHelpBtn.classList.remove('flash');
      void exceptionHelpBtn.offsetWidth;
      exceptionHelpBtn.classList.add('flash');
      setTimeout(() => {
        exceptionHelpBtn.classList.remove('flash');
      }, EXCEPTION_FLASH_DURATION_MS);
    }

    function openExceptionHelpModal() {
      if (!exceptionHelpModal || !exceptionHelpContent) return;
      const entry = lastRunExceptionEntry || findExceptionHelpEntry(lastRunExceptionType);
      if (!entry) {
        const missingEntryMsg = `Last exception: ${lastRunExceptionType || 'Unknown'}\n\n` +
          'No troubleshooting entry was found.\n' +
          'Please check Python documentation (https://docs.python.org/3/library/exceptions.html) ' +
          'or ask your instructor for help with this exception type.';
        exceptionHelpContent.textContent = missingEntryMsg;
      } else {
        const title = entry.exception || lastRunExceptionType || 'Exception';
        const desc = entry.description || 'No description available.';
        const tips = entry.troubleshooting || 'No troubleshooting steps available.';
        exceptionHelpContent.textContent = `Exception: ${title}\n\nDescription:\n${desc}\n\nTroubleshooting:\n${tips}`;
      }
      exceptionHelpModal.style.display = 'flex';
    }

    function closeExceptionHelpModal() {
      if (exceptionHelpModal) exceptionHelpModal.style.display = 'none';
    }

    loadExceptionHelpEntries();

    // --- File auth helpers ---
    function fileAuthHeaders() {
      if (USER_TOKEN) return { 'X-User-Token': USER_TOKEN };
      if (TEACHER_TOKEN) return { 'X-Teacher-Token': TEACHER_TOKEN };
      if (ADMIN_TOKEN) return { 'X-Admin-Token': ADMIN_TOKEN };
      return {};
    }
    function fileJsonHeaders() {
      return { 'Content-Type': 'application/json', ...fileAuthHeaders() };
    }
    function assignmentManagerHeaders() {
      if (TEACHER_TOKEN) return { 'X-Teacher-Token': TEACHER_TOKEN };
      return {};
    }

    function emitJoinClassRoom(role, token, classId) {
      if (!socket || !role || !token || !classId) return;
      socket.emit('join_class_room', { role, token, class_id: classId });
    }

    function emitLeaveClassRoom(classId) {
      if (!socket || !classId) return;
      socket.emit('leave_class_room', { class_id: classId });
    }

    function getSelectedStudentClassId() {
      const availableIds = studentClasses.map(cls => cls?.id).filter(Boolean);
      if (currentStudentClassId && availableIds.includes(currentStudentClassId)) return currentStudentClassId;
      return availableIds[0] || null;
    }

    function syncStudentClassSelection(persist = true) {
      const availableIds = studentClasses.map(cls => cls.id).filter(Boolean);
      let nextId = currentStudentClassId;
      if (!nextId || !availableIds.includes(nextId)) {
        try {
          const storedId = localStorage.getItem(STUDENT_CLASS_SELECTION_KEY);
          if (storedId && availableIds.includes(storedId)) nextId = storedId;
        } catch {}
      }
      if (!nextId || !availableIds.includes(nextId)) nextId = availableIds[0] || null;
      currentStudentClassId = nextId;
      studentClassData = studentClasses.find(cls => cls.id === currentStudentClassId) || null;
      if (currentUser) currentUser.class_id = studentClassData?.id || null;
      if (persist) {
        try {
          if (currentStudentClassId) localStorage.setItem(STUDENT_CLASS_SELECTION_KEY, currentStudentClassId);
          else localStorage.removeItem(STUDENT_CLASS_SELECTION_KEY);
        } catch {}
      }
      return studentClassData;
    }

    function updateTeacherStreamToggleState() {
      const btn = document.getElementById('teacherPaneToggleBtn');
      const activeClassId = getCurrentClassContext()?.id;
      const isLive = !!(activeClassId && teacherStreamLiveClasses[activeClassId]);
      if (btn) {
        btn.classList.toggle('live', isLive);
        const action = teacherPaneOpen ? 'Hide' : 'Show';
        btn.title = isLive ? `${action} live teacher code stream` : `${action} teacher code stream`;
      }
      const liveIndicator = document.getElementById('editorLiveIndicator');
      if (liveIndicator) liveIndicator.classList.toggle('on', !!isLive && !!teacherStreamingEnabled && !!(TEACHER_TOKEN || ADMIN_TOKEN));
    }

    function updateStreamingToggleButton() {
      const btn = document.getElementById('streamingToggleBtn');
      if (!btn) return;
      if (teacherStreamingEnabled) {
        btn.textContent = '📡 Streaming: On';
        btn.classList.remove('stop');
      } else {
        btn.textContent = '📡 Streaming: Off';
        btn.classList.add('stop');
      }
    }

    async function loadStudentClassData() {
      if (!USER_TOKEN) {
        studentClasses = [];
        studentClassData = null;
        currentStudentClassId = null;
        return null;
      }
      try {
        const res = await fetch('/api/classes/current', { headers: { 'X-User-Token': USER_TOKEN } });
        const j = await res.json().catch(() => ({}));
        studentClasses = Array.isArray(j?.classList) ? j.classList : [];
        currentStudentClassId = j?.classData?.id || currentStudentClassId;
        syncStudentClassSelection(false);
        studentClasses.forEach(cls => {
          if (cls?.id) emitJoinClassRoom('student', USER_TOKEN, cls.id);
        });
      } catch {
        studentClasses = [];
        studentClassData = null;
        currentStudentClassId = null;
      }
      return studentClassData;
    }

    async function loadTeacherClasses() {
      if (!TEACHER_TOKEN) { teacherClasses = []; currentTeacherClassId = null; activeAssignmentsClassId = null; return []; }
      try {
        const res = await fetch('/api/teacher/classes', { headers: { 'X-Teacher-Token': TEACHER_TOKEN } });
        const j = await res.json().catch(() => ({}));
        teacherClasses = j?.classes || [];
        if (!currentTeacherClassId || !teacherClasses.some(c => c.id === currentTeacherClassId)) {
          currentTeacherClassId = teacherClasses[0]?.id || null;
        }
        if (!activeAssignmentsClassId || !teacherClasses.some(c => c.id === activeAssignmentsClassId)) {
          activeAssignmentsClassId = currentTeacherClassId;
        }
      } catch {
        teacherClasses = [];
      }
      return teacherClasses;
    }

    async function loadTeacherSkills() {
      if (!TEACHER_TOKEN) { teacherSkills = []; editingSkillId = null; return []; }
      try {
        const res = await fetch('/api/teacher/skills', { headers: { 'X-Teacher-Token': TEACHER_TOKEN } });
        const j = await res.json().catch(() => ({}));
        teacherSkills = j?.skills || [];
      } catch {
        teacherSkills = [];
      }
      return teacherSkills;
    }

    function getCurrentClassContext() {
      if (TEACHER_TOKEN) return teacherClasses.find(c => c.id === currentTeacherClassId) || null;
      return studentClasses.find(c => c.id === getSelectedStudentClassId()) || studentClassData || null;
    }

    function updateTeacherStreamPaneVisibility() {
      const classCtx = getCurrentClassContext();
      const isStudentInClass = !!USER_TOKEN && !TEACHER_TOKEN && !ADMIN_TOKEN && !!classCtx;
      setTeacherPaneEnabled(isStudentInClass);
      updateTeacherStreamToggleState();
      if (isStudentInClass) syncEditorLanguage(currentOpenFile?.name || '');
    }

    function applyClassTabVisibility() {
      const classCtx = getCurrentClassContext();
      const isAuthenticatedUser = !!(USER_TOKEN || TEACHER_TOKEN || ADMIN_TOKEN);
      const isGuest = !isAuthenticatedUser;
      const isStudentNoClass = !!USER_TOKEN && !!currentUser && !classCtx;
      const aiEnabledForClass = !!classCtx?.settings?.ai_enabled;
      const wikiEnabledForClass = !!classCtx?.settings?.wiki_enabled;
      const tExplain = document.getElementById('aiTabBtn');
      const tChal = document.getElementById('aiChallengeTabBtn');
      const tAssist = document.getElementById('assistantTabBtn');
      const tWiki = document.getElementById('lessonTabBtn');
      const tAssignment = document.getElementById('assignmentTabBtn');
      const aiMasterEnabled = !!currentConfig?.ai_explainer_enabled;
      const effectiveAiEnabled = aiMasterEnabled && (ADMIN_TOKEN || aiEnabledForClass);
      const shouldHideAiTabs = isGuest;
      const canViewWikiContent = !!(ADMIN_TOKEN || TEACHER_TOKEN || wikiEnabledForClass);
      const hasGlobalWikiContent = !!(String(currentConfig?.lesson_html || '').trim() || String(currentConfig?.lesson_url || '').trim());
      const canShowWikiTab = isAuthenticatedUser && (
        ADMIN_TOKEN ||
        TEACHER_TOKEN ||
        (classCtx ? wikiEnabledForClass : hasGlobalWikiContent)
      );
      const canSeeAssignments = !!TEACHER_TOKEN || (!!USER_TOKEN && !!classCtx);
      if (tAssignment) tAssignment.style.display = canSeeAssignments ? '' : 'none';
      if (tExplain) tExplain.style.display = (!shouldHideAiTabs && effectiveAiEnabled) ? '' : 'none';
      if (tChal) tChal.style.display = (!shouldHideAiTabs && effectiveAiEnabled) ? '' : 'none';
      if (tAssist) tAssist.style.display = (!shouldHideAiTabs && effectiveAiEnabled) ? '' : 'none';
      if (tWiki) tWiki.style.display = canShowWikiTab ? '' : 'none';
      const classJoinNotice = document.getElementById('classJoinNotice');
      if (classJoinNotice) classJoinNotice.style.display = isStudentNoClass ? '' : 'none';
      const lessonLocal = document.getElementById('lessonLocal');
      const lessonFrame = document.getElementById('lessonFrame');
      if (classCtx?.settings?.wiki_html && canViewWikiContent) {
        lessonLocal.innerHTML = classCtx.settings.wiki_html;
        lessonLocal.style.display = 'block';
        lessonFrame.style.display = 'none';
      } else if (classCtx?.settings?.wiki_url && canViewWikiContent) {
        lessonLocal.style.display = 'none';
        lessonFrame.style.display = 'block';
        lessonFrame.src = classCtx.settings.wiki_url;
      } else if (currentConfig?.lesson_use_local) {
        lessonFrame.style.display = 'none';
        lessonLocal.style.display = 'block';
        lessonLocal.innerHTML = currentConfig?.lesson_html || '<p>(No local lesson content yet)</p>';
      } else {
        lessonLocal.style.display = 'none';
        lessonFrame.style.display = 'block';
        lessonFrame.src = currentConfig?.lesson_url || '';
      }
      const hiddenActiveTab = [...document.querySelectorAll('.tab-btn.active')].find(btn => getComputedStyle(btn).display === 'none');
      if (hiddenActiveTab) document.getElementById('notesTabBtn')?.click();
      updateTeacherStreamPaneVisibility();
    }

    const CLASS_SELECTOR_ADD_OPTION_VALUE = '__add_class__';

    function renderClassSelector() {
      const wrap = document.getElementById('classSelectorWrap');
      const select = document.getElementById('classSelector');
      const classCtx = getCurrentClassContext();
      if (TEACHER_TOKEN && teacherClasses.length) {
        wrap.style.display = 'inline-flex';
        wrap.style.alignItems = 'stretch';
        select.innerHTML = teacherClasses.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)} (${escapeHtml(c.join_code)})</option>`).join('');
        select.value = currentTeacherClassId || teacherClasses[0].id;
      } else if (studentClasses.length) {
        wrap.style.display = 'inline-flex';
        wrap.style.alignItems = 'stretch';
        select.innerHTML = [
          ...studentClasses.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`),
          `<option value="${CLASS_SELECTOR_ADD_OPTION_VALUE}">+ Add Class</option>`
        ].join('');
        select.value = getSelectedStudentClassId() || studentClasses[0].id;
      } else {
        wrap.style.display = 'none';
        select.innerHTML = '';
      }
      if (TEACHER_TOKEN && classCtx?.id) emitJoinClassRoom('teacher', TEACHER_TOKEN, classCtx.id);
      applyClassTabVisibility();
      updateTeacherStreamToggleState();
    }

    // Append a single line (no embedded newlines) to the shell output with correct coloring.
    function _appendLine(line) {
      if (!line) return; // skip null, undefined, and empty string
      // System messages: [Connected], [Process started], etc.
      if (SYSTEM_MESSAGE_PATTERN.test(line)) {
        const span = document.createElement('span');
        span.className = 'sys-msg';
        span.textContent = line;
        outputEl.appendChild(span);
        return;
      }
      // Start of a Python traceback
      if (TRACEBACK_START_PATTERN.test(line)) {
        _inTraceback = true;
        const span = document.createElement('span');
        span.className = 'shell-error';
        span.textContent = line;
        outputEl.appendChild(span);
        return;
      }
      // Lines that are part of an active traceback
      if (_inTraceback) {
        const span = document.createElement('span');
        span.className = 'shell-error';
        span.textContent = line;
        outputEl.appendChild(span);
        // The exception type line ends the traceback (e.g. "NameError: name 'x' is not defined")
        if (TRACEBACK_EXCEPTION_LINE_PATTERN.test(line) || TRACEBACK_SPECIAL_END_PATTERN.test(line)) {
          markExceptionFromLine(line);
          _inTraceback = false;
        }
        // Highlight error line numbers (from "File ..., line N" lines)
        const lineMatch = line.match(/^\s+File ".*?", line (\d+)/);
        if (lineMatch && window.eagleEditor) {
          const lineNum = parseInt(lineMatch[1]) - 1;
          highlightErrorLine(lineNum);
        }
        return;
      }
      // Standalone exception line outside a traceback (bare exception without Traceback header)
      if (STANDALONE_EXCEPTION_PATTERN.test(line)) {
        markExceptionFromLine(line);
        const span = document.createElement('span');
        span.className = 'shell-error';
        span.textContent = line;
        outputEl.appendChild(span);
        return;
      }
      // Normal output
      outputEl.appendChild(document.createTextNode(line));
    }

    // Append a (possibly multi-line) string to the shell output with correct per-line coloring.
    const appendOut = (s) => {
      if (!s) return;
      // Split into lines while preserving newlines at end of each segment
      const segments = s.split(/(?<=\n)/);
      for (const seg of segments) {
        _appendLine(seg);
      }
      outputEl.scrollTop = outputEl.scrollHeight;
    };

    function highlightErrorLine(lineNum) {
      if (!window.eagleEditor) return;
      const cm = window.eagleEditor;
      const line = cm.getLine(lineNum);
      if (!line) return;
      
      const marker = cm.markText(
        { line: lineNum, ch: 0 },
        { line: lineNum, ch: line.length },
        { className: 'cm-error-line' }
      );
      errorLineMarkers.push(marker);
      
      // Show the clear button
      document.getElementById('clearErrorsBtn').style.display = '';
    }

    function clearErrorHighlights() {
      errorLineMarkers.forEach(marker => marker.clear());
      errorLineMarkers = [];
      document.getElementById('clearErrorsBtn').style.display = 'none';
    }

    // Shell toggle button - moved before Socket.IO to ensure it always works
    (function() {
      const btn = document.getElementById('toggleShellBtn');
      const SHELL_TOGGLE_KEY = 'eagleide-shell-hidden';
      
      // Restore saved toggle state on page load
      try {
        const savedState = localStorage.getItem(SHELL_TOGGLE_KEY);
        if (savedState === '1') {
          document.body.classList.add('shell-hidden');
          btn.textContent = 'Show Shell ▲';
        }
      } catch (e) {
        console.warn('Failed to restore shell toggle state:', e);
      }
      
      // Handle toggle button clicks
      btn.addEventListener('click', () => {
        const isHidden = document.body.classList.toggle('shell-hidden');
        btn.textContent = isHidden ? 'Show Shell ▲' : 'Hide Shell ▼';
        
        // Save state to localStorage
        try {
          localStorage.setItem(SHELL_TOGGLE_KEY, isHidden ? '1' : '0');
        } catch (e) {
          console.warn('Failed to save shell toggle state:', e);
        }
      });
    })();

    // Initialize Socket.IO only if available
    let socket = null;
    if (typeof io !== 'undefined') {
      try {
        socket = io({ transports: ["websocket", "polling"], timeout: 20000 });
        socket.on('connected', (m) => {
          mySid = m?.sid || null;
          window.mySid = mySid;
          appendOut('[Connected]\n');
        });
        socket.on('connect_error', err => appendOut('[Socket error] ' + (err?.message || err) + '\n'));
        socket.on('run_ack', () => appendOut('[Run acknowledged]\n'));
        socket.on('output', msg => {
          let s = msg.data || '';
          if (!s) return;
          if (s.includes(INPUT_TOKEN)) {
            // Split on INPUT_TOKEN to handle any output that preceded the prompt in the same batch
            const tokenIdx = s.indexOf(INPUT_TOKEN);
            const before = s.substring(0, tokenIdx);
            // Display all text before the INPUT_TOKEN (prior output + prompt) through appendOut
            // The prompt itself is the last line of `before` (no trailing newline)
            if (before) {
              const lastNl = before.lastIndexOf('\n');
              if (lastNl >= 0) {
                // Output lines before the prompt
                appendOut(before.substring(0, lastNl + 1));
                // Prompt text (no newline — stays on same line as future input)
                const prompt = before.substring(lastNl + 1);
                if (prompt) outputEl.appendChild(document.createTextNode(prompt));
              } else {
                // Entire `before` is the prompt with no preceding newline
                outputEl.appendChild(document.createTextNode(before));
              }
            }
            waitingForUserInput = true;
            try {
              stdinEl.focus();
              stdinEl.select();
            } catch (e) {
              console.warn('Failed to focus stdin:', e);
            }
          } else if (waitingForUserInput && !s.startsWith('[')) {
            // The first line is the echoed user input; any lines after that are regular output
            const nlIdx = s.indexOf('\n');
            const echoLine = nlIdx >= 0 ? s.substring(0, nlIdx) : s.replace(/\n$/, '');
            const remainder = nlIdx >= 0 ? s.substring(nlIdx + 1) : '';
            // Display echo in green
            const userSpan = document.createElement('span');
            userSpan.className = 'shell-user-input';
            userSpan.textContent = echoLine;
            outputEl.appendChild(userSpan);
            outputEl.appendChild(document.createTextNode('\n'));
            waitingForUserInput = false;
            // Process any remaining output after the echo normally
            if (remainder) appendOut(remainder);
            outputEl.scrollTop = outputEl.scrollHeight;
          } else {
            appendOut(s);
          }
        });
        socket.on('finished', () => {
          _inTraceback = false; // Reset traceback state when process finishes
          waitingForUserInput = false;
          setRunButtonState(false);
          if (exceptionInCurrentRun) {
            showExceptionHelpButton();
          } else {
            hideExceptionHelpButton();
          }
          appendOut('[Process finished]\n');
          // Refresh file browser so files created by the program appear immediately
          if (USER_TOKEN || TEACHER_TOKEN || ADMIN_TOKEN) loadFileTree();
        });
        
        // Listen for teacher code updates
        socket.on('teacher_code', (msg) => {
          const selectedClassId = getCurrentClassContext()?.id;
          if (msg && typeof msg.code === 'string' && msg.class_id && msg.class_id === selectedClassId) {
            if (lastTeacherCodeSnapshot === msg.code) return;
            if (USER_TOKEN && !TEACHER_TOKEN && !ADMIN_TOKEN && teacherPaneOpen && !document.hidden) {
              initTeacherViewer();
              const modeInfo = getLanguageInfoForKey(msg.language);
              try { teacherEditor?.setOption('mode', modeInfo.mode); } catch {}
              if (teacherEditor) teacherEditor.setValue(msg.code);
              const ta = document.getElementById('teacherStreamEditor');
              if (ta && !teacherEditor) ta.value = msg.code;
            }
            lastTeacherCodeSnapshot = msg.code;
            // Save to localStorage
            try {
              localStorage.setItem(TEACHER_CODE_KEY, msg.code);
            } catch (e) {
              console.warn('Failed to save teacher code:', e);
            }
          }
        });
        socket.on('teacher_stream_status', (msg) => {
          if (!msg?.class_id) return;
          teacherStreamLiveClasses[msg.class_id] = !!msg.active;
          const selectedClassId = getCurrentClassContext()?.id;
          if (selectedClassId === msg.class_id) {
            updateTeacherStreamToggleState();
          }
        });
        socket.on('class_membership_revoked', async (msg) => {
          if (!USER_TOKEN || !currentUser) return;
          const previousClasses = [...studentClasses];
          const removedClass = previousClasses.find(cls => cls?.id === msg?.class_id);
          const refreshed = await loadStudentClassData().then(() => true).catch(() => false);
          if (!refreshed) {
            alert('Your class access may have changed. Please refresh and sign in again if needed.');
          } else if (removedClass) {
            alert(studentClasses.length
              ? `You were removed from ${removedClass.name}.`
              : `You were removed from ${removedClass.name}. You no longer have access to any classes.`);
          } else {
            alert('Your class access was updated by your teacher.');
          }
          renderClassSelector();
          updateAuthUI();
          await loadAssignments();
        });
      } catch (e) {
        console.error('Socket.IO initialization failed:', e);
        appendOut('[Socket.IO unavailable - IDE functionality limited]\n');
      }
    } else {
      appendOut('[Socket.IO library not loaded - IDE functionality limited]\n');
    }

    document.getElementById('classSelector')?.addEventListener('change', (e) => {
      const nextId = e.target.value;
      if (TEACHER_TOKEN) {
        if (currentTeacherClassId && currentTeacherClassId !== nextId) emitLeaveClassRoom(currentTeacherClassId);
        if (teacherStreamingEnabled && currentTeacherClassId && currentTeacherClassId !== nextId && socket) {
          socket.emit('teacher_stream_status', {
            token: ADMIN_TOKEN || TEACHER_TOKEN,
            role: ADMIN_TOKEN ? 'admin' : 'teacher',
            class_id: currentTeacherClassId,
            active: false
          });
        }
        currentTeacherClassId = nextId || null;
        activeAssignmentsClassId = currentTeacherClassId;
        syncTeacherDashboardClassSelectors();
        if (currentTeacherClassId) emitJoinClassRoom('teacher', TEACHER_TOKEN, currentTeacherClassId);
        if (teacherStreamingEnabled && currentTeacherClassId && socket) {
          socket.emit('teacher_stream_status', {
            token: ADMIN_TOKEN || TEACHER_TOKEN,
            role: ADMIN_TOKEN ? 'admin' : 'teacher',
            class_id: currentTeacherClassId,
            active: true
          });
        }
        if (teacherStreamingEnabled && !teacherBroadcastActive && currentTeacherClassId) startTeacherBroadcast();
        if (teacherStreamingEnabled) scheduleTeacherBroadcastFlush(true);
        refreshActiveStudentsForClass(currentTeacherClassId);
        renderTeacherClassManagement();
        renderClassReports().catch(() => {});
      } else if (USER_TOKEN) {
        if (nextId === CLASS_SELECTOR_ADD_OPTION_VALUE) {
          document.getElementById('assignmentTabBtn')?.click();
          const input = document.getElementById('joinClassCodeInput');
          if (input) {
            input.focus();
            input.select();
          }
          renderClassSelector();
          return;
        }
        currentStudentClassId = nextId || null;
        syncStudentClassSelection();
        updateTeacherStreamPaneVisibility();
      }
      applyClassTabVisibility();
      loadAssignments();
    });

    function isHtmlRuntimeFile(name) {
      const lower = String(name || '').trim().toLowerCase();
      return lower.endsWith('.html') || lower.endsWith('.htm');
    }

    async function cleanupHtmlRuntimeSession(runtimeId = htmlRuntimeId) {
      const rid = String(runtimeId || '').trim();
      if (!rid) return;
      try {
        await fetch('/api/html-runtime/cleanup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runtime_id: rid })
        });
      } catch {}
      if (rid === htmlRuntimeId) htmlRuntimeId = '';
    }

    function closeHtmlRuntimeWindow() {
      if (htmlRuntimeCloseMonitor) {
        clearInterval(htmlRuntimeCloseMonitor);
        htmlRuntimeCloseMonitor = null;
      }
      try {
        if (htmlRuntimeWindow && !htmlRuntimeWindow.closed) {
          htmlRuntimeWindow.close();
        }
      } catch {}
      htmlRuntimeWindow = null;
      cleanupHtmlRuntimeSession();
    }

    function setRunButtonState(running) {
      isProgramRunning = !!running;
      const runBtn = document.getElementById('runBtn');
      if (!runBtn) return;
      runBtn.textContent = isProgramRunning ? 'Stop ⏹' : 'Run ▶';
      runBtn.classList.toggle('stop', isProgramRunning);
      runBtn.classList.toggle('run', !isProgramRunning);
      runBtn.title = isProgramRunning ? 'Stop current program' : 'Run current program';
    }

    function stopCurrentRun() {
      closeHtmlRuntimeWindow();
      if (socket) socket.emit('stop', {});
      setRunButtonState(false);
    }

    function openHtmlRuntimePopup(runtimeData) {
      if (!runtimeData?.runtime_id || !runtimeData?.view_url) {
        appendOut('[HTML Runtime] Invalid runtime response\n');
        setRunButtonState(false);
        return;
      }

      closeHtmlRuntimeWindow();
      htmlRuntimeId = runtimeData.runtime_id;
      const popup = window.open('', `eagle-html-runtime-${runtimeData.runtime_id}`, 'popup=yes,width=1100,height=760');
      if (!popup) {
        appendOut('[HTML Runtime] Popup blocked by browser.\n');
        cleanupHtmlRuntimeSession(runtimeData.runtime_id);
        setRunButtonState(false);
        return;
      }
      htmlRuntimeWindow = popup;
      if (htmlRuntimeCloseMonitor) clearInterval(htmlRuntimeCloseMonitor);
      htmlRuntimeCloseMonitor = setInterval(() => {
        if (!htmlRuntimeWindow || htmlRuntimeWindow.closed) {
          clearInterval(htmlRuntimeCloseMonitor);
          htmlRuntimeCloseMonitor = null;
          htmlRuntimeWindow = null;
          cleanupHtmlRuntimeSession();
          setRunButtonState(false);
        }
      }, 400);

      const timeoutSeconds = Number(runtimeData.timeout_seconds || 30);
      const allowPopups = !!runtimeData.allow_popups;
      const title = `HTML WebView • ${currentOpenFile?.name || 'index.html'}`;
      const iframeSandbox = ['allow-scripts', 'allow-same-origin'];
      if (allowPopups) iframeSandbox.push('allow-popups');
      const popupDoc = popup.document;
      popupDoc.open();
      popupDoc.write(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${title.replace(/</g, '&lt;')}</title>
  <style>
    body{margin:0;font-family:Inter,Arial,sans-serif;background:#121212;color:#eaeaea;display:flex;flex-direction:column;height:100vh}
    .hdr{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:#1f1f1f;border-bottom:1px solid #333}
    .hdr strong{font-size:14px}
    .hdr button{border:0;border-radius:8px;padding:6px 10px;background:#c62828;color:#fff;cursor:pointer;font-weight:700}
    .runtime-msg{font-size:12px;opacity:.85}
    #runtimeFrame{flex:1;width:100%;border:0;background:#fff}
  </style>
  <link rel="stylesheet" href="/static/css/main.css">
</head>
<body>
  <div class="hdr">
    <div><strong>${title.replace(/</g, '&lt;')}</strong><div class="runtime-msg" id="runtimeMsg">Running...</div></div>
    <button id="runtimeExitBtn">Exit ✕</button>
  </div>
  <iframe id="runtimeFrame" sandbox="${iframeSandbox.join(' ')}" src="${runtimeData.view_url}"></iframe>
  <script>
    const runtimeId = ${JSON.stringify(runtimeData.runtime_id)};
    const timeoutMs = ${Math.max(1000, Math.floor(timeoutSeconds * 1000))};
    let stopped = false;
    const frame = document.getElementById('runtimeFrame');
    const msgEl = document.getElementById('runtimeMsg');
    const sendToOpener = (payload) => { try { window.opener && window.opener.postMessage(payload, '*'); } catch {} };
    const setMsg = (text) => { if (msgEl) msgEl.textContent = text; };
    const cleanupRuntime = () => {
      try {
        navigator.sendBeacon('/api/html-runtime/cleanup', new Blob([JSON.stringify({ runtime_id: runtimeId })], { type: 'application/json' }));
      } catch {
        fetch('/api/html-runtime/cleanup', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ runtime_id: runtimeId }) }).catch(() => {});
      }
    };
    const terminate = (reason) => {
      if (stopped) return;
      stopped = true;
      frame.src = 'about:blank';
      setMsg(reason || 'Execution stopped.');
      sendToOpener({ type:'eagle-html-runtime-log', level:'warn', message: reason || 'Execution stopped.' });
    };
    document.getElementById('runtimeExitBtn').addEventListener('click', () => window.close());
    window.addEventListener('beforeunload', cleanupRuntime);
    const timeoutHandle = setTimeout(() => terminate('Execution time limit reached.'), timeoutMs);
    window.addEventListener('message', (event) => {
      const data = event.data || {};
      if (!data.__eagleHtmlRuntime) return;
      if (data.type === 'limit') {
        terminate('Execution time limit reached.');
      } else if (data.type === 'error') {
        const details = data.message || 'JavaScript runtime error';
        sendToOpener({ type:'eagle-html-runtime-log', level:'error', message: details });
      } else if (data.type === 'console' && data.level === 'error') {
        sendToOpener({ type:'eagle-html-runtime-log', level:'error', message: data.message || 'console.error' });
      } else if (data.type === 'status') {
        sendToOpener({ type:'eagle-html-runtime-log', level:'warn', message: data.message || 'Runtime status' });
      }
    });
    frame.addEventListener('load', () => {
      if (!stopped) setMsg('Running...');
    });
    frame.addEventListener('error', () => terminate('Execution stopped due to iframe load error.'));
    window.addEventListener('unload', () => clearTimeout(timeoutHandle));
  <\/script>

  <nav class="tablet-panel-nav" id="tabletPanelNav" aria-label="Panel switcher">
    <button type="button" data-panel="editor" class="active">Editor</button>
    <button type="button" data-panel="shell">Shell</button>
    <button type="button" data-panel="resources">Resources</button>
  </nav>
  <div class="action-sheet" id="fileActionSheet" aria-hidden="true">
    <div class="action-sheet-panel glass-surface" id="fileActionSheetPanel"></div>
  </div>

  </div><!-- .app-shell -->
</body>
</html>`);
      popupDoc.close();
      appendOut('[HTML Runtime] WebView opened.\n');
    }

    window.addEventListener('message', (event) => {
      const payload = event.data || {};
      if (payload.type !== 'eagle-html-runtime-log') return;
      const lvl = String(payload.level || 'info').toUpperCase();
      const msg = String(payload.message || '').trim();
      if (!msg) return;
      appendOut(`[HTML ${lvl}] ${msg}\n`);
    });

    document.getElementById('runBtn').addEventListener('click', async () => {
      if (isProgramRunning) {
        stopCurrentRun();
        return;
      }
      // Auto-expand sidebar to show output
      const collapsed = document.body.classList.contains('right-collapsed');
      if (collapsed) {
        document.getElementById('rightEdgeToggleBtn')?.click();
      }
      // Auto-show shell if hidden
      const shellHidden = document.body.classList.contains('shell-hidden');
      if (shellHidden) {
        document.getElementById('toggleShellBtn').click();
      }
      outputEl.textContent = '';
      clearErrorHighlights();
      _inTraceback = false;      // reset traceback coloring state for new run
      waitingForUserInput = false;
      exceptionInCurrentRun = false;
      lastRunExceptionType = null;
      lastRunExceptionEntry = null;
      hideExceptionHelpButton();
      closeExceptionHelpModal();
      // Save current file before running
      if (currentOpenFile && (USER_TOKEN || TEACHER_TOKEN || ADMIN_TOKEN)) {
        try {
          await saveCurrentFile();
        } catch (err) {
          appendOut(`[Warning: could not save "${currentOpenFile.name}" before running: ${err}]\n`);
        }
      }
      if (csvEditorActive) {
        appendOut('[Run skipped: CSV files use spreadsheet editing only.]\n');
        return;
      }
      if (isHtmlRuntimeFile(currentOpenFile?.name || '')) {
        if (!currentOpenFile?.path) {
          appendOut('[HTML Runtime] Open an HTML file first.\n');
          return;
        }
        try {
          const res = await fetch('/api/html-runtime/start', {
            method: 'POST',
            headers: fileJsonHeaders(),
            body: JSON.stringify({ file_path: currentOpenFile.path })
          });
          const j = await res.json().catch(() => ({}));
          if (!j?.ok) {
            appendOut(`[HTML Runtime Error] ${j?.error || 'Failed to start HTML runtime'}\n`);
            return;
          }
          setRunButtonState(true);
          openHtmlRuntimePopup(j);
        } catch (err) {
          appendOut('[HTML Runtime Error] Network error while starting HTML runtime.\n');
          setRunButtonState(false);
        }
        return;
      }
      appendOut('[Sending code]\n');
      setRunButtonState(true);
      if (socket) {
        socket.emit('run_code', {
          code: editor.getValue(),
          language: getActiveLanguageInfo().mode,
          user_token: USER_TOKEN || '',
          teacher_token: TEACHER_TOKEN || '',
          admin_token: ADMIN_TOKEN || '',
          file_path: currentOpenFile ? currentOpenFile.path : ''
        });
      } else {
        appendOut('[Error: Cannot run code - Socket.IO not available]\n');
        setRunButtonState(false);
      }
    });
    exceptionHelpBtn?.addEventListener('click', async () => {
      if (!exceptionHelpByName.size) {
        await loadExceptionHelpEntries();
        if (lastRunExceptionType) {
          lastRunExceptionEntry = findExceptionHelpEntry(lastRunExceptionType);
        }
      }
      openExceptionHelpModal();
    });
    document.getElementById('exceptionHelpCloseBtn')?.addEventListener('click', closeExceptionHelpModal);
    exceptionHelpModal?.addEventListener('click', (e) => {
      if (e.target === exceptionHelpModal) closeExceptionHelpModal();
    });
    setRunButtonState(false);
    function sendInput(){ 
      const v = stdinEl.value ?? ""; 
      if (socket) {
        socket.emit('send_input', { data: v }); 
      }
      // DON'T display the input here - let the backend echo it back
      // This ensures proper ordering with the prompt
      stdinEl.value=''; 
    }
    document.getElementById('sendBtn').addEventListener('click', sendInput);
    stdinEl.addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); sendInput(); } });

    // Clear error highlights button
    document.getElementById('clearErrorsBtn').addEventListener('click', () => {
      clearErrorHighlights();
    });

    // ---- Theme toggle (light / dark mode) ----
    (function(){
      const THEME_KEY = 'ide-theme';
      const btn = document.getElementById('themeToggleBtn');
      let isLight = false;
      try { isLight = localStorage.getItem(THEME_KEY) === 'light'; } catch {}

      function applyTheme() {
        if (isLight) {
          document.body.classList.add('light-mode');
          document.documentElement.style.setProperty('--theme-bg-image', 'url(/api/background)');
          btn.textContent = '☀️';
        } else {
          document.body.classList.remove('light-mode');
          document.documentElement.style.setProperty('--theme-bg-image', 'url(/api/background_dark)');
          btn.textContent = '🌙';
        }
        // Clear any inline backgroundImage so the CSS variable takes effect
        document.body.style.backgroundImage = '';
        // Switch CodeMirror theme to match light/dark mode
        const cmTheme = isLight ? 'default' : 'monokai';
        try {
          document.querySelectorAll('.CodeMirror').forEach(w => {
            if (w.CodeMirror) { w.CodeMirror.setOption('theme', cmTheme); w.CodeMirror.refresh(); }
          });
        } catch {}
        try { localStorage.setItem(THEME_KEY, isLight ? 'light' : 'dark'); } catch {}
      }

      applyTheme();
      btn.addEventListener('click', () => { isLight = !isLight; applyTheme(); });
    })();

    // Tabs switching (refresh leaderboard when opening Challenge)
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        btn.classList.add('active'); document.getElementById(btn.dataset.tab).classList.add('active');
        if (btn.dataset.tab === 'aiChallengeTab') refreshLeaderboard();
        if (btn.dataset.tab === 'assignmentTab') loadAssignments();
      });
    });

    async function loadConfig(){
      const notesView = document.getElementById('notesView');
      if (notesView && !notesView.innerHTML.trim()) {
        notesView.innerHTML = '<div class="skeleton" style="height:80px;margin:12px;"></div>';
      }
      const res = await fetch('/api/config'); const j = await res.json().catch(()=>({}));
      if (j?.ok) { currentConfig = j.data; applyConfig(currentConfig); }
    }

    function renderHomeContent(htmlContent) {
      const view = document.getElementById('notesView');
      if (!view) return;
      if (window.DOMPurify) {
        view.innerHTML = DOMPurify.sanitize(htmlContent || '');
      } else {
        view.innerHTML = htmlContent || '';
      }
    }

    function applyConfig(cfg){
      if (!cfg) return;
      renderHomeContent(cfg.notes_html || '');

      // Apply page title and top bar color
      if (cfg.page_title) {
        document.title = cfg.page_title;
        document.querySelector('.topbar .brand div:first-child').textContent = cfg.page_title.split('(')[0].trim();
      }
      if (cfg.topbar_color) {
        document.documentElement.style.setProperty('--theme-topbar', cfg.topbar_color);
      }

      const iframe = document.getElementById('lessonFrame');
      const localDiv = document.getElementById('lessonLocal');
      const urlIn = document.getElementById('lessonUrlInput');
      const useLocal = document.getElementById('lessonUseLocal');
      if (urlIn) urlIn.value = cfg.lesson_url || '';
      if (useLocal) useLocal.checked = !!cfg.lesson_use_local;
      if (cfg.lesson_use_local){
        iframe.style.display = 'none'; localDiv.style.display = 'block';
        localDiv.innerHTML = cfg.lesson_html || '<p>(No local lesson content yet)</p>';
      } else {
        localDiv.style.display = 'none'; iframe.style.display = 'block'; iframe.src = cfg.lesson_url || '';
      }

      const enabled = !!cfg.ai_explainer_enabled;
      const tExplain = document.getElementById('aiTabBtn');
      const tChal = document.getElementById('aiChallengeTabBtn');
      const tAssist = document.getElementById('assistantTabBtn');
      if (tExplain) tExplain.style.display = enabled ? '' : 'none';
      if (tChal) tChal.style.display = enabled ? '' : 'none';
      if (tAssist) tAssist.style.display = enabled ? '' : 'none';

      const aiEnabledBox = document.getElementById('aiEnabled');
      if (aiEnabledBox) aiEnabledBox.checked = enabled;
      const u = document.getElementById('aiUrlInput'); if (u) u.value = cfg.ai_ollama_url || '';
      const m = document.getElementById('aiModelInput'); if (m) m.value = cfg.ai_model || 'gemma3:4b';
      const ap = document.getElementById('assistantPromptInput'); if (ap) ap.value = cfg.ai_assistant_preprompt || '';
      applyClassTabVisibility();
    }
    async function saveConfig(partial){
      const headers = {'Content-Type':'application/json'};
      if (ADMIN_TOKEN) headers['X-Admin-Token'] = ADMIN_TOKEN;
      const res = await fetch('/api/config/save', { method:'POST', headers, body:JSON.stringify({data: partial}) });
      const j = await res.json().catch(()=>({}));
      if (!j?.ok){ alert(j?.error || 'Save failed'); }
      else { currentConfig = {...(currentConfig||{}), ...partial}; }
    }
    loadConfig();

    (function initEditorControls() {
      const MIN_FONT_SIZE = 12;
      const MAX_FONT_SIZE = 40;
      const DEFAULT_FONT_SIZE = 14;
      const FONT_KEY = 'eagleide-font-size';
      const GUIDES_KEY = 'eagleide-indent-guides';
      const AUTOCOMPLETE_KEY = 'eagleide-autocomplete';
      const fontRange = document.getElementById('fontRange');
      const fontVal = document.getElementById('fontVal');
      const guidesBtn = document.getElementById('guidesBtn');
      const autocompleteBtn = document.getElementById('autocompleteBtn');
      let guidesEnabled = true;
      let autocompleteEnabled = true;
      let fontFrame = 0;

      const clampFontSize = (value) => Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, parseInt(value, 10) || DEFAULT_FONT_SIZE));
      function applyFontSize(value, persist = true) {
        const next = clampFontSize(value);
        fontRange.value = String(next);
        fontVal.textContent = String(next);
        if (fontFrame) cancelAnimationFrame(fontFrame);
        fontFrame = requestAnimationFrame(() => {
          document.documentElement.style.setProperty('--cm-font-size', `${next}px`);
          refreshEditors();
        });
        if (persist) {
          try { localStorage.setItem(FONT_KEY, String(next)); } catch {}
        }
      }

      function applyGuides(enabled, persist = true) {
        guidesEnabled = !!enabled;
        document.body.classList.toggle('guides-off', !guidesEnabled);
        guidesBtn.textContent = `Guides: ${guidesEnabled ? 'On' : 'Off'}`;
        if (persist) {
          try { localStorage.setItem(GUIDES_KEY, guidesEnabled ? '1' : '0'); } catch {}
        }
      }

      function applyAutocomplete(enabled, persist = true) {
        autocompleteEnabled = !!enabled;
        window.toggleEagleCompletion?.(autocompleteEnabled);
        autocompleteBtn.textContent = `Autocomplete: ${autocompleteEnabled ? 'On' : 'Off'}`;
        if (persist) {
          try { localStorage.setItem(AUTOCOMPLETE_KEY, autocompleteEnabled ? '1' : '0'); } catch {}
        }
      }

      try {
        applyFontSize(localStorage.getItem(FONT_KEY) || fontRange.value, false);
        applyGuides(localStorage.getItem(GUIDES_KEY) !== '0', false);
        applyAutocomplete(localStorage.getItem(AUTOCOMPLETE_KEY) !== '0', false);
      } catch {
        applyFontSize(fontRange.value, false);
        applyGuides(true, false);
        applyAutocomplete(true, false);
      }

      fontRange.addEventListener('input', (e) => applyFontSize(e.target.value));
      guidesBtn.addEventListener('click', () => applyGuides(!guidesEnabled));
      autocompleteBtn.addEventListener('click', () => applyAutocomplete(!autocompleteEnabled));
      document.getElementById('languageSelector')?.addEventListener('change', () => syncEditorLanguage());
      syncEditorLanguage();
    })();

    // ---- Layout controls (sidebar toggle + splitters) ----
    (function initLayoutControls() {
      const root = document.documentElement;
      const outer = document.getElementById('outer');
      const rightstack = document.getElementById('rightstack');
      const hsplitter = document.getElementById('hsplitter');
      const vsplitter = document.getElementById('vsplitter');
      const editorContentStack = document.getElementById('editorContentStack');
      const editorStreamSplitter = document.getElementById('editorStreamSplitter');
      const teacherPaneToggleBtn = document.getElementById('teacherPaneToggleBtn');
      const rightEdgeToggleBtn = document.getElementById('rightEdgeToggleBtn');
      const RIGHT_COLLAPSE_KEY = 'eagleide-right-collapsed';
      const LEFT_WIDTH_KEY = 'eagleide-left-width';
      const SHELL_SIZE_KEY = 'eagleide-shell-size';

      const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

      function setLeftWidth(percent, persist = true) {
        const normalized = clamp(percent, 20, 80);
        root.style.setProperty('--left-width', `${normalized}%`);
        if (persist) {
          try { localStorage.setItem(LEFT_WIDTH_KEY, String(normalized)); } catch {}
        }
      }

      function setShellSize(percent, persist = true) {
        const normalized = clamp(percent, 15, 75);
        root.style.setProperty('--shell-size', `${normalized}%`);
        if (persist) {
          try { localStorage.setItem(SHELL_SIZE_KEY, String(normalized)); } catch {}
        }
      }

      function applyRightSidebarState(collapsed, persist = true) {
        document.body.classList.toggle('right-collapsed', collapsed);
        if (rightEdgeToggleBtn) {
          rightEdgeToggleBtn.textContent = collapsed ? '◀' : '▶';
          rightEdgeToggleBtn.title = collapsed ? 'Show resources sidebar' : 'Hide resources sidebar';
          rightEdgeToggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        }
        if (persist) {
          try { localStorage.setItem(RIGHT_COLLAPSE_KEY, collapsed ? '1' : '0'); } catch {}
        }
      }

      if (rightEdgeToggleBtn) {
        rightEdgeToggleBtn.addEventListener('click', () => {
          const collapsed = !document.body.classList.contains('right-collapsed');
          applyRightSidebarState(collapsed);
        });
      }

      try {
        const storedLeft = parseFloat(localStorage.getItem(LEFT_WIDTH_KEY) || '');
        if (Number.isFinite(storedLeft)) setLeftWidth(storedLeft, false);
        const storedShell = parseFloat(localStorage.getItem(SHELL_SIZE_KEY) || '');
        if (Number.isFinite(storedShell)) setShellSize(storedShell, false);
        const storedTeacherPane = parseFloat(localStorage.getItem(TEACHER_PANE_SIZE_KEY) || '');
        if (Number.isFinite(storedTeacherPane)) setTeacherPaneSize(storedTeacherPane, false);
        applyRightSidebarState(localStorage.getItem(RIGHT_COLLAPSE_KEY) === '1', false);
      } catch {
        applyRightSidebarState(false, false);
        setTeacherPaneSize(50, false);
      }

      teacherPaneToggleBtn?.addEventListener('click', () => {
        if (!teacherPaneEnabled) return;
        setTeacherPaneOpen(!teacherPaneOpen);
      });

      function attachPointerDrag(element, canStart, onMove) {
        if (!element) return;
        element.addEventListener('pointerdown', (event) => {
          if (!canStart()) return;
          event.preventDefault();
          const pointerId = event.pointerId;
          try { element.setPointerCapture(pointerId); } catch (err) { console.debug('Pointer capture unavailable:', err); }
          const move = (moveEvent) => onMove(moveEvent);
          const up = (upEvent) => {
            if (upEvent.pointerId !== pointerId) return;
            try { element.releasePointerCapture(pointerId); } catch (err) { console.debug('Pointer release unavailable:', err); }
            element.removeEventListener('pointermove', move);
            element.removeEventListener('pointerup', up);
            element.removeEventListener('pointercancel', up);
          };
          element.addEventListener('pointermove', move);
          element.addEventListener('pointerup', up);
          element.addEventListener('pointercancel', up);
        }, { passive: false });
      }

      attachPointerDrag(hsplitter,
        () => !document.body.classList.contains('right-collapsed'),
        (moveEvent) => {
          const rect = outer.getBoundingClientRect();
          const relativeX = moveEvent.clientX - rect.left;
          const next = (relativeX / rect.width) * 100;
          setLeftWidth(next);
        }
      );

      attachPointerDrag(vsplitter,
        () => !document.body.classList.contains('shell-hidden'),
        (moveEvent) => {
          const rect = rightstack.getBoundingClientRect();
          const relativeY = moveEvent.clientY - rect.top;
          const next = (relativeY / rect.height) * 100;
          setShellSize(next);
        }
      );

      attachPointerDrag(editorStreamSplitter,
        () => !!teacherPaneEnabled && !!teacherPaneOpen && !!editorContentStack,
        (moveEvent) => {
          const rect = editorContentStack.getBoundingClientRect();
          const relativeY = moveEvent.clientY - rect.top;
          const bottomPercent = ((rect.height - relativeY) / rect.height) * 100;
          setTeacherPaneSize(bottomPercent);
          try { window.eagleEditor?.refresh?.(); } catch {}
          try { teacherEditor?.refresh?.(); } catch {}
        }
      );
    })();

    // ---- Login UI ----
    function updateLoginModeUI() {
      const reg = document.getElementById('registerSection');
      const btn = document.getElementById('toggleRegisterBtn');
      const submit = document.getElementById('loginSubmitBtn');
      const title = document.getElementById('loginModalTitle');
      if (reg) reg.style.display = registerMode ? 'block' : 'none';
      if (btn) btn.textContent = registerMode ? 'Back to Sign In' : 'Create Student Account';
      if (submit) submit.textContent = registerMode ? 'Create Account' : 'Sign In';
      if (title) title.textContent = registerMode ? 'Create Student Account' : 'Sign In';
      const err = document.getElementById('authError');
      if (err) err.textContent = '';
    }

    function openLoginModal() {
      registerMode = false;
      updateLoginModeUI();
      document.getElementById('loginModal').style.display = 'flex';
    }

    function closeLoginModal() {
      document.getElementById('loginModal').style.display = 'none';
    }

    function updateAuthUI() {
      const guestBadge = document.getElementById('guestBadge');
      const rightEdgeToggleBtn = document.getElementById('rightEdgeToggleBtn');
      const loginBtn = document.getElementById('loginBtn');
      const signOutBtn = document.getElementById('signOutBtn');
      const workspaceFilesTabBtn = document.getElementById('workspaceFilesTabBtn');
      const adminSettingsBtn = document.getElementById('adminSettingsBtn');
      const adminUsersBtn = document.getElementById('adminUsersBtn');
      const serverHealthBtn = document.getElementById('serverHealthBtn');
      const streamingToggleBtn = document.getElementById('streamingToggleBtn');
      const modeWrap = document.getElementById('modeSelectorWrap');
      const isLoggedIn = isAuthenticated();
      document.body.classList.toggle('guest-mode', !isLoggedIn);
      document.body.classList.toggle('admin-owner', !!ADMIN_TOKEN);
      guestBadge.style.display = isLoggedIn ? 'none' : '';
      if (modeWrap) modeWrap.style.display = isLoggedIn ? 'none' : 'inline-flex';
      if (rightEdgeToggleBtn) rightEdgeToggleBtn.style.display = isLoggedIn ? 'flex' : 'none';
      if (workspaceFilesTabBtn) workspaceFilesTabBtn.style.display = isLoggedIn ? '' : 'none';
      if (!isLoggedIn) {
        hideFileBrowser();
      }
      // Toggle sign-in/sign-out buttons
      if (isLoggedIn) {
        loginBtn.style.display = 'none';
        const accountName = (currentUser?.name || currentTeacher?.name || currentUser?.email || currentTeacher?.email || 'Admin').trim();
        if (signOutBtn) {
          signOutBtn.style.display = '';
          signOutBtn.title = `Sign out (${accountName})`;
        }
      } else {
        loginBtn.style.display = '';
        loginBtn.textContent = 'Sign In';
        loginBtn.title = 'Sign in';
        if (signOutBtn) signOutBtn.style.display = 'none';
      }
      adminSettingsBtn.style.display = ADMIN_TOKEN ? '' : 'none';
      adminSettingsBtn.title = 'Admin Settings';
      const teacherDashboardBtn = document.getElementById('teacherDashboardBtn');
      if (teacherDashboardBtn) teacherDashboardBtn.style.display = TEACHER_TOKEN ? '' : 'none';
      if (adminUsersBtn) adminUsersBtn.style.display = ADMIN_TOKEN ? '' : 'none';
      if (serverHealthBtn) serverHealthBtn.style.display = ADMIN_TOKEN ? '' : 'none';
      const roleMenuBtn = document.getElementById('roleMenuBtn');
      if (roleMenuBtn) roleMenuBtn.style.display = isLoggedIn ? '' : 'none';
      streamingToggleBtn.style.display = (ADMIN_TOKEN || TEACHER_TOKEN) ? '' : 'none';
      if (!ADMIN_TOKEN && !TEACHER_TOKEN) {
        setTeacherStreamingEnabled(false);
      } else {
        updateStreamingToggleButton();
      }
      updateEditorOverlay();
      renderClassSelector();
      if (typeof window.afterAuthUiUpdate === "function") window.afterAuthUiUpdate();
    }

    function formatDuration(totalSeconds) {
      const s = Math.max(0, Number(totalSeconds) || 0);
      const days = Math.floor(s / 86400);
      const hours = Math.floor((s % 86400) / 3600);
      const mins = Math.floor((s % 3600) / 60);
      if (days > 0) return `${days}d ${hours}h ${mins}m`;
      if (hours > 0) return `${hours}h ${mins}m`;
      return `${mins}m`;
    }

    function renderServerHealthFeed(alerts) {
      const feed = document.getElementById('serverHealthFeed');
      if (!feed) return;
      const items = Array.isArray(alerts) ? alerts : [];
      if (!items.length) {
        feed.innerHTML = '<div style="color:#888; font-size:12px;">No server events recorded yet.</div>';
        return;
      }
      feed.innerHTML = '';
      items.forEach(item => {
        const row = document.createElement('div');
        row.className = `server-health-alert${String(item?.level || '').toLowerCase() === 'critical' ? ' critical' : ''}`;
        const details = item?.details && typeof item.details === 'object'
          ? Object.entries(item.details).filter(([key, value]) => key && value !== null && value !== undefined && String(value) !== '')
          : [];
        const detailsText = details.length ? ' • ' + details.map(([k, v]) => `${k}: ${v}`).join(' | ') : '';
        row.innerHTML = `
          <div class="meta">${escapeHtml(item?.timestamp || '—')} • ${escapeHtml(String(item?.type || 'event'))} • ${escapeHtml(String(item?.level || 'info').toUpperCase())}</div>
          <div>${escapeHtml(item?.message || '')}${escapeHtml(detailsText)}</div>
        `;
        feed.appendChild(row);
      });
    }

    async function loadServerHealth() {
      if (!ADMIN_TOKEN) return;
      const res = await fetch('/api/admin/server-health', { headers: { 'X-Admin-Token': ADMIN_TOKEN } });
      const j = await res.json().catch(() => ({}));
      if (!j?.ok) {
        alert(j?.error || 'Failed to load server health');
        return;
      }
      const d = j.data || {};
      const formatResourceUsage = (percent, usedBytes, totalBytes) =>
        `${Number(percent || 0).toFixed(1)}% (${_formatBytes(usedBytes || 0)} / ${_formatBytes(totalBytes || 0)})`;
      const cpu = Number(d.cpu_percent || 0).toFixed(1) + '%';
      const memory = formatResourceUsage(d.memory?.percent, d.memory?.used_bytes, d.memory?.total_bytes);
      const storage = formatResourceUsage(d.storage?.percent, d.storage?.used_bytes, d.storage?.total_bytes);
      document.getElementById('serverHealthUptime').textContent = formatDuration(d.uptime_seconds || 0);
      document.getElementById('serverHealthCpu').textContent = cpu;
      document.getElementById('serverHealthMemory').textContent = memory;
      document.getElementById('serverHealthStorage').textContent = storage;
      document.getElementById('serverHealthSignins').textContent =
        `Last 24 hours: ${Number(d.sign_ins?.last_24_hours || 0)} | Last 7 days: ${Number(d.sign_ins?.last_7_days || 0)} | Last 30 days: ${Number(d.sign_ins?.last_30_days || 0)}`;
      document.getElementById('serverHealthLog').textContent = (d.server_log_tail || []).join('\n') || 'No server logs yet.';
      document.getElementById('serverHealthUpdatedAt').textContent =
        `Updated: ${new Date().toLocaleString()} • Started: ${d.started_at || '—'}`;
      renderServerHealthFeed(d.alerts || []);
    }

    // Show/hide an "no file selected" overlay on the editor when signed in but no file open
    function updateEditorOverlay() {
      const editorPanel = document.getElementById('editorPanel');
      const isLoggedIn = isAuthenticated();
      if (isLoggedIn && !currentOpenFile) {
        editorPanel.classList.add('editor-disabled');
        if (window.eagleEditor) window.eagleEditor.setOption('readOnly', true);
      } else {
        editorPanel.classList.remove('editor-disabled');
        if (window.eagleEditor) window.eagleEditor.setOption('readOnly', false);
      }
    }

    async function applyAuthLoginPayload(j) {
      if (j.role === 'teacher') {
        TEACHER_TOKEN = j.token;
        currentTeacher = j.user;
        USER_TOKEN = null;
        currentUser = null;
        ADMIN_TOKEN = null;
        studentClasses = [];
        studentClassData = null;
        currentStudentClassId = null;
        document.body.classList.add('admin-mode');
        await loadTeacherClasses();
        renderClassSelector();
        setTeacherStreamingEnabled(false);
      } else {
        USER_TOKEN = j.token;
        currentUser = j.user;
        TEACHER_TOKEN = null;
        currentTeacher = null;
        ADMIN_TOKEN = null;
        teacherClasses = [];
        currentTeacherClassId = null;
        document.body.classList.remove('admin-mode');
        await loadStudentClassData().catch((err) => {
          console.warn('Failed to refresh student class data after login.', err);
          alert('Signed in, but class data failed to load. Please refresh the page and try again.');
          return null;
        });
        setTeacherPaneOpen(false);
      }
      saveAuthSession();
      closeLoginModal();
      updateAuthUI();
      await showFileBrowser();
    }

    async function tryUnifiedSignIn(email, password) {
      try {
        const authRes = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });
        const authJson = await authRes.json().catch(() => ({}));
        if (authJson?.ok) {
          await applyAuthLoginPayload(authJson);
          return { ok: true };
        }
        const adminRes = await fetch('/api/admin/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });
        const adminJson = await adminRes.json().catch(() => ({}));
        if (adminJson?.ok) {
          ADMIN_TOKEN = adminJson.token;
          USER_TOKEN = null;
          TEACHER_TOKEN = null;
          currentTeacher = null;
          currentUser = null;
          document.body.classList.add('admin-mode');
          closeLoginModal();
          setTeacherStreamingEnabled(false);
          saveAuthSession();
          updateAuthUI();
          await showFileBrowser();
          return { ok: true };
        }
        const authError = String(authJson?.error || '').trim();
        const adminError = String(adminJson?.error || '').trim();
        const generic = 'Invalid email or password';
        let error = generic;
        if (authError && authError !== generic) {
          error = authError;
        } else if (adminError && adminError !== generic) {
          error = adminError;
        } else {
          error = authError || adminError || generic;
        }
        return { ok: false, error };
      } catch {
        return { ok: false, error: 'Network error. Please try again.' };
      }
    }

    // Login button: open unified login modal
    document.getElementById('loginBtn').addEventListener('click', () => openLoginModal());
    document.getElementById('signOutBtn')?.addEventListener('click', async () => {
      if (!isAuthenticated()) return;
      teacherSkills = [];
      editingSkillId = null;
      if (USER_TOKEN) {
        await fetch('/api/auth/logout', { method: 'POST', headers: { 'X-User-Token': USER_TOKEN } }).catch(() => {});
        USER_TOKEN = null;
        currentUser = null;
        studentClasses = [];
        studentClassData = null;
        currentStudentClassId = null;
        teacherStreamLiveClasses = {};
        currentOpenFile = null;
        setRunButtonState(false);
        setCsvMode(false);
        editor.setValue('');
        if (typeof updateActiveFileName === 'function') updateActiveFileName();
        hideFileBrowser();
      }
      if (TEACHER_TOKEN) {
        setTeacherStreamingEnabled(false);
        await fetch('/api/auth/logout', { method: 'POST', headers: { 'X-Teacher-Token': TEACHER_TOKEN } }).catch(() => {});
        TEACHER_TOKEN = null;
        currentTeacher = null;
        teacherClasses = [];
        currentTeacherClassId = null;
        teacherStreamLiveClasses = {};
        document.body.classList.remove('admin-mode');
        currentOpenFile = null;
        setRunButtonState(false);
        setCsvMode(false);
        editor.setValue('');
        if (typeof updateActiveFileName === 'function') updateActiveFileName();
        hideFileBrowser();
        document.getElementById('teacherDashboardModal').style.display = 'none';
        teacherDashListenersAttached = false;
        stopTeacherDashboardRosterPolling();
      }
      if (ADMIN_TOKEN) {
        setTeacherStreamingEnabled(false);
        ADMIN_TOKEN = null;
        document.body.classList.remove('admin-mode');
        teacherStreamLiveClasses = {};
        setRunButtonState(false);
        setCsvMode(false);
        document.getElementById('adminSettingsBtn').style.display = 'none';
        document.getElementById('streamingToggleBtn').style.display = 'none';
        const adminUsersBtn = document.getElementById('adminUsersBtn');
        if (adminUsersBtn) adminUsersBtn.style.display = 'none';
        const serverHealthBtn = document.getElementById('serverHealthBtn');
        if (serverHealthBtn) serverHealthBtn.style.display = 'none';
        document.getElementById('adminUsersModal').style.display = 'none';
        document.getElementById('serverHealthModal').style.display = 'none';
        currentOpenFile = null;
        hideFileBrowser();
        editor.setValue('');
        if (typeof updateActiveFileName === 'function') updateActiveFileName();
      }
      saveAuthSession();
      updateStreamingToggleButton();
      updateTeacherStreamToggleState();
      updateAuthUI();
      window.location.reload();
    });
    document.getElementById('toggleRegisterBtn').addEventListener('click', () => {
      registerMode = !registerMode;
      updateLoginModeUI();
    });
    document.getElementById('loginCancelBtn').addEventListener('click', closeLoginModal);
    document.getElementById('loginSubmitBtn').addEventListener('click', async () => {
      const errEl = document.getElementById('authError');
      errEl.textContent = '';
      const email = document.getElementById('authEmailInput').value.trim();
      const password = document.getElementById('authPasswordInput').value;
      if (!email || !password) { errEl.textContent = 'Email and password required.'; return; }
      if (registerMode) {
        const name = document.getElementById('regName').value.trim();
        if (!name) { errEl.textContent = 'Name is required.'; return; }
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, name })
        });
        const j = await res.json().catch(() => ({}));
        if (!j?.ok) { errEl.textContent = j.error || 'Registration failed'; return; }
        USER_TOKEN = j.token;
        currentUser = j.user;
        TEACHER_TOKEN = null;
        ADMIN_TOKEN = null;
        currentTeacher = null;
        document.body.classList.remove('admin-mode');
        await loadStudentClassData().catch((err) => {
          console.warn('Failed to refresh student class data after registration.', err);
          alert('Account created, but class data failed to load. Please refresh the page and try again.');
          return null;
        });
        setTeacherPaneOpen(false);
        saveAuthSession();
        closeLoginModal();
        updateAuthUI();
        await showFileBrowser();
        return;
      }
      const signInResult = await tryUnifiedSignIn(email, password);
      if (!signInResult.ok) errEl.textContent = signInResult.error || 'Invalid email or password';
    });
    document.getElementById('authPasswordInput').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') document.getElementById('loginSubmitBtn').click();
    });
    (async () => {
      const restored = restoreAuthSession();
      if (restored) {
        await validateRestoredAuthSession();
        if (USER_TOKEN) {
          await loadStudentClassData().catch(() => null);
        } else if (TEACHER_TOKEN) {
          await loadTeacherClasses().catch(() => []);
        }
      }
      updateAuthUI();
      if (isAuthenticated()) {
        await showFileBrowser();
      }
    })();

    // Teacher Code Broadcasting
    let teacherBroadcastActive = false;
    let teacherBroadcastFlushTimer = null;
    let lastBroadcastedCode = '';
    let lastBroadcastedLanguage = 'python';
    
    function flushTeacherBroadcast(force = false) {
      if (!teacherStreamingEnabled || !teacherBroadcastActive || document.hidden) return;
      const token = ADMIN_TOKEN || TEACHER_TOKEN;
      const role = ADMIN_TOKEN ? 'admin' : (TEACHER_TOKEN ? 'teacher' : '');
      const activeClassId = getCurrentClassContext()?.id;
      if (!token || !role || !activeClassId || !socket) return;
      const currentCode = editor.getValue();
      const langInfo = getActiveLanguageInfo();
      const language = langInfo?.highlight || 'python';
      if (!force && currentCode === lastBroadcastedCode && language === lastBroadcastedLanguage) return;
      lastTeacherCodeSnapshot = currentCode;
      try { localStorage.setItem(TEACHER_CODE_KEY, currentCode); } catch(e) {}
      socket.emit('teacher_code_update', {
        token,
        role,
        class_id: activeClassId,
        code: currentCode,
        language
      });
      lastBroadcastedCode = currentCode;
      lastBroadcastedLanguage = language;
    }

    function scheduleTeacherBroadcastFlush(force = false) {
      if (!teacherStreamingEnabled || !teacherBroadcastActive) return;
      if (teacherBroadcastFlushTimer) {
        clearTimeout(teacherBroadcastFlushTimer);
        teacherBroadcastFlushTimer = null;
      }
      if (force) {
        flushTeacherBroadcast(true);
        return;
      }
      teacherBroadcastFlushTimer = setTimeout(() => {
        teacherBroadcastFlushTimer = null;
        flushTeacherBroadcast(false);
      }, 200);
    }
    
    function startTeacherBroadcast() {
      if (teacherBroadcastActive) return;
      const classId = getCurrentClassContext()?.id;
      if (!classId) return;
      const initialCode = editor.getValue();
      const initialLangInfo = getActiveLanguageInfo();
      lastTeacherCodeSnapshot = initialCode;
      lastBroadcastedCode = initialCode;
      lastBroadcastedLanguage = initialLangInfo?.highlight || 'python';
      try { localStorage.setItem(TEACHER_CODE_KEY, initialCode); } catch(e) {}
      if (socket) {
        socket.emit('teacher_stream_status', {
          token: ADMIN_TOKEN || TEACHER_TOKEN,
          role: ADMIN_TOKEN ? 'admin' : 'teacher',
          class_id: classId,
          active: true
        });
        socket.emit('teacher_code_update', {
          token: ADMIN_TOKEN || TEACHER_TOKEN,
          role: ADMIN_TOKEN ? 'admin' : 'teacher',
          class_id: classId,
          code: initialCode,
          language: lastBroadcastedLanguage
        });
      }
      teacherBroadcastActive = true;
    }
    
    function stopTeacherBroadcast() {
      if (teacherBroadcastActive) {
        const activeClassId = getCurrentClassContext()?.id;
        if (teacherBroadcastFlushTimer) {
          clearTimeout(teacherBroadcastFlushTimer);
          teacherBroadcastFlushTimer = null;
        }
        teacherBroadcastActive = false;
        if (socket && activeClassId) {
          socket.emit('teacher_stream_status', {
            token: ADMIN_TOKEN || TEACHER_TOKEN,
            role: ADMIN_TOKEN ? 'admin' : 'teacher',
            class_id: activeClassId,
            active: false
          });
        }
      }
    }

    if (window.eagleEditor) {
      window.eagleEditor.on('change', () => scheduleTeacherBroadcastFlush(false));
    } else {
      document.getElementById('editor')?.addEventListener('input', () => scheduleTeacherBroadcastFlush(false));
    }
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) scheduleTeacherBroadcastFlush(true);
    });

    function setTeacherStreamingEnabled(enabled) {
      const next = !!enabled;
      teacherStreamingEnabled = next;
      if (next) {
        startTeacherBroadcast();
      } else {
        stopTeacherBroadcast();
      }
      updateStreamingToggleButton();
      updateTeacherStreamToggleState();
    }

    // Streaming toggle button handler
    document.getElementById('streamingToggleBtn').addEventListener('click', () => {
      setTeacherStreamingEnabled(!teacherStreamingEnabled);
    });
    updateStreamingToggleButton();

    // Admin settings modal handlers
    document.getElementById('adminSettingsBtn').addEventListener('click', () => {
      if (!ADMIN_TOKEN) return;
      document.getElementById('adminSettingsModal').style.display = 'flex';
      const siteWideSettingsSection = document.getElementById('siteWideSettingsSection');
      const settingsSaveBtn = document.getElementById('settingsSaveBtn');
      const modalTitle = document.querySelector('#adminSettingsModal .modal-content h3');
      
      // Page settings
      document.getElementById('pageTitleInput').value = currentConfig?.page_title || 'Eagles Web IDE (Python)';
      document.getElementById('topBarColorInput').value = currentConfig?.topbar_color || 'linear-gradient(90deg,#a5c8f0,#7fb2eb)';
      
      // Wiki/Lesson settings
      document.getElementById('lessonUrlInputModal').value = currentConfig?.lesson_url || '';
      document.getElementById('lessonUseLocalModal').checked = currentConfig?.lesson_use_local || false;
      
      // AI settings
      document.getElementById('aiEnabledModal').checked = currentConfig?.ai_explainer_enabled || false;
      document.getElementById('aiUrlInputModal').value = currentConfig?.ai_ollama_url || 'http://127.0.0.1:11434';
      document.getElementById('aiModelInputModal').value = currentConfig?.ai_model || 'gemma3:4b';
      document.getElementById('assistantPromptInputModal').value = currentConfig?.ai_assistant_preprompt || '';

      // HTML runtime settings
      document.getElementById('htmlRuntimeEnabledModal').checked = currentConfig?.html_runtime_enabled !== false;
      document.getElementById('htmlRuntimeTimeoutModal').value = Number(currentConfig?.html_runtime_timeout_seconds || 30);
      document.getElementById('htmlAllowExternalModal').checked = !!currentConfig?.html_runtime_allow_external_internet;
      document.getElementById('htmlAllowPopupsModal').checked = !!currentConfig?.html_runtime_allow_popups;
      document.getElementById('htmlAllowNavigationModal').checked = !!currentConfig?.html_runtime_allow_navigation;
      document.getElementById('htmlMaxFpsModal').value = Number(currentConfig?.html_runtime_max_fps || 30);
      document.getElementById('htmlMemoryLimitModal').value = Number(currentConfig?.html_runtime_memory_limit_mb || 128);
      document.getElementById('htmlMaxDomNodesModal').value = Number(currentConfig?.html_runtime_max_dom_nodes || 3000);
      document.getElementById('htmlMaxPopupSpawnModal').value = Number(currentConfig?.html_runtime_max_popups || 2);

      // Registration setting
      document.getElementById('registrationEnabledModal').checked = currentConfig?.registration_enabled !== false;

      if (modalTitle) modalTitle.textContent = 'Admin Settings';
      if (siteWideSettingsSection) siteWideSettingsSection.style.display = '';
      if (settingsSaveBtn) settingsSaveBtn.style.display = '';
      loadAdminUsers();
    });

    document.getElementById('settingsCancelBtn').addEventListener('click', () => {
      document.getElementById('adminSettingsModal').style.display = 'none';
    });

    // ── Teacher Dashboard ──────────────────────────────────────────
    let teacherDashListenersAttached = false;

    function activateReportsRosterPane() {
      const modal = document.getElementById('teacherDashboardModal');
      if (!modal) return;
      modal.querySelectorAll('#dash-reports .mastery-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.pane === 'class-roster-pane'));
      modal.querySelectorAll('#dash-reports .mastery-pane').forEach(p => p.classList.toggle('active', p.id === 'class-roster-pane'));
    }

    function stopTeacherDashboardRosterPolling() {
      if (teacherDashboardRosterPoll) {
        clearInterval(teacherDashboardRosterPoll);
        teacherDashboardRosterPoll = null;
      }
    }

    function isRosterPollingTargetActive() {
      const modal = document.getElementById('teacherDashboardModal');
      if (!modal || modal.style.display === 'none' || !TEACHER_TOKEN || !currentTeacherClassId || document.hidden) return false;
      const reportsActive = modal.querySelector('.teacher-dash-view.active')?.id === 'dash-reports';
      const rosterActive = modal.querySelector('#dash-reports .mastery-pane.active')?.id === 'class-roster-pane';
      return reportsActive && rosterActive;
    }

    function startTeacherDashboardRosterPolling() {
      stopTeacherDashboardRosterPolling();
      if (!isRosterPollingTargetActive()) return;
      teacherDashboardRosterPoll = setInterval(async () => {
        if (!isRosterPollingTargetActive()) {
          stopTeacherDashboardRosterPolling();
          return;
        }
        await refreshActiveStudentsForClass(currentTeacherClassId);
      }, 2000);
    }

    function ensureTeacherDashboardRosterPolling() {
      if (isRosterPollingTargetActive()) startTeacherDashboardRosterPolling();
      else stopTeacherDashboardRosterPolling();
    }

    function openTeacherDashboard(view) {
      const modal = document.getElementById('teacherDashboardModal');
      if (!modal) return;
      modal.style.display = 'flex';
      if (!teacherDashListenersAttached) {
        teacherDashListenersAttached = true;

        // Close button
        document.getElementById('teacherDashCloseBtn')?.addEventListener('click', () => {
          modal.style.display = 'none';
          stopTeacherDashboardRosterPolling();
        });
        modal.addEventListener('click', (e) => {
          if (e.target === modal) {
            modal.style.display = 'none';
            stopTeacherDashboardRosterPolling();
          }
        });

        // Sidebar nav tab switching
        modal.querySelectorAll('.teacher-dash-navbtn').forEach(btn => {
          btn.addEventListener('click', async () => {
            modal.querySelectorAll('.teacher-dash-navbtn').forEach(b => b.classList.toggle('active', b === btn));
            modal.querySelectorAll('.teacher-dash-view').forEach(v => v.classList.toggle('active', v.id === btn.dataset.view));
            if (btn.dataset.view === 'dash-reports') {
              activateReportsRosterPane();
              populateTeacherReportsClassSelect();
              await refreshActiveStudentsForClass(currentTeacherClassId);
              renderClassReports().catch(() => {});
              ensureTeacherDashboardRosterPolling();
            } else if (btn.dataset.view === 'dash-skills') {
              stopTeacherDashboardRosterPolling();
              await loadTeacherSkills();
              renderTeacherSkillsPage();
            } else {
              stopTeacherDashboardRosterPolling();
            }
          });
        });

        // Reports – mastery tab buttons
        modal.querySelectorAll('#dash-reports .mastery-tab-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            modal.querySelectorAll('#dash-reports .mastery-tab-btn').forEach(b => b.classList.toggle('active', b === btn));
            modal.querySelectorAll('#dash-reports .mastery-pane').forEach(p => p.classList.remove('active'));
            const pane = document.getElementById(btn.dataset.pane);
            if (pane) pane.classList.add('active');
            ensureTeacherDashboardRosterPolling();
          });
        });

        // Reports – class selector change
        document.getElementById('teacherReportsClassSelect')?.addEventListener('change', async (e) => {
          currentTeacherClassId = e.target.value || null;
          renderClassSelector();
          syncTeacherDashboardClassSelectors();
          await refreshActiveStudentsForClass(currentTeacherClassId);
          await renderClassReports();
          ensureTeacherDashboardRosterPolling();
        });
        document.getElementById('teacherAssignmentsClassSelect')?.addEventListener('change', async (e) => {
          activeAssignmentsClassId = e.target.value || null;
          currentTeacherClassId = activeAssignmentsClassId;
          renderClassSelector();
          syncTeacherDashboardClassSelectors();
          await refreshActiveStudentsForClass(currentTeacherClassId);
          renderAdminAssignments();
          ensureTeacherDashboardRosterPolling();
        });
        document.getElementById('teacherClassesActiveSelect')?.addEventListener('change', async (e) => {
          currentTeacherClassId = e.target.value || null;
          renderClassSelector();
          syncTeacherDashboardClassSelectors();
          await refreshActiveStudentsForClass(currentTeacherClassId);
          renderTeacherClassManagement();
          renderAdminAssignments();
          await renderClassReports();
          ensureTeacherDashboardRosterPolling();
        });
        document.getElementById('refreshSkillsBtn')?.addEventListener('click', async () => {
          await loadTeacherSkills();
          renderTeacherSkillsPage();
        });
        document.getElementById('saveSkillBtn')?.addEventListener('click', saveTeacherSkillFromForm);
        document.getElementById('clearSkillFormBtn')?.addEventListener('click', resetSkillForm);
      }

      // Switch to requested view
      const targetView = view || 'dash-reports';
      if (targetView) {
        const viewEl = document.getElementById(targetView);
        const navBtn = modal.querySelector(`.teacher-dash-navbtn[data-view="${targetView}"]`);
        if (viewEl && navBtn) {
          modal.querySelectorAll('.teacher-dash-navbtn').forEach(b => b.classList.toggle('active', b === navBtn));
          modal.querySelectorAll('.teacher-dash-view').forEach(v => v.classList.toggle('active', v === viewEl));
        }
      }

      // Initialize data
      loadTeacherClasses().then(async () => {
        renderTeacherClassManagement();
        await loadTeacherSkills();
        renderTeacherSkillsPage();
        populateTeacherReportsClassSelect();
        populateTeacherAssignmentsClassSelect();
        syncTeacherDashboardClassSelectors();
        await refreshActiveStudentsForClass(currentTeacherClassId);
        activateReportsRosterPane();
        renderClassReports().catch(() => {});
        await loadAssignments();
        renderAdminAssignments();
      });
      startTeacherDashboardRosterPolling();
      document.getElementById('teacherPasswordStatus').textContent = '';
      document.getElementById('teacherCurrentPassword').value = '';
      document.getElementById('teacherNewPassword').value = '';
    }

    function populateTeacherReportsClassSelect() {
      const sel = document.getElementById('teacherReportsClassSelect');
      if (!sel) return;
      sel.innerHTML = teacherClasses.map(c => `<option value="${escapeHtml(c.id)}" ${c.id === currentTeacherClassId ? 'selected' : ''}>${escapeHtml(c.name)} (${escapeHtml(c.join_code)})</option>`).join('');
    }

    function populateTeacherAssignmentsClassSelect() {
      const sel = document.getElementById('teacherAssignmentsClassSelect');
      if (!sel) return;
      if (!teacherClasses.length) {
        sel.innerHTML = '';
        activeAssignmentsClassId = null;
        return;
      }
      sel.innerHTML = teacherClasses.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)} (${escapeHtml(c.join_code)})</option>`).join('');
      if (!activeAssignmentsClassId || !teacherClasses.some(c => c.id === activeAssignmentsClassId)) {
        activeAssignmentsClassId = currentTeacherClassId || teacherClasses[0]?.id || null;
      }
      if (activeAssignmentsClassId) sel.value = activeAssignmentsClassId;
    }

    function syncTeacherDashboardClassSelectors() {
      if (!currentTeacherClassId || !teacherClasses.some(c => c.id === currentTeacherClassId)) {
        currentTeacherClassId = teacherClasses[0]?.id || null;
      }
      if (!activeAssignmentsClassId || !teacherClasses.some(c => c.id === activeAssignmentsClassId)) {
        activeAssignmentsClassId = currentTeacherClassId;
      }
      const reportSel = document.getElementById('teacherReportsClassSelect');
      if (reportSel && currentTeacherClassId) reportSel.value = currentTeacherClassId;
      const classesSel = document.getElementById('teacherClassesActiveSelect');
      if (classesSel && currentTeacherClassId) classesSel.value = currentTeacherClassId;
      const assignmentSel = document.getElementById('teacherAssignmentsClassSelect');
      if (assignmentSel && activeAssignmentsClassId) assignmentSel.value = activeAssignmentsClassId;
    }

    let activeStudentsRefreshPromise = null;
    let activeStudentsRefreshClassId = null;

    async function refreshActiveStudentsForClass(classId) {
      const classKey = classId || currentTeacherClassId;
      if (!TEACHER_TOKEN || !classKey) return;
      if (activeStudentsRefreshPromise && activeStudentsRefreshClassId === classKey) {
        return activeStudentsRefreshPromise;
      }
      activeStudentsRefreshClassId = classKey;
      activeStudentsRefreshPromise = (async () => {
        const res = await fetch(`/api/teacher/classes/${encodeURIComponent(classKey)}/active-students`, {
          headers: { 'X-Teacher-Token': TEACHER_TOKEN }
        });
        const data = await res.json().catch(() => ({}));
        if (!data?.ok) return;
        activeStudentsByClass[classKey] = new Set((data.activeStudents || []).map(e => String(e || '').toLowerCase()));
        inQuizStudentsByClass[classKey] = new Set((data.inQuizStudents || []).map(e => String(e || '').toLowerCase()));
        lastSignInByClass[classKey] = data.lastSignInByEmail || {};
        updateRosterCells(classKey);
      })().catch(() => {});
      try {
        return await activeStudentsRefreshPromise;
      } finally {
        if (activeStudentsRefreshClassId === classKey) {
          activeStudentsRefreshClassId = null;
          activeStudentsRefreshPromise = null;
        }
      }
    }

    function updateRosterCells(classId) {
      const classKey = classId || currentTeacherClassId;
      if (!classKey || !currentMasteryData) return;
      const rosterPane = document.getElementById('class-roster-pane');
      if (!rosterPane) return;
      const students = currentMasteryData.students || [];
      const activeStudents = activeStudentsByClass[classKey] || new Set();
      const inQuizStudents = inQuizStudentsByClass[classKey] || new Set();
      const lastSignInMap = lastSignInByClass[classKey] || {};
      // Build a map of email -> element once to avoid repeated DOM queries
      const emailToEl = new Map();
      rosterPane.querySelectorAll('[data-roster-email]').forEach(el => {
        emailToEl.set(el.dataset.rosterEmail, el);
      });
      students.forEach(s => {
        const email = (s.email || '').toLowerCase();
        const el = emailToEl.get(email);
        if (!el) return;
        const isInQuiz = inQuizStudents.has(email);
        const isOnline = activeStudents.has(email);
        // Remove all state classes first, then apply exactly one
        el.classList.remove('teacher-roster-row-in-assignment', 'teacher-roster-row-online', 'teacher-roster-row-offline');
        if (isInQuiz) {
          el.classList.add('teacher-roster-row-in-assignment');
        } else if (isOnline) {
          el.classList.add('teacher-roster-row-online');
        } else {
          el.classList.add('teacher-roster-row-offline');
        }
        const lastSignInEl = el.querySelector('[data-last-sign-in]');
        if (lastSignInEl) {
          const raw = String(lastSignInMap[email] || '').trim();
          let text = 'Never';
          if (raw) {
            const parsed = new Date(raw);
            text = Number.isNaN(parsed.getTime()) ? raw : parsed.toLocaleString();
          }
          lastSignInEl.textContent = text;
        }
      });
    }

    document.getElementById('teacherDashboardBtn')?.addEventListener('click', () => {
      openTeacherDashboard('dash-reports');
    });


    document.getElementById('settingsSaveBtn').addEventListener('click', async () => {
      // Page settings
      const page_title = document.getElementById('pageTitleInput').value.trim();
      const topbar_color = document.getElementById('topBarColorInput').value.trim();
      
      // Wiki/Lesson settings
      const lesson_url = document.getElementById('lessonUrlInputModal').value.trim();
      const lesson_use_local = document.getElementById('lessonUseLocalModal').checked;
      
      // AI settings
      const ai_explainer_enabled = document.getElementById('aiEnabledModal').checked;
      const ai_ollama_url = document.getElementById('aiUrlInputModal').value.trim();
      const ai_model = document.getElementById('aiModelInputModal').value.trim();
      const ai_assistant_preprompt = document.getElementById('assistantPromptInputModal').value.trim();

      // HTML runtime settings
      const html_runtime_enabled = document.getElementById('htmlRuntimeEnabledModal').checked;
      const html_runtime_timeout_seconds = parseInt(document.getElementById('htmlRuntimeTimeoutModal').value, 10) || 30;
      const html_runtime_allow_external_internet = document.getElementById('htmlAllowExternalModal').checked;
      const html_runtime_allow_popups = document.getElementById('htmlAllowPopupsModal').checked;
      const html_runtime_allow_navigation = document.getElementById('htmlAllowNavigationModal').checked;
      const html_runtime_max_fps = parseInt(document.getElementById('htmlMaxFpsModal').value, 10) || 30;
      const html_runtime_memory_limit_mb = parseInt(document.getElementById('htmlMemoryLimitModal').value, 10) || 128;
      const html_runtime_max_dom_nodes = parseInt(document.getElementById('htmlMaxDomNodesModal').value, 10) || 3000;
      const html_runtime_max_popups = parseInt(document.getElementById('htmlMaxPopupSpawnModal').value, 10) || 2;
      
      // Save all settings at once
      await saveConfig({ 
        page_title, 
        topbar_color, 
        lesson_url, 
        lesson_use_local,
        ai_explainer_enabled, 
        ai_ollama_url, 
        ai_model, 
        ai_assistant_preprompt,
        html_runtime_enabled,
        html_runtime_timeout_seconds,
        html_runtime_allow_external_internet,
        html_runtime_allow_popups,
        html_runtime_allow_navigation,
        html_runtime_max_fps,
        html_runtime_memory_limit_mb,
        html_runtime_max_dom_nodes,
        html_runtime_max_popups
      });
      
      applyConfig(currentConfig);
      document.getElementById('adminSettingsModal').style.display = 'none';
      alert('All settings saved successfully!');
    });

    // ---- Admin Users Management ----
    document.getElementById('saveRegistrationBtn').addEventListener('click', async () => {
      if (!ADMIN_TOKEN) return;
      const enabled = document.getElementById('registrationEnabledModal').checked;
      const res = await fetch('/api/admin/registration', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN_TOKEN },
        body: JSON.stringify({ enabled })
      });
      const j = await res.json().catch(() => ({}));
      if (j?.ok) { currentConfig.registration_enabled = enabled; alert('Registration setting saved.'); }
      else alert(j.error || 'Failed');
    });

    document.getElementById('refreshUsersBtn').addEventListener('click', loadAdminUsers);
    document.getElementById('createTeacherBtn').addEventListener('click', createTeacherAccount);
    document.getElementById('createClassBtn').addEventListener('click', async () => {
      if (!TEACHER_TOKEN) return alert('Teacher login required.');
      const name = document.getElementById('newClassNameInput').value.trim();
      if (!name) return alert('Class name is required.');
      const res = await fetch('/api/teacher/classes/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Teacher-Token': TEACHER_TOKEN },
        body: JSON.stringify({ name })
      });
      const j = await res.json().catch(() => ({}));
      if (!j?.ok) return alert(j?.error || 'Failed to create class');
      document.getElementById('newClassNameInput').value = '';
      await loadTeacherClasses();
      populateTeacherReportsClassSelect();
      populateTeacherAssignmentsClassSelect();
      syncTeacherDashboardClassSelectors();
      renderTeacherClassManagement();
      renderClassSelector();
      await refreshActiveStudentsForClass(currentTeacherClassId);
      await renderClassReports();
      await loadAssignments();
    });

    document.getElementById('teacherChangePasswordBtn').addEventListener('click', async () => {
      if (!TEACHER_TOKEN) return;
      const currentPassword = document.getElementById('teacherCurrentPassword').value;
      const newPassword = document.getElementById('teacherNewPassword').value;
      const statusEl = document.getElementById('teacherPasswordStatus');
      statusEl.textContent = '';
      statusEl.style.color = '';
      if (!currentPassword || !newPassword) {
        statusEl.textContent = 'Enter current and new password.';
        statusEl.style.color = '#ef5350';
        return;
      }
      try {
        const res = await fetch('/api/teacher/change-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Teacher-Token': TEACHER_TOKEN },
          body: JSON.stringify({ currentPassword, newPassword })
        });
        const j = await res.json().catch(() => ({}));
        if (!j?.ok) {
          statusEl.textContent = j?.error || 'Could not update password.';
          statusEl.style.color = '#ef5350';
          return;
        }
        document.getElementById('teacherCurrentPassword').value = '';
        document.getElementById('teacherNewPassword').value = '';
        statusEl.textContent = 'Password updated.';
        statusEl.style.color = '#4caf50';
      } catch {
        statusEl.textContent = 'Network error.';
        statusEl.style.color = '#ef5350';
      }
    });

    async function loadAdminUsers() {
      if (!ADMIN_TOKEN) return;
      const res = await fetch('/api/admin/users', { headers: { 'X-Admin-Token': ADMIN_TOKEN } });
      const j = await res.json().catch(() => ({}));
      const tbody = document.getElementById('usersTableBody');
      tbody.innerHTML = '';
      if (!j.ok) { tbody.innerHTML = '<tr><td colspan="8" style="color:#ef5350;">Failed to load users</td></tr>'; return; }
      if (!j.users.length) { tbody.innerHTML = '<tr><td colspan="8" style="color:#888;">No users registered yet.</td></tr>'; return; }
      j.users.forEach(u => {
        const tr = document.createElement('tr');
        if (!u.enabled) tr.className = 'disabled-row';
        tr.innerHTML = `<td>${escapeHtml(u.name || '')}</td><td>${escapeHtml(u.email)}</td><td>${escapeHtml(u.role || 'student')}</td><td>${escapeHtml(u.class_name || '—')}</td><td>${escapeHtml(u.created_at || '')}</td><td>${escapeHtml(u.last_sign_in || '—')}</td><td>${u.enabled ? '✅ Active' : '🔒 Disabled'}</td>
          <td style="display:flex;gap:4px;flex-wrap:wrap;">
            <button class="btn secondary" data-action="reset" style="font-size:11px;padding:2px 6px;">Reset PW</button>
            <button class="btn secondary" data-action="toggle" data-enable="${!u.enabled}" style="font-size:11px;padding:2px 6px;">${u.enabled ? 'Disable' : 'Enable'}</button>
            <button class="btn secondary" data-action="delete" style="font-size:11px;padding:2px 6px;color:#ef5350;">Delete</button>
          </td>`;
        // Use data attributes + event listeners to avoid inline JS with user data
        const [resetBtn, toggleBtn, deleteBtn] = tr.querySelectorAll('button[data-action]');
        resetBtn.addEventListener('click', () => adminResetPassword(u.email));
        toggleBtn.addEventListener('click', () => adminToggleUser(u.email, !u.enabled));
        deleteBtn.addEventListener('click', () => adminDeleteUser(u.email));
        tbody.appendChild(tr);
      });
    }

    async function adminResetPassword(email) {
      if (!confirm(`Reset password for ${email}?`)) return;
      const res = await fetch('/api/admin/users/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN_TOKEN },
        body: JSON.stringify({ email })
      });
      const j = await res.json().catch(() => ({}));
      if (j?.ok) {
        const pwd = j.temp_password;
        const msg = document.createElement('div');
        msg.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#1e1e2e;border:1px solid #444;border-radius:12px;padding:24px;z-index:9999;min-width:320px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.5)';
        const safeEmail = document.createElement('b');
        safeEmail.textContent = email;
        const codeEl = document.createElement('code');
        codeEl.style.cssText = 'display:block;background:#111;padding:10px 16px;border-radius:6px;font-size:1.1em;letter-spacing:.05em;margin:8px 0;user-select:all';
        codeEl.textContent = pwd;
        const note = document.createElement('p');
        note.style.cssText = 'color:#f59e0b;font-size:.82em;margin:8px 0 16px';
        note.textContent = 'Instruct the student to change this password immediately.';
        const copyBtn = document.createElement('button');
        copyBtn.style.cssText = 'margin-right:8px;padding:6px 14px;border-radius:6px;border:none;background:#3b82f6;color:#fff;cursor:pointer';
        copyBtn.textContent = 'Copy';
        copyBtn.addEventListener('click', () => { navigator.clipboard?.writeText(pwd); copyBtn.textContent = 'Copied!'; });
        const closeBtn = document.createElement('button');
        closeBtn.style.cssText = 'padding:6px 14px;border-radius:6px;border:none;background:#444;color:#fff;cursor:pointer';
        closeBtn.textContent = 'Close';
        closeBtn.addEventListener('click', () => msg.remove());
        const header = document.createElement('p');
        header.style.cssText = 'margin:0 0 8px;color:#ccc';
        header.append('Temporary password for ', safeEmail, ':');
        msg.append(header, codeEl, note, copyBtn, closeBtn);
        document.body.appendChild(msg);
      } else {
        alert(j.error || 'Failed');
      }
    }

    async function adminToggleUser(email, enable) {
      const res = await fetch('/api/admin/users/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN_TOKEN },
        body: JSON.stringify({ email, enabled: enable })
      });
      const j = await res.json().catch(() => ({}));
      if (j?.ok) loadAdminUsers();
      else alert(j.error || 'Failed');
    }

    async function adminDeleteUser(email) {
      if (!confirm(`Delete user ${email} and all their files? This cannot be undone.`)) return;
      const res = await fetch('/api/admin/users/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN_TOKEN },
        body: JSON.stringify({ email })
      });
      const j = await res.json().catch(() => ({}));
      if (j?.ok) loadAdminUsers();
      else alert(j.error || 'Failed');
    }

    async function createTeacherAccount() {
      if (!ADMIN_TOKEN) return;
      const name = document.getElementById('newTeacherName').value.trim();
      const email = document.getElementById('newTeacherEmail').value.trim();
      const password = document.getElementById('newTeacherPassword').value.trim();
      if (!name || !email || !password) return alert('Teacher name, email, and password are required.');
      const res = await fetch('/api/admin/teachers/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN_TOKEN },
        body: JSON.stringify({ name, email, password })
      });
      const j = await res.json().catch(() => ({}));
      if (!j?.ok) return alert(j?.error || 'Failed to create teacher account');
      document.getElementById('newTeacherName').value = '';
      document.getElementById('newTeacherEmail').value = '';
      document.getElementById('newTeacherPassword').value = '';
      loadAdminUsers();
      alert('Teacher account created.');
    }

    // ---- Admin Users Management Modal ----
    let _adminUsersData = [];
    let _adminSelectedEmails = new Set();

    function _formatBytes(bytes) {
      if (bytes == null || isNaN(bytes)) return '—';
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    }

    function _updateAdminBulkButtons() {
      const count = _adminSelectedEmails.size;
      const selCountEl = document.getElementById('adminUsersSelCount');
      if (selCountEl) selCountEl.textContent = count === 0 ? '0 selected' : `${count} selected`;
      const show = count > 0;
      ['adminBulkEnableBtn','adminBulkDisableBtn','adminBulkClearFilesBtn','adminBulkDeleteBtn'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = show ? '' : 'none';
      });
    }

    function filterAdminUsersTable() {
      const q = (document.getElementById('adminUsersSearch')?.value || '').toLowerCase();
      const rows = document.querySelectorAll('#adminUsersStatsBody tr[data-email]');
      let vis = 0;
      rows.forEach(tr => {
        const email = (tr.dataset.email || '').toLowerCase();
        const name = (tr.dataset.name || '').toLowerCase();
        const match = !q || email.includes(q) || name.includes(q);
        tr.style.display = match ? '' : 'none';
        if (match) vis++;
      });
      const summary = document.getElementById('adminUsersSummary');
      if (summary) summary.textContent = `Showing ${vis} of ${_adminUsersData.length} users`;
    }

    async function loadAdminUsersModal() {
      if (!ADMIN_TOKEN) return;
      const tbody = document.getElementById('adminUsersStatsBody');
      if (tbody) tbody.innerHTML = '<tr><td colspan="12" style="text-align:center; padding:16px; color:#888;">Loading…</td></tr>';
      const res = await fetch('/api/admin/users', { headers: { 'X-Admin-Token': ADMIN_TOKEN } });
      const j = await res.json().catch(() => ({}));
      if (!j?.ok) {
        if (tbody) tbody.innerHTML = '<tr><td colspan="12" style="color:#ef5350; padding:8px;">Failed to load users</td></tr>';
        return;
      }
      _adminUsersData = j.users || [];
      _adminSelectedEmails.clear();
      _updateAdminBulkButtons();

      if (!tbody) return;
      if (!_adminUsersData.length) {
        tbody.innerHTML = '<tr><td colspan="12" style="color:#888; padding:12px;">No users registered yet.</td></tr>';
        const summary = document.getElementById('adminUsersSummary');
        if (summary) summary.textContent = '0 users';
        return;
      }

      tbody.innerHTML = '';
      const ADMIN_USERS_RENDER_LIMIT = 100;
      const usersToRender = _adminUsersData.length > ADMIN_USERS_RENDER_LIMIT
        ? _adminUsersData.slice(0, ADMIN_USERS_RENDER_LIMIT)
        : _adminUsersData;
      const appendAdminUserRow = (u) => {
        const tr = document.createElement('tr');
        tr.dataset.email = u.email || '';
        tr.dataset.name = u.name || '';
        if (!u.enabled) tr.classList.add('disabled-row');
        if (_adminSelectedEmails.has(u.email)) tr.classList.add('selected-row');

        const chkTd = document.createElement('td');
        const chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.checked = _adminSelectedEmails.has(u.email);
        chk.addEventListener('change', () => {
          if (chk.checked) {
            _adminSelectedEmails.add(u.email);
            tr.classList.add('selected-row');
          } else {
            _adminSelectedEmails.delete(u.email);
            tr.classList.remove('selected-row');
          }
          _updateAdminBulkButtons();
          const selectAllChk = document.getElementById('adminSelectAllChk');
          if (selectAllChk) {
            const visRows = [...document.querySelectorAll('#adminUsersStatsBody tr[data-email]')].filter(r => r.style.display !== 'none');
            selectAllChk.checked = visRows.length > 0 && visRows.every(r => _adminSelectedEmails.has(r.dataset.email));
            selectAllChk.indeterminate = !selectAllChk.checked && _adminSelectedEmails.size > 0;
          }
        });
        chkTd.appendChild(chk);
        tr.appendChild(chkTd);

        const cells = [
          escapeHtml(u.name || ''),
          escapeHtml(u.email || ''),
          `<span style="text-transform:capitalize;">${escapeHtml(u.role || 'student')}</span>`,
          escapeHtml(u.class_name || '—'),
          escapeHtml(u.created_at || '—'),
          escapeHtml(u.last_sign_in || '—'),
          `<span class="stat-ip">${escapeHtml(u.last_ip || '—')}</span>`,
          `<span class="stat-storage">${_formatBytes(u.storage_bytes)}</span>`,
          String(u.file_count ?? 0),
          u.enabled ? '✅ Active' : '🔒 Disabled',
        ];
        cells.forEach(html => {
          const td = document.createElement('td');
          td.innerHTML = html;
          tr.appendChild(td);
        });

        // Actions cell
        const actTd = document.createElement('td');
        actTd.style.cssText = 'white-space:nowrap;';
        const resetBtn = document.createElement('button');
        resetBtn.className = 'btn secondary';
        resetBtn.style.cssText = 'font-size:10px;padding:2px 5px;margin:1px;';
        resetBtn.textContent = 'Reset PW';
        resetBtn.addEventListener('click', () => adminResetPassword(u.email));

        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'btn secondary';
        toggleBtn.style.cssText = 'font-size:10px;padding:2px 5px;margin:1px;';
        toggleBtn.textContent = u.enabled ? 'Disable' : 'Enable';
        toggleBtn.addEventListener('click', () => adminToggleUserAndReload(u.email, !u.enabled));

        const clearBtn = document.createElement('button');
        clearBtn.className = 'btn secondary';
        clearBtn.style.cssText = 'font-size:10px;padding:2px 5px;margin:1px;';
        clearBtn.title = 'Delete all files for this user without viewing them';
        clearBtn.textContent = '🗑 Files';
        clearBtn.addEventListener('click', () => adminClearUserFiles(u.email));

        const delBtn = document.createElement('button');
        delBtn.className = 'btn secondary';
        delBtn.style.cssText = 'font-size:10px;padding:2px 5px;margin:1px;color:#ef5350;';
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', () => adminDeleteUserAndReload(u.email));

        actTd.append(resetBtn, toggleBtn, clearBtn, delBtn);
        tr.appendChild(actTd);
        tbody.appendChild(tr);
      };
      usersToRender.forEach(appendAdminUserRow);
      if (_adminUsersData.length > ADMIN_USERS_RENDER_LIMIT) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 12;
        td.style.textAlign = 'center';
        td.style.padding = '12px';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn secondary';
        btn.textContent = `Show all ${_adminUsersData.length} users (${_adminUsersData.length - ADMIN_USERS_RENDER_LIMIT} hidden)`;
        btn.addEventListener('click', () => {
          tbody.innerHTML = '';
          _adminUsersData.forEach(appendAdminUserRow);
        });
        td.appendChild(btn);
        tr.appendChild(td);
        tbody.appendChild(tr);
      }

      const summary = document.getElementById('adminUsersSummary');
      if (summary) summary.textContent = `${_adminUsersData.length} user(s) total`;
      filterAdminUsersTable();

      const selectAllChk = document.getElementById('adminSelectAllChk');
      if (selectAllChk) {
        selectAllChk.checked = false;
        selectAllChk.indeterminate = false;
      }
    }

    async function adminToggleUserAndReload(email, enable) {
      const res = await fetch('/api/admin/users/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN_TOKEN },
        body: JSON.stringify({ email, enabled: enable })
      });
      const j = await res.json().catch(() => ({}));
      if (j?.ok) await loadAdminUsersModal();
      else alert(j?.error || 'Failed');
    }

    async function adminClearUserFiles(email) {
      if (!confirm(`Delete ALL files for ${email}? This cannot be undone. The account itself will remain.`)) return;
      const res = await fetch('/api/admin/users/clear-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN_TOKEN },
        body: JSON.stringify({ email })
      });
      const j = await res.json().catch(() => ({}));
      if (j?.ok) { await loadAdminUsersModal(); alert('Files cleared.'); }
      else alert(j?.error || 'Failed');
    }

    async function adminDeleteUserAndReload(email) {
      if (!confirm(`Permanently delete ${email} and ALL their files? This cannot be undone.`)) return;
      const res = await fetch('/api/admin/users/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN_TOKEN },
        body: JSON.stringify({ email })
      });
      const j = await res.json().catch(() => ({}));
      if (j?.ok) { _adminSelectedEmails.delete(email); await loadAdminUsersModal(); }
      else alert(j?.error || 'Failed');
    }

    // Wire up admin users modal buttons
    document.getElementById('adminUsersBtn')?.addEventListener('click', () => {
      document.getElementById('adminUsersModal').style.display = 'flex';
      loadAdminUsersModal();
    });
    document.getElementById('adminUsersCloseBtn')?.addEventListener('click', () => {
      document.getElementById('adminUsersModal').style.display = 'none';
    });
    document.getElementById('adminUsersRefreshBtn')?.addEventListener('click', loadAdminUsersModal);
    document.getElementById('serverHealthBtn')?.addEventListener('click', () => {
      document.getElementById('serverHealthModal').style.display = 'flex';
      loadServerHealth();
    });
    document.getElementById('serverHealthCloseBtn')?.addEventListener('click', () => {
      document.getElementById('serverHealthModal').style.display = 'none';
    });
    document.getElementById('serverHealthRefreshBtn')?.addEventListener('click', loadServerHealth);

    document.getElementById('adminSelectAllChk')?.addEventListener('change', (e) => {
      const checked = e.target.checked;
      const rows = [...document.querySelectorAll('#adminUsersStatsBody tr[data-email]')].filter(r => r.style.display !== 'none');
      rows.forEach(tr => {
        const chk = tr.querySelector('input[type=checkbox]');
        if (chk) chk.checked = checked;
        if (checked) {
          _adminSelectedEmails.add(tr.dataset.email);
          tr.classList.add('selected-row');
        } else {
          _adminSelectedEmails.delete(tr.dataset.email);
          tr.classList.remove('selected-row');
        }
      });
      _updateAdminBulkButtons();
    });

    document.getElementById('adminBulkEnableBtn')?.addEventListener('click', async () => {
      const emails = [..._adminSelectedEmails];
      if (!emails.length) return;
      if (!confirm(`Enable ${emails.length} account(s)?`)) return;
      const res = await fetch('/api/admin/users/bulk-toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN_TOKEN },
        body: JSON.stringify({ emails, enabled: true })
      });
      const j = await res.json().catch(() => ({}));
      if (j?.ok) { _adminSelectedEmails.clear(); await loadAdminUsersModal(); }
      else alert(j?.error || 'Failed');
    });

    document.getElementById('adminBulkDisableBtn')?.addEventListener('click', async () => {
      const emails = [..._adminSelectedEmails];
      if (!emails.length) return;
      if (!confirm(`Disable ${emails.length} account(s)?`)) return;
      const res = await fetch('/api/admin/users/bulk-toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN_TOKEN },
        body: JSON.stringify({ emails, enabled: false })
      });
      const j = await res.json().catch(() => ({}));
      if (j?.ok) { _adminSelectedEmails.clear(); await loadAdminUsersModal(); }
      else alert(j?.error || 'Failed');
    });

    document.getElementById('adminBulkClearFilesBtn')?.addEventListener('click', async () => {
      const emails = [..._adminSelectedEmails];
      if (!emails.length) return;
      if (!confirm(`Delete ALL files for ${emails.length} selected account(s)? Accounts remain active. This cannot be undone.`)) return;
      const res = await fetch('/api/admin/users/bulk-clear-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN_TOKEN },
        body: JSON.stringify({ emails })
      });
      const j = await res.json().catch(() => ({}));
      if (j?.ok) { _adminSelectedEmails.clear(); await loadAdminUsersModal(); alert(`Files cleared for ${j.cleared?.length ?? 0} account(s).`); }
      else alert(j?.error || 'Failed');
    });

    document.getElementById('adminBulkDeleteBtn')?.addEventListener('click', async () => {
      const emails = [..._adminSelectedEmails];
      if (!emails.length) return;
      if (!confirm(`Permanently DELETE ${emails.length} account(s) and ALL their files? This cannot be undone.`)) return;
      const res = await fetch('/api/admin/users/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN_TOKEN },
        body: JSON.stringify({ emails })
      });
      const j = await res.json().catch(() => ({}));
      if (j?.ok) { _adminSelectedEmails.clear(); await loadAdminUsersModal(); }
      else alert(j?.error || 'Failed');
    });

    function teacherStudentActionsHtml(classId, student) {
      return `
        <div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:6px;">
          <button class="btn secondary cls-reset-btn" data-class="${escapeHtml(classId)}" data-email="${escapeHtml(student.email)}" style="font-size:11px; padding:3px 8px;">Reset PW</button>
          <button class="btn secondary cls-toggle-btn" data-class="${escapeHtml(classId)}" data-email="${escapeHtml(student.email)}" data-enable="${!student.enabled}" style="font-size:11px; padding:3px 8px;">${student.enabled ? 'Lock' : 'Unlock'}</button>
          <button class="btn stop cls-remove-btn" data-class="${escapeHtml(classId)}" data-email="${escapeHtml(student.email)}" style="font-size:11px; padding:3px 8px;">Remove</button>
        </div>`;
    }

    function renderTeacherClassManagement() {
      const wrap = document.getElementById('teacherClassList');
      const activeSelect = document.getElementById('teacherClassesActiveSelect');
      if (!wrap) return;
      const canShowAiToggle = !!currentConfig?.ai_explainer_enabled;
      if (!teacherClasses.length) {
        if (activeSelect) activeSelect.innerHTML = '';
        wrap.innerHTML = '<div style="color:#888; font-size:12px; padding:8px 0;">No classes yet. Create one above to get started.</div>';
        return;
      }
      if (activeSelect) {
        activeSelect.innerHTML = teacherClasses.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)} (${escapeHtml(c.join_code)})</option>`).join('');
      }
      const selectedClassId = currentTeacherClassId || teacherClasses[0]?.id;
      const activeClass = teacherClasses.find(c => c.id === selectedClassId) || teacherClasses[0];
      currentTeacherClassId = activeClass?.id || null;
      syncTeacherDashboardClassSelectors();
      const aiToggleTemplate = (cls) => canShowAiToggle
        ? `<label style="font-size:12px;"><input type="checkbox" class="cls-ai" data-class="${escapeHtml(cls.id)}" ${cls.settings?.ai_enabled ? 'checked' : ''}> AI enabled</label>`
        : '';
      wrap.innerHTML = activeClass ? `
        <div class="teacher-dash-class-card">
          <div class="teacher-dash-class-card-header">
            <div>
              <div class="teacher-dash-class-name">${escapeHtml(activeClass.name)}</div>
              <div class="teacher-dash-class-code">Join code: <strong>${escapeHtml(activeClass.join_code)}</strong> · ${activeClass.students?.length || 0} student(s)</div>
            </div>
            <div style="display:flex; gap:6px; flex-wrap:wrap;">
              <button class="btn stop delete-class-btn" data-class="${escapeHtml(activeClass.id)}" data-name="${escapeHtml(activeClass.name)}" style="font-size:12px;">Delete</button>
            </div>
          </div>
          <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:10px;">
            ${aiToggleTemplate(activeClass)}
            <label style="font-size:12px;"><input type="checkbox" class="cls-wiki" data-class="${escapeHtml(activeClass.id)}" ${activeClass.settings?.wiki_enabled ? 'checked' : ''}> Wiki enabled</label>
            <button class="btn secondary save-class-settings-btn" data-class="${escapeHtml(activeClass.id)}" style="font-size:12px;">Save Settings</button>
          </div>
          <div style="margin-bottom:10px;">
            <label style="font-size:12px; margin:0 0 4px; display:block;">AI Grading Rigor: <span class="cls-rigor-label" data-class="${escapeHtml(activeClass.id)}">${rigorLevelLabel(activeClass.settings?.ai_grading_rigor || 5)}</span> (${activeClass.settings?.ai_grading_rigor || 5}/10)</label>
            <input type="range" min="1" max="10" value="${activeClass.settings?.ai_grading_rigor || 5}" class="cls-rigor" data-class="${escapeHtml(activeClass.id)}" style="width:100%;">
          </div>
          <input type="text" class="cls-wiki-url" data-class="${escapeHtml(activeClass.id)}" value="${escapeHtml(activeClass.settings?.wiki_url || '')}" placeholder="Class wiki URL (optional)" style="width:100%; margin-bottom:8px; padding:8px; background:var(--theme-input-bg); color:var(--theme-text); border:1px solid var(--theme-border-mid); border-radius:8px; font-size:12px;">
          <textarea class="cls-wiki-html" data-class="${escapeHtml(activeClass.id)}" placeholder="Class wiki HTML" style="width:100%; margin-bottom:8px; min-height:70px; background:var(--theme-input-bg); color:var(--theme-text); border:1px solid var(--theme-border-mid); border-radius:8px; padding:8px; font-size:12px;">${escapeHtml(activeClass.settings?.wiki_html || '')}</textarea>
          <div style="font-size:13px; font-weight:600; color:var(--columbia-blue); margin-bottom:6px;">Students</div>
          ${(activeClass.students || []).map(student => `
            <div class="teacher-dash-student-row">
              <span class="teacher-dash-student-name">${escapeHtml(student.name || student.email)}</span>
              <span class="teacher-dash-student-email">${escapeHtml(student.email)}</span>
              ${teacherStudentActionsHtml(activeClass.id, student)}
            </div>
          `).join('') || '<div style="color:#888; font-size:12px;">No students enrolled.</div>'}
        </div>
      ` : '';
      wrap.querySelectorAll('.delete-class-btn').forEach(btn => btn.addEventListener('click', async () => {
        const classId = btn.dataset.class;
        const className = btn.dataset.name || 'this class';
        if (!confirm(`Delete class "${className}"? Students in this class will become unassigned.`)) return;
        const res = await fetch('/api/teacher/classes/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Teacher-Token': TEACHER_TOKEN },
          body: JSON.stringify({ classId })
        });
        const j = await res.json().catch(() => ({}));
        if (!j?.ok) return alert(j?.error || 'Failed to delete class');
        await loadTeacherClasses();
        syncTeacherDashboardClassSelectors();
        renderTeacherClassManagement();
        renderClassSelector();
        await loadAssignments();
      }));
      wrap.querySelectorAll('.save-class-settings-btn').forEach(btn => btn.addEventListener('click', async () => {
        const classId = btn.dataset.class;
        const ai = canShowAiToggle ? wrap.querySelector(`.cls-ai[data-class="${CSS.escape(classId)}"]`)?.checked : undefined;
        const wiki = wrap.querySelector(`.cls-wiki[data-class="${CSS.escape(classId)}"]`)?.checked;
        const wikiUrl = wrap.querySelector(`.cls-wiki-url[data-class="${CSS.escape(classId)}"]`)?.value || '';
        const wikiHtml = wrap.querySelector(`.cls-wiki-html[data-class="${CSS.escape(classId)}"]`)?.value || '';
        const rigor = parseInt(wrap.querySelector(`.cls-rigor[data-class="${CSS.escape(classId)}"]`)?.value || '5', 10) || 5;
        const settingsPayload = { wiki_enabled: !!wiki, wiki_url: wikiUrl.trim(), wiki_html: wikiHtml, ai_grading_rigor: rigor };
        if (canShowAiToggle) settingsPayload.ai_enabled = !!ai;
        const res = await fetch('/api/teacher/classes/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Teacher-Token': TEACHER_TOKEN },
          body: JSON.stringify({ classId, settings: settingsPayload })
        });
        const j = await res.json().catch(() => ({}));
        if (!j?.ok) return alert(j?.error || 'Failed to save class settings');
        await loadTeacherClasses();
        syncTeacherDashboardClassSelectors();
        renderTeacherClassManagement();
        renderClassSelector();
      }));
      wrap.querySelectorAll('.cls-rigor').forEach(slider => slider.addEventListener('input', () => {
        const classId = slider.dataset.class;
        const label = wrap.querySelector(`.cls-rigor-label[data-class="${CSS.escape(classId)}"]`);
        if (label) label.textContent = rigorLevelLabel(slider.value);
      }));
      wrap.querySelectorAll('.cls-remove-btn').forEach(btn => btn.addEventListener('click', async () => {
        const res = await fetch('/api/teacher/classes/remove-student', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Teacher-Token': TEACHER_TOKEN },
          body: JSON.stringify({ classId: btn.dataset.class, studentEmail: btn.dataset.email })
        });
        const j = await res.json().catch(() => ({}));
        if (!j?.ok) return alert(j?.error || 'Failed to remove student');
        await loadTeacherClasses();
        syncTeacherDashboardClassSelectors();
        renderTeacherClassManagement();
      }));
      wrap.querySelectorAll('.cls-reset-btn').forEach(btn => btn.addEventListener('click', async () => {
        const res = await fetch('/api/teacher/students/reset-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Teacher-Token': TEACHER_TOKEN },
          body: JSON.stringify({ email: btn.dataset.email })
        });
        const j = await res.json().catch(() => ({}));
        if (!j?.ok) return alert(j?.error || 'Failed to reset password');
        alert(`Temporary password for ${btn.dataset.email}: ${j.temp_password}`);
      }));
      wrap.querySelectorAll('.cls-toggle-btn').forEach(btn => btn.addEventListener('click', async () => {
        const res = await fetch('/api/teacher/students/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Teacher-Token': TEACHER_TOKEN },
          body: JSON.stringify({ email: btn.dataset.email, enabled: btn.dataset.enable === 'true' })
        });
        const j = await res.json().catch(() => ({}));
        if (!j?.ok) return alert(j?.error || 'Failed to update student account');
        await loadTeacherClasses();
        syncTeacherDashboardClassSelectors();
        renderTeacherClassManagement();
      }));
    }

    function renderSkillClassChecklist(selected = []) {
      const wrap = document.getElementById('skillClassChecklist');
      if (!wrap) return;
      if (!teacherClasses.length) {
        wrap.innerHTML = '<div style="color:#888; font-size:12px;">Create a class first.</div>';
        return;
      }
      wrap.innerHTML = teacherClasses.map(c => `
        <label style="display:flex; align-items:flex-start; gap:8px; margin-bottom:6px; font-size:12px;">
          <input type="checkbox" class="skill-class-check" value="${escapeHtml(c.id)}" ${selected.includes(c.id) ? 'checked' : ''}>
          <span>${escapeHtml(c.name)} <span style="color:var(--theme-text-dim);">(${escapeHtml(c.join_code)})</span></span>
        </label>
      `).join('');
    }

    function selectedSkillClassIds() {
      return [...document.querySelectorAll('#skillClassChecklist .skill-class-check:checked')]
        .map(cb => cb.value)
        .filter(Boolean);
    }

    function resetSkillForm() {
      editingSkillId = null;
      const saveBtn = document.getElementById('saveSkillBtn');
      if (saveBtn) saveBtn.textContent = 'Save Skill';
      const nameInput = document.getElementById('skillNameInput');
      const descInput = document.getElementById('skillDescriptionInput');
      if (nameInput) nameInput.value = '';
      if (descInput) descInput.value = '';
      renderSkillClassChecklist([]);
    }

    function editSkill(skillId) {
      const skill = teacherSkills.find(s => s.id === skillId);
      if (!skill) return;
      editingSkillId = skill.id;
      const saveBtn = document.getElementById('saveSkillBtn');
      if (saveBtn) saveBtn.textContent = 'Update Skill';
      const nameInput = document.getElementById('skillNameInput');
      const descInput = document.getElementById('skillDescriptionInput');
      if (nameInput) nameInput.value = skill.name || '';
      if (descInput) descInput.value = skill.description || '';
      renderSkillClassChecklist(skill.class_ids || []);
    }

    async function persistTeacherSkillOrder() {
      if (!TEACHER_TOKEN) return false;
      const orderedSkillIds = teacherSkills.map(skill => skill.id).filter(Boolean);
      if (!orderedSkillIds.length) return true;
      const res = await fetch('/api/teacher/skills/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Teacher-Token': TEACHER_TOKEN },
        body: JSON.stringify({ orderedSkillIds })
      });
      const j = await res.json().catch(() => ({}));
      if (!j?.ok) {
        alert(j?.error || 'Failed to save skill order');
        return false;
      }
      return true;
    }

    async function renderTeacherSkillsPage() {
      const list = document.getElementById('teacherSkillList');
      if (!list) return;
      const editingSkill = editingSkillId ? teacherSkills.find(s => s.id === editingSkillId) : null;
      const selectedClassIds = editingSkill?.class_ids || [];
      renderSkillClassChecklist(selectedClassIds);
      if (!teacherSkills.length) {
        list.innerHTML = '<div style="color:#888; font-size:12px;">No skill tags created yet.</div>';
        return;
      }
      list.innerHTML = teacherSkills.map(skill => `
        <div class="skill-card" data-skill-id="${escapeHtml(skill.id)}" draggable="true">
          <div style="display:flex; align-items:center;">
            <span class="skill-card-handle" title="Drag to reorder">↕</span>
            <h4 style="margin:0;">${escapeHtml(skill.name || '')}</h4>
          </div>
          <div style="font-size:12px; color:var(--theme-text); white-space:pre-wrap;">${escapeHtml(skill.description || 'No description provided.')}</div>
          <div class="skill-class-pills">
            ${(skill.class_names || []).map(name => `<span class="skill-chip">${escapeHtml(name)}</span>`).join('') || '<span style="font-size:11px; color:var(--theme-text-dim);">Not assigned to classes</span>'}
          </div>
          <div style="display:flex; gap:8px; margin-top:8px;">
            <button class="btn secondary skill-edit-btn" data-id="${escapeHtml(skill.id)}" style="font-size:12px;">Edit</button>
            <button class="btn stop skill-delete-btn" data-id="${escapeHtml(skill.id)}" style="font-size:12px;">Delete</button>
          </div>
        </div>
      `).join('');
      const cards = [...list.querySelectorAll('.skill-card')];
      let draggedId = null;
      cards.forEach(card => {
        const skillId = card.dataset.skillId;
        card.addEventListener('dragstart', (e) => {
          draggedId = skillId;
          card.classList.add('dragging');
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', skillId || '');
          }
        });
        card.addEventListener('dragend', () => {
          card.classList.remove('dragging');
          cards.forEach(c => c.classList.remove('drag-over'));
        });
        card.addEventListener('dragover', (e) => {
          e.preventDefault();
          if (!draggedId || draggedId === skillId) return;
          card.classList.add('drag-over');
        });
        card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
        card.addEventListener('drop', async (e) => {
          e.preventDefault();
          card.classList.remove('drag-over');
          if (!draggedId || draggedId === skillId) return;
          const fromIndex = teacherSkills.findIndex(s => s.id === draggedId);
          const toIndex = teacherSkills.findIndex(s => s.id === skillId);
          if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;
          const [moved] = teacherSkills.splice(fromIndex, 1);
          teacherSkills.splice(toIndex, 0, moved);
          const saved = await persistTeacherSkillOrder();
          if (!saved) {
            await loadTeacherSkills();
          }
          renderTeacherSkillsPage();
          setAssignmentStatus('Skill order updated');
        });
      });
      list.querySelectorAll('.skill-edit-btn').forEach(btn => btn.addEventListener('click', () => editSkill(btn.dataset.id)));
      list.querySelectorAll('.skill-delete-btn').forEach(btn => btn.addEventListener('click', async () => {
        if (!confirm('Delete this skill tag?')) return;
        const res = await fetch('/api/teacher/skills/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Teacher-Token': TEACHER_TOKEN },
          body: JSON.stringify({ skillId: btn.dataset.id })
        });
        const j = await res.json().catch(() => ({}));
        if (!j?.ok) return alert(j?.error || 'Failed to delete skill');
        await loadTeacherSkills();
        resetSkillForm();
        renderTeacherSkillsPage();
      }));
    }

    async function saveTeacherSkillFromForm() {
      if (!TEACHER_TOKEN) return;
      const wasEditing = !!editingSkillId;
      const name = (document.getElementById('skillNameInput')?.value || '').trim();
      const description = (document.getElementById('skillDescriptionInput')?.value || '').trim();
      const classIds = selectedSkillClassIds();
      if (!name) return alert('Skill name is required.');
      const url = editingSkillId ? '/api/teacher/skills/update' : '/api/teacher/skills/create';
      const payload = editingSkillId
        ? { skillId: editingSkillId, name, description, classIds }
        : { name, description, classIds };
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Teacher-Token': TEACHER_TOKEN },
        body: JSON.stringify(payload)
      });
      const j = await res.json().catch(() => ({}));
      if (!j?.ok) return alert(j?.error || 'Failed to save skill');
      await loadTeacherSkills();
      resetSkillForm();
      renderTeacherSkillsPage();
      setAssignmentStatus(wasEditing ? 'Skill updated' : 'Skill created');
    }

    async function renderClassReports() {
      const rosterPane = document.getElementById('class-roster-pane');
      const scorePane = document.getElementById('score-overview-pane');
      const skillsPane = document.getElementById('skills-mastery-pane');
      if (!rosterPane || !scorePane || !skillsPane) return;
      if (!currentTeacherClassId) {
        rosterPane.innerHTML = '<div style="color:#888;">Select a class to view reports.</div>';
        scorePane.innerHTML = '';
        skillsPane.innerHTML = '';
        return;
      }
      rosterPane.innerHTML = '<div style="color:#888;">Loading class report…</div>';
      const res = await fetch(`/api/teacher/classes/${encodeURIComponent(currentTeacherClassId)}/mastery`, {
        headers: { 'X-Teacher-Token': TEACHER_TOKEN }
      });
      const data = await res.json().catch(() => ({}));
      if (!data.ok) {
        rosterPane.innerHTML = `<div style="color:#ef5350;">${escapeHtml(data.error || 'Failed to load class report.')}</div>`;
        scorePane.innerHTML = '';
        skillsPane.innerHTML = '';
        return;
      }
      currentMasteryData = data.report;
      const assignments = currentMasteryData.assignments || [];
      const students = currentMasteryData.students || [];
      const tags = currentMasteryData.skillTags || [];
      const skillDescriptions = currentMasteryData.skillDescriptions || {};
      const classMeta = currentMasteryData.class || {};
      const classSettings = (teacherClasses.find(c => c.id === classMeta.id)?.settings) || {};
      const activeStudents = activeStudentsByClass[currentTeacherClassId] || new Set();
      const inQuizStudents = inQuizStudentsByClass[currentTeacherClassId] || new Set();
      const lastSignInMap = lastSignInByClass[currentTeacherClassId] || {};

      rosterPane.innerHTML = `
        <div class="teacher-split-layout">
          <div class="teacher-panel-card">
            <h4>Class Snapshot</h4>
            <div style="font-size:12px; color:var(--theme-text); margin-bottom:8px;">${escapeHtml(classMeta.name || 'Class')}</div>
            <div style="font-size:12px; color:var(--theme-text); margin-bottom:6px;">AI enabled: ${classSettings.ai_enabled ? 'Yes' : 'No'}</div>
            <div style="font-size:12px; color:var(--theme-text); margin-bottom:6px;">Wiki enabled: ${classSettings.wiki_enabled ? 'Yes' : 'No'}</div>
            <div style="font-size:12px; color:var(--theme-text);">Skills tracked: ${escapeHtml(tags.join(', ') || 'None')}</div>
          </div>
          <div class="teacher-panel-card">
            <h4>Student Roster</h4>
            <div class="student-list-compact">
              ${students.map(s => {
                const email = (s.email || '').toLowerCase();
                const isInQuiz = inQuizStudents.has(email);
                const isOnline = activeStudents.has(email);
                const rowClass = isInQuiz ? 'teacher-roster-row-in-assignment' : (isOnline ? 'teacher-roster-row-online' : 'teacher-roster-row-offline');
                const rawLastSignIn = String(lastSignInMap[email] || '').trim();
                const lastSignInLabel = rawLastSignIn
                  ? (() => {
                    const parsed = new Date(rawLastSignIn);
                    return Number.isNaN(parsed.getTime()) ? rawLastSignIn : parsed.toLocaleString();
                  })()
                  : 'Never';
                return `
                <div class="${rowClass}" data-roster-email="${escapeHtml(email)}" style="border:1px solid; border-radius:8px; padding:8px;">
                  <div style="font-weight:700;">${escapeHtml(s.name || s.email)}</div>
                  <div style="font-size:12px; color:var(--theme-text-dim);">${escapeHtml(s.email || '')}</div>
                  <div style="font-size:11px; color:var(--theme-text-dim); margin-top:4px;">Last Sign In: <span data-last-sign-in>${escapeHtml(lastSignInLabel)}</span></div>
                </div>`;
              }).join('') || '<div style="color:#888;">No students enrolled.</div>'}
            </div>
          </div>
        </div>
      `;

      scorePane.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; gap:8px; flex-wrap:wrap;">
          <div style="font-size:12px; color:var(--theme-text);">Students and assignment score percentages for selected class.</div>
          <div style="display:flex; gap:8px;">
            <button class="btn secondary" id="masteryExportCsvBtn">Export CSV</button>
            <button class="btn secondary" id="masteryAllPdfBtn">All Skills PDF</button>
          </div>
        </div>
        <div class="mastery-grid">
          <table>
            <thead><tr><th>Student</th>${assignments.map(a => `<th>${escapeHtml(a.name)}</th>`).join('')}</tr></thead>
            <tbody>
              ${students.map(s => `
                <tr>
                  <td>${escapeHtml(s.name || s.email)}</td>
                  ${assignments.map(a => {
                    const score = s.assignmentScores?.[a.name]?.percent;
                    return `<td class="${masteryBandClass(score)}">${score === null || score === undefined ? 'Untested' : `${Math.round(score)}%`}</td>`;
                  }).join('')}
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
      scorePane.querySelector('#masteryExportCsvBtn')?.addEventListener('click', exportMasteryCsv);
      scorePane.querySelector('#masteryAllPdfBtn')?.addEventListener('click', () => openMasteryPdfReport('all'));

      skillsPane.innerHTML = `
        <div class="mastery-skills-layout">
          <div>
            <div class="teacher-panel-card">
              <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:8px;">
                <label style="margin:0;">Skill</label>
                <select id="masteryAnalyticsTagSelect" style="min-width:220px; padding:8px; background:var(--theme-input-bg); color:var(--theme-text); border:1px solid var(--theme-border-mid); border-radius:8px;">
                  ${tags.length ? tags.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('') : '<option value="">No skills</option>'}
                </select>
                <button class="btn secondary" id="masterySkillPdfBtn">Selected Skill PDF</button>
              </div>
              <div id="masterySkillDescription" class="skill-description-panel"></div>
              <div style="font-weight:700; margin-bottom:8px; color:var(--columbia-blue);">Selected Skill Distribution</div>
              <canvas id="masteryTagChart" height="220"></canvas>
              <div class="chart-legend-note" id="masteryTagLegendNote"></div>
            </div>
            <div class="teacher-panel-card" style="margin-top:10px;">
              <div style="font-weight:700; margin-bottom:8px; color:var(--columbia-blue);">All Skills Overview (Average Mastery)</div>
              <canvas id="masterySummaryChart" height="220"></canvas>
              <div class="chart-legend-note" id="masterySummaryLegendNote"></div>
              <div id="masteryAverageText" style="margin-top:10px; font-size:12px; color:var(--theme-text);"></div>
            </div>
          </div>
          <div>
            <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:8px;">
              <label style="margin:0;">Feedback Scope</label>
              <select id="masteryFeedbackScopeSelect" style="min-width:180px; padding:8px; background:var(--theme-input-bg); color:var(--theme-text); border:1px solid var(--theme-border-mid); border-radius:8px;">
                <option value="all">All skills</option>
                <option value="tag">Specific skill</option>
              </select>
              <button class="btn secondary" id="masteryAiFeedbackBtn">AI Feedback</button>
              <button class="btn secondary" id="masteryAiFeedbackCopyBtn">Copy Feedback</button>
              <button class="btn secondary" id="masteryAiFeedbackSaveBtn">Save to Reports</button>
            </div>
            <div class="mastery-grid">
              <table>
                <thead><tr><th>Student</th>${tags.map(t => `<th>${escapeHtml(t)}</th>`).join('')}</tr></thead>
                <tbody>
                  ${students.map(s => `
                    <tr>
                      <td>${escapeHtml(s.name || s.email)}</td>
                      ${tags.map(t => {
                        const score = s.skillScores?.[t];
                        return `<td class="${masteryBandClass(score)}">${score === null || score === undefined ? 'Untested' : `${Math.round(score)}%`}</td>`;
                      }).join('')}
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
            <div id="masteryAiFeedbackOutput" style="margin-top:10px; color:#ddd; border:1px solid var(--theme-border-mid); border-radius:8px; background:var(--theme-input-bg); padding:12px; min-height:110px;"></div>
          </div>
        </div>
      `;
      skillsPane.querySelector('#masteryAnalyticsTagSelect')?.addEventListener('change', () => renderMasteryCharts());
      skillsPane.querySelector('#masterySkillPdfBtn')?.addEventListener('click', () => openMasteryPdfReport('tag'));
      skillsPane.querySelector('#masteryFeedbackScopeSelect')?.addEventListener('change', () => {
        const scope = skillsPane.querySelector('#masteryFeedbackScopeSelect')?.value || 'all';
        const tagSelect = skillsPane.querySelector('#masteryAnalyticsTagSelect');
        if (tagSelect) tagSelect.disabled = scope !== 'tag';
      });
      skillsPane.querySelector('#masteryAiFeedbackBtn')?.addEventListener('click', requestMasteryFeedback);
      skillsPane.querySelector('#masteryAiFeedbackCopyBtn')?.addEventListener('click', async () => {
        const text = document.getElementById('masteryAiFeedbackOutput')?.innerText || '';
        if (!text.trim()) return;
        try { await navigator.clipboard.writeText(text); } catch {}
      });
      skillsPane.querySelector('#masteryAiFeedbackSaveBtn')?.addEventListener('click', saveMasteryFeedbackToReportFile);
      const descriptionEl = skillsPane.querySelector('#masterySkillDescription');
      if (descriptionEl) {
        const firstTag = tags[0] || '';
        descriptionEl.textContent = firstTag
          ? (skillDescriptions[firstTag] || 'No description provided for this skill.')
          : 'No skill selected.';
      }
      renderMasteryCharts();
    }

    async function renderMasteryCharts() {
      try { await window.EagleIDE?.ensureChart?.(); } catch (e) { console.warn('Chart.js unavailable', e); return; }
      const tagSelect = document.getElementById('masteryAnalyticsTagSelect');
      const selectedTag = tagSelect?.value;
      const tagData = currentMasteryData?.analytics?.tags?.[selectedTag] || {};
      const summary = currentMasteryData?.analytics?.summary || {};
      const skillDescriptions = currentMasteryData?.skillDescriptions || {};
      const legendItems = [
        { label: 'Red', color: '#d32f2f' },
        { label: 'Bronze', color: '#cd7f32' },
        { label: 'Silver', color: '#c0c0c0' },
        { label: 'Gold', color: '#ffd700' },
        { label: 'Untested', color: '#555' }
      ];
      const descriptionEl = document.getElementById('masterySkillDescription');
      if (descriptionEl) {
        descriptionEl.textContent = selectedTag
          ? (skillDescriptions[selectedTag] || 'No description provided for this skill.')
          : 'No skill selected.';
      }
      const averageText = document.getElementById('masteryAverageText');
      if (averageText) {
        const values = [];
        (currentMasteryData?.students || []).forEach(student => {
          Object.values(student?.skillScores || {}).forEach(val => {
            if (val !== null && val !== undefined) values.push(Number(val));
          });
        });
        const avg = values.length ? (values.reduce((sum, n) => sum + n, 0) / values.length) : null;
        averageText.textContent = `Average mastery across all skills: ${avg === null ? 'No scored data yet' : `${avg.toFixed(1)}%`}`;
      }
      const setLegendNote = (elementId, includeUntested = true) => {
        const legendEl = document.getElementById(elementId);
        if (!legendEl) return;
        const items = includeUntested ? legendItems : legendItems.filter(item => item.label !== 'Untested');
        legendEl.innerHTML = items.map(item => `
          <span><i class="chart-legend-swatch" style="background:${item.color};"></i>${item.label}</span>
        `).join('');
      };
      const createPie = (canvasId, payload, includeUntested = true, existingChartRef = null) => {
        const ctx = document.getElementById(canvasId)?.getContext('2d');
        if (!ctx || !window.Chart) return existingChartRef;
        if (existingChartRef) existingChartRef.destroy();
        const labels = includeUntested ? ['Red', 'Bronze', 'Silver', 'Gold', 'Untested'] : ['Red', 'Bronze', 'Silver', 'Gold'];
        const values = includeUntested
          ? [payload.red || 0, payload.bronze || 0, payload.silver || 0, payload.gold || 0, payload.untested || 0]
          : [payload.red || 0, payload.bronze || 0, payload.silver || 0, payload.gold || 0];
        const colors = includeUntested ? ['#d32f2f', '#cd7f32', '#c0c0c0', '#ffd700', '#555'] : ['#d32f2f', '#cd7f32', '#c0c0c0', '#ffd700'];
        return new Chart(ctx, {
          type: 'pie',
          data: { labels, datasets: [{ data: values, backgroundColor: colors }] },
          options: {
            plugins: {
              legend: {
                display: false
              }
            }
          }
        });
      };
      setLegendNote('masteryTagLegendNote', true);
      setLegendNote('masterySummaryLegendNote', false);
      masteryTagChart = createPie('masteryTagChart', tagData, true, masteryTagChart);
      masterySummaryChart = createPie('masterySummaryChart', summary, false, masterySummaryChart);
    }

    async function openMasteryPdfReport(scope = 'all') {
      try { await window.EagleIDE?.ensureJsPDF?.(); } catch (e) { console.warn('jsPDF unavailable', e); return; }
      if (!currentMasteryData || !window.jspdf?.jsPDF) return;
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ unit: 'pt', format: 'letter' });
      const legendItems = [
        { label: 'Red', color: [211, 47, 47] },
        { label: 'Bronze', color: [205, 127, 50] },
        { label: 'Silver', color: [160, 160, 160] },
        { label: 'Gold', color: [255, 215, 0] },
        { label: 'Untested', color: [85, 85, 85] }
      ];
      const margin = 42;
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const contentWidth = pageWidth - (margin * 2);
      const className = currentMasteryData?.class?.name || 'Class';
      const tag = document.getElementById('masteryAnalyticsTagSelect')?.value || '';
      const skillDescriptions = currentMasteryData?.skillDescriptions || {};
      const students = currentMasteryData?.students || [];
      const addFooter = () => {
        const totalPages = doc.getNumberOfPages();
        for (let i = 1; i <= totalPages; i++) {
          doc.setPage(i);
          doc.setFontSize(9);
          doc.setTextColor(110);
          doc.text(`Page ${i} of ${totalPages}`, pageWidth - margin, pageHeight - 16, { align: 'right' });
        }
      };
      let y = margin;
      const lineHeight = 16;
      const ensureSpace = (need = lineHeight) => {
        if (y + need > pageHeight - 36) {
          doc.addPage();
          y = margin;
        }
      };
      const addTitle = (title, subtitle = '') => {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(20);
        doc.setTextColor(22, 46, 82);
        doc.text(title, margin, y);
        y += 24;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(11);
        doc.setTextColor(60);
        doc.text(`Class: ${className}`, margin, y);
        y += 14;
        doc.text(`Generated: ${new Date().toLocaleString()}`, margin, y);
        if (subtitle) {
          y += 14;
          doc.text(subtitle, margin, y);
        }
        y += 16;
      };
      const drawChartImage = (canvasId, width = 230, height = 170) => {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        ensureSpace(height + 10);
        try {
          const dataUrl = canvas.toDataURL('image/png');
          doc.addImage(dataUrl, 'PNG', margin, y, width, height);
          y += height + 12;
        } catch (err) {
          console.warn('Failed to add chart image to PDF report.', err);
        }
      };
      const drawLegend = (includeUntested = true) => {
        const items = includeUntested ? legendItems : legendItems.filter(item => item.label !== 'Untested');
        ensureSpace(22 + (Math.ceil(items.length / 2) * 16));
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.setTextColor(30);
        doc.text('Legend', margin, y);
        y += 12;
        items.forEach((item, index) => {
          const col = index % 2;
          const row = Math.floor(index / 2);
          const baseX = margin + (col * 170);
          const baseY = y + (row * 16);
          doc.setFillColor(...item.color);
          doc.rect(baseX, baseY - 8, 10, 10, 'F');
          doc.setTextColor(30);
          doc.setFont('helvetica', 'normal');
          doc.text(item.label, baseX + 16, baseY);
        });
        y += (Math.ceil(items.length / 2) * 16) + 8;
      };
      const drawTableHeader = (headers) => {
        ensureSpace(24);
        doc.setFillColor(230, 238, 248);
        doc.rect(margin, y - 12, contentWidth, 20, 'F');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        const colWidth = contentWidth / headers.length;
        headers.forEach((header, i) => {
          doc.text(header, margin + (colWidth * i) + 4, y + 2);
        });
        y += 16;
      };
      const drawTableRow = (cells) => {
        ensureSpace(16);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        doc.setTextColor(30);
        const colWidth = contentWidth / cells.length;
        cells.forEach((cell, i) => {
          doc.text(String(cell), margin + (colWidth * i) + 4, y);
        });
        y += 14;
      };

      if (scope === 'tag') {
        addTitle(`Skill Report: ${tag || 'Selected Skill'}`);
        const description = tag ? (skillDescriptions[tag] || 'No description provided for this skill.') : 'No skill selected.';
        doc.setFillColor(240, 245, 252);
        doc.rect(margin, y - 10, contentWidth, 66, 'F');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(13);
        doc.text(tag || 'Skill', margin + 8, y + 8);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        const descriptionLines = doc.splitTextToSize(`Description: ${description}`, contentWidth - 16);
        doc.text(descriptionLines, margin + 8, y + 24);
        y += 76;
        drawChartImage('masteryTagChart', 250, 190);
        drawLegend(true);
        drawTableHeader(['Student', 'Mastery Score']);
        students.forEach(student => {
          const score = student?.skillScores?.[tag];
          drawTableRow([student?.name || student?.email || 'Student', score === null || score === undefined ? 'Untested' : `${Math.round(score)}%`]);
        });
      } else {
        addTitle('All Skills Mastery Report', 'Includes roster and average mastery across tracked skills.');
        const values = [];
        students.forEach(student => {
          Object.values(student?.skillScores || {}).forEach(v => {
            if (v !== null && v !== undefined) values.push(Number(v));
          });
        });
        const avg = values.length ? `${(values.reduce((sum, n) => sum + n, 0) / values.length).toFixed(1)}%` : 'No scored data';
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(12);
        doc.text(`Average Mastery: ${avg}`, margin, y);
        y += 18;
        drawChartImage('masterySummaryChart', 250, 190);
        drawLegend(false);
        drawTableHeader(['Student', 'Average Skill Mastery']);
        students.forEach(student => {
          const skillVals = Object.values(student?.skillScores || {}).filter(v => v !== null && v !== undefined).map(Number);
          const score = skillVals.length ? `${(skillVals.reduce((sum, n) => sum + n, 0) / skillVals.length).toFixed(1)}%` : 'Untested';
          drawTableRow([student?.name || student?.email || 'Student', score]);
        });
      }
      addFooter();
      const blob = doc.output('blob');
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    function exportMasteryCsv() {
      if (!currentMasteryData) return;
      const tags = currentMasteryData.skillTags || [];
      const rows = [['Student', ...tags]];
      (currentMasteryData.students || []).forEach(student => {
        rows.push([
          student.name || student.email || '',
          ...tags.map(tag => {
            const score = student.skillScores?.[tag];
            return score === null || score === undefined ? 'Untested' : `${Math.round(score)}%`;
          })
        ]);
      });
      const csv = rows.map(row => row.map(cell => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safeName = String(currentMasteryData.class?.name || 'class').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '');
      a.download = `${safeName || 'class'}_skill_mastery.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 500);
    }

    async function requestMasteryFeedback() {
      const out = document.getElementById('masteryAiFeedbackOutput');
      const tag = document.getElementById('masteryAnalyticsTagSelect')?.value || '';
      const scope = document.getElementById('masteryFeedbackScopeSelect')?.value || 'all';
      if (!out) return;
      out.textContent = 'Generating AI feedback…';
      try {
        const res = await fetch(`/api/teacher/classes/${encodeURIComponent(currentTeacherClassId)}/mastery-feedback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Teacher-Token': TEACHER_TOKEN },
          body: JSON.stringify({ scope, tag, ...buildAiContext() })
        });
        const data = await res.json().catch(() => ({}));
        if (!data.ok) {
          out.textContent = data.error || 'Failed to generate AI feedback.';
          return;
        }
        renderMarkdownTo(out, data.feedback || '(No feedback returned.)', 'python');
      } catch {
        out.textContent = 'Network error while generating feedback.';
      }
    }

    async function saveMasteryFeedbackToReportFile() {
      const out = document.getElementById('masteryAiFeedbackOutput');
      const text = out?.innerText || '';
      if (!text.trim()) {
        alert('Generate feedback first.');
        return;
      }
      try {
        const res = await fetch(`/api/teacher/classes/${encodeURIComponent(currentTeacherClassId)}/mastery-feedback/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Teacher-Token': TEACHER_TOKEN },
          body: JSON.stringify({ feedback: text, ...buildAiContext() })
        });
        const data = await res.json().catch(() => ({}));
        if (!data.ok) {
          alert(data.error || 'Failed to save feedback report.');
          return;
        }
        alert(`Saved to ${data.path || data.fileName || 'Reports folder'}.`);
        loadFileTree();
      } catch {
        alert('Network error while saving feedback.');
      }
    }

    // ---- File Browser ----
    let _currentFolderPath = ''; // '' = root
    let _allFileTree = [];       // full flat tree from server
    let _selectedFileItems = new Set();
    const WORKSPACE_TAB_EDITOR = 'editor';
    const WORKSPACE_TAB_FILES = 'files';
    let _workspaceTab = WORKSPACE_TAB_EDITOR;

    function setWorkspaceTab(tabName) {
      const editorTabBtn = document.getElementById('workspaceEditorTabBtn');
      const filesTabBtn = document.getElementById('workspaceFilesTabBtn');
      const editorContentStack = document.getElementById('editorContentStack');
      const title = document.getElementById('workspaceTitle');
      const isLoggedIn = isAuthenticated();
      _workspaceTab = tabName === WORKSPACE_TAB_FILES && isLoggedIn ? WORKSPACE_TAB_FILES : WORKSPACE_TAB_EDITOR;
      if (editorContentStack) editorContentStack.classList.toggle('file-browser-active', _workspaceTab === WORKSPACE_TAB_FILES);
      if (editorTabBtn) {
        const active = _workspaceTab === WORKSPACE_TAB_EDITOR;
        editorTabBtn.classList.toggle('active', active);
        editorTabBtn.setAttribute('aria-selected', active ? 'true' : 'false');
      }
      if (filesTabBtn) {
        const active = _workspaceTab === WORKSPACE_TAB_FILES;
        filesTabBtn.classList.toggle('active', active);
        filesTabBtn.setAttribute('aria-selected', active ? 'true' : 'false');
      }
      if (title) title.textContent = _workspaceTab === WORKSPACE_TAB_FILES ? 'File Browser' : 'Editor';
      if (_workspaceTab === WORKSPACE_TAB_FILES) {
        loadFileTree();
      } else {
        requestAnimationFrame(() => {
          try { window.eagleEditor?.refresh?.(); } catch {}
          try { teacherEditor?.refresh?.(); } catch {}
        });
      }
    }

    document.getElementById('workspaceEditorTabBtn')?.addEventListener('click', () => setWorkspaceTab(WORKSPACE_TAB_EDITOR));
    document.getElementById('workspaceFilesTabBtn')?.addEventListener('click', () => setWorkspaceTab(WORKSPACE_TAB_FILES));

    async function showFileBrowser() {
      if (!isAuthenticated()) return;
      setWorkspaceTab(WORKSPACE_TAB_FILES);
      try {
        await loadFileTree();
      } catch (err) {
        console.warn('Failed to load file tree after auth.', err);
      }
    }

    function hideFileBrowser() {
      setWorkspaceTab(WORKSPACE_TAB_EDITOR);
    }

    function _findItemByPath(items, path) {
      for (const item of items) {
        if (item.path === path) return item;
        if (item.type === 'folder' && item.children) {
          const found = _findItemByPath(item.children, path);
          if (found) return found;
        }
      }
      return null;
    }

    function _getItemsAtPath(tree, folderPath) {
      if (!folderPath) return tree;
      const folder = _findItemByPath(tree, folderPath);
      return folder ? (folder.children || []) : [];
    }

    function _collectTreePaths(items, out = new Set()) {
      for (const item of (items || [])) {
        if (!item?.path) continue;
        out.add(item.path);
        if (item.type === 'folder' && Array.isArray(item.children)) _collectTreePaths(item.children, out);
      }
      return out;
    }

    function _getAllFolders(items, depth = 0, out = []) {
      for (const item of (items || [])) {
        if (item?.type !== 'folder') continue;
        out.push({ path: item.path, name: item.name, depth });
        if (Array.isArray(item.children)) _getAllFolders(item.children, depth + 1, out);
      }
      return out;
    }

    function setFileStorageStats(usedBytes, limitBytes) {
      const statsEl = document.getElementById('fileStorageStats');
      if (!statsEl) return;
      const used = Number(usedBytes || 0);
      const limit = Number(limitBytes || 0);
      const remaining = Math.max(0, limit - used);
      statsEl.textContent = `Used ${_formatBytes(used)} • Remaining ${_formatBytes(remaining)}`;
    }

    async function refreshFileStorageStats() {
      const statsEl = document.getElementById('fileStorageStats');
      if (!statsEl) return;
      if (!USER_TOKEN && !TEACHER_TOKEN && !ADMIN_TOKEN) {
        statsEl.textContent = 'Storage: —';
        return;
      }
      try {
        const res = await fetch('/api/files/storage', { headers: fileAuthHeaders() });
        const j = await res.json().catch(() => ({}));
        if (!j?.ok) throw new Error(j?.error || 'Storage request failed');
        setFileStorageStats(j.used_bytes, j.limit_bytes);
      } catch {
        statsEl.textContent = 'Storage: unavailable';
      }
    }

    let _fileTreeLoadPromise = null;

    async function loadFileTree() {
      if (!USER_TOKEN && !TEACHER_TOKEN && !ADMIN_TOKEN) return;
      const treeEl = document.getElementById('fileTree');
      if (!treeEl) return;
      if (_fileTreeLoadPromise) return _fileTreeLoadPromise;
      treeEl.innerHTML = '<div class="skeleton file-tree-skeleton" aria-hidden="true"></div>';
      _fileTreeLoadPromise = (async () => {
        const res = await fetch('/api/files/list', { headers: fileAuthHeaders() });
        const j = await res.json().catch(() => ({}));
        if (!j.ok) {
          if (res.status === 401) {
            clearAuthStateMemory();
            saveAuthSession();
            updateAuthUI();
            treeEl.innerHTML = '<div style="padding:12px;color:#ef5350;">Session expired. Please sign in again.</div>';
            return;
          }
          treeEl.innerHTML = '<div style="padding:12px;color:#ef5350;">Error loading files</div>';
          return;
        }
        _allFileTree = j.files || [];
        const existingPaths = _collectTreePaths(_allFileTree);
        for (const path of _selectedFileItems) {
          if (!existingPaths.has(path)) _selectedFileItems.delete(path);
        }
        renderCurrentFolder();
        if (j.used_bytes !== undefined && j.limit_bytes !== undefined) setFileStorageStats(j.used_bytes, j.limit_bytes);
        else refreshFileStorageStats();
      })();
      try {
        await _fileTreeLoadPromise;
      } finally {
        _fileTreeLoadPromise = null;
      }
    }

    const FILE_TREE_VIRTUAL_LIMIT = 100;

    function renderCurrentFolder() {
      const treeEl = document.getElementById('fileTree');
      treeEl.innerHTML = '';
      const items = _getItemsAtPath(_allFileTree, _currentFolderPath);
      updateBreadcrumb();
      if (!items.length) {
        treeEl.innerHTML = '<div class="file-tree-empty">No files here. Create one!</div>';
        return;
      }
      const visible = items.length > FILE_TREE_VIRTUAL_LIMIT ? items.slice(0, FILE_TREE_VIRTUAL_LIMIT) : items;
      treeEl.appendChild(renderFileTree(visible, 0));
      if (items.length > FILE_TREE_VIRTUAL_LIMIT) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'btn secondary file-tree-more-btn';
        more.textContent = `Show all ${items.length} items (${items.length - FILE_TREE_VIRTUAL_LIMIT} hidden)`;
        more.addEventListener('click', () => {
          treeEl.innerHTML = '';
          treeEl.appendChild(renderFileTree(items, 0));
        });
        treeEl.appendChild(more);
      }
    }

    function updateBreadcrumb() {
      const bc = document.getElementById('fileBreadcrumb');
      bc.innerHTML = '';

      // Home crumb
      const home = document.createElement('span');
      home.className = 'crumb';
      home.dataset.path = '';
      home.textContent = '🏠 Home';
      home.title = 'Go to root';
      home.addEventListener('click', () => { _currentFolderPath = ''; renderCurrentFolder(); });
      bc.appendChild(home);

      if (_currentFolderPath) {
        const parts = _currentFolderPath.split('/');
        let built = '';
        parts.forEach((part, idx) => {
          built = built ? built + '/' + part : part;
          const sep = document.createTextNode(' › ');
          bc.appendChild(sep);
          const crumb = document.createElement('span');
          crumb.className = 'crumb';
          const pathSnap = built;
          crumb.textContent = part;
          crumb.title = pathSnap;
          crumb.addEventListener('click', () => { _currentFolderPath = pathSnap; renderCurrentFolder(); });
          bc.appendChild(crumb);
        });
      }
    }

    function renderFileTree(items, depth) {
      const ul = document.createElement('div');
      items.forEach(item => {
        const row = document.createElement('div');
        const isSelected = _selectedFileItems.has(item.path);
        row.className = 'file-tree-item' + (currentOpenFile?.path === item.path ? ' active' : '') + (isSelected ? ' selected' : '');
        row.style.paddingLeft = (12 + depth * 14) + 'px';
        row.draggable = true;
        row.dataset.path = item.path;
        row.dataset.type = item.type;
        row.dataset.name = item.name;
        row.dataset.selected = isSelected ? '1' : '0';

        const icon = document.createElement('span');
        icon.className = 'icon';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'file-select-checkbox';
        checkbox.checked = isSelected;
        checkbox.setAttribute('aria-label', `Select ${item.name}`);
        const fname = document.createElement('span');
        fname.className = 'fname';
        fname.title = item.name;
        fname.textContent = item.name;

        if (item.type === 'folder') {
          icon.textContent = '📂';
          const arrow = document.createElement('span');
          arrow.style.cssText = 'font-size:10px; color:#888; margin-right:2px;';
          arrow.textContent = '▶';
          row.appendChild(arrow);
        } else {
          icon.textContent =
            item.name.endsWith('.py') ? '🐍' :
            item.name.endsWith('.js') ? '⚡' :
            item.name.endsWith('.html') ? '🌐' :
            item.name.endsWith('.css') ? '🎨' :
            item.name.endsWith('.csv') ? '📊' : '📄';
        }

        row.appendChild(checkbox);
        row.appendChild(icon);
        row.appendChild(fname);

        checkbox.addEventListener('click', (e) => e.stopPropagation());
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) _selectedFileItems.add(item.path);
          else _selectedFileItems.delete(item.path);
          renderCurrentFolder();
        });

        // Click: open file or enter folder
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          if (item.type === 'folder') {
            _currentFolderPath = item.path;
            renderCurrentFolder();
          } else {
            openFile(item);
          }
        });

        // Context menu
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          showCtxMenu(e.clientX, e.clientY, item);
        });

        // --- Drag source ---
        row.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/plain', item.path);
          e.dataTransfer.effectAllowed = 'move';
          row.style.opacity = '0.5';
        });
        row.addEventListener('dragend', () => { row.style.opacity = ''; });

        // --- Drop target (folders only) ---
        if (item.type === 'folder') {
          row.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            row.classList.add('drag-over');
          });
          row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
          row.addEventListener('drop', async (e) => {
            e.preventDefault();
            row.classList.remove('drag-over');
            const srcPath = e.dataTransfer.getData('text/plain');
            if (!srcPath || srcPath === item.path) return;
            // Prevent dropping parent into child - use proper path prefix check with separator
            if (item.path === srcPath || item.path.startsWith(srcPath + '/')) {
              alert('Cannot move a folder into one of its subfolders.');
              return;
            }
            await moveItem(srcPath, item.path);
          });
        }

        ul.appendChild(row);

        // Show children of sub-folders when rendering nested (depth > 0)
        // At depth 0, folder navigation is via click-to-enter; children aren't shown inline
        if (item.type === 'folder' && item.children && depth > 0) {
          const childDiv = document.createElement('div');
          childDiv.className = 'file-tree-children';
          childDiv.appendChild(renderFileTree(item.children, depth + 1));
          ul.appendChild(childDiv);
        }
      });
      return ul;
    }

    async function moveItem(srcPath, destFolderPath) {
      if (!USER_TOKEN && !TEACHER_TOKEN && !ADMIN_TOKEN) return;
      const res = await fetch('/api/files/move', {
        method: 'POST',
        headers: fileJsonHeaders(),
        body: JSON.stringify({ src: srcPath, dest: destFolderPath })
      });
      const j = await res.json().catch(() => ({}));
      if (j.ok) {
        if (currentOpenFile?.path === srcPath) currentOpenFile = { path: j.new_path, name: currentOpenFile.name };
        loadFileTree();
      } else {
        alert(j.error || 'Move failed');
      }
    }

    function getSelectedTreeItems() {
      const items = [];
      for (const path of _selectedFileItems) {
        const found = _findItemByPath(_allFileTree, path);
        if (found) items.push(found);
      }
      return items;
    }

    async function duplicateSelectedItems() {
      const selected = getSelectedTreeItems();
      if (!selected.length) {
        alert('Select at least one file or folder to duplicate.');
        return;
      }
      const failures = [];
      for (const item of selected) {
        try {
          const res = await fetch('/api/files/duplicate', {
            method: 'POST',
            headers: fileJsonHeaders(),
            body: JSON.stringify({ src: item.path })
          });
          const j = await res.json().catch(() => ({}));
          if (!j?.ok) failures.push(`${item.name}: ${j?.error || 'Duplicate failed'}`);
        } catch {
          failures.push(`${item.name}: Network error`);
        }
      }
      await loadFileTree();
      if (failures.length) alert(`Some items could not be duplicated:\n\n${failures.join('\n')}`);
    }

    async function deleteSelectedItems() {
      const selected = getSelectedTreeItems();
      if (!selected.length) {
        alert('Select at least one file or folder to delete.');
        return;
      }
      if (!confirm(`Delete ${selected.length} selected item(s)?`)) return;
      const failures = [];
      for (const item of selected) {
        try {
          const res = await fetch('/api/files/delete', {
            method: 'DELETE',
            headers: fileJsonHeaders(),
            body: JSON.stringify({ path: item.path })
          });
          const j = await res.json().catch(() => ({}));
          if (!j?.ok) failures.push(`${item.name}: ${j?.error || 'Delete failed'}`);
        } catch {
          failures.push(`${item.name}: Network error`);
        }
      }
      _selectedFileItems.clear();
      await loadFileTree();
      if (failures.length) alert(`Some items could not be deleted:\n\n${failures.join('\n')}`);
    }

    function pickMoveDestination(folders, excludedPaths) {
      return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.className = 'modal glass-modal';
        const options = folders
          .filter(f => !excludedPaths.has(f.path))
          .map(f => `<option value="${escapeHtml(f.path)}">${escapeHtml(`${'↳ '.repeat(Math.max(0, f.depth))}${f.path || '/'}`)}</option>`)
          .join('');
        modal.innerHTML = `
          <div class="modal-content" style="max-width:560px;">
            <h3 style="margin-top:0;">Move selected items</h3>
            <p style="margin:0 0 10px; color:var(--theme-text-dim); font-size:13px;">Choose a destination folder.</p>
            <select id="moveItemsTargetFolder" style="width:100%; padding:10px; background:var(--theme-input-bg); color:var(--theme-text); border:1px solid var(--theme-border-mid); border-radius:8px;">
              <option value="">/</option>
              ${options}
            </select>
            <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:12px;">
              <button class="btn secondary" id="moveItemsCancelBtn">Cancel</button>
              <button class="btn run" id="moveItemsConfirmBtn">Move</button>
            </div>
          </div>
        `;
        document.body.appendChild(modal);
        const cleanup = (value) => {
          modal.remove();
          resolve(value);
        };
        modal.addEventListener('click', (e) => { if (e.target === modal) cleanup(null); });
        modal.querySelector('#moveItemsCancelBtn')?.addEventListener('click', () => cleanup(null));
        modal.querySelector('#moveItemsConfirmBtn')?.addEventListener('click', () => {
          const val = modal.querySelector('#moveItemsTargetFolder')?.value ?? null;
          cleanup(val);
        });
      });
    }

    async function moveSelectedItems() {
      const selected = getSelectedTreeItems();
      if (!selected.length) {
        alert('Select at least one file or folder to move.');
        return;
      }
      const folders = _getAllFolders(_allFileTree);
      const selectedFolders = new Set(selected.filter(item => item.type === 'folder').map(item => item.path));
      const destination = await pickMoveDestination(folders, selectedFolders);
      if (destination == null) return;

      const selectedPaths = selected.map(item => item.path);
      const pathDepth = new Map(selectedPaths.map(path => [path, path.split('/').length]));
      // Process parents before children to avoid cascading path conflicts after parent moves.
      selectedPaths.sort((a, b) => (pathDepth.get(a) || 0) - (pathDepth.get(b) || 0));

      const failures = [];
      for (const srcPath of selectedPaths) {
        if (destination && (srcPath === destination || destination.startsWith(srcPath + '/'))) {
          failures.push(`${srcPath}: Cannot move a folder into itself or a subfolder.`);
          continue;
        }
        try {
          const res = await fetch('/api/files/move', {
            method: 'POST',
            headers: fileJsonHeaders(),
            body: JSON.stringify({ src: srcPath, dest: destination || '' })
          });
          const j = await res.json().catch(() => ({}));
          if (!j?.ok) failures.push(`${srcPath}: ${j?.error || 'Move failed'}`);
        } catch {
          failures.push(`${srcPath}: Network error`);
        }
      }
      _selectedFileItems.clear();
      await loadFileTree();
      if (failures.length) alert(`Some items could not be moved:\n\n${failures.join('\n')}`);
    }

    // Save the currently open file (if any).
    // Returns true on success (or if nothing to save), false on error.
    async function saveCurrentFile() {
      if (!currentOpenFile || (!USER_TOKEN && !TEACHER_TOKEN && !ADMIN_TOKEN)) return true;
      const content = csvEditorActive ? stringifyCsvRows(csvEditorRows) : editor.getValue();
      try {
        const res = await fetch('/api/files/write', {
          method: 'POST',
          headers: fileJsonHeaders(),
          body: JSON.stringify({ path: currentOpenFile.path, content })
        });
        if (!res.ok) return false;
        const j = await res.json().catch(() => ({}));
        return !!j.ok;
      } catch (e) {
        return false;
      }
    }

    // Update the editor header to show the active filename
    function updateActiveFileName() {
      const el = document.getElementById('activeFileName');
      if (el) el.textContent = currentOpenFile ? currentOpenFile.name : '';
      if (!csvEditorActive) syncEditorLanguage();
    }

    // Autosave: save current file 1.5 s after the last edit
    let _autosaveTimer = null;
    function scheduleAutosave() {
      if (csvEditorActive) return;
      if (!currentOpenFile || (!USER_TOKEN && !TEACHER_TOKEN && !ADMIN_TOKEN)) return;
      if (_autosaveTimer) clearTimeout(_autosaveTimer);
      _autosaveTimer = setTimeout(async () => {
        _autosaveTimer = null;
        const ok = await saveCurrentFile().catch((err) => {
          console.warn('Autosave failed:', err);
          return false;
        });
        if (!ok) console.warn('Autosave: server returned failure for', currentOpenFile?.name);
      }, 1500);
    }

    // Hook autosave into CodeMirror's change event.
    // initEditor() runs in an earlier <script> block and sets window.eagleEditor synchronously,
    // so it is always defined by the time this block executes.
    if (window.eagleEditor) {
      window.eagleEditor.on('change', scheduleAutosave);
    } else {
      // Fallback: textarea change
      document.getElementById('editor').addEventListener('input', scheduleAutosave);
    }

    async function openFile(item) {
      if (!USER_TOKEN && !TEACHER_TOKEN && !ADMIN_TOKEN) return;
      // Save the currently open file before switching
      await saveCurrentFile();
      const res = await fetch('/api/files/read?path=' + encodeURIComponent(item.path), { headers: fileAuthHeaders() });
      const j = await res.json().catch(() => ({}));
      if (!j.ok) { alert(j.error || 'Cannot open file'); return; }
      currentOpenFile = { path: item.path, name: item.name };
      const isCsv = String(item.name || '').toLowerCase().endsWith('.csv');
      if (isCsv) {
        setCsvMode(true, j.content || '');
        editor.setValue('');
      } else {
        setCsvMode(false);
        editor.setValue(j.content || '');
      }
      updateActiveFileName();
      updateEditorOverlay();
      setWorkspaceTab('editor');
      renderCurrentFolder();
      syncSubmissionScoringForOpenFile(item.path);
    }

    // Context menu
    let _ctxMenu = null;
    function showCtxMenu(x, y, item) {
      if (_ctxMenu) _ctxMenu.remove();
      _ctxMenu = document.createElement('div');
      _ctxMenu.className = 'ctx-menu';
      _ctxMenu.style.left = x + 'px';
      _ctxMenu.style.top = y + 'px';
      if (item.type === 'file') {
        const openBtn = document.createElement('button');
        openBtn.textContent = '📂 Open';
        openBtn.onclick = () => { openFile(item); _ctxMenu.remove(); };
        _ctxMenu.appendChild(openBtn);

        // Download button
        const dlBtn = document.createElement('button');
        dlBtn.textContent = '⬇️ Download';
        dlBtn.onclick = () => {
          _ctxMenu.remove();
          const a = document.createElement('a');
          a.href = '/api/files/download?path=' + encodeURIComponent(item.path);
          a.setAttribute('download', item.name);
          // Pass auth token via a temporary fetch/blob approach
          fetch(a.href, { headers: fileAuthHeaders() })
            .then(r => r.ok ? r.blob() : Promise.reject(r.statusText))
            .then(blob => {
              const url = URL.createObjectURL(blob);
              const link = document.createElement('a');
              link.href = url;
              link.download = item.name;
              document.body.appendChild(link);
              link.click();
              link.remove();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            })
            .catch(err => alert('Download failed: ' + err));
        };
        _ctxMenu.appendChild(dlBtn);
      }
      const renameBtn = document.createElement('button');
      renameBtn.textContent = '✏️ Rename';
      renameBtn.onclick = () => { _ctxMenu.remove(); renameItem(item); };
      _ctxMenu.appendChild(renameBtn);
      const delBtn = document.createElement('button');
      delBtn.textContent = '🗑️ Delete';
      delBtn.className = 'danger';
      delBtn.onclick = () => { _ctxMenu.remove(); deleteItem(item); };
      _ctxMenu.appendChild(delBtn);
      document.body.appendChild(_ctxMenu);
      document.addEventListener('click', () => { if (_ctxMenu) { _ctxMenu.remove(); _ctxMenu = null; } }, { once: true });
    }


    async function renameItem(item) {
      const newName = prompt('New name:', item.name);
      if (!newName || newName === item.name) return;
      const res = await fetch('/api/files/rename', {
        method: 'POST',
        headers: fileJsonHeaders(),
        body: JSON.stringify({ old_path: item.path, new_name: newName })
      });
      const j = await res.json().catch(() => ({}));
      if (j.ok) {
        if (currentOpenFile?.path === item.path) {
          currentOpenFile = { path: j.new_path, name: newName };
          if (!String(newName).toLowerCase().endsWith('.csv') && csvEditorActive) setCsvMode(false);
          updateActiveFileName();
        }
        loadFileTree();
      } else alert(j.error || 'Rename failed');
    }

    async function deleteItem(item) {
      if (!confirm(`Delete "${item.name}"?`)) return;
      const res = await fetch('/api/files/delete', {
        method: 'DELETE',
        headers: fileJsonHeaders(),
        body: JSON.stringify({ path: item.path })
      });
      const j = await res.json().catch(() => ({}));
      if (j.ok) {
        if (currentOpenFile?.path === item.path) {
          currentOpenFile = null;
          setCsvMode(false);
          editor.setValue('');
          updateActiveFileName();
          updateEditorOverlay();
        }
        // If we deleted the folder we're currently in, go up
        if (item.type === 'folder' && _currentFolderPath && (_currentFolderPath === item.path || _currentFolderPath.startsWith(item.path + '/'))) {
          _currentFolderPath = item.path.includes('/') ? item.path.substring(0, item.path.lastIndexOf('/')) : '';
        }
        loadFileTree();
      } else alert(j.error || 'Delete failed');
    }

    document.getElementById('newFileBtn').addEventListener('click', async () => {
      let name = prompt('New file name (e.g. main.py, script.js, index.html, styles.css):');
      if (!name) return;
      name = name.trim();
      // Auto-add .py extension if no extension is provided
      if (name && !name.includes('.')) name += '.py';
      const res = await fetch('/api/files/create', {
        method: 'POST',
        headers: fileJsonHeaders(),
        body: JSON.stringify({ name, type: 'file', parent: _currentFolderPath })
      });
      const j = await res.json().catch(() => ({}));
      if (j.ok) loadFileTree();
      else alert(j.error || 'Failed to create file');
    });

    document.getElementById('newFolderBtn').addEventListener('click', async () => {
      const name = prompt('New folder name:');
      if (!name) return;
      const res = await fetch('/api/files/create', {
        method: 'POST',
        headers: fileJsonHeaders(),
        body: JSON.stringify({ name, type: 'folder', parent: _currentFolderPath })
      });
      const j = await res.json().catch(() => ({}));
      if (j.ok) loadFileTree();
      else alert(j.error || 'Failed to create folder');
    });

    document.getElementById('uploadFileBtn').addEventListener('click', () => {
      document.getElementById('sidebarFileInput').click();
    });

    document.getElementById('sidebarFileInput').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const formData = new FormData();
      formData.append('file', file);
      if (_currentFolderPath) formData.append('parent', _currentFolderPath);
      const res = await fetch('/api/files/upload', {
        method: 'POST',
        headers: fileAuthHeaders(),
        body: formData
      });
      const j = await res.json().catch(() => ({}));
      e.target.value = '';
      if (j.ok) loadFileTree();
      else alert(j.error || 'Upload failed');
    });

    document.getElementById('refreshFilesBtn').addEventListener('click', loadFileTree);
    document.getElementById('deleteSelectedBtn')?.addEventListener('click', deleteSelectedItems);
    document.getElementById('duplicateSelectedBtn')?.addEventListener('click', duplicateSelectedItems);
    document.getElementById('moveSelectedBtn')?.addEventListener('click', moveSelectedItems);

    // Home controls (admin)
    document.getElementById('notesEditBtn').addEventListener('click', () => {
      const notesView = document.getElementById('notesView');
      const notesEdit = document.getElementById('notesEdit');
      // Get current Markdown from config or fallback to text content
      notesEdit.value = currentConfig?.notes_markdown || notesView.textContent || '';
      notesView.style.display = 'none';
      notesEdit.style.display = 'block';
      notesEdit.focus();
    });
    document.getElementById('notesSaveBtn').addEventListener('click', async () => {
      if (!ADMIN_TOKEN) return alert('Enter Admin Mode first.');
      const notesEdit = document.getElementById('notesEdit');
      const notesView = document.getElementById('notesView');
      
      const markdown = notesEdit.value;
      const html = DOMPurify.sanitize(marked.parse(markdown));
      
      // Save both Markdown source and rendered HTML
      await saveConfig({notes_markdown: markdown, notes_html: html}); 
      
      renderHomeContent(html);
      notesEdit.style.display = 'none';
      notesView.style.display = 'block';
    });
    // AI toolbar controls (admin)
    document.getElementById('aiSaveBtn').addEventListener('click', async () => {
      if (!ADMIN_TOKEN) return alert('Enter Admin Mode first.');
      const ai_explainer_enabled = document.getElementById('aiEnabled').checked;
      const ai_ollama_url = document.getElementById('aiUrlInput').value.trim();
      const ai_model = document.getElementById('aiModelInput').value.trim();
      const ai_assistant_preprompt = document.getElementById('assistantPromptInput').value.trim();
      await saveConfig({ ai_explainer_enabled, ai_ollama_url, ai_model, ai_assistant_preprompt });
      applyConfig(currentConfig);
    });

    // === AI Explain with cooldown (renders Markdown) ===
    let explainCooldownUntil = 0, explainTimer = null;
    function startExplainCooldown(seconds){
      const btn = document.getElementById('aiExplainBtn');
      const cd = document.getElementById('aiCooldown');
      const now = Math.floor(Date.now()/1000);
      explainCooldownUntil = now + Math.max(1, seconds|0);
      btn.disabled = true;
      if (explainTimer) clearInterval(explainTimer);
      const tick = () => {
        const t = Math.max(0, explainCooldownUntil - Math.floor(Date.now()/1000));
        cd.textContent = t > 0 ? `Cooldown: ${t}s` : '';
        if (t <= 0){ clearInterval(explainTimer); explainTimer = null; btn.disabled = false; }
      };
      tick(); explainTimer = setInterval(tick, 1000);
    }
    document.getElementById('aiExplainBtn').addEventListener('click', async () => {
      const status = document.getElementById('aiStatus');
      const out = document.getElementById('aiOutput');
      const btn = document.getElementById('aiExplainBtn');
      const langInfo = getActiveLanguageInfo();

      const tnow = Math.floor(Date.now()/1000);
      if (tnow < explainCooldownUntil) return;

      // Show thinking indicator
      status.innerHTML = '<span class="ai-thinking">Thinking</span>';
      out.textContent = ''; 
      btn.disabled = true;

      const code = editor.getValue();
      try {
        const res = await fetch('/api/explain', {
          method:'POST',
          headers:{ 'Content-Type':'application/json', 'X-SID': (window.mySid || '') },
          body: JSON.stringify(buildAiContext({ code, sid: (mySid || window.mySid || '') }))
        });
        const j = await res.json().catch(()=>({}));
        if (j?.ok){
          const txt = j.text || '(No response)';
          renderMarkdownTo(out, txt, langInfo.highlight);
          status.textContent = 'Done';
          startExplainCooldown(j.cooldown ?? 45);
        } else {
          out.textContent = '';
          status.textContent = (j?.error ? 'Error: ' + j.error : 'Error');
          startExplainCooldown(45);
        }
      } catch (e) {
        out.textContent = ''; status.textContent = 'Network error'; startExplainCooldown(45);
      }
    });

    const MAX_ASSISTANT_MESSAGES = 16;
    const MAX_ASSISTANT_CODE_CHARS = 12000;
    let assistantMessages = [];
    let assistantCooldownUntil = 0;
    let assistantTimer = null;

    function ensureAssistantSid() {
      if (window.mySid) return window.mySid;
      try {
        const key = 'eagleide-assistant-sid';
        let sid = sessionStorage.getItem(key);
        if (!sid) {
          sid = `local-${Math.random().toString(36).slice(2)}`;
          sessionStorage.setItem(key, sid);
        }
        window.mySid = sid;
        return sid;
      } catch {
        return `local-${Math.random().toString(36).slice(2)}`;
      }
    }

    function renderAssistantMessages() {
      const chat = document.getElementById('assistantChat');
      const langInfo = getActiveLanguageInfo();
      chat.innerHTML = '';
      assistantMessages.forEach(message => {
        const bubble = document.createElement('div');
        bubble.className = `msg ${message.role === 'user' ? 'user' : 'bot'}`;
        if (message.role === 'assistant') {
          renderMarkdownTo(bubble, message.content || '', langInfo.highlight);
        } else {
          bubble.textContent = message.content || '';
        }
        chat.appendChild(bubble);
      });
      chat.scrollTop = chat.scrollHeight;
    }

    function startAssistantCooldown(seconds) {
      const badge = document.getElementById('assistantCooldown');
      const sendBtn = document.getElementById('assistantSend');
      assistantCooldownUntil = Math.floor(Date.now() / 1000) + Math.max(1, seconds | 0);
      sendBtn.disabled = true;
      if (assistantTimer) clearInterval(assistantTimer);
      const tick = () => {
        const remaining = Math.max(0, assistantCooldownUntil - Math.floor(Date.now() / 1000));
        badge.textContent = remaining > 0 ? `Cooldown: ${remaining}s` : '';
        if (remaining <= 0) {
          clearInterval(assistantTimer);
          assistantTimer = null;
          sendBtn.disabled = false;
        }
      };
      tick();
      assistantTimer = setInterval(tick, 1000);
    }

    async function sendAssistantMessage() {
      const input = document.getElementById('assistantInput');
      const sendBtn = document.getElementById('assistantSend');
      const text = input.value.trim();
      if (!text || Math.floor(Date.now() / 1000) < assistantCooldownUntil) return;
      assistantMessages.push({ role: 'user', content: text });
      assistantMessages = assistantMessages.slice(-MAX_ASSISTANT_MESSAGES);
      input.value = '';
      renderAssistantMessages();
      sendBtn.disabled = true;
      try {
        const response = await fetch('/api/assistant/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-SID': ensureAssistantSid() },
          body: JSON.stringify(buildAiContext({
            sid: ensureAssistantSid(),
            code: editor.getValue().slice(0, MAX_ASSISTANT_CODE_CHARS),
            messages: assistantMessages
          }))
        });
        const result = await response.json().catch(() => ({}));
        if (!result?.ok) {
          if (response.status === 429) startAssistantCooldown(result.cooldown ?? 15);
          assistantMessages.push({ role: 'assistant', content: result?.error || 'Assistant error.' });
        } else {
          assistantMessages.push({ role: 'assistant', content: result.reply || '(No response)' });
          startAssistantCooldown(result.cooldown ?? 15);
        }
      } catch (error) {
        assistantMessages.push({ role: 'assistant', content: 'Network error.' });
      } finally {
        assistantMessages = assistantMessages.slice(-MAX_ASSISTANT_MESSAGES);
        renderAssistantMessages();
        if (Math.floor(Date.now() / 1000) >= assistantCooldownUntil) sendBtn.disabled = false;
      }
    }

    document.getElementById('assistantSend').addEventListener('click', sendAssistantMessage);
    document.getElementById('assistantInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendAssistantMessage();
      }
    });

    // === Challenge scoring and leaderboard ===
    let currentChallenge = { id: '', text: '', difficulty: 1, points: 3 };
    let lastScore = null;

    function renderChallengeLeaderboard(rows) {
      const tb = document.querySelector('#lbTable tbody');
      if (!tb) return;
      tb.innerHTML = '';
      const items = rows || [];
      if (!items.length) {
        tb.innerHTML = '<tr><td colspan="2" style="color:#888;">No student accounts yet.</td></tr>';
        return;
      }
      items.forEach(row => {
        const tr = document.createElement('tr');
        const td1 = document.createElement('td'); td1.textContent = row.name || row.email || 'Unknown';
        const td2 = document.createElement('td'); td2.textContent = row.score ?? 0;
        tr.appendChild(td1);
        tr.appendChild(td2);
        tb.appendChild(tr);
      });
    }

    async function refreshLeaderboard() {
      try {
        const r = await fetch('/api/challenge/leaderboard');
        const j = await r.json().catch(() => ({}));
        if (j?.ok) renderChallengeLeaderboard(j.leaderboard || j.top || []);
      } catch {}
    }

    function refreshChallengeAuthState() {
      const label = document.getElementById('challengeAccountStatus');
      const scoreBtn = document.getElementById('scoreBtn');
      const saveBtn = document.getElementById('saveScoreBtn');
      const canSubmit = !!USER_TOKEN && !!currentUser;
      if (label) {
        label.textContent = canSubmit
          ? `Signed in as ${currentUser.name || currentUser.email}`
          : 'Sign in with a student account to submit challenge scores.';
      }
      if (scoreBtn) scoreBtn.disabled = !canSubmit || !currentChallenge.text;
      if (saveBtn) saveBtn.disabled = !canSubmit || lastScore == null;
    }

    async function newChallenge(diff) {
      const chStatus = document.getElementById('chStatus');
      const out = document.getElementById('challengeOutput');
      chStatus.textContent = 'Loading…';
      out.textContent = '';
      try {
        const r = await fetch('/api/challenge/random', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ difficulty: parseInt(diff, 10) })
        });
        const j = await r.json().catch(() => ({}));
        if (j?.ok) {
          currentChallenge = { id: j.challengeId || '', text: j.challenge || '', difficulty: j.difficulty, points: j.points };
          out.textContent = currentChallenge.text + `

(Difficulty: ${currentChallenge.difficulty} • ${currentChallenge.points} pts)`;
          chStatus.textContent = 'Ready';
          lastScore = null;
          document.getElementById('scoreStatus').textContent = '';
          refreshChallengeAuthState();
        } else {
          chStatus.textContent = j?.error || 'Error';
        }
      } catch (e) {
        chStatus.textContent = 'Network error';
      }
    }

    document.getElementById('btnD1').addEventListener('click', () => newChallenge(1));
    document.getElementById('btnD2').addEventListener('click', () => newChallenge(2));
    document.getElementById('btnD3').addEventListener('click', () => newChallenge(3));
    document.getElementById('btnD4').addEventListener('click', () => newChallenge(4));
    document.getElementById('btnD5').addEventListener('click', () => newChallenge(5));

    document.getElementById('scoreBtn').addEventListener('click', async () => {
      if (!USER_TOKEN || !currentUser) {
        alert('Please sign in with a student account first.');
        return;
      }
      if (!currentChallenge.text) {
        alert('Load a challenge first.');
        return;
      }
      const status = document.getElementById('scoreStatus');
      status.textContent = 'Scoring…';
      lastScore = null;
      refreshChallengeAuthState();
      try {
        const r = await fetch('/api/challenge/score', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-User-Token': USER_TOKEN },
          body: JSON.stringify(buildAiContext({ code: editor.getValue(), challenge: currentChallenge.text, points: currentChallenge.points }))
        });
        const j = await r.json().catch(() => ({}));
        if (j?.ok) {
          lastScore = j.score;
          status.textContent = `Score: ${j.score} / ${j.max}`;
          refreshChallengeAuthState();
        } else {
          status.textContent = j?.error || 'Error';
        }
      } catch (e) {
        status.textContent = 'Network error';
      }
    });

    document.getElementById('saveScoreBtn').addEventListener('click', async () => {
      if (!USER_TOKEN || !currentUser) {
        alert('Please sign in with a student account first.');
        return;
      }
      if (!currentChallenge.id) {
        alert('Load a challenge first.');
        return;
      }
      if (lastScore == null) {
        alert('Run the AI score first.');
        return;
      }
      const status = document.getElementById('scoreStatus');
      try {
        const r = await fetch('/api/challenge/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-User-Token': USER_TOKEN },
          body: JSON.stringify({ challengeId: currentChallenge.id, score: lastScore })
        });
        const j = await r.json().catch(() => ({}));
        if (j?.ok) {
          status.textContent = `Saved latest score: ${lastScore}`;
          lastScore = null;
          refreshChallengeAuthState();
          renderChallengeLeaderboard(j.leaderboard || j.top || []);
        } else {
          status.textContent = j?.error || 'Save failed';
        }
      } catch (e) {
        status.textContent = 'Network error';
      }
    });

    refreshChallengeAuthState();

    // Kick off leaderboard load once
    (async () => { try { await refreshLeaderboard(); } catch {} })();

    // =============================================
    // Assignment System
    // =============================================
    let currentAssignments = [];
    let isAdmin = false;
    let currentAdminAssignmentName = null;
    let activeSubmissionContext = null;
    let submissionSaveTimer = null;
    let assignmentsLoadPromise = null;
    let assignmentsReloadQueued = false;
    let activeQuizSession = null;
    let currentMasteryData = null;
    let masteryTagChart = null;
    let masterySummaryChart = null;

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text ?? '';
      return div.innerHTML;
    }

    function normalizeCodeLanguage(lang) {
      const value = String(lang || '').trim().toLowerCase();
      if (value === 'javascript' || value === 'js') return 'javascript';
      if (value === 'html' || value === 'xml') return 'html';
      return 'python';
    }

    function renderCodeSnippetBlock(code, lang = 'python') {
      const src = String(code || '');
      const language = normalizeCodeLanguage(lang);
      if (!src.trim()) return '<div style="color:#7e8a97; font-size:12px;">No code snippet.</div>';
      let highlighted = escapeHtml(src);
      try {
        if (window.hljs) {
          const hlLang = language === 'html' ? 'xml' : language;
          highlighted = hljs.highlight(src, { language: hlLang }).value;
        }
      } catch {}
      const lines = highlighted.split('\n');
      return `<div class="code-read-block">${lines.map((line, idx) => `
        <div class="code-read-line">
          <span class="code-read-line-num">${idx + 1}</span>
          <span class="code-read-line-code">${line || '&nbsp;'}</span>
        </div>
      `).join('')}</div>`;
    }

    function rigorLevelLabel(level) {
      const v = Math.max(1, Math.min(10, parseInt(level, 10) || 5));
      if (v <= 2) return 'Elementary';
      if (v <= 4) return 'Middle School';
      if (v <= 6) return 'High School';
      if (v <= 7) return 'Honors';
      if (v <= 8) return 'AP/Advanced';
      if (v <= 9) return 'College Prep';
      return 'College';
    }

    function masteryBandClass(score) {
      if (score === null || score === undefined) return 'mastery-cell-untested';
      if (score < 70) return 'mastery-cell-red';
      if (score < 80) return 'mastery-cell-bronze';
      if (score < 90) return 'mastery-cell-silver';
      return 'mastery-cell-gold';
    }

    function assignmentScoreValue(submission) {
      if (!submission) return null;
      if (submission.totalScore !== null && submission.totalScore !== undefined) return submission.totalScore;
      if (submission.codeScore !== null && submission.codeScore !== undefined) return submission.codeScore;
      if (submission.score !== null && submission.score !== undefined) return submission.score;
      return null;
    }

    function assignmentTotalMaxScore(assignment) {
      if (!assignment) return 0;
      const codeMax = assignment.allowFileSubmission === false ? 0 : (parseInt(assignment.maxScore, 10) || 0);
      const quizMax = parseInt(assignment.quiz?.totalPoints, 10) || 0;
      return Math.max(0, codeMax + quizMax);
    }

    function assignmentPercentValue(submission, assignment) {
      const total = assignmentScoreValue(submission);
      const max = assignmentTotalMaxScore(assignment);
      if (total === null || total === undefined || !max) return null;
      const pct = Math.max(0, Math.min(100, (Number(total) / Number(max)) * 100));
      return `${Math.round(pct)}%`;
    }

    function hasSubmissionSummary(summary) {
      if (!summary) return false;
      return !!(
        summary.submittedAt ||
        summary.totalScore !== null && summary.totalScore !== undefined ||
        summary.codeScore !== null && summary.codeScore !== undefined ||
        summary.quizScore !== null && summary.quizScore !== undefined
      );
    }

    function flattenFiles(items, output = []) {
      (items || []).forEach(item => {
        if (item.type === 'file') output.push(item);
        if (item.type === 'folder' && item.children) flattenFiles(item.children, output);
      });
      return output;
    }

    function setAssignmentStatus(message, isError = false) {
      const el = document.getElementById('assignmentStatus');
      if (!el) return;
      el.textContent = message || '';
      el.style.color = isError ? '#ef5350' : '';
      if (message) {
        setTimeout(() => {
          if (el.textContent === message) el.textContent = '';
        }, 3000);
      }
    }

    function hideSubmissionScoringPanel() {
      activeSubmissionContext = null;
      if (submissionSaveTimer) {
        clearTimeout(submissionSaveTimer);
        submissionSaveTimer = null;
      }
      const panel = document.getElementById('submissionScoringPanel');
      if (panel) panel.style.display = 'none';
      const input = document.getElementById('submissionScoreInput');
      if (input) input.value = '';
      const status = document.getElementById('submissionScoreSaveStatus');
      if (status) status.textContent = '';
    }

    function getAssignmentByName(name) {
      return currentAssignments.find(a => a.name === name);
    }

    function getSubmissionForAssignment(assignmentName, email) {
      const assignment = getAssignmentByName(assignmentName);
      if (!assignment) return { assignment: null, submission: null };
      const submission = (assignment.submissions || []).find(s => (s.email || '').toLowerCase() === (email || '').toLowerCase());
      return { assignment, submission };
    }

    function findSubmissionByAdminPath(filePath) {
      const target = (filePath || '').trim();
      if (!target) return { assignment: null, submission: null };
      for (const assignment of currentAssignments || []) {
        for (const submission of assignment.submissions || []) {
          if ((submission.adminFilePath || '').trim() === target) {
            return { assignment, submission };
          }
        }
      }
      return { assignment: null, submission: null };
    }

    function syncSubmissionScoringForOpenFile(filePath) {
      if (!isAdmin) return;
      const { assignment, submission } = findSubmissionByAdminPath(filePath);
      if (!assignment || !submission) {
        hideSubmissionScoringPanel();
        return;
      }
      currentAdminAssignmentName = assignment.name;
      populateSubmissionScoringPanel(assignment, submission);
      renderAdminAssignments();
    }

    async function loadAssignments() {
      if (assignmentsLoadPromise) {
        assignmentsReloadQueued = true;
        return assignmentsLoadPromise;
      }
      assignmentsLoadPromise = (async () => {
      try {
        const headers = TEACHER_TOKEN
          ? { 'X-Teacher-Token': TEACHER_TOKEN }
          : (USER_TOKEN ? { 'X-User-Token': USER_TOKEN } : {});
        const resp = await fetch('/api/assignments', { headers });
        const data = await resp.json().catch(() => ({}));
        if (!data.ok) {
          currentAssignments = [];
          isAdmin = false;
          renderAssignments();
          hideSubmissionScoringPanel();
          return;
        }
        currentAssignments = data.assignments || [];
        isAdmin = data.canManage || data.isAdmin || false;
        if (isAdmin) {
          populateTeacherAssignmentsClassSelect();
          syncTeacherDashboardClassSelectors();
        }
        if (isAdmin && currentAssignments.length) {
          if (!currentAdminAssignmentName || !getAssignmentByName(currentAdminAssignmentName)) {
            currentAdminAssignmentName = currentAssignments[0].name;
          }
        } else {
          currentAdminAssignmentName = null;
        }
        renderAssignments();
        if (activeSubmissionContext && isAdmin) {
          const { assignment, submission } = getSubmissionForAssignment(activeSubmissionContext.assignmentName, activeSubmissionContext.studentEmail);
          if (assignment && submission) {
            populateSubmissionScoringPanel(assignment, submission);
          } else {
            hideSubmissionScoringPanel();
          }
        } else if (!isAdmin) {
          hideSubmissionScoringPanel();
        }
      } catch (e) {
        console.error('Failed to load assignments:', e);
      } finally {
        assignmentsLoadPromise = null;
        if (assignmentsReloadQueued) {
          assignmentsReloadQueued = false;
          loadAssignments();
        }
      }
      })();
      return assignmentsLoadPromise;
    }

    function renderAssignments() {
      const studentView = document.getElementById('assignmentStudentView');
      const teacherNotice = document.getElementById('assignmentTeacherNotice');
      if (isAdmin) {
        if (studentView) studentView.style.display = 'none';
        if (teacherNotice) teacherNotice.style.display = '';
        renderAdminAssignments();
      } else {
        if (studentView) studentView.style.display = 'block';
        if (teacherNotice) teacherNotice.style.display = 'none';
        renderStudentAssignments();
      }
    }

    function renderAdminAssignments() {
      const list = document.getElementById('assignmentList');
      const detail = document.getElementById('assignmentDetailPanel');
      const activeClassId = activeAssignmentsClassId || currentTeacherClassId;
      const classAssignments = (currentAssignments || []).filter(a => !activeClassId || a.targetClassId === activeClassId);
      if (!classAssignments.length) {
        list.innerHTML = '<p style="color:#888;">No assignments yet. Create one to get started.</p>';
        detail.innerHTML = '<p style="color:#888; margin:0;">No assignments for the selected class.</p>';
        return;
      }

      if (!currentAdminAssignmentName || !classAssignments.some(a => a.name === currentAdminAssignmentName)) {
        currentAdminAssignmentName = classAssignments[0]?.name || null;
      }
      list.innerHTML = classAssignments.map(a => `
        <div class="assignment-card" style="border-color:${currentAdminAssignmentName === a.name ? 'var(--columbia-blue)' : 'var(--theme-border-mid)'};">
          <h4>${escapeHtml(a.name)}</h4>
          <div class="task">${escapeHtml(a.task || '(No task description)')}</div>
          <div class="meta">
            Max Score: ${(a.allowFileSubmission === false ? 0 : (a.maxScore || 0)) + (a.quiz?.totalPoints || 0)} (${a.allowFileSubmission === false ? 'Quiz only' : `Code ${a.maxScore || 0}${a.quiz?.totalPoints ? ` + Quiz ${a.quiz.totalPoints}` : ''}`}) · ${a.active ? 'Unlocked' : 'Locked'} · Class: ${escapeHtml(a.targetClassName || 'All')} · ${(a.submissions || []).length} submission(s)
          </div>
          ${(a.skillTags || []).length ? `<div class="skill-tags">${(a.skillTags || []).map(tag => `<span class="skill-chip">${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
          <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-top:8px;">
            <select class="copy-assignment-class-select" data-name="${escapeHtml(a.name)}" style="padding:6px; background:var(--theme-input-bg); color:var(--theme-text); border:1px solid var(--theme-border-mid); border-radius:6px;">
              <option value="">Copy to class…</option>
              ${teacherClasses.filter(c => c.id !== a.targetClassId).map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('')}
            </select>
            <button class="btn secondary copy-assignment-btn" data-name="${escapeHtml(a.name)}">Copy Test</button>
          </div>
          <div class="assignment-actions">
            <button class="btn secondary select-assignment-btn" data-name="${escapeHtml(a.name)}">Scores</button>
            <button class="btn secondary edit-assignment-btn" data-name="${escapeHtml(a.name)}">Edit</button>
            <button class="btn secondary lock-assignment-btn" data-name="${escapeHtml(a.name)}" data-active="${a.active}">${a.active ? 'Lock' : 'Unlock'}</button>
            <button class="btn stop delete-assignment-btn" data-name="${escapeHtml(a.name)}">Delete</button>
          </div>
        </div>
      `).join('');

      list.querySelectorAll('.select-assignment-btn').forEach(btn => btn.addEventListener('click', () => {
        currentAdminAssignmentName = btn.dataset.name;
        renderAdminAssignments();
      }));
      list.querySelectorAll('.edit-assignment-btn').forEach(btn => btn.addEventListener('click', () => showAssignmentModal(getAssignmentByName(btn.dataset.name))));
      list.querySelectorAll('.lock-assignment-btn').forEach(btn => btn.addEventListener('click', () => toggleAssignmentActive(btn.dataset.name, btn.dataset.active !== 'true')));
      list.querySelectorAll('.delete-assignment-btn').forEach(btn => btn.addEventListener('click', () => deleteAssignment(btn.dataset.name)));
      list.querySelectorAll('.copy-assignment-btn').forEach(btn => btn.addEventListener('click', () => copyAssignmentToClass(btn.dataset.name)));

      const assignment = getAssignmentByName(currentAdminAssignmentName);
      if (!assignment) {
        detail.innerHTML = '<p style="color:#888; margin:0;">Select an assignment to review scores and open submissions.</p>';
        return;
      }

      const submissions = [...(assignment.submissions || [])].sort((a, b) => ((a.name || a.email || '').localeCompare(b.name || b.email || '', undefined, { sensitivity: 'base' })));
      detail.innerHTML = `
        <h4>${escapeHtml(assignment.name)}</h4>
        <div class="meta" style="margin-bottom:12px; white-space:pre-wrap;">${escapeHtml(assignment.task || '(No task description)')}</div>
        <div class="meta" style="margin-bottom:12px;">Max score ${(assignment.allowFileSubmission === false ? 0 : (assignment.maxScore || 0)) + (assignment.quiz?.totalPoints || 0)}${assignment.allowFileSubmission === false ? ' (Quiz only)' : ''}${assignment.quiz?.totalPoints ? ` · Quiz ${assignment.quiz.totalPoints} pts` : ''} · Class ${escapeHtml(assignment.targetClassName || 'All')} · Quiz max submissions ${assignment.quizSettings?.maxSubmissions > 0 ? assignment.quizSettings.maxSubmissions : 'Unlimited'}</div>
        ${(assignment.skillTags || []).length ? `<div class="skill-tags" style="margin-bottom:12px;">${(assignment.skillTags || []).map(tag => `<span class="skill-chip">${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px;">
          <button class="btn secondary" id="downloadScoresBtn">Download CSV</button>
        </div>
        <table class="scores-table">
          <thead>
            <tr><th>Student</th><th>File</th><th>Submitted</th><th>Code Score</th><th>Quiz Score</th><th>Total</th><th>% Score</th><th>Quiz Attempts</th><th></th></tr>
          </thead>
          <tbody>
            ${submissions.length ? submissions.map(sub => `
              <tr>
                <td>${escapeHtml(sub.name || sub.email || 'Unknown')}</td>
                <td>${escapeHtml(sub.submittedFileName || '—')}</td>
                <td>${escapeHtml(sub.submittedAt || '—')}</td>
                <td>${sub.codeScore ?? sub.score ?? '—'}</td>
                <td>${sub.quizScore ?? '—'}</td>
                <td>${assignmentScoreValue(sub) ?? '—'}</td>
                <td>${assignmentPercentValue(sub, assignment) ?? '—'}</td>
                <td>${sub.quizSubmissionCount ?? 0}${assignment.quizSettings?.maxSubmissions > 0 ? ` / ${assignment.quizSettings.maxSubmissions}` : ''}</td>
                <td style="display:flex; gap:6px; flex-wrap:wrap;">
                  ${assignment.allowFileSubmission === false ? '' : `<button class="btn secondary open-submission-btn" data-assignment="${escapeHtml(assignment.name)}" data-email="${escapeHtml(sub.email)}">Open</button>`}
                  ${assignment.quiz?.questions?.length ? `<button class="btn secondary grade-quiz-btn" data-assignment="${escapeHtml(assignment.name)}" data-email="${escapeHtml(sub.email)}">Grade Quiz</button>` : ''}
                  ${assignment.quiz?.questions?.length ? `<button class="btn secondary reset-quiz-counter-btn" data-assignment="${escapeHtml(assignment.name)}" data-email="${escapeHtml(sub.email)}">Reset Attempts</button>` : ''}
                </td>
              </tr>
            `).join('') : '<tr><td colspan="9" style="color:#888;">No submissions yet.</td></tr>'}
          </tbody>
        </table>
      `;
      detail.querySelector('#downloadScoresBtn')?.addEventListener('click', () => downloadCSV(assignment.name));
      detail.querySelectorAll('.open-submission-btn').forEach(btn => btn.addEventListener('click', () => openAssignmentSubmission(btn.dataset.assignment, btn.dataset.email)));
      detail.querySelectorAll('.grade-quiz-btn').forEach(btn => btn.addEventListener('click', () => openQuizGradingModal(btn.dataset.assignment, btn.dataset.email)));
      detail.querySelectorAll('.reset-quiz-counter-btn').forEach(btn => btn.addEventListener('click', () => resetQuizCounter(btn.dataset.assignment, btn.dataset.email)));
    }

    function renderStudentAssignments() {
      const activeList = document.getElementById('studentAssignmentList');
      const pastList = document.getElementById('studentPastAssignmentList');
      const notice = document.getElementById('studentAccountNotice');
      const joinPanel = document.getElementById('joinClassPanel');
      const joinPanelTitle = document.getElementById('joinClassPanelTitle');
      const joinClassBtn = document.getElementById('joinClassBtn');
      const files = flattenFiles(_allFileTree || []);
      const canSubmit = !!USER_TOKEN && !!currentUser;
      const joinedClass = !!studentClassData;
      const selectedClassId = getSelectedStudentClassId();
      notice.textContent = canSubmit
        ? (joinedClass
          ? `Signed in as ${currentUser.name || currentUser.email}. Current class: ${studentClassData.name}. Use the class selector to switch classes or add another one.`
          : `Signed in as ${currentUser.name || currentUser.email}. Join a class with a code to view class assignments.`)
        : 'Sign in with a student account to submit assignment files and view your scores.';
      if (joinPanel) joinPanel.style.display = canSubmit ? '' : 'none';
      if (joinPanelTitle) joinPanelTitle.textContent = joinedClass ? 'Add Class' : 'Join Class';
      if (joinClassBtn) joinClassBtn.textContent = joinedClass ? 'Add Class' : 'Join Class';

      const visibleAssignments = (currentAssignments || []).filter(a => !selectedClassId || a.targetClassId === selectedClassId);
      const activeAssignments = visibleAssignments.filter(a => a.active);
      const pastAssignments = visibleAssignments.filter(a => !a.active);

      function scoreBadge(a) {
        const s = a.studentSubmissionSummary;
        if (!s) return '';
        const total = s.totalScore ?? s.codeScore ?? null;
        const maxTotal = assignmentTotalMaxScore(a);
        if (total != null) {
          return `<div><span class="assignment-score-badge scored">✓ Score: ${total} / ${maxTotal || a.maxScore}</span></div>`;
        }
        if (s.submittedAt) {
          return `<div><span class="assignment-score-badge pending">⏳ Submitted – awaiting grade</span></div>`;
        }
        return '';
      }

      if (!activeAssignments.length) {
        activeList.innerHTML = `<p style="color:#888;">${joinedClass ? 'No active assignments for this class.' : 'Join a class to see active assignments.'}</p>`;
      } else {
        activeList.innerHTML = activeAssignments.map(a => `
          <div class="assignment-card">
            <h4>${escapeHtml(a.name)}</h4>
            <div class="task">${escapeHtml(a.task || '(No task description)')}</div>
            <div class="meta">Max Score: ${assignmentTotalMaxScore(a)}${a.allowFileSubmission === false ? ' (Quiz only)' : ''}${a.quiz?.questions?.length ? ` · ${a.quiz.questions.length} question(s)` : ''}${a.quizSettings?.maxSubmissions > 0 ? ` · ${a.quizSettings.maxSubmissions} quiz attempt(s)` : ''}</div>
            ${scoreBadge(a)}
            ${(a.skillTags || []).length ? `<div class="skill-tags">${(a.skillTags || []).map(tag => `<span class="skill-chip">${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
            <div class="assignment-actions">
              ${a.allowFileSubmission === false ? '' : `<button class="btn run submit-assignment-btn" data-name="${escapeHtml(a.name)}" ${canSubmit && joinedClass && files.length ? '' : 'disabled'}>Submit File</button>`}
              ${a.quiz?.questions?.length ? `<button class="btn secondary open-questions-btn" data-name="${escapeHtml(a.name)}" ${canSubmit && joinedClass ? '' : 'disabled'}>Questions (${a.quiz.questions.length})</button>` : ''}
              ${hasSubmissionSummary(a.studentSubmissionSummary) ? `<button class="btn secondary view-score-report-btn" data-name="${escapeHtml(a.name)}" ${canSubmit ? '' : 'disabled'}>Score Report</button>` : ''}
            </div>
          </div>
        `).join('');
        activeList.querySelectorAll('.submit-assignment-btn').forEach(btn => btn.addEventListener('click', () => showAssignmentSubmitModal(btn.dataset.name)));
        activeList.querySelectorAll('.open-questions-btn').forEach(btn => btn.addEventListener('click', () => openQuestions(btn.dataset.name)));
        activeList.querySelectorAll('.view-score-report-btn').forEach(btn => btn.addEventListener('click', () => openStudentScoreReport(btn.dataset.name)));
      }

      if (!pastAssignments.length) {
        pastList.innerHTML = `<p style="color:#888;">${joinedClass ? 'No past assignments for this class.' : 'Join a class to see previous assignments.'}</p>`;
      } else {
        pastList.innerHTML = pastAssignments.map(a => `
          <div class="assignment-card" style="opacity:0.85;">
            <h4>${escapeHtml(a.name)} <span style="color:#888; font-size:12px; font-weight:normal;">(Locked)</span></h4>
            <div class="task">${escapeHtml(a.task || '(No task description)')}</div>
            ${scoreBadge(a)}
            ${(a.skillTags || []).length ? `<div class="skill-tags">${(a.skillTags || []).map(tag => `<span class="skill-chip">${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
            <div class="assignment-actions">
              ${hasSubmissionSummary(a.studentSubmissionSummary) ? `<button class="btn secondary view-score-report-btn" data-name="${escapeHtml(a.name)}" ${canSubmit ? '' : 'disabled'}>Score Report</button>` : ''}
            </div>
          </div>
        `).join('');
        pastList.querySelectorAll('.view-score-report-btn').forEach(btn => btn.addEventListener('click', () => openStudentScoreReport(btn.dataset.name)));
      }
    }

    async function loadStudentScores() {
      const resultsDiv = document.getElementById('studentScoreResults');
      if (!resultsDiv) return;
      if (!USER_TOKEN || !currentUser) {
        resultsDiv.innerHTML = '<p style="color:#888; font-size:12px;">Sign in to see your scores.</p>';
        return;
      }
      try {
        const response = await fetch('/api/assignments/student-scores', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-User-Token': USER_TOKEN },
          body: JSON.stringify({})
        });
        const result = await response.json().catch(() => ({}));
        if (!result.ok || !result.scores?.length) {
          resultsDiv.innerHTML = '<p style="color:#888; font-size:12px;">No submissions yet.</p>';
          return;
        }
        const renderCard = (score, closed) => `
          <div class="score-result-item" ${closed ? 'style="opacity:0.85;"' : ''}>
            <div class="assignment-name">${escapeHtml(score.assignmentName)}${closed ? ' <span style="color:#888; font-size:11px;">(Locked)</span>' : ''}</div>
            <div class="assignment-score">
              Score: ${score.totalScore ?? score.codeScore ?? score.score ?? '—'} / ${score.maxTotal ?? score.maxScore}
              ${score.quizScore !== null && score.quizScore !== undefined ? ` · Quiz ${score.quizScore}` : ''}
            </div>
            <div style="color:#666; font-size:11px; margin-top:4px;">${escapeHtml(score.submittedFileName || 'No code file yet')} · ${escapeHtml(score.submittedAt || 'Not submitted')}</div>
            <div style="margin-top:8px;">
              <button class="btn secondary view-score-report-btn" data-name="${escapeHtml(score.assignmentName)}" ${score.submittedAt ? '' : 'disabled'}>View Score Report</button>
            </div>
          </div>
        `;
        const activeScores = result.scores.filter(s => s.active);
        const pastScores = result.scores.filter(s => !s.active);
        let html = '';
        if (activeScores.length) html += '<div style="margin-bottom:16px;"><h5 style="color:var(--columbia-blue); margin:8px 0;">Active Assignments</h5>' + activeScores.map(score => renderCard(score, false)).join('') + '</div>';
        if (pastScores.length) html += '<div><h5 style="color:var(--columbia-blue); margin:8px 0;">Past Assignments</h5>' + pastScores.map(score => renderCard(score, true)).join('') + '</div>';
        resultsDiv.innerHTML = html || '<p style="color:#888; font-size:12px;">No submissions yet.</p>';
        resultsDiv.querySelectorAll('.view-score-report-btn').forEach(btn => btn.addEventListener('click', () => openStudentScoreReport(btn.dataset.name)));
      } catch (error) {
        console.error('Error loading scores:', error);
        resultsDiv.innerHTML = '<p style="color:#ff5555; font-size:12px;">Error loading scores. Please try again.</p>';
      }
    }

    function buildQuizPayload(quizQuestions) {
      if (!quizQuestions?.length) return null;
      return {
        questions: quizQuestions,
        totalPoints: quizQuestions.reduce((sum, q) => sum + (q.points || 0), 0)
      };
    }

    document.getElementById('joinClassBtn').addEventListener('click', async () => {
      if (!USER_TOKEN || !currentUser) return;
      const status = document.getElementById('joinClassStatus');
      const code = (document.getElementById('joinClassCodeInput').value || '').trim().toUpperCase();
      if (!code || code.length !== 6) {
        status.textContent = 'Enter a valid 6-character code.';
        status.style.color = '#ef5350';
        return;
      }
      status.textContent = 'Joining class…';
      status.style.color = '';
      try {
        const res = await fetch('/api/classes/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-User-Token': USER_TOKEN },
          body: JSON.stringify({ joinCode: code })
        });
        const j = await res.json().catch(() => ({}));
        if (!j?.ok) {
          status.textContent = j?.error || 'Failed to join class.';
          status.style.color = '#ef5350';
          return;
        }
        studentClasses = Array.isArray(j?.classList) ? j.classList : [];
        currentStudentClassId = j?.classData?.id || currentStudentClassId;
        syncStudentClassSelection();
        studentClasses.forEach(cls => {
          if (cls?.id) emitJoinClassRoom('student', USER_TOKEN, cls.id);
        });
        status.textContent = `Added ${studentClassData?.name || 'class'} successfully.`;
        status.style.color = '#4caf50';
        renderClassSelector();
        updateTeacherStreamPaneVisibility();
        updateAuthUI();
        await loadAssignments();
      } catch {
        status.textContent = 'Network error.';
        status.style.color = '#ef5350';
      }
    });

    document.getElementById('newAssignmentBtn').addEventListener('click', () => showAssignmentModal());
    document.getElementById('openDashAssignmentsBtn')?.addEventListener('click', () => openTeacherDashboard('dash-assignments'));

    function showAssignmentModal(existingAssignment = null) {
      const effectiveClassId = existingAssignment?.targetClassId || activeAssignmentsClassId || currentTeacherClassId;
      const availableSkills = teacherSkills || [];
      const selectedTags = existingAssignment?.skillTags || [];
      const maxQuizSubmissions = existingAssignment?.quizSettings?.maxSubmissions ?? 0;
      const modal = document.createElement('div');
      modal.className = 'modal workspace-modal glass-modal';
      modal.innerHTML = `
        <div class="modal-content glass-surface">
          <div class="workspace-modal-header">
            <h3 style="margin:0;">${existingAssignment ? 'Edit Assignment' : 'New Assignment'}</h3>
            <button class="btn secondary modal-exit-btn">Exit</button>
          </div>
          <div class="workspace-modal-body">
          <label>Assignment Name</label>
          <input type="text" id="modalAssignmentName" value="${escapeHtml(existingAssignment?.name || '')}" ${existingAssignment ? 'disabled' : ''} placeholder="e.g., Loops Practice 1" />
          <label>Task Description</label>
          <textarea id="modalAssignmentTask" placeholder="Describe what students need to do...">${escapeHtml(existingAssignment?.task || '')}</textarea>
          <label>Max Score (Code)</label>
          <input type="number" id="modalAssignmentMaxScore" value="${existingAssignment?.maxScore || 100}" min="1" />
          <label style="margin-bottom:2px;">Assignment Options</label>
          <div class="assignment-option-card">
            <label class="option-title">
              <input type="checkbox" id="modalAssignmentAllowFileSubmission" ${existingAssignment?.allowFileSubmission === false ? '' : 'checked'}>
              <span>Students upload a code file for this assignment</span>
            </label>
            <div class="option-help">Turn this off for quiz-only assignments so students only answer the questions below.</div>
          </div>
          ${TEACHER_TOKEN ? `
          <label>Class</label>
          <select id="modalAssignmentClassId" style="width:100%; padding:8px; background:var(--theme-input-bg); color:var(--theme-text); border:1px solid var(--theme-border-mid); border-radius:8px;">
            ${teacherClasses.map(c => `<option value="${escapeHtml(c.id)}" ${effectiveClassId === c.id ? 'selected' : ''}>${escapeHtml(c.name)} (${escapeHtml(c.join_code)})</option>`).join('')}
          </select>` : ''}
          <label>Skill Tags (covered by this assignment)</label>
          <div id="modalAssignmentSkillTags" style="border:1px solid var(--theme-border-mid); border-radius:8px; padding:8px; max-height:180px; overflow:auto;">
            ${availableSkills.length ? availableSkills.map(skill => `
              <div class="assignment-option-card" style="margin-bottom:8px;">
                <label class="option-title">
                  <input type="checkbox" class="modal-skill-check" value="${escapeHtml(skill.name)}" ${selectedTags.includes(skill.name) ? 'checked' : ''}>
                  <strong>${escapeHtml(skill.name)}</strong>
                </label>
                <div class="option-help">${escapeHtml(skill.description || 'Track this skill with the assignment score.')}</div>
              </div>
            `).join('') : '<div style="color:#888; font-size:12px;">No skills created yet. Add skills in the Skills dashboard page.</div>'}
          </div>
          <label>Quiz Max Submissions (0 = unlimited)</label>
          <input type="number" id="modalAssignmentMaxQuizSubmissions" value="${maxQuizSubmissions}" min="0" max="100" />
          <div style="margin-top:20px; padding-top:20px; border-top:1px solid #333;">
            <h4 style="color:var(--columbia-blue); margin:0 0 12px;">Quiz (Optional)</h4>
            <div id="quizBuilder">
              <div id="quizQuestionsList"></div>
              <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:10px;">
                <button type="button" class="btn secondary" id="addQuestionBtn">+ Add Question</button>
                <button type="button" class="btn secondary" id="viewQuizAsStudentBtn">View as Student</button>
              </div>
            </div>
          </div>
          <div class="modal-actions" style="margin-top:20px;">
            <button class="btn run modal-save-btn">${existingAssignment ? 'Save Changes' : 'Create Assignment'}</button>
          </div>
          </div>
        </div>
      `;
      document.body.appendChild(modal);

      let quizQuestions = JSON.parse(JSON.stringify(existingAssignment?.quiz?.questions || []));
      let questionIdCounter = { value: quizQuestions.length };

      function renderQuizQuestions() {
        const list = document.getElementById('quizQuestionsList');
        if (!quizQuestions.length) {
          list.innerHTML = '<p style="color:#888; font-size:12px;">No questions added yet.</p>';
          return;
        }
        list.innerHTML = quizQuestions.map((q, idx) => `
          <div class="quiz-question-item" style="background:#0c0c0c; border:1px solid #333; border-radius:6px; padding:12px; margin-bottom:10px;">
            <div style="display:flex; justify-content:space-between; align-items:start; gap:12px;">
              <div style="flex:1;">
                <strong style="color:var(--columbia-blue);">Question ${idx + 1}</strong>
                <span style="color:#888; margin-left:10px;">(${
                  q.type === 'multiple_choice' ? 'Multiple Choice' :
                  q.type === 'multiple_choice_code' ? 'Multiple Choice (Code Reading)' :
                  q.type === 'written_code' ? 'Written Response (Code Reading)' :
                  'Written Response'
                }, ${q.points} pts)</span>
                <div style="color:#ddd; margin-top:8px;">${escapeHtml(q.question)}</div>
                ${(q.type === 'multiple_choice_code' || q.type === 'written_code') ? `
                  <div class="question-code-panel" style="margin-top:10px; max-height:180px;">${renderCodeSnippetBlock(q.codeSnippet || '', q.codeLanguage || 'python')}</div>
                ` : ''}
              </div>
              <button class="btn-delete-question" data-idx="${idx}" style="background:#d32f2f; color:#fff; border:none; padding:4px 8px; border-radius:4px; cursor:pointer; font-size:11px;">Delete</button>
            </div>
          </div>
        `).join('');
        list.querySelectorAll('.btn-delete-question').forEach(btn => btn.addEventListener('click', () => {
          quizQuestions.splice(parseInt(btn.dataset.idx, 10), 1);
          renderQuizQuestions();
        }));
      }

      document.getElementById('addQuestionBtn').addEventListener('click', () => showAddQuestionModal(quizQuestions, renderQuizQuestions, questionIdCounter));
      document.getElementById('viewQuizAsStudentBtn')?.addEventListener('click', () => {
        const assignmentName = existingAssignment?.name || (document.getElementById('modalAssignmentName')?.value || 'Untitled Assignment');
        showTeacherQuizPreviewModal(assignmentName, quizQuestions);
      });
      renderQuizQuestions();
      modal.querySelector('.modal-exit-btn')?.addEventListener('click', () => modal.remove());
      modal.querySelector('.modal-save-btn').addEventListener('click', async () => {
        const name = existingAssignment
          ? existingAssignment.name
          : document.getElementById('modalAssignmentName').value.trim();
        const task = document.getElementById('modalAssignmentTask').value.trim();
        const maxScore = parseInt(document.getElementById('modalAssignmentMaxScore').value, 10) || 100;
        const allowFileSubmission = !!document.getElementById('modalAssignmentAllowFileSubmission')?.checked;
        const classId = document.getElementById('modalAssignmentClassId')?.value || (TEACHER_TOKEN ? currentTeacherClassId : null);
        const selectedSkillTags = [...modal.querySelectorAll('.modal-skill-check:checked')].map(cb => cb.value).filter(Boolean);
        const mergedSkillTags = [...new Set(selectedSkillTags)];
        const maxQuizSubmissions = Math.max(0, Math.min(100, parseInt(document.getElementById('modalAssignmentMaxQuizSubmissions')?.value, 10) || 0));
        if (!name) { alert('Please enter an assignment name.'); return; }
        const payload = {
          name,
          task,
          maxScore,
          allowFileSubmission,
          classId,
          skillTags: mergedSkillTags,
          quizSettings: { maxSubmissions: maxQuizSubmissions },
          quiz: buildQuizPayload(quizQuestions)
        };
        const url = existingAssignment ? '/api/assignments/update' : '/api/assignments/create';
        try {
          const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...assignmentManagerHeaders() },
            body: JSON.stringify(payload)
          });
          const data = await resp.json().catch(() => ({}));
          if (!data.ok) { alert(data.error || 'Failed to save assignment'); return; }
          modal.remove();
          currentAdminAssignmentName = name;
          await loadAssignments();
          setAssignmentStatus(existingAssignment ? 'Assignment updated' : 'Assignment created');
        } catch (error) {
          alert('Network error');
        }
      });
    }

    function showAddQuestionModal(quizQuestions, renderCallback, questionIdCounter) {
      const questionModal = document.createElement('div');
      questionModal.className = 'modal workspace-modal glass-modal';
      questionModal.innerHTML = `
        <div class="modal-content">
          <div class="workspace-modal-header">
            <h3 style="margin:0;">Add Question</h3>
            <button class="btn secondary modal-exit-btn-q">Exit</button>
          </div>
          <div class="workspace-modal-body">
          <label>Question Type</label>
          <select id="questionType" style="width:100%; padding:8px; background:#0c0c0c; border:1px solid #333; color:#ddd; border-radius:4px; margin-bottom:12px;">
            <option value="multiple_choice">Multiple Choice</option>
            <option value="written">Written Response</option>
            <option value="multiple_choice_code">Multiple Choice (Code Reading)</option>
            <option value="written_code">Written Response (Code Reading)</option>
          </select>
          <label>Question Text</label>
          <textarea id="questionText" placeholder="Enter your question..." style="width:100%; min-height:80px; padding:8px; background:#0c0c0c; border:1px solid #333; color:#ddd; border-radius:4px; margin-bottom:12px; font-family:inherit;"></textarea>
          <label>Points</label>
          <input type="number" id="questionPoints" value="10" min="1" style="width:100%; padding:8px; background:#0c0c0c; border:1px solid #333; color:#ddd; border-radius:4px; margin-bottom:12px;" />
          <div id="mcOptionsSection" style="display:block; margin-top:12px;">
            <label style="display:block; margin-bottom:8px; color:#aaa; font-weight:600;">Answer Options (select the correct answer)</label>
            <div id="optionsList" style="margin-bottom:12px;"></div>
            <button type="button" class="btn secondary" id="addOptionBtn" style="font-size:13px; padding:8px 16px;">+ Add Option</button>
          </div>
          <div id="codeReadingSection" style="display:none; margin-top:12px;">
            <label>Code Language</label>
            <select id="questionCodeLanguage" style="width:100%; padding:8px; background:#0c0c0c; border:1px solid #333; color:#ddd; border-radius:4px; margin-bottom:8px;">
              <option value="python">Python</option>
              <option value="javascript">JavaScript</option>
              <option value="html">HTML</option>
            </select>
            <label>Code Snippet</label>
            <textarea id="questionCodeSnippet" placeholder="Paste or type code students must read..." style="width:100%; min-height:140px; padding:8px; background:#0c0c0c; border:1px solid #333; color:#ddd; border-radius:4px; margin-bottom:12px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;"></textarea>
          </div>
          <div class="modal-actions">
            <button class="btn run modal-add-btn-q">Add Question</button>
          </div>
          </div>
        </div>
      `;
      document.body.appendChild(questionModal);
      let options = ['Option 1', 'Option 2', 'Option 3', 'Option 4'];
      let correctAnswer = 0;

      function renderOptions() {
        const list = document.getElementById('optionsList');
        list.innerHTML = options.map((opt, idx) => `
          <div style="display:flex; gap:10px; margin-bottom:12px; align-items:center;">
            <input type="radio" name="correctAnswer" value="${idx}" ${idx === correctAnswer ? 'checked' : ''} style="margin:0; width:20px; height:20px; cursor:pointer; flex-shrink:0;">
            <input type="text" class="option-text-input" data-idx="${idx}" value="${escapeHtml(opt)}" placeholder="Enter option ${idx + 1} text..." style="flex:1; padding:10px 12px; background:#0c0c0c; border:1px solid #555; border-radius:6px; color:#eee; font-size:14px; min-width:0;" />
            ${options.length > 2 ? `<button class="btn-remove-option" data-idx="${idx}" style="background:#d32f2f; color:#fff; border:none; padding:8px 12px; border-radius:6px; cursor:pointer; font-size:12px; white-space:nowrap; flex-shrink:0;">Remove</button>` : ''}
          </div>
        `).join('');
        list.querySelectorAll('input[name="correctAnswer"]').forEach(radio => radio.addEventListener('change', (e) => { correctAnswer = parseInt(e.target.value, 10); }));
        list.querySelectorAll('.option-text-input').forEach(input => input.addEventListener('input', (e) => { options[parseInt(input.dataset.idx, 10)] = e.target.value; }));
        list.querySelectorAll('.btn-remove-option').forEach(btn => btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.idx, 10);
          options.splice(idx, 1);
          if (correctAnswer >= options.length) correctAnswer = options.length - 1;
          renderOptions();
        }));
      }

      document.getElementById('addOptionBtn').addEventListener('click', () => { if (options.length < 6) { options.push(`Option ${options.length + 1}`); renderOptions(); } });
      document.getElementById('questionType').addEventListener('change', (e) => {
        const type = e.target.value;
        document.getElementById('mcOptionsSection').style.display = (type === 'multiple_choice' || type === 'multiple_choice_code') ? 'block' : 'none';
        document.getElementById('codeReadingSection').style.display = (type === 'multiple_choice_code' || type === 'written_code') ? 'block' : 'none';
      });
      renderOptions();
      questionModal.querySelector('.modal-exit-btn-q')?.addEventListener('click', () => questionModal.remove());
      questionModal.querySelector('.modal-add-btn-q').addEventListener('click', () => {
        const type = document.getElementById('questionType').value;
        const textValue = document.getElementById('questionText').value.trim();
        const points = parseInt(document.getElementById('questionPoints').value, 10) || 10;
        if (!textValue) { alert('Please enter a question.'); return; }
        const question = { id: 'q' + Date.now() + '_' + (questionIdCounter.value++), type, question: textValue, points };
        if (type === 'multiple_choice' || type === 'multiple_choice_code') {
          const validOptions = options.filter(opt => opt.trim() !== '');
          if (validOptions.length < 2) { alert('Please add at least 2 non-empty options.'); return; }
          let validCorrectAnswer = 0;
          let validIdx = 0;
          for (let i = 0; i < options.length; i++) {
            if (options[i].trim() !== '') {
              if (i === correctAnswer) { validCorrectAnswer = validIdx; break; }
              validIdx++;
            }
          }
          question.options = validOptions;
          question.correctAnswer = validCorrectAnswer;
        }
        if (type === 'multiple_choice_code' || type === 'written_code') {
          const snippet = (document.getElementById('questionCodeSnippet').value || '').trim();
          if (!snippet) { alert('Code-reading questions require a code snippet.'); return; }
          question.codeLanguage = document.getElementById('questionCodeLanguage').value || 'python';
          question.codeSnippet = snippet;
        }
        quizQuestions.push(question);
        questionModal.remove();
        renderCallback();
      });
    }

    function showTeacherQuizPreviewModal(assignmentName, quizQuestions) {
      if (!Array.isArray(quizQuestions) || !quizQuestions.length) {
        alert('Add at least one quiz question first.');
        return;
      }
      const previewModal = document.createElement('div');
      previewModal.className = 'modal workspace-modal glass-modal';
      const totalPoints = quizQuestions.reduce((sum, q) => sum + (parseInt(q.points, 10) || 0), 0);
      previewModal.innerHTML = `
        <div class="modal-content">
          <div class="workspace-modal-header">
            <h3 style="margin:0;">View as Student: ${escapeHtml(assignmentName || 'Assignment')}</h3>
            <button class="btn secondary preview-exit-btn">Exit</button>
          </div>
          <div class="workspace-modal-body">
            <div style="font-size:12px; color:#aaa;">Preview mode only. Responses and scores are not saved.</div>
            <div id="previewQuestionsContainer" style="margin:12px 0;">
              ${quizQuestions.map((q, idx) => (q.type === 'multiple_choice' || q.type === 'multiple_choice_code') ? `
                <div class="question-block" style="margin-bottom:24px; padding:20px; background:#0d0d0d; border:1px solid #444; border-radius:10px;">
                  <div style="color:var(--columbia-blue); font-weight:700; margin-bottom:12px;">Question ${idx + 1} (${q.points || 0} pts)</div>
                  ${q.type === 'multiple_choice_code' ? `<div class="question-split"><div class="question-code-panel">${renderCodeSnippetBlock(q.codeSnippet || '', q.codeLanguage || 'python')}</div><div>` : ''}
                  <div style="color:#eee; margin-bottom:14px; font-size:15px; line-height:1.6;">${escapeHtml(q.question || '')}</div>
                  ${(q.options || []).map((opt, optIdx) => `
                    <label style="display:flex; align-items:center; gap:12px; margin:8px 0; padding:10px; background:#1a1a1a; border:1px solid #333; border-radius:8px; cursor:pointer;">
                      <input type="radio" name="preview_question_${q.id}" value="${optIdx}">
                      <span>${escapeHtml(opt)}</span>
                    </label>
                  `).join('')}
                  ${q.type === 'multiple_choice_code' ? '</div></div>' : ''}
                </div>
              ` : `
                <div class="question-block" style="margin-bottom:24px; padding:20px; background:#0d0d0d; border:1px solid #444; border-radius:10px;">
                  <div style="color:var(--columbia-blue); font-weight:700; margin-bottom:12px;">Question ${idx + 1} (${q.points || 0} pts)</div>
                  ${q.type === 'written_code' ? `<div class="question-split"><div class="question-code-panel">${renderCodeSnippetBlock(q.codeSnippet || '', q.codeLanguage || 'python')}</div><div>` : ''}
                  <div style="color:#eee; margin-bottom:12px; font-size:15px; line-height:1.6;">${escapeHtml(q.question || '')}</div>
                  <textarea id="preview_written_answer_${q.id}" placeholder="Type your answer here..." style="width:100%; min-height:140px; padding:14px; background:#1a1a1a; border:2px solid #444; border-radius:8px; color:#eee; font-family:inherit; resize:vertical; font-size:15px; line-height:1.5;"></textarea>
                  ${q.type === 'written_code' ? '</div></div>' : ''}
                </div>
              `).join('')}
            </div>
            <div class="modal-actions" style="display:flex; gap:10px; justify-content:flex-end;">
              <button class="btn run preview-submit-btn">Submit Preview</button>
            </div>
            <div id="previewResultBox" style="margin-top:10px; font-size:14px; color:#ddd;"></div>
          </div>
        </div>
      `;
      document.body.appendChild(previewModal);
      previewModal.querySelector('.preview-exit-btn')?.addEventListener('click', () => previewModal.remove());
      previewModal.querySelector('.preview-submit-btn')?.addEventListener('click', () => {
        let score = 0;
        quizQuestions.forEach((q) => {
          if (q.type === 'multiple_choice' || q.type === 'multiple_choice_code') {
            const selected = previewModal.querySelector(`input[name="preview_question_${q.id}"]:checked`);
            if (selected && parseInt(selected.value, 10) === q.correctAnswer) {
              score += parseInt(q.points, 10) || 0;
            }
          }
        });
        const result = previewModal.querySelector('#previewResultBox');
        if (result) {
          result.innerHTML = `<strong>Preview Score:</strong> ${score} / ${totalPoints} <span style="color:#888;">(written-response questions are shown but not auto-scored in preview)</span>`;
        }
      });
    }

    async function toggleAssignmentActive(name, active) {
      try {
        const resp = await fetch('/api/assignments/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...assignmentManagerHeaders() },
          body: JSON.stringify({ name, active })
        });
        const data = await resp.json().catch(() => ({}));
        if (!data.ok) { alert(data.error || 'Failed to update assignment'); return; }
        await loadAssignments();
        setAssignmentStatus(active ? 'Assignment unlocked' : 'Assignment locked');
      } catch (error) {
        alert('Network error');
      }
    }

    async function deleteAssignment(name) {
      if (!confirm(`Delete assignment "${name}"? This removes the stored submission folder too.`)) return;
      try {
        const resp = await fetch('/api/assignments/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...assignmentManagerHeaders() },
          body: JSON.stringify({ name })
        });
        const data = await resp.json().catch(() => ({}));
        if (!data.ok) { alert(data.error || 'Failed to delete assignment'); return; }
        if (currentAdminAssignmentName === name) currentAdminAssignmentName = null;
        hideSubmissionScoringPanel();
        await loadAssignments();
        setAssignmentStatus('Assignment deleted');
      } catch (error) {
        alert('Network error');
      }
    }

    async function copyAssignmentToClass(name) {
      const list = document.getElementById('assignmentList');
      const classId = list?.querySelector(`.copy-assignment-class-select[data-name="${CSS.escape(name)}"]`)?.value || '';
      if (!classId) {
        alert('Select a destination class first.');
        return;
      }
      const source = getAssignmentByName(name);
      const targetClass = teacherClasses.find(c => c.id === classId);
      const defaultName = `${name} (${targetClass?.name || 'Copy'})`;
      const newName = prompt('Name for the copied assignment:', defaultName);
      if (newName === null) return;
      const trimmedName = (newName || '').trim();
      if (!trimmedName) {
        alert('Assignment name is required.');
        return;
      }
      try {
        const resp = await fetch('/api/assignments/copy-to-class', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...assignmentManagerHeaders() },
          body: JSON.stringify({ assignmentName: name, targetClassId: classId, newName: trimmedName })
        });
        const data = await resp.json().catch(() => ({}));
        if (!data.ok) { alert(data.error || 'Failed to copy assignment'); return; }
        currentAdminAssignmentName = trimmedName;
        activeAssignmentsClassId = classId;
        currentTeacherClassId = classId;
        syncTeacherDashboardClassSelectors();
        renderClassSelector();
        await loadAssignments();
        setAssignmentStatus(`Copied "${name}" to ${targetClass?.name || 'selected class'}.`);
      } catch {
        alert('Network error');
      }
    }

    function showAssignmentSubmitModal(assignmentName) {
      if (!USER_TOKEN || !currentUser) {
        alert('Please sign in with a student account first.');
        return;
      }
      const assignment = getAssignmentByName(assignmentName);
      if (assignment?.allowFileSubmission === false) {
        alert('File submissions are disabled for this assignment.');
        return;
      }
      const files = flattenFiles(_allFileTree || []);
      if (!files.length) {
        alert('Create or upload a file in your account before submitting.');
        return;
      }
      const selectedPath = currentOpenFile?.path && files.some(file => file.path === currentOpenFile.path) ? currentOpenFile.path : files[0].path;
      const modal = document.createElement('div');
      modal.className = 'modal glass-modal';
      modal.innerHTML = `
        <div class="modal-content" style="max-width:520px;">
          <h3>Submit: ${escapeHtml(assignmentName)}</h3>
          <p style="color:#888; font-size:13px;">Submitting as <strong>${escapeHtml(currentUser.name || currentUser.email)}</strong>. Pick the file from your account to copy into the assignment owner workspace.</p>
          <label for="assignmentFileSelect">File to submit</label>
          <select id="assignmentFileSelect" style="width:100%; padding:10px; background:var(--theme-input-bg); color:var(--theme-text); border:1px solid var(--theme-border); border-radius:8px;">
            ${files.map(file => `<option value="${escapeHtml(file.path)}" ${file.path === selectedPath ? 'selected' : ''}>${escapeHtml(file.path)}</option>`).join('')}
          </select>
          <div class="modal-actions">
            <button class="btn secondary modal-cancel-btn">Cancel</button>
            <button class="btn run modal-submit-btn">Submit File</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
      modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
      modal.querySelector('.modal-cancel-btn').addEventListener('click', () => modal.remove());
      modal.querySelector('.modal-submit-btn').addEventListener('click', async () => {
        const filePath = document.getElementById('assignmentFileSelect').value;
        if (!filePath) { alert('Select a file first.'); return; }
        if (currentOpenFile?.path === filePath) {
          const saved = await saveCurrentFile();
          if (!saved) {
            alert('Your latest edits could not be saved. Please save the file again before submitting.');
            return;
          }
        }
        try {
          const resp = await fetch('/api/assignments/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-User-Token': USER_TOKEN },
            body: JSON.stringify({ assignmentName, filePath })
          });
          const data = await resp.json().catch(() => ({}));
          if (!data.ok) { alert(data.error || 'Failed to submit assignment'); return; }
          modal.remove();
          alert('Assignment submitted successfully.');
          await loadAssignments();
        } catch (error) {
          alert('Network error');
        }
      });
    }

    async function openQuestions(assignmentName) {
      if (!USER_TOKEN || !currentUser) {
        alert('Please sign in with a student account first.');
        return;
      }
      try {
        const resp = await fetch(`/api/quiz/${encodeURIComponent(assignmentName)}`, {
          headers: { 'X-User-Token': USER_TOKEN }
        });
        const data = await resp.json().catch(() => ({}));
        if (!data.ok) { alert(data.error || 'Failed to load questions'); return; }
        const quiz = data.quiz || {};
        const quizSettings = data.quizSettings || {};
        const questions = quiz.questions || [];
        if (!questions.length) { alert('This assignment has no questions.'); return; }
        const maxSubmissions = parseInt(quizSettings.maxSubmissions, 10) || 0;
        const submissionCount = parseInt(data.submissionCount, 10) || 0;
        if (maxSubmissions > 0 && submissionCount >= maxSubmissions) {
          alert('You have reached the maximum number of quiz submissions for this assignment.');
          return;
        }
        const modal = document.createElement('div');
        modal.className = 'modal workspace-modal glass-modal';
        modal.innerHTML = `
          <div class="modal-content">
            <h3 style="margin-top:0; color:var(--columbia-blue);">Assignment Questions: ${escapeHtml(assignmentName)}</h3>
            <p style="color:#aaa; font-size:14px; margin:10px 0 20px;">Submitting as <strong style="color:#eee;">${escapeHtml(currentUser.name || currentUser.email)}</strong>. You must submit to exit this window.</p>
            <div class="quiz-lock-note">
              ${maxSubmissions > 0 ? `Attempts used: ${submissionCount}/${maxSubmissions}. Remaining: ${Math.max(0, maxSubmissions - submissionCount)}.` : 'Unlimited resubmissions are enabled for this assignment.'}
              <div class="no-exit-text">Closing the browser tab/window will record a submission attempt with your current answers.</div>
            </div>
            <div id="questionsContainer" style="margin:20px 0;">
              ${questions.map((q, idx) => (q.type === 'multiple_choice' || q.type === 'multiple_choice_code') ? `
                <div class="question-block" style="margin-bottom:30px; padding:24px; background:#0d0d0d; border:1px solid #444; border-radius:10px;">
                  <div style="color:var(--columbia-blue); font-weight:700; margin-bottom:14px; font-size:16px;">Question ${idx + 1} <span style="color:#888; font-weight:400; font-size:14px;">(${q.points || 0} points)</span></div>
                  ${q.type === 'multiple_choice_code' ? `
                    <div class="question-split">
                      <div class="question-code-panel">${renderCodeSnippetBlock(q.codeSnippet || '', q.codeLanguage || 'python')}</div>
                      <div>
                        <div style="color:#eee; margin-bottom:18px; font-size:15px; line-height:1.6;">${escapeHtml(q.question)}</div>
                        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:10px;">
                        ${(q.options || []).map((opt, optIdx) => `
                          <label style="display:flex; align-items:center; gap:12px; margin:10px 0; padding:12px; background:#1a1a1a; border:1px solid #333; border-radius:8px; cursor:pointer;">
                            <input type="radio" name="question_${q.id}" value="${optIdx}">
                            <span>${escapeHtml(opt)}</span>
                          </label>
                        `).join('')}
                        </div>
                      </div>
                    </div>
                  ` : `
                    <div style="color:#eee; margin-bottom:18px; font-size:15px; line-height:1.6;">${escapeHtml(q.question)}</div>
                    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:10px;">
                    ${(q.options || []).map((opt, optIdx) => `
                      <label style="display:flex; align-items:center; gap:12px; margin:10px 0; padding:12px; background:#1a1a1a; border:1px solid #333; border-radius:8px; cursor:pointer;">
                        <input type="radio" name="question_${q.id}" value="${optIdx}">
                        <span>${escapeHtml(opt)}</span>
                      </label>
                    `).join('')}
                    </div>
                  `}
                </div>
              ` : `
                <div class="question-block" style="margin-bottom:30px; padding:24px; background:#0d0d0d; border:1px solid #444; border-radius:10px;">
                  <div style="color:var(--columbia-blue); font-weight:700; margin-bottom:14px; font-size:16px;">Question ${idx + 1} <span style="color:#888; font-weight:400; font-size:14px;">(${q.points || 0} points)</span></div>
                  ${q.type === 'written_code' ? `
                    <div class="question-split">
                      <div class="question-code-panel">${renderCodeSnippetBlock(q.codeSnippet || '', q.codeLanguage || 'python')}</div>
                      <div>
                        <div style="color:#eee; margin-bottom:18px; font-size:15px; line-height:1.6;">${escapeHtml(q.question)}</div>
                        <textarea id="written_answer_${q.id}" placeholder="Type your answer here..." style="width:100%; min-height:160px; padding:14px; background:#1a1a1a; border:2px solid #444; border-radius:8px; color:#eee; font-family:inherit; resize:vertical; font-size:15px; line-height:1.5;"></textarea>
                      </div>
                    </div>
                  ` : `
                    <div style="color:#eee; margin-bottom:18px; font-size:15px; line-height:1.6;">${escapeHtml(q.question)}</div>
                    <textarea id="written_answer_${q.id}" placeholder="Type your answer here..." style="width:100%; min-height:140px; padding:14px; background:#1a1a1a; border:2px solid #444; border-radius:8px; color:#eee; font-family:inherit; resize:vertical; font-size:15px; line-height:1.5;"></textarea>
                  `}
                </div>
              `).join('')}
            </div>
            <div class="modal-actions" style="display:flex; gap:12px; justify-content:flex-end; margin-top:30px; padding-top:20px; border-top:1px solid #333;">
              <button class="btn run modal-submit-questions-btn">Submit Answers</button>
            </div>
          </div>
        `;
        document.body.appendChild(modal);
        if (socket) socket.emit('quiz_open', { assignmentName });
        activeQuizSession = { assignmentName, questions, modal, submitted: false };
        modal.querySelectorAll('textarea[id^="written_answer_"]').forEach(textarea => {
          textarea.addEventListener('paste', (e) => e.preventDefault());
        });
        const autoSubmitOnClose = () => {
          if (!activeQuizSession || activeQuizSession.submitted) return;
          if (socket) socket.emit('quiz_close', { assignmentName });
          const payload = buildQuizResponsesFromModal(questions, modal, true);
          fetch('/api/quiz/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-User-Token': USER_TOKEN },
            body: JSON.stringify({ assignmentName, quizResponses: payload.responses, closedByStudent: true }),
            keepalive: true
          }).catch(() => {});
        };
        activeQuizSession.autoSubmitOnClose = autoSubmitOnClose;
        window.addEventListener('beforeunload', autoSubmitOnClose);
        modal.querySelector('.modal-submit-questions-btn').addEventListener('click', async () => {
          await submitQuestionAnswers(assignmentName, questions, modal);
          if (activeQuizSession?.submitted) {
            window.removeEventListener('beforeunload', autoSubmitOnClose);
            activeQuizSession = null;
          }
        });
      } catch (error) {
        alert('Network error loading questions');
      }
    }

    function buildQuizResponsesFromModal(questions, modal, allowPartial = false) {
      const quizResponses = [];
      const missing = [];
      questions.forEach((q, idx) => {
        if (q.type === 'multiple_choice' || q.type === 'multiple_choice_code') {
          const selected = modal.querySelector(`input[name="question_${q.id}"]:checked`);
          if (!selected) { missing.push(idx + 1); return; }
          quizResponses.push({ questionId: q.id, answer: parseInt(selected.value, 10), questionType: q.type });
        } else {
          const value = modal.querySelector(`#written_answer_${q.id}`)?.value?.trim() || '';
          if (!value) { missing.push(idx + 1); return; }
          quizResponses.push({ questionId: q.id, answer: value, questionType: q.type });
        }
      });
      if (allowPartial && missing.length) {
        questions.forEach((q) => {
          if (quizResponses.some(r => r.questionId === q.id)) return;
          quizResponses.push({ questionId: q.id, answer: (q.type.includes('multiple_choice') ? null : ''), questionType: q.type });
        });
      }
      return { responses: quizResponses, missing };
    }

    async function submitQuestionAnswers(assignmentName, questions, modal) {
      const built = buildQuizResponsesFromModal(questions, modal, false);
      const quizResponses = built.responses;
      const missing = built.missing;
      if (missing.length) {
        alert(`Please answer all questions before submitting. Missing: ${missing.join(', ')}`);
        return;
      }
      try {
        const submitResp = await fetch('/api/quiz/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-User-Token': USER_TOKEN },
          body: JSON.stringify({ assignmentName, quizResponses, closedByStudent: false })
        });
        const submitData = await submitResp.json().catch(() => ({}));
        if (!submitData.ok) { alert(submitData.error || 'Failed to submit answers'); return; }
        if (activeQuizSession) activeQuizSession.submitted = true;
        if (socket) socket.emit('quiz_close', { assignmentName });
        modal.remove();
        alert('Your answers were submitted successfully.');
        await openStudentScoreReport(assignmentName);
        await loadAssignments();
      } catch (error) {
        alert('Network error submitting answers');
      }
    }

    async function openStudentScoreReport(assignmentName) {
      if (!USER_TOKEN || !currentUser) return;
      const modal = document.createElement('div');
      modal.className = 'modal glass-modal';
      modal.innerHTML = `
        <div class="modal-content" style="max-width:760px;">
          <h3>Score Report</h3>
          <div id="studentScoreReportBody" style="color:#aaa;">Loading report…</div>
          <div class="modal-actions">
            <button class="btn secondary score-report-close-btn">Close</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
      modal.querySelector('.score-report-close-btn')?.addEventListener('click', () => modal.remove());
      modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
      try {
        const resp = await fetch(`/api/quiz/report/${encodeURIComponent(assignmentName)}`, {
          headers: { 'X-User-Token': USER_TOKEN }
        });
        const data = await resp.json().catch(() => ({}));
        const body = modal.querySelector('#studentScoreReportBody');
        if (!body) return;
        if (!data.ok) {
          body.textContent = data.error || 'Unable to load score report.';
          return;
        }
        const report = data.report || {};
        const tags = report.skillScores || {};
        body.innerHTML = `
          <div style="font-size:13px; margin-bottom:6px;"><strong>Assignment:</strong> ${escapeHtml(report.assignmentName || assignmentName)}</div>
          <div style="font-size:13px; margin-bottom:6px;"><strong>Submitted:</strong> ${escapeHtml(report.submittedAt || '—')}</div>
          <div style="font-size:13px; margin-bottom:10px;"><strong>Total Score:</strong> ${report.totalScore ?? '—'} / ${report.maxTotal ?? '—'}</div>
          <div style="font-size:12px; color:#888; margin-bottom:10px;">This report shows score and skill-tag achievement only. Correct answers are never shown.</div>
          <div class="score-report-list">
            ${Object.keys(tags).map(tag => `
              <div class="score-report-item">
                <strong>${escapeHtml(tag)}</strong>
                <div style="margin-top:4px; color:#ddd;">Achievement: ${tags[tag] === null || tags[tag] === undefined ? 'Untested' : `${Math.round(tags[tag])}%`}</div>
              </div>
            `).join('') || '<div style="color:#888;">No skill tags configured for this assignment.</div>'}
          </div>
        `;
      } catch {
        const body = modal.querySelector('#studentScoreReportBody');
        if (body) body.textContent = 'Network error loading report.';
      }
    }

    async function openAssignmentSubmission(assignmentName, email) {
      const { assignment, submission } = getSubmissionForAssignment(assignmentName, email);
      if (!assignment || !submission) return;
      currentAdminAssignmentName = assignmentName;
      showFileBrowser();
      if (submission.adminFilePath) {
        await openFile({ path: submission.adminFilePath, name: submission.submittedFileName || `${submission.name || email}.py` });
      } else {
        editor.setValue(submission.code || '');
        syncEditorLanguage(submission.submittedFileName || '');
      }
      populateSubmissionScoringPanel(assignment, submission);
      renderAdminAssignments();
    }

    async function resetQuizCounter(assignmentName, email) {
      if (!confirm('Reset this student\'s quiz submission counter?')) return;
      try {
        const resp = await fetch('/api/quiz/reset-counter', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...assignmentManagerHeaders() },
          body: JSON.stringify({ assignmentName, studentEmail: email })
        });
        const data = await resp.json().catch(() => ({}));
        if (!data.ok) {
          alert(data.error || 'Failed to reset submission counter');
          return;
        }
        await loadAssignments();
      } catch {
        alert('Network error');
      }
    }

    function openQuizGradingModal(assignmentName, studentEmail) {
      const { assignment, submission } = getSubmissionForAssignment(assignmentName, studentEmail);
      if (!assignment || !submission) return;
      const questionsById = new Map((assignment.quiz?.questions || []).map(q => [q.id, q]));
      const quizResponses = submission.quizResponses || [];
      const modal = document.createElement('div');
      modal.className = 'modal glass-modal';
      modal.innerHTML = `
        <div class="modal-content" style="max-width:1100px; max-height:90vh; overflow:auto;">
          <h3>Grade Quiz Responses</h3>
          <div style="margin-bottom:10px; color:#aaa;">${escapeHtml(assignment.name)} · ${escapeHtml(submission.name || submission.email || studentEmail)}</div>
          <div id="quizGradeBody">
            ${quizResponses.map((resp, idx) => {
              const q = questionsById.get(resp.questionId) || {};
              const isWritten = (q.type === 'written' || q.type === 'written_code');
              const maxPts = q.points || 0;
              const answer = resp.answer ?? '';
              return `
                <div style="border:1px solid var(--theme-border-mid); border-radius:8px; padding:12px; margin-bottom:12px;">
                  <div style="font-weight:700; color:var(--columbia-blue); margin-bottom:6px;">Question ${idx + 1} (${maxPts} pts)</div>
                  ${q.type === 'written_code' || q.type === 'multiple_choice_code' ? `<div class="question-code-panel" style="margin-bottom:10px; max-height:220px;">${renderCodeSnippetBlock(q.codeSnippet || '', q.codeLanguage || 'python')}</div>` : ''}
                  <div style="margin-bottom:8px; color:#ddd;">${escapeHtml(q.question || 'Question')}</div>
                  <div style="margin-bottom:8px;"><strong>Student Answer:</strong> ${isWritten ? `<div style="margin-top:6px; padding:8px; background:#111; border:1px solid #333; border-radius:6px; white-space:pre-wrap;">${escapeHtml(answer)}</div>` : escapeHtml(String(answer))}</div>
                  <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
                    <label style="margin:0;">Score</label>
                    <input type="number" class="quiz-manual-score" data-question-id="${escapeHtml(resp.questionId)}" data-max="${maxPts}" value="${resp.manualScore ?? resp.pointsEarned ?? ''}" min="0" max="${maxPts}" style="width:120px;">
                    ${isWritten ? `<button class="btn secondary quiz-ai-grade-btn" data-question-id="${escapeHtml(resp.questionId)}">AI Grade</button>` : ''}
                    <span class="quiz-score-save-status" data-question-id="${escapeHtml(resp.questionId)}" style="font-size:12px; color:#888;"></span>
                  </div>
                </div>
              `;
            }).join('') || '<div style="color:#888;">No responses submitted yet.</div>'}
          </div>
          <div class="modal-actions">
            <button class="btn secondary modal-close-quiz-grade">Close</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
      const saveManual = async (questionId, value, statusEl) => {
        const max = parseInt(modal.querySelector(`.quiz-manual-score[data-question-id="${CSS.escape(questionId)}"]`)?.dataset.max || '0', 10);
        const parsed = value === '' ? null : Math.max(0, Math.min(max, parseInt(value, 10)));
        if (value !== '' && Number.isNaN(parsed)) {
          statusEl.textContent = 'Invalid score';
          return;
        }
        statusEl.textContent = 'Saving…';
        const resp = await fetch('/api/quiz/override-score', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...assignmentManagerHeaders() },
          body: JSON.stringify({ assignmentName, studentEmail, questionId, manualScore: parsed })
        });
        const data = await resp.json().catch(() => ({}));
        if (!data.ok) {
          statusEl.textContent = data.error || 'Save failed';
          return;
        }
        statusEl.textContent = 'Saved';
        await loadAssignments();
      };
      modal.querySelectorAll('.quiz-manual-score').forEach(input => {
        let timer = null;
        input.addEventListener('input', () => {
          const questionId = input.dataset.questionId;
          const statusEl = modal.querySelector(`.quiz-score-save-status[data-question-id="${CSS.escape(questionId)}"]`);
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => saveManual(questionId, input.value, statusEl), 450);
        });
      });
      modal.querySelectorAll('.quiz-ai-grade-btn').forEach(btn => btn.addEventListener('click', async () => {
        const questionId = btn.dataset.questionId;
        const statusEl = modal.querySelector(`.quiz-score-save-status[data-question-id="${CSS.escape(questionId)}"]`);
        const q = questionsById.get(questionId) || {};
        const resp = quizResponses.find(r => r.questionId === questionId) || {};
        statusEl.textContent = 'AI grading…';
        try {
          const response = await fetch('/api/quiz/grade-written', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...assignmentManagerHeaders() },
            body: JSON.stringify(buildAiContext({
              assignmentName,
              studentEmail,
              questionId,
              answer: resp.answer || '',
              questionText: q.question || '',
              maxPoints: q.points || 0
            }))
          });
          const data = await response.json().catch(() => ({}));
          if (!data.ok) {
            statusEl.textContent = data.error || 'AI grading failed';
            return;
          }
          const input = modal.querySelector(`.quiz-manual-score[data-question-id="${CSS.escape(questionId)}"]`);
          if (input) input.value = String(data.aiScore ?? '');
          statusEl.textContent = 'AI score saved';
          await loadAssignments();
        } catch {
          statusEl.textContent = 'Network error';
        }
      }));
      modal.querySelector('.modal-close-quiz-grade')?.addEventListener('click', () => modal.remove());
      modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    }

    function populateSubmissionScoringPanel(assignment, submission) {
      activeSubmissionContext = { assignmentName: assignment.name, studentEmail: submission.email };
      const panel = document.getElementById('submissionScoringPanel');
      const title = document.getElementById('submissionScoringTitle');
      const meta = document.getElementById('submissionScoringMeta');
      const quiz = document.getElementById('submissionQuizSummary');
      const totals = document.getElementById('submissionScoreTotals');
      const input = document.getElementById('submissionScoreInput');
      const aiBtn = document.getElementById('submissionAiGradeBtn');
      const maxScore = assignment.maxScore || 100;
      const maxTotal = assignmentTotalMaxScore(assignment);
      panel.style.display = 'flex';
      title.innerHTML = `
        <span class="submission-scoring-line assignment">${escapeHtml(assignment.name || 'Assignment')}</span>
        <span class="submission-scoring-line student">${escapeHtml(submission.name || submission.email || 'Student')}</span>
      `;
      meta.innerHTML = `File: <strong>${escapeHtml(submission.submittedFileName || '—')}</strong><br>Submitted: ${escapeHtml(submission.submittedAt || '—')}`;
      if (submission.quizScore !== null && submission.quizScore !== undefined) {
        quiz.style.display = 'block';
        quiz.textContent = `Quiz score: ${submission.quizScore}${assignment.quiz?.totalPoints ? ` / ${assignment.quiz.totalPoints}` : ''}`;
      } else {
        quiz.style.display = 'none';
        quiz.textContent = '';
      }
      input.max = String(assignment.allowFileSubmission === false ? 0 : maxScore);
      input.disabled = assignment.allowFileSubmission === false;
      input.value = submission.codeScore ?? submission.score ?? '';
      totals.textContent = `Code max ${assignment.allowFileSubmission === false ? 0 : maxScore} · Total max ${maxTotal}${submission.totalScore !== null && submission.totalScore !== undefined ? ` · Total ${submission.totalScore}` : ''}`;
      aiBtn.style.display = (currentConfig?.ai_explainer_enabled && assignment.allowFileSubmission !== false) ? '' : 'none';
      document.getElementById('submissionScoreSaveStatus').textContent = '';
    }

    async function saveSubmissionScore(assignmentName, email, rawScore) {
      const status = document.getElementById('submissionScoreSaveStatus');
      const parsedScore = rawScore === '' ? null : parseInt(rawScore, 10);
      if (rawScore !== '' && Number.isNaN(parsedScore)) {
        status.textContent = 'Enter a valid score.';
        return;
      }
      status.textContent = 'Saving…';
      try {
        const response = await fetch('/api/assignments/score', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...assignmentManagerHeaders() },
          body: JSON.stringify({ assignmentName, studentEmail: email, score: parsedScore })
        });
        const result = await response.json().catch(() => ({}));
        if (!result.ok) {
          status.textContent = result.error || 'Failed to save score.';
          return;
        }
        status.textContent = 'Saved automatically.';
        await loadAssignments();
      } catch (error) {
        status.textContent = 'Network error while saving.';
      }
    }

    document.getElementById('submissionScoreInput').addEventListener('input', (e) => {
      if (!activeSubmissionContext) return;
      if (submissionSaveTimer) clearTimeout(submissionSaveTimer);
      submissionSaveTimer = setTimeout(() => {
        saveSubmissionScore(activeSubmissionContext.assignmentName, activeSubmissionContext.studentEmail, e.target.value);
      }, 500);
    });

    document.getElementById('submissionAiGradeBtn').addEventListener('click', async () => {
      if (!activeSubmissionContext) return;
      const { assignment, submission } = getSubmissionForAssignment(activeSubmissionContext.assignmentName, activeSubmissionContext.studentEmail);
      if (!assignment || !submission) return;
      const status = document.getElementById('submissionScoreSaveStatus');
      status.textContent = 'Running AI grader…';
      try {
        const response = await fetch('/api/assignments/grade-ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...assignmentManagerHeaders() },
          body: JSON.stringify(buildAiContext({
            assignmentName: assignment.name,
            studentEmail: submission.email,
            code: submission.code || '',
            task: assignment.task || '',
            maxScore: assignment.maxScore || 100,
            fileName: submission.submittedFileName || ''
          }))
        });
        const result = await response.json().catch(() => ({}));
        if (!result.ok) {
          status.textContent = result.error || 'AI grading failed.';
          return;
        }
        document.getElementById('submissionScoreInput').value = result.score;
        status.textContent = 'AI grade saved automatically.';
        await loadAssignments();
      } catch (error) {
        status.textContent = 'Network error during AI grading.';
      }
    });

    async function downloadCSV(assignmentName) {
      const url = `/api/assignments/${encodeURIComponent(assignmentName)}/csv`;
      try {
        const resp = await fetch(url, { headers: assignmentManagerHeaders() });
        if (!resp.ok) { alert('Failed to download CSV'); return; }
        const blob = await resp.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = `${assignmentName}_scores.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
      } catch (error) {
        alert('Network error');
      }
    }

    window.afterAuthUiUpdate = async () => {
      if (USER_TOKEN) await loadStudentClassData();
      if (TEACHER_TOKEN) await loadTeacherClasses();
      renderClassSelector();
      refreshChallengeAuthState();
      await loadAssignments();
    };

    (async () => {
      if (USER_TOKEN) await loadStudentClassData();
      if (TEACHER_TOKEN) await loadTeacherClasses();
      renderClassSelector();
      await loadAssignments();
      refreshChallengeAuthState();
    })();
