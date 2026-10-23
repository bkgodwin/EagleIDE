/* Opt-in: lesson_plan_browser_fixture.py --mock-ai only; synthetic accounts. */
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const fs = require('node:fs'), path = require('node:path');
const base = process.env.EAGLE_AGENDA_TEST_URL, output = process.env.EAGLE_AGENDA_SCREENSHOTS;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base || '')) throw new Error('Use the isolated browser fixture');
(async () => {
  const browser = await chromium.launch({headless:true,executablePath:process.env.EAGLE_AGENDA_BROWSER});
  try {
    const errors=[];
    const cases=[['student',{userToken:'agenda-student',currentUser:{email:'student@example.test',role:'student'}}],
      ['teacher',{teacherToken:'agenda-teacher',currentTeacher:{email:'teacher@example.test',role:'teacher'}}],
      ['admin',{adminToken:'agenda-admin'}],
      ['wiki_manager',{wikiManagerToken:'agenda-ai-manager',currentUser:{email:'ai-manager@example.test',role:'wiki_manager'}}],
      ['guest',{}]];
    for (const [role,session] of cases) {
      console.log('Checking editor controls:',role);
      const context=await browser.newContext({viewport:{width:1440,height:1000}});
      await context.addInitScript(value=>sessionStorage.setItem('eagle-auth-session-v1',JSON.stringify(value)),session);
      const page=await context.newPage(); page.on('pageerror',e=>errors.push(e.message));
      await page.goto(base,{waitUntil:'networkidle'}); await page.locator('#ideViewBtn').click();
      await page.waitForFunction(()=>window.eagleCompletionEngine && window.EagleEditorAppearance);
      // The actual completion controller must flip above a caret near the bottom.
      for (const [width,height] of [[1440,1000],[768,1024],[390,600]]) {
        for (const light of (role==='student' ? [false,true] : [false])) {
        await page.setViewportSize({width,height});
        await page.evaluate(light=>{document.body.classList.toggle('light-mode',light);EagleEditorAppearance.applyAll();},light);
        const box=await page.evaluate(async () => {
          const cm=eagleEditor;
          await EagleIDE.getContext().setEditorSnapshot({code:'import random\n'+'# fixture\n'.repeat(60)+'random.',language:'python',fileName:'scratch.py',draft:true});
          cm.setCursor(cm.lastLine(),7); cm.scrollIntoView(cm.getCursor(),10); cm.focus();
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
          eagleCompletionEngine.check();
          const popup=document.querySelector('.eagle-completion-popup:not(.hidden)'), rect=popup.getBoundingClientRect(), style=getComputedStyle(popup);
          return {left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,width:innerWidth,height:innerHeight,
            blur:style.backdropFilter,background:style.backgroundColor,caret:cm.cursorCoords(cm.getCursor(),'window')};
        });
        assert.ok(box.left>=7 && box.right<=width-7 && box.top>=7 && box.bottom<=height-7,`${role} popup bounds ${JSON.stringify(box)}`);
        assert.ok(box.bottom<=box.caret.top || box.top>=box.caret.bottom,`${role}: popup covers caret`);
        assert.match(box.blur,/blur\(/); assert.ok(!box.background.endsWith(', 0)'));
        if (output && ['student','teacher'].includes(role)) {fs.mkdirSync(output,{recursive:true});await page.screenshot({path:path.join(output,`${role}-completion-${width}-${light ? 'light' : 'dark'}.png`)});}
        await page.keyboard.press('Escape');
        }
      }
      await page.evaluate(()=>{document.body.classList.remove('light-mode');EagleEditorAppearance.applyAll();});
      await page.setViewportSize({width:1440,height:1000});
      const coloring=await page.evaluate(async () => {
        const cm=eagleEditor, appearance=EagleEditorAppearance;
        const source='self.thing.stuff(x, y, z)\n# self.thing.stuff()\ntext = "self.thing.stuff()"';
        cm.setValue(source); appearance.apply(cm,{scheme:'eagle-dark'}); cm.refresh();
        const tokens=cm.getLineTokens(0,true);
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const members=tokens.filter(t=>t.type?.includes('eagle-member'));
        const style=token=>{const node=cm.getWrapperElement().querySelector('.cm-eagle-member-'+token);return node ? getComputedStyle(node).color : null;};
        const colors=[style(1),style(2)];
        const leaked=[1,2].some(line=>cm.getLineTokens(line,true).some(t=>t.type?.includes('eagle-member')));
        appearance.apply(cm,{scheme:'legacy-dark'});
        const legacy=cm.getLineTokens(0,true).some(t=>/eagle-member|eagle-call/.test(t.type||''));
        cm.setOption('mode','javascript'); appearance.apply(cm,{scheme:'eagle-dark'});
        const javascript=cm.getLineTokens(0,true).filter(t=>t.type?.includes('eagle-member')).map(t=>t.string);
        cm.setOption('mode','python');
        return {members:members.map(t=>({word:t.string,type:t.type})),javascript,colors,leaked,legacy,source:cm.getValue()};
      });
      assert.deepEqual(coloring.members.map(t=>t.word),['thing','stuff'],JSON.stringify(coloring)); assert.notEqual(coloring.colors[0],coloring.colors[1],JSON.stringify(coloring));
      assert.equal(coloring.leaked,false); assert.equal(coloring.legacy,false); assert.ok(coloring.source.startsWith('self.thing.stuff'));
      assert.deepEqual(coloring.javascript,['thing','stuff']);
      if (role==='admin') {
        const gutter=await page.evaluate(fs.readFileSync(path.join(__dirname,'editor_browser_checks.js'),'utf8'));
        assert.equal(gutter.ok,true); assert.ok(gutter.gutterCases>=39);
      }
      if (role==='student') {
        await page.locator('#roleMenuBtn').click(); await page.locator('#studentDashboardBtn').click();
        await page.locator('[data-view="student-dash-account"]').click();
        const panel=page.locator('[data-editor-appearance][aria-label="Student editor colors"]');
        for (const scheme of ['legacy-dark','legacy-light','midnight-dark','forest-dark','graphite-dark','alpine-dark']) {
          await panel.locator('select').selectOption(scheme);
          await panel.locator('[data-background-reset]').click();
          const state=await panel.locator('.CodeMirror').evaluate((wrapper,scheme)=>({
            background:wrapper.style.getPropertyValue('--editor-background'),expected:EagleEditorAppearance.schemes[scheme].colors.background,
            legacy:wrapper.CodeMirror.getOption('eagleLegacyColors')}),scheme);
          assert.equal(state.background,state.expected); assert.equal(state.legacy,scheme.startsWith('legacy'));
        }
        await panel.locator('select').selectOption('alpine-dark');
        await panel.locator('input[type=color]').fill('#292044');
        await panel.locator('[data-appearance-save]').click();
        await panel.locator('[role=status]').filter({hasText:'saved to your account'}).waitFor();
        await page.locator('#studentDashCloseBtn').click();
        const surfaces=await page.evaluate(() => ({editor:getComputedStyle(eagleEditor.getWrapperElement()).backgroundColor,
          files:getComputedStyle(document.getElementById('editorPanel')).backgroundColor,
          shell:getComputedStyle(document.getElementById('output')).backgroundColor,
          resources:getComputedStyle(document.getElementById('rightStackPanel')).backgroundColor}));
        assert.equal(surfaces.editor,'rgb(41, 32, 68)'); assert.equal(new Set([surfaces.files,surfaces.shell,surfaces.resources]).size,3);
        assert.ok(!Object.values(surfaces).slice(1).includes(surfaces.editor));
        if (output) await page.screenshot({path:path.join(output,'alpine-workspace-custom-editor.png')});
        await page.reload({waitUntil:'networkidle'});
        if (await page.locator('#ideViewBtn').isVisible()) await page.locator('#ideViewBtn').click();
        await page.waitForFunction(()=>eagleEditor.getWrapperElement().style.getPropertyValue('--editor-background')==='#292044');
      }
      if (role==='teacher') {
        assert.ok(await page.locator('#classSelector').evaluate(el=>el.getBoundingClientRect().width>=260));
        await page.locator('#streamingToggleBtn').click(); await page.locator('#streamingToggleBtn').filter({hasText:'Stream On'}).waitFor();
        await page.locator('#classSelector').selectOption('agenda-section');
        await page.locator('#streamingToggleBtn').filter({hasText:'Stream Off'}).waitFor();
        await page.waitForTimeout(700);
        assert.match(await page.locator('#streamingToggleBtn').textContent(),/Stream Off/);
      }
      await context.close();
    }
    assert.deepEqual(errors,[]);
    console.log('PASS: all-role blurred bounded completions; desktop/tablet/mobile; member colors and Legacy tokens; saved Alpine workspace/editor-only override; class width and stream reset.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
