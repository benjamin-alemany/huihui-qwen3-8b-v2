// Fixed-stage validation STOP safeguard. Never create/start/delete or expose an admin API.
const API='https://api.runpod.io/v2';
const PRIMARY_MINUTES=Object.freeze({probe:4,chat:18});
import {IMAGE,GPU,SESSION_MINUTES} from '../controller/session-policy.mjs';
export function queryFrom(raw){
  const q=JSON.parse(raw),start=Date.parse(q.windowStart),end=Date.parse(q.windowEnd);
  const zoned=s=>typeof s==='string'&&/T.*(?:Z|[+-]\d\d:\d\d)$/.test(s);
  if(!['probe','chat'].includes(q.kind)||
     !(q.kind==='probe'?/^qwen-chat-probe-[a-f0-9]{16}$/:/^qwen-chat-session-[a-f0-9]{16}$/).test(q.name??'')||q.image!==IMAGE||
     !/^ghcr\.io\/benjamin-alemany\/huihui-qwen3-8b-v2@sha256:[a-f0-9]{64}$/.test(q.image??'')||
     !zoned(q.windowStart)||!zoned(q.windowEnd)||!Number.isFinite(start)||!Number.isFinite(end)||end<start||end-start>5*60000)
    throw Error('Invalid chat reservation');
  if(q.earlyStopAt!==undefined&&(!zoned(q.earlyStopAt)||!Number.isFinite(Date.parse(q.earlyStopAt))))throw Error('Invalid early stop');
  // Legacy acceptance reservations retain their fixed stage duration. A new
  // owner session binds one of the product durations before any creation.
  if(q.minutes!==undefined&&(q.kind!=='chat'||!SESSION_MINUTES.includes(q.minutes)))throw Error('Invalid session duration');
  return {name:q.name,image:q.image,start,end,kind:q.kind,minutes:q.minutes??PRIMARY_MINUTES[q.kind],earlyStopAt:q.earlyStopAt?Date.parse(q.earlyStopAt):Infinity};
}
function matches(p,q){
  const created=Date.parse(p.createdAt);
  return p.name===q.name&&p.image===q.image&&Number.isFinite(created)&&created>=q.start&&created<=q.end;
}
function identity(p,bound){
  if(!/^[A-Za-z0-9_-]+$/.test(p.id??''))throw Error('Invalid Pod ID');
  for(const field of ['id','name','image','createdAt'])if(p[field]!==bound[field])throw Error('Pod identity mismatch');
  if(p.cloud!=='SECURE'||p.gpu?.id!==GPU||p.gpu?.count!==1)throw Error('Pod shape mismatch');
}
export async function checkChatStop(env,{now=Date.now(),fetchImpl=fetch}={}){
  if(!env.ARMED_CHAT)return {status:'unarmed'};
  const query=queryFrom(env.ARMED_CHAT);
  if(!['primary','backup'].includes(env.CHAT_STOP_ROLE))throw Error('Invalid cloud stop role');
  const stopAfter=(query.minutes+(env.CHAT_STOP_ROLE==='backup'?1:0))*60000;
  if(!env.RUNPOD_API_KEY||env.RUNPOD_API_KEY.startsWith('__'))throw Error('Missing cloud STOP key');
  async function request(path,stop=false){
    const r=await fetchImpl(API+path,{method:stop?'POST':'GET',
      headers:{Authorization:`Bearer ${env.RUNPOD_API_KEY}`,'Content-Type':'application/json'},
      body:stop?JSON.stringify({action:'stop'}):undefined,redirect:'manual',signal:AbortSignal.timeout(10000)});
    if(r.status===404)return null;
    if(stop&&r.status===409)return {conflict:true};
    if(!r.ok)throw Error(`Runpod HTTP ${r.status}`);
    return r.json();
  }
  const found=[];let cursor=null;
  for(let page=0;page<5;page++){
    const list=await request('/pods?limit=1000'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
    if(!list||!Array.isArray(list.pods))throw Error('Invalid Pod list');
    for(const p of list.pods)if(matches(p,query))found.push(p);
    if(!list.pagination?.hasNextPage)break;
    if(!list.pagination.nextCursor||list.pagination.nextCursor===cursor||page===4)throw Error('Invalid/excessive pagination');
    cursor=list.pagination.nextCursor;
  }
  if(!found.length)return {status:'waiting-for-reserved-pod'};
  const results=[];
  // A duplicate of this exact nonce/image/window belongs to the same test; stop it too.
  for(const bound of found){
    identity(bound,bound);
    const deadline=Math.min(Date.parse(bound.createdAt)+stopAfter,query.earlyStopAt+(env.CHAT_STOP_ROLE==='backup'?60000:0));
    if(now<deadline){results.push({id:bound.id,status:'armed',deadline});continue;}
    let p=await request('/pods/'+bound.id);
    if(!p){results.push({id:bound.id,status:'gone'});continue;}
    identity(p,bound);
    if(p.status==='EXITED'){results.push({id:bound.id,status:'stopped_verified'});continue;}
    if(p.locked||!p.actions?.includes('stop'))throw Error('Reserved Pod cannot stop');
    await request('/pods/'+bound.id+'/action',true);
    p=await request('/pods/'+bound.id);
    if(!p){results.push({id:bound.id,status:'gone'});continue;}
    identity(p,bound);
    results.push({id:bound.id,status:p.status==='EXITED'?'stopped_verified':'stop_requested_retrying'});
  }
  return {status:'reserved-pods-checked',results};
}
export default{
  async scheduled(_,env){
    const result=await checkChatStop(env);
    const reservation=env.ARMED_CHAT?queryFrom(env.ARMED_CHAT):null;
    console.log(JSON.stringify({event:'guard_tick',role:env.CHAT_STOP_ROLE,
      reservationName:reservation?.name,image:reservation?.image,...result,at:new Date().toISOString()}));
    if(result.results?.some(p=>p.status==='stop_requested_retrying'))throw Error('STOP pending; retry next minute');
  },
  async fetch(){return new Response('Not found',{status:404});}
};
