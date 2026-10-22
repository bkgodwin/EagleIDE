/* Run only against lesson_plan_browser_fixture.py, never a classroom server. */
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const base = process.env.EAGLE_AGENDA_TEST_URL;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base || '')) throw new Error('Use the isolated agenda fixture');

(async () => {
  const browser = await chromium.launch({headless: true, executablePath: process.env.EAGLE_AGENDA_BROWSER});
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const home = await page.goto(base, {waitUntil: 'networkidle'});
    assert.match(home.headers()['content-security-policy'], /script-src 'self'/);
    await page.evaluate(() => sessionStorage.setItem('security-fixture', 'retained'));
    const started = await context.request.post(base + '/api/html-runtime/start', {
      headers: {'X-User-Token': 'agenda-student'}, data: {file_path: 'preview.html'},
    });
    assert.equal(started.status(), 200);
    const runtime = await started.json();
    const prefix = base + '/api/html-runtime/view/' + runtime.runtime_id + '/';
    for (const file of ['attack.htm', 'attack.svg']) {
      const response = await page.goto(prefix + file);
      assert.equal(response.status(), 200);
      assert.match(response.headers()['content-security-policy'], /script-src 'none'/);
      assert.match(response.headers()['content-security-policy'], /sandbox/);
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-student-script')), null);
      assert.equal(await page.evaluate(() => {try {sessionStorage.getItem('security-fixture'); return true;} catch {return false;}}), false);
    }
    assert.equal((await context.request.get(prefix + '.eagleide/private.json')).status(), 404);
    await page.goto(base, {waitUntil: 'domcontentloaded'});
    assert.equal(await page.evaluate(() => sessionStorage.getItem('security-fixture')), 'retained');
    for (const route of ['/api/explain', '/api/assistant/chat']) {
      assert.equal((await context.request.post(base + route, {data: {code: 'print(1)', sid: 'rotated'}})).status(), 403);
    }
    await context.close();
    console.log('PASS: main CSP, direct HTM/SVG script denial, opaque preview storage, private-file denial, retained main-origin storage, anonymous AI denial.');
  } finally {
    await browser.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
