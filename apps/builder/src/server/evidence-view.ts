// Presentation only. Does not write data, issue authorization or run a validator.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Store} from './store.ts';
import {appRoot} from './config.ts';
import type {VerificationRun} from '../shared/verification.ts';
import type {EvidenceView} from '../shared/evidence-view.ts';
import {canonicalBytes} from '../shared/protocol-v11.mjs';
const sha=(x:string|Buffer)=>createHash('sha256').update(x).digest('hex'),same=(a:unknown,b:unknown)=>canonicalBytes(a)===canonicalBytes(b);
const registry=JSON.parse(readFileSync(new URL('./evidence-origins.json',import.meta.url),'utf8'));
function origin(store:Store,version:any,spec:any,plan:any,record:any,jobId:string|null):EvidenceView['origin']{
 const unknown={kind:'UNKNOWN_ORIGIN' as const,explanation:'记录未提供可核验的计划来源证明。'};
 if(!plan||record&&(!record.authorization||record.authorizationState!=='ALLOW'))return unknown;
 if(jobId){
  const rows=store.db.prepare('SELECT s.id,r.document FROM model_call_slots s JOIN model_call_results r ON s.id=r.slot_id WHERE s.job_id=? ORDER BY s.attempt DESC').all(jobId) as any[];
  for(const row of rows){try{const d=JSON.parse(row.document),r=d.receipt,input=d.request?.input,inv=input?.locatorInventory||input?.targetInventory;if(d.error||!r||r.provider!=='https://api.deepseek.com'||r.httpStatus!==200||r.finishReason!=='stop'||!r.requestId||r.bodyComplete===false||typeof d.rawContent!=='string'||!d.rawContent||!same(JSON.parse(d.rawContent),d.output)||sha(d.rawContent)!==d.rawSha256||!same(input?.specification,spec)||!inv||inv.appVersionId!==version.id||inv.sourceSha256!==version.sourceSha256||inv.buildSha256!==version.buildSha256||inv.configSha256!==version.configSha256)continue;if(record?!same(d.output,record.proposal):!same(d.output?.tests,plan.tests))continue;return {kind:'REAL_LLM_PLAN',explanation:'完整真实 Provider 内容、不可变计划及当前版本绑定相符；执行结果另见 Run。',proofId:row.id,proofSha256:d.rawSha256,providerRequestId:r.requestId};}catch{/* Unknown is safer than guessing. */}}
 }
 const entry=registry.entries.find((x:any)=>x.planId===(record?.id||plan.id)&&x.versionId===version.id);
 if(entry)try{const document=record?store.db.prepare('SELECT document FROM v11_plan_records WHERE id=?').get(record.id):store.db.prepare('SELECT document FROM version_test_plans WHERE id=?').get(plan.id);if(!document||sha((document as any).document)!==entry.recordSha256)return unknown;const bytes=readFileSync(join(appRoot,entry.auditFile)),audit=JSON.parse(bytes.toString()),snapshot=entry.auditPointer.split('.').reduce((v:any,k:string)=>v?.[k],audit);if(sha(bytes)!==entry.auditSha256||sha(readFileSync(join(appRoot,entry.producer)))!==entry.producerSha256||!same(snapshot,record||plan))return unknown;return {kind:'CONTROLLED_TEST_PLAN',explanation:'受控验收计划；已审阅生产脚本、原审计摘要与不可变计划逐项对应。不能代替真实模型 v1.1 Planner 正例。',proofId:entry.planId,proofSha256:entry.auditSha256};}catch{}
 return unknown;
}
export function evidenceView(store:Store,owner:string,versionId:string,run?:VerificationRun):EvidenceView {
 const version=store.version(versionId,owner),spec=store.spec(version.specId,owner),protocol=run?.testProtocolVersion||store.protocolSelection(versionId),planning=store.planning(version,spec);
 let record:any=null,plan:any=null,coverage:any[]=[],jobId:string|null=null,planState='NOT_STARTED',valid=true,missingReason:string|null=null;
 if(protocol==='1.1'){record=store.v11Record(versionId,run?.testPlanId);plan=record?.proposal;coverage=record?.coverage||[];jobId=record?.jobId||null;planState=plan?(record.authorizationState==='ALLOW'?'PARTIAL':record.authorizationState):record?'UNAVAILABLE':'NOT_STARTED';if(run){const b=store.v11RunBinding(run.id),a=record?.authorization,storedAuth=a?store.db.prepare('SELECT document FROM v11_authorizations WHERE id=?').get(a.authorizationId) as any:null;valid=Boolean(record&&a&&storedAuth&&same(JSON.parse(storedAuth.document),a)&&a.specId===spec.specId&&a.appVersionId===version.id&&a.sourceSha256===version.sourceSha256&&a.buildSha256===version.buildSha256&&a.configSha256===version.configSha256&&record.id===run.testPlanId&&b?.testPlanId===run.testPlanId&&b.authorizationId===run.authorizationId&&b.authorizationHash===run.authorizationHash&&record.authorization.authorizationId===run.authorizationId&&record.authorization.canonicalAuthorizationHash===run.authorizationHash);}}
 else{
  const row=run?store.db.prepare("SELECT document,job_id FROM planning_attempts WHERE version_id=? AND json_extract(document,'$.testPlanId')=? ORDER BY rowid DESC LIMIT 1").get(versionId,run.testPlanId) as any:null,p=row?JSON.parse(row.document):planning;
  plan=p.testPlan;coverage=p.coverage||[];jobId=row?.job_id||p.jobId||null;planState=p.state;
  if(run){const stored=store.db.prepare('SELECT * FROM version_test_plans WHERE id=?').get(run.testPlanId) as any,b=store.db.prepare('SELECT * FROM verification_bindings WHERE run_id=?').get(run.id) as any;valid=Boolean(plan&&stored?.version_id===versionId&&stored.spec_id===spec.specId&&same(JSON.parse(stored.document),plan)&&b?.version_id===versionId&&b.spec_id===spec.specId&&b.plan_id===run.testPlanId);}
 }
 if(run&&(run.appVersionId!==version.id||run.projectId!==version.projectId||run.specId!==spec.specId||run.sourceSha256!==version.sourceSha256||run.buildSha256!==version.buildSha256||run.configSha256!==version.configSha256))valid=false;
 if(!valid)missingReason='历史计划或版本身份不匹配；不能关联步骤、来源或授权。';
 const accepted=store.db.prepare('SELECT created_at FROM human_acceptances WHERE version_id=? AND owner_id=?').get(versionId,owner) as any;
 const tests=valid&&plan?.tests||[],expanded=record?.expandedCost??(plan?tests.reduce((n:number,t:any)=>n+t.steps.length,0):null);
 return {schemaVersion:'M2-C-1',identityValid:valid,missingReason,projectId:version.projectId,specId:spec.specId,versionId,planId:valid&&plan?(record?.id||plan?.id||null):null,protocol,planState,origin:valid?origin(store,version,spec,plan,record,jobId):{kind:'UNKNOWN_ORIGIN',explanation:missingReason!},expandedSteps:valid?expanded:null,humanAcceptance:{accepted:Boolean(accepted),createdAt:accepted?.created_at||null},authorization:valid&&record?.authorization?{id:record.authorization.authorizationId,hash:record.authorization.canonicalAuthorizationHash,decision:record.authorizationState,policyVersion:record.authorization.policyVersion}:null,requirements:spec.requirements.map(requirement=>{const test=tests.find((t:any)=>t.requirementId===requirement.id),c=coverage.find((x:any)=>x.requirementId===requirement.id),setup=test?.setupRef?plan.setupBundles.find((s:any)=>s.id===test.setupRef):null;return {requirement,coverage:test?'PLANNED':planState==='NOT_STARTED'?'NOT_STARTED':'UNVERIFIED',reason:test?'BOUND_TEST':c?.reason||'NOT_COVERED',explanation:test?'有绑定测试；覆盖并不代表测试或完整验收通过。':c?.explanation||'记录未提供覆盖说明。',steps:test?.steps||[],setup:setup?{id:setup.id,sourceRequirementId:setup.sourceRequirementId,steps:setup.steps}:null};})};
}
export function evidenceDemos(store:Store,owner:string){return registry.demos.flatMap((d:any)=>{try{const run=store.runRecord(d.runId,owner);if(run.appVersionId!==d.versionId||run.projectId!==d.projectId)return [];return [d];}catch{return [];}});}
