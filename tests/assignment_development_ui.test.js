const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../static/js/assignment-development.js'),'utf8');

function setup(legacyCrypto=false) {
  const events = {}, intervals = [], changes = {}, saved = new Map(), calls = [];
  let content='', file=null, token='student', student={email:'one@example.com'}, classes=[], blocked=false;
  let handler=async (url,options) => ({ok:true,status:200,json:async()=>url.includes('policy')?{ok:true,clipboardBlocked:blocked}:{ok:true,version:JSON.parse(options.body).version+JSON.parse(options.body).frames.length}});
  const status={textContent:'',setAttribute(){},classList:{toggle(){}}};
  const window={addEventListener(name,fn){events['window:'+name]=fn;},eagleEditor:{on(name,fn){changes[name]=fn;}}};
  const document={visibilityState:'visible',addEventListener(name,fn){events[name]=fn;},getSelection:()=>null,
    getElementById(id){return id==='developmentRecordingStatus'?status:id==='editor'?{addEventListener(){}}:null;},createElement:()=>status};
  const storage={getItem:key=>saved.get(key)||null,setItem:(key,value)=>saved.set(key,value),removeItem:key=>saved.delete(key),key:i=>[...saved.keys()][i],get length(){return saved.size;}};
  const context={window,document,localStorage:storage,TextEncoder,Date,Promise,crypto:legacyCrypto ? {} : require('node:crypto').webcrypto,
    setInterval(fn,ms){intervals.push({fn,ms});},setTimeout(){},clearTimeout(){}};
  vm.runInNewContext(source,context);
  const api=window.AssignmentDevelopment;
  api.configure({request:async(url,options)=>{calls.push({url,options});return handler(url,options);},student:()=>student,
    headers:()=>({'X-User-Token':token}),classes:()=>classes,file:()=>file,content:()=>content});
  return {api,events,intervals,saved,calls,status,
    open(value='',version=0){content=value;file={path:'Project.py',development:{assignmentId:'a'.repeat(32),recording:true,version,content:value}};api.opened();},
    edit(value){content=value;changes.change();},sample(){intervals.find(t=>t.ms===1000).fn();},
    file:()=>file,
    async settled(){await new Promise(resolve=>setImmediate(resolve));},
    request(fn){handler=fn;},setBlocked(value){blocked=value;},classes(value){classes=value;},
    account(email){token=email;student=email?{email}:null;}};
}

