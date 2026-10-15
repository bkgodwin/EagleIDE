const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const workflow = fs.readFileSync('static/js/assignment-workflow.js', 'utf8');
const recorder = fs.readFileSync('static/js/assignment-development.js', 'utf8');
const app = fs.readFileSync('static/js/app-core.js', 'utf8');
function extract(name) {
  const start = app.search(new RegExp(`^    (?:async )?function ${name}\\(`, 'm'));
  return app.slice(start, app.indexOf('\n    }', start) + 6);
}
function element() {
  const children = new Map(), classes = new Set();
  return {isConnected:true, hidden:false, textContent:'', value:'', checked:true, disabled:false,
    scrollTop:0, scrollLeft:0, clientHeight:100, clientWidth:200, listeners:{},
    classList:{add:x=>classes.add(x), remove:x=>classes.delete(x), contains:x=>classes.has(x), toggle(){}},
    set innerHTML(html) {
      children.clear();
      for (const match of html.matchAll(/class="([^"]+)"/g)) {
        const child = element();
        for (const cls of match[1].split(' ')) children.set('.' + cls, child);
      }
      if (children.has('.development-speed')) children.get('.development-speed').value = '1';
    },
    querySelector:s=>children.get(s) || null, querySelectorAll:()=>[],
    setAttribute(key,value){this[key]=value;}, addEventListener(key,fn){this.listeners[key]=fn;},
    replaceChildren(){children.clear();}, focus(){}, remove(){this.isConnected=false;},
  };
}
async function setup({count=3, fallback=false, request:customRequest, prepare}={}) {
  const panel=element(), stack=element(), textarea=element(), timers=new Map(), requests=[], rendered=[], scrolls=[];
  let source='submitted code', token='teacher', nextTimer=0, restores=0, modal;
  const frames=Array.from({length:count}, (_,i)=>({seq:i+1,from:i,delete:0,insert:String(i%10),
    kind:'editor',at:new Date(Date.UTC(2026,0,1,0,i*3)).toISOString(),receivedAt:'2026-01-02T00:00:00Z'}));
  const cm={on(){},getValue:()=>source,getScrollInfo:()=>({left:8,top:50}),operation:fn=>fn(),
    replaceRange:(insert,from,to,origin)=>{assert.equal(origin,'developmentPlayback');source=source.slice(0,from)+insert+source.slice(to);},
    posFromIndex:i=>i,clearHistory(){},scrollTo:(left,top)=>scrolls.push({left,top}),
    scrollIntoView:(position,margin)=>scrolls.push({position,margin}),refresh(){},markText:()=>({clear(){}})};
  const context={window:{eagleEditor:fallback?null:cm},document:{body:{classList:{toggle(){}},append(root){modal=root;}},
    getElementById:id=>({submissionDevelopmentPanel:panel,editorContentStack:stack,editor:textarea})[id],
    createElement:tag=>tag==='canvas'?{getContext:()=>({measureText:text=>({width:text.length*8})})}:element()},
    getComputedStyle:()=>({lineHeight:'20px',fontSize:'14px',font:'14px monospace',tabSize:'4',paddingTop:'0',paddingLeft:'0'}),
    URLSearchParams,AbortController,Date,Intl,Map,Promise,
    setTimeout(fn,ms){const id=++nextTimer;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)};
  vm.createContext(context);vm.runInContext(recorder,context);vm.runInContext(workflow,context);
  const api=context.window.AssignmentWorkflow;
  const request=async (url,options)=>{
    requests.push({url,options});
    if(customRequest) {const custom=await customRequest(url);if(custom) return custom;}
    const params=new URL(url,'https://example.test').searchParams, cursor=Number(params.get('cursor') || 1);
    return {ok:true,json:async()=>params.has('index') ? {ok:true,total:count,path:'Project.py',firstAt:frames[0]?.at,lastAt:frames.at(-1)?.at}
      : {ok:true,base:frames.slice(0,cursor-1).map(f=>f.insert).join(''),frames:frames.slice(cursor-1,cursor+119)}};
  };
  api.configure({request,managerHeaders:()=>({'X-Teacher-Token':token}),roster:()=>[{email:'student',name:'Student'}]});
  let valid=true;
  const adapter={email:'student',valid:()=>valid,prepare,render(content,frame,follow){rendered.push({content,frame,follow});api.renderEditorFrame(content,frame,follow);},restore(){restores++;}};
  await api.attachEditorDevelopment({id:'a',fileControl:true},'student',adapter);
  const settled=()=>new Promise(resolve=>setImmediate(resolve));
  return {api,context,panel,stack,textarea,timers,requests,rendered,scrolls,frames,adapter,
    node:cls=>panel.querySelector('.development-'+cls),source:()=>fallback?textarea.value:source,
    token(value){token=value;},invalidate(){valid=false;},restores:()=>restores,modal:()=>modal,
    async tick(){const [id,timer]=timers.entries().next().value || [];if(timer){timers.delete(id);timer.fn();await settled();}},settled};
}

