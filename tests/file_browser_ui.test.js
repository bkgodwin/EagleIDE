// Exercise production classic-script helpers without a frontend framework.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../static/js/app-core.js'), 'utf8');
function extract(name) {
  const match = new RegExp('^    (?:async )?function ' + name + '\\(', 'm').exec(source);
  assert.ok(match, name);
  return source.slice(match.index, source.indexOf('\n    }', match.index) + 6);
}

test('renaming and deleting a parent updates open files, working directories, and selections', () => {
  vm.runInNewContext(`
    let currentOpenFile = {path:'unit/nested/main.py', name:'main.py'};
    let _currentFolderPath = 'unit/nested', _shellCwd = 'unit/nested';
    let _selectedFileItems = new Set(['unit', 'unit/nested/main.py', 'other.py']);
    let _autosaveTimer = null, csvAutosaveTimer = null, currentBufferDirty = true;
    let csvEditorActive = false;
    const clearFileArtifactPreview = () => {}, setCsvMode = () => {}, updateActiveFileName = () => {}, updateEditorOverlay = () => {};
    const editor = { setValue() {} };
    ${extract('_normalizeTreePath')}
    ${extract('applyFilePathChange')}
    applyFilePathChange('unit', 'renamed');
    assert.equal(currentOpenFile.path, 'renamed/nested/main.py');
    assert.equal(_shellCwd, 'renamed/nested');
    assert.ok(_selectedFileItems.has('renamed/nested/main.py'));
    applyFilePathChange('renamed', null);
    assert.equal(currentOpenFile, null);
    assert.equal(_currentFolderPath, '');
    assert.equal(_shellCwd, '');
    assert.deepEqual([..._selectedFileItems], ['other.py']);
    assert.equal(currentBufferDirty, false);
  `, { assert, clearTimeout });
});

test('file selection changes only through the explicit checkbox selection helper', () => {
  vm.runInNewContext(`
    let _selectedFileItems = new Set();
    ${extract('_normalizeTreePath')}
    ${extract('setFileItemSelected')}
    assert.equal(setFileItemSelected('unit/main.py', true), true);
    assert.deepEqual([..._selectedFileItems], ['unit/main.py']);
    assert.equal(setFileItemSelected('unit/main.py', false), false);
    assert.equal(_selectedFileItems.size, 0);
    assert.equal(setFileItemSelected('Trash', true), false);
    assert.equal(_selectedFileItems.size, 0);
  `, { assert });
  const rowClick = source.slice(source.indexOf("row.addEventListener('click'"), source.indexOf("row.addEventListener('keydown'"));
  assert.doesNotMatch(rowClick, /_selectedFileItems\.add|setFileItemSelected/);
});

test('autosave does not mark new edits clean when an older request completes', async () => {
  const context = vm.createContext({ assert, window: {} });
  await vm.runInContext(`(async () => {
    let auditPreviewActive = false, fileArtifactPreviewActive = false, csvEditorActive = false;
    let currentOpenFile = {path:'main.py', name:'main.py'}, currentBufferDirty = true;
    let USER_TOKEN = 'student', TEACHER_TOKEN = null, ADMIN_TOKEN = null;
    let text = 'old text', release;
    let fileSavePromise = null;
    const editor = {getValue: () => text};
    const syncEditorBridge = () => {};
    const fileAuthHeaders = () => ({'X-User-Token':USER_TOKEN});
    const fileJsonHeaders = fileAuthHeaders;
    const fetch = (url, options) => {
      assert.equal(JSON.parse(options.body).require_existing, true);
      return new Promise(resolve => { release = resolve; });
    };
    ${extract('fetchWithDeadline')}
    ${extract('saveCurrentFile')}
    ${extract('writeCurrentFile')}
    const saving = saveCurrentFile();
    text = 'new edit';
    release({ok:true, json:async () => ({ok:true})});
    assert.equal(await saving, true);
    assert.equal(currentBufferDirty, true);
  })()`, context);
});

test('late file-list authentication failures cannot sign out a newer session', async () => {
  await vm.runInNewContext(`(async () => {
    let USER_TOKEN = 'old', TEACHER_TOKEN = null, ADMIN_TOKEN = null, release;
    const fileAuthHeaders = () => ({'X-User-Token': USER_TOKEN});
    const canCurrentUserAccessIDE = () => true;
    const clearAuthStateMemory = () => { throw new Error('must not clear newer session'); };
    const fetch = () => new Promise(resolve => { release = resolve; });
    ${extract('fetchWithDeadline')}
    ${extract('fetchFileTreeData')}
    const loading = fetchFileTreeData();
    USER_TOKEN = 'new';
    release({status:401, ok:false, json:async () => ({ok:false})});
    assert.equal(await loading, false);
    assert.equal(USER_TOKEN, 'new');
  })()`, { assert, window: {} });
});

