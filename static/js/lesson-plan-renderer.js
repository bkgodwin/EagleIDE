(function () {
  'use strict';

  const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];

  function safeMarkdown(markdown) {
    const source = String(markdown || '').trim().replace(/!\[([^\]\n]*)\]\(agenda-image:([a-f0-9]{32})\)/g,
      (_match, alt, id) => `<img data-agenda-image="${id}" alt="${escapeText(alt)}" loading="lazy" decoding="async">`);
    if (!source) return '';
    const rendered = window.marked?.parse ? window.marked.parse(source) : source.replace(/\n/g, '<br>');
    return window.DOMPurify?.sanitize ? window.DOMPurify.sanitize(rendered) : '';
  }

  const escapeText = value => String(value || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const imageUrls = new Map();
  const imageCache = new Map();
  let imageCacheBytes=0, activeImages=0;
  const imageWaiters=[];
  async function imageBlob(url, headers) {
    const key=`${JSON.stringify(headers)}:${url}`;
    const cached=imageCache.get(key);
    if(cached && Date.now()-cached.time<60000) return cached.promise;
    if(cached) {imageCache.delete(key); imageCacheBytes-=cached.size || 0;}
    const entry={time:Date.now(),size:0};
    entry.promise=(async()=>{
      if(activeImages>=3) await new Promise(resolve=>imageWaiters.push(resolve));
      else activeImages++;
      try {
        const response=await fetch(url,{headers,signal:AbortSignal.timeout(20000)});
        if(!response.ok) throw new Error('Image unavailable');
        const blob=await response.blob();
        if(blob.size>5*1024*1024) throw new Error('Image too large');
        if(imageCache.get(key)===entry) {
          entry.size=blob.size; imageCacheBytes+=blob.size;
          while(imageCache.size>32 || imageCacheBytes>16*1024*1024) {
            const oldest=imageCache.keys().next().value, previous=imageCache.get(oldest);
            imageCacheBytes-=previous.size; imageCache.delete(oldest);
          }
        }
        return blob;
      } catch(error) {if(imageCache.get(key)===entry) {imageCache.delete(key);imageCacheBytes-=entry.size;} throw error;}
      finally {const next=imageWaiters.shift(); if(next) next(); else activeImages--;}
    })();
    imageCache.set(key,entry);
    return entry.promise;
  }
  window.addEventListener('eagle-context-updated',()=>{imageCache.clear();imageCacheBytes=0;});
  if (window.MutationObserver) new MutationObserver(() => {
    for (const [img, url] of imageUrls) if (!img.isConnected) { URL.revokeObjectURL(url); imageUrls.delete(img); }
  }).observe(document.documentElement, {childList:true, subtree:true});

  async function loadImages(host, item, options = {}) {
    const ctx = window.EagleIDE?.getContext?.() || {};
    const headers = ctx.TEACHER_TOKEN ? {'X-Teacher-Token':ctx.TEACHER_TOKEN} : ctx.USER_TOKEN ? {'X-User-Token':ctx.USER_TOKEN} : {};
    const pending = [...host.querySelectorAll('img[data-agenda-image]')];
    await Promise.all(Array.from({length:Math.min(3,pending.length)}, async () => {
      while (pending.length) {
        const img = pending.shift();
        const image = (item.images || []).find(entry => entry.id === img.dataset.agendaImage);
        if (!image || !host.isConnected) continue;
        let url;
        try {
          url = new URL(image.url, location.origin);
          if (url.origin !== location.origin || !url.pathname.startsWith('/api/lesson-plans/')) continue;
          if (options.share) url.searchParams.set('share', options.share);
          if (options.printToken) url.searchParams.set('print', options.printToken);
          const blob = await imageBlob(url.href,headers);
          if (!img.isConnected) continue;
          const previous = imageUrls.get(img);
          if (previous) URL.revokeObjectURL(previous);
          const objectUrl = URL.createObjectURL(blob);
          imageUrls.set(img, objectUrl); img.src = objectUrl;
          await img.decode().catch(()=>{});
        } catch { if (img.isConnected) img.alt = `${img.alt || 'Agenda image'} (could not load)`; }
      }
    }));
  }

  function applyDayColor(element, color) {
    if (/^#[0-9a-f]{6}$/i.test(color || '')) element.style.setProperty('--agenda-color', color);
  }

  function renderDayContent(host, item = {}, data = {}, options = {}) {
    host.innerHTML = safeMarkdown(item.markdown) || '<p class="lesson-plan-day-empty">No activities listed.</p>';
    host.dataset.agendaClass = data.class?.id || '';
    host.dataset.agendaWeek = data.selected_week || data.plan?.week_start || '';
    applyDayColor(host, item.color);
    const resources = document.createElement('div'); resources.className = 'lesson-plan-resources';
    for (const page of item.wiki_pages || []) {
      const href = page.url || `/wiki/${encodeURIComponent(page.slug || '')}${page.anchor ? `#${encodeURIComponent(page.anchor)}` : ''}`;
      if (String(item.markdown || '').includes(`](${href})`)) continue;
      const link = document.createElement('a'); link.href = href;
      link.className = 'lesson-plan-resource-tile';
      link.textContent = page.section_title ? `${page.title} › ${page.section_title}` : page.title || 'Wiki page';
      if (options.publicPage) {link.target = '_blank'; link.rel = 'noopener';}
      resources.appendChild(link);
    }
    for (const resource of item.external_links || []) {
      if (!/^https?:\/\//i.test(resource.url || '')) continue;
      const link = document.createElement('a'); link.href = resource.url; link.textContent = resource.title || resource.url;
      link.target = '_blank'; link.rel = 'noopener noreferrer'; resources.appendChild(link);
    }
    {
      for (const file of item.attachments || []) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'lesson-plan-resource-tile lesson-plan-file';
        button.dataset.assetId = file.id; button.textContent = `↳ ${file.name}`; button.title = 'Copy this example to Home and open it in the IDE'; resources.appendChild(button);
        button.disabled=!!options.preview;
      }
      if(!options.publicPage) for (const assignment of item.assignments || []) {const tile=assignmentTile(assignment); tile.disabled=!!options.preview; resources.appendChild(tile);}
    }
    if (resources.children.length) host.appendChild(resources);
    if (!options.publicPage && item.due_assignments?.length) {
      const deadlines = document.createElement('div'); deadlines.className = 'lesson-plan-deadlines';
      for (const assignment of item.due_assignments) {
        const badge = assignmentTile(assignment); badge.classList.add('lesson-plan-due');
        badge.textContent = `Due: ${assignment.name} · ${new Date(assignment.dueAt).toLocaleTimeString([], {hour:'numeric',minute:'2-digit',timeZoneName:'short',...(data.time_zone?{timeZone:data.time_zone}:{})})}`;
        if (assignment.accommodationNote) {const note = document.createElement('small'); note.textContent = `Your deadline · ${assignment.accommodationNote}`; badge.appendChild(note);}
        deadlines.appendChild(badge);
      }
      host.appendChild(deadlines);
    }
    host.querySelectorAll('a[href^="/wiki/"]').forEach(link => link.classList.add('lesson-plan-inline-tile'));
    host.querySelectorAll('img').forEach(img => {img.loading='lazy'; img.decoding='async';img.tabIndex=0;img.setAttribute('role','button');img.setAttribute('aria-label',`Enlarge ${img.alt || 'agenda image'}`);});
    host.agendaImagesReady=new Promise(resolve=>queueMicrotask(()=>loadImages(host,item,options).then(resolve,resolve)));
  }

  function assignmentTile(assignment) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'lesson-plan-resource-tile lesson-plan-assignment';
    button.dataset.assignmentId = assignment.id; button.textContent = `▣ ${assignment.name}`;
    if (assignment.dueAt) button.title = `Your deadline: ${new Date(assignment.dueAt).toLocaleString()}${assignment.accommodationNote ? ` · ${assignment.accommodationNote}` : ''}`;
    if(assignment.dueAt || assignment.accommodationNote) {
      const note=document.createElement('small'); note.textContent=assignment.dueAt ? `Due ${new Date(assignment.dueAt).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'})}` : 'No submission deadline';
      if(assignment.accommodationNote) note.textContent+=` · ${assignment.accommodationNote}`;
      button.appendChild(note);
    }
    return button;
  }

  function dayLabel(day, isoDate) {
    const parsed = new Date(`${isoDate}T12:00:00`);
    const dateText = Number.isNaN(parsed.valueOf())
      ? ''
      : parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return { name: day.charAt(0).toUpperCase() + day.slice(1), date: dateText };
  }

  function addStandardTooltip(button, standard) {
    button.title = standard.description || standard.standard_id || '';
    button.addEventListener('pointerenter', () => {
      const tooltip = document.getElementById('wikiStandardDescriptionTooltip');
      if (!tooltip || !standard.description) return;
      tooltip.textContent = standard.description;
      tooltip.hidden = false;
      const rect = button.getBoundingClientRect();
      tooltip.style.left = `${Math.min(rect.left, window.innerWidth - 340)}px`;
      tooltip.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - tooltip.offsetHeight - 8)}px`;
    });
    button.addEventListener('pointerleave', () => {
      const tooltip = document.getElementById('wikiStandardDescriptionTooltip');
      if (tooltip) tooltip.hidden = true;
    });
  }

  function positionStandardsPopover(details) {
    const summary = details.querySelector('summary');
    const list = details.querySelector('.lesson-plan-standards-list');
    if (!summary || !list || !details.open || document.body.classList.contains('lesson-plan-printing') || window.matchMedia?.('print')?.matches) return;
    const rect = summary.getBoundingClientRect();
    const width = Math.min(380, Math.max(230, rect.width + 80));
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    list.style.width = `${width}px`;
    list.style.left = `${left}px`;
    list.style.right = 'auto';
    const roomBelow = window.innerHeight - rect.bottom;
    if (roomBelow >= 210 || roomBelow >= rect.top) {
      list.style.top = `${Math.min(rect.bottom + 5, window.innerHeight - 8)}px`;
      list.style.bottom = 'auto';
    } else {
      list.style.top = 'auto';
      list.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 5)}px`;
    }
  }

  function closeScreenStandards(except = null) {
    if (document.body.classList.contains('lesson-plan-printing') || window.matchMedia?.('print')?.matches) return;
    document.querySelectorAll('.lesson-plan-standards-popout[open]').forEach((details) => {
      if (details !== except) details.open = false;
    });
  }

  function standardsPopover(dayName, standards) {
    const details = document.createElement('details');
    details.className = 'lesson-plan-standards-popout';
    const summary = document.createElement('summary');
    summary.textContent = `${standards.length} standard${standards.length === 1 ? '' : 's'}`;
    summary.setAttribute('aria-label', `Show ${standards.length} standards for ${dayName}`);
    details.appendChild(summary);
    const list = document.createElement('div');
    list.className = 'lesson-plan-standards-list';
    standards.forEach((standard, index) => {
      const item = document.createElement('div');
      item.className = 'lesson-plan-standard-row';
      if (index >= 12) item.classList.add('lesson-plan-standard-overflow');
      const tag = document.createElement('button');
      tag.type = 'button';
      tag.className = 'wiki-standard-id';
      tag.textContent = standard.standard_id || 'Standard';
      addStandardTooltip(tag, standard);
      const description = document.createElement('span');
      description.textContent = standard.description || '';
      item.append(tag, description);
      list.appendChild(item);
    });
    if (standards.length > 12) {
      const more = document.createElement('div');
      more.className = 'lesson-plan-standard-more';
      more.textContent = `+ ${standards.length - 12} more`;
      list.appendChild(more);
    }
    details.appendChild(list);
    details.addEventListener('toggle', () => {
      if (!details.open) return;
      closeScreenStandards(details);
      positionStandardsPopover(details);
    });
    return details;
  }

  function render(host, data, options = {}) {
    if (!host) return;
    host.textContent = '';
    host.classList.add('lesson-plan-render-host');
    const plan = data?.plan;
    if (!plan) {
      const empty = document.createElement('div');
      empty.className = 'lesson-plan-empty';
      empty.innerHTML = '<strong>No plan published for this week.</strong><span>Use the previous-week button to view an earlier plan.</span>';
      host.appendChild(empty);
      return;
    }

    const frame = document.createElement('article');
    frame.className = `lesson-plan-frame${options.embed ? ' lesson-plan-frame--embed' : ''}`;
    const header = document.createElement('header');
    header.className = 'lesson-plan-frame-header';
    const heading = document.createElement('div');
    const title = document.createElement('h1');
    title.textContent = data.class?.name || 'Class Lesson Plan';
    const week = document.createElement('p');
    const monday = new Date(`${plan.week_start}T12:00:00`);
    const friday = new Date(monday);
    friday.setDate(friday.getDate() + 4);
    week.textContent = `Week of ${monday.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })} - ${friday.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}`;
    heading.append(title, week);
    header.appendChild(heading);
    frame.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'lesson-plan-week-grid';
    DAYS.forEach((day) => {
      const item = plan.days?.[day] || {};
      const label = dayLabel(day, item.date);
      const column = document.createElement('section');
      column.className = 'lesson-plan-day';
      applyDayColor(column, item.color);
      const dayHeader = document.createElement('header');
      dayHeader.innerHTML = `<strong>${label.name}</strong><time datetime="${item.date || ''}">${label.date}</time>`;
      const scroll = document.createElement('div');
      scroll.className = 'lesson-plan-day-scroll';
      const content = document.createElement('div');
      content.className = 'lesson-plan-markdown wiki-markdown';
      renderDayContent(content, item, data, options);
      scroll.appendChild(content);
      column.append(dayHeader, scroll);
      if (item.standards?.length) column.appendChild(standardsPopover(label.name, item.standards));
      grid.appendChild(column);
    });
    frame.appendChild(grid);

    if(!options.publicPage && plan.weekend_due_assignments?.length) {
      const deadlines=document.createElement('footer'); deadlines.className='lesson-plan-notes';
      deadlines.dataset.agendaClass=data.class?.id || ''; deadlines.dataset.agendaWeek=data.selected_week || plan.week_start;
      const label=document.createElement('strong'); label.textContent='Weekend deadlines'; deadlines.appendChild(label);
      const list=document.createElement('div'); list.className='lesson-plan-deadlines';
      for(const assignment of plan.weekend_due_assignments) list.appendChild(assignmentTile(assignment));
      deadlines.appendChild(list); frame.appendChild(deadlines);
    }

    if (String(plan.notes_markdown || '').trim()) {
      const notes = document.createElement('footer');
      notes.className = 'lesson-plan-notes';
      const label = document.createElement('strong');
      label.textContent = 'Additional notes';
      const content = document.createElement('div');
      content.className = 'lesson-plan-markdown wiki-markdown';
      content.innerHTML = safeMarkdown(plan.notes_markdown);
      notes.append(label, content);
      frame.appendChild(notes);
    }
    host.appendChild(frame);
    host.agendaImagesReady=Promise.all([...frame.querySelectorAll('.lesson-plan-markdown')].map(content=>content.agendaImagesReady));
  }

  let tooltipTimer, lightbox;
  function tooltip(button, message) {
    document.getElementById('agendaActionTooltip')?.remove();clearTimeout(tooltipTimer);
    const tip=document.createElement('span');tip.id='agendaActionTooltip';tip.className='agenda-action-tooltip';tip.role='tooltip';tip.textContent=message;
    document.body.appendChild(tip);button.setAttribute('aria-describedby',tip.id);
    const box=button.getBoundingClientRect();tip.style.left=`${Math.max(8,Math.min(box.left,innerWidth-tip.offsetWidth-8))}px`;tip.style.top=`${Math.max(8,Math.min(box.bottom+6,innerHeight-tip.offsetHeight-8))}px`;
    tooltipTimer=setTimeout(()=>{tip.remove();button.removeAttribute('aria-describedby');},4000);
  }
  function enlargeImage(source) {
    if(!source.currentSrc || !source.naturalWidth) return;
    lightbox?.close();
    const dialog=document.createElement('dialog');dialog.className='agenda-image-popout';dialog.setAttribute('aria-label','Agenda image');
    const close=document.createElement('button');close.type='button';close.className='btn secondary';close.textContent='Close image';
    const image=document.createElement('img');image.src=source.currentSrc;image.alt=source.alt || 'Agenda image';
    dialog.append(close,image);document.body.appendChild(dialog);lightbox=dialog;
    close.onclick=()=>dialog.close();dialog.onclick=event=>{if(event.target===dialog) dialog.close();};
    dialog.addEventListener('close',()=>{dialog.remove();if(lightbox===dialog) lightbox=null;if(source.isConnected) source.focus();},{once:true});
    dialog.showModal();close.focus();
  }
  function publicSession() {
    try {
      const saved=JSON.parse(sessionStorage.getItem('eagle-auth-session-v1') || '{}');
      if(saved.userToken) return {headers:{'X-User-Token':saved.userToken},email:saved.currentUser?.email,role:'student'};
      if(saved.teacherToken) return {headers:{'X-Teacher-Token':saved.teacherToken},email:saved.currentTeacher?.email,role:'teacher'};
      if(saved.adminToken) return {headers:{'X-Admin-Token':saved.adminToken},email:'admin',role:'admin'};
    } catch {}
    return null;
  }
  async function openPublicFile(button) {
    const session=publicSession();
    if(!session) {tooltip(button,'Sign in to open this file in the IDE.');return;}
    const host=button.closest('[data-agenda-class]'), share=decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
    button.disabled=true;
    try {
      const response=await fetch(`/api/classes/${encodeURIComponent(host.dataset.agendaClass)}/lesson-plans/${encodeURIComponent(host.dataset.agendaWeek)}/files/${encodeURIComponent(button.dataset.assetId)}/open?share=${encodeURIComponent(share)}`,{method:'POST',headers:session.headers,signal:AbortSignal.timeout(30000)});
      const data=await response.json().catch(()=>({}));
      if(!response.ok || !data.ok) {tooltip(button,response.status===401 || response.status===404 ? 'Sign in to open this file in the IDE.' : data.error || 'Could not open this file.');return;}
      if(JSON.stringify(publicSession()?.headers)!==JSON.stringify(session.headers)) return;
      sessionStorage.setItem('eagle-agenda-open-file',JSON.stringify({path:data.path,email:session.email,role:session.role,at:Date.now()}));
      location.assign('/ide');
    } catch {tooltip(button,'Could not reach the server. Try again.');}
    finally {button.disabled=false;}
  }
  document.addEventListener('click',event=>{
    const img=event.target.closest?.('.lesson-plan-markdown img,#wikiReferenceAgendaBody img');
    if(img) {event.preventDefault();enlargeImage(img);return;}
    const button=event.target.closest?.('.lesson-plan-file');
    if(button && document.body.classList.contains('lesson-plan-public-page')) {event.preventDefault();openPublicFile(button);}
  });
  document.addEventListener('keydown',event=>{if(['Enter',' '].includes(event.key) && event.target.matches?.('.lesson-plan-markdown img,#wikiReferenceAgendaBody img')) {event.preventDefault();enlargeImage(event.target);}});
  window.addEventListener('eagle-context-updated',()=>lightbox?.close());
  window.LessonPlanRenderer = { DAYS, createStandardsPopover: standardsPopover, render, safeMarkdown, renderDayContent, loadImages, applyDayColor };
  window.addEventListener('resize', () => closeScreenStandards());
  window.addEventListener('scroll', (event) => {
    if (event.target?.closest?.('.lesson-plan-standards-list')) return;
    closeScreenStandards();
  }, true);
})();
