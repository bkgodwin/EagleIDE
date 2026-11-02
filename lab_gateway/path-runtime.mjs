// PVE compatibility inside an opaque sandbox. No EagleIDE cookies/storage are used.
export function pathRuntimeSource(config) {
  return `(${runtime.toString()})(${JSON.stringify(config)});`;
}

function runtime(config) {
  'use strict';
  const {prefix,origin,upstreamOrigin,clipboardKey}=config;
  const NativeXHR=window.XMLHttpRequest,open=NativeXHR.prototype.open,send=NativeXHR.prototype.send;
  const cookie=new Map(Object.entries(config.cookies||{}));
  const maps={local:new Map(Object.entries(config.local||{})),session:new Map(Object.entries(config.session||{}))};
  const urlFor=value=>{
    if(value==null||String(value).startsWith('#')||/^(?:data|blob|mailto|javascript):/i.test(String(value)))return value;
    const url=new URL(String(value),document.baseURI);
    if(url.origin===origin&&url.pathname.startsWith(prefix))return url.href;
    if(url.origin!==origin&&url.origin!==upstreamOrigin&&!(['ws:','wss:'].includes(url.protocol)&&[new URL(origin).host,new URL(upstreamOrigin).host].includes(url.host)))return url.href;
    return origin+prefix+url.pathname.replace(/^\//,'')+url.search+url.hash;
  };
  function saveState(change,sync=false){
    const xhr=new NativeXHR();open.call(xhr,'POST',origin+prefix+'_eagle/state',!sync);
    xhr.withCredentials=false;xhr.setRequestHeader('Content-Type','text/plain;charset=UTF-8');
    send.call(xhr,JSON.stringify(change));
    if(sync&&xhr.status!==200)throw new Error('PVE session could not be saved. Reconnect in Eagle Lab.');
  }
  Object.defineProperty(document,'cookie',{configurable:true,
    get:()=>[...cookie].map(([key,value])=>key+'='+value).join('; '),
    set:raw=>{
      const parts=String(raw).split(';'),split=parts[0].indexOf('=');if(split<1)return;
      const name=parts[0].slice(0,split).trim(),value=parts[0].slice(split+1);
      const expired=parts.slice(1).some(part=>/^\s*max-age\s*=\s*0\s*$/i.test(part)||(/^\s*expires=/i.test(part)&&Date.parse(part.slice(part.indexOf('=')+1))<Date.now()));
      if(expired)cookie.delete(name);else cookie.set(name,value);
      saveState({cookie:String(raw)},true);
    }});
  function storage(kind){
    const map=maps[kind];
    const update=(op,key,value)=>{if(op==='clear')map.clear();else if(op==='remove')map.delete(String(key));else map.set(String(key),String(value));saveState({storage:kind,op,key:String(key??''),value:String(value??'')},key==='ProxmoxUser');};
    const api={getItem:key=>map.get(String(key))??null,setItem:(key,value)=>update('set',key,value),removeItem:key=>update('remove',key),clear:()=>update('clear'),key:index=>[...map.keys()][index]??null};
    Object.defineProperty(api,'length',{get:()=>map.size});
    return new Proxy(api,{get:(target,key)=>key in target?target[key]:map.get(String(key)),set:(_target,key,value)=>{update('set',key,value);return true;},deleteProperty:(_target,key)=>{update('remove',key);return true;}});
  }
  Object.defineProperty(window,'localStorage',{configurable:true,value:storage('local')});
  Object.defineProperty(window,'sessionStorage',{configurable:true,value:storage('session')});
  NativeXHR.prototype.open=function(method,url,...args){return open.call(this,method,urlFor(url),...args);};
  NativeXHR.prototype.send=function(body){this.withCredentials=false;return send.call(this,body);};
  const nativeFetch=window.fetch.bind(window);
  window.fetch=(input,options={})=>nativeFetch(input instanceof Request?new Request(urlFor(input.url),input):urlFor(input),{...options,mode:'cors',credentials:'omit'});
  const NativeSocket=window.WebSocket;
  window.WebSocket=class extends NativeSocket{
    constructor(value,protocols){const url=new URL(urlFor(value));url.protocol=location.protocol==='https:'?'wss:':'ws:';if(protocols===undefined)super(url.href);else super(url.href,protocols);}
  };
  if(window.EventSource){const Native=window.EventSource;window.EventSource=class extends Native{constructor(url){super(urlFor(url),{withCredentials:false});}};}
  const nativeSet=Element.prototype.setAttribute;
  Element.prototype.setAttribute=function(name,value){if(/^(?:src|href|action|poster|data)$/i.test(name))value=urlFor(value);return nativeSet.call(this,name,value);};
  for(const [type,property] of [['HTMLIFrameElement','src'],['HTMLScriptElement','src'],['HTMLLinkElement','href'],['HTMLImageElement','src'],['HTMLAnchorElement','href'],['HTMLFormElement','action'],['HTMLSourceElement','src'],['HTMLVideoElement','poster']]){
    const proto=window[type]?.prototype,descriptor=proto&&Object.getOwnPropertyDescriptor(proto,property);
    if(descriptor?.set)Object.defineProperty(proto,property,{...descriptor,set(value){descriptor.set.call(this,urlFor(value));}});
  }
  const rewrite=element=>{if(element.nodeType!==1)return;for(const attribute of ['src','href','action','poster']){const value=element.getAttribute(attribute);if(value){const mapped=urlFor(value);if(mapped!==value)nativeSet.call(element,attribute,mapped);}}};
  new MutationObserver(changes=>{for(const change of changes){if(change.type==='attributes')rewrite(change.target);else change.addedNodes.forEach(element=>{rewrite(element);element.querySelectorAll?.('[src],[href],[action],[poster]').forEach(rewrite);});}}).observe(document,{childList:true,subtree:true,attributes:true,attributeFilter:['src','href','action','poster']});
  const nativeWindowOpen=window.open.bind(window);window.open=(url,...args)=>nativeWindowOpen(urlFor(url),...args);
  // Clipboard authority belongs to the parent EagleIDE page, never the opaque PVE document.
  const pending=new Map(),relayed=new Map();let serial=0;
  const broker=window.top===window?window.opener:window.top;
  function clipboard(method,text){return new Promise((resolve,reject)=>{
    if(!broker)return reject(new Error('Open this console through Eagle Lab to use the clipboard.'));
    const id=crypto.randomUUID?.()||String(Date.now())+'-'+(++serial);
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Clipboard request timed out'));},10000);
    pending.set(id,{resolve,reject,timer});broker.postMessage({type:'eagle-lab-clipboard',key:clipboardKey,id,method,text},'*');
  });}
  window.addEventListener('message',event=>{
    const data=event.data;if(!data||data.key!==clipboardKey)return;
    if(data.type==='eagle-lab-clipboard'&&window.top!==window&&event.source!==window.top){relayed.set(data.id,event.source);window.top.postMessage(data,'*');return;}
    if(data.type!=='eagle-lab-clipboard-result'||event.source!==broker)return;
    if(relayed.has(data.id)){relayed.get(data.id).postMessage(data,'*');relayed.delete(data.id);return;}
    const item=pending.get(data.id);if(!item)return;clearTimeout(item.timer);pending.delete(data.id);data.error?item.reject(new Error(data.error)):item.resolve(data.text);
  });
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:text=>clipboard('writeText',String(text)),readText:()=>clipboard('readText')}});
}
