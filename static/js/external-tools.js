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
  function status(message) { if ($('externalToolStatus')) $('externalToolStatus').textContent = message; }
  function revoke(instance, auth, keepalive = false) {
    if (instance) api(`/api/tools/instances/${encodeURIComponent(instance)}`, { method: 'DELETE', keepalive }, auth).catch(() => {});
  }
  function dispose() {
    const old = state.current;
    state.generation++;
    state.current = null;
    $('externalToolFrameHost')?.replaceChildren();
    if ($('externalToolWorkspace')) $('externalToolWorkspace').hidden = true;
    document.body.classList.remove('external-tool-mode');
    if (old) revoke(old.instance, old.auth, true);
  }
  function leave({ force = false } = {}) {
    if (!state.current) return true;
    if (!force && !window.confirm('Close this tool? Use its save or download controls first. EagleIDE does not save its projects.')) return false;
    dispose();
    return true;
  }
  let channel;
  try { channel = new BroadcastChannel('eagleide-tool-account'); } catch {}
  function accountLeaving() {
    dispose();
    channel?.postMessage({ type: 'account-change' });
    if ($('externalToolsModal')) $('externalToolsModal').style.display = 'none';
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
      frame.setAttribute('sandbox', `allow-scripts allow-downloads${launch.forms ? ' allow-forms' : ''}`);
      frame.referrerPolicy = 'no-referrer';
      frame.src = launch.url;
      frame.addEventListener('load', () => {
        if (generation !== state.generation) return;
        status(launch.preview ? 'Private admin preview. Check rendering, assets, APIs and download behavior before enabling.' : 'Document loaded. Saving and downloads follow the app’s controls.');
      });
      frame.addEventListener('error', () => { if (generation === state.generation) status('Application did not load. Retry or contact your teacher.'); });
      $('externalToolFrameHost').append(frame);
      status(launch.preview ? 'Loading private admin preview…' : 'Loading…');
      window.dispatchEvent(new CustomEvent('external-tool-launched', { detail: { toolId: tool.id, instanceId: launch.instance_id, preview: launch.preview } }));
      return true;
    } catch (error) { if (generation === state.generation) status(error.message); return false; }
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
      status(authKey() === '{}' ? 'Sign in to open this tool.' : 'This tool is unavailable or your classes do not grant access.');
    }
    return true;
  }
  async function heartbeat() {
    const current = state.current;
    if (!current?.instance) return;
    try {
      await api(`/api/tools/instances/${encodeURIComponent(current.instance)}`, { method: 'POST' }, current.auth);
      if (current === state.current && current.offline) { current.offline = false; status('Connection restored.'); }
    } catch (error) {
      if (current !== state.current) return;
      if ([401, 403, 410].includes(error.status)) { dispose(); window.WikiReader?.showHome?.({ push: true }); window.alert('Tool access expired or was revoked.'); }
      else { current.offline = true; status('Connection unavailable. Keep this page open and download work if the app permits it.'); }
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
  window.ExternalTools = { open, route, refresh, leave, accountLeaving, bindClass, headers, api, active: () => !!state.current };
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
