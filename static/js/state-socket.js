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

    function makeHtmlRuntimeChannelId() {
      if (window.crypto?.randomUUID) return window.crypto.randomUUID().replace(/[^A-Za-z0-9_-]/g, '');
      return `rt${Date.now()}${Math.random().toString(36).slice(2)}`.replace(/[^A-Za-z0-9_-]/g, '');
    }

    function appendHtmlRuntimeLog(payload) {
      const lvl = String(payload.level || 'info').toUpperCase();
      const msg = String(payload.message || '').trim();
      if (!msg) return;
      appendOut(`[HTML ${lvl}] ${msg}\n`);
    }

    function teardownHtmlRuntimeBroadcast() {
      if (htmlRuntimeCloseMonitor) {
        clearTimeout(htmlRuntimeCloseMonitor);
        htmlRuntimeCloseMonitor = null;
      }
      try {
        if (htmlRuntimeWindow?.channel) htmlRuntimeWindow.channel.close();
      } catch {}
      if (htmlRuntimeWindow) htmlRuntimeWindow.channel = null;
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

    function notifyHtmlRuntimePopup(payload) {
      try {
        htmlRuntimeWindow?.channel?.postMessage(payload);
      } catch {}
    }

    function closeHtmlRuntimeWindow() {
      const runtimeId = htmlRuntimeId;
      notifyHtmlRuntimePopup({ type: 'stop', reason: 'Execution stopped.' });
      try {
        if (htmlRuntimeWindow?.popup && !htmlRuntimeWindow.popup.closed) {
          htmlRuntimeWindow.popup.close();
        } else if (htmlRuntimeWindow && !htmlRuntimeWindow.closed) {
          htmlRuntimeWindow.close();
        }
      } catch {}
      teardownHtmlRuntimeBroadcast();
      htmlRuntimeWindow = null;
      cleanupHtmlRuntimeSession(runtimeId);
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

    function openHtmlRuntimePopupShell() {
      closeHtmlRuntimeWindow();
      if (!('BroadcastChannel' in window)) {
        appendOut('[HTML Runtime] This browser does not support isolated HTML previews.\n');
        return false;
      }
      const channelId = makeHtmlRuntimeChannelId();
      const channel = new BroadcastChannel(`eagle-html-runtime-${channelId}`);
      channel.onmessage = (event) => {
        const payload = event.data || {};
        if (payload.type === 'eagle-html-runtime-log') {
          appendHtmlRuntimeLog(payload);
        } else if (payload.type === 'closed') {
          const closedRuntimeId = String(payload.runtime_id || '');
          if (closedRuntimeId && closedRuntimeId === htmlRuntimeId) cleanupHtmlRuntimeSession(closedRuntimeId);
          teardownHtmlRuntimeBroadcast();
          htmlRuntimeWindow = null;
          setRunButtonState(false);
        }
      };
      htmlRuntimeId = '';
      const popup = window.open(`/api/html-runtime/popup/${encodeURIComponent(channelId)}`, `eagle-html-runtime-${channelId}`, 'popup=yes,width=1100,height=760');
      if (!popup) {
        appendOut('[HTML Runtime] Popup blocked by browser.\n');
        try { channel.close(); } catch {}
        setRunButtonState(false);
        return false;
      }
      htmlRuntimeWindow = { popup, channel, channelId };
      appendOut('[HTML Runtime] Preparing WebView...\n');
      return true;
    }

    function openHtmlRuntimePopup(runtimeData) {
      if (!runtimeData?.runtime_id || !runtimeData?.view_url) {
        appendOut('[HTML Runtime] Invalid runtime response\n');
        notifyHtmlRuntimePopup({ type: 'error', message: 'Invalid runtime response.' });
        setRunButtonState(false);
        return;
      }

      htmlRuntimeId = runtimeData.runtime_id;
      const timeoutSeconds = Number(runtimeData.timeout_seconds || 30);
      const title = `HTML WebView • ${currentOpenFile?.name || 'index.html'}`;
      if (htmlRuntimeCloseMonitor) clearTimeout(htmlRuntimeCloseMonitor);
      htmlRuntimeCloseMonitor = setTimeout(() => {
        setRunButtonState(false);
        cleanupHtmlRuntimeSession(runtimeData.runtime_id);
      }, Math.max(1000, Math.floor((timeoutSeconds + 5) * 1000)));
      notifyHtmlRuntimePopup({
        type: 'load',
        runtime: {
          runtime_id: runtimeData.runtime_id,
          view_url: runtimeData.view_url,
          timeout_seconds: timeoutSeconds,
          allow_popups: !!runtimeData.allow_popups,
          title
        }
      });
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
      if (csvEditorActive) {
        appendOut('[Run skipped: CSV files use spreadsheet editing only.]\n');
        return;
      }
      if (isHtmlRuntimeFile(currentOpenFile?.name || '')) {
        if (!currentOpenFile?.path) {
          appendOut('[HTML Runtime] Open an HTML file first.\n');
          return;
        }
        if (!openHtmlRuntimePopupShell()) return;
        setRunButtonState(true);
        if (currentOpenFile && (USER_TOKEN || TEACHER_TOKEN || ADMIN_TOKEN)) {
          try {
            await saveCurrentFile();
          } catch (err) {
            appendOut(`[Warning: could not save "${currentOpenFile.name}" before running: ${err}]\n`);
          }
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
            notifyHtmlRuntimePopup({ type: 'error', message: j?.error || 'Failed to start HTML runtime' });
            setRunButtonState(false);
            return;
          }
          openHtmlRuntimePopup(j);
        } catch (err) {
          appendOut('[HTML Runtime Error] Network error while starting HTML runtime.\n');
          notifyHtmlRuntimePopup({ type: 'error', message: 'Network error while starting HTML runtime.' });
          setRunButtonState(false);
        }
        return;
      }
      // Save current file before running Python or JavaScript.
      if (currentOpenFile && (USER_TOKEN || TEACHER_TOKEN || ADMIN_TOKEN)) {
        try {
          await saveCurrentFile();
        } catch (err) {
          appendOut(`[Warning: could not save "${currentOpenFile.name}" before running: ${err}]\n`);
        }
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

    