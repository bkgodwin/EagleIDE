/* Opt-in browser checks; starts only an isolated loopback fixture with synthetic accounts. */
const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path');
const {spawn}=require('node:child_process'), {createInterface}=require('node:readline');
const {chromium}=require('playwright');
async function capture(page,name) {
 const directory=process.env.EAGLE_INFRA_SCREENSHOTS;
 if(directory) {fs.mkdirSync(directory,{recursive:true});await page.screenshot({path:path.join(directory,name)});}
}
async function homeChecks(browser,origin) {
 const errors=[];
  const page=await browser.newPage({viewport:{width:1510,height:980},acceptDownloads:true});
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());page.setDefaultTimeout(12000);
  const $=s=>page.locator(s);
  assert.deepEqual(await page.request.get(origin+'/health').then(r=>r.json()),{ok:true});
  const setting=await page.request.put(origin+'/api/network/teacher/classes/net-design/infra-labs/infra-lab-01',
     {headers:{'X-Teacher-Token':'fixture-teacher'},data:{assigned:true,submissions:1}});
  assert.equal(setting.status(),200,await setting.text());
  await page.goto(origin+'/fixture/classroom/student',{waitUntil:'domcontentloaded'});
  await $('#wifiLabsFolder summary').click();await $('[data-wifi-lab="infra-lab-01"]').click();
  await $('#wifiStarterChecklist').waitFor();
  const stable=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const mark=async(x,y)=>{
    await stable();
    const p=await $('#wifiObjects').evaluate((svg,[x,y])=>new DOMPoint(x,y).matrixTransform(svg.getScreenCTM()).toJSON(),[x,y]);
    await page.mouse.click(p.x,p.y);
  };
  const section=async key=>{
    const d=$('[data-wifi-config="'+key+'"]');if(!await d.evaluate(n=>n.open))await d.locator('summary').click();
  };
  const close=async()=>{
    const b=$('#wifiObjectPanel [data-wifi-close-panel]');if(await b.isVisible())await b.click();
  };
  const tool=async kind=>{await close();await $('[data-wifi-tool="'+kind+'"]').click()};
  const quiz=async(text,correct=true)=>{
    const dialog=$('.wifi-lab-quiz');await dialog.waitFor();
    await dialog.locator('label').filter({hasText:text}).locator('input').check();
    await dialog.locator('[type=submit]').click();
    const feedback=dialog.locator('.wifi-lab-feedback');
    await page.waitForFunction(correct=>document.querySelector('.wifi-lab-feedback')?.dataset.correct===String(correct),correct);
    assert.ok((await feedback.innerText()).length>40);
    await capture(page,'eagle-guided-lab-feedback.png');
    await dialog.locator('[data-quiz-continue]').click();
  };
  const route=async(x,y,port)=>{
    await tool('cable');await $('#wifiCableMedia').selectOption('ethernet');
    await mark(x,y);await mark(6,6);
    await $('#wifiCableToPort').selectOption(port);
    const picker=$('.wifi-starter-picker');
    if(await picker.isVisible())await page.keyboard.press('Escape');
    await $('#wifiCableConfirm').click();
  };
  await tool('equipment');await $('#wifiEquipmentType').selectOption('home_router');await mark(6,6);
  await capture(page,'eagle-guided-lab-debug.png');
  await quiz(/extends the trusted LAN/,false);
  await tool('select');await mark(6,6);await section('dhcp');
  await $('#wifiDhcpGateway').fill('192.168.10.1/24');await $('#wifiDhcpGateway').press('Tab');
  await route(2.5,3,'ETH1');
  await quiz(/Move the router toward occupied rooms/);
  await tool('select');await mark(6,6);await section('home-wifi');
  await $('#wifiHomeSsid').selectOption(':add');
  await $('#wifiHomeSsidName').fill('Home');await $('[data-wifi-network=save-home-ssid]').click();
  await close();await mark(5,8);await $('#wifiPhoneSsid').selectOption({label:'Home'});
  await quiz(/Inspect the desktop cable/);
  await route(10,3,'ETH2');
  await quiz(/moves TV traffic off shared/);
  await tool('equipment');await $('#wifiEquipmentType').selectOption('demarc');await $('#wifiEquipmentIsp').selectOption('meadowlink');await mark(14,3);
  await route(14,3,'WAN1');
  await close();await $('[data-wifi-tool=select]').click();await mark(5,8);
  await $('#wifiPingTarget').selectOption(':internet');await $('#wifiPingToggle').click();
  await quiz(/tested LAN paths work/);
  await $('.wifi-lab-assessment [data-lab-submit]').click();
  await page.waitForFunction(()=>document.querySelector('.wifi-lab-assessment').textContent.includes('Submitted · 94%'));
  assert.ok(await $('[data-lab-next]').isDisabled());
  await capture(page,'eagle-guided-lab-score.png');
  await $('#wifiSiteBack').click();
  await page.waitForFunction(()=>document.querySelector('[data-wifi-lab="infra-lab-01"]')?.textContent.includes('Latest 94%'));
  assert.match(await $('[data-wifi-lab="infra-lab-01"]').innerText(),/Latest 94%/);
  const teacher=await browser.newPage({viewport:{width:1530,height:980}});
  teacher.on('pageerror',e=>errors.push(e.message));teacher.on('dialog',d=>d.accept());
  await teacher.goto(origin+'/fixture/classroom/teacher',{waitUntil:'domcontentloaded'});
  await teacher.evaluate(async()=>{
    const ctx=window.EagleIDE.getContext;
    window.EagleIDE.getContext=()=>({...ctx(),ADMIN_TOKEN:null,USER_TOKEN:null,TEACHER_TOKEN:'fixture-teacher',teacherClasses:[{id:'net-design',name:'Infra Design'}]});
    await window.EagleFeatures.load('network');
    document.querySelector('#teacherDashboardModal').style.display='flex';
    document.querySelectorAll('#teacherDashboardModal .teacher-dash-view').forEach(n=>n.classList.toggle('active',n.id==='dash-network'));
    await window.NetworkSim.openTeacherPanel();
  });
  const card=teacher.locator('#networkTeacherInfraLabList article').first();
  assert.equal(await teacher.locator('#networkTeacherInfraLabList article').count(),5);
  await card.locator('summary').click();
  assert.match(await card.innerText(),/94%/);
  await card.locator('[data-infra-lab-reset]').click();
  await teacher.waitForFunction(()=>document.querySelector('#networkTeacherInfraLabList article td')?.textContent==='—');
  await card.locator('[data-infra-lab-allowance]').fill('0');
  await card.locator('[data-infra-lab-save]').click();
  await teacher.waitForFunction(()=>document.querySelector('[data-infra-lab-allowance]')?.value==='0' && !document.querySelector('[data-infra-lab-allowance]').disabled);
  const report=await teacher.request.get(origin+'/api/network/teacher/classes/net-design',{headers:{'X-Teacher-Token':'fixture-teacher'}}).then(r=>r.json());
  assert.equal(report.data.infra_labs[0].students[0].attempts,0);
  assert.equal(report.data.infra_labs[0].submissions,0);
  await card.locator('[data-infra-lab-preview]').click();
  await teacher.locator('#wifiStarterChecklist').waitFor();
  assert.match(await teacher.locator('.wifi-lab-assessment').innerText(),/Teacher preview/);
  const guest=await browser.newPage();await guest.goto(origin+'/network',{waitUntil:'domcontentloaded'});
  await guest.locator('#infraSimHub').waitFor();assert.equal(await guest.locator('#wifiLabsFolder').isVisible(),false);
  const blocked=await guest.request.post(origin+'/api/network/wifi-labs/infra-lab-01?class_id=net-design');assert.equal(blocked.status(),403);
  assert.deepEqual(errors,[]);
  console.log('Completed Lab 1 through the real UI, scored all five questions, submitted 94%, enforced the allowance, reset from the teacher roster, saved unlimited attempts, previewed, and blocked guest access.');
}

