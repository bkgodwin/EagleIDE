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

test('a text box displays multiline commands and interleaves private images without collecting answers',()=>{
  const sandbox={window:{addEventListener(){}}};
  vm.runInNewContext(source('lab-report-content.js'),sandbox);
  const id='a'.repeat(32);
  const html=sandbox.window.LabReportContent.sections([{id:'intro', type:'text_box', points:0,
    question:'Before ![Diagram](lab-image:'+id+') between {\nfirst line\n\nsecond line\n} after'}]);
  assert.match(html,/Before .*data-report-image="a{32}".* between .*data-lab-copy="&#10;first line&#10;&#10;second line&#10;".* after/s);
  assert.doesNotMatch(html,/data-report-question|<textarea|<input|points/);
  const embedded = sandbox.window.LabReportContent.render('{one\n![Diagram](lab-image:'+id+')two}');
  assert.match(embedded,/data-lab-copy="one&#10;two".*<code>one\n<\/code>.*data-report-image="a{32}".*<code>two<\/code>/s);
});

test('instruction clipboard survives denied browser permission and clears on account changes',async()=>{
  const events={},ctx={USER_TOKEN:'first'};
  const sandbox={
    window:{EagleIDE:{getContext:()=>ctx},addEventListener:(name,callback)=>(events[name] ||= []).push(callback)},
    navigator:{clipboard:{writeText:async()=>{throw Error('Denied');},readText:async()=>{throw Error('Denied');}}},
  };
  vm.runInNewContext(source('lab-report-content.js'),sandbox);
  const clipboard=sandbox.window.LabReportContent;
  assert.equal(await clipboard.writeClipboard('printf "hello"\n'),false);
  assert.equal(await clipboard.readClipboard(),'printf "hello"\n');
  ctx.USER_TOKEN='second';
  events['eagle-context-updated'].forEach(callback=>callback());
  await assert.rejects(clipboard.readClipboard(),/Denied/);
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
