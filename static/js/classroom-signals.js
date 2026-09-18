/**
 * Classroom raise-hand and question UI (requires app-core.js + Socket.IO).
 */
(function () {
  'use strict';

  let handRaised = false;
  let teacherHands = [];
  let teacherQuestions = [];
  let menuOpen = false;
  let signalContext = '';
  let signalRequest = 0;

  function ctx() {
    return window.EagleIDE?.getContext?.() || {};
  }

  function getSocket() {
    return window.eagleSocket;
  }

  function getClassId() {
    const c = ctx();
    if (c.TEACHER_TOKEN) return c.currentTeacherClassId || c.teacherClasses?.[0]?.id || null;
    return c.getCurrentClassContext?.()?.id || c.currentStudentClassId || null;
  }

  function classSettings() {
    const classCtx = ctx().getCurrentClassContext?.();
    if (classCtx?.settings) return classCtx.settings;
    const c = ctx();
    const id = getClassId();
    const fromList = (c.teacherClasses || c.studentClasses || []).find(cls => cls.id === id);
    return fromList?.settings || {};
  }

  function isStudentInClass() {
    const c = ctx();
    const role = String(c.currentUser?.role || 'student').toLowerCase();
    return !!c.USER_TOKEN
      && !c.TEACHER_TOKEN
      && !c.ADMIN_TOKEN
      && role === 'student'
      && !!c.getCurrentClassContext?.();
  }

  function isTeacherView() {
    const c = ctx();
    return !!c.TEACHER_TOKEN && !!getClassId();
  }

  function emitSocket(event, payload) {
    const socket = getSocket();
    if (!socket) return false;
    const c = ctx();
    const classId = getClassId();
    if (!classId) return false;
    const token = c.TEACHER_TOKEN || c.USER_TOKEN;
    socket.emit(event, { class_id: classId, token, ...payload });
    return true;
  }

  function setMenuOpen(open) {
    menuOpen = !!open;
    const menu = document.getElementById('classroomFabMenu');
    const main = document.getElementById('classroomFabMain');
    if (menu) {
      if (menuOpen) menu.removeAttribute('hidden');
      else menu.setAttribute('hidden', '');
    }
    if (main) main.setAttribute('aria-expanded', menuOpen ? 'true' : 'false');
  }

  function updateFabVisibility() {
    const fab = document.getElementById('classroomFab');
    if (!fab) return;
    const settings = classSettings();
    const show = isStudentInClass() && settings.raise_hand_enabled !== false;
    fab.hidden = !show;
    setMenuOpen(false);
  }

  function updateFabState() {
    const main = document.getElementById('classroomFabMain');
    const raiseBtn = document.getElementById('classroomRaiseHandBtn');
    if (!main) return;
    main.classList.toggle('raised', handRaised);
    main.title = handRaised ? 'Hand raised' : 'Classroom help';
    main.textContent = handRaised ? '✋' : '💬';
    if (raiseBtn) {
      raiseBtn.textContent = handRaised ? '✋ Lower hand' : '✋ Raise hand';
    }
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
      const newestFirst = teacherQuestions.slice().reverse();
      html += '<div class="classroom-question-list" aria-label="Student questions, newest first">';
      html += newestFirst.map(q => `
        <div class="classroom-strip-card classroom-question-card" data-qid="${escapeHtml(q.id)}">
          <div class="q-meta">${escapeHtml(q.student_name || q.student_email)}</div>
          <div class="q-text">${escapeHtml(q.text)}</div>
          <div class="classroom-question-actions">
            <button type="button" class="primary" data-respond="${escapeHtml(q.id)}">Respond</button>
            <button type="button" data-dismiss="${escapeHtml(q.id)}">Dismiss</button>
            <button type="button" class="silence" data-silence-email="${escapeHtml(q.student_email)}" data-silence-name="${escapeHtml(q.student_name || q.student_email)}">Silence 5 min</button>
          </div>
        </div>
      `).join('');
      html += '</div>';
    }
    strip.innerHTML = html;
    const questionList = strip.querySelector?.('.classroom-question-list') || null;
    const questionCards = questionList ? Array.from(questionList.children) : [];
    if (questionList && questionCards.length > 2) {
      const visibleHeight = questionCards[0].getBoundingClientRect().height
        + questionCards[1].getBoundingClientRect().height + 8;
      questionList.style.maxHeight = `${Math.ceil(visibleHeight)}px`;
    }
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
    strip.querySelectorAll('[data-silence-email]').forEach(btn => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.silenceName || btn.dataset.silenceEmail || 'this student';
        if (!confirm(`Silence questions from ${name} for 5 minutes? Their current questions will be dismissed.`)) return;
        emitSocket('classroom_question_silence', { student_email: btn.dataset.silenceEmail });
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
    const classId = getClassId();
    if (!c.TEACHER_TOKEN || !classId) return;
    const requestId = ++signalRequest;
    const token = c.TEACHER_TOKEN;
    try {
      const res = await fetch(`/api/teacher/classroom/signals?classId=${encodeURIComponent(classId)}`, {
        headers: { 'X-Teacher-Token': c.TEACHER_TOKEN },
      });
      const j = await res.json().catch(() => ({}));
      if (requestId !== signalRequest || getClassId() !== classId || ctx().TEACHER_TOKEN !== token) return;
      if (res.ok && j?.ok) {
        teacherHands = j.hands || [];
        teacherQuestions = j.questions || [];
        renderTeacherStrip();
      }
    } catch {}
  }

  function bindSocketHandlers(socket) {
    if (socket.__classroomBound) return;
    socket.__classroomBound = true;

    socket.on('classroom_hands_update', msg => {
      if (!msg || msg.class_id !== getClassId()) return;
      if (isTeacherView()) {
        ++signalRequest; // A live update is newer than an outstanding HTTP snapshot.
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
        ++signalRequest;
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

    socket.on('classroom_question_silenced', msg => {
      if (!isStudentInClass() || msg?.class_id !== getClassId()) return;
      const email = String(ctx().currentUser?.email || '').toLowerCase();
      if (String(msg.student_email || '').toLowerCase() !== email) return;
      alert('Your classroom questions have been paused for 5 minutes.');
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

    socket.on('connect', () => {
      if (typeof window.rejoinClassRooms === 'function') {
        window.rejoinClassRooms();
      } else {
        const c = ctx();
        const classId = getClassId();
        const token = c.TEACHER_TOKEN || c.USER_TOKEN;
        if (!classId || !token) return;
        const role = c.TEACHER_TOKEN ? 'teacher' : 'student';
        socket.emit('join_class_room', { role, token, class_id: classId });
      }
      if (ctx().TEACHER_TOKEN) loadTeacherSignals();
    });
  }

  function bindUi() {
    const main = document.getElementById('classroomFabMain');
    const menu = document.getElementById('classroomFabMenu');

    main?.addEventListener('click', (e) => {
      e.stopPropagation();
      setMenuOpen(!menuOpen);
    });

    document.addEventListener('click', (e) => {
      if (!menuOpen) return;
      if (e.target.closest('#classroomFab')) return;
      setMenuOpen(false);
    });

    document.getElementById('classroomRaiseHandBtn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (handRaised) {
        emitSocket('classroom_hand_lower', {});
        handRaised = false;
      } else {
        if (!emitSocket('classroom_hand_raise', {})) {
          alert('Could not raise hand. Check your connection and class selection.');
          return;
        }
        handRaised = true;
      }
      updateFabState();
      setMenuOpen(false);
    });

    document.getElementById('classroomAskQuestionBtn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      setMenuOpen(false);
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
      if (!emitSocket('classroom_question_submit', { text: text.slice(0, 200) })) {
        alert('Could not send question. Check your connection.');
        return;
      }
      document.getElementById('classroomQuestionModal').style.display = 'none';
    });

    if (menu) menu.setAttribute('hidden', '');
  }

  function onAuthChanged() {
    const c = ctx();
    const nextContext = `${c.TEACHER_TOKEN || c.USER_TOKEN || ''}:${getClassId() || ''}`;
    if (nextContext !== signalContext) {
      signalContext = nextContext;
      ++signalRequest;
      handRaised = false;
      teacherHands = [];
      teacherQuestions = [];
      setMenuOpen(false);
      const questionModal = document.getElementById('classroomQuestionModal');
      if (questionModal) questionModal.style.display = 'none';
    }
    updateFabVisibility();
    updateFabState();
    renderTeacherStrip();
    if (isTeacherView()) loadTeacherSignals();
  }

  window.ClassroomSignals = {
    onAuthChanged,
    loadTeacherSignals,
    refresh: onAuthChanged,
  };

  bindUi();

  function initSocket() {
    const socket = window.eagleSocket;
    if (socket) bindSocketHandlers(socket);
    onAuthChanged();
  }

  window.addEventListener('eagle-socket-ready', initSocket);
  if (window.eagleSocket) initSocket();
  document.addEventListener('DOMContentLoaded', onAuthChanged);
})();
