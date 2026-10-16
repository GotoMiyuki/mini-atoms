export interface Requirement { id: string; text: string; priority: 'MUST'|'SHOULD'; verificationMode: 'AUTOMATED'|'MANUAL'|'UNSUPPORTED'; acceptance: string; targetHints?: string[] }
export interface Specification { schemaVersion: '0.1'; specId: string; projectId: string; sourcePrompt: string; assumptions: string[]; requirements: Requirement[]; unsupported: string[]; createdAt: string }
export interface TestStep { action: 'fill'|'click'|'assertVisible'|'assertAbsent'|'assertCount'|'assertValue'; target: string; value?: string; expected?: string|number; timeoutMs?: number }
export interface TestPlan { schemaVersion: '0.1'; id: string; specId: string; tests: {requirementId: string; steps: TestStep[]}[]; createdAt: string }
export interface SourceEnvelope { schemaVersion: '0.1'; files: {path: string; content: string}[]; summary?: string }
export interface AppVersion { id: string; projectId: string; specId: string; parentVersionId: string|null; files: SourceEnvelope['files']; sourceSha256: string; buildSha256: string|null; configSha256: string; runtimeConfigVersion: string; runtimeVersionId: string|null; buildStatus: 'PENDING'|'SUCCEEDED'|'FAILED'; buildLogRef: string|null; createdAt: string; summary: string }
export interface Job { id: string; projectId: string; specId: string|null; versionId: string|null; kind: 'SPECIFY'|'GENERATE'; task?: 'SPECIFY'|'GENERATE'|'PLAN'|'VERIFY'; warnings?: string[]; diagnosticRef?: string; state: 'QUEUED'|'RUNNING'|'COMPLETED'|'ERROR'|'CANCELLED'; phase: string; error: string|null; createdAt: string; finishedAt: string|null }
export type PlanningState = 'NOT_STARTED'|'PLANNING'|'VALID'|'PARTIAL'|'UNAVAILABLE';
export type CoverageReason = 'NOT_EXECUTED'|'PLAN_CONTRACT_INVALID'|'UNSUPPORTED_ACTION'|'STEP_BUDGET_EXCEEDED'|'MISSING_TARGET_BINDING'|'PLANNING_PROVIDER_ERROR'|'MANUAL_REVIEW_REQUIRED';
export interface RequirementCoverage { requirementId:string; status:'PLANNED'|'UNVERIFIED'; reason:CoverageReason; explanation:string }
export interface PlanningSummary { state:PlanningState; specId:string; appVersionId:string; sourceSha256:string; buildSha256:string|null; configSha256:string; testPlanId:string|null; testPlan:TestPlan|null; coverage:RequirementCoverage[]; diagnosticRef?:string; jobId?:string|null; verificationStatus:'UNVERIFIED' }
export interface ContractIssue { module: 'Specification'|'TestPlan'|'Envelope'; path: string; rule: string; actual?: unknown; expected?: unknown }
export class AppError extends Error { code: string; status: number; issue?: ContractIssue; constructor(code: string, message: string, status=400, issue?: ContractIssue) { super(message); this.code=code; this.status=status; this.issue=issue; } }
function reject(path:string,rule:string,message:string,actual?:unknown,expected?:unknown):never {
  const module=path.startsWith('$.tests')?'TestPlan':/^\$\.(requirements|assumptions|unsupported)/.test(path)?'Specification':'Envelope';
  throw new AppError('INVALID_CONTRACT',`${message}（${path}）`,400,{module,path,rule,actual:typeof actual==='string'?actual.slice(0,256):actual,expected});
}
export function object(value: unknown, keys: string[], required=keys, path='$'): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k=>!keys.includes(k)) || required.some(k=>!Object.hasOwn(value,k))) reject(path,'FIELD_SET','JSON 字段不符合契约',value&&typeof value==='object'?Object.keys(value).slice(0,20):typeof value,keys);
  return value as Record<string, any>;
}
export function text(value: unknown, max=4000, min=1, path='$'): string {
  if (typeof value !== 'string' || value.trim().length<min || value.length>max) reject(path,'TEXT_LENGTH',`文本长度须为 ${min}–${max}`,typeof value==='string'?value.length:typeof value,{min,max});
  return value;
}
const strings=(value: unknown,maxCount=12,maxLength=1000,path='$'): string[]=>{
  if(!Array.isArray(value)||value.length>maxCount)reject(path,'ARRAY_LIMIT','列表超限',Array.isArray(value)?value.length:typeof value,maxCount);
  return value.map((v,i)=>text(v,maxLength,1,`${path}[${i}]`));
};
export function specDraft(value: unknown) {
  const v=object(value,['assumptions','requirements','unsupported']);
  if(!Array.isArray(v.requirements)||v.requirements.length<1||v.requirements.length>8)reject('$.requirements','REQUIREMENT_COUNT','需求数量须为 1–8',Array.isArray(v.requirements)?v.requirements.length:typeof v.requirements,{min:1,max:8});
  const ids=new Set<string>();
  const requirements: Requirement[]=v.requirements.map((raw: unknown,index:number)=>{
    const path=`$.requirements[${index}]`;
    const r=object(raw,['id','text','priority','verificationMode','acceptance','targetHints'],['id','text','priority','verificationMode','acceptance'],path);
    if(!/^R[1-8]$/.test(r.id)||ids.has(r.id))reject(path+'.id','REQUIREMENT_ID','需求 ID 无效或重复',r.id,'唯一 R1–R8');
    if(!['MUST','SHOULD'].includes(r.priority))reject(path+'.priority','PRIORITY_ENUM','优先级仅允许 MUST / SHOULD',r.priority,['MUST','SHOULD']);
    if(!['AUTOMATED','MANUAL','UNSUPPORTED'].includes(r.verificationMode))reject(path+'.verificationMode','VERIFICATION_MODE_ENUM','验证方式无效',r.verificationMode,['AUTOMATED','MANUAL','UNSUPPORTED']);
    ids.add(r.id);
    const hints=r.targetHints===undefined?[]:strings(r.targetHints,12,64,path+'.targetHints');
    if(hints.some(t=>! /^[a-z][a-z0-9-]{0,63}$/.test(t)))reject(path+'.targetHints','TARGET_HINT','targetHints 仅允许稳定 testid',hints);
    return {id:r.id,text:text(r.text,1000,1,path+'.text'),priority:r.priority,verificationMode:r.verificationMode,acceptance:text(r.acceptance,2000,1,path+'.acceptance'),targetHints:hints};
  });
  return {assumptions:strings(v.assumptions,12,1000,'$.assumptions'),requirements,unsupported:strings(v.unsupported,12,1000,'$.unsupported')};
}
// M1 validates the persisted planning contract only. It does not execute a plan
// or replace M0.5's validated executor. M2 must adapt that executor separately.
export function planDraft(value: unknown, requirements: Requirement[]) {
  if(!Array.isArray(value)||value.length>8)reject('$.tests','ARRAY_LIMIT','测试计划超限',Array.isArray(value)?value.length:typeof value,8);
  const seen=new Set<string>(); let count=0;
  return value.map((raw,index)=>{
    const path=`$.tests[${index}]`,r=object(raw,['requirementId','steps'],['requirementId','steps'],path);
    const req=requirements.find(q=>q.id===r.requirementId);
    if(!req||req.verificationMode!=='AUTOMATED'||seen.has(req.id))reject(path+'.requirementId','TEST_REQUIREMENT','测试需求引用无效',r.requirementId);
    if(!Array.isArray(r.steps)||r.steps.length<1)reject(path+'.steps','STEPS_ARRAY','测试需求步骤无效');
    seen.add(req.id);
    const steps: TestStep[]=r.steps.map((rawStep: unknown,stepIndex:number)=>{
      const stepPath=`${path}.steps[${stepIndex}]`,s=object(rawStep,['action','target','value','expected','timeoutMs'],['action','target'],stepPath);
      if(++count>20)reject(stepPath,'STEP_LIMIT','测试总步数超过 20',count,20);
      if(!['fill','click','assertVisible','assertAbsent','assertCount','assertValue'].includes(s.action))reject(stepPath+'.action','ACTION_ENUM','动作不在白名单',s.action);
      if(!req.targetHints?.includes(s.target))reject(stepPath+'.target','TARGET_SCOPE',`目标未在 ${req.id} 的 targetHints 中声明`,s.target,req.targetHints);
      if(s.timeoutMs!==undefined&&(!Number.isInteger(s.timeoutMs)||s.timeoutMs<100||s.timeoutMs>5000))reject(stepPath+'.timeoutMs','TIMEOUT_LIMIT','单步超时无效',s.timeoutMs,{min:100,max:5000});
      if(s.action==='fill'){
        if(s.value!=='${RUN_UNIQUE}')reject(stepPath+'.value','FILL_VALUE','fill 只接受运行时随机占位符',s.value,'${RUN_UNIQUE}');
        if(s.expected!==undefined)reject(stepPath+'.expected','FILL_VALUE','fill 不接受 expected',s.expected,'字段必须缺省');
      }
      else if(s.value!==undefined)reject(stepPath+'.value','UNEXPECTED_FIELD','意外 value');
      if(s.action==='assertCount'){if(!Number.isInteger(s.expected)||s.expected<0||s.expected>100)reject(stepPath+'.expected','COUNT_EXPECTED','数量无效',s.expected,{min:0,max:100});}
      else if(s.action==='assertValue')text(s.expected,128,0,stepPath+'.expected');
      else if(s.expected!==undefined)reject(stepPath+'.expected','UNEXPECTED_FIELD','意外 expected');
      return s as TestStep;
    });
    return {requirementId:req.id,steps};
  });
}
