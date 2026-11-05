// Only authenticated Cloudflare tail transport may supply these events.
// This is a scheduler readiness gate, not a provider-enforced billing cap.
export const GUARDS=Object.freeze({primary:'unjailed-chat-stop-primary',backup:'unjailed-chat-stop-backup'});
export const ACCOUNT='00000000000000000000000000000000';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function activeVersion(result){
  // Refuse a gradual or ambiguous deployment: every tick must have one current version.
  const d=result?.deployments?.[0],v=d?.versions;
  if(!Array.isArray(v)||v.length!==1||v[0].percentage!==100||!uuid.test(v[0].version_id??''))throw Error('Guard deployment is not a single active version');
  return v[0].version_id;
}
function eventTime(value){
  if(typeof value==='number')return value;
  if(typeof value==='string'&&/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value))return Date.parse(value);
  return NaN;
}
export function receiptFrom(event,versions,reservation,{now=Date.now(),heartbeatOnly=false}={}){
  if(!event||event.outcome!=='ok'||event.exceptions?.length||event.truncated||event.event?.cron!=='* * * * *')return null;
  const timestamp=eventTime(event.eventTimestamp),age=now-timestamp;
  if(!Number.isFinite(age)||age<0||age>90000||!Array.isArray(event.logs)||event.logs.length>64)return null;
  for(const log of event.logs){
    if(!Array.isArray(log.message)||log.message.length>16)continue;
    for(const message of log.message){
      if(typeof message!=='string'||message.length>8192)continue;
      let tick;try{tick=JSON.parse(message);}catch{continue;}
      const role=tick?.role,worker=GUARDS[role];
      if(!worker||event.scriptName!==worker||!uuid.test(versions?.[worker]??'')||event.scriptVersion?.id!==versions[worker])continue;
      if(tick.event!=='guard_tick')continue;
      if(heartbeatOnly){if(tick.status!=='unarmed'||tick.reservationName||tick.image)continue;}
      else if(tick.status!=='waiting-for-reserved-pod'||tick.reservationName!==reservation?.name||tick.image!==reservation?.image)continue;
      // Do not retain raw logs, errors, request headers, URLs, tokens or prompt text.
      return {role,worker,version:versions[worker],eventTimestamp:timestamp,mode:heartbeatOnly?'unarmed-heartbeat':'reservation'};
    }
  }
  return null;
}
export function verifyGuardReceipts(reservation,versions,events,{now=Date.now()}={}){
  const start=eventTime(reservation?.windowStart),end=eventTime(reservation?.windowEnd);
  if(!Number.isFinite(start)||!Number.isFinite(end)||start>now||now>=end||end-start>300000||end<start)throw Error('Reservation creation window is not open');
  if(!/^qwen-chat-session-[a-f0-9]{16}$/.test(reservation?.name??'')||!/^ghcr\.io\/benjamin-alemany\/huihui-qwen3-8b-v2@sha256:[a-f0-9]{64}$/.test(reservation?.image??''))throw Error('Invalid chat reservation');
  const found={};
  for(const event of events){const r=receiptFrom(event,versions,reservation,{now});if(r)found[r.role]=r;}
  if(Object.keys(found).sort().join()!=='backup,primary')throw Error('Both current guards must execute this reservation before paid creation');
  return {schedulerReady:true,reservationName:reservation.name,image:reservation.image,receiptMaxAgeSeconds:90,guards:found};
}
