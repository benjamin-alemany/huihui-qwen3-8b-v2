import test from 'node:test';
import assert from 'node:assert/strict';
import {collectHostDiagnostics,parseHostEvents,safeDiagnosticReceipt} from './host-diagnostics.mjs';
import {normalizeVM} from './policy.mjs';
import {NOW,RESERVATION,rawVM} from './fixtures.mjs';

const SESSION='22222222-2222-4222-8222-222222222222',KEY='DUMMY_PROVIDER_KEY_NOT_CONSOLE',SECRET='DUMMY_RAW_CONSOLE_OR_PROVIDER_SECRET';
const PREFIX='UNJAILED_HOST_EVENT ';
function reservation(){const q={...structuredClone(RESERVATION),kind:'chat',provider:'hyperstack',minutes:30,ownershipPolicy:'nonce-name-v2',image:'ghcr.io/benjamin-alemany/huihui-qwen3-8b-v2@sha256:'+'a'.repeat(64)};q.deadline=q.createdNotBefore+q.minutes*60000;q.windowStart=new Date(q.createdNotBefore).toISOString();q.windowEnd=new Date(q.createdNotAfter).toISOString();return q;}
function event(q,patch={}){return {version:1,sessionId:SESSION,nonce:q.nonce,component:'runtime',phase:'model-free-preflight',status:'running',at:NOW,deadline:q.deadline,...patch};}
function setup(){
  const q=reservation(),p=normalizeVM(rawVM({labels:[]})),s={gets:[],calls:[],postStatus:202,post:{status:true,request_id:6190,message:SECRET},results:[{status:true,logs:PREFIX+JSON.stringify(event(q))}],current:()=>p};
  const args={key:KEY,allocation:p,reservation:q,sessionId:SESSION,now:()=>NOW,providerGet:async id=>{s.gets.push(id);return s.current(s.gets.length);},fetchImpl:async(url,options)=>{
    s.calls.push({url,options});const u=new URL(url);
    assert.equal(u.origin,'https://infrahub-api.nexgencloud.com');assert.equal(u.pathname,'/v1/core/virtual-machines/44/logs');
    assert.equal(options.headers.api_key,KEY);assert.equal(options.redirect,'manual');assert(options.signal instanceof AbortSignal);
    if(options.method==='POST'){assert.equal(u.search,'');assert.deepEqual(JSON.parse(options.body),{length:200});return Response.json(s.post,{status:s.postStatus});}
    assert.equal(options.method,'GET');assert.equal(u.search,'?request_id=6190');assert.equal(options.body,undefined);
    return Response.json(s.results.shift()??{status:false,logs:null,message:SECRET});
  }};return {s,args,q,p};
}

test('console reader uses official fixed async endpoint with fresh ACTIVE ownership before POST and GET',async()=>{
  const {s,args,q,p}=setup(),r=await collectHostDiagnostics(args);
  assert.deepEqual(r,{version:1,provider:'hyperstack',kind:'host-console-progress-v1',state:'available',sessionId:SESSION,nonce:q.nonce,deadline:q.deadline,allocationId:'44',observedAt:NOW,events:[event(q)],diagnosticOnly:true});
  assert.deepEqual(s.gets,['44','44']);assert.deepEqual(s.calls.map(x=>x.options.method),['POST','GET']);
  assert.deepEqual(safeDiagnosticReceipt(r,{allocation:p,reservation:q,sessionId:SESSION}),r);
  for(const secret of [KEY,SECRET,'request_id','logs','user_data'])assert(!JSON.stringify(r).includes(secret));
});

test('schema-only 200 request and logs payloads work without undocumented response metadata',async()=>{
  const {s,args}=setup();s.postStatus=200;s.post={request_id:6190};s.results=[{logs:''}];
  const r=await collectHostDiagnostics(args);assert.equal(r.state,'available');assert.deepEqual(r.events,[]);assert.equal(r.diagnosticOnly,true);
});

