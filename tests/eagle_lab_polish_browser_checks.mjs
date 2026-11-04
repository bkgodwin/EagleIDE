// Run only against lesson_plan_browser_fixture.py --lab (all data is temporary).
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const module=process.env.EAGLE_LAB_PLAYWRIGHT_MODULE||'playwright';
const {chromium}=await import(isAbsolute(module)?pathToFileURL(module).href:module);
const base=process.env.EAGLE_LAB_TEST_URL,output=process.env.EAGLE_LAB_SCREENSHOT_DIR;
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(base||''))throw Error('Use the isolated --lab fixture URL');
const browser=await chromium.launch({headless:true,executablePath:process.env.EAGLE_LAB_BROWSER});
const errors=[];
async function account(session){const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.grantPermissions(['clipboard-read','clipboard-write']);await context.addInitScript(value=>sessionStorage.setItem('eagle-auth-session-v1',JSON.stringify(value)),session);const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());await page.goto(base,{waitUntil:'networkidle'});return {context,page};}
async function screenshot(page,name){if(output){mkdirSync(output,{recursive:true});await page.screenshot({path:join(output,name+'.png')});}}
async function inBounds(page,selector){assert.ok(await page.locator(selector).evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1;}),selector+' must stay on screen');}
try{
  const {context:studentContext,page:student}=await account({userToken:'agenda-student',currentUser:{email:'student@example.test',role:'student'}});
  await student.locator('#eagleLabViewBtn').waitFor({state:'visible'});await student.locator('#eagleLabViewBtn').click();await student.locator('[data-lab-server]').first().waitFor();
  assert.equal(await student.locator('[data-lab-server]').count(),3);await screenshot(student,'lab-student-dark');
  await student.getByRole('button',{name:/Your first self hosted service/}).click();await student.locator('.lab-report-window').waitFor();
  assert.equal(await student.locator('.lab-report-window').getAttribute('aria-modal'),'false');
  await student.locator('[data-lab-copy="hostname"]').click();assert.equal(await student.evaluate(()=>navigator.clipboard.readText()),'hostname');
  await student.locator('[data-report-question="notes"]').fill('The guest has a private IPv4 address.');
  await student.locator('#eagleLabSearch').fill('02');assert.equal(await student.locator('[data-lab-server]').count(),1,'background remains interactive');
  await student.locator('[data-float-move]').press('ArrowLeft');await student.locator('[data-float-resize]').press('ArrowLeft');await inBounds(student,'.lab-report-window');
  assert.ok(await student.locator('[data-step="0"]').evaluate(el=>el.getBoundingClientRect().width>=24));
  await student.locator('[data-float-minimize]').click();assert.equal(await student.locator('.lab-report-page').isVisible(),false);await student.locator('[data-float-minimize]').click();assert.equal(await student.locator('[data-report-question="notes"]').inputValue(),'The guest has a private IPv4 address.');
  await student.getByRole('button',{name:'Close for now'}).click();await student.locator('.lab-report-overlay').waitFor({state:'detached'});
  await student.locator('#eagleLabManualBtn').click();await student.locator('.lab-manual-window').waitFor();await student.locator('.lab-manual-search input').fill('network');await student.locator('[data-chapter="network"]').click();await student.locator('.lab-copy-text').first().click();assert.equal(await student.evaluate(()=>navigator.clipboard.readText()),'ip -br addr');await screenshot(student,'lab-manual-dark');
  await student.setViewportSize({width:390,height:844});await inBounds(student,'.lab-manual-window');await screenshot(student,'lab-manual-mobile');await student.locator('[data-manual-close]').click();
  for(const light of [false,true]){await student.evaluate(light=>document.body.classList.toggle('light-mode',light),light);await student.locator('#eagleLabSearch').fill('');await screenshot(student,'lab-student-mobile-'+(light?'light':'dark'));assert.ok(await student.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
  await student.setViewportSize({width:1440,height:1000});await student.locator('[data-lab-server]').first().click();await student.getByRole('dialog').filter({has:student.locator('.eagle-lab-detail')}).waitFor();await screenshot(student,'lab-server-detail');await student.keyboard.press('Escape');

  console.log('Student surfaces verified.');
  await student.locator('#ideViewBtn').click();await student.evaluate(()=>EagleIDE.getContext().setEditorSnapshot({code:'print("Lab UI smoke test")',language:'python',fileName:'lab-smoke.py',draft:true}));await student.locator('#runBtn').click();await student.locator('#output').filter({hasText:'Lab UI smoke test'}).waitFor();await student.locator('#eagleLabViewBtn').click();
  const {context:teacherContext,page:teacher}=await account({teacherToken:'agenda-teacher',currentTeacher:{email:'teacher@example.test',role:'teacher'}});
  await teacher.locator('#ideViewBtn').click();await teacher.locator('#roleMenuBtn').click();await teacher.locator('#teacherDashboardBtn').click();await teacher.locator('[data-view="dash-eagle-lab"]').click();await teacher.locator('[data-teacher-server]').first().waitFor();
  await teacher.locator('#eagleLabTeacherCredentials').check();await teacher.locator('[data-teacher-server]').last().uncheck();await teacher.locator('#eagleLabTeacherRefreshBtn').click();await teacher.getByText('Unsaved changes · refresh keeps your edits',{exact:true}).waitFor();assert.equal(await teacher.locator('#eagleLabTeacherCredentials').isChecked(),true);assert.equal(await teacher.locator('[data-teacher-server]').last().isChecked(),false);
  await teacher.locator('#eagleLabTeacherClassSelect').selectOption('agenda-section');await teacher.waitForFunction(()=>EagleLab.getState().teacherClassId==='agenda-section');assert.equal(await teacher.locator('#eagleLabTeacherCredentials').isChecked(),false);
  await teacher.locator('#eagleLabTeacherClassSelect').selectOption('agenda-class');await teacher.waitForFunction(()=>EagleLab.getState().teacherClassId==='agenda-class');assert.equal(await teacher.locator('#eagleLabTeacherCredentials').isChecked(),true);await screenshot(teacher,'lab-teacher-rules');
  let releaseSave;const savingGate=new Promise(resolve=>releaseSave=resolve);
  await teacher.route('**/api/eagle-lab/teacher/classes/agenda-class',async route=>{if(route.request().method()==='PUT')await savingGate;await route.continue();});
  await teacher.locator('#eagleLabTeacherSaveBtn').click();await teacher.waitForFunction(()=>EagleLab.getState().teacherSaving);await teacher.locator('#eagleLabTeacherCredentials').uncheck();releaseSave();await teacher.getByText('Saved. Newer edits are still unsaved.',{exact:true}).waitFor();assert.equal(await teacher.locator('#eagleLabTeacherCredentials').isChecked(),false);await teacher.unroute('**/api/eagle-lab/teacher/classes/agenda-class');
  await teacher.locator('#eagleLabTeacherSaveBtn').click();await teacher.getByText('Class access saved.',{exact:true}).waitFor();
  console.log('Teacher draft retention verified.');
  await teacher.locator('[data-view="dash-assignments"]').click();await teacher.locator('#newAssignmentBtn').click();await teacher.locator('#modalAssignmentType').selectOption('lab_report');await teacher.locator('.lab-composer-preview').waitFor();assert.equal(await teacher.locator('.assignment-composer>.modal-content').evaluate(el=>getComputedStyle(el).display),'grid');await teacher.locator('#modalAssignmentName').fill('Browser-built hosting report '+Date.now());await teacher.locator('#modalAssignmentTask').fill('Test your app with {curl http://127.0.0.1:8000}.');
  await teacher.locator('#composer-tab-questions').click();await teacher.locator('#addQuestionBtn').click();await teacher.locator('.lab-section-editor').waitFor();
  await teacher.locator('.lab-section-editor select[name=type]').selectOption('procedure');await teacher.locator('.lab-section-editor textarea[name=question]').fill('Use {pwd} to check your project directory.');await teacher.locator('.lab-section-editor textarea[name=steps]').fill('Create the site directory.\nStart the server.\nCheck the response.');
  await teacher.locator('.lab-section-editor input[type=file]').setInputFiles({name:'example.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=','base64')});await teacher.locator('.lab-section-preview img').waitFor({state:'visible'});await screenshot(teacher,'lab-report-editor-dark');
  await teacher.getByRole('button',{name:'Add section',exact:true}).click();await teacher.locator('.lab-section-editor').waitFor({state:'detached'});await teacher.locator('.lab-composer-preview [data-lab-copy="pwd"]').waitFor();
  await teacher.locator('[data-edit-report]').click();await teacher.locator('.lab-section-editor textarea[name=steps]').fill('Create the site directory.\nStart the server.\nCheck the response.\nRecord your results.');await teacher.getByRole('button',{name:'Save section',exact:true}).click();assert.equal(await teacher.locator('.lab-composer-preview .lab-report-check-row').count(),4);
  for(const light of [false,true]){await teacher.evaluate(light=>document.body.classList.toggle('light-mode',light),light);await screenshot(teacher,'lab-composer-'+(light?'light':'dark'));}
  await teacher.setViewportSize({width:390,height:844});await inBounds(teacher,'.assignment-composer>.modal-content');await screenshot(teacher,'lab-composer-mobile');await teacher.setViewportSize({width:1440,height:1000});
  const created=teacher.waitForResponse(response=>response.url().endsWith('/api/assignments/create')&&response.request().method()==='POST');await teacher.locator('.assignment-composer .modal-save-btn').click();const response=await created;assert.equal(response.status(),200);const assignment=(await response.json()).assignment;
  await teacherContext.request.post(base+'/api/assignments/update',{headers:{'X-Teacher-Token':'agenda-teacher'},data:{assignmentId:assignment.id,active:true,allowSubmissionAnyTime:true}});
  await student.locator('#eagleLabRefreshBtn').click();await student.locator('[data-lab-report="'+assignment.id+'"]').waitFor();await student.locator('[data-lab-report="'+assignment.id+'"]').click();await student.locator('.lab-report-image img').waitFor({state:'visible'});await student.locator('[data-lab-copy="pwd"]').click();assert.equal(await student.evaluate(()=>navigator.clipboard.readText()),'pwd');await student.getByRole('button',{name:'Close for now'}).click();
  // A fresh access check hides the navigation after class access is removed.
  const servers=await teacherContext.request.get(base+'/api/eagle-lab/teacher/classes/agenda-class',{headers:{'X-Teacher-Token':'agenda-teacher'}});const rule=(await servers.json()).data.rule;
  await teacherContext.request.put(base+'/api/eagle-lab/teacher/classes/agenda-class',{headers:{'X-Teacher-Token':'agenda-teacher'},data:{...rule,enabled:false}});await student.evaluate(()=>EagleLabAccess.refresh(null,true));assert.equal(await student.locator('#eagleLabViewBtn').isVisible(),false);
  assert.deepEqual(errors,[]);await studentContext.close();await teacherContext.close();console.log('PASS: real student/teacher UI, background interaction, clipboard, floating viewport bounds, manual, class draft retention, live editor, protected image upload/read, section editing, publishing and entitlement hiding.');
}finally{await browser.close();}
