/* Opt-in against lesson_plan_browser_fixture.py with EAGLE_CLEANUP_BROWSER_FIXTURE=1 only. */
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const base = process.env.EAGLE_AGENDA_TEST_URL, output = process.env.EAGLE_AGENDA_SCREENSHOTS;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base || '')) throw new Error('Use the isolated cleanup fixture URL');
(async () => {
  const browser = await chromium.launch({headless:true, executablePath:process.env.EAGLE_AGENDA_BROWSER});
  try {
    const context = await browser.newContext({viewport:{width:1280,height:900}});
    await context.addInitScript(() => sessionStorage.setItem('eagle-auth-session-v1', JSON.stringify({adminToken:'agenda-admin'})));
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base, {waitUntil:'networkidle'});
    await page.locator('#roleMenuBtn').click();
    await page.locator('#adminSettingsBtn').click();
    await page.locator('[data-admin-settings-section="cleanup"]').click();
    await page.locator('[data-cleanup-days="workspace_trash"]').waitFor();
    assert.equal(await page.locator('#cleanupEnabled').isChecked(), false);
    assert.equal(await page.locator('[data-cleanup-toggle][aria-pressed="true"]').count(), 0);
    assert.equal(await page.locator('#cleanupRunNow').isDisabled(), true);
    await page.locator('#cleanupEnabled').check();
    await page.locator('[data-cleanup-toggle="workspace_trash"]').click();
    await page.locator('[data-cleanup-days="workspace_trash"]').fill('30');
    assert.equal(await page.locator('#cleanupRunNow').isDisabled(), true);
    await page.locator('#settingsSaveBtn').click();
    await page.waitForFunction(() => !document.getElementById('cleanupRunNow').disabled);
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#cleanupRunNow').click();
    await page.waitForFunction(() => document.getElementById('cleanupLog').textContent.includes('cleanup-old.py') &&
      document.getElementById('cleanupRuns').textContent.includes('completed'));
    const files = await context.request.get(base + '/api/files/list', {headers:{'X-User-Token':'agenda-student'}});
    assert.equal(files.status(), 200);
    const tree = JSON.stringify(await files.json());
    assert.ok(tree.includes('cleanup-recent.py')); assert.ok(tree.includes('preview.html')); assert.ok(!tree.includes('cleanup-old.py'));
    const saved = await context.request.post(base + '/api/files/write', {headers:{'X-User-Token':'agenda-student'},
      data:{path:'preview.html',content:'<h1>Still saved after cleanup</h1>',require_existing:true}});
    assert.equal(saved.status(), 200);
    const health = await context.request.get(base + '/health'); assert.equal(health.status(), 200);
    const runOutput = await page.evaluate(() => new Promise((resolve,reject) => {
      const socket = io({forceNew:true}), timeout = setTimeout(() => {socket.disconnect();reject(new Error('Runner timed out'));},15000);
      let output=''; socket.on('output', event => {output += event.data || '';});
      socket.on('finished', () => {clearTimeout(timeout);socket.disconnect();resolve(output);});
      socket.on('connect', () => socket.emit('run_code', {code:'print("cleanup runner fixture")',language:'python',user_token:'agenda-student',file_path:''}));
    }));
    assert.ok(runOutput.includes('cleanup runner fixture'));
    for (const [width, height, theme] of [[1280,900,'light'], [1280,900,'dark'], [768,1024,'light'], [768,1024,'dark'], [390,844,'light'], [390,844,'dark']]) {
      await page.setViewportSize({width,height});
      await page.evaluate(theme => document.body.classList.toggle('light-mode', theme === 'light'), theme);
      assert.ok(await page.locator('#cleanupRules').evaluate(node => node.getBoundingClientRect().right <= innerWidth + 1));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.locator('.admin-settings-content').evaluate(node => {node.scrollTop=0;});
      if (output) {fs.mkdirSync(output,{recursive:true}); await page.screenshot({path:path.join(output,`cleanup-${theme}-${width}.png`)});}
    }
    // Unrelated Settings sections must keep their normal Save button semantics.
    await page.locator('[data-admin-settings-section="general"]').click();
    assert.equal(await page.locator('#settingsSaveBtn').textContent(), 'Save Settings');
    assert.equal(await page.locator('#settingsSaveBtn').isDisabled(), false);
    await page.locator('[data-admin-settings-section="cleanup"]').click();
    await page.waitForFunction(() => document.getElementById('cleanupEnabled').checked);
    await page.locator('#cleanupEnabled').uncheck(); await page.locator('#settingsSaveBtn').click();
    await page.waitForFunction(() => document.getElementById('cleanupStatus').textContent === 'Cleanup rules saved.');
    assert.equal(await page.locator('#cleanupRunNow').isDisabled(), true);
    assert.deepEqual(errors, []);
    console.log('PASS: default-off rules, explicit save, old-only cleanup, permanent receipts, preserved files and saving, healthy server/Python runner, desktop/tablet/mobile in both themes, Settings navigation.');
    await context.close();
  } finally {await browser.close();}
})().catch(error => {console.error(error); process.exitCode=1;});
