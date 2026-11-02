import http from 'node:http';
import https from 'node:https';
import {gunzipSync, inflateSync, brotliDecompressSync} from 'node:zlib';
import {bridgeSource} from './bridges.mjs';

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

export function createGateway({domain, portalOrigin, authorize, upstreamRequest = https.request, recheckMs = 2000}) {
  const active = new Map(); let globalActive = 0, pendingAuth = 0;
  const targetFor = req => {
    const host=String(req.headers.host || '').toLowerCase();
    const match=/^s-([a-f0-9]{32})\.([^:]+)(?::[0-9]{1,5})?$/.exec(host);
    return match && match[2]===domain ? match[1] : null;
  };
  const fail = (res, status, text) => {res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(text);};
  function admission(key, releaseOn) {
    if(globalActive>=128||(active.get(key)||0)>=16)return false;
    globalActive++;active.set(key,(active.get(key)||0)+1);
    let done=false;
    const release=()=>{if(done)return;done=true;globalActive--;const count=(active.get(key)||1)-1;if(count)active.set(key,count);else active.delete(key);};
    releaseOn.once('close',release);releaseOn.once('finish',release);return true;
  }
  async function grant(req, ticket) {
    const server_id=targetFor(req);
    if(!server_id)return null;
    const session=cookieValue(req.headers.cookie,SESSION_COOKIE);
    if(!ticket&&!/^[A-Za-z0-9_-]{40,64}$/.test(session))return null;
    if(pendingAuth>=32)return null;
    let result;pendingAuth++;
    try{result=await authorize({server_id,session,...(ticket?{ticket}:{})});}finally{pendingAuth--;}
    const row=result?.server;
    if(!row||row.id!==server_id||!privateIPv4(row.ip)||!Number.isInteger(row.port)||row.port<1||row.port>65535)return null;
    return result;
  }
  function options(req, row, websocket=false) {
    const cookieName='PVEAuthCookie_'+row.id;
    const incoming=websocket?req.headers:cleanHeaders(req.headers);
    const headers={...incoming,host:`${row.ip}:${row.port}`,'accept-encoding':'identity'};
    for(const key of Object.keys(headers)) {
      if(/^x-(?:admin|teacher|user|wiki-manager|lab-gateway)-token$|^x-lab-gateway-key$|^x-forwarded-|^forwarded$|^proxy-/i.test(key))delete headers[key];
    }
    headers.cookie=cookieValue(req.headers.cookie,cookieName)?`PVEAuthCookie=${cookieValue(req.headers.cookie,cookieName)}`:'';
    if(headers.authorization&&!headers.authorization.startsWith('PVEAPIToken='))delete headers.authorization;
    if(headers.origin)headers.origin=`https://${row.ip}:${row.port}`;
    if(headers.referer)headers.referer=`https://${row.ip}:${row.port}/`;
    return {hostname:row.ip,port:row.port,path:req.url,method:req.method,headers,rejectUnauthorized:row.allow_self_signed!==true};
  }
  function originOkay(req, launch=false) {
    const own=`https://${req.headers.host}`;
    if(req.headers.origin)return req.headers.origin===(launch?portalOrigin:own);
    return !launch && (['GET','HEAD'].includes(req.method) || req.headers['sec-fetch-site']==='same-origin');
  }
  async function handler(req,res) {
    try {
      if(!targetFor(req)||!req.url.startsWith('/')||req.url.startsWith('//'))return fail(res,403,'Unregistered lab origin.');
      if(req.url==='/_eagle/launch'&&req.method==='POST') {
        if(!originOkay(req,true)||!admission('launch',res))return fail(res,403,'Launch denied.');
        let size=0;const chunks=[];
        for await(const chunk of req){size+=chunk.length;if(size>2048)return fail(res,413,'Launch too large.');chunks.push(chunk);}
        const ticket=new URLSearchParams(Buffer.concat(chunks).toString('utf8')).get('ticket');
        if(!/^[A-Za-z0-9_-]{40,64}$/.test(ticket||''))return fail(res,403,'Invalid launch.');
        const access=await grant(req,ticket);
        if(!access)return fail(res,403,'Launch expired or access was revoked. Reconnect in Eagle Lab.');
        res.writeHead(303,{'Location':'/','Cache-Control':'no-store','Referrer-Policy':'no-referrer',
          'Set-Cookie':`${SESSION_COOKIE}=${access.session}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=14400`});return res.end();
      }
      if(!originOkay(req))return fail(res,403,'Origin denied.');
      const access=await grant(req);
      if(!access)return fail(res,403,'Unlock this server in Eagle Lab, then reconnect.');
      if(!admission(access.session,res))return fail(res,429,'Too many lab connections.');
      if(req.url==='/_eagle/bridge.js') {
        res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
        return res.end(bridgeSource('PVEAuthCookie_'+access.server.id));
      }
      if(!['GET','HEAD','POST','PUT','DELETE','OPTIONS'].includes(req.method))return fail(res,405,'Method not supported.');
      if(Number(req.headers['content-length']||0)>MAX_UPLOAD)return fail(res,413,'Upload exceeds the 2 GiB lab gateway limit.');
      let upstream;
      const recheck=setInterval(async()=>{try{if(!await grant(req)){upstream?.destroy();res.destroy();}}catch{upstream?.destroy();res.destroy();}},recheckMs);recheck.unref();
      res.once('close',()=>{clearInterval(recheck);upstream?.destroy();});
      upstream=upstreamRequest(options(req,access.server), incoming=>{
        const headers=cleanHeaders(incoming.headers),type=String(headers['content-type']||'');
        delete headers['x-frame-options'];delete headers['content-security-policy'];delete headers['content-security-policy-report-only'];
        headers['content-security-policy']=`default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' wss://${req.headers.host}; frame-src 'self' blob:; frame-ancestors ${portalOrigin} 'self'; form-action 'self'; base-uri 'self'; object-src 'none'`;
        headers['permissions-policy']='clipboard-read=(*), clipboard-write=(*), fullscreen=(*)';
        headers['cache-control']='no-store';headers['referrer-policy']='no-referrer';headers['x-content-type-options']='nosniff';
        // Forward only PVE's session cookie, never a Domain cookie or an EagleIDE cookie.
        if(headers['set-cookie'])headers['set-cookie']=headers['set-cookie'].filter(value=>/^PVEAuthCookie=/.test(value)).map(value=>value.replace(/^PVEAuthCookie=/,'PVEAuthCookie_'+access.server.id+'=').replace(/;\s*(?:domain|path|samesite)=[^;]*/ig,'').replace(/;\s*(?:secure|partitioned)\b/ig,'')+'; Path=/; Secure; SameSite=None; Partitioned');
        if(headers.location) {
          let target;
          try{target=new URL(headers.location,`https://${access.server.ip}:${access.server.port}`);}catch{incoming.destroy();return fail(res,502,'PVE returned an invalid redirect.');}
          if(target.origin!==`https://${access.server.ip}:${access.server.port}`){incoming.destroy();return fail(res,502,'PVE redirected outside its enrolled server.');}
          headers.location=target.pathname+target.search+target.hash;
        }
        if(req.method!=='HEAD'&&/javascript|text\/html/i.test(type)) {
          const chunks=[];let size=0;
          incoming.on('data',chunk=>{size+=chunk.length;if(size>MAX_REWRITE)incoming.destroy();else chunks.push(chunk);});
          incoming.on('error',()=>{if(!res.headersSent)fail(res,502,'PVE response interrupted.');else res.destroy();});
          incoming.on('end',()=>{
            try {
              let data=Buffer.concat(chunks);const encoding=String(incoming.headers['content-encoding']||'identity').toLowerCase();
              const decoder={gzip:gunzipSync,deflate:inflateSync,br:brotliDecompressSync}[encoding];
              if(decoder)data=decoder(data,{maxOutputLength:MAX_REWRITE});else if(encoding!=='identity')throw Error();
              let source=data.toString('utf8').replaceAll('PVEAuthCookie','PVEAuthCookie_'+access.server.id);
              if(/text\/html/i.test(type)){const script='<script src="/_eagle/bridge.js"></script>';source=/<head\b[^>]*>/i.test(source)?source.replace(/<head\b[^>]*>/i,head=>head+script):script+source;}
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
      if(!targetFor(req)||!originOkay(req)||!/^\/api2\/(?:json|extjs)\/.*\/(?:vncwebsocket|termwebsocket)(?:\?|$)/.test(req.url))return socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      const access=await grant(req);
      if(!access)return socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      if(!admission(access.session,socket))return socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      upstream=upstreamRequest(options(req,access.server,true));
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
