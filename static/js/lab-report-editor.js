/* Teacher report sections use the same renderer as the student report. */
(function () {
  'use strict';
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const content=()=>window.LabReportContent;
  function preview(name,task,questions){return `<span class="lab-report-eyebrow">STUDENT PREVIEW</span><h2>${esc(name||'Untitled report')}</h2>${content().render(task)}${questions.map((q,i)=>`<section class="lab-report-question"><div class="lab-report-question-meta"><span>SECTION ${i+1}</span><span>${Number(q.points)||0} points</span></div>${content().render(q.question)}${q.type==='procedure'?`<p class="lab-report-check-hint">Select every checkbox in this checklist to receive credit for this section.</p>${(q.steps||[]).map(step=>`<div class="lab-report-check-row"><input type="checkbox" disabled aria-label="Preview checklist">${content().render(step)}</div>`).join('')}`:q.type==='fill_blank'?'<input type="text" placeholder="Student answer" disabled>':'<textarea placeholder="Student observations" disabled></textarea>'}</section>`).join('')}`;}
  const imagePattern=/!\[([^\]\n]{0,200})\]\(lab-image:([a-f0-9]{32})\)/g;
  function summary(text){return String(text||'').replace(imagePattern,'[Image]');}
  function imageTools(container,textarea,getClassId,onChange,onImage=null){
    const tools=document.createElement('div');tools.className='lab-editor-image-tools';tools.innerHTML='<button class="btn secondary" type="button">Add image</button><input type="file" accept="image/jpeg,image/png" hidden><span role="status">JPEG / PNG · up to 5 MB</span>';
    (textarea.closest('label')||textarea).after(tools);
    tools.querySelector('button').onclick=()=>tools.querySelector('input').click();
    tools.querySelector('input').onchange=async event=>{
      const input=event.target,file=input.files[0];if(!file)return;
      const status=tools.querySelector('[role=status]');if(file.size>5*1024*1024){status.textContent='Choose an image smaller than 5 MB.';return;}
      const identity=JSON.stringify(content().headers()),classId=getClassId();
      status.textContent='Uploading image…';input.disabled=true;
      try{const data=new FormData();data.append('image',file);const response=await fetch(`/api/lab-reports/images?class_id=${encodeURIComponent(classId||'')}`,{method:'POST',headers:content().headers(),body:data,signal:AbortSignal.timeout(30000)}),result=await response.json();if(!response.ok||!result.ok)throw Error(result.error||'Image upload failed');if(!container.isConnected||identity!==JSON.stringify(content().headers())||getClassId()!==classId)return;
        const alt=file.name.replace(/\.[^.]+$/,'').replace(/[\]\n]/g,' ').slice(0,200),token=`\n![${alt}](lab-image:${result.data.id})\n`;
        if(onImage){onImage({id:result.data.id,alt});status.textContent='Image attached. Add a description below.';return;}
        textarea.setRangeText(token,textarea.selectionStart,textarea.selectionEnd,'end');textarea.dispatchEvent(new Event('input',{bubbles:true}));status.textContent='Image added. You can edit its description between [brackets].';onChange?.();
      }catch(error){status.textContent=error.message;}finally{input.disabled=false;input.value='';}
    };
  }
  function attachComposer(modal,getQuestions){
    if(modal.labPreviewRefresh)return;
    const box=document.createElement('aside');box.className='lab-composer-preview';box.setAttribute('aria-label','Live lab report preview');modal.querySelector('.modal-content').append(box);
    const classId=()=>modal.querySelector('#modalAssignmentClassId')?.value||'';
    const task=modal.querySelector('#modalAssignmentTask');
    imageTools(modal,task,classId);
    let cleanup=null,timer=null;
    const refresh=()=>{
      const enabled=modal.querySelector('#modalAssignmentType').value==='lab_report';
      modal.classList.toggle('is-lab-composer',enabled);box.hidden=!enabled;
      const tab=modal.querySelector('#composer-tab-questions');
      if(tab){const label=[...tab.childNodes].find(node=>node.nodeType===3);if(label)label.textContent=enabled?'Report sections':'Skills & questions';}
      const heading=modal.querySelector('#composer-pane-questions h4');if(heading)heading.textContent=enabled?'Build your report sections':'Connect skills and add a quiz';
      const attempts=modal.querySelector('#modalAssignmentMaxQuizSubmissions')?.previousElementSibling;if(attempts)attempts.textContent=enabled?'Maximum report submissions (0 = unlimited)':'Quiz Max Submissions (0 = unlimited)';
      const save=modal.querySelector('.modal-save-btn');if(save&&!/Save/.test(save.textContent))save.textContent=enabled?'Create report':'Create Assignment';
      if(!enabled){cleanup?.();return;}
      cleanup?.();box.innerHTML=preview(modal.querySelector('#modalAssignmentName').value,task.value,getQuestions());cleanup=content().mount(box,{classId:classId()});
    };
    modal.labPreviewRefresh=refresh;
    modal.addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(refresh,180);});modal.addEventListener('change',refresh);
    const original=JSON.stringify(content().headers()),changed=()=>{if(original!==JSON.stringify(content().headers()))modal.remove();};window.addEventListener('eagle-context-updated',changed);
    const observer=new MutationObserver(()=>{if(!modal.isConnected){clearTimeout(timer);cleanup?.();window.removeEventListener('eagle-context-updated',changed);observer.disconnect();}});observer.observe(document.body,{childList:true});refresh();
  }
  function open({questions,onChange,counter,index=-1,classId=''}){
    const existing=questions[index]||{type:'written',question:'',points:10,steps:[],acceptedAnswers:[]};
    const images=[...String(existing.question||'').matchAll(imagePattern)].map(match=>({id:match[2],alt:match[1]}));
    const text=String(existing.question||'').replace(imagePattern,'').trim();
    const modal=document.createElement('div');modal.className='modal glass-modal lab-section-editor';modal.style.display='flex';
    modal.innerHTML=`<section class="modal-content" role="dialog" aria-modal="true" aria-label="${index<0?'Add':'Edit'} report section"><header class="workspace-modal-header"><div><span class="lab-report-eyebrow">REPORT BUILDER</span><h3>${index<0?'Add':'Edit'} section</h3></div><button type="button" class="btn secondary" data-cancel>Cancel</button></header><div class="lab-section-editor-grid"><form><label>Response type<select name="type"><option value="written">Written response</option><option value="fill_blank">Fill in the blank</option><option value="procedure">Procedure checklist</option></select></label><label>Instructions<textarea name="question" rows="5" maxlength="20000" required placeholder="Explain this step and what students should record…">${esc(text)}</textarea></label><p class="lab-editor-help">Wrap text in {curly brackets} to make it click-to-copy, for example {ip -br addr}. Add screenshots below. The preview matches the student's report.</p><label>Points<input name="points" type="number" min="1" max="10000" value="${Number(existing.points)||10}" required></label><label data-answers>Accepted answers · one per line<textarea name="answers" rows="3">${esc((existing.acceptedAnswers||[]).join('\n'))}</textarea><small>Matched without case or surrounding whitespace. These answers are hidden from students.</small></label><label data-steps>Checklist steps · one per line<textarea name="steps" rows="6" placeholder="Create your container\nStart the container\nRecord its IP address">${esc((existing.steps||[]).join('\n'))}</textarea><small>Every checkbox must be selected for credit. Maximum 50 steps, 500 characters per step.</small></label><p role="status" data-status></p><button class="btn run" type="submit">${index<0?'Add section':'Save section'}</button></form><aside class="lab-section-preview" aria-label="Live section preview"></aside></div></section>`;
    document.body.append(modal);const form=modal.querySelector('form'),type=form.elements.type;type.value=existing.type;
    let cleanup=null,timer=null;const getQuestion=()=>({...existing,type:type.value,question:form.elements.question.value+images.map(image=>`\n![${image.alt.replace(/[\]\n]/g,' ')}](lab-image:${image.id})`).join(''),points:Number(form.elements.points.value),steps:form.elements.steps.value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean),acceptedAnswers:form.elements.answers.value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean)});
    function render(){form.querySelector('[data-answers]').hidden=type.value!=='fill_blank';form.querySelector('[data-steps]').hidden=type.value!=='procedure';cleanup?.();const target=modal.querySelector('.lab-section-preview');target.innerHTML=preview('Section preview','',[getQuestion()]);cleanup=content().mount(target,{classId});}
    const original=JSON.stringify(content().headers()),changed=()=>{if(original!==JSON.stringify(content().headers()))close();};window.addEventListener('eagle-context-updated',changed);
    function close(){clearTimeout(timer);cleanup?.();modal.remove();document.removeEventListener('keydown',key);window.removeEventListener('eagle-context-updated',changed);}
    function key(event){if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();close();}if(event.key==='Tab'){const items=[...modal.querySelectorAll('button,input,textarea,select')].filter(e=>!e.disabled&&e.getClientRects().length),first=items[0],last=items.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}}
    document.addEventListener('keydown',key);modal.querySelector('[data-cancel]').onclick=close;
    const gallery=document.createElement('div');gallery.className='lab-editor-attachments';form.elements.question.closest('label').after(gallery);
    function renderAttachments(){gallery.innerHTML=images.map((image,i)=>`<div><label>Image description<input data-image-alt="${i}" maxlength="200" value="${esc(image.alt)}"></label><button type="button" class="btn secondary" data-image-remove="${i}">Remove image</button></div>`).join('');gallery.querySelectorAll('[data-image-alt]').forEach(input=>input.oninput=()=>{images[Number(input.dataset.imageAlt)].alt=input.value;});gallery.querySelectorAll('[data-image-remove]').forEach(button=>button.onclick=()=>{images.splice(Number(button.dataset.imageRemove),1);renderAttachments();render();});}
    imageTools(modal,form.elements.question,()=>classId,render,image=>{if(images.length>=12){form.querySelector('[data-status]').textContent='Use at most 12 images per section.';return;}images.push(image);renderAttachments();render();});renderAttachments();
    form.addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(render,180);});type.onchange=render;
    form.onsubmit=event=>{event.preventDefault();const q=getQuestion(),status=form.querySelector('[data-status]');if(!q.question.trim()){status.textContent='Add instructions for this section.';return;}if(q.type==='procedure'&&(!q.steps.length||q.steps.length>50||q.steps.some(s=>s.length>500))){status.textContent='Add 1–50 steps of at most 500 characters.';return;}if(q.type==='fill_blank'&&(!q.acceptedAnswers.length||q.acceptedAnswers.length>20||q.acceptedAnswers.some(s=>s.length>500))){status.textContent='Add 1–20 accepted answers of at most 500 characters.';return;}if(index<0){q.id='q'+Date.now()+'_'+counter.value++;questions.push(q);}else questions[index]=q;close();onChange();};render();form.elements.question.focus();
  }
  window.LabReportEditor={open,attachComposer,preview,summary};
})();
