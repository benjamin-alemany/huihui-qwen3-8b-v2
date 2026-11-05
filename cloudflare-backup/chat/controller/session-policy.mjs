export const IMAGE='ghcr.io/benjamin-alemany/huihui-qwen3-8b-v2@sha256:f4fda4da17fe00a8188527d3a774dcc487529b63fe2e10359912d24d4ee83761';
export const GPU='NVIDIA A40',MINUTES=18,DISK_GB=60;
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
export function makeQuote(catalog,now,id){
  // Includes startup, backup's extra minute, scheduling/cleanup and settlement margin.
  const ceiling=units(catalog.totalHourly*23/60);
  return {id,minutes:MINUTES,gpu:GPU,gpuHourlyUSD:catalog.gpuHourly,totalHourlyUSD:catalog.totalHourly,
    maximumUSD:dollars(ceiling),holdUnits:ceiling,availability:catalog.availability,quotedAt:now,expiresAt:now+120000};
}
export function reservation(now,nonce){return {kind:'chat',name:'qwen-chat-session-'+nonce.slice(0,16),image:IMAGE,windowStart:new Date(now).toISOString(),windowEnd:new Date(now+300000).toISOString()};}
export function podMatches(p,q){const t=Date.parse(p.createdAt);return p.name===q.name&&p.image===IMAGE&&Number.isFinite(t)&&t>=Date.parse(q.windowStart)&&t<=Date.parse(q.windowEnd);}
export function validatePod(p,q,maxGpuHourly){
  if(!podMatches(p,q)||!/^[a-z0-9]{10,32}$/.test(p.id??'')||p.cloud!=='SECURE'||p.gpu?.id!==GPU||p.gpu.count!==1||p.disk!==DISK_GB||!Array.isArray(p.ports)||p.ports.join()!=='8000/http'||Object.keys(p.mounts??{}).length||!Number.isFinite(p.cost)||p.cost>maxGpuHourly)throw new SessionError('POD_IDENTITY_MISMATCH',503);
  return p;
}
export function createBody(s,now){
  return {name:s.reservation.name,image:IMAGE,cloud:'SECURE',gpu:{id:GPU,count:1,minCudaVersion:'13.0',minRamPerGpu:32,minVcpuCountPerGpu:4},disk:DISK_GB,ports:['8000/http'],startSsh:false,startJupyter:false,globalNetworking:false,
    env:{VLLM_API_KEY:s.inferenceKey,CHAT_CLOUD_GUARDS_VERIFIED:'true',CHAT_RESERVED_AT:new Date(now).toISOString(),CHAT_DEADLINE_UTC:new Date(now+MINUTES*60000).toISOString()}};
}
export function safeSession(s){
  if(!s)return null;
  return {id:s.id,quoteId:s.quoteId,phase:s.phase,code:s.code??null,stopRequested:!!s.stopRequested,createdAt:s.pod?.createdAt??null,deadline:s.deadline?new Date(s.deadline).toISOString():null,
    maximumUSD:s.quote.maximumUSD,settledUpperUSD:s.settledUnits===undefined?null:dollars(s.settledUnits),cleanupVerified:s.phase==='stopped',createAttempted:!!s.createAttempted};
}
export function budgetView(l){return {capUSD:dollars(l.cap),spentUpperUSD:dollars(l.spent),reservedUSD:dollars(l.held),remainingUSD:dollars(Math.max(0,l.cap-l.spent-l.held)),originalAcceptance:ORIGINAL_ACCEPTANCE};}
export function receiptFresh(proof,q,now){
  if(!proof?.schedulerReady||proof.reservationName!==q.name||proof.image!==q.image||now>=Date.parse(q.windowEnd))throw new SessionError('GUARD_RECEIPTS_EXPIRED');
  for(const role of ['primary','backup']){const r=proof.guards?.[role];if(r?.role!==role||r.mode!=='reservation'||now-r.eventTimestamp<0||now-r.eventTimestamp>90000)throw new SessionError('GUARD_RECEIPTS_EXPIRED');}
}
