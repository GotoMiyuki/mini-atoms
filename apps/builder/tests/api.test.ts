import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/server/store.ts';
import {Runtime} from '../src/server/runtime.ts';
import {Provider} from '../src/server/provider.ts';
import {createApp} from '../src/server/app.ts';
import {request as nativeRequest} from 'node:http';
test('API：认证、Origin/Host、防越权、严格字段、未配置模型失败关闭',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'mini-atoms-api-')),store=new Store(directory),runtime=new Runtime(directory);runtime.lock={imageId:'test-only'};
  const config={port:18120,origin:'http://127.0.0.1:18120',token:'a'.repeat(64),maxDaily:2,dataRoot:directory,provider:{baseUrl:'',model:'',apiKey:'',timeoutMs:100}};
  const app=createApp(config,store,runtime,new Provider(config.provider));await new Promise<void>(done=>app.server.listen(config.port,'127.0.0.1',done));
  const api=async(path:string,method='GET',value?:unknown,extra:Record<string,string>={})=>{const r=await fetch(config.origin+path,{method,headers:{authorization:`Bearer ${config.token}`,'content-type':'application/json',...extra},body:value===undefined?undefined:JSON.stringify(value)});return {status:r.status,body:await r.json()};};
  try{
    assert.equal((await fetch(config.origin+'/api/projects')).status,401);
    assert.equal((await api('/api/projects','GET',undefined,{origin:'https://attacker.invalid'})).status,403);
    const hostStatus=await new Promise<number>((done,reject)=>{const request=nativeRequest(config.origin+'/api/projects',{headers:{host:'attacker.invalid',authorization:`Bearer ${config.token}`}},response=>{response.resume();done(response.statusCode!);});request.once('error',reject);request.end();});assert.equal(hostStatus,403);
    assert.equal((await api('/api/projects','POST',{name:'project',shell:'rm'})).status,400);
    const p=(await api('/api/projects','POST',{name:'M1 test'})).body;
    assert.equal((await api(`/api/projects/${p.id}`)).status,200);
    const foreign=store.createProject('someone-else','private');assert.equal((await api(`/api/projects/${foreign.id}`)).status,404);
    assert.equal((await api(`/api/projects/${p.id}/specifications`,'POST',{prompt:'计数器'})).status,503);
    assert.equal((await api('/api/projects?url=http://169.254.169.254')).status,400);
    assert.equal((await api('/.env.local')).status,404);assert.equal((await api('/src/server/config.ts')).status,404);
  }finally{await app.orchestrator.close();app.server.closeAllConnections();await new Promise<void>(done=>app.server.close(()=>done()));store.close();await rm(directory,{recursive:true,force:true});}
});
