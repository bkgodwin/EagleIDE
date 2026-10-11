/* Bounded CSV pages and a lazy JSON tree. No student content is executed. */
(() => {
  'use strict';
  let bridge, page, item, column = 0, cursors = [0], pageIndex = 0, firstRow = 2, rowStarts = [2], navigating = false;
  const edits = new Map();
  let jsonTimer, status = '';
  const el = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const button = (label, action, disabled = false) => `<button type="button" class="btn secondary" data-action="${action}" ${disabled ? 'disabled' : ''}>${label}</button>`;

  function render() {
    const wrap = el('csvEditor');
    const width = Math.min(40, Math.max(1, page.header.length, ...page.rows.map(row => row.cells.length)));
    const cell = (offset, c, value, header = false) => `<${header ? 'th' : 'td'}><textarea rows="1" aria-label="${header ? 'Header' : 'Cell'} column ${column + c + 1}" data-offset="${offset}" data-column="${column + c}" maxlength="32768">${esc(edits.get(`${offset}:${column + c}`)?.value ?? value)}</textarea></${header ? 'th' : 'td'}>`;
    wrap.innerHTML = `<div class="data-viewer-toolbar"><strong>CSV spreadsheet</strong><span>${page.rows.length ? `Rows ${firstRow}–${firstRow + page.rows.length - 1}` : 'No data rows yet'} · ${page.size.toLocaleString()} bytes</span>
      ${button('Save', 'save')}${button('Add row', 'append')}${button('Add column', 'column')}
      ${button('Previous rows', 'previous', pageIndex === 0)}${button('Next rows', 'next', page.nextCursor === null)}
      ${button('Previous columns', 'left', column === 0)}${button('Next columns', 'right', column + 40 >= page.columns)}
      <span class="data-save-status" role="status">${esc(status)}</span></div>
      <div class="csv-grid-scroll"><table><thead><tr><th class="csv-row-number">Row</th>${Array.from({length: width}, (_, c) => cell(page.headerOffset, c, page.header[c] ?? '', true)).join('')}</tr></thead>
      <tbody>${page.rows.map((row, r) => `<tr><th class="csv-row-number">${firstRow + r}</th>${Array.from({length:width}, (_, c) => cell(row.offset, c, row.cells[c] ?? '')).join('')}</tr>`).join('')}</tbody></table></div>`;
    wrap.oninput = event => {
      const input = event.target.closest('textarea[data-offset]');
      if (!input) return;
      const change = {offset: Number(input.dataset.offset), column: Number(input.dataset.column), value: input.value};
      edits.set(`${change.offset}:${change.column}`, change);
      bridge.dirty();
      status = 'Unsaved changes';
      wrap.querySelector('.data-save-status').textContent = status;
    };
    wrap.onclick = async event => {
      const btn = event.target.closest('[data-action]');
      if (!btn || btn.disabled || navigating) return;
      navigating = true;
      let previousIndex = pageIndex, previousColumn = column, previousRow = firstRow;
      let previousCursors, previousStarts;
      wrap.querySelectorAll('[data-action]').forEach(button => button.disabled = true);
      wrap.querySelectorAll('textarea[data-offset]').forEach(input => input.disabled = true);
      try {
        const action = btn.dataset.action;
        if (!await bridge.save()) throw new Error('Changes could not be saved. Check your connection.');
        previousIndex = pageIndex; previousCursors = [...cursors]; previousStarts = [...rowStarts];
        if (action === 'save') return;
        if (edits.size) throw new Error('Save your new changes before switching pages.');
        if (action === 'append') {
          const result = await requestEdit({appendRow:true});
          page.version = result.version;
          cursors = [0, result.appendOffset]; pageIndex = 1;
          firstRow = result.appendRowNumber; rowStarts = [2, firstRow];
          await load(result.appendOffset);
        } else if (action === 'column') {
          const c = page.columns;
          edits.set(`${page.headerOffset}:${c}`, {offset:page.headerOffset, column:c, value:'New column'});
          bridge.dirty();
          if (!await bridge.save()) throw new Error('Could not add column');
          column = Math.floor(c / 40) * 40;
          await load(cursors[pageIndex]);
        } else {
          if (action === 'next') { firstRow += page.rows.length; cursors[++pageIndex] = page.nextCursor; rowStarts[pageIndex] = firstRow; }
          if (action === 'previous') { pageIndex--; firstRow = rowStarts[pageIndex]; }
          if (action === 'left') column = Math.max(0, column - 40);
          if (action === 'right') column += 40;
          await load(cursors[pageIndex]);
        }
      } catch (error) {
        pageIndex = previousIndex; column = previousColumn; firstRow = previousRow;
        if (previousCursors) { cursors = previousCursors; rowStarts = previousStarts; }
        status = error.message;
        render();
      } finally { navigating = false; if (wrap.contains(btn)) render(); }
    };
  }
  async function load(cursor) {
    const active = item;
    const signature = window.WorkspaceData.signature();
    const response = await bridge.request(`/api/files/csv-page?path=${encodeURIComponent(item.path)}&cursor=${cursor || 0}&column=${column}&version=${encodeURIComponent(page.version)}`, {headers:bridge.headers()});
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || 'Could not load CSV');
    if (active !== item) return;
    if (signature !== window.WorkspaceData.signature()) throw new Error('Save your new changes before switching pages.');
    page = result; render();
  }
  async function requestEdit(extra = {}) {
    const response = await bridge.request('/api/files/csv-edit', {method:'POST', headers:{'Content-Type':'application/json', ...bridge.headers()}, body:JSON.stringify({path:item.path, version:page.version, changes:[...edits.values()], offsets:[page.headerOffset, ...page.rows.map(r => r.offset), page.nextCursor].filter(v => v !== null), ...extra})});
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || 'Could not save CSV');
    return result;
  }
  async function saveCsv() {
    if (!edits.size) return true;
    try {
      const snapshot = [...edits.entries()];
      const result = await requestEdit();
      page.version = result.version;
      page.size = result.size;
      const mapped = old => result.offsets?.[old] ?? old;
      // Remap offsets after streaming rewrite; do not discard edits typed during save.
      for (const [key, value] of snapshot) {
        const current = edits.get(key);
        if (current === value) edits.delete(key);
        const cells = value.offset === page.headerOffset ? page.header : page.rows.find(r => r.offset === value.offset)?.cells;
        if (cells) cells[value.column - column] = value.value;
      }
      const pending = [...edits.values()]; edits.clear();
      pending.forEach(change => { change.offset = mapped(change.offset); edits.set(`${change.offset}:${change.column}`, change); });
      page.headerOffset = mapped(page.headerOffset);
      page.rows.forEach(row => { row.offset = mapped(row.offset); });
      page.nextCursor = page.nextCursor === null ? null : mapped(page.nextCursor);
      // Earlier page offsets may change after a header edit. Previous returns to the beginning.
      cursors = pageIndex ? [0, page.rows[0]?.offset || 0] : [0];
      pageIndex = pageIndex ? 1 : 0;
      rowStarts = pageIndex ? [2, firstRow] : [2];
      status = edits.size ? 'Unsaved changes' : 'Saved';
      el('csvEditor').querySelector('.data-save-status').textContent = status;
      return true;
    } catch (error) {
      status = error.message;
      el('csvEditor').querySelector('.data-save-status').textContent = status;
      return false;
    }
  }

  function jsonNode(key, value, depth) {
    const node = document.createElement('div'); node.className = 'json-node';
    if (value && typeof value === 'object') {
      const keys = Object.keys(value);
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = `${key}: ${Array.isArray(value) ? 'Array' : 'Object'} (${keys.length})`;
      details.append(summary); node.append(details);
      details.addEventListener('toggle', () => {
        if (!details.open || details.dataset.loaded) return;
        details.dataset.loaded = 'true';
        if (depth >= 30) { details.append(document.createTextNode('Depth limit. Edit the source to see deeper values.')); return; }
        let start = 0;
        const more = document.createElement('button'); more.type = 'button'; more.className = 'btn secondary';
        more.textContent = 'Show more items';
        const add = () => {
          for (const k of keys.slice(start, start + 100)) details.insertBefore(jsonNode(k, value[k], depth + 1), more);
          start += 100; more.hidden = start >= keys.length;
        };
        more.onclick = add; details.append(more); add();
      });
    } else {
      const text = JSON.stringify(value);
      node.textContent = `${key}: ${text.length > 2000 ? text.slice(0, 2000) + '…' : text}`;
    }
    return node;
  }
  function refreshJson() {
    const tree = el('jsonTree');
    try {
      const source = bridge.editor().getValue();
      if (source.length > 1024 * 1024) {
        el('jsonStatus').textContent = 'Large JSON: source editing available; tree preview limited to 1 MB.';
        tree.replaceChildren(); return;
      }
      const value = JSON.parse(source);
      el('jsonStatus').textContent = 'Valid JSON';
      if (!tree.hidden) tree.replaceChildren(jsonNode('$', value, 0));
    } catch (error) {
      el('jsonStatus').textContent = error.message;
      tree.replaceChildren();
    }
  }
  function jsonMode(active) {
    el('jsonToolbar').hidden = !active; el('jsonTree').hidden = true;
    el('jsonTreeBtn').textContent = 'View tree';
    document.querySelector('#editorPanel .student-editor-wrap')?.classList.remove('json-tree-active');
    clearTimeout(jsonTimer);
    if (active) refreshJson();
  }
  function bindJson() {
    el('jsonFormatBtn').onclick = () => {
      try { bridge.editor().setValue(JSON.stringify(JSON.parse(bridge.editor().getValue()), null, 2) + '\n'); bridge.dirty(); refreshJson(); }
      catch (error) { el('jsonStatus').textContent = error.message; }
    };
    el('jsonTreeBtn').onclick = () => {
      const tree = el('jsonTree'); tree.hidden = !tree.hidden;
      document.querySelector('#editorPanel .student-editor-wrap')?.classList.toggle('json-tree-active', !tree.hidden);
      el('jsonTreeBtn').textContent = tree.hidden ? 'View tree' : 'Edit source'; refreshJson(); bridge.editor().refresh?.();
    };
  }
  window.WorkspaceData = {
    configure(value) { bridge = value; bindJson(); },
    showCsv(result, file) { page = result; item = file; status = ''; edits.clear(); column = result.column || 0; firstRow = result.firstRow || 2; cursors = firstRow > 2 ? [0, result.rows[0]?.offset || 0] : [0]; rowStarts = firstRow > 2 ? [2, firstRow] : [2]; pageIndex = cursors.length - 1; render(); },
    closeCsv() { item = null; edits.clear(); },
    updateFile(file) { item = file; },
    snapshot: () => page ? JSON.parse(JSON.stringify({...page, firstRow})) : null,
    saveCsv, csvDirty: () => edits.size > 0,
    signature: () => JSON.stringify([...edits.values()]),
    jsonMode,
    changed() { if (!el('jsonToolbar').hidden) { clearTimeout(jsonTimer); jsonTimer = setTimeout(refreshJson, 400); } },
  };
})();
