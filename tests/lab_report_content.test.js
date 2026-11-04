const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=name=>fs.readFileSync(path.join(__dirname,'../static/js',name),'utf8');

test('report copy commands preserve exact text and never turn HTML or remote images into markup',()=>{
  const sandbox={window:{addEventListener(){}}};vm.runInNewContext(source('lab-report-content.js'),sandbox);
  const html=sandbox.window.LabReportContent.render('Use {printf "<script>"} then <img onerror="alert(1)">. ![remote](https://tracker.test/a)');
  assert.match(html,/data-lab-copy="printf &quot;&lt;script&gt;&quot;"/);
  assert.doesNotMatch(html,/<script>|<img/);
  assert.match(html,/&lt;img onerror/);
  const image=sandbox.window.LabReportContent.render('![<unsafe>](lab-image:'+'a'.repeat(32)+')');
  assert.match(image,/data-report-image="a{32}"/);
  assert.match(image,/alt="&lt;unsafe&gt;"/);
});

test('availability rejects a stale account response and deduplicates in-flight reads',async()=>{
  const events={},button={},requests=[];
  let resolveOld;
  const ctx={USER_TOKEN:'old',currentConfig:{eagle_lab_enabled:true}};
  const sandbox={window:{EagleIDE:{getContext:()=>ctx},addEventListener:(name,fn)=>events[name]=fn,dispatchEvent(){}},document:{getElementById:()=>button},AbortSignal,CustomEvent:class{},fetch:async(_url,options)=>{requests.push(options);if(options.headers['X-User-Token']==='old')return new Promise(resolve=>resolveOld=resolve);return {ok:true,json:async()=>({ok:true,data:{available:false,class_ids:[],role:'student'}})};}};
  vm.runInNewContext(source('eagle-lab-access.js'),sandbox);
  const pending=sandbox.window.EagleLabAccess.refresh();assert.equal(requests.length,1);
  ctx.USER_TOKEN='new';await sandbox.window.EagleLabAccess.refresh();
  resolveOld({ok:true,json:async()=>({ok:true,data:{available:true,class_ids:['private-old-class'],role:'student'}})});
  await pending;assert.equal(button.hidden,true);assert.deepEqual(Array.from(sandbox.window.EagleLabAccess.get().class_ids),[]);
  await sandbox.window.EagleLabAccess.refresh();assert.equal(requests.length,2);
});

test('a disabled configuration invalidates a previously accepted in-flight access read',async()=>{
  let finish;
  const ctx={USER_TOKEN:'same',currentConfig:{eagle_lab_enabled:true}},button={};
  const sandbox={window:{EagleIDE:{getContext:()=>ctx},addEventListener(){},dispatchEvent(){}},document:{getElementById:()=>button},AbortSignal,CustomEvent:class{},fetch:()=>new Promise(resolve=>finish=resolve)};
  vm.runInNewContext(source('eagle-lab-access.js'),sandbox);
  const pending=sandbox.window.EagleLabAccess.refresh();ctx.currentConfig.eagle_lab_enabled=false;
  await sandbox.window.EagleLabAccess.refresh();finish({ok:true,json:async()=>({ok:true,data:{available:true,class_ids:['old']}})});await pending;
  assert.equal(button.hidden,true);
});

test('CoTeacher report reads use the student token while media authoring retains its scoped teacher header',()=>{
  const ctx={TEACHER_TOKEN:'student-session',currentTeacher:{is_coteacher:true}};
  const sandbox={window:{EagleIDE:{getContext:()=>ctx},addEventListener(){}}};vm.runInNewContext(source('lab-report-content.js'),sandbox);
  assert.deepEqual({...sandbox.window.LabReportContent.headers(true)},{'X-User-Token':'student-session'});
  assert.deepEqual({...sandbox.window.LabReportContent.headers()},{'X-Teacher-Token':'student-session'});
});
