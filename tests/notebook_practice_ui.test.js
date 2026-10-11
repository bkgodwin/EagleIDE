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

test('notebook input tokens are recognized across every output chunk boundary', () => {
  const token = '[[_IDE_INPUT_]]';
  for (let split = 1; split < token.length; split++) {
    const out = { lastChild: null, scrollTop: 0, scrollHeight: 0, appendChild(node) { this.lastChild = node; } };
    const textNode = value => ({ nodeType: 3, data: value, get length() { return this.data.length; }, appendData(value) { this.data += value; } });
    const context = { Node: { TEXT_NODE: 3 }, document: { createTextNode: textNode }, setTimeout() {},
      shell: { querySelector(selector) { return selector === '.notebook-shell-output' ? out : null; } } };
    vm.runInNewContext(`const INPUT_TOKEN='${token}', MAX_INLINE_OUTPUT_CHARS=120000;
      let outputRemainder='', waitingForNotebookInput=false;
      function ctx() { return {showSystemShellMessages:true}; } function updateNotebookRunButtons() {}
      ${functionSource('function appendNotebookOutput(', 'function updateNotebookRunButtons(')}
      globalThis.feed = text => appendNotebookOutput(shell, text); globalThis.waiting = () => waitingForNotebookInput;`, context);
    context.feed('Name: ' + token.slice(0, split)); assert.equal(context.waiting(), false);
    context.feed(token.slice(split)); assert.equal(context.waiting(), true);
    assert.equal(out.lastChild.data, 'Name: ');
  }
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
  const context = { clearTimeout() {}, document:{getElementById(){return null;}}, updateEntryPoints() {}, hideAllCodeBlockShells() {},
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
    renderTabRail(){},activeTab(){return {id:'notes'};},updateNotebookToolbarMode(){},renderEditablePage(){},bindCodeBlockActions(){},highlightCodeBlocks(){},
    getCodeBlockText(){return 'name = input()';},tabIsReadOnly(){return false;},live};
  vm.runInNewContext(`let notebook={},runningCodeBlock=live,readOnlyCheck=false; const ASSIGNMENTS_TAB_ID='assignments';
    ${functionSource('function renderNotebook(', 'function updateNotebookToolbarMode(')} renderNotebook();`,context);
  assert.equal(replacement, live);
});
