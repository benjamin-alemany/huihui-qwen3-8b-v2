import test from 'node:test';
import assert from 'node:assert/strict';
import release from '../../../release/manifest.json' with {type:'json'};
import {SessionEngine} from '../controller/engine.mjs';
import {hyperstackLifecycle} from './controller-policy.mjs';
import {CreateError} from './client.mjs';
import {validateCatalog,normalizeVM,absenceReceipt} from './policy.mjs';
import {NOW,TARGET,rawVM,catalogRaw,Store} from './fixtures.mjs';
const pinned=()=>({...structuredClone(release),status:'candidate',artifact:{...release.artifact,servingImage:'ghcr.io/benjamin-alemany/huihui-qwen3-8b-v2@sha256:'+'a'.repeat(64),bootstrapLockSha256:'b'.repeat(64),bootstrapBundleSha256:'e'.repeat(64),bootstrapSourceCommit:'f'.repeat(40),bootstrapBundleSize:100},hosting:{...release.hosting,vmImageId:33}});
class EngineStore extends Store{async setAlarm(at){await this.put('$alarm',at);}}
function harness(){
 let now=NOW,sequence=0,vmSequence=100;
 const store=new EngineStore(),flags={health:true,cleanup:true,create:'ok',receiptExpiry:false,armingDelay:0,emptyLabels:false},rows=[],calls=[],guards=[null,null];
 const lifecycle=hyperstackLifecycle({target:TARGET,release:pinned()});
 const provider={
  catalog:async()=>validateCatalog(catalogRaw(),TARGET,now),list:async()=>structuredClone(rows),get:async id=>structuredClone(rows.find(p=>p.id===id)??null),
  create:async q=>{
   calls.push(['create',structuredClone(q)]);
   const current=(await engine().read()).session;assert(current.createAttempted,'durable attempt marker must precede create');assert(guards.every(g=>g?.name===q.name),'both guards must precede create');
   assert(!JSON.stringify(q).includes(current.inferenceKey));assert(!JSON.stringify(q).includes('DUMMY_PROVIDER_KEY'));
   if(flags.create==='definite')throw new CreateError('DUMMY_PREFLIGHT_REJECTED','definite-no-create');
   if(flags.create==='unknown')throw new CreateError('DUMMY_LOST_REPLY');
   const p=normalizeVM(rawVM({id:++vmSequence,name:q.name,labels:flags.emptyLabels?[]:[`unjailed:${q.nonce}`],created_at:new Date(now).toISOString()}));rows.push(p);return structuredClone(p);
  },
  health:async()=>flags.health,
  cleanup:async p=>{calls.push(['cleanup',p.id]);const index=rows.findIndex(x=>x.id===p.id);if(flags.cleanup&&index>=0)rows.splice(index,1);return absenceReceipt({complete:flags.cleanup,vmAbsent:flags.cleanup,inventoryAbsent:flags.cleanup});}
 };
 const deps={lifecycle,now:()=>now,id:()=>`dummy-${++sequence}`,hex:n=>(++sequence).toString(16).padStart(n,'0'),enabled:true,connected:true,validationMode:false,approval:'dummy-one-test',maxUSD:.4,maxHourly:1,key:'DUMMY_PROVIDER_KEY_ONLY_GUARDS',provider,catalog:provider.catalog,wake:async()=>{},heartbeat:async()=>{},
  guards:[0,1].map(i=>({arm:async(q,key)=>{assert.equal(key,'DUMMY_PROVIDER_KEY_ONLY_GUARDS');guards[i]=structuredClone(q);},shorten:async(name,at)=>{calls.push(['shorten',i,name,at]);},disarm:async(name,options)=>{calls.push(['disarm',i,name,options]);guards[i]=null;},report:async()=>({armed:!!guards[i],name:guards[i]?.name,deleted:[]})})),
  receipts:async q=>{now+=flags.armingDelay;return {schedulerReady:true,provider:'hyperstack',...(q.ownershipPolicy!==undefined?{ownershipPolicy:q.ownershipPolicy}:{}),reservationName:q.name,image:q.image,nonce:q.nonce,deadline:q.deadline,guards:Object.fromEntries(['primary','backup'].map(role=>[role,{role,mode:'reservation',...(q.ownershipPolicy!==undefined?{ownershipPolicy:q.ownershipPolicy}:{}),nonce:q.nonce,expiry:q.deadline+(role==='backup'?60000:0)+(flags.receiptExpiry?1:0),eventTimestamp:now,version:'11111111-1111-4111-8111-111111111111'}]))};},checkVersions:async()=>{}
 };
 const engine=()=>new SessionEngine(store,deps);
 return {store,provider,deps,flags,rows,calls,guards,engine,get now(){return now;},advance:ms=>{now+=ms;},get creates(){return calls.filter(c=>c[0]==='create').length;},async grant(){return engine().grant({grantId:'00000000-0000-4000-8000-000000000001',amountUSD:2});},async start(minutes){const q=await engine().quote(minutes===undefined?undefined:{minutes});await engine().start({quoteId:q.id,maximumUSD:q.maximumUSD});return q;},async ready(minutes){await this.start(minutes);await engine().tick();await engine().tick();await engine().tick();return (await engine().status()).session;}};
}
test('otherwise-pinned candidate with a missing serving artifact cannot choose the new provider',()=>{
 const valid=pinned();assert.equal(hyperstackLifecycle({target:TARGET,release:valid}).provider,'hyperstack');
 const missing=structuredClone(valid);missing.artifact.servingImage=null;
 assert.throws(()=>hyperstackLifecycle({target:TARGET,release:missing}),/HYPERSTACK_RELEASE_UNPINNED/);
});
test('injected Hyperstack lifecycle completes explicit repeat sessions without touching historical budget',async()=>{
 const h=harness();await h.grant();const original=structuredClone((await h.engine().read()).ledger);const ids=[];
 for(const minutes of [15,30,60]){
  const s=await h.ready(minutes);ids.push(s.id);assert.equal(s.phase,'ready');assert.equal(s.minutes,minutes);assert.match(s.deadline,/Z$/);
  const state=(await h.engine().read()).session,context=JSON.parse((await h.engine().context()).CHAT_SESSION);assert.equal(context.provider,'hyperstack');assert.match(context.vmId,/^[1-9][0-9]*$/);assert.equal(context.minutes,minutes);assert.equal(Date.parse(context.createdAt)+minutes*60000,state.reservation.deadline);assert.equal(state.bootAt,state.reservation.createdNotBefore);
  const creates=h.creates;await Promise.all([h.engine().start({quoteId:s.quoteId,maximumUSD:s.maximumUSD}),h.engine().start({quoteId:s.quoteId,maximumUSD:s.maximumUSD})]);assert.equal(h.creates,creates);
  await h.engine().stop({sessionId:s.id});assert.equal(await h.engine().context(),null);await h.engine().tick();const done=await h.engine().status();assert.equal(done.session.phase,'stopped');assert.equal(done.session.cleanupVerified,true);assert.equal(done.ordinaryBudget.reservedUSD,0);assert.deepEqual(h.guards,[null,null]);assert.equal(h.rows.length,0);assert.deepEqual((await h.engine().read()).ledger,original);
 }
 assert.equal(new Set(ids).size,3);assert.equal(h.creates,3);assert((await h.engine().status()).ordinaryBudget.spentUpperUSD>0);
});
test('arming time consumes the quoted immutable session and context cannot extend it',async()=>{
 const h=harness();await h.grant();h.flags.armingDelay=60000;const s=await h.ready(30),state=(await h.engine().read()).session;assert.equal(s.phase,'ready');assert.equal(state.bootAt,NOW);assert.equal(state.deadline,NOW+30*60000);assert.equal(state.reservation.deadline,state.deadline);h.advance(29*60000);assert.equal(await h.engine().context(),null);await h.engine().tick();assert.equal((await h.engine().status()).session.phase,'stopped');assert.equal(h.creates,1);
});
test('Hyper validation is 30 minutes and consumes its separate approval once',async()=>{
 const h=harness();h.deps.validationMode=true;const quote=await h.start();assert.equal(quote.minutes,30);assert(quote.maximumUSD<.3);await h.engine().tick();await h.engine().tick();await h.engine().tick();const s=await h.engine().status();assert.equal(s.session.phase,'ready');assert.equal(s.session.minutes,30);await h.engine().stop({sessionId:s.session.id});await h.engine().tick();const q=await h.engine().quote();await assert.rejects(h.engine().start({quoteId:q.id,maximumUSD:q.maximumUSD}),/APPROVAL_ALREADY_USED/);assert.equal(h.creates,1);assert.equal((await h.engine().status()).ordinaryBudget.capUSD,0);
});
test('fresh ownership V2 quote permits one simulated empty-label create with both guards and complete cleanup',async()=>{
 const h=harness();h.deps.validationMode=true;h.flags.emptyLabels=true;const before=(await h.engine().read()).ledger,quote=await h.start(30);await h.engine().tick();const armed=(await h.engine().read()).session;assert.equal(armed.reservation.ownershipPolicy,'nonce-name-v2');await h.engine().tick();assert(h.guards.every(q=>q?.ownershipPolicy==='nonce-name-v2'));assert.equal(h.creates,1);assert.deepEqual(h.rows[0].labels,[]);
 await h.engine().tick();const s=await h.engine().status(),raw=(await h.engine().read()).session;assert.equal(s.session.phase,'ready');assert.equal(raw.knownAllocations[0].ownershipPolicy,undefined);assert.deepEqual(raw.knownAllocations[0].labels,[]);assert.equal(JSON.parse(raw.quote.lifecycleBinding).ownershipPolicy,'nonce-name-v2');
 await h.engine().start({quoteId:quote.id,maximumUSD:quote.maximumUSD});assert.equal(h.creates,1);await h.engine().stop({sessionId:s.session.id});assert.equal(await h.engine().context(),null);await h.engine().tick();const done=await h.engine().status();assert.equal(done.session.phase,'stopped');assert.equal(done.testBudget.reservedUSD,0);assert.equal(done.ordinaryBudget.capUSD,0);assert(done.testBudget.spentUpperUSD>before.spent/1e10);assert.deepEqual(h.guards,[null,null]);assert.deepEqual(h.rows,[]);assert(h.calls.filter(c=>c[0]==='disarm').every(c=>c[3].definiteNoCreate===false));assert.equal(h.creates,1);
});
test('a stored pre-V2 quote binding cannot authorize a new V2 allocation',async()=>{
 const h=harness();await h.grant();const quote=await h.engine().quote({minutes:30});await h.engine().tx(r=>{const q=r.quotes.find(q=>q.id===quote.id),old=JSON.parse(q.lifecycleBinding);delete old.ownershipPolicy;q.lifecycleBinding=JSON.stringify(old);});await assert.rejects(h.engine().start({quoteId:quote.id,maximumUSD:quote.maximumUSD}),/QUOTE_CHANGED/);assert.equal(h.creates,0);assert.equal((await h.engine().status()).ordinaryBudget.reservedUSD,0);
});
test('missing runtime receipt keeps validating, chat disabled, and cold-start timeout deletes VM',async()=>{
 const h=harness();await h.grant();h.flags.health=false;const s=await h.ready(30);assert.equal(s.phase,'validating');assert.equal(await h.engine().context(),null);h.advance(15*60000);await h.engine().tick();assert.equal((await h.engine().status()).session.phase,'stopped');assert.equal(h.rows.length,0);assert.equal(h.creates,1);
});
test('never-ready startup timeout persists its sanitized reason through failed cleanup and a new engine handle',async()=>{
 const h=harness();await h.grant();h.flags.health=false;h.flags.cleanup=false;const initial=await h.ready(30),held=(await h.engine().status()).ordinaryBudget.reservedUSD;h.advance(15*60000);await h.engine().tick();
 let status=await h.engine().status();assert.equal(status.session.phase,'stopping');assert.equal(status.session.code,'STARTUP_TIMEOUT');assert.equal((await h.engine().read()).session.code,'STARTUP_TIMEOUT');assert.equal(status.ordinaryBudget.reservedUSD,held);assert.equal(status.session.deadline,initial.deadline);assert.equal(await h.engine().context(),null);
 const cleanup=h.provider.cleanup;h.provider.cleanup=async()=>{throw Error('DUMMY_SECRET_PROVIDER_FAILURE');};await h.engine().tick();status=await h.engine().status();assert.equal(status.session.code,'STARTUP_TIMEOUT');assert(!JSON.stringify(status).includes('DUMMY_SECRET'));assert.equal(status.ordinaryBudget.reservedUSD,held);
 h.provider.cleanup=cleanup;h.flags.cleanup=true;await h.engine().tick();status=await h.engine().status();assert.equal(status.session.phase,'stopped');assert.equal(status.session.code,'STARTUP_TIMEOUT');assert.equal((await h.engine().read()).session.code,'STARTUP_TIMEOUT');assert.equal(status.ordinaryBudget.reservedUSD,0);assert.equal(status.session.deadline,initial.deadline);assert.equal(h.creates,1);
});
test('owner Stop at the startup boundary is not recast as a startup failure',async()=>{
 for(const ready of [false,true]){const h=harness();await h.grant();h.flags.health=ready;const initial=await h.ready(30);h.advance(15*60000);await h.engine().stop({sessionId:initial.id});await h.engine().tick();const status=await h.engine().status();assert.equal(status.session.phase,'stopped');assert.equal(status.session.code,null);assert.equal(status.session.deadline,initial.deadline);assert.equal(status.ordinaryBudget.reservedUSD,0);assert.equal(h.creates,1);}
});
test('a previously ready session retains its original deadline and reports expiry instead of startup timeout',async()=>{
 const h=harness();await h.grant();const initial=await h.ready(30);h.flags.health=false;h.advance(15*60000);await h.engine().tick();let status=await h.engine().status();assert.equal(status.session.phase,'validating');assert.equal(status.session.code,null);assert.equal((await h.engine().read()).session.everReady,true);h.advance(15*60000);await h.engine().tick();status=await h.engine().status();assert.equal(status.session.phase,'stopped');assert.equal(status.session.code,'SESSION_DEADLINE_REACHED');assert.equal((await h.engine().read()).session.code,'SESSION_DEADLINE_REACHED');assert.equal(status.session.deadline,initial.deadline);assert.equal(status.ordinaryBudget.reservedUSD,0);assert.equal(await h.engine().context(),null);assert.equal(h.creates,1);
});
test('definite no-create releases allowance without retry and permits a later explicit ordinary request',async()=>{
 const h=harness();await h.grant();h.flags.create='definite';await h.start(30);await h.engine().tick();await h.engine().tick();const s=await h.engine().status();assert.equal(s.session.phase,'failed');assert.equal(s.ordinaryBudget.reservedUSD,0);assert.equal(s.ordinaryBudget.spentUpperUSD,0);assert.equal(h.creates,1);assert.equal(h.rows.length,0);assert.deepEqual(h.guards,[null,null]);assert(h.calls.filter(x=>x[0]==='disarm').every(x=>x[3].definiteNoCreate===true));await h.engine().tick();assert.equal(h.creates,1);
 h.flags.create='ok';assert.equal((await h.ready(15)).phase,'ready');assert.equal(h.creates,2);
});
test('unknown create retains durable hold and both guards across clock advances and new engine handles',async()=>{
 const h=harness();await h.grant();h.flags.create='unknown';await h.start(30);await h.engine().tick();await h.engine().tick();const before=(await h.engine().status()).ordinaryBudget.reservedUSD;h.advance(5*60000+1);await h.engine().tick();let s=await h.engine().status();assert.equal(s.session.phase,'attention');assert.equal(s.ordinaryBudget.reservedUSD,before);assert(h.guards.every(Boolean));assert.equal(h.creates,1);assert.equal(await h.engine().context(),null);h.advance(30*60000);await h.engine().tick();s=await h.engine().status();assert.equal(s.ordinaryBudget.reservedUSD,before);assert.equal(h.creates,1);await assert.rejects(h.start(15),/SESSION_ALREADY_ACTIVE/);
});
test('false cleanup receipt and ineffective deletion retain hold; verified receipt later completes',async()=>{
 const h=harness();await h.grant();const s=await h.ready(30),before=(await h.engine().status()).ordinaryBudget.reservedUSD;h.flags.cleanup=false;await h.engine().stop({sessionId:s.id});await h.engine().tick();assert.equal((await h.engine().status()).session.phase,'stopping');assert.equal((await h.engine().status()).ordinaryBudget.reservedUSD,before);assert(h.guards.every(Boolean));assert.equal(h.rows.length,1);h.flags.cleanup=true;await h.engine().tick();assert.equal((await h.engine().status()).session.cleanupVerified,true);assert.equal((await h.engine().status()).ordinaryBudget.reservedUSD,0);
});
test('wrong expiry proof refuses creation before any provider mutation or charge estimate',async()=>{
 const h=harness();await h.grant();h.flags.receiptExpiry=true;await h.start(30);await h.engine().tick();await h.engine().tick();const s=await h.engine().status();assert.equal(s.session.phase,'failed');assert.equal(s.ordinaryBudget.reservedUSD,0);assert.equal(s.ordinaryBudget.spentUpperUSD,0);assert.equal(h.creates,0);
});
test('current-version guards without explicit ownership V2 feature proof cannot authorize paid create',async()=>{
 for(const missing of ['top','primary','backup']){
  const h=harness();await h.grant();const original=h.deps.receipts;h.deps.receipts=async q=>{const proof=await original(q);if(missing==='top')delete proof.ownershipPolicy;else delete proof.guards[missing].ownershipPolicy;return proof;};await h.start(30);await h.engine().tick();await h.engine().tick();const status=await h.engine().status();assert.equal(h.creates,0);assert.equal(status.session.phase,'failed');assert.equal(status.ordinaryBudget.reservedUSD,0);assert.equal(status.ordinaryBudget.spentUpperUSD,0);assert.deepEqual(h.guards,[null,null]);assert.equal(await h.engine().context(),null);
 }
});
test('observed volume prevents settlement after VM disappears even if later absence receipt looks clean',async()=>{
 const h=harness();await h.grant();const s=await h.ready(30),before=(await h.engine().status()).ordinaryBudget.reservedUSD;
 h.provider.cleanup=async p=>{h.calls.push(['cleanup',p.id]);h.rows.length=0;return absenceReceipt({complete:false,vmAbsent:true,inventoryAbsent:true,unexpectedVolumeIds:['77']});};
 await h.engine().stop({sessionId:s.id});await h.engine().tick();assert.equal(h.rows.length,0);assert.equal((await h.engine().read()).session.cleanupAttention,true);assert.equal((await h.engine().status()).ordinaryBudget.reservedUSD,before);
 h.provider.cleanup=async()=>absenceReceipt({complete:true,vmAbsent:true,inventoryAbsent:true});await h.engine().tick();const status=await h.engine().status();assert.equal(status.session.cleanupVerified,false);assert.equal(status.ordinaryBudget.reservedUSD,before);assert(h.guards.every(Boolean));assert.equal(h.creates,1);await assert.rejects(h.start(15),/SESSION_ALREADY_ACTIVE/);
});
test('stored quote cannot cross legacy provider, image or target configurations before Start',async()=>{
 for(const change of ['legacy','image','target']){
  const h=harness();await h.grant();let quote;
  if(change==='legacy'){
   const old=h.deps.lifecycle,oldCatalog=h.deps.catalog;delete h.deps.lifecycle;h.deps.catalog=async()=>({id:'NVIDIA A40',secure:true,price:{secure:.59},availability:'HIGH'});quote=await h.engine().quote({minutes:30});h.deps.lifecycle=old;h.deps.catalog=oldCatalog;
  }else{
   quote=await h.engine().quote({minutes:30});const r=pinned(),t=structuredClone(TARGET);
   if(change==='image')r.artifact.servingImage='ghcr.io/benjamin-alemany/huihui-qwen3-8b-v2@sha256:'+'d'.repeat(64);
   else t.environmentName='changed-environment';
   h.deps.lifecycle=hyperstackLifecycle({target:t,release:r});
  }
  await assert.rejects(h.engine().start({quoteId:quote.id,maximumUSD:quote.maximumUSD}));assert.equal(h.creates,0);assert.equal((await h.engine().status()).ordinaryBudget.reservedUSD,0);
 }
});
test('bootstrap binding changed after Start is rejected immediately before paid create',async()=>{
 const h=harness();await h.grant();await h.start(30);await h.engine().tick();const changed=pinned();changed.artifact.bootstrapLockSha256='d'.repeat(64);h.deps.lifecycle=hyperstackLifecycle({target:TARGET,release:changed});await h.engine().tick();const status=await h.engine().status();assert.equal(h.creates,0);assert.equal(status.session.phase,'failed');assert.equal(status.ordinaryBudget.reservedUSD,0);
});
test('binding update does not prevent cleanup of an already created matching allocation',async()=>{
 const h=harness();await h.grant();const s=await h.ready(30);const changed=pinned();changed.artifact.bootstrapLockSha256='d'.repeat(64);h.deps.lifecycle=hyperstackLifecycle({target:TARGET,release:changed});await h.engine().stop({sessionId:s.id});await h.engine().tick();assert.equal((await h.engine().status()).session.phase,'stopped');assert.equal(h.creates,1);assert.equal(h.rows.length,0);
});
test('expired health tick cannot cancel or mutate a later explicitly started session',async()=>{
 const h=harness();await h.grant();const old=await h.ready(30);let resume,entered;const started=new Promise(r=>entered=r),pending=new Promise(r=>resume=r);
 h.provider.health=async()=>{entered();return pending;};const stale=h.engine().tick();await started;
 await h.engine().stop({sessionId:old.id});h.advance(191000);await h.engine().tick();assert.equal((await h.engine().status()).session.phase,'stopped');
 const quote=await h.start(15),before=(await h.engine().status()).session;assert.equal(before.phase,'preflight');resume(true);await stale;const after=(await h.engine().status()).session;
 assert.equal(after.id,before.id);assert.equal(after.phase,'preflight');assert.equal(after.stopRequested,false);assert.equal(after.quoteId,quote.id);assert.equal(h.creates,1);
});
test('delayed heartbeat from expired lease cannot replace the newer reservation nonce or deadline',async()=>{
 const h=harness();await h.grant();await h.start(30);let resume,entered,count=0;const started=new Promise(r=>entered=r),pending=new Promise(r=>resume=r);
 h.deps.heartbeat=async()=>{if(++count===1){entered();await pending;}};const stale=h.engine().tick();await started;h.advance(191000);await h.engine().tick();
 const before=(await h.engine().read()).session;assert.equal(before.phase,'arming');assert(before.nonce);resume();await stale;const after=(await h.engine().read()).session;
 assert.equal(after.id,before.id);assert.equal(after.phase,'arming');assert.equal(after.nonce,before.nonce);assert.deepEqual(after.reservation,before.reservation);assert.equal(after.lease,before.lease);assert.equal(h.creates,0);
});
test('late old-session billing incident cancels a pending allocation before any paid create',async()=>{
 for(const stage of ['preflight','arming']){
  const h=harness();await h.grant();await h.start(30);if(stage==='arming')await h.engine().tick();const before=(await h.engine().read()).session;
  await h.engine().recordCleanup({id:'previous-session',lease:'expired-lease'},{unexpectedVolumeIds:['77']});const observed=(await h.engine().read()).session;assert.equal(observed.id,before.id);assert.deepEqual(observed.reservation,before.reservation);assert.equal(observed.deadline,before.deadline);assert.equal(observed.stopRequested,true);
  await h.engine().tick();await h.engine().tick();const status=await h.engine().status();assert.equal(h.creates,0);assert.equal(status.cleanupAttention,true);assert.equal(status.launchEnabled,false);assert.equal(await h.engine().context(),null);assert.equal(status.ordinaryBudget.reservedUSD,0);assert(['cancelled','failed'].includes(status.session.phase));h.advance(10*60000);await h.engine().tick();assert.equal(h.creates,0);
 }
});

