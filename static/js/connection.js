/* Same-origin connection checks. Editing never waits for this controller. */
(function () {
  'use strict';
  const ide = window.EagleIDE = window.EagleIDE || {};
  const message = 'Connection lost. Keep this tab open while EagleIDE reconnects. You can continue editing.';
  let lost = navigator.onLine === false;
  let restoringSession = false;
  let socket = null;
  let instance = '', prepareSession;
  let timer = null, checking = null, revision = 0, failures = 0;
  const listeners = new Set();

  function render() {
    document.body.classList.toggle('connection-lost', lost);
    for (const id of ['connectionWarning', 'fileConnectionWarning', 'shellConnectionWarning']) {
      const element = document.getElementById(id);
      if (element) element.hidden = !lost;
    }
    const executionWarning = document.getElementById('executionConnectionWarning');
    if (executionWarning) executionWarning.hidden = lost || !!socket?.connected;
    const files = document.getElementById('fileBrowserTabPane');
    if (files) files.setAttribute('aria-disabled', String(lost));
    const title = document.getElementById('connectionWarningTitle');
    if (title) title.textContent = restoringSession ? 'Restoring your session.' : 'Reconnecting to EagleIDE.';
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
    setLost(true);
    schedule(1000);
  }

  function schedule(delay) {
    clearTimeout(timer);
    timer = setTimeout(check, delay + Math.floor(Math.random() * (lost ? 2000 : 4000)));
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
          return response.ok && (await response.json()).ok === true ? response : null;
        })();
        const response = await Promise.race([probe, expired]);
        // A newer HTTP or browser-offline failure wins over this probe.
        if (startedRevision !== revision || navigator.onLine === false) return false;
        if (!response) { restoringSession = false; failures++; setLost(true); return false; }
        const nextInstance = response.headers?.get('X-EagleIDE-Instance') || instance;
        const restarted = !!instance && instance !== nextInstance;
        const session = prepareSession?.({ restarted, reconnecting: lost });
        restoringSession = !!session?.then;
        if (restarted || lost || restoringSession) setLost(true);
        const ready = session === undefined || await session;
        if (startedRevision !== revision || navigator.onLine === false) return false;
        if (!ready) { failures++; setLost(true); return false; }
        instance = nextInstance;
        failures = 0;
        restoringSession = false;
        setLost(false);
        if (socket?.active === false && !socket.connected) socket.connect();
        return !lost;
      } catch {
        if (startedRevision === revision) { failures++; setLost(true); }
        return false;
      } finally {
        clearTimeout(timeout);
        checking = null;
        // One bounded probe at a time; suspended tabs do less work.
        schedule(document.hidden ? 30000 : lost ? Math.min(15000, 1500 * 2 ** Math.min(4, failures)) : 15000);
      }
    })();
    return checking;
  }

  function bindSocket(nextSocket) {
    socket = nextSocket;
    socket.on('connect', render);
    socket.on('disconnect', () => { render(); schedule(0); });
    socket.on('connect_error', render);
    render();
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
      // A slow individual request can fail while the rest of the site responds.
      // Confirm reachability before disabling unrelated file operations.
      check();
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
  window.addEventListener('online', () => schedule(0));
  window.addEventListener('pageshow', () => schedule(0));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(0); });
  window.addEventListener('beforeunload', event => {
    if (!lost) return;
    event.preventDefault(); event.returnValue = '';
  });
  document.getElementById('connectionRetryBtn')?.addEventListener('click', check);
  ide.connection = { isLost: () => lost, canRun: () => !lost && !!socket?.connected, request, check, reportFailure,
    prepareSession(handler) { prepareSession = handler; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }, message };
  window.addEventListener('eagle-socket-ready', event => bindSocket(event.detail.socket));
  render();
  schedule(1000);
})();
