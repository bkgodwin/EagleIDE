const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function setup() {
  const handlers = {}, current = {pasteRanges:[]}; let enabled=true, value='';
  const cm = {on:(event,fn) => handlers[event]=fn,indexFromPos:p=>p.ch,getRange:(from,to)=>value.slice(from.ch,to.ch)};
  const context={window:{eagleEditor:cm}};
  vm.runInNewContext(fs.readFileSync('static/js/file-provenance.js','utf8'),context);
  const api=context.window.FileProvenance;
  api.configure({enabled:()=>enabled,file:()=>current});
  const change=(from,to,text,origin='+input')=>{
    handlers.beforeChange(cm,{from:{ch:from},to:{ch:to},text:[text],origin});
    value=value.slice(0,from)+text+value.slice(to);
  };
  return {api,current,change,disable:()=>enabled=false};
}
const plain = value => JSON.parse(JSON.stringify(value));
test('paste provenance moves and splits around ordinary edits; deleting text removes it',()=>{
  const h=setup();
  h.change(0,0,'typed '); h.change(6,6,'pasted','paste');
  assert.deepEqual(plain(h.current.pasteRanges),[[6,12]]);
  h.change(0,0,'!'); assert.deepEqual(plain(h.current.pasteRanges),[[7,13]]);
  h.change(9,9,'X'); assert.deepEqual(plain(h.current.pasteRanges),[[7,9],[10,14]]);
  h.change(7,14,''); assert.deepEqual(plain(h.current.pasteRanges),[]);
});
test('undo and redo restore paste provenance without marking ordinary typed text',()=>{
  const h=setup(); h.change(0,0,'code','paste'); h.change(0,4,'','undo');
  assert.deepEqual(plain(h.current.pasteRanges),[]);
  h.change(0,0,'code','redo'); assert.deepEqual(plain(h.current.pasteRanges),[[0,4]]);
  h.change(4,4,'typed'); assert.deepEqual(plain(h.current.pasteRanges),[[0,4]]);
});
test('programmatic source loads, teacher editing, and guest editing are not paste events',()=>{
  const h=setup(); h.change(0,0,'loaded','setValue');
  assert.deepEqual(plain(h.current.pasteRanges),[]);
  h.disable(); h.change(0,0,'teacher paste','paste');
  assert.deepEqual(plain(h.current.pasteRanges),[]);
});
test('UTF-16 offsets agree with JavaScript source including emoji',()=>{
  const h=setup(); h.change(0,0,'🙂'); h.change(2,2,'hello','paste');
  assert.deepEqual(plain(h.current.pasteRanges),[[2,7]]);
});
test('undo of typed text does not inherit an older identical pasted fragment',()=>{
  const h=setup(); h.change(0,0,'x','paste'); h.change(0,1,'');
  h.change(0,0,'x'); h.change(0,1,''); h.change(0,0,'x','undo');
  assert.deepEqual(plain(h.current.pasteRanges),[]);
});
test('teacher preview escapes source and highlights only reported ranges',()=>{
  const context={window:{},document:{}};
  vm.runInNewContext(fs.readFileSync('static/js/assignment-workflow.js','utf8'),context);
  const html=context.window.AssignmentWorkflow.highlightSource('a<script>x</script>z',[[1,19]]);
  assert.match(html,/a<mark class="assignment-pasted-text">&lt;script&gt;x&lt;\/script&gt;<\/mark>z/);
  assert.doesNotMatch(html,/<script>/);
  assert.match(context.window.AssignmentWorkflow.teacherToolbar({quiz:{questions:[{type:'written'}]}},true),/Grade written responses by question/);
});
