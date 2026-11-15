import {SessionError} from '../controller/session-policy.mjs';
import {validateReservation} from './policy.mjs';
import {validateOperatorAbsence,sameOperatorAbsence,verifyOperatorAbsence} from './operator-absence.mjs';

const PREFIX='hyperstack-controller-operator-absence-v1:';
const PERMIT='hyperstack-runtime-handshake-v1:';
const refuse=code=>{throw new SessionError(code,503);};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
// Called only by the controller alarm from trusted deployment configuration.
// This exceptional post-deletion path cannot bind an allocation for inference,
// issue DELETE, fabricate a provider label, or declare that creation never ran.
export async function reconcileControllerOperatorAbsence(engine,input){
 const {d,lifecycle}=engine,now=()=>d.now();
 if(d.enabled!==false||d.validationMode!==true||lifecycle?.provider!=='hyperstack')refuse('OPERATOR_ABSENCE_LOCK_REQUIRED');
 const packet=validateOperatorAbsence(input,{target:lifecycle.target,now:now()}),key=PREFIX+packet.id,token=d.id();
 async function currentChecked(record,tx){
  if(d.enabled!==false||d.validationMode!==true)refuse('OPERATOR_ABSENCE_LOCK_REQUIRED');
  const s=record.session,q=packet.reservation;
  if(!s||s.id!==packet.sessionId||s.approval!==packet.approvalId||s.budgetKind!=='test'||s.createAttempted!==true||s.definiteNoCreate===true||s.stopRequested!==true||!['reconciling','stopping','attention'].includes(s.phase)||s.everReady===true||s.nonce!==q.nonce||s.bootAt!==q.createdNotBefore||s.deadline!==q.deadline||s.quote?.minutes!==30||!same(validateReservation(s.reservation,lifecycle.target),q)||s.pod||s.knownPodIds?.length||s.knownAllocations?.length||s.cleanupAttention||record.cleanupIncidents?.some(i=>i.resolved!==true))refuse('OPERATOR_ABSENCE_SESSION_MISMATCH');
  const ledger=record.ledger,hold=s.quote.holdUnits;
  if(s.quote.id!==s.quoteId||d.approval!==packet.approvalId||!Number.isFinite(d.maxUSD)||s.quote.maximumUSD>d.maxUSD||!Number.isSafeInteger(hold)||hold<=0||ledger.held!==hold||record.ordinaryLedger.held!==0||!Array.isArray(ledger.usedApprovals)||!ledger.usedApprovals.includes(packet.approvalId)||!Number.isSafeInteger(ledger.spent)||ledger.spent<0||!Number.isSafeInteger(ledger.spent+hold))refuse('OPERATOR_ABSENCE_LEDGER_MISMATCH');
  const marker=await tx.get('session-start-v1:'+s.quoteId);
  if(marker?.sessionId!==s.id||marker.budgetKind!=='test'||await tx.get(PERMIT+s.id)!==undefined)refuse('OPERATOR_ABSENCE_MODEL_OR_CREATE_EVIDENCE_MISMATCH');
  return s;
 }
 const prior=await engine.tx(async(r,tx)=>{
  const archived=await tx.get(key);
  if(archived){if(!sameOperatorAbsence(archived.packet,packet))refuse('OPERATOR_ABSENCE_REPLAY_MISMATCH');return {archived};}
  const s=await currentChecked(r,tx);
  if(s.leaseUntil>now())return {busy:true};
  s.lease=token;s.leaseUntil=now()+190000;await tx.setAlarm(s.leaseUntil+1000);return {acquired:true};
 });
 if(prior.archived)return {complete:true,replayed:true,...prior.archived.receipt};
 if(prior.busy)return {complete:false,busy:true};
 const renew=()=>engine.tx(async(r,tx)=>{const s=await currentChecked(r,tx);if(s.lease!==token)refuse('OPERATOR_ABSENCE_LEASE_CHANGED');s.leaseUntil=now()+190000;await tx.setAlarm(s.leaseUntil+1000);});
 const provider={
  get:async id=>{await renew();const value=await d.provider.get(id);await renew();return value;},
  list:async()=>{await renew();const value=await d.provider.list({beforePage:renew});await renew();return value;}
 };
 try{
  const before=await verifyOperatorAbsence({provider,packet,target:lifecycle.target,now});
  await renew();
  if(!Array.isArray(d.guards)||d.guards.length!==2||d.guards.some(g=>typeof g.operatorAbsence!=='function'))refuse('OPERATOR_ABSENCE_GUARDS_UNAVAILABLE');
  const proofs=await Promise.all(d.guards.map(g=>g.operatorAbsence(packet)));await renew();
  for(const [i,role]of ['primary','backup'].entries()){
   const proof=proofs[i];
   if(proof?.role!==role||proof.armed!==false||proof.operatorReconciled!==true||proof.complete!==true||proof.vmAbsent!==true||proof.inventoryAbsent!==true||proof.reconciliationId!==packet.id||proof.sessionId!==packet.sessionId||proof.approvalId!==packet.approvalId||proof.nonce!==packet.reservation.nonce||proof.allocationId!==packet.allocation.id||proof.name!==packet.reservation.name||proof.image!==packet.reservation.image||proof.deadline!==packet.reservation.deadline||proof.billingSettlementPending!==true||!Array.isArray(proof.bindings)||proof.bindings.length||!Array.isArray(proof.deleted)||proof.deleted.length)refuse('OPERATOR_ABSENCE_GUARD_UNCONFIRMED');
  }
  const receipt=await verifyOperatorAbsence({provider,packet,target:lifecycle.target,now});
  return await engine.tx(async(r,tx)=>{
   const s=await currentChecked(r,tx);if(s.lease!==token||await tx.get(key)!==undefined)refuse('OPERATOR_ABSENCE_LEASE_CHANGED');
   // Convert the existing hold to a conservative spent upper estimate exactly
   // once. It is not a settled invoice, refund, budget reset or free attempt.
   const upper=s.quote.holdUnits;r.ledger.held-=upper;r.ledger.spent+=upper;
   const stored={...receipt,settledUpperUnits:upper,billingSettlementPending:true,acceptancePassed:false};
   await tx.put(key,{packet,receipt:stored,guardReceipts:proofs,firstAbsenceReceipt:before});
   s.phase='stopped';s.code='ACCEPTANCE_IDENTITY_FAILURE_MANUAL_CLEANUP';s.finishedAt=now();s.settledUnits=upper;s.operatorReconciliationId=packet.id;s.acceptancePassed=false;s.cleanupReceipt=stored;s.leaseUntil=0;
   delete s.lease;delete s.inferenceKey;delete s.modelKey;delete s.nonce;
   await tx.deleteAlarm();return {complete:true,...stored};
  });
 }finally{
  await engine.tx(async(r,tx)=>{const s=r.session;if(s?.id!==packet.sessionId||s.lease!==token)return;s.leaseUntil=0;delete s.lease;await tx.setAlarm(now()+10000);});
 }
}
