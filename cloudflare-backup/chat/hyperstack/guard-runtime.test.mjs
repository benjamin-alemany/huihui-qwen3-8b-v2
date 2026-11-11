import test from 'node:test';
import assert from 'node:assert/strict';
import {hyperstackGuardRuntime} from './guard-runtime.mjs';
import {hyperstackClient} from './client.mjs';
import {normalizeVM} from './policy.mjs';
import {NOW,TARGET,RESERVATION,rawVM,fixture,Store} from './fixtures.mjs';
const SECRET='DUMMY_HYPERSTACK_API_KEY_OUTSIDE_VM';
const IMAGE='ghcr.io/benjamin-alemany/huihui-qwen3-8b-v2@sha256:'+'a'.repeat(64);
const reservation=(nonce='a'.repeat(32),time=NOW)=>({...RESERVATION,kind:'chat',provider:'hyperstack',minutes:30,image:IMAGE,nonce,name:'unjailed-chat-'+nonce,createdNotBefore:time,createdNotAfter:time+300000,deadline:time+1800000,windowStart:new Date(time).toISOString(),windowEnd:new Date(time+300000).toISOString()});
class Storage extends Store{
 async delete(key){return this.rows.delete(key);}
 async setAlarm(at){this.rows.set('$alarm',at);}
 async deleteAlarm(){this.rows.delete('$alarm');}
}
function harness(role='primary'){
 let time=NOW;const store=new Storage(),s=fixture();
 const factory=(key,target)=>{assert.equal(key,SECRET);assert.deepEqual(target,TARGET);return hyperstackClient(key,{target,fetchImpl:s.fetch,now:()=>time}).destroyClient();};
 const options={target:TARGET,role,providerFactory:factory,now:()=>time};
 return {store,s,options,runtime:hyperstackGuardRuntime(store,options),fresh:()=>hyperstackGuardRuntime(store,options),set time(t){time=t;},get time(){return time;}};
}
test('runtime stores its own key separately and emits only immutable keyless reservation evidence',async()=>{
 const h=harness(),q=reservation(),armed=await h.runtime.arm(q,SECRET);assert.equal(armed.armed,true);assert.equal(armed.name,q.name);assert.equal(armed.image,IMAGE);assert.equal(armed.deadline,q.deadline);assert.equal(armed.expiry,q.deadline);assert.equal(armed.minutes,30);assert.equal(await h.store.get('hyperstack-guard-key-v1'),SECRET);assert(!JSON.stringify(armed).includes(SECRET));assert((await h.store.get('$alarm'))<=NOW+100);
 await assert.rejects(h.runtime.arm({...q,image:IMAGE.slice(0,-1)+'b'},SECRET));await assert.rejects(h.runtime.arm(q,SECRET+'changed'));
});
test('deadline cleanup archives retained IDs, removes the key and permits a distinct next session',async()=>{
 const h=harness(),q=reservation();await h.runtime.arm(q,SECRET);h.s.vms.push(rawVM());await h.runtime.tick();h.time=q.deadline;
 const stopped=await h.runtime.tick();assert.equal(stopped.vmCleanupVerified,true);assert.equal(stopped.vmAbsent,true);assert.equal(stopped.inventoryAbsent,true);assert.equal(stopped.complete,true);assert.equal(stopped.deleted[0].id,'44');assert.equal(stopped.armed,true);
 const archived=await h.runtime.disarm(q.name);assert.equal(archived.unarmed,true);assert.equal(archived.armed,false);assert.equal(archived.billingSettlementPending,true);assert(!JSON.stringify(archived).includes(SECRET));assert.equal(await h.store.get('hyperstack-guard-key-v1'),undefined);assert.equal(await h.store.get('$alarm'),undefined);assert.equal((await h.runtime.report()).bindings[0].id,'44');
 await assert.rejects(h.runtime.arm(q,SECRET));const next=reservation('b'.repeat(32),h.time);await h.runtime.arm(next,SECRET);assert.equal((await h.runtime.report()).name,next.name);assert.equal((await h.store.get('hyperstack-guard-last-archive-v1:'+q.nonce)).bindings[0].id,'44');
});
test('backup expiry is exactly one minute later and explicit Stop only shortens execution',async()=>{
 const h=harness('backup'),q=reservation();await h.runtime.arm(q,SECRET);h.s.vms.push(rawVM());h.time=q.deadline;assert.equal((await h.runtime.tick()).status,'ARMED');assert.equal(h.s.vms.length,1);await assert.rejects(h.runtime.shorten('unrelated',h.time));await assert.rejects(h.runtime.shorten(q.name,h.time+1001));await h.runtime.shorten(q.name,h.time);assert.equal((await h.runtime.tick()).vmCleanupVerified,true);assert.equal((await h.runtime.report()).expiry,q.deadline+60000);
});
test('no-create cancellation needs explicit trusted proof and fresh complete empty inventory',async()=>{
 const h=harness(),q=reservation();await h.runtime.arm(q,SECRET);await assert.rejects(h.runtime.disarm(q.name));assert.equal(await h.store.get('hyperstack-guard-key-v1'),SECRET);
 const done=await h.runtime.disarm(q.name,{definiteNoCreate:true});assert.equal(done.armed,false);assert.equal(done.status,'DEFINITE_NO_CREATE_ARCHIVED');assert.deepEqual(done.bindings,[]);assert.equal(h.s.calls.filter(c=>c.method!=='GET').length,0);
});
test('an allocation contradicting no-create proof is durably bound instead of erasing its guard',async()=>{
 const h=harness(),q=reservation();await h.runtime.arm(q,SECRET);h.s.vms.push(rawVM());await assert.rejects(h.runtime.disarm(q.name,{definiteNoCreate:true}));assert.equal((await h.runtime.report()).bindings[0].id,'44');assert.equal(await h.store.get('hyperstack-guard-key-v1'),SECRET);
 h.s.vms[0].name='renamed';h.s.vms[0].labels=[];await h.runtime.shorten(q.name,h.time);assert.equal((await h.runtime.tick()).vmCleanupVerified,true);
});
test('unknown create, incomplete inventory and unexpected volumes retain credentials and reservations',async()=>{
 const h=harness(),q=reservation();await h.runtime.arm(q,SECRET);h.s.listHook=()=>Response.json({status:true,page:1,page_size:100,count:2,instances:[]});await assert.rejects(h.runtime.disarm(q.name,{definiteNoCreate:true}));assert.equal(await h.store.get('hyperstack-guard-key-v1'),SECRET);
 h.s.listHook=null;h.s.vms.push(rawVM({volume_attachments:[{id:9,volume:{id:77}}]}));await h.runtime.tick();h.time=q.deadline;await h.runtime.tick();await assert.rejects(h.runtime.disarm(q.name));assert.equal(await h.store.get('hyperstack-guard-key-v1'),SECRET);assert.deepEqual((await h.runtime.report()).unexpectedVolumeIds,['77']);
});
test('crashed leases recover on a scheduled alarm without losing the exact reservation',async()=>{
 const h=harness(),q=reservation();await h.runtime.arm(q,SECRET);const m=await h.store.get('hyperstack-guard-runtime-v1');m.token='crashed-token';m.leaseUntil=NOW+1000;await h.store.put('hyperstack-guard-runtime-v1',m);assert.equal((await h.fresh().tick()).status,'busy');assert.equal(h.s.calls.length,0);
 h.time=NOW+1001;assert.equal((await h.fresh().tick()).status,'ARMED');assert((await h.store.get('$alarm'))<=h.time+10000);assert.equal((await h.runtime.report()).nonce,q.nonce);
});
test('slow complete pagination renews the exact guard lease per API page without starving unknown-create discovery',async()=>{
 const h=harness(),q=reservation();await h.runtime.arm(q,SECRET);
 h.s.vms=[...Array.from({length:200},(_,i)=>rawVM({id:1000+i,name:'unrelated-'+i,labels:[]})),rawVM()];
 let pages=0;h.s.listHook=async u=>{
  const page=Number(u.searchParams.get('page'));h.time+=20000;pages++;
  // At page three the entire list has exceeded its initial 45s lease, while
  // every request is below 25s. A concurrent alarm must still see it as busy.
  assert.equal((await h.fresh().tick()).status,'busy');
  return Response.json({status:true,page,page_size:100,count:201,instances:h.s.vms.slice((page-1)*100,page*100)});
 };
 const discovered=await h.runtime.tick();assert.equal(pages,3);assert.equal(h.time,NOW+60000);assert.equal(discovered.status,'ARMED');assert.deepEqual(discovered.bindings.map(p=>p.id),['44']);
 h.s.listHook=null;h.time=q.deadline;assert.equal((await h.runtime.tick()).vmCleanupVerified,true);assert(h.s.vms.every(p=>p.id!==44));
});
test('a replaced guard token prevents another inventory page and retains key and cleanup uncertainty',async()=>{
 const h=harness(),q=reservation();await h.runtime.arm(q,SECRET);let pages=0;
 h.s.listHook=async u=>{
  pages++;const m=await h.store.get('hyperstack-guard-runtime-v1');m.token='new-operation-token';m.leaseUntil=h.time+45000;await h.store.put('hyperstack-guard-runtime-v1',m);
  return Response.json({status:true,page:Number(u.searchParams.get('page')),page_size:100,count:101,instances:Array.from({length:100},(_,i)=>rawVM({id:1000+i,name:'unrelated-'+i,labels:[]}))});
 };
 await assert.rejects(h.runtime.tick(),/GUARD_LEASE_CHANGED/);assert.equal(pages,1);assert.equal(h.s.calls.filter(c=>c.method!=='GET').length,0);assert.equal(await h.store.get('hyperstack-guard-key-v1'),SECRET);
 const state=await h.store.get('hyperstack-destroy-reservation');assert.equal(state.vmCleanupVerified,false);assert.deepEqual(state.bindings,[]);
});
test('untrusted targets, partial envelopes and provider create capability fail closed',async()=>{
 const h=harness(),q=reservation();await assert.rejects(hyperstackGuardRuntime(h.store,{target:{...TARGET,environmentId:99},role:'primary',providerFactory:()=>({}),now:()=>NOW}).arm(q,SECRET));
 await assert.rejects(h.runtime.arm({...RESERVATION},SECRET));await h.runtime.arm(q,SECRET);
 const unsafe=hyperstackGuardRuntime(h.store,{target:TARGET,role:'primary',providerFactory:()=>({list(){},get(){},remove(){},create(){}}),now:()=>NOW});await assert.rejects(unsafe.tick());assert.equal(await h.store.get('hyperstack-guard-key-v1'),SECRET);
});