test('Unicode-safe splices reconstruct insertions, deletions, and emoji edits',()=>{
  const {api}=setup();
  for(const [before,after] of [['','hello'],['hello',''],['abc','adc'],['😀a','😁a'],['a😀','a😁'],['a😀x','a😀!x']]) {
    assert.equal(api.apply(before,api.splice(before,after)),after);
    assert.doesNotMatch(api.splice(before,after).insert, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  }
});

test('one-second samples batch changes, preserve timestamps, and leave idle code alone',async()=>{
  const s=setup();await s.settled();s.open();s.sample();
  for(let i=0;i<5;i++)s.sample();
  assert.equal(s.calls.filter(c=>c.url.includes('/record')).length,0);
  s.edit('p');s.sample();s.edit('print(1)');s.sample();s.sample();
  await s.api.flush();
  const batches=s.calls.filter(c=>c.url.includes('/record')).map(c=>JSON.parse(c.options.body));
  assert.equal(batches.length,1);assert.equal(batches[0].frames.length,2);
  assert.equal(batches[0].frames[0].resync,undefined,'the first edit of a new file is an ordinary sample');
  assert.equal(batches[0].frames.reduce(s.api.apply,''),'print(1)');
  assert.ok(batches[0].frames.every(f=>Number.isFinite(Date.parse(f.at))));
  assert.equal(s.saved.size,0);
});

test('failed uploads keep a durable retry identity and preserve newer samples',async()=>{
  const s=setup();await s.settled();s.open();s.sample();s.edit('first');s.sample();
  s.request(async()=>{throw new Error('offline');});
  assert.equal(await s.api.flush(),false);assert.equal(s.saved.size,1);
  const first=JSON.parse([...s.saved.values()][0]);
  s.edit('second');s.sample();
  const batches=[];
  s.request(async(_url,options)=>{const b=JSON.parse(options.body);batches.push(b);return {ok:true,status:200,json:async()=>({ok:true,version:b.version+b.frames.length})};});
  assert.equal(await s.api.flush(),true);
  assert.equal(batches[0].batchId,first.batch.batchId);
  assert.equal(batches.length,2);assert.equal(s.saved.size,0);
});

test('another tab triggers an explicit rebase without discarding local code',async()=>{
  const s=setup();await s.settled();s.open('old',0);s.sample();s.edit('local');s.sample();let attempts=0;
  s.request(async(_url,options)=>{attempts++;const b=JSON.parse(options.body);
    if(attempts===1)return {ok:false,status:409,json:async()=>({ok:false,version:7,content:'other tab'})};
    assert.equal(b.version,7);assert.equal(s.api.apply('other tab',b.frames[0]),'local');assert.equal(b.frames[0].resync,true);
    return {ok:true,status:200,json:async()=>({ok:true,version:8})};});
  assert.equal(await s.api.flush(),true);assert.equal(attempts,2);
});

test('account changes cannot acknowledge or send another student recording',async()=>{
  const s=setup();await s.settled();s.open();s.sample();s.edit('private');s.sample();let release;
  s.request(()=>new Promise(resolve=>{release=resolve;}));
  const pending=s.api.flush();await s.settled();s.account('two@example.com');
  release({ok:true,status:200,json:async()=>({ok:true,version:1})});await pending;
  assert.equal(s.saved.size,1);
  const sent=s.calls.filter(c=>c.url.includes('/record'));assert.equal(sent.length,1);
  assert.equal(sent[0].options.headers['X-User-Token'],'student');
});

test('large replacements recover through the ordinary save and recording then resumes',async()=>{
  const s=setup();await s.settled();s.open();s.edit('x'.repeat(500000));s.sample();
  assert.equal(await s.api.flush(),false);
  assert.match(s.status.textContent,/Large change/);
  const journal=JSON.parse([...s.saved.values()][0]);
  assert.equal(journal.frames.length,1);
  assert.equal(s.calls.filter(c=>c.url.includes('/record')).length,0);
  s.api.saved(s.file(),'x'.repeat(500000),1);
  s.edit('x'.repeat(500000)+'!');s.sample();
  assert.equal(await s.api.flush(),true);
  const batch=JSON.parse(s.calls.find(c=>c.url.includes('/record')).options.body);
  assert.equal(batch.version,1);assert.equal(batch.frames.length,1);assert.equal(batch.frames[0].insert,'!');
});

test('clipboard controls cover keyboard, native events, fallback input, and teacher exemptions',async()=>{
  const s=setup();await s.settled();s.classes([{settings:{editor_clipboard:'block'}}]);
  const target={closest:()=>true};
  for(const type of ['copy','cut','paste','drop','beforeinput','keydown']) {
    let prevented=false;
    s.events[type]({target,key:'v',ctrlKey:true,inputType:'insertFromPaste',preventDefault(){prevented=true;},stopImmediatePropagation(){}});
    assert.equal(prevented,true,type);
  }
  s.account(null);assert.equal(s.api.blocked(),false);
  s.account('other@example.com');s.classes([{settings:{editor_clipboard:'outstanding'}}]);
  assert.equal(s.api.blocked(),true,'wait for authoritative policy');
  await s.api.refreshPolicy();assert.equal(s.api.blocked(),false);
});

test('HTTP classroom browsers can record without secure-context randomUUID',async()=>{
  const s=setup(true);await s.settled();s.open();s.edit('print(1)');s.sample();
  assert.equal(await s.api.flush(),true);
  const batch=JSON.parse(s.calls.find(c=>c.url.includes('/record')).options.body);
  assert.match(batch.batchId,/^[a-zA-Z0-9-]{8,80}$/);
});
