/* The main source editor's Edit controls. */
(() => {
  'use strict';

  const MATCH_LIMIT = 2000;
  const WORD = '[\\p{L}\\p{M}\\p{N}_$]';

  function findMatches(source, query, caseSensitive, contains) {
    if (!query) return [];
    const literal = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const startsWord = new RegExp('^' + WORD, 'u').test(query);
    const endsWord = new RegExp(WORD + '$', 'u').test(query);
    const left = !contains && startsWord ? `(?<!${WORD})` : '';
    const right = !contains && endsWord ? `(?!${WORD})` : '';
    const pattern = new RegExp(left + literal + right, caseSensitive ? 'gu' : 'giu');
    const matches = [];
    for (const match of source.matchAll(pattern)) {
      matches.push([match.index, match.index + match[0].length]);
      if (matches.length > MATCH_LIMIT) break;
    }
    return matches;
  }

  function configure(bridge) {
    const byId = id => document.getElementById(id);
    const trigger = byId('editorEditBtn');
    if (!trigger) return null;
    const cm = window.eagleEditor;
    const textarea = byId('editor');
    const surface = cm?.getWrapperElement() || textarea;
    const menu = byId('editorEditMenu');
    const find = byId('editorFind');
    const query = find.elements.query;
    const count = byId('editorFindCount');
    const status = byId('editorEditStatus');
    const actions = [...menu.querySelectorAll('[data-edit]')];
    const apple = /Mac|iPad|iPhone|iPod/i.test(navigator.userAgentData?.platform || navigator.platform || '');
    const mod = apple ? 'Command' : 'Ctrl';
    const shortcuts = {
      find: mod + '+F', undo: mod + '+Z', redo: apple ? mod + '+Shift+Z' : mod + '+Y',
      comment: mod + '+/', indent: 'Tab', unindent: 'Shift+Tab', duplicate: mod + '+Shift+Enter',
      copy: mod + '+C', cut: mod + '+X', paste: mod + '+V',
    };
    const value = () => cm ? cm.getValue() : textarea.value;
    const readOnly = () => cm ? cm.getOption('readOnly') : textarea.readOnly;
    const visible = () => surface.getClientRects().length > 0;
    const writable = () => visible() && !readOnly();
    const clipboardBlocked = () => window.AssignmentDevelopment?.blocked();
    const selected = () => cm ? cm.getSelection() : value().slice(textarea.selectionStart, textarea.selectionEnd);
    const selections = () => cm ? cm.listSelections() : [textarea.selectionStart, textarea.selectionEnd];
    const operation = callback => cm ? cm.operation(callback) : callback();
    const focusEditor = () => (cm || textarea).focus();
    const findButton = action => find.querySelector(`[data-find="${action}"]`);
    let search = null;
    let revision = 0;
    let statusTimer;
    let duplicating = false;

    for (const button of actions) {
      const shortcut = shortcuts[button.dataset.edit];
      button.querySelector('kbd').textContent = shortcut;
      button.title = `${button.textContent.trim().replace(shortcut, '').trim()} (${shortcut})`;
    }

    function showStatus(message) {
      clearTimeout(statusTimer);
      status.hidden = !message;
      status.textContent = message;
      if (message) statusTimer = setTimeout(() => { status.hidden = true; }, 4500);
    }

    function closeMenu() {
      if (menu.hidden) return;
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    }

    function canAct(action) {
      if (!visible()) return false;
      if (action === 'find') return true;
      if (action === 'copy') return !clipboardBlocked() && !!selected();
      if (!writable()) return false;
      if (action === 'duplicate') return !duplicating && bridge.canDuplicate();
      if (action === 'paste' || action === 'cut') return !clipboardBlocked() && (action === 'paste' || !!selected());
      if (action === 'undo' || action === 'redo') return !cm || cm.historySize()[action] > 0;
      return true;
    }

    function setReadOnly(locked) {
      if (cm) cm.setOption('readOnly', locked);
      else textarea.readOnly = locked;
    }

    function closeFind(focus = false) {
      if (!search) return;
      operation(() => {
        search.marks.forEach(mark => mark.clear());
        search.activeMark?.clear();
        setReadOnly(search.readOnly);
      });
      search = null;
      find.hidden = true;
      find.reset();
      if (focus && visible()) focusEditor();
    }

    function reset() {
      revision++;
      closeMenu();
      closeFind();
      showStatus('');
    }

    function selectMatch(index) {
      const { matches, limited } = search;
      search.index = matches.length ? (index + matches.length) % matches.length : -1;
      const match = matches[search.index];
      search.activeMark?.clear();
      if (match && cm) {
        const [from, to] = match.map(offset => cm.posFromIndex(offset));
        window.EagleEditorBehavior?.unfoldLine(cm, from.line);
        search.activeMark = cm.markText(from, to, { className: 'cm-eagle-find-match-current' });
        cm.scrollIntoView({ from, to }, 55);
      } else if (match) {
        textarea.setSelectionRange(...match);
        const linesBefore = search.source.slice(0, match[0]).split('\n').length - 1;
        textarea.scrollTop = textarea.scrollHeight * linesBefore / search.lineCount - textarea.clientHeight / 2;
      }
      count.textContent = match ? `${search.index + 1} of ${matches.length}${limited ? '+' : ''}` :
        query.value ? 'No matches' : 'Enter text to find';
      findButton('previous').disabled = !match;
      findButton('next').disabled = !match;
      findButton('replace').disabled = !match || !!search.readOnly;
      findButton('replaceAll').disabled = !match || !!search.readOnly || limited;
      findButton('replaceAll').title = limited ? 'Narrow your search to replace all' : '';
    }

    function updateMatches() {
      if (!search) return;
      const { caseSensitive, withinWord } = find.elements;
      const matches = findMatches(search.source, query.value, caseSensitive.checked, withinWord.checked);
      search.limited = matches.length > MATCH_LIMIT;
      search.matches = matches.slice(0, MATCH_LIMIT);
      operation(() => {
        search.marks.forEach(mark => mark.clear());
        search.marks = cm ? search.matches.map(([start, end]) => cm.markText(
          cm.posFromIndex(start), cm.posFromIndex(end), { className: 'cm-eagle-find-match' }
        )) : [];
        selectMatch(0);
      });
    }

    function openFind() {
      if (!search) {
        const source = value();
        search = { source, marks: [], readOnly: readOnly(), lineCount: cm ? 0 : source.split('\n').length };
        const selection = clipboardBlocked() ? '' : selected();
        if (!selection.includes('\n') && selection.length <= query.maxLength) query.value = selection;
        if (cm?.getOption('readOnly') !== 'nocursor') setReadOnly(true);
        window.eagleCompletionEngine?.hide();
        find.hidden = false;
        updateMatches();
      }
      query.focus();
      query.select();
    }

    function replaceTextarea(from, to, text, paste = false) {
      focusEditor();
      textarea.setSelectionRange(from, to);
      // Give provenance the edit origin before the native undoable command.
      textarea.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true, inputType: paste ? 'insertFromPaste' : text ? 'insertText' : 'deleteContent',
      }));
      if (text) document.execCommand('insertText', false, text);
      else if (from !== to) document.execCommand('delete');
    }

    function replaceMatches(all) {
      if (!search || search.readOnly || !visible() || value() !== search.source) return;
      const { matches, index, limited, source } = search;
      if (index < 0 || (all && limited)) return;
      const replacement = find.elements.replacement.value;
      const targets = all ? matches : [matches[index]];
      closeFind(true);
      if (cm) {
        cm.operation(() => {
          for (const [start, end] of targets.slice().reverse()) {
            cm.replaceRange(replacement, cm.posFromIndex(start), cm.posFromIndex(end), 'eagleReplace');
          }
        });
      } else {
        const start = targets[0][0];
        const end = targets.at(-1)[1];
        let cursor = start;
        const updated = targets.map(([from, to]) => {
          const unchanged = source.slice(cursor, from);
          cursor = to;
          return unchanged + replacement;
        }).join('');
        replaceTextarea(start, end, updated);
      }
      showStatus(`Replaced ${targets.length} ${targets.length === 1 ? 'match' : 'matches'}.`);
    }

    function textareaLineEdit(action) {
      const source = value();
      const from = textarea.selectionStart ? source.lastIndexOf('\n', textarea.selectionStart - 1) + 1 : 0;
      const end = Math.max(textarea.selectionStart, textarea.selectionEnd - 1);
      const newline = source.indexOf('\n', end);
      const to = newline < 0 ? source.length : newline;
      const lines = source.slice(from, to).split('\n');
      let updated;
      if (action === 'indent') updated = lines.map(line => '\t' + line).join('\n');
      else if (action === 'unindent') updated = lines.map(line => line.replace(/^(\t| {1,4})/, '')).join('\n');
      else {
        const mode = bridge.language();
        if (mode === 'css' || mode === 'htmlmixed') {
          const [open, close] = mode === 'css' ? ['/*', '*/'] : ['<!--', '-->'];
          const text = lines.join('\n');
          updated = text.startsWith(open) && text.endsWith(close)
            ? text.slice(open.length, -close.length).replace(/^ | $/g, '')
            : `${open} ${text} ${close}`;
        } else if (mode === 'python' || mode === 'javascript') {
          const marker = mode === 'python' ? '#' : '//';
          const allCommented = lines.every(line => line.trimStart().startsWith(marker));
          updated = lines.map(line => {
            const indentation = line.match(/^\s*/)[0];
            const text = line.slice(indentation.length);
            return indentation + (allCommented ? text.slice(marker.length).replace(/^ /, '') : marker + ' ' + text);
          }).join('\n');
        } else return;
      }
      if (updated === source.slice(from, to)) return;
      replaceTextarea(from, to, updated);
      textarea.setSelectionRange(from, from + updated.length);
    }

    async function clipboard(action) {
      const clipboard = navigator.clipboard;
      const text = action === 'paste' ? '' : selected();
      const startRevision = revision;
      const selection = JSON.stringify(selections());
      const stillCurrent = () => revision === startRevision && !search && canAct(action) &&
        selection === JSON.stringify(selections());
      focusEditor();
      try {
        if (action === 'paste') {
          const pasted = await clipboard.readText();
          if (!pasted || !stillCurrent()) return;
          if (cm) cm.replaceSelections(selections().map(() => pasted), 'end', 'paste');
          else replaceTextarea(textarea.selectionStart, textarea.selectionEnd,
            bridge.language() === 'python' ? window.EagleEditorBehavior.normalizePastedIndentation(pasted) : pasted, true);
        } else {
          await clipboard.writeText(text);
          if (action === 'cut' && stillCurrent()) {
            if (cm) cm.replaceSelections(selections().map(() => ''), 'end', 'cut');
            else replaceTextarea(textarea.selectionStart, textarea.selectionEnd, '');
          }
        }
      } catch {
        if (!stillCurrent()) return;
        if (action !== 'paste' && document.execCommand(action)) return;
        showStatus(`Use ${shortcuts[action]} or your device’s clipboard controls to ${action}.`);
      }
    }

    async function run(action) {
      if (!canAct(action)) return;
      if (action === 'find') { openFind(); return; }
      if (action === 'copy' || action === 'cut' || action === 'paste') { await clipboard(action); return; }
      focusEditor();
      if (action === 'duplicate') {
        duplicating = true;
        try {
          const path = await bridge.duplicate();
          if (path) showStatus(`Created ${path}`);
        } catch (error) {
          showStatus(error.message || 'Could not duplicate the file.');
        } finally { duplicating = false; }
      } else if (cm) {
        const command = { indent: 'indentMore', unindent: 'indentLess' }[action] || action;
        if (action === 'comment') cm.operation(() => cm.toggleComment?.({ indent: true, commentBlankLines: true }));
        else cm.execCommand(command);
      } else if (action === 'undo' || action === 'redo') {
        document.execCommand(action);
      } else textareaLineEdit(action);
    }

    trigger.addEventListener('click', () => {
      if (!menu.hidden) { closeMenu(); return; }
      closeFind();
      if (!visible()) return;
      window.eagleCompletionEngine?.hide();
      actions.forEach(button => { button.disabled = !canAct(button.dataset.edit); });
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      actions[0].focus();
    });
    menu.addEventListener('click', event => {
      const button = event.target.closest('[data-edit]');
      if (!button) return;
      closeMenu();
      run(button.dataset.edit);
    });
    find.addEventListener('input', event => { if (event.target.name !== 'replacement') updateMatches(); });
    find.addEventListener('submit', event => { event.preventDefault(); if (search) selectMatch(search.index + 1); });
    find.addEventListener('click', event => {
      const action = event.target.closest('[data-find]')?.dataset.find;
      if (action === 'close') closeFind(true);
      else if (action === 'previous') selectMatch(search.index - 1);
      else if (action === 'replace' || action === 'replaceAll') replaceMatches(action === 'replaceAll');
    });
    document.addEventListener('pointerdown', event => {
      if (!menu.contains(event.target) && !trigger.contains(event.target)) closeMenu();
      if (!find.contains(event.target) && !surface.contains(event.target)) closeFind();
    }, true);
    document.addEventListener('focusin', event => {
      if (!menu.contains(event.target) && !trigger.contains(event.target)) closeMenu();
      if (!find.contains(event.target) && !surface.contains(event.target)) closeFind();
    });
    document.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'Escape' && (!menu.hidden || search)) {
        event.preventDefault();
        event.stopPropagation();
        if (search) closeFind(true);
        else { closeMenu(); trigger.focus(); }
        return;
      }
      if (event.key === 'Enter' && event.target === query && event.shiftKey && search) {
        event.preventDefault();
        selectMatch(search.index - 1);
        return;
      }
      const modifier = apple ? event.metaKey : event.ctrlKey;
      if (modifier && !event.altKey && event.key.toLowerCase() === 'f' &&
          (surface.contains(event.target) || (search && find.contains(event.target)))) {
        event.preventDefault();
        event.stopPropagation();
        run('find');
        return;
      }
      if (!surface.contains(event.target)) return;
      let action;
      if (modifier && !event.altKey) {
        if (event.key === '/') action = 'comment';
        if (event.shiftKey && event.key === 'Enter') action = 'duplicate';
      } else if (!cm && event.key === 'Tab' && (event.shiftKey || selected())) {
        action = event.shiftKey ? 'unindent' : 'indent';
      }
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      run(action);
    }, true);

    const changed = () => { revision++; if (search) closeFind(); };
    if (cm) cm.on('change', changed);
    else textarea.addEventListener('input', changed);
    window.addEventListener('eagle-context-updated', reset);
    new ResizeObserver(() => {
      trigger.hidden = !visible();
      if (trigger.hidden) reset();
    }).observe(surface);
    window.EagleEditorEditMenu.reset = reset;
  }

  window.EagleEditorEditMenu = { configure };
})();
