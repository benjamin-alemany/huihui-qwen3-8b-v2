import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {GUARDS,activeVersion,receiptFrom,verifyGuardReceipts} from './receipts.mjs';
import {cloudflareTailClient,collectGuardReadiness,tailURL,safeTailFailure} from './tails.mjs';
const now=Date.parse('2026-11-03T03:22:00Z');
const versions=Object.fromEntries(Object.values(GUARDS).map((w,i)=>[w,`${i}1111111-1111-4111-8111-111111111111`]));
const reservation={name:'qwen-chat-session-'+'a'.repeat(16),image:'ghcr.io/benjamin-alemany/huihui-qwen3-8b-v2@sha256:'+'b'.repeat(64),windowStart:new Date(now-60000).toISOString(),windowEnd:new Date(now+120000).toISOString()};
const event=(role,heartbeat=false)=>({outcome:'ok',exceptions:[],truncated:false,event:{cron:'* * * * *'},eventTimestamp:now,scriptName:GUARDS[role],scriptVersion:{id:versions[GUARDS[role]]},logs:[{message:[JSON.stringify({event:'guard_tick',role,status:heartbeat?'unarmed':'waiting-for-reserved-pod',...(heartbeat?{}:{reservationName:reservation.name,image:reservation.image})})]}]});
test('exact current guard versions, nonce, image and recent cron ticks are required',()=>{
  const events=[event('primary'),event('backup')];assert.equal(verifyGuardReceipts(reservation,versions,events,{now}).schedulerReady,true);
  for(const mutate of [e=>e.outcome='exception',e=>e.exceptions=[{name:'Error'}],e=>e.truncated=true,e=>e.event={request:{}},e=>e.eventTimestamp=now-90001,e=>e.eventTimestamp=now+1,e=>e.scriptName='unrelated-worker',e=>e.scriptVersion.id=versions[GUARDS.backup],e=>e.logs[0].message=['not JSON'],e=>e.logs[0].message=[JSON.stringify({event:'guard_tick',role:'primary',status:'waiting-for-reserved-pod',reservationName:'other',image:reservation.image})]]){
    const e=structuredClone(events);mutate(e[0]);assert.throws(()=>verifyGuardReceipts(reservation,versions,e,{now}));
  }
  assert.throws(()=>verifyGuardReceipts(reservation,versions,[events[0],events[0]],{now}));
  assert.throws(()=>verifyGuardReceipts({...reservation,windowEnd:new Date(now).toISOString()},versions,events,{now}));
});
test('unarmed heartbeat cannot authorize a reservation or a Pod launch',()=>{
  const e=event('primary',true);assert.equal(receiptFrom(e,versions,reservation,{now}),null);
  const receipt=receiptFrom(e,versions,null,{now,heartbeatOnly:true});assert.equal(receipt.mode,'unarmed-heartbeat');
  assert.throws(()=>verifyGuardReceipts(reservation,versions,[e,event('backup',true)],{now}));
});
test('sanitized scheduled-tail fixtures require their matching versions and time',()=>{
  const base=new URL('./test/fixtures/guard-receipts/',import.meta.url);
  const r=JSON.parse(readFileSync(new URL('reservation.json',base)));
  const v=JSON.parse(readFileSync(new URL('versions.json',base)));
  const events=JSON.parse(readFileSync(new URL('events.json',base)));
  const timestamp=Math.max(...events.map(e=>e.eventTimestamp));
  assert.equal(verifyGuardReceipts(r,v,events,{now:timestamp}).schedulerReady,true);
  assert.throws(()=>verifyGuardReceipts(r,v,events,{now:timestamp+300000}));
});
test('gradual/ambiguous deployments and arbitrary tail destinations refuse to start',()=>{
  const v={version_id:versions[GUARDS.primary],percentage:100};assert.equal(activeVersion({deployments:[{versions:[v]}]}),v.version_id);
  for(const input of [{}, {deployments:[{versions:[{...v,percentage:50}]}]}, {deployments:[{versions:[v,v]}]}])assert.throws(()=>activeVersion(input));
  assert.ok(tailURL('wss://tail.developers.workers.dev/'+'a'.repeat(32)).startsWith('https://'));
  for(const u of ['wss://attacker.test/'+'a'.repeat(32),'https://tail.developers.workers.dev/'+'a'.repeat(32),'wss://user:pass@tail.developers.workers.dev/'+'a'.repeat(32),'wss://tail.developers.workers.dev/other','wss://tail.developers.workers.dev:8443/'+'a'.repeat(32),'wss://tail.developers.workers.dev/'+'a'.repeat(32)+'?redirect=x'])assert.throws(()=>tailURL(u));
});
function transport({heartbeat=false,dropBackup=false,rotate=false,badFrame=false,failBackup=false,failCleanup=false,binary=true}={}){
  const calls=[],sockets=[],deletes=[];let versionReads=0;
  const fetchImpl=async(url,options)=>{
    calls.push({url,options});const u=new URL(url),worker=Object.values(GUARDS).find(w=>u.pathname.includes('/scripts/'+w+'/'));
    if(u.hostname==='api.cloudflare.com'){
      assert.equal(options.headers.Authorization,'Bearer '+'D'.repeat(40));
      if(u.pathname.endsWith('/deployments')){versionReads++;const id=rotate&&versionReads>2?'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa':versions[worker];return Response.json({success:true,result:{deployments:[{versions:[{version_id:id,percentage:100}]}]}});}
      if(options.method==='DELETE'){deletes.push(worker);return Response.json({success:!failCleanup,result:{}});}
      assert.equal(options.method,'POST');return Response.json({success:true,result:{id:(worker===GUARDS.primary?'a':'b').repeat(32),url:'wss://tail.developers.workers.dev/'+(worker===GUARDS.primary?'a':'b').repeat(32)}});
    }
    assert.equal(u.hostname,'tail.developers.workers.dev');assert.equal(options.headers.Authorization,undefined);
    const role=u.pathname==='/'+'a'.repeat(32)?'primary':'backup';if(failBackup&&role==='backup')throw Error('dummy transport failure');
    class Socket extends EventTarget {binaryType='blob';accept(){assert.equal(this.binaryType,'arraybuffer');}send(){if(dropBackup&&role==='backup')return;setTimeout(()=>{const text=badFrame?'X'.repeat(65537):JSON.stringify(event(role,heartbeat));this.dispatchEvent(new MessageEvent('message',{data:binary?(this.binaryType==='arraybuffer'?new TextEncoder().encode(text).buffer:new Blob([text])):text}));},2);}close(){this.dispatchEvent(new Event('close'));}}
    const socket=new Socket();sockets.push(socket);return {status:101,webSocket:socket};
  };
  return {fetchImpl,calls,sockets,deletes};
}
test('tail collection uses two pinned APIs, no token on sockets, and always cleans sessions',async()=>{
  const t=transport();const result=await collectGuardReadiness('D'.repeat(40),reservation,{fetchImpl:t.fetchImpl,now:()=>now,timeoutMs:100});
  assert.equal(result.schedulerReady,true);assert.equal(t.deletes.length,2);assert.ok(!JSON.stringify(result).includes('D'.repeat(40)));
});
test('heartbeat-only collection explicitly refuses launch readiness',async()=>{
  const t=transport({heartbeat:true});const result=await collectGuardReadiness('D'.repeat(40),null,{heartbeatOnly:true,fetchImpl:t.fetchImpl,now:()=>now,timeoutMs:100});
  assert.equal(result.schedulerReady,false);assert.equal(result.heartbeatVerified,true);assert.equal(result.requiresExactReservation,true);assert.equal(t.deletes.length,2);
});
test('trusted account configuration changes only the fixed Cloudflare account path',async()=>{
  const accountId='1'.repeat(32),t=transport();
  const result=await collectGuardReadiness('D'.repeat(40),reservation,{accountId,fetchImpl:t.fetchImpl,now:()=>now,timeoutMs:100});assert.equal(result.schedulerReady,true);
  const api=t.calls.filter(c=>new URL(c.url).hostname==='api.cloudflare.com');assert(api.length>0);
  assert(api.every(c=>c.url.startsWith('https://api.cloudflare.com/client/v4/accounts/'+accountId+'/workers/scripts/')));
  assert(api.every(c=>Object.values(GUARDS).some(w=>new URL(c.url).pathname.includes('/scripts/'+w+'/'))));
  assert(t.calls.filter(c=>new URL(c.url).hostname==='tail.developers.workers.dev').every(c=>c.options.headers.Authorization===undefined));
});
test('invalid account identifiers refuse before any Cloudflare request',async()=>{
  let calls=0;const fetchImpl=async()=>{calls++;throw Error('No request');};
  for(const accountId of ['',null,123,'a'.repeat(31),'A'.repeat(32),'1'.repeat(32)+'/../../other','https://evil.invalid']){
    assert.throws(()=>cloudflareTailClient('D'.repeat(40),{accountId,fetchImpl}),e=>e.code==='ACCOUNT_FORMAT');
    await assert.rejects(collectGuardReadiness('D'.repeat(40),null,{accountId,fetchImpl,heartbeatOnly:true,timeoutMs:1}),e=>e.code==='ACCOUNT_FORMAT');
  }
  assert.equal(calls,0);assert.equal(safeTailFailure({code:'ACCOUNT_FORMAT'}),'ACCOUNT_FORMAT');
});
test('text frames also remain supported after selecting binary ArrayBuffer delivery',async()=>{
  const t=transport({binary:false});const r=await collectGuardReadiness('D'.repeat(40),reservation,{fetchImpl:t.fetchImpl,now:()=>now,timeoutMs:100});assert.equal(r.schedulerReady,true);assert.equal(t.deletes.length,2);
});
test('missing guard, rotated version, malformed frames and cleanup errors all fail closed',async()=>{
  for(const opts of [{dropBackup:true},{rotate:true},{badFrame:true},{failBackup:true},{failCleanup:true}]){
    const t=transport(opts);await assert.rejects(collectGuardReadiness('D'.repeat(40),reservation,{fetchImpl:t.fetchImpl,now:()=>now,timeoutMs:25}));assert.equal(t.deletes.length,2);
  }
});
test('invalid tokens and caller-selected resources are rejected before network access',async()=>{
  for(const token of ['', 'a'.repeat(32), 'a'.repeat(40)+'\nInjected: true'])assert.throws(()=>cloudflareTailClient(token));
  const t=transport();await assert.rejects(cloudflareTailClient('D'.repeat(40),{fetchImpl:t.fetchImpl}).open('other-worker'));assert.equal(t.calls.length,0);
});
test('diagnostics expose only a fixed stage code and never exception text',()=>{
  assert.equal(safeTailFailure({code:'TAIL_UPGRADE_HTTP_403',message:'DUMMY_SECRET'}),'TAIL_UPGRADE_HTTP_403');
  for(const error of [new Error('DUMMY_SECRET'),{code:'DUMMY_SECRET'},{code:'TAIL_CONNECT\nDUMMY_SECRET'},{code:'TAIL_CONNECT',message:'DUMMY_SECRET'}])assert.ok(!safeTailFailure(error).includes('DUMMY_SECRET'));
});
test('a completed WebSocket upgrade is not aborted by the old ten-second handshake deadline',async()=>{
  const t=transport(),session=await cloudflareTailClient('D'.repeat(40),{fetchImpl:t.fetchImpl}).open(GUARDS.primary);
  try{
    const upgrade=t.calls.find(c=>new URL(c.url).hostname==='tail.developers.workers.dev');
    await new Promise(resolve=>setTimeout(resolve,10050));
    assert.equal(upgrade.options.signal.aborted,false);
  }finally{await session.dispose();}
});


