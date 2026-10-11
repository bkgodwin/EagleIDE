const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'static/js/student-notebook.js'), 'utf8');
const sync = fs.readFileSync(path.join(root, 'static/js/notebook-sync.js'), 'utf8');
function merger() { const context = { window: {} }; vm.runInNewContext(sync, context); return context.window.NotebookSync; }
const clone = value => JSON.parse(JSON.stringify(value));
const initial = () => ({ revision: 1, activeTabId: 'notes', tabs: [
  { id: 'notes', label: 'Notes', html: '<p>Original</p>' },
  { id: 'second', label: 'Second', html: '<p>Another page</p>' },
  { id: 'assignments', blocks: [{ promptId: 'one', responseHtml: '<p>Original attempt</p>', notesMarkdown: 'Original notes', practice: { status: 'queued' } }] }
] });

test('different page edits merge and same-page conflicts preserve both copies', () => {
  const base = initial(), local = clone(base), remote = clone(base);
  local.tabs[0].html = '<p>Local edit</p>'; remote.tabs[1].html = '<p>Remote edit</p>'; remote.revision = 2;
  let result = merger().merge(base, local, remote);
  assert.equal(result.recovered, 0); assert.equal(result.notebook.revision, 2);
  assert.equal(result.notebook.tabs[0].html, '<p>Local edit</p>'); assert.equal(result.notebook.tabs[1].html, '<p>Remote edit</p>');
  remote.tabs[0].html = '<p>Remote conflict</p>';
  result = merger().merge(base, local, remote);
  assert.equal(result.recovered, 1); assert.equal(result.notebook.tabs[0].html, '<p>Remote conflict</p>');
  assert.match(result.notebook.tabs.find(t => t.label === 'Recovered notes').html, /Local edit/);
});

test('incoming AI feedback preserves student notes, new tabs, and prompt removals', () => {
  const base = initial(), local = clone(base), remote = clone(base);
  local.tabs[2].blocks[0].notesMarkdown = 'My explanation'; local.tabs[2].blocks[0].notesEdited = true;
  remote.tabs[2].blocks[0].practice = { status: 'complete', feedback: 'Good attempt' };
  let result = merger().merge(base, local, remote);
  assert.equal(result.notebook.tabs[2].blocks[0].notesMarkdown, 'My explanation');
  assert.equal(result.notebook.tabs[2].blocks[0].practice.feedback, 'Good attempt');
  local.tabs[2].blocks[0].responseHtml = '<p>Unsaved attempt</p>';
  remote.tabs[2].blocks = [];
  result = merger().merge(base, local, remote);
  assert.equal(result.recovered, 1); assert.match(result.notebook.tabs.find(t => t.label === 'Recovered notes').html, /Unsaved attempt/);
});

test('conflicting Markdown notes are preserved in a recovery page', () => {
  const base = initial(), local = clone(base), remote = clone(base);
  local.tabs[2].blocks[0].notesMarkdown = 'Local notes'; remote.tabs[2].blocks[0].notesMarkdown = 'Remote notes';
  const result = merger().merge(base, local, remote);
  assert.equal(result.recovered, 1); assert.match(result.notebook.tabs.find(t => t.label === 'Recovered notes').html, /Local notes/);
});

test('a notebook at its tab limit keeps its local draft instead of dropping conflicts', () => {
  const base = initial(); while (base.tabs.length < 80) base.tabs.unshift({ id: `tab${base.tabs.length}`, html: 'old' });
  const local = clone(base), remote = clone(base); local.tabs[0].html = 'local'; remote.tabs[0].html = 'remote';
  assert.throws(() => merger().merge(base, local, remote), /Export your local draft/);
});

function functionSource(name, next) { return source.slice(source.indexOf(`  ${name}`), source.indexOf(`  ${next}`, source.indexOf(`  ${name}`))); }

