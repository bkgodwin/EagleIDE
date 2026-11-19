// Run only against lesson_plan_browser_fixture.py --lab (all data is temporary).
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {consoleKeyboardSource} from '../lab_gateway/console-keyboard.mjs';
const module=process.env.EAGLE_LAB_PLAYWRIGHT_MODULE||'playwright';
const {chromium,webkit}=await import(isAbsolute(module)?pathToFileURL(module).href:module);
const base=process.env.EAGLE_LAB_TEST_URL,output=process.env.EAGLE_LAB_SCREENSHOT_DIR;
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(base||''))throw Error('Use the isolated --lab fixture URL');
const webkitMode=process.env.EAGLE_LAB_TEST_ENGINE==='webkit';
const browser=await (webkitMode?webkit:chromium).launch(webkitMode?{headless:true}:{headless:true,executablePath:process.env.EAGLE_LAB_BROWSER});
const errors=[];
async function account(session){const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.grantPermissions(['clipboard-read','clipboard-write']);await context.addInitScript(value=>{if(window===window.top)sessionStorage.setItem('eagle-auth-session-v1',JSON.stringify(value));},session);const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());await page.goto(base,{waitUntil:'networkidle'});return {context,page};}
async function screenshot(page,name){if(output){mkdirSync(output,{recursive:true});await page.screenshot({path:join(output,name+'.png')});}}
async function inBounds(page,selector){
  await page.waitForFunction(selector=>{
    const r=document.querySelector(selector)?.getBoundingClientRect();
    return r && r.left>=0 && r.top>=0 && r.right<=innerWidth+1 && r.bottom<=innerHeight+1;
  },selector);
}
async function touchDrag(page, locator, dx, dy) {
  const {x,y,width,height} = await locator.boundingBox();
  const from = {x:x + width/2, y:y + height/2};
  const to = {x:from.x + dx, y:from.y + dy};
  if (!webkitMode) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {type:'touchStart', touchPoints:[from]});
    await cdp.send('Input.dispatchTouchEvent', {type:'touchMove', touchPoints:[to]});
    await cdp.send('Input.dispatchTouchEvent', {type:'touchEnd', touchPoints:[]});
    await cdp.detach();
    return;
  }
  await locator.evaluate((element,{from,to})=>{
    for (const [type, point] of [['touchstart',from],['touchmove',to],['touchend',to]]) {
      const pointData = {identifier:1,target:element,clientX:point.x,clientY:point.y};
      const event = new Event(type,{bubbles:true,cancelable:true});
      Object.defineProperties(event,{
        touches:{value:type==='touchend'?[]:[pointData]},
        changedTouches:{value:[pointData]},
      });
      element.dispatchEvent(event);
    }
  },{from,to});
}
async function verifyTouchWindows(page) {
  const report = page.locator('.lab-report-window').first();
  for (const [handle, dx, dy] of [['header h2',-64,48],['[data-float-restore]',-64,48]]) {
    if (handle.includes('restore')) await report.locator('[data-float-minimize]').tap();
    const before = await report.boundingBox();
    await touchDrag(page, report.locator(handle), dx, dy);
    const after = await report.boundingBox();
    assert.ok(after.x < before.x - 30 && after.y > before.y + 25, 'Touch drag moves the report and restore square');
    assert.equal(await report.evaluate(el=>getComputedStyle(el).borderTopColor),'rgb(223, 81, 88)');
  }
  await report.locator('[data-float-restore]').tap();
  await report.locator('[data-float-minimize]').waitFor();
  return report;
}
if(webkitMode){
  try{
    const context=await browser.newContext({viewport:{width:1024,height:1366},hasTouch:true,isMobile:true});
    await context.addInitScript(()=>sessionStorage.setItem('eagle-auth-session-v1',JSON.stringify({
      teacherToken:'agenda-teacher',currentTeacher:{email:'teacher@example.test',role:'teacher'},
    })));
    const page=await context.newPage();
    page.on('dialog',dialog=>dialog.accept());
    await page.goto(base,{waitUntil:'networkidle'});
    await page.locator('#eagleLabViewBtn').tap();
    await page.getByRole('button',{name:/Your first self hosted service/}).tap();
    const report=await verifyTouchWindows(page);
    await report.locator('[data-report-question="notes"]').fill('WebKit teacher practice');
    assert.equal(await report.locator('[data-report-submit]').count(),0);
    await report.getByRole('button',{name:'Minimize report'}).tap();
    await report.getByRole('button',{name:/Restore Your first/}).waitFor();
    await page.evaluate(()=>EagleLab.openReportById(EagleLab.getState().report.assignmentId));
    assert.equal((await report.boundingBox()).y,8);
    assert.equal(await report.locator('[data-report-question="notes"]').inputValue(),'WebKit teacher practice');
    await report.getByRole('button',{name:'Reset my practice'}).tap();
    await report.getByText('Practice reset',{exact:true}).waitFor();
    await report.getByRole('button',{name:'Close for now'}).tap();
    await report.waitFor({state:'detached'});
    await page.locator('#eagleLabManualBtn').tap();
    const manual=page.locator('.lab-manual-window');
    const originalManual=await manual.boundingBox();
    await touchDrag(page,manual.locator('header h2'),64,48);
    assert.ok((await manual.boundingBox()).x>originalManual.x+30,'Touch drag moves the lab manual');
    assert.equal(await manual.evaluate(el=>getComputedStyle(el).borderTopColor),'rgb(223, 81, 88)');
    await manual.getByRole('button',{name:'Minimize Lab Manual'}).tap();
    const manualTile=await manual.boundingBox();
    await touchDrag(page,manual.locator('[data-float-restore]'),-64,48);
    assert.ok((await manual.boundingBox()).x<manualTile.x-30,'Touch drag moves the minimized manual');
    await manual.getByRole('button',{name:'Restore Lab Manual'}).tap();
    await manual.locator('input').fill('network');
    await manual.locator('[data-chapter="network"]').tap();
    await manual.locator('.lab-copy-text').first().tap();
    assert.equal(await page.evaluate(()=>LabReportContent.readClipboard()),'ip -br addr');
    await manual.getByRole('button',{name:'Close Lab Manual'}).tap();
    await context.close();
    console.log('PASS: WebKit iPad touch controls, teacher practice/reset, manual and command copy.');
  }finally{await browser.close();}
}else{
try{
  const touchContext=await browser.newContext({viewport:{width:1024,height:1366},hasTouch:true,isMobile:true});
  await touchContext.addInitScript(()=>sessionStorage.setItem('eagle-auth-session-v1',JSON.stringify({
    userToken:'agenda-student',currentUser:{email:'student@example.test',role:'student'},
  })));
  const touchPage=await touchContext.newPage();
  await touchPage.goto(base,{waitUntil:'networkidle'});
  await touchPage.locator('#eagleLabViewBtn').tap();
  await touchPage.getByRole('button',{name:/Your first self hosted service/}).tap();
  await verifyTouchWindows(touchPage);
  await touchContext.close();

  const {context:studentContext,page:student}=await account({userToken:'agenda-student',currentUser:{email:'student@example.test',role:'student'}});
  await student.locator('#eagleLabViewBtn').waitFor({state:'visible'});await student.locator('#eagleLabViewBtn').click();await student.locator('[data-lab-server]').first().waitFor();
  assert.equal(await student.locator('[data-lab-server]').count(),3);await screenshot(student,'lab-student-dark');
  await student.getByRole('button',{name:/Your first self hosted service/}).click();await student.locator('.lab-report-window').waitFor();
  assert.equal(await student.locator('.lab-report-window').getAttribute('aria-modal'),'false');
  await student.locator('[data-lab-copy="hostname"]').click();assert.equal(await student.evaluate(()=>navigator.clipboard.readText()),'hostname');
  await student.locator('[data-report-question="notes"]').fill('The guest has a private IPv4 address.');
  await student.locator('#eagleLabSearch').fill('02');assert.equal(await student.locator('[data-lab-server]').count(),1,'background remains interactive');
  await student.locator('.lab-report-window').press('ArrowLeft');await student.locator('[data-float-resize]').press('ArrowLeft');await inBounds(student,'.lab-report-window');
  assert.ok(await student.locator('[data-step="0"]').evaluate(el=>el.getBoundingClientRect().width>=24));
  await student.locator('[data-float-minimize]').click();assert.equal(await student.locator('.lab-report-page').isVisible(),false);await student.locator('[data-float-restore]').click();assert.equal(await student.locator('[data-report-question="notes"]').inputValue(),'The guest has a private IPv4 address.');
  await student.getByRole('button',{name:'Close for now'}).click();await student.locator('.lab-report-overlay').waitFor({state:'detached'});
  await student.locator('#eagleLabManualBtn').click();await student.locator('.lab-manual-window').waitFor();await student.locator('.lab-manual-search input').fill('network');await student.locator('[data-chapter="network"]').click();await student.locator('.lab-copy-text').first().click();assert.equal(await student.evaluate(()=>navigator.clipboard.readText()),'ip -br addr');await screenshot(student,'lab-manual-dark');
  await student.setViewportSize({width:390,height:844});await inBounds(student,'.lab-manual-window');await screenshot(student,'lab-manual-mobile');await student.locator('[data-manual-close]').click();
  for(const light of [false,true]){await student.evaluate(light=>document.body.classList.toggle('light-mode',light),light);await student.locator('#eagleLabSearch').fill('');await screenshot(student,'lab-student-mobile-'+(light?'light':'dark'));assert.ok(await student.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
  await student.setViewportSize({width:1440,height:1000});
  await student.locator('[data-lab-server]').first().click();
  await student.getByRole('dialog').filter({has:student.locator('.eagle-lab-detail')}).waitFor();
  await screenshot(student,'lab-server-detail');
  const clipboardConfig={clipboardKey:'fixture-console',portalOrigin:base};
  await student.route('**/api/eagle-lab/servers/*/launch', route=>route.fulfill({json:{ok:true,data:{
    transport:'path',url:base+'/fixture-console',ticket:'fixture',clipboard_key:clipboardConfig.clipboardKey,
  }}}));
  await student.route('**/fixture-console',route=>route.fulfill({contentType:'text/html',body:
    '<div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div><output></output><script>'
      +'const element=document.querySelector(".xterm"), textarea=element.querySelector("textarea");'
      +'window.term={element,focus:()=>textarea.focus(),paste:text=>document.querySelector("output").textContent=text};'
      +'Object.defineProperty(navigator,"clipboard",{value:{readText:async()=>"Keyboard paste works"}});'
      +consoleKeyboardSource(clipboardConfig)+'</script>',
  }));
  await student.getByRole('button',{name:'Connect to PVE'}).click();
  const workspace=student.locator('.eagle-lab-workspace');
  const consoleFrame=workspace.frameLocator('iframe');
  const toggle=workspace.getByRole('button',{name:'Clipboard controls'});
  const paste=consoleFrame.getByRole('button',{name:'Paste',exact:true});
  assert.equal(await toggle.getAttribute('aria-pressed'),'false');
  await consoleFrame.locator('.eagle-console-tools[hidden]').waitFor({state:'attached'});
  await toggle.click();
  await paste.waitFor();
  await toggle.click();
  await paste.waitFor({state:'hidden'});
  await consoleFrame.locator('textarea').press('Control+v');
  await consoleFrame.getByText('Keyboard paste works',{exact:true}).waitFor();
  const reportTools=workspace.locator('.eagle-lab-workspace-reports');
  const right=await reportTools.evaluate(el=>innerWidth-el.getBoundingClientRect().right);
  assert.ok(right<20,'The report tools stay at the top right');
  await reportTools.getByRole('combobox',{name:'Lab report'}).selectOption({index:1});
  await reportTools.getByRole('button',{name:'Open report'}).click();
  const topReport=student.locator('.lab-report-window');
  await topReport.waitFor();
  const toolbar=workspace.locator('.eagle-lab-workspace-toolbar');
  const toolbarBottom=await toolbar.evaluate(el=>el.getBoundingClientRect().bottom);
  assert.ok((await topReport.boundingBox()).y>=toolbarBottom,'Opening a report leaves the toolbar accessible');
  await topReport.getByRole('button',{name:'Close for now'}).click();
  await workspace.getByRole('button',{name:'Eagle Lab'}).click();
  await student.unroute('**/api/eagle-lab/servers/*/launch');
  await student.unroute('**/fixture-console');

  console.log('Student surfaces verified.');
  await student.locator('#ideViewBtn').click();await student.evaluate(()=>EagleIDE.getContext().setEditorSnapshot({code:'print("Lab UI smoke test")',language:'python',fileName:'lab-smoke.py',draft:true}));await student.locator('#runBtn').click();await student.locator('#output').filter({hasText:'Lab UI smoke test'}).waitFor();await student.locator('#eagleLabViewBtn').click();
  const {context:teacherContext,page:teacher}=await account({teacherToken:'agenda-teacher',currentTeacher:{email:'teacher@example.test',role:'teacher'}});
  await teacher.locator('#eagleLabViewBtn').click();
  await teacher.getByRole('button',{name:/Your first self hosted service/}).click();
  const practice=teacher.locator('.lab-report-window');
  assert.equal(await practice.locator('[data-report-submit]').count(),0);
  await practice.locator('[data-report-question="notes"]').fill('Private teacher practice');
  await practice.getByRole('button',{name:'Close for now'}).click();
  await practice.waitFor({state:'detached'});
  await teacher.getByRole('button',{name:/Your first self hosted service/}).click();
  assert.equal(await practice.locator('[data-report-question="notes"]').inputValue(),'Private teacher practice');
  await screenshot(teacher,'lab-teacher-practice');
  await practice.getByRole('button',{name:'Reset my practice'}).click();
  await practice.getByText('Practice reset',{exact:true}).waitFor();
  assert.equal(await practice.locator('[data-report-question="notes"]').inputValue(),'');
  await practice.getByRole('button',{name:'Close for now'}).click();
  await practice.waitFor({state:'detached'});
  await student.getByRole('button',{name:/Your first self hosted service/}).click();
  assert.equal(await student.locator('[data-report-question="notes"]').inputValue(),'The guest has a private IPv4 address.');
  await student.getByRole('button',{name:'Close for now'}).click();
  const assignments = (await (await studentContext.request.get(base + '/api/assignments', {
    headers:{'X-User-Token':'agenda-student'},
  })).json()).assignments;
  const reportAssignment = assignments.find(item => item.assignmentType === 'lab_report');
  const request = await studentContext.request.post(base + '/api/assignments/extension-requests', {
    headers:{'X-User-Token':'agenda-student'},
    data:{assignmentId:reportAssignment.id, days:1, reason:'The server was busy during class.'},
  });
  assert.equal(request.status(), 200);
  await teacher.locator('#ideViewBtn').click();await teacher.locator('#roleMenuBtn').click();await teacher.locator('#teacherDashboardBtn').click();
  const notice = teacher.locator('#teacherNotifications .assignment-request');
  await notice.getByText('The server was busy during class.').waitFor();
  assert.match(await notice.innerText(), /Jamie Lee[\s\S]*Your first self hosted service[\s\S]*Period 2/);
  await notice.getByLabel('Modify school days').fill('2');
  await notice.getByRole('button', {name:'Approve modified days'}).click();
  await teacher.getByText('No pending extension requests.', {exact:false}).waitFor();
  await teacher.locator('[data-view="dash-classes"]').click();
  await teacher.getByRole('button', {name:'Show large'}).click();
  const joinCode = teacher.locator('#teacherJoinCodeDisplay');
  await joinCode.waitFor();
  assert.equal(await joinCode.innerText(), 'AGENDA');
  assert.ok(await joinCode.evaluate(el => parseFloat(getComputedStyle(el).fontSize) >= 72));
  await teacher.keyboard.press('Escape');
  await teacher.setViewportSize({width:390,height:844});
  await teacher.getByRole('button', {name:'Show large'}).click();
  await inBounds(teacher, '#teacherJoinCodeDialog');
  await teacher.keyboard.press('Escape');
  await teacher.setViewportSize({width:1440,height:1000});
  await teacher.locator('[data-view="dash-eagle-lab"]').click();await teacher.locator('[data-teacher-server]').first().waitFor();
  await teacher.locator('#eagleLabTeacherCredentials').check();await teacher.locator('[data-teacher-server]').last().uncheck();await teacher.locator('#eagleLabTeacherRefreshBtn').click();await teacher.getByText('Unsaved changes · refresh keeps your edits',{exact:true}).waitFor();assert.equal(await teacher.locator('#eagleLabTeacherCredentials').isChecked(),true);assert.equal(await teacher.locator('[data-teacher-server]').last().isChecked(),false);
  await teacher.locator('#eagleLabTeacherClassSelect').selectOption('agenda-section');await teacher.waitForFunction(()=>EagleLab.getState().teacherClassId==='agenda-section');assert.equal(await teacher.locator('#eagleLabTeacherCredentials').isChecked(),false);
  await teacher.locator('#eagleLabTeacherClassSelect').selectOption('agenda-class');await teacher.waitForFunction(()=>EagleLab.getState().teacherClassId==='agenda-class');assert.equal(await teacher.locator('#eagleLabTeacherCredentials').isChecked(),true);await screenshot(teacher,'lab-teacher-rules');
  let releaseSave;const savingGate=new Promise(resolve=>releaseSave=resolve);
  await teacher.route('**/api/eagle-lab/teacher/classes/agenda-class',async route=>{if(route.request().method()==='PUT')await savingGate;await route.continue();});
  await teacher.locator('#eagleLabTeacherSaveBtn').click();await teacher.waitForFunction(()=>EagleLab.getState().teacherSaving);await teacher.locator('#eagleLabTeacherCredentials').uncheck();releaseSave();await teacher.getByText('Saved. Newer edits are still unsaved.',{exact:true}).waitFor();assert.equal(await teacher.locator('#eagleLabTeacherCredentials').isChecked(),false);await teacher.unroute('**/api/eagle-lab/teacher/classes/agenda-class');
  await teacher.locator('#eagleLabTeacherSaveBtn').click();await teacher.getByText('Class access saved.',{exact:true}).waitFor();
  const reserved = await teacher.locator('[data-teacher-server]').first().getAttribute('data-teacher-server');
  await teacher.locator('#eagleLabTeacherReserved').selectOption(reserved);
  await teacher.locator('#eagleLabTeacherSaveBtn').click();
  await teacher.getByText('Class access saved.', {exact:true}).waitFor();
  await student.locator('#eagleLabRefreshBtn').click();
  await student.waitForFunction(() => document.querySelectorAll('[data-lab-server]').length === 1);
  assert.equal(await student.locator(`[data-lab-server="${reserved}"]`).count(), 0);
  await teacher.locator('#eagleLabTeacherLimitHours').check();
  const excludedHour = (new Date().getUTCHours() + 12) % 24;
  const hour = String(excludedHour).padStart(2, '0');
  await teacher.locator('#eagleLabTeacherStart').fill(`${hour}:00`);
  await teacher.locator('#eagleLabTeacherEnd').fill(`${hour}:01`);
  await teacher.locator('#eagleLabTeacherZone').fill('UTC');
  await teacher.locator('#eagleLabTeacherSaveBtn').click();
  await teacher.getByText('Class access saved.', {exact:true}).waitFor();
  await student.locator('#eagleLabRefreshBtn').click();
  await student.locator('#eagleLabStatus').getByText(/Lab servers open during class/).waitFor();
  await student.locator('[data-lab-report]').first().waitFor();
  await teacher.locator('#eagleLabTeacherLimitHours').uncheck();
  await teacher.locator('#eagleLabTeacherSaveBtn').click();
  await teacher.getByText('Class access saved.', {exact:true}).waitFor();
  console.log('Teacher notifications, join code, lab policies and draft retention verified.');
  await teacher.locator('[data-view="dash-assignments"]').click();await teacher.locator('#newAssignmentBtn').click();await teacher.locator('#modalAssignmentType').selectOption('lab_report');await teacher.locator('.lab-composer-preview').waitFor();assert.equal(await teacher.locator('.assignment-composer>.modal-content').evaluate(el=>getComputedStyle(el).display),'grid');await teacher.locator('#modalAssignmentName').fill('Browser-built hosting report '+Date.now());await teacher.locator('#modalAssignmentTask').fill('Test your app with {curl http://127.0.0.1:8000}.');
  await teacher.locator('#composer-tab-questions').click();await teacher.locator('#addQuestionBtn').click();await teacher.locator('.lab-section-editor').waitFor();
  await teacher.locator('.lab-section-editor select[name=type]').selectOption('procedure');await teacher.locator('.lab-section-editor textarea[name=question]').fill('Use {pwd} to check your project directory.');await teacher.locator('.lab-section-editor textarea[name=steps]').fill('Create the site directory.\nStart the server.\nCheck the response.');
  await teacher.locator('.lab-section-editor input[type=file]').setInputFiles({name:'example.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=','base64')});await teacher.locator('.lab-section-preview img').waitFor({state:'visible'});await screenshot(teacher,'lab-report-editor-dark');
  await teacher.getByRole('button',{name:'Add section',exact:true}).click();await teacher.locator('.lab-section-editor').waitFor({state:'detached'});await teacher.locator('.lab-composer-preview [data-lab-copy="pwd"]').waitFor();
  await teacher.locator('[data-edit-report]').click();await teacher.locator('.lab-section-editor textarea[name=steps]').fill('Create the site directory.\nStart the server.\nCheck the response.\nRecord your results.');await teacher.getByRole('button',{name:'Save section',exact:true}).click();assert.equal(await teacher.locator('.lab-composer-preview .lab-report-check-row').count(),4);
  await teacher.locator('#addQuestionBtn').click();
  let editor=teacher.locator('.lab-section-editor');
  await editor.locator('[name=type]').selectOption('text_box');
  const body=editor.locator('textarea[name=question]');
  const example='\nMulti\n\nLine\n\nText\n';
  await body.fill('Before the diagram.\nAfter the diagram.\n{'+example+'}');
  await body.evaluate(el=>{const at=el.value.indexOf('After');el.setSelectionRange(at,at);});
  await editor.locator('input[type=file]').setInputFiles({
    name:'positioned.png',mimeType:'image/png',
    buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=','base64'),
  });
  const preview=editor.locator('.lab-section-preview');
  const previewImage=preview.locator('img');
  await previewImage.waitFor({state:'visible'});
  const image=await previewImage.elementHandle(), src=await previewImage.getAttribute('src');
  await body.press('End');
  await body.pressSequentially(' Updated.');
  await preview.getByText(/Updated/).waitFor();
  assert.equal(await image.evaluate(el=>el.isConnected),true);
  assert.equal(await previewImage.getAttribute('src'),src,'Typing keeps the original loaded image');
  assert.equal(await editor.locator('[name=points]').isVisible(),false);
  await teacher.getByRole('button',{name:'Add section',exact:true}).click();
  await teacher.locator('#addQuestionBtn').click();
  editor=teacher.locator('.lab-section-editor');
  await editor.locator('[name=question]').fill('How did you verify that the server was running?');
  await teacher.getByRole('button',{name:'Add section',exact:true}).click();
  for(const light of [false,true]){await teacher.evaluate(light=>document.body.classList.toggle('light-mode',light),light);await screenshot(teacher,'lab-composer-'+(light?'light':'dark'));}
  await teacher.setViewportSize({width:390,height:844});await inBounds(teacher,'.assignment-composer>.modal-content');await screenshot(teacher,'lab-composer-mobile');await teacher.setViewportSize({width:1440,height:1000});
  const created=teacher.waitForResponse(response=>response.url().endsWith('/api/assignments/create')&&response.request().method()==='POST');await teacher.locator('.assignment-composer .modal-save-btn').click();const response=await created;assert.equal(response.status(),200);const assignment=(await response.json()).assignment;
  await teacherContext.request.post(base+'/api/assignments/update',{headers:{'X-Teacher-Token':'agenda-teacher'},data:{assignmentId:assignment.id,active:true,allowSubmissionAnyTime:true}});
  const [checklist, textBox, written]=assignment.quiz.questions;
  assert.equal(textBox.type,'text_box');
  assert.equal(textBox.points,0);
  assert.equal(assignment.quiz.totalPoints,checklist.points+written.points);
  assert.match(textBox.question, /Before the diagram\.\n!\[positioned\]\(lab-image:[a-f0-9]{32}\)After the diagram\./);
  await student.locator('#eagleLabRefreshBtn').click();
  await student.locator('[data-lab-report="'+assignment.id+'"]').click();
  const published=student.locator('.lab-report-window');
  const textBoxView=published.locator('.lab-report-text-box');
  await textBoxView.locator('img').waitFor({state:'visible'});
  assert.equal(await textBoxView.locator('input, textarea').count(),0);
  await textBoxView.locator('[data-lab-copy]').click();
  assert.equal((await student.evaluate(()=>navigator.clipboard.readText())).replace(/\r\n/g,'\n'),example);
  for(const checkbox of await published.locator('input[type=checkbox]').all()) await checkbox.check();
  const firstAnswer='I checked the service with a browser.';
  await published.locator('textarea').fill(firstAnswer);
  const firstSubmission=student.waitForResponse(response=>response.url().endsWith('/api/quiz/submit'));
  await published.getByRole('button',{name:'Submit report'}).click();
  assert.equal((await firstSubmission).status(),200);
  await published.waitFor({state:'detached'});
  const secondAnswer='I checked the service logs and then sent a request.';
  const secondHeaders={'X-User-Token':'agenda-second-student'};
  const secondResponses=[{questionId:checklist.id,answer:[true,true,true,true]},{questionId:written.id,answer:secondAnswer}];
  const forged=[...secondResponses,{questionId:textBox.id,answer:'This section is display only'}];
  const invalidDraft=await studentContext.request.put(base+'/api/lab-reports/'+assignment.id+'/draft',{headers:secondHeaders,data:{revision:0,responses:forged}});
  assert.equal(invalidDraft.status(),400);
  const invalidSubmission=await studentContext.request.post(base+'/api/quiz/submit',{headers:secondHeaders,data:{assignmentId:assignment.id,quizResponses:forged}});
  assert.equal(invalidSubmission.status(),400);
  const secondSubmission=await studentContext.request.post(base+'/api/quiz/submit',{headers:secondHeaders,data:{assignmentId:assignment.id,quizResponses:secondResponses}});
  assert.equal(secondSubmission.status(),200);

  await teacher.locator('[data-view="dash-assignments"]').click();
  const assignmentTitle=teacher.locator('.assignment-title-row[data-id="'+assignment.id+'"]');
  await assignmentTitle.waitFor();
  if (await assignmentTitle.getAttribute('aria-expanded') !== 'true') await assignmentTitle.click();
  await teacher.getByRole('tab',{name:'Submissions',exact:true}).click();
  await teacher.getByRole('button',{name:'Grade report by question'}).click();
  const grading=teacher.locator('.question-grading-dialog');
  await grading.getByText(firstAnswer,{exact:true}).waitFor();
  await grading.getByText(secondAnswer,{exact:true}).waitFor();
  assert.match(await grading.locator('.question-select').textContent(), /Section 3/);
  await grading.locator('.question-grading-filter').selectOption('ungraded');
  const firstRow=grading.locator('.question-grading-row').filter({hasText:firstAnswer});
  await firstRow.getByRole('button',{name:/^Full/}).click();
  await grading.getByText('1 of 2 responses graded · 0 without a response',{exact:true}).waitFor();
  assert.equal(await firstRow.isVisible(),false);
  await grading.locator('.question-grading-filter').selectOption('graded');
  assert.equal(await firstRow.isVisible(),true);
  await screenshot(teacher,'lab-grading-by-question');
  await grading.getByRole('button',{name:'Close',exact:true}).click();
  // A fresh access check hides the navigation after class access is removed.
  const servers=await teacherContext.request.get(base+'/api/eagle-lab/teacher/classes/agenda-class',{headers:{'X-Teacher-Token':'agenda-teacher'}});const rule=(await servers.json()).data.rule;
  await teacherContext.request.put(base+'/api/eagle-lab/teacher/classes/agenda-class',{headers:{'X-Teacher-Token':'agenda-teacher'},data:{...rule,enabled:false}});await student.evaluate(()=>EagleLabAccess.refresh(null,true));assert.equal(await student.locator('#eagleLabViewBtn').isVisible(),false);
  assert.deepEqual(errors,[]);await studentContext.close();await teacherContext.close();console.log('PASS: touch dragging, clipboard toggle and keyboard paste, teacher authoring, stable image previews, multiline text boxes, publishing, class grading and entitlement checks.');
}finally{await browser.close();}
}
