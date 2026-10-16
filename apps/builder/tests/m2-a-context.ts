import {readFile,readdir,writeFile,mkdir} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {configuration,appRoot} from '../src/server/config.ts';
import {sha} from '../../../spikes/m0-5-tsx-runtime/src/shared.mjs';
export const workspace=join(appRoot,'../..'),pointerFile=join(appRoot,'evidence/latest-m2-a.json');
export const counterId='f26cafcb-d598-4b5e-a4b2-e2948d1ece46';
export async function context(){const pointer=JSON.parse(await readFile(pointerFile,'utf8'));return {pointer,directory:join(appRoot,'evidence',pointer.directory)};}
export async function fileHashes(dir:string):Promise<Record<string,string>>{const out:Record<string,string>={};for(const entry of await readdir(dir,{withFileTypes:true})){const file=join(dir,entry.name);if(entry.isDirectory())Object.assign(out,await fileHashes(file));else if(entry.isFile())out[relative(workspace,file).replaceAll('\\','/')]=sha(await readFile(file));else throw new Error('Unexpected evidence link');}return out;}
if(process.argv[2]==='init'){
  try{await readFile(pointerFile);throw new Error('M2-A snapshot already exists');}catch(error:any){if(error.code!=='ENOENT')throw error;}
  const config=configuration(),db=new DatabaseSync(join(config.dataRoot,'builder.sqlite'));
  try{if(db.prepare("SELECT id FROM job_records WHERE state IN ('QUEUED','RUNNING')").all().length)throw new Error('Wait for active jobs before snapshot');const tables:Record<string,unknown[]>={};for(const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as any[])tables[row.name]=db.prepare(`SELECT rowid AS _rowid_,* FROM ${row.name} ORDER BY rowid`).all();
    const hashes={...await fileHashes(join(config.dataRoot,'jobs')),...await fileHashes(join(config.dataRoot,'artifacts'))};for(const entry of await readdir(join(appRoot,'evidence'),{withFileTypes:true}))if(entry.isDirectory())Object.assign(hashes,await fileHashes(join(appRoot,'evidence',entry.name)));
    const id='m2-a-'+new Date().toISOString().replaceAll(':','-').replaceAll('.','-'),directory=join(appRoot,'evidence',id);await mkdir(directory);const backup=join(config.dataRoot,'builder.before-'+id+'.sqlite');db.exec("VACUUM INTO '"+backup.replaceAll("'","''")+"'");
    await writeFile(join(directory,'before.json'),JSON.stringify({capturedAt:new Date().toISOString(),version:db.prepare('PRAGMA user_version').get(),tables,hashes,backup,backupSha256:sha(await readFile(backup)),guideSha256:sha(await readFile(join(workspace,'docs/Mini-Atoms-M2-Design-and-Implementation-Guide.md')))},null,2),{flag:'wx'});await writeFile(pointerFile,JSON.stringify({directory:id,status:'IN_PROGRESS'},null,2),{flag:'wx'});console.log(JSON.stringify({directory:id,oldFiles:Object.keys(hashes).length,backupCreated:true}));
  }finally{db.close();}
}