test('topic notes edit button opens Markdown, saves additions, and returns to the rendered notes', () => {
  const block = {promptId:'one',notesMarkdown:'### Loops\nRepeat a task.',responseType:'code',practice:{notes:'### Loops\nRepeat a task.'}};
  const handlers = {}, attrs = {};
  const textarea = {hidden:true,value:block.notesMarkdown,focus(){this.focused=true;},addEventListener(type,fn){handlers.input=fn;}};
  const rendered = {hidden:false,addEventListener(type,fn){handlers.rendered=fn;}};
  const edit = {addEventListener(type,fn){handlers.edit=fn;},setAttribute(key,value){attrs[key]=value;}};
  const hint = {hidden:true}; let locked=false,saves=0,renders=0;
  const body = {querySelector(selector){return ({'.student-notebook-prompt-response':{addEventListener(){}},'[data-notes-source]':textarea,'[data-topic-notes]':rendered,'[data-edit-notes]':edit,'[data-notes-hint]':hint})[selector] || null;}};
  const context = {body,block,assignmentBodyHtml(){return '';},isAssignmentResponseLocked(){return false;},tabIsReadOnly(){return locked;},assignmentsTab(){return {blocks:[block]};},
    renderNotes(){renders++;},bindCodeBlockActions(){},highlightCodeBlocks(){},scheduleSave(){saves++;}};
  vm.runInNewContext(`${functionSource('function mountPracticeBody(', 'async function submitPractice(')} mountPracticeBody(body,block);`,context);
  handlers.edit();
  assert.equal(textarea.hidden,false);assert.equal(rendered.hidden,true);assert.equal(textarea.focused,true);assert.equal(hint.hidden,false);
  assert.equal(attrs['aria-pressed'],'true');assert.equal(edit.textContent,'✓ Done editing');
  textarea.value+='\nMy reminder';handlers.input();
  assert.match(block.notesMarkdown,/My reminder/);assert.equal(block.notesEdited,true);assert.equal(saves,1);
  handlers.edit();
  assert.equal(textarea.hidden,true);assert.equal(rendered.hidden,false);assert.equal(hint.hidden,true);
  assert.equal(attrs['aria-pressed'],'false');assert.equal(edit.textContent,'✎ Edit / add notes');assert.equal(renders,2);
  locked=true;handlers.edit();assert.equal(textarea.hidden,true);
});

test('practice cards keep code feedback separate from concept notes and omit editing for notebook checks', () => {
  let readOnly=false;
  const context = {Date,escapeHtml:value=>String(value || '').replaceAll('<','&lt;'),sanitizeHtml:value=>value,
    isAssignmentResponseLocked(){return readOnly;},tabIsReadOnly(){return readOnly;},ctx(){return {USER_TOKEN:'student'};},assignmentResponseHtml(){return '';}};
  vm.runInNewContext(`let readOnlyCheck=false; ${functionSource('function assignmentGradeHtml(', 'function renderNotes(')}
    ${functionSource('function assignmentBodyHtml(', 'function renderAssignmentsPage(')} globalThis.card=assignmentBodyHtml;globalThis.checkView=()=>{readOnlyCheck=true;};`,context);
  const block={prompt:'Use a loop',notesMarkdown:'### Iteration',responseType:'code',practice:{submittedAt:1,summary:'Keep going',feedback:'Check the loop bounds.',notes:'### Iteration'}};
  let html=context.card(block);
  assert.match(html,/Feedback on code quality and assignment requirements/);assert.match(html,/Check the loop bounds/);
  assert.match(html,/Topic notes/);assert.match(html,/student-notebook-notes-edit/);assert.match(html,/aria-pressed="false"/);
  assert.ok(html.indexOf('data-practice-feedback') < html.indexOf('student-notebook-topic-notes'));
  readOnly=true;context.checkView();html=context.card(block);assert.doesNotMatch(html,/data-edit-notes|data-practice-submit/);assert.match(html,/data-topic-notes/);
});

