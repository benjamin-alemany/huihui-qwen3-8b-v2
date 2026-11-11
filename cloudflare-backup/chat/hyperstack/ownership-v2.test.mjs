import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {NONCE_NAME_OWNERSHIP,normalizeVM,validateReservation,matchesReservation,assertBound,providerCreatedAtUTC,creationTimestampIdentity} from './policy.mjs';
import {hyperstackClient} from './client.mjs';
import {hyperstackGuardRuntime} from './guard-runtime.mjs';
import {NOW,TARGET,rawVM,fixture,Store} from './fixtures.mjs';
const KEY='DUMMY_V2_PROVIDER_KEY_OUTSIDE_VM',IMAGE='ghcr.io/benjamin-alemany/huihui-qwen3-8b-v2@sha256:'+'a'.repeat(64);
function reservation(at=NOW){const nonce='a'.repeat(32);return validateReservation({kind:'chat',provider:'hyperstack',minutes:30,image:IMAGE,nonce,name:'unjailed-chat-'+nonce,target:TARGET,createdNotBefore:at,createdNotAfter:at+300000,deadline:at+1800000,windowStart:new Date(at).toISOString(),windowEnd:new Date(at+300000).toISOString(),ownershipPolicy:NONCE_NAME_OWNERSHIP});}
const legacy=q=>{const result=structuredClone(q);delete result.ownershipPolicy;return result;};
class Storage extends Store{async delete(k){this.rows.delete(k);}async setAlarm(at){this.rows.set('$alarm',at);}async deleteAlarm(){this.rows.delete('$alarm');}}
function harness(createMode='ok'){
 let time=NOW;const s=fixture({createMode}),store=new Storage(),q=reservation(),base=s.fetch;
 // Faithfully model the observed provider: create response and later ACTIVE
 // reads have empty labels, even if a legacy request supplied optional tags.
 const fetchImpl=async(url,options)=>{
  const create=new URL(url).pathname==='/v1/core/virtual-machines'&&options?.method==='POST';
  if(!create)return base(url,options);
  try{const response=await base(url,options),body=await response.json();for(const p of s.vms)p.labels=[];for(const p of body.instances??[])p.labels=[];return Response.json(body,{status:response.status});}
  catch(error){for(const p of s.vms)p.labels=[];throw error;}
 };
 const factory=(key,target)=>hyperstackClient(key,{target,fetchImpl,now:()=>time}).destroyClient();
 return {s,store,q,client:hyperstackClient(KEY,{target:TARGET,fetchImpl,now:()=>time,bootstrapFor:async()=> '#cloud-config\nruncmd: []\n'}),guard:()=>hyperstackGuardRuntime(store,{target:TARGET,role:'primary',providerFactory:factory,now:()=>time}),set time(value){time=value;}};
}

