const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,'../static/js/wiki-admin.js'),'utf8');

function fixture(name) {
  const begin = source.indexOf(`  async function ${name}(`);
  const end = source.indexOf('\n  }',begin)+4;
  const controls = Object.fromEntries(['Title','Slug','Description','Status','Aliases','FolderIcon','Content'].map(key=>['wikiAdmin'+key,{value:key==='Status'?'published':key==='Content'?'original':''}]));
  controls.wikiAdminPageStandards = {querySelectorAll:()=>[]};
  let resolve;
  const pending = new Promise(done=>{resolve=done;});
  const loads = [];
  const context = {state:{node:{id:'first',kind:'page'},selectedId:'first',draftDirty:true},
    $:id=>controls[id], reader:()=>({fetchJson:()=>pending}),adminHeaders:()=>({}),
    clearTimeout(){},setTimeout(){},progress(){},loadTree:async options=>loads.push(options)};
  vm.runInNewContext(source.slice(begin,end)+`; globalThis.run=${name};`,context);
  return {context,controls,loads,resolve};
}

test('wiki publishing retains typing made while the save is pending',async()=>{
  const f=fixture('saveEditor'), pending=f.context.run();
  f.controls.wikiAdminContent.value='newer local text';
  f.resolve({node:{id:'first',kind:'page',markdown:'original'}});
  await pending;
  assert.equal(f.controls.wikiAdminContent.value,'newer local text');
  assert.equal(f.context.state.draftDirty,true);
  assert.equal(f.loads[0].reloadEditor,false);
});

test('a late wiki save cannot select the previously open page',async()=>{
  const f=fixture('saveEditor'),pending=f.context.run();
  f.context.state.node={id:'second',kind:'page'};
  f.context.state.selectedId='second';
  f.resolve({node:{id:'first',kind:'page'}});
  await pending;
  assert.equal(f.context.state.node.id,'second');
  assert.equal(f.context.state.selectedId,'second');
  assert.equal(f.loads.length,0);
});

test('wiki draft autosave leaves newer typing dirty',async()=>{
  const f=fixture('autosaveDraft'),pending=f.context.run(true);
  f.controls.wikiAdminContent.value='newer local text';
  f.resolve({draft:{}});await pending;
  assert.equal(f.context.state.draftDirty,true);
});
