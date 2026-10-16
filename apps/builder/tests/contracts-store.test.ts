import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/server/store.ts';
import {specDraft,planDraft} from '../src/shared/contracts.ts';
import type {AppVersion,Specification,TestPlan} from '../src/shared/contracts.ts';
const requirements=[{id:'R1',text:'计数器',priority:'MUST' as const,verificationMode:'AUTOMATED' as const,acceptance:'点击后从0变1',targetHints:['counter-value','increment-button']}];
function documents(projectId:string){const spec:Specification={schemaVersion:'0.1',specId:randomUUID(),projectId,sourcePrompt:'做一个计数器',assumptions:[],requirements,unsupported:[],createdAt:new Date().toISOString()};const plan:TestPlan={schemaVersion:'0.1',id:randomUUID(),specId:spec.specId,tests:[],createdAt:spec.createdAt};return {spec,plan};}
test('需求与计划拒绝未知字段、重复ID、任意动作/目标，以及非自动需求测试',()=>{
  assert.throws(()=>specDraft({assumptions:[],requirements:[requirements[0],requirements[0]],unsupported:[]}));
  assert.throws(()=>specDraft({assumptions:[],requirements,unsupported:[],pass:true}));
  for(const step of [{action:'evaluate',target:'counter-value'},{action:'click',target:'body'},{action:'click',target:'increment-button',url:'https://example.com'},{action:'fill',target:'counter-value',value:'hardcoded'}])assert.throws(()=>planDraft([{requirementId:'R1',steps:[step]}],requirements));
  assert.throws(()=>planDraft([{requirementId:'R1',steps:[{action:'click',target:'increment-button'}]}],[{...requirements[0],verificationMode:'MANUAL'}]));
});
test('SQLite：所有权、事务、不可变版本、重启恢复与中断作业',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'mini-atoms-store-'));let store=new Store(directory);
  try{
    const p=store.createProject('owner-a','计数器'),{spec,plan}=documents(p.id);store.saveSpec(spec,plan);
    assert.throws(()=>store.project(p.id,'owner-b'));
    assert.throws(()=>store.spec(spec.specId,'owner-b'));
    assert.throws(()=>store.db.prepare('UPDATE specifications SET document=? WHERE id=?').run(JSON.stringify({...spec,sourcePrompt:'changed'}),spec.specId));
    assert.throws(()=>store.db.prepare('UPDATE test_plans SET document=? WHERE id=?').run('{}',plan.id));
    const version:AppVersion={id:randomUUID(),projectId:p.id,specId:spec.specId,parentVersionId:null,files:[{path:'src/App.tsx',content:'test source'}],sourceSha256:'a'.repeat(64),buildSha256:null,configSha256:'c'.repeat(64),runtimeConfigVersion:'frozen',runtimeVersionId:null,buildStatus:'PENDING',buildLogRef:null,createdAt:new Date().toISOString(),summary:'test'};
    store.saveVersion(version);assert.throws(()=>store.finishVersion({...version,files:[],buildStatus:'SUCCEEDED'}));
    store.finishVersion({...version,buildStatus:'SUCCEEDED',buildSha256:'b'.repeat(64),runtimeVersionId:'d'.repeat(64)});
    assert.throws(()=>store.finishVersion({...version,buildStatus:'FAILED'}));assert.throws(()=>store.version(version.id,'owner-b'));
    const job=store.newJob(p.id,spec.specId,'GENERATE',{},1);assert.throws(()=>store.newJob(p.id,spec.specId,'GENERATE',{},1));
    const interrupted={...version,id:randomUUID()};store.saveVersion(interrupted);store.close();store=new Store(directory);store.recover();
    assert.equal(store.job(job.id).state,'ERROR');assert.match(store.job(job.id).error!,/INTERRUPTED/);assert.equal(store.version(interrupted.id,'owner-a').buildStatus,'FAILED');assert.equal(store.version(version.id,'owner-a').buildStatus,'SUCCEEDED');assert.deepEqual(store.spec(spec.specId,'owner-a'),spec);
    const before=store.detail(p.id,'owner-a').specifications.length;assert.throws(()=>store.transaction(()=>{const d=documents(p.id);store.db.prepare('INSERT INTO specifications VALUES (?,?,?)').run(d.spec.specId,p.id,JSON.stringify(d.spec));throw new Error('rollback');}));assert.equal(store.detail(p.id,'owner-a').specifications.length,before);
  }finally{store.close();await rm(directory,{recursive:true,force:true});}
});
