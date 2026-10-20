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
      const result = await api('/api/admin/tools', { method: 'POST', body: JSON.stringify({ revision: catalog.revision, name: 'SolidCraft test', label: 'Open SolidCraft', slug: 'solidcraft-test', backend_url: 'http://fixture.internal:8080/prefix/' }) });
      const tested = await api(`/api/admin/tools/${result.tool.id}/test`, { method: 'POST', body: JSON.stringify({ revision: result.revision }) });
      if (!tested.reachable) throw new Error('Fixture build is not reachable');
      return tested.tool;
    });
    await page.evaluate(tool => window.ExternalTools.open(tool), tool);
    const frameHost = page.locator('#externalToolFrameHost iframe');
    await frameHost.waitFor();
    const frame = await (await frameHost.elementHandle()).contentFrame();
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
