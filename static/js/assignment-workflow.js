/* Assignment cards, attachment selection, protected previews, and classroom controls. */
(() => {
  'use strict';
  let bridge, tab = 'current', account = '';
  const expanded = new Set();
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const date = value => value ? new Date(value).toLocaleString() : 'No due date';
  const size = bytes => Number(bytes) >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(Number(bytes || 0) / 1024)} KB`;
  const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const submitted = a => !!a.studentSubmissionSummary?.submittedAt && !a.studentSubmissionSummary.withdrawn;
  let highlights = true;
  const editorMarks = [];
  function setHighlights(value) {
    highlights = value;
    document.body?.classList?.toggle('assignment-hide-paste', !value);
    try {localStorage.setItem('eagleide-paste-highlights',value ? '1' : '0');} catch {}
  }
  function highlightSource(content, ranges) {
    let cursor = 0, html = '';
    for (const [start,end] of ranges || []) {
      if (start < cursor || end > content.length) continue;
      html += esc(content.slice(cursor,start)) + `<mark class="assignment-pasted-text">${esc(content.slice(start,end))}</mark>`;
      cursor = end;
    }
    return html + esc(content.slice(cursor));
  }
  function clearEditorHighlights() {editorMarks.splice(0).forEach(mark => mark.clear());}
  function highlightEditor(ranges) {
    clearEditorHighlights();
    const cm = window.eagleEditor;
    cm?.operation(() => (ranges || []).forEach(([start,end]) => editorMarks.push(cm.markText(cm.posFromIndex(start),cm.posFromIndex(end),{className:'assignment-pasted-text'}))));
  }
  function teacherToolbar(a, owner) {
    return `<div class="assignment-review-tools">${owner ? `<button type="button" class="btn secondary assignment-extension-requests">Extension requests${a.pendingExtensionRequests ? ` <span class="assignment-request-count">${a.pendingExtensionRequests}</span>` : ''}</button><button type="button" class="btn secondary assignment-extend">Grant extension</button>` : ''}${a.quiz?.questions?.some(q => ['written','written_code'].includes(q.type)) ? '<button type="button" class="btn secondary assignment-grade-question">Grade written responses by question</button>' : ''}<label><input type="checkbox" class="assignment-paste-toggle" ${highlights ? 'checked' : ''}> Highlight pasted text</label></div>`;
  }
  function extendStudent(a, email = '') {
    const roster = bridge.roster(a.targetClassId);
    const m = modal('Grant extension', `<p>Enter school days. Use 0 to reopen submissions through today’s dismissal.</p><label>Student<select class="extension-student">${roster.map(s => `<option value="${esc(s.email)}" ${email === s.email ? 'selected' : ''}>${esc([s.first_name ?? s.name,s.last_name].filter(Boolean).join(' ') || s.email)}</option>`).join('')}</select></label><label>School days<input class="extension-days" type="number" min="0" max="365" step="1" value="1" required></label><p class="extension-current"></p><p role="status"></p><div class="modal-actions"><button type="button" class="btn secondary extension-remove">Revoke extension</button><button type="button" class="btn run extension-save">Preview deadline</button></div>`);
    const student = m.root.querySelector('.extension-student');
    const update = () => {const until=a.studentExtensions?.[student.value]?.until; m.root.querySelector('.extension-current').textContent = until ? `Current make-up deadline: ${date(until)}` : 'No individual make-up deadline.';};
    student.onchange = update; update();
    const save = async (action, days) => {
      const buttons = m.root.querySelectorAll('.modal-actions button'); buttons.forEach(b => b.disabled=true);
      try {
        const payload = {assignmentId:a.id, studentEmail:student.value, days};
        if (action === 'grant' && !await confirmExtension(payload)) return;
        await mutate('/api/assignments/extend-student',{...payload, action}); m.close(); await bridge.reloadAssignments();
      } catch(error) {m.root.querySelector('[role="status"]').textContent=error.message;}
      finally {buttons.forEach(b => b.disabled=false);}
    };
    m.root.querySelector('.extension-save').onclick = () => {const input=m.root.querySelector('.extension-days'); if(input.reportValidity()) save('grant', Number(input.value));};
    m.root.querySelector('.extension-remove').onclick = () => save('revoke');
  }

  function classDate(value, zone) {
    if (!value) return 'No due date';
    return new Intl.DateTimeFormat(undefined, {dateStyle:'medium', timeStyle:'short', ...(zone ? {timeZone:zone} : {})}).format(new Date(value));
  }

  async function confirmExtension(payload) {
    const preview = await mutate('/api/assignments/extend-student', {...payload, action:'preview'});
    const zone = preview.timeZone;
    return confirm(`Reopen through ${classDate(preview.extension.until, zone)}${zone ? ` (${zone})` : ''}?\n${preview.submissionWindowMessage || 'Submission is available through this deadline.'}`);
  }

  function requestExtension(a) {
    if (!a) return;
    const m = modal(`Request extension · ${a.name}`, '<form class="assignment-extension-form"><label>School days<input name="days" type="number" min="0" max="365" step="1" value="1" required></label><p>Use 0 to request the rest of today’s school day.</p><label>Reason<textarea name="reason" rows="4" maxlength="500" required></textarea></label><p role="status"></p><div class="modal-actions"><button class="btn run" type="submit">Send request</button></div></form>');
    const form = m.root.querySelector('form');
    const auth = JSON.stringify(bridge.studentHeaders());
    form.onsubmit = async event => {
      event.preventDefault();
      if (auth !== JSON.stringify(bridge.studentHeaders())) return m.close();
      const button = form.querySelector('button');
      button.disabled = true;
      try {
        await mutate('/api/assignments/extension-requests', {assignmentId:a.id, days:Number(form.elements.days.value), reason:form.elements.reason.value}, true);
        m.close();
        if (auth === JSON.stringify(bridge.studentHeaders())) await bridge.reloadAssignments();
      } catch (error) {
        form.querySelector('[role="status"]').textContent = error.message;
        button.disabled = false;
      }
    };
  }

  async function reviewExtensions(a) {
    const m = modal(`Extension requests · ${a.name}`, '<div class="assignment-request-list" aria-live="polite">Loading requests…</div>');
    const host = m.root.querySelector('.assignment-request-list');
    const headers = bridge.managerHeaders(), auth = JSON.stringify(headers);
    const valid = () => m.root.isConnected && auth === JSON.stringify(bridge.managerHeaders());
    try {
      const {requests} = await json(`/api/assignments/extension-requests?${new URLSearchParams({assignmentId:a.id})}`, {headers});
      if (!valid()) return;
      host.innerHTML = requests.map((row, index) => `<article class="assignment-request"><div><strong>${esc(row.name)}</strong><span>${esc(row.status)} · ${esc(date(row.requestedAt))}</span></div><p>${esc(row.reason)}</p>${row.status === 'pending' && !a.gradingCompletedAt
        ? `<form data-request="${index}"><label>School days<input name="days" type="number" min="0" max="365" step="1" value="${row.days}" required></label><button type="submit" class="btn run">Approve</button><button type="button" class="btn secondary assignment-request-deny">Deny</button><span role="status"></span></form>`
        : `<small>${row.status === 'approved' ? `Approved for ${row.approvedDays} school days · ${esc(date(row.until))}` : `${row.days} school days requested`}</small>`}</article>`).join('') || '<p>No extension requests yet.</p>';
      host.querySelectorAll('form').forEach(form => {
        const row = requests[Number(form.dataset.request)];
        const decide = async action => {
          if (!valid()) return;
          const buttons = form.querySelectorAll('button');
          buttons.forEach(button => button.disabled = true);
          const payload = {assignmentId:a.id, studentEmail:row.studentEmail, requestId:row.id, days:Number(form.elements.days.value)};
          try {
            if (action === 'approve' && !await confirmExtension(payload)) return;
            if (!valid()) return;
            await mutate('/api/assignments/extend-student', {...payload, action});
            if (!valid()) return;
            form.replaceWith(Object.assign(document.createElement('p'), {textContent:action === 'approve' ? 'Extension approved' : 'Extension denied'}));
            await bridge.reloadAssignments();
          } catch(error) {
            if (valid()) form.querySelector('[role="status"]').textContent = error.message;
          } finally {
            buttons.forEach(button => button.disabled = false);
          }
        };
        form.onsubmit = event => { event.preventDefault(); decide('approve'); };
        form.querySelector('.assignment-request-deny').onclick = () => decide('deny');
      });
    } catch(error) {
      if (valid()) host.textContent = error.message;
    }
  }

  async function json(url, options = {}) {
    const response = await bridge.request(url, options);
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || 'The assignment request could not be completed.');
    return result;
  }
  const mutate = (url, value, student = false) => json(url, {method:'POST', headers:{'Content-Type':'application/json', ...(student ? bridge.studentHeaders() : bridge.managerHeaders())}, body:JSON.stringify(value)});

  function modal(title, body, className = '') {
    const previous = document.activeElement;
    const root = document.createElement('div'); root.className = `modal glass-modal assignment-workflow-modal ${className}`;
    root.innerHTML = `<div class="modal-content" role="dialog" aria-modal="true" aria-label="${esc(title)}"><header class="assignment-modal-header"><h3>${esc(title)}</h3><button type="button" class="btn secondary assignment-modal-close">Close</button></header>${body}</div>`;
    document.body.append(root);
    const cleanups = [], lifecycle = {};
    const close = () => {if(lifecycle.beforeClose && !lifecycle.beforeClose()) return; cleanups.forEach(fn => fn()); root.remove(); if (previous?.isConnected) previous.focus();};
    root.querySelector('.assignment-modal-close').onclick = close;
    root.onclick = event => {if (event.target === root) close();};
    root.addEventListener('keydown', event => {
      if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); close();}
      if (event.key !== 'Tab') return;
      const focusable = [...root.querySelectorAll('button, input, select, textarea, a[href], summary')].filter(el => !el.disabled && el.offsetParent !== null);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {event.preventDefault(); last?.focus();}
      if (!event.shiftKey && document.activeElement === last) {event.preventDefault(); first?.focus();}
    });
    root.querySelector('.assignment-modal-close').focus();
    return Object.assign(lifecycle,{root, close, cleanups});
  }

  function card(a, canSubmit) {
    const s = a.studentSubmissionSummary, id = a.id || a.name;
    const past = a.isPast ?? !a.active;
    const mayAttempt = !past || a.deadlineOpen;
    const total = s?.totalScore ?? s?.codeScore;
    return `<details class="assignment-card student-assignment-card ${past ? 'is-past' : ''}" data-assignment-id="${esc(id)}" ${expanded.has(id) ? 'open' : ''}>
      <summary><span class="assignment-title-copy"><strong>${submitted(a) ? '<span class="assignment-submitted-check" aria-label="Submitted">✓</span> ' : ''}${esc(a.name)}</strong><span class="assignment-title-due">${a.dueAt ? `Due ${esc(classDate(a.dueAt, a.timeZone))}` : 'No due date'}</span></span>${s ? `<span class="assignment-card-state">${s.withdrawn ? 'Un-submitted by teacher' : total != null ? `${esc(total)} / ${bridge.maxScore(a)}` : 'Submitted'}</span>` : ''}</summary>
      <div class="assignment-card-body">
        ${a.accommodationNote ? `<p class="assignment-accommodation-note">${esc(a.accommodationNote)}</p>` : ''}
        ${a.controlledFilePath ? `<button type="button" class="btn secondary assignment-open-controlled" data-path="${esc(a.controlledFilePath)}">Open original assignment file</button>` : ''}
        <div class="task assignment-markdown" data-assignment-markdown="${esc(id)}">${esc(a.task || '(No task description)')}</div>
        <div class="meta">Maximum score: ${bridge.maxScore(a)}${a.maxFileSubmissions ? ` · File attempts: ${s?.fileSubmissionCount || 0} / ${a.maxFileSubmissions}` : ''}</div>
        ${a.quiz?.questions?.length ? `<div class="meta">Questions: ${s?.quizAnsweredCount || 0} / ${a.quiz.questions.length} answered${a.quizSettings?.maxSubmissions ? ` · ${a.quizSettings.maxSubmissions} quiz attempt(s)` : ''}</div>` : ''}
        ${(a.skillTags || []).length ? `<div class="skill-tags">${a.skillTags.map(tag => `<span class="skill-chip">${esc(tag)}</span>`).join('')}</div>` : ''}
        ${mayAttempt && a.submissionWindowMessage ? `<p class="assignment-window-note ${a.submissionWindowOpen ? '' : 'is-closed'}">${esc(a.submissionWindowMessage)}</p>` : ''}
        ${s?.aiFeedback ? `<details class="assignment-feedback-details"><summary>View teacher feedback</summary>${bridge.feedback(s.aiFeedback, {audience:'student'})}</details>` : ''}
        <div class="assignment-actions">
          ${s ? `<button type="button" class="btn secondary view-student-submission-btn" data-id="${esc(id)}">View submission</button><button type="button" class="btn secondary view-score-report-btn" data-id="${esc(id)}">Score report</button>` : ''}
          ${mayAttempt && a.allowFileSubmission !== false ? `<button type="button" class="btn run submit-assignment-btn" data-id="${esc(id)}" ${canSubmit && a.canSubmitFiles !== false ? '' : 'disabled'}>${submitted(a) ? 'Turn in again' : 'Turn in'}</button>` : ''}
          ${mayAttempt && a.quiz?.questions?.length ? `<button type="button" class="btn secondary open-questions-btn" data-id="${esc(id)}" ${canSubmit && a.canSubmit !== false ? '' : 'disabled'}>${a.assignmentType === 'lab_report' ? 'Open lab report' : `Questions (${a.quiz.questions.length})`}</button>` : ''}
          ${!a.gradingCompletedAt && a.releasedAt && a.extensionRequest?.status !== 'pending' ? `<button type="button" class="btn secondary assignment-request-extension" data-id="${esc(id)}">Request extension</button>` : ''}
        </div>
        ${a.extensionRequest ? `<p class="assignment-extension-state" role="status">Extension request ${esc(a.extensionRequest.status)}${a.extensionRequest.status === 'approved' ? ` · through ${esc(date(a.extensionRequest.until))}` : ''}</p>` : ''}
      </div></details>`;
  }

  function bindStudent(root) {
    root.querySelectorAll('.assignment-open-controlled').forEach(button => button.onclick = () => bridge.openPath(button.dataset.path));
    root.querySelectorAll('.student-assignment-card').forEach(detail => detail.addEventListener('toggle', () => {if (detail.open) expanded.add(detail.dataset.assignmentId); else expanded.delete(detail.dataset.assignmentId);}));
    root.querySelectorAll('.submit-assignment-btn').forEach(button => button.onclick = () => submitDialog(button.dataset.id));
    root.querySelectorAll('.assignment-request-extension').forEach(button => button.onclick = () => requestExtension(bridge.assignment(button.dataset.id)));
    root.querySelectorAll('.view-student-submission-btn').forEach(button => button.onclick = () => openFiles(button.dataset.id));
    root.querySelectorAll('.open-questions-btn').forEach(button => button.onclick = () => bridge.questions(button.dataset.id));
    root.querySelectorAll('.view-score-report-btn').forEach(button => button.onclick = () => bridge.scoreReport(button.dataset.id));
    document.querySelectorAll('[data-student-assignment-tab]').forEach(button => {
      const active = button.dataset.studentAssignmentTab === tab;
      button.setAttribute('aria-selected', String(active)); button.classList.toggle('active', active);
      button.setAttribute('tabindex', active ? '0' : '-1');
      button.onclick = () => {tab = button.dataset.studentAssignmentTab; bridge.renderStudent();};
      button.onkeydown = event => {
        if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
        event.preventDefault();
        tab = event.key === 'Home' ? 'current' : event.key === 'End' ? 'past' : tab === 'current' ? 'past' : 'current';
        bridge.renderStudent();
        document.querySelector(`[data-student-assignment-tab="${tab}"]`)?.focus();
      };
    });
  }

  function submitDialog(reference) {
    const a = bridge.assignment(reference);
    if (!a || !bridge.studentHeaders()['X-User-Token']) return;
    if (a.allowFileSubmission === false || a.canSubmitFiles === false) return alert(a.submissionWindowMessage || 'Submissions are currently unavailable.');
    const files = bridge.files().filter(f => !f.in_trash && !String(f.path).startsWith('Trash/'));
    const open = bridge.openFile();
    const selected = files.some(f => f.path === open?.path) ? open.path : files[0]?.path;
    const multi = !!a.allowMultiFileSubmission;
    const m = modal(`Turn in · ${a.name}`, `<p>Choose ${multi ? 'the files' : 'one file'} to turn in. Available edit history and pasted-text marks travel with submitted workspace files.</p>
      ${multi ? `<div class="assignment-file-choices">${files.map(f => `<label><input type="checkbox" name="workspaceFile" value="${esc(f.path)}" ${f.path === selected ? 'checked' : ''}><span>${esc(f.path)}</span><small>${size(f.size)}</small></label>`).join('') || '<p>No workspace files yet. You can upload attachments below.</p>'}</div>` : `<label for="assignmentFileSelect">Workspace file</label><select id="assignmentFileSelect"><option value="">Choose a file or upload below</option>${files.map(f => `<option value="${esc(f.path)}" ${f.path === selected ? 'selected' : ''}>${esc(f.path)}</option>`).join('')}</select>`}
      <label class="assignment-upload-label">${multi ? 'Add attachments' : 'Or upload a file'}<input type="file" id="assignmentUploadFiles" ${multi ? 'multiple' : ''}></label>
      <small>${multi ? 'Up to 20 files and 25 MB total. ' : ''}Uploads may total up to 15 MB.</small>
      ${a.quiz?.questions?.length ? `<p class="meta">Questions answered ${a.studentSubmissionSummary?.quizAnsweredCount || 0} of ${a.quiz.questions.length}. ${a.studentSubmissionSummary?.quizComplete ? 'Answers are saved.' : 'You can finish the questions after turning in your files.'}</p>` : ''}
      <p class="assignment-dialog-status" role="status"></p><div class="modal-actions"><button type="button" class="btn run assignment-submit-selected">Turn in</button></div>`, 'assignment-submit-dialog');
    const status = m.root.querySelector('[role="status"]'), button = m.root.querySelector('.assignment-submit-selected');
    if (!multi) {
      const select = m.root.querySelector('#assignmentFileSelect'), upload = m.root.querySelector('#assignmentUploadFiles');
      select.onchange = () => {if (select.value) upload.value = '';};
      upload.onchange = () => {if (upload.files.length) select.value = '';};
    }
    const auth = JSON.stringify(bridge.studentHeaders());
    button.onclick = async () => {
      const uploads = [...(m.root.querySelector('#assignmentUploadFiles')?.files || [])];
      const paths = multi ? [...m.root.querySelectorAll('[name="workspaceFile"]:checked')].map(input => input.value) : uploads.length ? [] : [m.root.querySelector('#assignmentFileSelect')?.value].filter(Boolean);
      if (!paths.length && !uploads.length) {status.textContent = 'Choose at least one file.'; return;}
      if (paths.length + uploads.length > 20 || uploads.reduce((sum, f) => sum + f.size, 0) > 15 * 1024 * 1024) {status.textContent = 'Choose at most 20 files, with uploaded attachments totaling at most 15 MB.'; return;}
      button.disabled = true; status.textContent = 'Saving and submitting…';
      try {
        if (auth !== JSON.stringify(bridge.studentHeaders())) throw new Error('Your account changed. Reopen the submission menu.');
        window.WorkspaceHistory?.flush();
        if (paths.includes(bridge.openFile()?.path) && !await bridge.save()) throw new Error('Your current file could not be saved. Save your edits before submitting.');
        if (auth !== JSON.stringify(bridge.studentHeaders())) throw new Error('Your account changed. Reopen the submission menu.');
        const payload = {assignmentId:a.id, classId:a.targetClassId, filePaths:paths};
        if (uploads.length) {
          const form = new FormData(); form.append('payload', JSON.stringify(payload)); uploads.forEach(file => form.append('files',file));
          await json('/api/assignments/submit', {method:'POST', headers:bridge.studentHeaders(), body:form});
        } else await mutate('/api/assignments/submit', payload, true);
        if (auth !== JSON.stringify(bridge.studentHeaders())) return m.close();
        m.close(); await bridge.reloadAssignments();
        const refreshed = bridge.assignment(a.id);
        if (refreshed?.canSubmit && refreshed.quiz?.questions?.length && !refreshed.studentSubmissionSummary?.quizComplete) await bridge.questions(a.id);
      } catch (error) {status.textContent = error.message; button.disabled = false;}
    };
  }

  const submissionFilesMarkup = '<div class="assignment-version-control"></div><div class="assignment-submission-layout"><nav class="assignment-submission-files" aria-label="Submitted files"></nav><section class="assignment-submission-preview" aria-live="polite">Loading submission…</section></div><div class="assignment-submitted-answers"></div>';
  function openFiles(reference, studentEmail = '', fileId = '') {
    const a = bridge.assignment(reference) || {id:reference, name:'Assignment'};
    const m = modal(`${a.name} · Submission`, submissionFilesMarkup, 'assignment-files-dialog');
    return loadSubmissionFiles(a, studentEmail, fileId, m);
  }

  function mountReviewFiles(root, a, submission, fileId, canPlay) {
    root.hidden = false;
    root.innerHTML = submissionFilesMarkup;
    const cleanups = [];
    loadSubmissionFiles(a, submission.email, fileId, {root, cleanups, canPlay}, submission.revisionId || '');
    return () => {
      cleanups.forEach(cleanup => cleanup());
      root.hidden = true;
      root.replaceChildren();
    };
  }

  async function loadSubmissionFiles(a, studentEmail, fileId, m, reviewRevision = null) {
    const teacher = !!studentEmail;
    const headers = teacher ? bridge.managerHeaders() : bridge.studentHeaders();
    const auth = JSON.stringify(headers);
    let revision = '', sequence = 0, objectUrl = '', disposed = false;
    const preview = m.root.querySelector('.assignment-submission-preview');
    const params = extra => new URLSearchParams({assignmentId:a.id, ...(teacher ? {studentEmail} : {}), ...(revision ? {revisionId:revision} : {}), ...extra});
    const valid = () => !disposed && m.root.isConnected && auth === JSON.stringify(teacher ? bridge.managerHeaders() : bridge.studentHeaders());
    const release = () => {if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = '';};
    m.cleanups.push(() => {disposed = true; sequence++; release();});
    async function download(f) {
      const response = await bridge.request(`/api/assignments/submission-file?${params({fileId:f.id, download:'1'})}`, {headers});
      if (!response.ok) throw new Error('Could not download attachment.');
      const blob = await response.blob(); if (!valid()) return;
      const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = f.name;
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    async function show(f, cursor = 0) {
      if (m.canPlay) disposeEditorDevelopment();
      const request = ++sequence;
      release(); preview.textContent = 'Loading file…';
      try {
        const result = await json(`/api/assignments/submission-file?${params({fileId:f.id, cursor:String(cursor)})}`, {headers});
        if (request !== sequence || !valid()) return;
        preview.innerHTML = `<div class="assignment-file-preview-header"><strong>${esc(f.name)}</strong><div class="assignment-preview-actions">${teacher && !m.canPlay && !a.gradingCompletedAt ? '<button type="button" class="btn secondary attachment-history">Edit history</button>' : ''}<button type="button" class="btn secondary attachment-download">Download</button></div></div>`;
        preview.querySelector('.attachment-download').onclick = () => download(f).catch(error => alert(error.message));
        const historyButton = preview.querySelector('.attachment-history');
        if (historyButton) historyButton.onclick = () => openDevelopment(a, studentEmail, revision, f.id);
        if (result.kind === 'text') {
          let content = result.content || '';
          if (!result.pasteRanges?.length && f.name.toLowerCase().endsWith('.json')) {try {content = JSON.stringify(JSON.parse(content), null, 2);} catch {}}
          const pre = document.createElement('pre'); pre.className = 'assignment-file-source'; pre.innerHTML = highlightSource(content,teacher ? result.pasteRanges : []); preview.append(pre);
        } else if (result.kind === 'csv') {
          const wrap = document.createElement('div'); wrap.className = 'assignment-csv-preview';
          wrap.innerHTML = `<table><thead><tr>${result.header.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${result.rows.map(row => `<tr>${row.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
          preview.append(wrap);
          const next = document.createElement('button'); next.type = 'button'; next.className = 'btn secondary'; next.textContent = 'Next rows'; next.disabled = result.nextCursor === null;
          next.onclick = () => show(f,result.nextCursor); preview.append(next);
          if (cursor) {const first = document.createElement('button'); first.type = 'button'; first.className = 'btn secondary'; first.textContent = 'First rows'; first.onclick = () => show(f,0); preview.append(first);}
        } else if (result.kind === 'image') {
          const response = await bridge.request(`/api/assignments/submission-file?${params({fileId:f.id, download:'1'})}`, {headers});
          if (!response.ok) throw new Error('Could not load image.');
          const blob = await response.blob(); if (request !== sequence || !valid()) return;
          objectUrl = URL.createObjectURL(blob); const img = document.createElement('img'); img.src = objectUrl; img.alt = f.name; preview.append(img);
        } else {const p = document.createElement('p'); p.textContent = result.message; preview.append(p);}
        m.root.querySelectorAll('[data-submitted-file]').forEach(button => button.classList.toggle('active',button.dataset.submittedFile === f.id));
        if (revision && m.canPlay?.()) {
          const clip = {revision, attachment:f.id, legacyFallback:!!a.fileControl};
          const source = document.createElement('pre');
          source.className = 'assignment-file-source assignment-history-frame';
          attachEditorDevelopment(a, studentEmail, {
            clip: () => clip,
            valid: file => request === sequence && valid() && m.canPlay(file),
            render(content, frame, follow) {
              source.innerHTML = highlightSource(content, frame.pasteRanges);
              if (!source.isConnected) preview.append(source);
              preview.classList.add('is-history');
              if (follow) followSource(source, content, frame.from + frame.insert.length);
            },
            restore() {
              source.remove();
              preview.classList.remove('is-history');
            },
          });
        }
      } catch (error) {if (request === sequence && valid()) preview.textContent = error.message;}
    }
    async function load(version = '') {
      revision = version; const request = ++sequence; preview.textContent = 'Loading submission…';
      try {
        const data = await json(`/api/assignments/submission-files?${params({})}`, {headers});
        if (!valid() || request !== sequence || version !== revision) return;
        revision = data.revisionId || '';
        const control = m.root.querySelector('.assignment-version-control');
        if (reviewRevision === null) {
          control.innerHTML = teacher ? `<label>Submission version<select aria-label="Submission version"><option value="${esc(data.latestRevisionId || '')}">Latest submission</option>${data.history.map((h,i) => `<option value="${esc(h.revisionId)}">Previous ${i+1} · ${esc(h.submittedAt || 'Unknown time')}</option>`).join('')}</select></label>` : `<p>Submitted ${esc(data.submittedAt || '—')} · Read-only copy</p>`;
        }
        const select = control.querySelector('select'); if (select) {select.value = revision; select.onchange = () => load(select.value);}
        const files = m.root.querySelector('.assignment-submission-files');
        files.innerHTML = data.files.map(f => `<button type="button" class="assignment-submitted-file" data-submitted-file="${esc(f.id)}"><span>${esc(f.name)}</span><small>${size(f.size)}</small></button>`).join('');
        files.hidden = !data.files.length;
        files.querySelectorAll('button').forEach(button => button.onclick = () => show(data.files.find(f => f.id === button.dataset.submittedFile)));
        const answers = m.root.querySelector('.assignment-submitted-answers');
        answers.innerHTML = data.quizResponses.length ? `<h4>Submitted question answers</h4>${data.quizResponses.map(r => {const q=a.quiz?.questions?.find(q => q.id === r.questionId); const answer = q?.options && typeof r.answer === 'number' ? q.options[r.answer] : r.answer; return `<details><summary>${esc(q?.question || r.questionId)}</summary><pre>${esc(answer ?? '')}</pre></details>`;}).join('')}` : '';
        if (data.files.length) await show(data.files.find(f => f.id === fileId) || data.files[0]);
        else preview.textContent = data.quizResponses.length ? 'Question answers are shown below.' : 'No files or answers in this submission.';
      } catch (error) {if (valid() && request === sequence) preview.textContent = error.message;}
    }
    await load(reviewRevision || '');
  }

  function gradeByQuestion(a) {
    const questions = (a.quiz?.questions || []).filter(q => ['written','written_code'].includes(q.type));
    if (!questions.length) return;
    const headers = JSON.stringify(bridge.managerHeaders());
    const roster = [...bridge.roster(a.targetClassId)].sort((x,y) => String(x.last_name || '').localeCompare(String(y.last_name || '')) || String(x.first_name ?? x.name ?? '').localeCompare(String(y.first_name ?? y.name ?? '')));
    const m = modal(`${a.name} · Written responses`, '<div class="question-grading-nav"><button type="button" class="btn secondary question-previous">← Previous</button><label>Question<select class="question-select"></select></label><button type="button" class="btn secondary question-next">Next →</button></div><div class="question-grading-prompt"></div><div class="question-grading-responses"></div>', 'question-grading-dialog');
    const select = m.root.querySelector('.question-select');
    select.innerHTML = questions.map((q,i) => `<option value="${i}">Question ${i+1} · ${esc(q.question.slice(0,70))}</option>`).join('');
    const pending = new Set();
    const submissions = new Map((a.submissions || []).map(s => [s.email?.toLowerCase(),s]));
    let changed = false;
    m.beforeClose = () => !m.root.querySelector('[data-score-dirty="true"]') || confirm('Discard unsaved scores?');
    m.cleanups.push(() => {Promise.allSettled([...pending]).then(() => {if(changed && headers === JSON.stringify(bridge.managerHeaders())) bridge.reloadAssignments();});});
    const render = () => {
      const index = Number(select.value), q = questions[index];
      m.root.querySelector('.question-previous').disabled = index === 0;
      m.root.querySelector('.question-next').disabled = index === questions.length - 1;
      m.root.querySelector('.question-grading-prompt').innerHTML = `<h4>${esc(q.question)}</h4><span>${q.points} points · ${index+1} of ${questions.length}</span>${q.codeSnippet ? `<pre>${esc(q.codeSnippet)}</pre>` : ''}`;
      const host = m.root.querySelector('.question-grading-responses');
      host.textContent = '';
      for (const student of roster) {
        const candidate = submissions.get(student.email?.toLowerCase());
        const sub = candidate?.withdrawn ? null : candidate;
        const response = sub?.quizResponses?.find(r => r.questionId === q.id);
        const row = document.createElement('section'); row.className = 'question-grading-row';
        row.innerHTML = `<h5>${esc([student.first_name ?? student.name,student.last_name].filter(Boolean).join(' ') || student.email)}</h5><pre class="question-grading-answer">${esc(response ? response.answer ?? '' : 'Not submitted')}</pre>${response ? `<div class="question-score-options"><button type="button" class="btn secondary" data-score="0">0</button><button type="button" class="btn secondary" data-score="${q.points/2}">Half · ${q.points/2}</button><button type="button" class="btn secondary" data-score="${q.points}">Full · ${q.points}</button><label>Score<input type="number" min="0" max="${q.points}" step="any" value="${response.manualScore ?? response.pointsEarned ?? ''}" aria-label="Score for ${esc(student.name || student.email)}"></label><button type="button" class="btn secondary question-score-save">Save</button><span role="status"></span></div>` : ''}`;
        host.append(row);
        if (!response) continue;
        const input = row.querySelector('input'), status = row.querySelector('[role="status"]');
        const graded = () => response.manualScore != null || response.aiScore != null;
        const selection = () => row.querySelectorAll('[data-score]').forEach(button => button.setAttribute('aria-pressed', String(graded() && input.value !== '' && Number(button.dataset.score) === Number(input.value))));
        status.textContent = graded() ? 'Saved' : 'Not graded';
        selection();
        const save = async score => {
          if (headers !== JSON.stringify(bridge.managerHeaders())) {status.textContent='Account changed. Reopen grading.'; return;}
          if (score === null || !Number.isFinite(score) || score < 0 || score > q.points) {status.textContent=`Enter 0 to ${q.points}.`; return;}
          const controls = row.querySelectorAll('button,input'); controls.forEach(el => el.disabled=true); status.textContent='Saving…';
          select.disabled=true;
          m.root.querySelector('.question-previous').disabled=true;
          m.root.querySelector('.question-next').disabled=true;
          const job = mutate('/api/quiz/score-question',{assignmentId:a.id,studentEmail:student.email,questionId:q.id,manualScore:score,revisionId:sub.revisionId});
          pending.add(job);
          try {
            const result = await job; changed=true;
            response.manualScore=score; response.pointsEarned=result.pointsEarned; sub.quizScore=result.quizScore; sub.totalScore=result.totalScore;
            input.value=String(score); row.dataset.scoreDirty='false'; selection(); status.textContent='Saved';
          } catch(error) {status.textContent=error.message;}
          finally {
            pending.delete(job); controls.forEach(el => el.disabled=false);
            if (!pending.size) {
              select.disabled=false;
              m.root.querySelector('.question-previous').disabled=Number(select.value) === 0;
              m.root.querySelector('.question-next').disabled=Number(select.value) === questions.length - 1;
            }
          }
        };
        row.querySelectorAll('[data-score]').forEach(button => button.onclick = () => save(Number(button.dataset.score)));
        row.querySelector('.question-score-save').onclick = () => {if(input.reportValidity()) save(input.value === '' ? null : Number(input.value));};
        input.onkeydown = event => {if(event.key === 'Enter') {event.preventDefault(); row.querySelector('.question-score-save').click();}};
        input.oninput = () => {row.dataset.scoreDirty='true'; status.textContent='Unsaved score — choose Save';};
      }
    };
    const confirmDrafts = () => !m.root.querySelector('[data-score-dirty="true"]') || confirm('Discard unsaved scores for this question?');
    let selected = 0;
    select.onchange = () => {if(!confirmDrafts()) {select.value=String(selected); return;} selected=Number(select.value); render();};
    m.root.querySelector('.question-previous').onclick = () => {if(confirmDrafts()) {select.value=String(--selected); render();}};
    m.root.querySelector('.question-next').onclick = () => {if(confirmDrafts()) {select.value=String(++selected); render();}};
    render();
  }

  function teacherFiles(a, sub) {
    const files = sub.files || (sub.submissionPath ? [{id:'legacy', name:sub.submittedFileName}] : []);
    return `<div class="assignment-teacher-file-list">${files.map(f => `<button type="button" class="btn secondary assignment-view-file" data-email="${esc(sub.email)}" data-file="${esc(f.id)}">${esc(f.name)}</button>`).join('') || '—'}</div>${sub.history?.length ? `<button type="button" class="btn secondary assignment-view-history" data-email="${esc(sub.email)}">History (${sub.history.length} previous)</button>` : ''}`;
  }
  function bindTeacher(root, a, owner) {
    root.querySelectorAll('.assignment-development-open').forEach(button => button.onclick = () => openDevelopment(a, button.dataset.email || ''));
    root.querySelector('.assignment-grading-complete')?.addEventListener('click', async event => {
      if (!owner || !confirm('Finalize grading? Submissions close now and edit history is scheduled for deletion within three days. Submitted work, grades and feedback stay available.')) return;
      event.target.disabled = true;
      try {await mutate('/api/assignments/grading-complete', {assignmentId:a.id}); root.dataset.forceRefresh='true'; await bridge.reloadAssignments();}
      catch(error) {alert(error.message); event.target.disabled=false;}
    });
    root.querySelector('.assignment-extend')?.addEventListener('click', () => extendStudent(a));
    root.querySelector('.assignment-extension-requests')?.addEventListener('click', () => reviewExtensions(a));
    root.querySelectorAll('.assignment-extend-student').forEach(button => button.onclick = () => extendStudent(a,button.dataset.email));
    root.querySelector('.assignment-grade-question')?.addEventListener('click', () => gradeByQuestion(a));
    root.querySelector('.assignment-paste-toggle')?.addEventListener('change', event => setHighlights(event.target.checked));
    root.querySelectorAll('.assignment-view-file').forEach(button => button.onclick = () => bridge.reviewSubmission(a.id || a.name, button.dataset.email, button.dataset.file));
    root.querySelectorAll('.assignment-view-history').forEach(button => button.onclick = () => openFiles(a.id,button.dataset.email));
    root.querySelectorAll('.assignment-edit-feedback').forEach(button => button.onclick = () => editFeedback(a,button.dataset.email));
    root.querySelectorAll('.assignment-unsubmit').forEach(button => button.onclick = async () => {
      if (!owner) return;
      button.disabled = true;
      const sub = a.submissions.find(s => s.email === button.dataset.email);
      try {await mutate('/api/assignments/unsubmit',{assignmentId:a.id,studentEmail:button.dataset.email,revisionId:sub?.revisionId}); await bridge.reloadAssignments();}
      catch(error) {alert(error.message); button.disabled = false;}
    });
  }
  function developmentControls(compact = false) {
    const summary = '<p class="development-summary" role="status">Loading history…</p>';
    const options = '<label>Speed<select class="development-speed"><option value="1">1×</option><option value="5">5×</option><option value="20">20×</option></select></label><label><input type="checkbox" class="development-skip" checked> Skip idle gaps over 5 seconds</label><label><input type="checkbox" class="development-follow" checked> Follow edits</label>';
    const note = '<small class="development-note">Playback shows sampled edits and saved checkpoints. Highlighted text was pasted in the editor. The timeline can include gaps.</small>';
    return `${compact ? '' : summary}
      <div class="development-controls"><button type="button" class="btn run development-play" disabled>Play</button><button type="button" class="btn secondary development-previous" aria-label="Previous change" disabled>←</button><button type="button" class="btn secondary development-next" aria-label="Next change" disabled>→</button>${compact ? '' : options}</div>
      <label class="development-seek-label"><span class="${compact ? 'sr-only' : ''}">Edit timeline</span><input type="range" class="development-seek" min="1" max="1" value="1" step="1" disabled></label>
      ${compact ? `<button type="button" class="btn secondary development-submitted">Show submitted</button><details class="development-options"><summary>Playback options</summary><div>${options}<button type="button" class="btn secondary development-refresh">Refresh history</button>${summary}${note}</div></details>` : ''}
      <div class="development-caption">
        <div class="development-time-legend" aria-label="Timeline colors"><span class="development-in-class">In class</span><span class="development-outside-class">Outside class</span><span>Schedule unavailable</span></div>
        <div class="development-position" aria-live="polite"></div>
      </div>
      ${compact ? '' : note}`;
  }
  function completionHint(first, last) {
    const minutes = Math.max(0, (Date.parse(last) - Date.parse(first)) / 60000);
    return Number.isFinite(minutes) ? `Completion time hint: ${minutes.toFixed(minutes < 1 ? 2 : 1)} min` : 'Completion time unavailable';
  }
  // Scroll only when the changed position leaves the visible source area. Used by
  // the modal and textarea fallback; CodeMirror handles its own rendered metrics.
  function followSource(source, content, offset) {
    const style = getComputedStyle(source), before = content.slice(0, offset).split('\n');
    const lineHeight = parseFloat(style.lineHeight) || (parseFloat(style.fontSize) || 14) * 1.4;
    const padding = parseFloat(style.paddingTop) || 0;
    const top = padding + (before.length - 1) * lineHeight;
    if (top < source.scrollTop + lineHeight) source.scrollTop = Math.max(0, top - lineHeight);
    else if (top + lineHeight > source.scrollTop + source.clientHeight - lineHeight) source.scrollTop = Math.max(0, top + 2 * lineHeight - source.clientHeight);
    // A canvas gives the monospace editor's real glyph width, including tabs.
    const line = before[before.length - 1].replace(/\t/g, ' '.repeat(parseInt(style.tabSize, 10) || 4));
    const context = document.createElement('canvas').getContext('2d');
    if (context) {
      context.font = style.font;
      const left = (parseFloat(style.paddingLeft) || 0) + context.measureText(line).width;
      if (left < source.scrollLeft + 16) source.scrollLeft = Math.max(0, left - 16);
      else if (left > source.scrollLeft + source.clientWidth - 32) source.scrollLeft = Math.max(0, left + 32 - source.clientWidth);
    }
  }
  function renderEditorFrame(content, frame, follow) {
    clearEditorHighlights();
    const offset = Math.min(content.length, frame.from + frame.insert.length), cm = window.eagleEditor;
    if (cm) {
      const scroll = cm.getScrollInfo();
      const patch = window.AssignmentDevelopment.splice(cm.getValue(), content);
      cm.operation(() => {
        if (patch.delete || patch.insert) cm.replaceRange(patch.insert, cm.posFromIndex(patch.from), cm.posFromIndex(patch.from + patch.delete), 'developmentPlayback');
        cm.clearHistory();
      });
      cm.scrollTo(scroll.left, scroll.top);
      if (follow) cm.scrollIntoView(cm.posFromIndex(offset), 24);
    } else {
      const source = document.getElementById('editor'), top = source.scrollTop, left = source.scrollLeft;
      source.value = content; source.scrollTop = top; source.scrollLeft = left;
      if (follow) followSource(source, content, offset);
    }
    if (frame.pasteRanges?.length) highlightEditor(frame.pasteRanges);
  }

  const timeLabel = frame => frame.classTime === 'inside' ? 'In class' : frame.classTime === 'outside' ? 'Outside class' : 'Schedule unavailable';
  function colorTimeline(seek, marks, total) {
    if (!seek.style) return;
    const colors = {inside:'var(--history-in-class)', outside:'var(--history-outside-class)', unknown:'var(--history-unknown)'};
    const bands = (marks || []).map((mark, index) => {
      const start = 100 * (mark.seq - 1) / total;
      const end = 100 * ((marks[index + 1]?.seq || total + 1) - 1) / total;
      return `${colors[mark.classTime] || colors.unknown} ${start}% ${end}%`;
    });
    if (bands.length) seek.style.setProperty('--history-bands', `linear-gradient(to right,${bands.join(',')})`);
    else seek.style.removeProperty('--history-bands');
  }
  function mountDevelopmentPlayer(root, a, options) {
    const select=root.querySelector('.development-student'), seek=root.querySelector('.development-seek'), play=root.querySelector('.development-play');
    const summary=root.querySelector('.development-summary'), position=root.querySelector('.development-position');
    const previous=root.querySelector('.development-previous'), nextButton=root.querySelector('.development-next');
    const headers=bridge.managerHeaders(), auth=JSON.stringify(headers), cache=new Map(), abort=new AbortController();
    let total=0, current=1, sequence=0, playing=false, timeout=null, selected='', disposed=false, seekTimer, clip;
    const valid=()=>!disposed && root.isConnected && auth===JSON.stringify(bridge.managerHeaders()) && (!options.valid || options.valid());
    const params=extra=>new URLSearchParams({assignmentId:a.id,studentEmail:selected,...extra});
    function requestPage(extra) {
      const endpoint = clip && !clip.legacy ? 'workspace-history' : 'development';
      const attachment = clip ? {revisionId:clip.revision, fileId:clip.attachment} : {};
      return json(`/api/assignments/${endpoint}?${params({...attachment,...extra})}`, {headers,signal:abort.signal});
    }
    const stop=()=>{playing=false; clearTimeout(timeout); play.textContent='Play';};
    const pause=()=>{stop(); sequence++; clearTimeout(seekTimer);};
    async function page(seq) {
      if(!valid()) throw new Error('Review context changed');
      const pageStudent=selected, pageClip=clip;
      for(const entry of cache.values()) if(entry.frames.some(f=>f.seq===seq)) return entry;
      const start=Math.floor((seq-1)/120)*120+1;
      let data=await requestPage({cursor:String(start)});
      if(!valid() || pageStudent!==selected || pageClip!==clip) throw new Error('Review file changed');
      // Large replacements can shorten a page; fetch the requested position directly.
      if(!data.frames.some(f=>f.seq===seq)) data=await requestPage({cursor:String(seq)});
      if(!valid() || pageStudent!==selected || pageClip!==clip) throw new Error('Review file changed');
      cache.set(data.frames[0]?.seq || seq,data);
      while(cache.size>3) cache.delete(cache.keys().next().value);
      return data;
    }
    async function show(seq, schedule=false) {
      if(!valid()) return stop();
      const request=++sequence;
      try {
        const data=await page(seq);
        if(!valid() || request!==sequence) return;
        let content=data.base, frame;
        for(const f of data.frames) {content=window.AssignmentDevelopment.apply(content,f); if(f.seq===seq) {frame=f;break;}}
        if(!frame) return stop();
        if(options.prepare) await options.prepare();
        if(!valid() || request!==sequence) return;
        options.render(content,frame,root.querySelector('.development-follow').checked);
        current=seq; seek.value=String(seq);
        const stamp = classDate(frame.at, frame.timeZone);
        seek.setAttribute('aria-valuetext',`Change ${seq} of ${total}, ${stamp}, ${timeLabel(frame)}`);
        position.textContent=`Change ${seq} / ${total} · ${stamp}${frame.timeZone ? ` (${frame.timeZone})` : ''} · ${timeLabel(frame)} · ${frame.kind==='offline' ? 'Offline edit · device time' : frame.kind==='editor' ? 'Editor sample' : frame.kind==='resync' ? 'Checkpoint after a gap' : 'File checkpoint'} · Received ${classDate(frame.receivedAt, frame.timeZone)}${options.restore ? ' · Read-only history' : ''}`;
        if(schedule && playing) {
          if(seq>=total) return stop();
          const nextData=await page(seq+1);
          if(!valid() || request!==sequence || !playing) return;
          const next=nextData.frames.find(f=>f.seq===seq+1);
          let gap=Math.max(0,Date.parse(next.at)-Date.parse(frame.at));
          if(root.querySelector('.development-skip').checked && gap>5000) gap=1000;
          const speed=Number(root.querySelector('.development-speed').value);
          timeout=setTimeout(()=>show(seq+1,true),Math.max(50,gap/speed));
        }
      } catch(error) {if(valid() && request===sequence) {stop(); position.textContent=error.message;}}
    }
    function restore() {
      pause();
      if(valid()) options.restore?.();
      current=total || 1; seek.value=String(current);
      seek.setAttribute('aria-valuetext','Showing submitted file');
      position.textContent='Showing submitted code. Play or seek to inspect read-only history.';
    }
    async function load() {
      if(!valid()) return;
      pause(); if(valid()) options.restore?.();
      const request=++sequence; selected=select ? select.value : options.email; cache.clear(); position.textContent='';
      clip=options.clip?.();
      options.onAvailability?.(false);
      colorTimeline(seek, [], 1);
      seek.disabled=true; play.disabled=true; previous.disabled=true; nextButton.disabled=true; total=0;
      if(!selected || (options.clip && !clip)) {summary.textContent='Choose a submitted file to view its history.'; return;}
      summary.textContent='Loading history…'; options.clear?.();
      try {
        let result=await requestPage({index:'1'});
        if(!result.total && clip?.legacyFallback && valid() && request===sequence) {
          clip={...clip,legacy:true};
          result=await requestPage({index:'1'});
        }
        if(!valid() || request!==sequence) return;
        total=result.total;
        if(!total) {summary.textContent=result.gradingCompletedAt ? 'Grading finalized. Edit history is closed.' : 'No edit history is available for this submitted version.'; return;}
        summary.textContent=`${result.path} · ${total.toLocaleString()} changes · ${completionHint(result.firstAt,result.lastAt)} · First edit ${classDate(result.firstAt, result.marks?.[0]?.timeZone)} · Last edit ${classDate(result.lastAt, result.marks?.at(-1)?.timeZone)}${result.partial ? ' · Partial history. See the submitted file for the final version.' : ''}`;
        colorTimeline(seek, result.marks, total);
        if (result.marks?.length < total) summary.textContent += ' · Timeline colors are sampled.';
        seek.max=String(total); seek.disabled=false; play.disabled=false; previous.disabled=false; nextButton.disabled=false;
        options.onAvailability?.(true);
        if(options.restore) restore(); else await show(1);
      } catch(error) {if(valid() && request===sequence) summary.textContent=error.message;}
    }
    if(select) select.onchange=load;
    root.querySelector('.development-refresh').onclick=load;
    play.onclick=()=>{if(playing) pause(); else if(total) {playing=true; play.textContent='Pause'; show(current>=total?1:current,true);}};
    seek.oninput=()=>{pause(); seekTimer=setTimeout(()=>show(Number(seek.value)),70);};
    previous.onclick=()=>{pause(); if(total) return show(Math.max(1,current-1));};
    nextButton.onclick=()=>{pause(); if(total) return show(Math.min(total,current+1));};
    root.querySelector('.development-speed').onchange=()=>{if(playing) {clearTimeout(timeout); show(current,true);}};
    root.querySelector('.development-submitted')?.addEventListener('click',restore);
    return {ready:load(), reload:load, pause, dispose(){pause(); disposed=true; cache.clear(); abort.abort();}};
  }
  let editorPlayer=null;
  function disposeEditorDevelopment() {
    if(!editorPlayer) return;
    if(editorPlayer.valid()) editorPlayer.restore();
    editorPlayer.player.dispose(); editorPlayer=null;
    const root=document.getElementById('submissionDevelopmentPanel'); root.hidden=true; root.replaceChildren();
  }
  function syncEditorDevelopment(file) {
    if(editorPlayer && !editorPlayer.valid(file)) disposeEditorDevelopment();
  }
  function pauseEditorDevelopment() {editorPlayer?.player.pause();}
  function attachEditorDevelopment(a, email, adapter) {
    disposeEditorDevelopment();
    if(!a.fileControl && !adapter.clip?.()) return;
    const root=document.getElementById('submissionDevelopmentPanel');
    root.innerHTML=developmentControls(true);
    const player=mountDevelopmentPlayer(root,a,{...adapter,email,onAvailability: available => {
      root.hidden = !available;
      window.eagleEditor?.refresh();
    }});
    editorPlayer={player,valid:adapter.valid,restore:adapter.restore};
    return player.ready;
  }
  async function openDevelopment(a, email = '', revisionId = '', fileId = '') {
    const roster = [...bridge.roster(a.targetClassId)];
    for (const s of a.submissions || []) if (!roster.some(r => r.email === s.email)) roster.push(s);
    roster.sort((x,y) => String(x.last_name || '').localeCompare(String(y.last_name || '')) || String(x.first_name || x.name || x.email).localeCompare(String(y.first_name || y.name || y.email)));
    const m = modal(`${a.name} · Edit history`, `<div class="development-toolbar"><label>Student<select class="development-student">${roster.map(s => `<option value="${esc(s.email)}">${esc(s.name || s.email)}</option>`).join('')}</select></label><label>Submitted file<select class="development-file"></select></label><button type="button" class="btn secondary development-more" hidden>Older timelines</button><button type="button" class="btn secondary development-refresh">Refresh history</button></div>
      ${developmentControls()}<pre class="assignment-file-source development-source" tabindex="0" aria-label="Recorded code"></pre>`, 'development-dialog');
    const select=m.root.querySelector('.development-student'), fileSelect=m.root.querySelector('.development-file');
    const source=m.root.querySelector('.development-source'), more=m.root.querySelector('.development-more');
    if(email) select.value=email;
    let clips=[], request=0, nextOffset=0;
    const headers=bridge.managerHeaders(), auth=JSON.stringify(headers), abort=new AbortController();
    const valid=()=>m.root.isConnected && auth===JSON.stringify(bridge.managerHeaders());
    const player=mountDevelopmentPlayer(m.root,a,{valid,clip:()=>clips[Number(fileSelect.value)],clear(){source.textContent='';},render(content,frame,follow){
      const top=source.scrollTop, left=source.scrollLeft;
      source.innerHTML=highlightSource(content,frame.pasteRanges); source.scrollTop=top; source.scrollLeft=left;
      if(follow) followSource(source,content,Math.min(content.length,frame.from+frame.insert.length));
    }});
    async function load(offset=0) {
      const ticket=++request, student=select.value;
      if (!offset) {
        const sub=(a.submissions || []).find(row => row.email === student);
        clips=[sub,...(sub?.history || [])].filter(Boolean).flatMap(row => (row.files || []).map(f => ({
          revision:row.revisionId, attachment:f.id, name:f.name, submitted:row.submittedAt,
          legacyFallback:!!a.fileControl,
        })));
        if (revisionId && fileId && !clips.some(row => row.revision === revisionId && row.attachment === fileId)) {
          clips.unshift({revision:revisionId, attachment:fileId, name:'Selected submitted file', legacyFallback:!!a.fileControl});
        }
      }
      const params=new URLSearchParams({assignmentId:a.id, studentEmail:student, offset});
      try {
        const result=await json(`/api/assignments/workspace-history?${params}`,{headers,signal:abort.signal});
        if (!valid() || ticket!==request) return;
        for (const row of result.clips || []) {
          if (!clips.some(existing => existing.revision===row.revision && existing.attachment===row.attachment)) {
            clips.push({...row, submitted:row.submitted*1000});
          }
        }
        nextOffset=result.nextOffset;
        more.hidden=nextOffset==null;
        const previous=offset ? fileSelect.value : '';
        fileSelect.innerHTML=clips.map((row,index)=>`<option value="${index}">${esc(row.name)}${row.submitted ? ` · ${esc(date(row.submitted))}` : ''}</option>`).join('');
        if (previous) fileSelect.value=previous;
        else {
          const target=clips.findIndex(row=>row.revision===revisionId && (!fileId || row.attachment===fileId));
          if (target>=0) fileSelect.value=String(target);
        }
        await player.reload();
      } catch(error) {
        if (valid() && ticket===request) m.root.querySelector('.development-summary').textContent=error.message;
      }
    }
    select.onchange=()=>{ revisionId=fileId=''; player.pause(); load(); };
    fileSelect.onchange=player.reload;
    more.onclick=()=>load(nextOffset);
    m.root.querySelector('.development-refresh').onclick=()=>load();
    m.cleanups.push(player.dispose,()=>abort.abort());
    await load();
  }
  function editFeedback(a, email, sub = a.submissions.find(s => s.email === email)) {
    if (!sub) return;
    const headers = bridge.managerHeaders();
    const authorized = () => JSON.stringify(headers) === JSON.stringify(bridge.managerHeaders());
    const value = (sub.teacherFeedbackEdited ? sub.teacherFeedback : sub.aiFeedback) || '';
    const m = modal(`Feedback · ${sub.name || email}`, `<p>${a.shareAiFeedback ? 'Feedback sharing is on for this assignment.' : 'This feedback is private until sharing is enabled for this assignment.'}</p><label>Feedback<textarea class="assignment-feedback-editor" maxlength="12000" placeholder="Write feedback for this submission">${esc(value)}</textarea></label>${sub.aiFeedback ? `<details class="assignment-feedback-details"><summary>Original grading feedback</summary>${bridge.feedback(sub.aiFeedback)}</details>` : ''}<p role="status"></p><div class="modal-actions"><button class="btn run assignment-save-feedback" type="button">Save feedback</button></div>`);
    const input = m.root.querySelector('textarea');
    let saving = false;
    m.beforeClose = () => !saving && (!authorized() || input.value === value || confirm('Discard unsaved feedback?'));
    m.root.querySelector('.assignment-save-feedback').onclick = async event => {
      if (!authorized()) return m.close();
      saving = input.disabled = event.target.disabled = true;
      try {
        await json('/api/assignments/feedback', {
          method:'POST', headers:{'Content-Type':'application/json', ...headers},
          body:JSON.stringify({assignmentId:a.id, studentEmail:email, revisionId:sub.revisionId ?? null, feedback:input.value}),
        });
        m.beforeClose = null;
        m.close();
        if (authorized()) await bridge.reloadAssignments();
      } catch(error) {
        m.root.querySelector('[role="status"]').textContent = error.message;
        saving = input.disabled = event.target.disabled = false;
      }
    };
  }
  function present(reference) {
    const a = bridge.assignment(reference); if (!a) return;
    const m = modal(a.name, `<p class="assignment-presentation-due">${a.dueAt ? `Due ${esc(date(a.dueAt))}` : 'No due date'}</p><div class="assignment-presentation-description"></div>`, 'assignment-presentation');
    bridge.markdown(m.root.querySelector('.assignment-presentation-description'),a.task || '(No task description)');
  }
  function windowForm(cls) {
    const value = cls.settings?.assignment_submission_window || {start:'08:00',end:'15:00',timeZone:localZone()};
    const weekdays = [0,1,2,3,4];
    const days = (name, selected) => ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map((day,i) => `<label><input type="checkbox" name="${name}" value="${i}" ${selected.includes(i) ? 'checked' : ''}>${day}</label>`).join('');
    return `<section class="assignment-window-settings"><h4>Class schedule</h4><p>Meeting hours control in-class submissions and color the edit timeline. School dismissal determines extension deadlines.</p>
      <div class="assignment-window-fields"><label>Class starts<input type="time" class="assignment-window-start" value="${esc(value.start)}"></label><label>Class ends<input type="time" class="assignment-window-end" value="${esc(value.end)}"></label><label>School dismissal<input type="time" class="assignment-window-dismissal" value="${esc(value.dismissal || value.end)}"></label><label>Class time zone<input type="text" class="assignment-window-zone" value="${esc(value.timeZone)}" placeholder="America/Chicago"></label></div>
      <fieldset class="assignment-schedule-days"><legend>Class meets</legend>${days('meetingDays', value.meetingDays || weekdays)}</fieldset><fieldset class="assignment-schedule-days"><legend>School days</legend>${days('schoolDays', value.schoolDays || weekdays)}</fieldset>
      <label><input type="checkbox" class="assignment-window-enabled" ${value.enabled ? 'checked' : ''}> Apply class hours to older assignments that inherit the class setting</label><button type="button" class="btn secondary assignment-save-window">Save schedule</button><span class="assignment-window-status" role="status"></span></section>`;
  }
  function accommodationLabel(student) {
    const a = student.accommodations || {};
    return a.noDueDate ? 'No due date' : a.extendedWeekdays ? `+${a.extendedWeekdays} weekday${a.extendedWeekdays === 1 ? '' : 's'}` : 'None';
  }
  function bindClass(root, cls) {
    root.querySelector('.assignment-save-window')?.addEventListener('click', async event => {
      const status = root.querySelector('.assignment-window-status'); event.target.disabled = true;
      const selected = name => [...root.querySelectorAll(`[name="${name}"]:checked`)].map(input => Number(input.value));
      try {await mutate(`/api/teacher/classes/${encodeURIComponent(cls.id)}/submission-window`,{window:{enabled:root.querySelector('.assignment-window-enabled').checked,start:root.querySelector('.assignment-window-start').value,end:root.querySelector('.assignment-window-end').value,dismissal:root.querySelector('.assignment-window-dismissal').value,timeZone:root.querySelector('.assignment-window-zone').value,meetingDays:selected('meetingDays'),schoolDays:selected('schoolDays')}}); await bridge.reloadClasses();}
      catch(error) {status.textContent = error.message; event.target.disabled = false;}
    });
    root.querySelectorAll('.assignment-accommodation-edit').forEach(button => button.onclick = () => {
      const student = cls.students.find(s => s.email === button.dataset.email), value = student.accommodations || {};
      const m = modal(`Accommodations · ${student.name || student.email}`, `<label>Additional weekdays<input type="number" class="accommodation-days" min="0" max="365" step="1" value="${value.extendedWeekdays || 0}"></label><p>Weekends are skipped: Friday plus two weekdays is Tuesday.</p><label><input type="checkbox" class="accommodation-no-due" ${value.noDueDate ? 'checked' : ''}> No due date — accept late submissions</label><p>This student sees their own adjusted deadline. A teacher's manual lock still applies.</p><p role="status"></p><div class="modal-actions"><button type="button" class="btn run accommodation-save">Save accommodations</button></div>`);
      m.root.querySelector('.accommodation-save').onclick = async event => {
        event.target.disabled = true;
        try {await mutate(`/api/teacher/classes/${encodeURIComponent(cls.id)}/accommodations`,{studentEmail:student.email,timeZone:cls.settings?.assignment_submission_window?.timeZone || localZone(),accommodations:{extendedWeekdays:Number(m.root.querySelector('.accommodation-days').value),noDueDate:m.root.querySelector('.accommodation-no-due').checked}}); m.close(); await bridge.reloadClasses(); await bridge.reloadAssignments();}
        catch(error) {m.root.querySelector('[role="status"]').textContent = error.message; event.target.disabled = false;}
      };
    });
  }
  window.AssignmentWorkflow = {configure(value) {bridge = value; try {highlights=localStorage.getItem('eagleide-paste-highlights') !== '0';} catch {} if(document.body) setHighlights(highlights); window.eagleEditor?.on?.('beforeChange', (_cm,change) => {if(change.origin === 'setValue') clearEditorHighlights();});}, teacherToolbar, highlightSource, highlightEditor, card, bindStudent, submitDialog, openFiles, teacherFiles, bindTeacher, present, windowForm, bindClass, accommodationLabel,
    attachEditorDevelopment, syncEditorDevelopment, disposeEditorDevelopment, pauseEditorDevelopment, renderEditorFrame, mountReviewFiles, editFeedback, openDevelopment,
    focusStudentAssignment(assignment, email) {if(email!==account) {account=email;expanded.clear();} tab=(assignment.isPast ?? !assignment.active) ? 'past' : 'current'; expanded.add(assignment.id);},
    studentTab(email) {if (email !== account) {account=email; tab='current'; expanded.clear();} return tab;}};
})();
