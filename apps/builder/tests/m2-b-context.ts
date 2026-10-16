import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {configuration,appRoot} from '../src/server/config.ts';
import {fileHashes,workspace} from './m2-a-context.ts';
import {sha} from '../../../spikes/m0-5-tsx-runtime/src/shared.mjs';
export const pointerFile=join(appRoot,'evidence/latest-m2-b.json');
export async function context(){const pointer=JSON.parse(await readFile(pointerFile,'utf8'));return {pointer,directory:join(appRoot,'evidence',pointer.directory)};}
if(process.argv[2]==='--snapshot-b'){
  try{await readFile(pointerFile);throw new Error('M2-B snapshot already exists');}catch(e:any){if(e.code!=='ENOENT')throw e;}
  const c=configuration(),db=new DatabaseSync(join(c.dataRoot,'builder.sqlite'));
  try{if(db.prepare("SELECT id FROM job_records WHERE state IN ('QUEUED','RUNNING')").all().length)throw new Error('Active jobs');
    const tables:Record<string,unknown[]>={};for(const r of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as any[])tables[r.name]=db.prepare(`SELECT rowid AS _rowid_,* FROM ${r.name} ORDER BY rowid`).all();
    const hashes={...await fileHashes(join(c.dataRoot,'jobs')),...await fileHashes(join(c.dataRoot,'artifacts')),...await fileHashes(join(c.dataRoot,'verification/runs'))};
    for(const e of await readdir(join(appRoot,'evidence'),{withFileTypes:true}))if(e.isDirectory())Object.assign(hashes,await fileHashes(join(appRoot,'evidence',e.name)));
    const id='m2-b-'+new Date().toISOString().replaceAll(':','-').replaceAll('.','-'),directory=join(appRoot,'evidence',id);await mkdir(directory);const backup=join(c.dataRoot,'builder.before-'+id+'.sqlite');db.exec("VACUUM INTO '"+backup.replaceAll("'","''")+"'");
    await writeFile(join(directory,'before.json'),JSON.stringify({capturedAt:new Date().toISOString(),tables,hashes,backup,backupSha256:sha(await readFile(backup)),guideSha256:sha(await readFile(join(workspace,'docs/Mini-Atoms-M2-B-Protocol-Design-and-Implementation-Guide.md')))},null,2),{flag:'wx'});await writeFile(pointerFile,JSON.stringify({directory:id,status:'IN_PROGRESS'},null,2),{flag:'wx'});console.log(JSON.stringify({directory:id,oldFiles:Object.keys(hashes).length,oldRows:Object.values(tables).reduce((n,r)=>n+r.length,0),backupCreated:true}));
  }finally{db.close();}
}