test('processing is explicit and has a hard maximum of two GET polls, no new log request',async()=>{
  const {s,args}=setup();s.results=[];const r=await collectHostDiagnostics(args);
  assert.equal(r.state,'processing');assert.deepEqual(r.events,[]);assert.equal(s.gets.length,3);assert.deepEqual(s.calls.map(x=>x.options.method),['POST','GET','GET']);assert(!JSON.stringify(r).includes(SECRET));
});

test('a second bounded poll can return markers, with a fresh bound VM before every read',async()=>{
  const {s,args,q}=setup();s.results.unshift({status:false,message:SECRET,logs:null});
  const r=await collectHostDiagnostics(args);assert.equal(r.state,'available');assert.deepEqual(r.events,[event(q)]);assert.equal(s.gets.length,3);assert.equal(s.calls.length,3);
});

test('wrong initial identity, key, session or reservation sends no console request',async()=>{
  for(const patch of [{allocation:{...setup().p,id:'55'}},{sessionId:SECRET},{key:'bad\n'+SECRET},{reservation:{...reservation(),nonce:'b'.repeat(32)}}]){
    const {s,args}=setup();const r=await collectHostDiagnostics({...args,...patch});assert.equal(r.state,'unavailable');assert.deepEqual(r.events,[]);assert.equal(s.calls.length,0);assert(!JSON.stringify(r).includes(SECRET));
  }
});

test('fresh wrong ID, time, target, absence or non-ACTIVE state refuses before console request',async()=>{
  const changed=[null,{id:'55'},{createdAt:new Date(NOW+1).toISOString()},{environment:{id:99,name:'wrong',region:'CANADA-1'}},{status:'BUILD'},{status:'SHUTOFF'}];
  for(const patch of changed){const {s,args,p}=setup();s.current=()=>patch===null?null:{...p,...patch};assert.equal((await collectHostDiagnostics(args)).state,'unavailable');assert.equal(s.calls.length,0);}
});

test('a renamed previously bound V2 VM and equivalent naive UTC readback still bind',async()=>{
  const {s,args,p}=setup();s.current=()=>({...p,name:'renamed',labels:[],createdAt:p.createdAt.slice(0,-1)});assert.equal((await collectHostDiagnostics(args)).state,'available');assert.equal(s.calls.length,2);
});

test('identity loss after POST or between polls prevents the next console GET',async()=>{
  for(const failOn of [2,3]){
    const {s,args,p}=setup();s.results=[];s.current=n=>n===failOn?{...p,id:'55'}:p;
    const r=await collectHostDiagnostics(args);assert.equal(r.state,'unavailable');assert.deepEqual(r.events,[]);assert.equal(s.calls.length,failOn-1);
  }
});

test('redirects/errors, invalid request IDs and malformed provider envelopes never expose raw output',async()=>{
  for(const patch of [{postStatus:401},{postStatus:302},{post:{status:false,request_id:6190,message:SECRET}},{post:{request_id:'6190/../../bad'}},{post:{request_id:0}},{post:{request_id:6190,api_key:SECRET}},{results:[{logs:null,error:SECRET}]},{results:[{status:false,logs:SECRET}]},{results:[{logs:42,message:SECRET}]}]){
    const {s,args}=setup();Object.assign(s,patch);const r=await collectHostDiagnostics(args);assert.equal(r.state,'unavailable');assert.deepEqual(r.events,[]);assert(!JSON.stringify(r).includes(SECRET));assert(s.calls.length<=2);
  }
});

test('oversized provider body is refused and raw console/provider errors are never returned',async()=>{
  for(const mode of ['oversized','throw']){
    const {args}=setup();args.fetchImpl=async()=>{if(mode==='throw')throw Error(SECRET);return Response.json({logs:SECRET.repeat(20000)});};
    const r=await collectHostDiagnostics(args);assert.equal(r.state,'unavailable');assert.deepEqual(r.events,[]);assert(!JSON.stringify(r).includes(SECRET));
  }
});

test('hung fresh read has a hard timeout and never schedules a console request afterward',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const {s,args}=setup();let finish;
  args.providerGet=()=>new Promise(resolve=>{finish=resolve;});const pending=collectHostDiagnostics(args);await Promise.resolve();await Promise.resolve();t.mock.timers.tick(8001);
  const r=await pending;assert.equal(r.state,'unavailable');finish(args.allocation);await Promise.resolve();await Promise.resolve();assert.equal(s.calls.length,0);t.mock.timers.reset();
});

