/* Opt-in, synthetic data only: lesson_plan_browser_fixture.py --mock-ai. */
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const fs = require('node:fs'), path = require('node:path');
const base = process.env.EAGLE_AGENDA_TEST_URL, output = process.env.EAGLE_AGENDA_SCREENSHOTS;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base || '')) throw new Error('Use the isolated browser fixture');
(async () => {
  const browser = await chromium.launch({headless:true,executablePath:process.env.EAGLE_AGENDA_BROWSER});
  try {
    const context = await browser.newContext({viewport:{width:1440,height:1000}});
    await context.addInitScript(() => sessionStorage.setItem('eagle-auth-session-v1',JSON.stringify({
      userToken:'agenda-student',currentUser:{email:'student@example.test',role:'student'}})));
    const page = await context.newPage(), errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base,{waitUntil:'networkidle'}); await page.locator('#ideViewBtn').click();
    await page.waitForFunction(()=>window.EagleEditorAppearance && window.eagleEditor);
    const source = 'self.elements[element2].atomic_mass\nself.get_elements(value.name)[index].atomic_mass.real\n' +
      'self.elements[lookup["]."]].atomic_mass\nf"Mass: {self.elements[element2].atomic_mass}"\n' +
      '# self.elements[element2].atomic_mass\ntext = "self.elements[element2].atomic_mass"';
    await page.evaluate(async source => {
      await EagleIDE.getContext().setEditorSnapshot({code:source,language:'python',fileName:'scratch.py',draft:true});
      renderMarkdownTo(document.getElementById('notesView'), '## Workspace readability\n\nRead the instructions, then run your code.\n\n[Reference](#reference)\n\n```python\n# A readable comment\nimport math\nprint("Hello")\n```');
      const samples=document.createElement('p'); samples.innerHTML='<span class="assignment-ai-status queued">Queued</span> <span class="assignment-ai-status completed">Completed</span> <span class="assignment-not-turned-in">Missing</span>';
      document.getElementById('notesView').append(samples);
      document.getElementById('output').innerHTML='<span class="sys-msg">System information</span>\n<span class="shell-warning">Warning</span>\n<span class="shell-error">Error</span>\n<span class="shell-user-input">Program input</span>\n';
    },source);
    const openSettings = async () => {
      await page.locator('#roleMenuBtn').click(); await page.locator('#studentDashboardBtn').click();
      await page.locator('[data-view="student-dash-account"]').click();
    };
    const panel=page.locator('[data-editor-appearance][aria-label="Student editor colors"]');
    const names=await page.evaluate(()=>Object.keys(EagleEditorAppearance.schemes));
    let checked=0;
    for (const scheme of names) {
      await openSettings();
      await panel.locator('select').selectOption(scheme); await panel.locator('[data-background-reset]').click();
      await panel.locator('[data-appearance-save]').click();
      await panel.locator('[role=status]').filter({hasText:'saved to your account'}).waitFor();
      await page.locator('#studentDashCloseBtn').click();
      for (const light of [false,true]) {
        const result=await page.evaluate(async ({scheme,light}) => {
          document.body.classList.toggle('light-mode',light); EagleEditorAppearance.applyAll();
          // Shared controls animate their colors; measure their settled appearance.
          await new Promise(resolve=>setTimeout(resolve,200));
          const canvas=document.createElement('canvas'), ctx=canvas.getContext('2d',{willReadFrequently:true});
          const rgba=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];};
          const hex=channels=>'#'+channels.slice(0,3).map(c=>Math.round(c).toString(16).padStart(2,'0')).join('');
          const background=element=>{
            const layers=[];
            for (let node=element;node;node=node.parentElement) {const color=rgba(getComputedStyle(node).backgroundColor);layers.push(color);if(color[3]===255)break;}
            return hex(layers.reverse().reduce((base,c)=>c.slice(0,3).map((v,i)=>v*c[3]/255+base[i]*(1-c[3]/255)),[255,255,255]));
          };
          const selectors=['#notesView p','#notesView h2','#notesView a','#notesView .hljs-keyword','#notesView .hljs-string',
            '#notesView .hljs-comment','#notesView .assignment-ai-status.queued','#notesView .assignment-ai-status.completed',
            '#notesView .assignment-not-turned-in','#output .sys-msg','#output .shell-warning','#output .shell-error',
            '#output .shell-user-input','#fileSelectionStats','#fileBreadcrumb .crumb','#newFileBtn','#rightStackPanel h3'];
          const contrasts=selectors.map(selector=>{
            const element=document.querySelector(selector); if (!element) throw new Error('Missing sample '+selector);
            const ink=hex(rgba(getComputedStyle(element).color)), bg=background(element);
            return {selector,ink,bg,ratio:EagleEditorAppearance.contrast(ink,bg)};
          });
          const input=document.querySelector('.shell-input-bar input');
          contrasts.push({selector:'Shell placeholder',ratio:EagleEditorAppearance.contrast(hex(rgba(getComputedStyle(input,'::placeholder').color)),background(input))});
          const cm=eagleEditor; cm.refresh();
          const legacy=EagleEditorAppearance.schemes[scheme].legacy;
          const tokens=[0,1,2,3].map(n=>cm.getLineTokens(n,true).filter(t=>/eagle-member/.test(t.type||'')).map(t=>({word:t.string,type:t.type})));
          const leaks=[4,5].some(n=>cm.getLineTokens(n,true).some(t=>/eagle-member/.test(t.type||'')));
          const mode=cm.getOption('mode'); cm.setOption('mode','javascript');
          const javascript=cm.getLineTokens(0,true).filter(t=>/eagle-member/.test(t.type||'')).map(t=>({word:t.string,type:t.type}));
          cm.setOption('mode',mode);
          return {contrasts,tokens,javascript,legacy,leaks,source:cm.getValue()};
        },{scheme,light});
        for (const sample of result.contrasts) assert.ok(sample.ratio>=4.5,`${scheme} page-light=${light}: ${JSON.stringify(sample)}`);
        assert.equal(result.source,source); assert.equal(result.leaks,false);
        if (result.legacy) assert.ok(result.tokens.every(tokens=>tokens.length===0));
        else {
          for (const row of [0,2,3]) {
            const member=result.tokens[row].find(t=>t.word==='atomic_mass');
            assert.match(member?.type||'',/eagle-member-2/,`${scheme} Python row ${row}: ${JSON.stringify(result.tokens[row])}`);
          }
          assert.match(result.tokens[1].find(t=>t.word==='real')?.type||'',/eagle-member-3/);
          assert.match(result.javascript.find(t=>t.word==='atomic_mass')?.type||'',/eagle-member-2/);
        }
        checked++;
        if (output && !light && ['paper-light','alpine-dark','crimson-dark','industrial-dark','ember-rose-dark','harbor-paper-light','pastel-aura-dark'].includes(scheme)) {
          fs.mkdirSync(output,{recursive:true}); await page.screenshot({path:path.join(output,`${scheme}.png`)});
        }
      }
    }
    // A new profile and editor-only override survive reload without altering pane tones.
    await openSettings(); await panel.locator('select').selectOption('crimson-dark');
    await panel.locator('input[type=color]').fill('#201c30'); await panel.locator('[data-appearance-save]').click();
    await panel.locator('[role=status]').filter({hasText:'saved to your account'}).waitFor(); await page.locator('#studentDashCloseBtn').click();
    await page.reload({waitUntil:'networkidle'});
    if (await page.locator('#ideViewBtn').isVisible()) await page.locator('#ideViewBtn').click();
    await page.waitForFunction(()=>eagleEditor.getWrapperElement().style.getPropertyValue('--editor-background')==='#201c30');
    assert.equal(await page.locator('#shellPanel').evaluate(el=>el.dataset.workspacePalette),'dark');
    assert.equal(await page.locator('#shellPanel').evaluate(el=>el.style.getPropertyValue('--workspace-code-background')),'#290e17');
    await page.evaluate(()=>EagleIDE.getContext().setEditorSnapshot({code:'print("Workspace theme run OK")',language:'python',fileName:'theme-smoke.py',draft:true}));
    await page.locator('#runBtn').click();
    await page.waitForFunction(()=>document.getElementById('output').textContent.includes('Workspace theme run OK') && !EagleIDE.getContext().isProgramRunning);
    for (const [width,height] of [[768,1024],[390,600]]) {
      await page.setViewportSize({width,height});
      assert.ok(await page.locator('#shellPanel').evaluate(el=>{const rect=el.getBoundingClientRect();return rect.right<=innerWidth+1;}));
    }
    assert.deepEqual(errors,[]);
    console.log(`PASS: ${checked} profile/page-theme combinations; actual Home, Files, Shell, Markdown, status and placeholder contrast; indexed Python/f-string/JavaScript chains; persistence and editor-only override.`);
    await context.close();
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
