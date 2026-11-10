const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const app=fs.readFileSync('static/js/app-core.js','utf8');
function extract(source,name) {
  const start=source.search(new RegExp(`^    (?:async )?function ${name}\\(`,'m'));
  return source.slice(start,source.indexOf('\n    }',start)+6);
}
function deferred() {let resolve; const promise=new Promise(r=>resolve=r); return {promise,resolve};}
test('review navigation uses the roster and includes every submitted format', async () => {
  const first = {email:'zed@example.test', hasGradableFiles:true};
  const second = {email:'ada@example.test', files:[{name:'photo.png'}], hasGradableFiles:false};
  const third = {email:'ben@example.test', quizResponses:[{}]};
  const assignment = {id:'a', targetClassId:'class', submissions:[third, second, first]};
  const roster = [
    {email:third.email, first_name:'Ben', last_name:'Dawson'},
    {email:second.email, first_name:'Ada', last_name:'Chen'},
    {email:'missing@example.test', first_name:'Lin', last_name:'Brown'},
    {email:first.email, first_name:'Zed', last_name:'Adams'},
  ];
  const opened = [];
  const context = {
    teacherClasses:[{id:'class', students:roster}], activeSubmissionContext:{assignmentId:'a', studentEmail:first.email},
    saveReviewedScore:async () => true,
    getSubmissionForAssignment:(_id, email) => ({assignment, submission:assignment.submissions.find(row => row.email === email)}),
    openAssignmentSubmission:async (id, email) => {opened.push(email); context.activeSubmissionContext = {assignmentId:id, studentEmail:email};},
  };
  vm.runInNewContext(['studentNameSort','assignmentRoster','assignmentReviewSubmissions','navigateAssignmentSubmission']
    .map(name => extract(app,name)).join('\n'), context);
  for (const direction of [1, 1, 1, -1, -1, -1]) await context.navigateAssignmentSubmission(direction);
  assert.deepEqual(opened, [second.email, third.email, second.email, first.email]);
});

test('return waits for the score and restores the reviewed assignment by ID and class', async () => {
  const save = deferred();
  const actions = [];
  const tab = {click: () => actions.push('submissions'), focus: () => actions.push('focus')};
  const context = {
    activeSubmissionContext: {assignmentId:'reviewed'}, currentAdminAssignmentName:'other',
    activeAssignmentsClassId:'other-class', fileOpenRequestId:4,
    saveReviewedScore: () => save.promise,
    getAssignmentByName: id => ({id, targetClassId:'reviewed-class'}),
    syncTeacherDashboardClassSelectors: () => actions.push(context.activeAssignmentsClassId),
    openTeacherDashboard: view => actions.push(view),
    renderAdminAssignments: () => actions.push(context.currentAdminAssignmentName),
    document: {getElementById: id => id === 'assignment-tab-submissions' ? tab : null},
  };
  vm.runInNewContext(extract(app,'returnToSubmissionDashboard'), context);
  const pending = context.returnToSubmissionDashboard();
  assert.deepEqual(actions, []);
  save.resolve(true);
  await pending;
  assert.deepEqual(actions, ['reviewed-class', 'dash-assignments', 'reviewed', 'submissions', 'focus']);
  assert.equal(context.fileOpenRequestId, 5);
});

test('stream snapshots preserve scroll and selection-only updates keep the document intact', () => {
  let code = 'a\nb', scroll = {left:50, top:160}, marker = null, replacements = 0;
  let selection, visible;
  const cm = {
    getScrollInfo:() => scroll, operation:update => update(),
    scrollTo:(left, top) => {scroll = {left, top};},
    getOption:() => 'python', getValue:() => code,
    setValue:value => {code = value; scroll = {left:0, top:0}; replacements++;},
    clearHistory(){}, removeLineClass:line => {assert.equal(line, marker); marker = null;},
    addLineClass:line => {marker = {line}; return marker;},
    getWrapperElement:() => ({classList:{toggle:(_className, value) => {visible = value;}}}),
    setSelection:(anchor, head, {scroll}) => {
      assert.equal(scroll, false);
      selection = [anchor.line, anchor.ch, head.line, head.ch];
    },
  };
  const indicator = {};
  const context = {
    document:{getElementById:() => indicator}, initTeacherViewer:() => cm, teacherCursorMarker:null, teacherStreamFollowing:false,
    getLanguageInfoForKey:() => ({mode:'python'}),
  };
  vm.runInNewContext(extract(app,'applyTeacherCodeToViewer'), context);
  context.applyTeacherCodeToViewer({code:'a\nb\nc', language:'python', cursorLine:2});
  assert.deepEqual(scroll, {left:50, top:160});
  assert.equal(marker.line, 2);
  context.applyTeacherCodeToViewer({code, language:'python', cursorLine:0, cursorCh:1, selectionAnchor:{line:2,ch:0}});
  assert.equal(replacements, 1);
  assert.equal(marker.line, 0);
  assert.deepEqual(selection, [2, 0, 0, 1]);
  assert.deepEqual(scroll, {left:50, top:160});
  assert.equal(visible, true);
  assert.match(indicator.textContent, /Line 1, column 2$/);
  context.applyTeacherCodeToViewer({code, language:'python', cursorLine:null});
  assert.equal(marker, null);
  assert.equal(visible, false);
  assert.deepEqual(selection, [0, 0, 0, 0]);
});

