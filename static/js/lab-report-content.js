/* Shared escaped report content, private illustrations and floating panels. */
(function () {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const ctx = () => window.EagleIDE?.getContext?.() || {};
  const identity = () => ctx().ADMIN_TOKEN || ctx().TEACHER_TOKEN || ctx().USER_TOKEN || '';
  const imageCache=new Map();let cacheSession='';
  let copiedText = null, clipboardSession = '';
  async function writeClipboard(text) {
    copiedText = String(text).slice(0, 1000000);
    clipboardSession = identity();
    try { await navigator.clipboard.writeText(copiedText); }
    catch { return false; }
    return true;
  }
  async function readClipboard() {
    try { return await navigator.clipboard.readText(); }
    catch (error) {
      if (clipboardSession === identity() && copiedText !== null) return copiedText;
      throw error;
    }
  }
  function headers(student=false) { const c=ctx(); return c.ADMIN_TOKEN?{'X-Admin-Token':c.ADMIN_TOKEN}:c.TEACHER_TOKEN?{[student&&c.currentTeacher?.is_coteacher?'X-User-Token':'X-Teacher-Token']:c.TEACHER_TOKEN}:{'X-User-Token':c.USER_TOKEN||''}; }
  const imagePattern = /!\[([^\]\n]{0,200})\]\(lab-image:([a-f0-9]{32})\)/g;
  const contentPattern = new RegExp(imagePattern.source + '|' + /\{([^{}]{1,20000})\}/.source, 'g');

  function imageMarkup([, alt, id]) {
    return `<figure class="lab-report-image" data-report-image="${id}"><span role="status">Image loading…</span><img alt="${esc(alt || 'Lab illustration')}" hidden decoding="async"></figure>`;
  }

  function copyMarkup(text) {
    const attribute = value => esc(value).replace(/\r/g, '&#13;').replace(/\n/g, '&#10;');
    const button = (value, label) => `<button type="button" class="lab-copy-text" data-lab-copy="${attribute(value)}" title="Copy to clipboard">${label}<span aria-hidden="true">⧉</span></button>`;
    const images = [...text.matchAll(imagePattern)];
    if (!images.length) return button(text, `<code>${esc(text)}</code>`);
    const code = value => value ? `<code>${esc(value)}</code>` : '';
    let html = '', offset = 0;
    for (const image of images) {
      html += code(text.slice(offset, image.index)) + imageMarkup(image);
      offset = image.index + image[0].length;
    }
    html += code(text.slice(offset));
    const copyText = text.replace(imagePattern, '');
    return `<div class="lab-copy-with-images">${copyText.trim() ? button(copyText, 'Copy text') : ''}<div>${html}</div></div>`;
  }

  function render(value) {
    const text = String(value || '');
    let html = '', offset = 0;
    for (const match of text.matchAll(contentPattern)) {
      html += esc(text.slice(offset, match.index));
      html += match[2] ? imageMarkup(match) : copyMarkup(match[3]);
      offset = match.index + match[0].length;
    }
    return `<div class="lab-report-prose">${html + esc(text.slice(offset))}</div>`;
  }
  function sections(questions, {answers={}, preview=false, previewId="preview"}={}) {
    const labels = {written:'Written response', fill_blank:'Short answer', procedure:'Checklist'};
    return questions.map((question, index) => {
      if (question.type === 'text_box') {
        return `<section class="lab-report-question lab-report-text-box">${render(question.question)}</section>`;
      }
      const label = `report-label-${preview ? previewId + "-" : ""}${index}`;
      const field = `data-report-question="${esc(question.id)}" ${preview ? 'disabled' : ''}`;
      const answer = answers[question.id];
      let control;
      if (question.type === 'procedure') {
        control = '<p class="lab-report-check-hint">Select every checkbox in this checklist to receive credit for this section.</p>';
        control += (question.steps || []).map((step, i) =>
          `<div class="lab-report-check-row"><input type="checkbox" aria-label="Section ${index+1}, step ${i+1}" ${field} data-step="${i}" ${Array.isArray(answer) && answer[i] ? 'checked' : ''}>${render(step)}</div>`
        ).join('');
      } else if (question.type === 'fill_blank') {
        control = `<input type="text" aria-labelledby="${label}" placeholder="Your answer" maxlength="20000" ${field} value="${esc(answer)}" autocomplete="off">`;
      } else {
        control = `<textarea aria-labelledby="${label}" maxlength="20000" placeholder="Record your observations…" ${field}>\n${esc(answer)}</textarea>`;
      }
      return `<section class="lab-report-question">
        <div class="lab-report-question-meta"><span>Section ${index+1} · ${labels[question.type] || labels.written}</span><span>${Number(question.points) || 0} points</span></div>
        <div class="lab-report-prompt" id="${label}">${render(question.question)}</div>${control}
      </section>`;
    }).join('');
  }

  function mount(root, {assignmentId='',classId='',student=false,livePreview=false}={}) {
    const original=identity(), abort=new AbortController(), urls=new Map(), figures=new Set(), queue=[];
    const requested = new WeakSet();
    let active=0,closed=false;
    const observer=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{
      for(const entry of entries) if(entry.isIntersecting && figures.has(entry.target) && !requested.has(entry.target)) {
        requested.add(entry.target);
        observer.unobserve(entry.target);
        queue.push(entry.target);
      }
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
        if(closed||original!==identity()||!root.contains(figure))return;
        imageCache.delete(key);imageCache.set(key,{blob,at:Date.now()});
        let bytes=[...imageCache.values()].reduce((sum,item)=>sum+item.blob.size,0);
        for(const [old,item] of imageCache){if(imageCache.size<=12&&bytes<=12*1024*1024)break;bytes-=item.blob.size;imageCache.delete(old);}
        if(urls.size>=20){const [old,url]=urls.entries().next().value;URL.revokeObjectURL(url);urls.delete(old);old.querySelector('img').hidden=true;const status=old.querySelector('span');status.hidden=false;status.textContent='Reopen report to load this image.';}
        const url=URL.createObjectURL(blob);urls.set(figure,url);
        const image=figure.querySelector('img');image.src=url;image.hidden=false;figure.querySelector('span').hidden=true;
      } catch(error) {if(!closed)figure.querySelector('span').textContent=error.message;}
    }
    function drain(){while(!closed&&active<2&&queue.length){const figure=queue.shift();if(!figures.has(figure))continue;active++;load(figure).finally(()=>{active--;drain();});}}
    function syncImages() {
      const current = new Set(root.querySelectorAll('[data-report-image]'));
      for (const figure of figures) {
        if (current.has(figure)) continue;
        observer?.unobserve(figure);
        if (urls.has(figure)) URL.revokeObjectURL(urls.get(figure));
        urls.delete(figure);
        figures.delete(figure);
      }
      for (const figure of current) {
        if (figures.has(figure)) continue;
        figures.add(figure);
        if (observer) observer.observe(figure);
        else queue.push(figure);
      }
      drain();
    }
    syncImages();
    const previewObserver = livePreview ? new MutationObserver(syncImages) : null;
    previewObserver?.observe(root, {childList:true});
    async function copy(event) {
      const button=event.target.closest?.('[data-lab-copy]');if(!button||!root.contains(button))return;
      event.preventDefault(); // A copy command inside a checklist must not toggle its checkbox.
      const status=root.querySelector('[data-copy-status]');
      try{const system=await writeClipboard(button.dataset.labCopy);if(status)status.textContent=system?'Copied to clipboard':'Copied for Eagle Lab';button.classList.add('is-copied');button.title='Copied for Eagle Lab';}
      catch{if(status)status.textContent='Clipboard unavailable. Select the highlighted text and copy it.';button.title='Select this text and copy it manually';}
    }
    root.addEventListener('click',copy);
    return ()=>{closed=true;queue.length=0;abort.abort();observer?.disconnect();previewObserver?.disconnect();urls.forEach(url=>URL.revokeObjectURL(url));urls.clear();root.removeEventListener('click',copy);};
  }
  function floating(root, {topRightOffset = () => 0} = {}) {
    const panel = root.querySelector('.lab-report-window');
    const resize = root.querySelector('[data-float-resize]');
    const minimize = root.querySelector('[data-float-minimize]');
    const tile = root.querySelector('[data-float-restore]');
    const viewport = window.visualViewport;
    const margin = 8, tileSize = 48;
    const page = root.querySelector('.lab-report-page');
    let minimized = false, expanded, drag, moved = false, touchScroll;

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
      const anchor = topRight ? Math.max(area.top, topRightOffset()) : area.top;
      if (topRight) height = Math.min(height, Math.max(Math.min(200,area.height), area.height + area.top - anchor));
      const right = area.left + area.width - width;
      const bottom = area.top + area.height - height;
      Object.assign(panel.style, {
        width: width + 'px',
        height: height + 'px',
        left: (topRight ? right : Math.max(area.left, Math.min(left, right))) + 'px',
        top: (topRight ? Math.min(bottom, anchor) : Math.max(area.top, Math.min(top, bottom))) + 'px',
      });
    }

    function clamp() { place(panel.getBoundingClientRect()); }

    function restore(topRight = false) {
      const {left, top, width, height} = panel.getBoundingClientRect();
      const focusButton = minimized || topRight;
      const size = minimized ? expanded : {width, height};
      minimized = false;
      panel.classList.remove('is-minimized');
      minimize.setAttribute('aria-expanded', 'true');
      place({left, top, width: size.width, height: size.height}, topRight);
      if (focusButton) minimize.focus({preventScroll: true});
    }

    function dragControl(target) {
      const control = target.closest('button, input, textarea, select, a, label, [contenteditable]');
      const grip = !!resize && control === resize;
      const restoreTile = !!tile && control === tile;
      return !control || grip || restoreTile ? {resize:grip, restoreTile} : null;
    }

    function start(event) {
      if (drag || event.pointerType === 'touch' || event.button !== 0 || event.isPrimary === false) return;
      moved = false;
      const grip = dragControl(event.target);
      if (!grip) return;
      if (!grip.restoreTile) event.preventDefault();
      drag = {
        id:event.pointerId, x:event.clientX, y:event.clientY,
        rect:panel.getBoundingClientRect(), resize:grip.resize,
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
    let touchButton, touchButtonPoint, touchActivatedAt = -1000;
    panel.addEventListener('pointerdown', event => {
      if (event.pointerType === 'mouse') touchActivatedAt = -1000;
      touchButton = event.pointerType === 'touch' ? event.target.closest('button') : null;
      touchButtonPoint = {x:event.clientX,y:event.clientY};
    });
    panel.addEventListener('pointerup', event => {
      if (!touchButton || moved || event.pointerType !== 'touch' ||
          Math.hypot(event.clientX-touchButtonPoint.x,event.clientY-touchButtonPoint.y)>5) return;
      const button = touchButton;
      touchButton = null;
      if (button.disabled) return;
      event.preventDefault();
      touchActivatedAt = performance.now();
      button.click();
    });
    panel.addEventListener('click', event => {
      // A touch tap may deliver its compatibility click after a window changes size.
      if (event.isTrusted && event.detail > 0 &&
          performance.now()-touchActivatedAt<600) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },true);
    for (const control of [panel, resize, tile].filter(Boolean)) {
      control.addEventListener('keydown', event => {
        if (event.target !== control) return;
        const delta = {ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16]}[event.key];
        if (!delta) return;
        event.preventDefault();
        adjust(panel.getBoundingClientRect(), ...delta, control === resize);
      });
    }
    // WebKit can cancel touch pointers as it takes over a scroll gesture. Handle
    // these drags in the touch stream and cancel the native pan on the first move.
    let touchDrag;
    function startTouch(event) {
      if (event.touches.length === 2 && event.target.closest('.lab-report-page')) {
        touchDrag = null;
        panel.classList.remove('is-dragging');
        touchScroll = {y:touchCenter(event), top:page.scrollTop};
        return;
      }
      if (event.touches.length !== 1) return;
      moved = false;
      const grip = dragControl(event.target);
      if (!grip) return;
      const touch = event.changedTouches[0];
      touchDrag = {
        id:touch.identifier, x:touch.clientX, y:touch.clientY,
        rect:panel.getBoundingClientRect(), resize:grip.resize,
      };
    }
    function touchCenter(event) {
      return (event.touches[0].clientY + event.touches[1].clientY) / 2;
    }
    function moveTouch(event) {
      if (touchScroll && event.touches.length === 2) {
        event.preventDefault();
        page.scrollTop = touchScroll.top + touchScroll.y - touchCenter(event);
        return;
      }
      if (!touchDrag || event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (touch.identifier !== touchDrag.id) return;
      event.preventDefault();
      const dx = touch.clientX - touchDrag.x, dy = touch.clientY - touchDrag.y;
      if (!moved && Math.hypot(dx, dy) < 5) return;
      moved = true;
      panel.classList.add('is-dragging');
      adjust(touchDrag.rect, dx, dy, touchDrag.resize);
    }
    function endTouch(event) {
      if (touchDrag && Array.from(event.changedTouches).some(touch => touch.identifier === touchDrag.id)) {
        if (moved && event.cancelable) event.preventDefault();
        touchDrag = null;
        panel.classList.remove('is-dragging');
      }
      if (event.touches.length < 2) touchScroll = null;
    }
    panel.addEventListener('touchstart', startTouch, {passive:true});
    panel.addEventListener('touchmove', moveTouch, {passive:false});
    panel.addEventListener('touchend', endTouch, {passive:false});
    panel.addEventListener('touchcancel', endTouch);
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
  window.LabReportContent={render,sections,imagePattern,mount,floating,headers,writeClipboard,readClipboard};
  window.addEventListener('eagle-context-updated',()=>{
    if(clipboardSession!==identity()){copiedText=null;clipboardSession='';}
  });
  window.addEventListener('eagle-context-updated',()=>{if(cacheSession!==identity()){imageCache.clear();cacheSession=identity();}});
})();
