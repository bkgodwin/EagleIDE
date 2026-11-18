/* Shared escaped report content, private illustrations and floating panels. */
(function () {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const ctx = () => window.EagleIDE?.getContext?.() || {};
  const identity = () => ctx().ADMIN_TOKEN || ctx().TEACHER_TOKEN || ctx().USER_TOKEN || '';
  const imageCache=new Map();let cacheSession='';
  function headers(student=false) { const c=ctx(); return c.ADMIN_TOKEN?{'X-Admin-Token':c.ADMIN_TOKEN}:c.TEACHER_TOKEN?{[student&&c.currentTeacher?.is_coteacher?'X-User-Token':'X-Teacher-Token']:c.TEACHER_TOKEN}:{'X-User-Token':c.USER_TOKEN||''}; }
  function render(value) {
    const text=String(value || ''), pattern=/!\[([^\]\n]{0,200})\]\(lab-image:([a-f0-9]{32})\)|\{([^{}]{1,8000})\}/g;
    let html='', offset=0;
    for (const match of text.matchAll(pattern)) {
      html+=esc(text.slice(offset,match.index));
      html+=match[2] ? `<figure class="lab-report-image" data-report-image="${match[2]}"><span role="status">Image loading…</span><img alt="${esc(match[1] || 'Lab illustration')}" hidden decoding="async"></figure>` : `<button type="button" class="lab-copy-text" data-lab-copy="${esc(match[3])}" title="Copy to clipboard"><code>${esc(match[3])}</code><span aria-hidden="true">⧉</span></button>`;
      offset=match.index+match[0].length;
    }
    return `<div class="lab-report-prose">${html+esc(text.slice(offset))}</div>`;
  }
  function mount(root, {assignmentId='',classId='',student=false}={}) {
    const original=identity(), abort=new AbortController(), urls=new Map(), queue=[];
    let active=0,closed=false;
    const observer=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{
      for(const entry of entries) if(entry.isIntersecting && !entry.target.dataset.queued) {entry.target.dataset.queued='1';queue.push(entry.target);}
      drain();
    },{rootMargin:'120px'}):null;
    async function load(figure) {
      try {
        if(cacheSession!==original){imageCache.clear();cacheSession=original;}
        const query=new URLSearchParams({assignment_id:assignmentId,class_id:classId});
        const key=figure.dataset.reportImage+'?'+query,cached=imageCache.get(key);
        let blob=cached&&Date.now()-cached.at<30000?cached.blob:null;
        if(!blob){
          const response=await fetch(`/api/lab-reports/images/${figure.dataset.reportImage}?${query}`,{headers:headers(student),cache:'no-store',signal:AbortSignal.any?AbortSignal.any([abort.signal,AbortSignal.timeout(15000)]):abort.signal});
          if(!response.ok)throw Error('Image unavailable. Reopen the report to retry.');
          blob=await response.blob();
        }
        if(closed||original!==identity()||!root.isConnected)return;
        imageCache.delete(key);imageCache.set(key,{blob,at:Date.now()});
        let bytes=[...imageCache.values()].reduce((sum,item)=>sum+item.blob.size,0);
        for(const [old,item] of imageCache){if(imageCache.size<=12&&bytes<=12*1024*1024)break;bytes-=item.blob.size;imageCache.delete(old);}
        if(urls.size>=20){const [old,url]=urls.entries().next().value;URL.revokeObjectURL(url);urls.delete(old);old.querySelector('img').hidden=true;old.querySelector('span').textContent='Reopen report to load this image.';}
        const url=URL.createObjectURL(blob);urls.set(figure,url);
        const image=figure.querySelector('img');image.src=url;image.hidden=false;figure.querySelector('span').hidden=true;
      } catch(error) {if(!closed)figure.querySelector('span').textContent=error.message;}
    }
    function drain(){while(!closed&&active<2&&queue.length){const figure=queue.shift();active++;load(figure).finally(()=>{active--;drain();});}}
    root.querySelectorAll('[data-report-image]').forEach(figure=>{if(observer)observer.observe(figure);else{queue.push(figure);drain();}});
    async function copy(event) {
      const button=event.target.closest?.('[data-lab-copy]');if(!button||!root.contains(button))return;
      event.preventDefault(); // A copy command inside a checklist must not toggle its checkbox.
      const status=root.querySelector('[data-copy-status]');
      try{await navigator.clipboard.writeText(button.dataset.labCopy);if(status)status.textContent='Copied to clipboard';button.classList.add('is-copied');button.title='Copied to clipboard';}
      catch{if(status)status.textContent='Clipboard unavailable. Select the highlighted text and copy it.';button.title='Select this text and copy it manually';}
    }
    root.addEventListener('click',copy);
    return ()=>{closed=true;queue.length=0;abort.abort();observer?.disconnect();urls.forEach(url=>URL.revokeObjectURL(url));urls.clear();root.removeEventListener('click',copy);};
  }
  function floating(root) {
    const panel = root.querySelector('.lab-report-window');
    const handle = root.querySelector('[data-float-move]');
    const resize = root.querySelector('[data-float-resize]');
    const minimize = root.querySelector('[data-float-minimize]');
    const tile = root.querySelector('[data-float-restore]');
    const viewport = window.visualViewport;
    const margin = 8, tileSize = 48;
    let minimized = false, expanded, drag, moved = false;

    function bounds() {
      return {
        left: (viewport?.offsetLeft || 0) + margin,
        top: (viewport?.offsetTop || 0) + margin,
        width: (viewport?.width || innerWidth) - margin * 2,
        height: (viewport?.height || innerHeight) - margin * 2,
      };
    }

    function place({left, top, width, height}, topRight = false) {
      const area = bounds();
      if (minimized && tile) width = height = Math.min(tileSize, area.width, area.height);
      else {
        width = Math.min(Math.max(280, width), area.width);
        height = Math.min(Math.max(minimized ? 64 : 200, height), area.height);
      }
      const right = area.left + area.width - width;
      const bottom = area.top + area.height - height;
      Object.assign(panel.style, {
        width: width + 'px',
        height: height + 'px',
        left: (topRight ? right : Math.max(area.left, Math.min(left, right))) + 'px',
        top: (topRight ? area.top : Math.max(area.top, Math.min(top, bottom))) + 'px',
      });
    }

    function clamp() { place(panel.getBoundingClientRect()); }

    function restore(topRight = false) {
      const {left, top, width, height} = panel.getBoundingClientRect();
      const focusButton = minimized || topRight;
      const size = minimized ? expanded : {width, height};
      minimized = false;
      panel.classList.remove('is-minimized');
      minimize.textContent = 'Minimize';
      minimize.setAttribute('aria-expanded', 'true');
      place({left, top, width: size.width, height: size.height}, topRight);
      if (focusButton) minimize.focus({preventScroll: true});
    }

    function start(event) {
      if (drag || event.button !== 0 || event.isPrimary === false) return;
      moved = false;
      const control = event.target.closest('button, input, textarea, select, a, label, [contenteditable]');
      const grip = control === handle || control === resize;
      const restoreTile = tile && control === tile;
      if (!grip && !restoreTile && (control || !tile)) return;
      // Leave touch scrolling to the report body and keep clicks on the restore button native.
      if (grip || (event.pointerType === 'mouse' && !restoreTile)) event.preventDefault();
      drag = {
        id: event.pointerId, x: event.clientX, y: event.clientY,
        rect: panel.getBoundingClientRect(), resize: control === resize,
      };
    }

    function adjust(rect, dx, dy, resizing) {
      const {left, top, width, height} = rect;
      place(resizing ? {left, top, width: width + dx, height: height + dy}
        : {left: left + dx, top: top + dy, width, height});
    }

    function move(event) {
      if (drag?.id !== event.pointerId) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!moved) {
        if (Math.hypot(dx, dy) < 5) return;
        moved = true;
        panel.setPointerCapture(event.pointerId);
        panel.classList.add('is-dragging');
      }
      adjust(drag.rect, dx, dy, drag.resize);
    }

    function end(event) {
      if (drag?.id !== event.pointerId) return;
      drag = null;
      panel.classList.remove('is-dragging');
    }

    panel.addEventListener('pointerdown', start);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    panel.addEventListener('lostpointercapture', end);
    for (const control of [handle, resize, tile].filter(Boolean)) {
      control.addEventListener('keydown', event => {
        const delta = {ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16]}[event.key];
        if (!delta) return;
        event.preventDefault();
        adjust(panel.getBoundingClientRect(), ...delta, control === resize);
      });
    }
    if (tile) tile.onclick = event => { if (!moved || event.detail === 0) restore(); };
    minimize.onclick = () => {
      if (minimized) { restore(); return; }
      const rect = expanded = panel.getBoundingClientRect();
      minimized = true;
      panel.classList.add('is-minimized');
      minimize.setAttribute('aria-expanded', 'false');
      if (tile) {
        place({left: rect.right - tileSize, top: rect.top});
        tile.focus({preventScroll: true});
      } else {
        minimize.textContent = 'Expand';
        place({left: rect.left, top: rect.top, width: rect.width, height: Math.max(72, panel.querySelector('header').offsetHeight + 2)});
      }
    };
    clamp();
    window.addEventListener('resize', clamp);
    viewport?.addEventListener('resize', clamp);
    viewport?.addEventListener('scroll', clamp);
    return {restore, dispose() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('resize', clamp);
      viewport?.removeEventListener('resize', clamp);
      viewport?.removeEventListener('scroll', clamp);
    }};
  }
  window.LabReportContent={render,mount,floating,headers};
  window.addEventListener('eagle-context-updated',()=>{if(cacheSession!==identity()){imageCache.clear();cacheSession=identity();}});
})();
