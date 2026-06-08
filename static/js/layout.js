/* App shell: tool tray, role menu, tablet panel nav, touch helpers */
(function () {
  'use strict';

  const TABLET_BP = 1200;

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

  function initToolTray() {
    const toggle = document.getElementById('toolTrayToggle');
    const tray = document.getElementById('toolTray');
    if (!toggle || !tray) return;
    toggle.addEventListener('click', () => {
      const collapsed = tray.classList.toggle('collapsed');
      document.body.classList.toggle('tool-tray-collapsed', collapsed);
      toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      toggle.textContent = collapsed ? 'Tools ▸' : 'Tools ▾';
    });
    if (isTabletWidth()) {
      tray.classList.add('collapsed');
      document.body.classList.add('tool-tray-collapsed');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.textContent = 'Tools ▸';
    }
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

  function initShellFab() {
    const fab = document.getElementById('shellFab');
    const toggleBtn = document.getElementById('toggleShellBtn');
    if (!fab || !toggleBtn) return;
    fab.addEventListener('click', () => toggleBtn.click());
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

  function initEditorScrollOnFocus() {
    document.getElementById('editorPanel')?.addEventListener('focusin', () => {
      if (window.matchMedia('(pointer: coarse)').matches) {
        document.getElementById('editorPanel')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    });
  }

  window.addEventListener('resize', syncTabletMode);
  document.addEventListener('DOMContentLoaded', () => {
    syncTabletMode();
    initToolTray();
    initRoleMenu();
    initTabletPanelNav();
    initShellFab();
    initLongPressContext();
    initEditorScrollOnFocus();
  });

  window.EagleIDE = window.EagleIDE || {};
  window.EagleIDE.layout = { syncTabletMode, isTabletWidth };
})();
