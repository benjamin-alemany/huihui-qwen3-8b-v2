import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{queryFrom,checkChatStop} from './stop.mjs';
const start='2026-11-01T12:00:00Z',image='ghcr.io/benjamin-alemany/huihui-qwen3-8b-v2@sha256:'+'f4fda4da17fe00a8188527d3a774dcc487529b63fe2e10359912d24d4ee83761';
const q={kind:'chat',name:'qwen-chat-session-1234567890abcdef',image,windowStart:start,windowEnd:'2026-11-01T12:05:00Z'};
const p={id:'dummy123',name:q.name,image,createdAt:'2026-11-01T12:01:00Z',cloud:'SECURE',gpu:{id:'NVIDIA A40',count:1},status:'RUNNING',actions:['stop'],locked:false};
const env={ARMED_CHAT:JSON.stringify(q),RUNPOD_API_KEY:'DUMMY-NOT-A-REAL-KEY',CHAT_STOP_ROLE:'primary'};
const list=pods=>({pods,pagination:{hasNextPage:false}});
function fake(sequence){const calls=[];return {calls,fetchImpl:async(url,options)=>{calls.push({url,options});const value=sequence.shift();assert.ok(value!==undefined,'Unexpected request');return new Response(JSON.stringify(value),{status:200});}};}
test('unarmed makes zero provider calls',async()=>{assert.equal((await checkChatStop({}, {fetchImpl:()=>assert.fail()})).status,'unarmed');});
test('pre-armed reservation can wait safely before creation',async()=>{const f=fake([list([])]);assert.equal((await checkChatStop(env,f)).status,'waiting-for-reserved-pod');assert.equal(f.calls.length,1);});
test('deadline is createdAt+eighteen minutes and cannot be extended by input',async()=>{const f=fake([list([p])]);const r=await checkChatStop({...env,ARMED_CHAT:JSON.stringify({...q,deadline:'2099-01-01'})},{...f,now:Date.parse(start)+18*60000});assert.equal(r.results[0].status,'armed');assert.equal(r.results[0].deadline,Date.parse(p.createdAt)+18*60000);assert.equal(f.calls.length,1);});
test('expiry stops and verifies with fresh GET',async()=>{const f=fake([list([p]),p,{}, {...p,status:'EXITED'}]);const r=await checkChatStop(env,{...f,now:Date.parse(p.createdAt)+18*60000});assert.equal(r.results[0].status,'stopped_verified');assert.equal(f.calls[2].options.method,'POST');assert.deepEqual(JSON.parse(f.calls[2].options.body),{action:'stop'});assert.equal(f.calls[3].options.method,'GET');assert.ok(f.calls.every(c=>c.options.redirect==='manual'));});
test('unrelated identity or outside reservation window is ignored',async()=>{for(const other of [{...p,name:'unrelated'},{...p,image:'another-image'},{...p,createdAt:'2026-11-01T11:59:59Z'}]){const f=fake([list([other])]);assert.equal((await checkChatStop(env,f)).status,'waiting-for-reserved-pod');assert.equal(f.calls.length,1);}});
test('changed identity or GPU never receives STOP',async()=>{for(const changed of [{...p,image:'another-image'},{...p,gpu:{id:'wrong',count:1}}]){const f=fake([list([p]),changed]);await assert.rejects(checkChatStop(env,{...f,now:Date.parse(p.createdAt)+18*60000}));assert.ok(f.calls.every(c=>c.options.method==='GET'));}});
test('malformed reservation and missing credential fail closed',async()=>{for(const query of [{...q,name:'other'},{...q,windowStart:'2026-11-01T12:00:00'},{...q,windowEnd:'2026-11-01T13:00:00Z'}])assert.throws(()=>queryFrom(JSON.stringify(query)));await assert.rejects(checkChatStop({ARMED_CHAT:env.ARMED_CHAT}));});
test('unverified STOP is not called success',async()=>{const f=fake([list([p]),p,{},p]);assert.equal((await checkChatStop(env,{...f,now:Date.parse(p.createdAt)+18*60000})).results[0].status,'stop_requested_retrying');});
test('provider redirect is never followed',async()=>{await assert.rejects(checkChatStop(env,{fetchImpl:async()=>new Response('',{status:302})}));});
test('no public control endpoint',async()=>{assert.equal((await worker.fetch()).status,404);});
test('backup uses a fixed extra minute, not a configurable longer session',async()=>{const f=fake([list([p])]);const r=await checkChatStop({...env,CHAT_STOP_ROLE:'backup'},{...f,now:Date.parse(p.createdAt)+18*60000});assert.equal(r.results[0].status,'armed');assert.equal(r.results[0].deadline,Date.parse(p.createdAt)+19*60000);});
test('invalid role cannot arm a differently timed session',async()=>{await assert.rejects(checkChatStop({...env,CHAT_STOP_ROLE:'ten-hours'}));});
test('a successful prelaunch tick identifies the exact reservation without logging credentials',async()=>{
 const oldFetch=globalThis.fetch,oldLog=console.log,lines=[];
 globalThis.fetch=async()=>new Response(JSON.stringify(list([])),{status:200});console.log=value=>lines.push(value);
 try{await worker.scheduled({},env);}finally{globalThis.fetch=oldFetch;console.log=oldLog;}
 const receipt=JSON.parse(lines[0]);assert.equal(receipt.event,'guard_tick');assert.equal(receipt.role,'primary');
 assert.equal(receipt.reservationName,q.name);assert.equal(receipt.image,q.image);assert.equal(receipt.status,'waiting-for-reserved-pod');
 assert.ok(!lines.join('').includes(env.RUNPOD_API_KEY));
});