test('admin settings save independent notebook and general AI choices', async () => {
  const core=fs.readFileSync(path.join(root,'static/js/app-core.js'),'utf8');
  const start=core.indexOf("    document.getElementById('settingsSaveBtn').addEventListener");
  const end=core.indexOf('    // ---- Admin Users Management ----',start);
  for (const notebookEnabled of [false,true]) {
    let handler,saved;
    const fields=new Map();
    const document={getElementById(id){if (!fields.has(id)) fields.set(id,{value:'30',checked:false,addEventListener(type,fn){handler=fn;}});return fields.get(id);}};
    document.getElementById('aiEnabledModal').checked=!notebookEnabled;
    document.getElementById('aiNotebookFeedbackEnabledModal').checked=notebookEnabled;
    const context={document,ADMIN_TOKEN:'admin',currentConfig:{},collectPythonModuleAccess(){return {};},
      async saveConfig(config){saved=config;return {ok:true};},async fetch(){return {json:async()=>({ok:true})};},applyConfig(){},loadPythonRuntimeAdmin(){}};
    vm.runInNewContext(core.slice(start,end),context);
    await handler();
    assert.equal(saved.ai_notebook_feedback_enabled,notebookEnabled);assert.equal(saved.ai_explainer_enabled,!notebookEnabled);
    assert.equal(fields.get('adminSettingsStatus').textContent,'Settings saved.');
  }
});

test('notebook input tokens are recognized across every output chunk boundary', () => {
  const token = '[[_IDE_INPUT_]]';
  for (let split = 1; split < token.length; split++) {
    const out = { lastChild: null, scrollTop: 0, scrollHeight: 0, appendChild(node) { this.lastChild = node; } };
    const textNode = value => ({ nodeType: 3, data: value, get length() { return this.data.length; }, appendData(value) { this.data += value; } });
    const context = { Node: { TEXT_NODE: 3 }, document: { createTextNode: textNode }, setTimeout() {},
      shell: { querySelector(selector) { return selector === '.notebook-shell-output' ? out : null; } } };
    vm.runInNewContext(`const INPUT_TOKEN='${token}', MAX_INLINE_OUTPUT_CHARS=120000;
      let outputRemainder='', waitingForNotebookInput=false, inputMarkerNewline=false;
      function ctx() { return {showSystemShellMessages:true}; } function updateNotebookRunButtons() {}
      ${functionSource('function appendNotebookOutput(', 'function updateNotebookRunButtons(')}
      globalThis.feed = text => appendNotebookOutput(shell, text); globalThis.waiting = () => waitingForNotebookInput;`, context);
    context.feed('Name: ' + token.slice(0, split)); assert.equal(context.waiting(), false);
    context.feed(token.slice(split)); assert.equal(context.waiting(), true);
    assert.equal(out.lastChild.data, 'Name: ');
  }
});

test('worker input marker newlines are hidden and its single echo stays beside the prompt', () => {
  const token = '[[_IDE_INPUT_]]';
  for (const stream of [`Name: ${token}\nJoe\nHello, Joe!\n`, `Name: ${token}\r\nJoe\nHello, Joe!\n`]) {
    // Every possible two-chunk boundary, then one-character delivery.
    for (const chunks of [...Array.from({length:stream.length - 1}, (_,index) => [stream.slice(0,index+1),stream.slice(index+1)]), Array.from(stream)]) {
      const out = {lastChild:null,appendChild(node){this.lastChild=node;}};
      const context = {Node:{TEXT_NODE:3},document:{createTextNode(data){return {nodeType:3,data,get length(){return this.data.length;},appendData(text){this.data+=text;}};}}, setTimeout(){},
        shell:{querySelector(){return out;}}};
      vm.runInNewContext(`const INPUT_TOKEN='${token}', MAX_INLINE_OUTPUT_CHARS=120000; let outputRemainder='', inputMarkerNewline=false, waitingForNotebookInput=false;
        function ctx(){return {showSystemShellMessages:true};} function updateNotebookRunButtons(){}
        ${functionSource('function appendNotebookOutput(', 'function updateNotebookRunButtons(')} globalThis.feed=text=>appendNotebookOutput(shell,text);`,context);
      chunks.forEach(context.feed);
      assert.equal(out.lastChild.data,'Name: Joe\nHello, Joe!\n');
    }
  }
});

