// Diagnostic-only console reads. This is deliberately separate from the normal
// provider/guard clients and cannot establish health, permission or VM absence.
// Official schema: https://docs.hyperstack.cloud/openapi/hyperstack.json
// POST /core/virtual-machines/{id}/logs {length:200}: 200/202 + request_id.
// GET .../logs?request_id=<integer>: logs:string|null, ACTIVE VMs only.
import {boundedJSON} from '../policy.mjs';
import {API_BASE,assertBound,matchesReservation,providerId,validateReservation} from './policy.mjs';

const PREFIX='UNJAILED_HOST_EVENT ',MAX_RESPONSE=256*1024,REQUEST_MS=8000,OPERATION_MS=30000;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const FIELDS=['version','sessionId','nonce','component','phase','status','at','deadline'];
const RECEIPT_FIELDS=['version','provider','kind','state','sessionId','nonce','deadline','allocationId','observedAt','events','diagnosticOnly'];
const PHASES=Object.freeze({
  bootstrap:new Set(['new','metadata-review','installing','awaiting-reboot','driver-check','host-ready-model-not-started']),
  runtime:new Set(['preparing','image-pull','connector-install','host-boundary-probe','sealing','container-create','native-boundary','model-free-preflight','awaiting-provider-firewall-permit','model-starting','ready'])
});
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,fields)=>plain(x)&&Object.keys(x).sort().join()===fields.toSorted().join();
const safeTime=x=>Number.isSafeInteger(x)&&x>=0&&x<=8_640_000_000_000_000;
const refuse=()=>{throw Error('Host diagnostics unavailable');};

// No line/error/exception from the console may escape this parser. Even a
// correctly shaped event is only untrusted progress, never readiness evidence.
export function parseHostEvents(logs,{reservation,sessionId,observedAt}={}){
  let q;try{q=validateReservation(reservation);}catch{return [];}
  if(typeof logs!=='string'||new TextEncoder().encode(logs).byteLength>MAX_RESPONSE||!UUID.test(sessionId??'')||!safeTime(observedAt)||observedAt<q.createdNotBefore)return [];
  const events=[];
  for(const line of logs.split(/\r?\n/)){
    if(!line.startsWith(PREFIX)||new TextEncoder().encode(line).byteLength>1024)continue;
    const text=line.slice(PREFIX.length);let e;
    try{e=JSON.parse(text);}catch{continue;}
    // The host emits simple ASCII field names and scalar values. Counting the
    // exact keys also rejects duplicate/escaped keys that JSON.parse hides.
    const keys=[...text.matchAll(/"([A-Za-z][A-Za-z0-9]*)"\s*:/g)].map(m=>m[1]);
    if(!exact(e,FIELDS)||keys.length!==FIELDS.length||new Set(keys).size!==FIELDS.length||keys.some(k=>!FIELDS.includes(k))||e.version!==1||e.sessionId!==sessionId||e.nonce!==q.nonce||!Object.hasOwn(PHASES,e.component)||!PHASES[e.component].has(e.phase)||!['running','failed','passed'].includes(e.status)||!safeTime(e.at)||e.at<q.createdNotBefore||e.at>Math.min(observedAt,q.deadline)||e.deadline!==q.deadline)continue;
    events.push({version:1,sessionId,nonce:q.nonce,component:e.component,phase:e.phase,status:e.status,at:e.at,deadline:q.deadline});
    if(events.length>16)events.shift();
  }
  return events;
}

