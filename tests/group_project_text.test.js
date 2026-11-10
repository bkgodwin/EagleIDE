const test = require('node:test');
const assert = require('node:assert/strict');
const ops = require('../static/js/group-project-text.js');

test('concurrent inserts and overlapping deletes converge regardless of arrival order at the client', () => {
  const initial = 'abcd';
  const splices = [];
  for (let start = 0; start <= initial.length; start++) {
    for (let stop = start; stop <= initial.length; stop++) {
      for (const value of ['', 'X', '😀']) splices.push(ops.splice(initial.length,start,stop,value));
    }
  }
  for (const first of splices) for (const second of splices) {
    assert.equal(
      ops.apply(ops.apply(initial,first),ops.transform(second,first)),
      ops.apply(ops.apply(initial,second),ops.transform(first,second,true)),
    );
  }
});

test('queued batches preserve multiple edits, Unicode and surviving contributor ranges', () => {
  const initial = '😀\nstart\nend';
  const first = ops.splice(initial.length, 3, 8, 'hello');
  const current = ops.apply(initial,first);
  const second = ops.splice(current.length, current.length, current.length, '\nclass');
  const combined = ops.compose(first,second);
  const both = ops.apply(initial,combined);
  assert.equal(both,'😀\nhello\nend\nclass');
  assert.equal(ops.apply(both,ops.inverse(initial,combined)),initial);
  assert.deepEqual(ops.mapSpans([[0,2,'first']],combined,'second'),
    [[0,2,'first'],[3,8,'second'],[12,18,'second']]);
  assert.deepEqual(ops.diff('🍏abc','🍎abc'),[-2,'🍎',3]);
});

test('undo and redo can be rebased across another student’s insert', () => {
  const original = 'start';
  const a = ops.splice(original.length,0,0,'A ');
  const afterA = ops.apply(original,a);
  const b = ops.splice(afterA.length,2,2,'B ');
  const afterB = ops.apply(afterA,b);
  const stack = [ops.inverse(original,a),ops.inverse(afterA,b)];
  const remote = ops.splice(afterB.length,2,2,'other ');
  ops.rebaseUndo(stack,remote);
  const edited = ops.apply(afterB,remote);
  assert.equal(edited,'A other B start');
  const one = ops.apply(edited,stack.pop());
  assert.equal(one,'A other start');
  assert.equal(ops.apply(one,stack.pop()),'other start');
});
