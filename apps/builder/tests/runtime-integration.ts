import assert from 'node:assert/strict';
import {request} from 'node:http';
import {cp,mkdir,readFile,writeFile,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {configuration,appRoot} from '../src/server/config.ts';
import {Runtime,spikeRoot} from '../src/server/runtime.ts';
import {sha} from '../../../spikes/m0-5-tsx-runtime/src/shared.mjs';
const config=configuration(),runtime=new Runtime(config.dataRoot),id=`runtime-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID()}`,directory=join(appRoot,'evidence',id);
await mkdir(directory,{recursive:true});const checks:any[]=[],artifacts:Record<string,string>={};let failure:string|null=null;
const check=async(name:string,fn:()=>Promise<unknown>)=>{const detail=await fn();checks.push({name,status:'PASS',detail});console.log(JSON.stringify({name,status:'PASS'}));};
try{
  await check('frozen-source-and-image-identity',()=>runtime.check());
  await check('global-controller-lease',async()=>{const release=await runtime.globalLease();try{await assert.rejects(runtime.globalLease(),(e:any)=>e.code==='GLOBAL_BUSY');return {concurrentRejected:true};}finally{await release();}});
  await check('actual-compiler-rejects-unused-node-import',async()=>{const release=await runtime.globalLease();try{await assert.rejects(runtime.build({schemaVersion:'0.1',files:[{path:'src/App.tsx',content:"import type {Stats} from 'node:fs'; import React from 'react';export default function App(){return <p>rejected</p>}"}]},randomUUID(),new AbortController().signal),(e:any)=>e.status===422);return {realContainer:true};}finally{await release();}});
  await check('recover-only-owned-interrupted-container',async()=>{
    const jobId=randomUUID(),name=`m1-compiler-${randomUUID()}`,jobDirectory=join(config.dataRoot,'jobs',jobId),output=join(jobDirectory,'output'),logs=join(jobDirectory,'logs'),source=join(jobDirectory,'source.json');
    await mkdir(output,{recursive:true});await mkdir(logs,{recursive:true});await writeFile(source,'{}');
    const record={name,jobId,dataRoot:config.dataRoot};await writeFile(join(jobDirectory,'container.json'),JSON.stringify(record));
    const release=await runtime.globalLease();
    try{
      await runtime.compose(['run','-d','--no-deps','--pull','never','--name',name,'--label',`mini-atoms.m1.job=${jobId}`,'--label',`mini-atoms.m1.data=${sha(config.dataRoot)}`,'compiler','node','-e','setTimeout(()=>{},30000)'],undefined,{output,logs,source});
      await writeFile(join(jobDirectory,'container.json'),JSON.stringify({...record,dataRoot:'unrelated-project'}));
      await assert.rejects(runtime.recoverOwnedJobs([jobId]),(e:any)=>e.code==='RECOVERY_OWNER');
      assert.equal((await runtime.docker(['ps','-a','--filter',`name=^/${name}$`,'--format','{{.Names}}'])).stdout.trim(),name);
      await writeFile(join(jobDirectory,'container.json'),JSON.stringify(record));await runtime.recoverOwnedJobs([jobId]);
      assert.equal((await runtime.docker(['ps','-a','--filter',`name=^/${name}$`,'--format','{{.Names}}'])).stdout.trim(),'');return {actualContainerRemoved:true,incorrectOwnershipRejected:true};
    }finally{await runtime.docker(['container','rm','--force',name]).catch(()=>{});await release();}
  });
  const index=JSON.parse(await readFile(join(spikeRoot,'artifacts/fixture-index.json'),'utf8')),manifest=index['security-probe'];
  const published=join(config.dataRoot,'artifacts',manifest.versionId);try{await access(published);}catch{await cp(join(spikeRoot,'artifacts',manifest.versionId),published,{recursive:true,errorOnExist:true,force:false});}
  const rawPath=`/builds/${manifest.versionId}/index.html`,valid={'sec-fetch-dest':'iframe','sec-fetch-mode':'navigate','sec-fetch-site':'same-origin'};
  const native=(path:string,headers:Record<string,string>={},method='GET')=>new Promise<any>((done,reject)=>{const outgoing=request(config.origin+path,{method,headers},incoming=>{const chunks:Buffer[]=[];incoming.on('data',chunk=>chunks.push(chunk));incoming.once('end',()=>done({status:incoming.statusCode,headers:incoming.headers,bytes:Buffer.concat(chunks)}));});outgoing.once('error',reject);outgoing.end();});
  for(const [name,headers,expected] of [['absent',{},403],['document',{...valid,'sec-fetch-dest':'document'},403],['wrong-mode',{...valid,'sec-fetch-mode':'cors'},403],['cross-site',{...valid,'sec-fetch-site':'cross-site'},403],['valid-browser-context',valid,200]] as const)await check(`metadata-transport-${name}`,async()=>{const result=await native(rawPath,headers);assert.equal(result.status,expected);if(expected===200)assert.equal(sha(result.bytes),manifest.assets['index.html'].sha256);return {httpStatus:result.status,csp:result.headers['content-security-policy']};});
  for(const [name,path,method,expected] of [['query',rawPath+'?url=http://100.100.100.200','GET',400],['method',rawPath,'POST',405],['main-api','/api/projects','GET',401]] as const)await check(`transport-${name}`,async()=>{const result=await native(path,valid,method);assert.equal(result.status,expected);return {httpStatus:result.status};});
  process.env.PLAYWRIGHT_BROWSERS_PATH=resolve(spikeRoot,'../m0-preview-validation/node_modules/.cache/ms-playwright');
  const {chromium,expect}=await import('@playwright/test');
  const browser=await chromium.launch({channel:'chromium',headless:true,chromiumSandbox:true});
  try{for(const presentation of ['direct','embedded'])await check(`real-browser-security-${presentation}`,async()=>{
    const context=await browser.newContext({viewport:{width:1200,height:950},acceptDownloads:false,serviceWorkers:'block'}),page=await context.newPage(),logs:string[]=[];let downloads=0;
    page.on('console',m=>logs.push(m.text()));page.on('download',()=>downloads++);
    // This context only opens unauthenticated static preview; no API token is
    // present in its trace. Main workspace traces intentionally aren't saved.
    await context.tracing.start({screenshots:true,snapshots:true});
    try{
      const generated=page.waitForResponse(r=>r.url()===config.origin+rawPath);
      await page.goto(`${config.origin}/${presentation==='direct'?'preview':'harness'}/${manifest.versionId}`,{waitUntil:'networkidle'});
      const response=await generated,headers=await response.request().allHeaders();assert.equal(response.status(),200);assert.equal(headers['sec-fetch-mode'],'navigate');assert.equal(headers['sec-fetch-dest'],'iframe');assert.equal(headers['sec-fetch-site'],'same-origin');
      const target=presentation==='direct'?page.frameLocator('[data-testid="preview-frame"]'):page.frameLocator('[data-testid="shell-frame"]').frameLocator('[data-testid="preview-frame"]');
      await target.getByTestId('run-probe').click();await expect(target.getByTestId('probe-output')).not.toHaveText('');const observed=JSON.parse(await target.getByTestId('probe-output').innerText());
      for(const key of ['parentDOM','cookie','localStorage','fetch','metadata','aliyunMetadata','mainAPI','websocket','popup'])assert.equal(observed[key]?.allowed,false,key);
      assert(observed.violations.some((s:string)=>s.includes('connect-src:https://example.com/m05-beacon-marker')));assert(observed.violations.some((s:string)=>s.startsWith('img-src:')));assert(logs.some(s=>s.includes('Blocked form submission')));assert(logs.some(s=>s.includes('Download is disallowed')));assert.equal(downloads,0);
      const before=page.url();await target.getByTestId('top-nav').click({noWaitAfter:true});await page.waitForTimeout(400);assert.equal(page.url(),before);
      await target.getByTestId('self-nav').click({noWaitAfter:true});await page.waitForTimeout(400);assert.equal(page.url(),before);assert(logs.some(s=>s.includes('frame-src')&&s.includes('example.com')&&s.includes('has been blocked')));
      const raw=await context.newPage(),denied=await raw.goto(config.origin+rawPath);assert.equal(denied?.status(),403);assert.equal(await raw.locator('#root').count(),0);
      await page.screenshot({path:join(directory,`${presentation}.png`),fullPage:true});await raw.screenshot({path:join(directory,`${presentation}-raw-denied.png`)});await writeFile(join(directory,`${presentation}-security.json`),JSON.stringify({observed,logs,browserVersion:browser.version(),sandboxRequested:true,nativeMetadata:headers,networkInterceptionUsed:false},null,2));
      return {sourceSha256:manifest.sourceSha256,buildSha256:manifest.buildSha256,rawTopStatus:403,browserVersion:browser.version()};
    }finally{await context.tracing.stop({path:join(directory,`${presentation}-trace.zip`)});await context.close();}
  });}finally{await browser.close();}
}catch(error:any){failure=error.message;console.error(failure);}
const {readdir}=await import('node:fs/promises');for(const name of await readdir(directory))artifacts[name]=sha(await readFile(join(directory,name)));
const report={status:failure?'FAIL':'PASS',scope:'M1 adapter regression; original M0.5 compiler/preview/security fixture reused unchanged',runId:id,finishedAt:new Date().toISOString(),checks,error:failure,artifacts};await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2));await writeFile(join(appRoot,'evidence/latest-runtime.json'),JSON.stringify({status:report.status,report:`${id}/report.json`},null,2));console.log(JSON.stringify({status:report.status,checks:checks.length,report:`evidence/${id}/report.json`}));process.exitCode=failure?1:0;
