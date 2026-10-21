const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const appearance = require('../static/js/editor-appearance.js');

test('all palettes keep text readable on default and custom backgrounds', () => {
  for (const scheme of Object.keys(appearance.schemes)) {
    for (const bg of ['', '#000000', '#ffffff', '#808080', '#00ff00', '#33117f']) {
      const p = appearance.palette({scheme, backgrounds:{dark:bg,light:bg}}, false);
      for (const key of ['foreground','keyword','definition','variable','string','number','comment','type']) {
        assert.ok(appearance.contrast(p[key],p.background) >= 4.5, `${scheme} ${bg} ${key}`);
      }
    }
  }
  assert.equal(appearance.palette(null,true).mode,'light');
  assert.equal(appearance.palette({scheme:'accessible-dark'},true).mode,'dark');
  assert.deepEqual(appearance.normalize({scheme:'bad',backgrounds:{dark:'url(x)',light:'#AbCdEf'}}), {scheme:'auto',backgrounds:{dark:'',light:'#abcdef'}});
});

test('gutter remeasurement is bounded, preserves scroll, and releases observers', async () => {
  let count=9, refreshes=0, scroll, frames=[], observer, fontHandler;
  const handlers = {}, windowHandlers = {};
  const wrapper = {clientWidth:600,clientHeight:400};
  const cm = {getWrapperElement:()=>wrapper,lineCount:()=>count,on:(name,fn)=>handlers[name]=fn,off:name=>delete handlers[name],
    refresh:()=>refreshes++,getScrollInfo:()=>({left:45,top:200}),scrollTo:(...args)=>scroll=args};
  const env = {requestAnimationFrame:fn=>(frames.push(fn),frames.length), cancelAnimationFrame:()=>{},
    addEventListener:(name,fn)=>windowHandlers[name]=fn,removeEventListener:name=>delete windowHandlers[name],
    ResizeObserver:class {constructor(fn){this.fn=fn;observer=this;} observe(){} disconnect(){this.disconnected=true;}},
    document:{fonts:{ready:Promise.resolve(),addEventListener:(_name,fn)=>fontHandler=fn,removeEventListener:()=>fontHandler=null}}};
  const flush=()=>{const pending=frames;frames=[];pending.forEach(fn=>fn());};
  const dispose=appearance.attachGeometry(cm,env);
  await Promise.resolve();flush();assert.equal(refreshes,1);
  handlers.changes();flush();assert.equal(refreshes,1);
  count=10;handlers.changes();handlers.changes();flush();assert.equal(refreshes,2);
  count=100;handlers.changes();observer.fn();fontHandler();flush();assert.equal(refreshes,3);
  count=99;handlers.changes();flush();assert.equal(refreshes,4);
  assert.deepEqual(scroll,[45,200]);
  wrapper.clientWidth=0;observer.fn();flush();assert.equal(refreshes,4);
  wrapper.clientWidth=600;observer.fn();flush();assert.equal(refreshes,5);
  dispose();assert.ok(observer.disconnected);assert.deepEqual(handlers,{});assert.deepEqual(windowHandlers,{});assert.equal(fontHandler,null);
});

test('late preference loads cannot repaint a different signed-in account', async () => {
  let context={}, requests=[], listeners={}, applied={};
  const wrapper={style:{setProperty:(key,value)=>applied[key]=value},dataset:{},closest:()=>null};
  wrapper.CodeMirror={getWrapperElement:()=>wrapper,setOption:()=>{}};
  const document={body:{classList:{contains:()=>false}},querySelectorAll:selector=>selector==='.CodeMirror'?[wrapper]:[],getElementById:()=>null};
  const window={EagleIDE:{getContext:()=>context},addEventListener:(name,fn)=>listeners[name]=fn};
  const scope={window,document,console,AbortSignal,localStorage:{getItem:()=>null,setItem:()=>{}},fetch:(_url,options)=>new Promise(resolve=>requests.push({resolve,options}))};
  vm.runInNewContext(fs.readFileSync(require.resolve('../static/js/editor-appearance.js'),'utf8'),scope);
  context={USER_TOKEN:'first',currentUser:{email:'first@example.test'}};listeners['eagle-context-updated']();
  context={TEACHER_TOKEN:'second',currentTeacher:{email:'second@example.test'}};listeners['eagle-context-updated']();
  assert.equal(requests[0].options.headers['X-User-Token'],'first');
  assert.equal(requests[1].options.headers['X-Teacher-Token'],'second');
  requests[1].resolve({ok:true,json:async()=>({ok:true,preferences:{scheme:'ocean-dark'}})});
  await new Promise(resolve=>setImmediate(resolve));
  const current=applied['--editor-background'];
  requests[0].resolve({ok:true,json:async()=>({ok:true,preferences:{scheme:'paper-light'}})});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(applied['--editor-background'],current);
  context={};listeners['eagle-context-updated']();
  assert.equal(applied['--editor-background'],appearance.palette(null,false).background);
});
