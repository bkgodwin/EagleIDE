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
    return `<div class="assignment-review-tools">${owner ? '<button type="button" class="btn secondary assignment-extend">Extend for a student…</button>' : ''}${a.quiz?.questions?.some(q => ['written','written_code'].includes(q.type)) ? '<button type="button" class="btn secondary assignment-grade-question">Grade written responses by question</button>' : ''}<label><input type="checkbox" class="assignment-paste-toggle" ${highlights ? 'checked' : ''}> Highlight pasted text</label><span class="meta">A paste event does not identify its source.</span></div>`;
  }
  function extendStudent(a, email = '') {
    const roster = bridge.roster(a.targetClassId);
    const m = modal('Make-up / retest extension', `<p>Reopen this assignment for one student for the selected number of calendar days, starting now. Includes one additional file and question attempt if needed, at any time of day. Previous submissions and grades are kept.</p><label>Student<select class="extension-student">${roster.map(s => `<option value="${esc(s.email)}" ${email === s.email ? 'selected' : ''}>${esc([s.first_name ?? s.name,s.last_name].filter(Boolean).join(' ') || s.email)}</option>`).join('')}</select></label><label>Days from now<input class="extension-days" type="number" min="1" max="365" step="1" value="3"></label><p class="extension-current"></p><p role="status"></p><div class="modal-actions"><button type="button" class="btn secondary extension-remove">Remove extension</button><button type="button" class="btn run extension-save">Reopen for student</button></div>`);
    const student = m.root.querySelector('.extension-student');
    const update = () => {const until=a.studentExtensions?.[student.value]?.until; m.root.querySelector('.extension-current').textContent = until ? `Current make-up deadline: ${date(until)}` : 'No individual make-up deadline.';};
    student.onchange = update; update();
    const save = async days => {
      const buttons = m.root.querySelectorAll('.modal-actions button'); buttons.forEach(b => b.disabled=true);
      try {await mutate('/api/assignments/extend-student',{assignmentId:a.id,studentEmail:student.value,days}); m.close(); await bridge.reloadAssignments();}
      catch(error) {m.root.querySelector('[role="status"]').textContent=error.message; buttons.forEach(b => b.disabled=false);}
    };
    m.root.querySelector('.extension-save').onclick = () => {const input=m.root.querySelector('.extension-days'); if(input.reportValidity()) save(Number(input.value));};
    m.root.querySelector('.extension-remove').onclick = () => save(0);
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
      <summary><span class="assignment-title-copy"><strong>${submitted(a) ? '<span class="assignment-submitted-check" aria-label="Submitted">✓</span> ' : ''}${esc(a.name)}</strong><span class="assignment-title-due">${a.dueAt ? `Due ${esc(date(a.dueAt))}` : 'No due date'}</span></span>${s ? `<span class="assignment-card-state">${s.withdrawn ? 'Un-submitted by teacher' : total != null ? `${esc(total)} / ${bridge.maxScore(a)}` : 'Submitted'}</span>` : ''}</summary>
      <div class="assignment-card-body">
        ${a.accommodationNote ? `<p class="assignment-accommodation-note">${esc(a.accommodationNote)}</p>` : ''}
        ${a.fileControl ? `<p class="assignment-window-note">${a.controlledFilePath ? `Work in <strong>${esc(a.controlledFilePath)}</strong>. Only this file can be submitted. ${a.gradingCompletedAt ? 'Development recording is complete.' : 'Changed code is recorded for teacher review.'}` : esc(a.fileControlError || 'The assignment file will appear when this assignment is open.')}</p>${a.controlledFilePath ? `<button type="button" class="btn secondary assignment-open-controlled" data-path="${esc(a.controlledFilePath)}">Open assignment file</button>` : ''}` : ''}
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
    root.querySelectorAll('.assignment-open-controlled').forEach(button => button.onclick = () => bridge.openPath(button.dataset.path));
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
    const files = a.fileControl ? (a.controlledFilePath ? [{path:a.controlledFilePath,size:0}] : []) : bridge.files().filter(f => !f.in_trash && !String(f.path).startsWith('Trash/'));
    const open = bridge.openFile();
    const selected = files.some(f => f.path === open?.path) ? open.path : files[0]?.path;
    const multi = !!a.allowMultiFileSubmission && !a.fileControl;
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
      } catch (error) {if (request === sequence && valid()) preview.textContent = error.message;}
    }
    async function load(version = '') {
      revision = version; const request = ++sequence; preview.textContent = 'Loading submission…';
      try {
        const data = await json(`/api/assignments/submission-files?${params({})}`, {headers});
        if (!valid() || request !== sequence || version !== revision) return;
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
      } catch (error) {if (valid() && request === sequence) preview.textContent = error.message;}
    }
    await load();
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
      if (!owner || !confirm('Mark grading complete? This closes submissions, permanently deletes all development timelines for this assignment, and stops recording. Scores, submissions, and student files are kept. Copy the assignment if you later need a new recorded attempt.')) return;
      event.target.disabled = true;
      try {await mutate('/api/assignments/grading-complete', {assignmentId:a.id}); await bridge.reloadAssignments();}
      catch(error) {alert(error.message); event.target.disabled=false;}
    });
    root.querySelector('.assignment-extend')?.addEventListener('click', () => extendStudent(a));
    root.querySelectorAll('.assignment-extend-student').forEach(button => button.onclick = () => extendStudent(a,button.dataset.email));
    root.querySelector('.assignment-grade-question')?.addEventListener('click', () => gradeByQuestion(a));
    root.querySelector('.assignment-paste-toggle')?.addEventListener('change', event => setHighlights(event.target.checked));
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
  function developmentControls() {
    return `<p class="development-summary" role="status">Loading history…</p>
      <div class="development-controls"><button type="button" class="btn run development-play" disabled>Play</button><button type="button" class="btn secondary development-previous" aria-label="Previous change" disabled>←</button><button type="button" class="btn secondary development-next" aria-label="Next change" disabled>→</button><label>Speed<select class="development-speed"><option value="1">1×</option><option value="5">5×</option><option value="20">20×</option></select></label><label><input type="checkbox" class="development-skip" checked> Skip idle gaps over 5 seconds</label><label><input type="checkbox" class="development-follow" checked> Follow edits</label></div>
      <label class="development-seek-label">Development timeline<input type="range" class="development-seek" min="1" max="1" value="1" step="1" disabled></label>
      <div class="development-position" aria-live="polite"></div>
      <small class="development-note">Changed code is sampled at one-second resolution. Completion time is a hint from the first to last recorded edit, including idle time, not active typing time. Device sample and server receipt times are shown; history supports review and is not proof of authorship.</small>`;
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
  }
  function mountDevelopmentPlayer(root, a, options) {
    const select=root.querySelector('.development-student'), seek=root.querySelector('.development-seek'), play=root.querySelector('.development-play');
    const summary=root.querySelector('.development-summary'), position=root.querySelector('.development-position');
    const previous=root.querySelector('.development-previous'), nextButton=root.querySelector('.development-next');
    const headers=bridge.managerHeaders(), auth=JSON.stringify(headers), cache=new Map(), abort=new AbortController();
    let total=0, current=1, sequence=0, playing=false, timeout=null, selected='', disposed=false, seekTimer;
    const valid=()=>!disposed && root.isConnected && auth===JSON.stringify(bridge.managerHeaders()) && (!options.valid || options.valid());
    const params=extra=>new URLSearchParams({assignmentId:a.id,studentEmail:selected,...extra});
    const stop=()=>{playing=false; clearTimeout(timeout); play.textContent='Play';};
    const pause=()=>{stop(); sequence++; clearTimeout(seekTimer);};
    async function page(seq) {
      if(!valid()) throw new Error('Review context changed');
      const pageStudent=selected;
      for(const entry of cache.values()) if(entry.frames.some(f=>f.seq===seq)) return entry;
      const start=Math.floor((seq-1)/120)*120+1;
      let data=await json(`/api/assignments/development?${params({cursor:String(start)})}`, {headers,signal:abort.signal});
      if(!valid() || pageStudent!==selected) throw new Error('Review student changed');
      // Large replacements can shorten a page; fetch the requested position directly.
      if(!data.frames.some(f=>f.seq===seq)) data=await json(`/api/assignments/development?${params({cursor:String(seq)})}`, {headers,signal:abort.signal});
      if(!valid() || pageStudent!==selected) throw new Error('Review student changed');
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
        seek.setAttribute('aria-valuetext',`Change ${seq} of ${total}, ${date(frame.at)}`);
        position.textContent=`Change ${seq} / ${total} · ${date(frame.at)} · ${frame.kind==='editor' ? 'Editor sample' : frame.kind==='resync' ? 'Resynchronized — earlier changes may be missing' : 'File save'} · Received ${date(frame.receivedAt)}${options.restore ? ' · Read-only history' : ''}`;
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
      position.textContent='Showing submitted code. Play or seek to inspect read-only history.';
    }
    async function load() {
      if(!valid()) return;
      pause(); if(valid()) options.restore?.();
      const request=++sequence; selected=select ? select.value : options.email; cache.clear(); position.textContent='';
      seek.disabled=true; play.disabled=true; previous.disabled=true; nextButton.disabled=true; total=0;
      if(!selected) {summary.textContent='No students enrolled.'; return;}
      summary.textContent='Loading history…'; options.clear?.();
      try {
        const result=await json(`/api/assignments/development?${params({index:'1'})}`,{headers,signal:abort.signal});
        if(!valid() || request!==sequence) return;
        total=result.total;
        if(!total) {summary.textContent=result.gradingCompletedAt ? 'Grading complete · development timelines deleted.' : 'No code changes recorded yet. History appears after the student opens and edits the assignment file.'; return;}
        summary.textContent=`${result.path} · ${total.toLocaleString()} changes · ${completionHint(result.firstAt,result.lastAt)} · First edit ${date(result.firstAt)} · Last edit ${date(result.lastAt)}`;
        seek.max=String(total); seek.disabled=false; play.disabled=false; previous.disabled=false; nextButton.disabled=false;
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
    return {ready:load(), pause, dispose(){pause(); disposed=true; cache.clear(); abort.abort();}};
  }
  let editorPlayer=null;
  function disposeEditorDevelopment() {
    if(!editorPlayer) return;
    if(editorPlayer.valid()) editorPlayer.restore();
    editorPlayer.player.dispose(); editorPlayer=null;
    const root=document.getElementById('submissionDevelopmentPanel'); root.hidden=true; root.replaceChildren();
    document.getElementById('editorContentStack').classList.remove('has-development-player');
    window.eagleEditor?.refresh();
  }
  function syncEditorDevelopment(file) {
    if(editorPlayer && !editorPlayer.valid(file)) disposeEditorDevelopment();
  }
  function pauseEditorDevelopment() {editorPlayer?.player.pause();}
  function attachEditorDevelopment(a, email, adapter) {
    disposeEditorDevelopment();
    if(!a.fileControl) return;
    const root=document.getElementById('submissionDevelopmentPanel');
    root.innerHTML=`<div class="development-toolbar"><strong>Development history</strong><button type="button" class="btn secondary development-refresh">Refresh history</button><button type="button" class="btn secondary development-submitted">Show submitted code</button></div>${developmentControls()}`;
    root.hidden=false;
    document.getElementById('editorContentStack').classList.add('has-development-player');
    const player=mountDevelopmentPlayer(root,a,{...adapter,email});
    editorPlayer={player,valid:adapter.valid,restore:adapter.restore}; window.eagleEditor?.refresh();
    return player.ready;
  }
  async function openDevelopment(a, email = '') {
    const roster = [...bridge.roster(a.targetClassId)];
    for (const s of a.submissions || []) if (!roster.some(r => r.email === s.email)) roster.push(s);
    roster.sort((x,y) => String(x.last_name || '').localeCompare(String(y.last_name || '')) || String(x.first_name || x.name || x.email).localeCompare(String(y.first_name || y.name || y.email)));
    const m = modal(`${a.name} · Development history`, `<div class="development-toolbar"><label>Student<select class="development-student">${roster.map(s => `<option value="${esc(s.email)}">${esc(s.name || s.email)}</option>`).join('')}</select></label><button type="button" class="btn secondary development-refresh">Refresh history</button></div>
      ${developmentControls()}<pre class="assignment-file-source development-source" tabindex="0" aria-label="Recorded code"></pre>`, 'development-dialog');
    const select=m.root.querySelector('.development-student'), source=m.root.querySelector('.development-source');
    if(email) select.value=email;
    const player=mountDevelopmentPlayer(m.root,a,{clear(){source.textContent='';},render(content,frame,follow){
      const top=source.scrollTop, left=source.scrollLeft;
      source.textContent=content; source.scrollTop=top; source.scrollLeft=left;
      if(follow) followSource(source,content,Math.min(content.length,frame.from+frame.insert.length));
    }});
    m.cleanups.push(player.dispose); await player.ready;
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
  window.AssignmentWorkflow = {configure(value) {bridge = value; try {highlights=localStorage.getItem('eagleide-paste-highlights') !== '0';} catch {} if(document.body) setHighlights(highlights); window.eagleEditor?.on?.('beforeChange', (_cm,change) => {if(change.origin === 'setValue') clearEditorHighlights();});}, teacherToolbar, highlightSource, highlightEditor, card, bindStudent, submitDialog, openFiles, teacherFiles, bindTeacher, present, windowForm, bindClass, accommodationLabel,
    attachEditorDevelopment, syncEditorDevelopment, disposeEditorDevelopment, pauseEditorDevelopment, renderEditorFrame,
    studentTab(email) {if (email !== account) {account=email; tab='current'; expanded.clear();} return tab;}};
})();
