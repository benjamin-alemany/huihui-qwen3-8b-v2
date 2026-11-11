import {DurableObject} from "cloudflare:workers";
import {authenticate} from "../workstation/auth.mjs";
import {mutationAllowed} from "../workstation/policy.mjs";
import {Rejection,LIMITS,boundedJSON,sessionFrom,infer,completionFrom} from "./policy.mjs";
import {historyFrom,historyBackupFrom,historyId,HISTORY_LIMITS,BACKUP_LIMITS,importPlan,conversationFromHistory,migrateHistorySnapshot,upsertFrom,turnFrom} from './history.mjs';
const headers={"Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer",
  "Content-Security-Policy":"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "Permissions-Policy":"camera=(), microphone=(), geolocation=()"};
const json=(body,status=200)=>Response.json(body,{status,headers});
// Quota and explicit owner-saved text. Never stores a billing credential.
// All methods are available only through a private Worker binding, not HTTP routes.
export class ChatQuota extends DurableObject {
  constructor(ctx,env){
    super(ctx,env);this.generationRunning=false;
    this.ctx.blockConcurrencyWhile(async()=>{
      const sql=this.ctx.storage.sql;
      this.ctx.storage.transactionSync(()=>{
        sql.exec("CREATE TABLE IF NOT EXISTS quota (nonce TEXT PRIMARY KEY, turns INTEGER, busy_until INTEGER, lease TEXT)");
        sql.exec("CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY,title TEXT NOT NULL,messages TEXT NOT NULL,updated_at INTEGER NOT NULL)");
        const columns=sql.exec('PRAGMA table_info(conversations)').toArray().map(c=>c.name);
        if(!columns.includes('revision'))sql.exec('ALTER TABLE conversations ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
        if(!columns.includes('draft')){
          sql.exec("ALTER TABLE conversations ADD COLUMN draft TEXT NOT NULL DEFAULT ''");
          for(const r of sql.exec('SELECT id,title,messages FROM conversations').toArray()){
            const c=migrateHistorySnapshot({title:r.title,messages:JSON.parse(r.messages)});
            sql.exec('UPDATE conversations SET messages=?,draft=? WHERE id=?',JSON.stringify(c.messages),c.draft,r.id);
          }
        }
        sql.exec('CREATE TABLE IF NOT EXISTS generation_turns (turn_id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,revision INTEGER NOT NULL,nonce TEXT NOT NULL,deadline INTEGER NOT NULL,lease TEXT NOT NULL,input_messages TEXT NOT NULL,status TEXT NOT NULL,error TEXT,item_snapshot TEXT,created_at INTEGER NOT NULL)');
      });
      await this.ensureGenerationAlarm();
    });
  }
  savedList(){return this.ctx.storage.sql.exec('SELECT id,title,revision,updated_at FROM conversations ORDER BY updated_at DESC,id LIMIT 20').toArray();}
  savedRead(id){historyId(id);const r=this.ctx.storage.sql.exec('SELECT * FROM conversations WHERE id=?',id).toArray()[0];return r?{id:r.id,revision:r.revision,title:r.title,messages:JSON.parse(r.messages),draft:r.draft,updated_at:r.updated_at}:null;}
  activeTurn(){return this.ctx.storage.sql.exec("SELECT * FROM generation_turns WHERE status IN ('pending','inflight') ORDER BY created_at,turn_id LIMIT 1").toArray()[0]??null;}
  savedUpsert(input){
    const c=upsertFrom(input),sql=this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(()=>{
      const item=c.id?this.savedRead(c.id):null;
      if(item&&this.activeTurn()?.conversation_id===c.id)return {error:'GENERATION_PENDING',status:409,item};
      if(item&&item.revision!==c.revision||!item&&c.revision!==0)return {error:'REVISION_CONFLICT',status:409,item};
      if(!item&&sql.exec('SELECT COUNT(*) AS n FROM conversations').one().n>=HISTORY_LIMITS.conversations)return {error:'Twenty chats are saved; export or delete one first',status:429};
      const id=c.id??crypto.randomUUID(),revision=(item?.revision??0)+1,now=Date.now();
      sql.exec('INSERT INTO conversations (id,title,messages,updated_at,revision,draft) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,messages=excluded.messages,updated_at=excluded.updated_at,revision=excluded.revision,draft=excluded.draft',id,c.title,JSON.stringify(c.messages),now,revision,c.draft);
      return {item:this.savedRead(id)};
    });
  }
  savedWrite(input){const c=migrateHistorySnapshot(historyFrom(input)),r=this.savedUpsert({id:null,revision:0,...c});return r.status===429?null:r.item;}
  savedDelete(id){
    historyId(id);const sql=this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(()=>{
      if(this.activeTurn()?.conversation_id===id)return {error:'GENERATION_PENDING',status:409,item:this.savedRead(id)};
      // Keep ID tombstones for at-most-once requests, but erase deleted chat text.
      sql.exec("UPDATE generation_turns SET input_messages='[]',item_snapshot=NULL,error='CONVERSATION_DELETED',status='failed' WHERE conversation_id=?",id);
      sql.exec('DELETE FROM conversations WHERE id=?',id);return {deleted:true};
    });
  }
  savedBackup(){return historyBackupFrom({format:'unjailed.chat-backup',version:2,conversations:this.savedList().map(r=>{const {title,messages,draft}=this.savedRead(r.id);return {title,messages,draft};})});}
  savedImport(input,preview=false){
    let backup;try{backup=historyBackupFrom(input);}catch(e){return {error:e.message,status:e.status??400};}const sql=this.ctx.storage.sql;
    try{return this.ctx.storage.transactionSync(()=>{
      const existing=this.savedList().map(r=>{const {title,messages,draft}=this.savedRead(r.id);return {title,messages,draft};}),p=importPlan(existing,backup);
      if(preview)return {importable:p.add.length,duplicates:p.duplicates,remainingSlots:p.remainingSlots,canImport:p.canImport};
      if(!p.canImport)return {error:'Not enough saved-chat slots. No chats were imported.',status:409};
      for(const c of p.add)sql.exec('INSERT INTO conversations (id,title,messages,updated_at,revision,draft) VALUES (?,?,?,?,1,?)',crypto.randomUUID(),c.title,JSON.stringify(c.messages),Date.now(),c.draft);
      return {imported:p.add.length,duplicates:p.duplicates};
    });}catch{return {error:'Import could not be confirmed. Refresh saved chats before retrying; identical snapshots are skipped.',status:503};}
  }
  acquireInTransaction(s){
    const now=Date.now(),sql=this.ctx.storage.sql;
    if(!/^[a-f0-9]{32}$/.test(s?.nonce??'')||!Number.isFinite(s.deadline)||s.deadline<=now||s.deadline>now+60*60000)return null;
    const row=sql.exec('SELECT * FROM quota WHERE nonce=?',s.nonce).toArray()[0];
    if(row&&(row.busy_until>now||row.turns>=LIMITS.turns))return null;
    const lease=crypto.randomUUID();sql.exec('INSERT INTO quota VALUES (?,1,?,?) ON CONFLICT(nonce) DO UPDATE SET turns=turns+1,busy_until=excluded.busy_until,lease=excluded.lease',s.nonce,now+LIMITS.timeoutMs+5000,lease);
    sql.exec('DELETE FROM quota WHERE nonce<>?',s.nonce);return {nonce:s.nonce,lease};
  }
  acquire(binding){return this.ctx.storage.transactionSync(()=>this.activeTurn()?null:this.acquireInTransaction(binding??sessionFrom(this.env)));}
  release(ticket){if(ticket&&typeof ticket.nonce==='string'&&typeof ticket.lease==='string')this.ctx.storage.sql.exec('UPDATE quota SET busy_until=0 WHERE nonce=? AND lease=?',ticket.nonce,ticket.lease);}
  turnRecord(id){historyId(id);return this.ctx.storage.sql.exec('SELECT * FROM generation_turns WHERE turn_id=?',id).toArray()[0]??null;}
  turnView(job){return {turnId:job.turn_id,status:job.status==='inflight'?'pending':job.status,conversationId:job.conversation_id,item:job.item_snapshot?JSON.parse(job.item_snapshot):this.savedRead(job.conversation_id),...(job.error?{error:job.error}:{})};}
  async ensureGenerationAlarm(){
    const current=await this.ctx.storage.getAlarm(),active=this.activeTurn(),soon=Date.now()+100;if(!active)return;
    if(current===null||active.status==='pending'&&current>soon)await this.ctx.storage.setAlarm(soon);
  }
  async turnRead(id){const job=this.turnRecord(id);if(!job)return null;await this.ensureGenerationAlarm();return this.turnView(job);}
  async activeInference(){
    let timer;try{return await Promise.race([this.env.INFERENCE_CONTROLLER.context(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Session context unavailable')),8000);})])??{};}finally{clearTimeout(timer);}
  }
  async turnQueue(input){
    const t=turnFrom(input),prior=this.turnRecord(t.turnId);
    if(prior){if(prior.conversation_id!==t.conversationId||prior.revision!==t.revision)return {error:'TURN_ID_REUSED',status:409,item:this.savedRead(t.conversationId)};await this.ensureGenerationAlarm();return this.turnView(prior);}
    let session;try{session=sessionFrom(await this.activeInference());}catch{return {error:'SESSION_CLOSED',status:409,item:this.savedRead(t.conversationId)};}
    const result=this.ctx.storage.transactionSync(()=>{
      const duplicate=this.turnRecord(t.turnId);if(duplicate)return duplicate.conversation_id===t.conversationId&&duplicate.revision===t.revision?this.turnView(duplicate):{error:'TURN_ID_REUSED',status:409,item:this.savedRead(t.conversationId)};
      const item=this.savedRead(t.conversationId);
      if(!item||item.revision!==t.revision)return {error:'REVISION_CONFLICT',status:409,item};
      if(this.activeTurn())return {error:'GENERATION_PENDING',status:409,item};
      if(!item.draft.trim())return {error:'EMPTY_DRAFT',status:400,item};
      const messages=[...item.messages,{role:'user',content:item.draft}];completionFrom({messages});
      const ticket=this.acquireInTransaction(session);if(!ticket)return {error:'A reply is already running or the session turn limit was reached',status:429,item};
      this.ctx.storage.sql.exec("INSERT INTO generation_turns (turn_id,conversation_id,revision,nonce,deadline,lease,input_messages,status,created_at) VALUES (?,?,?,?,?,?,?,'pending',?)",t.turnId,t.conversationId,t.revision,session.nonce,session.deadline,ticket.lease,JSON.stringify(messages),Date.now());
      return this.turnView(this.turnRecord(t.turnId));
    });
    if(!result.error)await this.ensureGenerationAlarm();return result;
  }
  async finishTurn(job,status,error,result){
    this.ctx.storage.transactionSync(()=>{
      const current=this.turnRecord(job.turn_id);if(!current||!['pending','inflight'].includes(current.status))return;
      let item=this.savedRead(job.conversation_id);
      if(result){
        if(!item||item.revision!==job.revision){status='interrupted';error='CONVERSATION_CHANGED';}
        else{
          const c=conversationFromHistory({title:item.title,messages:[...JSON.parse(job.input_messages),{role:'assistant',content:result.content}],draft:''});
          this.ctx.storage.sql.exec('UPDATE conversations SET messages=?,draft=?,revision=revision+1,updated_at=? WHERE id=?',JSON.stringify(c.messages),'',Date.now(),item.id);item=this.savedRead(item.id);
        }
      }
      this.ctx.storage.sql.exec("UPDATE generation_turns SET status=?,error=?,item_snapshot=?,input_messages='[]' WHERE turn_id=?",status,error??null,item?JSON.stringify(item):null,job.turn_id);
      this.release({nonce:job.nonce,lease:job.lease});
    });
    // Retire this job's watchdog, then preserve any newly queued job's alarm.
    await this.ctx.storage.deleteAlarm();await this.ensureGenerationAlarm();
  }
  async alarm(){
    if(this.generationRunning)return;
    const job=this.activeTurn();if(!job)return;
    // Alarm delivery is at-least-once. An old in-flight marker must NEVER send
    // another inference request after eviction, timeout or process failure.
    if(job.status==='inflight'){await this.finishTurn(job,'interrupted','GENERATION_INTERRUPTED');return;}
    this.generationRunning=true;let attempted=false;
    try{
      this.ctx.storage.sql.exec("UPDATE generation_turns SET status='inflight' WHERE turn_id=? AND status='pending'",job.turn_id);
      await this.ctx.storage.setAlarm(Date.now()+LIMITS.timeoutMs+20000);
      const activeEnv=await this.activeInference(),session=sessionFrom(activeEnv);
      if(session.nonce!==job.nonce||session.deadline!==job.deadline)throw new Rejection('Session changed',409);
      attempted=true;const result=await infer({messages:JSON.parse(job.input_messages)},activeEnv);
      const finalSession=sessionFrom(await this.activeInference());
      if(finalSession.nonce!==job.nonce||finalSession.deadline!==job.deadline||Date.now()>=job.deadline)throw new Rejection('Session changed',409);
      await this.finishTurn(job,'completed',null,result);
    }catch{await this.finishTurn(job,attempted?'interrupted':'failed',attempted?'GENERATION_UNCONFIRMED':'SESSION_CLOSED');}
    finally{this.generationRunning=false;}
  }
}
export default {
  async fetch(request,env){
    const url=new URL(request.url);
    const logoutReturn=request.method==='GET'&&url.pathname==='/'&&url.search==='?__cf_access_message=logged_out';
    if(url.origin!==env.CHAT_ORIGIN||url.search&&!logoutReturn)return json({error:"Unknown origin or query"},403);
    if(!await authenticate(request,env))return json({error:"Owner login is not configured or authorized"},401);
    if(logoutReturn)return new Response(null,{status:302,headers:{...headers,Location:'/'}});
    const history=env.HISTORY_ENABLED==='true'?'private-cloud-opt-in':'tab-memory-only';
    // Never fall back to a static session when dynamic cloud control is enabled.
    const inferenceEnv=async()=>env.SESSION_CONTROLLER_ENABLED==='true'?(await env.INFERENCE_CONTROLLER.context()??{}):env;
    if(url.pathname==='/api/controller/status'&&request.method==='GET'){
      try{return json(await env.CONTROLLER.status());}catch{return json({error:'Cloud controller unavailable',launchEnabled:false},503);}
    }
    if(url.pathname==='/api/controller/check'&&request.method==='POST'){
      if(!mutationAllowed(request,env.CHAT_ORIGIN))return json({error:'Invalid request origin or format'},403);
      try{
        const body=await boundedJSON(request.body,1024);
        if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)return json({error:'This check accepts no parameters'},400);
        return json(await env.CONTROLLER.check(),202);
      }catch{return json({error:'Cloud guard check unavailable; no GPU was started',launchEnabled:false},503);}
    }
    if(['/api/session/quote','/api/session/start','/api/session/stop','/api/session/grant'].includes(url.pathname)&&request.method==='POST'){
      if(!mutationAllowed(request,env.CHAT_ORIGIN))return json({error:'Invalid request origin or format'},403);
      try{
        const body=await boundedJSON(request.body,1024),action=url.pathname.split('/').at(-1);
        if(!body||Array.isArray(body)||typeof body!=='object')return json({error:'Invalid session request'},400);
        const keys=Object.keys(body).sort().join();
        if(action==='quote'?!(keys===''||keys==='minutes'&&[15,30,60].includes(body.minutes)):keys!==(action==='start'?'maximumUSD,quoteId':action==='grant'?'amountUSD,grantId':'sessionId'))return json({error:'Invalid session fields'},400);
        if(action==='grant'&&(!Number.isFinite(body.amountUSD)||body.amountUSD<=0||body.amountUSD>10))return json({error:'Invalid spending grant'},400);
        if(action==='grant')historyId(body.grantId);
        const result=await env.CONTROLLER[action](body);return json(result,result.error?(result.status??409):action==='quote'?200:202);
      }catch{return json({error:'Session request could not be confirmed. Refresh status; do not repeat Start.',launchEnabled:false},503);}
    }
    if(request.method==="GET"&&url.pathname==="/api/status"){
      try {const s=sessionFrom(await inferenceEnv());return json({chatEnabled:true,deadline:new Date(s.deadline).toISOString(),agentToolsEnabled:false,history});}
      catch {return json({chatEnabled:false,agentToolsEnabled:false,history,reason:env.SESSION_CONTROLLER_ENABLED==='true'?'Chat is closed while the session is starting, stopping or locked. Check session status.':String(env.CHAT_STATUS??"No session is armed").slice(0,160)});}
    }
    if(url.pathname==='/api/history'||url.pathname.startsWith('/api/history/')){
      if(env.HISTORY_ENABLED!=='true')return json({error:'Saved chats are not enabled'},404);
      const saved=env.CHAT_QUOTA.getByName('owner-saved-chats-v1');
      if(request.method==='GET'&&url.pathname==='/api/history')return json({items:await saved.savedList()});
      if(request.method==='GET'&&url.pathname==='/api/history/backup')return json(await saved.savedBackup());
      const id=url.pathname.slice('/api/history/'.length);
      if(request.method==='GET'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)){
        const item=await saved.savedRead(id);return item?json(item):json({error:'Saved chat not found'},404);
      }
      if(request.method!=='POST'||!mutationAllowed(request,env.CHAT_ORIGIN))return json({error:'Invalid request origin or format'},403);
      try{
        const importing=['/api/history/import','/api/history/import/preview'].includes(url.pathname);
        const body=await boundedJSON(request.body,importing?BACKUP_LIMITS.bytes:HISTORY_LIMITS.bytes);
        if(importing){
          // Validate before RPC as well: remote exception types do not preserve instanceof.
          const backup=historyBackupFrom(body),result=await saved.savedImport(backup,true);
          if(result.error)return json(result,result.status??503);
          if(url.pathname.endsWith('/preview'))return json(result);
          if(!result.canImport)return json({error:'Not enough saved-chat slots. No chats were imported.'},409);
          const imported=await saved.savedImport(backup);return json(imported,imported.error?(imported.status??503):201);
        }
        if(url.pathname==='/api/history/save'){
          const item=await saved.savedWrite(historyFrom(body));return item?json(item,201):json({error:'Twenty chats are saved; export or delete one first'},429);
        }
        if(url.pathname==='/api/history/upsert'){const result=await saved.savedUpsert(upsertFrom(body));return json(result,result.status??200);}
        if(url.pathname==='/api/history/delete'&&body&&Object.keys(body).join()==='id'){const result=await saved.savedDelete(historyId(body.id));return json(result,result.status??200);}
        return json({error:'Not found'},404);
      }catch(e){return json({error:e instanceof Rejection?e.message:'Saved chat request failed'},e instanceof Rejection?e.status:400);}
    }
    if(url.pathname==='/api/turns'||url.pathname.startsWith('/api/turns/')){
      if(env.HISTORY_ENABLED!=='true')return json({error:'Saved chats are not enabled'},404);
      const saved=env.CHAT_QUOTA.getByName('owner-saved-chats-v1');
      try{
        if(request.method==='GET'&&url.pathname.startsWith('/api/turns/')){
          const result=await saved.turnRead(historyId(url.pathname.slice('/api/turns/'.length)));return result?json(result):json({error:'Generation not found'},404);
        }
        if(request.method!=='POST'||url.pathname!=='/api/turns')return json({error:'Not found'},404);
        if(!mutationAllowed(request,env.CHAT_ORIGIN))return json({error:'Invalid request origin or format'},403);
        const result=await saved.turnQueue(turnFrom(await boundedJSON(request.body,1024)));
        return json(result,typeof result.status==='number'?result.status:202);
      }catch(e){return json({error:e instanceof Rejection?e.message:'Generation request unconfirmed; check the same turn ID before retrying'},e instanceof Rejection?e.status:503);}
    }
    if(request.method==="POST"&&url.pathname==="/api/chat"){
      if(!mutationAllowed(request,env.CHAT_ORIGIN))return json({error:"Invalid request origin or format"},403);
      let ticket,quota;
      try {
        const activeEnv=await inferenceEnv(),s=sessionFrom(activeEnv);
        const body=await boundedJSON(request.body,LIMITS.requestBytes);
        quota=env.CHAT_QUOTA.getByName("owner-saved-chats-v1");ticket=await quota.acquire({nonce:s.nonce,deadline:s.deadline});
        if(!ticket)return json({error:"A reply is already running or the session turn limit was reached"},429);
        const result=await infer(body,activeEnv);
        if(sessionFrom(await inferenceEnv()).nonce!==s.nonce)throw new Rejection('Session changed or stopped',409);
        return json(result);
      }catch(e){
        return json({error:e instanceof Rejection?e.message:"Chat unavailable; no actions were executed"},e instanceof Rejection?e.status:502);
      }finally{if(ticket)try{await quota.release(ticket);}catch{/* Lease expires; never send a second model request. */}}
    }
    if(request.method!=="GET"||!["/","/index.html","/app.js","/recovery.js","/session.js","/session-ui.js","/session-policy-ui.js","/release-ui.js","/autosave.js","/style.css"].includes(url.pathname))return json({error:"Not found"},404);
    const r=await env.ASSETS.fetch(request),h=new Headers(r.headers);
    for(const [key,value]of Object.entries(headers))h.set(key,value);
    return new Response(r.body,{status:r.status,headers:h});
  }
};