async function rackChecks(browser,origin) {
 const errors=[];
  const page=await browser.newPage({viewport:{width:1510,height:980}});page.setDefaultTimeout(12000);
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  const $=s=>page.locator(s), sh={'X-User-Token':'fixture-student'},th={'X-Teacher-Token':'fixture-teacher'};
  const api=async(url,method,data,headers=sh)=>{const r=await page.request.fetch(origin+url,{method,data,headers});assert.equal(r.status(),200,await r.text());return(await r.json()).data};
  await api('/api/network/teacher/classes/net-design/infra-labs/infra-lab-02','PUT',{assigned:true,submissions:0},th);
  { const p='/api/network/wifi-labs/infra-lab-02?class_id=net-design'; let d=await api(p,'POST'); if(d.site.equipment.some(e=>e.kind==='rack')) { if(!d.progress.assessment.submitted)d=await api(p.replace('?','/submit?'),'POST',{revision:d.revision,attempt_id:d.attempt_id});await api(p.replace('?','/next?'),'POST',{revision:d.revision,attempt_id:d.attempt_id});} }
  await page.goto(origin+'/fixture/classroom/student',{waitUntil:'domcontentloaded'});
  await $('#wifiLabsFolder summary').click();await $('[data-wifi-lab="infra-lab-02"]').click();await $('#wifiStarterChecklist').waitFor();
  const mark=async(x,y)=>{const p=await $('#wifiObjects').evaluate((svg,[x,y])=>new DOMPoint(x,y).matrixTransform(svg.getScreenCTM()).toJSON(),[x,y]);await page.mouse.click(p.x,p.y)};
  const focused=async selector=>{
    try {await page.waitForFunction(s=>Boolean(document.querySelector(s)?.hasAttribute('data-wifi-starter-focus')),selector);}
    catch(error) {
      await capture(page,'eagle-guided-lab-guidance-failure.png');
      error.message+=' · Expected '+selector+'; focused '+await page.locator('[data-wifi-starter-focus]').evaluateAll(nodes=>nodes.map(n=>n.outerHTML.slice(0,300)).join(' | '));
      throw error;
    }
  };
  await $('[data-wifi-tool=equipment]').click();await $('#wifiEquipmentType').selectOption('rack');await mark(15,3);
  await focused('[data-wifi-starter-focus].wifi-gear-rack');await mark(15,3);await $('#wifiRackDialog').waitFor();
  const mounts=[[16,'patch_panel'],[14,'distribution_switch'],[12,'router']];
  for(const[u,kind]of mounts){
    await focused('[data-rack-slot="'+u+'"]');await $('[data-rack-slot="'+u+'"]').click();
    await $('[data-rack-mode=install]').click();await $('[data-rack-kind]').selectOption(kind);await $('[data-rack-add]').click();
  }
  await $('.wifi-lab-quiz').waitFor();assert.equal(await $('#wifiRackDialog').isVisible(),true);assert.equal(await $('#wifiStarterRackChecks li').count(),4);
  await $('.wifi-lab-quiz input').first().check();await $('.wifi-lab-quiz [type=submit]').click();await $('[data-quiz-continue]').click();
  assert.equal(await $('[data-rack-profile=router]').evaluate(n=>n.classList.contains('is-selected')),true);
  const dhcp=$('[data-wifi-config=dhcp]');
  await focused(await dhcp.evaluate(n=>n.open)?'#wifiDhcpGateway':'[data-wifi-config=dhcp] summary');
  if(!await dhcp.evaluate(n=>n.open))await dhcp.locator('summary').click();
  await $('#wifiDhcpGateway').fill('10.20.0.1/24');await $('#wifiDhcpGateway').press('Tab');
  await focused('[data-rack-mode=cable]');await $('[data-rack-mode=cable]').click();
  await focused('[data-rack-media]');await $('[data-rack-media]').selectOption('fiber');
  await focused('[data-rack-profile=router] [data-rack-port$=":SFP1"]');
  await $('[data-rack-profile=router] [data-rack-port$=":SFP1"]').click();
  await focused('[data-rack-profile=distribution_switch] [data-rack-port$=":SFP1"]');
  await $('[data-rack-profile=distribution_switch] [data-rack-port$=":SFP1"]').click();
  await focused('#wifiRackDialog header button');await capture(page,'eagle-guided-lab-rack.png');
  await $('#wifiRackDialog header button').click();await $('#wifiSiteBack').click();
  await api('/api/network/teacher/classes/net-design/infra-labs/infra-lab-05','PUT',{assigned:true,submissions:0},th);
  const lab='/api/network/wifi-labs/infra-lab-05?class_id=net-design';
  let draft=await api(lab,'POST');if(draft.site.equipment.some(d=>d.kind==='rack')){if(!draft.progress.assessment.submitted)draft=await api(lab.replace('?','/submit?'),'POST',{revision:draft.revision,attempt_id:draft.attempt_id});draft=await api(lab.replace('?','/next?'),'POST',{revision:draft.revision,attempt_id:draft.attempt_id});} const site=await page.request.get(origin+'/fixture/lab5').then(r=>r.json());
  draft=await api(lab,'PUT',{site,revision:draft.revision,attempt_id:draft.attempt_id,evidence:[]});
  draft=await api(lab.replace('?','/answer?'),'POST',{revision:draft.revision,attempt_id:draft.attempt_id,question:'q1',choice:'2'});
  await page.reload({waitUntil:'domcontentloaded'});await $('#wifiLabsFolder summary').click();await $('[data-wifi-lab="infra-lab-05"]').click();
  await $('#wifiStarterChecklist').waitFor();assert.match(await $('#wifiStarterTip').innerText(),/SFP2/);
  await $('[data-wifi-tool=cable]').click();await $('#wifiCableMedia').selectOption('fiber');await mark(16.5,3);
  await $('.wifi-starter-picker [data-recommended]').waitFor();assert.equal(await $('.wifi-starter-picker [data-recommended]').getAttribute('data-value'),'switch:SFP2');await $('.wifi-starter-picker [data-recommended]').click();
  await mark(27,14);await $('.wifi-starter-picker [data-recommended]').waitFor();assert.equal(await $('.wifi-starter-picker [data-recommended]').getAttribute('data-value'),'remote-switch:SFP1');await $('.wifi-starter-picker [data-recommended]').click();
  await $('#wifiCableConfirm').click();await $('.wifi-lab-quiz').waitFor();await $('.wifi-lab-quiz input').first().check();await $('.wifi-lab-quiz [type=submit]').click();await $('[data-quiz-continue]').click();
  if(await $('[data-wifi-tool=select]').getAttribute('aria-pressed')!=='true'){await focused('[data-wifi-tool=select]');await $('[data-wifi-tool=select]').click();}
  await focused('.wifi-gear-rack[data-wifi-starter-focus]');const remote=await $('[data-wifi-starter-focus]').getAttribute('class');assert.match(remote,/wifi-gear-rack/);
  await mark(16.5,3);await $('#wifiRackDialog').waitFor();await focused('#wifiRackDialog header button');await $('#wifiRackDialog header button').click();
  await mark(27,14);await $('#wifiRackDialog').waitFor();await focused('[data-rack-profile=distribution_switch]');await $('[data-rack-profile=distribution_switch]').click();
  await focused('[data-rack-port="remote-switch:SFP1"]');await $('[data-rack-port="remote-switch:SFP1"]').click();
  const ports=$('[data-wifi-config=ports]');if(!await ports.evaluate(n=>n.open))await ports.locator('summary').click();
  await $('#wifiTagged-20').check();await $('.wifi-lab-quiz').waitFor();
  await capture(page,'eagle-guided-lab-rack-question.png');
  await $('.wifi-lab-quiz [data-quiz-close]').click();await $('#wifiRackDialog header button').click();
  for(const theme of ['light','dark'])for(const width of [1510,760,390]){
   await page.setViewportSize({width,height:980});await page.evaluate(t=>document.body.classList.toggle('light-mode',t==='light'),theme);
   await capture(page,'eagle-guided-lab-'+theme+'-'+width+'.png');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'horizontal overflow '+theme+width);
   assert.equal(await $('#wifiStarterChecklist').isVisible(),true);
   if(width<720) {
     await $('#wifiStarterNext').click();await $('.wifi-lab-quiz').waitFor();
     const bounds=await $('.wifi-lab-quiz').boundingBox();
     assert.ok(bounds.y>=0 && bounds.y+bounds.height<=980,'Question stays within the viewport');
     await capture(page,'eagle-guided-lab-'+theme+'-'+width+'-question.png');
     await $('.wifi-lab-quiz [data-quiz-close]').click();
   }
  }
  await page.setViewportSize({width:390,height:650});
  await $('#wifiStarterNext').click();await $('.wifi-lab-quiz').waitFor();
  const question=await $('.wifi-lab-quiz').boundingBox();
  assert.ok(question.y>=0 && question.y+question.height<=650,'Long question fits a short phone viewport');
  await $('.wifi-lab-quiz [type=submit]').scrollIntoViewIfNeeded();
  const submit=await $('.wifi-lab-quiz [type=submit]').boundingBox();
  assert.ok(submit.y>=0 && submit.y+submit.height<=650,'Long question Submit remains reachable');
  await capture(page,'eagle-guided-lab-short-phone-question.png');
  await $('.wifi-lab-quiz [data-quiz-close]').click();
  assert.deepEqual(errors,[]);console.log('Rack mounting, checklist in rack, stacked quiz, router highlight, two-wing source/destination port recommendations, wrong-rack guidance, switch port VLAN highlight, and responsive theme checks passed.');

}

