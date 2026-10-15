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
