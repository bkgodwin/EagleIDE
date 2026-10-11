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
    const cleanups = [];
    const close = () => {cleanups.forEach(fn => fn()); root.remove(); if (previous?.isConnected) previous.focus();};
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
    return {root, close, cleanups};
  }

  function card(a, canSubmit) {
    const s = a.studentSubmissionSummary, id = a.id || a.name;
    const past = a.isPast ?? !a.active;
    const mayAttempt = !past || a.deadlineOpen;
    const total = s?.totalScore ?? s?.codeScore;
    return `<details class="assignment-card student-assignment-card ${past ? 'is-past' : ''}" data-assignment-id="${esc(id)}" ${expanded.has(id) ? 'open' : ''}>
      <summary><span class="assignment-title-copy"><strong>${submitted(a) ? '<span class="assignment-submitted-check" aria-label="Submitted">✓</span> ' : ''}${esc(a.name)}</strong><span class="assignment-title-due">${a.dueAt ? `Due ${esc(date(a.dueAt))}` : 'No due date'}</span></span>${s ? `<span class="assignment-card-state">${s.withdrawn ? 'Un-submitted by teacher' : total != null ? `${esc(total)} / ${bridge.maxScore(a)}` : 'Submitted'}</span>` : ''}</summary>
      <div class="assignment-card-body">
        ${a.accommodationNote ? `<p class="assignment-accommodation-note">${esc(a.accommodationNote)}</p>` : ''}
        <div class="task assignment-markdown" data-assignment-markdown="${esc(id)}">${esc(a.task || '(No task description)')}</div>
        <div class="meta">Maximum score: ${bridge.maxScore(a)}${a.maxFileSubmissions ? ` · File attempts: ${s?.fileSubmissionCount || 0} / ${a.maxFileSubmissions}` : ''}</div>
        ${a.quiz?.questions?.length ? `<div class="meta">Questions: ${s?.quizAnsweredCount || 0} / ${a.quiz.questions.length} answered${a.quizSettings?.maxSubmissions ? ` · ${a.quizSettings.maxSubmissions} quiz attempt(s)` : ''}</div>` : ''}
        ${(a.skillTags || []).length ? `<div class="skill-tags">${a.skillTags.map(tag => `<span class="skill-chip">${esc(tag)}</span>`).join('')}</div>` : ''}
        ${mayAttempt && a.submissionWindowMessage ? `<p class="assignment-window-note ${a.submissionWindowOpen ? '' : 'is-closed'}">${esc(a.submissionWindowMessage)}</p>` : ''}
        ${s?.aiFeedback ? `<details class="assignment-feedback-details"><summary>View teacher feedback</summary>${bridge.feedback(s.aiFeedback, {audience:'student'})}</details>` : ''}
        <div class="assignment-actions">
          ${s ? `<button type="button" class="btn secondary view-student-submission-btn" data-id="${esc(id)}">View submission</button><button type="button" class="btn secondary view-score-report-btn" data-id="${esc(id)}">Score report</button>` : ''}
          ${mayAttempt && a.allowFileSubmission !== false ? `<button type="button" class="btn run submit-assignment-btn" data-id="${esc(id)}" ${canSubmit && a.canSubmitFiles !== false ? '' : 'disabled'}>${submitted(a) ? 'Resubmit' : 'Submit files'}</button>` : ''}
          ${mayAttempt && a.quiz?.questions?.length ? `<button type="button" class="btn secondary open-questions-btn" data-id="${esc(id)}" ${canSubmit && a.canSubmit !== false ? '' : 'disabled'}>Questions (${a.quiz.questions.length})</button>` : ''}
        </div>
      </div></details>`;
  }

  function bindStudent(root) {
    root.querySelectorAll('.student-assignment-card').forEach(detail => detail.addEventListener('toggle', () => {if (detail.open) expanded.add(detail.dataset.assignmentId); else expanded.delete(detail.dataset.assignmentId);}));
    root.querySelectorAll('.submit-assignment-btn').forEach(button => button.onclick = () => submitDialog(button.dataset.id));
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
    const m = modal(`Submit: ${a.name}`, `<p>Choose ${multi ? 'the files' : 'one file'} to submit. Your currently open file is selected by default.</p>
      ${multi ? `<div class="assignment-file-choices">${files.map(f => `<label><input type="checkbox" name="workspaceFile" value="${esc(f.path)}" ${f.path === selected ? 'checked' : ''}><span>${esc(f.path)}</span><small>${size(f.size)}</small></label>`).join('') || '<p>No workspace files yet. You can upload attachments below.</p>'}</div><label class="assignment-upload-label">Add attachments of any type<input type="file" id="assignmentUploadFiles" multiple></label><small>Up to 20 files and 25 MB total. Uploaded attachments may total up to 15 MB.</small>` : `<label for="assignmentFileSelect">File to submit</label><select id="assignmentFileSelect">${files.map(f => `<option value="${esc(f.path)}" ${f.path === selected ? 'selected' : ''}>${esc(f.path)}</option>`).join('')}</select>`}
      <p class="assignment-dialog-status" role="status"></p><div class="modal-actions"><button type="button" class="btn run assignment-submit-selected">Submit ${multi ? 'files' : 'file'}</button></div>`, 'assignment-submit-dialog');
    const status = m.root.querySelector('[role="status"]'), button = m.root.querySelector('.assignment-submit-selected');
    const auth = JSON.stringify(bridge.studentHeaders());
    button.onclick = async () => {
      const paths = multi ? [...m.root.querySelectorAll('[name="workspaceFile"]:checked')].map(input => input.value) : [m.root.querySelector('#assignmentFileSelect')?.value].filter(Boolean);
      const uploads = [...(m.root.querySelector('#assignmentUploadFiles')?.files || [])];
      if (!paths.length && !uploads.length) {status.textContent = 'Choose at least one file.'; return;}
      if (paths.length + uploads.length > 20 || uploads.reduce((sum, f) => sum + f.size, 0) > 15 * 1024 * 1024) {status.textContent = 'Choose at most 20 files, with uploaded attachments totaling at most 15 MB.'; return;}
      button.disabled = true; status.textContent = 'Saving and submitting…';
      try {
        if (auth !== JSON.stringify(bridge.studentHeaders())) throw new Error('Your account changed. Reopen the submission menu.');
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

  async function openFiles(reference, studentEmail = '', fileId = '') {
    const a = bridge.assignment(reference) || {id:reference, name:'Assignment'};
    const teacher = !!studentEmail;
    const headers = teacher ? bridge.managerHeaders() : bridge.studentHeaders();
    const auth = JSON.stringify(headers);
    const m = modal(`${a.name} · Submission`, `<div class="assignment-version-control"></div><div class="assignment-submission-layout"><nav class="assignment-submission-files" aria-label="Submitted files"></nav><section class="assignment-submission-preview" aria-live="polite">Loading submission…</section></div><div class="assignment-submitted-answers"></div>`, 'assignment-files-dialog');
    let revision = '', sequence = 0, objectUrl = '';
    const preview = m.root.querySelector('.assignment-submission-preview');
    const params = extra => new URLSearchParams({assignmentId:a.id || reference, ...(teacher ? {studentEmail} : {}), ...(revision ? {revisionId:revision} : {}), ...extra});
    const valid = () => m.root.isConnected && auth === JSON.stringify(teacher ? bridge.managerHeaders() : bridge.studentHeaders());
    const release = () => {if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = '';};
    m.cleanups.push(() => {sequence++; release();});
    async function download(f) {
      const response = await bridge.request(`/api/assignments/submission-file?${params({fileId:f.id, download:'1'})}`, {headers});
      if (!response.ok) throw new Error('Could not download attachment.');
      const blob = await response.blob(); if (!valid()) return;
      const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = f.name;
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    async function show(f, cursor = 0) {
      const request = ++sequence;
      release(); preview.textContent = 'Loading file…';
      try {
        const result = await json(`/api/assignments/submission-file?${params({fileId:f.id, cursor:String(cursor)})}`, {headers});
        if (request !== sequence || !valid()) return;
        preview.innerHTML = `<div class="assignment-file-preview-header"><strong>${esc(f.name)}</strong><button type="button" class="btn secondary attachment-download">Download</button></div>`;
        preview.querySelector('.attachment-download').onclick = () => download(f).catch(error => alert(error.message));
        if (result.kind === 'text') {
          let content = result.content || '';
          if (f.name.toLowerCase().endsWith('.json')) {try {content = JSON.stringify(JSON.parse(content), null, 2);} catch {}}
          const pre = document.createElement('pre'); pre.className = 'assignment-file-source'; pre.textContent = content; preview.append(pre);
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
      } catch (error) {if (request === sequence && valid()) preview.textContent = error.message;}
    }
    async function load(version = '') {
      revision = version; sequence++; preview.textContent = 'Loading submission…';
      try {
        const data = await json(`/api/assignments/submission-files?${params({})}`, {headers});
        if (!valid() || version !== revision) return;
        revision = data.revisionId || '';
        const control = m.root.querySelector('.assignment-version-control');
        control.innerHTML = teacher ? `<label>Submission version<select aria-label="Submission version"><option value="${esc(data.latestRevisionId || '')}">Latest submission</option>${data.history.map((h,i) => `<option value="${esc(h.revisionId)}">Previous ${i+1} · ${esc(h.submittedAt || 'Unknown time')}</option>`).join('')}</select></label>` : `<p>Submitted ${esc(data.submittedAt || '—')} · Read-only copy</p>`;
        const select = control.querySelector('select'); if (select) {select.value = revision; select.onchange = () => load(select.value);}
        const files = m.root.querySelector('.assignment-submission-files');
        files.innerHTML = data.files.map(f => `<button type="button" class="assignment-submitted-file" data-submitted-file="${esc(f.id)}"><span>${esc(f.name)}</span><small>${size(f.size)}</small></button>`).join('');
        files.querySelectorAll('button').forEach(button => button.onclick = () => show(data.files.find(f => f.id === button.dataset.submittedFile)));
        const answers = m.root.querySelector('.assignment-submitted-answers');
        answers.innerHTML = data.quizResponses.length ? `<h4>Submitted question answers</h4>${data.quizResponses.map(r => {const q=a.quiz?.questions?.find(q => q.id === r.questionId); const answer = q?.options && typeof r.answer === 'number' ? q.options[r.answer] : r.answer; return `<details><summary>${esc(q?.question || r.questionId)}</summary><pre>${esc(answer ?? '')}</pre></details>`;}).join('')}` : '';
        if (data.files.length) await show(data.files.find(f => f.id === fileId) || data.files[0]);
        else preview.textContent = 'No files submitted. Question answers are shown below.';
      } catch (error) {if (valid()) preview.textContent = error.message;}
    }
    await load();
  }

  function teacherFiles(a, sub) {
    const files = sub.files || (sub.submissionPath ? [{id:'legacy', name:sub.submittedFileName}] : []);
    return `<div class="assignment-teacher-file-list">${files.map(f => `<button type="button" class="btn secondary assignment-view-file" data-email="${esc(sub.email)}" data-file="${esc(f.id)}">${esc(f.name)}</button>`).join('') || '—'}</div>${sub.history?.length ? `<button type="button" class="btn secondary assignment-view-history" data-email="${esc(sub.email)}">History (${sub.history.length} previous)</button>` : ''}`;
  }
  function bindTeacher(root, a, owner) {
    root.querySelectorAll('.assignment-view-file').forEach(button => button.onclick = () => openFiles(a.id,button.dataset.email,button.dataset.file));
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
  function editFeedback(a, email) {
    const sub = a.submissions.find(s => s.email === email);
    if (!sub) return;
    const value = sub.teacherFeedbackEdited ? sub.teacherFeedback : sub.aiFeedback;
    const m = modal(`Feedback · ${sub.name || email}`, `<p>Students see this feedback when feedback sharing is enabled for this assignment.</p><label>Feedback<textarea class="assignment-feedback-editor" maxlength="12000">${esc(value || '')}</textarea></label><p role="status"></p><div class="modal-actions"><button class="btn run assignment-save-feedback" type="button">Save feedback</button></div>`);
    m.root.querySelector('.assignment-save-feedback').onclick = async event => {
      event.target.disabled = true;
      try {await mutate('/api/assignments/feedback',{assignmentId:a.id,studentEmail:email,revisionId:sub.revisionId,feedback:m.root.querySelector('textarea').value}); m.close(); await bridge.reloadAssignments();}
      catch(error) {m.root.querySelector('[role="status"]').textContent = error.message; event.target.disabled = false;}
    };
  }
  function present(reference) {
    const a = bridge.assignment(reference); if (!a) return;
    const m = modal(a.name, `<p class="assignment-presentation-due">${a.dueAt ? `Due ${esc(date(a.dueAt))}` : 'No due date'}</p><div class="assignment-presentation-description"></div>`, 'assignment-presentation');
    bridge.markdown(m.root.querySelector('.assignment-presentation-description'),a.task || '(No task description)');
  }
  function windowForm(cls) {
    const value = cls.settings?.assignment_submission_window || {start:'08:00',end:'15:00',timeZone:localZone()};
    return `<section class="assignment-window-settings"><h4>Assignment submission window</h4><label><input type="checkbox" class="assignment-window-enabled" ${value.enabled ? 'checked' : ''}> Limit submissions to school hours on weekdays</label><div class="assignment-window-fields"><label>Start<input type="time" class="assignment-window-start" value="${esc(value.start)}"></label><label>End<input type="time" class="assignment-window-end" value="${esc(value.end)}"></label><label>Class time zone<input type="text" class="assignment-window-zone" value="${esc(value.timeZone)}" placeholder="America/Chicago"></label></div><p>Applies to files and questions. An assignment can allow submissions at any time.</p><button type="button" class="btn secondary assignment-save-window">Save submission window</button><span class="assignment-window-status" role="status"></span></section>`;
  }
  function accommodationLabel(student) {
    const a = student.accommodations || {};
    return a.noDueDate ? 'No due date' : a.extendedWeekdays ? `+${a.extendedWeekdays} weekday${a.extendedWeekdays === 1 ? '' : 's'}` : 'None';
  }
  function bindClass(root, cls) {
    root.querySelector('.assignment-save-window')?.addEventListener('click', async event => {
      const status = root.querySelector('.assignment-window-status'); event.target.disabled = true;
      try {await mutate(`/api/teacher/classes/${encodeURIComponent(cls.id)}/submission-window`,{window:{enabled:root.querySelector('.assignment-window-enabled').checked,start:root.querySelector('.assignment-window-start').value,end:root.querySelector('.assignment-window-end').value,timeZone:root.querySelector('.assignment-window-zone').value}}); await bridge.reloadClasses();}
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
  window.AssignmentWorkflow = {configure(value) {bridge = value;}, card, bindStudent, submitDialog, openFiles, teacherFiles, bindTeacher, present, windowForm, bindClass, accommodationLabel,
    studentTab(email) {if (email !== account) {account=email; tab='current'; expanded.clear();} return tab;}};
})();
