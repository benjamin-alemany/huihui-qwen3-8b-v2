import manifest from '../../../release/manifest.json' with {type:'json'};
import {releaseApprovedFor} from '../../../release/approval.mjs';
import {boundedJSON} from '../policy.mjs';
import {parseOperatorBudget} from '../controller/budget-reconcile.mjs';
import {SessionError,parseOriginalAcceptance} from '../controller/session-policy.mjs';
import {hyperstackClient} from './client.mjs';
import {hyperstackLifecycle} from './controller-policy.mjs';
import {runtimeHandshake} from './runtime-handshake.mjs';
import {collectHostDiagnostics} from './host-diagnostics.mjs';
import {INFERENCE_ORIGIN,creationTimestampIdentity,validateTarget,validateReservation} from './policy.mjs';

const LEDGER='session-ledger-v1',HOST_READY_PATH='/__unjailed/host-ready';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const inferenceKey=k=>typeof k==='string'&&/^[A-Za-z0-9_-]{43,128}$/.test(k);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const refused=code=>{throw new SessionError(code,503);};
const plain=p=>p!==null&&typeof p==='object'&&!Array.isArray(p);
function trustedTarget(encoded){
 try{if(typeof encoded!=='string'||encoded.length>4096)throw Error();return validateTarget(JSON.parse(encoded));}catch{refused('HYPERSTACK_TARGET_UNVERIFIED');}
}
function tunnelCredential(encoded){
 try{
  if(typeof encoded!=='string'||encoded.length>4096)throw Error();const c=JSON.parse(encoded);
  if(!plain(c)||Object.keys(c).sort().join()!=='AccountTag,TunnelID,TunnelSecret'||!UUID.test(c.TunnelID??'')||!/^[a-f0-9]{32}$/.test(c.AccountTag??'')||!/^[A-Za-z0-9+/]{43}=$/.test(c.TunnelSecret??'')||atob(c.TunnelSecret).length!==32||btoa(atob(c.TunnelSecret))!==c.TunnelSecret)throw Error();
  return Object.freeze({TunnelID:c.TunnelID,AccountTag:c.AccountTag,TunnelSecret:c.TunnelSecret});
 }catch{refused('HYPERSTACK_HOST_TUNNEL_UNCONFIGURED');}
}
export function sessionChecked(record,q,{target,release,now,bootstrap=false}){
 if(record?.cleanupIncidents!==undefined&&(!Array.isArray(record.cleanupIncidents)||record.cleanupIncidents.some(i=>i?.resolved!==true)))refused('HYPERSTACK_RESIDUAL_RESOURCE_REVIEW_REQUIRED');
 const s=record?.session;let reservation;
 try{reservation=validateReservation(q,target);}catch{refused('HYPERSTACK_SESSION_BINDING_INVALID');}
 let stored;try{stored=validateReservation(s?.reservation,target);}catch{refused('HYPERSTACK_SESSION_BINDING_INVALID');}
 if(!UUID.test(s?.id??'')||!same(reservation,stored)||reservation.image!==release?.artifact?.servingImage||s.nonce!==reservation.nonce||s.bootAt!==reservation.createdNotBefore||s.deadline!==reservation.deadline||s.quote?.minutes!==reservation.minutes||s.createAttempted!==true||s.stopRequested!==false||!inferenceKey(s.inferenceKey)||!inferenceKey(s.modelKey)||s.inferenceKey===s.modelKey||!Number.isSafeInteger(now)||now<reservation.createdNotBefore||now>=reservation.deadline||
  (bootstrap?s.phase!=='reconciling'||now>reservation.createdNotAfter:!['reconciling','validating','starting','ready'].includes(s.phase)))refused('HYPERSTACK_SESSION_BINDING_INVALID');
 return {id:s.id,nonce:s.nonce,phase:s.phase,createAttempted:true,stopRequested:false,inferenceKey:s.inferenceKey,modelKey:s.modelKey,reservation:structuredClone(stored),bootAt:s.bootAt,deadline:s.deadline,quote:{minutes:s.quote.minutes}};
}
// Only trusted source code may supply the renderer/bundle. It receives no env,
// provider key, ledger, owner allowance, acceptance token or billing controls.
export function boundBootstrapFor({storage,target,release,bundle,renderBootstrap,hostTunnelCredential,now=Date.now}){
 return async q=>{
  if(typeof renderBootstrap!=='function')refused('HYPERSTACK_BOOTSTRAP_UNAVAILABLE');
  const session=sessionChecked(await storage.get(LEDGER),q,{target,release,now:now(),bootstrap:true});
  const result=await renderBootstrap({reservation:structuredClone(session.reservation),session:structuredClone(session),release:structuredClone(release),bundle:structuredClone(bundle),hostTunnelCredential:structuredClone(hostTunnelCredential),now:now()});
  // Stop, expiry or a changed session during signing/rendering must prevent the
  // subsequent paid POST. Client.create also rechecks its immutable time window.
  const current=sessionChecked(await storage.get(LEDGER),q,{target,release,now:now(),bootstrap:true});
  if(!same(current,session))refused('HYPERSTACK_SESSION_CHANGED');
  return result;
 };
}
export function verifyHostGatewayReceipt(receipt,{session,release,now=Date.now()}={}){
 if(!plain(receipt)||!session||!Number.isSafeInteger(now)||now<session.bootAt||now>=session.deadline||!UUID.test(session.id??'')||!/^ghcr\.io\/benjamin-alemany\/huihui-qwen3-8b-v2@sha256:[a-f0-9]{64}$/.test(release?.artifact?.servingImage??'')||!['bootstrapLockSha256','bootstrapBundleSha256'].every(k=>/^[a-f0-9]{64}$/.test(release?.artifact?.[k]??''))||release?.model?.revision!=='7d89db76029281fd8f3e6698a8e30738608105a9'||release?.model?.servedName!=='huihui-qwen3-8b-v2')return false;
 const fields=['version','provider','status','sessionId','nonce','servingImage','bootstrapLockSha256','bootstrapBundleSha256','runtimeProfile','createdAt','deadlineUTC','sealed','nativeAttestation','privateNamespaces','modelEgressDenied','offlineCacheVerified','cudaReady','modelRevision','modelName','agentToolsEnabled'];
 const keys=Object.keys(receipt).filter(k=>k!=='vmId').sort();
 if(keys.join()!==fields.sort().join()||('vmId'in receipt&&receipt.vmId!==null))return false;
 return receipt.version===1&&receipt.provider==='hyperstack'&&receipt.status==='ready'&&receipt.sessionId===session.id&&receipt.nonce===session.nonce&&
  receipt.servingImage===release?.artifact?.servingImage&&receipt.bootstrapLockSha256===release?.artifact?.bootstrapLockSha256&&receipt.bootstrapBundleSha256===release?.artifact?.bootstrapBundleSha256&&receipt.runtimeProfile==='vm-inference-v1'&&receipt.runtimeProfile===release?.artifact?.runtimeProfile&&
  receipt.createdAt===new Date(session.bootAt).toISOString()&&receipt.deadlineUTC===new Date(session.deadline).toISOString()&&
  ['sealed','nativeAttestation','privateNamespaces','modelEgressDenied','offlineCacheVerified','cudaReady'].every(k=>receipt[k]===true)&&
  receipt.modelRevision===release?.model?.revision&&receipt.modelName===release?.model?.servedName&&receipt.agentToolsEnabled===false;
}
export function boundHealthVerifier({storage,target,release,lifecycle,fetchImpl=fetch,now=Date.now}){
 return async({allocation,origin,inferenceKey:key})=>{
  try{
   if(origin!==INFERENCE_ORIGIN)refused('HYPERSTACK_HEALTH_ORIGIN_INVALID');
   const before=await storage.get(LEDGER),s=before?.session;
   const session=sessionChecked(before,s?.reservation,{target,release,now:now()});
   lifecycle.validate(allocation,session.reservation,Infinity);
   const observed=s.knownAllocations?.find(p=>p.id===allocation.id)??(s.pod?.id===allocation.id?s.pod:null);
   if(!observed||!s.knownPodIds?.includes(allocation.id)||key!==session.inferenceKey||creationTimestampIdentity(observed.createdAt,session.reservation)!==creationTimestampIdentity(allocation.createdAt,session.reservation))refused('HYPERSTACK_HEALTH_BINDING_INVALID');
   lifecycle.validate(observed,session.reservation,Infinity);
   const response=await fetchImpl(INFERENCE_ORIGIN+HOST_READY_PATH,{headers:{Authorization:'Bearer '+key,Accept:'application/json','User-Agent':'unjailed-private-chat/1.0'},redirect:'manual',signal:AbortSignal.timeout(8000)});
   if(response.status!==200){await response.body?.cancel();return false;}
   const receipt=await boundedJSON(response.body,16384);
   if(!verifyHostGatewayReceipt(receipt,{session,release,now:now()}))return false;
   const after=sessionChecked(await storage.get(LEDGER),session.reservation,{target,release,now:now()});
   // Phase may advance while a health request is in flight; identity, keys and
   // the original expiry cannot change or be renewed by the response.
   return after.id===session.id&&after.nonce===session.nonce&&after.inferenceKey===session.inferenceKey&&after.modelKey===session.modelKey&&after.deadline===session.deadline;
  }catch{return false;}
 };
}
function unavailableLifecycle(code){
 const deny=()=>refused(code);
 return Object.freeze({provider:'hyperstack',binding:'hyperstack-unavailable-v1',catalogFrom:deny,quoteMinutes:deny,makeQuote:deny,reservation:deny,matches:deny,validate:deny,createBody:deny,context:deny,cleanupComplete:()=>false,priceAccept:()=>false,isRunning:()=>false,isFailed:()=>true,receiptFresh:deny});
}
// Construction is side-effect free. Source pins, trusted budget reconciliation,
// a reviewed bundle, and the complete host runtime orchestrator are independent
// gates. Environment flags alone cannot approve this release or fake readiness.
export function hyperstackControllerFactory({env,storage,release=manifest,bundle=null,renderBootstrap=null,bootstrapReady=()=>false,runtimeOrchestratorReady=()=>false,fetchImpl=fetch,now=Date.now}={}){
 const blockers=[];let target,lifecycle,operatorBudget,hostTunnelCredential,originalAcceptance=null;
 try{target=trustedTarget(env?.HYPERSTACK_TARGET_JSON);}catch{blockers.push('HYPERSTACK_TARGET_UNVERIFIED');}
 const key=env?.HYPERSTACK_API_KEY,keyConfigured=typeof key==='string'&&key.length>=16&&key.length<=512&&/^[!-~]+$/.test(key);
 if(!keyConfigured)blockers.push('HYPERSTACK_KEY_UNCONFIGURED');
 const guardAccountConfigured=typeof env?.CLOUDFLARE_ACCOUNT_ID==='string'&&/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID)&&env.CLOUDFLARE_ACCOUNT_ID!=='0'.repeat(32);
 const guardTailTokenConfigured=typeof env?.CF_TAIL_TOKEN==='string'&&/^[A-Za-z0-9_-]{40,256}$/.test(env.CF_TAIL_TOKEN);
 if(!guardAccountConfigured)blockers.push('HYPERSTACK_GUARD_ACCOUNT_UNCONFIGURED');
 if(!guardTailTokenConfigured)blockers.push('HYPERSTACK_GUARD_TAIL_TOKEN_UNCONFIGURED');
 try{lifecycle=hyperstackLifecycle({target,release});}catch{blockers.push('HYPERSTACK_RELEASE_UNPINNED');}
 try{operatorBudget=parseOperatorBudget(env?.OPERATOR_BUDGET_RECONCILIATION);if(operatorBudget===null)throw Error();}catch{operatorBudget={invalid:true};blockers.push('HYPERSTACK_BUDGET_UNRECONCILED');}
 try{originalAcceptance=parseOriginalAcceptance(env?.ORIGINAL_ACCEPTANCE_JSON);if(originalAcceptance===null)throw Error();}catch{originalAcceptance=null;blockers.push('HYPERSTACK_ORIGINAL_ACCEPTANCE_UNCONFIGURED');}
 try{hostTunnelCredential=tunnelCredential(env?.HYPERSTACK_HOST_TUNNEL_CREDENTIAL_JSON);}catch{blockers.push('HYPERSTACK_HOST_TUNNEL_UNCONFIGURED');}
 let bootstrapPrepared=false,runtimePrepared=false;
 try{bootstrapPrepared=typeof renderBootstrap==='function'&&bootstrapReady(release,bundle)===true;}catch{}
 try{runtimePrepared=runtimeOrchestratorReady(release,bundle)===true;}catch{}
 if(!bootstrapPrepared)blockers.push('HYPERSTACK_BOOTSTRAP_UNAVAILABLE');
 if(!runtimePrepared)blockers.push('HYPERSTACK_RUNTIME_ORCHESTRATOR_UNAVAILABLE');
 const validationMode=env?.VALIDATION_MODE==='true',sourceApproved=releaseApprovedFor(validationMode?'acceptance':'production',release);
 if(!sourceApproved)blockers.push(validationMode?'HYPERSTACK_ACCEPTANCE_RELEASE_UNAPPROVED':'HYPERSTACK_PRODUCTION_RELEASE_UNAPPROVED');
 if(validationMode&&(typeof env?.APPROVED_ACCEPTANCE_ID!=='string'||!env.APPROVED_ACCEPTANCE_ID.length))blockers.push('HYPERSTACK_ACCEPTANCE_AUTHORIZATION_MISSING');
 const configReady=!!(target&&lifecycle&&keyConfigured),lockedCode=blockers[0]??'HYPERSTACK_LAUNCH_LOCKED';
 const deny=async()=>refused(lockedCode);
 let provider=Object.freeze({catalog:deny,list:deny,get:deny,create:deny,cleanup:deny,health:async()=>false});
 if(configReady){provider=hyperstackClient(key,{target,now,fetchImpl,
  bootstrapFor:boundBootstrapFor({storage,target,release,bundle,renderBootstrap:env?.START_ENABLED==='true'&&blockers.length===0?renderBootstrap:null,hostTunnelCredential,now}),
  verifyHealth:runtimePrepared&&sourceApproved?runtimeHandshake({storage,target,release,lifecycle,sessionChecked,verifyHostGatewayReceipt,sealFirewall:(allocation,reservation)=>provider.sealFirewall(allocation,reservation),fetchImpl,now}):async()=>false});
  provider.diagnostics=(allocation,reservation,sessionId)=>collectHostDiagnostics({key,allocation,reservation,sessionId,providerGet:id=>provider.get(id),fetchImpl,now});
 }
 return Object.freeze({provider,lifecycle:lifecycle??unavailableLifecycle(lockedCode),operatorBudget,originalAcceptance,validationMode,connected:configReady,key:keyConfigured?key:undefined,
  enabled:env?.START_ENABLED==='true'&&blockers.length===0,
  catalog:configReady?()=>provider.catalog():deny,
  readiness:Object.freeze({provider:'hyperstack',credentialsConfigured:keyConfigured,guardAccountConfigured,guardTailTokenConfigured,targetConfigured:!!target,releasePinned:!!lifecycle,budgetConfigured:!operatorBudget.invalid,originalAcceptanceConfigured:originalAcceptance!==null,bootstrapPrepared,runtimeOrchestratorPrepared:runtimePrepared,sourceApproved,blockers:Object.freeze(blockers)})});
}
