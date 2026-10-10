/* Same-origin connection checks. Editing never waits for this controller. */
(function () {
  'use strict';
  const ide = window.EagleIDE = window.EagleIDE || {};
  const message = 'Connection lost. Check your network connection. Keep this tab open until you reconnect; you can continue editing, but changes cannot be saved yet.';
  let lost = navigator.onLine === false;
  let socket = null, socketReady = false, serverReady = false;
  let timer = null, checking = null, revision = 0, failures = 0;
  const listeners = new Set();

  function render() {
    document.body.classList.toggle('connection-lost', lost);
    for (const id of ['connectionWarning', 'fileConnectionWarning', 'shellConnectionWarning']) {
      const element = document.getElementById(id);
      if (element) element.hidden = !lost;
    }
    const files = document.getElementById('fileBrowserTabPane');
    if (files) files.setAttribute('aria-disabled', String(lost));
    if (lost) {
      for (const id of ['runBtn', 'stepModeBtn', 'sendBtn', 'executionQueueCancelBtn']) {
        const button = document.getElementById(id);
        if (button) button.disabled = true;
      }
    }
  }

  function setLost(next) {
    if (next === lost) { render(); return; }
    lost = next;
    render();
    listeners.forEach(listener => listener(lost));
    window.dispatchEvent(new CustomEvent('eagle-connection-changed', { detail: { lost } }));
  }

  function reportFailure() {
    revision++;
    serverReady = false;
    setLost(true);
    schedule(1000);
  }

  function schedule(delay) {
    clearTimeout(timer);
    timer = setTimeout(check, delay);
  }

  async function check() {
    if (checking) return checking;
    clearTimeout(timer);
    if (navigator.onLine === false) { reportFailure(); schedule(15000); return false; }
    const startedRevision = revision;
    checking = (async () => {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      let timeout;
      try {
        const expired = new Promise((_, reject) => {
          timeout = setTimeout(() => {
            controller?.abort();
            reject(new Error('Connection check timed out'));
          }, 8000);
        });
        const probe = (async () => {
          const response = await fetch('/health', { cache: 'no-store', credentials: 'omit', signal: controller?.signal });
          return response.ok && (await response.json()).ok === true;
        })();
        const ok = await Promise.race([probe, expired]);
        // An offline/socket event that occurred during the probe wins.
        if (startedRevision !== revision || navigator.onLine === false) return false;
        serverReady = ok;
        failures = ok ? 0 : failures + 1;
        setLost(!serverReady || !socketReady);
        return !lost;
      } catch {
        if (startedRevision === revision) { serverReady = false; failures++; setLost(true); }
        return false;
      } finally {
        clearTimeout(timeout);
        checking = null;
        // One bounded probe at a time; suspended tabs do less work.
        schedule(document.hidden ? 30000 : lost ? Math.min(15000, 3000 * Math.max(1, failures)) : 15000);
      }
    })();
    return checking;
  }

  function bindSocket(nextSocket) {
    socket = nextSocket;
    socketReady = !!socket?.connected;
    socket.on('connect', () => { socketReady = true; revision++; check(); });
    const closed = () => { socketReady = false; reportFailure(); };
    socket.on('disconnect', closed);
    socket.on('connect_error', closed);
  }

  async function request(url, options = {}, timeoutMs = 12000) {
    if (lost || navigator.onLine === false) throw new Error(message);
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timeout;
    try {
      const expired = new Promise((_, reject) => {
        timeout = setTimeout(() => { controller?.abort(); reject(new Error(message)); }, timeoutMs);
      });
      // Read the complete response under the deadline, including a stalled body.
      const operation = (async () => {
        const response = await fetch(url, { ...options, signal: controller?.signal });
        const body = await response.arrayBuffer();
        return new Response([204, 205, 304].includes(response.status) ? null : body, { status: response.status, statusText: response.statusText, headers: response.headers });
      })();
      return await Promise.race([operation, expired]);
    } catch (error) {
      reportFailure();
      throw error;
    } finally { clearTimeout(timeout); }
  }

  // Capture mouse, touch, keyboard, context-menu and drag/drop file actions.
  for (const type of ['click', 'dblclick', 'contextmenu', 'keydown', 'change', 'drop', 'dragstart']) {
    document.addEventListener(type, event => {
      if (!lost || !event.target.closest?.('#fileBrowserTabPane, .file-context-menu, .file-name-dialog')) return;
      // Let students cancel an already-open dialog.
      if (event.key === 'Escape' || event.target.closest?.('.file-name-dialog button[type="button"]')) return;
      event.preventDefault(); event.stopImmediatePropagation();
    }, true);
  }
  window.addEventListener('offline', reportFailure);
  window.addEventListener('online', () => { revision++; check(); socket?.connect(); });
  window.addEventListener('pageshow', check);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  window.addEventListener('beforeunload', event => {
    if (!lost) return;
    event.preventDefault(); event.returnValue = '';
  });
  document.getElementById('connectionRetryBtn')?.addEventListener('click', () => { check(); socket?.connect(); });
  ide.connection = { isLost: () => lost, canRun: () => !lost && !!socket?.connected, request, check, reportFailure,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }, message };
  window.addEventListener('eagle-socket-ready', event => bindSocket(event.detail.socket));
  render();
  schedule(1000);
})();