test('late residual-resource observations remain durable without rewriting a newer session',async()=>{
 const h=harness();await h.grant();const old=await h.ready(30),snapshot=(await h.engine().read()).session;
 await h.engine().stop({sessionId:old.id});await h.engine().tick();await h.start(15);
 const next=structuredClone((await h.engine().read()).session);
 assert.equal(await h.engine().recordCleanup(snapshot,absenceReceipt({unexpectedVolumeIds:['77']})),false);
 const state=await h.engine().read();assert.deepEqual({...state.session,stopRequested:next.stopRequested,stopAt:next.stopAt,code:next.code},{...next,stopAt:undefined,code:undefined});assert.equal(state.session.stopRequested,true);assert.deepEqual(state.cleanupIncidents[0].volumeIds,['77']);assert.equal((await h.engine().status()).cleanupAttention,true);assert.equal((await h.engine().status()).launchEnabled,false);
});
test('outer gateway and model backend authentication are distinct and both are erased after cleanup',async()=>{
 const h=harness();await h.grant();const session=await h.ready(30),raw=(await h.engine().read()).session;
 assert.match(raw.modelKey,/^[a-f0-9]{64}$/);assert.notEqual(raw.modelKey,raw.inferenceKey);const context=await h.engine().context();assert.equal(context.INFERENCE_API_KEY,raw.inferenceKey);assert(!JSON.stringify(context).includes(raw.modelKey));
 await h.engine().stop({sessionId:session.id});await h.engine().tick();const done=(await h.engine().read()).session;assert.equal(done.inferenceKey,undefined);assert.equal(done.modelKey,undefined);
});

