const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../static/js/teacher-assignments.js'), 'utf8');

function harness() {
  const ready = [];
  const input = value => ({ value, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } });
  const cards = [
    { dataset: { name: 'Functions & return values', status: 'open' }, hidden: false },
    { dataset: { name: 'Loops', status: 'locked' }, hidden: false },
    { dataset: { name: 'Arrays', status: 'complete' }, hidden: false },
  ];
  const list = { querySelectorAll: () => cards, append(card) { const index = cards.indexOf(card); cards.splice(index,1); cards.push(card); } };
  const nodes = {
    assignmentList: list, assignmentLibrarySearch: input(''), assignmentLibraryFilter: input('all'), assignmentLibrarySort: input('oldest'),
    assignmentLibraryCount: {}, assignmentLibraryEmpty: {}, assignmentWorkspace: { innerHTML: '' },
  };
  const window = {};
  // Expose the private draft helpers only inside this VM, using the same DOM-facing code.
  const instrumented = source.replace('window.TeacherAssignments = { prepare,', 'window.TeacherAssignments = { restoreDraft, fingerprint, prepare,');
  vm.runInNewContext(instrumented, { window, Event: class { constructor(type) { this.type=type; } }, document: {
    getElementById: id => nodes[id], addEventListener(_type, fn) { ready.push(fn); }, createElement: () => ({}),
  } });
  ready.forEach(fn=>fn());
  const refresh = () => nodes.assignmentLibrarySearch.listeners.input();
  return { api: window.TeacherAssignments, nodes, cards, refresh };
}

test('assignment search and status filters intersect without clearing the selected workspace', () => {
  const { nodes, cards, refresh } = harness();
  nodes.assignmentWorkspace.innerHTML = 'Unsaved grading form';
  nodes.assignmentLibrarySearch.value = '  FUNCTIONS ';
  nodes.assignmentLibraryFilter.value = 'open'; refresh();
  assert.equal(cards.filter(c=>!c.hidden).length,1);
  assert.equal(nodes.assignmentLibraryCount.textContent,'1 / 3');
  assert.equal(nodes.assignmentWorkspace.innerHTML,'Unsaved grading form');
  nodes.assignmentLibraryFilter.value = 'locked'; refresh();
  assert.equal(nodes.assignmentLibraryCount.textContent,'0 / 3');
  assert.equal(nodes.assignmentLibraryEmpty.hidden,false);
  nodes.assignmentLibrarySearch.value=''; nodes.assignmentLibraryFilter.value='all'; refresh();
  assert.equal(nodes.assignmentLibraryEmpty.hidden,true);
  assert.equal(cards.filter(c=>!c.hidden).length,3);
});

test('library sorting is reversible and retains the original chronological order', () => {
  const { nodes, cards, refresh } = harness();
  nodes.assignmentLibrarySort.value='name'; refresh();
  assert.deepEqual(cards.map(c=>c.dataset.name),['Arrays','Functions & return values','Loops']);
  nodes.assignmentLibrarySort.value='oldest'; refresh();
  assert.deepEqual(cards.map(c=>c.dataset.name),['Functions & return values','Loops','Arrays']);
  nodes.assignmentLibrarySort.value='newest'; refresh();
  assert.deepEqual(cards.map(c=>c.dataset.name),['Arrays','Loops','Functions & return values']);
});

test('changing classes resets library filters; changing accounts clears the private workspace', () => {
  const { api, nodes } = harness();
  api.prepare('teacher-one','class-one');
  nodes.assignmentWorkspace.innerHTML='Teacher one rubric';
  nodes.assignmentLibrarySearch.value='Functions'; nodes.assignmentLibraryFilter.value='open';
  api.prepare('teacher-one','class-one');
  assert.equal(nodes.assignmentLibrarySearch.value,'Functions');
  api.prepare('teacher-one','class-two');
  assert.equal(nodes.assignmentLibrarySearch.value,'');
  assert.equal(nodes.assignmentLibraryFilter.value,'all');
  api.setScope('teacher-two');
  assert.doesNotMatch(nodes.assignmentWorkspace.innerHTML,/Teacher one rubric/);
});