test('editor opens on submitted code and shares controls, minute hint and original timestamps',async()=>{
  const s=await setup();
  assert.equal(s.source(),'submitted code');assert.equal(s.rendered.length,0);
  assert.match(s.node('summary').textContent,/Completion time hint: 6.0 min/);
  assert.match(s.node('summary').textContent,/First edit .*Last edit/);
  assert.match(s.node('position').textContent,/Showing submitted code/);
  assert.equal(s.node('seek').value,'3');assert.equal(s.node('follow').checked,true);
  assert.ok(s.stack.classList.contains('has-development-player'));
  assert.equal(s.requests.length,1,'initial editor view only fetches the small history index');
  const brief=await setup({request:url=>url.includes('index=')?{ok:true,json:async()=>({ok:true,total:1,path:'Short.py',firstAt:'2026-01-01T00:00:00Z',lastAt:'2026-01-01T00:00:01Z'})}:null});
  assert.match(brief.node('summary').textContent,/Completion time hint: 0.02 min/,'brief work is not rounded down to zero minutes');
});

test('play, pause, seek and restore share paged data without fetching every frame',async()=>{
  const s=await setup();s.node('play').onclick();await s.settled();
  assert.equal(s.source(),'0');assert.equal(s.node('play').textContent,'Pause');
  assert.match(s.node('position').textContent,/Change 1 \/ 3.*Received.*Read-only history/);
  assert.equal([...s.timers.values()][0].ms,1000,'long idle gap is skipped');
  s.node('play').onclick();assert.equal(s.timers.size,0);
  s.node('seek').value='3';s.node('seek').oninput();await s.tick();
  assert.equal(s.source(),'012');assert.equal(s.requests.length,2);
  const restores=s.restores();s.node('submitted').listeners.click();assert.match(s.node('position').textContent,/Showing submitted code/);
  assert.equal(s.restores(),restores+1);
  s.node('skip').checked=false;s.node('speed').value='20';s.node('play').onclick();await s.settled();
  assert.equal([...s.timers.values()][0].ms,9000,'speed respects the original gap when idle skipping is off');
  s.api.disposeEditorDevelopment();assert.equal(s.timers.size,0);assert.equal(s.panel.hidden,true);
});

test('seeking across checkpoints reconstructs the correct source with a bounded page cache',async()=>{
  const s=await setup({count:700});
  for(const seq of [121,241,361,481,601,121]) {
    s.node('seek').value=String(seq);s.node('seek').oninput();await s.tick();
    assert.equal(s.source(),s.frames.slice(0,seq).map(f=>f.insert).join(''));
  }
  assert.equal(s.requests.length,7,'the oldest page was evicted and fetched again');
});

test('following can be turned off and incremental playback preserves the editor viewport',async()=>{
  const s=await setup();s.node('follow').checked=false;
  await s.node('previous').onclick();
  assert.deepEqual(s.scrolls,[{left:8,top:50}]);
  s.node('follow').checked=true;await s.node('next').onclick();
  assert.deepEqual(s.scrolls.at(-1),{position:3,margin:24});
});

