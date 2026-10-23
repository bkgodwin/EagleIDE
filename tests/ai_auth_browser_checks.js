/* Only lesson_plan_browser_fixture.py --mock-ai, never a classroom deployment. */
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const base = process.env.EAGLE_AGENDA_TEST_URL;
const output = process.env.EAGLE_AGENDA_SCREENSHOTS;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base || '')) throw new Error('Use the isolated --mock-ai fixture URL');

(async () => {
  const browser = await chromium.launch({headless: true, executablePath: process.env.EAGLE_AGENDA_BROWSER});
  try {
    const cases = [
      ['student', {userToken: 'agenda-student', currentUser: {email: 'student@example.test', role: 'student'}}, 'x-user-token', 'agenda-student'],
      ['teacher', {teacherToken: 'agenda-teacher', currentTeacher: {email: 'teacher@example.test', role: 'teacher'}}, 'x-teacher-token', 'agenda-teacher'],
      ['admin', {adminToken: 'agenda-admin'}, 'x-admin-token', 'agenda-admin'],
      ['wiki_manager', {wikiManagerToken: 'agenda-ai-manager', currentUser: {email: 'ai-manager@example.test', role: 'wiki_manager'}}, 'x-wiki-manager-token', 'agenda-ai-manager'],
      ['coteacher', {teacherToken: 'agenda-ai-coteacher', currentTeacher: {email: 'ai-coteacher@example.test', role: 'teacher', is_coteacher: true}}, 'x-user-token', 'agenda-ai-coteacher'],
    ];
    const errors = [];
    for (const [role, session, expectedHeader, token] of cases) {
      const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
      await context.addInitScript(value => sessionStorage.setItem('eagle-auth-session-v1', JSON.stringify(value)), session);
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', dialog => dialog.accept());
      await page.goto(base, {waitUntil: 'networkidle'});
      await page.waitForFunction(() => !!window.EagleIDE?.getContext?.());
      await page.locator('#ideViewBtn').click();
      await page.evaluate(async () => EagleIDE.getContext().setEditorSnapshot({code: 'print("AI browser fixture")', language: 'python', fileName: 'ai-fixture.py', draft: true}));
      for (const [route, tab, button, field] of [
        ['/api/explain', '#aiTabBtn', '#aiExplainBtn', 'text'],
        ['/api/assistant/chat', '#assistantTabBtn', '#assistantSend', 'reply'],
      ]) {
        await page.locator(tab).click();
        if (field === 'reply') await page.locator('#assistantInput').fill('Explain this Python print call.');
        const pending = page.waitForResponse(response => response.url() === base + route && response.request().method() === 'POST');
        await page.locator(button).click();
        const response = await pending;
        assert.equal(response.status(), 200, `${role} ${route}: ${await response.text()}`);
        const headers = await response.request().allHeaders();
        assert.equal(headers[expectedHeader], token);
        assert.deepEqual(Object.keys(headers).filter(name => name.endsWith('-token')), [expectedHeader]);
        assert.equal((await response.json())[field], 'AI browser fixture response.');
        await page.locator(field === 'text' ? '#aiOutput' : '#assistantChat').filter({hasText: 'AI browser fixture response.'}).waitFor();
      }
      assert.equal(await page.evaluate(() => EagleIDE.getContext().getEditorSnapshot().code), 'print("AI browser fixture")');
      if (output) {
        fs.mkdirSync(output, {recursive: true});
        await page.screenshot({path: path.join(output, `ai-${role}-desktop.png`)});
        await page.setViewportSize({width: 390, height: 844});
        await page.screenshot({path: path.join(output, `ai-${role}-mobile.png`)});
      }
      for (const route of ['/api/explain', '/api/assistant/chat']) {
        const denied = await context.request.post(base + route, {headers: {'X-SID': 'public-socket-id'},
          data: {code: 'print(1)', messages: [{role: 'user', content: 'Explain'}], user_token: token}});
        assert.equal(denied.status(), 403);
      }
      await context.close();
    }
    assert.deepEqual(errors, []);
    console.log('PASS: real Explain/Chat buttons for student, teacher, admin, wiki manager and co-teacher; role headers, HTTP dispatcher, visible AI replies, retained code, and anonymous/SID-only denial.');
  } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exitCode = 1;});
