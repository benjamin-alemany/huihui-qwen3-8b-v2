import {boundedJSON} from '../policy.mjs';
import {INFERENCE_ORIGIN} from './policy.mjs';
const LEDGER='session-ledger-v1',PREFIX='hyperstack-runtime-handshake-v1:';
const READY='/__unjailed/host-ready',ALLOW='/__unjailed/allow-model';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const refuse=()=>{throw Error('HYPERSTACK_RUNTIME_HANDSHAKE_UNCONFIRMED');};
const plain=p=>p!==null&&typeof p==='object'&&!Array.isArray(p);
function gatewayStage(receipt,session,release,now,verifyReceipt){
 if(!plain(receipt)||!['validated','ready'].includes(receipt.status)||receipt.modelLoaded!==(receipt.status==='ready'))return null;
 const checked={...receipt,status:'ready'};delete checked.modelLoaded;
 return verifyReceipt(checked,{session,release,now})?receipt.status:null;
}
function firewallChecked(receipt,allocation,session){
 if(!plain(receipt)||Object.keys(receipt).sort().join()!=='allocationId,deadline,nonce,policy,provider,sealed'||receipt.provider!=='hyperstack'||receipt.sealed!==true||receipt.allocationId!==allocation.id||receipt.nonce!==session.nonce||receipt.deadline!==session.deadline||receipt.policy!=='tunnel-dns-egress-v1')refuse();
 return {provider:'hyperstack',sealed:true,allocationId:allocation.id,nonce:session.nonce,deadline:session.deadline,policy:'tunnel-dns-egress-v1'};
}
function acknowledgement(doc,permit){return plain(doc)&&Object.keys(doc).sort().join()==='deadlineUTC,nonce,sessionId,status,version'&&doc.version===1&&doc.status==='permitted'&&doc.sessionId===permit.sessionId&&doc.nonce===permit.nonce&&doc.deadlineUTC===permit.deadlineUTC;}
// Trusted controller-only bridge. The only host requests use a fixed origin and
// fixed routes; provider URLs, API keys, rules and release pins cannot come from
// the browser or model. sealFirewall must perform fresh bound-VM identity and
// exact provider allowlist readback. It is never delegated to the VM.
export function runtimeHandshake({storage,target,release,lifecycle,sealFirewall,sessionChecked:checkSession,verifyHostGatewayReceipt:verifyReceipt,fetchImpl=fetch,now=Date.now}={}){
 if(!storage||typeof storage.get!=='function'||typeof storage.transaction!=='function'||typeof sealFirewall!=='function'||typeof checkSession!=='function'||typeof verifyReceipt!=='function'||!lifecycle||typeof lifecycle.validate!=='function')refuse();
 async function current(allocation,q){
  const record=await storage.get(LEDGER),session=checkSession(record,q??record?.session?.reservation,{target,release,now:now()});
  lifecycle.validate(allocation,session.reservation,Infinity);
  const s=record.session,known=s.knownAllocations?.find(p=>p.id===allocation.id)??(s.pod?.id===allocation.id?s.pod:null);
  if(!known||!s.knownPodIds?.includes(allocation.id)||known.createdAt!==allocation.createdAt)refuse();
  lifecycle.validate(known,session.reservation,Infinity);return session;
 }
 const identity=(session,allocation)=>({version:1,sessionId:session.id,nonce:session.nonce,deadline:session.deadline,reservation:session.reservation,allocationId:allocation.id,allocationCreatedAt:allocation.createdAt,bootstrapLockSha256:release.artifact.bootstrapLockSha256,bootstrapBundleSha256:release.artifact.bootstrapBundleSha256,runtimeProfile:release.artifact.runtimeProfile});
 const sameSession=(a,b)=>a.id===b.id&&a.nonce===b.nonce&&a.deadline===b.deadline&&a.inferenceKey===b.inferenceKey&&a.modelKey===b.modelKey&&same(a.reservation,b.reservation);
 function markerChecked(marker,pins){
  if(!plain(marker)||!['permit-requested','permitted'].includes(marker.phase)||!same(marker.identity,pins))refuse();
  firewallChecked(marker.firewall,{id:pins.allocationId},{nonce:pins.nonce,deadline:pins.deadline});return marker;
 }
 async function remember(session,allocation,firewall,phase){
  const pins=identity(session,allocation),key=PREFIX+session.id;
  await storage.transaction(async tx=>{
   const live=checkSession(await tx.get(LEDGER),session.reservation,{target,release,now:now()});if(!sameSession(live,session))refuse();
   const prior=await tx.get(key);if(prior)markerChecked(prior,pins);
   await tx.put(key,{identity:pins,phase:prior?.phase==='permitted'?'permitted':phase,firewall,updatedAt:now()});
  });
 }
 async function readJSON(path,key,body){
  const response=await fetchImpl(INFERENCE_ORIGIN+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+key,Accept:'application/json','User-Agent':'unjailed-private-chat/1.0',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'manual',signal:AbortSignal.timeout(8000)});
  if(response.status!==200){await response.body?.cancel();refuse();}
  return boundedJSON(response.body,16384);
 }
 return async({allocation,origin,inferenceKey})=>{
  try{
   if(origin!==INFERENCE_ORIGIN)return false;
   const session=await current(allocation);if(inferenceKey!==session.inferenceKey)return false;
   const receipt=await readJSON(READY,session.inferenceKey),stage=gatewayStage(receipt,session,release,now(),verifyReceipt);if(!stage)return false;
   const afterProbe=await current(allocation,session.reservation);if(!sameSession(afterProbe,session))return false;
   const existing=await storage.get(PREFIX+session.id);
   // A ready model without our prior durable permit intent is a protocol
   // violation, not a reason to infer that its provider firewall was sealed.
   if(stage==='ready'&&!existing)return false;
   if(existing)markerChecked(existing,identity(session,allocation));
   const firewall=firewallChecked(await sealFirewall(structuredClone(allocation),structuredClone(session.reservation)),allocation,session);
   const afterSeal=await current(allocation,session.reservation);if(!sameSession(afterSeal,session))return false;
   if(stage==='ready'){
    await remember(session,allocation,firewall,'permitted');return true;
   }
   // The keyless receipt and exact permit intent commit before the only host
   // mutation. Lost acknowledgements permit only this idempotent identical
   // request; they never create another VM, reload a model or renew expiry.
   await remember(session,allocation,firewall,'permit-requested');
   const beforePermit=await current(allocation,session.reservation);if(!sameSession(beforePermit,session))return false;
   const permit={sessionId:session.id,nonce:session.nonce,deadlineUTC:new Date(session.deadline).toISOString()};
   const ack=await readJSON(ALLOW,session.inferenceKey,permit);if(!acknowledgement(ack,permit))return false;
   const afterPermit=await current(allocation,session.reservation);if(!sameSession(afterPermit,session))return false;
   await remember(session,allocation,firewall,'permitted');return false; // Actual model readiness is a later host receipt.
  }catch{return false;}
 };
}
