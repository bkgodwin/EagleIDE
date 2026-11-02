import http from 'node:http';
import {createGateway} from './proxy.mjs';

const domain=process.env.EAGLEIDE_LAB_PROXY_DOMAIN;
const portalOrigin=process.env.EAGLEIDE_PUBLIC_ORIGIN;
const secret=process.env.EAGLEIDE_LAB_GATEWAY_SECRET;
const internal=new URL('/api/eagle-lab/gateway/authorize',process.env.EAGLEIDE_LAB_INTERNAL_URL||'http://127.0.0.1:8000');
if(!domain||!portalOrigin||!secret||internal.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(internal.hostname))throw Error('Invalid lab gateway configuration');
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
const server=createGateway({domain,portalOrigin,authorize});
server.on('error',()=>{console.error('Eagle Lab gateway could not listen on its configured loopback port.');process.exitCode=1;});
server.listen(Number(process.env.EAGLEIDE_LAB_GATEWAY_PORT||8010),'127.0.0.1',()=>console.log('Eagle Lab PVE gateway listening on loopback.'));
process.on('SIGTERM',()=>{server.closeAllConnections();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),1500).unref();});
