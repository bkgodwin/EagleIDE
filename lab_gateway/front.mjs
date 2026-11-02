// Fixed loopback application forwarding. Not an arbitrary destination proxy.
import http from 'node:http';

export function installApplicationForwarding(server,labServer,{backendPort,key}) {
  const headers=req=>{
    const result={...req.headers};delete result['x-eagle-front-key'];delete result['x-eagle-front-peer'];
    result['x-eagle-front-key']=key;result['x-eagle-front-peer']=req.socket.remoteAddress||'127.0.0.1';return result;
  };
  server.on('request',(req,res)=>{
    if(req.url.startsWith('/_eagle/lab/'))return labServer.emit('request',req,res);
    const upstream=http.request({hostname:'127.0.0.1',port:backendPort,path:req.url,method:req.method,headers:headers(req)},incoming=>{
      res.writeHead(incoming.statusCode,incoming.headers);incoming.pipe(res);incoming.on('error',()=>res.destroy());
    });
    upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502,{'Content-Type':'text/plain','Cache-Control':'no-store'});res.end('EagleIDE is starting or unavailable.');});
    req.on('aborted',()=>upstream.destroy());res.on('close',()=>upstream.destroy());req.pipe(upstream);
  });
  server.on('upgrade',(req,socket,head)=>{
    if(req.url.startsWith('/_eagle/lab/'))return labServer.emit('upgrade',req,socket,head);
    const upstream=http.request({hostname:'127.0.0.1',port:backendPort,path:req.url,method:req.method,headers:headers(req)});
    let peer;
    const close=()=>{peer?.destroy();upstream.destroy();socket.destroy();};
    socket.on('error',close);socket.on('close',close);
    upstream.on('upgrade',(response,remote,upstreamHead)=>{
      peer=remote;socket.write('HTTP/1.1 101 Switching Protocols\r\n'+Object.entries(response.headers).map(([name,value])=>`${name}: ${value}`).join('\r\n')+'\r\n\r\n');
      if(upstreamHead.length)socket.write(upstreamHead);if(head.length)remote.write(head);remote.pipe(socket);socket.pipe(remote);remote.on('error',close);remote.on('close',close);
    });
    upstream.on('response',response=>{response.resume();socket.end(`HTTP/1.1 ${response.statusCode||502} ${http.STATUS_CODES[response.statusCode]||'Error'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);});
    upstream.on('error',close);upstream.end();
  });
}
