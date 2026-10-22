const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');

test('home rendering remains inert if the sanitizer is unavailable', () => {
  const source = fs.readFileSync(path.join(root, 'static/js/app-core.js'), 'utf8');
  const start = source.indexOf('    function renderHomeContent(');
  const end = source.indexOf('\n    }', start) + 6;
  const view = { textContent: '' };
  Object.defineProperty(view, 'innerHTML', { set() { throw new Error('Unsanitized HTML assignment'); } });
  const context = { window: {}, document: { getElementById: () => view } };
  vm.runInNewContext(source.slice(start, end) + '\nrenderHomeContent("<img src=x onerror=alert(1)>");', context);
  assert.equal(view.textContent, '<img src=x onerror=alert(1)>');
});

test('dynamic report libraries set integrity and anonymous CORS before insertion', async () => {
  const window = {};
  const inserted = [];
  const document = {
    createElement: () => ({}),
    head: { appendChild(script) {
      assert.match(script.integrity, /^sha384-[A-Za-z0-9+/=]+$/);
      assert.equal(script.crossOrigin, 'anonymous');
      inserted.push(script.src);
      if (script.src.includes('chart.js')) window.Chart = {};
      else window.jspdf = {};
      script.onload();
    } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'static/js/lazy-libs.js'), 'utf8'), { window, document });
  await window.EagleIDE.ensureChart();
  await window.EagleIDE.ensureJsPDF();
  await window.EagleIDE.ensureChart();
  assert.equal(inserted.length, 2);
});


test('class joining accepts legacy and new codes without truncating input', async () => {
  const source = fs.readFileSync(path.join(root, 'static/js/app-core.js'), 'utf8');
  const start = source.indexOf("    document.getElementById('joinClassBtn').addEventListener('click', async () => {");
  const end = source.indexOf('\n    });', start) + 8;
  let handler, attempts = 0;
  const input = {value: ''}, status = {style: {}};
  const context = {USER_TOKEN: 'fixture', currentUser: {}, document: {getElementById(id) {
    return id === 'joinClassBtn' ? {addEventListener: (_event, callback) => {handler = callback;}} : id === 'joinClassCodeInput' ? input : status;
  }}, fetch: async () => {attempts++; throw new Error('fixture stops after admission');}};
  vm.runInNewContext(source.slice(start, end), context);
  for (const code of ['ABC123', 'ABCD1234']) {input.value = code; await handler();}
  assert.equal(attempts, 2);
  for (const code of ['ABC1234', '<script>', '']) {input.value = code; await handler();}
  assert.equal(attempts, 2);
  assert.match(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), /id="joinClassCodeInput" maxlength="8"/);
});
