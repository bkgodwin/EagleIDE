/* Executed in the opaque tool frame, before upstream scripts. No EagleIDE tokens. */
'use strict';
// The File System Access methods can exist but always reject in opaque frames.
// Apps such as SolidCraft then never try their ordinary <input type=file> path.
for (const name of ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']) {
  try { Object.defineProperty(window, name, { value: undefined, configurable: false }); } catch {}
}
const initial = config.snapshot;
const values = new Map(Object.entries(initial.entries));
let saved = new Map(values), revision = initial.revision, epoch = initial.epoch;
let running = false, timer, stopped = false, conflict = false, lastError = '';
const encoder = new TextEncoder();
const bytes = value => encoder.encode(value).byteLength;
const size = map => [...map].reduce((sum, [key, value]) => sum + bytes(value), 0);
let profileBytes = size(values), savedBytes = profileBytes, accountBytes = initial.used_bytes || 0;
const dirty = () => values.size !== saved.size || [...values].some(([key, value]) => saved.get(key) !== value);
function report(state, message = '') {
  parent.postMessage({ type: 'eagle-tool-storage', instance: config.instance, state, message, dirty: dirty() }, config.parentOrigin);
}
function quota(message) { report('error', message); throw new DOMException(message, 'QuotaExceededError'); }
if (initial.enabled) {
  const storage = Object.create(Storage.prototype);
  const descriptors = {
    length: { get: () => values.size },
    key: { value: index => [...values.keys()][Number(index) >>> 0] ?? null },
    getItem: { value: key => values.get(String(key)) ?? null },
    setItem: { value: (key, value) => {
      key = String(key); value = String(value);
      if (bytes(key) > 512 || key.includes('\0') || bytes(value) > initial.max_value_bytes) quota('Tool storage entry is too large');
      const next = profileBytes - (values.has(key) ? bytes(values.get(key)) : 0) + bytes(value);
      if ((!values.has(key) && values.size >= initial.max_keys) || next > initial.max_profile_bytes || accountBytes - savedBytes + next > initial.quota_bytes) quota('External tool storage is full. Download work or clear saved data in your EagleIDE account.');
      values.set(key, value); profileBytes = next; changed();
    } },
    removeItem: { value: key => { key = String(key); if (values.has(key)) { profileBytes -= bytes(values.get(key)); values.delete(key); changed(); } } },
    clear: { value: () => { values.clear(); profileBytes = 0; changed(); } }
  };
  Object.values(descriptors).forEach(descriptor => { descriptor.configurable = true; });
  Object.defineProperties(storage, descriptors);
  // Named-property access is part of the Storage API too (including enumeration).
  const proxy = new Proxy(storage, {
    get: (target, key) => typeof key === 'string' && !(key in target) ? values.get(key) : Reflect.get(target, key),
    set: (target, key, value) => { if (typeof key !== 'string' || key in target) return false; target.setItem(key, value); return true; },
    deleteProperty: (target, key) => { target.removeItem(key); return true; },
    ownKeys: target => [...new Set([...Reflect.ownKeys(target), ...values.keys()])],
    getOwnPropertyDescriptor: (target, key) => values.has(key) ? { enumerable: true, configurable: true, writable: true, value: values.get(key) } : Reflect.getOwnPropertyDescriptor(target, key)
  });
  Object.defineProperty(window, 'localStorage', { value: proxy, configurable: false });
}
function changed() {
  clearTimeout(timer);
  report(conflict ? 'conflict' : 'saving', conflict ? lastError : 'Saving tool storage…');
  if (!conflict && !stopped) timer = setTimeout(sync, 800);
}
async function request(action, body, query = '') {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(config.prefix + action + query, {
      method: 'POST', credentials: 'omit', cache: 'no-store', signal: controller.signal,
      headers: { 'Content-Type': body instanceof Uint8Array ? 'application/octet-stream' : 'application/json' },
      body: body instanceof Uint8Array ? body : JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok) { const error = new Error(data.error || `Save failed (${response.status})`); error.status = response.status; throw error; }
    return data;
  } finally { clearTimeout(timeout); }
}
async function sync() {
  clearTimeout(timer);
  if (running || stopped || conflict || !initial.enabled || !dirty()) return;
  running = true;
  const snapshot = new Map(values), changes = [];
  snapshot.forEach((value, key) => { if (saved.get(key) !== value) changes.push({ key, size: bytes(value) }); });
  saved.forEach((value, key) => { if (!snapshot.has(key)) changes.push({ key, size: null }); });
  let upload;
  try {
    report('saving', 'Saving tool storage…');
    upload = (await request('begin', { epoch, revision, changes })).upload_id;
    // Stream across values; avoid concatenating a second full profile in memory.
    let offset = 0, chunk = new Uint8Array(initial.chunk_bytes), used = 0;
    async function send() {
      const body = chunk.slice(0, used);
      // A lost acknowledgement can safely replay the identical chunk.
      try { await request('chunk', body, `?id=${upload}&offset=${offset}`); }
      catch (error) { if (error.status) throw error; await request('chunk', body, `?id=${upload}&offset=${offset}`); }
      offset += used; used = 0;
    }
    for (const item of changes) {
      if (item.size === null) continue;
      const value = encoder.encode(snapshot.get(item.key));
      for (let start = 0; start < value.length;) {
        const count = Math.min(chunk.length - used, value.length - start);
        chunk.set(value.subarray(start, start + count), used); used += count; start += count;
        if (used === chunk.length) await send();
      }
    }
    if (used) await send();
    const result = await request('commit', { upload_id: upload });
    revision = result.revision; epoch = result.epoch; accountBytes = result.used_bytes;
    saved = snapshot; savedBytes = size(saved); lastError = '';
    report(dirty() ? 'saving' : 'saved', dirty() ? 'Saving newer changes…' : 'Tool storage saved to your account');
  } catch (error) {
    lastError = error.message || 'Tool storage could not be saved. Keep this page open and download your work.';
    // An uncertain commit is never blindly replayed over a newer revision.
    if ([403, 409].includes(error.status)) conflict = true;
    if (upload) request('abort', { upload_id: upload }).catch(() => {});
    report(conflict ? 'conflict' : 'error', lastError);
  } finally {
    running = false;
    if (dirty() && !stopped && !conflict) timer = setTimeout(sync, lastError ? 15000 : 800);
  }
}
function backup() {
  const blob = new Blob([JSON.stringify({ format: 'eagleide-tool-storage-v1', tool_id: config.tool, entries: Object.fromEntries(values) })], { type: 'application/json' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = 'external-tool-unsaved-backup.json'; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
const popups = new Set(), open = window.open.bind(window);
window.open = (...args) => { const popup = open(...args); if (popup) popups.add(popup); return popup; };
function dispose() { stopped = true; clearTimeout(timer); popups.forEach(popup => { try { popup.close(); } catch {} }); }
window.addEventListener('message', event => {
  if (event.source !== parent || event.origin !== config.parentOrigin || event.data?.instance !== config.instance) return;
  if (event.data.type === 'eagle-tool-retry') sync();
  if (event.data.type === 'eagle-tool-backup') backup();
  if (event.data.type === 'eagle-tool-invalidated') { conflict = true; lastError = 'Storage was cleared. Download unsaved work and reopen this tool.'; clearTimeout(timer); report('conflict', lastError); }
  if (event.data.type === 'eagle-tool-dispose') dispose();
});
window.addEventListener('pagehide', dispose);
window.addEventListener('beforeunload', event => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('visibilitychange', () => { if (document.hidden) sync(); });
report(initial.enabled ? 'saved' : 'disabled', initial.enabled ? 'Tool storage saved to your account' : 'Cloud storage disabled. Download work using the app’s controls.');
