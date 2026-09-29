function eagleFoldRange(cm, pos) {
      return window.EagleEditorBehavior?.foldRange(cm, pos, window.CodeMirror) || null;
    }

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
          gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'],
          foldGutter: { rangeFinder: eagleFoldRange, indicatorOpen: 'eagle-fold-open', indicatorFolded: 'eagle-fold-closed' },
          foldOptions: { rangeFinder: eagleFoldRange, widget: '⋯' },
          extraKeys: { Enter: cm => window.EagleEditorBehavior.enter(cm), 'Ctrl-Q': cm => cm.foldCode?.(cm.getCursor()) },
          indentUnit: 4,
          tabSize: 4,
          indentWithTabs: true,
          smartIndent: true,
          electricChars: false,
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
        // Fallback textarea uses the same predictable Python Enter rules.
        ta.style.display = 'block';
        ta.style.width = "100%"; ta.style.height = "100%"; ta.style.background = "var(--bg-dark)";
        ta.style.color = "var(--text-light)"; ta.style.border = "0"; ta.style.outline = "none";
        ta.addEventListener("keydown", (e) => {
          if (e.key === "Tab") { e.preventDefault();
            const s = ta.selectionStart, e2 = ta.selectionEnd;
            ta.value = ta.value.substring(0, s) + "\t" + ta.value.substring(e2);
            ta.selectionStart = ta.selectionEnd = s + 1;
          } else if (e.key === "Enter") {
            e.preventDefault();
            const start = ta.selectionStart;
            const end = ta.selectionEnd;
            const lineStart = ta.value.lastIndexOf('\n', start - 1) + 1;
            const nextNewline = ta.value.indexOf('\n', start);
            const lineEnd = nextNewline < 0 ? ta.value.length : nextNewline;
            const line = ta.value.slice(lineStart, lineEnd);
            const next = window.EagleEditorBehavior?.nextPythonIndent(line, start - lineStart)
              || { clearBlankLine: false, text: `\n${line.match(/^[\t ]*/)?.[0] || ''}` };
            const from = next.clearBlankLine && start === end ? lineStart : start;
            const to = next.clearBlankLine && start === end ? lineEnd : end;
            ta.value = ta.value.slice(0, from) + next.text + ta.value.slice(to);
            ta.selectionStart = ta.selectionEnd = from + next.text.length;
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
      document.getElementById('editorStreamSplitter')?.setAttribute('aria-valuenow', String(Math.round(next)));
      window.EagleIDE?.layout?.refreshEditors?.();
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
        gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'],
        foldGutter: { rangeFinder: eagleFoldRange, indicatorOpen: 'eagle-fold-open', indicatorFolded: 'eagle-fold-closed' },
        foldOptions: { rangeFinder: eagleFoldRange, widget: '⋯' },
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
        btn.setAttribute('aria-label', btn.title);
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
      }
      // Closing/stopping a stream also changes the student's editor height.
      window.EagleIDE?.layout?.refreshEditors?.();
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
      if (!window.eagleEditor || !window.EagleAutocomplete) return;
      let enabled = true;
      try { enabled = localStorage.getItem('eagleide-autocomplete') !== '0'; } catch {}
      const completionEngine = window.EagleAutocomplete.createEngine(window.eagleEditor, { enabled });
      window.eagleCompletionEngine = completionEngine;
      window.toggleEagleCompletion = enabledState => completionEngine.setEnabled(enabledState);
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
