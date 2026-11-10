(() => {
  'use strict';
  const renderLimit = 250000;
  const transferLimit = 60000;
  const sanitizing = {
    FORBID_TAGS:['img','video','audio','iframe','style','svg','math','form','button','textarea','select','object','embed'],
    FORBID_ATTR:['style','src','srcset','autofocus','id','name'],
  };
  let bridge, file, editing, toggle, tools, view, wrap, rendered, paintTimer, stateKey = '';
  const editor = () => window.eagleEditor;
  const textarea = () => document.getElementById('editor');
  const present = () => !!file && bridge.visible() && bridge.file() === file;
  const writable = () => present() && !file.audit && !file.readOnly && !file.historyPlayback;
  const source = () => editor()?.getValue() ?? textarea().value;
  const matches = item => item && (!item.kind || item.kind === 'text') && !item.submission &&
    !item.notebook && /\.md$/i.test(item.name || '');
  const clipboardAllowed = () => !window.AssignmentDevelopment?.blocked();

  function opened() {
    if (!bridge) return;
    const next = bridge.file();
    const target = matches(next) ? next : null;
    if (target !== file) {
      file = target;
      editing = false;
      rendered = null;
      view.replaceChildren();
      view.scrollTop = 0;
    }
    sync();
  }

  function sync() {
    if (!bridge) return;
    const available = present();
    const reading = available && !editing;
    toggle.hidden = !available;
    toggle.textContent = editing ? 'Read Markdown' : writable() ? 'Edit Markdown' : 'View Markdown source';
    toggle.setAttribute('aria-pressed', String(!!editing));
    tools.hidden = !editing || !writable();
    view.hidden = !reading;
    wrap.classList.toggle('markdown-reading', reading);
    if (reading) refresh();
    const key = JSON.stringify([available ? file.name : '', writable(), available]);
    if (key !== stateKey) {
      stateKey = key;
      window.dispatchEvent(new CustomEvent('eagle-markdown-context'));
    }
  }

  function refresh() {
    clearTimeout(paintTimer);
    if (!present() || editing) return;
    paintTimer = setTimeout(() => {
      if (!present() || editing) return;
      const content = source();
      if (content === rendered) return;
      rendered = content;
      if (!content.trim()) {
        const note = document.createElement('p');
        note.className = 'markdown-view-status';
        note.textContent = writable() ? 'This note is empty. Choose Edit Markdown to start writing.' : 'This note is empty.';
        view.replaceChildren(note);
        return;
      }
      renderMarkdownTo(view, content.slice(0, renderLimit), 'python', {
        sanitize:sanitizing, maxCodeBlocks:128, canCopy:clipboardAllowed,
      });
      for (const code of view.querySelectorAll('pre > code')) {
        code.parentElement.dataset.language = [...code.classList].find(value => value.startsWith('language-'))?.slice(9) || 'text';
      }
      for (const input of view.querySelectorAll('input')) {
        if (input.type === 'checkbox') input.disabled = true;
        else input.remove();
      }
      if (content.length > renderLimit) {
        const note = document.createElement('p');
        note.className = 'markdown-view-status';
        note.textContent = 'Preview shortened. Open the Markdown source to see the full file.';
        view.append(note);
      }
    }, 90);
  }

  function switchMode(next, focus = true) {
    if (!present()) return;
    editing = next;
    window.EagleEditorEditMenu?.reset?.();
    window.EagleEditorAnnotations?.close();
    sync();
    if (editing) {
      editor()?.refresh();
      window.EagleEditorAnnotations?.refresh();
      if (focus) (editor() || textarea()).focus();
    } else if (focus) view.focus({preventScroll:true});
    window.EagleIDE?.layout?.refreshEditors();
  }

  function selection() {
    const cm = editor(), ta = textarea();
    return cm ? [cm.indexFromPos(cm.getCursor('from')), cm.indexFromPos(cm.getCursor('to'))] :
      [ta.selectionStart, ta.selectionEnd];
  }

  function replace(from, to, text, start, end, focus = true) {
    const cm = editor(), ta = textarea();
    if (cm) {
      const before = cm.changeGeneration();
      cm.operation(() => {
        cm.replaceRange(text, cm.posFromIndex(from), cm.posFromIndex(to), '+markdown');
        if (!cm.isClean(before)) cm.setSelection(cm.posFromIndex(from + start), cm.posFromIndex(from + end));
      });
      if (cm.isClean(before)) return false;
      if (focus) cm.focus();
    } else {
      ta.setRangeText(text, from, to, 'end');
      ta.setSelectionRange(from + start, from + end);
      ta.dispatchEvent(new Event('input', {bubbles:true}));
      if (focus) ta.focus();
    }
    return true;
  }

  function fenced(text, language = 'python') {
    const lang = /^[a-z0-9_+-]{1,30}$/i.test(language) ? language : 'text';
    let width = 3;
    for (const run of text.matchAll(/`+/g)) width = Math.max(width, run[0].length + 1);
    const fence = '`'.repeat(width);
    return {head:fence + lang + '\n', tail:'\n' + fence};
  }

  function format(action) {
    if (!editing || !writable()) return;
    const text = source();
    const [from,to] = selection();
    const selected = text.slice(from,to);
    const wraps = {bold:['**','**'], italic:['*','*'], underline:['<u>','</u>'], inlineCode:['`','`']};
    if (wraps[action]) {
      const [head,tail] = wraps[action];
      replace(from,to,head + selected + tail,head.length,head.length + selected.length);
    } else if (action === 'code') {
      const fence = fenced(selected);
      const before = from > 0 && text[from - 1] !== '\n' ? '\n' : '';
      const after = to < text.length && text[to] !== '\n' ? '\n' : '';
      const start = before.length + fence.head.length;
      replace(from,to,before + fence.head + selected + fence.tail + after,start,start + selected.length);
    } else {
      const start = from ? text.lastIndexOf('\n', from - 1) + 1 : 0;
      const lineEnd = text.indexOf('\n', Math.max(from, to - (to > from && text[to - 1] === '\n' ? 1 : 0)));
      const stop = lineEnd < 0 ? text.length : lineEnd;
      const lines = text.slice(start,stop).split('\n');
      const prefix = index => ({heading:'## ', bullets:'- ', numbered:(index + 1) + '. ', checklist:'- [ ] '})[action];
      const updated = lines.map((line,index) => prefix(index) + line.replace(/^(?:#{1,6}\s+|[-+*]\s+(?:\[[ xX]\]\s+)?|\d+\.\s+)/,'')).join('\n');
      const point = from === to ? Math.min(updated.length, from - start + prefix(0).length) : 0;
      replace(start,stop,updated,point,from === to ? point : updated.length);
    }
  }

  function insertNotes(text) {
    if (!writable()) throw new Error('Open a writable Markdown file.');
    if (!clipboardAllowed()) throw new Error('This class restricts copying into the editor.');
    if (!text.trim()) throw new Error('There are no notes to insert.');
    if (new TextEncoder().encode(text).length > transferLimit) throw new Error('Select a smaller portion of your notes.');
    const wasEditing = editing;
    if (!editing) switchMode(true, false);
    const value = source();
    const to = wasEditing ? selection()[1] : value.length;
    const before = to && !value.slice(0,to).endsWith('\n\n') ? (value[to - 1] === '\n' ? '\n' : '\n\n') : '';
    const insertion = before + text.trim() + '\n\n';
    if (!replace(to,to,insertion,insertion.length,insertion.length,false)) throw new Error('The Markdown file could not be updated.');
  }

  function notebookHtml() {
    if (!present()) throw new Error('Open a Markdown file first.');
    if (!clipboardAllowed()) throw new Error('This class restricts copying from the editor.');
    const text = source();
    if (!text.trim()) throw new Error('The Markdown file is empty.');
    if (new TextEncoder().encode(text).length > transferLimit) throw new Error('Use a smaller Markdown file to insert into your notes.');
    if (!window.marked || !window.DOMPurify) throw new Error('Markdown rendering is unavailable. Reload and try again.');
    const template = document.createElement('template');
    template.innerHTML = DOMPurify.sanitize(marked.parse(text, {gfm:true, breaks:true}), sanitizing);
    for (const input of template.content.querySelectorAll('input')) {
      if (input.type === 'checkbox') input.replaceWith(input.checked ? '[x] ' : '[ ] ');
      else input.remove();
    }
    return template.innerHTML;
  }

  function notesMarkdown(root, notebookCode) {
    const escape = text => text.replace(/[\\`*_~\[\]<>]/g, '\\$&');
    const walk = node => {
      if (node.nodeType === 3) return escape(node.nodeValue);
      if (node.nodeType !== 1 && node.nodeType !== 11) return '';
      const tag = node.tagName;
      if (node.matches?.('.student-notebook-code-block') || tag === 'PRE') {
        const code = notebookCode?.(node) || node.querySelector('code')?.textContent || node.textContent;
        const fence = fenced(code, node.dataset.language || node.querySelector('code')?.className.match(/language-([\w+-]+)/)?.[1] || 'python');
        return '\n\n' + fence.head + code.replace(/\n$/, '') + fence.tail + '\n\n';
      }
      if (tag === 'IMG') return node.alt ? '[' + escape(node.alt) + ']' : '';
      if (tag === 'BR') return '\n';
      if (tag === 'UL' || tag === 'OL') {
        const items = [...node.children].filter(child => child.tagName === 'LI');
        return '\n' + items.map((item,index) => (tag === 'OL' ? (index+1) + '. ' : '- ') +
          walk(item).trim().replace(/\n/g,'\n  ')).join('\n') + '\n\n';
      }
      const content = [...node.childNodes].map(walk).join('');
      if (/^H[1-6]$/.test(tag || '')) return '\n\n' + '#'.repeat(+tag[1]) + ' ' + content.trim() + '\n\n';
      if (tag === 'B' || tag === 'STRONG') return content.trim() ? '**' + content + '**' : content;
      if (tag === 'I' || tag === 'EM') return content.trim() ? '*' + content + '*' : content;
      if (tag === 'U') return '<u>' + content + '</u>';
      if (tag === 'CODE') return '`' + node.textContent.replace(/`/g,'') + '`';
      if (tag === 'A' && /^(?:https?:\/\/|\/(?!\/)|#)/i.test(node.getAttribute('href') || '')) {
        return '[' + content + '](' + node.getAttribute('href').replace(/[()\s]/g, ch => '%' + ch.charCodeAt(0).toString(16)) + ')';
      }
      if (tag === 'P' || tag === 'DIV' || tag === 'BLOCKQUOTE') return content + '\n\n';
      return content;
    };
    return walk(root).trim();
  }

  function configure(value) {
    bridge = value;
    toggle = document.getElementById('workspaceMarkdownToggle');
    tools = document.getElementById('workspaceMarkdownToolbar');
    view = document.getElementById('workspaceMarkdownView');
    wrap = document.getElementById('studentEditorWrap');
    toggle.addEventListener('click', () => switchMode(!editing));
    view.addEventListener('copy', event => {if (!clipboardAllowed()) event.preventDefault();});
    tools.addEventListener('pointerdown', event => {if (event.target.closest('button')) event.preventDefault();});
    tools.addEventListener('click', event => {
      const action = event.target.closest('[data-workspace-md]')?.dataset.workspaceMd;
      if (action) format(action);
    });
    editor()?.on('changes', refresh);
    textarea()?.addEventListener('input', refresh);
    const observer = new MutationObserver(sync);
    observer.observe(document.body, {attributes:true,attributeFilter:['class']});
    opened();
  }

  window.EagleWorkspaceMarkdown = {configure, opened, sync, refresh, present, writable, insertNotes, notebookHtml, notesMarkdown};
})();
