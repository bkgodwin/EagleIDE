export function consoleKeyboardSource() {
  return `(${installConsoleKeyboard.toString()})();`;
}

function installConsoleKeyboard() {
  const appleMobile = /iPad|iPhone|iPod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!appleMobile) return;

  const terminalInput = '.xterm-helper-textarea';
  const vmCanvas = '#noVNC_container canvas';
  const vmInput = '#noVNC_keyboardinput';

  // Focus the console again on a tap after using the surrounding lab report or toolbar.
  document.addEventListener('click', event => {
    const target = event.target;
    if (!target.closest || target.closest('a, button, input, textarea') || window.getSelection()?.isCollapsed === false) return;
    const consoleInput = target.closest('.xterm')?.querySelector(terminalInput);
    const canvas = target.closest(vmCanvas);
    if (consoleInput) consoleInput.focus({preventScroll: true});
    else if (canvas && !document.activeElement?.matches(vmInput)) canvas.focus({preventScroll: true});
  }, true);

  function dispatch(target, type, details, keyCode) {
    const event = new KeyboardEvent(type, {...details, bubbles: true, cancelable: true});
    Object.defineProperties(event, {keyCode: {value: keyCode}, which: {value: keyCode}});
    target.dispatchEvent(event);
  }

  function keyboard(event) {
    const target = event.target;
    if (!target.matches?.(`${terminalInput}, ${vmCanvas}, ${vmInput}`) || event.isComposing) return;
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
