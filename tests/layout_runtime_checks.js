/* No browser dependencies: exercise the production layout event handlers. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function surface() {
  const handlers = new Map();
  const classes = new Set();
  const attributes = new Map();
  const styles = new Map();
  return {
    handlers, styles, attributes,
    style: { setProperty: (key, value) => styles.set(key, value) },
    classList: {
      contains: (name) => classes.has(name),
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      toggle(name, force) {
        const next = force === undefined ? !classes.has(name) : force;
        if (next) classes.add(name); else classes.delete(name);
        return next;
      }
    },
    setAttribute: (name, value) => attributes.set(name, value),
    getAttribute: (name) => attributes.get(name),
    addEventListener(name, handler) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(handler);
    },
    removeEventListener: (name, handler) => handlers.get(name)?.delete(handler),
    fire(name, event = {}) {
      for (const handler of [...(handlers.get(name) || [])]) handler({ preventDefault() {}, ...event });
    },
    querySelectorAll: () => [],
    setPointerCapture() {}, releasePointerCapture() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 1000, height: 500 })
  };
}

const elements = new Map();
for (const id of ['outer', 'rightstack', 'hsplitter', 'vsplitter', 'editorContentStack',
  'teacherStreamPane', 'editorStreamSplitter', 'teacherPaneToggleBtn', 'rightEdgeToggleBtn',
  'editor', 'output']) elements.set(id, surface());
elements.get('hsplitter').setAttribute('aria-orientation', 'vertical');
elements.get('vsplitter').setAttribute('aria-orientation', 'horizontal');
elements.get('editorStreamSplitter').setAttribute('aria-orientation', 'horizontal');
elements.get('output').scrollTop = 12;
elements.get('output').scrollHeight = 200;

let editorRefreshes = 0;
let observer;
let frameId = 0;
const frames = new Map();
const storage = new Map();
const root = surface();
const body = surface();
const document = Object.assign(surface(), {
  documentElement: root, body,
  getElementById: (id) => elements.get(id) || null,
  querySelectorAll: () => [{ clientWidth: 400, clientHeight: 300,
    CodeMirror: { refresh: () => editorRefreshes++ } }]
});
const window = Object.assign(surface(), {
  innerHeight: 900,
  visualViewport: Object.assign(surface(), { height: 750, scale: 1, offsetTop: 0 }),
  matchMedia: () => ({ matches: true })
});
const context = vm.createContext({
  window, document, console,
  localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  requestAnimationFrame: (callback) => { frames.set(++frameId, callback); return frameId; },
  cancelAnimationFrame: (id) => frames.delete(id),
  getComputedStyle: () => ({ getPropertyValue: (key) => root.styles.get(key) || '' }),
  ResizeObserver: class {
    constructor(callback) { this.callback = callback; this.observed = []; observer = this; }
    observe(element) { this.observed.push(element); }
  },
  setTimeout, clearTimeout,
  teacherPaneEnabled: false, teacherPaneOpen: false,
  TEACHER_PANE_SIZE_KEY: 'teacher-size',
  setTeacherPaneSize: (value) => root.style.setProperty('--teacher-pane-size', `${value}%`),
  setTeacherPaneOpen: () => {}
});
window.ResizeObserver = context.ResizeObserver;
function flushFrames() {
  while (frames.size) {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach(callback => callback());
  }
}

vm.runInContext(fs.readFileSync('static/js/layout.js', 'utf8'), context);
body.classList.add('tablet-mode', 'panel-editor');
document.fire('DOMContentLoaded');
flushFrames();
assert.equal(body.classList.contains('tablet-mode'), false, 'tablet viewport must retain desktop panels');
assert.equal(body.classList.contains('panel-editor'), false);
assert.equal(root.styles.get('--app-height'), '750px');
assert.equal(elements.get('output').scrollTop, 12, 'resize preserves shell reading position');
assert.equal(observer.observed.length, 3);

window.visualViewport.height = 360;
window.visualViewport.offsetTop = 90;
window.visualViewport.fire('resize');
flushFrames();
assert.equal(root.styles.get('--app-height'), '360px', 'keyboard leaves controls within visible viewport');
assert.equal(root.styles.get('--app-offset-top'), '90px');
window.visualViewport.scale = 2;
window.visualViewport.height = 180;
window.visualViewport.fire('resize');
flushFrames();
assert.equal(root.styles.get('--app-height'), '360px', 'pinch zoom does not reflow layout');
const refreshesBefore = editorRefreshes;
observer.callback();
flushFrames();
assert.ok(editorRefreshes > refreshesBefore, 'editor refreshes without an active teacher stream');

const appCore = fs.readFileSync('static/js/app-core.js', 'utf8');
const start = appCore.indexOf('// ---- Layout controls (sidebar toggle + splitters) ----');
const end = appCore.indexOf('// ---- Login UI ----', start);
assert.ok(start >= 0 && end > start);
vm.runInContext(appCore.slice(start, end), context);
const divider = elements.get('hsplitter');
divider.fire('pointerdown', { isPrimary: true, button: 0, pointerId: 1 });
window.fire('pointermove', { pointerId: 2, clientX: 200 });
assert.equal(root.styles.get('--left-width'), undefined, 'second touch cannot move active divider');
window.fire('pointermove', { pointerId: 1, clientX: 620 });
assert.equal(root.styles.get('--left-width'), '62%', 'main resizing works without teacher streaming');
assert.equal(body.classList.contains('workspace-resizing'), true);
window.fire('pointercancel', { pointerId: 1 });
assert.equal(body.classList.contains('workspace-resizing'), false);
window.fire('pointermove', { pointerId: 1, clientX: 500 });
assert.equal(root.styles.get('--left-width'), '62%', 'cancelled drag removes listeners');
divider.fire('keydown', { key: 'ArrowRight' });
assert.equal(root.styles.get('--left-width'), '64%');
assert.equal(divider.getAttribute('aria-valuenow'), '64');
divider.fire('keydown', { key: 'End' });
assert.equal(root.styles.get('--left-width'), '80%');
divider.fire('dblclick');
assert.equal(root.styles.get('--left-width'), '50%');
const shellDivider = elements.get('vsplitter');
shellDivider.fire('pointerdown', { isPrimary: true, button: 0, pointerId: 3 });
window.fire('pointermove', { pointerId: 3, clientY: 300 });
assert.equal(root.styles.get('--shell-size'), '60%');
window.fire('blur');
assert.equal(body.classList.contains('workspace-resizing'), false, 'window blur releases drag');

const editorSource = fs.readFileSync('static/js/editor-init.js', 'utf8');
vm.runInContext(editorSource.slice(0, editorSource.indexOf('var editor = initEditor();')), context);
vm.runInContext('initEditor()', context);
assert.equal(elements.get('editor').style.display, 'block', 'textarea fallback remains usable when CDN fails');
console.log('Layout runtime checks passed.');
