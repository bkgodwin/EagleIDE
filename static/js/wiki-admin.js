(function () {
  'use strict';

  const state = {
    tree: [],
    selectedId: '',
    node: null,
    revisions: [],
    draftDirty: false,
    draftTimer: null,
    previewTimer: null,
    imageInsertRange: { start: 0, end: 0 },
    managerSection: 'content',
    editorView: 'split',
    standards: [],
    pageStandardsQuery: '',
    pageStandardsSelectedOnly: false,
    emojiCategory: 'favorites',
    emojiVisible: 240,
    clipboardImageUpload: false,
  };

  const $ = (id) => document.getElementById(id);
  const reader = () => window.WikiReader;

  function adminHeaders(json = false) {
    return reader().authHeaders(json);
  }

  function progress(message, error = false) {
    const el = $('wikiAdminProgress');
    if (!el) return;
    el.textContent = String(message || '');
    el.style.color = error ? '#ffb4b4' : 'var(--wiki-link)';
  }

  function selectedParentForNew() {
    if (!state.node) return null;
    return state.node.kind === 'folder' ? state.node.id : (state.node.parent_id || null);
  }

  function flatten(nodes, output = [], depth = 0) {
    for (const node of nodes || []) {
      output.push({ ...node, depth });
      flatten(node.children || [], output, depth + 1);
    }
    return output;
  }

  function descendantIds(node, output = new Set()) {
    if (!node) return output;
    output.add(node.id);
    for (const child of node.children || []) descendantIds(child, output);
    return output;
  }

  function findAdminNode(id, nodes = state.tree) {
    for (const node of nodes || []) {
      if (node.id === id) return node;
      const found = findAdminNode(id, node.children || []);
      if (found) return found;
    }
    return null;
  }

  function renderTree() {
    reader()?.renderTree?.($('wikiAdminTree'), state.tree, { admin: true, selectedId: state.selectedId });
  }

  function populateParentSelect() {
    const select = $('wikiAdminParent');
    if (!select) return;
    select.textContent = '';
    const root = document.createElement('option');
    root.value = '';
    root.textContent = 'Wiki root';
    select.appendChild(root);
    const selectedTreeNode = findAdminNode(state.node?.id);
    const forbidden = descendantIds(selectedTreeNode);
    for (const node of flatten(state.tree).filter(item => item.kind === 'folder' && !forbidden.has(item.id))) {
      const option = document.createElement('option');
      option.value = node.id;
      option.textContent = `${'— '.repeat(node.depth)}${node.title}`;
      option.selected = node.id === state.node?.parent_id;
      select.appendChild(option);
    }
    if (!state.node?.parent_id) root.selected = true;
  }

  async function loadTree({ preserveSelection = true } = {}) {
    const payload = await reader().fetchJson('/api/admin/wiki/tree', { headers: adminHeaders() });
    state.tree = payload.tree || [];
    renderTree();
    if (preserveSelection && state.selectedId && flatten(state.tree).some(item => item.id === state.selectedId)) {
      await selectNode(state.selectedId, { skipDraftSave: true });
    } else if (!preserveSelection) {
      clearSelection();
    }
    await reader().loadHome({ quiet: true }).catch(() => {});
  }

  function clearSelection() {
    state.selectedId = '';
    state.node = null;
    state.revisions = [];
    $('wikiAdminEditor').hidden = true;
    $('wikiAdminEmptyState').hidden = false;
  }

  async function selectNode(nodeId, { skipDraftSave = false } = {}) {
    if (!skipDraftSave && state.draftDirty) await autosaveDraft(true);
    try {
      const payload = await reader().fetchJson(`/api/admin/wiki/nodes/${encodeURIComponent(nodeId)}`, { headers: adminHeaders() });
      state.selectedId = nodeId;
      state.node = payload.node;
      state.revisions = payload.revisions || [];
      state.draftDirty = false;
      fillEditor();
      renderTree();
    } catch (error) {
      progress(error.message || 'Could not open wiki item.', true);
    }
  }

  function fillEditor() {
    const node = state.node;
    if (!node) return clearSelection();
    $('wikiAdminEmptyState').hidden = true;
    $('wikiAdminEditor').hidden = false;
    $('wikiAdminTitle').value = node.title || '';
    $('wikiAdminSlug').value = node.slug || '';
    $('wikiAdminDescription').value = node.description || '';
    $('wikiAdminFolderIconWrap').hidden = !['folder', 'page'].includes(node.kind);
    $('wikiAdminFolderIcon').value = ['folder', 'page'].includes(node.kind) ? (node.icon || '') : '';
    $('wikiAdminAliases').value = (node.aliases || []).join(', ');
    $('wikiAdminStatus').value = node.status || 'draft';
    $('wikiAdminAliasesWrap').hidden = node.kind === 'image';
    $('wikiAdminPageStandardsWrap').hidden = node.kind !== 'page';
    $('wikiAdminPageTools').hidden = node.kind !== 'page';
    $('wikiAdminPreviewBtn').hidden = node.kind !== 'page';
    $('wikiAdminProperties').open = node.kind !== 'page';
    if (node.kind === 'page') {
      state.pageStandardsQuery = '';
      state.pageStandardsSelectedOnly = false;
      if ($('wikiAdminPageStandardsSearch')) $('wikiAdminPageStandardsSearch').value = '';
      renderPageStandardOptions();
      $('wikiAdminContent').value = node.draft_markdown || node.markdown || '';
      setEditorView(state.editorView);
      renderRevisions();
    } else {
      $('wikiAdminContent').value = '';
      $('wikiAdminPreview').textContent = '';
      $('wikiAdminRevisions').textContent = '';
    }
    populateParentSelect();
  }

  function renderPreview() {
    if (!state.node || state.node.kind !== 'page') return;
    const previewWrap = $('wikiAdminPreview')?.closest('.wiki-admin-preview-wrap');
    const previousScrollTop = previewWrap?.scrollTop || 0;
    const previousScrollLeft = previewWrap?.scrollLeft || 0;
    const previewNode = { ...state.node, markdown: $('wikiAdminContent').value || '' };
    reader().renderMarkdown($('wikiAdminPreview'), previewNode.markdown, previewNode, { embedded: true });
    if (previewWrap) {
      previewWrap.scrollTop = Math.min(previousScrollTop, previewWrap.scrollHeight);
      previewWrap.scrollLeft = previousScrollLeft;
    }
  }

  function renderRevisions() {
    const target = $('wikiAdminRevisions');
    target.textContent = '';
    if (!state.revisions.length) return;
    const label = document.createElement('strong');
    label.textContent = 'Recent published revisions (latest 3):';
    target.appendChild(label);
    for (const revision of state.revisions.slice(0, 3)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = new Date(revision.created_at).toLocaleString();
      button.title = `Restore ${revision.title}`;
      button.addEventListener('click', async () => {
        if (!window.confirm('Restore this published revision? The current published version will remain in revision history.')) return;
        try {
          await reader().fetchJson(`/api/admin/wiki/nodes/${state.node.id}/revisions/${revision.id}/restore`, {
            method: 'POST', headers: adminHeaders(true), body: '{}',
          });
          progress('Revision restored.');
          await loadTree();
        } catch (error) {
          progress(error.message || 'Could not restore revision.', true);
        }
      });
      target.appendChild(button);
    }
  }

  async function autosaveDraft(immediate = false) {
    clearTimeout(state.draftTimer);
    if (!state.draftDirty || !state.node || state.node.kind !== 'page') return;
    const content = $('wikiAdminContent').value || '';
    try {
      const payload = await reader().fetchJson(`/api/admin/wiki/nodes/${state.node.id}/draft`, {
        method: 'PUT', headers: adminHeaders(true), body: JSON.stringify({ content }),
      });
      state.draftDirty = false;
      const stamp = payload.draft?.updated_at ? new Date(payload.draft.updated_at).toLocaleTimeString() : 'now';
      progress(`Draft autosaved ${stamp}.`);
      if (!immediate) setTimeout(() => { if (!state.draftDirty) progress(''); }, 1600);
    } catch (error) {
      progress(error.message || 'Draft autosave failed.', true);
    }
  }

  function scheduleDraftSave() {
    state.draftDirty = true;
    clearTimeout(state.draftTimer);
    state.draftTimer = setTimeout(() => autosaveDraft(), 1200);
    clearTimeout(state.previewTimer);
    if (state.editorView !== 'editor') state.previewTimer = setTimeout(renderPreview, 500);
  }

  async function saveEditor(event) {
    event?.preventDefault?.();
    if (!state.node) return;
    clearTimeout(state.draftTimer);
    const payload = {
      title: $('wikiAdminTitle').value.trim(),
      slug: $('wikiAdminSlug').value.trim(),
      description: $('wikiAdminDescription').value.trim(),
      status: $('wikiAdminStatus').value,
      aliases: $('wikiAdminAliases').value.split(',').map(item => item.trim()).filter(Boolean),
    };
    if (['folder', 'page'].includes(state.node.kind)) {
      payload.icon = $('wikiAdminFolderIcon').value.trim();
    }
    if (state.node.kind === 'page') {
      payload.content = $('wikiAdminContent').value || '';
      payload.standard_ids = [...$('wikiAdminPageStandards').querySelectorAll('input[type="checkbox"]:checked')].map(input => input.value);
    }
    progress(payload.status === 'published' ? 'Publishing…' : 'Saving…');
    try {
      const result = await reader().fetchJson(`/api/admin/wiki/nodes/${state.node.id}`, {
        method: 'PATCH', headers: adminHeaders(true), body: JSON.stringify(payload),
      });
      state.node = result.node;
      state.selectedId = result.node.id;
      state.draftDirty = false;
      progress(payload.status === 'published' ? 'Published successfully.' : 'Draft saved.');
      await loadTree();
    } catch (error) {
      progress(error.message || 'Could not save changes.', true);
    }
  }

  async function createFolder() {
    const title = window.prompt('Folder name:');
    if (title === null || !title.trim()) return;
    try {
      const payload = await reader().fetchJson('/api/admin/wiki/folders', {
        method: 'POST', headers: adminHeaders(true), body: JSON.stringify({ title, parent_id: selectedParentForNew() }),
      });
      state.selectedId = payload.node.id;
      await loadTree();
      progress('Folder created.');
    } catch (error) {
      progress(error.message || 'Could not create folder.', true);
    }
  }

  async function createPage() {
    const title = window.prompt('Page title:');
    if (title === null || !title.trim()) return;
    try {
      const payload = await reader().fetchJson('/api/admin/wiki/pages', {
        method: 'POST', headers: adminHeaders(true),
        body: JSON.stringify({ title, parent_id: selectedParentForNew(), status: 'draft', content: `# ${title.trim()}\n\n` }),
      });
      state.selectedId = payload.node.id;
      await loadTree();
      progress('Draft page created.');
      $('wikiAdminContent')?.focus();
    } catch (error) {
      progress(error.message || 'Could not create page.', true);
    }
  }

  async function uploadMarkdownFiles(files) {
    const parentId = selectedParentForNew();
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      progress(`Uploading Markdown ${index + 1} of ${files.length}: ${file.name}`);
      const form = new FormData();
      form.append('file', file, file.name);
      if (parentId) form.append('parent_id', parentId);
      try {
        const payload = await reader().fetchJson('/api/admin/wiki/pages/upload', {
          method: 'POST', headers: adminHeaders(), body: form,
        });
        state.selectedId = payload.node.id;
      } catch (error) {
        progress(`${file.name}: ${error.message}`, true);
        return;
      }
    }
    await loadTree();
    progress(`${files.length} Markdown file${files.length === 1 ? '' : 's'} uploaded as drafts.`);
  }

  async function uploadChunkedFile(file, { parentId = null, purpose = 'asset', title = '', fileName = '' } = {}) {
    const uploadName = String(fileName || file.name || 'upload').trim();
    const started = await reader().fetchJson('/api/admin/wiki/uploads/start', {
      method: 'POST', headers: adminHeaders(true),
      body: JSON.stringify({ filename: uploadName, total_size: file.size, parent_id: parentId, purpose, title: title || uploadName.replace(/\.[^.]+$/, '') }),
    });
    const chunkSize = Number(started.chunk_size || 8 * 1024 * 1024);
    let offset = Number(started.offset || 0);
    while (offset < file.size) {
      const chunk = file.slice(offset, Math.min(file.size, offset + chunkSize));
      const response = await fetch(`/api/admin/wiki/uploads/${started.upload_id}/chunk`, {
        method: 'PUT',
        headers: { ...adminHeaders(), 'Content-Type': 'application/octet-stream', 'X-Upload-Offset': String(offset) },
        body: chunk,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || `Upload failed (${response.status})`);
      offset = Number(payload.offset);
      progress(`Uploading ${uploadName}: ${Math.round((offset / file.size) * 100)}%`);
    }
    const completed = await reader().fetchJson(`/api/admin/wiki/uploads/${started.upload_id}/complete`, {
      method: 'POST', headers: adminHeaders(true), body: '{}',
    });
    return completed.result;
  }

  async function uploadAssetFiles(files) {
    const parentId = selectedParentForNew();
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      try {
        const node = await uploadChunkedFile(file, { parentId });
        state.selectedId = node.id;
      } catch (error) {
        progress(`${file.name}: ${error.message}`, true);
        return;
      }
    }
    await loadTree();
    progress(`${files.length} file${files.length === 1 ? '' : 's'} uploaded.`);
  }

  async function uploadMediaImages(files) {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      try {
        progress(`Uploading image ${index + 1} of ${files.length}: ${file.name}`);
        await uploadChunkedFile(file, { parentId: null });
      } catch (error) {
        progress(`${file.name}: ${error.message}`, true);
        return;
      }
    }
    await Promise.all([loadMedia(), loadTree()]);
    progress(`${files.length} image${files.length === 1 ? '' : 's'} uploaded.`);
  }

  async function moveSelected() {
    if (!state.node) return;
    try {
      await reader().fetchJson(`/api/admin/wiki/nodes/${state.node.id}/move`, {
        method: 'POST', headers: adminHeaders(true), body: JSON.stringify({ parent_id: $('wikiAdminParent').value || null }),
      });
      progress('Item moved.');
      await loadTree();
    } catch (error) {
      progress(error.message || 'Could not move item.', true);
    }
  }

  async function reorder(direction) {
    if (!state.node) return;
    try {
      await reader().fetchJson(`/api/admin/wiki/nodes/${state.node.id}/reorder`, {
        method: 'POST', headers: adminHeaders(true), body: JSON.stringify({ direction }),
      });
      await loadTree();
    } catch (error) {
      progress(error.message || 'Could not reorder item.', true);
    }
  }

  async function handleTreeDrop(nodeId, targetId, position) {
    progress(position === 'inside' ? 'Moving item into folder…' : 'Reordering wiki contents…');
    try {
      const result = await reader().fetchJson(`/api/admin/wiki/nodes/${encodeURIComponent(nodeId)}/position`, {
        method: 'POST',
        headers: adminHeaders(true),
        body: JSON.stringify({ target_id: targetId, position }),
      });
      state.selectedId = result.node?.id || nodeId;
      await loadTree();
      progress(position === 'inside' ? 'Item moved into folder.' : 'Wiki order updated.');
    } catch (error) {
      progress(error.message || 'Could not move wiki item.', true);
    }
  }

  async function deleteSelected() {
    if (!state.node || !window.confirm(`Delete “${state.node.title}”${state.node.kind === 'folder' ? ' and everything inside it' : ''}? You can recover it by restoring a backup.`)) return;
    try {
      await reader().fetchJson(`/api/admin/wiki/nodes/${state.node.id}`, { method: 'DELETE', headers: adminHeaders() });
      clearSelection();
      await loadTree({ preserveSelection: false });
      progress('Item deleted. It can be recovered from a backup.');
    } catch (error) {
      progress(error.message || 'Could not delete item.', true);
    }
  }

  function applyMarkdownTool(button) {
    const textarea = $('wikiAdminContent');
    if (!textarea || !state.node || state.node.kind !== 'page') return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = textarea.value.slice(start, end);
    let replacement = selected;
    if (button.dataset.mdWrap) replacement = `${button.dataset.mdWrap}${selected || 'text'}${button.dataset.mdWrap}`;
    if (button.dataset.mdPrefix) replacement = `${button.dataset.mdPrefix}${selected || 'text'}`;
    textarea.setRangeText(replacement, start, end, 'end');
    textarea.focus();
    scheduleDraftSave();
  }

  function openImageDialog() {
    if (!state.node || state.node.kind !== 'page') return;
    const textarea = $('wikiAdminContent');
    state.imageInsertRange = {
      start: textarea.selectionStart,
      end: textarea.selectionEnd,
    };
    const fileInput = $('wikiImageInsertFile');
    fileInput.value = '';
    $('wikiImageInsertAlt').value = '';
    $('wikiImageInsertCaption').value = '';
    $('wikiImageInsertAlign').value = 'center';
    $('wikiImageInsertWidth').value = 'original';
    $('wikiImageInsertModal').style.display = 'flex';
    // This runs directly from the toolbar click, so browsers permit the native
    // picker. The dialog remains open if the user cancels and wants to retry.
    fileInput.click();
  }

  function directiveValue(value) {
    return String(value || '').replace(/[|}\r\n]+/g, ' ').trim().slice(0, 300);
  }

  function imageDirective(node, { alt = '', caption = '', align = 'center', width = 'original' } = {}) {
    const placement = ['left', 'right', 'center', 'full'].includes(align) ? align : 'center';
    const scale = width === 'original' ? 'original' : String(Math.max(20, Math.min(100, Number(width) || 70)));
    return `{{image:${node.id}|alt=${directiveValue(alt || node.file_name || node.title)}|caption=${directiveValue(caption)}|align=${placement}|width=${scale}}}`;
  }

  function clipboardImageName(file, index = 0) {
    const supplied = String(file?.name || '').trim();
    if (/\.(?:png|jpe?g|webp|gif)$/i.test(supplied)) return supplied;
    const extensions = {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/webp': '.webp',
      'image/gif': '.gif',
    };
    const extension = extensions[String(file?.type || '').toLowerCase()];
    if (!extension) return '';
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
    return `pasted-image-${stamp}${index ? `-${index + 1}` : ''}${extension}`;
  }

  async function pasteClipboardImages(event) {
    if (!state.node || state.node.kind !== 'page') return;
    const files = Array.from(event.clipboardData?.items || [])
      .filter(item => item.kind === 'file' && String(item.type || '').toLowerCase().startsWith('image/'))
      .map(item => item.getAsFile())
      .filter(Boolean);
    if (!files.length) return;
    event.preventDefault();
    if (state.clipboardImageUpload) {
      progress('Please wait for the current pasted image to finish uploading.', true);
      return;
    }
    const prepared = files.map((file, index) => ({ file, fileName: clipboardImageName(file, index) }));
    if (prepared.some(item => !item.fileName)) {
      progress('Clipboard images must be PNG, JPEG, WebP, or GIF.', true);
      return;
    }
    const textarea = $('wikiAdminContent');
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const uploaded = [];
    state.clipboardImageUpload = true;
    textarea.readOnly = true;
    try {
      const directives = [];
      for (let index = 0; index < prepared.length; index += 1) {
        const { file, fileName } = prepared[index];
        progress(`Uploading pasted image ${index + 1} of ${prepared.length}: ${fileName}`);
        const node = await uploadChunkedFile(file, {
          parentId: null,
          title: fileName,
          fileName,
        });
        uploaded.push(node);
        directives.push(imageDirective(node, {
          alt: fileName,
          align: 'center',
          width: 'original',
        }));
      }
      const insertion = `\n${directives.join('\n\n')}\n`;
      textarea.setRangeText(insertion, start, end, 'end');
      scheduleDraftSave();
      renderPreview();
      await autosaveDraft(true);
      await loadMedia().catch(() => {});
      progress(`${prepared.length} clipboard image${prepared.length === 1 ? '' : 's'} uploaded and inserted at the cursor.`);
    } catch (error) {
      for (const node of uploaded) {
        await reader().fetchJson(`/api/admin/wiki/media/${encodeURIComponent(node.id)}`, {
          method: 'DELETE',
          headers: adminHeaders(),
        }).catch(() => {});
      }
      progress(error.message || 'Could not paste the clipboard image.', true);
    } finally {
      state.clipboardImageUpload = false;
      textarea.readOnly = false;
      textarea.focus();
    }
  }

  async function insertImage() {
    const file = $('wikiImageInsertFile').files?.[0];
    if (!file) { progress('Choose an image to upload.', true); return; }
    try {
      progress(`Uploading ${file.name}…`);
      const node = await uploadChunkedFile(file, { parentId: null, title: file.name });
      const directive = `\n${imageDirective(node, {
        alt: $('wikiImageInsertAlt').value || file.name,
        caption: $('wikiImageInsertCaption').value,
        align: $('wikiImageInsertAlign').value,
        width: $('wikiImageInsertWidth').value,
      })}\n`;
      const textarea = $('wikiAdminContent');
      const start = Math.min(state.imageInsertRange.start, textarea.value.length);
      const end = Math.min(Math.max(start, state.imageInsertRange.end), textarea.value.length);
      textarea.setRangeText(directive, start, end, 'end');
      $('wikiImageInsertModal').style.display = 'none';
      scheduleDraftSave();
      renderPreview();
      await autosaveDraft(true);
      await loadTree();
      progress('Image uploaded and inserted into the draft.');
    } catch (error) {
      progress(error.message || 'Could not insert image.', true);
    }
  }

  async function downloadBackup() {
    progress('Building portable wiki backup…');
    try {
      const result = await reader().fetchJson('/api/admin/wiki/backup-tickets', { method: 'POST', headers: adminHeaders() });
      const link = document.createElement('a');
      link.href = result.download_url;
      link.download = result.file_name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      progress('Backup downloaded. Bookmarks were not included.');
    } catch (error) {
      progress(error.message || 'Could not download backup.', true);
    }
  }

  async function restoreBackup(file) {
    if (!file) return;
    const confirmed = window.confirm('Restore this wiki backup? The server will validate it, create an automatic pre-restore backup, and replace wiki content and settings. Current bookmarks will be preserved but are not read from the archive.');
    if (!confirmed) return;
    try {
      const result = await uploadChunkedFile(file, { purpose: 'restore' });
      progress(`Restore complete. Pre-restore backup: ${result.pre_restore_backup || 'created'}.`);
      state.selectedId = '';
      clearSelection();
      await loadTree({ preserveSelection: false });
    } catch (error) {
      progress(error.message || 'Restore failed. The live wiki was not replaced.', true);
    }
  }

  function analyticsList(title, items, labelKey, countKey) {
    return `<section class="wiki-analytics-panel"><h5>${reader().escapeHtml(title)}</h5><ol class="wiki-analytics-list">${(items || []).slice(0, 8).map(item => `<li><span>${reader().escapeHtml(item[labelKey] || '(empty)')}</span><strong>${Number(item[countKey] || 0).toLocaleString()}</strong></li>`).join('') || '<li><span>No data yet</span></li>'}</ol></section>`;
  }

  async function showAnalytics() {
    const panel = $('wikiAdminAnalytics');
    const target = $('wikiAdminAnalyticsContent');
    target.innerHTML = '<div class="skeleton" style="height:100px"></div>';
    try {
      const payload = await reader().fetchJson('/api/admin/wiki/analytics', { headers: adminHeaders() });
      const data = payload.data || {};
      const totals = data.totals || {};
      const diagnostics = data.diagnostics || {};
      target.innerHTML = `
        <div class="wiki-analytics-cards">
          <div class="wiki-analytics-card"><strong>${Number(totals.page_views || 0).toLocaleString()}</strong><span>Page views</span></div>
          <div class="wiki-analytics-card"><strong>${Number(totals.searches || 0).toLocaleString()}</strong><span>Searches</span></div>
          <div class="wiki-analytics-card"><strong>${Number(totals.published_pages || 0).toLocaleString()}</strong><span>Published pages</span></div>
          <div class="wiki-analytics-card"><strong>${formatBytes(totals.media_bytes || 0)}</strong><span>Media storage</span></div>
        </div>
        <div class="wiki-analytics-grid">
          ${analyticsList('Most viewed pages', data.top_pages, 'title', 'views')}
          ${analyticsList('Completed searches', data.top_searches, 'query', 'searches')}
          ${analyticsList('Completed searches with no results', data.no_result_searches, 'query', 'searches')}
          <section class="wiki-analytics-panel"><h5>Content diagnostics</h5><ul class="wiki-analytics-list">
            <li><span>Missing files</span><strong>${(diagnostics.missing_files || []).length}</strong></li>
            <li><span>Broken media directives</span><strong>${(diagnostics.broken_directives || []).length}</strong></li>
            <li><span>Broken internal links</span><strong>${(diagnostics.broken_links || []).length}</strong></li>
            <li><span>Ambiguous aliases</span><strong>${(diagnostics.alias_conflicts || []).length}</strong></li>
            <li><span>Unpublished items</span><strong>${Number(diagnostics.unpublished_count || 0)}</strong></li>
          </ul></section>
        </div>`;
    } catch (error) {
      target.textContent = error.message || 'Could not load analytics.';
    }
  }

  function setEditorView(view) {
    state.editorView = ['editor', 'preview'].includes(view) ? view : 'split';
    const tools = $('wikiAdminPageTools');
    if (tools) tools.dataset.editorView = state.editorView;
    const buttons = {
      editor: $('wikiAdminEditorOnlyBtn'),
      split: $('wikiAdminSplitViewBtn'),
      preview: $('wikiAdminPreviewOnlyBtn'),
    };
    for (const [name, button] of Object.entries(buttons)) button?.classList.toggle('is-active', name === state.editorView);
    if (state.editorView !== 'editor') renderPreview();
  }

  async function loadMedia() {
    const grid = $('wikiAdminMediaGrid');
    grid.innerHTML = '<div class="skeleton" style="height:150px"></div>';
    try {
      const payload = await reader().fetchJson('/api/admin/wiki/media', { headers: adminHeaders() });
      grid.textContent = '';
      if (!payload.images?.length) {
        grid.innerHTML = '<p class="wiki-admin-empty-message">No images uploaded yet.</p>';
        return;
      }
      for (const image of payload.images) {
        const card = document.createElement('article');
        card.className = 'wiki-media-card';
        card.innerHTML = `
          <img src="${reader().escapeHtml(image.media_url)}" alt="${reader().escapeHtml(image.description || image.title)}" loading="lazy" />
          <div class="wiki-media-card-body"><strong>${reader().escapeHtml(image.title)}</strong><span>${reader().escapeHtml(image.file_name)} · ${formatBytes(image.size_bytes)}</span><span>${Number(image.reference_count || 0)} page reference${Number(image.reference_count || 0) === 1 ? '' : 's'}</span></div>
          <button class="btn btn--danger" type="button">Delete file</button>`;
        card.querySelector('button').addEventListener('click', async () => {
          const references = Number(image.reference_count || 0);
          const warning = references
            ? `Delete “${image.title}” permanently? It is used on ${references} page${references === 1 ? '' : 's'}. Its image directives will also be removed from those pages and drafts.`
            : `Delete “${image.title}” permanently from wiki storage?`;
          if (!window.confirm(warning)) return;
          try {
            const result = await reader().fetchJson(`/api/admin/wiki/media/${image.id}`, { method: 'DELETE', headers: adminHeaders() });
            progress(`Image deleted${result.result?.removed_from_pages ? ` and removed from ${result.result.removed_from_pages} page(s)` : ''}.`);
            await Promise.all([loadMedia(), loadTree()]);
          } catch (error) {
            progress(error.message || 'Could not delete image.', true);
          }
        });
        grid.appendChild(card);
      }
    } catch (error) {
      grid.textContent = error.message || 'Could not load images.';
    }
  }

  function showManagerSection(section) {
    state.managerSection = ['home', 'media', 'analytics'].includes(section) ? section : 'content';
    const panels = {
      content: $('wikiAdminContentPanel'),
      home: $('wikiAdminHomePanel'),
      media: $('wikiAdminMediaPanel'),
      analytics: $('wikiAdminAnalytics'),
    };
    const buttons = {
      content: $('wikiAdminContentTabBtn'),
      home: $('wikiAdminHomeTabBtn'),
      media: $('wikiAdminMediaTabBtn'),
      analytics: $('wikiAdminAnalyticsBtn'),
    };
    for (const [name, panel] of Object.entries(panels)) panel.hidden = name !== state.managerSection;
    for (const [name, button] of Object.entries(buttons)) button.classList.toggle('is-active', name === state.managerSection);
    if (state.managerSection === 'media') loadMedia();
    if (state.managerSection === 'analytics') showAnalytics();
  }

  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
    return `${(value / 1024 ** 3).toFixed(1)} GB`;
  }

  function fillHomeSettings(settings = {}) {
    $('wikiAdminHomeTitle').value = settings.title || 'Learn it. Try it. Build it.';
    $('wikiAdminHomeSubtitle').value = settings.subtitle || 'Browse classroom-ready programming topics, open examples directly in the IDE, and keep important lessons close at hand.';
    $('wikiAdminFooterText').value = settings.footer_text || 'Created by Ben Godwin | Computer Science Department ARCA High School | Youngsville Louisiana | Contact bgodwin@acadianacharter.org';
    state.standards = Array.isArray(settings.standards) ? settings.standards : [];
    const standardsList = $('wikiAdminStandards');
    standardsList.textContent = '';
    for (const standard of state.standards) addStandardRow(standard);
    renderPageStandardOptions();
    const list = $('wikiAdminExternalResources');
    list.textContent = '';
    for (const resource of settings.external_resources || []) addExternalResourceRow(resource);
  }

  function addStandardRow(standard = {}) {
    const row = document.createElement('div');
    row.className = 'wiki-admin-standard-row';
    row.dataset.standardId = standard.id || '';
    row.innerHTML = `
      <label>Standard ID<input data-standard-field="standard_id" maxlength="120" value="${reader().escapeHtml(standard.standard_id || '')}" placeholder="CS.1.2" required /></label>
      <label class="wiki-admin-standard-description">Description<textarea data-standard-field="description" maxlength="4000" rows="2" placeholder="What students should know or be able to do" required>${reader().escapeHtml(standard.description || '')}</textarea></label>
      <button class="btn secondary" type="button" aria-label="Remove curriculum standard">Remove</button>`;
    row.querySelector('button').addEventListener('click', () => row.remove());
    $('wikiAdminStandards').appendChild(row);
  }

  function collectStandards() {
    return [...$('wikiAdminStandards').querySelectorAll('.wiki-admin-standard-row')].map(row => ({
      id: row.dataset.standardId || '',
      standard_id: row.querySelector('[data-standard-field="standard_id"]').value.trim(),
      description: row.querySelector('[data-standard-field="description"]').value.trim(),
    })).filter(item => item.standard_id || item.description);
  }

  function renderPageStandardOptions() {
    const target = $('wikiAdminPageStandards');
    if (!target) return;
    target.textContent = '';
    const selected = new Set(state.node?.standard_ids || []);
    const search = $('wikiAdminPageStandardsSearch');
    if (search) search.disabled = !state.standards.length;
    if (!state.standards.length) {
      const note = document.createElement('span');
      note.className = 'wiki-admin-standards-empty';
      note.textContent = 'Add standards in the Home tab before tagging pages.';
      target.appendChild(note);
      updatePageStandardFilter();
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const standard of state.standards) {
      const label = document.createElement('label');
      label.className = 'wiki-admin-standard-option';
      label.dataset.searchText = `${standard.standard_id || ''} ${standard.description || ''}`.toLocaleLowerCase();
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = standard.id;
      input.checked = selected.has(standard.id);
      input.addEventListener('change', updatePageStandardFilter);
      const text = document.createElement('span');
      text.className = 'wiki-admin-standard-option-text';
      const standardId = document.createElement('strong');
      standardId.textContent = standard.standard_id || 'Standard';
      const description = document.createElement('small');
      description.textContent = standard.description || 'No description provided.';
      text.append(standardId, description);
      label.append(input, text);
      fragment.appendChild(label);
    }
    target.appendChild(fragment);
    updatePageStandardFilter();
  }

  function updatePageStandardFilter() {
    const target = $('wikiAdminPageStandards');
    if (!target) return;
    const search = $('wikiAdminPageStandardsSearch');
    state.pageStandardsQuery = String(search?.value || '').trim().toLocaleLowerCase();
    const options = [...target.querySelectorAll('.wiki-admin-standard-option')];
    let selectedCount = 0;
    let visibleCount = 0;
    for (const option of options) {
      const input = option.querySelector('input[type="checkbox"]');
      const isSelected = !!input?.checked;
      selectedCount += isSelected ? 1 : 0;
      option.classList.toggle('is-selected', isSelected);
      const queryMatches = !state.pageStandardsQuery
        || String(option.dataset.searchText || '').includes(state.pageStandardsQuery);
      const visible = queryMatches && (!state.pageStandardsSelectedOnly || isSelected);
      option.hidden = !visible;
      visibleCount += visible ? 1 : 0;
    }
    const summary = $('wikiAdminPageStandardsSummary');
    if (summary) {
      summary.textContent = options.length
        ? `${selectedCount} selected · showing ${visibleCount} of ${options.length} standards`
        : '';
    }
    const selectedButton = $('wikiAdminPageStandardsSelectedBtn');
    if (selectedButton) {
      selectedButton.disabled = !options.length;
      selectedButton.classList.toggle('is-active', state.pageStandardsSelectedOnly);
      selectedButton.setAttribute('aria-pressed', String(state.pageStandardsSelectedOnly));
    }
    const clearButton = $('wikiAdminPageStandardsClearBtn');
    if (clearButton) clearButton.disabled = selectedCount === 0;
    const noMatches = $('wikiAdminPageStandardsNoMatches');
    if (noMatches) noMatches.hidden = !options.length || visibleCount !== 0;
  }

  function addExternalResourceRow(resource = {}) {
    const row = document.createElement('div');
    row.className = 'wiki-admin-resource-row';
    row.innerHTML = `
      <label>Title<input data-resource-field="title" maxlength="200" value="${reader().escapeHtml(resource.title || '')}" placeholder="Resource title" /></label>
      <label>Website URL<input data-resource-field="url" type="url" maxlength="2048" value="${reader().escapeHtml(resource.url || '')}" placeholder="https://example.org" /></label>
      <label class="wiki-admin-resource-description">Description<input data-resource-field="description" maxlength="1000" value="${reader().escapeHtml(resource.description || '')}" placeholder="What students will find here" /></label>
      <button class="btn secondary" type="button" aria-label="Remove external resource">Remove</button>`;
    row.querySelector('button').addEventListener('click', () => row.remove());
    $('wikiAdminExternalResources').appendChild(row);
  }

  function collectExternalResources() {
    return [...$('wikiAdminExternalResources').querySelectorAll('.wiki-admin-resource-row')].map(row => ({
      title: row.querySelector('[data-resource-field="title"]').value.trim(),
      url: row.querySelector('[data-resource-field="url"]').value.trim(),
      description: row.querySelector('[data-resource-field="description"]').value.trim(),
    })).filter(item => item.title || item.url || item.description);
  }

  async function loadHomeSettings() {
    const payload = await reader().fetchJson('/api/admin/wiki/settings', { headers: adminHeaders() });
    fillHomeSettings(payload.home_settings || {});
  }

  async function saveHomeSettings() {
    progress('Saving wiki home content…');
    try {
      const payload = await reader().fetchJson('/api/admin/wiki/settings', {
        method: 'PATCH',
        headers: adminHeaders(true),
        body: JSON.stringify({
          title: $('wikiAdminHomeTitle').value,
          subtitle: $('wikiAdminHomeSubtitle').value,
          footer_text: $('wikiAdminFooterText').value,
          standards: collectStandards(),
          external_resources: collectExternalResources(),
        }),
      });
      fillHomeSettings(payload.home_settings || {});
      await reader().loadHome({ quiet: true });
      progress('Wiki home content saved.');
    } catch (error) {
      progress(error.message || 'Could not save wiki home content.', true);
    }
  }

  async function importStandardsCsv(file) {
    if (!file) return;
    progress(`Importing standards from ${file.name}…`);
    const form = new FormData();
    form.append('file', file, file.name);
    try {
      const payload = await reader().fetchJson('/api/admin/wiki/standards/import', {
        method: 'POST',
        headers: adminHeaders(),
        body: form,
      });
      fillHomeSettings(payload.home_settings || {});
      await reader().loadHome({ quiet: true });
      progress(`${Number(payload.imported_count || 0)} standard row${Number(payload.imported_count || 0) === 1 ? '' : 's'} imported.`);
    } catch (error) {
      progress(error.message || 'Could not import standards CSV.', true);
    }
  }

  const FAVORITE_FOLDER_EMOJIS = [
    '📁','📂','📚','📖','📝','📌','📎','🗂️','🗃️','💻','🖥️','🖧','🗄️','⌨️','🧠','🎓','🏫','👩‍🏫','👨‍🏫',
    '🐍','🟨','⚡','📜','🌐','🎨','🧩','🔧','🛠️','⚙️','💾','📡','🔌','☁️','🔬','🧪','📊','📈','✅','⭐','💡','🚀','🎯','🏆','🔒',
    '🔑','📅','🕹️','🤖','🌱','🌎','🧮','➕','♻️','❤️','🧡','💙','💜','🟥','🟦','🟩','🟨',
  ];
  const TECHNOLOGY_EMOJIS = [
    '💻','🖥️','🖧','🗄️','💾','💿','⌨️','🖱️','🖨️','📡','🔌','🔋','⚙️','🔧','🛠️','🧰',
    '📦','🗃️','🗂️','☁️','🌐','🔒','🔐','🔑','🛡️','🚨','📊','📈','🤖','🧑‍💻','👨‍💻','👩‍💻',
    '🐍','🟨','⚡','📜','🧩','🌍','🔗','📱','📶','🛰️','🏢','🏫','🧪','🧠','✅','❌',
  ];

  function emojiPresentationRegex() {
    try { return new RegExp('\\p{Emoji_Presentation}', 'u'); } catch { return null; }
  }

  function emojiRange(start, end) {
    const matcher = emojiPresentationRegex();
    const items = [];
    for (let point = start; point <= end; point += 1) {
      const value = String.fromCodePoint(point);
      if (matcher ? matcher.test(value) : point >= 0x1f300) items.push(value);
    }
    return items;
  }

  function flagEmojis() {
    const items = [];
    let displayNames = null;
    try { displayNames = new Intl.DisplayNames(['en'], { type: 'region' }); } catch {}
    for (let first = 65; first <= 90; first += 1) {
      for (let second = 65; second <= 90; second += 1) {
        const code = String.fromCharCode(first, second);
        if (displayNames) {
          const name = displayNames.of(code);
          if (!name || name === code || /unknown region/i.test(name)) continue;
        }
        items.push(String.fromCodePoint(0x1f1e6 + first - 65, 0x1f1e6 + second - 65));
      }
    }
    return items;
  }

  function emojisForCategory(category) {
    let items = [];
    if (category === 'favorites') items = FAVORITE_FOLDER_EMOJIS;
    else if (category === 'technology') items = TECHNOLOGY_EMOJIS;
    else if (category === 'faces') items = [...emojiRange(0x1f600, 0x1f64f), ...emojiRange(0x1f900, 0x1f9ff), ...emojiRange(0x1fa70, 0x1faff)];
    else if (category === 'objects') items = emojiRange(0x1f300, 0x1f5ff);
    else if (category === 'travel') items = emojiRange(0x1f680, 0x1f6ff);
    else if (category === 'symbols') items = [...emojiRange(0x2300, 0x2bff), ...emojiRange(0x1f700, 0x1f8ff)];
    else if (category === 'flags') items = flagEmojis();
    return [...new Set(items)];
  }

  function renderEmojiPicker() {
    const grid = $('wikiEmojiGrid');
    if (!grid) return;
    const items = emojisForCategory(state.emojiCategory);
    grid.textContent = '';
    for (const emoji of items.slice(0, state.emojiVisible)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'wiki-emoji-choice';
      button.setAttribute('role', 'option');
      button.textContent = emoji;
      button.title = `Use ${emoji}`;
      button.addEventListener('click', () => {
        $('wikiAdminFolderIcon').value = emoji;
        $('wikiEmojiPickerModal').style.display = 'none';
      });
      grid.appendChild(button);
    }
    $('wikiEmojiMoreBtn').hidden = state.emojiVisible >= items.length;
  }

  function openEmojiPicker() {
    if (!['folder', 'page'].includes(state.node?.kind)) return;
    state.emojiCategory = $('wikiEmojiPickerCategory')?.value || 'favorites';
    state.emojiVisible = 240;
    $('wikiEmojiPickerModal').style.display = 'flex';
    renderEmojiPicker();
  }

  async function openManager() {
    if (!reader().context().ADMIN_TOKEN) return;
    $('wikiManagerModal').style.display = 'flex';
    showManagerSection('content');
    progress('Loading wiki content…');
    try {
      await loadTree();
      await loadHomeSettings();
      progress('');
    } catch (error) {
      const message = error.status === 404
        ? 'Wiki routes are unavailable. Restart the EagleIDE server, then reopen Wiki Manager.'
        : (error.message || 'Could not load Wiki Manager.');
      progress(message, true);
    }
  }

  async function closeManager() {
    if (state.draftDirty) await autosaveDraft(true);
    $('wikiManagerModal').style.display = 'none';
    $('wikiAdminAnalytics').hidden = true;
  }

  function attachEvents() {
    $('adminWikiBtn')?.addEventListener('click', openManager);
    $('wikiAdminCloseBtn')?.addEventListener('click', closeManager);
    $('wikiAdminHomeSaveBtn')?.addEventListener('click', saveHomeSettings);
    $('wikiAdminAddStandardBtn')?.addEventListener('click', () => addStandardRow());
    $('wikiAdminStandardsCsvInput')?.addEventListener('change', event => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (file) importStandardsCsv(file);
    });
    $('wikiAdminAddResourceBtn')?.addEventListener('click', () => addExternalResourceRow());
    $('wikiAdminNewFolderBtn')?.addEventListener('click', createFolder);
    $('wikiAdminNewPageBtn')?.addEventListener('click', createPage);
    $('wikiAdminContentTabBtn')?.addEventListener('click', () => showManagerSection('content'));
    $('wikiAdminHomeTabBtn')?.addEventListener('click', () => showManagerSection('home'));
    $('wikiAdminMediaTabBtn')?.addEventListener('click', () => showManagerSection('media'));
    $('wikiAdminMarkdownInput')?.addEventListener('change', event => {
      const files = [...(event.target.files || [])];
      event.target.value = '';
      if (files.length) uploadMarkdownFiles(files);
    });
    $('wikiAdminAssetInput')?.addEventListener('change', event => {
      const files = [...(event.target.files || [])];
      event.target.value = '';
      if (files.length) uploadAssetFiles(files);
    });
    $('wikiAdminMediaInput')?.addEventListener('change', event => {
      const files = [...(event.target.files || [])];
      event.target.value = '';
      if (files.length) uploadMediaImages(files);
    });
    $('wikiAdminEditor')?.addEventListener('submit', saveEditor);
    $('wikiAdminContent')?.addEventListener('input', scheduleDraftSave);
    $('wikiAdminContent')?.addEventListener('paste', pasteClipboardImages);
    $('wikiAdminPageStandardsSearch')?.addEventListener('input', updatePageStandardFilter);
    $('wikiAdminPageStandardsSelectedBtn')?.addEventListener('click', () => {
      state.pageStandardsSelectedOnly = !state.pageStandardsSelectedOnly;
      updatePageStandardFilter();
    });
    $('wikiAdminPageStandardsClearBtn')?.addEventListener('click', () => {
      $('wikiAdminPageStandards')?.querySelectorAll('input[type="checkbox"]:checked')
        .forEach(input => { input.checked = false; });
      updatePageStandardFilter();
    });
    $('wikiAdminPreviewBtn')?.addEventListener('click', renderPreview);
    $('wikiAdminMoveUpBtn')?.addEventListener('click', () => reorder('up'));
    $('wikiAdminMoveDownBtn')?.addEventListener('click', () => reorder('down'));
    $('wikiAdminApplyMoveBtn')?.addEventListener('click', moveSelected);
    $('wikiAdminDeleteBtn')?.addEventListener('click', deleteSelected);
    $('wikiAdminFolderIconPickerBtn')?.addEventListener('click', openEmojiPicker);
    $('wikiEmojiPickerCloseBtn')?.addEventListener('click', () => { $('wikiEmojiPickerModal').style.display = 'none'; });
    $('wikiEmojiClearBtn')?.addEventListener('click', () => {
      $('wikiAdminFolderIcon').value = '';
      $('wikiEmojiPickerModal').style.display = 'none';
    });
    $('wikiEmojiPickerCategory')?.addEventListener('change', event => {
      state.emojiCategory = event.target.value;
      state.emojiVisible = 240;
      renderEmojiPicker();
    });
    $('wikiEmojiMoreBtn')?.addEventListener('click', () => {
      state.emojiVisible += 240;
      renderEmojiPicker();
    });
    $('wikiEmojiPickerModal')?.addEventListener('click', event => {
      if (event.target.id === 'wikiEmojiPickerModal') event.currentTarget.style.display = 'none';
    });
    document.querySelectorAll('.wiki-markdown-toolbar button[data-md-wrap],.wiki-markdown-toolbar button[data-md-prefix]').forEach(button => button.addEventListener('click', () => applyMarkdownTool(button)));
    $('wikiAdminInsertImageBtn')?.addEventListener('click', openImageDialog);
    $('wikiAdminEditorOnlyBtn')?.addEventListener('click', () => setEditorView('editor'));
    $('wikiAdminSplitViewBtn')?.addEventListener('click', () => setEditorView('split'));
    $('wikiAdminPreviewOnlyBtn')?.addEventListener('click', () => setEditorView('preview'));
    $('wikiImageInsertFile')?.addEventListener('change', event => {
      const file = event.target.files?.[0];
      if (file && !$('wikiImageInsertAlt').value.trim()) $('wikiImageInsertAlt').value = file.name;
    });
    $('wikiImageInsertCancelBtn')?.addEventListener('click', () => { $('wikiImageInsertModal').style.display = 'none'; });
    $('wikiImageInsertConfirmBtn')?.addEventListener('click', insertImage);
    $('wikiAdminBackupBtn')?.addEventListener('click', downloadBackup);
    $('wikiAdminRestoreInput')?.addEventListener('change', event => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (file) restoreBackup(file);
    });
    $('wikiAdminAnalyticsBtn')?.addEventListener('click', () => showManagerSection('analytics'));
    window.addEventListener('keydown', event => {
      if (event.key === 'Escape' && $('wikiManagerModal')?.style.display === 'flex' && $('wikiImageInsertModal')?.style.display !== 'flex') closeManager();
    });
  }

  window.WikiAdmin = { handleTreeDrop, openManager, renderTree, selectNode };
  attachEvents();
})();
