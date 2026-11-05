import {boundedJSON,MODEL} from '../policy.mjs';
import {GPU,podMatches,validatePod} from './session-policy.mjs';
// The official MCP surface, including mutations, pinned to the hosted vendor.
// No automatic HTTP retry; in particular create() is sent exactly once.
export function runpodClient(key,{fetchImpl=fetch}={}){
  if(typeof key!=='string'||key.length<16)throw Error('RUNPOD_NOT_CONFIGURED');
  let session,counter=0,initialized=false;
  async function rpc(method,params,notification=false){
    const id=++counter,headers={Authorization:'Bearer '+key,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2024-11-05'};
    if(session)headers['Mcp-Session-Id']=session;
    const r=await fetchImpl('https://mcp.runpod.io/',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',...(notification?{}:{id}),method,params}),redirect:'manual',signal:AbortSignal.timeout(30000)});
    if(!r.ok){await r.body?.cancel();throw Error('RUNPOD_REQUEST_UNCONFIRMED');}
    session=r.headers.get('Mcp-Session-Id')??session;
    if(notification){await r.body?.cancel();return;}
    let doc;
    if(r.headers.get('Content-Type')?.includes('text/event-stream')){
      // The MCP server terminates one reply stream per call. Bound it before parsing.
      const reader=r.body.getReader(),decoder=new TextDecoder();let text='',size=0;
      try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>2*1024*1024)throw Error('RUNPOD_RESPONSE_LIMIT');text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}
      finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
      doc=text.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>{try{return JSON.parse(l.slice(5));}catch{return null;}}).find(d=>d?.id===id);
    }else doc=await boundedJSON(r.body,2*1024*1024);
    if(!doc||doc.id!==id||doc.error)throw Error('RUNPOD_REQUEST_UNCONFIRMED');return doc.result;
  }
  async function tool(name,args){
    if(!initialized){await rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'unjailed-controller',version:'1'}});await rpc('notifications/initialized',{},true);initialized=true;}
    const result=await rpc('tools/call',{name,arguments:args});
    let d;try{d=JSON.parse(result.content.find(c=>c.type==='text').text);}catch{throw Error('RUNPOD_RESPONSE_INVALID');}
    if(result?.isError){if(name==='get-pod'&&d?.status===404&&d.detail==='pod not found')return null;throw Error('RUNPOD_REQUEST_UNCONFIRMED');}
    return d;
  }
  const safePod=p=>p?Object.fromEntries(['id','name','image','cloud','gpu','cost','createdAt','status','disk','ports','mounts','actions','locked'].map(k=>[k,p[k]])):null;
  async function get(id){
    // Only the observed structured get-pod 404 is absence. Auth failures,
    // timeouts and malformed replies can never be mistaken for deletion.
    return safePod(await tool('get-pod',{id}));
  }
  async function list(){const all=[];let cursor;for(let page=0;page<5;page++){const d=await tool('list-pods',{limit:1000,...(cursor?{cursor}:{})});if(!Array.isArray(d.pods))throw Error('RUNPOD_LIST_INVALID');all.push(...d.pods.map(safePod));if(!d.pagination?.hasNextPage)return all;const next=d.pagination.nextCursor;if(!next||next===cursor)throw Error('RUNPOD_CURSOR_INVALID');cursor=next;}throw Error('RUNPOD_LIST_LIMIT');}
  return {
    catalog:()=>tool('get-gpu-type',{id:GPU,include:['AVAILABILITY'],product:['POD'],cloud:'SECURE',minCudaVersion:'13.0'}),list,get,
    create:async body=>safePod(await tool('create-pod',{body})),
    async cleanup(p,q,maxGpuHourly){
      const current=await get(p.id);if(!current)return true;validatePod(current,q,maxGpuHourly);
      if(current.status!=='EXITED'){
        if(current.locked||!current.actions?.includes('stop'))throw Error('POD_CANNOT_STOP');
        try{await tool('pod-action',{id:p.id,body:{action:'stop'}});}catch{/* A lost STOP response is reconciled by a fresh read; never assumed successful. */}
        const stopped=await get(p.id);if(!stopped)return true;validatePod(stopped,q,maxGpuHourly);if(stopped.status!=='EXITED')return false;
      }
      try{await tool('delete-pod',{id:p.id});}catch{/* Verify absence before success. */}
      return (await get(p.id))===null;
    },
    async health(p,inferenceKey){
      if(!/^[a-z0-9]{10,32}$/.test(p.id??''))throw Error('POD_ID_INVALID');
      const base=`https://${p.id}-8000.proxy.runpod.net`;
      for(const path of ['/health','/v1/models']){
        const r=await fetchImpl(base+path,{headers:{Authorization:'Bearer '+inferenceKey,'User-Agent':'unjailed-private-chat/1.0'},redirect:'manual',signal:AbortSignal.timeout(8000)});
        if(!r.ok){await r.body?.cancel();return false;}
        if(path==='/v1/models'){const d=await boundedJSON(r.body,65536);if(!d.data?.some(m=>m.id===MODEL))return false;}else await r.body?.cancel();
      }return true;
    }
  };
}
