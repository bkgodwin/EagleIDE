const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('static/js/lesson-plans.js','utf8');
function extract(name) {
  const start=source.search(new RegExp(`^  (?:async )?function ${name}\\(`,'m'));
  return source.slice(start,source.indexOf('\n  }',start)+4);
}
function deferred() {let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};}

test('home clears personal agenda data across accounts and ignores the previous response',async()=>{
  let account={USER_TOKEN:'first'}, selected='one';
  const one=deferred(), two=deferred();let calls=0;
  const nodes=Object.fromEntries(['studentLessonPlanSection','studentLessonPlanHost','studentLessonPlanStatus','studentLessonPlanHeading','studentLessonPlanWeekLabel','studentLessonPlanPrevious','studentLessonPlanNext'].map(id=>[id,{textContent:'Previous personal deadline',classList:{remove(){},add(){}}}]));
  const sandbox={state:{homeRequest:0,homeScope:'old',homeData:{}},$:id=>nodes[id],context:()=>account,
    selectedHomeClass:()=>selected,authHeaders:()=>({}),readableWeek:week=>week,
    fetchJson:()=>++calls===1?one.promise:two.promise,
    window:{LessonPlanRenderer:{render:(host,data)=>host.textContent=data.label}}};
  vm.createContext(sandbox);vm.runInContext(extract('loadHomePlan'),sandbox);
  const first=sandbox.loadHomePlan();
  account={USER_TOKEN:'second'};selected='two';
  const second=sandbox.loadHomePlan();
  assert.equal(nodes.studentLessonPlanHost.textContent,'');
  one.resolve({label:'First account',selected_week:'2026-10-19'});await first;
  assert.equal(nodes.studentLessonPlanHost.textContent,'');
  two.resolve({label:'Second account',selected_week:'2026-10-19'});await second;
  assert.equal(nodes.studentLessonPlanHost.textContent,'Second account');
  account={};await sandbox.loadHomePlan();
  assert.equal(nodes.studentLessonPlanHost.textContent,'');
  assert.equal(nodes.studentLessonPlanSection.hidden,true);
});

function publisher() {
  const pending=deferred(), status=[], button={disabled:false};
  const plan={version:1,week_start:'2026-10-19',days:{monday:{markdown:'First revision'}},notes_markdown:''};
  let scope='teacher:one:2026-10-19', repaints=0;
  const sandbox={state:{teacherData:{plan},teacherClassId:'one',teacherWeek:'2026-10-19',scope,publishing:new Set(),drafts:new Map()},
    DAYS:['monday'],teacherScope:()=>scope,captureEditorDraft(){},setTeacherStatus:message=>status.push(message),
    $:()=>button,fetchJson:()=>pending.promise,authHeaders:()=>({}),renderTeacherEditor:()=>repaints++,
    markDirty:()=>sandbox.state.dirty=true,retainDraft:()=>sandbox.state.drafts.set(scope,structuredClone(sandbox.state.teacherData)),
    window:{WikiReader:{loadReferenceAgenda(){}}},JSON,encodeURIComponent};
  vm.createContext(sandbox);vm.runInContext(extract('saveTeacherPlan'),sandbox);
  return {sandbox,plan,pending,status,button,repaints:()=>repaints,scope:value=>scope=value};
}
test('a slow publish preserves newer typing and blocks duplicate publish requests',async()=>{
  const h=publisher(), first=h.sandbox.saveTeacherPlan();
  assert.equal(await h.sandbox.saveTeacherPlan(),false);
  h.plan.days.monday.markdown='Typed during publish';
  h.pending.resolve({plan:{...h.plan,version:2}});await first;
  assert.equal(h.sandbox.state.teacherData.plan.days.monday.markdown,'Typed during publish');
  assert.equal(h.sandbox.state.teacherData.plan.version,2);
  assert.equal(h.repaints(),0);
  assert.match(h.status.at(-1),/Newer edits are still unpublished/);
  assert.equal(h.button.disabled,false);
});
test('publishing after switching weeks updates only the original retained draft',async()=>{
  const h=publisher(), first=h.sandbox.saveTeacherPlan();
  h.sandbox.state.drafts.set('teacher:one:2026-10-19',{plan:structuredClone(h.plan)});
  h.scope('teacher:one:2026-10-26');
  h.sandbox.state.teacherData={plan:{version:0,days:{monday:{markdown:'Next week'}}}};
  h.pending.resolve({plan:{...h.plan,version:2}});await first;
  assert.equal(h.sandbox.state.teacherData.plan.days.monday.markdown,'Next week');
  assert.equal(h.sandbox.state.drafts.size,0,'already-published drafts do not leave a false unsaved warning');
  assert.equal(h.repaints(),0);
});