test('sending notebook stdin does not add a second browser echo', () => {
  let handler, appended=0, sent='';
  const input = {value:'Joe'};
  const block = {querySelector(selector){return selector.includes('send-input') ? {addEventListener(type,fn){handler=fn;}} : input;}};
  const start = source.indexOf("      block.querySelector('[data-code-action=\"send-input\"]')?.addEventListener");
  const end = source.indexOf("      block.querySelector('.notebook-shell-input input')?.addEventListener",start);
  const context={block,ctx(){return {activeRunSource:'notebook',isProgramRunning:true,sendNotebookInput(value){sent=value;return true;}};},appendNotebookOutput(){appended++;},updateNotebookRunButtons(){}};
  vm.runInNewContext(`let runningCodeBlock=block, waitingForNotebookInput=true; ${source.slice(start,end)}`,context);
  handler({preventDefault(){},stopPropagation(){}});
  assert.equal(sent,'Joe');assert.equal(appended,0);assert.equal(input.value,'');
});

test('tab padlock persists the buffer before locking and can unlock assignment tabs', () => {
  const tab = { id: 'assignments', editLocked: false };
  let persisted = 0, saves = 0;
  const context = { tab, persistActivePageFromDom() { persisted++; }, scheduleSave() { saves++; }, renderNotebook() {}, hideAllCodeBlockShells() {} };
  vm.runInNewContext(`let readOnlyCheck=false; function activeTab() { return tab; }
    ${functionSource('function toggleTabLock(', 'function exportLocalDraft(')} globalThis.toggle=toggleTabLock;`, context);
  context.toggle(); assert.equal(tab.editLocked, true); context.toggle(); assert.equal(tab.editLocked, false);
  assert.equal(persisted, 2); assert.equal(saves, 2);
});

test('notebook run claims the shared execution state synchronously before emitting', () => {
  const core = fs.readFileSync(path.join(root, 'static/js/app-core.js'), 'utf8');
  const snippet = core.slice(core.indexOf('    function runNotebookCode('), core.indexOf('    function sendNotebookInput('));
  const requests = [];
  const context = { socket: { emit(type, data) { requests.push({ type, data }); } } };
  vm.runInNewContext(`let isProgramRunning=false, notebookRunHandlers=null, USER_TOKEN='student', TEACHER_TOKEN='', ADMIN_TOKEN='';
    function canExecuteCode() { return true; } function setRunButtonState(value) { isProgramRunning=value; }
    function isCoTeacher() { return false; } function getCurrentClassContext() { return {id:'class'}; }
    ${snippet} globalThis.run=runNotebookCode;`, context);
  assert.equal(context.run({ code: 'print(1)' }), true); assert.equal(context.run({ code: 'print(2)' }), false);
  assert.equal(requests.length, 1);
});

test('class changes preserve the old draft and invalidate in-flight loads', () => {
  const backups = [];
  const context = { window:{}, clearTimeout() {}, document:{getElementById(){return null;}}, updateEntryPoints() {}, hideAllCodeBlockShells() {},
    persistActivePageFromDom() {}, storeDraft() { backups.push(context.state()); }, loadNotebook() { return Promise.resolve(); } };
  vm.runInNewContext(`let notebook={tabs:[{html:'Unsaved work'}]}, baseNotebook={}, loadedClassId='old-class', loadedOwner='old-user', dirty=true,
    readOnlyCheck=false, drawerOpen=false, loadSequence=1, checkSequence=1, saveTimer=null, feedbackTimer=null, expandedPromptId='one', recoveryCount=0, localBackupOk=true;
    function currentClassId() { return 'new-class'; } function ownerKey() { return 'new-user'; } function isStudentInClass() { return true; }
    ${functionSource('function onAuthChanged(', 'function bindUi(')}
    globalThis.state = () => ({notebook, loadedClassId, loadedOwner, dirty, loadSequence}); globalThis.change=onAuthChanged;`, context);
  context.change();
  assert.equal(backups.length, 1); assert.equal(backups[0].loadedClassId, 'old-class'); assert.equal(backups[0].notebook.tabs[0].html, 'Unsaved work');
  assert.equal(context.state().notebook, null); assert.equal(context.state().loadSequence, 2);
});