test('section tabs retain mounted form values and support roving keyboard focus', () => {
  const buttons = ['submissions','grading','manage'].map(section => ({
    dataset: { section }, attributes: {}, setAttribute(key,value) { this.attributes[key]=value; },
    focus() { this.focused=true; },
  }));
  const panels = buttons.map(button=>({dataset:{section:button.dataset.section},field:{value:'Unsaved work'},hidden:true}));
  const root = { querySelectorAll: selector => selector === 'tabs' ? buttons : panels };
  const start = source.indexOf('  function bindTabs('), end = source.indexOf('  function restoreDraft(',start);
  const context = { root, active: null };
  vm.runInNewContext(`${source.slice(start,end)}\nbindTabs(root,'tabs','panels','grading',value=>{active=value;});`,context);
  assert.equal(context.active,'grading');
  assert.equal(panels[1].hidden,false);
  assert.equal(buttons[1].tabIndex,0);
  let prevented=false;
  buttons[1].onkeydown({key:'ArrowRight',preventDefault(){prevented=true;}});
  assert.equal(context.active,'manage');
  assert.equal(buttons[2].focused,true);
  assert.equal(buttons[1].tabIndex,-1);
  assert.equal(prevented,true);
  buttons[2].onkeydown({key:'Home',preventDefault(){}});
  assert.equal(context.active,'submissions');
  buttons[1].onclick();
  assert.equal(panels[1].field.value,'Unsaved work');
  assert.equal(buttons[1].attributes['aria-selected'],'true');
});

function gradingDetail(api, assignment, dirty) {
  const field = (id,value,type='text') => ({ id,value,type,checked:false,classList:{contains:()=>false}, dispatchEvent() {} });
  const controls = [field('assignmentAiGradingMode','legacy'),field('assignmentAiInstructions','Saved instructions'),field('assignmentAiRubric','Saved rubric'),field('assignmentShareAiFeedback','','checkbox')];
  const criterion=field('','objectives','checkbox'); criterion.classList.contains=name=>name==='assignment-criterion-check'; controls.push(criterion);
  const buttons=[{disabled:false},{disabled:false}], notices=[];
  return {
    controls,buttons,notices,dataset:{assignmentId:assignment.id,settingsBase:api.fingerprint(assignment),rubricContext:'saved-context',aiSettingsDirty:dirty?'true':'false'},
    querySelectorAll(selector) { return selector.includes('input,') ? controls : buttons; },
    querySelector(selector) {
      if(selector==='[data-assignment-panel="grading"]') return {prepend:notice=>notices.push(notice)};
      return controls.find(field=>`#${field.id}`===selector);
    },
  };
}

test('grading drafts restore criteria, rubric, mode and sharing while requiring a save before grading', () => {
  const {api,nodes}=harness(), assignment={id:'assignment-a',task:'Use functions',maxScore:10};
  api.prepare('teacher','class-one');
  const old=gradingDetail(api,assignment,true); nodes.assignmentDetailPanel=old;
  old.controls[0].value='external'; old.controls[1].value='Unsaved instructions'; old.controls[2].value='Unsaved point rubric';
  old.controls[3].checked=true; old.controls[4].checked=true; old.dataset.rubricContext='draft-context';
  api.prepare('teacher','class-one');
  const current=gradingDetail(api,assignment,false); nodes.assignmentDetailPanel=current;
  api.restoreDraft(current,assignment);
  assert.equal(current.controls[0].value,'external');
  assert.equal(current.controls[1].value,'Unsaved instructions');
  assert.equal(current.controls[2].value,'Unsaved point rubric');
  assert.equal(current.controls[3].checked,true); assert.equal(current.controls[4].checked,true);
  assert.equal(current.dataset.rubricContext,'draft-context');
  assert.equal(current.dataset.aiSettingsDirty,'true');
  assert.ok(current.buttons.every(button=>button.disabled));
});

test('changed saved grading context and account changes cannot restore an older private draft', () => {
  const {api,nodes}=harness(), assignment={id:'assignment-a',task:'Use functions',maxScore:10};
  api.prepare('teacher-one','class-one');
  const old=gradingDetail(api,assignment,true); nodes.assignmentDetailPanel=old; old.controls[2].value='Private draft';
  api.prepare('teacher-one','class-one');
  const changed={...assignment,maxScore:20}, current=gradingDetail(api,changed,false);
  api.restoreDraft(current,changed);
  assert.equal(current.controls[2].value,'Saved rubric'); assert.equal(current.notices.length,1);
  api.prepare('teacher-one','class-one'); // Remember the original form again.
  api.setScope('teacher-two');
  const other=gradingDetail(api,assignment,false); api.restoreDraft(other,assignment);
  assert.equal(other.controls[2].value,'Saved rubric');
});
