(() => {
  'use strict';
  const ops = window.GroupProjectText;
  const baseUrl = '/api/group-projects';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const classColor = value => 'group-color-' + (Number.isInteger(value) && value >= 0 && value <= 12 ? value : 0);
  const id = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
  let bridge, socket, active, list = [], allowed = false, reason = '', account = '', listRequest, openSequence = 0;
  let saveTimer, cursorTimer, refreshTimer, watchTimer, draftTimer;
  let applyEditorChange = false, beforeEdit, composing = false, showColors = false;
  const views = new Set();
  const cm = () => window.eagleEditor;
  const context = () => bridge?.context() || {};
  const classId = () => context().currentStudentClassId || '';
  const showing = () => !document.hidden && (bridge.visible?.() ?? true);
  const token = () => context().USER_TOKEN || '';
  const student = () => !!token() && !context().TEACHER_TOKEN && !context().ADMIN_TOKEN;
  const canShare = () => student() && !!classId() && (context().studentClassData?.settings?.group_projects_enabled === true || allowed);
  const matches = (s, msg) => s && msg.projectId === s.project.id && msg.fileId === s.file.id;
  const valid = s => active === s && s.account === account && bridge.currentFile()?.groupFileId === s.file.id;
  const lost = () => !!window.EagleIDE?.connection?.isLost?.();
  const draftKey = s => 'eagleide-group-draft:' + JSON.stringify([s.email, s.project.id, s.file.id]);
  const storage = () => window.localStorage;
  const route = (projectId = '', fileId = '', teacher = false) => (teacher ? '/api/teacher/group-projects' : baseUrl) +
    (projectId ? '/' + encodeURIComponent(projectId) : '') +
    (fileId ? '/files/' + encodeURIComponent(fileId) : '');
  const currentProject = () => active && valid(active) ? active.project : null;
  const busy = s => !!(s.pending.length || s.sending);
  const marker = s => ({classId:s.project.classId, projectId:s.project.id, fileId:s.file.id});
  const syncKey = () => context().TEACHER_TOKEN ? JSON.stringify(['teacher', context().TEACHER_TOKEN, context().currentTeacherClassId]) :
    student() ? JSON.stringify(['student', token(), classId()]) : '';
  const fileRequest = (project, file, teacher, options = {}) => request(route(project.id, file.id, teacher), {
    ...options, teacher, params:{classId:project.classId, ...options.params},
  });

  async function request(url, {teacher = false, method = 'GET', data, params = {}, blob = false, timeout = 10000} = {}) {
    const c = context();
    const auth = teacher ? c.TEACHER_TOKEN : c.USER_TOKEN;
    const query = new URLSearchParams({classId:teacher ? c.currentTeacherClassId || '' : classId(), ...params});
    const headers = {[teacher ? 'X-Teacher-Token' : 'X-User-Token']:auth};
    const options = {method, headers, cache:'no-store'};
    if (data instanceof FormData) options.body = data;
    else if (data) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(teacher ? data : {classId:classId(), ...data});
    }
    const response = await bridge.request(url + '?' + query, options, timeout);
    if (auth !== (teacher ? context().TEACHER_TOKEN : token()) || (!teacher && query.get('classId') !== classId())) {
      throw new Error('Your class or account changed.');
    }
    if (blob && response.ok) return response.blob();
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw Object.assign(new Error(result.error || 'Group projects are temporarily unavailable.'), {status:response.status});
    return result;
  }

  function notify() {
    for (const view of views) view();
    renderToolbar();
  }

  async function refresh() {
    if (!student() || !classId() || document.hidden || lost()) return;
    if (!canShare() && context().studentClassData?.settings?.group_projects_enabled === false && !list.length &&
        !active && !document.getElementById('editorContentStack')?.classList.contains('file-browser-active')) return;
    if (listRequest) return listRequest;
    const scope = account;
    const task = request(baseUrl).then(data => {
      if (scope !== account) return;
      const changed = JSON.stringify([list, allowed, reason]) !== JSON.stringify([data.projects, data.allowed, data.reason]);
      list = data.projects;
      allowed = data.allowed;
      reason = data.reason;
      const s = active;
      if (s && valid(s)) {
        const project = list.find(item => item.id === s.project.id && item.status === 'active' && item.membership === 'active');
        if (!project || !allowed) pause(s, reason || 'Your access to this project ended.', true);
        else {
          const reopen = s.paused && !s.conflict;
          if (JSON.stringify(project.members) !== JSON.stringify(s.project.members)) s.project = {...s.project, ...project};
          if (reopen) {
            s.paused = false;
            poll(s).then(() => watch(s)).catch(error => handleError(s, error));
          }
        }
      }
      if (changed) notify();
    }).catch(() => {}).finally(() => {if (listRequest === task) listRequest = null;});
    listRequest = task;
    return task;
  }

  function contextChanged() {
    const next = syncKey();
    if (next !== account) {
      const s = active;
      dispose();
      if (s) bridge.close(s.file.id);
      account = next;
      list = [];
      allowed = false;
      reason = '';
      listRequest = null;
      openSequence++;
      notify();
      refresh();
    }
  }

  function guard() {
    const current = bridge.currentFile();
    if (active && current?.groupFileId !== active.file.id) dispose();
    renderToolbar();
  }

  function dispose() {
    if (active) persistDraft(active);
    if (active && socket?.connected) socket.emit('group_project_unwatch');
    clearTimeout(saveTimer);
    clearTimeout(cursorTimer);
    clearTimeout(draftTimer);
    saveTimer = cursorTimer = draftTimer = null;
    active?.marks.forEach(mark => mark.clear());
    active?.cursors.forEach(mark => mark.clear());
    if (active?.keyMap) cm()?.removeKeyMap(active.keyMap);
    active = null;
    beforeEdit = null;
    composing = false;
  }

  function persistDraft(s) {
    if (!s || s.file.kind !== 'text' || !s.pending.length) return true;
    try {
      const payload = JSON.stringify({revision:s.revision, text:s.local, path:s.file.path});
      if (payload.length > 2 * 1024 * 1024) throw new Error('large draft');
      storage().setItem(draftKey(s), payload);
      return true;
    } catch {
      s.recoveryWarning = 'Device storage could not save a recovery draft. Keep this tab open or download your draft.';
      if (valid(s)) renderToolbar();
      return false;
    }
  }

  function getDraft(s) {
    try { return JSON.parse(storage().getItem(draftKey(s)) || 'null'); }
    catch { return null; }
  }

  function clearDraft(s) {
    try { storage().removeItem(draftKey(s)); } catch {}
  }

  function scheduleSave(s) {
    const live = s.viewers.length >= 2;
    const delay = Math.max(live ? 85 : 1000, (s.retryAfter || 0) - Date.now());
    if (!saveTimer) saveTimer = setTimeout(() => {saveTimer = null; send(s);}, delay);
    if (!draftTimer) draftTimer = setTimeout(() => {draftTimer = null; persistDraft(s);}, 500);
  }

  function enqueue(s, parts, pasted = false) {
    const last = s.pending.at(-1);
    const insertSize = parts.reduce((n, part) => n + (typeof part === 'string' ? part.length : 0), 0);
    if (!pasted && last && !last.sent && !last.pasted && last.insertSize + insertSize < 15000 && last.parts.length + parts.length < 1500) {
      last.parts = ops.compose(last.parts, parts);
      last.insertSize += insertSize;
    } else s.pending.push({parts, opId:id(), pasted, insertSize});
    scheduleSave(s);
    if (s.pending.length === 1) renderToolbar();
    if (showColors) schedulePaint(s);
  }

  function insertEditor(parts) {
    const editor = cm();
    const changes = ops.edits(parts);
    if (!editor || !changes.length || active?.concealed) return;
    applyEditorChange = true;
    try {
      editor.operation(() => {
        for (const change of changes.reverse()) {
          editor.replaceRange(change.text, editor.posFromIndex(change.start), editor.posFromIndex(change.end), 'groupRemote');
        }
      });
      editor.clearHistory();
    } finally { applyEditorChange = false; }
  }

  function localChange(s, parts, {pasted = false, history = true} = {}) {
    const next = ops.apply(s.local, parts);
    if (next === s.local) return;
    if (history) {
      s.undo.push(ops.inverse(s.local, parts));
      if (s.undo.length > 100) s.undo.shift();
      s.redo.length = 0;
    }
    s.local = next;
    if (!history || pasted) s.byteLength = new TextEncoder().encode(s.local).length;
    enqueue(s, parts, pasted);
  }

  function undo(s, redo) {
    if (!valid(s) || s.paused) return;
    const [from, to] = redo ? [s.redo, s.undo] : [s.undo, s.redo];
    const parts = from.pop();
    if (!parts) return;
    to.push(ops.inverse(s.local, parts));
    insertEditor(parts);
    localChange(s, parts, {history:false});
  }

  function confirmEdit(s, update) {
    if (update.revision <= s.revision) return;
    if (update.revision !== s.revision + 1 || composing) {
      s.incoming.set(update.revision, update);
      if (s.incoming.size > 120) s.incoming.clear();
      if (!composing) poll(s).catch(error => handleError(s, error));
      return;
    }
    const own = s.pending[0]?.opId === update.opId;
    if (own) s.pending.shift();
    else {
      let remote = update.parts;
      for (const local of s.pending) {
        const previous = local.parts;
        local.parts = ops.transform(previous, remote);
        remote = ops.transform(remote, previous, true);
      }
      ops.rebaseUndo(s.undo, remote);
      ops.rebaseUndo(s.redo, remote);
      s.local = ops.apply(s.local, remote);
      s.byteLength = new TextEncoder().encode(s.local).length;
      insertEditor(remote);
    }
    s.source = ops.apply(s.source, update.parts);
    s.spans = ops.mapSpans(s.spans, update.parts, update.author.id);
    if (update.parts.some(part => typeof part === 'string' || part < 0)) s.authors.set(update.author.id, update.author);
    s.revision = update.revision;
    if (own && !s.pending.length) {
      // A concurrent edit may turn our queued edit into a no-op.
      if (s.local !== s.source) {
        insertEditor(ops.diff(s.local, s.source));
        s.local = s.source;
        s.byteLength = new TextEncoder().encode(s.local).length;
      }
      clearDraft(s);
    }
    schedulePaint(s);
  }

  function receive(s, updates) {
    if (!valid(s) || s.conflict) return;
    for (const update of updates) {
      try {confirmEdit(s, update);}
      catch {
        pause(s, 'This draft could not be merged. Download it before opening the latest revision.', false);
        return;
      }
    }
    for (const rev of s.incoming.keys()) if (rev <= s.revision) s.incoming.delete(rev);
    while (!composing && s.incoming.has(s.revision + 1)) {
      const update = s.incoming.get(s.revision + 1);
      s.incoming.delete(s.revision + 1);
      try {confirmEdit(s, update);} catch {pause(s, 'This draft needs review before it can sync.', false); break;}
    }
    renderToolbar();
  }

  function reconcile(s, file) {
    if (!valid(s) || s.conflict || file.revision < s.revision) return;
    if (file.kind !== s.file.kind) {
      pause(s, 'This file changed type. Open the saved revision to continue.', false);
      return;
    }
    if (file.updates) receive(s, file.updates);
    else if (file.content !== undefined && file.revision > s.revision) {
      if (s.pending.length) {
        pause(s, 'Your draft is older than the saved file. Download your draft before reloading.', false);
        return;
      }
      insertEditor(ops.diff(s.local, file.content));
      s.source = s.local = file.content;
      s.byteLength = new TextEncoder().encode(s.local).length;
      s.revision = file.revision;
      s.undo.length = s.redo.length = 0;
    } else if (file.kind === 'asset') {
      s.revision = file.revision;
    }
    if (file.contribution && s.revision === file.revision) {
      s.spans = file.contribution.spans || [];
      s.authors = new Map((file.contribution.authors || []).map(author => [author.id, author]));
    }
    if (s.file.path !== file.path) {
      s.file.path = file.path;
      bridge.rename(s.file.id, file.path);
    }
    schedulePaint(s);
  }

  async function poll(s) {
    if (!valid(s) || s.conflict || s.polling || lost()) return;
    const epoch = s.accessEpoch;
    const task = fileRequest(s.project, s.file, s.teacher, {params:{since:String(s.revision)}});
    s.polling = task;
    try {
      const result = await task;
      if (!valid(s) || epoch !== s.accessEpoch) return;
      reconcile(s, result.file);
      setViewers(s, result.viewers || []);
      if (!s.conflict) {
        s.paused = false;
        s.message = '';
        if (s.concealed) {
          s.concealed = false;
          bridge.restore(s.file.id, s.file.kind === 'text' ? s.local : 'Use Download file to open this shared asset.');
        }
        bridge.readOnly(s.file.id, s.file.kind !== 'text');
        renderToolbar();
        if (s.pending.length) scheduleSave(s);
      }
    } finally {if (s.polling === task) s.polling = null;}
  }

  const emit = (event, payload, ms = 3500) => new Promise((resolve, reject) => {
    if (!socket?.connected) return reject(new Error('The live connection is reconnecting.'));
    socket.timeout(ms).emit(event, payload, (err, result) => {
      if (err) reject(err);
      else if (!result?.ok) reject(Object.assign(new Error(result?.error || 'Group update failed.'), {status:result?.status}));
      else resolve(result);
    });
  });

  function setViewers(s, viewers) {
    if (s.viewers.join() === viewers.join()) return;
    const wasLive = s.viewers.length >= 2;
    s.viewers = viewers;
    if (wasLive !== (viewers.length >= 2)) {clearTimeout(saveTimer); saveTimer = null;}
    for (const [id, mark] of s.cursors) if (viewers.length < 2 || !viewers.includes(id)) {
      mark.clear();
      s.cursors.delete(id);
    }
    if (!wasLive && viewers.length >= 2 && valid(s)) {
      poll(s).then(() => {if (s.teacher) scheduleCursor(s);}).catch(error => handleError(s,error));
    }
    if (s.pending.length) scheduleSave(s);
    renderToolbar();
  }

  async function watch(s) {
    if (!valid(s) || s.paused || !socket?.connected || !showing() || s.watching) return;
    s.watching = true;
    try {
      const data = await emit('group_project_watch', marker(s));
      if (!valid(s)) return;
      setViewers(s, data.viewers || []);
      if (data.revision > s.revision) await poll(s);
      if (s.teacher) scheduleCursor(s);
    } finally { s.watching = false; }
  }

  function pause(s, message, access) {
    if (!valid(s)) return;
    s.paused = true;
    s.accessEpoch++;
    s.conflict = !access;
    s.message = message;
    persistDraft(s);
    if (socket?.connected) socket.emit('group_project_unwatch');
    setViewers(s, []);
    bridge.readOnly(s.file.id, true);
    if (access && !s.concealed) {
      s.concealed = true;
      bridge.conceal(s.file.id);
      schedulePaint(s);
    }
    renderToolbar();
  }

  function handleError(s, error) {
    if (!valid(s)) return;
    if (error.status === 401 || error.status === 403 || error.status === 404) pause(s, error.message, true);
    else if (error.status === 409 || error.status === 413 || error.status === 400) pause(s, error.message, false);
    else {
      if (error.status === 429) s.retryAfter = Date.now() + 1000;
      s.message = error.status === 429 ? 'Sync is catching up…' :
        s.pending.length ? 'Reconnecting · draft kept on this device' : 'Reconnecting…';
      persistDraft(s);
      renderToolbar();
    }
  }

  async function send(s, forceHttp = false) {
    if (!valid(s) || s.paused || s.sending || !s.pending.length || lost()) return false;
    const entry = s.pending[0];
    entry.sent ||= {...marker(s), revision:s.revision, opId:entry.opId, parts:entry.parts, pasted:entry.pasted};
    const task = (async () => {
      if (!forceHttp && s.viewers.length >= 2 && socket?.connected) {
        try {return await emit('group_project_change', entry.sent);}
        catch (error) {
          if (error.status && error.status !== 429 && error.status !== 409) throw error;
          if (error.status === 429) throw error;
        }
      }
      return fileRequest(s.project, s.file, s.teacher, {method:'POST', data:entry.sent});
    })();
    s.sending = task;
    try {
      const data = await task;
      if (!valid(s)) return false;
      reconcile(s, data.file);
      s.message = '';
      if (s.pending[0] === entry && !composing && !s.conflict) {
        // An accepted operation may have fallen outside the replay window.
        pause(s, 'The server saved a newer version. Review your recovery draft.', false);
      }
      return !s.paused;
    } catch (error) {
      handleError(s, error);
      return false;
    } finally {
      if (s.sending === task) s.sending = null;
      if (valid(s) && s.pending.length && !s.paused) scheduleSave(s);
      renderToolbar();
    }
  }

  async function flush({navigation = false} = {}) {
    const s = active;
    if (!s || !valid(s)) return true;
    if (!s.pending.length) return navigation || !s.paused;
    if (s.paused || lost()) return navigation && persistDraft(s);
    clearTimeout(saveTimer);
    saveTimer = null;
    for (let i = 0; i < 64 && valid(s) && busy(s); i++) {
      if (s.sending) {
        try {await s.sending;} catch {return false;}
      } else if (!await send(s, true)) return false;
    }
    return valid(s) && ((!s.pending.length && !s.paused) || (navigation && persistDraft(s)));
  }

  async function open(project, file, {teacher = false, canOpen = () => true} = {}) {
    const sequence = ++openSequence;
    const scope = account;
    if (teacher && project.classId !== context().currentTeacherClassId) throw new Error('Select this class before opening the file.');
    if (!await bridge.save() && bridge.currentFile()?.groupFileId !== file.id) throw new Error('Save or download the current draft before switching files.');
    if (sequence !== openSequence || scope !== account || !canOpen()) return false;
    const previous = bridge.currentFile(), previousText = bridge.content();
    const data = await fileRequest(project, file, teacher);
    if (sequence !== openSequence || scope !== account || !canOpen() || bridge.currentFile() !== previous || bridge.content() !== previousText) return false;
    dispose();
    const saved = data.file;
    const s = {
      account, teacher, email:(teacher ? context().currentTeacher : context().currentUser)?.email || '',
      project:teacher ? {...project, own:data.own} : project, file:saved, revision:saved.revision,
      source:saved.content || '', local:saved.content || '', byteLength:new TextEncoder().encode(saved.content || '').length, pending:[], incoming:new Map(), undo:[], redo:[],
      spans:saved.contribution?.spans || [], authors:new Map((saved.contribution?.authors || []).map(author => [author.id, author])),
      marks:[], cursors:new Map(), viewers:data.viewers || [], message:'', accessEpoch:0, paused:false, conflict:false,
    };
    active = s;
    bridge.open(s.project, saved, teacher);
    if (saved.kind === 'text' && cm()) {
      s.keyMap = {
        'Ctrl-Z': () => undo(s, false), 'Cmd-Z': () => undo(s, false),
        'Shift-Ctrl-Z': () => undo(s, true), 'Shift-Cmd-Z': () => undo(s, true), 'Ctrl-Y': () => undo(s, true),
      };
      cm().addKeyMap(s.keyMap);
      s.draft = getDraft(s);
      if (s.draft?.text === s.source) {clearDraft(s); s.draft = null;}
    }
    schedulePaint(s);
    renderToolbar();
    watch(s).catch(error => handleError(s,error));
    return true;
  }

  function bindSocket(value) {
    if (!value || socket === value) return;
    socket = value;
    value.on('group_project_edit', msg => {
      if (matches(active, msg)) receive(active, [msg]);
    });
    value.on('group_project_presence', msg => {
      if (matches(active, msg)) setViewers(active, msg.viewers);
    });
    value.on('group_project_cursor', msg => {
      const s = active;
      if (!matches(s, msg) || !valid(s) || s.paused || msg.author === s.project.own?.id) return;
      if (msg.position === null) {
        s.cursors.get(msg.author)?.clear();
        s.cursors.delete(msg.author);
        return;
      }
      if (s.revision !== msg.revision || !cm() || s.viewers.length < 2 || !s.viewers.includes(msg.author)) return;
      const person = msg.person || s.project.members.find(member => member.id === msg.author);
      if (!person) return;
      let position = msg.position;
      for (const edit of s.pending) position = ops.mapPosition(position, edit.parts);
      const cursor = document.createElement('span');
      cursor.className = 'group-remote-cursor ' + classColor(person.color);
      cursor.tabIndex = 0;
      cursor.title = person.name;
      cursor.setAttribute('aria-label', person.name + '’s cursor');
      const name = document.createElement('span');
      name.textContent = person.name;
      cursor.append(name);
      s.cursors.get(person.id)?.clear();
      s.cursors.set(person.id, cm().setBookmark(cm().posFromIndex(position), {widget:cursor, insertLeft:true}));
    });
    value.on('group_project_access_changed', msg => {
      const s = active;
      if (s?.project.id === msg.projectId) {
        pause(s, 'Checking project access…', true);
        poll(s).then(() => watch(s)).catch(error => handleError(s,error));
      }
      refresh();
    });
    value.on('disconnect', () => {
      const s = active;
      if (!s) return;
      setViewers(s, []);
      persistDraft(s);
    });
    value.on('connect', () => {
      refresh();
      if (active) poll(active).then(() => active && watch(active)).catch(error => active && handleError(active,error));
    });
  }

  function scheduleCursor(s) {
    if (cursorTimer || s.viewers.length < 2 || (s.teacher && !cm()?.hasFocus())) return;
    cursorTimer = setTimeout(() => {
      cursorTimer = null;
      if (!valid(s) || s.paused || !socket?.connected || !cm() || s.viewers.length < 2 ||
          (s.teacher && !cm().hasFocus())) return;
      let position = cm().indexFromPos(cm().getCursor());
      if (s.pending.length) {
        let combined = s.pending[0].parts;
        for (const item of s.pending.slice(1)) combined = ops.compose(combined, item.parts);
        position = ops.mapPosition(position, ops.inverse(s.source, combined));
      }
      socket.volatile.emit('group_project_cursor', {...marker(s), position, revision:s.revision});
    }, 100);
  }

  function schedulePaint(s) {
    if (s.painting) return;
    s.painting = true;
    requestAnimationFrame(() => {
      s.painting = false;
      if (!valid(s) || !cm()) return;
      cm().operation(() => {
        s.marks.splice(0).forEach(mark => mark.clear());
        if (!showColors || s.paused) return;
        let spans = s.spans;
        for (const change of s.pending) spans = ops.mapSpans(spans, change.parts, s.project.own?.id);
        const viewport = cm().getViewport();
        const start = cm().indexFromPos({line:Math.max(0, viewport.from - 15), ch:0});
        const stop = cm().indexFromPos({line:viewport.to + 15, ch:0});
        for (const [from,to,author] of spans) {
          if (to <= start || from >= stop) continue;
          const person = s.authors.get(author) || (s.project.own?.id === author ? s.project.own : null);
          if (person) s.marks.push(cm().markText(cm().posFromIndex(from), cm().posFromIndex(to),
            {className:'group-contribution ' + classColor(person.color), title:person.name}));
        }
      });
    });
  }

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function renderToolbar() {
    const bar = document.getElementById('groupEditorTools');
    const people = document.getElementById('groupMemberIcons');
    if (!bar || !people) return;
    const s = active && valid(active) ? active : null;
    bar.hidden = people.hidden = !s;
    if (!s) {
      if (bar.dataset.markup) {bar.replaceChildren(); delete bar.dataset.markup;}
      if (people.dataset.markup) {people.replaceChildren(); delete people.dataset.markup;}
      return;
    }
    const live = s.viewers.length >= 2;
    const state = s.file.kind === 'asset' ? 'Shared asset' : !cm() ? 'Reload to enable the shared editor' :
      busy(s) ? 'Saving…' : live ? 'Live editing' : 'Shared · saved';
    const description = s.recoveryWarning || s.message || state;
    const members = s.project.members.filter(p => !s.teacher || p.state === 'active' && p.available).map(p => {
      const viewing = s.viewers.includes(p.id);
      const initials = p.name.trim().split(/\s+/).slice(0,2).map(word => Array.from(word)[0]).join('').toUpperCase();
      return `<span class="group-member-icon ${classColor(p.color)} ${viewing ? 'is-viewing' : ''}" tabindex="0"
        title="${esc(p.name)} · ${viewing ? 'File open' : 'File closed'}" aria-label="${esc(p.name)} · ${viewing ? 'File open' : 'File closed'}">${esc(initials || '?')}</span>`;
    }).join('');
    if (people.dataset.markup !== members) {people.innerHTML = members; people.dataset.markup = members;}
    const markup = `<span class="group-status ${s.paused ? 'is-paused' : ''}" role="status"></span>
      ${s.file.kind === 'text' && cm() && !s.paused ? '<label><input type="checkbox" data-group-colors> Show contributions</label>' : ''}
      ${s.draft ? '<button type="button" class="btn secondary" data-group-draft>Recovery draft</button>' : ''}
      ${s.paused && s.pending.length ? '<button type="button" class="btn secondary" data-group-copy>Download draft</button>' : ''}
      ${s.conflict ? '<button type="button" class="btn secondary" data-group-reload>Open saved revision</button>' : ''}
      ${s.file.kind === 'asset' && !s.paused ? '<button type="button" class="btn secondary" data-group-download>Download file</button>' : ''}`;
    if (bar.dataset.markup === markup) {
      const status = bar.querySelector('.group-status');
      if (status.textContent !== description) status.textContent = description;
      return;
    }
    bar.dataset.markup = markup;
    bar.innerHTML = markup;
    bar.querySelector('.group-status').textContent = description;
    const toggle = bar.querySelector('[data-group-colors]');
    if (toggle) {
      toggle.checked = showColors;
      toggle.onchange = () => {showColors = toggle.checked; schedulePaint(s);};
    }
    bar.querySelector('[data-group-copy]')?.addEventListener('click', () => saveBlob(new Blob([s.local]), s.file.path.split('/').at(-1)));
    bar.querySelector('[data-group-reload]')?.addEventListener('click', () => {
      persistDraft(s);
      open(s.project, s.file, {teacher:s.teacher}).catch(error => {s.message = error.message; renderToolbar();});
    });
    bar.querySelector('[data-group-draft]')?.addEventListener('click', () => {
      const draft = s.draft;
      if (draft.revision === s.revision && !s.pending.length && !s.paused && confirm('Restore your unsynced draft into this shared file?')) {
        const parts = ops.diff(s.local, draft.text);
        insertEditor(parts);
        s.byteLength = new TextEncoder().encode(draft.text).length;
        localChange(s, parts);
        s.draft = null;
        renderToolbar();
      } else saveBlob(new Blob([draft.text]), draft.path.split('/').at(-1));
    });
    bar.querySelector('[data-group-download]')?.addEventListener('click', () =>
      download(s.project, s.file, s.teacher).catch(error => {s.message = error.message; renderToolbar();}));
  }

  function download(project, file, teacher = false) {
    return request(route(project.id, '', teacher) + (teacher ? '' : '/download'), {
      teacher, params:{classId:project.classId, ...(file ? {fileId:file.id} : {}), ...(teacher ? {download:'1'} : {})},
      blob:true, timeout:25000,
    })
      .then(blob => saveBlob(blob, file ? file.path.split('/').at(-1) : project.name + (project.folder ? '.zip' : '')));
  }

  function configure(value) {
    bridge = value;
    const editor = cm();
    editor?.on('beforeChange', (_instance, change) => {
      beforeEdit = null;
      const s = active;
      if (!s || !valid(s) || applyEditorChange || change.origin === 'setValue') return;
      if (s.paused) {change.cancel(); return;}
      const text = change.text.join('\n');
      const encoder = new TextEncoder();
      const inserted = encoder.encode(text).length;
      const removed = encoder.encode(editor.getRange(change.from, change.to)).length;
      const length = s.byteLength + inserted - removed;
      if (inserted > 96 * 1024 || length > 2 * 1024 * 1024 || s.pending.length >= 256) {
        change.cancel();
        s.message = s.pending.length >= 256 ? 'The recovery queue is full. Reconnect to continue editing.' :
          length > 2 * 1024 * 1024 ? 'Shared text files can be at most 2 MiB.' :
          'This edit is too large. Paste it in sections under 96 KiB.';
        setTimeout(renderToolbar, 0);
        return;
      }
      beforeEdit = {s, length, parts:ops.splice(s.local.length, editor.indexFromPos(change.from), editor.indexFromPos(change.to), text), pasted:change.origin === 'paste'};
    });
    editor?.on('change', () => {
      if (!beforeEdit) return;
      const {s, parts, pasted, length} = beforeEdit;
      beforeEdit = null;
      if (!valid(s)) return;
      s.byteLength = length;
      localChange(s, parts, {pasted});
    });
    editor?.on('cursorActivity', () => {if (active) scheduleCursor(active);});
    editor?.on('focus', () => {if (active?.teacher) scheduleCursor(active);});
    editor?.on('blur', () => {
      const s = active;
      if (!s?.teacher || !socket?.connected) return;
      clearTimeout(cursorTimer);
      cursorTimer = null;
      socket.emit('group_project_cursor', {...marker(s), position:null, revision:s.revision});
    });
    editor?.on('viewportChange', () => {if (active && showColors) schedulePaint(active);});
    editor?.getInputField().addEventListener('compositionstart', () => {composing = true;});
    editor?.getInputField().addEventListener('compositionend', () => {
      composing = false;
      if (active) receive(active, []);
    });
    window.addEventListener('eagle-context-updated', contextChanged);
    window.addEventListener('pagehide', () => {if (active) persistDraft(active);});
    document.addEventListener('visibilitychange', () => {
      const s = active;
      if (document.hidden) {
        if (s) {persistDraft(s); flush(); setViewers(s, []);}
        if (socket?.connected) socket.emit('group_project_unwatch');
      } else {
        refresh();
        if (s) poll(s).then(() => watch(s)).catch(error => handleError(s,error));
      }
    });
    let editorShowing = showing();
    const editorVisibility = new MutationObserver(() => {
      const visible = showing();
      if (editorShowing === visible) return;
      editorShowing = visible;
      const s = active;
      if (visible && s) watch(s).catch(error => handleError(s,error));
      else if (!visible && s) {
        setViewers(s, []);
        if (socket?.connected) socket.emit('group_project_unwatch');
      }
      if (!visible) refresh();
    });
    editorVisibility.observe(document.body, {attributes:true,attributeFilter:['class']});
    const stack = document.getElementById('editorContentStack');
    if (stack) editorVisibility.observe(stack, {attributes:true,attributeFilter:['class']});
    refreshTimer ||= setInterval(() => {
      if (document.hidden) return;
      refresh();
      const s = active;
      if (s) poll(s).catch(error => handleError(s,error));
    }, 12000);
    watchTimer ||= setInterval(() => {
      const s = active;
      if (s) watch(s).catch(error => handleError(s,error));
    }, 12000);
    contextChanged();
  }

  window.GroupProjects = {
    configure, bindSocket, guard, refresh, canShare, request, route, open, flush, download, saveBlob, esc, classColor,
    subscribe: view => views.add(view),
    list: () => list, available: () => ({allowed, reason}), context, currentProject,
    unsaved: () => !!active?.pending.length,
    runTarget: () => active && valid(active) && !active.paused && !active.teacher ?
      {...marker(active), revision:active.revision} : null,
  };
})();