test('a late notebook load cannot replace a newer account or class', async () => {
  let resolve;
  const context = { window: {}, localStorage: { getItem() { return null; } }, fetch() { return new Promise(done => { resolve = done; }); },
    setStatus() {}, userHeaders() { return {}; }, console };
  vm.runInNewContext(`let notebook=null, dirty=false, readOnlyCheck=false, baseNotebook=null, loadedClassId=null, loadedOwner='', activeClassId=null, loadSequence=0;
    let classId='old', owner='old-user'; function currentClassId() { return classId; } function ownerKey() { return owner; } function isStudentInClass() { return true; }
    ${functionSource('async function loadNotebook(', 'async function saveNotebook(')}
    globalThis.load=loadNotebook; globalThis.change=() => {classId='new'; owner='new-user'; loadSequence++;}; globalThis.value=() => notebook;`, context);
  const loading = context.load(); context.change();
  resolve({json: async () => ({ok:true, notebook:{tabs:[{html:'Wrong account'}]}})});
  assert.equal(await loading, null); assert.equal(context.value(), null);
});

test('resize supports pointer capture, keyboard bounds, and avoids storage writes while dragging', () => {
  let width = 860, writes = 0;
  const properties = {}, events = {}, attrs = {};
  const handle = { addEventListener(name, fn) { events[name] = fn; }, setAttribute(name, value) { attrs[name] = value; }, setPointerCapture() { this.captured=true; }, hasPointerCapture() { return this.captured; }, releasePointerCapture() { this.captured=false; } };
  const drawer = {getBoundingClientRect() {return {width};}};
  const context = {window:{innerWidth:1024, visualViewport:{width:700}}, localStorage:{getItem() {return null;},setItem() {writes++;}},
    document:{getElementById(id) {return id === 'studentNotebookResizeHandle' ? handle : drawer;}, querySelectorAll() {return [];},
      documentElement:{style:{setProperty(name,value) {properties[name]=value; width=parseInt(value,10);}}}} };
  vm.runInNewContext(`${functionSource('function bindNotebookResize(', 'async function openStudentNotebook(')} bindNotebookResize();`, context);
  events.pointerdown({button:0, clientX:500, pointerId:1, preventDefault(){}});
  events.pointermove({clientX:1000, pointerId:1}); assert.equal(width, 360); assert.equal(writes, 0);
  events.pointerup({pointerId:1}); assert.equal(writes, 1);
  events.keydown({key:'End', preventDefault(){}}); assert.equal(width, 700); assert.equal(attrs['aria-valuemax'], '700');
  events.keydown({key:'Home', preventDefault(){}}); assert.equal(properties['--notebook-width'], '360px');
});

test('duplicate snapshot IDs cannot give another code block control of stdin', () => {
  function block() {
    const controls = { run:{}, open:{}, input:{}, send:{}, stop:{} };
    return { dataset:{codeId:'shared-snapshot',language:'python'}, controls,
      querySelector(selector) { return selector.includes('"run"') ? controls.run : selector.includes('"open"') ? controls.open : selector.includes('"stop"') ? controls.stop : null; },
      querySelectorAll() {return [controls.input,controls.send];} };
  }
  const active = block(), duplicate = block();
  const context = {window:{}, document:{querySelectorAll(){return [active,duplicate];}}, active,
    ctx(){return {isProgramRunning:true,activeRunSource:'notebook'};}, isRunnableLanguage(){return true;} };
  vm.runInNewContext(`const readOnlyCheck=false; let runningCodeBlock=active, waitingForNotebookInput=true;
    ${functionSource('function updateNotebookRunButtons(', 'function runCodeBlock(')} updateNotebookRunButtons();`, context);
  assert.equal(active.controls.input.disabled, false); assert.equal(duplicate.controls.input.disabled, true);
  assert.equal(duplicate.controls.stop.disabled, true); assert.equal(active.controls.run.disabled, true);
});

test('editing topic notes after an autosave targets the current notebook object', () => {
  let input;
  const old = {promptId:'one', notesMarkdown:'Old notes'};
  let current = {blocks:[old]};
  const textarea = {value:'First edit',addEventListener(type,handler){input=handler;}};
  const context = {source:textarea, block:old, assignmentsTab(){return current;},tabIsReadOnly(){return false;},scheduleSave(){}};
  const start = source.indexOf("    source.addEventListener('input', () => {");
  const end = source.indexOf('    bindCodeBlockActions();', start);
  vm.runInNewContext(source.slice(start,end), context);
  input(); assert.equal(current.blocks[0].notesMarkdown,'First edit');
  current = {blocks:[{promptId:'one',notesMarkdown:'First edit'}]};
  textarea.value='Second edit'; input();
  assert.equal(current.blocks[0].notesMarkdown,'Second edit'); assert.equal(current.blocks[0].notesEdited,true);
});

