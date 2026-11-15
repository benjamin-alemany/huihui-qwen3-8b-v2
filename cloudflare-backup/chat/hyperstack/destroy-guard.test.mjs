import test from 'node:test';
import assert from 'node:assert/strict';
import {armDestroyGuard,runDestroyGuard,requestDestroy} from './destroy-guard.mjs';
import {normalizeVM} from './policy.mjs';
import {NOW,RESERVATION,rawVM,Store} from './fixtures.mjs';
function guardFixture(rows=[]){
 const s={rows:rows.map(normalizeVM),calls:[],deleteWorks:true,getFailure:false};
 s.provider={list:async()=>{s.calls.push('list');return structuredClone(s.rows);},get:async id=>{s.calls.push('get:'+id);if(s.getFailure)throw Error('DUMMY_SECRET');return structuredClone(s.rows.find(p=>p.id===id)??null);},remove:async id=>{s.calls.push('delete:'+id);if(s.deleteWorks)s.rows=s.rows.filter(p=>p.id!==id);return true;}};return s;
}
test('independent primary/backup use immutable absolute deadlines without create capabilities',async()=>{
 const p=new Store(),b=new Store(),s=guardFixture([rawVM()]);await armDestroyGuard(p,RESERVATION);await armDestroyGuard(b,RESERVATION,{role:'backup'});
 assert.equal((await runDestroyGuard({store:p,provider:s.provider,now:()=>RESERVATION.deadline-1})).code,'ARMED');assert(!s.calls.some(x=>x.startsWith('delete')));
 assert.equal((await runDestroyGuard({store:b,provider:s.provider,now:()=>RESERVATION.deadline})).code,'ARMED');
 const result=await runDestroyGuard({store:p,provider:s.provider,now:()=>RESERVATION.deadline});assert.equal(result.code,'VM_ABSENCE_VERIFIED');assert.equal(result.billingSettlementPending,true);assert.equal(result.independentIpReadback,false);
 const bs=await b.get('hyperstack-destroy-reservation');assert.equal(bs.expiry,RESERVATION.deadline+60_000);assert.equal(bs.bindings.length,1);
 await assert.rejects(armDestroyGuard(p,{...RESERVATION,deadline:RESERVATION.deadline+1}));await assert.rejects(runDestroyGuard({store:p,provider:{...s.provider,create:()=>{}},now:()=>NOW}));
});
test('backup alone deletes when primary is not executing',async()=>{
 const store=new Store(),s=guardFixture([rawVM()]);await armDestroyGuard(store,RESERVATION,{role:'backup'});const r=await runDestroyGuard({store,provider:s.provider,now:()=>RESERVATION.deadline+60_000});assert.equal(r.vmCleanupVerified,true);assert.deepEqual(s.calls.filter(x=>x.startsWith('delete')),['delete:44']);
});
test('explicit Stop is durable, nonce-scoped and does not extend expiry',async()=>{
 const store=new Store(),s=guardFixture([rawVM()]);await armDestroyGuard(store,RESERVATION);await assert.rejects(requestDestroy(store,'b'.repeat(32)));await requestDestroy(store,RESERVATION.nonce);const r=await runDestroyGuard({store,provider:s.provider,now:()=>NOW});assert.equal(r.vmCleanupVerified,true);assert.equal(r.expiry,RESERVATION.deadline);
});
test('IDs are persisted before DELETE and retained across rename, disappearance and future ticks',async()=>{
 const store=new Store(),s=guardFixture([rawVM()]);await armDestroyGuard(store,RESERVATION);await runDestroyGuard({store,provider:s.provider,now:()=>NOW});s.rows[0].name='changed-name';s.rows[0].labels=[];
 const remove=s.provider.remove;s.provider.remove=async id=>{assert.equal((await store.get('hyperstack-destroy-reservation')).bindings[0].id,id);return remove(id);};
 assert.equal((await runDestroyGuard({store,provider:s.provider,now:()=>RESERVATION.deadline})).vmCleanupVerified,true);assert.equal((await store.get('hyperstack-destroy-reservation')).bindings.length,1);
 assert.equal((await runDestroyGuard({store,provider:s.provider,now:()=>RESERVATION.deadline+60000})).vmCleanupVerified,true);assert.equal((await store.get('hyperstack-destroy-reservation')).bindings[0].id,'44');
});
test('unknown create with empty inventory keeps reconciliation and reservation armed',async()=>{
 const store=new Store(),s=guardFixture();await armDestroyGuard(store,RESERVATION);const r=await runDestroyGuard({store,provider:s.provider,now:()=>RESERVATION.deadline});assert.equal(r.code,'CREATE_OUTCOME_UNCONFIRMED');assert.equal(r.vmCleanupVerified,false);assert.equal(r.complete,false);assert.equal(r.requiresOperatorReconciliation,true);assert(await store.get('hyperstack-destroy-reservation'));
});
test('late exact duplicate is bound and prevents false cleanup; next tick deletes it',async()=>{
 const store=new Store(),s=guardFixture([rawVM()]);await armDestroyGuard(store,RESERVATION);let lists=0;const list=s.provider.list;s.provider.list=async()=>{lists++;if(lists===2)s.rows.push(normalizeVM(rawVM({id:45})));return list();};
 const first=await runDestroyGuard({store,provider:s.provider,now:()=>RESERVATION.deadline});assert.equal(first.complete,false);assert.equal((await store.get('hyperstack-destroy-reservation')).bindings.length,2);assert.equal((await runDestroyGuard({store,provider:s.provider,now:()=>RESERVATION.deadline+1})).complete,true);
});
test('unrelated names, tags, timestamps and targets are never deleted',async()=>{
 const rows=[rawVM({id:50,name:'unrelated'}),rawVM({id:51,labels:[]}),rawVM({id:52,created_at:new Date(NOW-60000).toISOString()}),rawVM({id:53,environment:{id:99,name:'other',region:'CANADA-1'}})];const store=new Store(),s=guardFixture(rows);await armDestroyGuard(store,RESERVATION);const r=await runDestroyGuard({store,provider:s.provider,now:()=>RESERVATION.deadline});assert.equal(r.complete,false);assert(!s.calls.some(x=>x.startsWith('delete')));assert.equal(s.rows.length,4);
});
test('read failures and acknowledged but ineffective DELETE are never cleanup success',async()=>{
 const store=new Store(),s=guardFixture([rawVM()]);await armDestroyGuard(store,RESERVATION);s.deleteWorks=false;assert.equal((await runDestroyGuard({store,provider:s.provider,now:()=>RESERVATION.deadline})).complete,false);s.getFailure=true;const r=await runDestroyGuard({store,provider:s.provider,now:()=>RESERVATION.deadline+1});assert.equal(r.code,'CLEANUP_UNCONFIRMED');assert.equal(r.vmCleanupVerified,false);assert(!JSON.stringify(r).includes('DUMMY_SECRET'));
});
test('unexpected volume observation survives VM disappearance and requires operator review',async()=>{
 const store=new Store(),s=guardFixture([rawVM({volume_attachments:[{id:1,volume:{id:77}}]})]);await armDestroyGuard(store,RESERVATION);await runDestroyGuard({store,provider:s.provider,now:()=>NOW});s.rows=[];const r=await runDestroyGuard({store,provider:s.provider,now:()=>RESERVATION.deadline});assert.equal(r.vmCleanupVerified,true);assert.equal(r.code,'UNEXPECTED_VOLUME_REVIEW');assert.equal(r.complete,false);assert.deepEqual(r.unexpectedVolumeIds,['77']);assert(s.calls.every(x=>!x.includes('volume')));
});
test('mutated bound immutable metadata and forged extended guard expiry fail closed',async()=>{
 const store=new Store(),s=guardFixture([rawVM()]);await armDestroyGuard(store,RESERVATION);await runDestroyGuard({store,provider:s.provider,now:()=>NOW});s.rows[0].environment.id=99;assert.equal((await runDestroyGuard({store,provider:s.provider,now:()=>RESERVATION.deadline})).code,'CLEANUP_UNCONFIRMED');assert(!s.calls.some(x=>x.startsWith('delete')));
 const current=await store.get('hyperstack-destroy-reservation');current.expiry+=1;await store.put('hyperstack-destroy-reservation',current);await assert.rejects(runDestroyGuard({store,provider:s.provider,now:()=>NOW}));
});

