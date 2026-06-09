function initEditor() {
      const ta = document.getElementById('editor');
      // Determine saved theme at startup
      let _savedCmTheme = 'monokai';
      try { _savedCmTheme = localStorage.getItem('ide-theme') === 'light' ? 'default' : 'monokai'; } catch {}
      if (window.CodeMirror) {
        const cm = CodeMirror.fromTextArea(ta, {
          mode: "python",
          theme: _savedCmTheme,
          lineNumbers: true,
          indentUnit: 4,
          tabSize: 4,
          indentWithTabs: true,
          smartIndent: true,
          electricChars: true,
          autoCloseBrackets: true,
          matchBrackets: true,
          viewportMargin: 20
        });
        let dirty = true;
        cm.on('change', () => { dirty = true; });
        window.__isDirty = () => dirty;
        
        // Custom autocomplete system
        window.eagleEditor = cm;
        return {
          getValue: () => cm.getValue(),
          setValue: (v) => { cm.setValue(v); dirty = true; }
        };
      } else {
        // Fallback textarea: keep tab characters on Enter after colon
        ta.style.width = "100%"; ta.style.height = "100%"; ta.style.background = "var(--bg-dark)";
        ta.style.color = "var(--text-light)"; ta.style.border = "0"; ta.style.outline = "none";
        ta.addEventListener("keydown", (e) => {
          if (e.key === "Tab") { e.preventDefault();
            const s = ta.selectionStart, e2 = ta.selectionEnd;
            ta.value = ta.value.substring(0, s) + "\t" + ta.value.substring(e2);
            ta.selectionStart = ta.selectionEnd = s + 1;
          } else if (e.key === "Enter") {
            const before = ta.value.slice(0, ta.selectionStart);
            const lastLine = before.split(/\r?\n/).pop() || "";
            const base = lastLine.match(/^\t*/)?.[0] ?? "";
            const extra = /:\s*$/.test(lastLine) ? "\t" : "";
            setTimeout(() => {
              const pos = ta.selectionStart;
              const insert = base + extra;
              ta.value = ta.value.slice(0, pos) + insert + ta.value.slice(pos);
              ta.selectionStart = ta.selectionEnd = pos + insert.length;
            }, 0);
          }
        });
        window.__isDirty = () => true;
        return { getValue: () => ta.value, setValue: (v) => { ta.value = v; } };
      }
    }

    var editor = initEditor();
    window.eagleEditorApi = editor;

    // Teacher code streaming state
    let teacherEditor = null;
    const TEACHER_CODE_KEY = 'eagleide-teacher-code';
    const TEACHER_PANE_OPEN_KEY = 'eagleide-teacher-pane-open';
    const TEACHER_PANE_SIZE_KEY = 'eagleide-teacher-pane-size';
    const STUDENT_CLASS_SELECTION_KEY = 'eagleide-student-class-id';
    let teacherPaneEnabled = false;
    let teacherPaneOpen = false;
    let teacherStreamingEnabled = false;

    function setTeacherPaneSize(percent, persist = true) {
      const next = Math.min(70, Math.max(25, Number(percent) || 50));
      document.documentElement.style.setProperty('--teacher-pane-size', `${next}%`);
      if (persist) {
        try { localStorage.setItem(TEACHER_PANE_SIZE_KEY, String(next)); } catch {}
      }
    }

    function initTeacherViewer() {
      const ta = document.getElementById('teacherStreamEditor');
      if (!ta) return null;
      if (!window.CodeMirror) {
        ta.style.display = 'block';
        ta.style.width = '100%';
        ta.style.height = '100%';
        ta.style.background = 'var(--theme-cm-bg)';
        ta.style.color = 'var(--text-light)';
        ta.style.border = '0';
        ta.style.outline = 'none';
        ta.style.padding = '8px';
        ta.readOnly = true;
        try {
          const saved = localStorage.getItem(TEACHER_CODE_KEY);
          if (saved !== null) ta.value = saved;
        } catch {}
        return null;
      }
      if (teacherEditor) return teacherEditor;
      let cmTheme = 'monokai';
      try { cmTheme = localStorage.getItem('ide-theme') === 'light' ? 'default' : 'monokai'; } catch {}
      teacherEditor = CodeMirror.fromTextArea(ta, {
        mode: "python",
        theme: cmTheme,
        lineNumbers: true,
        indentUnit: 4,
        tabSize: 4,
        indentWithTabs: true,
        smartIndent: true,
        electricChars: true,
        autoCloseBrackets: true,
        matchBrackets: true,
        viewportMargin: 20,
        readOnly: 'nocursor'
      });
      try {
        const saved = localStorage.getItem(TEACHER_CODE_KEY);
        if (saved !== null) teacherEditor.setValue(saved);
      } catch {}
      return teacherEditor;
    }

    function setTeacherPaneOpen(nextOpen, persist = true) {
      teacherPaneOpen = !!nextOpen && !!teacherPaneEnabled;
      const stack = document.getElementById('editorContentStack');
      const btn = document.getElementById('teacherPaneToggleBtn');
      if (stack) stack.classList.toggle('teacher-stream-open', teacherPaneOpen);
      if (btn) {
        btn.textContent = teacherPaneOpen ? '▼' : '▲';
        btn.title = teacherPaneOpen ? 'Hide teacher code stream' : 'Show teacher code stream';
        btn.setAttribute('aria-expanded', teacherPaneOpen ? 'true' : 'false');
      }
      updateTeacherStreamToggleState();
      if (persist) {
        try { localStorage.setItem(TEACHER_PANE_OPEN_KEY, teacherPaneOpen ? '1' : '0'); } catch {}
      }
      if (teacherPaneOpen) {
        window.ensureEditorTabForTeacherStream?.();
        initTeacherViewer();
        window.applyPendingTeacherStream?.();
        requestAnimationFrame(() => {
          try { window.eagleEditor?.refresh?.(); } catch {}
          try { teacherEditor?.refresh?.(); } catch {}
        });
      }
    }

    function setTeacherPaneEnabled(enabled) {
      const nextEnabled = !!enabled;
      if (nextEnabled === teacherPaneEnabled) return;
      teacherPaneEnabled = nextEnabled;
      const stack = document.getElementById('editorContentStack');
      const btn = document.getElementById('teacherPaneToggleBtn');
      if (stack) stack.classList.toggle('teacher-stream-enabled', teacherPaneEnabled);
      if (btn) btn.style.display = teacherPaneEnabled ? 'flex' : 'none';
      if (!teacherPaneEnabled) {
        setTeacherPaneOpen(false, false);
      } else {
        initTeacherViewer();
        let shouldOpen = false;
        try { shouldOpen = localStorage.getItem(TEACHER_PANE_OPEN_KEY) === '1'; } catch {}
        setTeacherPaneOpen(shouldOpen, false);
      }
      updateTeacherStreamToggleState();
    }

    // Eagle IDE Custom Completion Engine
    (function() {
      if (!window.eagleEditor) return;
      
      const cmInst = window.eagleEditor;
      const COMPLETION_DEBOUNCE_MS = 50;
      const MAX_AUTOCOMPLETE_ANALYSIS_LENGTH = 100000;
      let suggestionBox = null;
      let activeSuggIdx = 0;
      let suggestionList = [];
      let completionActive = true;
      const LANGUAGE_COMPLETIONS = {
        python: {
          keywords: ['def','class','if','elif','else','for','while','return','yield','import','from','as','try','except','finally','raise','with','assert','pass','break','continue','global','nonlocal','lambda','and','or','not','in','is','None','True','False','self'],
          builtins: ['print','input','len','range','str','int','float','list','dict','set','tuple','type','isinstance','hasattr','getattr','setattr','abs','all','any','max','min','sum','sorted','reversed','enumerate','zip','map','filter','open','round','pow','divmod','chr','ord','bin','hex','oct','bool','bytes','bytearray','complex','frozenset','slice','super','property','staticmethod','classmethod','vars','dir','help','id','hash','iter','next','callable','compile','eval','exec','format','globals','locals','memoryview','object','repr','ascii','breakpoint'],
          memberMap: {
            string: ['upper','lower','strip','split','join','replace','find','index','count','startswith','endswith','capitalize','title','swapcase','isalpha','isdigit','isspace','isupper','islower'],
            list: ['append','extend','insert','remove','pop','clear','index','count','sort','reverse','copy'],
            dict: ['keys','values','items','get','pop','update','clear','copy','setdefault']
          }
        },
        javascript: {
          keywords: ['function','class','const','let','var','if','else','switch','case','default','for','while','do','return','break','continue','try','catch','finally','throw','new','typeof','instanceof','in','of','await','async','import','export','from','extends','super','this','null','undefined','true','false'],
          builtins: ['console','Math','JSON','Array','Object','String','Number','Boolean','Promise','Set','Map','Date','RegExp','parseInt','parseFloat','setTimeout','setInterval','clearTimeout','clearInterval','fetch','document','window'],
          memberMap: {
            string: ['toUpperCase','toLowerCase','trim','split','slice','substring','replace','includes','startsWith','endsWith','indexOf','charAt','repeat','match'],
            array: ['push','pop','shift','unshift','map','filter','reduce','forEach','find','findIndex','includes','slice','splice','join','sort','reverse','flat'],
            object: ['keys','values','entries','assign','hasOwnProperty','toString'],
            console: ['log','error','warn','info','table','dir','clear'],
            math: ['abs','ceil','floor','max','min','pow','random','round','sqrt','trunc'],
            promise: ['then','catch','finally'],
            document: ['querySelector','querySelectorAll','getElementById','createElement','addEventListener'],
            window: ['addEventListener','removeEventListener','setTimeout','setInterval','requestAnimationFrame'],
            json: ['parse','stringify'],
            set: ['add','delete','has','clear','forEach'],
            map: ['set','get','has','delete','clear','forEach'],
            number: ['toFixed','toPrecision','toString'],
            boolean: ['valueOf','toString']
          }
        }
      };

      function currentLanguage() {
        return String(cmInst.getOption('mode') || '').toLowerCase().includes('javascript') ? 'javascript' : 'python';
      }

      function inferJsType(expr) {
        const value = String(expr || '').trim();
        if (!value) return null;
        if (/^["'`]/.test(value)) return 'string';
        if (/^\[/.test(value) || /\bArray\s*\(/.test(value)) return 'array';
        if (/^\{/.test(value) || /\bObject\./.test(value) || /\bnew\s+Object\b/.test(value)) return 'object';
        if (/^(true|false)\b/.test(value)) return 'boolean';
        if (/^-?\d+/.test(value) || /\bNumber\s*\(/.test(value)) return 'number';
        if (/\bPromise\b/.test(value)) return 'promise';
        if (/\bnew\s+Set\b/.test(value)) return 'set';
        if (/\bnew\s+Map\b/.test(value)) return 'map';
        return null;
      }

      function extractCodeTokens(sourceCode, language) {
        const tokenMap = { funcs: new Set(), classes: new Set(), vars: new Set(), varTypes: new Map() };
        const codeLines = sourceCode.split('\n');
        if (language === 'javascript') {
          codeLines.forEach(ln => {
            const funcDecl = ln.match(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
            if (funcDecl) tokenMap.funcs.add(funcDecl[1]);
            const classDecl = ln.match(/^\s*class\s+([A-Za-z_$][\w$]*)/);
            if (classDecl) tokenMap.classes.add(classDecl[1]);
            const varDecl = ln.match(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+?)(?:;\s*)?$/);
            if (varDecl) {
              tokenMap.vars.add(varDecl[1]);
              const inferred = inferJsType(varDecl[2]);
              if (inferred) tokenMap.varTypes.set(varDecl[1], inferred);
            }
            const arrowFunc = ln.match(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?.*=>/);
            if (arrowFunc) {
              tokenMap.funcs.add(arrowFunc[1]);
              tokenMap.vars.add(arrowFunc[1]);
            }
            const simpleVarDecl = ln.match(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/);
            if (simpleVarDecl) tokenMap.vars.add(simpleVarDecl[1]);
          });
        } else {
          const pyKeywords = LANGUAGE_COMPLETIONS.python.keywords;
          codeLines.forEach(ln => {
            const funcMatch = ln.match(/^\s*def\s+([a-zA-Z_]\w*)/);
            if (funcMatch) tokenMap.funcs.add(funcMatch[1]);
            const classMatch = ln.match(/^\s*class\s+([a-zA-Z_]\w*)/);
            if (classMatch) tokenMap.classes.add(classMatch[1]);
            const varMatches = ln.matchAll(/([a-zA-Z_]\w*)\s*=/g);
            for (const vm of varMatches) {
              if (vm[1] && !pyKeywords.includes(vm[1])) tokenMap.vars.add(vm[1]);
            }
          });
        }
        return tokenMap;
      }

      function memberSuggestions(language, tokens, objectName, partial) {
        const data = LANGUAGE_COMPLETIONS[language];
        const normalized = String(objectName || '').trim();
        const lowerName = normalized.toLowerCase();
        const lowerPartial = String(partial || '').toLowerCase();
        let typeName = tokens.varTypes.get(normalized) || null;
        if (!typeName && language === 'javascript') {
          if (normalized === 'console') typeName = 'console';
          else if (normalized === 'Math') typeName = 'math';
          else if (normalized === 'document') typeName = 'document';
          else if (normalized === 'window') typeName = 'window';
          else if (normalized === 'JSON') typeName = 'json';
        }
        if (!typeName && language === 'python') {
          if (lowerName.includes('dict')) typeName = 'dict';
          else if (lowerName.includes('list')) typeName = 'list';
          else if (lowerName.includes('str') || lowerName.includes('text') || lowerName.includes('name')) typeName = 'string';
        }
        const candidates = data.memberMap[typeName] || [];
        return candidates
          .filter(name => name.toLowerCase().startsWith(lowerPartial))
          .map(name => ({ text: name, category: 'attr', icon: 'A' }));
      }

      function buildSuggestions(partialToken, cursorPos) {
        const language = currentLanguage();
        const data = LANGUAGE_COMPLETIONS[language];
        const fullCode = cmInst.getValue();
        if (fullCode.length > MAX_AUTOCOMPLETE_ANALYSIS_LENGTH) return [];
        const preCursor = fullCode.substring(0, cursorPos.index);
        const tokens = extractCodeTokens(fullCode, language);
        const results = [];
        const seen = new Set();
        const pushResult = (text, category, icon) => {
          if (!text || seen.has(text)) return;
          seen.add(text);
          results.push({ text, category, icon });
        };
        const attrMatch = preCursor.match(/([A-Za-z_$][\w$]*)\.([A-Za-z_$]*)$/);
        if (attrMatch) {
          memberSuggestions(language, tokens, attrMatch[1], attrMatch[2]).forEach(item => pushResult(item.text, item.category, item.icon));
        } else {
          const lowerPartial = partialToken.toLowerCase();
          tokens.funcs.forEach(name => { if (name.toLowerCase().startsWith(lowerPartial)) pushResult(name, 'func', 'ƒ'); });
          tokens.classes.forEach(name => { if (name.toLowerCase().startsWith(lowerPartial)) pushResult(name, 'class', 'C'); });
          tokens.vars.forEach(name => { if (name.toLowerCase().startsWith(lowerPartial)) pushResult(name, 'var', 'V'); });
          data.keywords.forEach(name => { if (name.toLowerCase().startsWith(lowerPartial)) pushResult(name, 'kw', 'K'); });
          data.builtins.forEach(name => { if (name.toLowerCase().startsWith(lowerPartial)) pushResult(name, 'func', 'ƒ'); });
        }
        return results.sort((a, b) => {
          const aExact = a.text === partialToken ? 0 : 1;
          const bExact = b.text === partialToken ? 0 : 1;
          if (aExact !== bExact) return aExact - bExact;
          return a.text.localeCompare(b.text);
        });
      }
      
      // Create suggestion widget
      function createSuggestionWidget() {
        const widget = document.createElement('div');
        widget.className = 'eagle-completions hidden';
        document.body.appendChild(widget);
        return widget;
      }
      
      // Position and show suggestions
      function displaySuggestions(suggestions, coords) {
        if (!suggestionBox) suggestionBox = createSuggestionWidget();
        if (suggestions.length === 0) {
          suggestionBox.classList.add('hidden');
          return;
        }
        
        suggestionList = suggestions;
        activeSuggIdx = 0;
        suggestionBox.innerHTML = '';
        
        const allItems = [];
        suggestions.forEach((sugg, idx) => {
          const itemEl = document.createElement('div');
          itemEl.className = 'completion-item' + (idx === 0 ? ' selected' : '');
          
          const iconEl = document.createElement('span');
          iconEl.className = `completion-icon icon-${sugg.category}`;
          iconEl.textContent = sugg.icon;
          
          const txtEl = document.createElement('span');
          txtEl.textContent = sugg.text;
          
          itemEl.appendChild(iconEl);
          itemEl.appendChild(txtEl);
          itemEl.dataset.index = idx;
          
          itemEl.addEventListener('click', () => applySuggestion(sugg));
          itemEl.addEventListener('mouseenter', () => {
            allItems.forEach(el => el.classList.remove('selected'));
            itemEl.classList.add('selected');
            activeSuggIdx = idx;
          });
          
          allItems.push(itemEl);
          suggestionBox.appendChild(itemEl);
        });
        
        suggestionBox.style.left = coords.left + 'px';
        suggestionBox.style.top = coords.bottom + 'px';
        suggestionBox.classList.remove('hidden');
      }
      
      // Apply selected suggestion
      function applySuggestion(sugg) {
        const cursor = cmInst.getCursor();
        const lineContent = cmInst.getLine(cursor.line);
        const beforeCursor = lineContent.substring(0, cursor.ch);
        
        // Find token start
        const tokenMatch = beforeCursor.match(/[a-zA-Z_]\w*$/);
        const attrMatch = beforeCursor.match(/[a-zA-Z_]\w*\.[a-zA-Z_]*$/);
        
        let replaceFrom;
        if (attrMatch) {
          const parts = attrMatch[0].split('.');
          replaceFrom = cursor.ch - parts[parts.length - 1].length;
        } else if (tokenMatch) {
          replaceFrom = cursor.ch - tokenMatch[0].length;
        } else {
          replaceFrom = cursor.ch;
        }
        
        cmInst.replaceRange(sugg.text, 
          { line: cursor.line, ch: replaceFrom },
          { line: cursor.line, ch: cursor.ch }
        );
        
        hideSuggestions();
        cmInst.focus();
      }
      
      // Hide suggestions
      function hideSuggestions() {
        if (suggestionBox) suggestionBox.classList.add('hidden');
        suggestionList = [];
        activeSuggIdx = 0;
      }
      
      // Trigger completion check
      function checkCompletion() {
        if (!completionActive) return;
        
        const cursor = cmInst.getCursor();
        const lineContent = cmInst.getLine(cursor.line);
        const beforeCursor = lineContent.substring(0, cursor.ch);
        
        // Match partial identifier or attribute access
        const tokenMatch = beforeCursor.match(/(?:([A-Za-z_$][\w$]*)\.)?([A-Za-z_$][\w$]*)$/);
        if (!tokenMatch || !tokenMatch[0]) {
          hideSuggestions();
          return;
        }
        
        const partialToken = tokenMatch[2] || '';
        if (!partialToken && !tokenMatch[1]) {
          hideSuggestions();
          return;
        }
        
        const cursorPos = cmInst.indexFromPos(cursor);
        const suggestions = buildSuggestions(partialToken, { index: cursorPos });
        
        if (suggestions.length > 0) {
          const coords = cmInst.cursorCoords(cursor, 'page');
          displaySuggestions(suggestions, coords);
        } else {
          hideSuggestions();
        }
      }
      
      // Keyboard navigation
      cmInst.on('keydown', (cm, ev) => {
        if (!completionActive || suggestionList.length === 0) return;
        
        const items = document.querySelectorAll('.completion-item');
        
        if (ev.key === 'ArrowDown') {
          ev.preventDefault();
          activeSuggIdx = (activeSuggIdx + 1) % suggestionList.length;
          items.forEach((el, i) => {
            el.classList.toggle('selected', i === activeSuggIdx);
          });
          items[activeSuggIdx]?.scrollIntoView({ block: 'nearest' });
        } else if (ev.key === 'ArrowUp') {
          ev.preventDefault();
          activeSuggIdx = (activeSuggIdx - 1 + suggestionList.length) % suggestionList.length;
          items.forEach((el, i) => {
            el.classList.toggle('selected', i === activeSuggIdx);
          });
          items[activeSuggIdx]?.scrollIntoView({ block: 'nearest' });
        } else if (ev.key === 'Enter') {
          if (suggestionList.length > 0) {
            ev.preventDefault();
            applySuggestion(suggestionList[activeSuggIdx]);
          }
        } else if (ev.key === 'Tab') {
          if (suggestionList.length > 0) {
            ev.preventDefault();
            applySuggestion(suggestionList[activeSuggIdx]);
          }
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          hideSuggestions();
        }
      });
      
      // Trigger on input
      cmInst.on('inputRead', () => {
        setTimeout(checkCompletion, COMPLETION_DEBOUNCE_MS);
      });
      
      // Hide on click outside
      document.addEventListener('click', (ev) => {
        if (suggestionBox && !suggestionBox.contains(ev.target)) {
          hideSuggestions();
        }
      });
      
      // Toggle button handler
      window.toggleEagleCompletion = function(enabled) {
        completionActive = enabled;
        if (!enabled) hideSuggestions();
      };
    })();

    // Warn before closing/reloading
    window.addEventListener('beforeunload', (e) => {
      if (typeof window.__isDirty === 'function' ? window.__isDirty() : true) {
        e.preventDefault(); e.returnValue = '';
      }
    });

    // Starter example
    editor.setValue(`# Welcome Eagles!.
name = input("Type your name: ")
print("Hello " + name)
`);
