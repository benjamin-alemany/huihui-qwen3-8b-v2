import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {validateOperatorAbsence,parseOperatorAbsence,sameOperatorAbsence,verifyOperatorAbsence} from './operator-absence.mjs';
import {normalizeVM,validateReservation,matchesReservation} from './policy.mjs';
import {NOW,TARGET,rawVM} from './fixtures.mjs';
const CLOSED=NOW+300001;
function packet(){
 const nonce='a'.repeat(32),reservation=validateReservation({kind:'chat',provider:'hyperstack',minutes:30,image:'ghcr.io/benjamin-alemany/huihui-qwen3-8b-v2@sha256:'+'a'.repeat(64),nonce,name:'unjailed-chat-'+nonce,target:TARGET,createdNotBefore:NOW,createdNotAfter:NOW+300000,deadline:NOW+1800000,windowStart:new Date(NOW).toISOString(),windowEnd:new Date(NOW+300000).toISOString()});
 return {version:1,id:'11111111-1111-4111-8111-111111111111',sessionId:'22222222-2222-4222-8222-222222222222',approvalId:'DUMMY_ONE_ACCEPTANCE',reservation,allocation:normalizeVM(rawVM({labels:[]})),observedAt:NOW+1000,deleteRequestedAt:NOW+2000,absenceObservedAt:NOW+3000,reason:'MISSING_PROVIDER_LABEL'};
}
test('strict operator packet preserves the truthful missing label without changing ordinary ownership',()=>{
 const p=packet(),checked=validateOperatorAbsence(p,{target:TARGET,now:CLOSED});assert.deepEqual(checked.allocation.labels,[]);assert.equal(matchesReservation(checked.allocation,checked.reservation),false);assert.deepEqual(parseOperatorAbsence(JSON.stringify(p),{target:TARGET,now:CLOSED}),checked);
 const reordered={...p,reservation:Object.fromEntries(Object.entries(p.reservation).reverse()),allocation:Object.fromEntries(Object.entries(p.allocation).reverse())};assert(sameOperatorAbsence(validateOperatorAbsence(reordered,{target:TARGET,now:CLOSED}),checked));
});
test('provider timestamps without a suffix remain UTC on a non-UTC operator machine',()=>{
 const p=packet();p.allocation.createdAt=p.allocation.createdAt.replace(/\.000Z$/,'');
 const script=`import {validateOperatorAbsence} from ${JSON.stringify(new URL('./operator-absence.mjs',import.meta.url).href)}; validateOperatorAbsence(${JSON.stringify(p)},{target:${JSON.stringify(TARGET)},now:${CLOSED}});`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,TZ:'Pacific/Honolulu'},encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});
test('historical missing-label exception remains A6000-only after another target is reviewed',()=>{
 const p=packet(),target={...TARGET,flavorId:77,flavorName:'n3-A100x1',maximumHourlyUSD:1.36};
 p.reservation.target=target;p.allocation.flavor={...p.allocation.flavor,id:77,name:target.flavorName};
 assert.throws(()=>validateOperatorAbsence(p,{target,now:CLOSED}),/OPERATOR_ABSENCE_PACKET_INVALID/);
});
test('wrong identity, extra controls, labels, volumes and incoherent or future times refuse',()=>{
 const mutations=[p=>p.extra=true,p=>p.version=2,p=>p.id='bad',p=>p.approvalId='',p=>p.reason='DEFINITE_NO_CREATE',p=>p.allocation.name='unrelated',p=>p.allocation.labels=['unjailed:'+p.reservation.nonce],p=>p.allocation.volumeIds=['77'],p=>p.allocation.user_data='DUMMY_SECRET',p=>p.allocation.artifactVerified=true,p=>p.allocation.environment.id=99,p=>p.allocation.flavor.count=2,p=>p.allocation.createdAt=new Date(NOW-1).toISOString(),p=>p.allocation.publicIp='999.0.0.1',p=>p.observedAt=NOW-1,p=>p.deleteRequestedAt=NOW,p=>p.absenceObservedAt=NOW+1000,p=>p.absenceObservedAt=CLOSED+1,p=>p.reservation.controlKey='DUMMY_SECRET',p=>p.reservation.target={...p.reservation.target,environmentId:99}];
 for(const mutate of mutations){const p=packet();mutate(p);assert.throws(()=>validateOperatorAbsence(p,{target:TARGET,now:CLOSED}));}
 assert.throws(()=>validateOperatorAbsence(packet(),{target:TARGET,now:NOW+299999}));assert.throws(()=>parseOperatorAbsence(undefined,{target:TARGET,now:CLOSED}));assert.throws(()=>parseOperatorAbsence('not JSON',{target:TARGET,now:CLOSED}));
});
test('each absence proof performs only its own GET404, full empty list, GET404 and remains billing-qualified',async()=>{
 for(let role=0;role<3;role++){
  const calls=[],p=packet(),provider={get:async id=>{calls.push(['get',id]);return null;},list:async()=>{calls.push(['list']);return [];},remove:async()=>{throw Error('No DELETE allowed');},create:async()=>{throw Error('No CREATE allowed');}};
  const r=await verifyOperatorAbsence({provider,packet:p,target:TARGET,now:()=>CLOSED});assert.deepEqual(calls,[['get','44'],['list'],['get','44']]);assert.equal(r.operatorReconciled,true);assert.equal(r.reconciliationId,p.id);assert.equal(r.allocationId,'44');assert.equal(r.complete,true);assert.equal(r.independentIpReadback,false);assert.equal(r.billingSettlementPending,true);assert.equal(r.checkedAt,CLOSED);
 }
});
test('a live or omitted VM, any account allocation, failed inventory or final read failure never proves absence',async()=>{
 const p=packet();
 for(const mode of ['first-live','unrelated','inventory-failed','inventory-malformed','final-live','final-failed']){
  let reads=0;const provider={get:async()=>{reads++;if(mode==='first-live'||mode==='final-live'&&reads===2)return p.allocation;if(mode==='final-failed'&&reads===2)throw Error('DUMMY');return null;},list:async()=>{if(mode==='inventory-failed')throw Error('DUMMY');if(mode==='inventory-malformed')return {};return mode==='unrelated'?[{id:'99'}]:[];}};
  await assert.rejects(verifyOperatorAbsence({provider,packet:p,target:TARGET,now:CLOSED}));
 }
});
