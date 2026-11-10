(() => {
  'use strict';
  const core = window.GroupProjects;
  const {esc, classColor, request, route} = core;
  const modal = (title, body, variant = '') => window.AssignmentWorkflow.modal(title, body, 'group-modal ' + variant);
  const dialogs = new Set();
  let panelSignature = '';
  function studentModal(title, body, variant) {
    const m = modal(title, body, variant);
    dialogs.add(m);
    m.cleanups.push(() => dialogs.delete(m));
    return m;
  }
  function status(m, message) {
    const target = m.root.querySelector('[data-group-status]');
    if (target) target.textContent = message;
  }
  const statusMarkup = '<p role="status" class="group-message" data-group-status></p>';
  const button = (name, label, primary = false) => `<button type="button" class="btn ${primary ? 'run' : 'secondary'}" data-group-${name}>${label}</button>`;
  const actions = (...buttons) => '<div class="modal-actions">' + buttons.join('') + '</div>';
  const bind = (m, name, fn) => {
    const control = m.root.querySelector('[data-group-' + name + ']');
    if (control) control.onclick = () => fn(control);
  };
  async function run(m, control, action) {
    control.disabled = true;
    status(m, '');
    try {await action();}
    catch (error) {status(m, error.message);}
    finally {control.disabled = false;}
  }
  async function roster() {
    const {students} = await request('/api/group-projects/roster');
    return students.sort((a,b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email));
  }
  function classmates(people, multiple) {
    return people.length ? `<div class="group-choices">${people.map(p => `<label>
      <input type="${multiple ? 'checkbox' : 'radio'}" name="groupInvitee" value="${esc(p.email)}"><span>${esc(p.name)}</span></label>`).join('')}</div>`
      : '<p>No other classmates are available.</p>';
  }
  const invitees = m => [...m.root.querySelectorAll('[name="groupInvitee"]:checked')].map(input => input.value);

  async function share(item) {
    const m = studentModal('Share as group project', `<p>Create a shared working copy of <strong>${esc(item.name)}</strong>.
      Invite up to three classmates now, or invite them from the project later.</p>
      <div data-group-roster>Loading classmates…</div>${statusMarkup}${actions(button('create','Create group project',true))}`);
    const create = m.root.querySelector('[data-group-create]');
    create.disabled = true;
    try {
      const people = await roster();
      if (!m.root.isConnected) return;
      const list = m.root.querySelector('[data-group-roster]');
      list.innerHTML = classmates(people, true);
      list.onchange = () => {
        const count = invitees(m).length;
        list.querySelectorAll('input').forEach(el => {el.disabled = !el.checked && count >= 3;});
        status(m, count ? `${count} of 3 invitations selected` : '');
      };
      create.disabled = false;
      create.onclick = () => run(m, create, async () => {
        if (!await core.context().saveCurrentFile()) throw new Error('Save your current file before sharing.');
        const {project} = await request(route(), {method:'POST', data:{path:item.path, invitees:invitees(m)}});
        if (!m.root.isConnected) return;
        await core.refresh();
        if (!m.root.isConnected) return;
        if (!project.folder && project.files[0]) await core.open(project, project.files[0]);
        else browseStudent(project.id);
        m.close();
      });
    } catch (error) {status(m, error.message);}
  }

  function addCtxMenu(menu, item, close) {
    if (!core.canShare() || item.system || item.in_trash || !item.path) return;
    const control = document.createElement('button');
    control.type = 'button';
    control.textContent = 'Share as group project…';
    const {allowed, reason} = core.available();
    if (!allowed && reason) {control.disabled = true; control.title = reason;}
    control.onclick = () => {close(); share(item);};
    menu.append(control);
  }

  function renderPanel() {
    const root = document.getElementById('groupProjectsPanel');
    if (!root) return;
    const projects = core.list();
    const {allowed, reason} = core.available();
    root.hidden = !core.canShare() && !projects.length;
    if (root.hidden) {root.replaceChildren(); panelSignature = ''; return;}
    const signature = JSON.stringify([projects, allowed, reason]);
    if (signature === panelSignature) return;
    panelSignature = signature;
    const pending = projects.filter(p => p.membership === 'pending');
    root.innerHTML = `<div class="group-panel-heading"><strong>Group Projects</strong>${pending.length ? `<span class="skill-chip">${pending.length} invited</span>` : ''}</div>
      ${!allowed && reason ? `<p class="group-muted">${esc(reason)}</p>` : ''}
      ${projects.length ? projects.map(project => `<button class="group-file-row" type="button" data-group-browse="${esc(project.id)}" ${!allowed && project.status === 'active' && project.membership !== 'pending' ? 'disabled' : ''}>
          <span class="group-file-glyph" aria-hidden="true">${project.folder ? '▰' : '▤'}</span><span class="group-file-title">${esc(project.name)}</span>
          <span class="group-file-meta">${project.status === 'canceled' ? 'Recovery copy' : project.membership === 'pending' ? 'Invitation' : `${project.members.length}/4`}</span></button>`).join('') :
        '<p class="group-muted">Open a file or folder’s menu to share it.</p>'}`;
    root.querySelectorAll('[data-group-browse]').forEach(control => control.onclick = () => {
      const project = projects.find(p => p.id === control.dataset.groupBrowse);
      if (project.status === 'canceled') {
        const m = studentModal('Recover project', `<p>Download the last saved copy of <strong>${esc(project.name)}</strong> by
          ${esc(new Date(project.recoverUntil * 1000).toLocaleDateString())}.</p>${statusMarkup}${actions(button('recover','Download copy',true))}`);
        bind(m, 'recover', control => run(m,control,async () => {await core.download(project); m.close();}));
      } else if (project.membership === 'pending') invitation(project);
      else browseStudent(project.id);
    });
  }

  function invitation(project) {
    const m = studentModal('Group project invitation', `<p><strong>${esc(project.members.find(p => p.owner)?.name || 'A classmate')}</strong> invited you to edit
      <strong>${esc(project.name)}</strong>. Group members can edit shared files and turn in work when the assignment allows it.</p>
      ${statusMarkup}${actions(button('decline','Decline'),button('accept','Join group',true))}`);
    m.root.querySelector('[data-group-accept]').disabled = !core.available().allowed;
    for (const action of ['accept','decline']) bind(m,action,control => run(m,control,async () => {
      await request(route(project.id), {method:'POST', data:{action}});
      if (!m.root.isConnected) return;
      m.close(); await core.refresh();
      if (action === 'accept') browseStudent(project.id);
    }));
  }

  function memberChips(members) {
    return `<div class="group-member-legend">${members.map(p => `<span class="group-person ${classColor(p.color)}"><span aria-hidden="true"></span>${esc(p.name)}${p.owner ? ' · Organizer' : ''}</span>`).join('')}</div>`;
  }

  function fileRows(files, teacher = false) {
    if (!files.length) return '<p class="group-muted">This folder is empty.</p>';
    return files.map(file => {
      const parts = file.path.split('/');
      return `<div class="group-file-row ${file.folder ? 'is-folder' : ''}" style="--group-depth:${Math.min(parts.length - 1, 5)}">
        <span class="group-file-glyph" aria-hidden="true">${file.folder ? '▰' : '▤'}</span>
        ${file.folder ? `<span class="group-file-title" title="${esc(file.path)}">${esc(parts.at(-1))}</span>` :
          `<button type="button" class="group-file-title group-file-open" title="${esc(file.path)}" data-group-open="${esc(file.id)}">${esc(parts.at(-1))}</button>`}
        ${!teacher ? `<button type="button" class="btn secondary group-file-options" data-group-options="${esc(file.id)}" aria-label="Options for ${esc(file.path)}">Options</button>` : ''}
      </div>`;
    }).join('');
  }

  function browseStudent(projectId) {
    const m = studentModal('Group project', '<div data-group-body>Loading project…</div>' + statusMarkup, 'group-browser-modal');
    const body = m.root.querySelector('[data-group-body]');
    let signature = '';
    async function load() {
      try {
        const {project} = await request(route(projectId));
        if (!m.root.isConnected) return;
        const next = JSON.stringify([project.members,project.files.map(f => [f.id,f.path,f.folder]),project.canInvite]);
        if (signature === next) {
          // Keep controls stable while revisions change in the background.
          Object.assign(body.project, project);
          return;
        }
        signature = next;
        body.project = project;
        body.innerHTML = `<div class="group-project-heading"><div><h4>${esc(project.name)}</h4>${memberChips(project.members)}</div>
          <div class="group-actions">${project.canInvite ? button('invite','Invite classmates') : ''}${button('download-all','Download copy')}${button('leave','Unlink and leave group')}</div></div>
          ${project.folder ? '<div class="group-actions group-tree-actions">' + button('new','New file') + button('mkdir','New folder') + button('upload','Upload file') + '</div>' : ''}
          <div class="group-file-list" aria-label="Shared project files">${fileRows(project.files)}</div>`;
        const find = id => project.files.find(file => file.id === id);
        body.querySelectorAll('[data-group-open]').forEach(control => control.onclick = () => run(m,control,async () => {
          await core.open(project, find(control.dataset.groupOpen));
          m.close();
        }));
        body.querySelectorAll('[data-group-options]').forEach(control => control.onclick = () => fileOptions(project, find(control.dataset.groupOptions), load, m));
        for (const action of ['new','mkdir','upload']) bind(m,action,() => editTree(project,action,null,load));
        bind(m,'invite',() => invite(project,load));
        bind(m,'download-all',control => run(m,control,() => core.download(project)));
        bind(m,'leave',() => leave(project,m));
      } catch (error) {status(m,error.message);}
    }
    const timer = setInterval(() => {if (!document.hidden) load();},12000);
    m.cleanups.push(() => clearInterval(timer));
    load();
  }

  function leave(project, parent) {
    const m = studentModal('Unlink and leave group', `<p>You’ll lose access to the shared project and stop receiving updates.
      Download a personal copy before leaving to keep the saved files.</p>${statusMarkup}${actions(button('save-leave','Download and leave'),button('leave-now','Leave group',true))}`);
    const submit = download => async () => {
      if (download) {
        if (core.currentProject()?.id === project.id && !await core.flush()) throw new Error('The current draft could not sync. Download it from the editor first.');
        await core.download(project);
      }
      await request(route(project.id), {method:'POST', data:{action:'leave'}});
      m.close(); parent.close(); core.refresh();
    };
    bind(m,'save-leave',control => run(m,control,submit(true)));
    bind(m,'leave-now',control => run(m,control,submit(false)));
  }

  async function invite(project, refresh) {
    const m = studentModal('Manage invitations', '<div data-group-invite-list>Loading classmates…</div>' + statusMarkup);
    try {
      const [people,{project:current}] = await Promise.all([roster(),request(route(project.id))]);
      if (!m.root.isConnected) return;
      const pending = current.invitations || [];
      const list = m.root.querySelector('[data-group-invite-list]');
      list.innerHTML = `${pending.length ? `<div class="group-invitations">${pending.map(p => `<div><span>${esc(p.name)} · Pending</span>
        <button type="button" class="btn secondary" data-group-cancel-invite="${esc(p.id)}">Cancel invitation</button></div>`).join('')}</div>` : ''}
        ${current.members.length + pending.length < 4 ? `<p>Select a classmate to invite.</p>${classmates(people.filter(person => !current.invitedEmails?.includes(person.email)), false)}
        ${actions(button('send-invite','Send invitation',true))}` : '<p>All four places are filled or reserved.</p>'}`;
      const send = data => async () => {
        await request(route(project.id), {method:'POST', data});
        m.close(); refresh(); core.refresh();
      };
      list.querySelectorAll('[data-group-cancel-invite]').forEach(control => control.onclick = () =>
        run(m,control,send({action:'cancelInvite', memberId:control.dataset.groupCancelInvite})));
      bind(m,'send-invite',control => {
        const [email] = invitees(m);
        if (!email) return status(m, 'Choose a classmate.');
        run(m,control,send({action:'invite',email}));
      });
    } catch (error) {status(m,error.message);}
  }

  function fileOptions(project, file, reload, parent) {
    const m = studentModal('Project file options', `<p><strong>${esc(file.path)}</strong></p>${statusMarkup}
      ${actions(...(!file.folder ? [button('file-download','Download'),button('replace','Replace asset')] : []),
        ...(project.folder ? [button('rename','Rename or move'),button('delete','Delete from project')] : []),
        button('unlink','Unlink and leave group'))}`);
    bind(m,'unlink',() => {m.close(); leave(project,parent);});
    bind(m,'file-download',control => run(m,control,async () => {await core.download(project,file); m.close();}));
    for (const action of ['replace','rename','delete']) bind(m,action,() => {m.close(); editTree(project,action,file,reload);});
  }

  function editTree(project, action, file, reload) {
    const titles = {new:'New project file', mkdir:'New project folder', upload:'Upload to project', rename:'Rename or move', replace:'Replace project asset', delete:'Delete from project'};
    const upload = ['upload','replace'].includes(action), deleting = action === 'delete';
    const folders = project.files.filter(f => f.folder && (!file || f.path !== file.path && !f.path.startsWith(file.path + '/')));
    const m = studentModal(titles[action], `<form class="group-form">
      ${deleting ? `<p>Delete <strong>${esc(file.path)}</strong> and its contents for everyone in this project?</p>` : ''}
      ${!deleting && action !== 'replace' ? `<label>Location<select data-group-parent><option value="">Project root</option>${folders.map(f => `<option value="${esc(f.path)}">${esc(f.path)}</option>`).join('')}</select></label>` : ''}
      ${upload ? '<label>File<input type="file" data-group-upload required></label>' : ''}
      ${!upload && !deleting ? `<label>Name<input type="text" data-group-path value="${esc(file?.path.split('/').at(-1) || '')}" maxlength="120" required></label>` : ''}
      ${statusMarkup}<div class="modal-actions"><button class="btn run" type="submit">${deleting ? 'Delete' : 'Save'}</button></div></form>`);
    const form = m.root.querySelector('form');
    const parent = form.querySelector('[data-group-parent]');
    if (parent && file) parent.value = file.path.split('/').slice(0,-1).join('/');
    form.onsubmit = event => {
      event.preventDefault();
      run(m,form.querySelector('button[type=submit]'),async () => {
        const blob = form.querySelector('[data-group-upload]')?.files[0];
        const name = blob?.name || form.querySelector('[data-group-path]')?.value.trim() || '';
        if (name.includes('/') || name.includes('\\')) throw new Error('Enter a name and choose its folder.');
        const path = action === 'replace' ? file.path : [parent?.value, name].filter(Boolean).join('/');
        let data = {action,path, ...(file ? {fileId:file.id, revision:file.revision} : {})};
        if (upload) {
          const multipart = new FormData();
          Object.entries({...data,classId:project.classId}).forEach(([key,value]) => multipart.append(key,value));
          multipart.append('file',blob);
          data = multipart;
        }
        await request(route(project.id), {method:'POST',data});
        m.close(); reload(); core.refresh();
      });
    };
  }

  function contributionControls(container, contribution, paint, teacher = true, authors = contribution?.authors || []) {
    if (!authors.length) return;
    const row = document.createElement('div');
    row.className = 'group-review-contributions';
    row.innerHTML = `<strong>Contributors</strong>${memberChips(authors)}
      ${teacher && contribution?.spans?.length ? '<label><input type="checkbox"> Highlight contributions</label>' : ''}`;
    container.append(row);
    const input = row.querySelector('input');
    if (!input) return;
    try {input.checked = localStorage.getItem('eagleide-group-review-colors') === '1';} catch {}
    const update = () => {
      try {localStorage.setItem('eagleide-group-review-colors', input.checked ? '1' : '0');} catch {}
      paint(input.checked);
    };
    input.onchange = update;
    update();
  }

  function highlight(content, contribution, pasted = []) {
    const authors = new Map((contribution?.authors || []).map(person => [person.id, person]));
    const marks = (contribution?.spans || []).filter(([from,to,id]) => authors.has(id) && from >= 0 && to > from && to <= content.length);
    let offset = 0, a = 0, b = 0, html = '';
    while (offset < content.length && (a < marks.length || b < pasted.length)) {
      const mark = marks[a], paste = pasted[b];
      if (mark && mark[1] <= offset) {a++; continue;}
      if (paste && (paste[1] <= offset || paste[1] > content.length || paste[0] >= paste[1])) {b++; continue;}
      const person = mark?.[0] <= offset ? authors.get(mark[2]) : null;
      const isPaste = paste?.[0] <= offset;
      const end = Math.min(person ? mark[1] : mark?.[0] ?? content.length,
        isPaste ? paste[1] : paste?.[0] ?? content.length);
      const segment = esc(content.slice(offset,end));
      html += person || isPaste ? `<mark class="${person ? 'group-contribution ' + classColor(person.color) : ''} ${isPaste ? 'assignment-pasted-text' : ''}"${person ? ` title="${esc(person.name)}"` : ''}>${segment}</mark>` : segment;
      offset = end;
    }
    return html + esc(content.slice(offset));
  }

  function teacherDashboard(cls, saved) {
    const current = cls.settings?.group_project_schedule || {enabled:false, days:[0,1,2,3,4], start:'08:00', end:'15:00', timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'};
    const m = studentModal(`${cls.name} · Group Projects`, `<form class="group-form group-settings">
      <label class="group-check"><input type="checkbox" name="enabled" ${cls.settings?.group_projects_enabled ? 'checked' : ''}><span><strong>Enable group projects</strong><small>Let students share and edit project files with classmates.</small></span></label>
      <label class="group-check"><input type="checkbox" name="scheduled" ${current.enabled ? 'checked' : ''}><span><strong>Only during class</strong><small>Pause student access outside the scheduled days and times.</small></span></label>
      <fieldset data-group-schedule><legend>Class schedule</legend><div class="group-days">${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map((day,i) =>
        `<label><input type="checkbox" name="day" value="${i}" ${current.days.includes(i) ? 'checked' : ''}>${day}</label>`).join('')}</div>
        <div class="group-schedule-fields"><label>Start<input type="time" name="start" value="${esc(current.start)}" required></label>
        <label>End<input type="time" name="end" value="${esc(current.end)}" required></label>
        <label>Time zone<input name="zone" value="${esc(current.timeZone)}" required maxlength="80"></label></div></fieldset>
      <div class="group-actions"><button type="submit" class="btn run">Save group settings</button></div>${statusMarkup}</form>
      <div class="group-project-heading"><div><h4>Active projects</h4><p class="group-muted">Includes projects with nobody currently editing.</p></div>
      ${button('refresh','Refresh')}</div><div class="group-teacher-list" data-group-teacher-list>Loading projects…</div>`, 'group-browser-modal');
    const options = {teacher:true,params:{classId:cls.id}};
    const list = m.root.querySelector('[data-group-teacher-list]');
    const form = m.root.querySelector('form');
    const schedule = form.querySelector('[data-group-schedule]');
    const syncForm = () => {schedule.hidden = !form.scheduled.checked; schedule.disabled = !form.scheduled.checked;};
    form.scheduled.onchange = syncForm; syncForm();
    let signature = '', loading = false;
    async function load() {
      if (loading || !m.root.isConnected) return;
      loading = true;
      try {
        const {projects} = await request('/api/teacher/group-projects', options);
        if (!m.root.isConnected) return;
        const next = JSON.stringify(projects.map(p => [p.id,p.name,p.members,p.openFiles]));
        if (next === signature) return;
        signature = next;
        list.innerHTML = projects.length ? projects.map(project => `<button class="group-teacher-project" type="button" data-group-teacher="${esc(project.id)}">
          <strong>${esc(project.name)}</strong><span>${esc(project.members.filter(p => p.state === 'active').map(p => p.name).join(', '))}</span>
          <small>${project.openFiles.length ? esc(project.openFiles.map(file => `${file.path} (${file.viewers.length} open)`).join(' · ')) : 'Idle'}</small>
        </button>`).join('') : '<p class="group-muted">No active group projects in this class.</p>';
        list.querySelectorAll('button').forEach(control => control.onclick = () => browseTeacher(cls, control.dataset.groupTeacher, load, m));
      } catch (error) {if (m.root.isConnected) {signature = ''; list.textContent = error.message;}}
      finally {loading = false;}
    }
    form.onsubmit = event => {
      event.preventDefault();
      const enabled = form.enabled.checked;
      if (cls.settings?.group_projects_enabled && !enabled &&
          !confirm('Turn off group projects and cancel every group in this class? Students can download the last saved copies for 30 days.')) return;
      run(m,form.querySelector('button'),async () => {
        const groupSchedule = form.scheduled.checked ? {enabled:true, days:[...form.querySelectorAll('[name=day]:checked')].map(el => Number(el.value)),
          start:form.start.value, end:form.end.value, timeZone:form.zone.value.trim()} : {...current,enabled:false};
        const result = await request('/api/teacher/classes/settings', {...options,method:'POST',data:{
          classId:cls.id,settings:{group_projects_enabled:enabled,group_project_schedule:groupSchedule},
        }});
        cls = result.classData;
        status(m,'Group project settings saved.');
        await saved(cls);
        await load();
      });
    };
    bind(m,'refresh',load);
    const timer = setInterval(() => {if (!document.hidden) load();}, 12000);
    m.cleanups.push(() => clearInterval(timer));
    load();
  }

  function browseTeacher(cls, projectId, reload, parent) {
    const url = '/api/teacher/group-projects/' + encodeURIComponent(projectId);
    const options = {teacher:true,params:{classId:cls.id}};
    const m = studentModal('Browse group project', '<div data-group-body>Loading files…</div>' + statusMarkup, 'group-browser-modal');
    const body = m.root.querySelector('[data-group-body]');
    let sequence = 0;
    async function load() {
      try {
        const {project} = await request(url, options);
        if (!m.root.isConnected) return;
        body.innerHTML = `<h4>${esc(project.name)}</h4><div class="group-teacher-members">${project.members.map(p =>
          `<div><span>${esc(p.name)}${p.state === 'active' ? (p.owner ? ' · Organizer' : '') : ' · ' + esc(p.state)}</span>
          <button type="button" class="btn secondary" data-group-member="${esc(p.id)}" data-group-state="${esc(p.state)}">${p.state === 'removed' ? 'Allow reinvite' : 'Remove'}</button></div>`).join('')}</div>
          <div class="group-teacher-browser"><div class="group-file-list">${fileRows(project.files,true)}</div>
          <section class="group-teacher-preview" data-group-preview aria-live="polite">Select a file to preview.</section></div>`;
        const preview = body.querySelector('[data-group-preview]');
        body.querySelectorAll('[data-group-open]').forEach(control => control.onclick = async () => {
          const fileId = control.dataset.groupOpen, current = ++sequence;
          preview.textContent = 'Loading file…';
          try {
            const {file} = await request(url,{...options,params:{...options.params,fileId}});
            if (!m.root.isConnected || current !== sequence || !preview.isConnected) return;
            preview.innerHTML = `<div class="group-project-heading"><strong>${esc(file.path)}</strong><div class="group-actions">
              ${file.kind === 'text' ? button('edit','Edit in IDE',true) : ''}${button('download','Download')}
              </div></div>`;
            preview.querySelector('[data-group-download]').onclick = () => request(url,{...options,params:{...options.params,fileId,download:'1'},blob:true})
              .then(blob => core.saveBlob(blob,file.path.split('/').at(-1))).catch(error => status(m,error.message));
            if (file.kind === 'text') {
              preview.querySelector('[data-group-edit]').onclick = event => run(m,event.currentTarget,async () => {
                const opened = await core.open(project, file, {
                  teacher:true, canOpen:() => m.root.isConnected && current === sequence && preview.isConnected,
                });
                if (!opened) return;
                m.close();
                parent.close();
                document.getElementById('teacherDashCloseBtn')?.click();
                window.WikiReader?.showIDE(true);
                window.eagleEditor?.focus();
              });
              const code = document.createElement('pre');
              code.className = 'assignment-file-source';
              code.textContent = file.content;
              contributionControls(preview, file.contribution, enabled => {code.innerHTML = highlight(file.content, enabled ? file.contribution : null);});
              preview.append(code);
            } else preview.insertAdjacentHTML('beforeend','<p class="group-muted">Download this asset to view it.</p>');
          } catch (error) {if (current === sequence) preview.textContent = error.message;}
        });
        body.querySelectorAll('[data-group-member]').forEach(control => control.onclick = () => {
          const reinstate = control.dataset.groupState === 'removed';
          if (!reinstate && !confirm('Remove this student from the project and revoke their access?')) return;
          run(m,control,async () => {
            await request(url,{...options,method:'POST',data:{action:reinstate ? 'reinstate' : 'remove',memberId:control.dataset.groupMember}});
            reload(); load();
          });
        });
      } catch (error) {body.textContent = error.message;}
    }
    load();
  }

  function canSubmit(assignment) {
    return core.canShare() && assignment.targetClassId === core.context().currentStudentClassId &&
      !assignment.fileControl && assignment.assignmentType !== 'lab_report';
  }

  function assignmentDialog(assignment, reload) {
    const m = studentModal(`Turn in group work · ${assignment.name}`, `<p>Choose a shared project and the saved files to turn in.</p>
      <label class="group-form">Project<select data-group-project-choice></select></label><div data-group-submit-files></div>
      ${statusMarkup}${actions(button('turn-in','Turn in files',true))}`);
    const select = m.root.querySelector('[data-group-project-choice]');
    const files = m.root.querySelector('[data-group-submit-files]');
    const turnIn = m.root.querySelector('[data-group-turn-in]');
    turnIn.disabled = true;
    let project, sequence = 0, submissionKey = null, submitting = false;
    m.beforeClose = () => !submitting;
    async function load(preselected = []) {
      const current = ++sequence;
      project = null; submissionKey = null; turnIn.disabled = true;
      files.textContent = 'Loading project files…';
      try {
        if (!select.value) {files.textContent = 'Choose a project.'; return;}
        if (core.currentProject()?.id === select.value && !await core.flush()) throw new Error('Save the current shared draft before submitting.');
        const data = await request(route(select.value));
        if (current !== sequence || !m.root.isConnected) return;
        project = data.project;
        const selectable = project.files.filter(file => !file.folder);
        const multi = assignment.allowMultiFileSubmission;
        const openId = core.context().getCurrentFile?.()?.groupFileId;
        const selected = new Set(preselected.length ? preselected : [selectable.find(file => file.id === openId)?.id || selectable[0]?.id]);
        files.innerHTML = `<div class="group-choices">${selectable.map(file => `<label>
          <input type="${multi ? 'checkbox' : 'radio'}" name="groupFileSelection" value="${esc(file.id)}" ${selected.has(file.id) ? 'checked' : ''}>
          <span>${esc(file.path)}</span><small>${Math.ceil(file.size / 1024)} KB</small></label>`).join('') || '<p>No files to turn in.</p>'}</div>
          <fieldset class="group-submit-options"><legend>Who gets credit?</legend>
          <label><input type="radio" name="groupTurnInMode" value="self" checked> Submit for myself</label>
          <label><input type="radio" name="groupTurnInMode" value="group" ${assignment.allowGroupSubmission && project.members.length >= 2 ? '' : 'disabled'}> Submit for group</label>
          <p class="group-muted">${!assignment.allowGroupSubmission ? 'This assignment accepts individual turn-in.' : project.members.length < 2 ? 'Invite a classmate and have them join to submit as a group.' : 'Group credit goes to ' + esc(project.members.map(person => person.name).join(', ')) + '.'}</p>
          </fieldset>`;
        turnIn.disabled = !selectable.length;
      } catch (error) {if (current === sequence) files.textContent = error.message;}
    }
    files.onchange = () => {submissionKey = null;};
    select.onchange = () => {status(m,''); load();};
    turnIn.onclick = async () => {
      const selected = [...files.querySelectorAll('[name=groupFileSelection]:checked')].map(input => input.value);
      const mode = files.querySelector('[name=groupTurnInMode]:checked')?.value;
      if (!project || !selected.length) return status(m,'Choose at least one file.');
      if (selected.length > 20) return status(m,'Choose at most 20 files.');
      submissionKey ||= Date.now().toString(36) + '-' + crypto.getRandomValues(new Uint32Array(2)).join('-');
      submitting = turnIn.disabled = true;
      status(m, 'Turning in saved files…');
      const fields = [...m.root.querySelectorAll('input,select')];
      const disabled = fields.map(field => field.disabled);
      fields.forEach(field => {field.disabled = true;});
      try {
        const data = await request('/api/assignments/submit', {method:'POST', data:{
          assignmentId:assignment.id, classId:assignment.targetClassId, submissionKey,
          groupSelection:{projectId:project.id,mode,recipients:project.members.map(p => p.id).sort(),
            files:project.files.filter(f => selected.includes(f.id)).map(f => ({id:f.id,revision:f.revision}))},
        }});
        if (!m.root.isConnected) return;
        submitting = false;
        select.closest('label').hidden = true;
        files.innerHTML = `<h4>Files turned in</h4><p>${esc((data.submission.groupRecipients || []).join(', '))}</p>
          <ul>${data.receipt.files.map(f => `<li>${esc(f.name)}</li>`).join('')}</ul>`;
        status(m, ''); turnIn.textContent = 'Done'; turnIn.onclick = m.close;
        await reload();
      } catch (error) {
        status(m,error.message);
        if (error.status === 409 && /changed/.test(error.message)) await load(selected);
      } finally {
        submitting = false;
        turnIn.disabled = !project;
        fields.forEach((field,i) => {field.disabled = disabled[i];});
      }
    };
    (async () => {
      await core.refresh();
      if (!m.root.isConnected) return;
      const projects = core.list().filter(p => p.status === 'active' && p.membership === 'active');
      select.innerHTML = projects.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
      if (core.currentProject()) select.value = core.currentProject().id;
      if (!projects.length) files.textContent = core.available().reason || 'Create or join a group project in Files first.';
      else load();
    })();
  }

  core.subscribe(renderPanel);
  let scope = '';
  window.addEventListener('eagle-context-updated', () => {
    const c = core.context();
    const next = JSON.stringify([c.USER_TOKEN, c.currentStudentClassId, c.TEACHER_TOKEN, c.currentTeacherClassId]);
    if (next !== scope) {
      scope = next;
      for (const m of dialogs) {m.beforeClose = null; m.close();}
    }
  });
  window.GroupProjectUI = {addCtxMenu, teacherDashboard, canSubmit, assignmentDialog, contributionControls, highlight};
})();
