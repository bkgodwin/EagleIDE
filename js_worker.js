/* Student JavaScript process. Never expose Node objects inside the VM realm. */
'use strict';
const fs = require('fs');
const vm = require('vm');
const [sourcePath, workspace, timeoutText, inputToken] = process.argv.slice(2);
const timeout = Math.max(1, Number(timeoutText));
const timers = new Map();
let nextTimer = 0;
function fail(error) {
  // Student exceptions may have arbitrary getters; don't inspect prototypes.
  let message = 'JavaScript execution failed';
  try { message = String(error?.stack || error); } catch {}
  message = message.split(sourcePath).join('runner.js').split(__filename).join('[JavaScript worker]');
  process.stderr.write(message + '\n');
  process.exit(1);
}
const context = vm.createContext(Object.create(null), {
  codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate'
});
const bridge = Object.freeze({
  write(text, error) { (error ? process.stderr : process.stdout).write(text); },
  input(prompt) {
    process.stdout.write(prompt + inputToken + '\n');
    const byte = Buffer.alloc(1), collected = [];
    let size = 0;
    while (size < 10000) {
      let count;
      try { count = fs.readSync(0, byte, 0, 1); } catch { break; }
      if (!count || byte[0] === 10) break;
      if (byte[0] !== 13) { collected.push(byte[0]); size++; }
    }
    const line = Buffer.from(collected).toString('utf8');
    process.stdout.write(line + '\n');
    return line;
  },
  schedule(callback, delay, repeat, args) {
    if (timers.size >= 128) return 0;
    const id = ++nextTimer;
    const invoke = () => {
      if (!repeat) timers.delete(id);
      // Only realm-created functions and arrays cross back into the context.
      context.__eagleCallback = callback;
      context.__eagleArgs = args;
      try {
        vm.runInContext('__eagleCallback(...__eagleArgs)', context, { timeout, filename: 'runner.js' });
      } catch (error) { fail(error); }
      finally { delete context.__eagleCallback; delete context.__eagleArgs; }
    };
    timers.set(id, (repeat ? setInterval : setTimeout)(invoke, Math.max(1, Math.min(delay, 2147483647))));
    return id; // Numeric handles, never Node Timeout instances.
  },
  cancel(id) {
    const timer = timers.get(id);
    if (timer) { clearTimeout(timer); clearInterval(timer); timers.delete(id); }
  }
});
context.__eagleBridge = bridge;
try {
  process.chdir(workspace);
  vm.runInContext(`
    ((bridge) => {
      'use strict';
      const stringify = String, finite = Number.isFinite, number = Number;
      const wrap = action => (...args) => {
        try { return action(...args); }
        catch { throw new Error('JavaScript input/output failed'); }
      };
      const console = Object.create(null);
      for (const method of ['log', 'info', 'warn', 'error']) {
        console[method] = wrap((...args) => bridge.write(args.map(value => stringify(value)).join(' ') + '\\n', method === 'error'));
      }
      const schedule = repeat => wrap((callback, delay = 0, ...args) => {
        if (typeof callback !== 'function') throw new TypeError('Timer callback must be a function');
        const milliseconds = number(delay);
        return bridge.schedule(callback, finite(milliseconds) ? milliseconds : 1, repeat, args);
      });
      Object.defineProperties(globalThis, {
        console: { value: Object.freeze(console), writable: false },
        input: { value: wrap((prompt = '') => bridge.input(stringify(prompt))), writable: false },
        setTimeout: { value: schedule(false), writable: false },
        setInterval: { value: schedule(true), writable: false },
        clearTimeout: { value: wrap(id => bridge.cancel(number(id))), writable: false },
        clearInterval: { value: wrap(id => bridge.cancel(number(id))), writable: false }
      });
    })(__eagleBridge);
    delete globalThis.__eagleBridge;
  `, context, { timeout, filename: '[JavaScript setup]' });
  const script = new vm.Script(fs.readFileSync(sourcePath, 'utf8'), {
    filename: 'runner.js',
    // The default missing-loader rejection is a host Error with a host
    // Function constructor. Return a realm Error instead, with the VM-module
    // flag enabled by the parent so Node actually invokes this deny hook.
    importModuleDynamically: () => { throw vm.runInContext("new Error('Module imports are unavailable in student JavaScript')", context); }
  });
  script.runInContext(context, { timeout });
} catch (error) { fail(error); }
