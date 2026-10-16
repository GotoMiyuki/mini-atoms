import {readFile,readdir,lstat,realpath,rename,mkdir,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {createRequire} from 'node:module';
import {AppError} from '../shared/contracts.ts';
import {verificationLimits} from '../shared/verification.ts';
import type {BuildManifest} from './runtime.ts';
import {sha} from '../../../../spikes/m0-5-tsx-runtime/src/shared.mjs';
const require=createRequire(import.meta.url),{yauzl}=require('../../node_modules/playwright-core/lib/utilsBundle.js');
export async function traceEntries(file:string):Promise<Map<string,Buffer>>{const entries=new Map<string,Buffer>();let total=0,count=0;await new Promise<void>((done,reject)=>yauzl.open(file,{lazyEntries:true},(error:any,zip:any)=>{if(error)return reject(error);zip.on('error',reject);zip.on('end',done);zip.on('entry',(entry:any)=>{if(++count>4096||entry.uncompressedSize>verificationLimits.fileBytes||(total+=entry.uncompressedSize)>128*1024*1024||entries.has(entry.fileName)){zip.close();return reject(new AppError('EVIDENCE_INCOMPLETE','Trace超限或重复条目',503));}if(entry.fileName.endsWith('/'))return zip.readEntry();zip.openReadStream(entry,(error:any,stream:any)=>{if(error)return reject(error);const parts:Buffer[]=[];stream.on('data',(b:Buffer)=>parts.push(b));stream.on('error',reject);stream.on('end',()=>{entries.set(entry.fileName,Buffer.concat(parts));zip.readEntry();});});});zip.readEntry();}));return entries;}
export async function browserAssets(trace:string,manifest:BuildManifest,report:any){
  const entries=await traceEntries(trace),observed:Record<string,unknown>={};
  for(const name of ['index.html','app.css','app.js']){
    const url=`http://127.0.0.1:8765/builds/${manifest.versionId}/${name}`;let resource:any;
    for(const [file,bytes] of entries)if(file.endsWith('.network'))for(const line of bytes.toString().split('\n').filter(Boolean)){const snapshot=JSON.parse(line).snapshot;if(snapshot?.request?.url===url&&snapshot.response?.status===200)resource=snapshot;}
    if(!resource)throw new AppError('IDENTITY_MISMATCH',`Trace缺少实际浏览器资源响应: ${name}`,503);
    const content=resource.response.content,bytes=entries.get(content._file||`resources/${content._sha1}`);
    if(bytes){if(sha(bytes)!==manifest.assets[name].sha256)throw new AppError('IDENTITY_MISMATCH','Trace资源字节不匹配',503);observed[name]={sha256:sha(bytes),basis:'BROWSER_TRACE_RESPONSE_BYTES'};}
    else{if(name!=='app.js'||report.exposure?.generatedHTML?.sha256!==manifest.assets['index.html'].sha256)throw new AppError('EVIDENCE_INCOMPLETE','Trace必要资源字节缺失',503);observed[name]={sha256:manifest.assets[name].sha256,basis:'UNCHANGED_WORKER_FIXED_ORIGIN_FETCH_HASH_AND_BROWSER_200; READONLY_STATIC_BUILD_CHECKED_BEFORE_AND_AFTER',traceContainsScriptBody:false};}
  }return observed;
}
export async function safeEvidence(dataRoot:string,key:string,expected?:{sha256:string;bytes:number}){
  if(!/^runs\/[a-f0-9-]{36}\/R[1-8]\/[a-z0-9-]+\.(png|zip|json)$/.test(key))throw new AppError('EVIDENCE_PATH','证据路径无效',404);
  const base=resolve(dataRoot,'verification'),path=resolve(base,key);if(!path.startsWith(base+sep))throw new AppError('EVIDENCE_PATH','证据路径越界',404);
  try{if((await lstat(base)).isSymbolicLink())throw new Error('Storage root symlink');let current=base;for(const part of key.split('/')){current=join(current,part);if((await lstat(current)).isSymbolicLink())throw new Error('Symlink');}const resolved=await realpath(path);if(!resolved.startsWith(await realpath(base)+sep))throw new Error('Escape');const stat=await lstat(path);if(!stat.isFile()||stat.size>verificationLimits.fileBytes)throw new Error('Invalid size/type');const bytes=await readFile(path);if(expected&&(bytes.length!==expected.bytes||sha(bytes)!==expected.sha256))throw new Error('Digest changed');return bytes;}catch{throw new AppError('EVIDENCE_INCOMPLETE','已登记证据缺失或完整性失效',503);}
}
export async function privateBytes(base:string):Promise<number>{let size=0,count=0;async function walk(dir:string){let list;try{if((await lstat(dir)).isSymbolicLink())throw new AppError('EVIDENCE_STORAGE','拒绝跟随私有目录符号链接',503);list=await readdir(dir,{withFileTypes:true});}catch(error:any){if(error.code==='ENOENT')return;throw error;}for(const entry of list){if(++count>20000||entry.isSymbolicLink())throw new AppError('EVIDENCE_STORAGE','私有证据目录异常或条目过多',503);const file=join(dir,entry.name);if(entry.isDirectory())await walk(file);else if(entry.isFile())size+=(await lstat(file)).size;else throw new AppError('EVIDENCE_STORAGE','非普通证据文件',503);}}await walk(base);return size;}
// Only proven unreferenced directories can be removed; referenced archives are
// never expired automatically. Run identities are strict UUIDs and no symlinks.
export async function reclaimUnreferenced(dataRoot:string,isReferenced:(runId:string)=>boolean){const base=resolve(dataRoot,'verification');let removed=0;for(const name of ['.staging','runs']){const parent=join(base,name);await mkdir(parent,{recursive:true});if((await lstat(base)).isSymbolicLink()||(await lstat(parent)).isSymbolicLink())throw new AppError('EVIDENCE_STORAGE','拒绝清理符号链接目录',503);for(const entry of await readdir(parent,{withFileTypes:true})){if(!/^[a-f0-9-]{36}$/.test(entry.name)||!entry.isDirectory()||entry.isSymbolicLink()||isReferenced(entry.name))continue;const path=resolve(parent,entry.name);if(!path.startsWith(parent+sep)||(await lstat(path)).mtimeMs>Date.now()-86400000)continue;await privateBytes(path);await rm(path,{recursive:true});removed++;}}return {removed,referencedArchivesProtected:true};}
export async function publishDirectory(dataRoot:string,runId:string,requirementId:string,output:string){const destination=resolve(dataRoot,'verification/runs',runId,requirementId);if(!/^[a-f0-9-]{36}$/.test(runId)||!/^R[1-8]$/.test(requirementId)||!destination.startsWith(resolve(dataRoot,'verification/runs')+sep))throw new AppError('EVIDENCE_PATH','归档目标无效');await mkdir(join(destination,'..'),{recursive:true});await rename(output,destination);return destination;}
