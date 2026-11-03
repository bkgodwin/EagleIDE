import http from 'node:http';
import https from 'node:https';
import {gunzipSync, inflateSync, brotliDecompressSync} from 'node:zlib';
import {bridgeSource} from './bridges.mjs';
import {pathRuntimeSource} from './path-runtime.mjs';
import {rewritePathContent} from './path-rewrite.mjs';

const SESSION_COOKIE = '__Host-EagleLab';
const MAX_REWRITE = 32 * 1024 * 1024;
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024;
const HOP = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);
const cleanHeaders = source => {
  const omitted = new Set([...HOP, ...String(source.connection || '').split(',').map(x => x.trim().toLowerCase())]);
  return Object.fromEntries(Object.entries(source).filter(([key]) => !omitted.has(key.toLowerCase())));
};
const cookieValue = (raw, name) => (raw || '').split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1) || '';
const privateIPv4 = value => /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(value) && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value) && value.split('.').every(x=>Number(x)<=255);

export function createGateway({domain, portalOrigin, authorize, upstreamRequest = https.request, recheckMs = 2000, transport='origin'}) {
  const active = new Map(); let globalActive = 0, pendingAuth = 0;
  const waiting=[];
  const pathMode=transport==='path',profiles=new Map();
  const pathParts=req=>{
    const match=/^\/_eagle\/lab\/([a-f0-9]{32})\/(?:(launch)$|([A-Za-z0-9_-]{43})\/(.*)$)/.exec(req.url);
    if(!match)return null;
    const path='/'+(match[4]||'');if(path.startsWith('//')||/[\\\r\n\0]/.test(path))return null;
    return {id:match[1],launch:!!match[2],session:match[3],path,prefix:`/_eagle/lab/${match[1]}/${match[3]}/`};
  };
  const profileFor=access=>{
    for(const [key,value] of profiles)if(value.expires<Date.now())profiles.delete(key);
    if(!profiles.has(access.session)){if(profiles.size>=2048)throw Error('Lab profiles are full');profiles.set(access.session,{cookies:{},local:{},session:{},expires:Date.now()+14400000});}
    return profiles.get(access.session);
  };
  const rememberCookie=(profile,raw)=>{
    const parts=String(raw).split(';'),split=parts[0].indexOf('=');if(split<1)return;
    const key=parts[0].slice(0,split).trim(),value=parts[0].slice(split+1);
    if(!/^[A-Za-z0-9_.-]{1,64}$/.test(key)||['__proto__','constructor','prototype'].includes(key)||value.length>8192)throw Error('Invalid PVE cookie');
    const previous=profile.cookies[key];
    if(parts.slice(1).some(part=>/^\s*max-age\s*=\s*-?0\s*$/i.test(part)||(/^\s*expires=/i.test(part)&&Date.parse(part.slice(part.indexOf('=')+1))<Date.now())))delete profile.cookies[key];else profile.cookies[key]=value;
    if(Buffer.byteLength(JSON.stringify(profile.cookies))>32768||Buffer.byteLength(JSON.stringify(profile))>131072){if(previous===undefined)delete profile.cookies[key];else profile.cookies[key]=previous;throw Error('PVE cookies are too large');}
  };
  const targetFor = req => {
    if(pathMode)return pathParts(req)?.id;
    const host=String(req.headers.host || '').toLowerCase();
    const match=/^s-([a-f0-9]{32})\.([^:]+)(?::[0-9]{1,5})?$/.exec(host);
    return match && match[2]===domain ? match[1] : null;
  };
  const fail = (res, status, text) => {res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(text);};
  function admission(key, releaseOn) {
    if(globalActive>=128||(active.get(key)||0)>=16)return false;
    globalActive++;active.set(key,(active.get(key)||0)+1);
    let done=false;
    const release=()=>{if(done)return;done=true;globalActive--;const count=(active.get(key)||1)-1;if(count)active.set(key,count);else active.delete(key);queueMicrotask(drain);};
    releaseOn.once('close',release);releaseOn.once('finish',release);return true;
  }
  function drain(){
    for(const item of [...waiting])if(!item.response.destroyed&&admission(item.key,item.response)){item.cleanup();item.resolve(true);}
  }
  function waitForTransfer(key,response){
    if(admission(key,response))return Promise.resolve(true);
    if(waiting.length>=256||waiting.filter(item=>item.key===key).length>=64)return Promise.resolve(false);
    return new Promise(resolve=>{
      const item={key,response,resolve,cleanup:()=>{clearTimeout(timer);response.off('close',closed);const index=waiting.indexOf(item);if(index>=0)waiting.splice(index,1);}};
      const closed=()=>{item.cleanup();resolve(false);},timer=setTimeout(closed,15000);timer.unref();response.once('close',closed);waiting.push(item);
    });
  }
  async function grant(req, ticket) {
    const server_id=targetFor(req);
    if(!server_id)return null;
    const session=pathMode?pathParts(req)?.session:cookieValue(req.headers.cookie,SESSION_COOKIE);
    if(!ticket&&!/^[A-Za-z0-9_-]{40,64}$/.test(session))return null;
    if(pendingAuth>=128)return null;
    let result;pendingAuth++;
    try{result=await authorize({server_id,session,...(ticket?{ticket}:{})});}finally{pendingAuth--;}
    const row=result?.server;
    if(!row||row.id!==server_id||!privateIPv4(row.ip)||!Number.isInteger(row.port)||row.port<1||row.port>65535){profiles.delete(session);return null;}
    if(pathMode){const origin=result.portal_origin;if(typeof origin!=='string'||!/^https?:\/\/[A-Za-z0-9.\-:\[\]]+$/.test(origin)||new URL(origin).host!==String(req.headers.host).toLowerCase())return null;}
    return result;
  }
  function options(req, row, websocket=false, access=null) {
    const cookieName='PVEAuthCookie_'+row.id;
    const incoming=websocket?req.headers:cleanHeaders(req.headers);
    const headers={...incoming,host:`${row.ip}:${row.port}`,'accept-encoding':'identity'};
    for(const key of Object.keys(headers)) {
      if(/^x-(?:admin|teacher|user|wiki-manager|lab-gateway)-token$|^x-lab-gateway-key$|^x-eagle-front-|^x-forwarded-|^forwarded$|^proxy-/i.test(key))delete headers[key];
    }
    headers.cookie=cookieValue(req.headers.cookie,cookieName)?`PVEAuthCookie=${cookieValue(req.headers.cookie,cookieName)}`:'';
    if(pathMode)headers.cookie=Object.entries(profileFor(access).cookies).map(([name,value])=>name+'='+value).join('; ');
    if(headers.authorization&&!headers.authorization.startsWith('PVEAPIToken='))delete headers.authorization;
    if(headers.origin)headers.origin=`https://${row.ip}:${row.port}`;
    if(headers.referer)headers.referer=`https://${row.ip}:${row.port}/`;
    return {hostname:row.ip,port:row.port,path:pathMode?pathParts(req).path:req.url,method:req.method,headers,rejectUnauthorized:row.allow_self_signed!==true};
  }
  function originOkay(req, launch=false) {
    if(pathMode)return !req.headers.origin||req.headers.origin==='null'||/^https?:\/\//.test(req.headers.origin);
    const own=`https://${req.headers.host}`;
    if(req.headers.origin)return req.headers.origin===(launch?portalOrigin:own);
    return !launch && (['GET','HEAD'].includes(req.method) || req.headers['sec-fetch-site']==='same-origin');
  }
  async function handler(req,res) {
    try {
      if(!targetFor(req)||!req.url.startsWith('/')||req.url.startsWith('//'))return fail(res,403,'Unregistered lab origin.');
      if((pathMode?pathParts(req)?.launch:req.url==='/_eagle/launch')&&req.method==='POST') {
        if(!originOkay(req,true)||!admission('launch',res))return fail(res,403,'Launch denied.');
        let size=0;const chunks=[];
        for await(const chunk of req){size+=chunk.length;if(size>2048)return fail(res,413,'Launch too large.');chunks.push(chunk);}
        const ticket=new URLSearchParams(Buffer.concat(chunks).toString('utf8')).get('ticket');
        if(!/^[A-Za-z0-9_-]{40,64}$/.test(ticket||''))return fail(res,403,'Invalid launch.');
        const access=await grant(req,ticket);
        if(!access)return fail(res,403,'Launch expired or access was revoked. Reconnect in Eagle Lab.');
        if(pathMode){
          if(req.headers.origin!==access.portal_origin)return fail(res,403,'Launch origin denied.');
          profileFor(access);
          res.writeHead(303,{'Location':`/_eagle/lab/${access.server.id}/${access.session}/`,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});return res.end();
        }
        res.writeHead(303,{'Location':'/','Cache-Control':'no-store','Referrer-Policy':'no-referrer',
          'Set-Cookie':`${SESSION_COOKIE}=${access.session}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=14400`});return res.end();
      }
      if(!originOkay(req))return fail(res,403,'Origin denied.');
      const access=await grant(req);
      if(!access)return fail(res,403,'Unlock this server in Eagle Lab, then reconnect.');
      if(pathMode){
        if(req.headers.origin&&req.headers.origin!=='null'&&req.headers.origin!==access.portal_origin)return fail(res,403,'Origin denied.');
        res.setHeader('Access-Control-Allow-Origin','null');res.setHeader('Vary','Origin');
        res.setHeader('Access-Control-Expose-Headers','Content-Disposition, Content-Length, CSRFPreventionToken');
        if(req.method==='OPTIONS'){
          res.writeHead(204,{'Access-Control-Allow-Methods':'GET, HEAD, POST, PUT, DELETE, OPTIONS','Access-Control-Allow-Headers':'Content-Type, CSRFPreventionToken, X-Requested-With, Authorization, Cache-Control, Pragma','Access-Control-Max-Age':'120'});return res.end();
        }
      }
      if(!await waitForTransfer(access.session,res)){if(!res.destroyed)return fail(res,429,'Too many lab connections.');return;}
      if(!await grant(req))return fail(res,403,'Lab access changed while waiting. Reconnect in Eagle Lab.');
      const upstreamPath=pathMode?pathParts(req).path:req.url;
      if(pathMode&&upstreamPath==='/_eagle/state'&&req.method==='POST'){
        const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>131072)return fail(res,413,'PVE state is too large.');chunks.push(chunk);}
        const change=JSON.parse(Buffer.concat(chunks).toString()),profile=profileFor(access),copy=structuredClone(profile);
        if(typeof change.cookie==='string')rememberCookie(copy,change.cookie);
        else if(['local','session'].includes(change.storage)&&typeof change.key==='string'&&!['__proto__','constructor','prototype'].includes(change.key)){
          if(change.op==='clear')copy[change.storage]={};else if(change.op==='remove')delete copy[change.storage][change.key];else if(change.op==='set'&&typeof change.value==='string')copy[change.storage][change.key]=change.value;else return fail(res,400,'Invalid PVE state');
        }else return fail(res,400,'Invalid PVE state');
        if(Buffer.byteLength(JSON.stringify(copy))>131072)return fail(res,413,'PVE state is too large.');profiles.set(access.session,copy);res.writeHead(200,{'Cache-Control':'no-store'});return res.end('{}');
      }
      if(upstreamPath==='/_eagle/bridge.js') {
        res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
        return res.end(pathMode?pathRuntimeSource({...profileFor(access),prefix:pathParts(req).prefix,origin:access.portal_origin,upstreamOrigin:`https://${access.server.ip}:${access.server.port}`,clipboardKey:access.clipboard_key}):bridgeSource('PVEAuthCookie_'+access.server.id));
      }
      if(!['GET','HEAD','POST','PUT','DELETE','OPTIONS'].includes(req.method))return fail(res,405,'Method not supported.');
      if(Number(req.headers['content-length']||0)>MAX_UPLOAD)return fail(res,413,'Upload exceeds the 2 GiB lab gateway limit.');
      let upstream;
      const recheck=setInterval(async()=>{try{if(!await grant(req)){upstream?.destroy();res.destroy();}}catch{upstream?.destroy();res.destroy();}},recheckMs);recheck.unref();
      res.once('close',()=>{clearInterval(recheck);upstream?.destroy();});
      upstream=upstreamRequest(options(req,access.server,false,access), incoming=>{
        const headers=cleanHeaders(incoming.headers),type=String(headers['content-type']||'');
        delete headers['x-frame-options'];delete headers['content-security-policy'];delete headers['content-security-policy-report-only'];
        headers['content-security-policy']=`default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' wss://${req.headers.host}; frame-src 'self' blob:; frame-ancestors ${portalOrigin} 'self'; form-action 'self'; base-uri 'self'; object-src 'none'`;
        if(pathMode){
          const address=access.portal_origin+pathParts(req).prefix,ws=address.replace(/^http/,'ws');
          headers['content-security-policy']=`default-src ${address} data: blob:; script-src ${address} 'unsafe-inline' 'unsafe-eval' blob:; style-src ${address} 'unsafe-inline'; connect-src ${address} ${ws}; frame-src ${address} blob:; form-action ${address}; base-uri ${address}; object-src 'none'; sandbox allow-scripts allow-forms allow-downloads allow-modals allow-popups allow-pointer-lock`;
          headers['access-control-allow-origin']='null';delete headers['access-control-allow-credentials'];headers.vary='Origin';
        }
        headers['permissions-policy']='clipboard-read=(*), clipboard-write=(*), fullscreen=(*)';
        headers['cache-control']='no-store';headers['referrer-policy']='no-referrer';headers['x-content-type-options']='nosniff';
        // Forward only PVE's session cookie, never a Domain cookie or an EagleIDE cookie.
        if(headers['set-cookie'])headers['set-cookie']=headers['set-cookie'].filter(value=>/^PVEAuthCookie=/.test(value)).map(value=>value.replace(/^PVEAuthCookie=/,'PVEAuthCookie_'+access.server.id+'=').replace(/;\s*(?:domain|path|samesite)=[^;]*/ig,'').replace(/;\s*(?:secure|partitioned)\b/ig,'')+'; Path=/; Secure; SameSite=None; Partitioned');
        if(pathMode){try{for(const value of incoming.headers['set-cookie']||[])rememberCookie(profileFor(access),value);}catch{incoming.destroy();return fail(res,502,'PVE returned invalid cookies.');}delete headers['set-cookie'];}
        if(headers.location) {
          let target;
          try{target=new URL(headers.location,`https://${access.server.ip}:${access.server.port}`);}catch{incoming.destroy();return fail(res,502,'PVE returned an invalid redirect.');}
          if(target.origin!==`https://${access.server.ip}:${access.server.port}`){incoming.destroy();return fail(res,502,'PVE redirected outside its enrolled server.');}
          headers.location=target.pathname+target.search+target.hash;
          if(pathMode)headers.location=pathParts(req).prefix+headers.location.slice(1);
        }
        if(req.method!=='HEAD'&&/javascript|text\/html|text\/css/i.test(type)) {
          const chunks=[];let size=0;
          incoming.on('data',chunk=>{size+=chunk.length;if(size>MAX_REWRITE)incoming.destroy();else chunks.push(chunk);});
          incoming.on('error',()=>{if(!res.headersSent)fail(res,502,'PVE response interrupted.');else res.destroy();});
          incoming.on('end',()=>{
            try {
              let data=Buffer.concat(chunks);const encoding=String(incoming.headers['content-encoding']||'identity').toLowerCase();
              const decoder={gzip:gunzipSync,deflate:inflateSync,br:brotliDecompressSync}[encoding];
              if(decoder)data=decoder(data,{maxOutputLength:MAX_REWRITE});else if(encoding!=='identity')throw Error();
              let source=data.toString('utf8');
              if(pathMode)source=rewritePathContent(source,type,pathParts(req).prefix,access.portal_origin);
              else {source=source.replaceAll('PVEAuthCookie','PVEAuthCookie_'+access.server.id);if(/text\/html/i.test(type)){const script='<script src="/_eagle/bridge.js"></script>';source=/<head\b[^>]*>/i.test(source)?source.replace(/<head\b[^>]*>/i,head=>head+script):script+source;}}
              delete headers['content-length'];delete headers['content-encoding'];delete headers.etag;
              res.writeHead(incoming.statusCode,headers);res.end(source);
            }catch{fail(res,502,'Could not prepare the PVE management interface.');}
          });
        } else {res.writeHead(incoming.statusCode,headers);incoming.pipe(res);incoming.on('error',()=>res.destroy());}
      });
      upstream.setTimeout(120000,()=>upstream.destroy());
      upstream.on('error',()=>{if(!res.headersSent)fail(res,502,'PVE is unavailable. Check its LAN connection.');else res.destroy();});
      let uploaded=0;req.on('data',chunk=>{uploaded+=chunk.length;if(uploaded>MAX_UPLOAD){upstream.destroy();req.destroy();}});
      req.on('aborted',()=>upstream.destroy());req.pipe(upstream);
    }catch{if(!res.headersSent)fail(res,503,'Lab authorization is unavailable. Reconnect in Eagle Lab.');else res.destroy();}
  }
  const server=http.createServer(handler);
  server.requestTimeout=30*60*1000;server.headersTimeout=15000;
  server.on('upgrade',async(req,socket,head)=>{
    let remote,upstream,watch;
    const close=()=>{clearInterval(watch);remote?.destroy();upstream?.destroy();socket.destroy();};
    socket.on('error',close);socket.once('close',close);
    try {
      const wsPath=pathMode?pathParts(req)?.path:req.url;
      if(!targetFor(req)||!originOkay(req)||!/^\/api2\/(?:json|extjs)\/.*\/(?:vncwebsocket|termwebsocket)(?:\?|$)/.test(wsPath))return socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      const access=await grant(req);
      if(!access)return socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      if(pathMode&&req.headers.origin!=='null'&&req.headers.origin!==access.portal_origin)return socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      if(!admission(access.session,socket))return socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      upstream=upstreamRequest(options(req,access.server,true,access));
      upstream.setTimeout(15000,close);
      upstream.on('upgrade',(response,peer,upstreamHead)=>{
        remote=peer;upstream.setTimeout(0);peer.setTimeout(0);socket.setTimeout(0);
        const headers=Object.entries(response.headers).filter(([key])=>!['set-cookie','server'].includes(key));
        socket.write('HTTP/1.1 101 Switching Protocols\r\n'+headers.map(([key,value])=>`${key}: ${value}`).join('\r\n')+'\r\n\r\n');
        if(upstreamHead.length)socket.write(upstreamHead);if(head.length)peer.write(head);
        peer.pipe(socket);socket.pipe(peer);peer.on('error',close);peer.once('close',close);
        let checking=false;
        watch=setInterval(async()=>{if(checking)return;checking=true;try{if(!await grant(req))close();}catch{close();}finally{checking=false;}},recheckMs);watch.unref();
      });
      upstream.on('response',response=>{response.resume();socket.end(`HTTP/1.1 ${response.statusCode||502} ${http.STATUS_CODES[response.statusCode]||'Upstream Error'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);});
      upstream.on('error',close);upstream.end();
    }catch{close();}
  });
  return server;
}
