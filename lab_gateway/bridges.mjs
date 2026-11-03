// Adapted from bkgodwin/Eagle-Lab: per-node cookies and nested console transport.
export function bridgeSource(cookieName) {
  return `(() => {
    const name = ${JSON.stringify(cookieName)};
    let proto = Document.prototype, descriptor;
    while (proto && !(descriptor = Object.getOwnPropertyDescriptor(proto, 'cookie'))) proto = Object.getPrototypeOf(proto);
    if (!descriptor?.get || !descriptor?.set) throw new Error('PVE cookie compatibility is unavailable.');
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get() { return descriptor.get.call(this); },
      set(value) {
        const parts = String(value).split(';'), split = parts[0].indexOf('=');
        const key = parts[0].slice(0, split).trim();
        if (split >= 0 && (key === name || key === 'PVEAuthCookie')) {
          parts[0] = name + parts[0].slice(split);
          const attrs = parts.slice(1).filter(part => !/^\\s*(domain|path|samesite|secure|partitioned)(?:\\s*=|\\s*$)/i.test(part));
          value = [parts[0], ...attrs, 'Path=/', 'Secure', 'SameSite=None', 'Partitioned'].join('; ');
        }
        descriptor.set.call(this, value);
      }
    });
    // Browser transport stays HTTPS/WSS; the gateway always uses TLS to PVE.
    if (window.WebSocket) {
      const Native = window.WebSocket;
      window.WebSocket = new Proxy(Native, {construct(Target, [url, protocols]) {
          const target = new URL(url, location.href);
          if (target.host === location.host && /^\\/api2\\/(?:json|extjs)\\/.*\\/(?:vncwebsocket|termwebsocket)$/.test(target.pathname)) {
            target.protocol = 'wss:'; url = target.href;
          }
          return protocols === undefined ? new Target(url) : new Target(url, protocols);
        }
      });
    }
  })();`;
}
