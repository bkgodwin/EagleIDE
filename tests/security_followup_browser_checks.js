/* Opt-in: only lesson_plan_browser_fixture.py, never a classroom server. */
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const base = process.env.EAGLE_AGENDA_TEST_URL;
const output = process.env.EAGLE_AGENDA_SCREENSHOTS;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base || '')) throw new Error('Use the isolated agenda fixture URL');

(async () => {
  const browser = await chromium.launch({headless: true, executablePath: process.env.EAGLE_AGENDA_BROWSER});
  try {
    const context = await browser.newContext({viewport: {width: 1280, height: 800}});
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base, {waitUntil: 'networkidle'});
    await page.evaluate(() => {
      window.popupEvents = [];
      window.popupChannel = new BroadcastChannel('eagle-html-runtime-followup-fixture');
      popupChannel.onmessage = event => popupEvents.push(event.data);
    });
    const popupPromise = context.waitForEvent('page');
    await page.evaluate(() => window.open('/api/html-runtime/popup/followup-fixture', '_blank'));
    const popup = await popupPromise;
    popup.on('pageerror', error => errors.push(error.message));
    await popup.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => popupEvents.some(event => event.type === 'ready'));
    const policy = (await context.request.get(base + '/api/html-runtime/popup/followup-fixture')).headers()['content-security-policy'];
    assert.match(policy, /script-src 'self'/);
    assert.doesNotMatch(policy.match(/script-src[^;]*/)[0], /unsafe-inline/);
    await popup.evaluate(() => {
      window.bootstrapViolations = [];
      addEventListener('securitypolicyviolation', event => {
        if (event.effectiveDirective.startsWith('script-src')) bootstrapViolations.push(event.blockedURI);
      });
    });
    async function start(timeoutSeconds = 30) {
      const response = await context.request.post(base + '/api/html-runtime/start', {
        headers: {'X-User-Token': 'agenda-student'}, data: {file_path: 'preview.html'},
      });
      assert.equal(response.status(), 200);
      const runtime = await response.json();
      await page.evaluate(runtime => popupChannel.postMessage({type: 'load', runtime}), {...runtime, timeout_seconds: timeoutSeconds});
      await popup.frameLocator('#runtimeFrame').getByRole('heading', {name: 'Preview fixture'}).waitFor();
      assert.equal(await popup.locator('#runtimeFrame').getAttribute('sandbox'), 'allow-scripts');
      return runtime;
    }
    async function assertRemoved(runtime) {
      await page.waitForFunction(async url => (await fetch(url)).status === 404, runtime.view_url);
    }
    const stopped = await start();
    if (output) {
      fs.mkdirSync(output, {recursive: true});
      await popup.screenshot({path: path.join(output, 'html-popup-desktop.png')});
      await popup.setViewportSize({width: 390, height: 844});
      assert.ok(await popup.locator('#runtimeFrame').evaluate(frame => frame.getBoundingClientRect().right <= innerWidth));
      await popup.screenshot({path: path.join(output, 'html-popup-mobile.png')});
    }
    await page.evaluate(() => popupChannel.postMessage({type: 'stop', reason: 'Fixture stop'}));
    await popup.locator('#runtimeEmpty').filter({hasText: 'Fixture stop'}).waitFor();
    await assertRemoved(stopped);
    const timed = await start(1);
    await popup.locator('#runtimeEmpty').filter({hasText: 'Execution time limit reached.'}).waitFor();
    await assertRemoved(timed);
    assert.deepEqual(await popup.evaluate(() => bootstrapViolations), []);
    const exited = await start();
    const closed = popup.waitForEvent('close');
    await popup.locator('#runtimeExitBtn').click();
    await closed;
    await assertRemoved(exited);

    // Keep a real editor buffer mounted while server-side revocation disconnects
    // two student sockets. A teacher connection must remain usable.
    const studentContext = await browser.newContext();
    await studentContext.addInitScript(() => sessionStorage.setItem('eagle-auth-session-v1', JSON.stringify({
      userToken: 'agenda-student', currentUser: {email: 'student@example.test', name: 'Fixture Student', role: 'student', class_id: 'agenda-class', class_ids: ['agenda-class']},
    })));
    const student = await studentContext.newPage();
    student.on('pageerror', error => errors.push(error.message));
    await student.goto(base, {waitUntil: 'networkidle'});
    await student.waitForFunction(() => !!window.EagleIDE?.getContext?.().USER_TOKEN && typeof io === 'function');
    await student.locator('#ideViewBtn').click();
    await student.evaluate(async () => {
      await EagleIDE.getContext().setEditorSnapshot({code: 'print("retained security fixture")', language: 'python', fileName: 'retained.py', draft: true});
      window.fixtureSockets = [];
      for (const [role, token] of [['student', 'agenda-student'], ['student', 'agenda-student'], ['teacher', 'agenda-teacher']]) {
        const socket = io({forceNew: true});
        await new Promise((resolve, reject) => {
          socket.on('connect_error', reject);
          socket.on('connect', () => {
            socket.emit('join_class_room', {class_id: 'agenda-class', role, token});
            socket.once('teacher_stream_status', resolve);
          });
        });
        fixtureSockets.push(socket);
      }
    });
    const disabled = await context.request.post(base + '/api/teacher/students/toggle', {
      headers: {'X-Teacher-Token': 'agenda-teacher'}, data: {email: 'student@example.test', enabled: false},
    });
    assert.equal(disabled.status(), 200);
    await student.waitForFunction(() => !fixtureSockets[0].connected && !fixtureSockets[1].connected && fixtureSockets[2].connected);
    assert.equal(await student.evaluate(() => EagleIDE.getContext().getEditorSnapshot().code), 'print("retained security fixture")');
    assert.equal((await context.request.get(base + '/api/auth/me', {headers: {'X-User-Token': 'agenda-student'}})).status(), 401);
    assert.equal((await context.request.get(base + '/api/auth/me', {headers: {'X-Teacher-Token': 'agenda-teacher'}})).status(), 200);
    if (output) await student.screenshot({path: path.join(output, 'revoked-student-buffer-retained.png')});
    await student.evaluate(() => fixtureSockets.forEach(socket => socket.disconnect()));
    assert.deepEqual(errors, []);
    await studentContext.close();
    await context.close();
    console.log('PASS: popup ready/load/stop/timeout/exit and cleanup under enforcing CSP; desktop/mobile; live student revocation, retained editor buffer, unaffected teacher.');
  } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exitCode = 1;});
