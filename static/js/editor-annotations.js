(() => {
  'use strict';
  const cm = () => window.eagleEditor;
  const maxEdits = 256;
  let bridge, state, card, popup, hideTimer;
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (text, action) => {
    const node = element('button', text);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  };
  const color = author => Number.isInteger(author?.color) && author.color >= 0 && author.color <= 12 ?
    'group-color-' + author.color : 'annotation-personal';
  const current = s => !!s && state === s && bridge.file() === s.file && bridge.scope() === s.scope;
  const visible = () => !document.hidden && bridge.visible() && !!cm()?.getWrapperElement().getClientRects().length;
  const enabled = () => current(state) && visible() && (!state.file.groupFileId || !state.file.readOnly);
  const group = s => window.GroupProjects?.annotationTarget(s.file.groupFileId);

  function close() {
    clearTimeout(hideTimer);
    popup?.draftMark?.clear();
    popup = null;
    if (card) {card.hidden = true; card.replaceChildren();}
  }

  function clear() {
    close();
    const previous = state;
    state = null;
    if (previous) cm()?.operation(() => previous.marks.forEach(mark => mark.clear()));
  }

  function opened() {
    const file = bridge.file();
    if (current(state)) return;
    clear();
    if (!cm() || !file || file.draft || file.submission || file.notebook || file.historyPlayback ||
        (file.kind && file.kind !== 'text') || (!file.groupFileId && !file.annotationDigest) ||
        file.name?.toLowerCase().endsWith('.csv') || bridge.excluded(file)) return;
    state = {file, scope:bridge.scope(), account:bridge.account(), base:file.annotationDigest,
      marks:new Map(), threads:[], edits:[], batch:[], count:0, serial:0};
    refresh();
  }

  // CodeMirror sends positions in the pre-change document, including for
  // undo and edits composed from several replacements in one operation.
  function recordChange(s, change) {
    if (s.batch.length > maxEdits) return;
    s.batch.push([cm().indexFromPos(change.from), cm().indexFromPos(change.to), change.text.join('\n').length]);
  }

  function saveInfo(file) {
    const s = state;
    if (!current(s) || s.file !== file || file.audit || file.groupFileId) return null;
    return {s, count:s.count, size:s.edits?.length, payload:{annotationBase:s.base, annotationEdits:s.edits}};
  }

  function saved(file, info, digest) {
    if (!digest) return;
    file.annotationDigest = digest;
    if (!info || !current(info.s)) return;
    const s = info.s;
    s.base = digest;
    if (s.edits && info.size != null) s.edits.splice(0, info.size);
    else if (s.count === info.count) s.edits = [];
    if (s.threads.some(thread => !s.marks.get(thread.id)?.find())) refresh();
  }

  function mapRange(start, end, edits) {
    for (const [from, to, added] of edits) {
      const delta = added - (to - from);
      if (end <= from) continue;
      if (start >= to) {start += delta; end += delta; continue;}
      const left = start < from, right = end > to;
      if (!left && !right) return null;
      if (!left) start = from + added;
      end = right ? end + delta : from;
    }
    return {start,end};
  }

  function paint(s, threads) {
    const byId = new Map(threads.map(thread => [thread.id, thread]));
    cm().operation(() => {
      for (const [id, mark] of s.marks) {
        const thread = byId.get(id), range = mark.find();
        if (!thread || !range || cm().indexFromPos(range.from) !== thread.start || cm().indexFromPos(range.to) !== thread.end) {
          mark.clear();
          s.marks.delete(id);
        }
      }
      for (const thread of threads) if (!s.marks.has(thread.id)) {
        s.marks.set(thread.id, cm().markText(cm().posFromIndex(thread.start), cm().posFromIndex(thread.end), {
          className:'eagle-annotation-highlight ' + color(thread.author),
          attributes:{'data-annotation-id':thread.id},
        }));
      }
    });
    s.threads = threads;
    if (popup?.id && !byId.has(popup.id)) close();
    else if (popup?.id && !popup.form) updateMessages();
    else if (popup?.list) showList(popup.anchor);
  }

  async function request(s, data) {
    if (s.file.groupFileId) {
      const target = group(s);
      if (!target) throw new Error('Wait for the shared file to sync.');
      const core = window.GroupProjects;
      return core.request(core.route(target.projectId, target.fileId, target.teacher) + '/annotations', {
        teacher:target.teacher, params:{classId:target.classId}, method:data ? 'POST' : 'GET', data,
      });
    }
    const {audit, path} = s.file;
    const params = new URLSearchParams({path});
    if (audit) {params.set('studentEmail', s.file.studentEmail); params.set('classId', s.file.auditClassId);}
    const response = await bridge.request((audit ? '/api/teacher/students/files/annotations' : '/api/files/annotations') + '?' + params, {
      cache:'no-store', method:data ? 'POST' : 'GET', headers:{...bridge.headers(), ...(data ? {'Content-Type':'application/json'} : {})},
      ...(data ? {body:JSON.stringify(data)} : {}),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw Object.assign(new Error(result.error || 'Could not load annotations.'), {status:response.status});
    return result;
  }

  function accept(s, result) {
    if (!current(s)) return false;
    let threads = result.annotations;
    if (s.file.groupFileId) {
      if (group(s)?.revision !== result.revision) return false;
    } else {
      if (threads.length && result.digest !== s.base || !s.edits) return false;
      threads = threads.flatMap(thread => {
        const range = mapRange(thread.start, thread.end, s.edits);
        return range ? [{...thread,...range}] : [];
      });
    }
    paint(s, threads);
    return true;
  }

  async function refresh() {
    const s = state;
    if (!enabled() || s.loading || (s.file.groupFileId && !group(s))) return;
    const serial = s.serial;
    s.loading = true;
    try {
      const result = await request(s);
      if (s.serial === serial) accept(s, result);
    } catch (error) {
      if (current(s) && [401,403,404].includes(error.status)) paint(s, []);
    } finally {s.loading = false;}
  }

  function place(anchor) {
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
    const width = viewport?.width || window.innerWidth, height = viewport?.height || window.innerHeight;
    const rect = anchor?.getBoundingClientRect?.() || anchor || cm().cursorCoords(null, 'window');
    const gap = 8;
    card.style.left = Math.max(left + gap, Math.min(rect.left, left + width - card.offsetWidth - gap)) + 'px';
    const below = rect.bottom + gap;
    card.style.top = Math.max(top + gap, Math.min(below + card.offsetHeight > top + height - gap ? rect.top - card.offsetHeight - gap : below,
      top + height - card.offsetHeight - gap)) + 'px';
  }

  function header(title, pinned) {
    const row = element('header', null, 'annotation-heading');
    const dismiss = button('×', close);
    dismiss.setAttribute('aria-label', 'Dismiss annotation card');
    row.append(element('strong', title), dismiss);
    card.replaceChildren(row);
    card.hidden = false;
    card.dataset.pinned = String(pinned);
  }

  function updateMessages() {
    const thread = state.threads.find(t => t.id === popup.id);
    const list = card.querySelector('.annotation-messages');
    if (!thread || !list) return;
    const signature = JSON.stringify(thread.messages);
    if (list.dataset.signature === signature) return;
    list.dataset.signature = signature;
    list.replaceChildren(...thread.messages.map(message => {
      const item = element('article', null, 'annotation-message ' + (message.author.mentor ? 'annotation-mentor' : color(message.author)));
      const top = element('div', null, 'annotation-message-top');
      const resolve = button('Close', () => mutate({action:'closeMessage', threadId:thread.id, messageId:message.id}, resolve));
      resolve.setAttribute('aria-label', 'Close message by ' + message.author.name);
      top.append(element('strong', message.author.name), resolve);
      item.append(top, element('p', message.body));
      return item;
    }));
  }

  function showThread(id, anchor, pinned = false) {
    const thread = state?.threads.find(t => t.id === id);
    if (!enabled() || !thread || !state.marks.get(id)?.find()) return;
    if (popup?.id === id && !pinned) return;
    close();
    popup = {id, anchor, pinned};
    header('Annotation', pinned);
    const actions = element('div', null, 'annotation-actions');
    const reply = button('Reply', () => compose('Reply', body => ({action:'reply', threadId:id, body})));
    const resolve = button('Close annotation', () => mutate({action:'close', threadId:id}, resolve));
    actions.append(reply, resolve);
    card.append(element('div', null, 'annotation-messages'), actions, element('p', '', 'annotation-status'));
    updateMessages();
    place(anchor);
    if (pinned) reply.focus({preventScroll:true});
  }

  function showList(anchor) {
    if (!enabled()) return;
    close();
    popup = {list:true, pinned:true, anchor};
    header('Annotations in this file', true);
    const list = element('div', null, 'annotation-list');
    for (const thread of state.threads) {
      const range = state.marks.get(thread.id)?.find();
      if (!range) continue;
      list.append(button(`Line ${range.from.line + 1} · ${thread.messages[0].body.slice(0, 75)}`, () => {
        cm().scrollIntoView(range.from, 24);
        showThread(thread.id, cm().charCoords(range.from, 'window'), true);
      }));
    }
    if (!list.childElementCount) list.append(element('p', 'Select text and choose Add Annotation to start.'));
    card.append(list);
    place(anchor);
  }

  function compose(label, action) {
    popup.form = true;
    popup.pinned = true;
    card.dataset.pinned = 'true';
    card.querySelector('form')?.remove();
    const form = element('form', null, 'annotation-compose');
    const field = element('textarea');
    field.setAttribute('aria-label', label + ' message');
    field.placeholder = 'Write a note or a checklist item…';
    field.required = true;
    field.maxLength = 1000;
    field.rows = 3;
    const submit = element('button', label);
    submit.type = 'submit';
    form.append(field, submit);
    form.addEventListener('submit', event => {
      event.preventDefault();
      mutate(action(field.value), submit);
    });
    const status = card.querySelector('.annotation-status');
    card.insertBefore(form, status);
    place(popup.anchor);
    field.focus({preventScroll:true});
  }

  function add() {
    if (!enabled() || !cm().somethingSelected()) return;
    const from = cm().getCursor('from'), to = cm().getCursor('to');
    close();
    const anchor = cm().charCoords(from, 'window');
    const draftMark = cm().markText(from, to, {className:'eagle-annotation-highlight annotation-personal'});
    popup = {pinned:true, anchor, draftMark};
    header('Add Annotation', true);
    card.append(element('p', '', 'annotation-status'));
    compose('Add annotation', body => ({action:'add', body}));
  }

  async function mutate(data, control) {
    const s = state, view = popup;
    if (!enabled()) return;
    const status = card.querySelector('.annotation-status');
    control.disabled = true;
    s.serial++;
    try {
      if (data.action === 'add') {
        const synced = s.file.groupFileId ? await window.GroupProjects.flush() : (s.file.audit || await bridge.save());
        if (!current(s) || popup !== view) return;
        if (!synced || !view.draftMark.find() || (!s.file.groupFileId && s.edits?.length !== 0)) {
          throw new Error('Save the file and select the text again before annotating.');
        }
        const {from,to} = view.draftMark.find();
        Object.assign(data, {start:cm().indexFromPos(from), end:cm().indexFromPos(to),
          ...(s.file.groupFileId ? {revision:group(s)?.revision} : {digest:s.base})});
      }
      const result = await request(s, data);
      if (!current(s)) return;
      s.serial++;
      if (!accept(s, result)) refresh();
      if (popup === view && data.action !== 'close') {
        const id = result.threadId, anchor = view.anchor;
        close();
        showThread(id, anchor, true);
      }
    } catch (error) {
      if (current(s) && popup === view) status.textContent = error.message;
    } finally {control.disabled = false;}
  }

  function configure(value) {
    bridge = value;
    card = document.getElementById('editorAnnotationCard');
    if (!card || !cm()) return;
    const surface = cm().getWrapperElement();
    const markAt = target => target.closest?.('[data-annotation-id]');
    surface.addEventListener('pointerover', event => {
      const mark = markAt(event.target);
      if (!mark || popup?.pinned) return;
      clearTimeout(hideTimer);
      showThread(mark.dataset.annotationId, mark);
    });
    const leave = () => {
      if (popup && !popup.pinned) hideTimer = setTimeout(close, 200);
    };
    surface.addEventListener('pointerout', event => {
      if (markAt(event.target) && markAt(event.relatedTarget || {}) !== markAt(event.target)) leave();
    });
    surface.addEventListener('click', event => {
      const mark = markAt(event.target);
      if (mark) showThread(mark.dataset.annotationId, mark, true);
    });
    card.addEventListener('pointerenter', () => clearTimeout(hideTimer));
    card.addEventListener('pointerleave', leave);
    document.addEventListener('pointerdown', event => {
      if (popup && !card.contains(event.target) && !markAt(event.target)) close();
    });
    document.addEventListener('keydown', event => {
      if (popup && event.key === 'Escape') {
        const pinned = popup.pinned;
        close();
        if (pinned && visible()) cm().focus();
        event.preventDefault();
      }
    });
    cm().on('beforeChange', (_editor, change) => {
      if (current(state) && !state.file.groupFileId && !state.file.audit) recordChange(state, change);
    });
    cm().on('changes', (_editor, changes) => {
      const s = state;
      if (!current(s)) return;
      if (!s.file.groupFileId && !s.file.audit) {
        s.count += changes.length;
        if (s.edits && s.batch.length === changes.length && s.edits.length + s.batch.length <= maxEdits) s.edits.push(...s.batch);
        else s.edits = null;
        s.batch = [];
      }
      if (popup?.id && !s.marks.get(popup.id)?.find()) close();
    });
    cm().on('scroll', () => {if (popup && !popup.pinned) close();});
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('resize', () => {if (popup) place(popup.anchor);});
    window.addEventListener('eagle-context-updated', () => {
      const s = state;
      if (!s || current(s)) return;
      if (s.file === bridge.file() && s.account === bridge.account() && !s.file.audit && !s.file.groupFileId) {
        // A class switch doesn't change ownership of the personal workspace.
        s.scope = bridge.scope();
        s.serial++;
        close();
        refresh();
      } else clear();
    });
    window.addEventListener('eagle-group-annotations-changed', event => {
      if (state?.file.groupFileId === event.detail.fileId) refresh();
    });
    setInterval(refresh, 10000);
  }

  window.EagleEditorAnnotations = {configure, opened, refresh, close, clear, enabled, add, showList, saveInfo, saved};
})();
