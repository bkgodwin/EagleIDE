(function () {
  'use strict';
  const $ = id => document.getElementById(id), api = (...args) => window.ExternalTools.api(...args);
  let catalog, editing = null, auth = '', requestId = 0;
  const previews = new Map();
  const key = () => JSON.stringify(window.ExternalTools.headers());
  function status(message) { $('externalToolsAdminStatus').textContent = message; }
  function section(name) {
    document.querySelector('.external-tools-body').scrollTop = 0;
    document.querySelectorAll('[data-tool-pane]').forEach(pane => { pane.hidden = pane.dataset.toolPane !== name; });
    document.querySelectorAll('[data-tool-section]').forEach(button => {
      const active = button.dataset.toolSection === name;
      button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
    });
  }
  document.querySelectorAll('[data-tool-section]').forEach(button => { button.onclick = () => section(button.dataset.toolSection); });
  function permissionSummary() {
    const writes = $('externalToolHttp').checked, forms = $('externalToolForms').checked;
    $('externalToolPermissionSummary').textContent = `${writes ? 'Read and write requests allowed (GET, HEAD, POST, PUT, PATCH, DELETE; configured server request limit).' : 'Read requests only (GET and HEAD).'} ${forms ? 'HTML forms allowed.' : 'HTML form submission is blocked.'}${forms && !writes ? ' POST forms still need server data permission.' : ''} Local file selection and downloads do not need either permission. Cloud storage, popups and dialogs use the options above.`;
  }
  $('externalToolHttp').addEventListener('change', permissionSummary);
  $('externalToolForms').addEventListener('change', permissionSummary);
  async function load() {
    const request = ++requestId, started = key();
    const data = await api('/api/admin/tools');
    if (started !== key() || request !== requestId) return;
    catalog = data.catalog; auth = started;
    $('externalToolsEnabled').checked = catalog.enabled;
    $('externalToolsAllowed').value = catalog.allowed_networks.join('\n');
    $('externalToolsDenied').value = catalog.denied_networks.join('\n');
    const host = $('externalToolsCatalog'); host.replaceChildren();
    if (!catalog.tools.length) host.textContent = 'No applications yet. Add your first tool using the app connection form.';
    catalog.tools.forEach(tool => {
      const card = document.createElement('section'); card.className = 'external-tool-card';
      const heading = document.createElement('div'); heading.className = 'external-tool-card-heading';
      const title = document.createElement('strong'); title.textContent = tool.name;
      const badge = document.createElement('span'); badge.className = `external-tool-badge${tool.enabled ? ' is-enabled' : ''}`; badge.textContent = tool.enabled ? 'Enabled' : 'Disabled'; heading.append(title, badge);
      const info = document.createElement('p'); info.textContent = `/${tool.slug}/ → ${tool.backend_url}`;
      const test = document.createElement('p'); test.textContent = tool.test;
      const next = document.createElement('p'); next.textContent = tool.enabled ? 'Teachers have access. Class owners can grant student access.' : !tool.addresses.length ? 'Next: test the connection, then open a private preview.' : !previews.has(tool.id) ? 'Next: preview and test the app’s classroom workflow.' : 'Next: confirm compatibility after checking the preview.';
      const actions = document.createElement('div'); actions.className = 'modal-actions'; card.append(heading, info, test, next, actions);
      function action(label, handler) { const button = document.createElement('button'); button.type = 'button'; button.className = 'btn secondary'; button.textContent = label; button.onclick = async () => { button.disabled = true; try { if (auth !== key()) throw new Error('Account changed. Reopen External Tools.'); await handler(); } catch (error) { if (auth === key()) status(error.message); } finally { button.disabled = false; } }; actions.append(button); }
      action('Edit', () => edit(tool));
      action('Test connection', async () => { const result = await api(`/api/admin/tools/${tool.id}/test`, { method: 'POST', body: JSON.stringify({ revision: catalog.revision }) }); status(result.tool.test); await load(); });
      action('Private preview', async () => { $('externalToolsModal').style.display = 'none'; $('adminSettingsModal').style.display = 'none'; await window.ExternalTools.open(tool); });
      action(tool.enabled ? 'Disable' : 'Confirm compatibility and enable', async () => {
        if (!tool.enabled && !window.confirm('Have you tested this tool in the private preview, including imports, downloads, cloud save/reopen and any popups or prompts it needs? Only localStorage is synchronized when enabled. Cookies/login, IndexedDB, OPFS, workers and live connections remain unavailable. Confirm only if its classroom workflow works.')) return;
        await api(`/api/admin/tools/${tool.id}/enable`, { method: 'POST', body: JSON.stringify({ revision: catalog.revision, enabled: !tool.enabled, confirmed: true, preview_id: previews.get(tool.id) }) });
        status(tool.enabled ? 'Tool disabled.' : 'Tool enabled. Class owners can now grant it.'); await load(); window.ExternalTools.refresh();
      });
      action('Delete', async () => { if (!window.confirm(`Delete ${tool.name} and its class grants? The independently deployed app and its data are not deleted.`)) return; await api(`/api/admin/tools/${tool.id}`, { method: 'DELETE', body: JSON.stringify({ revision: catalog.revision }) }); await load(); window.ExternalTools.refresh(); });
      host.append(card);
    });
  }
  function edit(tool = null) {
    editing = tool?.id || null;
    $('externalToolFormTitle').textContent = tool ? `Edit ${tool.name}` : 'Add Tool';
    for (const [id, field] of [['externalToolName','name'],['externalToolLabel','label'],['externalToolBackend','backend_url'],['externalToolSlug','slug']]) $(id).value = tool?.[field] || '';
    $('externalToolForms').checked = !!tool?.forms;
    $('externalToolHttp').checked = !!tool?.methods.includes('POST');
    $('externalToolCloud').checked = tool ? tool.storage : true;
    $('externalToolPopups').checked = tool ? tool.popups : true;
    $('externalToolDialogs').checked = tool ? tool.dialogs : true;
    $('externalToolUploadLimit').value = tool?.upload_mib || 1;
    permissionSummary();
    section('apps');
    if (tool) $('externalToolForm').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  $('externalToolForm').addEventListener('submit', async event => {
    event.preventDefault(); const started = key();
    try {
      if (!catalog || auth !== started) throw new Error('Reload External Tools first.');
      await api('/api/admin/tools', { method: 'POST', body: JSON.stringify({ id: editing, revision: catalog.revision, name: $('externalToolName').value, label: $('externalToolLabel').value, backend_url: $('externalToolBackend').value, slug: $('externalToolSlug').value, forms: $('externalToolForms').checked, upload_mib: Number($('externalToolUploadLimit').value), storage: $('externalToolCloud').checked, popups: $('externalToolPopups').checked, dialogs: $('externalToolDialogs').checked, methods: $('externalToolHttp').checked ? ['GET','HEAD','POST','PUT','PATCH','DELETE'] : ['GET','HEAD'] }) });
      if (started !== key()) return;
      edit(); status('Saved disabled. Test, preview, then confirm compatibility.'); await load();
    } catch (error) { if (started === key()) status(error.message); }
  });
  $('externalToolsPolicySave').onclick = async () => {
    const started = key();
    try {
      if (auth !== started) throw new Error('Reload External Tools first.');
      await api('/api/admin/tools/policy', { method: 'PUT', body: JSON.stringify({ revision: catalog.revision, enabled: $('externalToolsEnabled').checked, allowed_networks: $('externalToolsAllowed').value.split(/\s+/).filter(Boolean), denied_networks: $('externalToolsDenied').value.split(/\s+/).filter(Boolean) }) });
      if (started !== key()) return;
      status('Policy saved. All tools require retesting.'); await load(); window.ExternalTools.refresh();
    } catch (error) { if (started === key()) status(error.message); }
  };
  $('externalToolNew').onclick = () => { edit(); $('externalToolForm').scrollIntoView({ block: 'start', behavior: 'smooth' }); $('externalToolName').focus({ preventScroll: true }); };
  $('externalToolsDone').onclick = () => { $('externalToolsModal').style.display = 'none'; };
  let storagePolicy, storageEmail, storageAuth, storageRequest = 0;
  $('externalToolStorageEmail').addEventListener('input', () => { storageRequest++; storagePolicy = null; $('externalToolUserStorageSettings').hidden = true; });
  $('externalToolUserStorageForm').addEventListener('submit', async event => {
    event.preventDefault(); const started = key(), request = ++storageRequest;
    const email = $('externalToolStorageEmail').value.trim();
    try {
      const result = await api('/api/admin/tools/storage?email=' + encodeURIComponent(email));
      if (started !== key() || request !== storageRequest) return;
      storagePolicy = result.storage; storageEmail = email; storageAuth = started;
      $('externalToolUserStorageSettings').hidden = false;
      $('externalToolUserStorageEnabled').checked = storagePolicy.enabled;
      $('externalToolUserStorageQuota').value = storagePolicy.quota_bytes / 1048576;
      $('externalToolUserStorageUsage').textContent = `${email || 'Administrator'}: ${(storagePolicy.used_bytes / 1048576).toFixed(2)} MiB used`;
    } catch (error) { if (started === key() && request === storageRequest) status(error.message); }
  });
  $('externalToolUserStorageSave').onclick = async () => {
    if (!storagePolicy || storageAuth !== key()) return;
    const started = key(), request = ++storageRequest;
    try {
      const result = await api('/api/admin/tools/storage?email=' + encodeURIComponent(storageEmail), { method: 'PUT', body: JSON.stringify({ enabled: $('externalToolUserStorageEnabled').checked, quota_mib: Number($('externalToolUserStorageQuota').value), version: storagePolicy.version }) });
      if (started !== key() || request !== storageRequest) return;
      storagePolicy = result.storage; status('Storage allowance saved. Open tools must be reopened to use it.');
    } catch (error) { if (started === key() && request === storageRequest) status(error.message); }
  };
  $('externalToolsBack').onclick = () => { $('externalToolsModal').style.display = 'none'; $('adminSettingsModal').style.display = 'flex'; };
  window.addEventListener('external-tool-launched', event => { if (event.detail.preview) previews.set(event.detail.toolId, event.detail.instanceId); });
  window.addEventListener('eagle-context-updated', () => { if (auth !== key()) { catalog = null; previews.clear(); $('externalToolsCatalog').replaceChildren(); edit(); $('externalToolsModal').style.display = 'none'; } });
  window.ExternalToolsAdmin = { show: async () => { $('adminSettingsModal').style.display = 'none'; $('externalToolsModal').style.display = 'flex'; status('Loading…'); try { await load(); edit(); section(catalog.allowed_networks.length ? 'apps' : 'network'); permissionSummary(); status(catalog.enabled ? 'Gateway on. Teachers can open enabled apps. Students also need a class grant.' : 'Gateway off. Private admin previews are available after a connection test.'); } catch (error) { status(error.message); } } };
})();
