// Run with node --test tests/classroom_ui.test.js (no packages required).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function signalFixture() {
  const elements = new Map();
  const el = id => {
    if (!elements.has(id)) elements.set(id, {
      innerHTML: '', textContent: '', style: {}, hidden: false,
      classList: { toggle() {} }, setAttribute() {}, removeAttribute() {},
      addEventListener() {}, querySelectorAll() { return []; },
    });
    return elements.get(id);
  };
  let selected = 'one';
  const context = { TEACHER_TOKEN: 'teacher', currentTeacherClassId: 'one',
    teacherClasses: [{ id: 'one' }, { id: 'two' }],
    getCurrentClassContext: () => ({ id: selected, settings: {} }),
  };
  const requests = [];
  const handlers = {};
  const window = { EagleIDE: { getContext: () => context },
    eagleSocket: { on: (name, fn) => { handlers[name] = fn; } }, addEventListener() {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../static/js/classroom-signals.js'), 'utf8'), {
    window,
    document: { getElementById: el, addEventListener() {} },
    fetch: () => new Promise(resolve => requests.push(resolve)),
  });
  const reply = async (index, name) => {
    requests[index]({ ok: true, json: async () => ({ ok: true, hands: [{ student_name: name, student_email: 'student@example.test' }], questions: [] }) });
    await new Promise(resolve => setImmediate(resolve));
  };
  return { context, window, el, requests, handlers, reply,
    select(id) { selected = id; context.currentTeacherClassId = id; window.ClassroomSignals.onAuthChanged(); },
  };
}

test('class switching clears stale hands and ignores responses from the old class', async () => {
  const f = signalFixture();
  await f.reply(0, 'First Section');
  assert.match(f.el('classroomTeacherStrip').innerHTML, /First Section/);
  f.window.ClassroomSignals.loadTeacherSignals();
  f.select('two');
  assert.equal(f.el('classroomTeacherStrip').hidden, true);
  await f.reply(2, 'Second Section');
  await f.reply(1, 'Stale First Section');
  assert.match(f.el('classroomTeacherStrip').innerHTML, /Second Section/);
  assert.doesNotMatch(f.el('classroomTeacherStrip').innerHTML, /Stale/);
});

test('a live socket signal is not overwritten by an older HTTP snapshot', async () => {
  const f = signalFixture();
  f.handlers.classroom_hands_update({ class_id: 'one', hands: [{ student_name: 'Live Student' }] });
  await f.reply(0, 'Old Student');
  assert.match(f.el('classroomTeacherStrip').innerHTML, /Live Student/);
  assert.doesNotMatch(f.el('classroomTeacherStrip').innerHTML, /Old Student/);
});
