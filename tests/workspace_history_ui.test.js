const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('workspace recorder stays idle without edits and rebases an unsent Unicode and paste batch', async () => {
  const uploads = [];
  const file = {workspaceHistory:{id:'workspace-file', version:0}, pasteRanges:[]};
  let source = '🌱', change, now = 1800000000000;
  const context = {
    TextEncoder,
    Date:{now:() => now},
    setInterval(){}, setTimeout(){return 1;},
    document:{getElementById:()=>null, addEventListener(){}},
    window:{addEventListener(){}, eagleEditor:{on(_type, callback){change=callback;}}},
  };
  vm.createContext(context);
  for (const asset of ['assignment-development.js','workspace-history.js']) {
    vm.runInContext(fs.readFileSync('static/js/'+asset,'utf8'), context);
  }
  const recorder = context.window.WorkspaceHistory;
  recorder.configure({
    account:()=>'student@example.test', file:()=>file, content:()=>source, headers:()=>({'X-User-Token':'fixture'}),
    request:async (_url, options) => {
      uploads.push(JSON.parse(options.body));
      return uploads.length === 1
        ? {status:409,json:async()=>({ok:false,version:8})}
        : {status:200,json:async()=>({ok:true,version:10})};
    },
  });
  recorder.opened();
  await recorder.flush();
  assert.equal(uploads.length,0);
  source = '🌱 pasted';
  file.pasteRanges = [[2,9]];
  change(null,{origin:'paste'});
  await recorder.flush();
  assert.deepEqual(uploads[0].frames[0].pasteRanges,[[2,9]]);
  assert.equal(uploads[0].frames[0].from,2);
  now += 1000;
  await recorder.flush();
  assert.equal(uploads[1].version,8);
  assert.equal(uploads[1].base,'🌱');
  await recorder.flush();
  assert.equal(uploads.length,2);
});