test('textarea fallback follows changed lines and long lines only when outside the viewport',async()=>{
  const s=await setup({fallback:true});
  const render=(text,offset,follow=true)=>s.api.renderEditorFrame(text,{from:offset,insert:''},follow);
  render('first\nsecond',7);assert.equal(s.textarea.scrollTop,0);assert.equal(s.textarea.scrollLeft,0);
  const text='line\n'.repeat(40)+'x'.repeat(80);render(text,text.length);
  assert.ok(s.textarea.scrollTop>600);assert.ok(s.textarea.scrollLeft>400);
  const top=s.textarea.scrollTop,left=s.textarea.scrollLeft;
  render(text,0,false);assert.equal(s.textarea.scrollTop,top);assert.equal(s.textarea.scrollLeft,left);
  render(text,0);assert.equal(s.textarea.scrollTop,0);assert.equal(s.textarea.scrollLeft,0);
});

test('late history responses cannot replace code after student navigation or account changes',async()=>{
  for(const mutation of ['student','account','pause']) {
    let release;
    const s=await setup({request:url=>url.includes('cursor=')?new Promise(resolve=>{release=resolve;}):null});
    const pending=s.node('previous').onclick();await s.settled();
    if(mutation==='student') {s.invalidate();s.api.syncEditorDevelopment({});}
    else if(mutation==='account') s.token('other teacher');else s.api.pauseEditorDevelopment();
    release({ok:true,json:async()=>({ok:true,base:'',frames:s.frames})});await pending;
    assert.equal(s.rendered.length,0,mutation);assert.equal(s.source(),'submitted code');
  }
});

test('a save failure keeps submitted code visible and reports the problem',async()=>{
  const s=await setup({prepare:async()=>{throw new Error('Could not save teacher edits');}});
  await s.node('previous').onclick();
  assert.equal(s.source(),'submitted code');assert.match(s.node('position').textContent,/Could not save teacher edits/);
});

test('empty or purged recordings disable all playback controls',async()=>{
  for(const purged of [false,true]) {
    const s=await setup({count:0,request:url=>url.includes('index=')?{ok:true,json:async()=>({ok:true,total:0,gradingCompletedAt:purged?'date':null})}:null});
    for(const control of ['play','seek','previous','next']) assert.equal(s.node(control).disabled,true);
    assert.match(s.node('summary').textContent,purged?/timelines deleted/:/No code changes/);
    assert.equal(s.source(),'submitted code');
  }
});

test('modal history uses the same controls, time hint and follow-edits behavior',async()=>{
  const s=await setup();const root=element(), button=element();
  button.dataset={email:'student'};root.querySelectorAll=selector=>selector==='.assignment-development-open'?[button]:[];
  s.api.bindTeacher(root,{id:'a',name:'Project',targetClassId:'class',submissions:[]},false);
  await button.onclick();const modal=s.modal();
  assert.match(modal.querySelector('.development-summary').textContent,/Completion time hint: 6.0 min/);
  assert.equal(modal.querySelector('.development-source').textContent,'0');
  modal.querySelector('.development-follow').checked=false;
  await modal.querySelector('.development-next').onclick();
  assert.equal(modal.querySelector('.development-source').textContent,'01');
  modal.querySelector('.assignment-modal-close').onclick();assert.equal(modal.isConnected,false);
});

