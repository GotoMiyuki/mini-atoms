import {object,specDraft,planDraft} from '../shared/contracts.ts';
import type {ContractIssue} from '../shared/contracts.ts';

// Read-only diagnostics. Acceptance is decided only by the existing validators.
// Additional findings never rewrite targets, truncate plans or change enums.
export function inspectPlanning(value:unknown){
  let stage:'Envelope'|'Specification'|'TestPlan'='Envelope';
  let specification:any=null,plan:any=null,firstFailure:ContractIssue|null=null,message:string|null=null;
  try{
    const v=object(value,['assumptions','requirements','unsupported','tests']);stage='Specification';
    specification=specDraft({assumptions:v.assumptions,requirements:v.requirements,unsupported:v.unsupported});stage='TestPlan';
    plan=planDraft(v.tests,specification.requirements);
  }catch(error:any){message=error.message;firstFailure=error.issue||{module:stage,path:'$',rule:error.code||'UNKNOWN'};}
  const v=value as any,findings:ContractIssue[]=[],capabilityConcerns:{path:string;reason:string;basis:string}[]=[];
  let totalSteps=0;
  if(Array.isArray(v?.requirements))for(const [index,r] of v.requirements.entries()){
    if(r&&!['MUST','SHOULD'].includes(r.priority))findings.push({module:'Specification',path:`$.requirements[${index}].priority`,rule:'PRIORITY_ENUM',actual:r.priority,expected:['MUST','SHOULD']});
  }
  if(Array.isArray(v?.tests))for(const [ti,t] of v.tests.entries()){
    const requirement=Array.isArray(v?.requirements)?v.requirements.find((r:any)=>r?.id===t?.requirementId):null;
    if(!Array.isArray(t?.steps))continue;
    for(const [si,s] of t.steps.entries()){
      totalSteps++;if(!s||typeof s!=='object')continue;const path=`$.tests[${ti}].steps[${si}]`;
      if(!['fill','click','assertVisible','assertAbsent','assertCount','assertValue'].includes(s.action))findings.push({module:'TestPlan',path:path+'.action',rule:'ACTION_ENUM',actual:s.action});
      if(!requirement?.targetHints?.includes(s.target))findings.push({module:'TestPlan',path:path+'.target',rule:'TARGET_SCOPE',actual:s.target,expected:requirement?.targetHints||[]});
      if(s.action==='fill'&&s.value!=='${RUN_UNIQUE}')findings.push({module:'TestPlan',path:path+'.value',rule:'FILL_VALUE',actual:s.value,expected:'${RUN_UNIQUE}'});
      if(s.action==='fill'&&/amount|email|money|price|金额|邮箱/i.test(String(s.target)+' '+String(requirement?.text)))capabilityConcerns.push({path,reason:'随机文本未必满足金额/邮箱等输入域；不能直接认定可自动验证',basis:'根据目标名/需求推断，需结合真实元素类型确认'});
      if(s.action==='click'&&/select/.test(String(s.target)))capabilityConcerns.push({path,reason:'当前 DSL 没有 selectOption，click 下拉框不证明完成选项选择',basis:'冻结动作集合'});
      if(s.action==='assertValue'&&typeof s.target==='string'&&!s.target.endsWith('-input')&&/title|email|name|note|input/.test(s.target))capabilityConcerns.push({path,reason:'原执行器仅对 -input 后缀使用 toHaveValue；其它目标使用 toHaveText，需核对实际元素',basis:'M0.5 worker.mjs 的现有分支；未改写执行器'});
    }
  }
  if(totalSteps>20)findings.push({module:'TestPlan',path:'$.tests',rule:'STEP_LIMIT',actual:totalSteps,expected:20});
  return {accepted:firstFailure===null,specificationAccepted:specification!==null,failedStage:firstFailure?stage:null,firstFailure,message,totalSteps,findings,capabilityConcerns,specification,plan};
}
