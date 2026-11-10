/* Opt-in Chromium verification against only the loopback group project fixture. */
const {chromium} = require('playwright');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {createInterface} = require('node:readline');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

async function main() {
  const python = process.env.EAGLE_GROUP_PYTHON || 'python';
  const fixture = spawn(python, [path.join(__dirname, 'group_projects_browser_fixture.py')], {stdio:['ignore','pipe','pipe']});
  let browser, logs = '';
  fixture.stderr.on('data', chunk => {logs = (logs + chunk).slice(-5000);});
  try {
    const lines = createInterface({input:fixture.stdout});
    const server = await Promise.race([
      (async () => {for await (const line of lines) if (line.startsWith('{"url"')) return JSON.parse(line); throw new Error('Fixture did not start:\n' + logs);})(),
      once(fixture,'exit').then(([code]) => {throw new Error('Fixture exited with ' + code);}),
    ]);
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    browser = await chromium.launch({headless:true, executablePath:process.env.EAGLE_GROUP_BROWSER});
    const screenshots = process.env.EAGLE_GROUP_SCREENSHOTS;
    if (screenshots) fs.mkdirSync(screenshots,{recursive:true});
    const errors = [];
    async function account(name, viewport = {width:1365,height:900}) {
      const teacher = name === 'Teacher';
      const context = await browser.newContext({viewport,ignoreHTTPSErrors:true});
      const profile = {email:name.toLowerCase()+'@example.test',name,role:teacher?'teacher':'student',
                       class_id:server.classId,class_ids:[server.classId]};
      await context.addInitScript(value => sessionStorage.setItem('eagle-auth-session-v1',JSON.stringify(value)),
        teacher ? {teacherToken:'group-teacher',currentTeacher:profile} : {userToken:'group-'+name.toLowerCase(),currentUser:profile});
      const page = await context.newPage();
      page.on('pageerror',error => errors.push(name + ': ' + error.message));
      page.on('dialog',dialog => dialog.accept());
      await page.goto(server.url,{waitUntil:'domcontentloaded',timeout:60000});
      await page.waitForFunction(() => window.eagleEditor && window.EagleIDE?.getContext?.().canAccessIDE);
      await page.waitForFunction(isTeacher => {
        const c = window.EagleIDE.getContext();
        return isTeacher ? c.teacherClasses?.length : c.currentStudentClassId && c.studentClassData;
      },teacher);
      await page.evaluate(() => window.WikiReader.showIDE(true));
      return page;
    }
    const [alice,ben,carmen,devon,teacher] = await Promise.all([
      account('Alice'), account('Ben'), account('Carmen'), account('Devon',{width:420,height:850}), account('Teacher'),
    ]);
    const files = async page => {
      const switcher = page.locator('#workspaceSwitchBtn');
      if (await switcher.getAttribute('aria-pressed') !== 'true') await switcher.click();
      await page.locator('#fileTree').waitFor();
    };
    await files(alice);
    const folder = alice.locator('.file-tree-item').filter({hasText:'Lab files'}).first();
    await folder.click({button:'right'});
    await alice.getByRole('menuitem',{name:'Share as group project…',exact:true}).click();
    for (const name of ['Ben','Carmen','Devon']) await alice.getByLabel(name,{exact:true}).check();
    await alice.getByRole('button',{name:'Create group project',exact:true}).click();
    await alice.getByRole('button',{name:'main.py',exact:true}).click();
    for (const [page, filename] of [[ben,'main.py'],[carmen,'message.txt'],[devon,'message.txt']]) {
      await files(page);
      await page.locator('[data-group-browse]').filter({hasText:'Lab files'}).click();
      await page.getByRole('button',{name:'Join group',exact:true}).click();
      await page.getByRole('button',{name:filename,exact:true}).click();
    }
    await alice.waitForFunction(() => document.querySelectorAll('#groupMemberIcons .is-viewing').length === 2);
    const text = page => page.evaluate(() => window.eagleEditor.getValue());
    const insert = (page,value) => page.evaluate(value => window.eagleEditor.replaceRange(value,{line:0,ch:0}),value);
    await Promise.all([insert(alice,'# Alice 😀\n'),insert(ben,'# Ben\n')]);
    for (const page of [alice,ben]) await page.waitForFunction(() => {
      const code = window.eagleEditor.getValue();
      return code.includes('# Alice 😀') && code.includes('# Ben') && !window.GroupProjects.unsaved();
    }, null, {timeout:5000});
    assert.equal(await text(alice),await text(ben));
    await alice.getByLabel('Show contributions',{exact:true}).check();
    await alice.locator('.CodeMirror .group-contribution').first().waitFor();
    await ben.evaluate(() => {window.eagleEditor.focus(); window.eagleEditor.setCursor({line:1,ch:1});});
    const remote = alice.locator('.group-remote-cursor[title="Ben"]');
    await remote.waitFor();
    await remote.focus();
    assert.match(await remote.innerText(),/Ben/);
    if (screenshots) await alice.screenshot({path:path.join(screenshots,'group-editing.png')});
    await ben.keyboard.press('Control+z');
    await alice.waitForFunction(() => !window.eagleEditor.getValue().includes('# Ben') && window.eagleEditor.getValue().includes('# Alice'));
    await ben.keyboard.press('Control+Shift+z');
    await alice.waitForFunction(() => window.eagleEditor.getValue().includes('# Ben'));
    await carmen.context().setOffline(true);
    await insert(carmen,'Carmen offline · ');
    await carmen.waitForFunction(() => window.GroupProjects.unsaved());
    await insert(devon,'Devon online · ');
    await devon.waitForFunction(() => !window.GroupProjects.unsaved());
    await carmen.context().setOffline(false);
    for (const page of [carmen,devon]) await page.waitForFunction(() => {
      const code = window.eagleEditor.getValue();
      return code.includes('Carmen offline') && code.includes('Devon online') && !window.GroupProjects.unsaved();
    });
    assert.equal(await text(carmen),await text(devon));
    await alice.locator('#runBtn').click();
    await alice.waitForFunction(() => document.getElementById('output').textContent.includes('Hello from the shared folder'));
    await alice.evaluate(({assignment,classId}) => window.EagleIDE.getContext().openAgendaAssignment(assignment,classId),server);
    await alice.locator(`.student-assignment-card[data-assignment-id="${server.assignment}"] .submit-assignment-btn`).click();
    await alice.getByRole('button',{name:'Choose group files',exact:true}).click();
    await alice.getByLabel('Submit for group',{exact:true}).check();
    await alice.getByRole('button',{name:'Turn in files',exact:true}).click();
    await alice.getByRole('heading',{name:'Files turned in',exact:true}).waitFor();
    await alice.getByRole('button',{name:'Done',exact:true}).click();
    await teacher.evaluate(() => openTeacherDashboard('dash-assignments'));
    await teacher.locator(`.assignment-title-row[data-id="${server.assignment}"]`).click();
    await teacher.locator('.assignment-view-file').first().click();
    const toggle = teacher.getByLabel('Highlight contributions',{exact:true});
    await toggle.check();
    const colors = teacher.locator('.assignment-file-source .group-contribution');
    assert.equal(await colors.count(),2);
    await toggle.uncheck();
    assert.equal(await colors.count(),0);
    await toggle.check();
    if (screenshots) await teacher.screenshot({path:path.join(screenshots,'teacher-contributions.png')});
    await teacher.locator('#themeToggleBtn').click();
    assert.equal(await colors.count(),2);
    if (screenshots) await teacher.screenshot({path:path.join(screenshots,'teacher-contributions-light.png')});
    await teacher.evaluate(() => openTeacherDashboard('dash-classes'));
    await teacher.locator('.cls-group-projects').click();
    await teacher.locator('[data-group-teacher]').filter({hasText:'Lab files'}).click();
    const row = teacher.locator('.group-teacher-members > div').filter({hasText:'Ben'});
    await row.getByRole('button',{name:'Remove',exact:true}).click();
    await ben.waitForFunction(() => window.eagleEditor.getValue() === '' && window.eagleEditor.getOption('readOnly'));
    await teacher.getByRole('dialog',{name:'Browse group project',exact:true}).getByRole('button',{name:'Close',exact:true}).click();
    await teacher.getByLabel('Enable group projects').uncheck();
    await teacher.getByRole('button',{name:'Save group settings',exact:true}).click();
    await alice.waitForFunction(() => window.eagleEditor.getValue() === '' && window.eagleEditor.getOption('readOnly'));
    await devon.locator('#layoutToggleBtn').click();
    await files(devon);
    await devon.getByRole('button',{name:/Lab files Recovery copy/}).waitFor();
    await devon.getByRole('button',{name:/Lab files Recovery copy/}).click();
    if (screenshots) await devon.screenshot({path:path.join(screenshots,'mobile-recovery.png')});
    assert.deepEqual(errors,[]);
    console.log('Group projects browser checks passed.');
  } finally {
    await browser?.close();
    fixture.kill();
  }
}
main().catch(error => {console.error(error); process.exitCode = 1;});
