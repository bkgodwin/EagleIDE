// Opt-in actual Proxmox clients against fake PVE APIs/PTY/RFB. No live nodes.
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import {readFileSync} from 'node:fs';
import {resolve,extname,isAbsolute,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createGateway} from '../lab_gateway/proxy.mjs';

const moduleAt=value=>isAbsolute(value)?pathToFileURL(value).href:value;
const {chromium}=await import(moduleAt(process.env.EAGLE_LAB_PLAYWRIGHT_MODULE||'playwright'));
const {WebSocketServer}=await import(moduleAt(process.env.EAGLE_LAB_WS_MODULE||'ws'));
const root=fileURLToPath(new URL('../',import.meta.url));
const xterm=resolve(process.env.EAGLE_LAB_XTERM_ROOT),novnc=resolve(process.env.EAGLE_LAB_NOVNC_ROOT);
const generated=spawnSync(process.env.EAGLE_LAB_TEST_PYTHON||'python',[root+'tests/eagle_lab_test_certificate.py'],{encoding:'utf8'});
assert.equal(generated.status,0,generated.stderr);const tls=JSON.parse(generated.stdout);
const pathMode=process.env.EAGLE_LAB_TEST_TRANSPORT!=='origin';
const id='a'.repeat(32),session='s'.repeat(43),prefix=pathMode?`/_eagle/lab/${id}/${session}/`:'/';
const seen=[],input=[],keys=[],sockets=new Set();let portalOrigin,proxyOrigin,relay,allowed=true;
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const template=(base,name)=>readFileSync(resolve(base,name),'utf8').replaceAll('[% nodename %]','pve').replaceAll('[% username %]','fixture@pve').replaceAll('[% token %]','fixture-csrf');
const json=(res,data)=>{res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({data}));};
const pve=http.createServer((req,res)=>{
  seen.push({url:req.url,headers:req.headers});const url=new URL(req.url,'http://fixture');
  if(url.pathname.startsWith('/api2/json/')){
    assert.equal(req.headers.cookie,'PVEAuthCookie=fixture-cookie');
    if(url.pathname.endsWith('/status/current'))return json(res,{status:'running'});
    if(url.pathname.endsWith('/termproxy')||url.pathname.endsWith('/vncproxy'))return json(res,{port:5900,ticket:'PVEVNC:fixture+=',password:'fixture-password',user:'fixture@pve'});
    return json(res,{});
  }
  if(url.pathname==='/'){
    res.writeHead(200,{'Content-Type':'text/html'});return res.end(url.searchParams.has('xtermjs')?template(xterm,'index.html.tpl.in'):template(novnc,'vnc.html'));
  }
  const base=url.pathname.startsWith('/xtermjs/')?xterm:novnc;
  const path=resolve(base,url.pathname.replace(/^\/(?:xtermjs|novnc)\//,''));
  if(!path.startsWith(base+sep)){res.writeHead(404);return res.end();}
  try{const data=readFileSync(path);res.writeHead(200,{'Content-Type':({'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.json':'application/json'})[extname(path)]||'application/octet-stream'});res.end(data);}catch{res.writeHead(404);res.end();}
});
const ws=new WebSocketServer({noServer:true,perMessageDeflate:false});
pve.on('upgrade',(req,socket,head)=>{
  seen.push({url:req.url,headers:req.headers});
  if(req.headers.cookie!=='PVEAuthCookie=fixture-cookie')return socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
  ws.handleUpgrade(req,socket,head,client=>{
    sockets.add(client);client.on('close',()=>sockets.delete(client));
    if(req.url.includes('/lxc/')){
      client.on('message',data=>{const text=data.toString();input.push(text);if(text.startsWith('fixture@pve:'))client.send(Buffer.from('OKshell ready $ '));else if(text==='0:1:\x03')client.send(Buffer.from('\r\n^C\r\nshell ready $ '));});
      return;
    }
    // RFB 3.8, None security, tiny raw framebuffer. Assert real client key events.
    let stage=0,buffer=Buffer.alloc(0);client.send(Buffer.from('RFB 003.008\n'));
    const framebuffer=()=>{const header=Buffer.alloc(16);header[3]=1;header.writeUInt16BE(64,8);header.writeUInt16BE(48,10);const pixels=Buffer.alloc(64*48*4);for(let i=0;i<pixels.length;i+=4){pixels[i]=24;pixels[i+1]=100;pixels[i+2]=210;}client.send(Buffer.concat([header,pixels]));};
    client.on('message',data=>{
      buffer=Buffer.concat([buffer,data]);
      while(buffer.length){
        if(stage===0){if(buffer.length<12)return;buffer=buffer.subarray(12);stage=1;client.send(Buffer.from([1,1]));}
        else if(stage===1){buffer=buffer.subarray(1);stage=2;client.send(Buffer.alloc(4));}
        else if(stage===2){buffer=buffer.subarray(1);stage=3;const init=Buffer.alloc(24);init.writeUInt16BE(64,0);init.writeUInt16BE(48,2);init[4]=32;init[5]=24;init[7]=1;for(const offset of [8,10,12])init.writeUInt16BE(255,offset);init[14]=16;init[15]=8;const name=Buffer.from('Fixture VM');init.writeUInt32BE(name.length,20);client.send(Buffer.concat([init,name]));}
        else{
          const type=buffer[0];let length=({0:20,3:10,4:8,5:6})[type];
          if(type===2){if(buffer.length<4)return;length=4+buffer.readUInt16BE(2)*4;}
          if(type===6){if(buffer.length<8)return;length=8+buffer.readUInt32BE(4);}
          if(!length)throw Error('Unexpected RFB client message '+type);if(buffer.length<length)return;
          if(type===4)keys.push({down:buffer[1],key:buffer.readUInt32BE(4)});
          if(type===3&&buffer[1]===0)framebuffer();buffer=buffer.subarray(length);
        }
      }
    });
  });
});
const pvePort=await listen(pve);
const portal=https.createServer(tls,(req,res)=>{
  if(pathMode&&req.url.startsWith(prefix))return relay.emit('request',req,res);
  const sandbox='allow-scripts allow-forms'+(pathMode?'':' allow-same-origin');
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(`<html><body><iframe title="LXC console" sandbox="${sandbox}" style="width:100%;height:600px" src="${proxyOrigin}${prefix}?console=lxc&xtermjs=1&node=pve&vmid=100"></iframe><iframe title="VM console" sandbox="${sandbox}" style="width:100%;height:600px" src="${proxyOrigin}${prefix}?console=kvm&novnc=1&node=pve&vmid=101"></iframe></body></html>`);
});
portalOrigin=`https://ide.school.test:${await listen(portal)}`;
relay=createGateway({transport:pathMode?'path':'origin',domain:'pve.school.test',portalOrigin,recheckMs:50,authorize:async body=>allowed&&body.server_id===id&&body.session===session?{session,portal_origin:portalOrigin,clipboard_key:'fixture',server:{id,ip:'10.0.0.10',port:8006,allow_self_signed:true}}:null,upstreamRequest:(options,callback)=>http.request({...options,hostname:'127.0.0.1',port:pvePort},callback)});
portal.on('upgrade',(req,socket,head)=>relay.emit('upgrade',req,socket,head));
const front=https.createServer(tls,(req,res)=>relay.emit('request',req,res));front.on('upgrade',(req,socket,head)=>relay.emit('upgrade',req,socket,head));
proxyOrigin=pathMode?portalOrigin:`https://s-${id}.pve.school.test:${await listen(front)}`;
// Seed only the session's fake PVE cookie, never an EagleIDE login.
if(pathMode)await new Promise((resolve,reject)=>{const req=https.request({hostname:'127.0.0.1',port:portal.address().port,path:prefix+'_eagle/state',rejectUnauthorized:false,method:'POST',headers:{Host:new URL(portalOrigin).host,Origin:'null'}},res=>{res.resume();res.on('end',()=>res.statusCode===200?resolve():reject(Error('State seed failed')));});req.on('error',reject);req.end(JSON.stringify({cookie:'PVEAuthCookie=fixture-cookie'}));});
let browser,page;const diagnostics=[];
try{
  browser=await chromium.launch({headless:true,args:['--no-proxy-server','--host-resolver-rules=MAP *.school.test 127.0.0.1']});
  page=await browser.newPage({ignoreHTTPSErrors:true,viewport:{width:1280,height:1400}});const errors=[];
  if(!pathMode)await page.context().addCookies([{name:'__Host-EagleLab',value:session,url:proxyOrigin,secure:true,httpOnly:true,sameSite:'None'},{name:'PVEAuthCookie_'+id,value:'fixture-cookie',url:proxyOrigin,secure:true,sameSite:'None'}]);
  page.on('console',message=>{if(['warning','error'].includes(message.type()))diagnostics.push(message.text());});
  page.on('requestfailed',request=>diagnostics.push(request.url()+': '+request.failure()?.errorText));
  page.on('pageerror',error=>errors.push(error.message));await page.goto(portalOrigin);
  const lxc=page.frames().find(frame=>frame.url().includes('console=lxc'));
  await lxc.waitForFunction(()=>window.state===window.states?.connected);
  await lxc.locator('.xterm-helper-textarea').focus();await page.keyboard.type('sleep 60');await page.keyboard.press('Enter');await page.keyboard.press('Control+c');
  await lxc.waitForFunction(()=>window.term?.buffer.active.getLine(window.term.buffer.active.cursorY)?.translateToString().includes('shell ready'));
  assert.ok(input.includes('0:1:\x03'),'Ctrl+C must reach the PTY as ETX');
  const vm=page.frames().find(frame=>frame.url().includes('console=kvm'));
  await vm.waitForFunction(()=>document.documentElement.classList.contains('noVNC_connected'));
  const canvas=vm.locator('#noVNC_container canvas');await canvas.waitFor();await canvas.click({position:{x:10,y:10}});await page.keyboard.press('Control+c');
  await vm.waitForFunction(()=>{const canvas=document.querySelector('#noVNC_container canvas');return canvas?.width===64&&canvas?.height===48;});
  assert.ok(keys.some(event=>event.key===0xffe3&&event.down),'VM receives Ctrl press');assert.ok(keys.some(event=>event.key===99&&event.down),'VM receives C press');
  assert.ok(seen.some(item=>item.url.includes('/termproxy')&&item.headers['cache-control']==='no-cache'));
  assert.ok(seen.some(item=>item.url.includes('/vncproxy')&&item.headers['cache-control']==='no-cache'));
  assert.equal(seen.some(item=>item.url.includes('/_eagle/')),false,'session prefix must be removed exactly once');
  if(process.env.EAGLE_LAB_SCREENSHOT)await page.screenshot({path:process.env.EAGLE_LAB_SCREENSHOT});
  allowed=false;await lxc.waitForFunction(()=>window.state===window.states?.disconnected);
  assert.deepEqual(errors,[]);console.log('PASS: official PVE xterm LXC PTY, typed commands, Ctrl+C ETX, official patched noVNC RFB rendering/keyboard, CORS and revocation.');
}catch(error){console.error(JSON.stringify({diagnostics,requests:seen.map(item=>item.url),input},null,2));for(const frame of page?.frames()||[]){console.error(frame.url(),await frame.locator('body').innerText().catch(()=>''));}throw error;}
finally{await browser?.close();for(const socket of sockets)socket.terminate();ws.close();for(const server of [front,portal,pve,relay]){server.closeAllConnections();server.close();}}
