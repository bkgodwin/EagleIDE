export function rewritePathContent(source,type,prefix,origin) {
  const rooted=value=>value.startsWith(prefix)?value:prefix+value.slice(1);
  const javascript=value=>value.replace(/(\b(?:from\s*|import\s*\(?\s*))(["'])(\/(?!\/)[^"']+)\2/g,(_all,start,quote,path)=>start+quote+rooted(path)+quote)
    .replace(/box\.getWin\(\)\.location\.reload\(\)/g,'box.load(box.getFrame().src)');
  if(/text\/html/i.test(type)) {
    source=source.replace(/<base\b[^>]*>/gi,'').replace(/\b(src|href|action|poster)\s*=\s*(["'])(\/(?!\/)[^"']*)\2/gi,(_all,name,quote,value)=>`${name}=${quote}${rooted(value)}${quote}`);
    // PVE's noVNC template imports /novnc/app.js in an inline module. Module
    // resolution happens before runtime URL hooks, just like external imports.
    source=source.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)/gi,(_all,start,body,end)=>start+javascript(body)+end);
    const bridge=`<base href="${origin}${prefix}"><script src="${prefix}_eagle/bridge.js"></script>`;
    return /<head\b[^>]*>/i.test(source)?source.replace(/<head\b[^>]*>/i,head=>head+bridge):bridge+source;
  }
  if(/text\/css/i.test(type))return source.replace(/url\(\s*(["']?)(\/(?!\/)[^\s)"']+)\1\s*\)/gi,(_all,quote,value)=>`url(${quote}${rooted(value)}${quote})`).replace(/(@import\s+)(["'])(\/(?!\/)[^"']+)\2/gi,(_all,start,quote,value)=>start+quote+rooted(value)+quote);
  // Static module imports resolve before runtime URL hooks can run.
  // Proxmox VNCConsole.reload must reload its iframe element, not read an opaque child's Location.
  return javascript(source);
}
