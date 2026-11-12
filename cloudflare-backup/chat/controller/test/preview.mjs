// Loopback-only browser fixture. Dummy services; never a provider client.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {conversationFrom,backupFrom,importPlan,BACKUP_LIMITS} from '../../site/recovery.js';
const site=new URL('../../site/',import.meta.url),saved=new Map(),quotes=new Map(),grants=new Map(),turns=new Map();
let session=null,allowance=0,spent=0,creates=0;
const active=()=>session&&!['stopped','failed','cancelled'].includes(session.phase);
const budget=()=>({capUSD:allowance,spentUpperUSD:spent,reservedUSD:active()?session.maximumUSD:0,remainingUSD:Math.max(0,allowance-spent-(active()?session.maximumUSD:0))});
const status=()=>({launchEnabled:true,agentToolsEnabled:false,terminalEnabled:false,session,ordinaryBudget:budget(),budget:budget(),testBudget:{capUSD:0,spentUpperUSD:0,reservedUSD:0,remainingUSD:0},readiness:{phase:'verified'}});
const item=id=>saved.get(id),list=()=>[...saved.values()].map(({id,title,revision,draft,updated_at})=>({id,title,revision,draft,updated_at}));
const error=(code,message,extra={})=>({code,result:{error:message,...extra}});
const server=createServer(async(req,res)=>{
 const path=new URL(req.url,'http://127.0.0.1:8876').pathname;let result,code=200;
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; frame-ancestors 'none'; form-action 'self'");
 try{
  if(req.method==='GET'&&(path==='/'||/^\/[a-z-]+\.(js|css)$/.test(path))){
   const file=path==='/'?'index.html':path.slice(1);let body=await readFile(new URL(file,site));
   if(file==='index.html')body=body.toString().replace('<main>','<main><p role="status">LOCAL DUMMY PREVIEW — no GPU, cloud mutation or billing.</p>');
   res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(body);return;
  }
  if(req.method==='POST'&&req.headers['x-workstation-request']!=='1'){code=403;result={error:'Dummy mutation header required'};}
  else{
   let input='';for await(const part of req){input+=part;if(input.length>BACKUP_LIMITS.bytes)throw Error('too large');}const body=input?JSON.parse(input):{};
   if(path==='/api/controller/status')result=status();
   else if(path==='/api/status')result={chatEnabled:session?.phase==='ready',agentToolsEnabled:false,history:'private-cloud-opt-in',deadline:session?.deadline,reason:'Local dummy session. No Qwen or GPU is running.'};
   else if(path==='/api/controller/check'){result=status();code=202;}
   else if(path==='/api/session/grant'){
    if(!Number.isFinite(body.amountUSD)||body.amountUSD<.01||body.amountUSD>10)throw Error('Invalid grant');
    if(grants.has(body.grantId)&&grants.get(body.grantId)!==body.amountUSD)({code,result}=error(409,'GRANT_ID_REUSED'));
    else{if(!grants.has(body.grantId)){grants.set(body.grantId,body.amountUSD);allowance+=body.amountUSD;}result=status();}
   }else if(path==='/api/session/quote'){
    const minutes=body.minutes??30;if(![15,30,60].includes(minutes))throw Error('Invalid minutes');
    const q={id:randomUUID(),minutes,totalHourlyUSD:.51,gpuHourlyUSD:.50,maximumUSD:Math.ceil(.51*(minutes+5)/60*100)/100,live:true,launchEnabled:true,availability:'HIGH',expiresAt:Date.now()+120000,includes:'Dummy compute and temporary storage',excludes:'No actual charge or provider action'};quotes.set(q.id,q);result=q;
   }else if(path==='/api/session/start'){
    const q=quotes.get(body.quoteId);
    if(session?.quoteId===body.quoteId)result=status();
    else if(active()||!q||q.expiresAt<=Date.now()||body.maximumUSD!==q.maximumUSD)({code,result}=error(409,'START_REFUSED'));
    else if(budget().remainingUSD<q.maximumUSD)({code,result}=error(409,'BUDGET_EXHAUSTED'));
    else{creates++;session={id:randomUUID(),quoteId:q.id,minutes:q.minutes,phase:'preflight',stopRequested:false,maximumUSD:q.maximumUSD,deadline:new Date(Date.now()+q.minutes*60000).toISOString()};const s=session;setTimeout(()=>{if(!s.stopRequested)s.phase='ready';},800);result=status();code=202;}
   }else if(path==='/api/session/stop'){
    if(!session||body.sessionId!==session.id)({code,result}=error(409,'SESSION_CHANGED'));
    else{session.stopRequested=true;session.phase='stopping';const s=session;setTimeout(()=>{s.phase='stopped';s.cleanupVerified=true;},400);result=status();code=202;}
   }else if(path==='/api/history')result={items:list()};
   else if(path==='/api/history/upsert'){
    const c=conversationFrom({title:body.title,messages:body.messages,draft:body.draft}),id=body.id??randomUUID(),prior=item(id);
    if([...turns.values()].some(t=>t.conversationId===id&&t.status==='pending'))({code,result}=error(409,'GENERATION_PENDING',{item:prior}));
    else if(prior&&JSON.stringify(c)===JSON.stringify({title:prior.title,messages:prior.messages,draft:prior.draft}))result={item:prior};
    else if((prior&&prior.revision!==body.revision)||(!prior&&body.revision!==0))({code,result}=error(409,'REVISION_CONFLICT',{item:prior}));
    else if(!prior&&saved.size>=20)({code,result}=error(429,'HISTORY_FULL'));
    else{const next={id,revision:(prior?.revision??0)+1,...c,updated_at:Date.now()};saved.set(id,next);result={item:next};code=prior?200:201;}
   }else if(path==='/api/turns'){
    const prior=turns.get(body.turnId),c=item(body.conversationId);
    if(prior)result={...prior,item:c};
    else if(!c||c.revision!==body.revision||!c.draft.trim())({code,result}=error(409,'REVISION_CONFLICT',{item:c}));
    else if(session?.phase!=='ready')({code,result}=error(409,'SESSION_CLOSED',{item:c}));
    else{const t={turnId:body.turnId,conversationId:c.id,status:'pending'};turns.set(t.turnId,t);const text=c.draft,s=session;
     setTimeout(()=>{if(s.stopRequested){t.status='interrupted';t.error='SESSION_CLOSED';return;}saved.set(c.id,{...c,revision:c.revision+1,messages:[...c.messages,{role:'user',content:text},{role:'assistant',content:'Dummy reply: durable browser workflow only; no Qwen, GPU or charge.'}],draft:'',updated_at:Date.now()});t.status='completed';},800);result={...t,item:c};code=202;}
   }else if(path.startsWith('/api/turns/')){const t=turns.get(path.split('/').at(-1));if(t)result={...t,item:item(t.conversationId)};else({code,result}=error(404,'TURN_NOT_FOUND'));}
   else if(path==='/api/history/backup')result=backupFrom({format:'unjailed.chat-backup',version:2,conversations:[...saved.values()].map(({title,messages,draft})=>({title,messages,draft}))});
   else if(path==='/api/history/import/preview'||path==='/api/history/import'){
    const plan=importPlan([...saved.values()].map(({title,messages,draft})=>({title,messages,draft})),body);
    if(path.endsWith('/preview'))result={importable:plan.add.length,duplicates:plan.duplicates,remainingSlots:plan.remainingSlots,canImport:plan.canImport};
    else if(!plan.canImport)({code,result}=error(409,'HISTORY_FULL'));
    else{for(const c of plan.add){const id=randomUUID();saved.set(id,{id,revision:1,...c,updated_at:Date.now()});}result={imported:plan.add.length,duplicates:plan.duplicates};code=201;}
   }else if(path==='/api/history/delete'){saved.delete(body.id);result={deleted:true};}
   else if(path.startsWith('/api/history/')){result=item(path.split('/').at(-1));if(!result)({code,result}=error(404,'CHAT_NOT_FOUND'));}
   else if(path==='/__test/state')result={creates,saved:list(),turns:[...turns.values()],session,grants:grants.size};
   else({code,result}=error(404,'NOT_FOUND'));
  }
 }catch{code=400;result={error:'Dummy request refused'};}
 res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(result));
});
server.listen(8876,'127.0.0.1',()=>console.log('Local dummy preview at http://127.0.0.1:8876; no provider clients, credentials or paid resources.'));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
