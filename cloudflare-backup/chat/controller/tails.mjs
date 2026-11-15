import {ACCOUNT,GUARDS,activeVersion,receiptFrom,verifyGuardReceipts} from './receipts.mjs';
const MAX_FRAME_BYTES=65536;
class TailFailure extends Error {constructor(code){super(code);this.code=code;}}
export function safeTailFailure(error){return typeof error?.code==='string'&&/^(?:(?:VERSIONS_READ|TAIL_CREATE|TAIL_CONNECT|TAIL_UPGRADE|TAIL_CLEANUP|TOKEN_FORMAT|ACCOUNT_FORMAT|GUARD_TIMEOUT|GUARD_DEPLOYMENT_CHANGED|TAIL_FRAME|TAIL_SOCKET)(?:_HTTP_\d{3})?|TAIL_SOCKET_CLOSE_\d{4})$/.test(error.code)?error.code:'GUARD_HEARTBEAT_NOT_VERIFIED';}
async function smallJSON(response){
  const reader=response.body?.getReader();if(!reader)throw Error('Missing Cloudflare response');
  let text='',size=0;const decoder=new TextDecoder('utf-8',{fatal:true});
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_FRAME_BYTES){await reader.cancel();throw Error('Cloudflare response exceeds limit');}text+=decoder.decode(value,{stream:true});}text+=decoder.decode();return JSON.parse(text);}
  finally{reader.releaseLock();}
}
export function tailURL(raw){
  const u=new URL(raw);
  // The API response contains a temporary tail credential. Never log it or add
  // the account API token to the WebSocket request. No arbitrary fetch target.
  if(u.protocol!=='wss:'||u.hostname!=='tail.developers.workers.dev'||u.port||u.username||u.password||u.hash||u.search||!/^\/[a-f0-9]{32}$/.test(u.pathname))throw Error('Unexpected Cloudflare tail transport');
  u.protocol='https:';return u.toString();
}
export function cloudflareTailClient(token,{accountId=ACCOUNT,fetchImpl=fetch}={}){
  if(typeof accountId!=='string'||!/^[a-f0-9]{32}$/.test(accountId))throw new TailFailure('ACCOUNT_FORMAT');
  if(typeof token!=='string'||token.length<40||token.length>256||!/^[A-Za-z0-9_-]+$/.test(token))throw new TailFailure('TOKEN_FORMAT');
  const API=`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/`;
  async function request(worker,suffix,method='GET',body){
    if(!Object.values(GUARDS).includes(worker)||!(/^(deployments|tails(?:\/[a-f0-9]{32})?)$/.test(suffix)))throw Error('Unknown stop guard resource');
    const r=await fetchImpl(API+worker+'/'+suffix,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','User-Agent':'unjailed-session-controller/1.0'},body:body===undefined?undefined:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(10000)});
    if(!r.ok){await r.body?.cancel();throw new TailFailure((suffix==='deployments'?'VERSIONS_READ':method==='DELETE'?'TAIL_CLEANUP':'TAIL_CREATE')+'_HTTP_'+r.status);}
    const data=await smallJSON(r);if(data.success!==true)throw Error('Cloudflare guard API rejected the request');return data.result;
  }
  return {
    async versions(){try{const result=await Promise.all(Object.values(GUARDS).map(async worker=>[worker,activeVersion(await request(worker,'deployments'))]));return Object.fromEntries(result);}catch(e){throw e instanceof TailFailure?e:new TailFailure('VERSIONS_READ');}},
    async open(worker){
      let record;try{record=await request(worker,'tails','POST',{});}catch(e){throw e instanceof TailFailure?e:new TailFailure('TAIL_CREATE');}
      if(!/^[a-f0-9]{32}$/.test(record?.id??''))throw Error('Invalid Cloudflare tail session');
      let socket;
      const dispose=async()=>{try{socket?.close(1000,'Readiness check complete');}finally{await request(worker,'tails/'+record.id,'DELETE');}};
      try{
        // Abort only a stalled handshake. Leaving AbortSignal.timeout(10000)
        // attached after HTTP 101 terminates the upgraded socket ten seconds
        // later, before the next scheduled guard tick can arrive.
        const abort=new AbortController(),handshakeTimer=setTimeout(()=>abort.abort(),10000);
        let r;
        try{r=await fetchImpl(tailURL(record.url),{headers:{Upgrade:'websocket','Sec-WebSocket-Protocol':'trace-v1','User-Agent':'unjailed-session-controller/1.0'},redirect:'manual',signal:abort.signal});}
        finally{clearTimeout(handshakeTimer);}
        if(r.status!==101||!r.webSocket)throw new TailFailure('TAIL_UPGRADE_HTTP_'+r.status);
        // Current Workers dates default binary messages to Blob. Tail sends
        // JSON in binary frames; select ArrayBuffer before accepting so the
        // bounded synchronous decoder always sees bytes, never a Blob.
        socket=r.webSocket;socket.binaryType='arraybuffer';socket.accept();socket.send(JSON.stringify({debug:false}));
        return {socket,dispose};
      }catch(e){await dispose().catch(()=>{});throw e instanceof TailFailure?e:new TailFailure('TAIL_CONNECT');}
    }
  };
}
function decodeFrame(data){
  if(typeof data==='string'){if(data.length>MAX_FRAME_BYTES||new TextEncoder().encode(data).byteLength>MAX_FRAME_BYTES)throw Error('Oversized tail frame');return JSON.parse(data);}
  if(data instanceof ArrayBuffer&&data.byteLength<=MAX_FRAME_BYTES)return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));
  throw Error('Unsupported tail frame');
}
// Must run inside an awaited Durable Object alarm, not a browser connection or
// a short-lived waitUntil. Heartbeat mode checks transport only and NEVER grants
// permission to create a Pod. Paid launches require an exact reservation.
export async function collectGuardReadiness(token,reservation,{accountId=ACCOUNT,heartbeatOnly=false,timeoutMs=125000,fetchImpl=fetch,now=Date.now}={}){
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>150000)throw Error('Invalid readiness timeout');
  const client=cloudflareTailClient(token,{accountId,fetchImpl}),versions=await client.versions(),sessions=[],receipts={},events=[];
  let timer,resolveDone,rejectDone;
  const done=new Promise((resolve,reject)=>{resolveDone=resolve;rejectDone=reject;});
  // Attach a rejection handler before network setup to avoid an unhandled
  // rejection if a socket fails while the other session is still opening.
  done.catch(()=>{});
  try{
    for(const worker of Object.values(GUARDS)){
      const session=await client.open(worker);sessions.push(session);
      session.socket.addEventListener('message',event=>{
        let data;try{data=decodeFrame(event.data);}catch{rejectDone(new TailFailure('TAIL_FRAME'));return;}
        const receipt=receiptFrom(data,versions,reservation,{now:now(),heartbeatOnly});
        if(!receipt||receipt.worker!==worker)return;
        receipts[receipt.role]=receipt;
        if(!heartbeatOnly){events.push(data);if(events.length>16)events.shift();}
        if(Object.keys(receipts).length===2)resolveDone();
      });
      session.socket.addEventListener('error',()=>rejectDone(new TailFailure('TAIL_SOCKET')));
      session.socket.addEventListener('close',event=>rejectDone(new TailFailure(Number.isInteger(event.code)&&event.code>=1000&&event.code<=4999?'TAIL_SOCKET_CLOSE_'+event.code:'TAIL_SOCKET')));
    }
    timer=setTimeout(()=>rejectDone(new TailFailure('GUARD_TIMEOUT')),timeoutMs);
    await done;
    const current=await client.versions();
    if(Object.values(GUARDS).some(worker=>current[worker]!==versions[worker]))throw new TailFailure('GUARD_DEPLOYMENT_CHANGED');
    if(!heartbeatOnly)return verifyGuardReceipts(reservation,current,events,{now:now()});
    // A stale first receipt cannot be made fresh by the second guard arriving.
    if(Object.values(receipts).some(r=>now()-r.eventTimestamp>90000))throw Error('Guard heartbeat expired');
    return {schedulerReady:false,heartbeatVerified:true,requiresExactReservation:true,guards:receipts};
  }finally{
    clearTimeout(timer);
    const cleanup=await Promise.allSettled(sessions.map(s=>s.dispose()));
    if(cleanup.some(r=>r.status==='rejected'))throw new TailFailure('TAIL_CLEANUP');
  }
}
