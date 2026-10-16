import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AppError,specDraft,planDraft} from '../shared/contracts.ts';
import type {AppVersion,Job,Specification,TestPlan,PlanningSummary,RequirementCoverage,CoverageReason} from '../shared/contracts.ts';
import {developmentOrigin} from './development-budget.ts';
import type {DevelopmentBudget} from './development-budget.ts';
import {verificationLimits} from '../shared/verification.ts';
import type {VerificationRun,RequirementResult,EvidenceRecord} from '../shared/verification.ts';
import {verifyAuthorization} from './policy-v11.ts';
import type {AuditV11} from './policy-v11.ts';
export function uncovered(spec:Specification,reason:CoverageReason='NOT_EXECUTED',explanation='尚未规划或执行浏览器验证'):RequirementCoverage[]{return spec.requirements.map(r=>({requirementId:r.id,status:'UNVERIFIED',reason:r.verificationMode==='MANUAL'?'MANUAL_REVIEW_REQUIRED':r.verificationMode==='UNSUPPORTED'?'UNSUPPORTED_ACTION':reason,explanation:r.verificationMode==='AUTOMATED'?explanation:'需求保留原验证方式，尚无浏览器执行证据'}));}
export class Store {
  db:DatabaseSync;
  migration:{from:number;to:number;backup:string|null};
  developmentBudget:DevelopmentBudget|undefined;
  constructor(directory:string,developmentBudget?:DevelopmentBudget){
    this.developmentBudget=developmentBudget;
    mkdirSync(directory,{recursive:true});this.db=new DatabaseSync(join(directory,'builder.sqlite'));
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    const from=(this.db.prepare('PRAGMA user_version').get() as any).user_version;let backup:string|null=null;
    if(from>4)throw new AppError('DB_VERSION','数据库版本比当前应用新；未修改数据',503);
    if(from===0)this.db.exec(readFileSync(new URL('../../migrations/001-initial.sql',import.meta.url),'utf8'));
    if(from<2){
      if(from===1){backup=join(directory,`builder.pre-m1-1-${randomUUID()}.sqlite`);this.db.exec("VACUUM INTO '"+backup.replaceAll("'","''")+"'");}
      try{this.db.exec(readFileSync(new URL('../../migrations/002-planning-lifecycle.sql',import.meta.url),'utf8'));}catch(error){try{this.db.exec('ROLLBACK');}catch{}this.db.close();throw error;}
    }
    if(from<3){if(from===2){backup=join(directory,`builder.pre-m2-a-${randomUUID()}.sqlite`);this.db.exec("VACUUM INTO '"+backup.replaceAll("'","''")+"'");}try{this.db.exec(readFileSync(new URL('../../migrations/003-verification-integration.sql',import.meta.url),'utf8'));}catch(error){try{this.db.exec('ROLLBACK');}catch{}this.db.close();throw error;}}
    if(from<4){if(from===3){backup=join(directory,`builder.pre-m2-b-${randomUUID()}.sqlite`);this.db.exec("VACUUM INTO '"+backup.replaceAll("'","''")+"'");}try{this.db.exec(readFileSync(new URL('../../migrations/004-protocol-v11.sql',import.meta.url),'utf8'));}catch(error){try{this.db.exec('ROLLBACK');}catch{}this.db.close();throw error;}}
    this.migration={from,to:4,backup};
    const external=join(directory,'external-model-calls.json');
    if(existsSync(external))for(const item of JSON.parse(readFileSync(external,'utf8'))){
      if(typeof item.id!=='string'||item.id.length>128||!/^\d{4}-\d\d-\d\dT/.test(item.createdAt))throw new AppError('CALL_AUDIT','外部实验调用账本格式无效',503);
      const id='external:'+item.id;this.db.prepare('INSERT OR IGNORE INTO model_call_slots VALUES (?,NULL,1,?,?)').run(id,item.createdAt,String(item.origin||'Recorded external experiment'));
      this.db.prepare('INSERT OR IGNORE INTO model_call_results VALUES (?,?)').run(id,JSON.stringify({receipt:item.receipt||null,origin:item.origin,imported:true}));
    }
  }
  transaction<T>(action:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const result=action();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  project(id:string,owner:string){const row=this.db.prepare('SELECT * FROM projects WHERE id=? AND owner_id=?').get(id,owner);if(!row)throw new AppError('NOT_FOUND','项目不存在',404);return row;}
  projects(owner:string){return this.db.prepare('SELECT id,name,created_at AS createdAt FROM projects WHERE owner_id=? ORDER BY created_at DESC').all(owner);}
  createProject(owner:string,name:string){if(this.projects(owner).length>=50)throw new AppError('LIMIT','最多保存 50 个项目',429);const p={id:randomUUID(),name,createdAt:new Date().toISOString()};this.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(p.id,owner,p.name,p.createdAt);return p;}
  spec(id:string,owner:string):Specification{const row=this.db.prepare('SELECT s.document FROM specifications s JOIN projects p ON p.id=s.project_id WHERE s.id=? AND p.owner_id=?').get(id,owner) as any;if(!row)throw new AppError('NOT_FOUND','需求版本不存在',404);return JSON.parse(row.document);}
  plan(specId:string):TestPlan|null{const row=this.db.prepare('SELECT document FROM test_plans WHERE spec_id=?').get(specId) as any;return row?JSON.parse(row.document):null;}
  saveSpec(spec:Specification,plan?:TestPlan|null,provenance?:{sourceJobId:string;rawSha256:string}){
    specDraft({assumptions:spec.assumptions,requirements:spec.requirements,unsupported:spec.unsupported});
    if(plan){if(plan.specId!==spec.specId)throw new AppError('PLAN_IDENTITY','计划需求身份不符');planDraft(plan.tests,spec.requirements);}
    this.transaction(()=>{this.db.prepare('INSERT INTO specifications VALUES (?,?,?)').run(spec.specId,spec.projectId,JSON.stringify(spec));if(plan)this.db.prepare('INSERT INTO test_plans VALUES (?,?,?)').run(plan.id,spec.specId,JSON.stringify(plan));if(provenance)this.db.prepare('INSERT INTO spec_provenance VALUES (?,?,?)').run(spec.specId,provenance.sourceJobId,JSON.stringify(provenance));});
  }
  recoveredSpec(jobId:string,owner:string):Specification|null{const row=this.db.prepare('SELECT spec_id FROM spec_provenance WHERE source_job_id=? ORDER BY rowid LIMIT 1').get(jobId) as any;return row?this.spec(row.spec_id,owner):null;}
  version(id:string,owner:string):AppVersion{const row=this.db.prepare('SELECT v.document FROM app_versions v JOIN projects p ON p.id=v.project_id WHERE v.id=? AND p.owner_id=?').get(id,owner) as any;if(!row)throw new AppError('NOT_FOUND','应用版本不存在',404);return JSON.parse(row.document);}
  saveVersion(v:AppVersion){this.db.prepare('INSERT INTO app_versions VALUES (?,?,?,?,?)').run(v.id,v.projectId,v.specId,v.parentVersionId,JSON.stringify(v));}
  finishVersion(v:AppVersion){this.db.prepare('UPDATE app_versions SET document=? WHERE id=?').run(JSON.stringify(v),v.id);}
  job(id:string,owner?:string):Job{const row=owner?this.db.prepare('SELECT j.* FROM job_records j JOIN projects p ON p.id=j.project_id WHERE j.id=? AND p.owner_id=?').get(id,owner):this.db.prepare('SELECT * FROM job_records WHERE id=?').get(id);if(!row)throw new AppError('NOT_FOUND','任务不存在',404);const r=row as any,context=this.db.prepare('SELECT task FROM job_context WHERE job_id=?').get(id) as any,outcome=this.db.prepare('SELECT document FROM job_outcomes WHERE job_id=?').get(id) as any;return {id:r.id,projectId:r.project_id,specId:r.spec_id,versionId:r.version_id,kind:r.kind,...(context?{task:this.db.prepare('SELECT run_id FROM verification_jobs WHERE job_id=?').get(id)?'VERIFY':context.task}:{}),...(outcome?JSON.parse(outcome.document):{}),state:r.state,phase:r.phase,error:r.error,createdAt:r.created_at,finishedAt:r.finished_at};}
  quota(maxDaily:number){const day=new Date().toISOString().slice(0,10),used=(this.db.prepare('SELECT count(*) AS n FROM model_call_slots WHERE created_at>=?').get(day) as any).n;return {utcDay:day,used,remaining:Math.max(0,maxDaily-used),limit:maxDaily};}
  developmentSlot(scope:{projectId:string;specId:string|null;task:NonNullable<Job['task']>;versionId:string|null}){
    const origin=developmentOrigin(this.developmentBudget!,scope),used=(this.db.prepare('SELECT count(*) AS n FROM model_call_slots WHERE origin=?').get(origin) as any).n;
    if(used>=this.developmentBudget!.limit)throw new AppError('QUOTA',`本轮开发验收最多 ${this.developmentBudget!.limit} 次模型调用（含纠正）`,429);
    return origin;
  }
  newJob(projectId:string,specId:string|null,kind:Job['kind'],payload:unknown,maxDaily:number,task:NonNullable<Job['task']>=kind,versionId:string|null=null){
    if(task==='VERIFY')throw new AppError('INVALID_TASK','浏览器验证必须经独立的非模型预算入口');
    return this.transaction(()=>{
      const queued=(this.db.prepare("SELECT count(*) AS n FROM job_records WHERE state IN ('QUEUED','RUNNING')").get() as any).n;
      const origin=this.developmentBudget?this.developmentSlot({projectId,specId,task,versionId}):'M1.1 queued model task';
      if((!this.developmentBudget&&this.quota(maxDaily).remaining===0)||queued>=8)throw new AppError('QUOTA','每日模型调用额度或队列上限已达到',429);
      if((this.db.prepare('SELECT count(*) AS n FROM app_versions').get() as any).n>=100)throw new AppError('STORAGE_QUOTA','版本存储额度已达到',429);
      const id=randomUUID(),now=new Date().toISOString();this.db.prepare('INSERT INTO job_records VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,projectId,specId,versionId,kind,'QUEUED','QUEUED',JSON.stringify(payload),null,now,null);
      this.db.prepare('INSERT INTO job_context VALUES (?,?)').run(id,task);this.db.prepare('INSERT INTO model_call_slots VALUES (?,?,?,?,?)').run(randomUUID(),id,1,now,origin);return this.job(id);
    });
  }
  callSlot(jobId:string,attempt:number,maxDaily:number):string{return this.transaction(()=>{
    const existing=this.db.prepare('SELECT id,origin FROM model_call_slots WHERE job_id=? AND attempt=?').get(jobId,attempt) as any;
    const first=this.db.prepare('SELECT origin FROM model_call_slots WHERE job_id=? AND attempt=1').get(jobId) as any;
    if(this.developmentBudget){const job=this.job(jobId),origin=developmentOrigin(this.developmentBudget,{projectId:job.projectId,specId:job.specId,task:job.task!,versionId:job.versionId});if(first?.origin!==origin)throw new AppError('DEVELOPMENT_BUDGET','不得以开发预算重试普通历史任务',403);}
    else if(first?.origin.startsWith('DEV_ACCEPTANCE:'))throw new AppError('DEVELOPMENT_BUDGET','开发验收任务只能由本机验收控制器执行',403);
    if(existing)return existing.id;
    if(attempt!==2||(!this.developmentBudget&&this.quota(maxDaily).remaining===0))throw new AppError('QUOTA','模型纠正调用额度已耗尽',429);
    const job=this.job(jobId),origin=this.developmentBudget?this.developmentSlot({projectId:job.projectId,specId:job.specId,task:job.task!,versionId:job.versionId}):'M1.1 one contract correction',id=randomUUID();
    this.db.prepare('INSERT INTO model_call_slots VALUES (?,?,?,?,?)').run(id,jobId,attempt,new Date().toISOString(),origin);return id;
  });}
  recordCall(slot:string,document:unknown){this.db.prepare('INSERT INTO model_call_results VALUES (?,?)').run(slot,JSON.stringify(document));}
  outcome(jobId:string,document:{warnings?:string[];diagnosticRef?:string}){this.db.prepare('INSERT OR IGNORE INTO job_outcomes VALUES (?,?)').run(jobId,JSON.stringify(document));}
  updateJob(id:string,state:Job['state'],phase:string,fields:{specId?:string;versionId?:string;error?:string}={}){const old=this.job(id);this.db.prepare('UPDATE job_records SET state=?,phase=?,spec_id=?,version_id=?,error=?,finished_at=? WHERE id=?').run(state,phase,fields.specId??old.specId,fields.versionId??old.versionId,fields.error??old.error,['COMPLETED','ERROR','CANCELLED'].includes(state)?new Date().toISOString():null,id);}
  planning(v:AppVersion,spec:Specification):PlanningSummary{
    const row=this.db.prepare('SELECT document FROM planning_attempts WHERE version_id=? ORDER BY rowid DESC LIMIT 1').get(v.id) as any;
    const active=this.db.prepare("SELECT j.id FROM job_records j JOIN job_context c ON c.job_id=j.id WHERE j.version_id=? AND c.task='PLAN' AND coalesce(json_extract(j.payload,'$.protocolVersion'),'0.1')='0.1' AND j.state IN ('QUEUED','RUNNING') ORDER BY j.rowid DESC LIMIT 1").get(v.id) as any;
    const base:PlanningSummary={state:'NOT_STARTED',specId:spec.specId,appVersionId:v.id,sourceSha256:v.sourceSha256,buildSha256:v.buildSha256,configSha256:v.configSha256,testPlanId:null,testPlan:null,coverage:uncovered(spec),verificationStatus:'UNVERIFIED'};
    return active?{...base,state:'PLANNING',jobId:active.id}:row?{...JSON.parse(row.document),verificationStatus:'UNVERIFIED'}:base;
  }
  savePlanning(v:AppVersion,spec:Specification,summary:PlanningSummary,jobId:string|null){
    const saved=this.db.prepare('SELECT document FROM app_versions WHERE id=?').get(v.id) as any,stored=saved?JSON.parse(saved.document):null;
    if(!stored||JSON.stringify(stored)!==JSON.stringify(v)||v.buildStatus!=='SUCCEEDED'||v.specId!==spec.specId||v.projectId!==spec.projectId||summary.appVersionId!==v.id||summary.specId!==spec.specId||summary.sourceSha256!==v.sourceSha256||summary.buildSha256!==v.buildSha256||summary.configSha256!==v.configSha256||summary.verificationStatus!=='UNVERIFIED')throw new AppError('PLAN_IDENTITY','规划身份必须绑定成功的不可变版本');
    if(summary.coverage.length!==spec.requirements.length||new Set(summary.coverage.map(c=>c.requirementId)).size!==spec.requirements.length||summary.coverage.some(c=>!spec.requirements.some(r=>r.id===c.requirementId)||!['PLANNED','UNVERIFIED'].includes(c.status)))throw new AppError('PLAN_COVERAGE','覆盖记录必须完整且不能包含测试结果');
    if(summary.testPlan){
      if(summary.testPlan.schemaVersion!=='0.1'||summary.testPlan.specId!==spec.specId||summary.testPlanId!==summary.testPlan.id||!summary.testPlan.tests.length)throw new AppError('PLAN_IDENTITY','不能用空计划伪装成功');planDraft(summary.testPlan.tests,spec.requirements);
      const planned=summary.testPlan.tests.map(t=>t.requirementId);
      if(summary.state!==(planned.length===spec.requirements.length?'VALID':'PARTIAL')||summary.coverage.some(c=>(c.status==='PLANNED')!==planned.includes(c.requirementId)||c.status==='PLANNED'&&c.reason!=='NOT_EXECUTED'))throw new AppError('PLAN_COVERAGE','规划状态必须与完整覆盖记录一致');
    }else if(summary.testPlanId||summary.state!=='UNAVAILABLE'||summary.coverage.some(c=>c.status!=='UNVERIFIED'))throw new AppError('PLAN_IDENTITY','不可用规划不得伪造 TestPlan 引用或已规划覆盖');
    this.transaction(()=>{if(summary.testPlan)this.db.prepare('INSERT INTO version_test_plans VALUES (?,?,?,?)').run(summary.testPlan.id,spec.specId,v.id,JSON.stringify(summary.testPlan));this.db.prepare('INSERT INTO planning_attempts VALUES (?,?,?,?,?)').run(randomUUID(),v.id,spec.specId,jobId,JSON.stringify({...summary,jobId}));});
  }
  planningJob(versionId:string):Job|null{const row=this.db.prepare("SELECT j.id FROM job_records j JOIN job_context c ON c.job_id=j.id WHERE j.version_id=? AND c.task='PLAN' AND coalesce(json_extract(j.payload,'$.protocolVersion'),'0.1')='0.1' ORDER BY j.rowid DESC LIMIT 1").get(versionId) as any;return row?this.job(row.id):null;}
  protocolSelection(versionId:string){return (this.db.prepare('SELECT protocol_version FROM verification_protocol_selections WHERE version_id=? ORDER BY rowid DESC LIMIT 1').get(versionId) as any)?.protocol_version||'0.1';}
  selectProtocol(versionId:string,protocol:'0.1'|'1.1',jobId:string|null){this.db.prepare('INSERT INTO verification_protocol_selections VALUES (?,?,?,?)').run(randomUUID(),versionId,protocol,jobId);}
  v11Record(versionId:string,planId?:string){const row=(planId?this.db.prepare('SELECT document FROM v11_plan_records WHERE version_id=? AND id=?').get(versionId,planId):this.db.prepare('SELECT document FROM v11_plan_records WHERE version_id=? ORDER BY rowid DESC LIMIT 1').get(versionId)) as any;return row?JSON.parse(row.document):null;}
  saveV11(v:AppVersion,spec:Specification,planId:string,audit:AuditV11,jobId:string|null,raw:unknown){
    const saved=this.db.prepare('SELECT document FROM app_versions WHERE id=?').get(v.id) as any;if(!saved||saved.document!==JSON.stringify(v)||v.specId!==spec.specId||v.projectId!==spec.projectId||v.buildStatus!=='SUCCEEDED')throw new AppError('IDENTITY_MISMATCH','提案只能绑定真实成功版本');
    if(audit.authorization){verifyAuthorization(audit.authorization,audit.inventory);if(audit.decision!=='ALLOW'||audit.authorization.testPlanId!==planId||audit.authorization.appVersionId!==v.id||audit.authorization.specId!==spec.specId)throw new AppError('IDENTITY_MISMATCH','授权绑定不符');}
    const record={id:planId,protocolVersion:'1.1',createdAt:new Date().toISOString(),jobId,appVersionId:v.id,specId:spec.specId,proposal:audit.proposal,raw,contractState:audit.proposal?'CONTRACT_VALID':'INVALID',authorizationState:audit.decision,authorization:audit.authorization,inventory:audit.inventory,diagnostics:audit.diagnostics,expandedCost:audit.expandedCost,coverage:audit.coverage};
    this.transaction(()=>{this.db.prepare('INSERT INTO v11_plan_records VALUES (?,?,?,?,?)').run(planId,v.id,spec.specId,jobId,JSON.stringify(record));this.db.prepare('INSERT INTO v11_inventories VALUES (?,?)').run(planId,JSON.stringify(audit.inventory));if(audit.authorization)this.db.prepare('INSERT INTO v11_authorizations VALUES (?,?,?)').run(audit.authorization.authorizationId,planId,JSON.stringify(audit.authorization));});return record;
  }
  v11RunBinding(id:string){const row=this.db.prepare('SELECT document FROM v11_run_bindings WHERE run_id=?').get(id) as any;return row?JSON.parse(row.document):null;}
  createVerificationV11(v:AppVersion,record:any){const stored=this.v11Record(v.id,record.id);if(!stored||JSON.stringify(stored)!==JSON.stringify(record)||record.authorizationState!=='ALLOW'||!record.authorization)throw new AppError('NOT_AUTHORIZED','没有服务端不可变授权',409);verifyAuthorization(record.authorization,record.inventory);return this.createVerification(v,{state:'PARTIAL',testPlanId:record.id} as PlanningSummary,record);}
  detail(id:string,owner:string){const p=this.project(id,owner) as any,specs=this.db.prepare('SELECT document FROM specifications WHERE project_id=? ORDER BY rowid DESC').all(id).map((r:any)=>JSON.parse(r.document) as Specification),versions=this.db.prepare('SELECT document FROM app_versions WHERE project_id=? ORDER BY rowid DESC').all(id).map((r:any)=>JSON.parse(r.document) as AppVersion);return {apiVersion:'M1.1',id:p.id,name:p.name,createdAt:p.created_at,specifications:specs,versions,jobs:this.db.prepare('SELECT id FROM job_records WHERE project_id=? ORDER BY rowid DESC LIMIT 20').all(id).map((r:any)=>this.job(r.id)),testPlans:specs.map(s=>this.plan(s.specId)).filter(Boolean),planning:versions.map(v=>this.planning(v,specs.find(s=>s.specId===v.specId)!)),acceptances:this.db.prepare('SELECT h.version_id AS versionId,h.created_at AS createdAt FROM human_acceptances h JOIN app_versions v ON h.version_id=v.id WHERE v.project_id=?').all(id)};}
  recover(){
    for(const row of this.db.prepare("SELECT id FROM verification_runs WHERE json_extract(document,'$.state') IN ('QUEUED','RUNNING')").all() as any[])this.finishVerification(row.id,'ERROR','INFRASTRUCTURE','INTERRUPTED: 服务在验证完成前停止；没有自动重试或推断PASS');
    for(const row of this.db.prepare("SELECT j.id,j.version_id,j.payload FROM job_records j JOIN job_context c ON c.job_id=j.id WHERE c.task='PLAN' AND j.state IN ('QUEUED','RUNNING')").all() as any[]){if(JSON.parse(row.payload).protocolVersion==='1.1')continue;const vr=this.db.prepare('SELECT document FROM app_versions WHERE id=?').get(row.version_id) as any,v=JSON.parse(vr.document),sr=this.db.prepare('SELECT document FROM specifications WHERE id=?').get(v.specId) as any,spec=JSON.parse(sr.document);this.savePlanning(v,spec,{...this.planning(v,spec),state:'UNAVAILABLE',testPlanId:null,testPlan:null,coverage:uncovered(spec,'PLANNING_PROVIDER_ERROR','规划被服务重启中断；预览保持可用')},row.id);}
    this.transaction(()=>{for(const r of this.db.prepare("SELECT document FROM app_versions WHERE json_extract(document,'$.buildStatus')='PENDING'").all() as any[]){const v=JSON.parse(r.document);v.buildStatus='FAILED';this.finishVersion(v);}this.db.prepare("UPDATE job_records SET state='ERROR',phase='BLOCKED',error='INTERRUPTED: 服务在任务完成前停止；未自动重试付费请求',finished_at=? WHERE state IN ('QUEUED','RUNNING')").run(new Date().toISOString());});
  }
  runRecord(id:string,owner?:string):VerificationRun{const row=(owner?this.db.prepare('SELECT r.document FROM verification_runs r JOIN projects p ON p.id=r.project_id WHERE r.id=? AND p.owner_id=?').get(id,owner):this.db.prepare('SELECT document FROM verification_runs WHERE id=?').get(id)) as any;if(!row)throw new AppError('NOT_FOUND','验证记录不存在',404);return JSON.parse(row.document);}
  runs(versionId:string,owner:string){this.version(versionId,owner);return this.db.prepare('SELECT document FROM verification_runs WHERE app_version_id=? ORDER BY rowid DESC').all(versionId).map((r:any)=>JSON.parse(r.document) as VerificationRun);}
  runDetail(id:string,owner:string){const run=this.runRecord(id,owner),spec=this.spec(run.specId,owner),saved=this.db.prepare('SELECT document FROM requirement_results WHERE run_id=?').all(id).map((r:any)=>JSON.parse(r.document) as RequirementResult);return {...run,results:spec.requirements.map<RequirementResult>(r=>saved.find(s=>s.requirementId===r.id)||{runId:id,requirementId:r.id,status:'UNVERIFIED',reasonCode:'NOT_EXECUTED',observed:'尚未完成浏览器验证',assertionResults:[],missingEvidence:[]}),evidence:this.evidenceIndex(id,owner)};}
  evidenceIndex(runId:string,owner:string):EvidenceRecord[]{this.runRecord(runId,owner);return this.db.prepare('SELECT e.id,e.run_id AS runId,m.requirement_id AS requirementId,e.kind,e.sha256,m.bytes,m.created_at AS createdAt FROM evidence_files e JOIN evidence_metadata m ON m.evidence_id=e.id WHERE e.run_id=? ORDER BY e.rowid').all(runId) as unknown as EvidenceRecord[];}
  evidenceFile(id:string,owner:string){const row=this.db.prepare('SELECT e.*,m.bytes FROM evidence_files e JOIN evidence_metadata m ON m.evidence_id=e.id JOIN verification_runs r ON r.id=e.run_id JOIN projects p ON p.id=r.project_id WHERE e.id=? AND p.owner_id=?').get(id,owner) as any;if(!row)throw new AppError('NOT_FOUND','证据不存在或尚未发布',404);return row;}
  createVerification(v:AppVersion,planning:PlanningSummary,v11?:any){return this.transaction(()=>{
    const active=this.db.prepare("SELECT document FROM verification_runs WHERE app_version_id=? AND project_id=? AND json_extract(document,'$.state') IN ('QUEUED','RUNNING') ORDER BY rowid DESC LIMIT 1").get(v.id,v.projectId) as any;if(active)return {run:JSON.parse(active.document) as VerificationRun,reused:true};
    const day=new Date().toISOString().slice(0,10),daily=this.db.prepare('SELECT count(*) AS n FROM verification_runs WHERE json_extract(document,\'$.createdAt\')>=?').get(day) as any,queued=this.db.prepare("SELECT count(*) AS n FROM job_records WHERE state IN ('QUEUED','RUNNING')").get() as any,count=this.db.prepare('SELECT count(*) AS n FROM verification_runs').get() as any,size=this.db.prepare('SELECT coalesce(sum(bytes),0) AS n FROM evidence_metadata').get() as any;
    if(daily.n>=verificationLimits.dailyRuns||queued.n>=8||count.n>=verificationLimits.storedRuns||size.n+verificationLimits.runBytes>verificationLimits.evidenceBytes)throw new AppError('VERIFICATION_QUOTA','浏览器验证次数、队列或证据容量已达到上限',429);
    const id=randomUUID(),jobId=randomUUID(),now=new Date().toISOString(),run:VerificationRun={id,jobId,projectId:v.projectId,specId:v.specId,appVersionId:v.id,testPlanId:planning.testPlanId!,sourceSha256:v.sourceSha256,buildSha256:v.buildSha256!,configSha256:v.configSha256,testProtocolVersion:'0.1',state:'QUEUED',createdAt:now,startedAt:null,finishedAt:null,failureCategory:null,error:null,coverageStatus:planning.state==='VALID'?'FULL':'PARTIAL'};
    if(v11){Object.assign(run,{testProtocolVersion:'1.1',authorizationId:v11.authorization.authorizationId,authorizationHash:v11.authorization.canonicalAuthorizationHash,policyVersion:v11.authorization.policyVersion,runnerIdentity:{runnerVersion:v11.authorization.runnerVersion,runnerSha256:v11.authorization.runnerSha256,parserSha256:v11.authorization.parserSha256,imageId:v11.authorization.imageId}});}
    this.db.prepare('INSERT INTO verification_runs VALUES (?,?,?,?)').run(id,v.projectId,v.id,JSON.stringify(run));if(v11)this.db.prepare('INSERT INTO v11_run_bindings VALUES (?,?,?,?)').run(id,run.testPlanId,v11.authorization.authorizationId,JSON.stringify({runId:id,testPlanId:run.testPlanId,authorizationId:v11.authorization.authorizationId,authorizationHash:v11.authorization.canonicalAuthorizationHash}));else this.db.prepare('INSERT INTO verification_bindings VALUES (?,?,?,?)').run(id,v.specId,v.id,run.testPlanId);
    this.db.prepare('INSERT INTO job_records VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(jobId,v.projectId,v.specId,v.id,'GENERATE','QUEUED','VERIFY_QUEUED',JSON.stringify({runId:id}),null,now,null);this.db.prepare('INSERT INTO job_context VALUES (?,?)').run(jobId,'GENERATE');this.db.prepare('INSERT INTO verification_jobs VALUES (?,?)').run(jobId,id);return {run,reused:false};
  });}
  startVerification(id:string){const run=this.runRecord(id);if(run.state!=='QUEUED')throw new AppError('RUN_STATE','验证任务已经启动或终结',409);this.db.prepare('UPDATE verification_runs SET document=? WHERE id=?').run(JSON.stringify({...run,state:'RUNNING',startedAt:new Date().toISOString()}),id);}
  publishResult(result:RequirementResult,files:(EvidenceRecord&{privateKey:string})[]){this.transaction(()=>{
    const run=this.runRecord(result.runId);if(run.state!=='RUNNING')throw new AppError('RUN_STATE','终结任务不能产生新结果',409);const specRow=this.db.prepare('SELECT document FROM specifications WHERE id=?').get(run.specId) as any,req=JSON.parse(specRow.document).requirements.find((r:any)=>r.id===result.requirementId);if(!req||result.status!=='UNVERIFIED'&&req.verificationMode!=='AUTOMATED')throw new AppError('RESULT_SCOPE','非自动需求不能产生自动PASS/FAIL');
    if((result.status!=='UNVERIFIED'||['PASS','FAIL'].includes(result.testStatus||''))&&['BEFORE_SCREENSHOT','AFTER_SCREENSHOT','TRACE','BROWSER_LOG','REPORT'].some(kind=>!files.some(f=>f.kind===kind)))throw new AppError('EVIDENCE_INCOMPLETE','必要证据缺失，不能登记行为PASS/FAIL',503);
    for(const file of files){if(file.runId!==run.id||file.requirementId!==req.id||!new RegExp(`^runs/${run.id}/${req.id}/[a-z0-9-]+\\.(json|png|zip)$`).test(file.privateKey))throw new AppError('EVIDENCE_SCOPE','证据路径或归属不符');this.db.prepare('INSERT INTO evidence_files VALUES (?,?,?,?,?)').run(file.id,run.id,file.privateKey,file.sha256,file.kind);this.db.prepare('INSERT INTO evidence_metadata VALUES (?,?,?,?)').run(file.id,req.id,file.bytes,file.createdAt);}
    this.db.prepare('INSERT INTO requirement_results VALUES (?,?,?,?,?)').run(randomUUID(),run.id,req.id,result.status,JSON.stringify(result));
  });}
  finishVerification(id:string,state:'COMPLETED'|'ERROR'|'CANCELLED',category:VerificationRun['failureCategory'],error:string|null){this.transaction(()=>{
    const run=this.runRecord(id);if(!['QUEUED','RUNNING'].includes(run.state))return;
    const spec=JSON.parse((this.db.prepare('SELECT document FROM specifications WHERE id=?').get(run.specId) as any).document) as Specification,v11=run.testProtocolVersion==='1.1'?this.v11Record(run.appVersionId,run.testPlanId):null,plan=v11?{tests:v11.proposal.tests}:JSON.parse((this.db.prepare('SELECT document FROM version_test_plans WHERE id=?').get(run.testPlanId) as any).document) as TestPlan,planningRow=v11?null:this.db.prepare('SELECT document FROM planning_attempts WHERE version_id=? AND json_extract(document,\'$.testPlanId\')=? ORDER BY rowid DESC LIMIT 1').get(run.appVersionId,run.testPlanId) as any,planning=v11?{coverage:v11.coverage}:JSON.parse(planningRow.document) as PlanningSummary;
    for(const req of spec.requirements){if(this.db.prepare('SELECT id FROM requirement_results WHERE run_id=? AND requirement_id=?').get(id,req.id))continue;const covered=plan.tests.some((t:any)=>t.requirementId===req.id),coverage=planning.coverage.find((c:any)=>c.requirementId===req.id),reasonCode=!covered?coverage?.reason||'NOT_COVERED':state==='CANCELLED'?'CANCELLED':error?.startsWith('INTERRUPTED')?'INTERRUPTED':category||'NOT_EXECUTED',result:RequirementResult={runId:id,requirementId:req.id,status:'UNVERIFIED',reasonCode,observed:!covered?coverage?.explanation||'未覆盖':error||'未执行',assertionResults:[],missingEvidence:covered?['BEFORE_SCREENSHOT','AFTER_SCREENSHOT','TRACE'].map(kind=>({kind,reason:'此需求未完成证据采集'})):[]};this.db.prepare('INSERT INTO requirement_results VALUES (?,?,?,?,?)').run(randomUUID(),id,req.id,'UNVERIFIED',JSON.stringify(result));}
    this.db.prepare('UPDATE verification_runs SET document=? WHERE id=?').run(JSON.stringify({...run,state,finishedAt:new Date().toISOString(),failureCategory:category,error}),id);this.updateJob(run.jobId,state==='COMPLETED'?'COMPLETED':state==='CANCELLED'?'CANCELLED':'ERROR',state==='COMPLETED'?'VERIFICATION_COMPLETE':state==='CANCELLED'?'CANCELLED':'VERIFICATION_ERROR',error?{error}:{});
  });}
  close(){this.db.close();}
}
