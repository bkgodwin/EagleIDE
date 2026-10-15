const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('static/js/wiki-reader.js','utf8');
function extract(name) {
  const start=source.search(new RegExp(`^  (?:async )?function ${name}\\(`,'m'));
  return source.slice(start,source.indexOf('\n  }',start)+4);
}
function deferred() {let resolve; const promise=new Promise(r=>resolve=r); return {promise,resolve};}
function agenda(fetch) {
  const body={innerHTML:'',textContent:'',children:[],append(node){this.children.push(node);}};
  const nodes={wikiReferenceAgenda:{hidden:true},wikiReferenceAgendaBody:body,wikiReferenceAgendaDate:{}};
  let classId='one';
  const context={state:{agendaRequest:0,agendaKey:''},$:id=>nodes[id],
    defaultClassId:()=>classId,availableClasses:()=>[{id:classId,name:classId,settings:{assignment_submission_window:{timeZone:'America/Chicago'}}}],
    isSignedIn:()=>true,isAdmin:()=>false,isTeacher:()=>false,authHeaders:()=>({'X-User-Token':'test'}),
    fetchJson:fetch,Intl,Date:class extends Date {constructor(...args){super(...(args.length?args:['2026-10-16T01:00:00Z']));}},
    window:{LessonPlanRenderer:{safeMarkdown:text=>`<p>${text}</p>`}},document:{createElement:()=>({})}};
  vm.createContext(context);vm.runInContext(extract('loadReferenceAgenda'),context);
  return {context,body,nodes,load:options=>context.loadReferenceAgenda(options),select:value=>classId=value};
}
test('reference agenda uses current class local date, same-week request, and only today’s links',async()=>{
  let url;
  const h=agenda(async value=>{url=value;return {plan:{days:{thursday:{date:'2026-10-15',markdown:'Today',wiki_pages:[{title:'Loops',slug:'loops'}]},friday:{date:'2026-10-16',markdown:'Tomorrow',wiki_pages:[{title:'Wrong',slug:'wrong'}]}}}};});
  await h.load();
  assert.match(url,/classes\/one\/lesson-plans\?week=2026-10-12$/);
  assert.match(h.body.innerHTML,/Today/);assert.doesNotMatch(h.body.innerHTML,/Tomorrow/);
  assert.deepEqual(h.body.children.map(x=>x.href),['/wiki/loops']);
  assert.equal(h.nodes.wikiReferenceAgenda.hidden,false);
});
test('a previous class agenda cannot replace the current class agenda',async()=>{
  const one=deferred(),two=deferred(); let requests=0;
  const h=agenda(()=>++requests===1?one.promise:two.promise);
  const first=h.load(); h.select('two'); const second=h.load();
  two.resolve({plan:{days:{thursday:{date:'2026-10-15',markdown:'Current'}}}});await second;
  one.resolve({plan:{days:{thursday:{date:'2026-10-15',markdown:'Old'}}}});await first;
  assert.match(h.body.innerHTML,/Current/);assert.doesNotMatch(h.body.innerHTML,/Old/);
  await h.load(); assert.equal(requests,2,'unchanged context does not refetch');
});
test('slow embedded article responses cannot replace a newer topic',async()=>{
  const one=deferred(),two=deferred(),target={innerHTML:'',scrollTop:0}; let count=0;
  const context={state:{embeddedRequest:0,embeddedNode:null,embeddedHistory:[]},$:()=>target,
    disposeWikiContent:()=>{},fetchJson:()=>++count===1?one.promise:two.promise,
    renderNode:node=>{target.title=node.title;},document:{getElementById:()=>null}};
  vm.createContext(context);vm.runInContext(extract('openEmbeddedNode'),context);
  const first=context.openEmbeddedNode('one'),second=context.openEmbeddedNode('two');
  two.resolve({node:{title:'Second',kind:'page',id:'two'}});await second;
  one.resolve({node:{title:'First',kind:'page',id:'one'}});await first;
  assert.equal(target.title,'Second');assert.equal(context.state.embeddedNode.id,'two');
});
