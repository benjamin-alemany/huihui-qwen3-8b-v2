import {validateReservation,matchesReservation,assertBound,absenceReceipt,fail} from './policy.mjs';

// Standalone durable core: its provider capability has only list/get/remove.
// Authentication, secret storage, scheduled receipt/version checks, and calling
// this core from an independent scheduled Worker are deployment responsibilities.
// Store must supply get/put AND transaction; no in-memory fallback is accepted.
const KEY='hyperstack-destroy-reservation';
function requireStore(store){if(!store||typeof store.get!=='function'||typeof store.put!=='function'||typeof store.transaction!=='function')fail('HYPERSTACK_GUARD_STORAGE_REQUIRED');}
function requireProvider(provider){if(!provider||typeof provider.list!=='function'||typeof provider.get!=='function'||typeof provider.remove!=='function'||'create' in provider||'catalog' in provider)fail('HYPERSTACK_GUARD_CAPABILITY_INVALID');}
function initial(reservation,role){const r=validateReservation(reservation);if(!['primary','backup'].includes(role))fail('HYPERSTACK_GUARD_ROLE_INVALID');return {version:1,reservation:r,role,expiry:r.deadline+(role==='backup'?60_000:0),bindings:[],unexpectedVolumeIds:[],stopRequested:false,vmCleanupVerified:false,cleanupAttention:false,requiresOperatorReconciliation:true,lastCheckedAt:null,lastCode:'ARMED'};}
export async function armDestroyGuard(store,reservation,{role='primary'}={}){
  requireStore(store);const prepared=initial(reservation,role);
  return store.transaction(async tx=>{
    const current=await tx.get(KEY);
    if(current){if(JSON.stringify(current.reservation)!==JSON.stringify(prepared.reservation)||current.role!==role||current.expiry!==prepared.expiry)fail('HYPERSTACK_GUARD_RESERVATION_LOCKED');return structuredClone(current);}
    await tx.put(KEY,prepared);return structuredClone(prepared);
  });
}
export async function requestDestroy(store,nonce){
  requireStore(store);await store.transaction(async tx=>{const s=await tx.get(KEY);if(!s||s.reservation.nonce!==nonce)fail('HYPERSTACK_GUARD_RESERVATION_MISMATCH');s.stopRequested=true;await tx.put(KEY,s);});
}
async function update(store,nonce,mutate){return store.transaction(async tx=>{const s=await tx.get(KEY);if(!s||s.reservation.nonce!==nonce)fail('HYPERSTACK_GUARD_RESERVATION_MISMATCH');mutate(s);await tx.put(KEY,s);return structuredClone(s);});}
export async function runDestroyGuard({store,provider,now=Date.now}={}){
  requireStore(store);requireProvider(provider);
  let s=await store.get(KEY);if(!s)return {armed:false,code:'NOT_ARMED'};
  const r=validateReservation(s.reservation),time=now();
  if(s.version!==1||!['primary','backup'].includes(s.role)||s.expiry!==r.deadline+(s.role==='backup'?60_000:0)||!Array.isArray(s.bindings)||!Array.isArray(s.unexpectedVolumeIds))fail('HYPERSTACK_GUARD_STATE_INVALID');
  if(!Number.isSafeInteger(time))fail('HYPERSTACK_GUARD_CLOCK_INVALID');
  const report=(code,extra={})=>({armed:true,nonce:r.nonce,role:s.role,expiry:s.expiry,code,vmCleanupVerified:false,requiresOperatorReconciliation:true,...absenceReceipt(),...extra});
  try{
    let allAbsent=true,knownReadFailed=false;const attemptedIds=new Set();
    async function destroyKnown(bound){
      if(attemptedIds.has(bound.id))return;attemptedIds.add(bound.id);
      try{
        const p=await provider.get(bound.id);
        if(p){
          assertBound(p,bound,r);
          if(p.volumeIds?.length)s=await update(store,r.nonce,x=>{x.unexpectedVolumeIds=[...new Set([...x.unexpectedVolumeIds,...p.volumeIds])];x.cleanupAttention=true;});
          // Shutoff/hibernate retain billable resources. This core only deletes.
          try{await provider.remove(bound.id);}catch{/* Fresh GET must prove absence. */}
        }
        if(await provider.get(bound.id)!==null)allAbsent=false;
      }catch{allAbsent=false;knownReadFailed=true;}
    }
    // Previously bound IDs already have durable ownership evidence. An unrelated
    // inventory failure must not prevent their deadline/Stop teardown.
    if(s.stopRequested||time>=s.expiry)for(const bound of s.bindings)await destroyKnown(bound);
    // Complete inventory is still mandatory for discovering duplicates and for
    // any cleanup-success receipt. Never infer absence from a failed list.
    const inventory=await provider.list();if(!Array.isArray(inventory))fail('HYPERSTACK_GUARD_INVENTORY_INVALID');
    s=await update(store,r.nonce,current=>{
      for(const p of inventory.filter(p=>matchesReservation(p,r))){
        const known=current.bindings.find(x=>x.id===p.id);
        if(known)assertBound(p,known,r);else current.bindings.push(structuredClone(p));
        if(p.volumeIds?.length){current.unexpectedVolumeIds=[...new Set([...current.unexpectedVolumeIds,...p.volumeIds])];current.cleanupAttention=true;}
      }
      if(current.bindings.length>8)fail('HYPERSTACK_GUARD_BINDING_LIMIT');
    });
    const afterInventory=now();if(!Number.isSafeInteger(afterInventory))fail('HYPERSTACK_GUARD_CLOCK_INVALID');
    if(!s.stopRequested&&afterInventory<s.expiry){await update(store,r.nonce,x=>{x.lastCheckedAt=time;x.lastCode='ARMED';});return report('ARMED');}
    // Include newly discovered allocations, but issue at most one DELETE per ID
    // in this tick. A failed read of one owned ID cannot skip the other IDs.
    for(const bound of s.bindings)await destroyKnown(bound);
    // A late create or duplicate must be bound durably before another tick can
    // delete it. Its discovery makes this tick unconfirmed, never a false win.
    const after=await provider.list();if(!Array.isArray(after))fail('HYPERSTACK_GUARD_INVENTORY_INVALID');
    let inventoryAbsent=true;
    s=await update(store,r.nonce,current=>{
      for(const p of after){
        const known=current.bindings.find(x=>x.id===p.id);
        if(known){assertBound(p,known,r);inventoryAbsent=false;}
        else if(matchesReservation(p,r)){current.bindings.push(structuredClone(p));if(p.volumeIds?.length){current.unexpectedVolumeIds=[...new Set([...current.unexpectedVolumeIds,...p.volumeIds])];current.cleanupAttention=true;}inventoryAbsent=false;}
      }
      if(current.bindings.length>8)fail('HYPERSTACK_GUARD_BINDING_LIMIT');
    });
    // A final GET also detects a stale list response for already bound IDs.
    for(const bound of s.bindings)if(await provider.get(bound.id)!==null)allAbsent=false;
    const vmCleanupVerified=s.bindings.length>0&&allAbsent&&inventoryAbsent&&!knownReadFailed;
    const cleanupAttention=s.unexpectedVolumeIds.length>0;
    const code=knownReadFailed?'CLEANUP_UNCONFIRMED':cleanupAttention?'UNEXPECTED_VOLUME_REVIEW':vmCleanupVerified?'VM_ABSENCE_VERIFIED':s.bindings.length?'DELETE_UNCONFIRMED':'CREATE_OUTCOME_UNCONFIRMED';
    s=await update(store,r.nonce,x=>{x.vmCleanupVerified=vmCleanupVerified;x.cleanupAttention=cleanupAttention;x.requiresOperatorReconciliation=true;x.lastCheckedAt=time;x.lastCode=code;});
    // Reservations, IDs and cron protection remain armed after VM absence.
    // No autonomous budget release or independent IP/billing-settlement claim.
    return report(code,{vmAbsent:vmCleanupVerified,inventoryAbsent,complete:vmCleanupVerified&&!cleanupAttention,vmCleanupVerified,unexpectedVolumeIds:[...s.unexpectedVolumeIds]});
  }catch{
    await update(store,r.nonce,x=>{x.lastCheckedAt=time;x.lastCode='CLEANUP_UNCONFIRMED';x.vmCleanupVerified=false;});
    return report('CLEANUP_UNCONFIRMED');
  }
}
