// Isolated administration UI fixture. All catalog mutations stay in memory.
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFileSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url)),module=process.env.EAGLE_LAB_PLAYWRIGHT_MODULE||'playwright';
const {chromium}=await import(isAbsolute(module)?pathToFileURL(module).href:module);
const html=readFileSync(root+'index.html','utf8');
const panel=html.match(/<section class="admin-settings-pane" data-admin-settings-pane="eagle-lab">[\s\S]*?<\/section>/)[0].replace('class="admin-settings-pane"','class="admin-settings-pane" style="display:block;padding:24px"');
const dialog=html.match(/<dialog id="eagleLabServerDialog"[\s\S]*?<\/dialog>/)[0];
const main=html.match(/<main class="eagle-lab-view"[\s\S]*?<\/main>/)[0];
let servers=[{id:'a'.repeat(32),hostname:'Networking 01',ip:'10.0.0.10',port:8006,username:'student@pve',notes:'Group one',pin_required:true},{id:'b'.repeat(32),hostname:'Networking 02',ip:'10.0.0.11',port:8006,username:'root',pin_required:false}],rejectSave=false;
const writes=[];
const json=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://fixture');
  if(url.pathname.startsWith('/static/')){try{res.writeHead(200,{'Content-Type':url.pathname.endsWith('.css')?'text/css':'text/javascript'});return res.end(readFileSync(root+url.pathname.slice(1)));}catch{res.writeHead(404);return res.end();}}
  if(url.pathname==='/context.js'){res.writeHead(200,{'Content-Type':'text/javascript'});return res.end(`window.fixtureAdmin=${url.searchParams.has('admin')};window.EagleIDE={getContext:()=>window.fixtureAdmin?{ADMIN_TOKEN:'fixture',currentConfig:{eagle_lab_enabled:true}}:{USER_TOKEN:'student',currentConfig:{eagle_lab_enabled:true},studentClasses:[{id:'class-a',name:'Lab'}]}};`);}
  if(url.pathname==='/init.js'){res.writeHead(200,{'Content-Type':'text/javascript'});return res.end('window.fixtureAdmin?EagleLab.loadAdmin():EagleLab.show({push:false});');}
  if(url.pathname.startsWith('/api/')){
    let data={};if(req.method!=='GET'){const chunks=[];for await(const chunk of req)chunks.push(chunk);data=JSON.parse(Buffer.concat(chunks).toString());writes.push({url:url.pathname,data});}
    if(url.pathname==='/api/eagle-lab/admin/server-order'){servers=data.server_ids.map(id=>servers.find(item=>item.id===id));return json(res,{ok:true,data:{servers}});}
    if(url.pathname==='/api/eagle-lab/admin/servers'&&req.method==='GET')return json(res,{ok:true,data:{servers,gateway_configured:true,gateway_transport:'path'}});
    if(url.pathname.startsWith('/api/eagle-lab/admin/servers')&&['PUT','POST'].includes(req.method)){
      if(rejectSave)return json(res,{ok:false,error:'Fixture save failed'},503);
      if(req.method==='POST')servers.push({...data,id:'c'.repeat(32)});else servers=servers.map(item=>item.id===url.pathname.split('/').at(-1)?{...item,...data}:item);
      return json(res,{ok:true,data:{}});
    }
    if(url.pathname==='/api/eagle-lab/bootstrap')return json(res,{ok:true,data:{servers:servers.map(item=>({...item,status:'up'})),role:'student'}});
    if(url.pathname==='/api/assignments')return json(res,{ok:true,assignments:[]});
    return json(res,{ok:false},404);
  }
  const admin=url.pathname!=='/student';res.writeHead(200,{'Content-Type':'text/html'});
  res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/static/css/main.css"></head><body class="${admin?'':'eagle-lab-mode'}" style="margin:0;min-height:100vh;overflow:auto"><button id="eagleLabViewBtn">Eagle Lab</button>${admin?panel+dialog:main}<script src="/context.js${admin?'?admin=1':''}"></script><script src="/static/js/eagle-lab.js"></script><script src="/init.js"></script></body></html>`);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