async function teacherCatalogChecks(browser,origin) {
  const page=await browser.newPage({viewport:{width:1510,height:980}});
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const headers={'X-Teacher-Token':'fixture-teacher'};
  const assigned=await page.request.put(origin+'/api/network/teacher/classes/net-review/infra-labs/infra-lab-02',
    {headers,data:{assigned:true,submissions:3}});
  assert.equal(assigned.status(),200);
  await page.goto(origin+'/fixture/classroom/teacher',{waitUntil:'domcontentloaded'});
  const $=s=>page.locator(s);
  await $('#wifiLabsFolder summary').click();
  assert.equal(await $('[data-wifi-lab]').count(),5);
  await $('#wifiLabsClass').selectOption('net-design');
  assert.match(await $('[data-wifi-lab="infra-lab-01"]').innerText(),/Enabled for students/);
  assert.match(await $('[data-wifi-lab="infra-lab-03"]').innerText(),/Not enabled for students/);
  await $('#wifiLabsClass').selectOption('net-review');
  assert.match(await $('[data-wifi-lab="infra-lab-02"]').innerText(),/Enabled for students/);
  assert.match(await $('[data-wifi-lab="infra-lab-01"]').innerText(),/Not enabled for students/);
  await $('[data-wifi-lab="infra-lab-05"]').click();
  await $('#wifiStarterChecklist').waitFor();
  assert.match(await $('.wifi-lab-assessment').innerText(),/Teacher preview/);
  await $('#wifiSiteBack').click();
  assert.equal(await $('#wifiLabsClass').inputValue(),'net-review');
  await $('#wifiLabsClass').selectOption('');
  await $('[data-wifi-lab="infra-lab-03"]').click();
  await $('#wifiStarterChecklist').waitFor();
  assert.match(await $('.wifi-lab-assessment').innerText(),/Teacher preview/);
  await $('#wifiSiteBack').click();
  const disabled=await page.request.put(origin+'/api/network/teacher/classes/net-review/settings',
    {headers,data:{access:{infra:false,packet:false}}});
  assert.equal(disabled.status(),200);
  await page.reload({waitUntil:'domcontentloaded'});
  await $('#wifiLabsFolder summary').click();
  await $('#wifiLabsClass').selectOption('net-review');
  assert.match(await $('[data-wifi-lab="infra-lab-02"]').innerText(),/Assigned · Infra Sim access is off/);
  assert.equal(await $('[data-wifi-lab]').count(),5);
  for(const theme of ['light','dark'])for(const width of [1510,760,390]) {
    await page.setViewportSize({width,height:980});
    await page.evaluate(t=>document.body.classList.toggle('light-mode',t==='light'),theme);
    await $('#wifiLabsClass').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'Teacher catalog overflow');
    await capture(page,'eagle-teacher-labs-'+theme+'-'+width+'.png');
  }
  await $('[data-wifi-lab="infra-lab-02"]').click();
  await $('#wifiStarterChecklist').waitFor();
  assert.match(await $('.wifi-lab-assessment').innerText(),/Teacher preview/);
  assert.deepEqual(errors,[]);
  console.log('Teacher catalog shows all labs, switches class indicators, preserves selection, and previews unassigned labs, disabled-class labs, and labs without a class.');
}

