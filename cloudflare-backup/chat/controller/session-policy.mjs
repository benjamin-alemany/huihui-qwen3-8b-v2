import release from '../../../release/manifest.json' with {type:'json'};
export const IMAGE=release.legacyValidation.image;
export const GPU=release.legacyValidation.gpu,MINUTES=release.legacyValidation.minutes,DISK_GB=release.legacyValidation.diskGB;
export const DEFAULT_MINUTES=release.sessions.defaultMinutes,SESSION_MINUTES=Object.freeze([...release.sessions.allowedMinutes]),MAX_GRANT_USD=10;
export const SCALE=10_000_000_000;
export const SEED=Object.freeze({version:1,cap:5_000_000_000,spent:2_000_000_000,held:0,usedApprovals:[]});
export const ORIGINAL_ACCEPTANCE=Object.freeze({capUSD:0.51,spentUSD:0.4,remainingUSD:0.11});
export const terminal=s=>!s||['stopped','cancelled','failed'].includes(s.phase);
export const units=usd=>Math.ceil(usd*SCALE),dollars=n=>n/SCALE;
export class SessionError extends Error {constructor(code,status=409){super(code);this.code=code;this.status=status;}}
export function catalogFrom(raw){
  if(raw?.id!==GPU||raw.secure!==true||!Number.isFinite(raw.price?.secure)||raw.price.secure<=0)throw new SessionError('CATALOG_INVALID',503);
  const gpuHourly=raw.price.secure,totalHourly=Math.ceil((gpuHourly+0.01)*100)/100;
  if(totalHourly>1)throw new SessionError('HOURLY_LIMIT');
  return {gpu:GPU,gpuHourly,totalHourly,availability:['HIGH','MEDIUM','LOW','NONE'].includes(raw.availability)?raw.availability:'NONE'};
}
export function quoteMinutes(input,validationMode=false){
  if(input===undefined)input={};
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>k!=='minutes')||('minutes'in input&&!SESSION_MINUTES.includes(input.minutes)))throw new SessionError('INVALID_DURATION',400);
  if(validationMode&&'minutes'in input)throw new SessionError('INVALID_DURATION',400);
  return validationMode?MINUTES:(input.minutes??DEFAULT_MINUTES);
}
export const sessionMinutes=s=>s.quote?.minutes??MINUTES;
export const startupMinutes=s=>Math.min(15,sessionMinutes(s)-2);
export function makeQuote(catalog,now,id,minutes=DEFAULT_MINUTES){
  if(!SESSION_MINUTES.includes(minutes)&&minutes!==MINUTES)throw new SessionError('INVALID_DURATION',400);
  // Includes startup, backup's extra minute, scheduling/cleanup and settlement margin.
  const ceiling=units(catalog.totalHourly*(minutes+5)/60);
  return {id,minutes,gpu:GPU,gpuHourlyUSD:catalog.gpuHourly,totalHourlyUSD:catalog.totalHourly,
    maximumUSD:dollars(ceiling),holdUnits:ceiling,availability:catalog.availability,quotedAt:now,expiresAt:now+120000};
}
export function reservation(now,nonce,minutes){return {kind:'chat',...(minutes===undefined?{}:{minutes}),name:'qwen-chat-session-'+nonce.slice(0,16),image:IMAGE,windowStart:new Date(now).toISOString(),windowEnd:new Date(now+300000).toISOString()};}
export function podMatches(p,q){const t=Date.parse(p.createdAt);return p.name===q.name&&p.image===IMAGE&&Number.isFinite(t)&&t>=Date.parse(q.windowStart)&&t<=Date.parse(q.windowEnd);}
export function validatePod(p,q,maxGpuHourly){
  if(!podMatches(p,q)||!/^[a-z0-9]{10,32}$/.test(p.id??'')||p.cloud!=='SECURE'||p.gpu?.id!==GPU||p.gpu.count!==1||p.disk!==DISK_GB||!Array.isArray(p.ports)||p.ports.join()!=='8000/http'||Object.keys(p.mounts??{}).length||!Number.isFinite(p.cost)||p.cost>maxGpuHourly)throw new SessionError('POD_IDENTITY_MISMATCH',503);
  return p;
}
export function createBody(s,now){
  return {name:s.reservation.name,image:IMAGE,cloud:'SECURE',gpu:{id:GPU,count:1,minCudaVersion:'13.0',minRamPerGpu:32,minVcpuCountPerGpu:4},disk:DISK_GB,ports:['8000/http'],startSsh:false,startJupyter:false,globalNetworking:false,
    env:{VLLM_API_KEY:s.inferenceKey,CHAT_CLOUD_GUARDS_VERIFIED:'true',CHAT_RESERVED_AT:new Date(now).toISOString(),CHAT_DEADLINE_UTC:new Date(now+sessionMinutes(s)*60000).toISOString()}};
}
export function safeSession(s){
  if(!s)return null;
  return {id:s.id,quoteId:s.quoteId,minutes:sessionMinutes(s),phase:s.phase,code:s.code??null,stopRequested:!!s.stopRequested,createdAt:s.pod?.createdAt??null,deadline:s.deadline?new Date(s.deadline).toISOString():null,
    maximumUSD:s.quote.maximumUSD,settledUpperUSD:s.settledUnits===undefined?null:dollars(s.settledUnits),cleanupVerified:s.phase==='stopped',createAttempted:!!s.createAttempted};
}
export function budgetView(l){return {capUSD:dollars(l.cap),spentUpperUSD:dollars(l.spent),reservedUSD:dollars(l.held),remainingUSD:dollars(Math.max(0,l.cap-l.spent-l.held)),originalAcceptance:ORIGINAL_ACCEPTANCE};}
export function ordinaryBudgetView(l){return {capUSD:dollars(l.cap),spentUpperUSD:dollars(l.spent),reservedUSD:dollars(l.held),remainingUSD:dollars(Math.max(0,l.cap-l.spent-l.held)),grantCount:l.grantCount};}
export function parseGrant(input){
  if(!input||Array.isArray(input)||Object.keys(input).sort().join()!=='amountUSD,grantId'||typeof input.grantId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.grantId??'')||!Number.isFinite(input.amountUSD)||input.amountUSD<=0||input.amountUSD>MAX_GRANT_USD)throw new SessionError('INVALID_GRANT',400);
  // Accept exactly whole cents before converting to the ledger's finer units.
  // Multiplying a decimal dollar directly by SCALE rejects valid cents (.07)
  // while also admitting fractions of a cent that the owner UI never offers.
  const cents=Math.round(input.amountUSD*100);
  if(!Number.isSafeInteger(cents)||input.amountUSD!==cents/100)throw new SessionError('INVALID_GRANT',400);
  return {id:input.grantId,amountUnits:cents*(SCALE/100)};
}
export function receiptFresh(proof,q,now){
  if(!proof?.schedulerReady||proof.reservationName!==q.name||proof.image!==q.image||now>=Date.parse(q.windowEnd))throw new SessionError('GUARD_RECEIPTS_EXPIRED');
  for(const role of ['primary','backup']){const r=proof.guards?.[role];if(r?.role!==role||r.mode!=='reservation'||now-r.eventTimestamp<0||now-r.eventTimestamp>90000)throw new SessionError('GUARD_RECEIPTS_EXPIRED');}
}
