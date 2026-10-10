/* Shared desktop/touch app shell, viewport sizing, and touch helpers. */
(function () {
  'use strict';

  const TABLET_BP = 1200;
  let viewportFrame = null;
  let editorFrame = null;
  const LAYOUT_KEY = 'eagleide-layout-orientation';
  const layoutListeners = new Set();

  function isHorizontal() {
    return document.body.classList.contains('workspace-horizontal');
  }

  function setOrientation(orientation, persist = true) {
    const horizontal = orientation === 'horizontal';
    document.body.classList.toggle('workspace-horizontal', horizontal);
    const button = document.getElementById('layoutToggleBtn');
    if (button) {
      button.textContent = horizontal ? '▤ Horizontal' : '▥ Vertical';
      button.title = horizontal ? 'Switch to vertical layout: editor beside shell and resources'
        : 'Switch to horizontal layout: editor above shell and resources';
      button.setAttribute('aria-label', button.title);
      button.setAttribute('aria-pressed', String(horizontal));
    }
    if (persist) {
      try { localStorage.setItem(LAYOUT_KEY, horizontal ? 'horizontal' : 'vertical'); } catch {}
    }
    layoutListeners.forEach(listener => listener());
    refreshEditors();
  }

  // Apply before the application initializes its resizers, including restored sessions.
  try { setOrientation(localStorage.getItem(LAYOUT_KEY), false); }
  catch { setOrientation('vertical', false); }

  function refreshEditors() {
    if (editorFrame) return;
    editorFrame = requestAnimationFrame(() => {
      editorFrame = null;
      document.querySelectorAll('#editorPanel .CodeMirror').forEach((element) => {
        if (element.clientWidth && element.clientHeight) element.CodeMirror?.refresh?.();
      });
    });
  }

  function syncAppHeight() {
    if (viewportFrame) cancelAnimationFrame(viewportFrame);
    viewportFrame = requestAnimationFrame(() => {
      viewportFrame = null;
      const viewport = window.visualViewport;
      // Pinch zoom must not reflow the workspace. Keyboard/browser chrome changes
      // at normal zoom do resize it, keeping the bottom controls on screen.
      if (viewport && Math.abs(viewport.scale - 1) > 0.01) {
        refreshEditors();
        return;
      }
      const viewportHeight = viewport?.height || window.innerHeight;
      if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return;
      document.documentElement.style.setProperty('--app-height', `${Math.round(viewportHeight)}px`);
      document.documentElement.style.setProperty('--app-offset-top', `${Math.round(viewport?.offsetTop || 0)}px`);
      refreshEditors();
    });
  }

  function isTabletWidth() {
    return window.matchMedia(`(max-width: ${TABLET_BP}px)`).matches;
  }

  function syncTabletMode() {
    // Keep the same panels and controls on iPad and desktop; do not switch to
    // mutually exclusive Editor/Shell/Resources screens based on viewport width.
    document.body.classList.remove('tablet-mode', 'panel-editor', 'panel-shell', 'panel-resources');
  }

  function initRoleMenu() {
    const menu = document.getElementById('roleMenu');
    const btn = document.getElementById('roleMenuBtn');
    if (!menu || !btn) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = menu.classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('click', () => {
      menu.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    });
    menu.addEventListener('click', (e) => e.stopPropagation());
  }

  function observeWorkspaceSize() {
    if (!window.ResizeObserver) return;
    const observer = new ResizeObserver(refreshEditors);
    ['editorContentStack', 'studentEditorWrap', 'teacherStreamPane', 'outer'].forEach((id) => {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
    });
  }

  function initLongPressContext() {
    const LONG_MS = 500;
    let timer = null;
    let targetItem = null;
    let startX = 0;
    let startY = 0;

    document.addEventListener('pointerdown', (e) => {
      const item = e.target.closest?.('.file-tree-item');
      if (!item || e.pointerType === 'mouse') return;
      if (timer) clearTimeout(timer);
      targetItem = item;
      startX = e.clientX;
      startY = e.clientY;
      timer = setTimeout(() => {
        item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: e.clientX, clientY: e.clientY }));
      }, LONG_MS);
    }, { passive: true });

    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      targetItem = null;
    };
    document.addEventListener('pointerup', cancel);
    document.addEventListener('pointercancel', cancel);
    document.addEventListener('pointermove', (e) => {
      if (!targetItem) return;
      if (Math.hypot(e.clientX - startX, e.clientY - startY) > 10) return cancel();
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el?.closest?.('.file-tree-item')?.isSameNode(targetItem)) cancel();
    });
  }

  window.addEventListener('resize', () => {
    syncTabletMode();
    syncAppHeight();
  }, { passive: true });
  window.addEventListener('pageshow', refreshEditors);
  window.visualViewport?.addEventListener('resize', syncAppHeight, { passive: true });
  window.visualViewport?.addEventListener('scroll', syncAppHeight, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshEditors();
  });
  document.fonts?.ready?.then(refreshEditors).catch(() => {});
  document.addEventListener('DOMContentLoaded', () => {
    syncAppHeight();
    syncTabletMode();
    initRoleMenu();
    observeWorkspaceSize();
    initLongPressContext();
    document.getElementById('layoutToggleBtn')?.addEventListener('click', () => {
      setOrientation(isHorizontal() ? 'vertical' : 'horizontal');
    });
  });

  window.EagleIDE = window.EagleIDE || {};
  window.EagleIDE.layout = { syncTabletMode, syncAppHeight, refreshEditors, isTabletWidth,
    isHorizontal, setOrientation, onOrientationChange: listener => layoutListeners.add(listener) };
})();
