import ts from 'typescript';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {appRoot} from './config.ts';
import {locatorInventory} from './planning.ts';
import type {AppVersion,Specification} from '../shared/contracts.ts';
import {parseProposal,reject,ProtocolError,canonicalBytes} from '../shared/protocol-v11.mjs';
import {canonicalHash,sha} from '../../../../spikes/m0-5-tsx-runtime/src/shared.mjs';
export const policyVersion='m2-b-local-state-2';
export const runnerVersion='m2-b-v11-2';
export const documentHash=(value:unknown)=>canonicalHash({'document.json':canonicalBytes(value)});
export interface TargetV11 {id:string;bindingId:string;tag:string;type:string|null;file:string;line:number;duplicate:boolean;pattern:boolean;options:{ref:string;label:string}[];optionsStatic:boolean;interactive:boolean;effectAllowed:boolean;}
export interface InventoryV11 {protocolVersion:'1.1';appVersionId:string;sourceSha256:string;buildSha256:string;configSha256:string;targets:TargetV11[];effects:{allowed:boolean;reasons:string[]};unsupportedDeclarations:number;inventoryHash:string;}
export type AuthorizationV11={protocolVersion:'1.1';policyVersion:string;runnerVersion:string;runnerSha256:string;parserSha256:string;imageId:string;authorizationId:string;specId:string;appVersionId:string;testPlanId:string;sourceSha256:string;buildSha256:string;configSha256:string;targetInventoryHash:string;expandedCost:number;authorizedTests:any[];canonicalAuthorizationHash:string};
export type AuditV11={decision:'ALLOW'|'DENY'|'REVIEW_REQUIRED';proposal:any|null;inventory:InventoryV11;authorization:AuthorizationV11|null;diagnostics:any[];expandedCost:number;coverage:any[]};
// An intentionally narrow local-state subset. Unknown effects are REVIEW, even
// when the old compiler accepted the code. This never grants browser isolation.
export function inventoryV11(v:AppVersion):InventoryV11{
  const old=locatorInventory(v),reasons=new Set<string>(),locals=new Set<string>(),setters=new Set<string>(),localArrays=new Set<string>();let unsupportedDeclarations=0;
  const asts=v.files.filter(f=>f.path.endsWith('.tsx')).map(f=>({f,ast:ts.createSourceFile(f.path,f.content,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)}));
  for(const {ast} of asts){function declarations(n:ts.Node){if(ts.isFunctionDeclaration(n)&&n.name)locals.add(n.name.text);if(ts.isVariableDeclaration(n)){if(ts.isIdentifier(n.name)&&n.initializer&&ts.isArrayLiteralExpression(n.initializer))localArrays.add(n.name.text);if(ts.isIdentifier(n.name)&&n.initializer&&(ts.isArrowFunction(n.initializer)||ts.isFunctionExpression(n.initializer)))locals.add(n.name.text);if(ts.isArrayBindingPattern(n.name)&&n.initializer&&ts.isCallExpression(n.initializer)&&n.initializer.expression.getText(ast)==='useState'){const s=n.name.elements[1];if(s&&ts.isBindingElement(s)&&ts.isIdentifier(s.name))setters.add(s.name.text);}}ts.forEachChild(n,declarations);}declarations(ast);}
  const pureMethods=new Set(['trim','map','filter','reduce','toFixed','test']);
  const banned=new Set(['window','document','globalThis','self','parent','top','location','navigator','localStorage','sessionStorage','indexedDB','fetch','XMLHttpRequest','WebSocket','Worker','Function','eval','open','setTimeout','setInterval','queueMicrotask','requestAnimationFrame','console']);
  for(const {ast} of asts){function effects(n:ts.Node){
    if(ts.isIdentifier(n)&&banned.has(n.text))reasons.add('FORBIDDEN_EFFECT:'+n.text);
    if(ts.isJsxAttribute(n)&&n.name.getText(ast)==='ref')reasons.add('DOM_REF_EFFECT');
    if(ts.isElementAccessExpression(n)||ts.isNewExpression(n)||ts.isAwaitExpression(n)||ts.isTaggedTemplateExpression(n)||ts.isGetAccessor(n)||ts.isSetAccessor(n)||ts.isSpreadAssignment(n)&&!ts.isIdentifier(n.expression))reasons.add('UNKNOWN_COMPUTED_EFFECT');
    if(ts.isPropertyAccessExpression(n)&&['constructor','prototype','__proto__'].includes(n.name.text))reasons.add('PROTOTYPE_EFFECT');
    if(ts.isImportDeclaration(n)&&n.moduleSpecifier.getText(ast)!=="'react'"&&n.moduleSpecifier.getText(ast)!=='"react"'&&!n.moduleSpecifier.getText(ast).includes('styles.css'))reasons.add('UNSUPPORTED_MODULE');
    if(ts.isCallExpression(n)){const e=n.expression;let allowed=false;if(ts.isIdentifier(e))allowed=locals.has(e.text)||setters.has(e.text)||['useState','Number','isFinite','isNaN'].includes(e.text);else if(ts.isPropertyAccessExpression(e))allowed=pureMethods.has(e.name.text)||e.name.text==='push'&&localArrays.has(e.expression.getText(ast))||e.getText(ast)==='Math.round'||e.name.text==='preventDefault'&&['event','e'].includes(e.expression.getText(ast));if(!allowed)reasons.add('UNKNOWN_CALL:'+e.getText(ast).slice(0,80));}
    ts.forEachChild(n,effects);
  }effects(ast);}
  const targets:TargetV11[]=old.targets.map(t=>({...t,bindingId:'',options:[],optionsStatic:t.tag!=='select',interactive:false,effectAllowed:false}));
  for(const {f,ast} of asts){function visit(n:ts.Node){if(ts.isJsxOpeningElement(n)||ts.isJsxSelfClosingElement(n)){
    const attrs=n.attributes.properties,literal=(key:string)=>{const a=attrs.find(a=>ts.isJsxAttribute(a)&&a.name.getText(ast)===key);return a&&ts.isJsxAttribute(a)&&a.initializer&&ts.isStringLiteral(a.initializer)?a.initializer.text:null;},has=(key:string)=>attrs.some(a=>ts.isJsxAttribute(a)&&a.name.getText(ast)===key);
    if(has('data-testid')&&(!literal('data-testid')||attrs.some(a=>ts.isJsxSpreadAttribute(a))))unsupportedDeclarations++;
    const t=targets.find(t=>t.id===literal('data-testid')&&t.file===f.path&&t.line===ast.getLineAndCharacterOfPosition(n.getStart(ast)).line+1);
    if(t){if(has('type')&&!literal('type'))t.type='DYNAMIC_UNSUPPORTED';t.interactive=t.tag==='button'&&t.type==='button'&&!['formAction','formTarget','download','href'].some(has)||t.tag==='input'&&t.type==='checkbox';t.effectAllowed=reasons.size===0&&t.interactive;
      if(t.tag==='select'&&ts.isJsxOpeningElement(n)&&ts.isJsxElement(n.parent)){const children=n.parent.children.filter(c=>!ts.isJsxText(c)||c.text.trim());t.optionsStatic=children.length>0&&children.every(c=>ts.isJsxElement(c)&&c.openingElement.tagName.getText(ast)==='option'&&!c.openingElement.attributes.properties.some(a=>ts.isJsxSpreadAttribute(a)));if(t.optionsStatic)for(const c of children as ts.JsxElement[]){const a=c.openingElement.attributes.properties.find(a=>ts.isJsxAttribute(a)&&a.name.getText(ast)==='value');if(!a||!ts.isJsxAttribute(a)||!a.initializer||!ts.isStringLiteral(a.initializer)||!/^[a-zA-Z0-9_-]{1,64}$/.test(a.initializer.text)||c.children.some(x=>!ts.isJsxText(x))){t.optionsStatic=false;break;}t.options.push({ref:a.initializer.text,label:c.children.map(c=>c.getText(ast).trim()).join('')});}if(new Set(t.options.map(o=>o.ref)).size!==t.options.length)t.optionsStatic=false;}
    }
  }ts.forEachChild(n,visit);}visit(ast);}
  for(const t of targets)t.bindingId=documentHash(t);
  const body={protocolVersion:'1.1' as const,appVersionId:v.id,sourceSha256:v.sourceSha256,buildSha256:v.buildSha256!,configSha256:v.configSha256,targets,effects:{allowed:!reasons.size,reasons:[...reasons].sort()},unsupportedDeclarations};return {...body,inventoryHash:documentHash(body)};
}
export async function runnerIdentity(imageId:string){return {runnerVersion,runnerSha256:sha(await readFile(join(appRoot,'src/validator/v11-worker.mjs'))),parserSha256:sha(await readFile(join(appRoot,'src/shared/protocol-v11.mjs'))),imageId};}
export function auditV11(value:unknown,spec:Specification,v:AppVersion,inventory:InventoryV11,testPlanId:string,identity:{runnerVersion:string;runnerSha256:string;parserSha256:string;imageId:string}):AuditV11{
  let proposal:any=null,expandedCost=0;const diagnostics:any[]=[],coverage=spec.requirements.map(r=>({requirementId:r.id,reason:r.verificationMode==='AUTOMATED'?'NOT_COVERED':r.verificationMode==='MANUAL'?'MANUAL_REVIEW_REQUIRED':'UNSUPPORTED_ACTION',explanation:'原始验收尚未完整验证',acceptance:r.acceptance}));
  try{
    proposal=parseProposal(value);
    for(const k of ['specId','appVersionId','sourceSha256','buildSha256','configSha256']){const expected=k==='specId'?spec.specId:k==='appVersionId'?v.id:(v as any)[k];if(proposal[k]!==expected)reject('BINDING_MISMATCH','$.'.concat(k),proposal[k],expected);}
    if(spec.projectId!==v.projectId||spec.specId!==v.specId||inventory.appVersionId!==v.id||inventory.sourceSha256!==v.sourceSha256||inventory.buildSha256!==v.buildSha256||inventory.configSha256!==v.configSha256)reject('BINDING_MISMATCH','$.inventory',null,'same immutable version');
    const {inventoryHash,...inventoryBody}=inventory;if(documentHash(inventoryBody)!==inventoryHash)reject('BINDING_MISMATCH','$.inventoryHash',inventoryHash,'actual inventory hash');
    const authorizedTests:any[]=[],used=new Set<string>();
    const check=(steps:any[],r:any,path:string,phase:string)=>steps.map((step,i)=>{
      const p=`${path}[${i}]`;if(!r||r.verificationMode!=='AUTOMATED')reject('REQUIREMENT_SCOPE',p,r?.id,'AUTOMATED frozen requirement');
      if(!r.targetHints?.includes(step.target))reject('TARGET_SCOPE',p+'.target',step.target,r.targetHints||[]);
      const target=inventory.targets.find(t=>t.id===step.target);if(!target)reject('MISSING_TARGET_BINDING',p+'.target',step.target,'static literal target',true);if(target.duplicate)reject('AMBIGUOUS_TARGET',p+'.target',step.target,'unique declaration',true);
      if(step.action==='fill'){if(target.pattern||!(target.tag==='textarea'||target.tag==='input'&&['text','email','number','search'].includes(target.type||'')))reject('UNSUPPORTED_TARGET_TYPE',p,target,'text/number/email/textarea',true);if(target.type==='number'&&!['RUN_POSITIVE_AMOUNT_A','RUN_POSITIVE_AMOUNT_B','EMPTY_STRING'].includes(step.dataRef)||target.type==='email'&&!['RUN_VALID_EMAIL','RUN_INVALID_EMAIL','EMPTY_STRING'].includes(step.dataRef))reject('INPUT_DATA_TYPE',p,step.dataRef,target.type);}
      if(step.action==='assertInputValue'&&!['input','textarea'].includes(target.tag))reject('UNSUPPORTED_TARGET_TYPE',p,target,'input/textarea',true);
      if(step.action==='assertChecked'&&!(target.tag==='input'&&target.type==='checkbox'))reject('UNSUPPORTED_TARGET_TYPE',p,target,'checkbox',true);
      if(step.action==='selectOption'&&(!target.optionsStatic||target.tag!=='select'||!target.options.some(o=>o.ref===step.optionRef)))reject('UNSUPPORTED_TARGET_TYPE',p,step.optionRef,target.options,true);
      if(['click','fill','selectOption'].includes(step.action)&&!inventory.effects.allowed)reject('UNKNOWN_SIDE_EFFECT',p,inventory.effects.reasons,'bounded local state',true);
      if(step.action==='click'&&!target.effectAllowed)reject('UNSUPPORTED_CLICK',p,target,'type=button or checkbox; audited local state',true);
      if(['click','fill','selectOption'].includes(step.action)&&(!steps.slice(i+1).some(s=>s.action.startsWith('assert'))))reject('MISSING_POSTSTATE',p,step,'following assertion',true);
      if(step.action.startsWith('assert')&&step.expectedText&&steps.slice(0,i).some(s=>s.action==='fill'&&s.target===step.target))reject('FIXED_RANDOM_EXPECTATION',p,step.expectedText,'expectedRef or empty string');
      return {phase,step,targetBindingId:target.bindingId};
    });
    for(const [i,test] of proposal.tests.entries()){
      const r=spec.requirements.find(r=>r.id===test.requirementId),p=`$.tests[${i}]`;if(!r)reject('REQUIREMENT_SCOPE',p,test.requirementId,'frozen requirement');if(!r!.acceptance.includes(test.acceptanceClaim))reject('ACCEPTANCE_CLAIM',p+'.acceptanceClaim',test.acceptanceClaim,'exact frozen acceptance fragment');
      const own=check(test.steps,r,p+'.steps','TEST');if(!own.some(s=>s.step.action.startsWith('assert')))reject('NO_TEST_ASSERTION',p,null,'own behavior assertion',true);
      if(own.some(s=>['click','fill','selectOption'].includes(s.step.action))&&!own[0].step.action.startsWith('assert'))reject('MISSING_PRESTATE',p,null,'observable initial assertion',true);
      let setup:any[]=[],sourceId:string|undefined;
      if(test.setupRef){const bundle=proposal.setupBundles.find((s:any)=>s.id===test.setupRef);if(!bundle)reject('SETUP_REFERENCE',p+'.setupRef',test.setupRef,'existing one-layer setup');used.add(test.setupRef);sourceId=bundle.sourceRequirementId;if(sourceId===r!.id)reject('SETUP_SELF_DEPENDENCY',p,sourceId,'another source requirement');const source=spec.requirements.find(r=>r.id===sourceId);setup=check(bundle.steps,source,`$.setupBundles[${proposal.setupBundles.indexOf(bundle)}].steps`,'SETUP');
        const s=bundle.steps,first=s[0],last=s.at(-1),middle=s.slice(1,-1),create=first.action==='assertCount'&&first.expected===0&&last.action==='assertCount'&&last.expected===1&&first.target===last.target&&middle.length>=2&&middle.at(-1).action==='click'&&middle.slice(0,-1).every((x:any)=>['fill','selectOption'].includes(x.action))&&middle.some((x:any)=>x.action==='fill')&&inventory.targets.find(t=>t.id===middle.at(-1).target)?.tag==='button';
        if(!create)reject('UNSUPPORTED_SETUP_CAPABILITY',p+'.setupRef',s,'zero rows; typed inputs/static selects; one button; one row',true);
        // A deletion setup cannot precede this template. Completion establishes
        // exactly one local row, observed again by the TEST in its own scope.
        if(test.steps[0].action!=='assertCount'||test.steps[0].target!==first.target||test.steps[0].expected!==1)reject('SETUP_STATE_CONFLICT',p+'.steps[0]',test.steps[0],'test asserts same one-row prestate',true);
      }
      // Explicit, small adequacy registry. Exact frozen acceptance + structural
      // oracle, never an LLM completeness score or a general language proof.
      const s=test.steps,mutations=s.filter((x:any)=>['fill','click','selectOption'].includes(x.action)),first=s[0],last=s.at(-1);
      const removal=['点击删除按钮后，对应任务项从列表中消失。','Remove the row.'].includes(r!.acceptance)&&setup.length>0&&first.action==='assertCount'&&first.expected===1&&last.action==='assertCount'&&last.expected===0&&first.target===last.target&&mutations.length===1&&mutations[0].action==='click'&&inventory.targets.find(t=>t.id===mutations[0].target)?.tag==='button';
      const empty=r!.acceptance==='页面加载后任务列表区域无任务项。'&&!setup.length&&!mutations.length&&s.some((x:any)=>x.action==='assertCount'&&x.expected===0&&inventory.targets.find(t=>t.id===x.target)?.tag==='li')&&s.every((x:any)=>x.action==='assertVisible'||x.action==='assertCount'&&x.expected===0);
      const adequacy=removal||empty?'FULL_ATOMIC_TEMPLATE':'PARTIAL_ACCEPTANCE',adequacyRule=removal?'SINGLE_RECORD_REMOVAL_1':empty?'INITIAL_EMPTY_LIST_1':'FINITE_SAMPLE_ONLY';
      const expandedSteps=[...setup,...own];expandedCost+=expandedSteps.length;authorizedTests.push({requirementId:r!.id,acceptanceClaim:test.acceptanceClaim,adequacy,adequacyRule,uncoveredAcceptance:adequacy==='PARTIAL_ACCEPTANCE'?r!.acceptance:'',...(sourceId?{setupSourceRequirementId:sourceId}:{}),expandedSteps});
    }
    if(used.size!==proposal.setupBundles.length)reject('UNUSED_SETUP','$.setupBundles',proposal.setupBundles.length,used.size);
    if(expandedCost>20)reject('STEP_BUDGET_EXCEEDED','$.tests',expandedCost,20);
    for(const c of proposal.coverage||[]){if(!spec.requirements.some(r=>r.id===c.requirementId))reject('COVERAGE_REFERENCE','$.coverage',c.requirementId,'frozen requirement');if(c.reason==='STEP_BUDGET_EXCEEDED')diagnostics.push({module:'TestPlanV11',rule:'COVERAGE_REASON_INCONSISTENT',path:'$.coverage',actual:{expandedCost,limit:20,claim:c},expected:'program-evidenced excluded-test cost; model claim not accepted'});}
    const body={protocolVersion:'1.1' as const,policyVersion,...identity,authorizationId:randomUUID(),specId:spec.specId,appVersionId:v.id,testPlanId,sourceSha256:v.sourceSha256,buildSha256:v.buildSha256!,configSha256:v.configSha256,targetInventoryHash:inventory.inventoryHash,expandedCost,authorizedTests};
    return {decision:'ALLOW',proposal,inventory,authorization:{...body,canonicalAuthorizationHash:documentHash(body)},expandedCost,diagnostics,coverage};
  }catch(e:any){if(!(e instanceof ProtocolError))throw e;return {decision:e.review?'REVIEW_REQUIRED':'DENY',proposal,inventory,authorization:null,diagnostics:[...diagnostics,e.issue],expandedCost,coverage:coverage.map(c=>({...c,reason:e.issue.rule,explanation:e.message}))};}
}
export function verifyAuthorization(a:AuthorizationV11,inventory:InventoryV11){const {canonicalAuthorizationHash,...body}=a;if(a.protocolVersion!=='1.1'||a.policyVersion!==policyVersion||a.runnerVersion!==runnerVersion||a.targetInventoryHash!==inventory.inventoryHash||documentHash(body)!==canonicalAuthorizationHash||a.expandedCost!==a.authorizedTests.reduce((n,t)=>n+t.expandedSteps.length,0)||a.expandedCost>20)reject('BINDING_MISMATCH','$.authorization',null,'exact authorization hash/identity/budget');}
