import {DurableObject} from "cloudflare:workers";
import {authenticate} from "../workstation/auth.mjs";
import {mutationAllowed} from "../workstation/policy.mjs";
import {Rejection,LIMITS,boundedJSON,sessionFrom,infer} from "./policy.mjs";
import {historyFrom,historyId,HISTORY_LIMITS} from './history.mjs';
const headers={"Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer",
  "Content-Security-Policy":"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "Permissions-Policy":"camera=(), microphone=(), geolocation=()"};
const json=(body,status=200)=>Response.json(body,{status,headers});
// Quota and explicit owner-saved text. Never stores a billing credential.
// All methods are available only through a private Worker binding, not HTTP routes.
export class ChatQuota extends DurableObject {
  constructor(ctx,env){super(ctx,env);this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS quota (nonce TEXT PRIMARY KEY, turns INTEGER, busy_until INTEGER, lease TEXT)");this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY,title TEXT NOT NULL,messages TEXT NOT NULL,updated_at INTEGER NOT NULL)");}
  savedList(){return this.ctx.storage.sql.exec('SELECT id,title,updated_at FROM conversations ORDER BY updated_at DESC,id LIMIT 20').toArray();}
  savedRead(id){historyId(id);const r=this.ctx.storage.sql.exec('SELECT * FROM conversations WHERE id=?',id).toArray()[0];return r?{id:r.id,title:r.title,messages:JSON.parse(r.messages),updated_at:r.updated_at}:null;}
  savedWrite(input){
    const c=historyFrom(input),sql=this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(()=>{
      if(sql.exec('SELECT COUNT(*) AS n FROM conversations').one().n>=HISTORY_LIMITS.conversations)return null;
      const id=crypto.randomUUID(),now=Date.now();sql.exec('INSERT INTO conversations VALUES (?,?,?,?)',id,c.title,JSON.stringify(c.messages),now);return {id,title:c.title,updated_at:now};
    });
  }
  savedDelete(id){historyId(id);this.ctx.storage.sql.exec('DELETE FROM conversations WHERE id=?',id);return {deleted:true};}
  acquire(binding){
    const s=binding??sessionFrom(this.env),now=Date.now(),sql=this.ctx.storage.sql;
    if(!/^[a-f0-9]{32}$/.test(s.nonce??'')||!Number.isFinite(s.deadline)||s.deadline<=now||s.deadline>now+30*60000)return null;
    // No await between related reads/writes: one synchronous SQLite transaction.
    return this.ctx.storage.transactionSync(()=>{
      const row=sql.exec("SELECT * FROM quota WHERE nonce = ?",s.nonce).toArray()[0];
      if(row && (row.busy_until>now||row.turns>=LIMITS.turns))return null;
      const lease=crypto.randomUUID();
      sql.exec("INSERT INTO quota VALUES (?,1,?,?) ON CONFLICT(nonce) DO UPDATE SET turns=turns+1,busy_until=excluded.busy_until,lease=excluded.lease",s.nonce,now+LIMITS.timeoutMs+5000,lease);
      sql.exec("DELETE FROM quota WHERE nonce <> ?",s.nonce);
      return {nonce:s.nonce,lease};
    });
  }
  release(ticket){
    if(!ticket||typeof ticket.nonce!=="string"||typeof ticket.lease!=="string")return;
    this.ctx.storage.sql.exec("UPDATE quota SET busy_until=0 WHERE nonce=? AND lease=?",ticket.nonce,ticket.lease);
  }
}
export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.origin!==env.CHAT_ORIGIN||url.search)return json({error:"Unknown origin or query"},403);
    if(!await authenticate(request,env))return json({error:"Owner login is not configured or authorized"},401);
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
    if(['/api/session/quote','/api/session/start','/api/session/stop'].includes(url.pathname)&&request.method==='POST'){
      if(!mutationAllowed(request,env.CHAT_ORIGIN))return json({error:'Invalid request origin or format'},403);
      try{
        const body=await boundedJSON(request.body,1024),action=url.pathname.split('/').at(-1);
        if(!body||Array.isArray(body)||typeof body!=='object')return json({error:'Invalid session request'},400);
        const keys=Object.keys(body).sort().join();
        if(keys!==(action==='quote'?'':action==='start'?'maximumUSD,quoteId':'sessionId'))return json({error:'Invalid session fields'},400);
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
      const id=url.pathname.slice('/api/history/'.length);
      if(request.method==='GET'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)){
        const item=await saved.savedRead(id);return item?json(item):json({error:'Saved chat not found'},404);
      }
      if(request.method!=='POST'||!mutationAllowed(request,env.CHAT_ORIGIN))return json({error:'Invalid request origin or format'},403);
      try{
        const body=await boundedJSON(request.body,HISTORY_LIMITS.bytes);
        if(url.pathname==='/api/history/save'){
          const item=await saved.savedWrite(historyFrom(body));return item?json(item,201):json({error:'Twenty chats are saved; export or delete one first'},429);
        }
        if(url.pathname==='/api/history/delete'&&body&&Object.keys(body).join()==='id')return json(await saved.savedDelete(historyId(body.id)));
        return json({error:'Not found'},404);
      }catch(e){return json({error:e instanceof Rejection?e.message:'Saved chat request failed'},e instanceof Rejection?e.status:400);}
    }
    if(request.method==="POST"&&url.pathname==="/api/chat"){
      if(!mutationAllowed(request,env.CHAT_ORIGIN))return json({error:"Invalid request origin or format"},403);
      let ticket,quota;
      try {
        const activeEnv=await inferenceEnv(),s=sessionFrom(activeEnv);
        const body=await boundedJSON(request.body,LIMITS.requestBytes);
        quota=env.CHAT_QUOTA.getByName("owner-chat-v1");ticket=await quota.acquire({nonce:s.nonce,deadline:s.deadline});
        if(!ticket)return json({error:"A reply is already running or the session turn limit was reached"},429);
        const result=await infer(body,activeEnv);
        if(sessionFrom(await inferenceEnv()).nonce!==s.nonce)throw new Rejection('Session changed or stopped',409);
        return json(result);
      }catch(e){
        return json({error:e instanceof Rejection?e.message:"Chat unavailable; no actions were executed"},e instanceof Rejection?e.status:502);
      }finally{if(ticket)try{await quota.release(ticket);}catch{/* Lease expires; never send a second model request. */}}
    }
    if(request.method!=="GET"||!["/","/index.html","/app.js","/session.js","/style.css"].includes(url.pathname))return json({error:"Not found"},404);
    const r=await env.ASSETS.fetch(request),h=new Headers(r.headers);
    for(const [key,value]of Object.entries(headers))h.set(key,value);
    return new Response(r.body,{status:r.status,headers:h});
  }
};
