/* Pure, bounded three-way merging: a stale session must never erase newer notes. */
(() => {
  const clone = value => JSON.parse(JSON.stringify(value));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const escape = value => String(value || '').replace(/[&<>"']/g, ch => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[ch]));
  function merge(base, local, remote) {
    if (!base) base = remote;
    const result = clone(remote);
    const recovered = [];
    const recover = (label, html) => recovered.push({ id: `recovered_${Date.now().toString(36)}_${recovered.length}`,
      label: 'Recovered notes', html: `<h2>${escape(label)}</h2><p>Another session changed this page. Your local copy is preserved here.</p>${html}`,
      locked: false, editLocked: false, color: '#f7d666', bookmarked: true });
    const fields = (before, draft, latest, keys, conflict) => {
      for (const key of keys) {
        if (same(draft?.[key], before?.[key])) continue;
        if (!same(latest?.[key], before?.[key]) && !same(latest?.[key], draft?.[key]) && conflict.includes(key)) return false;
      }
      for (const key of keys) if (!same(draft?.[key], before?.[key])) latest[key] = draft[key];
      return true;
    };
    const baseTabs = new Map((base.tabs || []).map(t => [t.id, t]));
    const localTabs = new Map((local.tabs || []).map(t => [t.id, t]));
    result.tabs = result.tabs.filter(tab => {
      const before = baseTabs.get(tab.id), draft = localTabs.get(tab.id);
      if (!draft) return !before || !same(tab, before) || tab.id === 'assignments';
      if (tab.id === 'assignments') {
        fields(before, draft, tab, ['editLocked'], []);
        const priorBlocks = new Map((before?.blocks || []).map(b => [b.promptId, b]));
        const draftBlocks = new Map((draft.blocks || []).map(b => [b.promptId, b]));
        for (const block of tab.blocks || []) {
          const prior = priorBlocks.get(block.promptId), edit = draftBlocks.get(block.promptId);
          if (!edit) continue;
          if (block.locked && !same(edit.responseHtml, prior?.responseHtml) && !same(edit.responseHtml, block.responseHtml)) {
            recover(edit.title || 'Practice response', edit.responseHtml || '');
          }
          const keys = block.locked ? ['notesMarkdown', 'notesEdited'] : ['responseHtml', 'updatedAt', 'notesMarkdown', 'notesEdited'];
          if (!fields(prior, edit, block, keys, ['responseHtml', 'notesMarkdown'])) {
            recover(edit.title || 'Practice response', `${edit.responseHtml || ''}<pre>${escape(edit.notesMarkdown)}</pre>`);
          }
        }
        // A teacher may remove a prompt while a student is still writing.
        for (const edit of draft.blocks || []) if (!(tab.blocks || []).some(b => b.promptId === edit.promptId)
          && !same(edit.responseHtml, priorBlocks.get(edit.promptId)?.responseHtml)) recover(edit.title, edit.responseHtml || '');
      } else if (!fields(before, draft, tab, ['html', 'label', 'color', 'bookmarked', 'editLocked'], ['html'])) {
        recover(draft.label, draft.html || '');
      }
      return true;
    });
    for (const tab of local.tabs || []) if (!result.tabs.some(t => t.id === tab.id)) {
      if (!baseTabs.has(tab.id)) result.tabs.splice(Math.max(0, result.tabs.length - 1), 0, clone(tab));
      else if (!same(tab, baseTabs.get(tab.id))) recover(tab.label, tab.html || '');
    }
    if (result.tabs.length + recovered.length > 80) throw new Error('Recovery needs another tab. Export your local draft before removing a tab.');
    result.tabs.splice(Math.max(0, result.tabs.length - 1), 0, ...recovered);
    result.activeTabId = recovered[0]?.id || (result.tabs.some(t => t.id === local.activeTabId) ? local.activeTabId : remote.activeTabId);
    return { notebook: result, recovered: recovered.length };
  }
  window.NotebookSync = { merge, clone };
})();