async function main() {
 const fixture=spawn(process.env.EAGLE_INFRA_PYTHON||'python',[path.join(__dirname,'wifi_guided_labs_browser_fixture.py')],{stdio:['ignore','pipe','pipe']});
 let browser, logs='';
 fixture.stderr.on('data',chunk=>{logs=(logs+chunk).slice(-4000)});
 try {
  const origin=await new Promise((resolve,reject)=>{
   const lines=createInterface({input:fixture.stdout});
   const timer=setTimeout(()=>reject(new Error('Fixture startup timed out. '+logs)),60000);
   fixture.once('exit',code=>{clearTimeout(timer);reject(new Error('Fixture exited '+code+'. '+logs))});
   fixture.once('error',error=>{clearTimeout(timer);reject(error)});
   lines.on('line',line=>{if(line.startsWith('{"url"')){clearTimeout(timer);resolve(JSON.parse(line).url)}});
  });
  assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/);
  browser=await chromium.launch({headless:true,executablePath:process.env.EAGLE_INFRA_BROWSER});
  await homeChecks(browser,origin);
  await rackChecks(browser,origin);
  await teacherCatalogChecks(browser,origin);
 } finally {if(browser)await browser.close();fixture.kill();}
}
main().catch(error=>{console.error(error);process.exitCode=1});
