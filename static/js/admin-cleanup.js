/* Administrator-only retention controls; no credentials or history in browser storage. */
(function () {
  'use strict';
  let owner = '', generation = 0, data = null, dirty = false, pending = false, timer = null, cursor = 0;
  let requestSequence = 0, editRevision = null;
  const el = id => document.getElementById(id);
  const token = () => window.EagleIDE?.getContext?.().ADMIN_TOKEN || '';
  const visible = () => el('cleanupPane')?.classList.contains('active') && el('adminSettingsModal')?.style.display !== 'none';
  const current = (who, epoch) => !!who && who === owner && who === token() && epoch === generation;
  const text = (tag, content, className) => {
    const node = document.createElement(tag); node.textContent = content;
    if (className) node.className = className;
    return node;
  };
  function pause() { if (timer) clearTimeout(timer); timer = null; }
  function onAuthChanged() {
    if (owner === token()) return;
    pause(); owner = token(); generation++; requestSequence++; data = null; dirty = false; pending = false; cursor = 0; editRevision = null;
    el('cleanupRules')?.replaceChildren(); el('cleanupLog')?.replaceChildren(); el('cleanupRuns')?.replaceChildren();
    if (el('cleanupEnabled')) el('cleanupEnabled').checked = false;
    el('cleanupStatus').textContent = '';
    controls();
  }
  function controls() {
    const enabled = !!data && el('cleanupEnabled').checked;
    const any = !!data && [...el('cleanupRules').querySelectorAll('[data-cleanup-toggle]')].some(button => button.getAttribute('aria-pressed') === 'true');
    el('cleanupRunNow').disabled = !enabled || !any || dirty || pending || !!data?.active_run;
    el('cleanupOlder').disabled = pending || !data?.next_before;
    el('cleanupEnabled').disabled = pending || !data;
    el('cleanupRules').querySelectorAll('input, button').forEach(input => { input.disabled = pending; });
    el('cleanupRefresh').disabled = pending;
    el('cleanupNewest').disabled = pending;
    if (visible()) el('settingsSaveBtn').disabled = pending || !data || !dirty;
  }
  function changed() {
    if (!dirty) editRevision = data.revision;
    dirty = true; controls();
    el('cleanupStatus').textContent = 'Unsaved cleanup rules. Save them before cleaning.';
  }
  async function api(path, options = {}) {
    const who = owner, epoch = generation;
    if (!current(who, epoch)) throw new Error('Administrator sign-in required.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(path, {...options, signal: controller.signal,
        headers: {'Content-Type': 'application/json', 'X-Admin-Token': who}});
      const result = await response.json();
      if (!current(who, epoch)) { const error = new Error('Stale cleanup response'); error.stale = true; throw error; }
      if (!response.ok || !result.ok) throw new Error(result.error || 'Cleanup request failed.');
      return result;
    } finally { clearTimeout(timeout); }
  }
  function renderRules() {
    el('cleanupEnabled').checked = data.policy.enabled;
    el('cleanupRules').replaceChildren();
    for (const type of data.types) {
      const rule = data.policy.rules[type.id];
      const row = text('div', '', 'cleanup-rule');
      const description = text('div', '', 'cleanup-rule-description');
      description.append(text('strong', type.label), text('p', type.description));
      const toggle = text('button', rule.enabled ? 'Enabled' : 'Disabled', 'btn secondary cleanup-toggle');
      toggle.type = 'button'; toggle.dataset.cleanupToggle = type.id;
      toggle.setAttribute('aria-pressed', String(rule.enabled)); toggle.setAttribute('aria-label', type.label + ' cleanup');
      toggle.addEventListener('click', () => {
        const enabled = toggle.getAttribute('aria-pressed') !== 'true';
        toggle.setAttribute('aria-pressed', String(enabled)); toggle.textContent = enabled ? 'Enabled' : 'Disabled'; changed();
      });
      const label = text('label', 'Retain for (days)');
      const input = document.createElement('input'); input.type = 'number'; input.min = '1'; input.max = '3650'; input.step = '1';
      input.value = String(rule.days); input.dataset.cleanupDays = type.id; input.setAttribute('aria-label', type.label + ' retention days');
      input.addEventListener('input', changed); label.append(input);
      row.append(description, toggle, label); el('cleanupRules').append(row);
    }
  }
  function renderHistory() {
    el('cleanupRuns').replaceChildren();
    for (const run of data.runs) {
      el('cleanupRuns').append(text('p', `${new Date(run.started * 1000).toLocaleString()} · ${run.trigger} · ${run.status} · ${run.deleted} completed operations · ${run.failed} failed · ${(run.bytes / 1048576).toFixed(1)} MiB removed${run.message ? ' · ' + run.message : ''}`));
    }
    if (!data.runs.length) el('cleanupRuns').append(text('p', 'No cleanup runs yet.'));
    el('cleanupLog').replaceChildren();
    for (const entry of data.entries) {
      const row = document.createElement('tr');
      const name = text('td', ''); name.append(text('strong', entry.name), text('code', entry.path));
      const outcome = entry.status + (entry.records ? ` · ${entry.records} records` : '') + (entry.error ? ' · ' + entry.error : '');
      row.append(text('td', new Date(entry.started * 1000).toLocaleString()), text('td', `${entry.kind} / ${entry.action}`), name, text('td', outcome));
      el('cleanupLog').append(row);
    }
    if (!data.entries.length) {
      const row = document.createElement('tr'), cell = text('td', 'No cleanup entries on this page.'); cell.colSpan = 4; row.append(cell); el('cleanupLog').append(row);
    }
  }
  function schedule() {
    pause();
    if (data?.active_run && visible() && owner === token()) timer = setTimeout(() => load(cursor, true), 2000);
  }
  async function load(before = 0, polling = false) {
    onAuthChanged(); if (!owner) return;
    const who = owner, epoch = generation, sequence = ++requestSequence;
    try {
      const result = await api('/api/admin/cleanup?before=' + before);
      if (sequence !== requestSequence) return;
      data = result; cursor = before;
      if (!dirty) { renderRules(); editRevision = data.revision; }
      renderHistory(); controls();
      if (!dirty) el('cleanupStatus').textContent = data.active_run ? 'Cleanup is running. You can disable it and save to stop further deletions.' : data.policy.enabled ? 'Saved enabled rules are checked hourly. Clean now applies the same retention ages.' : 'Automatic cleanup is disabled.';
      schedule();
    } catch (error) {
      if (current(who, epoch) && sequence === requestSequence && !error.stale) el('cleanupStatus').textContent = error.name === 'AbortError' ? 'Cleanup request timed out. Refresh to check its status.' : error.message;
    }
  }
  async function save() {
    if (!data || pending || !owner) return;
    const policy = {enabled: el('cleanupEnabled').checked, rules: {}};
    for (const type of data.types) {
      const input = el('cleanupRules').querySelector(`[data-cleanup-days="${type.id}"]`);
      const days = Number(input.value);
      if (!Number.isInteger(days) || days < 1 || days > 3650) { el('cleanupStatus').textContent = 'Retention must be a whole number from 1 to 3650 days.'; input.focus(); return; }
      policy.rules[type.id] = {enabled: el('cleanupRules').querySelector(`[data-cleanup-toggle="${type.id}"]`).getAttribute('aria-pressed') === 'true', days};
    }
    const who = owner, epoch = generation; pending = true; pause(); requestSequence++; controls();
    try {
      const result = await api('/api/admin/cleanup/policy', {method: 'POST', body: JSON.stringify({revision: editRevision, policy})});
      data.revision = result.revision; data.policy = result.policy; editRevision = result.revision; dirty = false;
      el('cleanupStatus').textContent = 'Cleanup rules saved.';
    } catch (error) { if (current(who, epoch) && !error.stale) el('cleanupStatus').textContent = error.message; }
    finally { if (current(who, epoch)) {pending = false; controls(); schedule();} }
  }
  async function runNow() {
    if (el('cleanupRunNow').disabled) return;
    if (!window.confirm('Permanently delete data older than the saved enabled retention limits? Deleted data cannot be restored by EagleIDE.')) return;
    const who = owner, epoch = generation; pending = true; controls();
    try {
      const result = await api('/api/admin/cleanup/run', {method: 'POST', body: '{}'});
      data.active_run = result.run;
      await load(0, true);
    } catch (error) { if (current(who, epoch) && !error.stale) el('cleanupStatus').textContent = error.message; }
    finally { if (current(who, epoch)) {pending = false; controls();} }
  }
  el('cleanupEnabled').addEventListener('change', changed);
  el('cleanupRunNow').addEventListener('click', runNow);
  el('cleanupRefresh').addEventListener('click', () => {
    if (dirty && !window.confirm('Discard unsaved cleanup rules and load the saved settings?')) return;
    dirty = false; load(cursor);
  });
  el('cleanupNewest').addEventListener('click', () => load(0));
  el('cleanupOlder').addEventListener('click', () => { if (data?.next_before) load(data.next_before); });
  window.AdminCleanup = Object.freeze({open: () => load(cursor), save, pause, onAuthChanged});
})();