test('late submission opens cannot overwrite edits or a changed teacher account',async()=>{
  for(const mutation of ['edit','account']) {
    const response=deferred();let value='teacher draft',token='teacher',requested=false;
    const context={getSubmissionForAssignment:()=>({assignment:{id:'a'},submission:{email:'student',files:[{}],submittedFileName:'one.py'}}),
      currentAdminAssignmentName:null,saveCurrentFile:async()=>true,fileOpenRequestId:0,
      currentOpenFile:{name:'draft.py'},assignmentManagerHeaders:()=>({'X-Teacher-Token':token}),
      editor:{getValue:()=>value,setValue:()=>assert.fail('stale request changed editor')},
      fetch:()=>{requested=true;return response.promise;},window:{eagleEditor:{}},URLSearchParams};
    vm.createContext(context);vm.runInContext(extract(app,'openAssignmentSubmission'),context);
    const pending=context.openAssignmentSubmission('a','student');while(!requested) await Promise.resolve();
    if(mutation==='edit') value='newer teacher edits';else token='different teacher';
    response.resolve({json:async()=>({ok:true,content:'student source'})});await pending;
    assert.equal(context.currentOpenFile.name,'draft.py');
  }
});
test('a draft save keeps edits made during its write dirty and ready to autosave',async()=>{
  const writing=deferred();let value='initial',request=0,scheduled=0;
  const context={window:{EagleIDE:{},prompt:()=> 'saved.py',alert:()=>assert.fail('unexpected alert')},
    currentOpenFile:{draft:true,name:'example.py',pasteRanges:[[0,7]]},isAuthenticated:()=>true,
    fileAuthHeaders:()=>({'X-User-Token':'sample'}),fileJsonHeaders:()=>({'X-User-Token':'sample'}),
    USER_TOKEN:'sample',TEACHER_TOKEN:null,ADMIN_TOKEN:null,editor:{getValue:()=>value},
    syncEditorBridge:()=>{},updateActiveFileName:()=>{},loadFileTree:async()=>{},scheduleAutosave:()=>scheduled++,
    fetchWithDeadline:async()=>++request===1?{ok:false}:request===2?{ok:true,json:async()=>({ok:true,path:'saved.py'})}:writing.promise};
  vm.createContext(context);vm.runInContext(extract(app,'saveDraftAsFile'),context);
  const pending=context.saveDraftAsFile();
  while(request<3) await Promise.resolve();
  value='initial and later edits';
  writing.resolve({ok:true,json:async()=>({ok:true})});
  assert.equal(await pending,true);
  assert.equal(context.currentBufferDirty,true);assert.equal(scheduled,1);
  assert.equal(context.currentOpenFile.path,'saved.py');
});
test('loading a different source clears undo history across file and account boundaries',()=>{
  const source=fs.readFileSync('static/js/editor-init.js','utf8');
  let value='',undo=[];
  const cm={on:()=>{},setValue:next=>{undo.push(value);value=next;},getValue:()=>value,clearHistory:()=>{undo=[];}};
  const context={document:{getElementById:()=>({})},window:{CodeMirror:true},CodeMirror:{fromTextArea:()=>cm},eagleFoldRange:()=>null};
  vm.createContext(context);vm.runInContext(extract(source,'initEditor'),context);
  const editor=context.initEditor();
  editor.setValue('private source from previous file');editor.setValue('new student source');
  if(undo.length) value=undo.pop();
  assert.equal(editor.getValue(),'new student source');assert.equal(undo.length,0);
});
