/* Opt-in checks against lesson_plan_browser_fixture.py; never a classroom server. */
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const base = process.env.EAGLE_AGENDA_TEST_URL;
const output = process.env.EAGLE_AGENDA_SCREENSHOTS;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base || '')) throw new Error('Use the isolated agenda fixture URL');

(async () => {
  const browser = await chromium.launch({headless:true,executablePath:process.env.EAGLE_AGENDA_BROWSER || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  const errors = [];
  try {
    async function pageFor(session) {
      const context = await browser.newContext({viewport:{width:1440,height:1000}});
      if (session) await context.addInitScript(value => sessionStorage.setItem('eagle-auth-session-v1',JSON.stringify(value)),session);
      const page = await context.newPage();
      page.on('pageerror',error => errors.push(error.message));
      page.on('dialog',dialog => dialog.accept(dialog.type()==='prompt' ? 'Manager browser lesson' : undefined));
      await page.goto(base,{waitUntil:'networkidle',timeout:90000});
      await page.waitForFunction(() => EagleIDE?.getContext?.());
      return {context,page};
    }
    const admin = await pageFor({adminToken:'agenda-admin'});
    await admin.page.locator('#roleMenuBtn').click();
    await admin.page.locator('#adminUsersBtn').click();
    await admin.page.locator('#newStaffRole').selectOption('wiki_manager');
    await admin.page.locator('#newTeacherName').fill('Wiki Browser Manager');
    await admin.page.locator('#newTeacherEmail').fill('browser-manager@example.invalid');
    await admin.page.locator('#newTeacherPassword').fill('fixture-manager-password');
    await admin.page.locator('#createTeacherBtn').click();
    await admin.page.locator('#adminUsersStatsBody tr[data-role="wiki_manager"]').waitFor();
    await admin.page.locator('#adminUsersCloseBtn').click();

    const manager = await pageFor();
    await manager.page.locator('#loginBtn').click();
    await manager.page.locator('#authEmailInput').fill('browser-manager@example.invalid');
    await manager.page.locator('#authPasswordInput').fill('fixture-manager-password');
    await manager.page.locator('#loginSubmitBtn').click();
    await manager.page.waitForFunction(() => !!EagleIDE.getContext().WIKI_MANAGER_TOKEN);
    await manager.page.locator('#roleMenuBtn').click();
    await manager.page.locator('#adminWikiBtn').click();
    await manager.page.locator('#wikiAdminNewPageBtn').waitFor();
    for (const id of ['adminUsersBtn','teacherDashboardBtn','adminSettingsBtn','wikiAdminHistoryBtn','wikiAdminBackupBtn','wikiAdminAnalyticsBtn']) {
      assert.equal(await manager.page.locator('#'+id).isVisible(),false,`${id} should be unavailable to managers`);
    }
    await manager.page.locator('#wikiAdminNewPageBtn').click();
    await manager.page.locator('#wikiAdminEditor').waitFor({state:'visible'});
    await manager.page.locator('#wikiAdminProperties').evaluate(element => {element.open=true;});
    await manager.page.locator('#wikiAdminStatus').selectOption('published');
    await manager.page.locator('#wikiAdminContent').fill('# Manager browser lesson\n\nOriginal browser content.');
    await manager.page.locator('#wikiAdminSaveBtn').click();
    await manager.page.waitForFunction(() => document.getElementById('wikiAdminProgress').textContent.includes('Published successfully'));
    const token = await manager.page.evaluate(() => EagleIDE.getContext().WIKI_MANAGER_TOKEN);
    await manager.page.locator('#wikiAdminContent').fill('# Manager browser lesson\n\nEdited browser content.');
    await manager.page.locator('#wikiAdminSaveBtn').click();
    await manager.page.waitForFunction(() => document.getElementById('wikiAdminProgress').textContent.includes('Published successfully'));
    const history = await (await admin.context.request.get(base+'/api/admin/wiki/history',{headers:{'X-Admin-Token':'agenda-admin'}})).json();
    const edit = history.entries.find(row => row.actor==='browser-manager@example.invalid' && row.action==='admin_wiki_node_update');
    assert.ok(edit?.can_restore);

    for (const [width,theme] of [[1440,'dark'],[768,'light'],[390,'dark'],[390,'light']]) {
      await manager.page.setViewportSize({width,height:1000});
      await manager.page.evaluate(light => document.body.classList.toggle('light-mode',light),theme==='light');
      assert.ok(await manager.page.locator('.wiki-manager-modal').evaluate(el => el.getBoundingClientRect().width<=innerWidth+2));
      if (output) { fs.mkdirSync(output,{recursive:true}); await manager.page.screenshot({path:path.join(output,`wiki-manager-${width}-${theme}.png`)}); }
    }
    await manager.page.locator('#wikiAdminCloseBtn').click();
    await manager.page.locator('#roleMenuBtn').click();
    await manager.page.locator('#wikiManagerAccountBtn').click();
    await manager.page.locator('#wikiManagerAccountModal').waitFor({state:'visible'});
    assert.ok(await manager.page.locator('.wiki-manager-account').evaluate(el => el.scrollWidth<=el.clientWidth+2));
    await manager.page.locator('#wikiManagerAccountModal .external-tool-storage-open').click();
    await manager.page.locator('#externalToolStorageUsage').filter({hasText:'used.'}).waitFor();
    await manager.page.locator('#externalToolStorageDone').click();
    if (output) await manager.page.screenshot({path:path.join(output,'wiki-manager-account-mobile.png')});
    await manager.page.locator('#wikiManagerAccountClose').click();
    await manager.page.setViewportSize({width:1440,height:1000});
    await manager.page.locator('#ideViewBtn').click();
    await manager.page.evaluate(() => EagleIDE.getContext().setEditorSnapshot({code:'print("Wiki manager run OK")',language:'python',fileName:'manager-smoke.py',draft:true}));
    await manager.page.locator('#runBtn').click();
    await manager.page.waitForFunction(() => document.getElementById('output').textContent.includes('Wiki manager run OK') && !EagleIDE.getContext().isProgramRunning);
    await manager.page.reload({waitUntil:'networkidle'});
    await manager.page.waitForFunction(() => !!EagleIDE.getContext().WIKI_MANAGER_TOKEN);
    assert.equal(await (await manager.context.request.get(base+'/api/admin/users',{headers:{'X-Wiki-Manager-Token':token}})).status(),401);

    await admin.page.locator('#roleMenuBtn').click();
    await admin.page.locator('#adminWikiBtn').click();
    await admin.page.locator('#wikiAdminHistoryBtn').click();
    await admin.page.locator('.wiki-history-entry').first().waitFor();
    await admin.page.locator('.wiki-history-entry').filter({hasText:edit.target}).first().getByRole('button',{name:'Restore before this edit'}).click();
    await admin.page.waitForFunction(() => document.getElementById('wikiAdminProgress').textContent.includes('Wiki restored'));
    const restored = await (await admin.context.request.get(base+'/api/wiki/nodes/'+edit.target)).json();
    assert.match(restored.node.markdown,/Original browser content/);

    const student = await pageFor({userToken:'agenda-student',currentUser:{email:'student@example.test',name:'Jamie Lee',role:'student',class_id:'agenda-class',class_ids:['agenda-class']}});
    await student.page.locator('#studentLessonPlanHost .lesson-plan-day-scroll').first().waitFor();
    const shell = student.page.locator('.wiki-reader-shell');
    for (const width of [1440,768,390]) {
      await student.page.setViewportSize({width,height:1000});
      await student.page.evaluate(() => document.body.classList.remove('wiki-drawer-open'));
      await student.page.waitForTimeout(250);
      const day = student.page.locator('#studentLessonPlanHost .lesson-plan-day-scroll').first();
      await day.scrollIntoViewIfNeeded();
      await shell.evaluate(el => {el.scrollTop=Math.max(0,el.scrollTop-40);});
      const box = await day.boundingBox();
      await student.page.mouse.move(box.x+Math.min(30,box.width/2),box.y+Math.min(30,box.height/2));
      const before = await shell.evaluate(el => el.scrollTop);
      await student.page.mouse.wheel(0,180);
      await student.page.waitForFunction(value => document.querySelector('.wiki-reader-shell').scrollTop>value,before);
      if (output) await student.page.screenshot({path:path.join(output,`home-scroll-${width}.png`)});
    }
    assert.equal((await admin.context.request.get(base+'/health')).status(),200);
    assert.deepEqual(errors,[]);
    console.log('PASS: admin account creation, manager login/restore/editing/IDE/account controls, admin audit rollback, desktop/tablet/mobile light/dark layouts, and Home scroll chaining.');
  } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