test('concurrent saves serialize and the last save contains the newest edits', async () => {
  await vm.runInNewContext(`(async () => {
    let fileSavePromise = null;
    let auditPreviewActive = false, fileArtifactPreviewActive = false, csvEditorActive = false;
    let currentOpenFile = {path:'main.py', name:'main.py'}, currentBufferDirty = true;
    let USER_TOKEN = 'student', TEACHER_TOKEN = null, ADMIN_TOKEN = null;
    let text = 'first', release;
    const bodies = [];
    const editor = {getValue: () => text};
    const syncEditorBridge = () => {};
    const fileAuthHeaders = () => ({'X-User-Token':USER_TOKEN});
    const fileJsonHeaders = fileAuthHeaders;
    const fetch = (url, options) => {
      bodies.push(JSON.parse(options.body).content);
      return new Promise(resolve => { release = resolve; });
    };
    ${extract('fetchWithDeadline')}
    ${extract('saveCurrentFile')}
    ${extract('writeCurrentFile')}
    const first = saveCurrentFile();
    text = 'latest'; const second = saveCurrentFile();
    assert.equal(bodies.length, 1);
    release({ok:true, json:async () => ({ok:true})}); await first;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(bodies, ['first','latest']);
    release({ok:true, json:async () => ({ok:true})}); await second;
    assert.equal(currentBufferDirty, false);
  })()`, { assert, window: {}, setImmediate });
});

test('a slow file open cannot overwrite edits made while waiting for its response', async () => {
  await vm.runInNewContext(`(async () => {
    let fileOpenRequestId = 0, release;
    let USER_TOKEN = 'student', TEACHER_TOKEN = null, ADMIN_TOKEN = null;
    let auditPreviewActive = false, csvEditorActive = false, currentBufferDirty = false;
    let currentOpenFile = {path:'main.py', name:'main.py'}, text = 'saved source';
    const fileAuthHeaders = () => ({'X-User-Token':USER_TOKEN});
    const syncEditorBridge = () => {}, setMainEditorReadOnly = () => {}, saveCurrentFile = async () => true;
    const editor = {getValue: () => text, setValue() { throw new Error('must not overwrite new edits'); }};
    const fetchWithDeadline = () => new Promise(resolve => { release = resolve; });
    ${extract('openFile')}
    const opening = openFile({path:'other.py', name:'other.py'});
    await new Promise(resolve => setImmediate(resolve));
    text = 'new offline edit'; currentBufferDirty = true;
    release({ok:true, json:async () => ({ok:true, content:'other file'})});
    await opening;
    assert.equal(currentOpenFile.path,'main.py'); assert.equal(text,'new offline edit');
    assert.equal(currentBufferDirty,true);
  })()`, { assert, window: {}, setImmediate });
});

test('CSV opens fetch one bounded page; text and JSON opens fetch their source once', async () => {
  await vm.runInNewContext(`(async () => {
    let fileOpenRequestId = 0;
    let USER_TOKEN = 'student', TEACHER_TOKEN = null, ADMIN_TOKEN = null;
    let auditPreviewActive = false, csvEditorActive = false, currentBufferDirty = false;
    let currentOpenFile = null, text = '', csvPage;
    const calls = [], alerts = [];
    const alert = message => alerts.push(message);
    const fileAuthHeaders = () => ({'X-User-Token':USER_TOKEN});
    const syncEditorBridge = () => {}, setMainEditorReadOnly = () => {}, saveCurrentFile = async () => true;
    const editor = {getValue: () => text, setValue(value) { text = value; }};
    const csvBufferContent = () => '';
    const clearFileArtifactPreview = () => {}, updateActiveFileName = () => {}, updateEditorOverlay = () => {};
    const setWorkspaceTab = () => {}, renderCurrentFolder = () => {}, syncSubmissionScoringForOpenFile = () => {}, updateSendFileButtonVisibility = () => {};
    const setCsvMode = (active, page) => { csvEditorActive = active; if(active) csvPage = page; };
    const fetchWithDeadline = async url => {
      calls.push(url);
      return {ok:true, json:async () => url.includes('/csv-page') ? {ok:true, kind:'csv', rows:[{cells:['sample']}]} : {ok:true, kind:'text', content:'source'}};
    };
    ${extract('openFile')}
    await openFile({path:'folder/LARGE.CSV', name:'LARGE.CSV'});
    assert.deepEqual(calls, ['/api/files/csv-page?path=folder%2FLARGE.CSV']);
    assert.equal(csvEditorActive,true); assert.equal(csvPage.rows.length,1);
    await openFile({path:'main.py', name:'main.py'});
    assert.equal(calls[1],'/api/files/read?path=main.py'); assert.equal(text,'source');
    await openFile({path:'data.json', name:'data.json'});
    assert.equal(calls[2],'/api/files/read?path=data.json');
    assert.equal(calls.length,3); assert.deepEqual(alerts,[]);
  })()`, { assert, window: {WorkspaceData:{jsonMode() {}}} });
});

test('unchanged editor languages preserve token state; language changes still apply', () => {
  const modes = {student:'python', teacher:'python'}, changes = [];
  const makeEditor = name => ({getOption: () => modes[name], setOption(option, value) {changes.push([name,option,value]); modes[name] = value;}});
  vm.runInNewContext(`
    let currentOpenFile = {name:'main.py'}, teacherEditor = teacher;
    const getManualLanguageInfo = () => null;
    const getLanguageInfoForFileName = name => ({mode:name.endsWith('.js') ? 'javascript' : 'python', label:'Language'});
    ${extract('syncEditorLanguage')}
    syncEditorLanguage(); syncEditorLanguage();
    assert.equal(changes.length,0);
    syncEditorLanguage('script.js'); syncEditorLanguage('script.js');
  `, {assert, changes, teacher:makeEditor('teacher'), window:{eagleEditor:makeEditor('student')}, document:{querySelector: () => null}});
  assert.deepEqual(changes,[['student','mode','javascript'],['teacher','mode','javascript']]);
});
