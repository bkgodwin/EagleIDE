/* Shared desktop/touch app shell, viewport sizing, and touch helpers. */
(function () {
  'use strict';

  const TABLET_BP = 1200;
  let viewportFrame = null;
  let editorFrame = null;

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
      if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
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

  function setToolTrayCollapsed(collapsed) {
    const tray = document.getElementById('toolTray');
    const btn = document.getElementById('topbarToolsBtn');
    if (!tray) return;
    tray.classList.toggle('collapsed', collapsed);
    document.body.classList.toggle('tool-tray-collapsed', collapsed);
    if (btn) {
      btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      btn.textContent = collapsed ? 'Tools ▸' : 'Tools ▾';
    }
    refreshEditors();
    try {
      localStorage.setItem('eagleide-tool-tray-collapsed', collapsed ? '1' : '0');
    } catch {}
  }

  function initToolTray() {
    const btn = document.getElementById('topbarToolsBtn');
    const tray = document.getElementById('toolTray');
    if (!btn || !tray) return;

    btn.addEventListener('click', () => {
      setToolTrayCollapsed(!tray.classList.contains('collapsed'));
    });

    let startCollapsed = false;
    try {
      const saved = localStorage.getItem('eagleide-tool-tray-collapsed');
      if (saved === '1') startCollapsed = true;
    } catch {}
    setToolTrayCollapsed(startCollapsed);
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
    ['editorContentStack', 'teacherStreamPane', 'outer'].forEach((id) => {
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
  window.visualViewport?.addEventListener('resize', syncAppHeight, { passive: true });
  window.visualViewport?.addEventListener('scroll', syncAppHeight, { passive: true });
  document.addEventListener('DOMContentLoaded', () => {
    syncAppHeight();
    syncTabletMode();
    initToolTray();
    initRoleMenu();
    observeWorkspaceSize();
    initLongPressContext();
  });

  window.EagleIDE = window.EagleIDE || {};
  window.EagleIDE.layout = { syncTabletMode, syncAppHeight, refreshEditors, isTabletWidth, setToolTrayCollapsed };
})();
