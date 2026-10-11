const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname,'../static/js/assignment-workflow.js'),'utf8');

function setup() {
  const tabs = ['current','past'].map(value => ({dataset:{studentAssignmentTab:value},
    setAttribute(key,value){this[key]=value;}, classList:{toggle() {}}}));
  const context = {window:{}, document:{querySelectorAll:()=>tabs}, Intl, Date, URLSearchParams};
  vm.runInNewContext(source,context);
  let renders=0;
  context.window.AssignmentWorkflow.configure({maxScore:()=>10,feedback:value=>value,
    renderStudent:()=>renders++});
  return {api:context.window.AssignmentWorkflow,tabs,renders:()=>renders};
}
const assignment = {id:'one',name:'Loops',task:'Write a loop',active:true,isPast:false,
  canSubmit:true,canSubmitFiles:true,dueAt:'2026-10-13T20:00:00Z'};

test('student titles start collapsed with deadline and submitted check',()=>{
  const {api}=setup();
  const html=api.card({...assignment,studentSubmissionSummary:{submittedAt:'today',totalScore:8}},true);
  assert.match(html,/<details[^>]+data-assignment-id="one" >/);
  assert.match(html,/<summary>.*Due .*<\/summary>/);
  assert.match(html,/aria-label="Submitted">✓/);
  assert.match(html,/8 \/ 10/);
  assert.match(html,/View submission/);
});
test('ordinary past work offers viewing and scores without submitting',()=>{
  const {api}=setup();
  const html=api.card({...assignment,isPast:true,active:false,deadlineOpen:false,
    studentSubmissionSummary:{submittedAt:'today',aiFeedback:'Good effort'}},true);
  assert.match(html,/View submission/);
  assert.match(html,/Score report/);
  assert.match(html,/View teacher feedback/);
  assert.doesNotMatch(html,/submit-assignment-btn|open-questions-btn/);
});
test('no-deadline accommodation can submit from Past, while closed window disables it',()=>{
  const {api}=setup();
  const html=api.card({...assignment,isPast:true,active:false,deadlineOpen:true,canSubmitFiles:false,
    dueAt:'',accommodationNote:'No deadline provided per accommodation',submissionWindowOpen:false,
    submissionWindowMessage:'Submissions open weekdays 08:00–15:00 (America/Chicago).'},true);
  assert.match(html,/submit-assignment-btn[^>]*disabled/);
  assert.match(html,/No due date/);
  assert.match(html,/No deadline provided per accommodation/);
  assert.match(html,/is-closed/);
});
test('withdrawn work retains view access but loses submitted check',()=>{
  const {api}=setup();
  const html=api.card({...assignment,studentSubmissionSummary:{submittedAt:'today',withdrawn:true}},true);
  assert.match(html,/Un-submitted by teacher/);
  assert.match(html,/View submission/);
  assert.doesNotMatch(html,/aria-label="Submitted"/);
});
test('Past tab survives refresh but resets on account change',()=>{
  const {api,tabs,renders}=setup();
  assert.equal(api.studentTab('one@example.com'),'current');
  api.bindStudent({querySelectorAll:()=>[]});
  tabs[1].onclick();
  assert.equal(renders(),1);
  assert.equal(api.studentTab('one@example.com'),'past');
  assert.equal(api.studentTab('two@example.com'),'current');
});
test('attachment names and student identity are escaped and histories accessible',()=>{
  const {api}=setup();
  const html=api.teacherFiles(assignment,{email:'<student>',files:[{id:'f',name:'<script>.html'}],history:[{}]});
  assert.match(html,/&lt;script&gt;.html/);
  assert.match(html,/data-email="&lt;student&gt;"/);
  assert.match(html,/History \(1 previous\)/);
  assert.doesNotMatch(html,/<script>/);
  assert.doesNotMatch(api.card({...assignment,name:'<script>alert(1)</script>'},true),/<script>/);
});

function submissionSetup(save) {
  let token='student-one', root, sent;
  const button={focus(){}}, status={};
  const context={window:{}, Intl, Date,
    document:{activeElement:null,body:{append(element){root=element;root.isConnected=true;}},
      createElement(){return {innerHTML:'',addEventListener(){},remove(){this.isConnected=false;},
        querySelector(selector){return selector==='[role="status"]' ? status : button;},
        querySelectorAll(){return [...this.innerHTML.matchAll(/name="workspaceFile" value="([^"]+)" checked/g)].map(match=>({value:match[1]}));}};}}};
  vm.runInNewContext(source,context);
  const api=context.window.AssignmentWorkflow;
  const a={...assignment,allowMultiFileSubmission:true};
  api.configure({assignment:()=>a,studentHeaders:()=>({'X-User-Token':token}),
    files:()=>[{path:'old.py'},{path:'current.py'},{path:'Trash/removed.py',in_trash:true}],
    openFile:()=>({path:'current.py'}), save,
    request:async (_url, options)=>{sent=JSON.parse(options.body);return {ok:true,json:async()=>({ok:true})};},
    reloadAssignments:async()=>{}});
  api.submitDialog('one');
  return {root:()=>root,button,status,sent:()=>sent,changeAccount(){token='student-two';}};
}
test('submission defaults to the open file and saves its edits first',async()=>{
  let saves=0;
  const s=submissionSetup(async()=>{saves++;return true;});
  assert.match(s.root().innerHTML,/value="current.py" checked/);
  assert.doesNotMatch(s.root().innerHTML,/Trash\/removed.py/);
  await s.button.onclick();
  assert.equal(saves,1);
  assert.deepEqual(s.sent().filePaths,['current.py']);
});
test('failed save and account changes during save prevent submission',async()=>{
  const failed=submissionSetup(async()=>false);
  await failed.button.onclick();
  assert.equal(failed.sent(),undefined);
  assert.match(failed.status.textContent,/could not be saved/);
  let finish;
  const changing=submissionSetup(()=>new Promise(resolve=>{finish=resolve;}));
  const pending=changing.button.onclick();
  changing.changeAccount(); finish(true); await pending;
  assert.equal(changing.sent(),undefined);
  assert.match(changing.status.textContent,/account changed/);
});
