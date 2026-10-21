/* Optional integration check. Serve a downloaded, unmodified SolidCraft web build
 * with external_tools_browser_fixture.py --app-directory <public-build-folder>.
 * No app download, installation or production configuration is performed here. */
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const base = process.env.EAGLE_TOOL_TEST_URL;
if (!base || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('Use the isolated local fixture URL');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.EAGLE_TOOL_BROWSER || chromium.executablePath(),
    // The test machine may have no physical GPU. This affects this test only.
    args: ['--enable-unsafe-swiftshader'],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
    await context.addInitScript(() => { try { sessionStorage.setItem('eagle-auth-session-v1', JSON.stringify({ adminToken: 'fixture-admin' })); } catch {} });
    const page = await context.newPage(), integrityErrors = [];
    page.on('dialog', dialog => dialog.accept());
    page.on('console', message => { if (message.type() === 'error' && /integrity/i.test(message.text())) integrityErrors.push(message.text()); });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.ExternalTools && window.EagleIDE?.getContext?.().ADMIN_TOKEN);
    const tool = await page.evaluate(async () => {
      const api = window.ExternalTools.api;
      let catalog = (await api('/api/admin/tools')).catalog;
      if (catalog.tools.length) throw new Error('Start a fresh fixture for this check');
      await api('/api/admin/tools/policy', { method: 'PUT', body: JSON.stringify({ revision: catalog.revision, enabled: true, allowed_networks: ['10.231.24.0/24'], denied_networks: [] }) });
      catalog = (await api('/api/admin/tools')).catalog;
      const result = await api('/api/admin/tools', { method: 'POST', body: JSON.stringify({ revision: catalog.revision, name: 'SolidCraft test', label: 'Open SolidCraft', slug: 'solidcraft-test', backend_url: 'http://fixture.internal:8080/prefix/', storage: true, popups: true, dialogs: true }) });
      const tested = await api(`/api/admin/tools/${result.tool.id}/test`, { method: 'POST', body: JSON.stringify({ revision: result.revision }) });
      if (!tested.reachable) throw new Error('Fixture build is not reachable');
      return tested.tool;
    });
    await page.evaluate(tool => window.ExternalTools.open(tool), tool);
    const frameHost = page.locator('#externalToolFrameHost iframe');
    await frameHost.waitFor();
    const frame = await (await frameHost.elementHandle()).contentFrame();
    async function waitForBox(target) {
      for (let attempt = 0; attempt < 300; attempt++) {
        const model = await target.evaluate(() => solidcraft.inspect({ measure: true }));
        if (model.bodies[0]?.volume_mm3 === 6000) return;
        await page.waitForTimeout(100);
      }
      throw new Error('Expected imported/restored box geometry did not become available');
    }
    await frame.waitForFunction(() => window.solidcraft && !document.getElementById('solidcraft_loading'), null, { timeout: 90000 });
    assert.equal(await frame.locator('link[rel=stylesheet][integrity]').first().getAttribute('crossorigin'), 'anonymous');
    assert.equal(integrityErrors.length, 0);
    const geometry = await frame.evaluate(async () => {
      await solidcraft.request('ui.home', { open: false });
      await solidcraft.execute('solid.box', { length: 30, width: 20, height: 10, body_name: 'Gateway test box' });
      return solidcraft.inspect({ measure: true });
    });
    assert.equal(geometry.bodies[0].volume_mm3, 6000);
    assert.equal(geometry.bodies[0].faces, 6);
    await frame.evaluate(() => solidcraft.execute('edit.undo'));
    assert.equal((await frame.evaluate(() => solidcraft.inspect())).bodies.length, 0);
    await frame.evaluate(() => solidcraft.execute('edit.redo'));
    assert.equal(await frame.evaluate(() => typeof window.showOpenFilePicker), 'undefined');
    const downloadEvent = page.waitForEvent('download');
    await frame.evaluate(() => solidcraft.execute('file.export', { path: '/downloads/gateway-box.step' }));
    const download = await downloadEvent;
    assert.equal(download.suggestedFilename(), 'gateway-box.step');
    const step = await require('node:fs/promises').readFile(await download.path());
    assert.ok(step.includes(Buffer.from('ISO-10303-21')));
    await frame.evaluate(() => solidcraft.execute('file.save_as', { path: '/opfs/gateway-box.solidcraft' }));
    await page.waitForFunction(() => document.getElementById('externalToolSaveState').textContent === 'Storage synced');
    await frame.waitForFunction(() => localStorage.getItem('solidcraft.file.gateway-box.solidcraft'));
    await page.waitForTimeout(1500);
    const stored = await frame.evaluate(() => localStorage.getItem('solidcraft.file.gateway-box.solidcraft'));
    assert.ok(stored.length > 100);
    assert.ok((await page.evaluate(() => ExternalTools.api('/api/tools/storage'))).storage.used_bytes > 100);
    await frame.evaluate(() => solidcraft.execute('file.new', { name: 'Import target' }));
    assert.equal((await frame.evaluate(() => solidcraft.inspect())).bodies.length, 0);
    // Open the app's real canvas File menu; subsequent import clicks use these
    // fixed desktop coordinates only for this pinned, optional release check.
    await page.mouse.click(133, 60);
    await page.waitForTimeout(300);
    if (process.env.EAGLE_TOOL_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.EAGLE_TOOL_SCREENSHOT_DIR}/solidcraft-file-menu.png` });
    await page.mouse.click(150, 120); // File → Open
    await page.waitForTimeout(300);
    const pickerEvent = page.waitForEvent('filechooser');
    await page.mouse.click(500, 472); // Open from computer in the app's file panel
    const picker = await pickerEvent;
    await picker.setFiles({ name: 'gateway-box.step', mimeType: 'application/step', buffer: step });
    await waitForBox(frame);
    assert.equal((await frame.evaluate(() => solidcraft.inspect({ measure: true }))).bodies[0].faces, 6);
    // A separate browser context has no browser storage/cookies from the first.
    const other = await browser.newContext({ viewport: { width: 1365, height: 900 } });
    await other.addInitScript(() => sessionStorage.setItem('eagle-auth-session-v1', JSON.stringify({ adminToken: 'fixture-admin' })));
    const otherPage = await other.newPage(); otherPage.on('dialog', dialog => dialog.accept());
    await otherPage.goto(base, { waitUntil: 'domcontentloaded' });
    await otherPage.waitForFunction(() => window.ExternalTools && window.EagleIDE?.getContext?.().ADMIN_TOKEN);
    await otherPage.evaluate(tool => ExternalTools.open(tool), tool);
    const otherFrame = await (await otherPage.locator('#externalToolFrameHost iframe').elementHandle()).contentFrame();
    await otherFrame.waitForFunction(() => window.solidcraft && !document.getElementById('solidcraft_loading'), null, { timeout: 90000 });
    assert.equal(await otherFrame.evaluate(() => localStorage.getItem('solidcraft.file.gateway-box.solidcraft')), stored);
    await otherFrame.evaluate(() => solidcraft.request('ui.home', { open: false }));
    await otherPage.mouse.click(133, 60); await otherPage.waitForTimeout(250); await otherPage.mouse.click(150, 120); await otherPage.waitForTimeout(300);
    await otherPage.mouse.click(647, 506); // Open the cloud-restored native design
    await waitForBox(otherFrame);
    await other.close();
    console.log('PASS: real STEP download → native file chooser → STEP import, plus native design save/reopen in an independent browser session.');
    await page.evaluate(() => { window.retainedSolidCraftFrame = document.querySelector('#externalToolFrameHost iframe'); });
    for (const viewport of [{ width: 1365, height: 900 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await frame.waitForFunction(() => {
        const canvas = document.getElementById('solidcraft_canvas');
        return canvas.clientWidth === innerWidth && canvas.clientHeight === innerHeight && innerHeight > 200;
      });
      if (process.env.EAGLE_TOOL_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.EAGLE_TOOL_SCREENSHOT_DIR}/solidcraft-${viewport.width}.png` });
    }
    await page.setViewportSize({ width: 1365, height: 900 });
    console.log('SolidCraft rendered and created the expected box. Checking retention beyond the original 90-second lease…');
    for (let i = 0; i < 2; i++) await page.waitForTimeout(50000);
    assert.equal(await page.evaluate(() => window.retainedSolidCraftFrame === document.querySelector('#externalToolFrameHost iframe')), true);
    assert.equal((await frame.evaluate(() => solidcraft.inspect({ measure: true }))).bodies[0].volume_mm3, 6000);
    assert.equal(integrityErrors.length, 0);
    await page.locator('#externalToolClose').click();
    assert.equal(await frameHost.count(), 0);
    console.log('PASS: unmodified SolidCraft web build, native SRI stylesheet validation, full-size CAD canvas, box/undo/redo, desktop/tablet/mobile layout, and retained geometry beyond the lease.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