test('a failed inventory does not block deadline teardown of a previously bound VM',async()=>{
 const store=new Store(),s=guardFixture([rawVM()]);await armDestroyGuard(store,RESERVATION);await runDestroyGuard({store,provider:s.provider,now:()=>NOW});
 s.provider.list=async()=>{s.calls.push('list-failed');throw Error('DUMMY_LIST_FAILURE_SECRET');};
 const r=await runDestroyGuard({store,provider:s.provider,now:()=>RESERVATION.deadline});
 assert.deepEqual(s.calls.filter(c=>c.startsWith('delete:')),['delete:44']);assert.equal(s.rows.length,0);assert.equal(r.code,'CLEANUP_UNCONFIRMED');assert.equal(r.complete,false);assert.equal(r.vmCleanupVerified,false);assert.equal(r.requiresOperatorReconciliation,true);assert.equal((await store.get('hyperstack-destroy-reservation')).bindings.length,1);assert(!JSON.stringify(r).includes('SECRET'));
});
test('failure reading one bound VM cannot skip teardown of another owned VM',async()=>{
 const store=new Store(),s=guardFixture([rawVM(),rawVM({id:45})]);await armDestroyGuard(store,RESERVATION);await runDestroyGuard({store,provider:s.provider,now:()=>NOW});
 const get=s.provider.get;s.provider.get=async id=>{if(id==='44')throw Error('DUMMY_READ_FAILURE');return get(id);};
 const r=await runDestroyGuard({store,provider:s.provider,now:()=>RESERVATION.deadline});
 assert.deepEqual(s.calls.filter(c=>c.startsWith('delete:')),['delete:45']);assert.equal(s.rows[0].id,'44');assert.equal(r.complete,false);assert.equal(r.code,'CLEANUP_UNCONFIRMED');
});
test('a deadline reached during inventory is enforced in the same tick',async()=>{
 const store=new Store(),s=guardFixture([rawVM()]);await armDestroyGuard(store,RESERVATION);let time=RESERVATION.deadline-1;const list=s.provider.list;
 s.provider.list=async()=>{const rows=await list();time=RESERVATION.deadline;return rows;};
 const r=await runDestroyGuard({store,provider:s.provider,now:()=>time});assert.equal(r.vmCleanupVerified,true);assert.deepEqual(s.calls.filter(c=>c.startsWith('delete:')),['delete:44']);
});
