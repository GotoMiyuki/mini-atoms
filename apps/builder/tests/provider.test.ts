import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Provider} from '../src/server/provider.ts';
import {fixture} from './m2-b-fixtures.ts';
test('模型传输负例：429、非法JSON、截断、超时、取消；无自动重试',async()=>{
  let mode='ok',calls=0;
  const server=createServer((request,response)=>{request.resume();calls++;if(mode==='slow')return;response.writeHead(mode==='rate'?429:200,{'content-type':'application/json'});if(mode==='keepalive'){response.write('\n');return;}response.end(mode==='bad'?'{':JSON.stringify({id:'test-only',model:'stub',choices:[{finish_reason:mode==='truncated'?'length':'stop',message:{content:'{"hello":"world"}'}}]}));});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const port=(server.address() as any).port;
  const provider=new Provider({baseUrl:`http://127.0.0.1:${port}`,model:'TEST_STUB_NOT_REAL_LLM',apiKey:'test-only',timeoutMs:100});
  try{
    assert.deepEqual(await provider.complete('JSON',{},100,new AbortController().signal),{hello:'world'});
    for(const [selected,code] of [['rate','LLM_RATE_LIMIT'],['bad','LLM_JSON'],['truncated','LLM_JSON'],['slow','LLM_UNAVAILABLE']]){mode=selected;const before=calls;await assert.rejects(provider.complete('JSON',{},100,new AbortController().signal),(e:any)=>e.code===code);assert.equal(calls,before+1);}
    mode='keepalive';const before=calls;await assert.rejects(provider.complete('JSON',{},100,new AbortController().signal),{code:'LLM_UNAVAILABLE'});assert.equal(calls,before+1);assert.equal(provider.lastReceipt!.httpStatus,200);assert.equal(provider.lastReceipt!.bodyComplete,false);assert.equal(provider.lastReceipt!.bodyOnlyWhitespace,true);assert.equal(provider.lastReceipt!.bodyBytes,1);
    mode='slow';const abort=new AbortController();setTimeout(()=>abort.abort(new Error('test cancel')),20);await assert.rejects(provider.complete('JSON',{},100,abort.signal),/test cancel/);
  }finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}
});
test('v1.1 narrow planning focus preserves the complete frozen Spec and inventory; invalid focus stops before transport',async()=>{let calls=0,received:any=null;const server=createServer(async(request,response)=>{const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(chunk);calls++;received=JSON.parse(Buffer.concat(chunks).toString());response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({id:'TEST_ONLY',model:'stub',choices:[{finish_reason:'stop',message:{content:'{"stub":true}'}}]}));});await new Promise<void>(d=>server.listen(0,'127.0.0.1',d));const provider=new Provider({baseUrl:`http://127.0.0.1:${(server.address() as any).port}`,model:'TEST_STUB_NOT_REAL_LLM',apiKey:'TEST_ONLY',timeoutMs:1000}),f=fixture();try{await provider.generateTestPlanV11(f.spec,f.inventory,new AbortController().signal,undefined,'R2');const input=JSON.parse(received.messages[1].content);assert.deepEqual(input.specification,f.spec);assert.deepEqual(input.targetInventory,f.inventory);assert.equal(input.planningFocus.requirementId,'R2');assert.equal(input.budget.expandedSteps,20);assert.equal(calls,1);await assert.rejects(provider.generateTestPlanV11(f.spec,f.inventory,new AbortController().signal,undefined,'R8'),{code:'INVALID_CONTRACT'});assert.equal(calls,1);}finally{server.closeAllConnections();await new Promise<void>(d=>server.close(()=>d()));}});
