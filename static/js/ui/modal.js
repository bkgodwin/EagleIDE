/* Shared modal factory for assignment/quiz flows */
(function () {
  'use strict';

  function createModal({ title, body, actions, size = 'default', className = '' }) {
    const overlay = document.createElement('div');
    overlay.className = `modal glass-modal workspace-modal ${className}`.trim();
    overlay.style.display = 'flex';

    const content = document.createElement('div');
    content.className = 'modal-content glass-surface';

    if (size === 'large') {
      content.style.width = 'min(1500px, 96vw)';
      content.style.maxWidth = '96vw';
      content.style.maxHeight = '94vh';
      content.style.minHeight = '72vh';
    } else if (size === 'full') {
      content.style.width = '98vw';
      content.style.maxWidth = '1800px';
      content.style.height = '96vh';
      content.style.maxHeight = '96vh';
      content.style.padding = '0';
      content.style.display = 'flex';
      content.style.flexDirection = 'column';
      content.style.overflow = 'hidden';
    }

    const hdr = document.createElement('div');
    hdr.className = 'workspace-modal-header';
    const h = document.createElement('h3');
    h.textContent = title || '';
    hdr.appendChild(h);
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn btn--ghost secondary';
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.addEventListener('click', () => overlay.remove());
    hdr.appendChild(closeBtn);
    content.appendChild(hdr);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'workspace-modal-body';
    if (typeof body === 'string') bodyEl.innerHTML = body;
    else if (body instanceof Node) bodyEl.appendChild(body);
    else if (body) Object.assign(bodyEl, body);
    content.appendChild(bodyEl);

    if (actions && actions.length) {
      const act = document.createElement('div');
      act.className = 'modal-actions';
      actions.forEach((a) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `btn ${a.variant || 'secondary'}`.trim();
        btn.textContent = a.label;
        if (a.onClick) btn.addEventListener('click', a.onClick);
        act.appendChild(btn);
      });
      content.appendChild(act);
    }

    overlay.appendChild(content);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);
    return { overlay, content, bodyEl, close: () => overlay.remove() };
  }

  window.EagleIDE = window.EagleIDE || {};
  window.EagleIDE.createModal = createModal;
})();
