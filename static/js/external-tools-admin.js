(function () {
  'use strict';
  const $ = id => document.getElementById(id), api = (...args) => window.ExternalTools.api(...args);
  let catalog, editing = null, auth = '', requestId = 0;
  const previews = new Map();
  const key = () => JSON.stringify(window.ExternalTools.headers());
  function status(message) { $('externalToolsAdminStatus').textContent = message; }
  async function load() {
    const request = ++requestId, started = key();
    const data = await api('/api/admin/tools');
    if (started !== key() || request !== requestId) return;
    catalog = data.catalog; auth = started;
    $('externalToolsEnabled').checked = catalog.enabled;
    $('externalToolsAllowed').value = catalog.allowed_networks.join('\n');
    $('externalToolsDenied').value = catalog.denied_networks.join('\n');
    const host = $('externalToolsCatalog'); host.replaceChildren();
    if (!catalog.tools.length) host.textContent = 'No tools registered. Add a compatible private application below.';
    catalog.tools.forEach(tool => {
      const card = document.createElement('section'); card.className = 'external-tool-card';
      const title = document.createElement('strong'); title.textContent = `${tool.name} — /${tool.slug}/ — ${tool.enabled ? 'Enabled' : 'Disabled'}`;
      const info = document.createElement('p'); info.textContent = `${tool.backend_url} · ${tool.test} · ${tool.compatibility}`;
      const actions = document.createElement('div'); actions.className = 'modal-actions'; card.append(title, info, actions);
      function action(label, handler) { const button = document.createElement('button'); button.type = 'button'; button.className = 'btn secondary'; button.textContent = label; button.onclick = async () => { button.disabled = true; try { if (auth !== key()) throw new Error('Account changed. Reopen External Tools.'); await handler(); } catch (error) { if (auth === key()) status(error.message); } finally { button.disabled = false; } }; actions.append(button); }
      action('Edit', () => edit(tool));
      action('Test connection', async () => { const result = await api(`/api/admin/tools/${tool.id}/test`, { method: 'POST', body: JSON.stringify({ revision: catalog.revision }) }); status(result.tool.test); await load(); });
      action('Private preview', async () => { $('externalToolsModal').style.display = 'none'; $('adminSettingsModal').style.display = 'none'; await window.ExternalTools.open(tool); });
      action(tool.enabled ? 'Disable' : 'Confirm compatibility and enable', async () => {
        if (!tool.enabled && !window.confirm('Have you tested this tool in the private restricted preview, including assets, APIs, imports and downloads? Cookies, persistent browser storage, offline workers, external resources and same-origin privileges are unavailable. Confirm only if its intended classroom workflow works.')) return;
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
  }
  $('externalToolForm').addEventListener('submit', async event => {
    event.preventDefault(); const started = key();
    try {
      if (!catalog || auth !== started) throw new Error('Reload External Tools first.');
      await api('/api/admin/tools', { method: 'POST', body: JSON.stringify({ id: editing, revision: catalog.revision, name: $('externalToolName').value, label: $('externalToolLabel').value, backend_url: $('externalToolBackend').value, slug: $('externalToolSlug').value, forms: $('externalToolForms').checked, methods: $('externalToolHttp').checked ? ['GET','HEAD','POST','PUT','PATCH','DELETE'] : ['GET','HEAD'] }) });
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
  $('externalToolNew').onclick = () => edit();
  $('externalToolsDone').onclick = () => { $('externalToolsModal').style.display = 'none'; };
  window.addEventListener('external-tool-launched', event => { if (event.detail.preview) previews.set(event.detail.toolId, event.detail.instanceId); });
  window.addEventListener('eagle-context-updated', () => { if (auth !== key()) { catalog = null; previews.clear(); $('externalToolsCatalog').replaceChildren(); edit(); $('externalToolsModal').style.display = 'none'; } });
  window.ExternalToolsAdmin = { show: async () => { $('adminSettingsModal').style.display = 'none'; $('externalToolsModal').style.display = 'flex'; status('Loading…'); try { await load(); status('Connection tests do not verify browser compatibility.'); } catch (error) { status(error.message); } } };
})();
