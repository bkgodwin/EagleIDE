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

test('autosave does not mark new edits clean when an older request completes', async () => {
  const context = vm.createContext({ assert });
  await vm.runInContext(`(async () => {
    let auditPreviewActive = false, fileArtifactPreviewActive = false, csvEditorActive = false;
    let currentOpenFile = {path:'main.py', name:'main.py'}, currentBufferDirty = true;
    let USER_TOKEN = 'student', TEACHER_TOKEN = null, ADMIN_TOKEN = null;
    let text = 'old text', release;
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
  })()`, { assert });
});
