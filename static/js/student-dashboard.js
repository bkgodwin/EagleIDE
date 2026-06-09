/**
 * Student dashboard — skill mastery progress and achievement toasts.
 */
(function () {
  'use strict';

  const BAND_RANK = { untested: 0, red: 1, bronze: 2, silver: 3, gold: 4 };
  const BAND_LABEL = {
    untested: 'Untested',
    red: 'Red',
    bronze: 'Bronze',
    silver: 'Silver',
    gold: 'Gold',
  };
  const STORAGE_PREFIX = 'eagleide-skill-bands-';
  let listenersAttached = false;
  let masteryPollTimer = null;

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

  function isStudent() {
    const c = ctx();
    return !!(c.USER_TOKEN && !c.TEACHER_TOKEN && !c.ADMIN_TOKEN);
  }

  function getClassId() {
    const c = ctx();
    return c.getCurrentClassContext?.()?.id || c.currentStudentClassId || null;
  }

  function storageKey(classId) {
    return `${STORAGE_PREFIX}${classId || 'none'}`;
  }

  function loadStoredBands(classId) {
    try {
      const raw = localStorage.getItem(storageKey(classId));
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  function saveStoredBands(classId, bands) {
    try {
      localStorage.setItem(storageKey(classId), JSON.stringify(bands || {}));
    } catch {}
  }

  function scoreLabel(score) {
    if (score === null || score === undefined) return '—';
    return `${Math.round(Number(score))}%`;
  }

  function renderSkillCard(skill) {
    const band = skill.band || 'untested';
    const untested = band === 'untested';
    return `
      <article class="student-skill-card${untested ? ' is-untested' : ''}">
        <div class="student-skill-medal student-skill-medal--${escapeHtml(band)}" title="${escapeHtml(BAND_LABEL[band] || band)}"></div>
        <div class="student-skill-name">${escapeHtml(skill.name)}</div>
        <div class="student-skill-score">${escapeHtml(scoreLabel(skill.score))}</div>
        <div class="student-skill-band student-skill-band--${escapeHtml(band)}">${escapeHtml(BAND_LABEL[band] || band)}</div>
        <p class="student-skill-description">${escapeHtml(skill.description || 'No description provided for this skill.')}</p>
      </article>
    `;
  }

  async function fetchMastery(classId) {
    const c = ctx();
    if (!c.USER_TOKEN || !classId) return null;
    const res = await fetch(`/api/student/mastery?classId=${encodeURIComponent(classId)}`, {
      headers: { 'X-User-Token': c.USER_TOKEN },
    });
    const data = await res.json().catch(() => ({}));
    if (!data?.ok) return null;
    return data.report || null;
  }

  function detectLevelUps(classId, skills, { silent = false } = {}) {
    if (!classId || !Array.isArray(skills)) return [];
    const previous = loadStoredBands(classId);
    const next = {};
    const upgrades = [];

    skills.forEach((skill) => {
      const name = skill?.name;
      if (!name) return;
      const band = skill.band || 'untested';
      next[name] = band;
      const oldBand = previous[name] || 'untested';
      const oldRank = BAND_RANK[oldBand] ?? 0;
      const newRank = BAND_RANK[band] ?? 0;
      if (newRank > oldRank) {
        upgrades.push({
          name,
          from: oldBand,
          to: band,
          score: skill.score,
        });
      }
    });

    const hadPrevious = Object.keys(previous).length > 0;
    saveStoredBands(classId, next);

    if (silent || !hadPrevious || !upgrades.length) return [];
    return upgrades;
  }

  function showAchievementToasts(upgrades) {
    const stack = document.getElementById('studentAchievementToastStack');
    if (!stack || !upgrades.length) return;

    const toast = document.createElement('div');
    toast.className = 'student-achievement-toast';
    toast.innerHTML = `
      <div class="student-achievement-toast-title">New achievement${upgrades.length > 1 ? 's' : ''}!</div>
      <ul class="student-achievement-toast-list">
        ${upgrades.map((item) => `
          <li class="student-achievement-toast-item">
            <span class="student-skill-medal student-skill-medal--${escapeHtml(item.to)}" style="width:28px;height:28px;border-width:2px;"></span>
            <span><strong>${escapeHtml(item.name)}</strong> — ${escapeHtml(BAND_LABEL[item.from] || item.from)} → ${escapeHtml(BAND_LABEL[item.to] || item.to)}${item.score != null ? ` (${Math.round(item.score)}%)` : ''}</span>
          </li>
        `).join('')}
      </ul>
    `;
    stack.appendChild(toast);

    const dismissMs = Math.min(9000, 3500 + (upgrades.length * 900));
    setTimeout(() => {
      toast.classList.add('is-leaving');
      setTimeout(() => toast.remove(), 260);
    }, dismissMs);
  }

  async function renderMasteryPane() {
    const pane = document.getElementById('studentMasteryPane');
    if (!pane) return;
    const classId = getClassId();
    if (!classId) {
      pane.innerHTML = '<div style="color:#888; padding:12px 0;">Join a class to track skill mastery.</div>';
      return;
    }
    pane.innerHTML = '<div style="color:#888; padding:12px 0;">Loading skill mastery…</div>';
    const report = await fetchMastery(classId);
    if (!report) {
      pane.innerHTML = '<div style="color:#ef5350; padding:12px 0;">Could not load skill mastery.</div>';
      return;
    }
    const skills = report.skills || [];
    const className = report.class?.name || 'Class';
    pane.innerHTML = `
      <div style="font-size:12px; color:var(--theme-text-dim); margin-bottom:10px;">
        ${escapeHtml(className)} · ${skills.length} skill${skills.length === 1 ? '' : 's'} tracked
      </div>
      <div class="student-skill-scroll">
        <div class="student-skill-grid">
          ${skills.length
            ? skills.map(renderSkillCard).join('')
            : '<div style="grid-column:1/-1; padding:16px; color:#888;">No skills have been added for this class yet.</div>'}
        </div>
      </div>
    `;
  }

  async function checkAchievements({ silent = false } = {}) {
    if (!isStudent()) return;
    const classId = getClassId();
    if (!classId) return;
    const report = await fetchMastery(classId);
    if (!report) return;
    const upgrades = detectLevelUps(classId, report.skills || [], { silent });
    if (upgrades.length) showAchievementToasts(upgrades);
  }

  function stopMasteryPolling() {
    if (masteryPollTimer) {
      clearInterval(masteryPollTimer);
      masteryPollTimer = null;
    }
  }

  function startMasteryPolling() {
    stopMasteryPolling();
    if (!isStudent()) return;
    masteryPollTimer = setInterval(() => {
      if (document.hidden) return;
      checkAchievements({ silent: false }).catch(() => {});
    }, 60000);
  }

  function openDashboard() {
    const modal = document.getElementById('studentDashboardModal');
    if (!modal || !isStudent()) return;
    modal.style.display = 'flex';
    renderMasteryPane().catch(() => {});
    checkAchievements({ silent: true }).catch(() => {});
  }

  function closeDashboard() {
    const modal = document.getElementById('studentDashboardModal');
    if (modal) modal.style.display = 'none';
  }

  function bindUi() {
    if (listenersAttached) return;
    listenersAttached = true;

    document.getElementById('studentDashboardBtn')?.addEventListener('click', openDashboard);
    document.getElementById('studentDashCloseBtn')?.addEventListener('click', closeDashboard);

    const modal = document.getElementById('studentDashboardModal');
    modal?.addEventListener('click', (e) => {
      if (e.target === modal) closeDashboard();
    });
  }

  function onAuthChanged() {
    const btn = document.getElementById('studentDashboardBtn');
    const show = isStudent() && !!getClassId();
    if (btn) btn.style.display = show ? '' : 'none';
    if (!show) {
      closeDashboard();
      stopMasteryPolling();
      return;
    }
    startMasteryPolling();
    checkAchievements({ silent: true }).catch(() => {});
  }

  window.StudentDashboard = {
    open: openDashboard,
    close: closeDashboard,
    refreshMastery: renderMasteryPane,
    checkAchievements,
    onAuthChanged,
    onClassChanged() {
      onAuthChanged();
      renderMasteryPane().catch(() => {});
    },
  };

  bindUi();
  document.addEventListener('DOMContentLoaded', onAuthChanged);
})();
