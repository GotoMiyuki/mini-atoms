// Shared strict parser: no generated code, URLs, selectors or authorization input.
export const dataRefs=Object.freeze(['RUN_UNIQUE_TEXT_A','RUN_UNIQUE_TEXT_B','RUN_POSITIVE_AMOUNT_A','RUN_POSITIVE_AMOUNT_B','RUN_VALID_EMAIL','RUN_INVALID_EMAIL','EMPTY_STRING']);
export const actions=Object.freeze(['fill','click','selectOption','assertVisible','assertAbsent','assertCount','assertTextContains','assertInputValue','assertChecked']);
// JSON document carried as one canonicalHash file-map entry. Reuse the pinned
// M0.5 hash framing, with recursively sorted JSON object keys (arrays ordered).
export function canonicalBytes(value){const sort=v=>Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;return JSON.stringify(sort(value));}
export class ProtocolError extends Error {constructor(rule,path,actual,expected,review=false){super(`${rule} at ${path}`);this.code='INVALID_CONTRACT';this.status=422;this.issue={module:'TestPlanV11',rule,path,actual,expected};this.review=review;}}
/** @returns {never} */
export const reject=(rule,path,actual,expected,review=false)=>{throw new ProtocolError(rule,path,actual,expected,review);};
export function exact(o,required,optional=[],path='$'){if(!o||typeof o!=='object'||Array.isArray(o))reject('OBJECT',path,typeof o,'object');for(const k of Object.keys(o))if(![...required,...optional].includes(k))reject('UNKNOWN_FIELD',`${path}.${k}`,k,'strict fields');for(const k of required)if(!Object.hasOwn(o,k))reject('MISSING_FIELD',`${path}.${k}`,null,k);return o;}
export function string(v,max,path,min=1){if(typeof v!=='string'||v.length<min||v.length>max)reject('STRING',path,typeof v,`${min}..${max}`);return v;}
const id=(v,path)=>{if(typeof v!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v))reject('ID',path,v,'uuid');};
const req=(v,path)=>{if(typeof v!=='string'||!/^R[1-8]$/.test(v))reject('REQUIREMENT_ID',path,v,'R1..R8');};
const target=(v,path)=>{if(typeof v!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(v))reject('TARGET',path,v,'literal testid');};
function ref(v,path){if(!dataRefs.includes(v))reject('DATA_REF',path,v,dataRefs);}
export function parseStep(v,path='$'){
  if(!actions.includes(v?.action))reject('ACTION',path+'.action',v?.action,actions);
  const field={fill:'dataRef',selectOption:'optionRef',assertCount:'expected',assertChecked:'expected'}[v.action];
  const text=['assertTextContains','assertInputValue'].includes(v.action);
  exact(v,['action','target',...(field?[field]:[])],['timeoutMs',...(text?['expectedText','expectedRef']:[])],path);target(v.target,path+'.target');
  if(v.timeoutMs!==undefined&&(!Number.isInteger(v.timeoutMs)||v.timeoutMs<100||v.timeoutMs>5000))reject('TIMEOUT',path+'.timeoutMs',v.timeoutMs,'100..5000');
  if(v.action==='fill')ref(v.dataRef,path+'.dataRef');
  if(v.action==='selectOption'){string(v.optionRef,64,path+'.optionRef');if(!/^[a-zA-Z0-9_-]+$/.test(v.optionRef))reject('OPTION_REF',path+'.optionRef',v.optionRef,'static bounded value');}
  if(v.action==='assertCount'&&(!Number.isInteger(v.expected)||v.expected<0||v.expected>100))reject('COUNT',path+'.expected',v.expected,'integer 0..100');
  if(v.action==='assertChecked'&&typeof v.expected!=='boolean')reject('CHECKED',path+'.expected',v.expected,'boolean');
  if(text){if(Object.hasOwn(v,'expectedText')===Object.hasOwn(v,'expectedRef'))reject('EXPECTED_XOR',path,null,'one of expectedText/expectedRef');if(Object.hasOwn(v,'expectedRef'))ref(v.expectedRef,path+'.expectedRef');else{string(v.expectedText,128,path+'.expectedText',0);if(/\$\{|\{\{|RUN_|m2v11-|@example\.invalid|[<>`]/.test(v.expectedText))reject('LITERAL_TEMPLATE',path+'.expectedText',v.expectedText,'bounded literal, no random templates');}}
  return structuredClone(v);
}
export function parseProposal(value){
  const encoded=JSON.stringify(value);if(encoded===undefined)reject('OBJECT','$',typeof value,'object');if(Buffer.byteLength(encoded)>65536)reject('SIZE','$',null,'<=64KiB');
  const v=exact(value,['protocolVersion','specId','appVersionId','sourceSha256','buildSha256','configSha256','setupBundles','tests'],['coverage']);
  if(v.protocolVersion!=='1.1')reject('PROTOCOL_VERSION','$.protocolVersion',v.protocolVersion,'1.1');id(v.specId,'$.specId');id(v.appVersionId,'$.appVersionId');for(const k of ['sourceSha256','buildSha256','configSha256'])if(typeof v[k]!=='string'||!/^[a-f0-9]{64}$/.test(v[k]))reject('HASH','$.'.concat(k),v[k],'sha256');
  if(!Array.isArray(v.setupBundles)||v.setupBundles.length>8||!Array.isArray(v.tests)||v.tests.length<1||v.tests.length>8)reject('PLAN_SIZE','$',null,'1..8 tests,0..8 setups');
  const seen=new Set();v.setupBundles.forEach((s,i)=>{const p=`$.setupBundles[${i}]`;exact(s,['id','sourceRequirementId','purpose','steps'],['capabilityTag'],p);target(s.id,p+'.id');if(seen.has(s.id))reject('DUPLICATE_SETUP',p,s.id,'unique');seen.add(s.id);req(s.sourceRequirementId,p+'.sourceRequirementId');string(s.purpose,500,p+'.purpose');if(s.capabilityTag!==undefined&&!['CREATE_TEST_RECORD','SELECT_TEST_ITEM'].includes(s.capabilityTag))reject('CAPABILITY_TAG',p,s.capabilityTag,'known tag');if(!Array.isArray(s.steps)||s.steps.length<1||s.steps.length>5)reject('SETUP_SIZE',p,null,'1..5');s.steps.forEach((x,j)=>parseStep(x,`${p}.steps[${j}]`));});
  seen.clear();v.tests.forEach((t,i)=>{const p=`$.tests[${i}]`;exact(t,['requirementId','acceptanceClaim','steps'],['setupRef'],p);req(t.requirementId,p+'.requirementId');if(seen.has(t.requirementId))reject('DUPLICATE_TEST',p,t.requirementId,'unique');seen.add(t.requirementId);string(t.acceptanceClaim,1000,p+'.acceptanceClaim');if(t.setupRef!==undefined)target(t.setupRef,p+'.setupRef');if(!Array.isArray(t.steps)||t.steps.length<1||t.steps.length>10)reject('TEST_SIZE',p,null,'1..10');t.steps.forEach((x,j)=>parseStep(x,`${p}.steps[${j}]`));});
  if(v.coverage!==undefined){if(!Array.isArray(v.coverage)||v.coverage.length>8)reject('COVERAGE_SIZE','$.coverage',null,'0..8');const ids=new Set();v.coverage.forEach((c,i)=>{const p=`$.coverage[${i}]`;exact(c,['requirementId','reason','explanation'],[],p);req(c.requirementId,p+'.requirementId');if(ids.has(c.requirementId)||seen.has(c.requirementId))reject('COVERAGE_REFERENCE',p,c.requirementId,'omitted unique requirement');ids.add(c.requirementId);if(!['UNSUPPORTED_ACTION','STEP_BUDGET_EXCEEDED','MANUAL_REVIEW_REQUIRED','PARTIAL_ACCEPTANCE','UNSUPPORTED_SETUP_CAPABILITY'].includes(c.reason))reject('COVERAGE_REASON',p,c.reason,'known reason');string(c.explanation,1000,p+'.explanation');});}
  return structuredClone(v);
}
