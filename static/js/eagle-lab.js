/* Native Eagle Lab section and continuous, autosaving lab reports. */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const state = { initialized:false, bootstrap:null, classId:'', search:'', assignments:[], adminServers:[], teacherData:null, report:null, workspace:null };

  function context() { return window.EagleIDE?.getContext?.() || {}; }
  function sessionKey() { const ctx=context(); return ctx.ADMIN_TOKEN || ctx.TEACHER_TOKEN || ctx.USER_TOKEN || ''; }
  function headers(json = false) {
    const ctx = context(), result = {};
    if (ctx.ADMIN_TOKEN) result['X-Admin-Token'] = ctx.ADMIN_TOKEN;
    else if (ctx.TEACHER_TOKEN) result['X-Teacher-Token'] = ctx.TEACHER_TOKEN;
    else if (ctx.USER_TOKEN) result['X-User-Token'] = ctx.USER_TOKEN;
    if (json) result['Content-Type'] = 'application/json';
    return result;
  }
  async function api(url, options = {}) {
    const requestSession=sessionKey();
    const response = await fetch(url, { cache:'no-store', ...options, headers:{...headers(!!options.body), ...(options.headers || {})} });
    const data = await response.json().catch(() => ({}));
    if(requestSession!==sessionKey())throw new Error('Your session changed. Reopen Eagle Lab.');
    if (!response.ok || !data.ok) { const error = new Error(data.error || `Request failed (${response.status})`); error.status=response.status; error.data=data.data; throw error; }
    return data.data !== undefined ? data.data : data;
  }
  function classes() {
    const ctx=context();
    if (ctx.TEACHER_TOKEN) return ctx.teacherClasses || [];
    if (ctx.USER_TOKEN) return ctx.studentClasses || [];
    return [];
  }
  function preferredClassId() {
    const ctx=context(), available=classes();
    const wanted=ctx.TEACHER_TOKEN ? ctx.currentTeacherClassId : ctx.currentStudentClassId;
    return available.some(item=>item.id===wanted) ? wanted : (available[0]?.id || '');
  }
  function populateClassSelect(select, selected = '') {
    if (!select) return '';
    const available=classes();
    const value=available.some(item=>item.id===selected) ? selected : (preferredClassId() || available[0]?.id || '');
    select.innerHTML=available.map(item=>`<option value="${esc(item.id)}" ${item.id===value?'selected':''}>${esc(item.name || 'Class')}</option>`).join('');
    select.hidden=!available.length;
    return value;
  }

  function showMode({push=true}={}) {
    document.body.classList.remove('wiki-mode','network-mode','external-tool-mode');
    document.body.classList.add('eagle-lab-mode');
    $('eagleLabViewBtn')?.setAttribute('aria-current','page');
    $('wikiViewBtn')?.setAttribute('aria-current','false');
    $('networkViewBtn')?.setAttribute('aria-current','false');
    $('ideViewBtn')?.setAttribute('aria-current','false');
    if(push && location.pathname!=='/lab') history.pushState({eagleView:'eagle-lab'},'', '/lab');
  }
  async function show({push=true}={}) {
    if(window.ExternalTools?.active?.() && !window.ExternalTools.leave()) return;
    showMode({push});
    state.classId=populateClassSelect($('eagleLabClassSelect'),state.classId||preferredClassId());
    await loadLab();
  }
  async function loadLab() {
    const status=$('eagleLabStatus');
    if(status) status.textContent='Checking servers…';
    try {
      const query=state.classId ? `?class_id=${encodeURIComponent(state.classId)}` : '';
      state.bootstrap=await api(`/api/eagle-lab/bootstrap${query}`);
      $('eagleLabPreview').hidden=!state.bootstrap.admin_preview;
      renderServers();
      await loadReports();
    } catch(error) {
      state.bootstrap=null;
      if(status) status.textContent=error.message;
      if($('eagleLabServerGrid')) $('eagleLabServerGrid').innerHTML=`<div class="eagle-lab-empty">${esc(error.message)}</div>`;
      if($('eagleLabReportList')) $('eagleLabReportList').innerHTML='<div class="eagle-lab-empty">No lab reports available.</div>';
    }
  }
  function renderServers() {
    const servers=state.bootstrap?.servers || [], query=state.search.trim().toLowerCase();
    const filtered=servers.filter(item=>`${item.hostname} ${item.ip}`.toLowerCase().includes(query));
    const up=servers.filter(item=>item.status==='up').length;
    $('eagleLabStatus').textContent=`${servers.length} server${servers.length===1?'':'s'} · ${up} up`;
    $('eagleLabServerGrid').innerHTML=filtered.map(server=>`
      <button class="eagle-lab-server-card is-${esc(server.status || 'down')}" type="button" data-lab-server="${esc(server.id)}">
        <div class="eagle-lab-server-top"><div><h3>${esc(server.hostname)}</h3><span class="eagle-lab-address">${esc(server.ip)}:${Number(server.port)||8006}</span></div><span class="eagle-lab-state ${esc(server.status)}">● ${esc(server.status || 'unknown')}</span></div>
        <p class="eagle-lab-server-reason">${esc(server.status_reason || 'Status unavailable.')}</p>
        <div class="eagle-lab-card-action"><span>Open server</span><span>→</span></div>
      </button>`).join('') || '<div class="eagle-lab-empty">No matching servers are available for this class.</div>';
  }
  async function loadReports() {
    const ctx=context();
    if(!ctx.USER_TOKEN || ctx.TEACHER_TOKEN || ctx.ADMIN_TOKEN) {state.assignments=[];renderReports();return;}
    try {
      const result=await api('/api/assignments');
      const list=Array.isArray(result.assignments) ? result.assignments : [];
      state.assignments=list.filter(item=>item.assignmentType==='lab_report' && (!state.classId || item.targetClassId===state.classId));
    } catch { state.assignments=[]; }
    renderReports();
  }
  function renderReports() {
    const workspaceSelect=state.workspace?.root.querySelector('[data-workspace-report]');
    if(workspaceSelect){const previous=workspaceSelect.value;workspaceSelect.innerHTML='<option value="">Choose lab report</option>'+state.assignments.map(item=>`<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');workspaceSelect.value=previous;}
    $('eagleLabReportList').innerHTML=state.assignments.map(item=>`
      <button class="eagle-lab-report-card" type="button" data-lab-report="${esc(item.id)}"><strong>${esc(item.name)}</strong><span>${item.studentSubmissionSummary?.submittedAt?'Submitted':'Autosaves while you work'}</span></button>`).join('') || '<div class="eagle-lab-empty">No active lab reports for this class.</div>';
  }
  async function openServer(serverId) {
    const server=(state.bootstrap?.servers||[]).find(item=>item.id===serverId); if(!server) return;
    let credentials=null;
    if(state.bootstrap?.show_credentials && !server.pin_required) {
      try {credentials=await api(`/api/eagle-lab/servers/${encodeURIComponent(serverId)}/credentials?class_id=${encodeURIComponent(state.classId||'')}`);} catch(error) {credentials={error:error.message};}
    }
    const modal=document.createElement('div'); modal.className='modal glass-modal'; modal.style.display='flex';
    modal.innerHTML=`<div class="modal-content eagle-lab-detail" role="dialog" aria-modal="true" aria-label="${esc(server.hostname)}">
      <div class="workspace-modal-header"><h3>${esc(server.hostname)}</h3><button class="btn secondary" data-close type="button">Close</button></div>
      <div class="eagle-lab-detail-grid"><div class="eagle-lab-detail-item"><span>Address</span><code>${esc(server.ip)}:${Number(server.port)||8006}</code></div><div class="eagle-lab-detail-item"><span>Status</span><strong>${esc(server.status||'unknown')}</strong></div>
      ${credentials && !credentials.error ? `<div class="eagle-lab-detail-item"><span>Username</span><div class="eagle-lab-secret-row"><code>${esc(credentials.username)}</code><button class="btn secondary" data-copy="${esc(credentials.username)}" type="button">Copy</button></div></div><div class="eagle-lab-detail-item"><span>Password</span><div class="eagle-lab-secret-row"><code data-secret>••••••••</code><button class="btn secondary" data-reveal="${esc(credentials.password)}" type="button">Reveal</button><button class="btn secondary" data-copy="${esc(credentials.password)}" type="button">Copy</button></div></div>` : ''}</div>
      ${credentials?.error?`<p class="meta">${esc(credentials.error)}</p>`:''}<p>${esc(server.notes||'')}</p>
      ${server.pin_required?'<label>Server PIN<input data-lab-pin type="password" inputmode="numeric" maxlength="12" autocomplete="off" placeholder="Enter the PIN assigned by your administrator"></label>':''}
      <p data-connect-status role="status"></p>
      <div class="modal-actions"><button class="btn run" data-connect type="button">Connect to PVE</button><button class="btn secondary" data-close type="button">Close</button></div></div>`;
    document.body.append(modal);
    modal.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>modal.remove());
    modal.onclick=event=>{if(event.target===modal)modal.remove();};
    modal.querySelector('[data-reveal]')?.addEventListener('click',event=>{const code=modal.querySelector('[data-secret]');code.textContent=event.currentTarget.dataset.reveal;event.currentTarget.remove();});
    modal.querySelectorAll('[data-copy]').forEach(button=>button.onclick=async()=>{try{await navigator.clipboard.writeText(button.dataset.copy);button.textContent='Copied';}catch{button.textContent='Select manually';}});
    modal.querySelector('[data-connect]').onclick=async event=>{
      const button=event.currentTarget,status=modal.querySelector('[data-connect-status]');button.disabled=true;status.textContent='Connecting…';
      try{
        await closeWorkspace();
        const launch=await api(`/api/eagle-lab/servers/${encodeURIComponent(serverId)}/launch`,{method:'POST',body:JSON.stringify({class_id:state.classId,pin:modal.querySelector('[data-lab-pin]')?.value||''})});
        if(!modal.isConnected)return;
        await openWorkspace(server,launch);modal.remove();
      }catch(error){status.textContent=error.message;button.disabled=false;}
    };
  }

  function closeWorkspace(revoke=true){
    const workspace=state.workspace;if(!workspace)return;
    workspace.root.remove();state.workspace=null;
    if(revoke&&workspace.session===sessionKey())return api(`/api/eagle-lab/servers/${encodeURIComponent(workspace.serverId)}/disconnect`,{method:'POST',body:'{}'}).catch(()=>{});
  }
  async function openWorkspace(server,launch){
    closeWorkspace(false);
    const originalSession=sessionKey();
    let credentials=null;
    if(state.bootstrap?.show_credentials){
      try{credentials=await api(`/api/eagle-lab/servers/${encodeURIComponent(server.id)}/credentials?class_id=${encodeURIComponent(state.classId||'')}`);}catch{}
    }
    if(originalSession!==sessionKey())return;
    const root=document.createElement('section'),frameName='eagle-pve-'+server.id+'-'+Date.now();
    root.className='eagle-lab-workspace';root.setAttribute('aria-label','PVE management workspace');
    const sandbox='allow-scripts allow-forms allow-downloads allow-modals allow-popups allow-pointer-lock'+(launch.transport==='path'?'':' allow-same-origin');
    root.innerHTML=`<header class="eagle-lab-workspace-toolbar"><button class="btn secondary" data-workspace-exit type="button">← Eagle Lab</button><strong>${esc(server.hostname)}</strong><span class="eagle-lab-clipboard-hint">Terminal: Ctrl+Shift+C / Ctrl+Shift+V · VM: noVNC clipboard or serial terminal</span>${credentials?'<button class="btn secondary" data-workspace-credentials type="button">Credentials</button>':''}<select data-workspace-report aria-label="Lab report"><option value="">Choose lab report</option>${state.assignments.map(item=>`<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('')}</select><button class="btn secondary" data-workspace-open-report type="button">Open report</button></header>
      <iframe name="${esc(frameName)}" title="${esc(server.hostname)} management interface" sandbox="${sandbox}" allow="clipboard-read *; clipboard-write *; fullscreen *" allowfullscreen referrerpolicy="no-referrer"></iframe>`;
    document.body.append(root);
    state.workspace={root,serverId:server.id,session:originalSession,transport:launch.transport,clipboardKey:launch.clipboard_key,clipboardTimes:[]};
    root.querySelector('[data-workspace-exit]').onclick=()=>closeWorkspace();
    root.querySelector('[data-workspace-credentials]')?.addEventListener('click',()=>{
      const panel=document.createElement('div');panel.className='modal glass-modal';panel.style.display='flex';
      panel.innerHTML=`<section class="modal-content eagle-lab-credentials"><h3>${esc(server.hostname)}</h3><p>Username: <code>${esc(credentials.username)}</code></p><p>Password: <code data-password>••••••••</code></p><button class="btn secondary" data-reveal-password type="button">Reveal password</button><button class="btn secondary" data-copy-password type="button">Copy password</button><button class="btn secondary" data-close-credentials type="button">Close</button></section>`;
      document.body.append(panel);
      panel.querySelector('[data-reveal-password]').onclick=()=>{panel.querySelector('[data-password]').textContent=credentials.password;};
      panel.querySelector('[data-copy-password]').onclick=async event=>{try{await navigator.clipboard.writeText(credentials.password);event.target.textContent='Copied';}catch{panel.querySelector('[data-password]').textContent=credentials.password;}};
      panel.querySelector('[data-close-credentials]').onclick=()=>panel.remove();
    });
    root.querySelector('[data-workspace-open-report]').onclick=()=>{
      const id=root.querySelector('[data-workspace-report]').value;
      if(id)openReportById(id,state.assignments.find(item=>item.id===id));
    };
    // A one-time POST exchanges the capability for a host-only HttpOnly cookie.
    // EagleIDE auth tokens never enter the frame, its URL, or its storage.
    const form=document.createElement('form');form.method='POST';form.action=launch.url;form.target=frameName;form.hidden=true;
    const ticket=document.createElement('input');ticket.type='hidden';ticket.name='ticket';ticket.value=launch.ticket;form.append(ticket);document.body.append(form);form.submit();form.remove();
  }

  async function loadAdmin() {
    if(!context().ADMIN_TOKEN) return;
    try {const data=await api('/api/eagle-lab/admin/servers');state.adminServers=data.servers||[];renderAdminServers();$('eagleLabAdminStatus').textContent=data.gateway_configured?(data.gateway_transport==='path'?'Automatic relay uses the current EagleIDE address.':`Embedded gateway configured: s-<server-id>.${data.proxy_domain}`):'Embedded PVE gateway is disabled.';}
    catch(error){$('eagleLabAdminStatus').textContent=error.message;}
  }
  function resetAdminForm() {
    if($('eagleLabServerPin'))$('eagleLabServerPin').placeholder='Optional 4–12 digits';
    $('eagleLabServerForm')?.reset(); $('eagleLabServerId').value=''; $('eagleLabServerPort').value='8006'; $('eagleLabServerUsername').value='root'; $('eagleLabServerSelfSigned').checked=true; $('eagleLabServerCancelBtn').hidden=true; $('eagleLabServerSaveBtn').textContent='Enroll server';
  }
  function renderAdminServers() {
    $('eagleLabAdminServers').innerHTML=state.adminServers.map(server=>`<article class="eagle-lab-admin-server"><div><strong>${esc(server.hostname)}</strong><small>${esc(server.ip)}:${Number(server.port)||8006} · ${esc(server.username)}</small></div><div class="eagle-lab-admin-server-actions"><button class="btn secondary" type="button" data-admin-edit="${esc(server.id)}">Edit</button><button class="btn stop" type="button" data-admin-delete="${esc(server.id)}">Remove</button></div></article>`).join('')||'<p>No PVE servers enrolled.</p>';
  }
  function editAdminServer(id) {
    const server=state.adminServers.find(item=>item.id===id);if(!server)return;
    $('eagleLabServerPin').value='';$('eagleLabServerPin').placeholder=server.pin_required?'PIN is set — leave blank to keep':'Optional 4–12 digits';$('eagleLabServerClearPin').checked=false;
    $('eagleLabServerId').value=server.id;$('eagleLabServerHostname').value=server.hostname;$('eagleLabServerIp').value=server.ip;$('eagleLabServerPort').value=server.port||8006;$('eagleLabServerUsername').value=server.username||'root';$('eagleLabServerPassword').value='';$('eagleLabServerNotes').value=server.notes||'';$('eagleLabServerSelfSigned').checked=server.allow_self_signed!==false;$('eagleLabServerCancelBtn').hidden=false;$('eagleLabServerSaveBtn').textContent='Save server';
  }
  async function saveAdminServer(event) {
    event.preventDefault(); const id=$('eagleLabServerId').value;
    const payload={hostname:$('eagleLabServerHostname').value.trim(),ip:$('eagleLabServerIp').value.trim(),port:Number($('eagleLabServerPort').value||8006),username:$('eagleLabServerUsername').value.trim(),notes:$('eagleLabServerNotes').value,allow_self_signed:$('eagleLabServerSelfSigned').checked};
    if($('eagleLabServerPassword').value)payload.password=$('eagleLabServerPassword').value;
    if($('eagleLabServerClearPin').checked)payload.pin='';
    else if($('eagleLabServerPin').value)payload.pin=$('eagleLabServerPin').value;
    $('eagleLabAdminStatus').textContent='Saving…';
    try{await api(id?`/api/eagle-lab/admin/servers/${encodeURIComponent(id)}`:'/api/eagle-lab/admin/servers',{method:id?'PUT':'POST',body:JSON.stringify(payload)});resetAdminForm();await loadAdmin();$('eagleLabAdminStatus').textContent='Server saved.';}catch(error){$('eagleLabAdminStatus').textContent=error.message;}
  }
  async function deleteAdminServer(id){if(!confirm('Remove this PVE server from Eagle Lab and every class rule?'))return;try{await api(`/api/eagle-lab/admin/servers/${encodeURIComponent(id)}`,{method:'DELETE'});await loadAdmin();}catch(error){$('eagleLabAdminStatus').textContent=error.message;}}

  async function openTeacherPanel(){
    state.classId=populateClassSelect($('eagleLabTeacherClassSelect'),$('eagleLabTeacherClassSelect')?.value||preferredClassId());
    if(!state.classId){$('eagleLabTeacherStatus').textContent='Create or select a class first.';return;}
    $('eagleLabTeacherStatus').textContent='Loading…';
    try{state.teacherData=await api(`/api/eagle-lab/teacher/classes/${encodeURIComponent(state.classId)}`);renderTeacher();}catch(error){$('eagleLabTeacherStatus').textContent=error.message;}
  }
  function renderTeacher(){const data=state.teacherData||{},rule=data.rule||{};$('eagleLabTeacherEnabled').checked=!!rule.enabled;$('eagleLabTeacherCredentials').checked=!!rule.show_credentials;$('eagleLabTeacherServers').innerHTML=(data.servers||[]).map(server=>`<label class="eagle-lab-teacher-server"><span><strong>${esc(server.hostname)}</strong><small>${esc(server.ip)}:${Number(server.port)||8006} · ${esc(server.status)}</small></span><input type="checkbox" data-teacher-server="${esc(server.id)}" ${(rule.server_ids||[]).includes(server.id)?'checked':''}></label>`).join('')||'<p>No servers have been enrolled by the administrator.</p>';$('eagleLabTeacherStatus').textContent=data.globally_enabled?'':'Eagle Lab is globally disabled; these rules will be retained.';}
  async function saveTeacher(){const payload={enabled:$('eagleLabTeacherEnabled').checked,show_credentials:$('eagleLabTeacherCredentials').checked,server_ids:[...document.querySelectorAll('[data-teacher-server]:checked')].map(item=>item.dataset.teacherServer)};$('eagleLabTeacherStatus').textContent='Saving…';try{await api(`/api/eagle-lab/teacher/classes/${encodeURIComponent(state.classId)}`,{method:'PUT',body:JSON.stringify(payload)});await openTeacherPanel();$('eagleLabTeacherStatus').textContent='Class rules saved.';}catch(error){$('eagleLabTeacherStatus').textContent=error.message;}}

  function reportResponses(questions, root, partial=true){const responses=[],missing=[];questions.forEach((question,index)=>{let answer;if(question.type==='procedure'){answer=(question.steps||[]).map((_,step)=>!!root.querySelector(`[data-report-question="${CSS.escape(question.id)}"][data-step="${step}"]`)?.checked);if(!partial&&!answer.every(Boolean))missing.push(index+1);}else{answer=root.querySelector(`[data-report-question="${CSS.escape(question.id)}"]`)?.value||'';if(!partial&&!answer.trim())missing.push(index+1);}responses.push({questionId:question.id,questionType:question.type,answer});});return{responses,missing};}
  async function openReportById(assignmentId, assignmentHint=null){
    const reportSession=sessionKey();
    if(state.report?.root?.isConnected){state.report.root.querySelector('textarea,input')?.focus();return;}
    const assignment=assignmentHint||state.assignments.find(item=>item.id===assignmentId)||{id:assignmentId,name:'Lab Report',task:''};
    try{
      const [quizData,draft]=await Promise.all([api(`/api/quiz/${encodeURIComponent(assignmentId)}`),api(`/api/lab-reports/${encodeURIComponent(assignmentId)}/draft`)]);
      if(reportSession!==sessionKey())return;
      const questions=quizData.quiz?.questions||[], saved=Object.fromEntries((quizData.savedResponses||[]).map(item=>[item.questionId,item.answer])), drafted=Object.fromEntries((draft.responses||[]).map(item=>[item.questionId,item.answer]));
      const answers={...saved,...drafted},overlay=document.createElement('div');overlay.className='lab-report-overlay';
      overlay.innerHTML=`<section class="lab-report-window" role="dialog" aria-modal="true" aria-label="${esc(assignment.name)}"><header><div><h2>${esc(assignment.name)}</h2><span class="lab-report-save-state" role="status">${draft.updated_at?'Draft restored':'Ready'}</span></div><button class="btn secondary" data-report-close type="button">Close</button></header><div class="lab-report-page"><div class="lab-report-description">${esc(assignment.task||'')}</div>${questions.map((question,index)=>`<section class="lab-report-question"><h3>${index+1}. ${esc(question.question||'')}</h3><p>${Number(question.points)||0} points</p>${question.type==='procedure'?`<div class="lab-report-procedure">${(question.steps||[]).map((step,i)=>`<label><input type="checkbox" data-report-question="${esc(question.id)}" data-step="${i}" ${Array.isArray(answers[question.id])&&answers[question.id][i]?'checked':''}><span>${esc(step)}</span></label>`).join('')}</div>`:question.type==='fill_blank'?`<input type="text" data-report-question="${esc(question.id)}" value="${esc(answers[question.id]||'')}" autocomplete="off">`:`<textarea data-report-question="${esc(question.id)}">${esc(answers[question.id]||'')}</textarea>`}</section>`).join('')}</div><div class="lab-report-actions"><button class="btn secondary" data-report-close type="button">Close for now</button><button class="btn run" data-report-submit type="button">Submit lab report</button></div></section>`;
      document.body.append(overlay);let revision=Number(draft.revision||0),timer=null,saveChain=Promise.resolve(),conflicted=false;const saveState=overlay.querySelector('.lab-report-save-state');
      let savedOkay=true,submitting=false,editVersion=0;
      const save=()=>{
        if(conflicted||submitting||!overlay.isConnected||reportSession!==sessionKey())return Promise.resolve(false);
        clearTimeout(timer);
        const responses=reportResponses(questions,overlay,true).responses,version=editVersion;
        saveState.textContent='Saving…';
        saveChain=saveChain.then(async()=>{
          if(reportSession!==sessionKey())return false;
          try{
            const result=await api(`/api/lab-reports/${encodeURIComponent(assignmentId)}/draft`,{method:'PUT',body:JSON.stringify({revision,responses})});
            revision=result.revision;savedOkay=version===editVersion;
            saveState.textContent=savedOkay?'Saved':'Unsaved';return true;
          }catch(error){
            savedOkay=false;
            if(error.status===409){conflicted=true;saveState.textContent='Open in another session — reload before continuing';}
            else saveState.textContent=error.message;
            return false;
          }
        });
        return saveChain;
      };
      overlay.querySelector('.lab-report-page').addEventListener('input',()=>{editVersion++;savedOkay=false;clearTimeout(timer);saveState.textContent='Unsaved';timer=setTimeout(save,700);});overlay.querySelector('.lab-report-page').addEventListener('change',()=>{editVersion++;savedOkay=false;clearTimeout(timer);saveState.textContent='Unsaved';timer=setTimeout(save,250);});
      const close=async()=>{if(submitting)return;if(!await save()||!savedOkay)return;overlay.remove();if(state.report?.root===overlay)state.report=null;};overlay.querySelectorAll('[data-report-close]').forEach(button=>button.onclick=close);
      overlay.querySelector('[data-report-submit]').onclick=async()=>{if(submitting||conflicted||reportSession!==sessionKey())return;const result=reportResponses(questions,overlay,false);if(result.missing.length){alert(`Complete every response and procedure step before submitting. Missing: ${result.missing.join(', ')}`);return;}if(!confirm('Submit this lab report?'))return;submitting=true;clearTimeout(timer);await saveChain;if(reportSession!==sessionKey()){submitting=false;return;}try{await api('/api/quiz/submit',{method:'POST',body:JSON.stringify({assignmentId,quizResponses:result.responses,closedByStudent:false})});overlay.remove();state.report=null;await loadReports();alert('Lab report submitted.');}catch(error){saveState.textContent=error.message;submitting=false;}};
      state.report={root:overlay,assignmentId,save,dirty:()=>!savedOkay,session:reportSession,cancel:()=>{clearTimeout(timer);overlay.remove();}};
    }catch(error){alert(error.message||'Could not open the lab report.');}
  }

  function applyConfig(config={}){const ctx=context(),available=!!(config.eagle_lab_enabled||ctx.ADMIN_TOKEN);if($('eagleLabViewBtn'))$('eagleLabViewBtn').hidden=!available;}
  async function refreshAvailability(){let config=context().currentConfig;if(!config&&window.EagleIDE?.configReady){await window.EagleIDE.configReady;config=context().currentConfig;}applyConfig(config||{});}
  function attach(){
    window.addEventListener('message',async event=>{
      const data=event.data,workspace=state.workspace;
      if(!workspace||workspace.transport!=='path'||!workspace.root.isConnected||event.origin!=='null'||!data||data.type!=='eagle-lab-clipboard'||data.key!==workspace.clipboardKey||typeof data.id!=='string'||data.id.length>100||!['readText','writeText'].includes(data.method))return;
      workspace.clipboardTimes=workspace.clipboardTimes.filter(time=>Date.now()-time<2000);
      if(workspace.clipboardTimes.length>=8)return;workspace.clipboardTimes.push(Date.now());
      const result={type:'eagle-lab-clipboard-result',key:workspace.clipboardKey,id:data.id};
      try{
        if(!document.hasFocus()||workspace.session!==sessionKey())throw new Error('Focus the Eagle Lab window to use the clipboard.');
        if(data.method==='writeText'){
          if(typeof data.text!=='string'||data.text.length>1000000)throw new Error('Clipboard text is too large.');
          await navigator.clipboard.writeText(data.text);
        }else {result.text=await navigator.clipboard.readText();if(result.text.length>1000000)throw new Error('Clipboard text is too large.');}
      }catch(error){result.error=error.message||'Clipboard permission is required.';}
      if(state.workspace===workspace&&workspace.session===sessionKey())event.source?.postMessage(result,'*');
    });
    window.addEventListener('eagle-context-updated',()=>{if(state.workspace&&state.workspace.session!==sessionKey())closeWorkspace(false);document.querySelectorAll('.eagle-lab-credentials').forEach(item=>item.closest('.modal')?.remove());});
    [$('wikiViewBtn'),$('wikiHomeBtn'),$('ideViewBtn'),$('networkViewBtn'),$('eagleLabViewBtn')].forEach(button=>button?.addEventListener('click',()=>closeWorkspace()));
    window.addEventListener('popstate',()=>closeWorkspace());
    window.addEventListener('beforeunload',event=>{if(state.report?.dirty?.()){event.preventDefault();event.returnValue='';}});
    $('eagleLabViewBtn')?.addEventListener('click',()=>show());$('eagleLabClassSelect')?.addEventListener('change',event=>{state.classId=event.target.value;loadLab();});$('eagleLabSearch')?.addEventListener('input',event=>{state.search=event.target.value;renderServers();});$('eagleLabRefreshBtn')?.addEventListener('click',loadLab);$('eagleLabServerGrid')?.addEventListener('click',event=>{const card=event.target.closest('[data-lab-server]');if(card)openServer(card.dataset.labServer);});$('eagleLabReportList')?.addEventListener('click',event=>{const card=event.target.closest('[data-lab-report]');if(card)openReportById(card.dataset.labReport,state.assignments.find(item=>item.id===card.dataset.labReport));});
    $('eagleLabServerForm')?.addEventListener('submit',saveAdminServer);$('eagleLabServerCancelBtn')?.addEventListener('click',resetAdminForm);$('eagleLabAdminServers')?.addEventListener('click',event=>{const edit=event.target.closest('[data-admin-edit]'),remove=event.target.closest('[data-admin-delete]');if(edit)editAdminServer(edit.dataset.adminEdit);if(remove)deleteAdminServer(remove.dataset.adminDelete);});
    $('eagleLabTeacherClassSelect')?.addEventListener('change',event=>{state.classId=event.target.value;openTeacherPanel();});$('eagleLabTeacherRefreshBtn')?.addEventListener('click',openTeacherPanel);$('eagleLabTeacherSaveBtn')?.addEventListener('click',saveTeacher);
    window.addEventListener('eagle-context-updated',()=>{if(state.report&&state.report.session!==sessionKey()){state.report.cancel();state.report=null;}if(!sessionKey()){state.bootstrap=null;state.assignments=[];state.adminServers=[];state.teacherData=null;document.querySelectorAll('.eagle-lab-detail').forEach(item=>item.closest('.modal')?.remove());}});
    [$('wikiViewBtn'),$('ideViewBtn'),$('networkViewBtn')].forEach(button=>button?.addEventListener('click',()=>state.report?.save?.()));window.addEventListener('eagle-context-updated',()=>{refreshAvailability();if(document.body.classList.contains('eagle-lab-mode')){state.classId=populateClassSelect($('eagleLabClassSelect'),preferredClassId());loadLab();}});window.addEventListener('pagehide',()=>state.report?.save?.());
  }
  function initialize(){if(state.initialized)return;state.initialized=true;attach();refreshAvailability();}
  window.EagleLab={show,applyConfig,refreshAvailability,openTeacherPanel,openReportById,loadAdmin,getState:()=>state};initialize();
})();
