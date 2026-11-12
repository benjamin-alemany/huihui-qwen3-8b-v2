import {SessionError,SCALE} from '../controller/session-policy.mjs';
import {validateReservation} from './policy.mjs';
import {validateOperatorRejection,sameOperatorRejection} from './operator-rejection.mjs';
const PREFIX='hyperstack-controller-operator-rejection-v1:',PERMIT='hyperstack-runtime-handshake-v1:';
const refuse=code=>{throw new SessionError(code,503);};
const same=(a,b)=>sameOperatorRejection(a,b);
const empty=p=>p===undefined||Array.isArray(p)&&p.length===0;
const ledgerView=l=>({cap:l.cap,spent:l.spent,held:l.held,usedApprovals:structuredClone(l.usedApprovals)});

// Trusted private configuration only. This exceptional, evidence-bound path
// never sends CREATE/DELETE or changes the general provider response policy.
export async function reconcileControllerOperatorRejection(engine,input){
 const {d,lifecycle}=engine,clock=()=>d.now();
 const locked=()=>{if(d.enabled!==false||d.validationMode!==true||lifecycle?.provider!=='hyperstack')refuse('OPERATOR_REJECTION_LOCK_REQUIRED');};
 locked();const packet=validateOperatorRejection(input,{target:lifecycle.target,now:clock()}),key=PREFIX+packet.id,token=d.id();
 const completedReceipt=()=>({complete:true,reconciliationId:packet.id,sessionId:packet.sessionId,approvalId:packet.approvalId,nonce:packet.reservation.nonce,providerRejected:true,settledUnits:0,acceptancePassed:false});
 function journalChecked(journal){
  if(!journal||!same(journal.packet,packet)||!['finishing','complete'].includes(journal.phase)||typeof journal.quoteId!=='string'||!journal.baseline||!journal.ordinaryBefore)refuse('OPERATOR_REJECTION_REPLAY_MISMATCH');
  if(journal.phase==='complete'&&!same(journal.receipt,completedReceipt()))refuse('OPERATOR_REJECTION_REPLAY_MISMATCH');
  return journal;
 }
 async function currentChecked(record,tx,journal){
  locked();const s=record.session,q=packet.reservation;
  let stored;try{stored=validateReservation(s?.reservation,lifecycle.target);}catch{refuse('OPERATOR_REJECTION_SESSION_MISMATCH');}
  const finished=s?.phase==='failed'&&s?.code==='PROVIDER_CONFIRMED_NO_CREATE';
  if(!s||s.id!==packet.sessionId||s.approval!==packet.approvalId||s.budgetKind!=='test'||s.createAttempted!==true||s.stopRequested!==true||s.everReady===true||s.acceptancePassed===true||!same(stored,q)||!same(s.reservation,q)||s.bootAt!==q.createdNotBefore||s.deadline!==q.deadline||s.quote?.minutes!==q.minutes||s.quote?.id!==s.quoteId||s.quote?.provider!=='hyperstack'||s.quote?.lifecycleBinding!==engine.currentBinding()||s.pod||!empty(s.knownPodIds)||!empty(s.knownAllocations)||s.cleanupAttention||!empty(record.cleanupIncidents))refuse('OPERATOR_REJECTION_SESSION_MISMATCH');
  if(finished){
   if(!journal||s.definiteNoCreate!==true||s.operatorRejectionId!==packet.id||s.settledUnits!==0||s.nonce!==undefined||s.inferenceKey!==undefined||s.modelKey!==undefined||!Number.isSafeInteger(s.finishedAt))refuse('OPERATOR_REJECTION_TERMINAL_MISMATCH');
  }else if(!['reconciling','stopping','attention'].includes(s.phase)||s.nonce!==q.nonce||s.definiteNoCreate===true&&(!journal||s.operatorRejectionId!==packet.id)||s.operatorRejectionId!==undefined&&s.operatorRejectionId!==packet.id)refuse('OPERATOR_REJECTION_SESSION_MISMATCH');
  const ledger=record.ledger,hold=s.quote.holdUnits;
  if(!ledger||!Number.isSafeInteger(hold)||hold<=0||s.quote.maximumUSD!==hold/SCALE||d.approval!==packet.approvalId||!Number.isFinite(d.maxUSD)||d.maxUSD<=0||s.quote.maximumUSD>d.maxUSD||!Number.isSafeInteger(ledger.cap)||!Number.isSafeInteger(ledger.spent)||ledger.spent<0||!Number.isSafeInteger(ledger.held)||ledger.held!==(finished?0:hold)||ledger.cap<ledger.spent+ledger.held||!Array.isArray(ledger.usedApprovals)||!ledger.usedApprovals.includes(packet.approvalId)||!record.ordinaryLedger||record.ordinaryLedger.held!==0)refuse('OPERATOR_REJECTION_LEDGER_MISMATCH');
  if(journal){
   journalChecked(journal);const expected={...journal.baseline,held:finished?0:journal.baseline.held};
   if(journal.quoteId!==s.quoteId||!same(ledgerView(ledger),expected)||!same(record.ordinaryLedger,journal.ordinaryBefore))refuse('OPERATOR_REJECTION_LEDGER_MISMATCH');
  }
  const marker=await tx.get('session-start-v1:'+s.quoteId);
  if(marker?.sessionId!==s.id||marker.budgetKind!=='test'||await tx.get(PERMIT+s.id)!==undefined)refuse('OPERATOR_REJECTION_MODEL_OR_CREATE_EVIDENCE_MISMATCH');
  return {s,finished};
 }
 const prior=await engine.tx(async(r,tx)=>{
  const journal=await tx.get(key);if(journal){journalChecked(journal);if(journal.phase==='complete')return {complete:journal.receipt};}
  const {s}=await currentChecked(r,tx,journal);
  if(s.leaseUntil>clock())return {busy:true};
  s.lease=token;s.leaseUntil=clock()+190000;await tx.setAlarm(s.leaseUntil+1000);return {acquired:true};
 });
 if(prior.complete)return {...completedReceipt(),replayed:true};
 if(prior.busy)return {complete:false,busy:true};
 let complete=false;
 const renew=()=>engine.tx(async(r,tx)=>{
  const journal=await tx.get(key),{s}=await currentChecked(r,tx,journal);
  if(s.lease!==token)refuse('OPERATOR_REJECTION_LEASE_CHANGED');s.leaseUntil=clock()+190000;await tx.setAlarm(s.leaseUntil+1000);
 });
 async function emptyInventory(){
  if(typeof d.provider?.list!=='function')refuse('OPERATOR_REJECTION_PROVIDER_INVALID');
  await renew();const inventory=await d.provider.list({beforePage:renew});await renew();
  if(!Array.isArray(inventory)||inventory.length!==0)refuse('OPERATOR_REJECTION_INVENTORY_NOT_EMPTY');
 }
 async function finalize(){
  return engine.tx(async(r,tx)=>{
   const journal=journalChecked(await tx.get(key)),{s,finished}=await currentChecked(r,tx,journal);
   if(s.lease!==token||!finished)refuse('OPERATOR_REJECTION_TERMINAL_MISMATCH');
   const receipt=completedReceipt();
   await tx.put(key,{...journal,phase:'complete',receipt,completedAt:clock()});
   s.acceptancePassed=false;s.operatorReconciliationId=packet.id;s.leaseUntil=0;delete s.lease;
   await tx.deleteAlarm();return receipt;
  });
 }
 try{
  const current=await engine.tx(async(r,tx)=>currentChecked(r,tx,await tx.get(key)));
  if(current.finished){const receipt=await finalize();complete=true;return receipt;}
  // Two fresh COMPLETE account inventories, including unrelated allocations.
  // No network I/O runs in a transaction and no observed resource is touched.
  await emptyInventory();await emptyInventory();
  const session=await engine.tx(async(r,tx)=>{
   const existing=await tx.get(key),{s,finished}=await currentChecked(r,tx,existing);
   if(s.lease!==token||finished)refuse('OPERATOR_REJECTION_LEASE_CHANGED');
   const journal=existing??{packet,phase:'finishing',quoteId:s.quoteId,baseline:ledgerView(r.ledger),ordinaryBefore:structuredClone(r.ordinaryLedger),inventoryVerifiedAt:clock()};
   // The evidence journal and flag are one atomic commit; neither alone may
   // be used to recreate the session or reinterpret its consumed approval.
   await tx.put(key,journal);s.definiteNoCreate=true;s.operatorRejectionId=packet.id;s.acceptancePassed=false;
   return structuredClone(s);
  });
  // Each existing guard independently performs its own fresh complete inventory
  // before erasing its saved key. A failed disarm retains the hold for retry.
  if(!Array.isArray(d.guards)||d.guards.length!==2||d.guards.some(g=>typeof g.disarm!=='function'))refuse('OPERATOR_REJECTION_GUARDS_UNAVAILABLE');
  // Reuse finish's independent disarm/accounting, but strengthen both of its
  // atomic updates for this exceptional path. A late observed ID, permit or
  // ledger change during guard I/O must refuse BEFORE the hold is released.
  // This private facade never changes the shared engine or its normal policy.
  const finisher=Object.create(engine);
  finisher.update=(id,fn)=>engine.tx(async(r,tx)=>{
   const {s,finished}=await currentChecked(r,tx,await tx.get(key));
   if(id!==packet.sessionId||s.lease!==token||finished)refuse('OPERATOR_REJECTION_LEASE_CHANGED');
   return fn(s,r);
  });
  await renew();await engine.finish.call(finisher,session,'failed','PROVIDER_CONFIRMED_NO_CREATE');
  const receipt=await finalize();complete=true;return receipt;
 }finally{
  if(!complete)await engine.tx(async(r,tx)=>{const s=r.session;if(s?.id!==packet.sessionId||s.lease!==token)return;s.leaseUntil=0;delete s.lease;await tx.setAlarm(clock()+10000);});
 }
}
