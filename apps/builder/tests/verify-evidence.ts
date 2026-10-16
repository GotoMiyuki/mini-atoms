import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {configuration,appRoot} from '../src/server/config.ts';
import {spikeRoot} from '../src/server/runtime.ts';
import {sha,canonicalHash} from '../../../spikes/m0-5-tsx-runtime/src/shared.mjs';
const config=configuration(),evidence=join(appRoot,'evidence'),lock=JSON.parse(await readFile(join(appRoot,'runtime.lock.json'),'utf8'));
const authority=join(appRoot,'../..',lock.authority);assert.equal(sha(await readFile(authority)),lock.authoritySha256);
let frozenFiles=0,verifiedArtifacts=0;
for(const [name,expected] of Object.entries(lock.sourceFiles)){assert.equal(sha(await readFile(join(spikeRoot,name))),expected,name);frozenFiles++;}
async function report(kind:string){const pointer=JSON.parse(await readFile(join(evidence,`latest-${kind}.json`),'utf8'));assert.equal(pointer.status,'PASS',kind);const file=join(evidence,pointer.report),r=JSON.parse(await readFile(file,'utf8'));assert.equal(r.status,'PASS',kind);for(const [name,hash] of Object.entries(r.artifacts)){assert(!name.includes('/')&&!name.includes('\\')&&name!=='.'&&name!=='..');assert.equal(sha(await readFile(join(file,'..',name))),hash,`${kind}/${name}`);verifiedArtifacts++;}return {file,report:r,path:pointer.report,sha256:sha(await readFile(file))};}
const runtime=await report('runtime'),real=await report('real-llm'),restore=await report('restore');assert.equal(runtime.report.checks.length,14);assert.equal(real.report.results.length,2);assert.equal(restore.report.results.length,2);
const db=new DatabaseSync(join(config.dataRoot,'builder.sqlite'),{readOnly:true});const requests=new Set<string>(),versions=[];
try{
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
  for(const item of real.report.results){
    const version=JSON.parse((db.prepare('SELECT document FROM app_versions WHERE id=?').get(item.versionId) as any).document);
    assert.equal(version.sourceSha256,item.sourceSha256);assert.equal(canonicalHash(Object.fromEntries(version.files.map((f:any)=>[f.path,f.content]))),item.sourceSha256);assert.equal(version.buildSha256,item.buildSha256);assert.equal(version.configSha256,lock.configSha256);
    const manifest=JSON.parse(await readFile(join(config.dataRoot,'artifacts',item.runtimeVersionId,'build-manifest.json'),'utf8'));const output:Record<string,Buffer>={};
    for(const [name,asset] of Object.entries(manifest.assets) as any){output[name]=await readFile(join(config.dataRoot,'artifacts',item.runtimeVersionId,name));assert.equal(sha(output[name]),asset.sha256);assert.equal(item.loadedAssets[name].sha256,asset.sha256);}
    assert.equal(canonicalHash(output),item.buildSha256);assert.equal(manifest.configurationSha256,lock.configSha256);assert.equal(manifest.sourceSha256,item.sourceSha256);
    const buildJob=(db.prepare('SELECT id FROM job_records WHERE version_id=?').get(item.versionId) as any).id;
    const boundary=JSON.parse(await readFile(join(config.dataRoot,'jobs',buildJob,'logs/container-boundary.json'),'utf8')),host=boundary.hostConfig;
    assert.equal(boundary.image,lock.imageId);assert.equal(boundary.user,'1001:1001');assert.equal(host.networkMode,'none');assert.equal(host.memory,536870912);assert.equal(host.nanoCpus,1000000000);assert.equal(host.pidsLimit,192);assert(host.readonlyRootfs&&host.capDrop.includes('ALL')&&host.securityOpt.includes('no-new-privileges:true'));assert(!host.capAdd?.length);assert(!boundary.environmentVariableNames.some((s:string)=>/LLM|API_KEY|TOKEN|SECRET/i.test(s)));assert.equal(boundary.mounts.map((m:any)=>m.Destination).sort().join(','),'/app/artifacts,/app/evidence,/input/source.json');assert.equal(boundary.mounts.find((m:any)=>m.Destination==='/input/source.json').RW,false);
    const receipts=JSON.parse(await readFile(join(real.file,'..',`${item.kind}-model-receipts.json`),'utf8'));assert.equal(receipts.length,2);for(const receipt of receipts){assert.equal(receipt.provider,'https://api.deepseek.com');assert.equal(receipt.modelRequested,'deepseek-flash');assert.equal(receipt.modelReturned,'deepseek-flash');assert.equal(receipt.finishReason,'stop');assert(receipt.requestId);assert(!requests.has(receipt.requestId));requests.add(receipt.requestId);}
    assert(restore.report.results.some((r:any)=>r.versionId===item.versionId&&r.restored&&r.postRestartInteraction));assert.equal(item.productVerificationStatus,'UNVERIFIED');
    versions.push({projectId:item.projectId,versionId:item.versionId,sourceSha256:item.sourceSha256,buildSha256:item.buildSha256,configSha256:version.configSha256});
  }
}finally{db.close();}
assert.notEqual(versions[0].sourceSha256,versions[1].sourceSha256);assert.notEqual(versions[0].buildSha256,versions[1].buildSha256);
// Scan deliverable files AND decompressed traces without exposing secret values.
const secrets=[config.token,config.provider.apiKey].filter(Boolean).map(s=>Buffer.from(s));let scannedFiles=0,zipEntries=0;
function scan(bytes:Buffer,where:string){for(const secret of secrets)assert.equal(bytes.indexOf(secret),-1,`Credential present in deliverable: ${where}`);}
const require=createRequire(import.meta.url),{yauzl}=require('../node_modules/playwright-core/lib/utilsBundle.js');
async function scanZip(path:string){await new Promise<void>((done,reject)=>{yauzl.open(path,{lazyEntries:true},(error:any,zip:any)=>{if(error)return reject(error);zip.on('error',reject);zip.on('end',done);zip.on('entry',(entry:any)=>{if(entry.fileName.endsWith('/'))return zip.readEntry();if(entry.uncompressedSize>20*1024*1024)return reject(new Error('Trace entry too large'));zip.openReadStream(entry,(error:any,stream:any)=>{if(error)return reject(error);const chunks:Buffer[]=[];stream.on('data',(chunk:Buffer)=>chunks.push(chunk));stream.on('error',reject);stream.on('end',()=>{try{scan(Buffer.concat(chunks),relative(appRoot,path)+'/'+entry.fileName);zipEntries++;zip.readEntry();}catch(e){zip.close();reject(e);}});});});zip.readEntry();});});}
async function walk(directory:string){for(const entry of await readdir(directory,{withFileTypes:true})){if(['node_modules','.local'].includes(entry.name)||entry.name.startsWith('.env'))continue;const path=join(directory,entry.name);if(entry.isDirectory())await walk(path);else if(entry.isFile()){const bytes=await readFile(path);scan(bytes,relative(appRoot,path));scannedFiles++;if(entry.name.endsWith('.zip'))await scanZip(path);}}}
await walk(appRoot);
const result={status:'PASS',capturedAt:new Date().toISOString(),authority:lock.authority,authoritySha256:lock.authoritySha256,originalM05FilesUnchanged:frozenFiles,verifiedArtifacts,successfulRealModelRequests:requests.size,versions,reports:{runtime:{path:runtime.path,sha256:runtime.sha256},real:{path:real.path,sha256:real.sha256},restore:{path:restore.path,sha256:restore.sha256}},credentialScan:{status:'PASS',deliverableFiles:scannedFiles,decompressedTraceEntries:zipEntries,secretValuesRecorded:false}};
await writeFile(join(evidence,'integrity.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({status:result.status,originalM05FilesUnchanged:frozenFiles,verifiedArtifacts,successfulRealModelRequests:requests.size,deliverableFiles:scannedFiles,decompressedTraceEntries:zipEntries}));
