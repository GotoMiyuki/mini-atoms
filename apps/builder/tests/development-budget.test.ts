import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/server/store.ts';
import type {DevelopmentBudget} from '../src/server/development-budget.ts';
import {developmentOrigin} from '../src/server/development-budget.ts';
test('local acceptance budget is scoped, expires, counts corrections, persists cap, and leaves ordinary quota enforced',()=>{
  const root=mkdtempSync(join(tmpdir(),'m11-budget-'));let store=new Store(root);
  try{
    const project=store.createProject('owner','budget'),day=new Date().toISOString().slice(0,10),scope={projectId:project.id,specId:null,task:'SPECIFY' as const,versionId:null},budget:DevelopmentBudget={id:`m1.1-completion-${day}`,utcDay:day,limit:6,scopes:[scope]};
    for(let i=0;i<20;i++){const job=store.newJob(project.id,null,'SPECIFY',{},20);store.updateJob(job.id,'COMPLETED','SPEC_READY');}
    assert.throws(()=>store.newJob(project.id,null,'SPECIFY',{},20),{code:'QUOTA'});store.close();store=new Store(root,budget);
    assert.throws(()=>store.newJob(project.id,null,'GENERATE',{},20),{code:'DEVELOPMENT_BUDGET'});
    const jobs:ReturnType<Store['job']>[]=[];for(let i=0;i<3;i++){const job=store.newJob(project.id,null,'SPECIFY',{},20);jobs.push(job);assert.equal(store.callSlot(job.id,1,20),store.callSlot(job.id,1,20));const slot=store.callSlot(job.id,2,20);store.recordCall(slot,{receipt:{test:true}});assert.throws(()=>store.recordCall(slot,{}));store.updateJob(job.id,'COMPLETED','SPEC_READY');}
    assert.equal(store.quota(20).used,26);assert.equal(store.quota(20).remaining,0);assert.throws(()=>store.newJob(project.id,null,'SPECIFY',{},20),{code:'QUOTA'});
    assert.throws(()=>store.callSlot(jobs[0].id,3,20),{code:'QUOTA'});
    store.close();store=new Store(root,budget);assert.throws(()=>store.newJob(project.id,null,'SPECIFY',{},20),{code:'QUOTA'});
    store.close();store=new Store(root);assert.throws(()=>store.newJob(project.id,null,'SPECIFY',{developmentBudget:budget},20),{code:'QUOTA'});assert.throws(()=>store.callSlot(jobs[0].id,1,20),{code:'DEVELOPMENT_BUDGET'});
    store.close();store=new Store(root,{...budget,utcDay:'2000-01-01'});assert.throws(()=>store.newJob(project.id,null,'SPECIFY',{},20),{code:'DEVELOPMENT_BUDGET'});
  }finally{store.close();assert(root.startsWith(join(tmpdir(),'m11-budget-')));rmSync(root,{recursive:true});}
});
test('M2-B optional local budget is exactly four PLAN calls on three frozen versions, with current-day scope; unavailable from HTTP/env',()=>{const day=new Date().toISOString().slice(0,10),scope={projectId:'owned-project',specId:'frozen-spec',task:'PLAN' as const,versionId:'8445f9d9-2744-4705-a1fd-19896bbcb279'},budget:DevelopmentBudget={id:`m2-b-${day}`,utcDay:day,limit:4,scopes:[scope]};assert.match(developmentOrigin(budget,scope),/^DEV_ACCEPTANCE:m2-b-/);for(const changed of [{...scope,task:'GENERATE' as const},{...scope,versionId:'other-version'},{...scope,projectId:'foreign'},{...scope,specId:'other-spec'}])assert.throws(()=>developmentOrigin(budget,changed));assert.throws(()=>developmentOrigin({...budget,limit:6},scope));assert.throws(()=>developmentOrigin({...budget,utcDay:'2000-01-01'},scope));});
