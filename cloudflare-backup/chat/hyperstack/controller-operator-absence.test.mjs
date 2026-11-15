import test from 'node:test';
import assert from 'node:assert/strict';
import manifest from '../../../release/manifest.json' with {type:'json'};
import {SessionEngine} from '../controller/engine.mjs';
import {SCALE,SEED} from '../controller/session-policy.mjs';
import {hyperstackLifecycle} from './controller-policy.mjs';
import {reconcileControllerOperatorAbsence} from './controller-operator-absence.mjs';
import {verifyOperatorAbsence} from './operator-absence.mjs';
import {normalizeVM,validateReservation} from './policy.mjs';
import {NOW,TARGET,rawVM,Store} from './fixtures.mjs';

class EngineStore extends Store{async setAlarm(n){this.alarm=n;}async deleteAlarm(){this.alarm=null;}}
async function harness(){
 const release={...structuredClone(manifest),status:'candidate',artifact:{...manifest.artifact,servingImage:'ghcr.io/benjamin-alemany/huihui-qwen3-8b-v2@sha256:'+'a'.repeat(64)},hosting:{...manifest.hosting,flavor:TARGET.flavorName,region:TARGET.region,vmImageId:33}},lifecycle=hyperstackLifecycle({target:TARGET,release});
 const historical=lifecycle.reservation(NOW,'a'.repeat(32),30);delete historical.ownershipPolicy;
 const q=validateReservation(historical),quote=lifecycle.makeQuote({provider:'hyperstack',gpu:'RTX-A6000',gpuHourly:.5,totalHourly:.50672043,availability:'AVAILABLE'},NOW,'33333333-3333-4333-8333-333333333333',30);
 const packet={version:1,id:'11111111-1111-4111-8111-111111111111',sessionId:'22222222-2222-4222-8222-222222222222',approvalId:'DUMMY_ONE_ACCEPTANCE',reservation:q,allocation:normalizeVM(rawVM({labels:[]})),observedAt:NOW+1000,deleteRequestedAt:NOW+2000,absenceObservedAt:NOW+3000,reason:'MISSING_PROVIDER_LABEL'};
 const session={id:packet.sessionId,quoteId:quote.id,quote,reservation:q,approval:packet.approvalId,budgetKind:'test',createAttempted:true,phase:'attention',stopRequested:true,everReady:false,nonce:q.nonce,bootAt:q.createdNotBefore,deadline:q.deadline,inferenceKey:'c'.repeat(64),modelKey:'d'.repeat(64),leaseUntil:0};
 const store=new EngineStore(),ledger={...structuredClone(SEED),cap:2*SCALE,spent:Math.round(.4*SCALE),held:quote.holdUnits,usedApprovals:['DUMMY_EARLIER_APPROVAL',packet.approvalId]};
 await store.put('session-ledger-v1',{ledger,session,quotes:[],ordinaryLedger:{version:1,cap:0,spent:0,held:0,grantCount:0}});await store.put('session-start-v1:'+quote.id,{sessionId:session.id,budgetKind:'test'});
 let now=NOW+600000,sequence=0;const calls=[],flags={guardFail:false,live:false,finalLive:false},provider={get:async id=>{calls.push(['get',id]);return flags.live?packet.allocation:null;},list:async()=>{calls.push(['list']);return [];},create:async()=>{throw Error('Never create');},cleanup:async()=>{throw Error('Never delete');}};
 const deps={enabled:false,validationMode:true,connected:true,approval:packet.approvalId,maxUSD:.35,lifecycle,provider,now:()=>now,id:()=>`operator-token-${++sequence}`,guards:['primary','backup'].map(role=>({operatorAbsence:async p=>{calls.push(['guard',role]);if(flags.guardFail&&role==='backup')throw Error('DUMMY_GUARD_UNCONFIRMED');return {...await verifyOperatorAbsence({provider,packet:p,target:TARGET,now}),role,armed:false,bindings:[],deleted:[]};}}))};
 const engine=new SessionEngine(store,deps);return {engine,store,packet,session,quote,ledger,deps,calls,flags,setNow:n=>{now=n;}};
}
test('operator recovery records a created/deleted failure and conservatively consumes only the existing hold once',async()=>{
 const h=await harness(),before=await h.engine.read(),result=await reconcileControllerOperatorAbsence(h.engine,h.packet),after=await h.engine.read();
 assert.equal(result.complete,true);assert.equal(result.billingSettlementPending,true);assert.equal(result.acceptancePassed,false);assert.equal(after.session.createAttempted,true);assert.notEqual(after.session.definiteNoCreate,true);assert.equal(after.session.phase,'stopped');assert.equal(after.session.settledUnits,h.quote.holdUnits);assert.equal(after.ledger.spent,before.ledger.spent+h.quote.holdUnits);assert.equal(after.ledger.held,0);assert.equal(after.ledger.cap,before.ledger.cap);assert.deepEqual(after.ledger.usedApprovals,before.ledger.usedApprovals);assert.deepEqual(after.ordinaryLedger,before.ordinaryLedger);assert.equal(after.session.inferenceKey,undefined);assert.equal(after.session.modelKey,undefined);assert.equal(after.session.nonce,undefined);assert.equal(h.store.alarm,null);assert.deepEqual(after.session.knownPodIds,undefined);
 const receipt=await reconcileControllerOperatorAbsence(h.engine,h.packet);assert.equal(receipt.replayed,true);assert.deepEqual((await h.engine.read()).ledger,after.ledger);assert.equal(await h.engine.context(),null);assert.equal((await h.engine.status()).launchEnabled,false);
});
test('any live VM, guard failure or a late allocation keeps the hold and session keys',async()=>{
 for(const mode of ['live','guard','late']){
  const h=await harness(),before=await h.engine.read();
  if(mode==='live')h.flags.live=true;
  if(mode==='guard')h.flags.guardFail=true;
  if(mode==='late'){const last=h.deps.guards[1].operatorAbsence;h.deps.guards[1].operatorAbsence=async p=>{const receipt=await last(p);h.flags.live=true;return receipt;};}
  await assert.rejects(reconcileControllerOperatorAbsence(h.engine,h.packet));const after=await h.engine.read();assert.deepEqual(after.ledger,before.ledger);assert.equal(after.session.inferenceKey,before.session.inferenceKey);assert.equal(after.session.modelKey,before.session.modelKey);assert.notEqual(after.session.phase,'stopped');
 }
});
test('wrong consumed approval, target/session state, ordinary mode, open launch or prior model permit refuse',async()=>{
 for(const mode of ['enabled','ordinary','approval','not-stopped','ready','model-permit','marker','known-id','hold','volume']){
  const h=await harness(),r=await h.engine.read();
  if(mode==='enabled')h.deps.enabled=true;if(mode==='ordinary')h.deps.validationMode=false;if(mode==='approval')r.ledger.usedApprovals=[];if(mode==='not-stopped')r.session.stopRequested=false;if(mode==='ready')r.session.everReady=true;if(mode==='model-permit')await h.store.put('hyperstack-runtime-handshake-v1:'+h.session.id,{phase:'permit-requested'});if(mode==='marker')await h.store.put('session-start-v1:'+h.quote.id,{sessionId:'WRONG',budgetKind:'test'});if(mode==='known-id')r.session.knownPodIds=['44'];if(mode==='hold')r.ledger.held--;if(mode==='volume')r.cleanupIncidents=[{resolved:false,volumeIds:['77']}];await h.store.put('session-ledger-v1',r);
  await assert.rejects(reconcileControllerOperatorAbsence(h.engine,h.packet));assert.equal((await h.engine.read()).ledger.held,r.ledger.held);assert.equal(h.calls.length,0);
 }
});
test('a changed operation/session during an awaited read cannot settle or clear the newer state',async()=>{
 const h=await harness();h.deps.provider.get=async()=>{const r=await h.engine.read();r.session={...r.session,id:'99999999-9999-4999-8999-999999999999',lease:'new-operation',modelKey:'NEW_DUMMY_KEY'};await h.store.put('session-ledger-v1',r);return null;};
 await assert.rejects(reconcileControllerOperatorAbsence(h.engine,h.packet));const after=await h.engine.read();assert.equal(after.session.id,'99999999-9999-4999-8999-999999999999');assert.equal(after.session.modelKey,'NEW_DUMMY_KEY');assert.equal(after.ledger.held,h.quote.holdUnits);
});
test('exact old reconciliation replay leaves a newer session untouched; changed packet ID reuse refuses',async()=>{
 const h=await harness();await reconcileControllerOperatorAbsence(h.engine,h.packet);const r=await h.engine.read();r.session={id:'99999999-9999-4999-8999-999999999999',phase:'preflight',modelKey:'NEW_DUMMY_KEY'};await h.store.put('session-ledger-v1',r);
 assert.equal((await reconcileControllerOperatorAbsence(h.engine,h.packet)).replayed,true);assert.deepEqual((await h.engine.read()).session,r.session);
 const changed=structuredClone(h.packet);changed.allocation.id='45';await assert.rejects(reconcileControllerOperatorAbsence(h.engine,changed));assert.deepEqual((await h.engine.read()).session,r.session);
});
