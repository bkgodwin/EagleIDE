// Optional real Chromium fixture: no production accounts, nodes, DNS, or data.
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import {readFileSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {isAbsolute} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {createGateway} from '../lab_gateway/proxy.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const playwrightModule=process.env.EAGLE_LAB_PLAYWRIGHT_MODULE || 'playwright';
const {chromium}=await import(isAbsolute(playwrightModule)?pathToFileURL(playwrightModule).href:playwrightModule);
const generated=spawnSync(process.env.EAGLE_LAB_TEST_PYTHON || 'python',[root+'tests/eagle_lab_test_certificate.py'],{encoding:'utf8'});
if(generated.status!==0)throw Error('The fixture needs Python with the project cryptography dependency.');
const tls=JSON.parse(generated.stdout);
const id='a'.repeat(32),assignmentId='b'.repeat(32),domain='pve.school.test';
const nodeHost='s-'+id+'.'+domain;
const questions=[{id:'written',type:'written',question:'Record your observations',points:5},{id:'blank',type:'fill_blank',question:'Management port',points:2},{id:'steps',type:'procedure',question:'Complete the procedure',steps:['Sign in','Inspect the VM'],points:3}];
const assignment={id:assignmentId,name:'Virtualization lab report',task:'Inspect the assigned node and record the results.',assignmentType:'lab_report',targetClassId:'class-a',quiz:{questions}};
const server={id,hostname:'PVE Lab 01',ip:'10.40.0.10',port:8006,status:'up',status_reason:'PVE management responded with HTTP 200.',pin_required:true};
let allowed=true,draft={revision:0,responses:[]},unlocked=false,portalOrigin,proxyOrigin;
const tickets=new Set(),sessions=new Set(),seen=[];
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const json=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
async function body(req){const chunks=[];for await(const chunk of req)chunks.push(chunk);return JSON.parse(Buffer.concat(chunks).toString()||'{}');}

const pve=http.createServer(async(req,res)=>{
  seen.push(req.headers);
  if(req.url==='/pve.js'){
    res.writeHead(200,{'Content-Type':'text/javascript'});return res.end(`
      document.querySelector('#login').onsubmit=async event=>{
        event.preventDefault(); const result=await fetch('/api2/json/access/ticket',{method:'POST',body:'username=fixture'}).then(r=>r.json());
        document.cookie='PVEAuthCookie='+result.data.ticket+'; Path=/; Secure';
        document.querySelector('#login').hidden=true;document.querySelector('#management').hidden=false;
      };
      document.querySelector('#console').onclick=()=>{const frame=document.createElement('iframe');frame.title='VM console';frame.src='/?console=kvm&novnc=1';document.querySelector('#consolePanel').replaceChildren(frame);};`);
  }
  if(req.url==='/console.js'){
    res.writeHead(200,{'Content-Type':'text/javascript'});return res.end(`
      const socket=new WebSocket('wss://'+location.host+'/api2/json/nodes/pve/qemu/100/vncwebsocket?port=5900&vncticket=PVEVNC%3Asynthetic%2B%3D','binary');
      socket.binaryType='arraybuffer';socket.onmessage=event=>document.querySelector('#consoleStatus').textContent=new TextDecoder().decode(event.data).trim();
      socket.onclose=()=>document.querySelector('#consoleStatus').textContent='Disconnected';`);
  }
  if(req.url==='/api2/json/access/ticket')return json(res,{data:{ticket:'synthetic-session'}});
  res.writeHead(200,{'Content-Type':'text/html','X-Frame-Options':'SAMEORIGIN'});
  if(req.url.includes('console=kvm'))return res.end('<!doctype html><html><head><title>VM console</title></head><body><div id="consoleStatus">Connecting</div><textarea aria-label="VM clipboard"></textarea><script src="/console.js"></script></body></html>');
  res.end('<!doctype html><html><head><title>PVE management fixture</title></head><body style="font:16px sans-serif;background:#e7edf3;color:#192734"><h1>PVE management</h1><form id="login"><label>Username<input name="username"></label><label>Password<input name="password" type="password"></label><button>Sign in to PVE</button></form><section id="management" hidden><h2>Node management loaded</h2><label>Terminal<textarea aria-label="Terminal" rows="5" style="width:90%"></textarea></label><button id="console">Open VM console</button><div id="consolePanel"></div></section><script src="/pve.js"></script></body></html>');
});
pve.on('upgrade',(req,socket)=>{
  seen.push(req.headers);
  if(!req.headers.cookie?.includes('PVEAuthCookie=synthetic-session'))return socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
  const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Protocol: binary\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  const greeting=Buffer.from('RFB 003.008\n');socket.write(Buffer.concat([Buffer.from([0x82,greeting.length]),greeting]));socket.on('error',()=>{});
});
const pvePort=await listen(pve);
// Build the real relay after discovering the fixture's portal TLS port.
let relay;
const pageMain=readFileSync(root+'index.html','utf8').match(/<main class="eagle-lab-view"[\s\S]*?<\/main>/)[0];
const portal=https.createServer(tls,async(req,res)=>{
  try{
    if(req.url.startsWith('/static/')){
      const path=new URL(req.url,'https://fixture.test').pathname;
      if(path.includes('..')){res.writeHead(404);return res.end();}
      res.writeHead(200,{'Content-Type':path.endsWith('.css')?'text/css':'text/javascript'});return res.end(readFileSync(root+path.slice(1)));
    }
    if(req.url==='/context.js'){res.writeHead(200,{'Content-Type':'text/javascript'});return res.end("window.EagleIDE={getContext:()=>({USER_TOKEN:'synthetic-student',currentConfig:{eagle_lab_enabled:true},studentClasses:[{id:'class-a',name:'Networking I'}],currentStudentClassId:'class-a'})};");}
    if(req.url==='/init.js'){res.writeHead(200,{'Content-Type':'text/javascript'});return res.end('window.EagleLab.show({push:false});');}
    if(req.url.startsWith('/api/eagle-lab/bootstrap'))return json(res,{ok:true,data:{role:'student',servers:[server],show_credentials:true,gateway_configured:true}});
    if(req.url==='/api/assignments')return json(res,{ok:true,assignments:[assignment]});
    if(req.url==='/api/quiz/'+assignmentId)return json(res,{ok:true,quiz:{questions},savedResponses:[]});
    if(req.url==='/api/lab-reports/'+assignmentId+'/draft'){
      if(req.method==='PUT'){const next=await body(req);if(next.revision!==draft.revision)return json(res,{ok:false,error:'Conflict'},409);draft={revision:draft.revision+1,responses:next.responses,updated_at:Date.now()};}
      return json(res,{ok:true,data:draft});
    }
    if(req.url===`/api/eagle-lab/servers/${id}/launch`){const data=await body(req);if(data.pin!=='1234')return json(res,{ok:false,error:'Incorrect server PIN'},403);const ticket=randomBytes(32).toString('base64url');tickets.add(ticket);unlocked=true;return json(res,{ok:true,data:{url:proxyOrigin+'/_eagle/launch',ticket}});}
    if(req.url.startsWith(`/api/eagle-lab/servers/${id}/credentials`))return json(res,{ok:unlocked,data:{username:'fixture@pve',password:'fixture-only'}});
    if(req.url===`/api/eagle-lab/servers/${id}/disconnect`){sessions.clear();return json(res,{ok:true});}
    res.writeHead(200,{'Content-Type':'text/html','Content-Security-Policy':`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-src ${proxyOrigin}; form-action 'self' ${proxyOrigin}`});
    res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/static/css/main.css"></head><body class="dark eagle-lab-mode" style="display:flex;flex-direction:column;height:100vh;margin:0"><header class="topbar topbar-primary"><button id="eagleLabViewBtn">Eagle Lab</button></header>'+pageMain+'<script src="/context.js"></script><script src="/static/js/eagle-lab.js"></script><script src="/init.js"></script></body></html>');
  }catch{res.writeHead(500);res.end('Fixture error');}
});
const portalPort=await listen(portal);portalOrigin=`https://ide.school.test:${portalPort}`;
relay=createGateway({domain,portalOrigin,recheckMs:50,authorize:async({ticket,session,server_id})=>{
  if(!allowed||server_id!==id)return null;
  if(ticket){if(!tickets.delete(ticket))return null;session=randomBytes(32).toString('base64url');sessions.add(session);}
  return sessions.has(session)?{session,server:{id,ip:'10.40.0.10',port:8006,allow_self_signed:true,revision:1}}:null;
},upstreamRequest:(options,callback)=>http.request({...options,hostname:'127.0.0.1',port:pvePort},callback)});
const front=https.createServer(tls,(req,res)=>relay.emit('request',req,res));front.on('upgrade',(req,socket,head)=>relay.emit('upgrade',req,socket,head));
const proxyPort=await listen(front);proxyOrigin=`https://${nodeHost}:${proxyPort}`;

let browser;
try{
  browser=await chromium.launch({headless:true,args:['--no-proxy-server','--host-resolver-rules=MAP *.school.test 127.0.0.1']});
  const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}});
  await context.grantPermissions(['clipboard-read','clipboard-write']);
  const page=await context.newPage();const failures=[];
  page.on('pageerror',error=>failures.push(error.message));
  await page.goto(portalOrigin);
  await page.getByRole('button',{name:/PVE Lab 01/}).click();
  await page.locator('[data-lab-pin]').fill('0000');await page.getByRole('button',{name:'Connect to PVE'}).click();
  await page.getByText('Incorrect server PIN').waitFor();
  await page.locator('[data-lab-pin]').fill('1234');await page.getByRole('button',{name:'Connect to PVE'}).click();
  const pveFrame=page.frameLocator('iframe[title="PVE Lab 01 management interface"]');
  await pveFrame.getByRole('button',{name:'Sign in to PVE'}).click();
  await pveFrame.getByRole('heading',{name:'Node management loaded'}).waitFor();
  const isolated=await page.locator('iframe[title="PVE Lab 01 management interface"]').evaluate(frame=>{try{return !!frame.contentWindow.document;}catch{return false;}});
  assert.equal(isolated,false,'PVE must not share the parent origin');
  const terminal=pveFrame.getByRole('textbox',{name:'Terminal'});await terminal.click();
  const frame=page.frames().find(frame=>frame.url()===proxyOrigin+'/');
  await frame.evaluate(()=>navigator.clipboard.writeText('echo clipboard fixture'));
  await terminal.press('Control+V');assert.equal(await terminal.inputValue(),'echo clipboard fixture');
  await terminal.fill('copied from embedded terminal');await terminal.press('Control+A');await terminal.press('Control+C');
  assert.equal(await frame.evaluate(()=>navigator.clipboard.readText()),'copied from embedded terminal');
  await pveFrame.getByRole('button',{name:'Open VM console'}).click();
  const consoleFrame=pveFrame.frameLocator('iframe[title="VM console"]');
  await consoleFrame.getByText('RFB 003.008',{exact:true}).waitFor();
  await page.locator('[data-workspace-report]').selectOption(assignmentId);await page.getByRole('button',{name:'Open report',exact:true}).click();
  await page.locator('textarea[data-report-question="written"]').fill('Observations from outside the LAN');
  await page.locator('[data-report-question="blank"]').fill('8006');
  await page.locator('[data-report-question="steps"][data-step="0"]').check();
  await page.getByRole('button',{name:'Close for now'}).click();
  await page.locator('.lab-report-overlay').waitFor({state:'detached'});
  await page.getByRole('button',{name:'Open report',exact:true}).click();
  assert.equal(await page.locator('textarea[data-report-question="written"]').inputValue(),'Observations from outside the LAN');
  assert.equal(await page.locator('[data-report-question="steps"][data-step="0"]').isChecked(),true);
  assert.equal(await page.locator('.lab-report-window').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(20, 20, 20)');
  await page.evaluate(()=>document.body.classList.add('light-mode'));
  assert.equal(await page.locator('.lab-report-window').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(240, 242, 245)');
  await page.evaluate(()=>document.body.classList.remove('light-mode'));
  if(process.env.EAGLE_LAB_SCREENSHOT)await page.screenshot({path:process.env.EAGLE_LAB_SCREENSHOT});
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Mobile page must not overflow');
  await page.getByRole('button',{name:'Close for now'}).click();
  await page.locator('.lab-report-overlay').waitFor({state:'detached'});
  allowed=false;await consoleFrame.getByText('Disconnected',{exact:true}).waitFor();
  assert.equal(seen.some(headers=>headers['x-user-token']),false);
  assert.deepEqual(failures,[]);
  console.log('PASS: PIN denial/unlock, isolated embedded login, clipboard paste, nested binary VM console, report autosave/reopen, mobile bounds, and live revocation.');
}finally{
  await browser?.close();for(const server of [front,portal,pve,relay]){server.closeAllConnections();server.close();}
}
