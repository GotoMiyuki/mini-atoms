import {createServer as tlsServer} from 'node:https';
import {createServer as controlServer} from 'node:http';
import {createHash,timingSafeEqual,randomUUID} from 'node:crypto';
import {chmod,unlink,lstat} from 'node:fs/promises';
import {configuredOrigin} from '../server/deployment-origin.ts';
import {generatedCsp} from '../server/preview-presentation.ts';
import {sha,backendGet,projectResponse,checkLiveScope,requireCondition,shellIdentity} from './scope.mjs';
import {interactiveGateway} from './interactive.mjs';

export const reviewLimits=Object.freeze({connections:16,requests:12,downloads:2,requestRate:20,requestBurst:100,failedRate:5,failedBurst:10,downloadRate:2,downloadBurst:4,deliveryChunk:8192,deliveryIntervalMs:16,maximumTtlMs:1800000});
class Bucket{constructor(rate,burst){this.rate=rate;this.burst=burst;this.tokens=burst;this.at=performance.now();}take(){const now=performance.now();this.tokens=Math.min(this.burst,this.tokens+(now-this.at)*this.rate/1000);this.at=now;if(this.tokens<1)return false;this.tokens--;return true;}}
const equal=(a,b)=>timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
const responseHeaders=['content-type','content-security-policy','cache-control','x-content-type-options','referrer-policy','content-disposition','x-evidence-sha256','x-m0-5-build-sha256','x-m0-5-source-sha256','vary','x-dns-prefetch-control'];
export function productionReviewGateway({origin,backendPort=8120,ownerToken,key,cert,scope=null,interactiveProjectId=null,loadError=null,log=()=>{},now=()=>Date.now()}){
 if(origin)configuredOrigin(origin,backendPort);requireCondition(Number.isInteger(backendPort)&&backendPort>=1024&&backendPort<=65535,'BACKEND_PORT');
 const bootId=randomUUID(),host=origin?new URL(origin).host:null,requests=new Set(),sockets=new Set(),requestBucket=new Bucket(reviewLimits.requestRate,reviewLimits.requestBurst),failedBucket=new Bucket(reviewLimits.failedRate,reviewLimits.failedBurst),downloadBucket=new Bucket(reviewLimits.downloadRate,reviewLimits.downloadBurst);
 let grant=null,enabled=false,buffered=0,activeDownloads=0,closing=false,epoch=0,activating=false;
 const interactive=interactiveProjectId?interactiveGateway({projectId:interactiveProjectId,scope,port:backendPort,ownerToken,origin,onFailure:()=>disable('INTERACTIVE_HOST_UNAVAILABLE')}):null;
 const metrics={accepted:0,denied:0,limited:0,failedAuthentication:0,aborted:0,disconnected:0,connectionsRejected:0};
 function status(){return {bootId,enabled,mode:grant?.mode||null,interactiveProjectId,scopeSha256:scope?.sha256||null,scopeError:loadError,grantId:grant?.id||null,expiresAt:grant?.expiresAt||null,activeRequests:requests.size,activeDownloads,connections:sockets.size,bufferedBytes:buffered,limits:reviewLimits,metrics:{...metrics},identity:'M4_B21_REVIEW_GATEWAY_1',authenticationCookies:false,forwardedIdentityHeadersTrusted:false};}
 function disable(reason='DISABLED'){enabled=false;grant=null;epoch++;void interactive?.revoke().catch(()=>log({event:'INTERACTIVE_REVOKE_PENDING_LEASE_EXPIRY'}));for(const item of [...requests]){metrics.aborted++;item.abort(reason);}server.closeIdleConnections();log({event:'REVIEW_DISABLED',reason,bootId});return status();}
 async function activate(value){requireCondition(!activating&&!closing&&scope&&host&&typeof ownerToken==='string'&&ownerToken.length>=32&&!loadError,'ACTIVATION_CONFIGURATION');const mode=value?.mode||'READ_ONLY';requireCondition(['READ_ONLY','INTERACTIVE'].includes(mode)&&(mode!=='INTERACTIVE'||interactive),'ACTIVATION_MODE');requireCondition(value?.audience==='HUMAN_ONLY'&&value.scopeSha256===scope.sha256&&/^[a-f0-9]{64}$/.test(value.basicSha256)&&/^[a-f0-9]{64}$/.test(value.bearerSha256)&&Number.isSafeInteger(value.expiresAt)&&value.expiresAt>now()&&value.expiresAt<=now()+reviewLimits.maximumTtlMs,'ACTIVATION_GRANT');requireCondition(value.bearerSha256!==sha('Bearer '+ownerToken),'OWNER_IS_NOT_REVIEW_CREDENTIAL');activating=true;try{disable('REISSUE');await interactive?.drain();const activationEpoch=epoch;await checkLiveScope(scope,backendPort,ownerToken,origin);requireCondition(epoch===activationEpoch&&!closing&&value.expiresAt>now(),'ACTIVATION_REVOKED');const next={id:randomUUID(),mode,basicSha256:value.basicSha256,bearerSha256:value.bearerSha256,expiresAt:value.expiresAt};if(mode==='INTERACTIVE')await interactive.activate(next.id,next.expiresAt);requireCondition(epoch===activationEpoch&&!closing&&value.expiresAt>now(),'ACTIVATION_REVOKED');grant=next;enabled=true;log({event:'REVIEW_ENABLED',mode,bootId,grantId:grant.id,scopeSha256:scope.sha256,expiresAt:grant.expiresAt});return status();}catch(e){await interactive?.revoke().catch(()=>{});throw e;}finally{activating=false;}}
 const server=tlsServer({key,cert,minVersion:'TLSv1.2',maxHeaderSize:8192,handshakeTimeout:5000},(req,res)=>{
  const started=performance.now(),requestId=randomUUID(),path=req.url||'',method=req.method||'',record={event:'REQUEST',requestId,method:['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS','TRACE','CONNECT'].includes(method)?method:'OTHER',status:0,route:'UNKNOWN',bytes:0};let finished=false;
  const audit=()=>{if(finished)return;finished=true;record.durationMs=Math.round(performance.now()-started);log(record);};res.once('finish',audit);res.once('close',audit);
  const deny=(code,httpStatus,challenge=false)=>{if(res.destroyed)return;record.status=httpStatus;metrics.denied++;if(httpStatus===429)metrics.limited++;const body=Buffer.from(JSON.stringify({code,error:'评审入口拒绝此请求'}));record.bytes=body.length;res.writeHead(httpStatus,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; frame-ancestors 'none'",...(challenge?{'www-authenticate':'Basic realm="Mini Atoms Human Review", charset="UTF-8"'}:{}),...(httpStatus===429?{'retry-after':'1'}:{})});res.end(body);};
  if(!enabled||!grant||!scope||!ownerToken||!host)return deny('REVIEW_DISABLED',403);
  if(now()>=grant.expiresAt){disable('EXPIRED');return deny('REVIEW_EXPIRED',403);}
  const raw=req.rawHeaders.map((v,i)=>i%2===0?v.toLowerCase():null).filter(Boolean);if(['host','authorization','origin','sec-fetch-site','sec-fetch-mode','sec-fetch-dest'].some(k=>raw.filter(x=>x===k).length>1))return deny('REVIEW_HEADERS',400);
  if(req.headers.host!==host)return deny('REVIEW_HOST',403);
  if(!requestBucket.take())return deny('REVIEW_REQUEST_RATE',429);
  const supplied=req.headers.authorization||'',digest=sha(supplied),isApi=path.startsWith('/api/'),valid=equal(digest,grant.basicSha256)||isApi&&equal(digest,grant.bearerSha256);
  if(!valid){metrics.failedAuthentication++;return failedBucket.take()?deny('REVIEW_CREDENTIAL',401,true):deny('REVIEW_AUTH_RATE',429);}
  if(method!=='GET'&&!(grant.mode==='INTERACTIVE'&&method==='POST'))return deny('REVIEW_READ_ONLY',405);
  if(req.headers['transfer-encoding']||method==='GET'&&req.headers['content-length']&&req.headers['content-length']!=='0')return deny('REVIEW_BODY',400);
  if(!path.startsWith('/')||/[?%\\#\x00-\x20]/.test(path)||path.includes('..')||path.includes('//'))return deny('REVIEW_PATH',400);
  if(req.headers.origin&&req.headers.origin!==origin)return deny('REVIEW_ORIGIN',403);
  if(isApi&&req.headers['sec-fetch-site']&&!['same-origin','none'].includes(req.headers['sec-fetch-site']))return deny('REVIEW_FETCH_SITE',403);
  if(grant.mode==='INTERACTIVE'){
   if(method==='POST'&&(req.headers.origin!==origin||req.headers['sec-fetch-site']!=='same-origin'||req.headers['content-type']?.split(';')[0]!=='application/json'))return deny('INTERACTIVE_WRITE_METADATA',403);
   if(requests.size>=reviewLimits.requests)return deny('REVIEW_REQUEST_CONCURRENCY',429);const download=path.startsWith('/api/evidence/');if(download&&(activeDownloads>=reviewLimits.downloads||!downloadBucket.take()))return deny('REVIEW_DOWNLOAD_LIMIT',429);const expected=download?20*1024*1024:1048576;if(buffered+expected>32*1024*1024)return deny('REVIEW_BUFFER_LIMIT',429);
   const controller=new AbortController(),admission=grant.id;let released=false,timer=null;buffered+=expected;if(download)activeDownloads++;const release=()=>{if(released)return;released=true;clearTimeout(timer);requests.delete(item);buffered-=expected;if(download)activeDownloads--;};const item={abort(){controller.abort();if(res.headersSent)res.destroy();else deny('REVIEW_ABORTED',403);release();}};requests.add(item);req.once('aborted',()=>item.abort());res.once('finish',release);res.once('close',()=>{if(!res.writableFinished)controller.abort();release();});
   const headers={};for(const k of ['origin','sec-fetch-dest','sec-fetch-mode','sec-fetch-site','sec-fetch-user'])if(typeof req.headers[k]==='string')headers[k]=req.headers[k];record.route=download?'EVIDENCE':'INTERACTIVE';
   void(async()=>{let upstream;if(method==='POST'){const parts=[];let size=0;for await(const b of req){size+=b.length;if(size>65536)throw Error('INTERACTIVE_BODY_LIMIT');parts.push(b);}const value=JSON.parse(Buffer.concat(parts));upstream=await interactive.write(path,value,headers,controller.signal);}else upstream=await interactive.read(path,headers,controller.signal);
    requireCondition(enabled&&grant?.id===admission&&now()<grant.expiresAt&&!controller.signal.aborted,'RESPONSE_REVOKED');requireCondition(!upstream.bytes.includes(Buffer.from(ownerToken)),'RESPONSE_SECRET');const outgoing={};for(const k of responseHeaders)if(typeof upstream.headers[k]==='string')outgoing[k]=upstream.headers[k];outgoing['cache-control']='no-store';outgoing['content-length']=String(upstream.bytes.length);record.status=upstream.status;record.bytes=upstream.bytes.length;metrics.accepted++;res.writeHead(upstream.status,outgoing);if(!download){res.end(upstream.bytes);return;}let offset=0;const chunk=()=>{if(!enabled||grant?.id!==admission||now()>=grant.expiresAt||controller.signal.aborted){item.abort();return;}const end=Math.min(offset+reviewLimits.deliveryChunk,upstream.bytes.length),ok=res.write(upstream.bytes.subarray(offset,end));offset=end;if(offset===upstream.bytes.length){res.end();return;}if(ok)timer=setTimeout(chunk,reviewLimits.deliveryIntervalMs);else res.once('drain',()=>{timer=setTimeout(chunk,reviewLimits.deliveryIntervalMs);});};chunk();
   })().catch(e=>{if(!res.headersSent&&!res.destroyed)deny(e.message==='INTERACTIVE_BODY_LIMIT'?'REVIEW_BODY_LIMIT':'INTERACTIVE_OBJECT_OR_REQUEST',e.message==='INTERACTIVE_BODY_LIMIT'?413:403);else if(!res.destroyed)res.destroy();release();});return;
  }
  const route=scope.doc.routes[path];if(!route)return deny('REVIEW_OBJECT_OR_ROUTE',403);record.route=route.kind;
  if(requests.size>=reviewLimits.requests)return deny('REVIEW_REQUEST_CONCURRENCY',429);
  const download=route.kind==='EVIDENCE';if(download&&(activeDownloads>=reviewLimits.downloads||!downloadBucket.take()))return deny('REVIEW_DOWNLOAD_LIMIT',429);
  const expected=Math.max(route.bytes||65536,65536);if(buffered+expected>32*1024*1024)return deny('REVIEW_BUFFER_LIMIT',429);
  const controller=new AbortController(),admission=grant.id;let timer=null,released=false,delivering=false;buffered+=expected;if(download)activeDownloads++;
  const release=()=>{if(released)return;released=true;clearTimeout(timer);requests.delete(item);buffered-=expected;if(download)activeDownloads--;};
  const item={abort(reason){controller.abort(Error(reason));if(res.headersSent)res.destroy();else deny('REVIEW_ABORTED',403);release();}};requests.add(item);
  req.once('aborted',()=>{metrics.disconnected++;item.abort('CLIENT_ABORT');});res.once('finish',release);res.once('close',()=>{if(!res.writableFinished){metrics.disconnected++;controller.abort(Error('CLIENT_CLOSED'));}release();});
  const headers={};for(const k of ['origin','sec-fetch-dest','sec-fetch-mode','sec-fetch-site','sec-fetch-user'])if(typeof req.headers[k]==='string')headers[k]=req.headers[k];
  // No Cookie, client Authorization, forwarded identity, upstream address or method is copied.
  void backendGet(backendPort,ownerToken,path,headers,controller.signal).then(upstream=>{
   if(controller.signal.aborted||res.destroyed)return;requireCondition(enabled&&grant?.id===admission&&now()<grant.expiresAt,'RESPONSE_REVOKED');
   if(upstream.status!==200){if(route.kind==='ASSET'&&path.endsWith('/index.html')&&upstream.status===403){record.status=403;record.bytes=upstream.bytes.length;res.writeHead(403,{'content-type':'application/json','cache-control':'no-store'});res.end(upstream.bytes);release();return;}throw Error('UPSTREAM_STATUS');}
   if(route.kind==='SHELL')requireCondition(upstream.bytes.length===route.bytes&&shellIdentity(upstream.bytes,upstream.headers['content-security-policy'])===route.normalizedSha256,'RESPONSE_SHELL_IDENTITY');else if(route.kind!=='STATUS')requireCondition(upstream.bytes.length===route.bytes&&sha(upstream.bytes)===route.sha256,'RESPONSE_IDENTITY');
   if(route.kind==='ASSET'){const v=scope.versions.get(route.versionId);requireCondition(upstream.headers['content-security-policy']===generatedCsp(`${origin}/builds/${v.runtimeVersionId}`)&&upstream.headers['x-m0-5-build-sha256']===v.buildSha256&&upstream.headers['x-m0-5-source-sha256']===v.sourceSha256,'RESPONSE_PREVIEW_BOUNDARY');}
   if(route.csp&&!['ASSET','SHELL'].includes(route.kind))requireCondition(upstream.headers['content-security-policy']===route.csp,'RESPONSE_CSP');
   if(route.kind==='EVIDENCE')requireCondition(upstream.headers['x-evidence-sha256']===route.sha256,'RESPONSE_EVIDENCE_BOUNDARY');
   let bytes=upstream.bytes;if(isApi&&route.kind!=='EVIDENCE'){const projected=projectResponse(path,JSON.parse(bytes.toString()),scope);bytes=Buffer.from(JSON.stringify(projected));}
   requireCondition(!bytes.includes(Buffer.from(ownerToken)),'RESPONSE_SECRET');const outgoing={};for(const k of responseHeaders)if(typeof upstream.headers[k]==='string')outgoing[k]=upstream.headers[k];outgoing['cache-control']='no-store';outgoing['content-length']=String(bytes.length);record.status=200;record.bytes=bytes.length;metrics.accepted++;res.writeHead(200,outgoing);
   if(!download){res.end(bytes);return;}delivering=true;let offset=0;const chunk=()=>{if(res.destroyed||controller.signal.aborted){release();return;}if(!enabled||grant?.id!==admission||now()>=grant.expiresAt){item.abort('REVOKED_DURING_DELIVERY');return;}const end=Math.min(offset+reviewLimits.deliveryChunk,bytes.length),ok=res.write(bytes.subarray(offset,end));offset=end;if(offset===bytes.length){res.end();return;}if(ok)timer=setTimeout(chunk,reviewLimits.deliveryIntervalMs);else res.once('drain',()=>{timer=setTimeout(chunk,reviewLimits.deliveryIntervalMs);});};chunk();
  }).catch(()=>{if(!res.destroyed&&!res.headersSent)deny('REVIEW_UPSTREAM_BOUNDARY',503);else if(delivering)res.destroy();release();});
 });
 server.maxRequestsPerSocket=100;server.requestTimeout=10000;server.headersTimeout=5000;server.keepAliveTimeout=2000;server.on('connection',socket=>{if(sockets.size>=reviewLimits.connections){metrics.connectionsRejected++;socket.destroy();return;}sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});server.on('clientError',(_e,socket)=>{if(socket.writable)socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');});
 for(const event of ['connect','upgrade'])server.on(event,(_req,socket)=>socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
 const expiry=setInterval(()=>{if(grant&&now()>=grant.expiresAt)disable('EXPIRED');},100);expiry.unref();
 async function close(){closing=true;disable('SHUTDOWN');clearInterval(expiry);let failure;try{await interactive?.drain();}catch(e){failure=e;}server.closeAllConnections();await new Promise(done=>server.close(()=>done()));if(failure)throw failure;}
 return {server,status,activate,disable,close,drain:()=>interactive?.drain()||Promise.resolve()};
}

export async function openControl(gateway,path){try{await lstat(path);throw Error('CONTROL_SOCKET_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}
 const server=controlServer((req,res)=>{
  if(req.method!=='POST'||req.url!=='/control'){res.writeHead(403);res.end();return;}
  const parts=[];let size=0;req.on('data',b=>{if((size+=b.length)>2048)req.destroy();else parts.push(b);});
  req.on('end',()=>{void(async()=>{try{
   const {command,...value}=JSON.parse(Buffer.concat(parts));let result;
   if(command==='status')result=gateway.status();
   else if(command==='disable'||command==='revoke'){result=gateway.disable(command.toUpperCase());await gateway.drain();}
   else if(command==='activate')result=await gateway.activate(value);else throw Error('CONTROL_COMMAND');
   res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(result));
  }catch{res.writeHead(409,{'content-type':'application/json'});res.end(JSON.stringify({code:'CONTROL_REJECTED'}));}})();});
 });await new Promise((done,reject)=>{server.once('error',reject);server.listen(path,done);});await chmod(path,0o600);return async()=>{server.closeAllConnections();await new Promise(done=>server.close(()=>done()));await unlink(path).catch(()=>{});};
}