test('Hyperstack scheduled receipts require exact nonce and both immutable destroy expiries',async()=>{
 const {TARGET}=await import('../hyperstack/fixtures.mjs');
 const q={provider:'hyperstack',kind:'chat',minutes:30,name:'unjailed-chat-'+'a'.repeat(32),nonce:'a'.repeat(32),image:reservation.image,target:TARGET,createdNotBefore:now-60000,createdNotAfter:now+120000,deadline:now-60000+30*60000,windowStart:reservation.windowStart,windowEnd:reservation.windowEnd};
 const events=['primary','backup'].map(role=>({...event(role),logs:[{message:[JSON.stringify({event:'guard_tick',provider:'hyperstack',role,status:'waiting-for-reserved-vm',reservationName:q.name,image:q.image,nonce:q.nonce,deadline:q.deadline,expiry:q.deadline+(role==='backup'?60000:0)})]}]}));
 const proof=verifyGuardReceipts(q,versions,events,{now});assert.equal(proof.provider,'hyperstack');assert.equal(proof.nonce,q.nonce);assert.equal(proof.guards.backup.expiry,q.deadline+60000);
 for(const patch of [{provider:'runpod'},{status:'ARMED'},{nonce:'b'.repeat(32)},{deadline:q.deadline+1},{expiry:q.deadline+1},{image:reservation.image+'x'}]){
  const bad=structuredClone(events),tick=JSON.parse(bad[0].logs[0].message[0]);bad[0].logs[0].message[0]=JSON.stringify({...tick,...patch});assert.throws(()=>verifyGuardReceipts(q,versions,bad,{now}));
 }
 assert.throws(()=>verifyGuardReceipts(q,versions,[event('primary'),event('backup')],{now}));
});

