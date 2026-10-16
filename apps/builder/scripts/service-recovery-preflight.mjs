// Read-only admission for service startup. Cleanup remains exclusively in the original Main recovery.
import {safePath,json,sha} from './deployment-lib.mjs';
export async function recoverableWorker({name,raw,data,imageId,jobs,runs}){
 try{
  const labels=raw.Config?.Labels||{};
  if(raw.Name!=='/'+name||raw.Image!==imageId||labels['com.docker.compose.project']!=='mini-atoms-m1-runtime')return false;
  if(/^m1-compiler-[a-f0-9-]{36}$/.test(name)){
   const id=labels['mini-atoms.m1.job'];if(!/^[a-f0-9-]{36}$/.test(id)||labels['mini-atoms.m1.data']!==sha(data)||!jobs.some(j=>j.id===id&&j.kind==='GENERATE'))return false;
   const r=await json(await safePath(data,'jobs/'+id+'/container.json'));return r.name===name&&r.jobId===id&&r.dataRoot===data;
  }
  if(/^m2-validator-[a-f0-9-]{36}$/.test(name)){
   const id=labels['mini-atoms.m2.run'],run=runs.find(r=>r.id===id);if(!/^[a-f0-9-]{36}$/.test(id)||labels['mini-atoms.m2.data']!==sha(data)||!run||!jobs.some(j=>j.id===run.jobId))return false;
   let matches=0;
   for(let n=1;n<=8;n++){let r;try{r=await json(await safePath(data,'verification/.staging/'+id+'/R'+n+'/container.json'));}catch(e){if(e.code==='ENOENT')continue;throw e;}if(r.name===name){if(r.runId!==id||r.requirementId!=='R'+n||r.dataRoot!==data)return false;matches++;}}
   return matches===1;
  }
  return false;
 }catch{return false;}
}
