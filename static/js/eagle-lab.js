/* Native Eagle Lab section and continuous, autosaving lab reports. */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const state = { initialized:false, bootstrap:null, classId:'', search:'', assignments:[], adminServers:[], adminOrdering:false, adminSaving:false, teacherData:null, teacherClassId:'', teacherDrafts:new Map(), teacherVersion:0, teacherSaving:false, labLoad:0, reportOpening:false, report:null, workspace:null };

  function context() { return window.EagleIDE?.getContext?.() || {}; }
  function sessionKey() { const ctx=context(); return ctx.ADMIN_TOKEN || ctx.TEACHER_TOKEN || ctx.USER_TOKEN || ''; }
  function headers(json = false) {
    const ctx = context(), result = {};
    if (ctx.ADMIN_TOKEN) result['X-Admin-Token'] = ctx.ADMIN_TOKEN;
    else if (ctx.TEACHER_TOKEN) result[ctx.currentTeacher?.is_coteacher?'X-User-Token':'X-Teacher-Token'] = ctx.TEACHER_TOKEN;
    else if (ctx.USER_TOKEN) result['X-User-Token'] = ctx.USER_TOKEN;
    if (json) result['Content-Type'] = 'application/json';
    return result;
  }
  async function api(url, options = {}) {
    const requestSession=sessionKey();
    const response = await fetch(url, { cache:'no-store', signal:typeof AbortSignal!=='undefined'?AbortSignal.timeout(15000):undefined, ...options, headers:{...headers(!!options.body), ...(options.headers || {})} });
    const data = await response.json().catch(() => ({}));
    if(requestSession!==sessionKey())throw new Error('Your session changed. Reopen Eagle Lab.');
    if (!response.ok || !data.ok) { const error = new Error(data.error || `Request failed (${response.status})`); error.status=response.status; error.data=data.data; throw error; }
    return data.data !== undefined ? data.data : data;
  }
  function classes() {
    const ctx=context();
    if (ctx.TEACHER_TOKEN&&!ctx.currentTeacher?.is_coteacher) return ctx.teacherClasses || [];
    if (ctx.USER_TOKEN||ctx.currentTeacher?.is_coteacher) {const allowed=window.EagleLabAccess?.get?.();return (ctx.studentClasses?.length?ctx.studentClasses:ctx.teacherClasses||[]).filter(item=>!allowed || allowed.class_ids.includes(item.id));}
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
    const load=++state.labLoad, classId=state.classId;
    const status=$('eagleLabStatus');
    if($('eagleLabRefreshBtn'))$('eagleLabRefreshBtn').disabled=true;
    if(status) status.textContent='Checking servers…';
    try {
      const query=state.classId ? `?class_id=${encodeURIComponent(state.classId)}` : '';
      const data=await api(`/api/eagle-lab/bootstrap${query}`);
      if(load!==state.labLoad||classId!==state.classId)return;
      state.bootstrap=data;state.classId=data.class_id||state.classId;
      $('eagleLabPreview').hidden=!state.bootstrap.admin_preview;
      renderServers();
      await loadReports();
    } catch(error) {
      if(load!==state.labLoad)return;
      state.bootstrap=null;
      if(status) status.textContent=error.message;
      if($('eagleLabServerGrid')) $('eagleLabServerGrid').innerHTML=`<div class="eagle-lab-empty">${esc(error.message)}</div>`;
      if($('eagleLabReportList')) $('eagleLabReportList').innerHTML='<div class="eagle-lab-empty">No lab reports available.</div>';
    } finally {if(load===state.labLoad&&$('eagleLabRefreshBtn'))$('eagleLabRefreshBtn').disabled=false;}
  }
  function renderServers() {
    const servers=state.bootstrap?.servers || [], query=state.search.trim().toLowerCase();
    const filtered=servers.filter(item=>`${item.hostname} ${item.ip}`.toLowerCase().includes(query));
    const up=servers.filter(item=>item.status==='up').length;
    $('eagleLabStatus').textContent=`${servers.length} server${servers.length===1?'':'s'} · ${up} up`;
    $('eagleLabServerGrid').innerHTML=filtered.map(server=>`
      <button class="eagle-lab-server-card is-${esc(server.status || 'down')}" type="button" data-lab-server="${esc(server.id)}">
        <div class="eagle-lab-server-top"><span class="eagle-lab-server-icon" aria-hidden="true">▤</span><div><h3>${esc(server.hostname)}</h3><span class="eagle-lab-address">${esc(server.ip)}:${Number(server.port)||8006}</span></div><span class="eagle-lab-state ${esc(server.status)}">● ${esc(server.status || 'unknown')}</span></div>
        <p class="eagle-lab-server-reason">${esc(server.status_reason || 'Status unavailable.')}</p>
        <div class="eagle-lab-card-action"><span>Server details &amp; connect</span><span>→</span></div>
      </button>`).join('') || '<div class="eagle-lab-empty">No matching servers are available for this class.</div>';
  }
  async function loadReports() {
    const ctx=context(),classId=state.classId;
    if((!ctx.USER_TOKEN&&!ctx.currentTeacher?.is_coteacher) || (ctx.TEACHER_TOKEN&&!ctx.currentTeacher?.is_coteacher) || ctx.ADMIN_TOKEN) {state.assignments=[];renderReports();return;}
    try {
      const result=await api('/api/assignments');
      if(classId!==state.classId)return;
      const list=Array.isArray(result.assignments) ? result.assignments : [];
      state.assignments=list.filter(item=>item.assignmentType==='lab_report' && (!state.classId || item.targetClassId===state.classId));
    } catch { if(classId!==state.classId)return;state.assignments=[]; }
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
    const detailSession=sessionKey(),detailClass=state.classId;
    let credentials=null;
    if(state.bootstrap?.show_credentials && !server.pin_required) {
      try {credentials=await api(`/api/eagle-lab/servers/${encodeURIComponent(serverId)}/credentials?class_id=${encodeURIComponent(state.classId||'')}`);} catch(error) {credentials={error:error.message};}
    }
    if(detailSession!==sessionKey()||detailClass!==state.classId)return;
    document.querySelectorAll('.eagle-lab-detail').forEach(item=>item.closest('.modal')?.remove());
    const modal=document.createElement('dialog'); modal.className='modal glass-modal eagle-lab-detail-dialog';modal.setAttribute('aria-label',server.hostname);
    modal.innerHTML=`<div class="modal-content eagle-lab-detail">
      <div class="workspace-modal-header"><div><span class="lab-report-eyebrow">PROXMOX VE · SERVER</span><h3>${esc(server.hostname)}</h3></div><button class="btn secondary" data-close type="button">Close</button></div>
      <div class="eagle-lab-detail-grid"><div class="eagle-lab-detail-item"><span>Address</span><code>${esc(server.ip)}:${Number(server.port)||8006}</code></div><div class="eagle-lab-detail-item"><span>Status</span><strong>${esc(server.status||'unknown')}</strong></div>
      ${credentials && !credentials.error ? `<div class="eagle-lab-detail-item"><span>Username</span><div class="eagle-lab-secret-row"><code>${esc(credentials.username)}</code><button class="btn secondary" data-copy="${esc(credentials.username)}" type="button">Copy</button></div></div><div class="eagle-lab-detail-item"><span>Password</span><div class="eagle-lab-secret-row"><code data-secret>••••••••</code><button class="btn secondary" data-reveal="${esc(credentials.password)}" type="button">Reveal</button><button class="btn secondary" data-copy="${esc(credentials.password)}" type="button">Copy</button></div></div>` : ''}</div>
      ${credentials?.error?`<p class="meta">${esc(credentials.error)}</p>`:''}<p>${esc(server.notes||'')}</p>
      ${server.pin_required?'<label>Server PIN<input data-lab-pin type="password" inputmode="numeric" maxlength="12" autocomplete="off" placeholder="Enter the PIN assigned by your administrator"></label>':''}
      <p data-connect-status role="status"></p>
      <div class="modal-actions"><button class="btn run" data-connect type="button">Connect to PVE</button><button class="btn secondary" data-close type="button">Close</button></div></div>`;
    document.body.append(modal);state.detail={root:modal,session:detailSession};modal.showModal();
    modal.addEventListener('cancel',event=>{event.preventDefault();modal.remove();});
    modal.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>modal.remove());
    modal.onclick=event=>{if(event.target===modal)modal.remove();};
    modal.querySelector('[data-reveal]')?.addEventListener('click',event=>{const code=modal.querySelector('[data-secret]');code.textContent=event.currentTarget.dataset.reveal;event.currentTarget.remove();});
    modal.querySelectorAll('[data-copy]').forEach(button=>button.onclick=async()=>{try{await navigator.clipboard.writeText(button.dataset.copy);button.textContent='Copied';}catch{button.textContent='Select manually';}});
    modal.querySelector('[data-connect]').onclick=async event=>{
      const button=event.currentTarget,status=modal.querySelector('[data-connect-status]');button.disabled=true;status.textContent='Connecting…';
      try{
        await closeWorkspace();
        const launch=await api(`/api/eagle-lab/servers/${encodeURIComponent(serverId)}/launch`,{method:'POST',body:JSON.stringify({class_id:state.classId,pin:modal.querySelector('[data-lab-pin]')?.value||''})});
        if(!modal.isConnected||detailSession!==sessionKey()||detailClass!==state.classId)return;
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
    root.innerHTML=`<header class="eagle-lab-workspace-toolbar"><button class="btn secondary" data-workspace-manual type="button">Lab Manual</button><button class="btn secondary" data-workspace-exit type="button">← Eagle Lab</button><strong>${esc(server.hostname)}</strong><span class="eagle-lab-clipboard-hint">Terminal: Ctrl+C interrupts · Ctrl+Shift+C / Ctrl+Shift+V copy/paste · VM: noVNC clipboard</span>${credentials?'<button class="btn secondary" data-workspace-credentials type="button">Credentials</button>':''}<select data-workspace-report aria-label="Lab report"><option value="">Choose lab report</option>${state.assignments.map(item=>`<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('')}</select><button class="btn secondary" data-workspace-open-report type="button">Open report</button></header>
      <iframe name="${esc(frameName)}" title="${esc(server.hostname)} management interface" sandbox="${sandbox}" allow="clipboard-read *; clipboard-write *; fullscreen *" allowfullscreen referrerpolicy="no-referrer"></iframe>`;
    document.body.append(root);
    state.workspace={root,serverId:server.id,session:originalSession,transport:launch.transport,clipboardKey:launch.clipboard_key,clipboardTimes:[]};
    root.querySelector('[data-workspace-manual]').onclick=()=>window.LabManual?.open();
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
    $('eagleLabServerForm')?.reset(); $('eagleLabServerId').value=''; $('eagleLabServerPort').value='8006'; $('eagleLabServerUsername').value='root'; $('eagleLabServerSelfSigned').checked=true;
    $('eagleLabServerPassword').required=true;$('eagleLabServerPin').disabled=false;$('eagleLabServerPin').placeholder='Optional 4–12 digits';
    $('eagleLabServerDialogTitle').textContent='Enroll server';$('eagleLabServerDialogHelp').textContent="Add a Proxmox VE server reachable from EagleIDE's local network.";
    $('eagleLabServerPasswordHelp').textContent='Required for enrollment.';$('eagleLabServerPinHelp').textContent='Use 4–12 digits. Students also need class access.';
    $('eagleLabServerClearPinLabel').hidden=true;$('eagleLabServerFormStatus').textContent='';$('eagleLabServerSaveBtn').textContent='Enroll server';
  }
  function closeAdminEditor(){if(state.adminSaving)return;$('eagleLabServerDialog')?.close();resetAdminForm();}
  function openAdminEditor(id='') {
    if(!context().ADMIN_TOKEN||state.adminSaving)return;
    resetAdminForm();
    if(id&&!editAdminServer(id))return;
    state.editorSession=sessionKey();$('eagleLabServerDialog').showModal();$('eagleLabServerHostname').focus();
  }
  function renderAdminServers() {
    $('eagleLabAdminServers').innerHTML=state.adminServers.map((server,index)=>`<article class="eagle-lab-admin-server"><div class="eagle-lab-server-summary"><strong>${esc(server.hostname)}</strong><small>${esc(server.ip)}:${Number(server.port)||8006} · ${esc(server.username)} · ${server.pin_required?'PIN protected':'No PIN'}</small></div><div class="eagle-lab-admin-server-actions"><label class="eagle-lab-position">Position<select data-admin-position="${esc(server.id)}" aria-label="Position for ${esc(server.hostname)}" ${state.adminOrdering?'disabled':''}>${state.adminServers.map((_,position)=>`<option value="${position}" ${position===index?'selected':''}>${position+1}</option>`).join('')}</select></label><button class="btn secondary" type="button" data-admin-move="${esc(server.id)}" data-direction="-1" aria-label="Move ${esc(server.hostname)} up" ${index===0||state.adminOrdering?'disabled':''}>↑</button><button class="btn secondary" type="button" data-admin-move="${esc(server.id)}" data-direction="1" aria-label="Move ${esc(server.hostname)} down" ${index===state.adminServers.length-1||state.adminOrdering?'disabled':''}>↓</button><button class="btn secondary" type="button" data-admin-edit="${esc(server.id)}">Edit</button><button class="btn stop" type="button" data-admin-delete="${esc(server.id)}">Remove</button></div></article>`).join('')||'<p>No PVE servers enrolled. Choose Enroll server to add one.</p>';
  }
  function editAdminServer(id) {
    const server=state.adminServers.find(item=>item.id===id);if(!server)return false;
    $('eagleLabServerPin').value='';$('eagleLabServerPin').placeholder=server.pin_required?'PIN is set — leave blank to keep':'Optional 4–12 digits';$('eagleLabServerClearPin').checked=false;
    $('eagleLabServerId').value=server.id;$('eagleLabServerHostname').value=server.hostname;$('eagleLabServerIp').value=server.ip;$('eagleLabServerPort').value=server.port||8006;$('eagleLabServerUsername').value=server.username||'root';$('eagleLabServerPassword').value='';$('eagleLabServerNotes').value=server.notes||'';$('eagleLabServerSelfSigned').checked=server.allow_self_signed!==false;$('eagleLabServerSaveBtn').textContent='Save changes';
    $('eagleLabServerPassword').required=false;$('eagleLabServerDialogTitle').textContent='Edit server';$('eagleLabServerDialogHelp').textContent=server.hostname;
    $('eagleLabServerPasswordHelp').textContent='Leave blank to keep the saved password.';$('eagleLabServerPinHelp').textContent=server.pin_required?'A PIN is set. Leave blank to keep it, enter a replacement, or choose Remove existing PIN.':'No PIN is set. Enter 4–12 digits to require one.';
    $('eagleLabServerClearPinLabel').hidden=!server.pin_required;return true;
  }
  async function reorderAdminServer(id,position){
    if(state.adminOrdering||!context().ADMIN_TOKEN)return;
    const items=state.adminServers.slice(),index=items.findIndex(item=>item.id===id);
    if(index<0||!Number.isInteger(position)||position<0||position>=items.length||index===position)return;
    items.splice(position,0,items.splice(index,1)[0]);state.adminOrdering=true;renderAdminServers();$('eagleLabAdminStatus').textContent='Saving server order…';
    try{const data=await api('/api/eagle-lab/admin/server-order',{method:'PUT',body:JSON.stringify({server_ids:items.map(item=>item.id)})});state.adminServers=data.servers;$('eagleLabAdminStatus').textContent='Server order saved. Students see this order.';state.bootstrap=null;}
    catch(error){await loadAdmin();$('eagleLabAdminStatus').textContent=error.message;}
    finally{state.adminOrdering=false;renderAdminServers();}
  }
  async function saveAdminServer(event) {
    event.preventDefault();if(state.adminSaving||!context().ADMIN_TOKEN)return;const id=$('eagleLabServerId').value;
    const payload={hostname:$('eagleLabServerHostname').value.trim(),ip:$('eagleLabServerIp').value.trim(),port:Number($('eagleLabServerPort').value||8006),username:$('eagleLabServerUsername').value.trim(),notes:$('eagleLabServerNotes').value,allow_self_signed:$('eagleLabServerSelfSigned').checked};
    if($('eagleLabServerPassword').value)payload.password=$('eagleLabServerPassword').value;
    if($('eagleLabServerClearPin').checked)payload.pin='';
    else if($('eagleLabServerPin').value)payload.pin=$('eagleLabServerPin').value;
    state.adminSaving=true;$('eagleLabServerSaveBtn').disabled=true;$('eagleLabServerFormStatus').textContent='Saving…';const originalSession=sessionKey();
    try{await api(id?`/api/eagle-lab/admin/servers/${encodeURIComponent(id)}`:'/api/eagle-lab/admin/servers',{method:id?'PUT':'POST',body:JSON.stringify(payload)});state.adminSaving=false;closeAdminEditor();await loadAdmin();$('eagleLabAdminStatus').textContent=id?'Server changes saved.':'Server enrolled.';}
    catch(error){if(sessionKey()===originalSession)$('eagleLabServerFormStatus').textContent=error.message;}
    finally{state.adminSaving=false;$('eagleLabServerSaveBtn').disabled=false;}
  }
  async function deleteAdminServer(id){if(!confirm('Remove this PVE server from Eagle Lab and every class rule?'))return;try{await api(`/api/eagle-lab/admin/servers/${encodeURIComponent(id)}`,{method:'DELETE'});await loadAdmin();}catch(error){$('eagleLabAdminStatus').textContent=error.message;}}

  function captureTeacherDraft(){
    if(!state.teacherClassId||!state.teacherData)return;
    state.teacherDrafts.set(state.teacherClassId,{enabled:$('eagleLabTeacherEnabled').checked,show_credentials:$('eagleLabTeacherCredentials').checked,server_ids:[...document.querySelectorAll('[data-teacher-server]:checked')].map(item=>item.dataset.teacherServer),version:++state.teacherVersion});
    $('eagleLabTeacherStatus').textContent='Unsaved changes · refresh keeps your edits';
  }
  async function openTeacherPanel(){
    const classId=populateClassSelect($('eagleLabTeacherClassSelect'),$('eagleLabTeacherClassSelect')?.value||preferredClassId());
    const request=state.teacherLoad=(state.teacherLoad||0)+1, original=sessionKey();
    if(!classId){$('eagleLabTeacherStatus').textContent='Create or select a class first.';return;}
    state.teacherSession=original;
    $('eagleLabTeacherStatus').textContent='Refreshing server availability…';
    try{const data=await api(`/api/eagle-lab/teacher/classes/${encodeURIComponent(classId)}`);if(request!==state.teacherLoad||original!==sessionKey()||$('eagleLabTeacherClassSelect').value!==classId)return;state.teacherData=data;state.teacherClassId=classId;renderTeacher();}catch(error){if(request===state.teacherLoad)$('eagleLabTeacherStatus').textContent=error.message;}
  }
  function renderTeacher(){
    const data=state.teacherData||{},draft=state.teacherDrafts.get(state.teacherClassId),rule=draft||data.rule||{};
    $('eagleLabTeacherEnabled').checked=!!rule.enabled;$('eagleLabTeacherCredentials').checked=!!rule.show_credentials;
    $('eagleLabTeacherServers').innerHTML=(data.servers||[]).map(server=>`<label class="eagle-lab-teacher-server"><input type="checkbox" data-teacher-server="${esc(server.id)}" ${(rule.server_ids||[]).includes(server.id)?'checked':''}><span class="eagle-lab-teacher-server-icon" aria-hidden="true">▤</span><span><strong>${esc(server.hostname)}</strong><small>${esc(server.ip)}:${Number(server.port)||8006}</small></span><span class="eagle-lab-state ${esc(server.status||'checking')}">${esc(server.status||'checking')}</span></label>`).join('')||'<p>No servers have been enrolled by the administrator.</p>';
    $('eagleLabTeacherStatus').textContent=draft?'Unsaved changes · refresh keeps your edits':data.globally_enabled?'Choose the servers students in this class can use.':'Eagle Lab is globally disabled; these rules will be retained.';
  }
  async function saveTeacher(){
    if(state.teacherSaving||!state.teacherClassId||state.teacherClassId!==$('eagleLabTeacherClassSelect').value)return;
    captureTeacherDraft();const classId=state.teacherClassId,draft=state.teacherDrafts.get(classId),original=sessionKey();
    const payload={enabled:draft.enabled,show_credentials:draft.show_credentials,server_ids:draft.server_ids};
    state.teacherSaving=true;$('eagleLabTeacherSaveBtn').disabled=true;$('eagleLabTeacherStatus').textContent='Saving class access…';
    try{const result=await api(`/api/eagle-lab/teacher/classes/${encodeURIComponent(classId)}`,{method:'PUT',body:JSON.stringify(payload)});if(original!==sessionKey())return;if(state.teacherDrafts.get(classId)?.version===draft.version)state.teacherDrafts.delete(classId);if(state.teacherClassId===classId){state.teacherData.rule=result.rule;renderTeacher();$('eagleLabTeacherStatus').textContent=state.teacherDrafts.has(classId)?'Saved. Newer edits are still unsaved.':'Class access saved.';}window.EagleLabAccess?.refresh?.(null,true);}
    catch(error){if(original===sessionKey())$('eagleLabTeacherStatus').textContent=error.message;}
    finally{state.teacherSaving=false;$('eagleLabTeacherSaveBtn').disabled=false;}
  }

  function reportResponses(questions, root, partial=true){const responses=[],missing=[];questions.forEach((question,index)=>{let answer;if(question.type==='procedure'){answer=(question.steps||[]).map((_,step)=>!!root.querySelector(`[data-report-question="${CSS.escape(question.id)}"][data-step="${step}"]`)?.checked);if(!partial&&!answer.every(Boolean))missing.push(index+1);}else{answer=root.querySelector(`[data-report-question="${CSS.escape(question.id)}"]`)?.value||'';if(!partial&&!answer.trim())missing.push(index+1);}responses.push({questionId:question.id,questionType:question.type,answer});});return{responses,missing};}
  async function openReportById(assignmentId, assignmentHint=null){
    const reportSession=sessionKey();
    if(state.reportOpening)return;
    if(state.report?.root?.isConnected){if(state.report.assignmentId===assignmentId){state.report.root.querySelector('textarea,input')?.focus();return;}if(!await state.report.close())return;}
    state.reportOpening=true;
    const assignment=assignmentHint||state.assignments.find(item=>item.id===assignmentId)||{id:assignmentId,name:'Lab Report',task:''};
    try{
      const [quizData,draft]=await Promise.all([api(`/api/quiz/${encodeURIComponent(assignmentId)}`),api(`/api/lab-reports/${encodeURIComponent(assignmentId)}/draft`)]);
      if(reportSession!==sessionKey())return;
      const questions=quizData.quiz?.questions||[], saved=Object.fromEntries((quizData.savedResponses||[]).map(item=>[item.questionId,item.answer])), drafted=Object.fromEntries((draft.responses||[]).map(item=>[item.questionId,item.answer]));
      const answers={...saved,...drafted},overlay=document.createElement('div');overlay.className='lab-report-overlay';
      const content=window.LabReportContent, prose=value=>content?.render(value)||`<div class="lab-report-prose">${esc(value)}</div>`;
      overlay.innerHTML=`<section class="lab-report-window" role="dialog" aria-modal="false" aria-label="${esc(assignment.name)}"><header><div><span class="lab-report-eyebrow">LAB REPORT · AUTOSAVE</span><h2>${esc(assignment.name)}</h2><span class="lab-report-save-state" role="status">${draft.updated_at?'Draft restored':'Ready'}</span></div><div class="lab-report-window-tools"><button class="btn secondary" data-float-move type="button" aria-label="Move report with arrow keys" title="Drag to move · arrow keys to move">⠿</button><button class="btn secondary" data-float-minimize type="button" aria-expanded="true">Minimize</button><button class="btn secondary" data-report-close type="button" aria-label="Close report">✕</button></div></header><div class="lab-report-page"><p class="lab-report-hint">Keep this window open while you work. Drag the grip to move it or use Minimize to see more of your console.</p><div class="lab-report-description">${prose(assignment.task||'')}</div>${questions.map((question,index)=>`<section class="lab-report-question"><div class="lab-report-question-meta"><span>SECTION ${index+1} · ${esc(question.type==='procedure'?'CHECKLIST':question.type==='fill_blank'?'SHORT ANSWER':'WRITTEN RESPONSE')}</span><span>${Number(question.points)||0} points</span></div><div class="lab-report-prompt" id="report-label-${index}">${prose(question.question||'')}</div>${question.type==='procedure'?`<p class="lab-report-check-hint">Select every checkbox in this checklist to receive credit for this section.</p><div class="lab-report-procedure">${(question.steps||[]).map((step,i)=>`<div class="lab-report-check-row"><input type="checkbox" aria-label="Section ${index+1}, step ${i+1}" data-report-question="${esc(question.id)}" data-step="${i}" ${Array.isArray(answers[question.id])&&answers[question.id][i]?'checked':''}><div>${prose(step)}</div></div>`).join('')}</div>`:question.type==='fill_blank'?`<input type="text" aria-labelledby="report-label-${index}" placeholder="Your answer" maxlength="20000" data-report-question="${esc(question.id)}" value="${esc(answers[question.id]||'')}" autocomplete="off">`:`<textarea aria-labelledby="report-label-${index}" maxlength="20000" placeholder="Record your observations…" data-report-question="${esc(question.id)}">${esc(answers[question.id]||'')}</textarea>`}</section>`).join('')}</div><div class="lab-report-actions"><span data-copy-status role="status" aria-live="polite"></span><button class="btn secondary" data-report-close type="button">Close for now</button><button class="btn run" data-report-submit type="button">Submit report</button></div><button type="button" class="lab-report-resize" data-float-resize aria-label="Resize report with arrow keys" title="Drag or use arrow keys to resize">◢</button></section>`;
      document.body.append(overlay);let revision=Number(draft.revision||0),timer=null,saveChain=Promise.resolve(),conflicted=false;const saveState=overlay.querySelector('.lab-report-save-state');
      const disposeContent=content?.mount(overlay,{assignmentId,student:true}),disposeFloating=content?.floating(overlay);
      const dispose=()=>{disposeContent?.();disposeFloating?.();overlay.remove();};
      let savedOkay=true,submitting=false,editVersion=0,savedVersion=0;
      const save=()=>{
        if(conflicted||submitting||!overlay.isConnected||reportSession!==sessionKey())return Promise.resolve(false);
        clearTimeout(timer);
        if(savedOkay&&savedVersion===editVersion)return saveChain.then(()=>true);
        const responses=reportResponses(questions,overlay,true).responses,version=editVersion;
        saveState.textContent='Saving…';
        saveChain=saveChain.then(async()=>{
          if(reportSession!==sessionKey())return false;
          if(version<=savedVersion)return true;
          try{
            const result=await api(`/api/lab-reports/${encodeURIComponent(assignmentId)}/draft`,{method:'PUT',body:JSON.stringify({revision,responses})});
            revision=result.revision;savedVersion=version;savedOkay=version===editVersion;
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
      const close=async()=>{if(submitting)return false;if(!await save()||!savedOkay)return false;dispose();if(state.report?.root===overlay)state.report=null;return true;};overlay.querySelectorAll('[data-report-close]').forEach(button=>button.onclick=close);
      overlay.querySelector('[data-report-submit]').onclick=async()=>{if(submitting||conflicted||reportSession!==sessionKey())return;const result=reportResponses(questions,overlay,false);if(result.missing.length){alert(`Complete every response and procedure step before submitting. Missing: ${result.missing.join(', ')}`);return;}if(!confirm('Submit this lab report?'))return;submitting=true;overlay.querySelectorAll('textarea,input,[data-report-submit]').forEach(field=>field.disabled=true);clearTimeout(timer);await saveChain;if(reportSession!==sessionKey()){submitting=false;return;}try{await api('/api/quiz/submit',{method:'POST',body:JSON.stringify({assignmentId,quizResponses:result.responses,closedByStudent:false})});dispose();state.report=null;await loadReports();alert('Lab report submitted.');}catch(error){saveState.textContent=error.message;submitting=false;overlay.querySelectorAll('textarea,input,[data-report-submit]').forEach(field=>field.disabled=false);}};
      state.report={root:overlay,assignmentId,save,close,dirty:()=>!savedOkay,session:reportSession,cancel:()=>{clearTimeout(timer);dispose();}};
    }catch(error){alert(error.message||'Could not open the lab report.');}finally{state.reportOpening=false;}
  }

  function applyConfig(config={}){window.EagleLabAccess?.refresh?.(config);}
  async function refreshAvailability(){let config=context().currentConfig;if(!config&&window.EagleIDE?.configReady){await window.EagleIDE.configReady;config=context().currentConfig;}applyConfig(config||{});}
  function attach(){
    window.addEventListener('eagle-context-updated',()=>{
      if(state.uiSession===sessionKey())return;
      state.uiSession=sessionKey();state.labLoad++;state.teacherLoad=(state.teacherLoad||0)+1;
      state.bootstrap=null;state.assignments=[];state.adminServers=[];state.classId='';
      state.teacherData=null;state.teacherDrafts.clear();state.teacherClassId='';
      ['eagleLabServerGrid','eagleLabReportList','eagleLabAdminServers','eagleLabTeacherServers'].forEach(id=>$(id)?.replaceChildren());
      ['eagleLabTeacherEnabled','eagleLabTeacherCredentials'].forEach(id=>{if($(id))$(id).checked=false;});
    });
    window.addEventListener('eagle-lab-access-updated',event=>{
      if(event.detail.available)return;
      closeWorkspace();state.bootstrap=null;state.labLoad++;
      if($('eagleLabServerGrid'))$('eagleLabServerGrid').innerHTML='<div class="eagle-lab-empty">Eagle Lab is not enabled for your current classes.</div>';
      if($('eagleLabStatus'))$('eagleLabStatus').textContent='Class access required';
    });
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
    window.addEventListener('eagle-context-updated',()=>{if(state.workspace&&state.workspace.session!==sessionKey())closeWorkspace(false);if(state.detail&&state.detail.session!==sessionKey()){state.detail.root.remove();state.detail=null;}document.querySelectorAll('.eagle-lab-credentials').forEach(item=>item.closest('.modal')?.remove());});
    [$('wikiViewBtn'),$('wikiHomeBtn'),$('ideViewBtn'),$('networkViewBtn'),$('eagleLabViewBtn')].forEach(button=>button?.addEventListener('click',()=>closeWorkspace()));
    window.addEventListener('popstate',()=>closeWorkspace());
    window.addEventListener('beforeunload',event=>{if(state.report?.dirty?.()){event.preventDefault();event.returnValue='';}});
    $('eagleLabManualBtn')?.addEventListener('click',()=>window.LabManual?.open());$('eagleLabManualCard')?.addEventListener('click',()=>window.LabManual?.open());$('eagleLabViewBtn')?.addEventListener('click',()=>show());$('eagleLabClassSelect')?.addEventListener('change',event=>{state.classId=event.target.value;loadLab();});$('eagleLabSearch')?.addEventListener('input',event=>{state.search=event.target.value;renderServers();});$('eagleLabRefreshBtn')?.addEventListener('click',loadLab);$('eagleLabServerGrid')?.addEventListener('click',event=>{const card=event.target.closest('[data-lab-server]');if(card)openServer(card.dataset.labServer);});$('eagleLabReportList')?.addEventListener('click',event=>{const card=event.target.closest('[data-lab-report]');if(card)openReportById(card.dataset.labReport,state.assignments.find(item=>item.id===card.dataset.labReport));});
    $('eagleLabServerForm')?.addEventListener('submit',saveAdminServer);$('eagleLabServerEnrollBtn')?.addEventListener('click',()=>openAdminEditor());
    $('eagleLabServerCancelBtn')?.addEventListener('click',closeAdminEditor);$('eagleLabServerDialogClose')?.addEventListener('click',closeAdminEditor);
    $('eagleLabServerDialog')?.addEventListener('cancel',event=>{event.preventDefault();closeAdminEditor();});
    $('eagleLabServerClearPin')?.addEventListener('change',()=>{if($('eagleLabServerClearPin').checked)$('eagleLabServerPin').value='';$('eagleLabServerPin').disabled=$('eagleLabServerClearPin').checked;});
    $('eagleLabAdminServers')?.addEventListener('click',event=>{const edit=event.target.closest('[data-admin-edit]'),remove=event.target.closest('[data-admin-delete]'),move=event.target.closest('[data-admin-move]');if(edit)openAdminEditor(edit.dataset.adminEdit);if(remove&&!state.adminOrdering)deleteAdminServer(remove.dataset.adminDelete);if(move)reorderAdminServer(move.dataset.adminMove,state.adminServers.findIndex(item=>item.id===move.dataset.adminMove)+Number(move.dataset.direction));});
    $('eagleLabAdminServers')?.addEventListener('change',event=>{const select=event.target.closest('[data-admin-position]');if(select)reorderAdminServer(select.dataset.adminPosition,Number(select.value));});
    window.addEventListener('eagle-context-updated',()=>{if(state.editorSession!==sessionKey()&&$('eagleLabServerDialog')?.open){$('eagleLabServerDialog').close();resetAdminForm();}});
    $('eagleLabTeacherClassSelect')?.addEventListener('change',()=>openTeacherPanel());
    ['eagleLabTeacherEnabled','eagleLabTeacherCredentials','eagleLabTeacherServers'].forEach(id=>$(id)?.addEventListener('change',captureTeacherDraft));$('eagleLabTeacherRefreshBtn')?.addEventListener('click',openTeacherPanel);$('eagleLabTeacherSaveBtn')?.addEventListener('click',saveTeacher);
    window.addEventListener('eagle-context-updated',()=>{if(state.report&&state.report.session!==sessionKey()){state.report.cancel();state.report=null;}if(state.teacherSession!==sessionKey()){state.teacherDrafts.clear();state.teacherData=null;state.teacherClassId='';state.teacherSession=sessionKey();}if(!sessionKey()){state.bootstrap=null;state.assignments=[];state.adminServers=[];state.teacherData=null;document.querySelectorAll('.eagle-lab-detail').forEach(item=>item.closest('.modal')?.remove());}});
    [$('wikiViewBtn'),$('ideViewBtn'),$('networkViewBtn')].forEach(button=>button?.addEventListener('click',()=>state.report?.save?.()));window.addEventListener('eagle-context-updated',()=>{refreshAvailability();const ctx=context(),scope=JSON.stringify([sessionKey(),ctx.currentStudentClassId,ctx.currentTeacherClassId]);if(document.body.classList.contains('eagle-lab-mode')&&state.contextScope!==scope){state.contextScope=scope;state.classId=populateClassSelect($('eagleLabClassSelect'),preferredClassId());loadLab();}});window.addEventListener('pagehide',()=>state.report?.save?.());
  }
  function initialize(){if(state.initialized)return;state.initialized=true;state.uiSession=sessionKey();attach();refreshAvailability();}
  window.EagleLab={show,applyConfig,refreshAvailability,openTeacherPanel,openReportById,loadAdmin,getState:()=>state};initialize();
})();
