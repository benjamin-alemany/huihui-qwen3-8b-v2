import canonicalRelease from '../../../release/manifest.json' with {type:'json'};
import {SCALE,units,dollars,SessionError} from '../controller/session-policy.mjs';
import {PROVIDER,INFERENCE_ORIGIN,validateTarget,validateReservation,matchesReservation} from './policy.mjs';

const durations=Object.freeze([...canonicalRelease.sessions.allowedMinutes]);
const imagePattern=/^ghcr\.io\/benjamin-alemany\/huihui-qwen3-8b-v2@sha256:[a-f0-9]{64}$/;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const reject=(code,status=409)=>{throw new SessionError(code,status);};
const finite=n=>typeof n==='number'&&Number.isFinite(n);

// Explicit dependency injection only: importing this module never selects a
// provider, connects an account, unlocks Start, or changes a stored ledger.
export function hyperstackLifecycle({target,release}={}){
  let t;try{t=validateTarget(target);}catch{reject('HYPERSTACK_TARGET_UNVERIFIED',503);}
  // A fully pinned candidate may be used for a separately approved acceptance
  // test. It is not equivalent to a verified production release or authorization
  // to run one. Root deployment/acceptance gates remain independent.
  if(!release||release.schemaVersion!==1||!['candidate','verified'].includes(release.status)||
    !imagePattern.test(release.artifact?.servingImage??'')||!/^[a-f0-9]{64}$/.test(release.artifact?.bootstrapLockSha256??'')||!/^[a-f0-9]{64}$/.test(release.artifact?.bootstrapBundleSha256??'')||!/^[a-f0-9]{40}$/.test(release.artifact?.bootstrapSourceCommit??'')||!Number.isSafeInteger(release.artifact?.bootstrapBundleSize)||release.artifact.bootstrapBundleSize<=0||release.artifact.bootstrapBundleSize>256*1024||
    release.artifact?.runtimeProfile!=='vm-inference-v1'||![undefined,null,'vm-run-v1'].includes(release.artifact?.runtimeOrchestrator)||release.hosting?.provider!==PROVIDER||
    release.hosting?.vmImageId!==t.imageId||release.hosting?.vmImageName!==t.imageName||
    release.hosting?.flavor!==t.flavorName||release.hosting?.region!==t.region||release.hosting?.driverBranch!==580||
    release.inference?.origin!==INFERENCE_ORIGIN||release.inference?.completionPath!=='/v1/chat/completions'||release.inference?.healthPath!=='/health'||
    release.model?.repository!=='huihui-ai/Huihui-Qwen3-8B-abliterated-v2'||release.model?.revision!=='7d89db76029281fd8f3e6698a8e30738608105a9'||release.model?.servedName!=='huihui-qwen3-8b-v2'||
    release.sessions?.allowedMinutes?.join()!==durations.join()||release.sessions?.defaultMinutes!==30||release.sessions?.backupDelayMinutes!==1||release.sessions?.cleanupMarginMinutes!==5||release.sessions?.maximumStartupMinutes!==15)reject('HYPERSTACK_RELEASE_UNPINNED',503);
  const image=release.artifact.servingImage;
  // Durable consent binding, independent of mutable constructor inputs. The
  // engine stores it privately on the quote and checks Start and pre-create;
  // it is not a replacement for source approval or runtime verification.
  const binding=JSON.stringify({provider:PROVIDER,image,target:t,bootstrapLockSha256:release.artifact.bootstrapLockSha256,bootstrapBundleSha256:release.artifact.bootstrapBundleSha256,bootstrapSourceCommit:release.artifact.bootstrapSourceCommit,bootstrapBundleSize:release.artifact.bootstrapBundleSize,modelRevision:release.model.revision,runtimeProfile:release.artifact.runtimeProfile,runtimeOrchestrator:release.artifact.runtimeOrchestrator??null});
  const reservationChecked=q=>{
    try{validateReservation(q,t);}catch{reject('HYPERSTACK_RESERVATION_INVALID',503);}
    if(q?.provider!==PROVIDER||q.kind!=='chat'||q.image!==image||!durations.includes(q.minutes)||q.windowStart!==new Date(q.createdNotBefore).toISOString()||q.windowEnd!==new Date(q.createdNotAfter).toISOString()||q.deadline!==q.createdNotBefore+q.minutes*60_000)reject('HYPERSTACK_RESERVATION_INVALID',503);
    return q;
  };
  function validate(p,q,maxGpuHourly){
    reservationChecked(q);
    if(!matchesReservation(p,q)||typeof p.id!=='string'||!/^[1-9][0-9]{0,14}$/.test(p.id)||!Array.isArray(p.volumeIds)||p.volumeIds.length||
      !(maxGpuHourly===Infinity||finite(maxGpuHourly)&&maxGpuHourly>0&&maxGpuHourly<=t.maximumHourlyUSD))reject('HYPERSTACK_VM_IDENTITY_MISMATCH',503);
    return p;
  }
  const quoteCatalog=c=>{
    if(c?.provider!==PROVIDER||c.gpu!=='RTX-A6000'||!finite(c.gpuHourly)||c.gpuHourly<=0||!finite(c.totalHourly)||c.totalHourly<c.gpuHourly||c.totalHourly>t.maximumHourlyUSD||!['AVAILABLE','NONE'].includes(c.availability))reject('HYPERSTACK_CATALOG_INVALID',503);
    return c;
  };
  return Object.freeze({
    provider:PROVIDER,image,target:t,binding,
    catalogFrom(raw){
      if(raw?.provider!==PROVIDER||raw.catalogVerified!==true||raw.gpu!=='RTX-A6000'||raw.gpuCount!==1||raw.vramGB!==48||raw.cpu!==28||raw.ramGB!==58||raw.rootDiskGB!==100||JSON.stringify(raw.target)!==JSON.stringify(t)||!finite(raw.publicIpHourlyUSD)||raw.publicIpHourlyUSD<0||raw.totalHourlyUSD!==raw.gpuHourlyUSD+raw.publicIpHourlyUSD)reject('HYPERSTACK_CATALOG_INVALID',503);
      return quoteCatalog({provider:PROVIDER,gpu:'RTX-A6000',gpuHourly:raw.gpuHourlyUSD,totalHourly:raw.totalHourlyUSD,availability:raw.availability});
    },
    quoteMinutes(input,validationMode=false){
      if(input===undefined)input={};
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>k!=='minutes')||('minutes'in input&&!durations.includes(input.minutes))||validationMode&&'minutes'in input&&input.minutes!==30)reject('INVALID_DURATION',400);
      return validationMode?30:(input.minutes??30);
    },
    makeQuote(catalog,now,id,minutes=30){
      const c=quoteCatalog(catalog);if(!durations.includes(minutes)||!Number.isSafeInteger(now)||typeof id!=='string'||!id.length)reject('HYPERSTACK_QUOTE_INVALID',400);
      // SCALE comes from the common durable ledger; Hyperstack never seeds,
      // resets or changes the existing acceptance/ordinary budget here.
      const holdUnits=units(c.totalHourly*(minutes+5)/60);if(!Number.isSafeInteger(holdUnits)||holdUnits<=0||holdUnits/SCALE>10)reject('HYPERSTACK_QUOTE_INVALID',400);
      return {id,provider:PROVIDER,minutes,gpu:'RTX-A6000',gpuHourlyUSD:c.gpuHourly,totalHourlyUSD:c.totalHourly,maximumUSD:dollars(holdUnits),holdUnits,availability:c.availability,quotedAt:now,expiresAt:now+60_000,
        includes:'RTX A6000 VM, 100 GB temporary root disk, public IPv4, cold start and 5-minute stop/cleanup margin',
        excludes:'Tax/FX if applicable; existing domain; credit deposits are separate from usage; provider failures can exceed the operational allowance'};
    },
    reservation(now,nonce,minutes=30){
      if(!Number.isSafeInteger(now)||!durations.includes(minutes))reject('INVALID_DURATION',400);
      const q={kind:'chat',provider:PROVIDER,minutes,name:`unjailed-chat-${nonce}`,image,nonce,target:structuredClone(t),createdNotBefore:now,createdNotAfter:now+5*60_000,deadline:now+minutes*60_000,windowStart:new Date(now).toISOString(),windowEnd:new Date(now+5*60_000).toISOString()};
      return reservationChecked(q);
    },
    matches(p,q){reservationChecked(q);return matchesReservation(p,q);},validate,
    createBody(s,now){
      const q=reservationChecked(s?.reservation);
      if(s.nonce!==q.nonce||s.bootAt!==q.createdNotBefore||s.deadline!==q.deadline||s.quote?.minutes!==q.minutes||!Number.isSafeInteger(now)||now<q.createdNotBefore||now>q.createdNotAfter||now>=q.deadline)reject('HYPERSTACK_CREATE_BINDING_INVALID',503);
      // No inference credential is added to target/reservation/readbacks. The
      // trusted provider bootstrapFor(q) closure must reread the durable current
      // session and verify this exact nonce/reservation before rendering only
      // its inference key and host tunnel token. That bridge is integration work.
      return structuredClone(q);
    },
    context(s){
      const q=reservationChecked(s?.reservation);validate(s?.pod,q,s?.quote?.gpuHourlyUSD);
      if(s.phase!=='ready'||s.stopRequested||s.nonce!==q.nonce||s.bootAt!==q.createdNotBefore||s.deadline!==q.deadline||s.quote?.minutes!==q.minutes||!/^[A-Za-z0-9_-]{43,128}$/.test(s.inferenceKey??''))reject('HYPERSTACK_CONTEXT_INVALID',503);
      return {CHAT_ENABLED:'true',CHAT_SESSION:JSON.stringify({provider:PROVIDER,vmId:s.pod.id,createdAt:new Date(s.bootAt).toISOString(),nonce:s.nonce,minutes:q.minutes}),INFERENCE_API_KEY:s.inferenceKey};
    },
    cleanupComplete(receipt){return receipt?.provider===PROVIDER&&receipt.complete===true&&receipt.vmAbsent===true&&receipt.inventoryAbsent===true&&receipt.publicIpReleaseMode==='vm-coupled'&&receipt.independentIpReadback===false&&receipt.standaloneIpAbsence==='unverified'&&receipt.billingSettlementPending===true&&Array.isArray(receipt.unexpectedVolumeIds)&&receipt.unexpectedVolumeIds.length===0;},
    priceAccept(p,s){
      // The VM readback has no price. This checks the freshly authenticated
      // quote and matching target, without fabricating a p.cost observation.
      try{validate(p,s.reservation,s.quote?.gpuHourlyUSD);return s.quote.provider===PROVIDER&&finite(s.quote.totalHourlyUSD)&&s.quote.totalHourlyUSD>=s.quote.gpuHourlyUSD&&s.quote.totalHourlyUSD<=t.maximumHourlyUSD;}catch{return false;}
    },
    isRunning:p=>p?.provider===PROVIDER&&p.status==='ACTIVE',
    isFailed:p=>p?.provider===PROVIDER&&['ERROR','SHUTOFF','HIBERNATED','DELETED','SUSPENDED','STOPPED'].includes(p.status),
    receiptFresh(proof,q,now){
      reservationChecked(q);
      if(!Number.isSafeInteger(now)||now<q.createdNotBefore||now>=q.createdNotAfter||now>=q.deadline||proof?.schedulerReady!==true||proof.provider!==PROVIDER||proof.reservationName!==q.name||proof.image!==image||proof.nonce!==q.nonce||proof.deadline!==q.deadline)reject('GUARD_RECEIPTS_EXPIRED');
      for(const role of ['primary','backup']){
        const r=proof.guards?.[role];
        if(r?.role!==role||r.mode!=='reservation'||r.nonce!==q.nonce||r.expiry!==q.deadline+(role==='backup'?60_000:0)||!uuid.test(r.version??'')||!Number.isSafeInteger(r.eventTimestamp)||now-r.eventTimestamp<0||now-r.eventTimestamp>90_000)reject('GUARD_RECEIPTS_EXPIRED');
      }
      // Current-version equality is established by authenticated tail parsing
      // and the engine's separate checkVersions(proof), never by model output.
    }
  });
}
