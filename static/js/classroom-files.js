/**
 * Classroom send-file and teacher file audit UI.
 */
(function () {
  'use strict';

  let sendFileItem = null;
  let auditStudentEmail = null;
  let auditClassId = null;

  function ctx() {
    return window.EagleIDE?.getContext?.() || {};
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function getClassContext() {
    const c = ctx();
    const fromHelper = c.getCurrentClassContext?.();
    if (fromHelper) return fromHelper;
    if (c.TEACHER_TOKEN) {
      const id = c.currentTeacherClassId || c.teacherClasses?.[0]?.id;
      return (c.teacherClasses || []).find(cls => cls.id === id) || c.teacherClasses?.[0] || null;
    }
    if (c.USER_TOKEN) {
      const id = c.currentStudentClassId;
      return (c.studentClasses || []).find(cls => cls.id === id) || c.studentClassData || null;
    }
    return null;
  }

  function canSendFile(item) {
    if (!item || item.type !== 'file') return false;
    const c = ctx();
    const classCtx = getClassContext();
    if (!classCtx) return false;
    const settings = classCtx.settings || {};
    if (c.TEACHER_TOKEN) return settings.teacher_file_send_enabled !== false;
    if (c.USER_TOKEN && !c.ADMIN_TOKEN) {
      return settings.student_send_to_teacher_enabled !== false
        || settings.student_peer_sharing_enabled === true;
    }
    return false;
  }

  function openSendModal(item) {
    const c = ctx();
    const classCtx = getClassContext();
    if (!canSendFile(item)) return;
    sendFileItem = item;
    const modal = document.getElementById('classroomSendFileModal');
    const title = document.getElementById('classroomSendFileTitle');
    const recipientsWrap = document.getElementById('classroomSendRecipients');
    const peerRow = document.getElementById('classroomSendPeerRow');
    if (!modal || !recipientsWrap) return;

    title.textContent = `Send "${item.name}"`;
    recipientsWrap.innerHTML = '';
    if (peerRow) peerRow.style.display = 'none';

    if (c.TEACHER_TOKEN) {
      const students = (ctx().teacherClasses || [])
        .find(cls => cls.id === ctx().currentTeacherClassId)?.students || [];
      recipientsWrap.innerHTML = `
        <label class="choice-item choice-item--emphasis">
          <input type="checkbox" id="classroomSendSelectAll">
          <span class="choice-text">Select all students</span>
        </label>
        ${students.map(s => `
          <label class="choice-item">
            <input type="checkbox" class="classroom-send-student" value="${escapeHtml(s.email)}">
            <span class="choice-text">${escapeHtml(s.name || s.email)}</span>
          </label>
        `).join('') || '<div style="color:#888; padding:8px;">No students in class.</div>'}
      `;
      const selectAll = document.getElementById('classroomSendSelectAll');
      selectAll?.addEventListener('change', () => {
        recipientsWrap.querySelectorAll('.classroom-send-student').forEach(cb => {
          cb.checked = selectAll.checked;
        });
      });
    } else {
      recipientsWrap.innerHTML = `
        <label class="choice-item">
          <input type="radio" name="classroomSendMode" value="teacher" checked>
          <span class="choice-text">Send to teacher</span>
        </label>
      `;
      const settings = classCtx.settings || {};
      if (settings.student_peer_sharing_enabled) {
        recipientsWrap.innerHTML += `
          <label class="choice-item">
            <input type="radio" name="classroomSendMode" value="peer">
            <span class="choice-text">Send to classmate</span>
          </label>
        `;
        if (peerRow) peerRow.style.display = '';
        loadPeerSelect(classCtx.id);
      }
    }
    modal.style.display = 'flex';
  }

  async function loadPeerSelect(classId) {
    const c = ctx();
    const peerSelect = document.getElementById('classroomSendPeerSelect');
    if (!peerSelect || !c.USER_TOKEN) return;
    peerSelect.innerHTML = '<option value="">Select classmate…</option>';
    try {
      const rosterRes = await fetch(`/api/student/class-roster?classId=${encodeURIComponent(classId)}`, {
        headers: { 'X-User-Token': c.USER_TOKEN },
      });
      const roster = await rosterRes.json().catch(() => ({}));
      (roster?.students || []).forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.email;
        opt.textContent = s.name || s.email;
        peerSelect.appendChild(opt);
      });
    } catch {}
  }

  async function submitSendFile() {
    const c = ctx();
    const classCtx = getClassContext();
    if (!sendFileItem || !classCtx) return;
    const classId = c.TEACHER_TOKEN
      ? (c.currentTeacherClassId || classCtx.id || c.teacherClasses?.[0]?.id)
      : classCtx.id;
    const body = {
      classId,
      sourcePath: sendFileItem.path,
    };

    if (c.TEACHER_TOKEN) {
      const selectAll = document.getElementById('classroomSendSelectAll')?.checked;
      const checked = [...document.querySelectorAll('.classroom-send-student:checked')].map(cb => cb.value);
      if (selectAll) body.recipients = 'all';
      else if (checked.length) body.recipients = checked;
      else return alert('Select at least one student or use Select all');
    } else {
      const mode = document.querySelector('input[name="classroomSendMode"]:checked')?.value || 'teacher';
      if (mode === 'peer') {
        const peer = document.getElementById('classroomSendPeerSelect')?.value;
        if (!peer) return alert('Select a classmate');
        body.targetEmail = peer;
      }
    }

    const headers = { 'Content-Type': 'application/json' };
    if (c.TEACHER_TOKEN) headers['X-Teacher-Token'] = c.TEACHER_TOKEN;
    else headers['X-User-Token'] = c.USER_TOKEN;

    const res = await fetch('/api/classroom/send-file', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!j?.ok) return alert(j?.error || 'Send failed');
    const copied = j.copied?.length || 0;
    const errors = j.errors?.length || 0;
    let msg = `File sent to ${copied} recipient(s).`;
    if (errors) msg += ` ${errors} failed.`;
    alert(msg);
    document.getElementById('classroomSendFileModal').style.display = 'none';
    sendFileItem = null;
  }

  function renderAuditTree(items, indent) {
    let html = '';
    (items || []).forEach(item => {
      if (item.type === 'folder') {
        html += `<div class="audit-folder" style="padding-left:${indent}px">📁 ${escapeHtml(item.name)}</div>`;
        html += renderAuditTree(item.children, indent + 12);
      } else {
        html += `
          <div class="audit-item" style="padding-left:${indent}px" data-path="${escapeHtml(item.path)}">
            <span>📄 ${escapeHtml(item.name)}</span>
            <span>
              <button type="button" class="btn secondary audit-view-btn" data-path="${escapeHtml(item.path)}" style="font-size:11px;padding:2px 8px;">View</button>
              <button type="button" class="btn stop audit-del-btn" data-path="${escapeHtml(item.path)}" style="font-size:11px;padding:2px 8px;">Delete</button>
            </span>
          </div>`;
      }
    });
    return html;
  }

  async function openAuditModal(classId, studentEmail, studentName) {
    const c = ctx();
    auditClassId = classId;
    auditStudentEmail = studentEmail;
    const modal = document.getElementById('classroomAuditModal');
    const title = document.getElementById('classroomAuditTitle');
    const tree = document.getElementById('classroomAuditTree');
    if (!modal || !tree) return;
    title.textContent = `Files: ${studentName || studentEmail}`;
    tree.innerHTML = 'Loading…';
    modal.style.display = 'flex';
    const res = await fetch(
      `/api/teacher/students/files/list?classId=${encodeURIComponent(classId)}&studentEmail=${encodeURIComponent(studentEmail)}`,
      { headers: { 'X-Teacher-Token': c.TEACHER_TOKEN } }
    );
    const j = await res.json().catch(() => ({}));
    if (!j?.ok) {
      tree.innerHTML = `<div style="color:#c44;">${escapeHtml(j?.error || 'Failed to load')}</div>`;
      return;
    }
    tree.innerHTML = `<div class="classroom-audit-tree">${renderAuditTree(j.files, 0) || '<div style="color:#888;">No files.</div>'}</div>`;
    tree.querySelectorAll('.audit-view-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        viewAuditFile(btn.dataset.path);
      });
    });
    tree.querySelectorAll('.audit-del-btn').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        if (!confirm('Delete this file from the student account?')) return;
        const delRes = await fetch('/api/teacher/students/files/delete', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', 'X-Teacher-Token': c.TEACHER_TOKEN },
          body: JSON.stringify({
            classId: auditClassId,
            studentEmail: auditStudentEmail,
            path: btn.dataset.path,
          }),
        });
        const dj = await delRes.json().catch(() => ({}));
        if (!dj?.ok) return alert(dj?.error || 'Delete failed');
        openAuditModal(auditClassId, auditStudentEmail, studentName);
      });
    });
  }

  async function viewAuditFile(path) {
    const c = ctx();
    const res = await fetch('/api/teacher/students/files/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Teacher-Token': c.TEACHER_TOKEN },
      body: JSON.stringify({
        classId: auditClassId,
        studentEmail: auditStudentEmail,
        path,
      }),
    });
    const j = await res.json().catch(() => ({}));
    if (!j?.ok) return alert(j?.error || 'Could not read file');
    c.openAuditPreview?.(path, j.content, auditStudentEmail);
    document.getElementById('classroomAuditModal').style.display = 'none';
  }

  async function resetStudentExamples(classId, studentEmail, studentName) {
    const c = ctx();
    if (!confirm(`Reset default example files for ${studentName || studentEmail}?\n\nOnly original Examples files are overwritten. Other files in Examples/ are left unchanged.`)) return;
    const res = await fetch('/api/teacher/students/reset-examples', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Teacher-Token': c.TEACHER_TOKEN },
      body: JSON.stringify({ classId, studentEmail }),
    });
    const j = await res.json().catch(() => ({}));
    if (!j?.ok) return alert(j?.error || 'Reset failed');
    alert(`Reset ${j.files_reset ?? 0} example file(s).`);
  }

  async function loadClassroomLog() {
    const c = ctx();
    if (!c.ADMIN_TOKEN) return;
    const feed = document.getElementById('classroomLogFeed');
    if (!feed) return;
    feed.textContent = 'Loading…';
    const res = await fetch('/api/admin/classroom-events?limit=100', {
      headers: { 'X-Admin-Token': c.ADMIN_TOKEN },
    });
    const j = await res.json().catch(() => ({}));
    if (!j?.ok) {
      feed.textContent = j?.error || 'Failed to load';
      return;
    }
    feed.innerHTML = (j.events || []).map(ev => `
      <div class="classroom-log-entry">
        <div><strong>${escapeHtml(ev.type)}</strong> · ${escapeHtml(ev.timestamp || '')}</div>
        <div>${escapeHtml(ev.actor_email || '')} (${escapeHtml(ev.actor_role || '')}) · class ${escapeHtml(ev.class_id || '')}</div>
      </div>
    `).join('') || '<div style="color:#888;">No events yet.</div>';
  }

  function bindUi() {
    document.getElementById('classroomSendFileCancelBtn')?.addEventListener('click', () => {
      document.getElementById('classroomSendFileModal').style.display = 'none';
      sendFileItem = null;
    });
    document.getElementById('classroomSendFileSubmitBtn')?.addEventListener('click', () => submitSendFile());
    document.getElementById('classroomAuditCloseBtn')?.addEventListener('click', () => {
      document.getElementById('classroomAuditModal').style.display = 'none';
    });
    document.getElementById('classroomLogRefreshBtn')?.addEventListener('click', loadClassroomLog);
  }

  function addCtxMenuItems(menu, item, closeMenu) {
    if (!canSendFile(item)) return;
    const btn = document.createElement('button');
    btn.textContent = '📤 Send to…';
    btn.onclick = () => {
      closeMenu();
      openSendModal(item);
    };
    menu.insertBefore(btn, menu.querySelector('.danger') || null);
  }

  window.ClassroomFiles = {
    addCtxMenuItems,
    openSendModal,
    openAuditModal,
    resetStudentExamples,
    loadClassroomLog,
    canSendFile,
  };

  bindUi();
})();