try{
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  const base=`http://127.0.0.1:${server.address().port}`;await page.goto(base);
  await page.locator('[data-admin-edit]').first().click();const modal=page.getByRole('dialog',{name:'Edit server'});await modal.waitFor();
  assert.equal(await page.locator('#eagleLabServerHostname').inputValue(),'Networking 01');assert.equal(await page.locator('#eagleLabServerPassword').inputValue(),'');assert.equal(await page.locator('#eagleLabServerPassword').evaluate(el=>el.required),false);
  await page.locator('#eagleLabServerHostname').fill('Edited lab');rejectSave=true;await page.getByRole('button',{name:'Save changes',exact:true}).click();await page.getByText('Fixture save failed',{exact:true}).waitFor();assert.equal(await page.locator('#eagleLabServerHostname').inputValue(),'Edited lab');
  rejectSave=false;await page.getByRole('button',{name:'Save changes',exact:true}).click();await modal.waitFor({state:'hidden'});assert.ok(!Object.hasOwn(writes.at(-1).data,'password'));assert.ok(!Object.hasOwn(writes.at(-1).data,'pin'));
  await page.getByRole('button',{name:'Enroll server',exact:true}).click();await page.getByRole('dialog',{name:'Enroll server'}).waitFor();
  for(const id of ['Hostname','Ip','Password','Pin','Notes'])assert.equal(await page.locator('#eagleLabServer'+id).inputValue(),'');assert.equal(await page.locator('#eagleLabServerPassword').evaluate(el=>el.required),true);
  await page.locator('#eagleLabServerHostname').fill('Third lab');await page.locator('#eagleLabServerIp').fill('10.0.0.12');await page.locator('#eagleLabServerPassword').fill('fixture-only');await page.locator('#eagleLabServerSaveBtn').click();await page.locator('#eagleLabServerDialog').waitFor({state:'hidden'});
  await page.locator('[data-admin-position="'+servers[2].id+'"]').selectOption('0');await page.getByText('Server order saved. Students see this order.',{exact:true}).waitFor();assert.equal(servers[0].hostname,'Third lab');
  await page.reload();await page.locator('[data-admin-edit]').first().waitFor();assert.equal(await page.locator('.eagle-lab-server-summary strong').first().innerText(),'Third lab');
  await page.getByRole('button',{name:'Move Third lab down',exact:true}).click();await page.getByText('Server order saved. Students see this order.',{exact:true}).waitFor();assert.equal(servers[1].hostname,'Third lab');
  for(const light of [false,true]){
    await page.evaluate(light=>document.body.classList.toggle('light-mode',light),light);
    await page.locator('[data-admin-edit]').first().click();
    if(process.env.EAGLE_LAB_SCREENSHOT)await page.screenshot({path:process.env.EAGLE_LAB_SCREENSHOT.replace(/\.png$/,light?'-light.png':'-dark.png')});
    await page.keyboard.press('Escape');await page.locator('#eagleLabServerDialog').waitFor({state:'hidden'});
  }
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Enroll server',exact:true}).click();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.ok(await page.locator('#eagleLabServerDialog').evaluate(el=>el.getBoundingClientRect().right<=innerWidth));
  await page.keyboard.press('Escape');await page.goto(base+'/student');await page.locator('[data-lab-server]').first().waitFor();assert.deepEqual(await page.locator('[data-lab-server] h3').allTextContents(),servers.map(item=>item.hostname));assert.deepEqual(errors,[]);
  console.log('PASS: edit dialog, blank enrollment, failed-save recovery, preserved secrets, reorder/reload/student order, Escape, desktop/mobile and themes.');
}finally{await browser?.close();server.closeAllConnections();server.close();}
