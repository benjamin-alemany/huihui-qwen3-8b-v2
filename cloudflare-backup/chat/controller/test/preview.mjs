// Loopback-only UI fixture. No cloud client, keys or external requests.
import {createServer} from 'node:http';import {readFile} from 'node:fs/promises';import {randomUUID} from 'node:crypto';
const site=new URL('../../site/',import.meta.url);let session=null,quote=null,saved=[];
const status=()=>({launchEnabled:true,agentToolsEnabled:false,terminalEnabled:false,session,budget:{capUSD:.5,spentUpperUSD:.2,reservedUSD:session&&!['stopped','failed','cancelled'].includes(session.phase)?.23:0,remainingUSD:.3},readiness:{phase:'verified'}});
const server=createServer(async(req,res)=>{
 res.setHeader('Cache-Control','no-store');const path=req.url;let result,code=200;
 try{
  if(req.method==='GET'&&['/','/app.js','/session.js','/style.css'].includes(path)){
   const file=path==='/'?'index.html':path.slice(1);let body=await readFile(new URL(file,site));if(file==='index.html')body=body.toString().replace('<main>','<main><p role="status">LOCAL DUMMY PREVIEW — no GPU or cloud resources.</p>');res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(body);return;
  }
  let input='';for await(const part of req){input+=part;if(input.length>65536)throw Error('too large');}const body=input?JSON.parse(input):{};
  if(path==='/api/controller/status')result=status();
  else if(path==='/api/status')result={chatEnabled:session?.phase==='ready',agentToolsEnabled:false,history:'private-cloud-opt-in',deadline:session?.deadline,reason:'Local dummy session; no paid resources.'};
  else if(path==='/api/session/quote'){quote={id:randomUUID(),minutes:18,totalHourlyUSD:.60,gpuHourlyUSD:.59,maximumUSD:.23,live:true,launchEnabled:true,availability:'HIGH',expiresAt:Date.now()+120000,includes:'GPU, temporary disk, startup and shutdown margin',excludes:'Tax/FX and provider outages'};result=quote;}
  else if(path==='/api/session/start'){
   if(session||body.quoteId!==quote?.id||body.maximumUSD!==.23){result={error:'Start refused'};code=409;}
   else{session={id:randomUUID(),quoteId:quote.id,phase:'preflight',stopRequested:false,deadline:new Date(Date.now()+18*60000).toISOString()};setTimeout(()=>{if(!session.stopRequested)session.phase='ready';},1500);result=status();code=202;}
  }else if(path==='/api/session/stop'){session.stopRequested=true;session.phase='stopping';setTimeout(()=>{session.phase='stopped';session.cleanupVerified=true;},800);result=status();code=202;}
  else if(path==='/api/chat')result={content:'Dummy reply: this browser test did not run Qwen or start a GPU.',finishReason:'stop'};
  else if(path==='/api/controller/check'){result=status();code=202;}
  else if(path==='/api/history')result={items:saved.map(({id,title})=>({id,title}))};
  else if(path==='/api/history/save'){const item={id:randomUUID(),...body};saved.push(item);result={id:item.id};code=201;}
  else if(path.startsWith('/api/history/'))result=saved.find(x=>x.id===path.split('/').at(-1))??{};
  else{result={error:'Not found'};code=404;}
 }catch{result={error:'Dummy request failed'};code=400;}
 res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(result));
});
server.listen(8876,'127.0.0.1',()=>console.log('Local dummy preview at http://127.0.0.1:8876; no provider clients or credentials.'));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