test('notebook redraws keep the live code block and its input/output handlers', () => {
  let replacement;
  const live = {dataset:{codeId:'one'}};
  const rendered = {dataset:{codeId:'one'},replaceWith(block){replacement=block;}};
  const page = {querySelectorAll(){return [rendered];}};
  const context = {document:{getElementById(id){return id === 'studentNotebookPage' ? page : null;}}, ctx(){return {isProgramRunning:true,activeRunSource:'notebook'};},
    renderTabRail(){},activeTab(){return {id:'notes'};},updateNotebookToolbarMode(){},renderEditablePage(){},bindCodeBlockActions(){},hydrateNotebookPhotos(){},highlightCodeBlocks(){},
    getCodeBlockText(){return 'name = input()';},tabIsReadOnly(){return false;},live};
  vm.runInNewContext(`let notebook={},runningCodeBlock=live,readOnlyCheck=false; const ASSIGNMENTS_TAB_ID='assignments';
    ${functionSource('function renderNotebook(', 'function updateNotebookToolbarMode(')} renderNotebook();`,context);
  assert.equal(replacement, live);
});

test('feedback refresh settles queued state during editing or a run without replacing the editor',async()=>{
  for (const running of [false,true]) {
    const base=initial(),local=clone(base),remote=clone(base);local.tabs[2].blocks[0].responseHtml='<p>Unsaved attempt</p>';
    local.tabs[2].blocks[0].notesMarkdown='My draft notes';local.tabs[2].blocks[0].notesEdited=true;
    remote.tabs[2].blocks[0].practice={status:'failed',error:'Retry now'};remote.revision=2;
    let redraws=0,updates=0,saves=0;
    const context={window:{NotebookSync:merger()},base,local,remote,
      fetch:async()=>({json:async()=>({ok:true,notebook:remote})}),userHeaders(){return {};},ctx(){return {isProgramRunning:running};},
      currentClassId(){return 'class';},ownerKey(){return 'owner';},isStudentInClass(){return true;},
      document:{activeElement:{closest(){return running ? null : {};}}},persistActivePageFromDom(){},
      ensureNotebookShape:value=>value,cloneNotebook:clone,storeDraft(){},scheduleSave(){saves++;},renderNotebook(){redraws++;},updatePracticeFeedback(){updates++;},activeTab(){return {id:'assignments'};},console};
    vm.runInNewContext(`let notebook=local,baseNotebook=base,drawerOpen=true,readOnlyCheck=false,refreshPending=null,loadedClassId='class',loadedOwner='owner',dirty=true,recoveryCount=0;
      const ASSIGNMENTS_TAB_ID='assignments';${functionSource('async function refreshAssignmentsFromServer(', 'function updatePracticeFeedback(')}
      globalThis.refresh=refreshAssignmentsFromServer;globalThis.value=()=>notebook;`,context);
    await context.refresh();
    const block=context.value().tabs.find(tab=>tab.id === 'assignments').blocks[0];
    assert.equal(block.practice.status,'failed');assert.equal(block.notesMarkdown,'My draft notes');assert.match(block.responseHtml,/Unsaved/);
    assert.equal(redraws,0);assert.equal(updates,1);assert.equal(saves,1);
  }
});

test('failed feedback enables retry controls immediately without changing its timestamp',()=>{
  const button={},status={},badge={};const block={promptId:'one',practice:{status:'failed',submittedAt:Date.now()/1000}};
  const card={dataset:{promptId:'one'},querySelector(selector){return selector.includes('badges') ? badge : selector.includes('submit') ? button : status;}};
  const context={document:{querySelectorAll(){return [card];}},assignmentsTab(){return {blocks:[block]};},isAssignmentResponseLocked(){return false;}};
  vm.runInNewContext(`${functionSource('function updatePracticeFeedback(', 'function updateFeedbackPolling(')} updatePracticeFeedback({content:false});`,context);
  assert.equal(button.disabled,false);assert.match(status.textContent,/submit again/);assert.equal(badge.textContent,'failed');
});
