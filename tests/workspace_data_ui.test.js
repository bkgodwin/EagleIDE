const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup() {
  const status = {textContent:''};
  const wrap = {innerHTML:'', querySelector:()=>status, querySelectorAll:()=>[], contains:()=>false};
  const elements = {csvEditor:wrap, jsonToolbar:{hidden:true}, jsonTree:{hidden:true}, jsonFormatBtn:{}, jsonTreeBtn:{}};
  const context = {window:{}, document:{getElementById:id=>elements[id], querySelector:()=>null}, setTimeout, clearTimeout};
  vm.runInNewContext(fs.readFileSync('static/js/workspace-data.js','utf8'), context);
  const module = context.window.WorkspaceData;
  let resolve, payload, requests = [], notifyRequest;
  const requested = new Promise(r=>notifyRequest=r);
  module.configure({dirty(){}, editor:()=>({}), headers:()=>({}), save:()=>module.saveCsv(), request(url, options) {
    requests.push(url);
    if (options?.body) payload = JSON.parse(options.body);
    return new Promise(r=>{resolve=r;notifyRequest();});
  }});
  module.showCsv({header:['Name'], headerOffset:0, rows:[{offset:5,cells:['Avery']}], columns:1, column:0, nextCursor:12, version:'v1', size:20}, {path:'data.csv'});
  const input = (offset, value) => wrap.oninput({target:{closest:()=>({dataset:{offset:String(offset),column:'0'},value})}});
  return {module, wrap, status, input, requests, requested, get payload(){return payload;}, respond(body) {resolve({ok:true,json:async()=>({ok:true,...body})});}};
}

test('CSV save preserves newer edits and remaps their offsets', async () => {
  const s = setup(); s.input(5,'Saved value');
  const saving = s.module.saveCsv();
  assert.equal(s.payload.changes[0].value,'Saved value');
  s.input(5,'Typed during save');
  s.respond({version:'v2',size:40,offsets:{0:0,5:8,12:30}});
  assert.equal(await saving,true);
  assert.equal(s.module.csvDirty(),true);
  assert.deepEqual(JSON.parse(s.module.signature()),[{offset:8,column:0,value:'Typed during save'}]);
  const again = s.module.saveCsv(); s.respond({version:'v3',size:40,offsets:{0:0,8:8,30:30}});
  assert.equal(await again,true);
  assert.equal(s.module.csvDirty(),false);
});

test('CSV navigation refuses to discard edits typed during page load', async () => {
  const s = setup();
  const navigating = s.wrap.onclick({target:{closest:()=>({dataset:{action:'next'},disabled:false})}});
  await s.requested;
  s.input(5,'Keep this');
  s.respond({header:['Name'],headerOffset:0,rows:[{offset:12,cells:['Next']}],columns:1,nextCursor:null,version:'v1',size:20});
  await navigating;
  assert.equal(s.module.csvDirty(),true);
  assert.match(s.wrap.innerHTML,/new changes/);
  assert.match(s.wrap.innerHTML,/Keep this/);
});

test('CSV rename updates the path used by future saves', async () => {
  const s = setup(); s.module.updateFile({path:'renamed.csv'}); s.input(5,'New');
  const saving = s.module.saveCsv();
  assert.equal(s.payload.path,'renamed.csv');
  s.respond({version:'v2',size:20,offsets:{0:0,5:5,12:12}}); await saving;
});

test('CPU polling starts only when the performance menu is visible and stops when closed', async () => {
  let observer, interval, calls=0;
  const modal={style:{display:'none'}}, graphs={replaceChildren(){},textContent:''};
  const context={window:{}, document:{hidden:false,getElementById:id=>id==='serverHealthModal'?modal:graphs,addEventListener(){}},
    MutationObserver:class {constructor(cb){observer=cb;} observe(){}},
    fetch:async()=>{calls++;return {json:async()=>({ok:true,cores:[]})};},AbortSignal:{timeout:()=>({})},
    setInterval(cb){interval=cb;return 1;},clearInterval(){interval=null;}};
  vm.runInNewContext(fs.readFileSync('static/js/server-performance.js','utf8'),context);
  context.window.ServerPerformance.configure(()=> 'admin');
  observer(); assert.equal(calls,0);
  modal.style.display='flex'; observer(); await Promise.resolve(); await Promise.resolve();
  assert.equal(calls,1); assert.equal(typeof interval,'function');
  modal.style.display='none'; observer(); assert.equal(interval,null);
  assert.equal(calls,1);
});
