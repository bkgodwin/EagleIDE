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
        ta.style.display = 'block';
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
