/**
 * Classroom raise-hand and question UI (requires app-core.js + Socket.IO).
 */
(function () {
  'use strict';

  let handRaised = false;
  let openQuestions = [];
  let teacherHands = [];
  let teacherQuestions = [];

  function ctx() {
    return window.EagleIDE?.getContext?.() || {};
  }

  function getSocket() {
    return window.eagleSocket;
  }

  function getClassId() {
    const c = ctx();
    if (c.TEACHER_TOKEN) return c.currentTeacherClassId;
    return c.getCurrentClassContext?.()?.id;
  }

  function classSettings() {
    return ctx().getCurrentClassContext?.()?.settings || {};
  }

  function isStudentInClass() {
    const c = ctx();
    return !!c.USER_TOKEN && !c.TEACHER_TOKEN && !c.ADMIN_TOKEN && !!c.getCurrentClassContext?.();
  }

  function isTeacherView() {
    const c = ctx();
    return !!c.TEACHER_TOKEN && !!getClassId();
  }

  function emitSocket(event, payload) {
    const socket = getSocket();
    if (!socket) return;
    const c = ctx();
    const classId = getClassId();
    if (!classId) return;
    const token = c.TEACHER_TOKEN || c.USER_TOKEN;
    socket.emit(event, { class_id: classId, token, ...payload });
  }

  function updateFabVisibility() {
    const fab = document.getElementById('classroomFab');
    if (!fab) return;
    const settings = classSettings();
    const show = isStudentInClass() && settings.raise_hand_enabled !== false;
    fab.hidden = !show;
    if (!show) {
      document.getElementById('classroomFabMenu')?.setAttribute('hidden', '');
    }
  }

  function updateFabState() {
    const main = document.getElementById('classroomFabMain');
    if (!main) return;
    main.classList.toggle('raised', handRaised);
    main.title = handRaised ? 'Hand raised — tap to lower' : 'Classroom help';
    main.textContent = handRaised ? '✋' : '💬';
  }

  function renderTeacherStrip() {
    const strip = document.getElementById('classroomTeacherStrip');
    if (!strip) return;
    if (!isTeacherView()) {
      strip.hidden = true;
      strip.innerHTML = '';
      return;
    }
    const settings = classSettings();
    if (settings.raise_hand_enabled === false) {
      strip.hidden = true;
      strip.innerHTML = '';
      return;
    }
    const hasHands = teacherHands.length > 0;
    const hasQuestions = teacherQuestions.length > 0;
    if (!hasHands && !hasQuestions) {
      strip.hidden = true;
      strip.innerHTML = '';
      return;
    }
    strip.hidden = false;
    let html = '';
    if (hasHands) {
      html += `<div class="classroom-strip-card hands"><strong>Raised hands:</strong> `;
      html += teacherHands.map(h => `
        <span class="classroom-hand-chip">
          ${escapeHtml(h.student_name || h.student_email)}
          <button type="button" data-ack-email="${escapeHtml(h.student_email)}">Acknowledge</button>
        </span>
      `).join('');
      html += '</div>';
    }
    if (hasQuestions) {
      html += teacherQuestions.map(q => `
        <div class="classroom-strip-card classroom-question-card" data-qid="${escapeHtml(q.id)}">
          <div class="q-meta">${escapeHtml(q.student_name || q.student_email)}</div>
          <div class="q-text">${escapeHtml(q.text)}</div>
          <div class="classroom-question-actions">
            <button type="button" class="primary" data-respond="${escapeHtml(q.id)}">Respond</button>
            <button type="button" data-dismiss="${escapeHtml(q.id)}">Dismiss</button>
          </div>
        </div>
      `).join('');
    }
    strip.innerHTML = html;
    strip.querySelectorAll('[data-ack-email]').forEach(btn => {
      btn.addEventListener('click', () => {
        emitSocket('classroom_hand_ack', { student_email: btn.dataset.ackEmail });
      });
    });
    strip.querySelectorAll('[data-dismiss]').forEach(btn => {
      btn.addEventListener('click', () => {
        emitSocket('classroom_question_dismiss', { question_id: btn.dataset.dismiss });
      });
    });
    strip.querySelectorAll('[data-respond]').forEach(btn => {
      btn.addEventListener('click', () => {
        const response = prompt('Your response to the student:');
        if (!response || !response.trim()) return;
        emitSocket('classroom_question_respond', {
          question_id: btn.dataset.respond,
          response: response.trim().slice(0, 500),
        });
      });
    });
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function loadTeacherSignals() {
    const c = ctx();
    if (!c.TEACHER_TOKEN || !getClassId()) return;
    try {
      const res = await fetch(`/api/teacher/classroom/signals?classId=${encodeURIComponent(getClassId())}`, {
        headers: { 'X-Teacher-Token': c.TEACHER_TOKEN },
      });
      const j = await res.json().catch(() => ({}));
      if (j?.ok) {
        teacherHands = j.hands || [];
        teacherQuestions = j.questions || [];
        renderTeacherStrip();
      }
    } catch {}
  }

  function bindSocketHandlers(socket) {
    socket.on('classroom_hands_update', msg => {
      if (!msg || msg.class_id !== getClassId()) return;
      if (isTeacherView()) {
        teacherHands = msg.hands || [];
        renderTeacherStrip();
      }
      if (isStudentInClass()) {
        const c = ctx();
        const email = (c.currentUser?.email || '').toLowerCase();
        handRaised = (msg.hands || []).some(h => (h.student_email || '').toLowerCase() === email);
        updateFabState();
      }
    });

    socket.on('classroom_questions_update', msg => {
      if (!msg || msg.class_id !== getClassId()) return;
      if (isTeacherView()) {
        teacherQuestions = msg.questions || [];
        renderTeacherStrip();
      }
    });

    socket.on('classroom_question_responded', msg => {
      if (!isStudentInClass() || msg?.class_id !== getClassId()) return;
      const c = ctx();
      const myEmail = (c.currentUser?.email || '').toLowerCase();
      if (msg.student_email && String(msg.student_email).toLowerCase() !== myEmail) return;
      alert(`Teacher response:\n\n${msg.response || ''}`);
    });

    socket.on('classroom_question_error', msg => {
      if (msg?.class_id !== getClassId()) return;
      alert(msg.error || 'Could not submit question');
    });

    socket.on('classroom_file_received', msg => {
      if (!isStudentInClass() || msg?.class_id !== getClassId()) return;
      const c = ctx();
      const myEmail = (c.currentUser?.email || '').toLowerCase();
      if (msg.target_email && String(msg.target_email).toLowerCase() !== myEmail) return;
      if (confirm(`New shared file from ${msg.from_name || 'someone'}: ${msg.filename || 'file'}\n\nRefresh file list?`)) {
        c.loadFileTree?.();
      }
    });
  }

  function bindUi() {
    const main = document.getElementById('classroomFabMain');
    const menu = document.getElementById('classroomFabMenu');
    main?.addEventListener('click', () => {
      if (handRaised) {
        emitSocket('classroom_hand_lower', {});
        handRaised = false;
        updateFabState();
        menu?.setAttribute('hidden', '');
        return;
      }
      const hidden = menu?.hasAttribute('hidden');
      if (hidden) menu?.removeAttribute('hidden');
      else menu?.setAttribute('hidden', '');
    });

    document.getElementById('classroomRaiseHandBtn')?.addEventListener('click', () => {
      emitSocket('classroom_hand_raise', {});
      handRaised = true;
      updateFabState();
      menu?.setAttribute('hidden', '');
    });

    document.getElementById('classroomAskQuestionBtn')?.addEventListener('click', () => {
      menu?.setAttribute('hidden', '');
      document.getElementById('classroomQuestionModal').style.display = 'flex';
      const input = document.getElementById('classroomQuestionInput');
      if (input) {
        input.value = '';
        input.focus();
      }
    });

    document.getElementById('classroomQuestionCancelBtn')?.addEventListener('click', () => {
      document.getElementById('classroomQuestionModal').style.display = 'none';
    });

    document.getElementById('classroomQuestionSubmitBtn')?.addEventListener('click', () => {
      const text = (document.getElementById('classroomQuestionInput')?.value || '').trim();
      if (!text) return alert('Enter a question');
      emitSocket('classroom_question_submit', { text: text.slice(0, 200) });
      document.getElementById('classroomQuestionModal').style.display = 'none';
    });
  }

  function onAuthChanged() {
    updateFabVisibility();
    updateFabState();
    if (isTeacherView()) loadTeacherSignals();
    else renderTeacherStrip();
  }

  window.ClassroomSignals = {
    onAuthChanged,
    loadTeacherSignals,
    refresh: onAuthChanged,
  };

  bindUi();

  window.addEventListener('eagle-socket-ready', e => {
    const socket = e.detail?.socket;
    if (socket) bindSocketHandlers(socket);
    onAuthChanged();
  });

  if (window.eagleSocket) {
    bindSocketHandlers(window.eagleSocket);
    onAuthChanged();
  }

  document.addEventListener('DOMContentLoaded', onAuthChanged);
})();