test('editor adapter makes frames read-only, bypasses autosave and restores submitted source and paste marks',async()=>{
  const s=await setup();let adapter,readonly=false,value='submitted',marks;
  Object.assign(s.context,{currentOpenFile:{submission:true,pasteRanges:[[0,2]]},assignmentManagerHeaders:()=>({teacher:'one'}),
    editor:{getValue:()=>value,setValue:next=>{value=next;}},saveCurrentFile:async()=>true,currentBufferDirty:false,_autosaveTimer:null,
    setMainEditorReadOnly:value=>{readonly=value;},updateEditorOverlay:()=>{readonly=false;}});
  s.context.window.AssignmentWorkflow={attachEditorDevelopment(_a,_e,value){adapter=value;},renderEditorFrame(content){value=content;},highlightEditor:value=>{marks=value;}};
  vm.runInContext(extract('attachSubmissionDevelopment'),s.context);
  vm.runInContext(extract('writeCurrentFile'),s.context);
  s.context.attachSubmissionDevelopment({id:'a'}, {email:'student'});
  await adapter.prepare();adapter.render('historical',{},true);
  assert.equal(value,'historical');assert.equal(readonly,true);assert.equal(s.context.currentOpenFile.historyPlayback,true);
  s.context.auditPreviewActive=false;s.context.currentBufferDirty=true;
  assert.equal(await s.context.writeCurrentFile(),true,'no fetch or grading mutation is needed for a history frame');
  adapter.restore();assert.equal(value,'submitted');assert.equal(readonly,false);
  assert.deepEqual(marks,[[0,2]]);assert.equal(s.context.currentBufferDirty,false);
  s.context.currentOpenFile={name:'different student'};adapter.render('late frame',{},true);
  assert.equal(value,'submitted');
});

test('teacher edits made while a save is pending prevent playback from discarding those edits',async()=>{
  const s=await setup();let adapter;
  Object.assign(s.context,{currentOpenFile:{submission:true},assignmentManagerHeaders:()=>({}),editor:{getValue:()=> 'new unsaved teacher edit'},
    saveCurrentFile:async()=>true,currentBufferDirty:true});
  s.context.window.AssignmentWorkflow={attachEditorDevelopment(_a,_e,value){adapter=value;}};
  vm.runInContext(extract('attachSubmissionDevelopment'),s.context);
  s.context.attachSubmissionDevelopment({id:'a'},{email:'student'});
  await assert.rejects(adapter.prepare(),/finish saving/);assert.equal(s.context.currentBufferDirty,true);
});

test('controlled Python, JavaScript, HTML and CSS submissions open in the editor including textarea fallback',async()=>{
  for(const extension of ['py','js','html','css']) {
    let value='old source',attached=0,ideOpened=0,readOnly;
    const context={getSubmissionForAssignment:()=>({assignment:{id:'a',fileControl:true},submission:{email:'student',submittedFileName:'Project.'+extension}}),
      currentAdminAssignmentName:null,saveCurrentFile:async()=>true,fileOpenRequestId:0,currentOpenFile:{name:'old.py'},
      assignmentManagerHeaders:()=>({teacher:'one'}),editor:{getValue:()=>value,setValue:next=>{value=next;}},
      fetch:async()=>({json:async()=>({ok:true,content:'submitted source',fileName:'Project.'+extension,revisionId:'one',pasteRanges:[[0,3]]})}),
      window:{eagleEditor:null,AssignmentWorkflow:{highlightEditor(){}},WikiReader:{showIDE(){ideOpened++;}}},URLSearchParams,
      clearFileArtifactPreview(){},setCsvMode(){},syncEditorLanguage(){},setMainEditorReadOnly:next=>{readOnly=next;},isCoTeacher:()=>false,
      updateActiveFileName(){},updateEditorOverlay(){},setWorkspaceTab(){},populateSubmissionScoringPanel(){},
      attachSubmissionDevelopment(){attached++;},renderAdminAssignments(){},minimizeTeacherDashboardForSubmission(){}};
    vm.createContext(context);vm.runInContext(extract('openAssignmentSubmission'),context);
    await context.openAssignmentSubmission('a','student');
    assert.equal(value,'submitted source');assert.equal(attached,1);assert.equal(ideOpened,1);
    assert.equal(readOnly,['html','css'].includes(extension));assert.equal(context.currentOpenFile.submission,true);
    assert.deepEqual(Array.from(context.currentOpenFile.pasteRanges[0]),[0,3]);
  }
});
