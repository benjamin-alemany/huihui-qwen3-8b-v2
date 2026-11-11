import test from 'node:test';
import assert from 'node:assert/strict';
import {hyperstackGuardRuntime} from './guard-runtime.mjs';
import {hyperstackClient} from './client.mjs';
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
 return {store,s,runtime:hyperstackGuardRuntime(store,options),fresh:()=>hyperstackGuardRuntime(store,options),set time(t){time=t;},get time(){return time;}};
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