test('probe has a fixed four-minute primary and five-minute backup',async()=>{
 const probe={...q,kind:'probe',name:'qwen-chat-probe-1234567890abcdef'},pod={...p,name:probe.name};
 for(const [role,minutes] of [['primary',4],['backup',5]]){
  const f=fake([list([pod])]);const r=await checkChatStop({...env,CHAT_STOP_ROLE:role,ARMED_CHAT:JSON.stringify(probe)},{...f,now:Date.parse(p.createdAt)});
  assert.equal(r.results[0].deadline,Date.parse(p.createdAt)+minutes*60000);
 }
});
test('invalid stages, stage/name mismatches and other images refuse arming',()=>{
 for(const bad of [{...q,kind:'ten-hours'},{...q,kind:'probe'},{...q,image:'ghcr.io/benjamin-alemany/huihui-qwen3-8b-v2@sha256:'+'b'.repeat(64)}])
  assert.throws(()=>queryFrom(JSON.stringify(bad)));
});

test('owner-requested early stop only shortens, never extends the original deadline',async()=>{
 for(const earlyStopAt of ['2026-11-01T12:03:00Z','2099-01-01T00:00:00Z']){
  const f=fake([list([p])]);const r=await checkChatStop({...env,ARMED_CHAT:JSON.stringify({...q,earlyStopAt})},{...f,now:Date.parse(p.createdAt)});
  assert.equal(r.results[0].deadline,Math.min(Date.parse(p.createdAt)+18*60000,Date.parse(earlyStopAt)));
 }
 assert.throws(()=>queryFrom(JSON.stringify({...q,earlyStopAt:'not-a-date'})));
});
test('product reservations bind 15/30/60 minutes and the independent backup minute',async()=>{
 for(const minutes of [15,30,60])for(const [role,extra]of [['primary',0],['backup',1]]){
  const reservation={...q,minutes},f=fake([list([p])]);
  const result=await checkChatStop({...env,CHAT_STOP_ROLE:role,ARMED_CHAT:JSON.stringify(reservation)},{...f,now:Date.parse(p.createdAt)});
  assert.equal(result.results[0].deadline,Date.parse(p.createdAt)+(minutes+extra)*60000);
 }
 for(const minutes of [0,18,31,61,600,'30'])assert.throws(()=>queryFrom(JSON.stringify({...q,minutes})));
 assert.throws(()=>queryFrom(JSON.stringify({...q,kind:'probe',name:'qwen-chat-probe-1234567890abcdef',minutes:30})));
});
