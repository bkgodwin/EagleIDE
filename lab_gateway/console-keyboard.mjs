export function consoleKeyboardSource(config) {
  return `(${installConsoleKeyboard.toString()})(${JSON.stringify(config)});`;
}

function installConsoleKeyboard({clipboardKey, portalOrigin}) {
  const appleMobile = /iPad|iPhone|iPod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  const broker = window.top === window ? window.opener : window.top;
  let controlsVisible = matchMedia('(any-pointer: coarse)').matches;
  const terminalInput = '.xterm-helper-textarea';
  const vmCanvas = '#noVNC_container canvas';
  const vmInput = '#noVNC_keyboardinput';
  const forwarded = new WeakSet();
  let selecting = false, selectionDrag, toolbar, status, pastePending = false, pasteSerial = 0;
  const terminal = () => window.term?.element?.isConnected ? window.term : null;

  function show(message) {
    if (status) status.textContent = message;
  }
  async function copySelection() {
    const term = terminal();
    const text = term ? term.getSelection() : document.querySelector('#noVNC_clipboard_text')?.value;
    if (!text) {
      show(term ? 'Select shell text to copy.' : 'Copy text inside the guest first. VM clipboard transfer requires guest clipboard support.');
      return;
    }
    try { await navigator.clipboard.writeText(text); show('Copied for Eagle Lab'); }
    catch (error) { show(error.message); }
  }
  function pasteText(target, text, shifted = false) {
    const term = terminal();
    if (typeof text !== 'string' || text.length > 1000000) throw new Error('Clipboard text is too large.');
    if (!document.contains(target)) return;
    if (term) {
      // Use xterm's paste API for newline normalization and bracketed paste mode.
      term.paste(text);
      term.focus();
      show('');
    } else {
      const clipboard = document.querySelector('#noVNC_clipboard_text');
      if (!clipboard) throw new Error('The VM clipboard is not ready.');
      clipboard.value = text;
      clipboard.dispatchEvent(new Event('change', {bubbles:true}));
      const canvas = document.querySelector(vmCanvas);
      canvas.focus({preventScroll:true});
      const control = {key:'Control',code:'ControlLeft',ctrlKey:true};
      dispatch(canvas,'keydown',control,17);
      if (shifted) dispatch(canvas,'keydown',{key:'Shift',code:'ShiftLeft',ctrlKey:true,shiftKey:true},16);
      const key = {key:shifted?'V':'v',code:'KeyV',ctrlKey:true,shiftKey:shifted};
      dispatch(canvas,'keydown',key,86);
      dispatch(canvas,'keyup',key,86);
      if (shifted) dispatch(canvas,'keyup',{key:'Shift',code:'ShiftLeft',ctrlKey:true},16);
      dispatch(canvas,'keyup',{key:'Control',code:'ControlLeft'},17);
      show('Sent to VM clipboard. The guest must support clipboard transfer.');
    }
  }
  async function pasteClipboard(target, shifted = false) {
    if (pastePending) return;
    const serial = ++pasteSerial;
    pastePending = true;
    try {
      const text = await navigator.clipboard.readText();
      if (serial === pasteSerial) pasteText(target,text,shifted);
    } catch (error) {
      if (serial === pasteSerial) show(error.message || 'Copy an instruction in Eagle Lab and try Paste again.');
    } finally {
      if (serial === pasteSerial) pastePending = false;
    }
  }
  document.addEventListener('paste', event => {
    if (!event.target.matches?.(`${terminalInput}, ${vmCanvas}, ${vmInput}`) || !event.clipboardData) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    pasteSerial++;
    pastePending = true;
    try { pasteText(event.target,event.clipboardData.getData('text/plain')); }
    catch (error) { show(error.message); }
    finally { pastePending = false; }
  },true);
  document.addEventListener('copy', event => {
    if (!event.target.closest?.('.xterm')) return;
    const text = terminal()?.getSelection();
    if (!text) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    event.clipboardData?.setData('text/plain',text);
    navigator.clipboard.writeText(text).then(()=>show('Copied for Eagle Lab')).catch(error=>show(error.message));
  },true);

  window.addEventListener('message', event => {
    const message = event.data;
    if (event.source !== broker || event.origin !== portalOrigin || message?.key !== clipboardKey
        || message.type !== 'eagle-lab-clipboard-controls' || typeof message.visible !== 'boolean') return;
    controlsVisible = message.visible;
    if (toolbar) toolbar.hidden = !controlsVisible;
    if (!controlsVisible) {
      selecting = false;
      selectionDrag = null;
      document.body.classList.remove('eagle-console-select');
      toolbar?.querySelector('[aria-pressed]')?.setAttribute('aria-pressed', 'false');
    }
  });

  function mount() {
    if (toolbar || !document.querySelector(`.xterm, ${vmCanvas}`)) return;
    const style = document.createElement('style');
    style.textContent = `
      .eagle-console-tools { position:fixed;right:8px;top:8px;z-index:10000;display:flex;align-items:center;gap:4px;max-width:calc(100% - 16px);flex-wrap:wrap;padding:4px;background:#18202fee;color:#fff;border:1px solid #778399;border-radius:6px;font:12px/1.4 sans-serif; }
      .eagle-console-tools[hidden] { display:none; }
      .eagle-console-tools button { min-height:36px;padding:4px 10px;border:1px solid #7b8da8;border-radius:4px;background:#26354a;color:#fff;cursor:pointer;touch-action:manipulation;font:inherit; }
      .eagle-console-tools button[aria-pressed=true] { background:#226bb8; }
      .eagle-console-status:empty { display:none; }
      .eagle-console-status { flex:0 0 100%;max-width:360px; }
      .eagle-console-select .xterm { touch-action:none!important;cursor:text; }
      #wrap > .center { pointer-events:none; }
      #connect_dlg.pve_open { pointer-events:auto; }
      #status_bar.normal { pointer-events:none; }
    `;
    document.head.append(style);
    toolbar = document.createElement('div');
    toolbar.className = 'eagle-console-tools';
    toolbar.hidden = !controlsVisible;
    toolbar.setAttribute('aria-label', 'Console clipboard');
    const buttons = terminal() ? ['Copy','Paste','Select text'] : ['Copy','Paste'];
    for (const label of buttons) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      if (label === 'Select text') button.setAttribute('aria-pressed','false');
      button.onclick = () => {
        if (label === 'Copy') copySelection();
        else if (label === 'Paste') pasteClipboard(document.querySelector(terminalInput) || document.querySelector(vmCanvas));
        else {
          selecting = !selecting;
          button.setAttribute('aria-pressed',String(selecting));
          document.body.classList.toggle('eagle-console-select',selecting);
          show(selecting ? 'Drag across shell text, then use Copy.' : '');
        }
      };
      toolbar.append(button);
    }
    status = document.createElement('span');
    status.className = 'eagle-console-status';
    status.setAttribute('role','status');
    toolbar.append(status);
    document.body.append(toolbar);
    broker?.postMessage({type:'eagle-lab-clipboard-controls-ready', key:clipboardKey}, portalOrigin);
    // noVNC writes received guest clipboard text directly into this field.
    const clipboard = document.querySelector('#noVNC_clipboard_text');
    const value = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value');
    if (clipboard && value?.set) Object.defineProperty(clipboard,'value',{configurable:true,
      get() { return value.get.call(this); },
      set(text) {
        value.set.call(this,text);
        // The change handler also sets this field for outbound transfers.
        if (!pastePending && text) navigator.clipboard.writeText(String(text)).catch(error => show(error.message));
      },
    });
    observer.disconnect();
  }
  const observer = new MutationObserver(mount);
  observer.observe(document,{childList:true,subtree:true});
  document.addEventListener('DOMContentLoaded',mount);

  function cell(event, term) {
    const screen = term.element.querySelector('.xterm-screen').getBoundingClientRect();
    const column = Math.max(0,Math.min(term.cols - 1,Math.floor((event.clientX - screen.left) / screen.width * term.cols)));
    const row = Math.max(0,Math.min(term.rows - 1,Math.floor((event.clientY - screen.top) / screen.height * term.rows)));
    return (term.buffer.active.viewportY + row) * term.cols + column;
  }
  document.addEventListener('pointerdown',event => {
    const term = terminal();
    if (!selecting || !term || !event.target.closest('.xterm') || event.button !== 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    selectionDrag = {id:event.pointerId,anchor:cell(event,term)};
    term.element.setPointerCapture(event.pointerId);
    term.select(selectionDrag.anchor % term.cols,Math.floor(selectionDrag.anchor / term.cols),1);
  },true);
  document.addEventListener('pointermove',event => {
    if (selectionDrag?.id !== event.pointerId) return;
    const term = terminal();
    if (!term) return;
    event.preventDefault();
    const end = cell(event,term), start = Math.min(end,selectionDrag.anchor);
    term.select(start % term.cols,Math.floor(start / term.cols),Math.abs(end - selectionDrag.anchor) + 1);
  },true);
  function endSelection(event) {
    if (selectionDrag?.id === event.pointerId) selectionDrag = null;
  }
  document.addEventListener('pointerup',endSelection,true);
  document.addEventListener('pointercancel',endSelection,true);

  // Focus the console again on a tap after using the surrounding lab report or toolbar.
  function focusConsole(event) {
    const target = event.target;
    if (!target.closest || target.closest('a, button, input, textarea') || terminal()?.hasSelection()) return;
    const consoleInput = target.closest('.xterm')?.querySelector(terminalInput);
    const canvas = target.closest(vmCanvas);
    if (consoleInput) consoleInput.focus({preventScroll: true});
    else if (canvas && !document.activeElement?.matches(vmInput)) canvas.focus({preventScroll: true});
  }
  document.addEventListener('pointerup', focusConsole, true);
  document.addEventListener('click', focusConsole, true);

  function dispatch(target, type, details, keyCode) {
    const event = new KeyboardEvent(type, {...details, bubbles: true, cancelable: true});
    Object.defineProperties(event, {keyCode: {value: keyCode}, which: {value: keyCode}});
    forwarded.add(event);
    target.dispatchEvent(event);
  }

  function keyboard(event) {
    if (forwarded.has(event)) return;
    const target = event.target;
    if (!target.matches?.(`${terminalInput}, ${vmCanvas}, ${vmInput}`) || event.isComposing) return;
    const modifier = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    const term = terminal();
    const paste = modifier && key === 'v' && !event.altKey;
    const copy = modifier && key === 'c' && !event.altKey && term && (event.shiftKey || term.hasSelection());
    if (paste || copy) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === 'keydown' && !event.repeat) {
        if (paste) pasteClipboard(target,event.shiftKey);
        else copySelection();
      }
      return;
    }
    if (!appleMobile) return;
    const letter = /^[a-z]$/i.test(event.key) ? event.key.toUpperCase() : '';
    const keyCode = letter ? letter.charCodeAt(0) : event.keyCode;
    const code = letter && (!event.code || event.code === 'Enter') ? 'Key' + letter : event.code;

    if (event.key === 'Meta') {
      event.stopImmediatePropagation();
      return;
    }
    const command = event.metaKey && event.type === 'keydown' && !['Control', 'Shift', 'Alt', 'CapsLock'].includes(event.key);
    // Older xterm builds read keyCode. Hardware Ctrl+C can arrive as key "c" with keyCode 13.
    const wrongControlCode = event.ctrlKey && letter && (event.keyCode !== keyCode || event.code !== code);
    if (!command && !wrongControlCode) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    const chord = {key: event.key, code, location: event.location, ctrlKey: true,
      shiftKey: event.shiftKey, altKey: event.altKey};
    if (!command) {
      dispatch(target, event.type, {...chord, repeat: event.repeat}, keyCode);
      return;
    }
    const control = {key: 'Control', code: 'ControlLeft', location: 1};
    const sendControl = !target.matches(terminalInput) && !event.ctrlKey;
    if (sendControl) dispatch(target, 'keydown', {...control, ctrlKey: true}, 17);
    dispatch(target, 'keydown', {...chord, repeat: event.repeat}, keyCode);
    // WebKit may omit the original keyup while Command is held.
    dispatch(target, 'keyup', chord, keyCode);
    if (sendControl) dispatch(target, 'keyup', control, 17);
  }

  document.addEventListener('keydown', keyboard, true);
  document.addEventListener('keyup', keyboard, true);
}
