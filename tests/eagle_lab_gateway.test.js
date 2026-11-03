const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const vm = require('node:vm');

const id = 'a'.repeat(32), session = 's'.repeat(43), ticket = 't'.repeat(43);
const host = `s-${id}.pve.school.test`, origin = `https://${host}`;
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}
async function fixture(t,transport='origin') {
  const {createGateway} = await import('../lab_gateway/proxy.mjs');
  const received = [];
  const upstream = http.createServer((req, res) => {
    received.push({url:req.url,headers:req.headers});
    if(req.url==='/slow')setTimeout(()=>res.end('loaded'),20);
    else if(req.url==='/html') {res.writeHead(200,{'Content-Type':'text/html','X-Frame-Options':'SAMEORIGIN'});res.end('<html><head></head><script>document.cookie="PVEAuthCookie=ticket; Secure"</script></html>');}
    else if(req.url==='/login') {res.writeHead(200,{'Content-Type':'application/json','Set-Cookie':'PVEAuthCookie=private; Path=/; Secure; Domain=10.0.0.10'});res.end('{}');}
    else if(req.url==='/reject') {res.writeHead(401);res.end();}
    else {res.writeHead(200,{'Content-Type':'application/octet-stream'});req.pipe(res);}
  });
  upstream.on('upgrade',(req,socket)=>{
    received.push({url:req.url,headers:req.headers});
    if(req.url.includes('reject'))return socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: binary\r\n\r\n`);
    socket.write(Buffer.from([0x82,3,82,70,66])); // noVNC/RFB binary greeting
    socket.on('data',data=>socket.write(data));socket.on('error',()=>{});
  });
  const upstreamPort=await listen(upstream);
  const state={allowed:true};
  const gateway=createGateway({domain:'pve.school.test',portalOrigin:'https://ide.school.test',recheckMs:25,transport,
    authorize:async body=>state.allowed&&body.server_id===id&&(body.session===session||body.ticket===ticket)
      ? {session,portal_origin:'https://ide.school.test',clipboard_key:'c'.repeat(43),server:{id,ip:'10.0.0.10',port:8006,allow_self_signed:true,revision:1}} : null,
    upstreamRequest:(options,callback)=>{
      assert.equal(options.hostname,'10.0.0.10');assert.equal(options.port,8006);assert.equal(options.rejectUnauthorized,false);
      return http.request({...options,hostname:'127.0.0.1',port:upstreamPort},callback);
    }});
  const port=await listen(gateway);
  t.after(()=>{gateway.closeAllConnections();gateway.close();upstream.closeAllConnections();upstream.close();});
  const request=(path,headers={},method='GET',body)=>new Promise((resolve,reject)=>{
    if(transport==='path')path=path==='/_eagle/launch'?`/_eagle/lab/${id}/launch`:`/_eagle/lab/${id}/${session}`+path;
    const req=http.request({hostname:'127.0.0.1',port,path,method,headers:{Host:transport==='path'?'ide.school.test':host,Cookie:`__Host-EagleLab=${session}; PVEAuthCookie_${id}=pve-session; EagleIDE=must-not-forward`,...headers}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:new Headers(Object.entries(res.headers).map(([key,value])=>[key,Array.isArray(value)?value.join(','):value])),text:async()=>Buffer.concat(chunks).toString()}));res.on('error',reject);
    });req.on('error',reject);req.end(body===undefined?undefined:String(body));
  });
  return {gateway,port,state,request,received};
}

test('PVE management pages allow only the portal and nested same-node frames; cookies and EagleIDE headers are isolated',async t=>{
  const f=await fixture(t);
  const page=await f.request('/html',{'X-User-Token':'secret-ide-token','X-Lab-Gateway-Key':'never-forward'});
  assert.equal(page.status,200);
  const html=await page.text();
  assert.match(html,/<head><script src="\/_eagle\/bridge.js"><\/script>/);
  assert.match(html,new RegExp('PVEAuthCookie_'+id));
  assert.equal(page.headers.get('x-frame-options'),null);
  assert.match(page.headers.get('content-security-policy'),/frame-ancestors https:\/\/ide.school.test 'self'/);
  assert.match(page.headers.get('permissions-policy'),/clipboard-read/);
  assert.equal(f.received[0].headers.cookie,'PVEAuthCookie=pve-session');
  assert.equal(f.received[0].headers['x-user-token'],undefined);
  assert.equal(f.received[0].headers['x-lab-gateway-key'],undefined);
  const login=await f.request('/login',{Origin:origin},'POST','login=data');await login.text();
  const cookie=login.headers.get('set-cookie');
  assert.match(cookie,new RegExp('PVEAuthCookie_'+id));assert.doesNotMatch(cookie,/Domain=/i);assert.match(cookie,/Secure; SameSite=None; Partitioned/);
});

test('one-time launch POST sets a host-only HttpOnly gateway cookie without putting capabilities in URLs',async t=>{
  const f=await fixture(t);
  const response=await f.request('/_eagle/launch',{Origin:'https://ide.school.test'},'POST',new URLSearchParams({ticket}));
  assert.equal(response.status,303);assert.equal(response.headers.get('location'),'/');
  assert.match(response.headers.get('set-cookie'),/^__Host-EagleLab=.*HttpOnly; Secure; SameSite=None; Partitioned/);
  assert.equal(f.received.length,0);
  const denied=await f.request('/_eagle/launch',{Origin:'https://evil.test'},'POST',new URLSearchParams({ticket}));
  assert.equal(denied.status,403);
});

test('unknown node origins, forged sessions and cross-origin mutations fail before contacting PVE',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/',{Host:'code.school.test'})).status,403);
  assert.equal((await f.request('/',{Cookie:'__Host-EagleLab=forged'})).status,403);
  assert.equal((await f.request('/api2/json/nodes',{Origin:'https://evil.test'},'POST','data')).status,403);
  assert.equal(f.received.length,0);
});

test('authenticated PVE API writes and binary uploads/downloads are streamed unchanged',async t=>{
  const f=await fixture(t);
  const data='API payload '.repeat(10000);
  const response=await f.request('/api2/json/nodes/pve/storage/upload',{Origin:origin,'Content-Type':'application/octet-stream'},'POST',data);
  assert.equal(response.status,200);assert.equal(await response.text(),data);
  assert.equal(f.received[0].headers.origin,'https://10.0.0.10:8006');
  f.state.allowed=false;
  const denied=await f.request('/html');assert.equal(denied.status,403);
  assert.equal(f.received.length,1);
});

function rawSocket(port,path,requestOrigin=origin,requestHost=host) {
  const socket=net.connect(port,'127.0.0.1');let chunks=[];
  const connected=new Promise((resolve,reject)=>{
    socket.on('error',reject);
    socket.on('data',chunk=>{chunks.push(chunk);if(Buffer.concat(chunks).includes(Buffer.from('\r\n\r\n')))resolve();});
    socket.on('connect',()=>socket.write(`GET ${path} HTTP/1.1\r\nHost: ${requestHost}\r\nOrigin: ${requestOrigin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: binary\r\nCookie: __Host-EagleLab=${session}; PVEAuthCookie_${id}=pve-session\r\n\r\n`));
  });
  return {socket,connected,data:()=>Buffer.concat(chunks)};
}

test('nested noVNC preserves tickets and binary subprotocol, tunnels RFB bytes, and closes after revocation',async t=>{
  const f=await fixture(t);
  const path='/api2/json/nodes/pve/qemu/100/vncwebsocket?port=5900&vncticket=PVEVNC%3Aticket%2B%3D';
  const ws=rawSocket(f.port,path);t.after(()=>ws.socket.destroy());
  await ws.connected;
  if(!ws.data().includes(Buffer.from([0x82,3,82,70,66])))await new Promise(resolve=>ws.socket.once('data',resolve));
  assert.match(ws.data().toString('latin1'),/101 Switching Protocols/);
  assert.match(ws.data().toString('latin1'),/sec-websocket-protocol: binary/i);
  assert.ok(ws.data().includes(Buffer.from([0x82,3,82,70,66])));
  assert.equal(f.received[0].url,path);
  assert.equal(f.received[0].headers.cookie,'PVEAuthCookie=pve-session');
  const payload=Buffer.from([0x82,0x83,1,2,3,4,96,96,96]);
  const echoed=new Promise(resolve=>ws.socket.once('data',resolve));ws.socket.write(payload);
  assert.deepEqual(await echoed,payload);
  const closed=new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Revoked console stayed connected')),1500);ws.socket.once('close',()=>{clearTimeout(timeout);resolve();});});
  f.state.allowed=false;await closed;
});

test('PVE upgrade rejection keeps the real HTTP status',async t=>{
  const f=await fixture(t);const ws=rawSocket(f.port,'/api2/json/nodes/reject/vncwebsocket');t.after(()=>ws.socket.destroy());await ws.connected;
  assert.match(ws.data().toString(),/^HTTP\/1.1 401 Unauthorized/);
});

test('PVE cookie bridge preserves clipboard-compatible secure partitioned cookies and WebSocket binary protocols',async()=>{
  const {bridgeSource}=await import('../lab_gateway/bridges.mjs');let assigned;const calls=[];
  class Document{};Object.defineProperty(Document.prototype,'cookie',{get:()=>assigned||'',set:value=>{assigned=value;}});
  class Socket{constructor(...args){calls.push(args);}send(){}close(){}}
  const document=new Document(),window={WebSocket:Socket};
  vm.runInNewContext(bridgeSource('PVEAuthCookie_'+id),{document,Document,window,URL,location:{href:origin+'/',host,protocol:'https:'}});
  document.cookie='PVEAuthCookie=ticket; Secure; Path=/; Domain=school.test';
  assert.match(assigned,new RegExp('^PVEAuthCookie_'+id+'=ticket'));
  assert.doesNotMatch(assigned,/Domain=/);assert.match(assigned,/Secure; SameSite=None; Partitioned/);
  const socket=new window.WebSocket('ws://'+host+'/api2/json/nodes/pve/qemu/100/vncwebsocket?ticket=x',['binary']);
  assert.equal(Object.getPrototypeOf(socket),Socket.prototype);assert.ok(Object.getOwnPropertyNames(Object.getPrototypeOf(socket)).includes('send'));
  assert.match(calls[0][0],/^wss:/);assert.deepEqual(calls[0][1],['binary']);
});

test('single-address pages stay opaque even on direct navigation and use only session-local PVE state',async t=>{
  const f=await fixture(t,'path'),prefix=`/_eagle/lab/${id}/${session}/`;
  const launch=await f.request('/_eagle/launch',{Origin:'https://ide.school.test'},'POST',new URLSearchParams({ticket}));
  assert.equal(launch.status,303);assert.equal(launch.headers.get('location'),prefix);assert.equal(launch.headers.get('set-cookie'),null);
  const page=await f.request('/html');const html=await page.text();
  assert.match(html,new RegExp('<base href="https://ide.school.test'+prefix+'">'));
  assert.ok(html.includes(`src="${prefix}_eagle/bridge.js"`));
  const policy=page.headers.get('content-security-policy');assert.match(policy,/sandbox allow-scripts/);assert.doesNotMatch(policy,/allow-same-origin/);
  assert.equal(page.headers.get('access-control-allow-origin'),'null');
  const saved=await f.request('/_eagle/state',{Origin:'null'},'POST',JSON.stringify({cookie:'PVEAuthCookie=opaque-ticket; Secure; Path=/'}));assert.equal(saved.status,200);
  const next=await f.request('/html');await next.text();assert.equal(f.received.at(-1).headers.cookie,'PVEAuthCookie=opaque-ticket');
  const bridge=await f.request('/_eagle/bridge.js',{Origin:'null'});assert.match(await bridge.text(),/opaque-ticket/);
  const denied=await f.request('/html',{Origin:'https://unrelated.test'});assert.equal(denied.status,403);
});

test('single-address console WebSockets use opaque Origin and server-side PVE cookies',async t=>{
  const f=await fixture(t,'path');
  await f.request('/_eagle/state',{Origin:'null'},'POST',JSON.stringify({cookie:'PVEAuthCookie=console-session; Secure'}));
  const ws=rawSocket(f.port,`/_eagle/lab/${id}/${session}/api2/json/nodes/pve/qemu/100/vncwebsocket?port=5900&vncticket=kept%2Bticket`,'null','ide.school.test');t.after(()=>ws.socket.destroy());await ws.connected;
  assert.match(ws.data().toString('latin1'),/101 Switching Protocols/);assert.equal(f.received.at(-1).headers.cookie,'PVEAuthCookie=console-session');
  assert.equal(f.received.at(-1).url,'/api2/json/nodes/pve/qemu/100/vncwebsocket?port=5900&vncticket=kept%2Bticket');
  f.state.allowed=false;await new Promise(resolve=>ws.socket.once('close',resolve));
});

test('path rewriting preserves PVE API semantics and rewrites static assets, CSS, modules and console reloads',async()=>{
  const {rewritePathContent}=await import('../lab_gateway/path-rewrite.mjs');const prefix='/_eagle/lab/node/session/';
  const html=rewritePathContent('<head><script src="/pve2/main.js"></script><link href="/pwt/style.css"></head>','text/html',prefix,'https://ide.school.test');
  assert.ok(html.includes('src="'+prefix+'pve2/main.js"'));assert.ok(html.includes('href="'+prefix+'pwt/style.css"'));
  assert.equal(rewritePathContent('a{background:url(/pve2/image.svg)}','text/css',prefix,''),'a{background:url('+prefix+'pve2/image.svg)}');
  const js=rewritePathContent('import RFB from "/novnc/core/rfb.js";const api="/api2/json";box.getWin().location.reload();','text/javascript',prefix,'');
  assert.ok(js.includes(prefix+'novnc/core/rfb.js'));assert.ok(js.includes('api="/api2/json"'));assert.ok(js.includes('box.load(box.getFrame().src)'));
  const template=rewritePathContent('<head><script type="module">import UI from "/novnc/app.js";UI.start();</script></head>','text/html',prefix,'https://ide.school.test');
  assert.ok(template.includes(`import UI from "${prefix}novnc/app.js"`));
});

test('opaque console API preflights permit the headers sent by real PVE xterm and noVNC clients',async t=>{
  const f=await fixture(t,'path');
  const response=await f.request('/api2/json/nodes/pve/lxc/100/termproxy',{Origin:'null','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'cache-control,csrfpreventiontoken,content-type'},'OPTIONS');
  assert.equal(response.status,204);assert.equal(response.headers.get('access-control-allow-origin'),'null');
  const allowed=response.headers.get('access-control-allow-headers').toLowerCase().split(/,\s*/);
  for(const header of ['cache-control','csrfpreventiontoken','content-type'])assert.ok(allowed.includes(header));
  assert.equal(f.received.length,0,'preflight must not contact PVE');
});

test('path WebSocket bridge retains the native prototype required by noVNC and never doubles a session prefix',async()=>{
  const {pathRuntimeSource}=await import('../lab_gateway/path-runtime.mjs');const urls=[];
  class NativeSocket{static OPEN=1;constructor(url,protocols){urls.push({url,protocols});}send(){}close(){}get binaryType(){return 'arraybuffer';}}
  class XHR{open(){}send(){}}
  class Element{setAttribute(){}}
  const document={baseURI:'https://ide.school.test/_eagle/lab/node/session/'};
  const window={XMLHttpRequest:XHR,WebSocket:NativeSocket,fetch(){},open(){},addEventListener(){}};window.top=window;
  const sandbox={window,document,navigator:{},location:{protocol:'https:'},URL,Map,Proxy,Object,Element,MutationObserver:class{observe(){}}};
  vm.runInNewContext(pathRuntimeSource({prefix:'/_eagle/lab/node/session/',origin:'https://ide.school.test',upstreamOrigin:'https://10.0.0.1:8006'}),sandbox);
  for(const url of ['wss://ide.school.test/api2/json/nodes/pve/qemu/100/vncwebsocket?ticket=x','wss://ide.school.test/_eagle/lab/node/session/api2/json/nodes/pve/qemu/100/vncwebsocket?ticket=x']){
    const socket=new window.WebSocket(url,['binary']);
    assert.equal(Object.getPrototypeOf(socket),NativeSocket.prototype);
    for(const property of ['send','close','binaryType'])assert.ok(Object.getOwnPropertyNames(Object.getPrototypeOf(socket)).includes(property));
    assert.ok(socket instanceof window.WebSocket);assert.equal(window.WebSocket.OPEN,1);
  }
  assert.equal(urls[0].url,'wss://ide.school.test/_eagle/lab/node/session/api2/json/nodes/pve/qemu/100/vncwebsocket?ticket=x');assert.equal(urls[1].url,urls[0].url);
});

test('automatic front preserves ordinary EagleIDE responses and replaces forged transport-peer headers',async t=>{
  const {installApplicationForwarding}=await import('../lab_gateway/front.mjs');let received;
  const app=http.createServer((req,res)=>{received=req.headers;res.writeHead(200,{'Content-Type':'application/octet-stream','Cache-Control':'private, no-store'});req.pipe(res);});
  const backendPort=await listen(app),lab=http.createServer((_req,res)=>res.end('lab')),front=http.createServer();
  installApplicationForwarding(front,lab,{backendPort,key:'private-front-key'});const port=await listen(front);
  t.after(()=>{for(const server of [front,lab,app]){server.closeAllConnections();server.close();}});
  const response=await fetch(`http://127.0.0.1:${port}/api/files/save`,{method:'POST',headers:{'X-User-Token':'kept','X-Eagle-Front-Peer':'8.8.8.8','X-Eagle-Front-Key':'forged'},body:'normal EagleIDE payload'});
  assert.equal(await response.text(),'normal EagleIDE payload');assert.equal(response.headers.get('cache-control'),'private, no-store');
  assert.equal(received['x-user-token'],'kept');assert.equal(received['x-eagle-front-key'],'private-front-key');assert.equal(received['x-eagle-front-peer'],'127.0.0.1');
});

test('PVE asset bursts queue behind bounded transfers instead of failing module loads',async t=>{
  const f=await fixture(t,'path');const responses=await Promise.all(Array.from({length:50},()=>f.request('/slow')));
  assert.ok(responses.every(response=>response.status===200));assert.equal(f.received.length,50);
});

test('ordinary EagleIDE WebSocket upgrades and bytes pass through the automatic front unchanged',async t=>{
  const {installApplicationForwarding}=await import('../lab_gateway/front.mjs');let headers;
  const app=http.createServer();app.on('upgrade',(req,socket)=>{
    headers=req.headers;const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);socket.on('data',data=>socket.write(data));socket.on('end',()=>socket.destroy());socket.on('error',()=>{});
  });
  const backendPort=await listen(app),lab=http.createServer(),front=http.createServer();installApplicationForwarding(front,lab,{backendPort,key:'front-key'});const port=await listen(front);
  const ws=rawSocket(port,'/socket.io/?EIO=4&transport=websocket');t.after(()=>{ws.socket.destroy();for(const server of [front,lab,app]){server.closeAllConnections();server.close();}});await ws.connected;
  assert.match(ws.data().toString(),/101 Switching Protocols/);assert.equal(headers['x-eagle-front-key'],'front-key');assert.equal(headers.origin,origin);
  const payload=Buffer.from([0x82,0x83,1,2,3,4,96,96,96]);const echoed=new Promise(resolve=>ws.socket.once('data',resolve));ws.socket.write(payload);assert.deepEqual(await echoed,payload);
});
