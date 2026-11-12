import {parseOperatorBudget} from './budget-reconcile.mjs';
import {DurableObject,WorkerEntrypoint} from 'cloudflare:workers';
import {collectGuardReadiness,safeTailFailure,cloudflareTailClient} from './tails.mjs';
import {SessionEngine} from './engine.mjs';
import {runpodClient} from './runpod.mjs';
import {SessionError,terminal,IMAGE,parseOriginalAcceptance} from './session-policy.mjs';
import {networkReleaseReady} from './network-release.mjs';
import {hyperstackControllerFactory} from '../hyperstack/controller-factory.mjs';
import {renderCloudInit,bootstrapRenderReady} from '../hyperstack/bootstrap-render.mjs';
import {parseOperatorAbsence} from '../hyperstack/operator-absence.mjs';
import {reconcileControllerOperatorAbsence} from '../hyperstack/controller-operator-absence.mjs';
import {parseOperatorRejection} from '../hyperstack/operator-rejection.mjs';
import {reconcileControllerOperatorRejection} from '../hyperstack/controller-operator-rejection.mjs';
import bootstrapBundle from '../../../release/bootstrap-payload.json' with {type:'json'};
const object=env=>env.SESSION_CONTROLLER.getByName('owner-chat-controller-v1');
const operatorRecoveryActive=env=>env.OPERATOR_ABSENCE_RECONCILIATION_JSON!==undefined||env.OPERATOR_CREATE_REJECTION_JSON!==undefined;
// Paid Start and the reviewed network-image gate remain locked in production.
// Owner grants authorize application usage only; no payment or provider top-up.
export class ChatSessionController extends DurableObject {
  #tailAccountId(){
    const lane=this.env.HOSTING_PROVIDER;
    return this.env.CLOUDFLARE_ACCOUNT_ID??(lane===undefined||lane===''||lane==='runpod'?undefined:'');
  }
  #configuration(){
    const selected=this.env.HOSTING_PROVIDER;
    if(selected===undefined||selected===''||selected==='runpod')return null;
    if(selected==='hyperstack'){
      // Prepared source and hash-bound bundle do not approve a paid launch.
      // Null acceptance/production pins and explicit owner authorization gates
      // remain independent of these callbacks and deployment flags.
      return hyperstackControllerFactory({env:this.env,storage:this.ctx.storage,bundle:bootstrapBundle,renderBootstrap:renderCloudInit,bootstrapReady:bootstrapRenderReady,
        runtimeOrchestratorReady:(release,bundle)=>release.artifact?.runtimeOrchestrator==='vm-run-v1'&&bootstrapRenderReady(release,bundle)});
    }
    const blocked=hyperstackControllerFactory({env:{...this.env,HYPERSTACK_API_KEY:undefined,HYPERSTACK_TARGET_JSON:undefined},storage:this.ctx.storage});
    return {...blocked,connected:false,enabled:false,readiness:{...blocked.readiness,provider:'invalid',blockers:['HOSTING_PROVIDER_INVALID',...blocked.readiness.blockers]}};
  }
  engine(){
    const selected=this.#configuration();
    const connected=selected?selected.connected:!!this.env.RUNPOD_API_KEY,provider=selected?.provider??(connected?runpodClient(this.env.RUNPOD_API_KEY):null);
    const now=()=>Date.now(),validationMode=this.env.VALIDATION_MODE==='true';let operatorBudget;try{operatorBudget=parseOperatorBudget(this.env.OPERATOR_BUDGET_RECONCILIATION);}catch{operatorBudget={invalid:true};}
    let originalAcceptance;try{originalAcceptance=parseOriginalAcceptance(this.env.ORIGINAL_ACCEPTANCE_JSON)??undefined;}catch{originalAcceptance=null;}
    return new SessionEngine(this.ctx.storage,{now,id:()=>crypto.randomUUID(),hex:length=>Array.from(crypto.getRandomValues(new Uint8Array(length/2)),b=>b.toString(16).padStart(2,'0')).join(''),
      operatorBudget:selected?.operatorBudget??operatorBudget,validationMode,enabled:!operatorRecoveryActive(this.env)&&(selected?selected.enabled:this.env.START_ENABLED==='true'&&networkReleaseReady(IMAGE)&&(!validationMode||operatorBudget!==null&&!operatorBudget.invalid)),approval:this.env.APPROVED_ACCEPTANCE_ID??'',connected,key:selected?selected.key:this.env.RUNPOD_API_KEY,
      originalAcceptance:selected?selected.originalAcceptance:originalAcceptance,
      ...(selected?{lifecycle:selected.lifecycle}:{}),
      maxHourly:Number(this.env.MAX_SESSION_HOURLY_USD??'.60'),maxUSD:Number(this.env.MAX_ACCEPTANCE_USD??'.25'),
      provider,guards:[this.env.PRIMARY_GUARD,this.env.BACKUP_GUARD],
      catalog:selected?selected.catalog:()=>connected?provider.catalog():Promise.resolve(JSON.parse(this.env.PREPARED_CATALOG)),
      wake:ms=>this.ctx.storage.setAlarm(now()+(ms??100)),
      heartbeat:()=>collectGuardReadiness(this.env.CF_TAIL_TOKEN,null,{accountId:this.#tailAccountId(),heartbeatOnly:true}),
      receipts:q=>collectGuardReadiness(this.env.CF_TAIL_TOKEN,q,{accountId:this.#tailAccountId()}),
      checkVersions:async proof=>{const versions=await cloudflareTailClient(this.env.CF_TAIL_TOKEN,{accountId:this.#tailAccountId()}).versions();for(const r of Object.values(proof.guards))if(versions[r.worker]!==r.version)throw new SessionError('GUARD_VERSION_CHANGED');}
    });
  }
  async status(){
    const readiness=await this.ctx.storage.get('readiness')??{phase:'not-checked'},selected=this.#configuration();
    return {...await this.engine().status(),readiness,networkBoundaryReady:selected?selected.readiness.sourceApproved&&selected.readiness.runtimeOrchestratorPrepared:networkReleaseReady(IMAGE),
      hostingProvider:selected?.readiness.provider??'runpod',operatorRecovery:await this.ctx.storage.get('operator-absence-status-v1')??null,operatorCreateRejection:await this.ctx.storage.get('operator-create-rejection-status-v1')??null,...(selected?{providerReadiness:selected.readiness,launchBlockers:selected.readiness.blockers}:{})};
  }
  async quote(input){try{return await this.engine().quote(input);}catch(e){return {error:e instanceof SessionError?e.code:'QUOTE_UNAVAILABLE',status:e instanceof SessionError?e.status:503};}}
  async grant(input){try{return await this.engine().grant(input);}catch(e){return {error:e instanceof SessionError?e.code:'GRANT_REFUSED',status:e instanceof SessionError?e.status:409};}}
  async start(input){try{if(operatorRecoveryActive(this.env))throw new SessionError('OPERATOR_RECOVERY_ACTIVE');const selected=this.#configuration();if(selected){if(!selected.enabled)throw new SessionError(selected.readiness.blockers[0]??'LAUNCH_LOCKED',503);}else if(this.env.START_ENABLED==='true'&&!networkReleaseReady(IMAGE))throw new SessionError('NETWORK_BOUNDARY_UNVERIFIED');const r=await this.ctx.storage.get('readiness');if(['pending','checking'].includes(r?.phase))throw new SessionError('READINESS_CHECK_ACTIVE');return await this.engine().start(input);}catch(e){return {error:e instanceof SessionError?e.code:'START_REFUSED',status:e instanceof SessionError?e.status:409};}}
  async stop(input){try{return await this.engine().stop(input);}catch{return {error:'STOP_UNCONFIRMED',status:503};}}
  context(){if(operatorRecoveryActive(this.env))return null;const selected=this.#configuration();if(selected&&(!selected.readiness.sourceApproved||!selected.readiness.runtimeOrchestratorPrepared||!selected.connected))return null;return this.engine().context();}
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
    if(this.env.OPERATOR_CREATE_REJECTION_JSON!==undefined){
      try{
        if(this.env.OPERATOR_ABSENCE_RECONCILIATION_JSON!==undefined||this.env.START_ENABLED!=='false'||this.env.VALIDATION_MODE!=='true'||this.env.HOSTING_PROVIDER!=='hyperstack')throw new SessionError('OPERATOR_REJECTION_LOCK_REQUIRED',503);
        const engine=this.engine(),packet=parseOperatorRejection(this.env.OPERATOR_CREATE_REJECTION_JSON,{target:engine.lifecycle.target,now:Date.now()});
        const result=await reconcileControllerOperatorRejection(engine,packet);
        await this.ctx.storage.put('operator-create-rejection-status-v1',{id:packet.id,phase:result.complete?'verified':'waiting',at:Date.now(),providerRejected:result.complete===true,settledUnits:result.complete?0:null,acceptancePassed:false});
        if(!result.complete)await this.ctx.storage.setAlarm(Date.now()+10000);
        else if(!result.replayed)console.log(JSON.stringify({event:'operator_create_rejection_reconciled',reconciliationId:packet.id,sessionId:packet.sessionId,approvalId:packet.approvalId,provider:'hyperstack',status:'verified',settledUnits:0,acceptancePassed:false,at:new Date().toISOString()}));
        return;
      }catch(error){
        const code=error instanceof SessionError?error.code:'OPERATOR_REJECTION_UNCONFIRMED';
        await this.ctx.storage.put('operator-create-rejection-status-v1',{phase:'refused',code,at:Date.now()});
        console.warn(JSON.stringify({event:'operator_create_rejection_refused',code,at:new Date().toISOString()}));
        await this.ctx.storage.setAlarm(Date.now()+10000);return;
      }
    }
    if(this.env.OPERATOR_ABSENCE_RECONCILIATION_JSON!==undefined){
      try{
        const engine=this.engine();
        if(this.env.START_ENABLED!=='false'||this.env.VALIDATION_MODE!=='true'||this.env.HOSTING_PROVIDER!=='hyperstack')throw new SessionError('OPERATOR_ABSENCE_LOCK_REQUIRED',503);
        const packet=parseOperatorAbsence(this.env.OPERATOR_ABSENCE_RECONCILIATION_JSON,{target:engine.lifecycle.target,now:Date.now()});
        const result=await reconcileControllerOperatorAbsence(engine,packet);
        await this.ctx.storage.put('operator-absence-status-v1',{id:packet.id,phase:result.complete?'verified':'waiting',at:Date.now(),billingSettlementPending:true});
        if(!result.complete)await this.ctx.storage.setAlarm(Date.now()+10000);
        return;
      }catch(error){
        await this.ctx.storage.put('operator-absence-status-v1',{phase:'refused',code:error instanceof SessionError?error.code:'OPERATOR_ABSENCE_UNCONFIRMED',at:Date.now()});
        await this.ctx.storage.setAlarm(Date.now()+10000);return;
      }
    }
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
      const result=await collectGuardReadiness(this.env.CF_TAIL_TOKEN,null,{accountId:this.#tailAccountId(),heartbeatOnly:true,timeoutMs:Math.min(125000,state.expiresAt-Date.now())});
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
  async quote(input){try{return await object(this.env).quote(input);}catch{return {error:'QUOTE_UNAVAILABLE',status:503};}}
  async grant(input){try{return await object(this.env).grant(input);}catch{return {error:'GRANT_REFUSED',status:409};}}
  async start(input){try{return await object(this.env).start(input);}catch(e){return {error:e instanceof SessionError?e.code:'START_REFUSED',status:e instanceof SessionError?e.status:409};}}
  async stop(input){try{return await object(this.env).stop(input);}catch{return {error:'STOP_UNCONFIRMED',status:503};}}
}
// The owner-facing binding cannot return credentials. Only the trusted chat
// gateway has this separate binding; model outputs never select its arguments.
export class ChatInference extends WorkerEntrypoint {context(){return object(this.env).context();}}
export default {fetch(){return new Response('Not found',{status:404,headers:{'Cache-Control':'no-store'}});}};
