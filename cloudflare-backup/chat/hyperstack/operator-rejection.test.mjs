import test from 'node:test';
import assert from 'node:assert/strict';
import {parseOperatorRejection,validateOperatorRejection,sameOperatorRejection} from './operator-rejection.mjs';
import {NOW,TARGET} from './fixtures.mjs';
function packet(){
 const nonce='a'.repeat(32),q={kind:'chat',provider:'hyperstack',ownershipPolicy:'nonce-name-v2',minutes:30,name:'unjailed-chat-'+nonce,image:'ghcr.io/benjamin-alemany/huihui-qwen3-8b-v2@sha256:'+'b'.repeat(64),nonce,target:structuredClone(TARGET),createdNotBefore:NOW,createdNotAfter:NOW+300000,deadline:NOW+1800000,windowStart:new Date(NOW).toISOString(),windowEnd:new Date(NOW+300000).toISOString()};
 return {version:1,id:'11111111-1111-4111-8111-111111111111',sessionId:'22222222-2222-4222-8222-222222222222',approvalId:'DUMMY_ONE_ACCEPTANCE',reservation:q,requestAt:NOW+60000,confirmedAt:NOW+3600000,httpStatus:400,evidenceSHA256:'c'.repeat(64),reason:'PROVIDER_CONFIRMED_NO_CREATE'};
}
test('private rejection packet binds only exact V2 identity and reviewed provider-evidence digest',()=>{
 const p=packet(),options={target:TARGET,now:NOW+3600000},checked=validateOperatorRejection(p,options);
 assert.deepEqual(parseOperatorRejection(JSON.stringify(p),options),checked);assert(sameOperatorRejection(checked,p));
 const reordered={...p,reservation:Object.fromEntries(Object.entries(p.reservation).reverse())};assert(sameOperatorRejection(validateOperatorRejection(reordered,options),checked));checked.reservation.target.keyName='changed';assert.notEqual(p.reservation.target.keyName,'changed');
});
test('missing V2, extra controls, mismatched targets, invalid evidence or incoherent times refuse',()=>{
 const changes=[p=>delete p.reservation.ownershipPolicy,p=>p.extra='DUMMY_PRIVATE_KEY',p=>p.reservation.controlKey='DUMMY_PRIVATE_KEY',p=>p.reservation.target.secret='DUMMY_PRIVATE_KEY',p=>p.reservation.target.environmentId=99,p=>p.id='not UUID',p=>p.sessionId='',p=>p.approvalId='',p=>p.approvalId='a\nb',p=>p.reason='HTTP400_IS_ALWAYS_SAFE',p=>p.httpStatus=200,p=>p.httpStatus=500,p=>p.httpStatus=400.5,p=>p.evidenceSHA256='not evidence',p=>p.requestAt=NOW-1,p=>p.requestAt=NOW+300001,p=>p.confirmedAt=NOW,p=>p.confirmedAt=NOW+3600001,p=>p.reservation.nonce='d'.repeat(32),p=>p.reservation.deadline++];
 for(const change of changes){const p=packet();change(p);assert.throws(()=>validateOperatorRejection(p,{target:TARGET,now:NOW+3600000}),/OPERATOR_REJECTION_PACKET_INVALID/);}
 for(const value of [undefined,'not JSON','x'.repeat(16385)])assert.throws(()=>parseOperatorRejection(value,{target:TARGET,now:NOW+3600000}));
 assert.throws(()=>validateOperatorRejection(packet(),{target:TARGET,now:NaN}));
});
test('packet rejects hidden nested fields rather than silently normalizing them away',()=>{
 for(const extra of ['providerKey','user_data','__proto__']){
  const p=JSON.parse(JSON.stringify(packet()));Object.defineProperty(p.reservation.target,extra,{value:'DUMMY_PRIVATE_SECRET',enumerable:true});
  assert.throws(()=>parseOperatorRejection(JSON.stringify(p),{target:TARGET,now:NOW+3600000}),/OPERATOR_REJECTION_PACKET_INVALID/);
 }
});
