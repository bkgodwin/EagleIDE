/* Classroom clipboard policy and changed-only, one-second development samples. */
(() => {
  'use strict';
  const BUFFER_LIMIT = 2 * 1024 * 1024;
  let bridge, state = null, dirty = false, policy = null, policyAuth = '', policyPending = null;
  let noticeAt = 0, timer, policyTimer, boundaryTimer;
  const bytes = value => new TextEncoder().encode(value).length;
  // HTTP classroom LANs do not expose randomUUID; this is a retry identity,
  // never an authentication secret.
  const batchId = () => typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  const identity = () => bridge?.student?.();
  const auth = () => JSON.stringify(bridge?.headers?.() || {});
  const apply = (content, frame) => content.slice(0, frame.from) + frame.insert + content.slice(frame.from + frame.delete);
  function splice(before, after) {
    let from = 0, tail = 0;
    while (from < Math.min(before.length, after.length) && before[from] === after[from]) from++;
    // Do not split a surrogate pair at either edge of a replacement.
    if (from && /[\uD800-\uDBFF]/.test(before[from - 1])) from--;
    while (tail < Math.min(before.length, after.length) - from && before[before.length - tail - 1] === after[after.length - tail - 1]) tail++;
    if (tail && /[\uDC00-\uDFFF]/.test(before[before.length - tail])) tail--;
    return {from, delete: before.length - from - tail, insert: after.slice(from, after.length - tail)};
  }
  function status(message, error = false) {
    let node = document.getElementById('developmentRecordingStatus');
    if (!node) {
      node = document.createElement('span'); node.id = 'developmentRecordingStatus'; node.setAttribute('role', 'status');
      document.getElementById('activeFileName')?.parentElement?.append(node);
    }
    node.textContent = message; node.classList.toggle('recording-error', error);
  }
  function persist(s) {
    if(!s) return;
    if (!s?.frames.length && !s?.batch) {try {localStorage.removeItem(s?.key);} catch {} return;}
    try {
      const value = JSON.stringify({version:s.version, base:s.base, frames:s.frames, batch:s.batch, assignmentId:s.assignmentId, path:s.path});
      let total = bytes(value);
      for (let i=0; i<localStorage.length; i++) {const key=localStorage.key(i); if (key?.startsWith('eagleide-development:') && key !== s.key) total += bytes(localStorage.getItem(key) || '');}
      if (total > BUFFER_LIMIT) throw new Error('buffer full');
      localStorage.setItem(s.key, value);
    } catch {
      status('History backup unavailable · keep this page open and reconnect', true);
    }
  }
  function activate() {
    const file = bridge?.file?.(), student = identity();
    if (state?.file === file && state?.auth === auth() && file?.development?.recording) return state;
    if (state) {persist(state); if (state.auth === auth()) upload(state);}
    state = null;
    if (!student || !file?.development?.recording || file.audit || file.submission || file.notebook || file.draft) {status(student && file?.development?.error || '', !!file?.development?.error); return null;}
    const info = file.development;
    const s = {file, auth:auth(), assignmentId:info.assignmentId, path:file.path, version:info.version, resync:false,
      base:info.content || '', last:info.content || '', frames:[], batch:null, pending:null,
      key:`eagleide-development:${encodeURIComponent(student.email)}:${info.assignmentId}`};
    try {
      const saved = JSON.parse(localStorage.getItem(s.key) || 'null');
      if (saved?.path === s.path && saved.assignmentId === s.assignmentId && Array.isArray(saved.frames) && typeof saved.base === 'string' && Number.isInteger(saved.version)) {
        Object.assign(s, {base:saved.base, version:saved.version, frames:saved.frames, batch:saved.batch});
        s.last = s.frames.reduce(apply, s.base);
      }
    } catch {status('History backup could not be restored. Tell your teacher.', true);}
    state = s; dirty = true;
    status('Development history recording');
    return s;
  }
  function sample() {
    const s = activate();
    if (!s || !dirty || s.auth !== auth()) return;
    const content = bridge.content(); dirty = false;
    if (content === s.last) return;
    const frame = {...splice(s.last, content), at:new Date().toISOString(), ...(s.resync ? {resync:true} : {})};
    if (bytes(JSON.stringify(s.frames)) + bytes(JSON.stringify(frame)) > BUFFER_LIMIT) {
      dirty = true; status('History buffer full · reconnect before continuing', true); return;
    }
    s.frames.push(frame); s.last = content; s.resync=false;
    if(!s.error) status(`Development history · ${s.frames.length} change(s) awaiting sync`);
  }
  async function upload(s = state, keepalive = false) {
    if (!s || s.auth !== auth() || !identity()) return false;
    if (s.pending) return s.pending;
    if (!s.frames.length) return true;
    s.pending = Promise.resolve().then(async () => {
      try {
        if (!s.batch) {
          let count = Math.min(30, s.frames.length);
          const make = () => ({assignmentId:s.assignmentId, version:s.version, batchId:batchId(), frames:s.frames.slice(0,count)});
          let batch = make();
          while (count > 1 && bytes(JSON.stringify(batch)) > 480 * 1024) {count--; batch = make();}
          if (bytes(JSON.stringify(batch)) > 480 * 1024) throw new Error('Large change will be captured at the next file save.');
          s.batch = batch; persist(s);
        }
        const batch = s.batch;
        const response = await bridge.request('/api/assignments/development/record', {
          method:'POST', headers:{'Content-Type':'application/json', ...bridge.headers()}, body:JSON.stringify(batch),
          ...(keepalive && bytes(JSON.stringify(batch)) < 60000 ? {keepalive:true} : {})
        });
        const result = await response.json();
        if (s.auth !== auth()) return false;
        if (result.stopped) {s.frames=[]; s.batch=null; s.file.development.recording=false; persist(s); if(s===state) status('Development recording complete'); return true;}
        if (response.status === 409 && typeof result.content === 'string') {
          // Rebase the first local sample, preserving subsequent one-second edits.
          const first = apply(s.base, s.frames[0]);
          s.frames[0] = {...s.frames[0], ...splice(result.content, first), resync:true};
          s.base = result.content; s.version = result.version; s.batch = null; persist(s);
          if(s===state) status('History resynchronized after another tab or file save');
          return false;
        }
        if (!response.ok || !result.ok) throw new Error(result.error || 'History sync failed');
        s.base = batch.frames.reduce(apply, s.base);
        s.frames.splice(0, batch.frames.length); s.version = result.version; s.batch = null; persist(s);
        s.error='';
        if(s===state) status(s.frames.length ? 'Development history awaiting sync' : 'Development history recording');
        return true;
      } catch(error) {s.error=error.message || 'History sync failed · retrying'; if(s===state) status(s.error, true); return false;}
      finally {s.pending=null;}
    });
    return s.pending;
  }
  async function flush() {
    sample();
    const s = state;
    if (!s) return true;
    persist(s);
    // Bounded work; remaining samples stay in the device journal for retry.
    for(let tries=0; tries<3 && s.frames.length; tries++) {
      const before = s.frames.length;
      const ok = await upload(s);
      if (!ok && before === s.frames.length && s.batch) return false;
    }
    return !s.frames.length;
  }
  function opened() {
    const s=activate();
    if(s) {s.resync=bridge.content()!==s.last; dirty=s.resync; if(s.resync) sample();}
  }
  function saved(file, content, version) {
    const s=state;
    if(!s || s.file!==file || s.auth!==auth() || !Number.isInteger(version)
        || !(s.error?.startsWith('Large change') || s.error?.startsWith('Recording timestamp'))) return;
    // A large replacement is captured by the ordinary file save instead of
    // repeatedly sending an oversized recording batch. Resume from its receipt.
    s.base=content; s.version=version; s.batch=null;
    s.frames=s.last===content ? [] : [{...splice(content,s.last),at:new Date().toISOString(),resync:true}];
    s.error=''; persist(s); status('Development history recording');
  }
  async function assignmentsChanged(assignments) {
    const file=bridge?.file?.();
    if(!identity() || !file?.development) return;
    const assignment=assignments.find(a=>a.id===file.development.assignmentId);
    if(!assignment) return;
    if(!assignment.fileControlRecording) {
      sample(); persist(state); upload(); file.development.recording=false; return;
    }
    if(file.development.recording) return;
    const requestAuth=auth();
    try {
      const response=await bridge.request(`/api/files/read?path=${encodeURIComponent(file.path)}`,{headers:bridge.headers()});
      const result=await response.json();
      if(response.ok && result.ok && result.development && file===bridge.file() && auth()===requestAuth) {
        file.development=result.development; opened();
      }
    } catch {status('Reopen this assignment file to resume recording.',true);}
  }
  async function refreshPolicy() {
    if (!identity()) {policy=null; policyAuth=''; return;}
    if (policyPending) return policyPending;
    const requestAuth = auth();
    policyPending = (async () => {
      try {
        const response = await bridge.request('/api/editor/policy', {headers:bridge.headers()});
        const data = await response.json();
        if (auth() !== requestAuth || !identity() || !response.ok || !data.ok) return;
        policy = data; policyAuth = requestAuth;
        clearTimeout(boundaryTimer);
        if (data.nextChangeAt) boundaryTimer = setTimeout(refreshPolicy, Math.max(100, Math.min(60000, Date.parse(data.nextChangeAt)-Date.now()+100)));
      } catch {} finally {policyPending=null;}
    })();
    return policyPending;
  }
  function blocked() {
    if (!identity()) return false;
    // Class settings are available immediately at sign-in, before the policy probe.
    if (bridge.classes?.().some(c => c.settings?.editor_clipboard === 'block')) return true;
    if (policyAuth !== auth() && bridge.classes?.().some(c => c.settings?.editor_clipboard === 'outstanding')) return true;
    return policyAuth === auth() && !!policy?.clipboardBlocked;
  }
  function isCodeTarget(target) {
    return !!target?.closest?.('#editor, .CodeMirror, .student-notebook-code-block, .student-notebook-code-input');
  }
  function preventClipboard(event) {
    const selection = document.getSelection?.();
    if (!blocked() || !(isCodeTarget(event.target) || isCodeTarget(selection?.anchorNode?.parentElement))) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (Date.now()-noticeAt > 1500) {
      noticeAt=Date.now();
      status('Copy and paste are disabled by your class settings.', true);
    }
  }
  function configure(value) {
    bridge=value;
    ['copy','cut','paste','drop'].forEach(name => document.addEventListener(name, preventClipboard, true));
    document.addEventListener('beforeinput', event => {if (/insertFromPaste|insertFromDrop|deleteByCut/.test(event.inputType || '')) preventClipboard(event);}, true);
    document.addEventListener('keydown', event => {
      if (((event.ctrlKey || event.metaKey) && ['c','v','x'].includes(event.key.toLowerCase())) || (event.shiftKey && ['Insert','Delete'].includes(event.key))) preventClipboard(event);
    }, true);
    document.addEventListener('click', event => {if (event.target?.closest?.('[data-code-action="copy"]')) preventClipboard(event);}, true);
    const change=()=>{dirty=true;};
    window.eagleEditor?.on?.('change', change);
    document.getElementById('editor')?.addEventListener('input', change);
    timer=setInterval(sample,1000);
    setInterval(()=>{if(state?.frames.length) {persist(state); upload();}},10000);
    policyTimer=setInterval(()=>{if(identity() && document.visibilityState!=='hidden') refreshPolicy();},60000);
    window.addEventListener('eagle-context-updated', ()=>{activate(); refreshPolicy();});
    window.addEventListener('eagle-assignments-updated', refreshPolicy);
    window.addEventListener('eagle-socket-ready', event => {
      event.detail.socket.on('classroom_settings_updated', refreshPolicy);
      event.detail.socket.on('assignment_workflow_updated', refreshPolicy);
    });
    document.addEventListener('visibilitychange', ()=>{sample(); persist(state); upload(state,true); if(document.visibilityState==='visible') refreshPolicy();});
    window.addEventListener('pagehide', ()=>{sample(); persist(state); upload(state,true);});
    refreshPolicy();
  }
  window.AssignmentDevelopment = {configure, opened, saved, assignmentsChanged, flush, sample, refreshPolicy, blocked, splice, apply};
})();
