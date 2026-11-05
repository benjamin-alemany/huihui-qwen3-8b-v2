// Local dummy network only. Never imports real secrets or uses a real fetch.
export function providerFixture(initial=[]){
 const state={pods:structuredClone(initial),calls:[],stopWorks:true,deleteWorks:true,getFailure:false,createFailure:false,sse:false};
 state.fetch=async(url,options={})=>{
  state.calls.push({url:String(url),method:options.method??'GET'});const u=new URL(url);
  if(u.origin==='https://mcp.runpod.io'){
   const input=JSON.parse(options.body),name=input.params?.name,args=input.params?.arguments;
   if(input.method==='notifications/initialized')return new Response(null,{status:202});
   let result={protocolVersion:'2024-11-05',serverInfo:{name:'dummy',version:'1'},capabilities:{}};
   if(input.method==='tools/call'){
    state.calls.at(-1).tool=name;let data,failed=false;
    if(name==='list-pods')data={pods:state.pods,pagination:{hasNextPage:false}};
    else if(name==='get-pod'){if(state.getFailure)throw Error('dummy provider read failure');data=state.pods.find(p=>p.id===args.id);if(!data){data={status:404,detail:'pod not found'};failed=true;}}
    else if(name==='pod-action'){if(args.body.action!=='stop')throw Error('unexpected action');if(state.stopWorks)state.pods=state.pods.map(p=>p.id===args.id?{...p,status:'EXITED'}:p);data={};}
    else if(name==='delete-pod'){if(state.deleteWorks)state.pods=state.pods.filter(p=>p.id!==args.id);data={};}
    else if(name==='create-pod'){if(state.createFailure)throw Error('lost create reply');data={id:'abcdefghijklm',...args.body,createdAt:new Date().toISOString(),cost:.59,status:'RUNNING',env:{SECRET:'DUMMY_UPSTREAM_SECRET'}};state.pods.push(data);}
    else throw Error('Unexpected dummy tool '+name);
    result={isError:failed,content:[{type:'text',text:JSON.stringify(data)}]};
   }
   const doc={jsonrpc:'2.0',id:input.id,result};return state.sse?new Response('event: message\ndata: '+JSON.stringify(doc)+'\n\n',{headers:{'Content-Type':'text/event-stream'}}):Response.json(doc);
  }
  if(u.origin==='https://api.runpod.io'){
   let data;if(u.pathname==='/v2/pods')data={pods:state.pods,pagination:{hasNextPage:false}};
   else if(u.pathname.endsWith('/action')){if(state.stopWorks)state.pods=state.pods.map(p=>({...p,status:'EXITED'}));data={};}
   else data=state.pods.find(p=>u.pathname.endsWith('/'+p.id));
   return data?Response.json(data):new Response(null,{status:404});
  }
  throw Error('Unexpected dummy destination');
 };
 return state;
}
