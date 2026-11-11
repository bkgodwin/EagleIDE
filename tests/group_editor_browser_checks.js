/* Opt-in browser coverage for shared editor rendering and phrase replacement. */
const {chromium, webkit, devices, request} = require('playwright');
const {spawn} = require('node:child_process');
const {createInterface} = require('node:readline');
const assert = require('node:assert/strict');
const path = require('node:path');

async function main() {
  const fixture = spawn(process.env.EAGLE_GROUP_PYTHON || 'python', [
    path.join(__dirname, 'group_projects_browser_fixture.py'),
  ], {stdio:['ignore', 'pipe', 'pipe']});
  let browser, api, logs = '';
  fixture.stderr.on('data', chunk => {logs = (logs + chunk).slice(-5000);});
  try {
    const lines = createInterface({input:fixture.stdout});
    let server;
    for await (const line of lines) {
      if (line.startsWith('{"url"')) {server = JSON.parse(line); break;}
    }
    assert.match(server?.url || logs, /^http:\/\/127\.0\.0\.1:\d+$/);
    const engine = process.env.EAGLE_GROUP_ENGINE === 'webkit' ? webkit : chromium;
    browser = await engine.launch({executablePath:process.env.EAGLE_GROUP_BROWSER});
    api = await request.newContext({baseURL:server.url});
    const aliceHeaders = {'X-User-Token':'group-alice'};
    const benHeaders = {'X-User-Token':'group-ben'};
    const fileName = 'scroll.py';
    const declarations = 'def MyFunction():\ndef  MyFunction():\ndef\tMyFunction():\ndef MyFunctionExtra():\ndef\nMyFunction\n';
    const source = declarations + Array.from({length:1200}, (_, i) => '# Scroll row ' + i + ' ' + 'text '.repeat(45)).join('\n');
    async function post(url, headers, data) {
      const response = await api.post(url, {headers, data});
      const result = await response.json();
      assert.ok(response.ok() && result.ok, JSON.stringify(result));
      return result;
    }
    await post('/api/files/create', aliceHeaders, {name:fileName});
    await post('/api/files/write', aliceHeaders, {path:fileName, content:source});
    const {project} = await post('/api/group-projects', aliceHeaders, {
      classId:server.classId, path:fileName, invitees:['ben@example.test'],
    });
    await post('/api/group-projects/' + project.id, benHeaders, {classId:server.classId, action:'accept'});

    const errors = [];
    async function open(name, options) {
      const context = await browser.newContext({...options, ignoreHTTPSErrors:true});
      await context.addInitScript(({name, classId}) => {
        sessionStorage.setItem('eagle-auth-session-v1', JSON.stringify({
          userToken:'group-' + name.toLowerCase(),
          currentUser:{email:name.toLowerCase() + '@example.test', name, role:'student', class_id:classId, class_ids:[classId]},
        }));
      }, {name, classId:server.classId});
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(server.url, {waitUntil:'domcontentloaded'});
      await page.waitForFunction(() => window.eagleEditor && window.EagleIDE?.getContext?.().currentStudentClassId);
      await page.evaluate(() => window.WikiReader.showIDE(true));
      const switcher = page.locator('#workspaceSwitchBtn');
      if (await switcher.getAttribute('aria-pressed') !== 'true') await switcher.click();
      await page.locator('[data-group-browse]').filter({hasText:fileName}).click();
      await page.getByRole('button', {name:fileName, exact:true}).click();
      await page.waitForFunction(() => document.getElementById('activeFileName').textContent === 'scroll.py');
      return page;
    }
    const [alice, ben] = await Promise.all([
      open('Alice', {viewport:{width:1365, height:900}}), open('Ben', devices['iPad (gen 7)']),
    ]);
    for (const page of [alice, ben]) {
      await page.waitForFunction(() => document.querySelectorAll('#groupMemberIcons .is-viewing').length === 2);
      await page.getByLabel('Show contributions', {exact:true}).check();
    }

    const geometry = page => page.evaluate(async () => {
      const cm = window.eagleEditor;
      const wrapper = cm.getWrapperElement();
      const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      cm.scrollTo(0, cm.heightAtLine(130, 'local'));
      await frame();
      const previous = cm.getViewport();
      const line = previous.to - 4;
      const contribution = cm.findMarksAt({line, ch:4}).find(mark => mark.className?.includes('group-contribution'));
      if (!contribution) return {retained:false};
      const markRange = contribution.find();
      cm.scrollTo(0, cm.heightAtLine(line - 2, 'local'));
      await frame();
      const retained = cm.getViewport().to > previous.to && cm.findMarksAt({line, ch:4}).includes(contribution);
      const missing = [];
      for (const row of [300, 465, 850, 1030, 40]) {
        cm.scrollTo(row === 40 ? 0 : 240, cm.heightAtLine(row, 'local'));
        await frame();
        const scroll = cm.getScrollInfo();
        const middle = cm.lineAtHeight(scroll.top + scroll.clientHeight / 2, 'local');
        const gutter = wrapper.querySelector('.CodeMirror-gutters').getBoundingClientRect();
        const number = [...wrapper.querySelectorAll('.CodeMirror-linenumber')].find(node => Number(node.textContent) === middle + 1);
        const bounds = number?.getBoundingClientRect();
        if (!bounds?.height || bounds.left < gutter.left - 1 || bounds.right > gutter.right + 1) missing.push(middle + 1);
      }
      cm.scrollTo(0, 0);
      return {retained, markedLines:markRange.to.line - markRange.from.line, missing};
    });
    for (const page of [alice, ben]) {
      const result = await geometry(page);
      assert.deepEqual(result.missing, []);
      assert.equal(result.retained, true, 'Scrolling should retain contribution marks for rows still rendered');
      assert.ok(result.markedLines <= 32, 'Contribution marks should cover only a block of lines');
    }

    const rowHeight = () => ben.evaluate(() => {
      const cm = window.eagleEditor;
      return cm.heightAtLine(2, 'local') - cm.heightAtLine(1, 'local');
    });
    const originalHeight = await rowHeight();
    await alice.evaluate(() => {
      window.eagleEditor.focus();
      window.eagleEditor.setCursor({line:1, ch:5});
    });
    const cursor = ben.locator('.group-remote-cursor[title="Alice"]');
    await cursor.waitFor();
    assert.ok((await cursor.boundingBox()).width >= 4, 'The shared caret should be at least four pixels wide');
    assert.ok(Math.abs(await rowHeight() - originalHeight) < 1, 'The caret should not change line height');
    await cursor.focus();
    assert.match(await cursor.innerText(), /Alice/);

    await ben.getByRole('button', {name:'Edit', exact:true}).click();
    await ben.locator('#editorEditMenu [data-edit="find"]').click();
    const find = ben.locator('#editorFind');
    const query = find.getByRole('textbox', {name:'Find', exact:true});
    await query.pressSequentially('def MyFunction');
    assert.equal(await query.inputValue(), 'def MyFunction');
    assert.equal(await find.locator('#editorFindCount').innerText(), '1 of 3');
    await query.fill('def\u00a0MyFunction');
    assert.equal(await find.locator('#editorFindCount').innerText(), '1 of 3');
    await find.getByRole('textbox', {name:'Replace with'}).fill('def NewName');
    await find.getByRole('button', {name:'Replace all', exact:true}).click();
    const expected = source.replace(/def[ \t]+MyFunction\(/g, 'def NewName(');
    for (const page of [alice, ben]) {
      await page.waitForFunction(text => window.eagleEditor.getValue() === text && !window.GroupProjects.unsaved(), expected);
    }
    const saved = await api.get(`/api/group-projects/${project.id}/files/${project.files[0].id}`, {
      headers:aliceHeaders, params:{classId:server.classId},
    });
    assert.equal((await saved.json()).file.content, expected);
    assert.deepEqual(errors, []);
    console.log(`Shared editor browser checks passed in ${engine.name()}.`);
  } finally {
    await api?.dispose();
    await browser?.close();
    fixture.kill();
  }
}

main().catch(error => {console.error(error); process.exitCode = 1;});