function diagnosticReceipt(allocation,reservation,sessionId,at,state='available'){
 return {version:1,provider:'hyperstack',kind:'host-console-progress-v1',state,sessionId,nonce:reservation.nonce,deadline:reservation.deadline,allocationId:allocation.id,observedAt:at,events:state==='available'?[{version:1,sessionId,nonce:reservation.nonce,component:'bootstrap',phase:'driver-check',status:'failed',at,deadline:reservation.deadline}]:[],diagnosticOnly:true};
}
test('early startup diagnostics commit intent and revoke chat before bounded capture, then preserve only a keyless summary',async()=>{
 const h=harness();h.deps.id=()=>crypto.randomUUID();await h.grant();h.flags.health=false;const initial=await h.ready(30);h.advance(15*60000);let resolve,entered,args,secrets;const started=new Promise(r=>entered=r),pending=new Promise(r=>resolve=r);let captures=0;
 h.provider.diagnostics=async(allocation,reservation,sessionId)=>{captures++;args={allocation,reservation,sessionId};const raw=(await h.engine().read()).session;secrets=[raw.inferenceKey,raw.modelKey];assert.equal(raw.diagnosticsAttempted,true);assert.equal(raw.phase,'stopping');assert.equal(raw.code,'STARTUP_TIMEOUT');assert.equal(await h.engine().context(),null);entered();return pending;};
 const tick=h.engine().tick();await started;assert.equal(h.rows.length,1);assert.equal(h.calls.filter(c=>c[0]==='shorten'||c[0]==='cleanup').length,0);assert.equal((await h.engine().status()).session.deadline,initial.deadline);resolve(diagnosticReceipt(args.allocation,args.reservation,args.sessionId,h.now));await tick;
 const raw=(await h.engine().read()).session,status=await h.engine().status();assert.equal(raw.hostDiagnostics.diagnosticOnly,true);assert.equal(status.session.code,'STARTUP_TIMEOUT');assert.equal(status.session.phase,'stopped');assert.deepEqual(status.session.diagnostics,{state:'available',observedAt:h.now,eventCount:1,latestEvent:{component:'bootstrap',phase:'driver-check',status:'failed',at:h.now},diagnosticOnly:true});assert(!('events'in status.session.diagnostics));assert(secrets.every(key=>!JSON.stringify(status).includes(key)));assert.equal(h.rows.length,0);assert.equal(captures,1);assert.equal(status.session.deadline,initial.deadline);assert.equal(h.creates,1);
});
test('manual Stop, actual expiry and near-expiry cleanup never wait for or request host diagnostics',async()=>{
 for(const mode of ['owner','near-expiry','expiry','ready-expiry']){
  const h=harness();h.deps.id=()=>crypto.randomUUID();await h.grant();h.flags.health=mode==='ready-expiry';const initial=await h.ready(30);let calls=0;h.provider.diagnostics=async()=>{calls++;throw Error('Never request diagnostics here');};
  h.advance(mode==='owner'?15*60000:mode==='near-expiry'?30*60000-44999:30*60000);if(mode==='owner')await h.engine().stop({sessionId:initial.id});await h.engine().tick();const raw=(await h.engine().read()).session;assert.equal(calls,0);assert.equal(raw.diagnosticsAttempted,undefined);assert.equal(raw.phase,'stopped');assert.equal(new Date(raw.deadline).toISOString(),initial.deadline);assert.equal(h.rows.length,0);
 }
});
test('diagnostic errors and extra raw fields are sanitized, cannot skip cleanup and are never retried',async()=>{
 for(const mode of ['throw','raw-extra']){
  const h=harness();h.deps.id=()=>crypto.randomUUID();await h.grant();h.flags.health=false;h.flags.cleanup=false;await h.ready(30);h.advance(15*60000);let calls=0;h.provider.diagnostics=async(p,q,id)=>{calls++;if(mode==='throw')throw Error('DUMMY_SECRET_RAW_PROVIDER_ERROR');return {...diagnosticReceipt(p,q,id,h.now),rawConsole:'DUMMY_SECRET'};};
  await h.engine().tick();let raw=(await h.engine().read()).session;assert.equal(raw.diagnosticsAttempted,true);assert.equal(raw.hostDiagnostics.state,'unavailable');assert(!JSON.stringify(raw.hostDiagnostics).includes('DUMMY_SECRET'));assert.equal(raw.code,'STARTUP_TIMEOUT');assert(h.calls.some(c=>c[0]==='cleanup'));h.flags.cleanup=true;await h.engine().tick();raw=(await h.engine().read()).session;assert.equal(raw.phase,'stopped');assert.equal(raw.code,'STARTUP_TIMEOUT');assert.equal(calls,1);assert.equal((await h.engine().status()).session.diagnostics.state,'unavailable');
 }
});
test('a persisted diagnostic attempt after a crash skips collection and continues cleanup',async()=>{
 const h=harness();h.deps.id=()=>crypto.randomUUID();await h.grant();h.flags.health=false;const initial=await h.ready(30);h.advance(15*60000);await h.engine().update(initial.id,c=>{c.diagnosticsAttempted=true;c.diagnosticsAttemptedAt=h.now;c.phase='stopping';c.stopRequested=true;c.code='STARTUP_TIMEOUT';});let calls=0;h.provider.diagnostics=async()=>{calls++;throw Error('Never retry');};await h.engine().tick();assert.equal(calls,0);assert.equal((await h.engine().status()).session.code,'STARTUP_TIMEOUT');assert.equal((await h.engine().status()).session.phase,'stopped');assert.equal(h.rows.length,0);
});
test('never-ready unexpected failures can capture one diagnostic without making it readiness or replacing the reason',async()=>{
 const h=harness();h.deps.id=()=>crypto.randomUUID();await h.grant();h.flags.health=false;await h.ready(30);h.advance(2*60000);h.provider.health=async()=>{throw Error('DUMMY_SECRET_FAILURE');};let calls=0;h.provider.diagnostics=async(p,q,id)=>{calls++;return diagnosticReceipt(p,q,id,h.now);};await h.engine().tick();let status=await h.engine().status();assert.equal(status.session.phase,'stopping');assert.equal(status.session.code,'PROVIDER_OR_IDENTITY_UNCONFIRMED');assert.equal(status.session.diagnostics.diagnosticOnly,true);assert.equal(await h.engine().context(),null);await h.engine().tick();status=await h.engine().status();assert.equal(status.session.phase,'stopped');assert.equal(status.session.code,'PROVIDER_OR_IDENTITY_UNCONFIRMED');assert.equal(calls,1);assert(!JSON.stringify(status).includes('DUMMY_SECRET_FAILURE'));
});
test('an owner Stop during early diagnostic capture still immediately shortens both independent guards',async()=>{
 const h=harness();h.deps.id=()=>crypto.randomUUID();await h.grant();h.flags.health=false;const initial=await h.ready(30);h.advance(15*60000);let entered,resolve,args;const started=new Promise(r=>entered=r),pending=new Promise(r=>resolve=r);h.provider.diagnostics=async(p,q,id)=>{args=[p,q,id];entered();return pending;};const tick=h.engine().tick();await started;await h.engine().stop({sessionId:initial.id});assert.equal(h.calls.filter(c=>c[0]==='shorten').length,2);assert.equal(await h.engine().context(),null);resolve(diagnosticReceipt(...args,h.now));await tick;assert.equal((await h.engine().status()).session.phase,'stopped');assert.equal(h.rows.length,0);
});
test('a delayed diagnostic from an expired operation cannot alter a newer session',async()=>{
 const h=harness();h.deps.id=()=>crypto.randomUUID();await h.grant();h.flags.health=false;await h.ready(30);h.advance(15*60000);let entered,resolve,args;const started=new Promise(r=>entered=r),pending=new Promise(r=>resolve=r);h.provider.diagnostics=async(p,q,id)=>{args=[p,q,id];entered();return pending;};const stale=h.engine().tick();await started;h.advance(191000);await h.engine().tick();assert.equal((await h.engine().status()).session.phase,'stopped');await h.start(15);const next=structuredClone((await h.engine().read()).session);resolve(diagnosticReceipt(...args,h.now));await stale;assert.deepEqual((await h.engine().read()).session,next);assert.equal(h.creates,1);
});
