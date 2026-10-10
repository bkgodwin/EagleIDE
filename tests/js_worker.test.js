const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
function run(code, input = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eagle-js-test-'));
  try {
    const file = path.join(root, 'source.js'); fs.writeFileSync(file, code);
    return spawnSync(process.execPath, ['--experimental-vm-modules', path.resolve('js_worker.js'), file, root, '500', '[[_IDE_INPUT_]]'], { input, encoding: 'utf8', timeout: 3000 });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
test('JavaScript intrinsics, UTF-8 input, promises, and numeric timer handles work', () => {
  const result = run(`
    console.log(Math.floor(2.8), JSON.stringify([1]), input('Name: '));
    Promise.resolve(3).then(value => console.log('promise', value));
    const timer = setTimeout((value) => console.log('timer', value), 1, 4);
    console.log('handle', typeof timer);
  `, 'José\n');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 \[1\] José/);
  assert.match(result.stdout, /promise 3/); assert.match(result.stdout, /timer 4/); assert.match(result.stdout, /handle number/);
});
test('realm constructors cannot obtain process, require, or host Function', () => {
  const result = run(`
    for (const object of [console.log, input, Math.max, Date, JSON.parse, setTimeout, clearInterval, globalThis]) {
      try { object.constructor.constructor('return process')(); console.log('ESCAPED'); }
      catch { console.log('blocked'); }
    }
    console.log(typeof process, typeof require, typeof Buffer, typeof __eagleBridge);
    const importing = import('node:fs');
    try { importing.constructor.constructor('return process')(); console.log('ESCAPED promise'); }
    catch { console.log('blocked promise'); }
    importing.catch(error => {
      try { error.constructor.constructor('return process')(); console.log('ESCAPED import'); } catch { console.log('blocked import'); }
    });
    setTimeout(() => {}, 1);
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /ESCAPED/);
  assert.match(result.stdout, /undefined undefined undefined undefined/);
  assert.match(result.stdout, /blocked promise/);
  assert.match(result.stdout, /blocked import/);
});
test('timer callbacks and promise microtasks stay subject to execution timeout', () => {
  for (const code of ['setTimeout(() => { while (true) {} }, 1)', 'Promise.resolve().then(() => { while (true) {} })']) {
    const result = run(code); assert.equal(result.status, 1); assert.match(result.stderr, /timed out/);
  }
});
test('timers reject string evaluation and do not return host Timeout objects', () => {
  const result = run(`
    try { setTimeout('console.log("unsafe")', 1); } catch { console.log('blocked string'); }
    const id = setInterval(() => {}, 1); console.log(typeof id); clearInterval(id);
  `);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, 'blocked string\nnumber\n');
});
