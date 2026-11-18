export function clipboardSource({clipboardKey, portalOrigin}) {
  return `(${installClipboard.toString()})(${JSON.stringify({clipboardKey, portalOrigin})});`;
}

function installClipboard({clipboardKey, portalOrigin}) {
  const broker = window.top === window ? window.opener : window.top;
  const pending = new Map();
  function request(method, text) {
    return new Promise((resolve, reject) => {
      if (!broker) { reject(new Error('Open this console through Eagle Lab to use the clipboard.')); return; }
      if (pending.size >= 8) { reject(new Error('Clipboard is busy. Try again.')); return; }
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Clipboard request timed out. Use Paste again.'));
      }, 5000);
      pending.set(id, {resolve, reject, timer});
      broker.postMessage({type:'eagle-lab-clipboard', key:clipboardKey, id, method, text}, portalOrigin);
    });
  }
  window.addEventListener('message', event => {
    const data = event.data;
    if (event.source !== broker || event.origin !== portalOrigin || data?.key !== clipboardKey
        || data.type !== 'eagle-lab-clipboard-result') return;
    const item = pending.get(data.id);
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(data.id);
    if (data.error) item.reject(new Error(data.error));
    else item.resolve(data.text);
  });
  Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{
    writeText: text => request('writeText', String(text)),
    readText: () => request('readText'),
  }});
}
