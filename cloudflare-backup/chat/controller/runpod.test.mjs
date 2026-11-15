import {test} from 'node:test';import assert from 'node:assert/strict';
import {runpodClient} from './runpod.mjs';import {providerFixture} from './test/provider-fixture.mjs';
import {IMAGE,GPU,reservation,createBody} from './session-policy.mjs';
const q=reservation(Date.now()-1000,'a'.repeat(32));
const p={id:'abcdefghijklm',name:q.name,image:IMAGE,cloud:'SECURE',gpu:{id:GPU,count:1},disk:60,ports:['8000/http'],mounts:{},cost:.59,createdAt:new Date().toISOString(),status:'RUNNING',actions:['stop']};
test('official MCP STOP then fresh GET, delete and explicit 404 establish cleanup',async()=>{
 const f=providerFixture([p]),client=runpodClient('DUMMY_CONTROL_KEY',{fetchImpl:f.fetch});assert.equal(await client.cleanup(p,q,.59),true);assert.deepEqual(f.calls.filter(c=>c.tool).map(c=>c.tool),['get-pod','pod-action','get-pod','delete-pod','get-pod']);
});
test('failed STOP/delete and failed get never masquerade as a deleted Pod',async()=>{
 for(const kind of ['stopWorks','deleteWorks','getFailure']){const f=providerFixture([p]);f[kind]=kind==='getFailure';const client=runpodClient('DUMMY_CONTROL_KEY',{fetchImpl:f.fetch});if(kind==='getFailure')await assert.rejects(client.cleanup(p,q,.59));else assert.equal(await client.cleanup(p,q,.59),false);}
});
test('unknown create is sent once and never retried, with no secrets returned',async()=>{
 const f=providerFixture();f.createFailure=true;const client=runpodClient('DUMMY_CONTROL_KEY',{fetchImpl:f.fetch});await assert.rejects(client.create({}));assert.equal(f.calls.filter(c=>c.tool==='create-pod').length,1);
 f.createFailure=false;f.sse=true;const pod=await client.create(createBody({reservation:q,inferenceKey:'a'.repeat(64)},Date.now()));assert.ok(!JSON.stringify(pod).includes('DUMMY_UPSTREAM_SECRET'));assert.equal(pod.env,undefined);
});
test('health calls use only fixed inference URL and inference key, never billing auth',async()=>{
 const calls=[];const client=runpodClient('DUMMY_CONTROL_KEY',{fetchImpl:async(url,options)=>{calls.push({url,options});return url.endsWith('/health')?new Response('OK'):Response.json({data:[{id:'huihui-qwen3-8b-v2'}]});}});
 assert.equal(await client.health(p,'DUMMY_INFERENCE_KEY'),true);assert.ok(calls.every(c=>c.url.startsWith('https://abcdefghijklm-8000.proxy.runpod.net/')));assert.ok(!JSON.stringify(calls).includes('DUMMY_CONTROL_KEY'));
 await assert.rejects(client.health({id:'attacker.test/path'},'DUMMY_INFERENCE_KEY'));assert.equal(calls.length,2);
});

test('malformed successful get replies never count as deletion',async()=>{
 for(const value of [null,false,0,'',[], 'not found']){
  const f=providerFixture([p]);
  const client=runpodClient('DUMMY_CONTROL_KEY',{fetchImpl:async(url,options)=>{
   const input=JSON.parse(options.body);
   if(input.method==='tools/call'&&input.params?.name==='get-pod')return Response.json({jsonrpc:'2.0',id:input.id,result:{isError:false,content:[{type:'text',text:JSON.stringify(value)}]}});
   return f.fetch(url,options);
  }});
  await assert.rejects(client.cleanup(p,q,.59),/RUNPOD_RESPONSE_INVALID/);
  assert.ok(!f.calls.some(c=>['pod-action','delete-pod'].includes(c.tool)));
 }
});
test('the exact structured get-pod 404 still establishes absence',async()=>{
 const f=providerFixture(),client=runpodClient('DUMMY_CONTROL_KEY',{fetchImpl:f.fetch});
 assert.equal(await client.get(p.id),null);
});
