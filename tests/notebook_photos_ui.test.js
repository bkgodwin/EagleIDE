const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,'../static/js/notebook-photos.js'),'utf8');
function element(tag) {
  return {tag,dataset:{},children:[],isConnected:true,events:{},classList:{add(){}},
    appendChild(node){this.children.push(node);},prepend(node){this.children.unshift(node);},
    addEventListener(name,handler){this.events[name]=handler;},
    removeAttribute(name){if(name === 'src') delete this.src; if(name === 'data-photo-loading') delete this.dataset.photoLoading;},
    remove(){this.isConnected=false;},querySelector(selector){return selector === 'img' ? this.children.find(n=>n.tag === 'img') : this.children.find(n=>n.dataset.photoStatus);},
    querySelectorAll(){return this.children.filter(n=>n.dataset.photoControl || n.dataset.photoStatus);}};
}
function setup(count=4,readOnly=false) {
  let intersection, removals=0, made=0;
  const figures=Array.from({length:count},(_,index)=>{const figure=element('figure');figure.dataset.notebookImage=`images/board-${index}.jpg`;figure.appendChild(element('img'));return figure;});
  const requests=[],revoked=[];
  const context={URLSearchParams,AbortController,window:{},fetch(url,options){return new Promise(resolve=>requests.push({url,options,resolve}));},
    URL:{createObjectURL(){return `blob:photo-${++made}`;},revokeObjectURL(url){revoked.push(url);}},
    document:{getElementById(){return null;},createElement:element}};
  context.window.IntersectionObserver=context.IntersectionObserver=class {constructor(fn){intersection=fn;}observe(){}disconnect(){}};
  vm.runInNewContext(source,context);
  const root={querySelectorAll(){return figures;}};
  context.window.NotebookPhotos.mount(root,{classId:'class',studentEmail:'student@example.com',headers:{'X-Teacher-Token':'private-token'},readOnly,onRemove(){removals++;}});
  return {api:context.window.NotebookPhotos,figures,requests,revoked,root,removals:()=>removals,show(entries){intersection(entries.map(([target,isIntersecting])=>({target,isIntersecting})));}};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const respond=request=>request.resolve({ok:true,headers:{get(){return 'image/jpeg';}},blob:async()=>new Blob(['photo'],{type:'image/jpeg'})});

test('photos load only near the viewport, two at a time, through authenticated requests',async()=>{
  const state=setup(6,true);
  assert.equal(state.requests.length,0);
  state.show(state.figures.map(figure=>[figure,true]));assert.equal(state.requests.length,2);
  state.requests.forEach(respond);await tick();assert.equal(state.requests.length,4);
  assert.ok(state.requests.every(request=>request.options.headers['X-Teacher-Token'] === 'private-token'));
  assert.ok(state.requests.every(request=>!request.url.includes('private-token')));
  assert.match(state.requests[0].url,/studentEmail=student%40example.com/);
  assert.equal(state.figures[0].children.filter(node=>node.dataset.photoControl).length,0);
  state.api.reset();state.requests.slice(2).forEach(respond);await tick();
  assert.equal(state.requests.length,4);assert.equal(state.revoked.length,2);
});

test('offscreen and removed photos release their browser URLs and preserve the workspace file',async()=>{
  const state=setup(1);
  state.show([[state.figures[0],true]]);respond(state.requests[0]);await tick();
  state.show([[state.figures[0],false]]);assert.equal(state.revoked.length,1);assert.equal(state.figures[0].querySelector('img').src,undefined);
  state.show([[state.figures[0],true]]);respond(state.requests[1]);await tick();
  const button=state.figures[0].children.find(node=>node.dataset.photoControl);
  button.events.click({preventDefault(){},stopPropagation(){}});
  assert.equal(state.removals(),1);assert.equal(state.revoked.length,2);assert.equal(state.requests.length,2);
  assert.equal(state.figures[0].isConnected,false);
});

test('persisted photo markup contains the workspace path but no runtime image URL or controls',async()=>{
  const state=setup(1);state.show([[state.figures[0],true]]);respond(state.requests[0]);await tick();
  state.api.clean(state.root);
  assert.equal(state.figures[0].querySelector('img').src,undefined);
  assert.equal(state.figures[0].dataset.notebookImage,'images/board-0.jpg');
  assert.ok(state.figures[0].children.filter(node=>node.dataset.photoControl || node.dataset.photoStatus).every(node=>!node.isConnected));
  assert.equal(state.api.validPath('../x.jpg'),false);assert.equal(state.api.validPath('images/nested/x.jpg'),false);
  state.api.reset();
});

test('camera images are resized before upload and posted without embedding tokens',async()=>{
  let canvas,upload;
  const context={window:{},URLSearchParams,AbortController,setTimeout,clearTimeout,URL:{createObjectURL(){return 'blob:camera';},revokeObjectURL(){}},
    Image:class {constructor(){this.naturalWidth=4000;this.naturalHeight=3000;}set src(value){if(value)queueMicrotask(()=>this.onload());}},
    FormData:class {constructor(){this.parts=[];}append(...part){this.parts.push(part);}},
    document:{createElement(){canvas={getContext(){return {drawImage(){}};},toBlob(callback,type){callback({size:100,type,width:this.width,height:this.height});}};return canvas;}},
    fetch:async(url,options)=>{upload={url,options,width:canvas.width,height:canvas.height};return {json:async()=>({ok:true,path:'images/board.jpg',width:1920,height:1440})};}};
  vm.runInNewContext(source,context);
  const result=await context.window.NotebookPhotos.upload({size:1000,name:'Camera.HEIC',type:'image/heic'},'class',{'X-User-Token':'token'});
  assert.equal(result.path,'images/board.jpg');assert.equal(upload.url,'/api/notebook/images');
  const file=upload.options.body.parts.find(part=>part[0] === 'image');
  assert.equal(file[2],'Camera.jpg');assert.equal(file[1].type,'image/jpeg');
  assert.equal(file[1].width,1920);assert.equal(file[1].height,1440);
  assert.equal(canvas.width,1);assert.equal(canvas.height,1);assert.equal(upload.options.headers['X-User-Token'],'token');
});

test('an upload finishing after an account switch cannot insert into the new notebook',async()=>{
  const notebook=fs.readFileSync(path.join(__dirname,'../static/js/student-notebook.js'),'utf8');
  const start=notebook.indexOf('  async function insertNotebookPhoto('),end=notebook.indexOf('  function renderEditablePage(',start);
  let resolve;
  const context={window:{NotebookPhotos:{upload(){return new Promise(done=>resolve=done);}}},ownerKey(){return 'old';},tabIsReadOnly(){return false;},activeTab(){return {id:'notes'};},setStatus(){},updateNotebookToolbarMode(){},
    document:{getElementById(){throw new Error('Should not touch the new notebook');}}};
  vm.runInNewContext(`let photoTarget={owner:'old',classId:'old',tabId:'notes',headers:{}},photoUploadPending=false,loadedOwner='old',loadedClassId='old';
    ${notebook.slice(start,end)} globalThis.insert=insertNotebookPhoto;globalThis.switchAccount=()=>{loadedOwner='new';loadedClassId='new';};`,context);
  const pending=context.insert({name:'Photo.jpg'});context.switchAccount();resolve({path:'images/photo.jpg'});await pending;
});