test('V2 is explicit complete reservation metadata; absent policy retains the missing-label V1 gate',()=>{
 const q=reservation(),p=normalizeVM(rawVM({labels:[]}));assert.equal(validateReservation(q).ownershipPolicy,NONCE_NAME_OWNERSHIP);assert.equal(matchesReservation(p,q),true);assert.equal(matchesReservation(p,legacy(q)),false);
 assert.equal(matchesReservation({...p,labels:['unrelated-diagnostic-label']},q),true);
 for(const value of [null,undefined,'nonce-name-v1','nonce-label-v1','future-v3',true])assert.throws(()=>validateReservation({...q,ownershipPolicy:value}));
 const incomplete={nonce:q.nonce,name:q.name,target:TARGET,createdNotBefore:q.createdNotBefore,createdNotAfter:q.createdNotAfter,deadline:q.deadline,ownershipPolicy:NONCE_NAME_OWNERSHIP};assert.throws(()=>validateReservation(incomplete));
});
test('full nonce-name, exact UTC window and target are required; labels never authorize a mismatch',()=>{
 const q=reservation(),p=normalizeVM(rawVM({labels:[]}));
 for(const patch of [{name:'unjailed-chat-'+'b'.repeat(32),labels:['unjailed:'+q.nonce]},{name:q.name.slice(0,-1)},{createdAt:new Date(q.createdNotBefore-1).toISOString()},{createdAt:new Date(q.createdNotAfter+1).toISOString()},{createdAt:'2026-02-30T12:00:00'},{environment:{...p.environment,id:99}},{flavor:{...p.flavor,count:2}},{bootImageName:'different-image'}])assert.equal(matchesReservation({...p,...patch},q),false);
 for(const at of [q.createdNotBefore,q.createdNotAfter])assert.equal(matchesReservation({...p,createdAt:new Date(at).toISOString()},q),true);
});
test('provider UTC parsing rejects malformed calendars and preserves explicit UTC instants',()=>{
 const at=Date.parse('2026-11-11T02:51:52Z');assert.equal(providerCreatedAtUTC('2026-11-11T02:51:52'),at);assert.equal(providerCreatedAtUTC('2026-11-11T02:51:52Z'),at);assert.equal(providerCreatedAtUTC('2026-11-10T21:51:52-05:00'),at);
 for(const value of ['2026-02-30T02:51:52','2026-11-11T24:00:00','2026-11-11 02:51:52','2026-11-11T02:51:52+99:00','not-a-date',null])assert.throws(()=>providerCreatedAtUTC(value));
});
test('shared creation identity canonicalizes V2 instants while V1 keeps exact raw-time semantics',()=>{
 const q=reservation(),v1=legacy(q),z=new Date(NOW).toISOString(),naive=z.slice(0,-1),offset='2026-11-10T07:00:00-05:00';
 for(const wire of [z,naive,offset])assert.equal(creationTimestampIdentity(wire,q),z);
 assert.notEqual(creationTimestampIdentity(new Date(NOW+1).toISOString(),q),z);
 assert.equal(creationTimestampIdentity(naive,v1),naive);assert.notEqual(creationTimestampIdentity(naive,v1),creationTimestampIdentity(z,v1));
 const p=normalizeVM(rawVM());assert.equal(assertBound({...p,createdAt:naive},p,q).id,p.id);assert.throws(()=>assertBound({...p,createdAt:naive},p,v1),/OWNERSHIP_UNCONFIRMED/);
});
test('the actual naive provider timestamp binds as UTC in a non-UTC process without widening the window',()=>{
 const policy=new URL('./policy.mjs',import.meta.url).href,fixtures=new URL('./fixtures.mjs',import.meta.url).href;
 const script=`import assert from 'node:assert/strict';import {normalizeVM,validateReservation,matchesReservation,assertBound,providerCreatedAtUTC} from ${JSON.stringify(policy)};import {TARGET,rawVM} from ${JSON.stringify(fixtures)};
 const wire='2026-11-11T02:51:52',at=Date.parse(wire+'Z'),nonce='a'.repeat(32);assert.notEqual(Date.parse(wire),at);
 const q=validateReservation({kind:'chat',provider:'hyperstack',minutes:30,image:${JSON.stringify(IMAGE)},nonce,name:'unjailed-chat-'+nonce,target:TARGET,createdNotBefore:at-1,createdNotAfter:at+1,deadline:at-1+1800000,windowStart:new Date(at-1).toISOString(),windowEnd:new Date(at+1).toISOString(),ownershipPolicy:'nonce-name-v2'});
 const p=normalizeVM(rawVM({created_at:wire,labels:[]}));assert.equal(p.createdAt,wire);assert.equal(providerCreatedAtUTC(p.createdAt),at);assert(matchesReservation(p,q));assert.equal(matchesReservation({...p,createdAt:new Date(at+2).toISOString()},q),false);
 assert.equal(assertBound({...p,name:'renamed',createdAt:wire+'Z'},p,q).id,p.id);console.log('EXPLICIT_PROVIDER_UTC_WITH_RAW_WIRE_PRESERVED');`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,TZ:'Pacific/Honolulu'},encoding:'utf8',timeout:10000});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/EXPLICIT_PROVIDER_UTC_WITH_RAW_WIRE_PRESERVED/);
});
test('V2 CREATE uses the required nonce name and binds an empty-label readback; V1 remains rejected',async()=>{
 const h=harness();const p=await h.client.create(h.q);assert.equal(p.id,'44');assert.deepEqual(p.labels,[]);const post=h.s.calls.find(c=>c.method==='POST');assert.equal(post.body.count,1);assert.equal(post.body.name,h.q.name);assert.equal(Object.hasOwn(post.body,'labels'),false);assert.equal(Object.hasOwn(post.body,'ownershipPolicy'),false);assert(!JSON.stringify(post.body).includes(KEY));
 await assert.rejects(h.client.create(h.q),error=>error.outcome==='unknown');assert.equal(h.s.calls.filter(c=>c.method==='POST').length,1);
 const old=harness();await assert.rejects(old.client.create(legacy(old.q)),error=>error.code==='HYPERSTACK_CREATE_READBACK_UNCONFIRMED'&&error.outcome==='unknown');assert.equal(old.s.vms.length,1);assert.equal(matchesReservation(normalizeVM(old.s.vms[0]),legacy(old.q)),false);
});
test('lost V2 CREATE response survives guard restart, discovers duplicate empty-label VMs and retains IDs after renames',async()=>{
 const h=harness('lost');await h.guard().arm(h.q,KEY);await assert.rejects(h.client.create(h.q),error=>error.outcome==='unknown');assert.equal(h.s.vms.length,1);assert.deepEqual(h.s.vms[0].labels,[]);
 const first=await h.guard().tick();assert.equal(first.status,'ARMED');assert.deepEqual(first.bindings.map(p=>p.id),['44']);
 h.s.vms.push(rawVM({id:45,labels:[]}));const duplicates=await h.guard().tick();assert.deepEqual(duplicates.bindings.map(p=>p.id),['44','45']);
 for(const p of h.s.vms){p.name='renamed-'+p.id;p.labels=[];}
 h.time=h.q.deadline;const cleaned=await h.guard().tick();assert.equal(cleaned.vmCleanupVerified,true);assert.equal(cleaned.complete,true);assert.equal(h.s.vms.length,0);assert.deepEqual(h.s.calls.filter(c=>c.method==='DELETE').map(c=>c.path).sort(),['/v1/core/virtual-machines/44','/v1/core/virtual-machines/45']);
 assert.equal(h.s.calls.filter(c=>c.method==='POST').length,1);assert.equal(cleaned.expiry,h.q.deadline);assert.equal((await h.guard().disarm(h.q.name)).armed,false);
});
test('partial inventory cannot resolve an unknown V2 create or erase its guard credential',async()=>{
 const h=harness('lost');await h.guard().arm(h.q,KEY);await assert.rejects(h.client.create(h.q));h.time=h.q.deadline;
 h.s.listHook=()=>Response.json({status:true,page:1,page_size:100,count:1,instances:[]});const refused=await h.guard().tick();assert.equal(refused.vmCleanupVerified,false);assert.equal(refused.complete,false);assert.equal(await h.store.get('hyperstack-guard-key-v1'),KEY);assert.equal(h.s.calls.filter(c=>c.method==='DELETE').length,0);
 h.s.listHook=null;assert.equal((await h.guard().tick()).complete,true);assert.equal(h.s.calls.filter(c=>c.method==='POST').length,1);
});
test('an already armed V1 reservation cannot be silently reinterpreted as V2',async()=>{
 const h=harness();await h.guard().arm(legacy(h.q),KEY);await assert.rejects(h.guard().arm(h.q,KEY),/GUARD_RESERVATION_LOCKED/);const report=await h.guard().report();assert.equal(report.nonce,h.q.nonce);assert.equal(Object.hasOwn((await h.store.get('hyperstack-guard-runtime-v1')).reservation,'ownershipPolicy'),false);assert.equal(h.s.calls.length,0);
 // This isolated fixture has made no CREATE. Its legitimate V1 archive must
 // also prevent a later policy flag from reusing the consumed nonce.
 await h.guard().disarm(h.q.name,{definiteNoCreate:true});await assert.rejects(h.guard().arm(h.q,KEY),/GUARD_ALREADY_ARCHIVED/);
});
