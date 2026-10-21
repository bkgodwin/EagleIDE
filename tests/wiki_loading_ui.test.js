const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('static/js/wiki-reader.js','utf8');
function extract(name) {
  const start=source.search(new RegExp(`^  (?:async )?function ${name}\\(`,'m'));
  return source.slice(start,source.indexOf('\n  }',start)+4);
}
function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};}
function homeHarness(fetchWiki) {
  const state={homeRequest:0,homeLoad:null,selectedClassId:'one',tree:[{id:'public'}],treeLoaded:true,treeVersion:1};
  const sandbox={state,authHeaders:()=>({'X-User-Token':'session'}),syncClassSelector(){},loadTree:()=>Promise.resolve(state.tree),
    fetchWiki,showStatus(){},renderHomeData(){},syncHomeBackground(){},$:()=>({hidden:false}),AbortController,URLSearchParams,JSON,encodeURIComponent};
  vm.createContext(sandbox);vm.runInContext(extract('loadHome'),sandbox);return sandbox;
}
test('initial wiki requests deduplicate and restart when the class changes before the first response',async()=>{
  const one=deferred(),two=deferred(),requests=[];
  const h=homeHarness((url,options)=>{requests.push({url,options});return requests.length===1?one.promise:two.promise;});
  const first=h.loadHome(),duplicate=h.loadHome();assert.equal(requests.length,1);
  h.state.selectedClassId='two';const second=h.loadHome();
  assert.equal(requests[0].options.signal.aborted,true);
  two.resolve({ok:true,catalog_version:1,featured:['current class']});await second;
  one.resolve({ok:true,catalog_version:1,featured:['old class']});await first;await duplicate;
  assert.deepEqual(h.state.home.featured,['current class']);
  assert.equal(h.state.tree[0].id,'public','class changes preserve the public catalog');
  assert.match(requests[1].url,/include_tree=0/);
});
test('public contents become available while personalized home data is still pending',async()=>{
  const tree=deferred(),home=deferred();let renders=0;
  const h=homeHarness(url=>url==='/api/wiki/tree'?tree.promise:home.promise);
  Object.assign(h,{Date,renderAllTrees:()=>renders++,renderEmbeddedHome(){}});
  Object.assign(h.state,{tree:[],treeLoaded:false,treeLoad:null,treeLoadedAt:0});
  vm.runInContext(extract('loadTree'),h);
  const pending=h.loadHome();
  tree.resolve({ok:true,tree:[{id:'ready'}],catalog_version:1});await h.state.treeLoad;
  assert.equal(h.state.tree[0].id,'ready');assert.equal(h.state.home,undefined);assert.ok(renders>=2);
  home.resolve({ok:true,catalog_version:1,featured:[]});await pending;
  assert.equal(h.state.tree[0].id,'ready');
});
test('wiki retries one transient failure but does not retry authorization errors',async()=>{
  let calls=0;
  const h={fetchJson:async()=>{calls++;if(calls===1) throw Object.assign(new Error('Unavailable'),{status:503});return {ok:true};},AbortSignal,
    setTimeout:fn=>queueMicrotask(fn)};
  vm.createContext(h);vm.runInContext(extract('fetchWiki'),h);
  assert.equal((await h.fetchWiki('/api/wiki/tree')).ok,true);assert.equal(calls,2);
  calls=0;h.fetchJson=async()=>{calls++;throw Object.assign(new Error('Denied'),{status:403});};
  await assert.rejects(h.fetchWiki('/api/wiki/home'),/Denied/);assert.equal(calls,1);
});