function operatorPacket(q){return {version:1,id:'11111111-1111-4111-8111-111111111111',sessionId:'22222222-2222-4222-8222-222222222222',approvalId:'DUMMY_ONE_ACCEPTANCE',reservation:q,allocation:normalizeVM(rawVM({labels:[]})),observedAt:NOW+1000,deleteRequestedAt:NOW+2000,absenceObservedAt:NOW+3000,reason:'MISSING_PROVIDER_LABEL'};}
async function operatorHarness(){const h=harness(),q=reservation();await h.runtime.arm(q,SECRET);h.time=NOW+300001;const packet=operatorPacket(q);return {h,q,packet,call:(input=packet,patch={})=>hyperstackGuardRuntime(h.store,{...h.options,operatorLocked:true,operatorAbsenceJSON:JSON.stringify(packet),...patch}).operatorAbsence(input)};}
test('operator absence independently verifies and atomically archives truthful evidence before clearing guard key',async()=>{
 const {h,q,packet,call}=await operatorHarness(),receipt=await call();assert.equal(receipt.operatorReconciled,true);assert.equal(receipt.reconciliationId,packet.id);assert.equal(receipt.allocationId,'44');assert.equal(receipt.armed,false);assert.equal(receipt.vmCleanupVerified,true);assert.deepEqual(receipt.deleted,[]);assert.deepEqual(receipt.bindings,[]);assert.equal(receipt.billingSettlementPending,true);assert(!JSON.stringify(receipt).includes(SECRET));assert.equal(await h.store.get('hyperstack-guard-key-v1'),undefined);assert.equal(await h.store.get('hyperstack-destroy-reservation'),undefined);assert.equal(await h.store.get('$alarm'),undefined);
 const archived=await h.store.get('hyperstack-operator-absence-v1:'+packet.id);assert.deepEqual(archived.packet.allocation.labels,[]);assert.equal(archived.packet.reason,'MISSING_PROVIDER_LABEL');assert.equal(h.s.calls.length,3);assert(h.s.calls.every(c=>c.method==='GET'));assert.equal((await h.runtime.report()).status,'OPERATOR_VM_ABSENCE_ARCHIVED');await assert.rejects(h.runtime.arm(q,SECRET));
});
test('operator recovery requires locked source authority and exact packet before provider I/O',async()=>{
 const {h,packet,call}=await operatorHarness();await assert.rejects(call(packet,{operatorLocked:false}));await assert.rejects(call(packet,{operatorAbsenceJSON:undefined}));await assert.rejects(call({...packet,id:'33333333-3333-4333-8333-333333333333'}));assert.equal(h.s.calls.length,0);assert.equal(await h.store.get('hyperstack-guard-key-v1'),SECRET);
});
test('operator proof fails closed for live, unrelated, failed inventory and final direct-read failure',async()=>{
 for(const mode of ['live','unrelated','list','final']){
  const {h,packet,call}=await operatorHarness();if(mode==='live')h.s.vms.push(rawVM({labels:[]}));if(mode==='unrelated')h.s.vms.push(rawVM({id:45,name:'unrelated',labels:[]}));if(mode==='list')h.s.listHook=()=>Response.json({status:true,instances:'invalid'});
  if(mode==='final'){const base=h.s.fetch;let gets=0;h.s.fetch=async(url,opt)=>{if(new URL(url).pathname.endsWith('/44')&&++gets===2)return Response.json({status:false,error_reason:'forbidden'},{status:403});return base(url,opt);};}
  await assert.rejects(call());assert.equal(await h.store.get('hyperstack-guard-key-v1'),SECRET);assert.equal(await h.store.get('hyperstack-operator-absence-v1:'+packet.id),undefined);assert(h.s.calls.every(c=>c.method==='GET'));
 }
});
test('old operator replay returns its exact archive and cannot erase a newer guard reservation',async()=>{
 const {h,packet,call}=await operatorHarness(),first=await call();const next=reservation('b'.repeat(32),h.time);await h.runtime.arm(next,SECRET);const before={meta:await h.store.get('hyperstack-guard-runtime-v1'),core:await h.store.get('hyperstack-destroy-reservation'),alarm:await h.store.get('$alarm')},calls=h.s.calls.length;
 assert.deepEqual(await call(),first);assert.deepEqual(await h.store.get('hyperstack-guard-runtime-v1'),before.meta);assert.deepEqual(await h.store.get('hyperstack-destroy-reservation'),before.core);assert.equal(await h.store.get('$alarm'),before.alarm);assert.equal(await h.store.get('hyperstack-guard-key-v1'),SECRET);assert.equal(h.s.calls.length,calls);
 const changed={...packet,observedAt:packet.observedAt+1};await assert.rejects(call(changed,{operatorAbsenceJSON:JSON.stringify(changed)}));assert.equal((await h.runtime.report()).name,next.name);
});
test('existing bindings, volume evidence and observations changed during proof retain all guard state',async()=>{
 for(const mode of ['binding','volume','race']){
  const {h,packet,call}=await operatorHarness();let core=await h.store.get('hyperstack-destroy-reservation');if(mode==='binding')core.bindings=[normalizeVM(rawVM())];if(mode==='volume')core.unexpectedVolumeIds=['77'];await h.store.put('hyperstack-destroy-reservation',core);
  if(mode==='race'){const base=h.s.fetch;let gets=0;h.s.fetch=async(url,opt)=>{const r=await base(url,opt);if(new URL(url).pathname.endsWith('/44')&&++gets===2){const changed=await h.store.get('hyperstack-destroy-reservation');changed.unexpectedVolumeIds=['77'];await h.store.put('hyperstack-destroy-reservation',changed);}return r;};}
  await assert.rejects(call());assert.equal(await h.store.get('hyperstack-guard-key-v1'),SECRET);assert.equal(await h.store.get('hyperstack-operator-absence-v1:'+packet.id),undefined);
 }
});
