// UI state regression only. Fixtures are not model output or generation evidence.
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {Store} from '../src/server/store.ts';
import {Runtime} from '../src/server/runtime.ts';
import {Provider} from '../src/server/provider.ts';
import {createApp} from '../src/server/app.ts';
import type {Specification,AppVersion} from '../src/shared/contracts.ts';

const appRoot=resolve(import.meta.dirname,'..'),temporaryRoot=join(appRoot,'.local/delivery-p0-a'),root=await mkdtemp(join(temporaryRoot,'ui-')),store=new Store(root),runtime=new Runtime(root);
runtime.lock=JSON.parse(await readFile(join(appRoot,'runtime.lock.json'),'utf8'));
const config={port:18134,origin:'http://127.0.0.1:18134',token:randomUUID()+randomUUID(),maxDaily:20,dataRoot:root,provider:{baseUrl:'',model:'',apiKey:'',timeoutMs:100}};
const owner=createHash('sha256').update(config.token).digest('hex'),project=store.createProject(owner,'Delivery UI state fixture'),time=new Date().toISOString();
const spec=(title:string):Specification=>({schemaVersion:'0.1',projectId:project.id,specId:randomUUID(),sourcePrompt:title,assumptions:[],unsupported:[],requirements:[{id:'R1',text:title,priority:'MUST',verificationMode:'AUTOMATED',acceptance:'显示当前数字',targetHints:['counter-value']}],createdAt:time});
const older=spec('旧需求'),newer=spec('新需求：计数器加一或减一');store.saveSpec(older);
const version=(s:Specification):AppVersion=>({id:randomUUID(),projectId:project.id,specId:s.specId,parentVersionId:null,files:[{path:'src/App.tsx',content:"import React from 'react'; export default function App(){return <div data-testid=\"counter-value\">0</div>}"}],sourceSha256:'a'.repeat(64),buildSha256:'b'.repeat(64),configSha256:runtime.lock.configSha256,runtimeConfigVersion:runtime.lock.policyVersion,runtimeVersionId:'c'.repeat(64),buildStatus:'SUCCEEDED',buildLogRef:null,createdAt:time,summary:'UI fixture only; not compiled or LLM-generated'});
const oldVersion=version(older);store.saveVersion(oldVersion);const pendingSpec=store.newJob(project.id,null,'SPECIFY',{},20);store.updateJob(pendingSpec.id,'RUNNING','SPECIFYING');
const app=createApp(config,store,runtime,new Provider(config.provider));await new Promise<void>(done=>app.server.listen(config.port,'127.0.0.1',done));
process.env.PLAYWRIGHT_BROWSERS_PATH=resolve(appRoot,'../../spikes/m0-preview-validation/node_modules/.cache/ms-playwright');const {chromium,expect}=await import('@playwright/test');const browser=await chromium.launch({channel:'chromium',headless:true,chromiumSandbox:true}),page=await browser.newPage();const checks:string[]=[];
try{
 await page.goto(config.origin);await page.locator('#access').fill(config.token);await page.getByRole('button',{name:'进入工作台'}).click();await expect(page.getByLabel('R1 需求',{exact:true})).toHaveValue('旧需求');
 store.saveSpec(newer);store.updateJob(pendingSpec.id,'COMPLETED','SPEC_READY',{specId:newer.specId});
 if(process.argv.includes('--expect-old-defect')){await page.waitForTimeout(2500);await expect(page.getByLabel('R1 需求',{exact:true})).toHaveValue('旧需求');checks.push('REPRODUCED: completed new Spec is hidden by restored old AppVersion');}
 else{
  await expect(page.getByLabel('R1 需求',{exact:true})).toHaveValue(newer.requirements[0].text,{timeout:10000});checks.push('Completed SPECIFY selects the new immutable Spec while retaining the prior Preview');
  const generated=store.newJob(project.id,newer.specId,'GENERATE',{planVerification:false},20);store.updateJob(generated.id,'RUNNING','GENERATING');await page.reload();await expect(page.getByLabel('应用版本')).toHaveValue(oldVersion.id);
  const newVersion=version(newer);store.saveVersion(newVersion);store.updateJob(generated.id,'COMPLETED','PREVIEW_READY',{versionId:newVersion.id});await expect(page.getByLabel('应用版本')).toHaveValue(newVersion.id,{timeout:10000});await expect(page.getByLabel('R1 需求',{exact:true})).toHaveValue(newer.requirements[0].text);checks.push('Completed GENERATE selects its new AppVersion and matching Spec');
  await page.getByLabel('应用版本').selectOption(oldVersion.id);await expect(page.getByLabel('R1 需求',{exact:true})).toHaveValue(older.requirements[0].text);await page.reload();await expect(page.getByLabel('应用版本')).toHaveValue(oldVersion.id);checks.push('Explicit historical version selection and reload still restore the chosen immutable version');
 }
 const result={status:'PASS_UI_STATE_REGRESSION_ONLY',mode:process.argv.includes('--expect-old-defect')?'BEFORE_FIX_REPRODUCTION':'AFTER_FIX',browser:browser.version(),realApi:true,isolatedSqlite:true,providerConfigured:false,realLlmCalls:0,generationE2ePassed:false,checks};await writeFile(process.env.DELIVERY_UI_REPORT||join(temporaryRoot,result.mode==='AFTER_FIX'?'ui-after.json':'ui-before.json'),JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify(result));
}finally{await browser.close();await app.orchestrator.close();app.server.closeAllConnections();await new Promise<void>(done=>app.server.close(()=>done()));store.close();assert(resolve(root).startsWith(resolve(temporaryRoot)+sep));await rm(root,{recursive:true,force:true});}
