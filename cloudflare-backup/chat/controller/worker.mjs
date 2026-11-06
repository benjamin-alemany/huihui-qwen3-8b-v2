import {DurableObject,WorkerEntrypoint} from 'cloudflare:workers';
import {collectGuardReadiness,safeTailFailure,cloudflareTailClient} from './tails.mjs';
import {SessionEngine} from './engine.mjs';
import {runpodClient} from './runpod.mjs';
import {SessionError,terminal,IMAGE} from './session-policy.mjs';
import {networkReleaseReady} from './network-release.mjs';
const object=env=>env.SESSION_CONTROLLER.getByName('owner-chat-controller-v1');
// The server-side launch lock and one-use approval remain OFF in production
// until the consolidated acceptance is approved. There is no public endpoint.
export class ChatSessionController extends DurableObject {
  engine(){
    const connected=!!this.env.RUNPOD_API_KEY,provider=connected?runpodClient(this.env.RUNPOD_API_KEY):null;
    const now=()=>Date.now();
    return new SessionEngine(this.ctx.storage,{now,id:()=>crypto.randomUUID(),hex:length=>Array.from(crypto.getRandomValues(new Uint8Array(length/2)),b=>b.toString(16).padStart(2,'0')).join(''),
      enabled:this.env.START_ENABLED==='true'&&networkReleaseReady(IMAGE),approval:this.env.APPROVED_ACCEPTANCE_ID??'',connected,key:this.env.RUNPOD_API_KEY,
      maxHourly:Number(this.env.MAX_SESSION_HOURLY_USD??'.60'),maxUSD:Number(this.env.MAX_ACCEPTANCE_USD??'.25'),
      provider,guards:[this.env.PRIMARY_GUARD,this.env.BACKUP_GUARD],
      catalog:()=>connected?provider.catalog():Promise.resolve(JSON.parse(this.env.PREPARED_CATALOG)),
      wake:ms=>this.ctx.storage.setAlarm(now()+(ms??100)),
      heartbeat:()=>collectGuardReadiness(this.env.CF_TAIL_TOKEN,null,{heartbeatOnly:true}),
      receipts:q=>collectGuardReadiness(this.env.CF_TAIL_TOKEN,q),
      checkVersions:async proof=>{const versions=await cloudflareTailClient(this.env.CF_TAIL_TOKEN).versions();for(const r of Object.values(proof.guards))if(versions[r.worker]!==r.version)throw new SessionError('GUARD_VERSION_CHANGED');}
    });
  }
  async status(){
    const readiness=await this.ctx.storage.get('readiness')??{phase:'not-checked'};
    return {...await this.engine().status(),readiness,networkBoundaryReady:networkReleaseReady(IMAGE)};
  }
  quote(){return this.engine().quote();}
  async start(input){try{if(this.env.START_ENABLED==='true'&&!networkReleaseReady(IMAGE))throw new SessionError('NETWORK_BOUNDARY_UNVERIFIED');const r=await this.ctx.storage.get('readiness');if(['pending','checking'].includes(r?.phase))throw new SessionError('READINESS_CHECK_ACTIVE');return await this.engine().start(input);}catch(e){return {error:e instanceof SessionError?e.code:'START_REFUSED',status:e instanceof SessionError?e.status:409};}}
  async stop(input){try{return await this.engine().stop(input);}catch{return {error:'STOP_UNCONFIRMED',status:503};}}
  context(){return this.engine().context();}
  async check(){
    if(!terminal((await this.engine().read()).session))throw new SessionError('SESSION_ALREADY_ACTIVE');
    if(this.env.READINESS_ENABLED!=='true'||!this.env.CF_TAIL_TOKEN)throw Error('Cloud guard verification is not configured');
    // The output gate commits both writes before returning to the owner. The
    // alarm keeps running in Cloudflare after browser/Codex/laptop closes.
    await this.ctx.storage.transaction(async tx=>{
      const prior=await tx.get('readiness'),now=Date.now();
      if(prior&&['pending','checking'].includes(prior.phase)&&prior.expiresAt>now)return;
      const readiness={id:crypto.randomUUID(),phase:'pending',requestedAt:now,expiresAt:now+170000};
      await tx.put('readiness',readiness);await tx.setAlarm(now+100);
    });
    return this.status();
  }
  async alarm(){
    if(!terminal((await this.engine().read()).session)){await this.engine().tick();return;}
    const state=await this.ctx.storage.get('readiness');
    if(!state||!['pending','checking'].includes(state.phase))return;
    if(state.expiresAt<=Date.now()){
      await this.ctx.storage.put('readiness',{...state,phase:'failed',code:'READINESS_EXPIRED',finishedAt:Date.now()});return;
    }
    // A replacement/retry alarm never grants launch readiness. It can retry
    // only this free read-only heartbeat check within its original window.
    await this.ctx.storage.transaction(async tx=>{await tx.put('readiness',{...state,phase:'checking'});await tx.setAlarm(state.expiresAt);});
    let next;
    try{
      const result=await collectGuardReadiness(this.env.CF_TAIL_TOKEN,null,{heartbeatOnly:true,timeoutMs:Math.min(125000,state.expiresAt-Date.now())});
      next={...state,phase:'verified',finishedAt:Date.now(),...result};
    }catch(error){
      next={...state,phase:'failed',code:safeTailFailure(error),finishedAt:Date.now()};
    }
    const current=await this.ctx.storage.get('readiness');
    if(current?.id!==state.id)return;
    await this.ctx.storage.transaction(async tx=>{await tx.put('readiness',next);await tx.deleteAlarm();});
  }
}
export class OwnerReadiness extends WorkerEntrypoint {
  status(){return object(this.env).status();}
  check(){return object(this.env).check();}
  async quote(){try{return await object(this.env).quote();}catch{return {error:'QUOTE_UNAVAILABLE',status:503};}}
  async start(input){try{return await object(this.env).start(input);}catch(e){return {error:e instanceof SessionError?e.code:'START_REFUSED',status:e instanceof SessionError?e.status:409};}}
  async stop(input){try{return await object(this.env).stop(input);}catch{return {error:'STOP_UNCONFIRMED',status:503};}}
}
// The owner-facing binding cannot return credentials. Only the trusted chat
// gateway has this separate binding; model outputs never select its arguments.
export class ChatInference extends WorkerEntrypoint {context(){return object(this.env).context();}}
export default {fetch(){return new Response('Not found',{status:404,headers:{'Cache-Control':'no-store'}});}};
