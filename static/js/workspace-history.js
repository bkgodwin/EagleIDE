/* Changed editor samples, bounded offline retry, and asynchronous upload. */
(() => {
  'use strict';
  const FILE_LIMIT = 256 * 1024, JOURNAL_LIMIT = 2 * 1024 * 1024, BATCH_LIMIT = 375 * 1024;
  const states = new Map();
  const encoder = new TextEncoder();
  const bytes = text => encoder.encode(text).length;
  let bridge, account = '', active, database, busy = false, dirty = false, journalRestored = false;
  let retryAt = 0, failures = 0, journalTimer;
  const cloneRanges = file => (file?.pasteRanges || []).map(range => [...range]);
  const id = () => globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  const byteLength = object => bytes(JSON.stringify(object));
  const sameRanges = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const authKey = () => JSON.stringify(bridge.headers());

  function notice(text) {
    const node = document.getElementById('workspaceHistoryStatus');
    if (node && node.textContent !== text) node.textContent = node.title = text;
  }

  function storage() {
    if (!database) database = new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('IndexedDB unavailable'));
      const opening = indexedDB.open('eagleide-workspace-history', 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore('retry');
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = opening.onblocked = () => reject(new Error('History journal unavailable'));
    });
    return database;
  }

  function queued() {
    return [...states.values()].filter(s => s.frames.length).map(s => ({
      fileId:s.fileId, path:s.path, version:s.version, head:s.head, headRanges:s.headRanges, last:s.last, lastRanges:s.lastRanges,
      frames:s.frames, reset:s.reset, batch:s.batch,
    }));
  }

  async function persist() {
    const owner = account, entries = queued();
    if (!owner || !journalRestored) return;
    try {
      const db = await storage();
      if (owner !== account) return;
      const store = db.transaction('retry', 'readwrite').objectStore('retry');
      const record = {owner, entries, updated:Date.now()};
      if (byteLength(record) > JOURNAL_LIMIT) throw new Error('History journal is full');
      const operation = store.put(record, 'journal');
      operation.onerror = () => notice('Edit history backup unavailable on this device.');
    } catch {
      if (entries.length && owner === account) notice('Edit history backup unavailable on this device.');
    }
  }

  function persistSoon() {
    if (!journalTimer) journalTimer = setTimeout(() => { journalTimer = null; persist(); }, 400);
  }

  async function restore(owner) {
    try {
      const db = await storage();
      if (owner !== account) return;
      const saved = await new Promise((resolve, reject) => {
        const get = db.transaction('retry').objectStore('retry').get('journal');
        get.onsuccess = () => resolve(get.result);
        get.onerror = reject;
      });
      if (owner !== account) return;
      if (saved?.owner === owner && Date.now() - saved.updated < 86400000 && Array.isArray(saved.entries)) {
        for (const entry of saved.entries) {
          if (!states.get(entry.fileId)?.frames.length && entry.frames?.length) states.set(entry.fileId, entry);
        }
      }
    } catch {
      // Recording remains available with a bounded in-memory retry buffer.
    } finally {
      if (owner === account) {
        journalRestored = true;
        persistSoon();
        flush();
      }
    }
  }

  function identity() {
    const next = bridge.account() || '';
    if (account === next) return;
    account = next;
    states.clear();
    active = null;
    retryAt = failures = 0;
    journalRestored = false;
    if (next) restore(next);
  }

  function opened() {
    identity();
    active = bridge.file();
    dirty = false;
    const enabled = !!(account && active?.workspaceHistory && !active.readOnly);
    notice(enabled ? 'Edit history on · shared when you turn in this file' : '');
    if (!enabled) return;
    const {id: fileId, version} = active.workspaceHistory;
    if (!states.has(fileId)) {
      const head = bridge.content(), ranges = cloneRanges(active);
      states.set(fileId, {fileId, version, head, headRanges:ranges, last:head, lastRanges:ranges, frames:[], reset:true, batch:null});
    }
    states.get(fileId).path = active.path;
    for (const [key, state] of states) {
      if (key !== fileId && !state.frames.length) states.delete(key);
    }
  }

  function sample() {
    if (!dirty || !account || active !== bridge.file() || !active?.workspaceHistory) return;
    const s = states.get(active.workspaceHistory.id);
    if (!s) return;
    const content = bridge.content(), ranges = cloneRanges(active);
    if (content.length > FILE_LIMIT || bytes(content) > FILE_LIMIT) {
      notice('Detailed history paused for this large file.');
      return;
    }
    if (content === s.last && sameRanges(ranges, s.lastRanges)) { dirty = false; return; }
    const patch = window.AssignmentDevelopment.splice(s.last, content);
    const frame = {...patch, at:Date.now()/1000, pasteRanges:ranges};
    if (states.size > 32 || byteLength(queued()) + byteLength(frame) + 2 * bytes(content) > JOURNAL_LIMIT) {
      notice('Edit history is catching up. Your file can still be saved.');
      return;
    }
    s.frames.push(frame);
    s.last = content;
    s.lastRanges = ranges;
    dirty = false;
    persistSoon();
  }

  function makeBatch(s) {
    const batch = {fileId:s.fileId, version:s.version, batchId:id(), frames:s.frames.slice(0, 15)};
    if (s.reset) Object.assign(batch, {base:s.head, baseRanges:s.headRanges});
    while (batch.frames.length > 1 && byteLength(batch) > BATCH_LIMIT) batch.frames.pop();
    if (byteLength(batch) > BATCH_LIMIT) {
      // A large replacement is represented as a checkpoint and a labelled gap.
      s.head = s.last;
      s.headRanges = s.lastRanges;
      s.reset = true;
      s.frames = [{from:0, delete:0, insert:'', at:Date.now()/1000, pasteRanges:s.lastRanges}];
      return {fileId:s.fileId, version:s.version, batchId:id(), base:s.head, baseRanges:s.headRanges, frames:s.frames};
    }
    return batch;
  }

  async function flush(paths) {
    sample();
    if (!account || busy || Date.now() < retryAt) return;
    const s = [...states.values()].find(state => state.frames.length && (!paths || paths.has(state.path)));
    if (!s) return;
    const owner = account, token = authKey();
    if (!s.batch) { s.batch = makeBatch(s); persistSoon(); }
    busy = true;
    try {
      const response = await bridge.request('/api/workspace-history/record', {
        method:'POST', headers:{'Content-Type':'application/json', ...bridge.headers()}, body:JSON.stringify(s.batch),
      }, 4000);
      const result = await response.json();
      if (owner !== account || token !== authKey()) return;
      if (response.status === 409 && Number.isInteger(result.version)) {
        s.version = result.version;
        s.reset = true;
        s.batch = null;
        retryAt = Date.now() + 500;
      } else if (result.ok) {
        for (const frame of s.batch.frames) {
          s.head = window.AssignmentDevelopment.apply(s.head, frame);
          s.headRanges = frame.pasteRanges;
        }
        s.frames.splice(0, s.batch.frames.length);
        s.version = result.version;
        s.batch = null;
        s.reset = false;
        failures = 0;
        if (!s.frames.length && active?.workspaceHistory?.id !== s.fileId) states.delete(s.fileId);
        if (active?.workspaceHistory?.id) notice('Edit history on · shared when you turn in this file');
      } else if (response.status === 400 || response.status === 413) {
        s.batch = null;
        s.head = s.last;
        s.headRanges = s.lastRanges;
        s.reset = true;
        s.frames = [{from:0, delete:0, insert:'', at:Date.now()/1000, pasteRanges:s.lastRanges}];
        retryAt = Date.now() + 60000;
        notice('Edit history will resume from a checkpoint.');
      } else {
        throw new Error(result.error || 'Edit history awaiting sync.');
      }
    } catch (error) {
      if (owner === account) {
        retryAt = Date.now() + Math.min(60000, 3000 * 2 ** Math.min(5, failures++)) + Math.random() * 1000;
        notice(error.message || 'Edit history awaiting sync.');
      }
    } finally {
      busy = false;
      persistSoon();
    }
  }

  async function flushForSubmission(files) {
    const paths = new Set(files);
    const started = Date.now(), owner = account;
    sample();
    while (owner === account && Date.now() - started < 1200 && retryAt <= Date.now()
        && [...states.values()].some(state => state.frames.length && paths.has(state.path))) {
      let timer;
      try {
        await Promise.race([busy ? Promise.resolve() : flush(paths), new Promise(resolve => {
          timer = setTimeout(resolve, Math.max(0, 1200 - (Date.now() - started)));
        })]);
      } finally { clearTimeout(timer); }
      if (busy && Date.now() - started < 1200) await new Promise(resolve => setTimeout(resolve, 60));
    }
  }

  function configure(value) {
    bridge = value;
    const change = (_editor, edit) => {
      if (active?.workspaceHistory && !['setValue', 'developmentPlayback'].includes(edit?.origin)) dirty = true;
    };
    window.eagleEditor?.on?.('change', change);
    document.getElementById('editor')?.addEventListener('input', change);
    setInterval(sample, 2000);
    const schedule = () => setTimeout(() => { flush(); schedule(); }, 12000 + Math.random() * 6000);
    schedule();
    document.addEventListener('visibilitychange', () => { sample(); persist(); if (!document.hidden) flush(); });
    window.addEventListener('online', () => flush());
    window.addEventListener('eagle-context-updated', identity);
    window.addEventListener('pagehide', () => { sample(); persist(); });
  }

  window.WorkspaceHistory = {configure, opened, sample, flush, flushForSubmission,
    tracking(file) { return !!(account && file?.workspaceHistory && states.has(file.workspaceHistory.id)); },
  };
})();
