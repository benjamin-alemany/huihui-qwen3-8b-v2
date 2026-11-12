import test from 'node:test';
import assert from 'node:assert/strict';
import manifest from '../../../release/manifest.json' with {type:'json'};
import {SessionEngine} from '../controller/engine.mjs';
import {SCALE,SEED} from '../controller/session-policy.mjs';
import {hyperstackLifecycle} from './controller-policy.mjs';
import {reconcileControllerOperatorRejection} from './controller-operator-rejection.mjs';
import {NOW,TARGET,Store} from './fixtures.mjs';
const PREFIX='hyperstack-controller-operator-rejection-v1:';
class EngineStore extends Store{async setAlarm(n){this.alarm=n;}async deleteAlarm(){this.alarm=null;}}
async function harness(){
 const release={...structuredClone(manifest),status:'candidate',hosting:{...manifest.hosting,vmImageId:TARGET.imageId}},lifecycle=hyperstackLifecycle({target:TARGET,release});
 const q=lifecycle.reservation(NOW,'a'.repeat(32),30),quote={...lifecycle.makeQuote({provider:'hyperstack',gpu:'RTX-A6000',gpuHourly:.5,totalHourly:.50672043,availability:'AVAILABLE'},NOW,'33333333-3333-4333-8333-333333333333',30),lifecycleBinding:lifecycle.binding};
 const packet={version:1,id:'11111111-1111-4111-8111-111111111111',sessionId:'22222222-2222-4222-8222-222222222222',approvalId:'DUMMY_ONE_ACCEPTANCE',reservation:q,requestAt:NOW+60000,confirmedAt:NOW+3600000,httpStatus:400,evidenceSHA256:'c'.repeat(64),reason:'PROVIDER_CONFIRMED_NO_CREATE'};
 const session={id:packet.sessionId,quoteId:quote.id,quote,reservation:q,approval:packet.approvalId,budgetKind:'test',createAttempted:true,phase:'attention',stopRequested:true,nonce:q.nonce,bootAt:q.createdNotBefore,deadline:q.deadline,inferenceKey:'DUMMY_PRIVATE_OUTER_KEY',modelKey:'DUMMY_PRIVATE_MODEL_KEY',leaseUntil:0};
 const ledger={...structuredClone(SEED),cap:2*SCALE,spent:Math.round(.4*SCALE),held:quote.holdUnits,usedApprovals:['DUMMY_PRIOR_APPROVAL',packet.approvalId]},ordinary={version:1,cap:0,spent:0,held:0,grantCount:0},store=new EngineStore();
 await store.put('session-ledger-v1',{ledger,session,quotes:[],ordinaryLedger:ordinary});await store.put('session-start-v1:'+quote.id,{sessionId:session.id,budgetKind:'test'});
 const flags={live:false,failGuard:false,failList:false,listHook:null},calls=[],armed={primary:true,backup:true};let sequence=0;
 const provider={list:async options=>{calls.push('list');await options?.beforePage?.();if(flags.listHook)await flags.listHook();if(flags.failList)throw Error('DUMMY_PRIVATE_LIST_FAILURE');return flags.live?[{id:'UNRELATED_OR_LATE_VM'}]:[];},create:async()=>{calls.push('CREATE');throw Error('Never create');},cleanup:async()=>{calls.push('DELETE');throw Error('Never delete');},get:async()=>{calls.push('GET');throw Error('No fabricated VM ID');}};
 const deps={enabled:false,validationMode:true,connected:true,approval:packet.approvalId,maxUSD:.35,lifecycle,provider,now:()=>NOW+3600000,id:()=>`operator-lease-${++sequence}`,guards:['primary','backup'].map(role=>({disarm:async(name,proof)=>{calls.push('guard-'+role);assert.equal(name,q.name);assert.deepEqual(proof,{definiteNoCreate:true});if(flags.failGuard&&role==='backup')throw Error('DUMMY_PRIVATE_GUARD_FAILURE');const inventory=await provider.list();if(inventory.length)throw Error('Guard discovered allocation');armed[role]=false;return {unarmed:true};}}))};
 return {engine:new SessionEngine(store,deps),store,packet,session,quote,ledger,ordinary,deps,calls,flags,armed};
}
test('provider rejection releases only this hold once, preserving consumed approval, history and ordinary ledger',async()=>{
 const h=await harness(),before=await h.engine.read(),receipt=await reconcileControllerOperatorRejection(h.engine,h.packet),after=await h.engine.read();
 assert.deepEqual(receipt,{complete:true,reconciliationId:h.packet.id,sessionId:h.packet.sessionId,approvalId:h.packet.approvalId,nonce:h.packet.reservation.nonce,providerRejected:true,settledUnits:0,acceptancePassed:false});
 assert.equal(after.session.createAttempted,true);assert.equal(after.session.definiteNoCreate,true);assert.equal(after.session.phase,'failed');assert.equal(after.session.code,'PROVIDER_CONFIRMED_NO_CREATE');assert.equal(after.session.settledUnits,0);assert.equal(after.ledger.held,0);assert.equal(after.ledger.cap,before.ledger.cap);assert.equal(after.ledger.spent,before.ledger.spent);assert.deepEqual(after.ledger.usedApprovals,before.ledger.usedApprovals);assert.deepEqual(after.ordinaryLedger,before.ordinaryLedger);assert.deepEqual(h.armed,{primary:false,backup:false});assert.equal(h.store.alarm,null);
 for(const key of ['inferenceKey','modelKey','nonce','lease'])assert.equal(after.session[key],undefined);
 assert(!h.calls.some(c=>['CREATE','DELETE','GET'].includes(c)));assert.equal(h.calls.filter(c=>c==='list').length,4);assert(!JSON.stringify(await h.store.get(PREFIX+h.packet.id)).includes('DUMMY_PRIVATE'));
 const replay=await reconcileControllerOperatorRejection(h.engine,h.packet);assert.equal(replay.replayed,true);assert.deepEqual((await h.engine.read()).ledger,after.ledger);assert.equal(h.calls.filter(c=>c==='list').length,4);assert.equal((await h.engine.status()).launchEnabled,false);assert.equal(await h.engine.context(),null);
});
test('open authority, wrong identity/quote/evidence scope, runtime permit and resource observations refuse without I/O',async()=>{
 for(const mode of ['enabled','ordinary','provider','approval','unused','not-stopped','ready','pod','known-id','known-allocation','incident','hold','quote','deadline','session','marker','permit']){
  const h=await harness(),r=await h.engine.read();
  if(mode==='enabled')h.deps.enabled=true;if(mode==='ordinary')h.deps.validationMode=false;if(mode==='provider')h.engine.lifecycle={...h.deps.lifecycle,provider:'runpod'};if(mode==='approval')h.deps.approval='WRONG_APPROVAL';if(mode==='unused')r.ledger.usedApprovals=[];if(mode==='not-stopped')r.session.stopRequested=false;if(mode==='ready')r.session.everReady=true;if(mode==='pod')r.session.pod={id:'44'};if(mode==='known-id')r.session.knownPodIds=['44'];if(mode==='known-allocation')r.session.knownAllocations=[{id:'44'}];if(mode==='incident')r.cleanupIncidents=[{resolved:false,volumeIds:['77']}];if(mode==='hold')r.ledger.held--;if(mode==='quote')r.session.quote.id='WRONG_QUOTE';if(mode==='deadline')r.session.deadline++;if(mode==='session')r.session.id='99999999-9999-4999-8999-999999999999';if(mode==='marker')await h.store.put('session-start-v1:'+h.quote.id,{sessionId:'WRONG',budgetKind:'test'});if(mode==='permit')await h.store.put('hyperstack-runtime-handshake-v1:'+h.session.id,{phase:'permit-requested'});
  await h.store.put('session-ledger-v1',r);await assert.rejects(reconcileControllerOperatorRejection(h.engine,h.packet),undefined,mode);assert.equal(h.calls.length,0);assert.equal((await h.engine.read()).ledger.held,r.ledger.held);
 }
});
test('nonempty, partial, failed or newly occupied inventory retains the hold and does not set the no-create flag',async()=>{
 for(const mode of ['live','late','malformed','failed']){
  const h=await harness();if(mode==='live')h.flags.live=true;if(mode==='failed')h.flags.failList=true;
  if(mode==='late')h.flags.listHook=async()=>{if(h.calls.filter(c=>c==='list').length===2)h.flags.live=true;};
  if(mode==='malformed')h.deps.provider.list=async()=>({instances:[]});
  await assert.rejects(reconcileControllerOperatorRejection(h.engine,h.packet));const after=await h.engine.read();assert.equal(after.ledger.held,h.quote.holdUnits);assert.notEqual(after.session.definiteNoCreate,true);assert.equal(await h.store.get(PREFIX+h.packet.id),undefined);assert(!h.calls.some(c=>c.startsWith('guard-')));
 }
});
test('evidence journal is durable before no-create disarm; failure retains hold and retries cleanup only',async()=>{
 const h=await harness();h.flags.failGuard=true;const disarm=h.deps.guards[0].disarm;
 h.deps.guards[0].disarm=async(...args)=>{const s=(await h.engine.read()).session,j=await h.store.get(PREFIX+h.packet.id);assert(j);assert.deepEqual(j.packet,h.packet);assert.equal(j.phase,'finishing');assert.equal(s.definiteNoCreate,true);assert.equal(s.operatorRejectionId,h.packet.id);return disarm(...args);};
 await assert.rejects(reconcileControllerOperatorRejection(h.engine,h.packet));let after=await h.engine.read();assert.equal(after.ledger.held,h.quote.holdUnits);assert.equal(after.session.settledUnits,undefined);assert.equal((await h.store.get(PREFIX+h.packet.id)).phase,'finishing');assert(!JSON.stringify(await h.store.get(PREFIX+h.packet.id)).includes('DUMMY_PRIVATE'));
 h.flags.failGuard=false;const result=await reconcileControllerOperatorRejection(h.engine,h.packet);after=await h.engine.read();assert.equal(result.complete,true);assert.equal(after.ledger.held,0);assert.equal(after.ledger.spent,h.ledger.spent);assert.equal(h.calls.includes('CREATE'),false);assert.equal(h.calls.includes('DELETE'),false);
});
test('crash after zero settlement but before archive finalization resumes without a second settlement or disarm',async()=>{
 const h=await harness(),finish=h.engine.finish.bind(h.engine);let crash=true;
 h.engine.finish=async(...args)=>{await finish(...args);if(crash){crash=false;throw Error('DUMMY_SIMULATED_CRASH_AFTER_SETTLEMENT');}};
 await assert.rejects(reconcileControllerOperatorRejection(h.engine,h.packet));const settled=await h.engine.read(),calls=h.calls.length;assert.equal(settled.ledger.held,0);assert.equal(settled.session.settledUnits,0);assert.equal((await h.store.get(PREFIX+h.packet.id)).phase,'finishing');
 const result=await reconcileControllerOperatorRejection(h.engine,h.packet);assert.equal(result.complete,true);assert.equal(h.calls.length,calls);assert.deepEqual((await h.engine.read()).ledger,settled.ledger);assert.equal((await h.store.get(PREFIX+h.packet.id)).phase,'complete');
});
test('a changed evidence packet or changed baseline cannot resume a pending operation',async()=>{
 const h=await harness();h.flags.failGuard=true;await assert.rejects(reconcileControllerOperatorRejection(h.engine,h.packet));h.flags.failGuard=false;
 const changed={...h.packet,evidenceSHA256:'d'.repeat(64)};let calls=h.calls.length;await assert.rejects(reconcileControllerOperatorRejection(h.engine,changed),/OPERATOR_REJECTION_REPLAY_MISMATCH/);assert.equal(h.calls.length,calls);
 const r=await h.engine.read();r.ledger.spent++;await h.store.put('session-ledger-v1',r);await assert.rejects(reconcileControllerOperatorRejection(h.engine,h.packet),/OPERATOR_REJECTION_LEDGER_MISMATCH/);assert.equal(h.calls.length,calls);assert.equal((await h.engine.read()).ledger.held,h.quote.holdUnits);
});
test('an allocation, permit or ledger mutation during guard I/O cannot release the hold',async()=>{
 for(const mode of ['allocation','permit','ledger']){
  const h=await harness(),disarm=h.deps.guards[1].disarm;
  h.deps.guards[1].disarm=async(...args)=>{
   const result=await disarm(...args),r=await h.engine.read();
   if(mode==='allocation'){r.session.knownPodIds=['44'];r.session.knownAllocations=[{id:'44'}];}
   if(mode==='ledger')r.ledger.spent++;
   await h.store.put('session-ledger-v1',r);
   if(mode==='permit')await h.store.put('hyperstack-runtime-handshake-v1:'+h.session.id,{phase:'permit-requested'});
   return result;
  };
  await assert.rejects(reconcileControllerOperatorRejection(h.engine,h.packet));const after=await h.engine.read();assert.equal(after.ledger.held,h.quote.holdUnits);assert.equal(after.session.settledUnits,undefined);assert.equal((await h.store.get(PREFIX+h.packet.id)).phase,'finishing');assert(!h.calls.includes('CREATE'));assert(!h.calls.includes('DELETE'));
 }
});
test('late newer session or reclaimed lease stops reconciliation without touching newer state',async()=>{
 for(const mode of ['session','lease']){
  const h=await harness();h.flags.listHook=async()=>{h.flags.listHook=null;const r=await h.engine.read();if(mode==='session')r.session={...r.session,id:'99999999-9999-4999-8999-999999999999',modelKey:'DUMMY_NEW_PRIVATE_KEY'};r.session.lease='new-operation';await h.store.put('session-ledger-v1',r);};
  await assert.rejects(reconcileControllerOperatorRejection(h.engine,h.packet));const after=await h.engine.read();assert.equal(after.session.lease,'new-operation');assert.equal(after.ledger.held,h.quote.holdUnits);if(mode==='session')assert.equal(after.session.modelKey,'DUMMY_NEW_PRIVATE_KEY');assert(!h.calls.some(c=>c.startsWith('guard-')));
 }
});
test('completed old packet replay leaves a newer session untouched; changed packet ID reuse refuses',async()=>{
 const h=await harness();await reconcileControllerOperatorRejection(h.engine,h.packet);const r=await h.engine.read();r.session={id:'99999999-9999-4999-8999-999999999999',phase:'preflight',modelKey:'DUMMY_NEW_PRIVATE_KEY'};await h.store.put('session-ledger-v1',r);const calls=h.calls.length;
 assert.equal((await reconcileControllerOperatorRejection(h.engine,h.packet)).replayed,true);assert.deepEqual((await h.engine.read()).session,r.session);assert.equal(h.calls.length,calls);
 await assert.rejects(reconcileControllerOperatorRejection(h.engine,{...h.packet,httpStatus:401}),/OPERATOR_REJECTION_REPLAY_MISMATCH/);assert.deepEqual((await h.engine.read()).session,r.session);
});
