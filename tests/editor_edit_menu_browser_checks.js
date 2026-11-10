/* Opt-in: use lesson_plan_browser_fixture.py with temporary accounts and files. */
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const base = process.env.EAGLE_AGENDA_TEST_URL;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base || '')) throw new Error('Use the isolated browser fixture');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.EAGLE_AGENDA_BROWSER });
  try {
    const headers = { 'X-User-Token': 'agenda-student' };
    const context = await browser.newContext({
      viewport: { width: 1440, height: 950 }, permissions: ['clipboard-read', 'clipboard-write'],
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'platform', { value: 'Win32' });
      sessionStorage.setItem('eagle-auth-session-v1', JSON.stringify({
        userToken: 'agenda-student', currentUser: { email: 'student@example.test', role: 'student' },
      }));
    });
    const name = `edit-menu-${Date.now()}.py`;
    assert.deepEqual(await (await context.request.get(base + '/health')).json(), { ok: true });
    assert.equal((await context.request.post(base + '/api/files/create', { headers, data: { name } })).ok(), true);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.locator('#ideViewBtn').click();
    await page.waitForFunction(() => window.eagleEditor && window.EagleIDE.getContext().USER_TOKEN);
    await page.evaluate(path => EagleIDE.getContext().openWorkspacePath(path), name);
    await page.waitForFunction(path => EagleIDE.getContext().getCurrentFile()?.path === path, name);
    const edit = page.locator('#editorEditBtn');
    const menu = page.locator('#editorEditMenu');
    const find = page.locator('#editorFind');
    const action = name => menu.locator(`[data-edit="${name}"]`);
    const choose = async name => { await edit.click(); await action(name).click(); };
    const setCode = code => page.evaluate(code => { eagleEditor.setValue(code); eagleEditor.clearHistory(); }, code);
    const code = () => page.evaluate(() => eagleEditor.getValue());
    const source = 'cat CAT catfish a+b\n' + '# long file\n'.repeat(160) + 'cat';
    await setCode(source);
    await edit.click();
    assert.equal(await action('find').getAttribute('title'), 'Find and replace (Ctrl+F)');
    assert.match(await menu.evaluate(node => getComputedStyle(node).backdropFilter), /blur\(/);
    await action('find').click();
    const query = find.getByRole('textbox', { name: 'Find', exact: true });
    await query.fill('a+b');
    assert.equal(await page.locator('#editorFindCount').innerText(), '1 of 1');
    await query.fill('cat');
    assert.equal(await page.locator('#editorFindCount').innerText(), '1 of 3');
    assert.equal(await page.locator('.cm-eagle-find-match').count(), 2);
    await find.getByLabel('Case sensitive').check();
    assert.equal(await page.locator('#editorFindCount').innerText(), '1 of 2');
    await find.getByLabel('Contains').check();
    assert.equal(await page.locator('#editorFindCount').innerText(), '1 of 3');

    await page.evaluate(() => eagleEditor.focus());
    await page.keyboard.insertText('blocked');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Backspace');
    assert.equal(await code(), source);
    const box = await page.locator('#studentEditorWrap').boundingBox();
    await page.mouse.move(box.x + 60, box.y + box.height / 2);
    await page.mouse.wheel(0, 240);
    await page.waitForFunction(() => eagleEditor.getScrollInfo().top > 0);
    assert.equal(await find.isVisible(), true);
    await find.getByLabel('Contains').uncheck();
    await find.getByRole('textbox', { name: 'Replace with' }).fill('$&');
    await find.getByRole('button', { name: 'Replace all' }).click();
    assert.equal(await code(), source.replace(/^cat/, '$$&').replace(/cat$/, '$$&'));
    assert.equal(await find.isVisible(), false);
    assert.equal(await page.evaluate(() => eagleEditor.getOption('readOnly')), false);
    await choose('undo');
    assert.equal(await code(), source);
    await choose('redo');
    assert.match(await code(), /^\$& CAT catfish/);
    await page.keyboard.press('Control+f');
    await query.fill('catfish');
    await find.getByRole('textbox', { name: 'Replace with' }).fill('fish');
    await find.getByRole('button', { name: 'Replace', exact: true }).click();
    assert.match(await code(), /^\$& CAT fish/);

    await setCode('one\n\ttwo\nthree');
    await page.evaluate(() => eagleEditor.setSelection({ line: 0, ch: 0 }, { line: 2, ch: 0 }));
    await choose('comment');
    assert.equal(await code(), '# one\n# \ttwo\nthree');
    await choose('comment');
    await choose('indent');
    assert.equal(await code(), '\tone\n\t\ttwo\nthree');
    await choose('unindent');
    assert.equal(await code(), 'one\n\ttwo\nthree');
    await page.evaluate(() => eagleEditor.setSelection({ line: 0, ch: 0 }, { line: 0, ch: 3 }));
    await choose('copy');
    await page.waitForFunction(async () => (await navigator.clipboard.readText()) === 'one');
    await choose('cut');
    await page.waitForFunction(() => eagleEditor.getLine(0) === '');
    await choose('paste');
    await page.waitForFunction(() => eagleEditor.getLine(0) === 'one');
    assert.deepEqual(await page.evaluate(() => EagleIDE.getContext().getCurrentFile().pasteRanges), [[0, 3]]);

    const editable = await code();
    await setCode('print("Edit menu fixture")');
    await page.locator('#runBtn').click();
    await page.locator('#output').getByText('Edit menu fixture', { exact: false }).waitFor();
    await page.waitForFunction(() => !EagleIDE.getContext().isProgramRunning);
    await setCode(editable);

    await page.evaluate(() => { window.AssignmentDevelopment.blocked = () => true; });
    await edit.click();
    assert.equal(await action('paste').isDisabled(), true);
    await page.keyboard.press('Escape');

    await page.route('**/api/files/write', route => route.abort());
    await page.evaluate(() => eagleEditor.replaceRange('!', { line: 2, ch: 5 }));
    await choose('duplicate');
    await page.locator('#editorEditStatus').getByText(/Created .*?-copy\.py/).waitFor();
    const duplicate = await context.request.get(base + '/api/files/read', {
      headers, params: { path: name.replace('.py', '-copy.py') },
    });
    assert.equal((await duplicate.json()).content, 'one\n\ttwo\nthree!');

    for (const [width, height] of [[1440, 950], [768, 1024], [390, 650]]) {
      await page.setViewportSize({ width, height });
      for (const light of [false, true]) {
        await page.evaluate(light => {
          document.body.classList.toggle('light-mode', light);
          EagleEditorAppearance.applyAll();
        }, light);
        await choose('find');
        const bounds = await find.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
        assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= height);
        await page.keyboard.press('Escape');
      }
    }
    assert.deepEqual(errors, []);

    const fallback = await context.newPage();
    fallback.on('pageerror', error => errors.push(error.message));
    await fallback.addInitScript(() => {
      Object.defineProperty(navigator, 'userAgentData', { value: { platform: 'macOS' } });
    });
    await fallback.route('**/codemirror/**', route => route.abort());
    await fallback.goto(base);
    await fallback.locator('#ideViewBtn').click();
    await fallback.waitForFunction(() => window.EagleIDE.getContext().USER_TOKEN);
    await fallback.evaluate(path => EagleIDE.getContext().openWorkspacePath(path), name);
    const textarea = fallback.locator('#editor');
    await textarea.fill('first\nsecond');
    await textarea.evaluate(node => node.select());
    const fallbackAction = name => fallback.locator(`#editorEditMenu [data-edit="${name}"]`);
    await fallback.locator('#editorEditBtn').click();
    assert.equal(await fallbackAction('find').getAttribute('title'), 'Find and replace (Command+F)');
    await fallbackAction('comment').click();
    assert.equal(await textarea.inputValue(), '# first\n# second');
    await fallback.locator('#editorEditBtn').click();
    await fallbackAction('undo').click();
    assert.equal(await textarea.inputValue(), 'first\nsecond');
    await fallback.locator('#editorEditBtn').click();
    await fallbackAction('find').click();
    await fallback.locator('#editorFind input[name="query"]').fill('second');
    assert.equal(await textarea.evaluate(node => node.readOnly), true);
    await fallback.locator('#editorFind input[name="replacement"]').fill('next');
    await fallback.locator('#editorFind [data-find="replace"]').click();
    assert.equal(await textarea.inputValue(), 'first\nnext');
    assert.equal(await textarea.evaluate(node => node.readOnly), false);
    assert.deepEqual(errors, []);
    console.log('Editor Edit menu browser checks passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
