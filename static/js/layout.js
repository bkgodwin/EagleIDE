/* App shell: tool tray, role menu, tablet panel nav, touch helpers */
(function () {
  'use strict';

  const TABLET_BP = 1200;
  let viewportFrame = null;

  function syncAppHeight() {
    if (viewportFrame) cancelAnimationFrame(viewportFrame);
    viewportFrame = requestAnimationFrame(() => {
      viewportFrame = null;
      const viewportHeight = window.visualViewport?.height || window.innerHeight;
      if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return;
      document.documentElement.style.setProperty('--app-height', `${Math.round(viewportHeight)}px`);
      const output = document.getElementById('output');
      if (output) output.scrollTop = output.scrollHeight;
    });
  }

  function isTabletWidth() {
    return window.matchMedia(`(max-width: ${TABLET_BP}px)`).matches;
  }

  function syncTabletMode() {
    document.body.classList.toggle('tablet-mode', isTabletWidth());
    if (!isTabletWidth()) {
      document.body.classList.remove('panel-editor', 'panel-shell', 'panel-resources');
    } else if (!document.body.classList.contains('panel-editor') &&
      !document.body.classList.contains('panel-shell') &&
      !document.body.classList.contains('panel-resources')) {
      document.body.classList.add('panel-editor');
    }
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
      else if (saved === null && isTabletWidth()) startCollapsed = true;
    } catch {
      if (isTabletWidth()) startCollapsed = true;
    }
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

  function initTabletPanelNav() {
    const nav = document.getElementById('tabletPanelNav');
    if (!nav) return;
    nav.querySelectorAll('button[data-panel]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const panel = btn.dataset.panel;
        document.body.classList.remove('panel-editor', 'panel-shell', 'panel-resources');
        document.body.classList.add(`panel-${panel}`);
        nav.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
      });
    });
  }

  function initLongPressContext() {
    const LONG_MS = 500;
    let timer = null;
    let targetItem = null;

    document.addEventListener('pointerdown', (e) => {
      const item = e.target.closest?.('.file-tree-item');
      if (!item || e.pointerType === 'mouse') return;
      targetItem = item;
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
    initTabletPanelNav();
    initLongPressContext();
  });

  window.EagleIDE = window.EagleIDE || {};
  window.EagleIDE.layout = { syncTabletMode, syncAppHeight, isTabletWidth, setToolTrayCollapsed };
})();