test('ownership V2 requires explicit matching feature evidence from both current guard versions',async()=>{
 const {TARGET}=await import('../hyperstack/fixtures.mjs');
 const q={provider:'hyperstack',kind:'chat',minutes:30,ownershipPolicy:'nonce-name-v2',name:'unjailed-chat-'+'a'.repeat(32),nonce:'a'.repeat(32),image:reservation.image,target:TARGET,createdNotBefore:now-60000,createdNotAfter:now+120000,deadline:now-60000+30*60000,windowStart:reservation.windowStart,windowEnd:reservation.windowEnd};
 const events=['primary','backup'].map(role=>({...event(role),logs:[{message:[JSON.stringify({event:'guard_tick',provider:'hyperstack',role,status:'waiting-for-reserved-vm',ownershipPolicy:'nonce-name-v2',reservationName:q.name,image:q.image,nonce:q.nonce,deadline:q.deadline,expiry:q.deadline+(role==='backup'?60000:0)})]}]}));
 const proof=verifyGuardReceipts(q,versions,events,{now});assert.equal(proof.ownershipPolicy,'nonce-name-v2');assert.equal(proof.guards.primary.ownershipPolicy,'nonce-name-v2');assert.equal(proof.guards.backup.ownershipPolicy,'nonce-name-v2');
 for(const role of [0,1])for(const value of [undefined,null,'label-v1']){const bad=structuredClone(events),tick=JSON.parse(bad[role].logs[0].message[0]);if(value===undefined)delete tick.ownershipPolicy;else tick.ownershipPolicy=value;bad[role].logs[0].message[0]=JSON.stringify(tick);assert.throws(()=>verifyGuardReceipts(q,versions,bad,{now}));}
 const legacy={...q};delete legacy.ownershipPolicy;assert.throws(()=>verifyGuardReceipts(legacy,versions,events,{now}));const oldEvents=structuredClone(events);for(const e of oldEvents){const tick=JSON.parse(e.logs[0].message[0]);delete tick.ownershipPolicy;e.logs[0].message[0]=JSON.stringify(tick);}const oldProof=verifyGuardReceipts(legacy,versions,oldEvents,{now});assert.equal('ownershipPolicy'in oldProof,false);assert.equal('ownershipPolicy'in oldProof.guards.primary,false);assert.throws(()=>verifyGuardReceipts(q,versions,oldEvents,{now}));
});
