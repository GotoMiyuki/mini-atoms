import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Store,uncovered} from './store.ts';
import {Runtime} from './runtime.ts';
import {Provider} from './provider.ts';
import {VerificationExecutorV11} from './verification-v11.ts';
import {inventoryV11,auditV11,runnerIdentity} from './policy-v11.ts';
import {locatorInventory,candidatePlan,specificationRepairCore} from './planning.ts';
import {AppError} from '../shared/contracts.ts';
import type {AppVersion,Specification,TestPlan,Job,CoverageReason} from '../shared/contracts.ts';
import {canonicalHash,sha} from '../../../../spikes/m0-5-tsx-runtime/src/shared.mjs';
import {validateSource} from '../../../../spikes/m0-5-tsx-runtime/src/controlled-build/policy.mjs';
export class Orchestrator {
  interactive:any=null;
  store:Store;runtime:Runtime;provider:Provider;owner:string;maxDaily:number;jobTimeoutMs=180000;
  working=false;closed=false;active:{id:string;abort:AbortController}|null=null;
  verifier:VerificationExecutorV11;
  constructor(store:Store,runtime:Runtime,provider:Provider,owner:string,maxDaily:number){this.store=store;this.runtime=runtime;this.provider=provider;this.owner=owner;this.maxDaily=maxDaily;this.verifier=new VerificationExecutorV11(store,runtime,owner);}
  async requestVerification(v:AppVersion){await this.verifier.capacity();let result;if(this.store.protocolSelection(v.id)==='1.1'){const binding=await this.verifier.bindingV11(v);result=this.store.createVerificationV11(v,binding.record);}else{const binding=await this.verifier.binding(v);result=this.store.createVerification(v,binding.planning);}setImmediate(()=>void this.pump());return {...result,job:this.store.job(result.run.jobId,this.owner)};}
  requestPlanningV11(v:AppVersion){if(v.buildStatus!=='SUCCEEDED')throw new AppError('NOT_READY','只为成功版本规划',409);const row=this.store.db.prepare("SELECT id FROM job_records WHERE version_id=? AND json_extract(payload,'$.protocolVersion')='1.1' ORDER BY rowid DESC LIMIT 1").get(v.id) as any;if(row){this.store.selectProtocol(v.id,'1.1',row.id);return {job:this.store.job(row.id,this.owner),v11:this.store.v11Record(v.id),reused:true};}const job=this.enqueue(v.projectId,v.specId,'SPECIFY',{protocolVersion:'1.1'},'PLAN',v.id);this.store.selectProtocol(v.id,'1.1',job.id);return {job,v11:null,reused:false};}
  enqueue(projectId:string,specId:string|null,kind:'SPECIFY'|'GENERATE',payload:unknown,task:NonNullable<Job['task']>=kind,versionId:string|null=null){if(!this.provider.ready())throw new AppError('LLM_NOT_CONFIGURED','请先在服务端配置真实模型连接',503);const job=this.store.newJob(projectId,specId,kind,payload,this.maxDaily,task,versionId);setImmediate(()=>void this.pump());return job;}
  requestPlanning(v:AppVersion){
    if(v.buildStatus!=='SUCCEEDED')throw new AppError('NOT_READY','构建成功后才能规划验证',409);
    const spec=this.store.spec(v.specId,this.owner),existing=this.store.planningJob(v.id);
    if(existing)return {job:existing,planning:this.store.planning(v,spec),reused:true};
    const previous=this.store.planning(v,spec);
    if(previous.state==='UNAVAILABLE'&&!previous.jobId&&(!this.provider.ready()||this.store.quota(this.maxDaily).remaining===0))return {job:null,planning:previous,reused:true};
    try{const job=this.enqueue(v.projectId,spec.specId,'SPECIFY',{},'PLAN',v.id);return {job,planning:this.store.planning(v,spec),reused:false};}
    catch(error:any){this.store.savePlanning(v,spec,{...this.store.planning(v,spec),state:'UNAVAILABLE',testPlan:null,testPlanId:null,coverage:uncovered(spec,'PLANNING_PROVIDER_ERROR',`${error.code||'INFRASTRUCTURE'}: 规划未能排队；已构建预览保持可用`)},null);return {job:null,planning:this.store.planning(v,spec),reused:false};}
  }
  recordPlanFailure(job:Job,error:any){
    const payload=JSON.parse((this.store.db.prepare('SELECT payload FROM job_records WHERE id=?').get(job.id) as any).payload);if(payload.protocolVersion==='1.1'){if(this.store.v11Record(job.versionId!)?.jobId===job.id)return;const v=this.store.version(job.versionId!,this.owner),spec=this.store.spec(v.specId,this.owner),inventory=inventoryV11(v);this.store.saveV11(v,spec,randomUUID(),{decision:'DENY',proposal:null,inventory,authorization:null,expandedCost:0,diagnostics:[error.issue||{module:'TestPlanV11',path:'$',rule:error.code||'INFRASTRUCTURE',actual:error.message,expected:'legal proposal'}],coverage:spec.requirements.map(r=>({requirementId:r.id,reason:error.code||'PLANNING_PROVIDER_ERROR',explanation:'未获得可执行授权',acceptance:r.acceptance}))},job.id,(()=>{const r=this.store.db.prepare('SELECT r.document FROM model_call_results r JOIN model_call_slots s ON s.id=r.slot_id WHERE s.job_id=? ORDER BY s.attempt DESC LIMIT 1').get(job.id) as any;return r?JSON.parse(r.document).output:null;})());return;}
    const v=this.store.version(job.versionId!,this.owner),spec=this.store.spec(v.specId,this.owner),rule=error?.issue?.rule;
    const reason:CoverageReason=rule==='STEP_LIMIT'?'STEP_BUDGET_EXCEEDED':['UNSUPPORTED_ACTION','MISSING_TARGET_BINDING'].includes(rule)?rule:error?.code==='INVALID_CONTRACT'?'PLAN_CONTRACT_INVALID':'PLANNING_PROVIDER_ERROR';
    this.store.savePlanning(v,spec,{...this.store.planning(v,spec),state:'UNAVAILABLE',testPlan:null,testPlanId:null,coverage:uncovered(spec,reason,`${error?.code||'INFRASTRUCTURE'}: ${String(error?.message||'规划失败').slice(0,1000)}；预览不受影响`),diagnosticRef:`jobs/${job.id}/attempts`},job.id);
  }
  cancel(id:string){const job=this.store.job(id,this.owner);if(!['QUEUED','RUNNING'].includes(job.state))return job;const error=new AppError('CANCELLED','用户取消任务',409);if(this.active?.id===id)this.active.abort.abort(error);else{if(job.task==='VERIFY'){const row=this.store.db.prepare('SELECT run_id FROM verification_jobs WHERE job_id=?').get(id) as any;this.store.finishVerification(row.run_id,'CANCELLED',null,'CANCELLED: 用户取消任务');}else{if(job.task==='PLAN')this.recordPlanFailure(job,error);this.store.updateJob(id,'CANCELLED','CANCELLED',{error:error.message});}}return this.store.job(id,this.owner);}
  async pump(){if(this.working||this.closed)return;this.working=true;try{while(!this.closed){const row=this.store.db.prepare("SELECT id,payload FROM job_records WHERE state='QUEUED' ORDER BY rowid LIMIT 1").get() as any;if(!row)break;await this.execute(row.id,JSON.parse(row.payload));}}finally{this.working=false;}}
  async modelCall<T>(id:string,attempt:number,signal:AbortSignal,fn:()=>Promise<T>):Promise<T>{
    signal.throwIfAborted();const slot=this.store.callSlot(id,attempt,this.maxDaily);signal.throwIfAborted();
    this.provider.lastReceipt=null;this.provider.lastOutput=null;this.provider.lastRawContent=null;this.provider.lastRequest=null;let failure:any=null;
    let reservation:any=null;this.provider.beforeRequest=(bytes,tokens)=>{reservation=this.interactive?.beforeCall(id,bytes,tokens)||null;};
    try{return await fn();}catch(error){failure=error;throw error;}
    finally{
      const raw=this.provider.lastRawContent,output=this.provider.lastOutput,receipt=this.provider.lastReceipt;
      const document={attempt,slotId:slot,recordedAt:new Date().toISOString(),request:this.provider.lastRequest,receipt,output,rawContent:raw,rawSha256:sha(raw??JSON.stringify(output)),error:failure?{code:failure.code||'INFRASTRUCTURE',message:String(failure.message||failure),diagnostic:failure.issue||null}:null};
      this.store.recordCall(slot,document);
      const root=join(this.runtime.dataRoot,'jobs',id),directory=join(root,'attempts',String(attempt));await mkdir(directory,{recursive:true});
      await writeFile(join(directory,'audit.json'),JSON.stringify(document,null,2),{flag:'wx'});
      if(receipt)await writeFile(join(root,'provider-receipt.json'),JSON.stringify(receipt,null,2));
      if(output!==null)await writeFile(join(root,'model-output.json'),JSON.stringify(output,null,2));
      if(failure?.issue)await writeFile(join(root,'contract-diagnostic.json'),JSON.stringify(failure.issue,null,2));
      this.provider.beforeRequest=null;this.interactive?.settle(reservation,receipt);
    }
  }
  async specification(id:string,prompt:string,signal:AbortSignal){
    let correction:unknown=undefined,core:unknown=null,firstFailure:any=null;
    for(let attempt=1;attempt<=2;attempt++){
      try{return await this.modelCall(id,attempt,signal,async()=>{
        const draft=await this.provider.generateSpecification(prompt,signal,correction);
        if(core&&JSON.stringify(specificationRepairCore(draft))!==JSON.stringify(core))throw new AppError('SPEC_REPAIR_CHANGED','纠正改变了原需求内容、优先级或验收条件，已阻断',422,{module:'Specification',path:'$.requirements',rule:'IMMUTABLE_INTENT'});
        return draft;
      });}catch(error:any){
        if(attempt===2&&error.code==='QUOTA'&&firstFailure)throw new AppError(firstFailure.code,`${firstFailure.message}；QUOTA: 未执行纠正调用，额度已耗尽`,firstFailure.status,firstFailure.issue);
        const first=this.provider.lastOutput;core=specificationRepairCore(first);
        if(attempt!==1||signal.aborted||error.code!=='INVALID_CONTRACT'||!error.issue||!core)throw error;
        firstFailure=error;correction={previousResponse:first,diagnostic:error.issue,instruction:'只纠正合同格式；逐字保留每条需求的 id/text/priority/acceptance/verificationMode，不得删除需求或映射未知优先级'};
      }
    }throw new AppError('SPEC_BLOCKED','需求纠正次数已用尽');
  }
  async plan(id:string,spec:Specification,v:AppVersion,signal:AbortSignal){
    const inventory=locatorInventory(v),root=join(this.runtime.dataRoot,'jobs',id);await mkdir(root,{recursive:true});await writeFile(join(root,'locator-inventory.json'),JSON.stringify(inventory,null,2));
    let correction:unknown=undefined,firstFailure:any=null;
    for(let attempt=1;attempt<=2;attempt++){
      try{return await this.modelCall(id,attempt,signal,async()=>candidatePlan(await this.provider.generateTestPlan(spec,inventory,signal,correction),spec,inventory));}
      catch(error:any){if(attempt===2&&error.code==='QUOTA'&&firstFailure)throw new AppError(firstFailure.code,`${firstFailure.message}；QUOTA: 未执行纠正调用，额度已耗尽`,firstFailure.status,firstFailure.issue);if(attempt!==1||signal.aborted||error.code!=='INVALID_CONTRACT'||!error.issue)throw error;firstFailure=error;correction={previousResponse:this.provider.lastOutput,diagnostic:error.issue,instruction:'只修复测试计划的合同错误；不可修改冻结需求或targetHints。无法完整覆盖时在coverage给出原因，不削弱验收'};}
    }throw new AppError('PLAN_UNAVAILABLE','计划纠正次数已用尽');
  }
  async execute(id:string,payload:any){
    const job=this.store.job(id),abort=new AbortController();this.active={id,abort};let release:(()=>Promise<void>)|undefined,version:AppVersion|undefined;
    const timer=setTimeout(()=>abort.abort(new AppError('JOB_TIMEOUT','任务超过 180 秒总时限',504)),this.jobTimeoutMs);
    try{
      this.interactive?.grantForJob(id);release=await this.runtime.globalLease();abort.signal.throwIfAborted();
      this.store.updateJob(id,'RUNNING',job.task==='VERIFY'?'VERIFYING':job.task==='PLAN'?'PLANNING_VERIFICATION':job.kind==='SPECIFY'?'SPECIFYING':'GENERATING');
      if(job.task==='VERIFY'){
        await this.verifier.execute(payload.runId,abort.signal);
      }else if(job.task==='PLAN'){
        if(payload.protocolVersion==='1.1'){
          const v=this.store.version(job.versionId!,this.owner),spec=this.store.spec(v.specId,this.owner),inventory=inventoryV11(v),identity=await runnerIdentity(this.runtime.lock.imageId),planId=randomUUID();let correction:unknown=undefined,record:any=null;
          for(let attempt=1;attempt<=2;attempt++){try{const audit=await this.modelCall(id,attempt,abort.signal,async()=>{const raw=await this.provider.generateTestPlanV11(spec,inventory,abort.signal,correction,payload.focusRequirementId),audit=auditV11(raw,spec,v,inventory,planId,identity);if(audit.decision==='DENY'){const issue=audit.diagnostics.at(-1);throw new AppError('INVALID_CONTRACT','v1.1 提案被确定性政策拒绝',422,issue);}return audit;});abort.signal.throwIfAborted();record=this.store.saveV11(v,spec,planId,audit,id,this.provider.lastOutput);break;}catch(e:any){if(attempt!==1||abort.signal.aborted||e.code!=='INVALID_CONTRACT'||!e.issue)throw e;correction={previousResponse:this.provider.lastOutput,diagnostic:e.issue,instruction:'只纠正合法性；不得改冻结需求、目标权限、预算或平台策略。最多一次纠正。'};}}
          this.store.outcome(id,{warnings:[record.authorizationState==='ALLOW'?'提案获授权；尚未执行，完整验收仍未证明':'提案需要审查；不会执行浏览器']});this.store.updateJob(id,'COMPLETED',record.authorizationState==='ALLOW'?'PLANNED':'PLAN_UNAVAILABLE');return;
        }
        const v=this.store.version(job.versionId!,this.owner),spec=this.store.spec(v.specId,this.owner),candidate=await this.plan(id,spec,v,abort.signal);abort.signal.throwIfAborted();
        const createdAt=new Date().toISOString(),plan:TestPlan|null=candidate.tests.length?{schemaVersion:'0.1',id:randomUUID(),specId:spec.specId,tests:candidate.tests,createdAt}:null;
        this.store.savePlanning(v,spec,{...this.store.planning(v,spec),state:candidate.state,testPlanId:plan?.id||null,testPlan:plan,coverage:candidate.coverage},id);
        const warnings=candidate.state==='VALID'?['计划可用；尚未执行浏览器验证']:['部分或全部需求尚无可执行计划；已构建预览保持可用'];this.store.outcome(id,{warnings});this.store.updateJob(id,'COMPLETED',plan?'PLANNED':'PLAN_UNAVAILABLE');
      }else if(job.kind==='SPECIFY'){
        const draft=await this.specification(id,payload.prompt,abort.signal);abort.signal.throwIfAborted();
        const createdAt=new Date().toISOString(),specId=randomUUID(),spec:Specification={schemaVersion:'0.1',specId,projectId:job.projectId,sourcePrompt:payload.prompt,...draft,createdAt};
        this.store.saveSpec(spec);this.store.updateJob(id,'COMPLETED','SPEC_READY',{specId});
      }else{
        const spec=this.store.spec(job.specId!,this.owner),source=await this.modelCall(id,1,abort.signal,()=>this.provider.generateSource(spec,abort.signal));abort.signal.throwIfAborted();
        const files=validateSource(source),sourceSha256=canonicalHash(files);
        if(source.summary!==undefined&&(typeof source.summary!=='string'||source.summary.length>2000))throw new AppError('INVALID_SOURCE','生成摘要无效');
        const parent=(this.store.detail(job.projectId,this.owner).versions[0] as AppVersion|undefined)?.id||null;
        version={id:randomUUID(),projectId:job.projectId,specId:spec.specId,parentVersionId:parent,files:source.files,sourceSha256,buildSha256:null,configSha256:this.runtime.lock.configSha256,runtimeConfigVersion:this.runtime.lock.policyVersion,runtimeVersionId:null,buildStatus:'PENDING',buildLogRef:`${id}/logs/build.log`,createdAt:new Date().toISOString(),summary:source.summary||''};
        this.store.saveVersion(version);this.store.updateJob(id,'RUNNING','BUILDING',{versionId:version.id});
        const manifest=await this.runtime.build(source,id,abort.signal);abort.signal.throwIfAborted();
        version={...version,buildSha256:manifest.buildSha256,runtimeVersionId:manifest.versionId,buildStatus:'SUCCEEDED'};this.store.finishVersion(version);
        const warnings=['应用已构建；尚未执行浏览器验证'];
        if(payload.planVerification!==false){const planned=this.requestPlanning(version);if(!planned.job)warnings.push('验证规划未能排队；预览保持可用');}
        this.store.outcome(id,{warnings});this.store.updateJob(id,'COMPLETED','PREVIEW_READY',{versionId:version.id});
      }
    }catch(error:any){
      if(version&&this.store.version(version.id,this.owner).buildStatus==='PENDING')this.store.finishVersion({...version,buildStatus:'FAILED'});
      const reason=abort.signal.aborted?abort.signal.reason:error,cancelled=reason?.code==='CANCELLED';
      if(job.task==='VERIFY'){const category=reason?.code==='IDENTITY_MISMATCH'?'IDENTITY_MISMATCH':reason?.code==='EVIDENCE_INCOMPLETE'?'EVIDENCE_INCOMPLETE':reason?.code==='INVALID_CONTRACT'||reason?.code==='PLAN_CAPABILITY'?'INVALID_TEST_PLAN':'INFRASTRUCTURE';this.store.finishVerification(payload.runId,cancelled?'CANCELLED':'ERROR',cancelled?null:category,`${reason?.code||'INFRASTRUCTURE'}: ${String(reason?.message||'验证失败').slice(0,2000)}`);return;}
      if(job.task==='PLAN')this.recordPlanFailure(job,reason);
      this.store.outcome(id,{...(reason?.issue?{diagnosticRef:`jobs/${id}/attempts`}:{}),...(job.task==='PLAN'?{warnings:['验证规划不可用；已构建预览保持可用']}: {})});
      this.store.updateJob(id,cancelled?'CANCELLED':'ERROR',cancelled?'CANCELLED':job.task==='PLAN'?'PLAN_UNAVAILABLE':'BLOCKED',{error:`${reason?.code||'INFRASTRUCTURE'}: ${String(reason?.message||'任务失败').slice(0,2000)}`});
    }finally{clearTimeout(timer);await release?.();this.active=null;}
  }
  async close(){this.interactive?.close();this.closed=true;this.active?.abort.abort(new AppError('SERVER_STOP','服务停止，任务没有自动重试',503));while(this.working)await new Promise(done=>setTimeout(done,50));}
}
