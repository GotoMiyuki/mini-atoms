import ts from 'typescript';
import {AppError,object,text,planDraft} from '../shared/contracts.ts';
import type {Specification,AppVersion,RequirementCoverage,CoverageReason} from '../shared/contracts.ts';
import {validateSource} from '../../../../spikes/m0-5-tsx-runtime/src/controlled-build/policy.mjs';
import {canonicalHash} from '../../../../spikes/m0-5-tsx-runtime/src/shared.mjs';
export interface LocatorInfo {id:string;tag:string;type:string|null;file:string;line:number;pattern:boolean;duplicate:boolean}
export interface LocatorInventory {basis:'STATIC_JSX_DECLARATIONS_NOT_DOM_EVIDENCE';appVersionId:string;sourceSha256:string;buildSha256:string;configSha256:string;targets:LocatorInfo[]}
// Parse literal JSX attributes only. No generated code or DOM script is executed.
export function locatorInventory(v:AppVersion):LocatorInventory{
  if(v.buildStatus!=='SUCCEEDED'||!v.buildSha256||canonicalHash(validateSource({schemaVersion:'0.1',files:v.files}))!==v.sourceSha256)throw new AppError('PLAN_IDENTITY','只允许读取成功版本且源码摘要一致的定位信息');
  const targets:LocatorInfo[]=[];
  for(const file of v.files.filter(f=>f.path.endsWith('.tsx'))){const source=ts.createSourceFile(file.path,file.content,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
    function visit(node:ts.Node){
      if(ts.isJsxOpeningElement(node)||ts.isJsxSelfClosingElement(node)){
        const attrs=node.attributes.properties;
        if(!attrs.some(a=>ts.isJsxSpreadAttribute(a))){
          const literal=(key:string)=>{const a=attrs.find(a=>ts.isJsxAttribute(a)&&a.name.getText(source)===key);return a&&ts.isJsxAttribute(a)&&a.initializer&&ts.isStringLiteral(a.initializer)?a.initializer.text:null;};
          const id=literal('data-testid'),tag=node.tagName.getText(source);
          if(id&&/^[a-z][a-z0-9-]{0,63}$/.test(id)&&/^[a-z]+$/.test(tag)&&targets.length<128)targets.push({id,tag,type:literal('type')||(tag==='input'?'text':null),pattern:attrs.some(a=>ts.isJsxAttribute(a)&&a.name.getText(source)==='pattern'),file:file.path,line:source.getLineAndCharacterOfPosition(node.getStart(source)).line+1,duplicate:false});
        }
      }ts.forEachChild(node,visit);
    }visit(source);
  }
  for(const target of targets)target.duplicate=targets.filter(t=>t.id===target.id).length>1;
  return {basis:'STATIC_JSX_DECLARATIONS_NOT_DOM_EVIDENCE',appVersionId:v.id,sourceSha256:v.sourceSha256,buildSha256:v.buildSha256,configSha256:v.configSha256,targets};
}
const reasons:CoverageReason[]=['UNSUPPORTED_ACTION','STEP_BUDGET_EXCEEDED','MISSING_TARGET_BINDING','MANUAL_REVIEW_REQUIRED'];
function capability(path:string,rule:CoverageReason,message:string,actual?:unknown):never{throw new AppError('PLAN_CAPABILITY',message,422,{module:'TestPlan',path,rule,actual});}
export function candidatePlan(value:unknown,spec:Specification,inventory:LocatorInventory){
  const raw=object(value,['tests','coverage']),tests=planDraft(raw.tests,spec.requirements);
  if(!Array.isArray(raw.coverage)||raw.coverage.length>8)throw new AppError('INVALID_CONTRACT','遗漏覆盖说明须为最多 8 项列表',400,{module:'TestPlan',path:'$.coverage',rule:'COVERAGE_SHAPE'});
  const omitted=new Map<string,{reason:CoverageReason;explanation:string}>();
  for(const [index,item] of raw.coverage.entries()){
    const c=object(item,['requirementId','reason','explanation'],undefined,`$.coverage[${index}]`);
    if(!spec.requirements.some(r=>r.id===c.requirementId)||tests.some(t=>t.requirementId===c.requirementId)||omitted.has(c.requirementId)||!reasons.includes(c.reason))throw new AppError('INVALID_CONTRACT','覆盖引用或原因无效',400,{module:'TestPlan',path:`$.coverage[${index}]`,rule:'COVERAGE_REFERENCE'});
    omitted.set(c.requirementId,{reason:c.reason,explanation:text(c.explanation,1000,1,`$.coverage[${index}].explanation`)});
  }
  for(const [ti,test] of tests.entries())for(const [si,step] of test.steps.entries()){
    const path=`$.tests[${ti}].steps[${si}]`,matches=inventory.targets.filter(t=>t.id===step.target),target=matches[0];
    if(!target)capability(path+'.target','MISSING_TARGET_BINDING','版本中没有可信的静态定位声明；不能据此承诺可执行',step.target);
    if(step.action==='fill'&&(!(target.tag==='textarea'||target.tag==='input'&&['text','search','password'].includes(target.type||''))||target.pattern))capability(path,'UNSUPPORTED_ACTION','冻结随机文本不能可靠填入此控件',target);
    if(step.action==='click'&&target.tag==='select')capability(path,'UNSUPPORTED_ACTION','click 不能代表选择下拉选项',target);
    if(step.action==='assertValue'&&((['input','textarea'].includes(target.tag))!==step.target.endsWith('-input')))capability(path,'UNSUPPORTED_ACTION','冻结 assertValue 的 -input 后缀约定与元素类型不匹配',target);
    if(step.action==='assertValue'&&step.expected!==''&&test.steps.slice(0,si).some(s=>s.action==='fill'&&s.target===step.target))capability(path,'UNSUPPORTED_ACTION','运行时随机文本不能用固定字符串或前缀作精确值断言',step.expected);
    if(step.action==='click'&&!test.steps.slice(si+1).some(s=>s.action.startsWith('assert')))capability(path,'UNSUPPORTED_ACTION','操作后没有行为断言，不能将仅执行动作记为完整计划',step.target);
  }
  const coverage:RequirementCoverage[]=spec.requirements.map(r=>{
    if(tests.some(t=>t.requirementId===r.id))return {requirementId:r.id,status:'PLANNED',reason:'NOT_EXECUTED',explanation:'候选计划已校验并绑定此版本；尚未执行浏览器验证'};
    const c=omitted.get(r.id);if(!c)throw new AppError('INVALID_CONTRACT','缺少需求覆盖说明',400,{module:'TestPlan',path:'$.coverage',rule:'COVERAGE_MISSING',actual:r.id});
    if(r.verificationMode==='MANUAL'&&c.reason!=='MANUAL_REVIEW_REQUIRED'||r.verificationMode==='UNSUPPORTED'&&c.reason!=='UNSUPPORTED_ACTION')throw new AppError('INVALID_CONTRACT','覆盖说明不得改变需求原验证方式',400,{module:'TestPlan',path:'$.coverage',rule:'COVERAGE_MODE',actual:r.id});
    return {requirementId:r.id,status:'UNVERIFIED',...c};
  });
  return {tests,coverage,state:tests.length===0?'UNAVAILABLE' as const:tests.length===spec.requirements.length?'VALID' as const:'PARTIAL' as const};
}
// Only repair structure when the first response already defines an unambiguous
// requirement core. Unknown priorities/modes require visible user clarification.
export function specificationRepairCore(value:any){
  if(!Array.isArray(value?.requirements)||!value.requirements.length||value.requirements.length>8)return null;
  const ids=new Set<string>(),core=[];
  for(const r of value.requirements){if(!r||!/^R[1-8]$/.test(r.id)||ids.has(r.id)||typeof r.text!=='string'||!r.text.trim()||typeof r.acceptance!=='string'||!r.acceptance.trim()||!['MUST','SHOULD'].includes(r.priority)||!['AUTOMATED','MANUAL','UNSUPPORTED'].includes(r.verificationMode))return null;ids.add(r.id);core.push({id:r.id,text:r.text,priority:r.priority,acceptance:r.acceptance,verificationMode:r.verificationMode});}
  return core;
}