// Persistence boundary for the controller: validate and reconstruct, never
// clone a provider-controlled object or accept unbound/unavailable identities.
export function safeDiagnosticReceipt(result,{allocation,reservation,sessionId}={}){
  try{
    const q=validateReservation(reservation),id=providerId(allocation?.id);
    if(!matchesReservation(allocation,q)||!UUID.test(sessionId??'')||!exact(result,RECEIPT_FIELDS)||result.version!==1||result.provider!=='hyperstack'||result.kind!=='host-console-progress-v1'||!['available','processing','unavailable'].includes(result.state)||result.sessionId!==sessionId||result.nonce!==q.nonce||result.deadline!==q.deadline||result.allocationId!==id||!safeTime(result.observedAt)||result.observedAt<q.createdNotBefore||result.diagnosticOnly!==true||!Array.isArray(result.events)||result.events.length>16||result.state!=='available'&&result.events.length) return null;
    const events=parseHostEvents(result.events.map(e=>PREFIX+JSON.stringify(e)).join('\n'),{reservation:q,sessionId,observedAt:result.observedAt});
    if(events.length!==result.events.length)return null;
    return {version:1,provider:'hyperstack',kind:'host-console-progress-v1',state:result.state,sessionId,nonce:q.nonce,deadline:q.deadline,allocationId:id,observedAt:result.observedAt,events,diagnosticOnly:true};
  }catch{return null;}
}

export async function collectHostDiagnostics({key,allocation,reservation,sessionId,providerGet,fetchImpl=fetch,now=Date.now}={}){
  let observedAt;try{observedAt=now();}catch{}
  let receipt={version:1,provider:'hyperstack',kind:'host-console-progress-v1',state:'unavailable',sessionId:null,nonce:null,deadline:null,allocationId:null,observedAt:safeTime(observedAt)?observedAt:null,events:[],diagnosticOnly:true};
  const started=performance.now();
  try{
    const q=validateReservation(reservation),id=providerId(allocation?.id);
    if(!UUID.test(sessionId??'')||!safeTime(observedAt)||observedAt<q.createdNotBefore||!matchesReservation(allocation,q))refuse();
    receipt={...receipt,sessionId,nonce:q.nonce,deadline:q.deadline,allocationId:id};
    if(typeof key!=='string'||key.length<16||key.length>512||!/^[!-~]+$/.test(key)||typeof providerGet!=='function'||typeof fetchImpl!=='function')refuse();
    async function bounded(action){
      const remaining=OPERATION_MS-(performance.now()-started);
      if(remaining<=0)refuse();
      const controller=new AbortController();let timer;
      try{
        return await Promise.race([
          Promise.resolve().then(()=>action(controller.signal)),
          new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('Host diagnostics unavailable'));},Math.min(REQUEST_MS,remaining));})
        ]);
      }finally{clearTimeout(timer);controller.abort();}
    }
    async function fresh(){
      const current=await bounded(()=>providerGet(id));
      assertBound(current,allocation,q);
      if(current.status!=='ACTIVE')refuse();
    }
    async function request(path,method='GET',body){
      return bounded(async signal=>{
        const response=await fetchImpl(API_BASE+path,{method,headers:{api_key:key,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'manual',signal});
        // Never parse or surface provider errors/redirects, including raw logs.
        if(!(method==='POST'?[200,202]:[200]).includes(response.status)){await response.body?.cancel();refuse();}
        return boundedJSON(response.body,MAX_RESPONSE);
      });
    }
    const path='/core/virtual-machines/'+id+'/logs';
    await fresh();
    const requested=await request(path,'POST',{length:200});
    if(!plain(requested)||Object.keys(requested).some(k=>!['status','message','request_id'].includes(k))||('status'in requested&&requested.status!==true)||!Number.isSafeInteger(requested.request_id)||requested.request_id<=0||requested.request_id>999_999_999_999_999)refuse();
    for(let poll=0;poll<2;poll++){
      // The documented API is asynchronous. Give its one existing job a
      // bounded interval to finish; this never submits another log request.
      if(poll)await new Promise(resolve=>setTimeout(resolve,500));
      await fresh();
      const result=await request(path+'?request_id='+requested.request_id);
      if(!plain(result)||Object.keys(result).some(k=>!['status','message','logs'].includes(k))||!Object.hasOwn(result,'logs')||('status'in result&&typeof result.status!=='boolean'))refuse();
      if(result.logs===null){receipt.state='processing';continue;}
      if(typeof result.logs!=='string'||result.status===false)refuse();
      const at=now();if(!safeTime(at)||at<observedAt)refuse();
      return {...receipt,state:'available',observedAt:at,events:parseHostEvents(result.logs,{reservation:q,sessionId,observedAt:at})};
    }
    return receipt;
  }catch{return {...receipt,state:'unavailable',events:[]};}
}
