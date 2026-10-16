import {writeFile,readFile,unlink,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {configuration} from './config.ts';
import {Store} from './store.ts';
import {Runtime} from './runtime.ts';
import {Provider} from './provider.ts';
import {createApp} from './app.ts';
import {VerificationExecutor} from './verification.ts';
import {createHash} from 'node:crypto';
import {reclaimUnreferenced} from './evidence.ts';
import {loadInteractiveConfig} from './interactive-grant.mjs';
const config=configuration();await mkdir(config.dataRoot,{recursive:true});
const lockFile=join(config.dataRoot,'app.lock'),token=randomUUID();
async function claim(){try{await writeFile(lockFile,JSON.stringify({pid:process.pid,token}),{flag:'wx'});}catch(error:any){if(error.code!=='EEXIST')throw error;const prior=JSON.parse(await readFile(lockFile,'utf8'));try{process.kill(prior.pid,0);}catch(e:any){if(e.code==='ESRCH'){await unlink(lockFile);return claim();}}throw new Error('Another Builder process owns this SQLite directory');}}
await claim();let closing=false;
try{
  const runtime=new Runtime(config.dataRoot);await runtime.up();
  const store=new Store(config.dataRoot);
  await new VerificationExecutor(store,runtime,createHash('sha256').update(config.token).digest('hex')).recover();
  await runtime.recoverOwnedJobs(store.db.prepare("SELECT id,state FROM job_records WHERE kind='GENERATE'").all() as {id:string;state:string}[]);store.recover();
  await reclaimUnreferenced(config.dataRoot,id=>Boolean(store.db.prepare('SELECT id FROM verification_runs WHERE id=?').get(id)));
  const interactiveConfig=loadInteractiveConfig(process.env.M1_INTERACTIVE_CONFIG);
  const {server,orchestrator}=createApp(config,store,runtime,new Provider(config.provider),interactiveConfig?{config:interactiveConfig,refresh:()=>loadInteractiveConfig(process.env.M1_INTERACTIVE_CONFIG)}:null);
  await new Promise<void>((done,reject)=>{server.once('error',reject);server.listen(config.port,'127.0.0.1',done);});
  console.log(JSON.stringify({service:'Mini Atoms M2-B',origin:config.origin,llmConfigured:Boolean(config.provider.apiKey&&config.provider.model&&config.provider.baseUrl),runtime:'M0.5 unchanged',databaseVersion:store.migration.to,migratedFrom:store.migration.from,backupCreated:Boolean(store.migration.backup)}));
  async function close(){if(closing)return;closing=true;server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await orchestrator.close();store.close();if(JSON.parse(await readFile(lockFile,'utf8')).token===token)await unlink(lockFile);process.exit(0);}
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void close());
}catch(error){try{if(JSON.parse(await readFile(lockFile,'utf8')).token===token)await unlink(lockFile);}catch{}throw error;}
