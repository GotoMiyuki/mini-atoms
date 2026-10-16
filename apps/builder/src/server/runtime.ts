import { spawn } from 'node:child_process';
import { mkdir,writeFile,readFile,lstat,readdir,rename,access,chown,unlink } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from '../shared/contracts.ts';
import type { SourceEnvelope } from '../shared/contracts.ts';
// Reuse the exact M0.5 algorithms. Never execute buildSource in this process.
import { validateSource } from '../../../../spikes/m0-5-tsx-runtime/src/controlled-build/policy.mjs';
import { canonicalHash,sha } from '../../../../spikes/m0-5-tsx-runtime/src/shared.mjs';
import { appRoot } from './config.ts';
export const spikeRoot=resolve(appRoot,'../../spikes/m0-5-tsx-runtime');
export interface BuildManifest {versionId:string;sourceSha256:string;buildSha256:string;configurationSha256:string;policyVersion:string;assets:Record<string,{sha256:string;bytes:number}>}
export class Runtime {
  dataRoot:string; lock:any;
  constructor(dataRoot:string){this.dataRoot=dataRoot;}
  async check(){
    this.lock=JSON.parse(await readFile(resolve(appRoot,'runtime.lock.json'),'utf8'));
    for(const [name,expected] of Object.entries(this.lock.sourceFiles))if(sha(await readFile(resolve(spikeRoot,name)))!==expected)throw new AppError('RUNTIME_CHANGED',`M0.5 冻结文件发生变化：${name}`,503);
    const inspected=await this.docker(['image','inspect',this.lock.imageId,'--format','{{.Id}}']);
    if(inspected.stdout.trim()!==this.lock.imageId)throw new AppError('RUNTIME_IMAGE','已验证的 M0.5 镜像不可用',503);
    const program='const fs=require("node:fs"),c=require("node:crypto");const h=JSON.parse(fs.readFileSync("/runtime-hashes.json","utf8"));for(const [p,s] of Object.entries(h)){if(c.createHash("sha256").update(fs.readFileSync(p)).digest("hex")!==s)process.exit(1)}console.log("RUNTIME_FILES_MATCH")';
    await this.docker(['run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--user','1001:1001','-v',`${resolve(appRoot,'runtime-hashes.json')}:/runtime-hashes.json:ro`,this.lock.imageId,'node','-e',program]);
    await mkdir(join(this.dataRoot,'artifacts'),{recursive:true});await mkdir(join(this.dataRoot,'jobs'),{recursive:true});
    return {status:'PASS',imageId:this.lock.imageId,sourceFiles:Object.keys(this.lock.sourceFiles).length,runtimeFiles:Object.keys(this.lock.runtimeFiles).length};
  }
  async docker(args:string[],signal?:AbortSignal,env:Record<string,string>={},timeout=90000){
    return await new Promise<{stdout:string;stderr:string;exitCode:number}>((done,reject)=>{
      const childEnv:Record<string,string>={};
      for(const name of ['PATH','SystemRoot','SystemDrive','ProgramData','ProgramFiles','ProgramFiles(x86)','ProgramW6432','CommonProgramFiles','COMSPEC','TEMP','TMP','USERPROFILE','HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA','HOME','DOCKER_HOST','DOCKER_CONTEXT','DOCKER_CONFIG'])if(process.env[name])childEnv[name]=process.env[name]!;
      const child=spawn('docker',args,{shell:false,windowsHide:true,cwd:spikeRoot,env:{...childEnv,...env}});
      let stdout='',stderr='',exceeded=false;
      for(const [stream,name] of [[child.stdout,'stdout'],[child.stderr,'stderr']] as const)stream.on('data',chunk=>{if(name==='stdout')stdout+=chunk;else stderr+=chunk;if(stdout.length+stderr.length>262144){exceeded=true;child.kill();}});
      const timer=setTimeout(()=>child.kill(),timeout);
      const cancel=()=>child.kill();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
      child.once('error',error=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);reject(error);});
      child.once('exit',exitCode=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);if(signal?.aborted)return reject(signal.reason);if(exceeded)return reject(new AppError('DOCKER_OUTPUT','Docker 输出超限',502));if(exitCode!==0)return reject(new AppError('DOCKER_ERROR',`容器命令失败（${exitCode??'timeout'}）：${stderr.slice(-2000)}`,502));done({stdout,stderr,exitCode:0});});
    });
  }
  async compose(args:string[],signal?:AbortSignal,jobPaths?:{output:string;logs:string;source:string}){
    if(!this.lock)this.lock=JSON.parse(await readFile(resolve(appRoot,'runtime.lock.json'),'utf8'));
    const defaults=join(this.dataRoot,'jobs/runtime-config');await mkdir(defaults,{recursive:true});
    const placeholder=join(defaults,'unused-source.json');await writeFile(placeholder,'{}');
    return this.docker(['compose','-p','mini-atoms-m1-runtime','-f',join(spikeRoot,'deploy/compose.yml'),'-f',join(appRoot,'deploy/runtime.override.yml'),...args],signal,{M1_RUNTIME_IMAGE:this.lock.imageId,M1_ARTIFACTS_ROOT:join(this.dataRoot,'artifacts'),M1_BUILD_OUTPUT:jobPaths?.output||defaults,M1_BUILD_LOGS:jobPaths?.logs||defaults,M1_SOURCE_FILE:jobPaths?.source||placeholder});
  }
  async up(){await this.check();await this.compose(['up','-d','--no-build','--wait','preview']);}
  async down(){await this.compose(['down']);}
  async build(input:SourceEnvelope,jobId:string,signal:AbortSignal){
    const files=validateSource(input),sourceSha256=canonicalHash(files);
    if(Buffer.byteLength(JSON.stringify(input))>300000)throw new AppError('SOURCE_LIMIT','序列化源码超过编译入口限制');
    const directory=join(this.dataRoot,'jobs',jobId),output=join(directory,'output'),logs=join(directory,'logs'),source=join(directory,'source.json');
    await mkdir(output,{recursive:true});await mkdir(logs,{recursive:true});
    if(process.platform==='linux'&&process.getuid?.()===0){await chown(output,1001,1001);await chown(logs,1001,1001);}
    await writeFile(source,JSON.stringify(input),{mode:0o644});
    const name=`m1-compiler-${randomUUID()}`;
    await writeFile(join(directory,'container.json'),JSON.stringify({name,jobId,dataRoot:this.dataRoot}));
    try{
      await this.compose(['run','-d','--no-deps','--pull','never','--name',name,'--label',`mini-atoms.m1.job=${jobId}`,'--label',`mini-atoms.m1.data=${sha(this.dataRoot)}`,'compiler'],signal,{output,logs,source});
      const raw=JSON.parse((await this.docker(['inspect',name,'--format','{{json .}}'],signal)).stdout),h=raw.HostConfig;
      const destinations=raw.Mounts.map((m:any)=>m.Destination).sort().join(',');
      if(raw.Image!==this.lock.imageId||raw.Config.User!=='1001:1001'||!h.ReadonlyRootfs||h.Privileged||h.CapAdd?.length||!h.CapDrop.includes('ALL')||!h.SecurityOpt.includes('no-new-privileges:true')||h.NetworkMode!=='none'||h.Memory!==536870912||h.NanoCpus!==1000000000||h.PidsLimit!==192||destinations!=='/app/artifacts,/app/evidence,/input/source.json'||raw.Mounts.find((m:any)=>m.Destination==='/input/source.json').RW)throw new AppError('COMPILER_BOUNDARY','实际编译容器偏离 M0.5 边界',503);
      await writeFile(join(logs,'container-boundary.json'),JSON.stringify({image:raw.Image,user:raw.Config.User,hostConfig:{networkMode:h.NetworkMode,memory:h.Memory,nanoCpus:h.NanoCpus,pidsLimit:h.PidsLimit,readonlyRootfs:h.ReadonlyRootfs,capDrop:h.CapDrop,capAdd:h.CapAdd,securityOpt:h.SecurityOpt,tmpfs:h.Tmpfs},mounts:raw.Mounts,environmentVariableNames:raw.Config.Env.map((v:string)=>v.split('=',1)[0])},null,2));
      const exit=Number((await this.docker(['wait',name],signal)).stdout.trim());
      const execution=await this.docker(['logs',name],signal);await writeFile(join(logs,'build.log'),execution.stdout+'\n'+execution.stderr);
      const result=JSON.parse(execution.stdout.trim());
      if(exit!==0||result.status!=='BUILT')throw new AppError(result.code||'BUILD_FAILED',`受控构建失败：${String(result.message||'编译错误').slice(0,2000)}`,422);
      const manifest=result.manifest as BuildManifest;
      if(!/^[a-f0-9]{64}$/.test(manifest.versionId)||manifest.sourceSha256!==sourceSha256||manifest.configurationSha256!==this.lock.configSha256)throw new AppError('BUILD_IDENTITY','编译结果身份不符',502);
      const built=join(output,manifest.versionId),bytes:Record<string,Buffer>={};let total=0;
      if((await readdir(built)).sort().join(',')!==[...Object.keys(manifest.assets),'build-manifest.json'].sort().join(','))throw new AppError('BUILD_OUTPUT','产物集合不符',502);
      for(const [file,info] of Object.entries(manifest.assets)){
        if(!['index.html','app.js','app.css'].includes(file))throw new AppError('BUILD_OUTPUT','非静态白名单产物',502);
        const stat=await lstat(join(built,file));if(!stat.isFile()||stat.isSymbolicLink()||(total+=stat.size)>1048576)throw new AppError('BUILD_OUTPUT','产物类型或大小无效',502);
        bytes[file]=await readFile(join(built,file));if(sha(bytes[file])!==info.sha256||bytes[file].length!==info.bytes)throw new AppError('BUILD_OUTPUT','真实产物 hash 不符',502);
      }
      if(canonicalHash(bytes)!==manifest.buildSha256||sha(`${manifest.sourceSha256}:${manifest.buildSha256}:${manifest.configurationSha256}`)!==manifest.versionId)throw new AppError('BUILD_IDENTITY','构建 hash/versionId 不符',502);
      const published=join(this.dataRoot,'artifacts',manifest.versionId);
      try{await access(published);for(const [file,info] of Object.entries(manifest.assets))if(sha(await readFile(join(published,file)))!==info.sha256)throw new AppError('PUBLISHED_CHANGED','既有只读产物发生变化',502);}
      catch(error:any){if(error.code!=='ENOENT')throw error;await rename(built,published);}
      return manifest;
    }finally{
      try{const remaining=await this.docker(['ps','-a','--filter',`name=^/${name}$`,'--format','{{.Names}}']);if(remaining.stdout.trim())await this.docker(['container','rm','--force',name],undefined,{},10000);await writeFile(join(logs,'cleanup.json'),JSON.stringify({status:'PASS',container:name}));}
      catch{await writeFile(join(logs,'cleanup.json'),JSON.stringify({status:'FAIL',container:name})).catch(()=>{});throw new AppError('CLEANUP_FAILED','本任务编译容器回收失败，任务已停止',503);}
    }
  }
  async globalLease(){
    const file=join(spikeRoot,'.local/controller.lock'),token=randomUUID();await mkdir(join(spikeRoot,'.local'),{recursive:true});
    try{await writeFile(file,JSON.stringify({pid:process.pid,token,controller:'M1',dataRoot:this.dataRoot}),{flag:'wx'});}catch{throw new AppError('GLOBAL_BUSY','另一个 M0.5/M1 高资源作业正在执行',409);}
    return async()=>{try{if(JSON.parse(await readFile(file,'utf8')).token===token)await unlink(file);}catch{}};
  }
  async recoverOwnedJobs(jobs:(string|{id:string;state:string})[]){
    for(const job of jobs){
      const jobId=typeof job==='string'?job:job.id,terminal=typeof job!=='string'&&['COMPLETED','ERROR','CANCELLED'].includes(job.state);
      if(!/^[a-f0-9-]{36}$/.test(jobId))throw new AppError('RECOVERY_ID','中断任务 ID 无效',503);
      let record:any;try{record=JSON.parse(await readFile(join(this.dataRoot,'jobs',jobId,'container.json'),'utf8'));}catch(error:any){if(error.code==='ENOENT')continue;throw error;}
      if(record.jobId!==jobId||typeof record.dataRoot!=='string'||!(/^(?:[A-Za-z]:[\\/]|\/)/.test(record.dataRoot))||/[\x00-\x1f]/.test(record.dataRoot)||!/^m1-compiler-[a-f0-9-]{36}$/.test(record.name))throw new AppError('RECOVERY_OWNER','中断容器归属不符',503);
      if(record.dataRoot!==this.dataRoot){
        if(!terminal)throw new AppError('RECOVERY_OWNER','活动任务不能跨数据目录恢复',503);
        // Terminal state is supplied from the locked SQLite startup query. No old record is edited.
        const named=await this.docker(['ps','-a','--filter',`name=^/${record.name}$`,'--format','{{.Names}}']);
        const labelled=await this.docker(['ps','-a','--filter',`label=mini-atoms.m1.job=${jobId}`,'--format','{{.Names}}']);
        if(named.stdout.trim()||labelled.stdout.trim())throw new AppError('RECOVERY_OWNER','终态历史记录仍有实际容器或归属冲突，拒绝跨路径恢复',503);
        continue;
      }
      const matches=await this.docker(['ps','-a','--filter',`name=^/${record.name}$`,'--format','{{.Names}}']);if(!matches.stdout.trim())continue;
      const container=JSON.parse((await this.docker(['inspect',record.name,'--format','{{json .}}'])).stdout),labels=container.Config.Labels;
      if(labels['mini-atoms.m1.job']!==jobId||labels['mini-atoms.m1.data']!==sha(this.dataRoot)||labels['com.docker.compose.project']!=='mini-atoms-m1-runtime')throw new AppError('RECOVERY_OWNER','实际容器标签与中断任务不符',503);
      await this.docker(['container','rm','--force',record.name]);
    }
    const file=join(spikeRoot,'.local/controller.lock');
    let prior:any;try{prior=JSON.parse(await readFile(file,'utf8'));}catch(error:any){if(error.code==='ENOENT')return;throw error;}
    if(prior.controller!=='M1'||prior.dataRoot!==this.dataRoot)return;
    if(!Number.isInteger(prior.pid)||prior.pid<1||typeof prior.token!=='string')throw new AppError('RECOVERY_OWNER','本项目旧锁的身份无效',503);
    try{process.kill(prior.pid,0);return;}catch(error:any){if(error.code!=='ESRCH')return;}
    if(JSON.parse(await readFile(file,'utf8')).token===prior.token)await unlink(file);
  }
}
