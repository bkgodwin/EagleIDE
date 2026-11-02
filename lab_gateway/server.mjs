import http from 'node:http';
import {createGateway} from './proxy.mjs';
import {installApplicationForwarding} from './front.mjs';

const domain=process.env.EAGLEIDE_LAB_PROXY_DOMAIN;
const portalOrigin=process.env.EAGLEIDE_PUBLIC_ORIGIN;
const secret=process.env.EAGLEIDE_LAB_GATEWAY_SECRET;
const transport=process.env.EAGLEIDE_LAB_TRANSPORT||'origin';
const internal=new URL('/api/eagle-lab/gateway/authorize',process.env.EAGLEIDE_LAB_INTERNAL_URL||'http://127.0.0.1:8000');
if((transport!=='path'&&(!domain||!portalOrigin))||!secret||internal.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(internal.hostname))throw Error('Invalid lab gateway configuration');
function authorize(body) {
  return new Promise((resolve,reject)=>{
    const data=JSON.stringify(body);
    const req=http.request(internal,{method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data),'X-Lab-Gateway-Key':secret},timeout:4000},res=>{
      const chunks=[];let size=0;
      res.on('data',chunk=>{size+=chunk.length;if(size>16384)res.destroy();else chunks.push(chunk);});
      res.on('error',reject);res.on('end',()=>{try{const result=JSON.parse(Buffer.concat(chunks));resolve(res.statusCode===200&&result.ok?result.data:null);}catch{reject(Error('Authorization unavailable'));}});
    });
    req.on('timeout',()=>req.destroy());req.on('error',reject);req.end(data);
  });
}
const lab=createGateway({domain,portalOrigin,authorize,transport});
const server=transport==='path'?http.createServer():lab;
server.requestTimeout=lab.requestTimeout;server.headersTimeout=lab.headersTimeout;
if(transport==='path')installApplicationForwarding(server,lab,{backendPort:Number(internal.port||80),key:secret});
server.on('error',()=>{console.error('Eagle Lab gateway could not listen on its configured address and port.');process.exitCode=1;});
server.listen(Number(transport==='path'?process.env.EAGLEIDE_LAB_PUBLIC_PORT:process.env.EAGLEIDE_LAB_GATEWAY_PORT||8010),transport==='path'?process.env.EAGLEIDE_LAB_PUBLIC_HOST:'127.0.0.1',()=>console.log(transport==='path'?'EagleIDE single-address gateway listening.':'Eagle Lab PVE gateway listening on loopback.'));
process.on('SIGTERM',()=>{server.closeAllConnections();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),1500).unref();});
