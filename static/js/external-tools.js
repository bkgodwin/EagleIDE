/* Generic application workspace. Application code never runs in EagleIDE's origin. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const state = { tools: [], auth: '', generation: 0, request: 0, current: null, loading: null };
  const ctx = () => window.EagleIDE?.getContext?.() || {};
  function headers() {
    const c = ctx();
    if (c.ADMIN_TOKEN) return { 'X-Admin-Token': c.ADMIN_TOKEN };
    if (c.currentTeacher?.is_coteacher) return { 'X-User-Token': c.TEACHER_TOKEN };
    if (c.TEACHER_TOKEN) return { 'X-Teacher-Token': c.TEACHER_TOKEN };
    return c.USER_TOKEN ? { 'X-User-Token': c.USER_TOKEN } : {};
  }
  const authKey = () => JSON.stringify(headers());
  async function api(url, options = {}, auth = headers()) {
    const response = await fetch(url, { ...options, cache: 'no-store', headers: { ...auth, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) { const error = new Error(data.error || `Request failed (${response.status})`); error.status = response.status; throw error; }
    return data;
  }
  function status(message, attention = false) {
    if ($('externalToolStatus')) $('externalToolStatus').textContent = message;
    const info = $('externalToolInfo'), summary = info?.querySelector('summary');
    if (summary) { summary.textContent = attention ? 'Check' : 'Info'; summary.setAttribute('data-attention', String(attention)); }
    if (attention && info) info.open = true;
  }
  const loadedStatus = current => current.preview
    ? 'Private admin preview: document loaded. Check rendering, assets, actions and downloads before enabling.'
    : 'Document loaded. Use the app’s controls to save or download your work.';
  function revoke(instance, auth, keepalive = false) {
    if (instance) api(`/api/tools/instances/${encodeURIComponent(instance)}`, { method: 'DELETE', keepalive }, auth).catch(() => {});
  }
  function dispose() {
    const old = state.current;
    old?.frame?.contentWindow?.postMessage({ type: 'eagle-tool-dispose', instance: old.instance }, '*');
    state.generation++;
    state.current = null;
    if ($('externalToolInfo')) $('externalToolInfo').open = false;
    $('externalToolFrameHost')?.replaceChildren();
    if ($('externalToolWorkspace')) $('externalToolWorkspace').hidden = true;
    document.body.classList.remove('external-tool-mode');
    if (old) revoke(old.instance, old.auth, true);
  }
  function leave({ force = false } = {}) {
    if (!state.current) return true;
    if (!force && !window.confirm(state.current.dirty || state.current.storageError ? 'Tool storage has unsaved changes or a save error. Cancel to wait for saving, retry, or download your work before closing.' : 'Close this tool? Use its save or download controls first. Cloud storage covers only data the app has written to its storage.')) return false;
    dispose();
    return true;
  }
  let channel;
  try { channel = new BroadcastChannel('eagleide-tool-account'); } catch {}
  function accountLeaving() {
    dispose();
    channel?.postMessage({ type: 'account-change' });
    if ($('externalToolsModal')) $('externalToolsModal').style.display = 'none';
    if ($('externalToolStorageModal')) $('externalToolStorageModal').style.display = 'none';
  }
  if (channel) channel.onmessage = event => {
    if (event.data?.type !== 'account-change') return;
    dispose();
    if (/^\/[a-z][a-z0-9-]*\/$/.test(location.pathname)) window.WikiReader?.showHome?.({ push: true });
  };
  function shell(tool) {
    window.WikiReader?.disposeActiveContent?.();
    document.body.classList.remove('wiki-mode', 'network-mode');
    document.body.classList.add('external-tool-mode');
    $('externalToolWorkspace').hidden = false;
    $('externalToolTitle').textContent = tool.name;
    $('externalToolFrameHost').replaceChildren();
  }
  async function open(tool, { push = true } = {}) {
    if (!leave()) return false;
    const generation = ++state.generation, auth = headers(), key = authKey();
    shell(tool);
    status('Authorizing…');
    state.current = { tool, auth, instance: null, generation };
    if (push && location.pathname !== `/${tool.slug}/`) history.pushState({ eagleView: 'tool', tool: tool.id }, '', `/${tool.slug}/`);
    try {
      const launch = await api(`/api/tools/${encodeURIComponent(tool.id)}/launch`, { method: 'POST' }, auth);
      if (generation !== state.generation || key !== authKey()) { revoke(launch.instance_id, auth); return false; }
      state.current.instance = launch.instance_id;
      state.current.preview = launch.preview;
      const frame = document.createElement('iframe');
      frame.title = tool.name;
      frame.setAttribute('sandbox', `allow-scripts allow-downloads${launch.forms ? ' allow-forms' : ''}${launch.popups ? ' allow-popups' : ''}${launch.dialogs ? ' allow-modals' : ''}`);
      frame.referrerPolicy = 'no-referrer';
      frame.src = launch.url;
      state.current.frame = frame;
      if ($('externalToolSaveState')) $('externalToolSaveState').textContent = 'Starting';
      frame.addEventListener('load', () => {
        if (generation !== state.generation) return;
        state.current.loaded = true;
        if (!state.current.offline && !state.current.storageError) status(loadedStatus(state.current));
      });
      frame.addEventListener('error', () => { if (generation === state.generation) status('Application did not load. Reload or contact your teacher.', true); });
      $('externalToolFrameHost').append(frame);
      status(launch.preview ? 'Loading private admin preview…' : 'Loading…');
      window.dispatchEvent(new CustomEvent('external-tool-launched', { detail: { toolId: tool.id, instanceId: launch.instance_id, preview: launch.preview } }));
      return true;
    } catch (error) { if (generation === state.generation) status(error.message, true); return false; }
  }
  function renderButtons() {
    const host = $('externalToolButtons');
    if (!host) return;
    host.replaceChildren();
    state.tools.forEach(tool => { const button = document.createElement('button'); button.type = 'button'; button.className = 'btn run'; button.textContent = tool.label; button.onclick = () => open(tool); host.append(button); });
  }
  async function refresh() {
    const key = authKey(), requestId = ++state.request;
    if (state.auth && key !== state.auth) accountLeaving();
    state.auth = key;
    if (key === '{}') { state.tools = []; renderButtons(); return; }
    try {
      const data = await api('/api/tools');
      if (requestId !== state.request || key !== authKey()) return;
      state.tools = data.tools;
      renderButtons();
      if (state.current && !state.tools.some(tool => tool.id === state.current.tool.id)) { dispose(); window.WikiReader?.showHome?.({ push: true }); }
    } catch (error) {
      if (requestId !== state.request || key !== authKey()) return;
      if ([401, 403].includes(error.status)) { state.tools = []; renderButtons(); dispose(); }
    }
  }
  function route() {
    const path = location.pathname;
    if (state.current && path !== `/${state.current.tool.slug}/`) {
      const previous = `/${state.current.tool.slug}/`;
      if (!leave()) { history.pushState({ eagleView: 'tool' }, '', previous); return true; }
    }
    if (!/^\/[a-z][a-z0-9-]{0,47}\/$/.test(path)) return false;
    if (state.current?.tool.slug === path.slice(1, -1)) return true;
    const tool = state.tools.find(item => `/${item.slug}/` === path);
    if (tool) open(tool, { push: false });
    else {
      shell({ name: 'External tool' });
      status(authKey() === '{}' ? 'Sign in to open this tool.' : 'This tool is unavailable or your classes do not grant access.', true);
    }
    return true;
  }
  async function heartbeat() {
    const current = state.current;
    if (!current?.instance) return;
    try {
      await api(`/api/tools/instances/${encodeURIComponent(current.instance)}`, { method: 'POST' }, current.auth);
      if (current === state.current && current.offline) { current.offline = false; if (!current.storageError) status(current.loaded ? loadedStatus(current) : 'Connection restored. Application is loading.'); }
    } catch (error) {
      if (current !== state.current) return;
      if ([401, 403, 410].includes(error.status)) { dispose(); window.WikiReader?.showHome?.({ push: true }); window.alert('Tool access expired or was revoked.'); }
      else { current.offline = true; status('Connection unavailable. Keep this page open and download work if the app permits it.', true); }
    }
  }
  function bindClass(wrap, cls) {
    const section = document.createElement('section'); section.className = 'external-tool-class-settings';
    const button = document.createElement('button'); button.className = 'btn secondary'; button.textContent = 'External Tools'; button.type = 'button';
    const body = document.createElement('div'); section.append(button, body); wrap.querySelector('.teacher-dash-class-card')?.append(section);
    button.onclick = async () => {
      const key = authKey(); body.textContent = 'Loading…';
      try {
        const data = await api(`/api/teacher/classes/${encodeURIComponent(cls.id)}/tools`);
        if (key !== authKey() || !section.isConnected || ctx().currentTeacherClassId !== cls.id) return;
        body.replaceChildren();
        data.tools.forEach(tool => { const label = document.createElement('label'); label.className = 'choice-item'; const input = document.createElement('input'); input.type = 'checkbox'; input.value = tool.id; input.checked = data.granted.includes(tool.id); label.append(input, document.createTextNode(tool.name)); body.append(label); });
        if (!data.tools.length) body.append(document.createTextNode('No globally enabled tools.'));
        const save = document.createElement('button'); save.type = 'button'; save.className = 'btn secondary'; save.textContent = 'Save tool access'; body.append(save);
        save.onclick = async () => {
          if (key !== authKey() || !section.isConnected || ctx().currentTeacherClassId !== cls.id) return;
          save.disabled = true;
          try {
            await api(`/api/teacher/classes/${encodeURIComponent(cls.id)}/tools`, { method: 'PUT', body: JSON.stringify({ revision: data.revision, tool_ids: [...body.querySelectorAll('input:checked')].map(input => input.value) }) });
            if (key === authKey() && section.isConnected) { button.click(); refresh(); }
          } catch (error) { if (key === authKey()) window.alert(error.message); }
          finally { save.disabled = false; }
        };
      } catch (error) { if (key === authKey() && section.isConnected) body.textContent = error.message; }
    };
  }
  window.ExternalTools = { open, route, refresh, leave, accountLeaving, bindClass, headers, api, active: () => !!state.current, unsavedStorage: () => !!(state.current?.dirty || state.current?.storageError) };
  window.addEventListener('message', event => {
    const current = state.current, data = event.data;
    if (!current?.frame || event.source !== current.frame.contentWindow || event.origin !== 'null' || data?.type !== 'eagle-tool-storage' || data.instance !== current.instance) return;
    if (!['saved', 'saving', 'disabled', 'error', 'conflict'].includes(data.state)) return;
    current.dirty = data.dirty === true;
    const previousError = current.storageError;
    current.storageError = ['error', 'conflict'].includes(data.state);
    const labels = { saved: 'Storage synced', saving: 'Syncing…', disabled: 'Downloads only', error: 'Not saved', conflict: 'Save conflict' };
    if ($('externalToolSaveState')) $('externalToolSaveState').textContent = labels[data.state];
    if ($('externalToolCloudStatus')) $('externalToolCloudStatus').textContent = String(data.message || '').slice(0, 500);
    if (['error', 'conflict'].includes(data.state)) status('Tool storage needs attention. Download your work or a storage backup before leaving.', true);
    else if (previousError && !current.offline) status(loadedStatus(current));
  });
  for (const [id, type] of [['externalToolSaveRetry', 'eagle-tool-retry'], ['externalToolBackup', 'eagle-tool-backup']]) {
    $(id)?.addEventListener('click', () => { const current = state.current; current?.frame?.contentWindow.postMessage({ type, instance: current.instance }, '*'); });
  }
  let storageSummary, storageGeneration = 0, storageAuthKey = authKey();
  const mib = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1048576).toFixed(2)} MiB`;
  async function storageLoad() {
    const key = authKey(), generation = ++storageGeneration;
    $('externalToolStorageList').replaceChildren();
    $('externalToolStorageUsage').textContent = 'Loading…'; storageSummary = null;
    try {
      const result = await api('/api/tools/storage');
      if (key !== authKey() || generation !== storageGeneration) return;
      storageSummary = result.storage;
      $('externalToolStorageUsage').textContent = `${mib(storageSummary.used_bytes)} of ${mib(storageSummary.quota_bytes)} used. Cloud storage ${storageSummary.enabled ? 'enabled' : 'disabled'}.`;
      for (const tool of storageSummary.tools) {
        const row = document.createElement('div'); row.className = 'external-tool-storage-row';
        const label = document.createElement('span'); label.textContent = `${tool.name}: ${mib(tool.used_bytes)}`;
        const download = document.createElement('button'); download.type = 'button'; download.className = 'btn secondary'; download.textContent = 'Backup';
        download.onclick = async () => {
          download.disabled = true;
          try {
            const response = await fetch(`/api/tools/storage/${encodeURIComponent(tool.tool)}/export`, { headers: headers(), cache: 'no-store' });
            if (!response.ok) throw new Error('Could not download storage backup');
            const blob = await response.blob();
            if (key !== authKey() || generation !== storageGeneration) return;
            const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = 'external-tool-backup.json'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
          } catch (error) { if (key === authKey()) $('externalToolStorageUsage').textContent = error.message; }
          finally { download.disabled = false; }
        };
        const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'btn secondary'; clear.textContent = 'Clear'; clear.onclick = () => storageClear(tool.tool);
        row.append(label, download, clear); $('externalToolStorageList').append(row);
      }
      if (!storageSummary.tools.length) $('externalToolStorageList').textContent = 'No saved external tool data.';
    } catch (error) { if (key === authKey() && generation === storageGeneration) $('externalToolStorageUsage').textContent = error.message; }
  }
  async function storageClear(tool = null) {
    if (!storageSummary || !window.confirm('Delete saved external tool data? Download work or a backup first. This affects your other devices too. Open tools must be reopened; their old caches cannot save over the cleared data.')) return;
    const key = authKey(), epoch = storageSummary.epoch;
    storageSummary = null;
    try {
      await api('/api/tools/storage', { method: 'DELETE', body: JSON.stringify({ epoch, tool_id: tool }) });
      if (key === authKey()) {
        const current = state.current;
        current?.frame?.contentWindow.postMessage({ type: 'eagle-tool-invalidated', instance: current.instance }, '*');
        await storageLoad();
      }
    } catch (error) { if (key === authKey()) { $('externalToolStorageUsage').textContent = error.message; } }
  }
  function storageShow() { $('externalToolStorageModal').style.display = 'flex'; storageLoad(); }
  $('roleMenuBtn')?.addEventListener('click', () => { if ($('externalToolInfo')) $('externalToolInfo').open = false; });
  document.querySelectorAll('.external-tool-storage-open').forEach(button => button.addEventListener('click', storageShow));
  $('externalToolStorageRefresh')?.addEventListener('click', storageLoad);
  $('externalToolStorageClear')?.addEventListener('click', () => storageClear());
  $('externalToolStorageDone')?.addEventListener('click', () => { storageGeneration++; $('externalToolStorageModal').style.display = 'none'; });
  window.addEventListener('eagle-context-updated', () => { const key = authKey(); if (key !== storageAuthKey) { storageAuthKey = key; storageGeneration++; storageSummary = null; $('externalToolStorageList')?.replaceChildren(); } });
  $('externalToolClose')?.addEventListener('click', () => { if (leave()) window.WikiReader?.showHome?.({ push: true }); });
  $('externalToolRetry')?.addEventListener('click', () => { const tool = state.current?.tool || state.tools.find(item => `/${item.slug}/` === location.pathname); if (tool) open(tool, { push: false }); else refresh().then(route); });
  $('settingsExternalToolsBtn')?.addEventListener('click', async () => { try { await window.EagleFeatures.load('externalToolsAdmin'); window.ExternalToolsAdmin.show(); } catch (error) { window.alert(error.message); } });
  window.addEventListener('eagle-context-updated', () => { refresh().then(() => { if (!state.current) route(); }); });
  window.addEventListener('beforeunload', event => { if (state.current) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('pagehide', dispose);
  window.addEventListener('pageshow', event => { if (event.persisted) { dispose(); refresh().then(route); } });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { heartbeat(); refresh(); } });
  setInterval(() => { heartbeat(); refresh(); }, 30000);
  refresh().then(route);
})();
