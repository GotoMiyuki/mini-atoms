import {createServer,request as httpRequest} from 'node:http';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {timingSafeEqual,createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Store} from './store.ts';
import {Provider} from './provider.ts';
import {Runtime} from './runtime.ts';
import {Orchestrator} from './orchestrator.ts';
import {appRoot} from './config.ts';
import {AppError,object,text,specDraft,planDraft} from '../shared/contracts.ts';
import {verificationLimits} from '../shared/verification.ts';
import {evidenceView,evidenceDemos} from './evidence-view.ts';
import {adaptPreviewCsp,presentationPath} from './preview-presentation.ts';
import {InteractiveGrant} from './interactive-grant.mjs';
import type {Specification,TestPlan} from '../shared/contracts.ts';
import type {configuration} from './config.ts';
const digest=(s:string)=>createHash('sha256').update(s).digest();
async function body(request:IncomingMessage){if(request.headers['content-type']?.split(';')[0]!=='application/json')throw new AppError('CONTENT_TYPE','请求须使用 application/json',415);let bytes=0;const chunks:Buffer[]=[];for await(const chunk of request){bytes+=chunk.length;if(bytes>65536)throw new AppError('BODY_LIMIT','请求超过 64 KiB',413);chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString());}catch{throw new AppError('INVALID_JSON','JSON 格式无效');}}
function send(response:ServerResponse,status:number,value:unknown,headers:Record<string,string>={}){response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...headers});response.end(JSON.stringify(value));}
// Transport adapter only: the unchanged M0.5 server decides CSP, metadata,
// paths, methods and top-level denial. Native HTTP preserves Fetch Metadata.
// No credentials/cookies/user upstream. HTTPS maps only exact version-bound CSP URLs.
function previewTransport(request:IncomingMessage,response:ServerResponse,host:string,config:ReturnType<typeof configuration>,runtime:Runtime){
  if(config.origin.startsWith('https://')){presentationPath(request.url||'');if(request.method!=='GET')throw new AppError('METHOD','预览仅允许 GET',405);}
  const headers:Record<string,string>={host};for(const key of ['sec-fetch-dest','sec-fetch-mode','sec-fetch-site'])if(typeof request.headers[key]==='string')headers[key]=request.headers[key];
  const upstream=httpRequest({hostname:'127.0.0.1',port:8092,path:request.url,method:request.method,headers},incoming=>{
    const chunks:Buffer[]=[];let size=0;
    incoming.on('data',chunk=>{if((size+=chunk.length)>1048576)incoming.destroy(new Error('Static output limit'));else chunks.push(chunk);});
    incoming.once('error',()=>{if(!response.headersSent)send(response,502,{code:'PREVIEW_UNAVAILABLE',error:'预览服务不可用'});});
    incoming.once('end',()=>{void(async()=>{try{let outgoing:Record<string,string>={};for(const key of ['content-type','content-security-policy','cache-control','vary','x-content-type-options','x-dns-prefetch-control','x-m0-5-build-sha256','x-m0-5-source-sha256'])if(incoming.headers[key])outgoing[key]=String(incoming.headers[key]);const bytes=Buffer.concat(chunks);outgoing=await adaptPreviewCsp({path:request.url||'',origin:config.origin,backendHost:host,dataRoot:config.dataRoot,configSha256:runtime.lock.configSha256,status:incoming.statusCode||502,headers:outgoing,bytes});response.writeHead(incoming.statusCode||502,outgoing);response.end(bytes);}catch{if(!response.headersSent)send(response,503,{code:'PREVIEW_BOUNDARY',error:'预览来源、CSP 或版本身份不匹配'});}})();});
  });
  upstream.setTimeout(4000,()=>upstream.destroy(new Error('timeout')));upstream.once('error',()=>{if(!response.headersSent)send(response,502,{code:'PREVIEW_UNAVAILABLE',error:'预览服务不可用'});});upstream.end();
}
export function createApp(config:ReturnType<typeof configuration>,store:Store,runtime:Runtime,provider:Provider,interactiveOptions:any=null){
  const owner=digest(config.token).toString('hex'),orchestrator=new Orchestrator(store,runtime,provider,owner,config.maxDaily);
  const interactive=interactiveOptions?new InteractiveGrant({store,orchestrator,...interactiveOptions}):null;orchestrator.interactive=interactive;
  const server=createServer(async(request,response)=>{
    try{
      if(request.headers.host!==`127.0.0.1:${config.port}`)throw new AppError('HOST_REJECTED','请求来源无效',403);
      if(request.headers.origin&&request.headers.origin!==config.origin)throw new AppError('ORIGIN_REJECTED','跨站请求被拒绝',403);
      const url=new URL(request.url||'/',config.origin),path=url.pathname,method=request.method||'GET';
      if(['/preview/','/harness/','/builds/'].some(prefix=>path.startsWith(prefix)))return previewTransport(request,response,`127.0.0.1:${config.port}`,config,runtime);
      if(path==='/healthz'&&method==='GET')return send(response,200,{status:'ok',milestone:'M2-C'});
      if(path.startsWith('/api/')){
        const supplied=request.headers.authorization||'';
        if(!timingSafeEqual(digest(supplied),digest(`Bearer ${config.token}`)))throw new AppError('UNAUTHORIZED','请输入本机访问令牌',401);
        if(url.search)throw new AppError('QUERY_REJECTED','此 API 不接受查询参数');
        const internal=/^\/api\/interactive-grants\/([a-f0-9-]{36})\/(register|heartbeat|revoke|catalog)$/.exec(path);
        if(internal){if(!interactive)throw new AppError('INTERACTIVE_DISABLED','交互模式未配置',503);const [,id,command]=internal;if(command==='catalog'&&method==='GET')return send(response,200,await interactive.catalog(id));if(method!=='POST')throw new AppError('METHOD','方法不允许',405);const b=await body(request);if(command==='register'){object(b,['expiresAt']);return send(response,200,interactive.register(id,b.expiresAt));}object(b,[]);return send(response,200,command==='heartbeat'?interactive.heartbeat(id):command==='revoke'?interactive.revoke(id):(()=>{throw new AppError('METHOD','方法不允许',405);})());}
        if(method==='POST'&&interactive){const grant=request.headers['x-mini-atoms-grant'];if(grant!==undefined){if(typeof grant!=='string')throw new AppError('INTERACTIVE_GRANT','交互授权无效',403);const result=await interactive.action(grant,path,await body(request));return send(response,result.status,result.value);}if(interactive.ownsProtectedPath(path))throw new AppError('INTERACTIVE_GRANT_REQUIRED','演示项目必须经受控交互授权',403);}
        if(path==='/api/status'&&method==='GET')return send(response,200,{milestone:'M2-C',apiVersion:'M1.1',verificationApiVersion:'M2-B',evidencePresentationVersion:'M2-C-1',evidenceDemos:evidenceDemos(store,owner),verificationProtocols:['0.1','1.1'],protocolRunners:{'0.1':'FROZEN_M05_WORKER','1.1':'EXPLICIT_AUTHORIZED_TYPED_RUNNER'},llmConfigured:provider.ready(),model:provider.settings.model||null,validation:'ISOLATED_WORKER_V0.1',quota:store.quota(config.maxDaily),limits:{dailyJobs:config.maxDaily,queue:8,totalJobSeconds:180,contractCorrections:1,verification:verificationLimits},runtime:{contract:'trusted-shell-v1',image:runtime.lock.imageId}});
        if(path==='/api/projects'&&method==='GET')return send(response,200,store.projects(owner));
        if(path==='/api/projects'&&method==='POST'){const b=object(await body(request),['name']);return send(response,201,store.createProject(owner,text(b.name,80)));}
        let match=/^\/api\/runs\/([a-f0-9-]{36})(\/evidence|\/cancel)?$/.exec(path);
        if(match){const run=store.runRecord(match[1],owner);if(method==='GET'&&!match[2])return send(response,200,{...store.runDetail(run.id,owner),apiVersion:run.testProtocolVersion==='1.1'?'M2-B':'M2-A',presentation:evidenceView(store,owner,run.appVersionId,run)});if(method==='GET'&&match[2]==='/evidence')return send(response,200,store.evidenceIndex(run.id,owner));if(method==='POST'&&match[2]==='/cancel'){object(await body(request),[]);orchestrator.cancel(run.jobId);return send(response,202,store.runDetail(run.id,owner));}}
        match=/^\/api\/evidence\/([a-f0-9-]{36})$/.exec(path);
        if(match&&method==='GET'){const {file,bytes}=await orchestrator.verifier.readEvidence(match[1]),png=file.path.endsWith('.png'),zip=file.path.endsWith('.zip');response.writeHead(200,{'content-type':png?'image/png':zip?'application/zip':'application/json; charset=utf-8','content-disposition':`${png?'inline':'attachment'}; filename="${file.id}.${png?'png':zip?'zip':'json'}"`,'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox",'x-evidence-sha256':file.sha256});return response.end(bytes);}
        match=/^\/api\/versions\/([a-f0-9-]{36})\/verification-runs$/.exec(path);if(match&&method==='GET')return send(response,200,store.runs(match[1],owner));
        match=/^\/api\/projects\/([a-f0-9-]{36})$/.exec(path);
        if(match&&method==='GET')return send(response,200,store.detail(match[1],owner));
        match=/^\/api\/projects\/([a-f0-9-]{36})\/specifications$/.exec(path);
        if(match&&method==='POST'){
          store.project(match[1],owner);
          const b=object(await body(request),['prompt','revisionOf','draft','tests'],[]);
          if(b.revisionOf){
            if(b.prompt!==undefined)throw new AppError('INVALID_CONTRACT','修订不得替换原始需求');
            const prior=store.spec(text(b.revisionOf,36),owner);if(prior.projectId!==match[1])throw new AppError('NOT_FOUND','需求不属于此项目',404);
            if(b.tests!==undefined)throw new AppError('API_CONTRACT_CHANGED','M1.1 需求修订仅保存 Spec；验证计划在构建后独立规划');
            const draft=specDraft(b.draft),createdAt=new Date().toISOString(),specId=randomUUID();
            const spec:Specification={...prior,...draft,specId,createdAt};store.saveSpec(spec);return send(response,201,{apiVersion:'M1.1',specification:spec,testPlan:null,planningState:'NOT_STARTED'});
          }
          if(Object.keys(b).join(',')!=='prompt')throw new AppError('INVALID_CONTRACT','请输入 prompt');
          return send(response,202,{...orchestrator.enqueue(match[1],null,'SPECIFY',{prompt:text(b.prompt,8000,3)}),apiVersion:'M1.1'});
        }
        match=/^\/api\/specifications\/([a-f0-9-]{36})\/generate$/.exec(path);
        if(match&&method==='POST'){const b=object(await body(request),['planVerification'],[]);if(b.planVerification!==undefined&&typeof b.planVerification!=='boolean')throw new AppError('INVALID_CONTRACT','planVerification 须为布尔值');const spec=store.spec(match[1],owner);return send(response,202,orchestrator.enqueue(spec.projectId,spec.specId,'GENERATE',{planVerification:b.planVerification!==false}));}
        match=/^\/api\/jobs\/([a-f0-9-]{36})(\/cancel|\/diagnostics|\/recover-specification)?$/.exec(path);
        if(match&&method==='GET'&&!match[2])return send(response,200,store.job(match[1],owner));
        if(match&&method==='POST'&&match[2]==='/cancel'){object(await body(request),[]);store.job(match[1],owner);return send(response,202,orchestrator.cancel(match[1]));}
        if(match&&method==='GET'&&match[2]==='/diagnostics'){
          store.job(match[1],owner);const attempts=store.db.prepare('SELECT r.document FROM model_call_results r JOIN model_call_slots s ON s.id=r.slot_id WHERE s.job_id=? ORDER BY s.attempt').all(match[1]).map((row:any)=>{const d=JSON.parse(row.document);return {attempt:d.attempt,rawSha256:d.rawSha256,receipt:d.receipt,error:d.error};});
          let legacy=null;try{legacy=JSON.parse(await readFile(join(config.dataRoot,'jobs',match[1],'contract-diagnostic.json'),'utf8'));}catch{}return send(response,200,{attempts,legacy});
        }
        if(match&&method==='POST'&&match[2]==='/recover-specification'){
          object(await body(request),[]);const job=store.job(match[1],owner);
          if(job.kind!=='SPECIFY'||job.task==='PLAN'||job.state!=='ERROR'||job.specId)throw new AppError('RECOVERY_UNAVAILABLE','仅可恢复已有失败规划中保存的合法需求',409);
          const existing=store.recoveredSpec(job.id,owner);if(existing)return send(response,200,{apiVersion:'M1.1',specification:existing,testPlan:null,planningState:'NOT_STARTED',reused:true});
          let bytes:Buffer;try{bytes=await readFile(join(config.dataRoot,'jobs',job.id,'model-output.json'));}catch{throw new AppError('RECOVERY_UNAVAILABLE','没有保存原模型 JSON，无法安全恢复需求',409);}
          const raw=object(JSON.parse(bytes.toString()),['assumptions','requirements','unsupported','tests']);const draft=specDraft({assumptions:raw.assumptions,requirements:raw.requirements,unsupported:raw.unsupported});
          const payload=JSON.parse((store.db.prepare('SELECT payload FROM job_records WHERE id=?').get(job.id) as any).payload),spec:Specification={schemaVersion:'0.1',specId:randomUUID(),projectId:job.projectId,sourcePrompt:payload.prompt,...draft,createdAt:new Date().toISOString()};
          let diagnostic=null;try{planDraft(raw.tests,draft.requirements);}catch(error:any){diagnostic=error.issue||{message:error.message};}
          store.saveSpec(spec,null,{sourceJobId:job.id,rawSha256:createHash('sha256').update(bytes).digest('hex')});return send(response,201,{apiVersion:'M1.1',specification:spec,testPlan:null,planningState:'NOT_STARTED',legacyPlanDiagnostic:diagnostic,reused:false});
        }
        match=/^\/api\/versions\/([a-f0-9-]{36})(\/build-log|\/accept|\/verify|\/planning|\/plan-verification)?$/.exec(path);
        if(match){
          const v=store.version(match[1],owner);
          if(method==='GET'&&!match[2])return send(response,200,{...v,previewUrl:v.buildStatus==='SUCCEEDED'?`/preview/${v.runtimeVersionId}`:null,verificationStatus:'UNVERIFIED',planning:store.planning(v,store.spec(v.specId,owner)),verificationRuns:store.runs(v.id,owner)});
          if(method==='GET'&&match[2]==='/planning')return send(response,200,{...store.planning(v,store.spec(v.specId,owner)),selectedProtocol:store.protocolSelection(v.id),v11:store.v11Record(v.id),presentation:evidenceView(store,owner,v.id)});
          if(method==='POST'&&match[2]==='/plan-verification'){const b=object(await body(request),['protocolVersion'],[]);if(b.protocolVersion!==undefined&&b.protocolVersion!=='1.1')throw new AppError('INVALID_CONTRACT','新协议选择仅接受显式1.1');const result=b.protocolVersion==='1.1'?orchestrator.requestPlanningV11(v):orchestrator.requestPlanning(v);if(b.protocolVersion===undefined)store.selectProtocol(v.id,'0.1',result.job?.id||null);return send(response,result.job&&['QUEUED','RUNNING'].includes(result.job.state)?202:200,result);}
          if(method==='GET'&&match[2]==='/build-log'){let log:string|null=null;try{if(v.buildLogRef)log=(await readFile(join(config.dataRoot,'jobs',v.buildLogRef),'utf8')).slice(0,65536);}catch{}return send(response,200,{log,missingReason:log===null?'编译器尚未产生日志或任务在编译前终止':null});}
          if(method==='POST'&&match[2]==='/accept'){object(await body(request),[]);if(v.buildStatus!=='SUCCEEDED')throw new AppError('NOT_READY','仅能接受已构建版本',409);store.db.prepare('INSERT OR IGNORE INTO human_acceptances VALUES (?,?,?)').run(v.id,owner,new Date().toISOString());return send(response,200,{accepted:true,verificationStatus:'UNVERIFIED'});}
          if(method==='POST'&&match[2]==='/verify'){object(await body(request),[]);const result=await orchestrator.requestVerification(v);return send(response,result.reused?200:202,{apiVersion:result.run.testProtocolVersion==='1.1'?'M2-B':'M2-A',runId:result.run.id,jobId:result.job.id,...result});}
        }
        throw new AppError('NOT_FOUND','API 不存在',404);
      }
      if(method!=='GET')throw new AppError('METHOD','方法不允许',405);
      if(path!=='/'&&!/^\/assets\/[A-Za-z0-9_.-]+\.(js|css)$/.test(path))throw new AppError('NOT_FOUND','页面不存在',404);
      const file=join(appRoot,'dist',path==='/'?'index.html':path.slice(1)),bytes=await readFile(file);
      response.writeHead(200,{'content-type':path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'self'; img-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors 'none'"});response.end(bytes);
    }catch(error:any){if(response.headersSent)return response.destroy();send(response,error instanceof AppError?error.status:500,{code:error instanceof AppError?error.code:'INTERNAL',error:error instanceof AppError?error.message:'请求处理失败',...(error instanceof AppError&&error.issue?{diagnostic:error.issue}:{})});}
  });
  server.requestTimeout=10000;server.headersTimeout=5000;
  return {server,orchestrator,owner};
}
