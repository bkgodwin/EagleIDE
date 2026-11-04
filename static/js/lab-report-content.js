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
    const panel=root.querySelector('.lab-report-window'), handle=root.querySelector('[data-float-move]'), resize=root.querySelector('[data-float-resize]');
    if(!panel?.getBoundingClientRect)return ()=>{};
    let minimized=false,drag=null;
    function bounds(){const v=window.visualViewport;return{x:v?.offsetLeft||0,y:v?.offsetTop||0,w:v?.width||innerWidth,h:v?.height||innerHeight};}
    function place(left,top,width,height){const b=bounds();width=Math.min(Math.max(280,width),b.w-16);height=Math.min(Math.max(minimized?64:200,height),b.h-16);panel.style.width=width+'px';panel.style.height=height+'px';panel.style.left=Math.max(b.x+8,Math.min(left,b.x+b.w-width-8))+'px';panel.style.top=Math.max(b.y+8,Math.min(top,b.y+b.h-height-8))+'px';}
    function clamp(){const r=panel.getBoundingClientRect();place(r.left,r.top,r.width,r.height);}
    function start(event,mode){if(event.button!==0)return;event.preventDefault();const r=panel.getBoundingClientRect();drag={x:event.clientX,y:event.clientY,r,mode};event.currentTarget.setPointerCapture(event.pointerId);panel.classList.add('is-dragging');}
    function move(event){if(!drag)return;const {x,y,r,mode}=drag,dx=event.clientX-x,dy=event.clientY-y;place(r.left+(mode==='move'?dx:0),r.top+(mode==='move'?dy:0),r.width+(mode==='resize'?dx:0),r.height+(mode==='resize'?dy:0));}
    function end(){drag=null;panel.classList.remove('is-dragging');}
    for(const [control,mode] of [[handle,'move'],[resize,'resize']]){
      control?.addEventListener('pointerdown',event=>start(event,mode));control?.addEventListener('pointermove',move);control?.addEventListener('pointerup',end);control?.addEventListener('pointercancel',end);
      control?.addEventListener('keydown',event=>{const delta={ArrowLeft:[-16,0],ArrowRight:[16,0],ArrowUp:[0,-16],ArrowDown:[0,16]}[event.key];if(!delta)return;event.preventDefault();const r=panel.getBoundingClientRect();place(r.left+(mode==='move'?delta[0]:0),r.top+(mode==='move'?delta[1]:0),r.width+(mode==='resize'?delta[0]:0),r.height+(mode==='resize'?delta[1]:0));});
    }
    const minimize=root.querySelector('[data-float-minimize]');let expandedHeight=0;
    if(minimize)minimize.onclick=()=>{const r=panel.getBoundingClientRect();if(!minimized)expandedHeight=r.height;minimized=!minimized;panel.classList.toggle('is-minimized',minimized);minimize.textContent=minimized?'Expand':'Minimize';minimize.setAttribute('aria-expanded',String(!minimized));place(r.left,r.top,r.width,minimized?Math.max(72,panel.querySelector('header').getBoundingClientRect().height+2):expandedHeight);};
    clamp();window.addEventListener('resize',clamp);window.visualViewport?.addEventListener('resize',clamp);window.visualViewport?.addEventListener('scroll',clamp);
    return ()=>{window.removeEventListener('resize',clamp);window.visualViewport?.removeEventListener('resize',clamp);window.visualViewport?.removeEventListener('scroll',clamp);};
  }
  window.LabReportContent={render,mount,floating,headers};
  window.addEventListener('eagle-context-updated',()=>{if(cacheSession!==identity()){imageCache.clear();cacheSession=identity();}});
})();
