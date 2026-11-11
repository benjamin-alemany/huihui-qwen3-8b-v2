import {armDestroyGuard,requestDestroy,runDestroyGuard} from './destroy-guard.mjs';
import {validateReservation,validateTarget,absenceReceipt,fail} from './policy.mjs';
const CORE='hyperstack-destroy-reservation',META='hyperstack-guard-runtime-v1',SECRET='hyperstack-guard-key-v1',ARCHIVE='hyperstack-guard-last-archive-v1';
const LEASE_MS=45_000;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const narrow=p=>{if(!p||typeof p.list!=='function'||typeof p.get!=='function'||typeof p.remove!=='function'||'create'in p||'catalog'in p)fail('HYPERSTACK_GUARD_CAPABILITY_INVALID');return p;};
// Construct only from the trusted Worker environment. No public HTTP handler or
// caller-selected API destination, target, bootstrap, or provider client exists.
export function hyperstackGuardRuntime(storage,{target,role,providerFactory,now=Date.now}={}){
 const trustedTarget=validateTarget(target);
 if(!['primary','backup'].includes(role)||typeof providerFactory!=='function')fail('HYPERSTACK_GUARD_RUNTIME_INVALID');
 for(const method of ['get','put','delete','transaction','setAlarm','deleteAlarm'])if(typeof storage?.[method]!=='function')fail('HYPERSTACK_GUARD_STORAGE_REQUIRED');
 const clock=()=>{const n=now();if(!Number.isSafeInteger(n)||n<0)fail('HYPERSTACK_GUARD_CLOCK_INVALID');return n;};
 const query=q=>{const r=validateReservation(q,trustedTarget);if(r.kind!=='chat'||r.provider!=='hyperstack'||![15,30,60].includes(r.minutes)||typeof r.image!=='string')fail('HYPERSTACK_GUARD_ENVELOPE_INVALID');return r;};
 async function assertMeta(tx,token){const m=await tx.get(META);if(!m||m.version!==1||m.token!==token||m.role!==role||!same(query(m.reservation),m.reservation))fail('HYPERSTACK_GUARD_LEASE_CHANGED');return m;}
 const leasedStore=token=>({
  get:async key=>{await assertMeta(storage,token);return storage.get(key);},
  put:async(key,value)=>storage.transaction(async tx=>{await assertMeta(tx,token);await tx.put(key,value);}),
  transaction:fn=>storage.transaction(async tx=>{await assertMeta(tx,token);return fn(tx);})
 });
 async function operation(name){return storage.transaction(async tx=>{
  const m=await tx.get(META);if(!m)return null;
  const q=query(m.reservation);if(m.version!==1||m.role!==role||(name!==undefined&&q.name!==name))fail('HYPERSTACK_GUARD_RESERVATION_MISMATCH');
  const time=clock();if(m.leaseUntil>time)return {busy:true};
  m.token=crypto.randomUUID();m.leaseUntil=time+LEASE_MS;await tx.put(META,m);await tx.setAlarm(m.leaseUntil+100);return m;
 });}
 async function release(token,delay=10_000){await storage.transaction(async tx=>{
  const m=await tx.get(META);if(!m||m.token!==token)return;m.leaseUntil=0;delete m.token;await tx.put(META,m);await tx.setAlarm(clock()+delay);
 });}
 async function providerFor(m){
  const key=await storage.get(SECRET);if(typeof key!=='string'||key.length<16)fail('HYPERSTACK_GUARD_KEY_MISSING');const p=narrow(await providerFactory(key,trustedTarget));
  const renew=()=>storage.transaction(async tx=>{const live=await assertMeta(tx,m.token);live.leaseUntil=clock()+LEASE_MS;await tx.put(META,live);await tx.setAlarm(live.leaseUntil+100);});
  async function checked(method,...args){
   // Renew before each bounded provider call. A lost Worker is recoverable on
   // its alarm in less than one cron interval; stale operations cannot commit.
   await renew();
   const value=await p[method](...args);await assertMeta(storage,m.token);return value;
  }
  // Each list page has the client's 25s transport deadline, below the 45s
  // lease. Pagination cannot repeatedly lose discovery after the first page;
  // only this token may renew, and no partial list is ever returned as absence.
  return {list:()=>checked('list',{beforePage:renew}),get:id=>checked('get',id),remove:id=>checked('remove',id)};
 }
 async function coreFor(m){const core=await storage.get(CORE);const q=query(m.reservation);if(!core||!same(validateReservation(core.reservation,trustedTarget),q)||core.role!==role||core.expiry!==q.deadline+(role==='backup'?60_000:0))fail('HYPERSTACK_GUARD_STATE_INVALID');return core;}
 async function report(){
  const m=await storage.get(META);
  if(!m){if(await storage.get(CORE)!==undefined||await storage.get(SECRET)!==undefined)fail('HYPERSTACK_GUARD_ORPHANED_STATE');const archived=await storage.get(ARCHIVE);return archived?{...archived,armed:false}:{armed:false,provider:'hyperstack',role,name:null,image:null,nonce:null,deleted:[],bindings:[],status:'NOT_ARMED'};}
  const q=query(m.reservation),core=await coreFor(m),verified=core.vmCleanupVerified===true;
  return {...absenceReceipt(),armed:true,provider:'hyperstack',role,name:q.name,reservationName:q.name,image:q.image,minutes:q.minutes,nonce:q.nonce,deadline:q.deadline,expiry:core.expiry,stopRequested:core.stopRequested===true,bindings:structuredClone(core.bindings),deleted:verified?structuredClone(core.bindings):[],vmAbsent:verified,inventoryAbsent:verified,vmCleanupVerified:verified,complete:verified&&!core.unexpectedVolumeIds.length,unexpectedVolumeIds:[...core.unexpectedVolumeIds],status:core.lastCode,requiresOperatorReconciliation:true};
 }
 async function arm(q,key){
  const reservation=query(q);if(typeof key!=='string'||key.length<16||/[\r\n]/.test(key))fail('HYPERSTACK_GUARD_KEY_INVALID');
  const token=crypto.randomUUID(),time=clock(),digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key)),keyFingerprint=Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('');
  await storage.transaction(async tx=>{
   if(await tx.get('active'))fail('HYPERSTACK_GUARD_OTHER_PROVIDER_ACTIVE');
   const prior=await tx.get(META),oldKey=await tx.get(SECRET);
   if(prior){if(prior.role!==role||!same(prior.reservation,reservation)||prior.keyFingerprint!==keyFingerprint||typeof oldKey!=='string')fail('HYPERSTACK_GUARD_RESERVATION_LOCKED');if(prior.leaseUntil>time)fail('HYPERSTACK_GUARD_BUSY');}
   else if(await tx.get(CORE)||oldKey!==undefined)fail('HYPERSTACK_GUARD_ORPHANED_STATE');
   if(await tx.get(ARCHIVE+':'+reservation.nonce))fail('HYPERSTACK_GUARD_ALREADY_ARCHIVED');
   await tx.put(META,{version:1,reservation,role,phase:'arming',keyFingerprint,token,leaseUntil:time+LEASE_MS});await tx.put(SECRET,key);await tx.setAlarm(time+LEASE_MS+100);
  });
  try{await armDestroyGuard(leasedStore(token),reservation,{role});await storage.transaction(async tx=>{const m=await assertMeta(tx,token);m.phase='active';await tx.put(META,m);});}finally{await release(token,100);}
  return report();
 }
 async function shorten(name,at){
  const time=clock();if(!Number.isSafeInteger(at)||at<0||at>time+1000)fail('HYPERSTACK_GUARD_EARLY_STOP_INVALID');
  const m=await operation(name);if(!m)fail('HYPERSTACK_GUARD_RESERVATION_MISMATCH');if(m.busy)fail('HYPERSTACK_GUARD_BUSY');
  try{await coreFor(m);await requestDestroy(leasedStore(m.token),m.reservation.nonce);}finally{await release(m.token,100);}
  return {shortened:true};
 }
 async function tick(){
  const m=await operation();if(!m)return {...await report(),status:'unarmed'};if(m.busy)return {...await report(),status:'busy'};
  try{
   // Repair a crash after atomic metadata/key storage but before core arming.
   if(!await storage.get(CORE)){if(m.phase!=='arming')fail('HYPERSTACK_GUARD_STATE_INVALID');await armDestroyGuard(leasedStore(m.token),m.reservation,{role});}
   if(m.phase==='arming')await storage.transaction(async tx=>{const live=await assertMeta(tx,m.token);live.phase='active';await tx.put(META,live);});
   await coreFor(m);const p=await providerFor(m);
   await runDestroyGuard({store:leasedStore(m.token),provider:p,now:clock});return report();
  }finally{await release(m.token);}
 }
 async function disarm(name,proof={}){
  if(!proof||Array.isArray(proof)||Object.keys(proof).some(k=>k!=='definiteNoCreate')||proof.definiteNoCreate!==undefined&&typeof proof.definiteNoCreate!=='boolean')fail('HYPERSTACK_GUARD_DISARM_PROOF_INVALID');
  const m=await operation(name);if(!m)return {unarmed:true};if(m.busy)fail('HYPERSTACK_GUARD_BUSY');
  try{
   let core=await coreFor(m);const p=await providerFor(m);
   if(!core.bindings.length){
    if(proof.definiteNoCreate!==true)fail('HYPERSTACK_GUARD_CREATE_OUTCOME_UNCONFIRMED');
    const discovery=await runDestroyGuard({store:leasedStore(m.token),provider:p,now:clock});core=await coreFor(m);
    // A successful core pass already fetched complete fresh inventory and
    // durably bound any matching allocation before returning. Never erase a
    // contradictory discovery or infer absence from an earlier receipt.
    if(core.bindings.length||!['ARMED','CREATE_OUTCOME_UNCONFIRMED'].includes(discovery.code))fail('HYPERSTACK_GUARD_NO_CREATE_CONTRADICTED');
   }else{
    await requestDestroy(leasedStore(m.token),m.reservation.nonce);
    const result=await runDestroyGuard({store:leasedStore(m.token),provider:p,now:clock});
    if(!result.complete||!result.vmCleanupVerified)fail('HYPERSTACK_GUARD_ABSENCE_UNCONFIRMED');
   }
   core=await coreFor(m);
   const archive={...await report(),armed:false,status:core.bindings.length?'VM_ABSENCE_ARCHIVED':'DEFINITE_NO_CREATE_ARCHIVED',archivedAt:clock()};
   await storage.transaction(async tx=>{
    await assertMeta(tx,m.token);const live=await tx.get(CORE);
    if(!same(live,core))fail('HYPERSTACK_GUARD_OBSERVATIONS_CHANGED');
    await tx.put(ARCHIVE,archive);await tx.put(ARCHIVE+':'+m.reservation.nonce,archive);await tx.delete(CORE);await tx.delete(SECRET);await tx.delete(META);await tx.deleteAlarm();
   });
   return {unarmed:true,...archive};
  }finally{await release(m.token);}
 }
 return Object.freeze({arm,shorten,report,disarm,tick});
}
