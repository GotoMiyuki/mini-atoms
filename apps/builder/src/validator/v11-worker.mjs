// Trusted protocol interpreter; loaded through the existing read-only manifest
// mount. Imports the pinned M0.5 static transport and hash implementation.
import {chromium,expect} from '@playwright/test';
import {randomUUID,randomInt} from 'node:crypto';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {sha,canonicalHash} from '/app/src/shared.mjs';
import {startStaticLoopback} from '/app/src/validator/static-loopback.mjs';
import {parseStep,canonicalBytes,exact} from './protocol-v11.mjs';
const output='/evidence',origin='http://preview:8080',startedAt=new Date().toISOString(),steps=[],logs=[],assets={},artifactSha256={};
const docHash=v=>canonicalHash({'document.json':canonicalBytes(v)});
let job,manifest,authorization,inventory,test,browser,context,page,transport,timer,current,ready=false,guard=null,crashed=false,status='ERROR',reasonCode='INFRASTRUCTURE',error=null,sandbox=null,setupStatus='NOT_REQUIRED';
const addLog=e=>{if(logs.length<256)logs.push({at:new Date().toISOString(),...e});};
const save=async(name,value)=>{await writeFile(`${output}/${name}`,JSON.stringify(value,null,2));};
const fail=(code,message)=>{const e=new Error(message);e.code=code;throw e;};
function dataPool(){const a=randomInt(100,99999),b=(a+randomInt(1,50000))%99999+1;const amount=c=>`${Math.floor(c/100)}.${String(c%100).padStart(2,'0')}`;return {RUN_UNIQUE_TEXT_A:`m2v11-a-${randomUUID()}`,RUN_UNIQUE_TEXT_B:`m2v11-b-${randomUUID()}`,RUN_POSITIVE_AMOUNT_A:amount(a),RUN_POSITIVE_AMOUNT_B:amount(b===a?b+1:b),RUN_VALID_EMAIL:`test-${randomUUID()}@example.invalid`,RUN_INVALID_EMAIL:`invalid-${randomUUID()}`,EMPTY_STRING:''};}
const values=dataPool();
async function metrics(){const result={nodeMaxRssKiB:process.resourceUsage().maxRSS};for(const name of ['memory.peak','memory.max','memory.events','pids.current','pids.peak','pids.max','cpu.stat'])try{result[name]=(await readFile(`/sys/fs/cgroup/${name}`,'utf8')).trim();}catch{}return result;}
async function processBoundary(){const list=[];for(const pid of await readdir('/proc'))if(/^\d+$/.test(pid))try{const command=(await readFile(`/proc/${pid}/cmdline`,'utf8')).replaceAll('\0',' ');if(command.includes('/ms-playwright/')&&command.includes('chrome')){const text=await readFile(`/proc/${pid}/status`,'utf8');list.push({pid:Number(pid),command:command.slice(0,6000),status:text.split('\n').filter(l=>/^(Uid|Gid|CapEff|NoNewPrivs|Seccomp|NSpid):/.test(l))});}}catch{}return list;}
async function screenshot(name){if(page&&!page.isClosed())await page.screenshot({path:`${output}/${name}`,fullPage:true,timeout:2000});}
try{
  const bytes=await readFile('/jobs/job.json');if(bytes.length>65536)fail('BINDING_MISMATCH','Inbox too large');job=exact(JSON.parse(bytes),['protocolVersion','runId','requirementId','authorization','inventory','manifest']);
  if(job.protocolVersion!=='1.1'||process.env.M05_JOB_ID!==`${job.runId}-${job.requirementId}`)fail('BINDING_MISMATCH','Controller/inbox identity');
  ({authorization,inventory,manifest}=job);const {canonicalAuthorizationHash,...a}=authorization,{inventoryHash,...inv}=inventory;
  if(docHash(a)!==canonicalAuthorizationHash||docHash(inv)!==inventoryHash||authorization.protocolVersion!=='1.1'||authorization.policyVersion!=='m2-b-local-state-2'||authorization.runnerVersion!=='m2-b-v11-2'||authorization.targetInventoryHash!==inventoryHash||authorization.expandedCost>20||authorization.expandedCost!==authorization.authorizedTests.reduce((n,t)=>n+t.expandedSteps.length,0)||sha(await readFile(import.meta.filename))!==authorization.runnerSha256||sha(await readFile('/app/artifacts/protocol-v11.mjs'))!==authorization.parserSha256)fail('BINDING_MISMATCH','Authorization/inventory/runner hash');
  for(const key of ['sourceSha256','buildSha256'])if(manifest[key]!==authorization[key]||inventory[key]!==authorization[key])fail('BINDING_MISMATCH','Static build identity');
  if(manifest.configurationSha256!==authorization.configSha256||inventory.configSha256!==authorization.configSha256||inventory.appVersionId!==authorization.appVersionId||sha(`${manifest.sourceSha256}:${manifest.buildSha256}:${manifest.configurationSha256}`)!==manifest.versionId)fail('BINDING_MISMATCH','Config/version identity');
  test=authorization.authorizedTests.find(t=>t.requirementId===job.requirementId);if(!test)fail('BINDING_MISMATCH','Requirement not authorized');setupStatus=test.setupSourceRequirementId?'PENDING':'NOT_REQUIRED';
  let testSeen=false;for(const x of test.expandedSteps){parseStep(x.step);if(!['SETUP','TEST'].includes(x.phase)||x.phase==='SETUP'&&testSeen)fail('BINDING_MISMATCH','Invalid phase order');if(x.phase==='TEST')testSeen=true;const b=inventory.targets.find(t=>t.bindingId===x.targetBindingId&&t.id===x.step.target);if(!b||b.duplicate)fail('BINDING_MISMATCH','Target binding absent');}
  if(process.getuid?.()!==1001)fail('INFRASTRUCTURE','Runner uid');
  const health=await fetch(`${origin}/healthz`,{signal:AbortSignal.timeout(3000)});if(!health.ok)fail('INFRASTRUCTURE','Preview unavailable');
  transport=await startStaticLoopback();browser=await chromium.launch({headless:true,channel:'chromium',chromiumSandbox:true,timeout:15000});
  const sandboxPage=await browser.newPage();await sandboxPage.goto('chrome://sandbox');const statusText=await sandboxPage.locator('body').innerText();sandbox={requested:true,uid:process.getuid(),browserVersion:browser.version(),statusText};if(!/Layer 1 Sandbox\s+Namespace/.test(statusText)||!/PID namespaces\s+Yes/.test(statusText)||!/Seccomp-BPF sandbox\s+Yes/.test(statusText))fail('INFRASTRUCTURE','Chromium sandbox verification');await save('sandbox-status.json',sandbox);await sandboxPage.close();
  context=await browser.newContext({viewport:{width:1100,height:820},serviceWorkers:'block',acceptDownloads:false});await context.tracing.start({screenshots:true,snapshots:true});page=await context.newPage();page.setDefaultTimeout(2500);
  page.on('console',m=>addLog({type:`console.${m.type()}`,text:m.text().slice(0,2000)}));page.on('pageerror',e=>{crashed=true;addLog({type:'pageerror',text:e.message.slice(0,2000)});});page.on('crash',()=>{crashed=true;});browser.on('disconnected',()=>{crashed=true;});
  page.on('requestfailed',r=>addLog({type:'requestfailed',url:r.url().slice(0,500),text:r.failure()?.errorText}));page.on('download',()=>{guard='DOWNLOAD_BLOCKED';});
  context.on('page',p=>{if(p!==page){guard='POPUP_BLOCKED';p.close().catch(()=>{});}});
  const pending=[];page.on('response',r=>{if(r.url().startsWith(`${transport.origin}/builds/${manifest.versionId}/`)){const name=r.url().split('/').at(-1);if(Object.hasOwn(manifest.assets,name)){const task=(async()=>{const body=await r.body();assets[name]={status:r.status(),sha256:sha(body),bytes:body.length,requestHeaders:await r.request().allHeaders(),headers:r.headers()};})();task.catch(()=>{});pending.push(task);}}});
  const expectedPages=[`${transport.origin}/harness/${manifest.versionId}`,`${transport.origin}/preview/${manifest.versionId}`,`${transport.origin}/builds/${manifest.versionId}/index.html`];
  page.on('framenavigated',f=>{if(ready&&!expectedPages.includes(f.url())&&f.url()!=='about:blank')guard='NAVIGATION_BLOCKED';});
  await page.goto(expectedPages[0],{waitUntil:'networkidle',timeout:10000});await Promise.all(pending);
  for(const [name,m] of Object.entries(manifest.assets))if(!assets[name]||assets[name].status!==200||assets[name].sha256!==m.sha256||assets[name].bytes!==m.bytes)fail('BINDING_MISMATCH',`Browser actual bytes mismatch: ${name}`);
  const html=assets['index.html'];if(html.headers['x-m0-5-build-sha256']!==manifest.buildSha256||html.requestHeaders['sec-fetch-dest']!=='iframe'||html.requestHeaders['sec-fetch-mode']!=='navigate'||html.requestHeaders['sec-fetch-site']!=='same-origin')fail('BINDING_MISMATCH','Iframe identity/metadata');
  await save('browser-assets.json',{basis:'ACTUAL_CHROMIUM_RESPONSE_BODY_SHA256',assets});
  const target=page.frameLocator('[data-testid="shell-frame"]').frameLocator('[data-testid="preview-frame"]');await target.locator('#root').waitFor({state:'attached'});ready=true;await screenshot('before.png');await save('phase.json',{phase:'READY',runId:job.runId,requirementId:job.requirementId});
  timer=setTimeout(()=>{crashed=true;browser?.close().catch(()=>{});},15000);
  for(const [index,x] of test.expandedSteps.entries()){
    if(guard)fail(guard,'Unexpected navigation/popup/download');if(crashed)fail('INFRASTRUCTURE','Browser runtime error');
    // A fixed health check detects real Preview loss without model URLs.
    const h=await fetch(`${origin}/healthz`,{signal:AbortSignal.timeout(1500)});if(!h.ok)fail('INFRASTRUCTURE','Preview lost');
    const {step,phase}=x,binding=inventory.targets.find(t=>t.bindingId===x.targetBindingId),element=target.getByTestId(step.target),options={timeout:step.timeoutMs||2500};
    if(phase==='TEST'&&setupStatus==='PENDING')setupStatus='SETUP_SUCCEEDED';current={index,phase,step,targetBindingId:x.targetBindingId,status:'RUNNING',startedAt:new Date().toISOString()};steps.push(current);
    if(!['assertCount','assertAbsent'].includes(step.action))await expect(element).toHaveCount(1,options);
    // Constant trusted DOM inspection only. No model expression or generated
    // application code is evaluated by this interpreter.
    const dom=await element.evaluateAll(nodes=>nodes.map(n=>({tag:n.tagName.toLowerCase(),type:n.getAttribute('type')||(n.tagName==='INPUT'?'text':null),formAction:n.getAttribute('formaction'),formTarget:n.getAttribute('formtarget'),href:n.getAttribute('href'),download:n.hasAttribute('download'),form:n.closest('form')?.getAttribute('action'),options:n.tagName==='SELECT'?Array.from(n.options).map(o=>o.value):[]})));
    for(const d of dom){if(d.tag!==binding.tag||d.type!==binding.type)fail('TARGET_TYPE_MISMATCH','DOM kind differs from static binding');if(['click','fill','selectOption'].includes(step.action)&&(d.formAction||d.formTarget||d.href||d.download||d.form))fail('UNSUPPORTED_RUNTIME_EFFECT','Navigation/form attributes');}
    if(step.action==='fill'){if(!(dom[0]?.tag==='textarea'||dom[0]?.tag==='input'&&['text','email','number','search'].includes(dom[0]?.type)))fail('TARGET_TYPE_MISMATCH','Not editable');await element.fill(values[step.dataRef],options);}
    else if(step.action==='click'){if(!(dom[0]?.tag==='button'&&dom[0]?.type==='button'||dom[0]?.tag==='input'&&dom[0]?.type==='checkbox'))fail('TARGET_TYPE_MISMATCH','Not audited button/checkbox');await element.click(options);}
    else if(step.action==='selectOption'){if(dom[0]?.tag!=='select'||!binding.optionsStatic||!binding.options.some(o=>o.ref===step.optionRef)||!dom[0].options.includes(step.optionRef))fail('TARGET_TYPE_MISMATCH','Unknown static option');await element.selectOption({value:step.optionRef},options);}
    else if(step.action==='assertVisible')await expect(element).toBeVisible(options);
    else if(step.action==='assertAbsent')await expect(element).toHaveCount(0,options);
    else if(step.action==='assertCount')await expect(element).toHaveCount(step.expected,options);
    else if(step.action==='assertTextContains'){await expect(element).toContainText(Object.hasOwn(step,'expectedRef')?values[step.expectedRef]:step.expectedText,options);current.observedText=(await element.innerText()).slice(0,4096);}
    else if(step.action==='assertInputValue'){if(!['input','textarea'].includes(dom[0]?.tag))fail('TARGET_TYPE_MISMATCH','Not input');await expect(element).toHaveValue(Object.hasOwn(step,'expectedRef')?values[step.expectedRef]:step.expectedText,options);}
    else if(step.action==='assertChecked'){if(dom[0]?.tag!=='input'||dom[0]?.type!=='checkbox')fail('TARGET_TYPE_MISMATCH','Not checkbox');await expect(element).toBeChecked({...options,checked:step.expected});}
    // Count may wait for nodes that were absent at the first metadata check.
    // Recheck the nodes that actually satisfied the assertion before PASS.
    if(step.action==='assertCount'){const actual=await element.evaluateAll(nodes=>nodes.map(n=>({tag:n.tagName.toLowerCase(),type:n.getAttribute('type')||(n.tagName==='INPUT'?'text':null)})));if(actual.some(d=>d.tag!==binding.tag||d.type!==binding.type))fail('TARGET_TYPE_MISMATCH','Count satisfied by an incompatible DOM kind');}
    if(guard)fail(guard,'Unexpected navigation/popup/download');if(crashed)fail('INFRASTRUCTURE','Browser runtime error');current.status='PASS';current.finishedAt=new Date().toISOString();
  }
  if(setupStatus==='PENDING')setupStatus='SETUP_SUCCEEDED';status='PASS';reasonCode='ASSERTIONS_PASSED';
}catch(e){if(ready)try{const h=await fetch(`${origin}/healthz`,{signal:AbortSignal.timeout(1000)});if(!h.ok)e.code='INFRASTRUCTURE';}catch{e.code='INFRASTRUCTURE';}error={code:e.code||null,name:e.name,message:String(e.message).slice(0,4000)};const assertion=current&&ready&&!guard&&!crashed&&!e.code&&(e.name==='Error'||e.name==='TimeoutError')&&/expect\(|locator\.|Timeout|Expected|Received/.test(e.message);
  if(e.code==='TARGET_TYPE_MISMATCH'||e.code==='UNSUPPORTED_RUNTIME_EFFECT'||guard){status='UNVERIFIED';reasonCode=e.code||guard;}
  else if(assertion){status=current.phase==='SETUP'?'UNVERIFIED':'FAIL';reasonCode=current.phase==='SETUP'?'SETUP_FAILED':'APP_BEHAVIOR';if(current.phase==='SETUP')setupStatus='SETUP_FAILED';}
  else{status='ERROR';reasonCode=e.code==='BINDING_MISMATCH'?'BINDING_MISMATCH':'INFRASTRUCTURE';}
  if(current&&current.status==='RUNNING'){current.status=status==='FAIL'?'FAIL':'UNVERIFIED';current.message=error.message;current.finishedAt=new Date().toISOString();}
}finally{
  clearTimeout(timer);const missing=[];try{await screenshot('after.png');}catch(e){missing.push({kind:'AFTER_SCREENSHOT',reason:String(e.message).slice(0,200)});}
  try{await save('process-boundary.json',await processBoundary());}catch{}try{if(context)await context.tracing.stop({path:`${output}/trace.zip`});}catch(e){missing.push({kind:'TRACE',reason:String(e.message).slice(0,200)});}
  if(browser)await browser.close().catch(()=>{});if(transport){await save('static-transport.json',{origin:transport.origin,requests:transport.requests});await transport.close();}
  await save('browser-log.json',{logs});await save('setup-observation.json',{status:setupStatus,sourceRequirementId:test?.setupSourceRequirementId||null,steps:steps.filter(s=>s.phase==='SETUP'),reason:setupStatus==='SETUP_FAILED'?error:null});
  for(const name of await readdir(output))if(/^(before|after)\.png$|^(trace\.zip|sandbox-status\.json|process-boundary\.json|static-transport\.json|browser-log\.json|browser-assets\.json|setup-observation\.json|phase\.json)$/.test(name))artifactSha256[name]=sha(await readFile(`${output}/${name}`));
  if(['PASS','FAIL'].includes(status)&&['before.png','after.png','trace.zip','sandbox-status.json','browser-assets.json'].some(n=>!artifactSha256[n])){status='ERROR';reasonCode='EVIDENCE_INCOMPLETE';}
  await save('report.json',{protocolVersion:'1.1',runId:job?.runId,requirementId:job?.requirementId,authorizationId:authorization?.authorizationId,authorizationHash:authorization?.canonicalAuthorizationHash,testPlanId:authorization?.testPlanId,sourceSha256:manifest?.sourceSha256,buildSha256:manifest?.buildSha256,configSha256:manifest?.configurationSha256,versionId:manifest?.versionId,runnerVersion:authorization?.runnerVersion,status,reasonCode,setupStatus,startedAt,finishedAt:new Date().toISOString(),steps,data:values,error,sandbox,metrics:await metrics(),artifactSha256,missingEvidence:missing});
}
process.exitCode={PASS:0,FAIL:1,ERROR:2,UNVERIFIED:3}[status];
