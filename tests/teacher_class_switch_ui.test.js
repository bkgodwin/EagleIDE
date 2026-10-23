const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname,'../static/js/app-core.js'),'utf8');
const functions = ['selectTeacherClass','stopTeacherBroadcast','setTeacherStreamingEnabled'].map(name => {
  const start=source.indexOf(`    function ${name}(`), end=source.indexOf('\n    }',start)+6;
  assert.ok(start>=0); return source.slice(start,end);
}).join('\n');
test('switching teacher classes stops the old stream and cancels its pending flush before joining', () => {
  const events=[], cancelled=[];
  const scope={events,clearTimeout:id=>cancelled.push(id),window:{},
    emitLeaveClassRoom:id=>events.push(['leave',id]),emitJoinClassRoom:(...args)=>events.push(['join',...args]),
    refreshEagleIDEContext(){},syncTeacherDashboardClassSelectors(){},renderTeacherReferenceAssignments(){},
    updateSendFileButtonVisibility(){},updateStreamingToggleButton(){},updateTeacherStreamToggleState(){},
    startTeacherBroadcast(){throw new Error('Must not start another class stream');},
    scheduleTeacherBroadcastFlush(){throw new Error('Must not send code to the next class');}};
  vm.runInNewContext(`let TEACHER_TOKEN='fixture',teacherClasses=[{id:'one'},{id:'two'}],currentTeacherClassId='one',
    activeAssignmentsClassId='one',currentAdminAssignmentName='old',teacherStreamingEnabled=true,teacherBroadcastActive=true,teacherBroadcastFlushTimer=42;
    const socket={emit:(...args)=>events.push(args)},getCurrentClassContext=()=>({id:currentTeacherClassId});
    ${functions}
    globalThis.select=selectTeacherClass;
    globalThis.state=()=>({enabled:teacherStreamingEnabled,active:teacherBroadcastActive,timer:teacherBroadcastFlushTimer,id:currentTeacherClassId});`,scope);
  assert.equal(scope.select('invalid'),false); assert.equal(scope.state().enabled,true);
  assert.equal(scope.select('two'),true);
  assert.equal(scope.state().enabled,false); assert.equal(scope.state().active,false); assert.equal(scope.state().timer,null);
  assert.equal(scope.state().id,'two'); assert.deepEqual(cancelled,[42]);
  assert.equal(events[0][0],'teacher_stream_status'); assert.equal(events[0][1].class_id,'one'); assert.equal(events[0][1].active,false);
  assert.equal(events[1][0],'leave'); assert.equal(events[2][0],'join');
});
