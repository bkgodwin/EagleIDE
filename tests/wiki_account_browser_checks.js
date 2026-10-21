/* Opt-in reliability/layout checks against lesson_plan_browser_fixture.py only. */
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const fs=require('node:fs');
const path=require('node:path');
const base=process.env.EAGLE_AGENDA_TEST_URL, output=process.env.EAGLE_AGENDA_SCREENSHOTS;
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(base || '')) throw new Error('Use the isolated agenda fixture URL');
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.EAGLE_AGENDA_BROWSER || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  const errors=[];
  try {
    async function account(role) {
      const ctx=await browser.newContext({viewport:{width:1440,height:1000}});
      await ctx.addInitScript(payload=>sessionStorage.setItem('eagle-auth-session-v1',JSON.stringify(payload)),role==='teacher'
        ? {teacherToken:'agenda-teacher',currentTeacher:{email:'teacher@example.test',name:'Alex Rivera',role:'teacher'}}
        : role==='student' ? {userToken:'agenda-student',currentUser:{email:'student@example.test',name:'Jamie Lee',role:'student',class_id:'agenda-class',class_ids:['agenda-class']}}
        : {adminToken:'agenda-admin'});
      return ctx;
    }
    const teacher=await account('teacher'), page=await teacher.newPage();page.on('pageerror',error=>errors.push(error.message));
    let release, homeRequests=0;const gate=new Promise(done=>release=done);
    await page.route('**/api/wiki/home*',async route=>{homeRequests++;await gate;try {await route.continue();} catch {}});
    await page.goto(base,{waitUntil:'domcontentloaded'});
    await page.locator('#wikiNavTree .wiki-tree-link').filter({hasText:'Python loops'}).waitFor({state:'attached'});
    assert.equal(await page.evaluate(()=>WikiReader.getState().home),null,'Public contents load before slow class metadata');
    await page.waitForFunction(()=>EagleIDE.getContext().teacherClasses.length===2);
    const before=homeRequests;
    await page.evaluate(()=>{WikiReader.loadHome({quiet:true});WikiReader.loadHome({quiet:true});});
    await page.waitForTimeout(100);assert.equal(homeRequests,before,'Identical metadata requests are shared');
    release();await page.waitForFunction(()=>WikiReader.getState().home?.active_class?.id==='agenda-class');
    await page.unroute('**/api/wiki/home*');
    const retryPage=await teacher.newPage();retryPage.on('pageerror',error=>errors.push(error.message));let treeRequests=0;
    await retryPage.route('**/api/wiki/tree',async route=>{treeRequests++;if(treeRequests===1) await route.fulfill({status:503,contentType:'application/json',body:'{"ok":false,"error":"Temporary outage"}'});else await route.continue();});
    await retryPage.goto(base+'/wiki/python-loops',{waitUntil:'networkidle'});
    await retryPage.waitForFunction(()=>WikiReader.getState().treeLoaded);
    assert.equal(treeRequests,2);
    await retryPage.locator('#wikiFontSizeSelect').selectOption('28');
    assert.equal(await retryPage.locator('#wikiArticleBody').evaluate(el=>getComputedStyle(el).fontSize),'28px');
    await retryPage.reload({waitUntil:'networkidle'});
    assert.equal(await retryPage.locator('#wikiArticleBody').evaluate(el=>getComputedStyle(el).fontSize),'28px');
    assert.ok(await retryPage.locator('#wikiArticleBody').textContent());
    await retryPage.close();
    const failed=await teacher.newPage();
    await failed.route('**/api/wiki/tree',route=>route.fulfill({status:503,contentType:'application/json',body:'{"ok":false,"error":"Unavailable"}'}));
    await failed.goto(base+'/wiki/python-loops',{waitUntil:'networkidle'});
    await failed.waitForFunction(()=>!!WikiReader.getState().treeError);
    await failed.unroute('**/api/wiki/tree');
    const retry=failed.locator('#wikiNavTree').getByRole('button',{name:'Retry contents'});
    if(!await retry.isVisible()) await failed.locator('#wikiNavBtn').click();
    await retry.click();await failed.waitForFunction(()=>WikiReader.getState().treeLoaded);
    assert.ok(await failed.locator('#wikiArticleBody').textContent());await failed.close();
    async function checkAccount(role, ctx, existing) {
      const p=existing || await ctx.newPage();p.on('pageerror',error=>errors.push(error.message));
      if(!existing) {await p.goto(base,{waitUntil:'networkidle'});await p.waitForFunction(()=>EagleIDE?.getContext?.());}
      if(role==='teacher') {await p.evaluate(()=>EagleIDE.getContext().openLessonPlanDashboard());await p.locator('[data-view="dash-account"]').click();}
      else {await p.locator('#roleMenuBtn').click();await p.locator(role==='student'?'#studentDashboardBtn':'#adminSettingsBtn').click();await p.locator(role==='student'?'[data-view="student-dash-account"]':'[data-admin-settings-section="account"]').click();}
      const host=p.locator(role==='teacher'?'#dash-account':role==='student'?'#student-dash-account':'[data-admin-settings-pane="account"]');
      assert.equal(await p.locator('#externalToolStorageMenu').count(),0);
      for(const [width,theme] of [[1440,'dark'],[1440,'light'],[390,'dark'],[390,'light']]) {
        await p.setViewportSize({width,height:1000});await p.evaluate(light=>document.body.classList.toggle('light-mode',light),theme==='light');
        await p.waitForTimeout(250); // Let existing dashboard/theme transitions settle before visual inspection.
        assert.ok(await host.evaluate(el=>el.scrollWidth<=el.clientWidth+2),`${role} account overflows at ${width}`);
        if(output) {fs.mkdirSync(output,{recursive:true});await p.screenshot({path:path.join(output,`account-${role}-${width}-${theme}.png`)});}
      }
      await host.locator('.external-tool-storage-open').click();
      await p.locator('#externalToolStorageUsage').filter({hasText:'used.'}).waitFor();
      await p.locator('#externalToolStorageDone').click();
      if(role==='student') {await p.locator('.profile-edit-btn:visible').click();await p.getByRole('button',{name:'Cancel',exact:true}).filter({visible:true}).first().click().catch(()=>{});}
    }
    await checkAccount('teacher',teacher,page);
    const student=await account('student');await checkAccount('student',student);
    const admin=await account('admin');await checkAccount('admin',admin);
    assert.deepEqual(errors,[]);
    console.log('PASS: independent public wiki contents, metadata deduplication, bounded automatic retry, visible retry recovery, persistent 28px extra-large text, and teacher/student/admin account layouts and storage controls in both themes.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