test('hung provider response also times out and cannot leak error text',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const {args}=setup();let requested;
  const seen=new Promise(resolve=>{requested=resolve;});args.fetchImpl=()=>{requested();return new Promise(()=>{});};
  const pending=collectHostDiagnostics(args);await seen;t.mock.timers.tick(8001);const r=await pending;assert.equal(r.state,'unavailable');assert.deepEqual(r.events,[]);t.mock.timers.reset();
});

test('parser drops foreign/malformed/unknown/extra/duplicate-field events and all ordinary console lines',()=>{
  const q=reservation(),good=event(q),bad=[{sessionId:'33333333-3333-4333-8333-333333333333'},{nonce:'b'.repeat(32)},{deadline:q.deadline+1},{component:'model'},{phase:SECRET},{status:'ready'},{version:2},{extra:SECRET},{at:NOW+1},{at:q.createdNotBefore-1},{at:Number.MAX_SAFE_INTEGER}].map(p=>PREFIX+JSON.stringify({...good,...p}));
  bad.push(PREFIX+JSON.stringify(good).replace('"version":1','"version":1,"version":1'),PREFIX+'{bad JSON}',SECRET,'timestamp '+PREFIX+JSON.stringify(good));
  const logs=[...bad,PREFIX+JSON.stringify(good)].join('\n');assert.deepEqual(parseHostEvents(logs,{reservation:q,sessionId:SESSION,observedAt:NOW}),[good]);
});

test('parser permits only explicit component phases and statuses, without conferring health',()=>{
  const q=reservation();for(const [component,phase]of [['bootstrap','driver-check'],['bootstrap','host-ready-model-not-started'],['runtime','ready']])for(const status of ['running','failed','passed']){
    const e=event(q,{component,phase,status});assert.deepEqual(parseHostEvents(PREFIX+JSON.stringify(e),{reservation:q,sessionId:SESSION,observedAt:NOW}),[e]);
  }
  assert.deepEqual(parseHostEvents(PREFIX+JSON.stringify(event(q,{component:'bootstrap',phase:'ready'})),{reservation:q,sessionId:SESSION,observedAt:NOW}),[]);
});

test('parser enforces line/body bounds and retains at most the last sixteen valid markers',()=>{
  const q=reservation(),events=Array.from({length:25},(_,i)=>event(q,{at:q.createdNotBefore+i}));
  assert.deepEqual(parseHostEvents(events.map(e=>PREFIX+JSON.stringify(e)).join('\r\n'),{reservation:q,sessionId:SESSION,observedAt:NOW}),events.slice(-16));
  assert.deepEqual(parseHostEvents(PREFIX+' '.repeat(1024)+JSON.stringify(event(q)),{reservation:q,sessionId:SESSION,observedAt:NOW}),[]);
  assert.deepEqual(parseHostEvents('X'.repeat(256*1024)+PREFIX+JSON.stringify(event(q)),{reservation:q,sessionId:SESSION,observedAt:NOW}),[]);
});

test('persisted summary validator reconstructs only strictly bound receipts and rejects added secrets',async()=>{
  const {args,q,p}=setup(),r=await collectHostDiagnostics(args),context={allocation:p,reservation:q,sessionId:SESSION};
  for(const patch of [{raw:SECRET},{nonce:'b'.repeat(32)},{allocationId:'55'},{sessionId:null},{deadline:q.deadline+1},{diagnosticOnly:false},{observedAt:q.createdNotBefore-1},{events:[{...event(q),secret:SECRET}]},{events:Array(17).fill(event(q))},{state:'processing'},{state:'unavailable'}])assert.equal(safeDiagnosticReceipt({...r,...patch},context),null);
  const safe=safeDiagnosticReceipt(r,context);safe.events[0].phase='ready';assert.equal(r.events[0].phase,'model-free-preflight');assert.equal(safeDiagnosticReceipt({...r,state:'processing',events:[]},context).state,'processing');
  assert.equal(safeDiagnosticReceipt(r,{...context,sessionId:'wrong'}),null);
});
