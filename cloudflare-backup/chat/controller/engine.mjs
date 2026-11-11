import {applyOperatorBudget} from './budget-reconcile.mjs';
import {SEED,SCALE,SessionError,terminal,catalogFrom,makeQuote,reservation,podMatches,validatePod,createBody,safeSession,budgetView,ordinaryBudgetView,parseGrant,quoteMinutes,sessionMinutes,startupMinutes,receiptFresh,IMAGE,GPU,DISK_GB} from './session-policy.mjs';
const recordKey='session-ledger-v1';
const legacyLifecycle={catalogFrom,makeQuote,reservation,matches:podMatches,validate:validatePod,createBody,receiptFresh,quoteMinutes,cleanupComplete:r=>r===true,priceAccept:(p,s)=>p.cost<=s.quote.gpuHourlyUSD,isRunning:p=>p.status==='RUNNING',isFailed:p=>['EXITED','ERROR'].includes(p.status),context:s=>({CHAT_ENABLED:'true',CHAT_SESSION:JSON.stringify({podId:s.pod.id,createdAt:new Date(s.bootAt).toISOString(),nonce:s.nonce,minutes:sessionMinutes(s)}),INFERENCE_API_KEY:s.inferenceKey})};
const knownPodIds=s=>[...new Set([...(s.knownPodIds??[]),...(s.pod?[s.pod.id]:[])])];
function keylessGuardProof(proof,q,verifiedAt){
 const pick=(value,keys)=>Object.fromEntries(keys.filter(k=>['string','number'].includes(typeof value?.[k])).map(k=>[k,value[k]]));
 return {verifiedAt,...pick(q,['provider','ownershipPolicy','name','image','nonce','deadline']),guards:Object.fromEntries(['primary','backup'].map(role=>[role,{role,...pick(proof.guards[role],['worker','version','eventTimestamp','mode','nonce','expiry','ownershipPolicy'])}]))};
}
// All account state is durable. No network I/O runs inside a transaction.
export class SessionEngine {
  constructor(storage,deps){this.storage=storage;this.d=deps;this.lifecycle=deps.lifecycle??legacyLifecycle;}
  async tx(fn,wakeAt){return this.storage.transaction(async tx=>{
    const r=await tx.get(recordKey)??{ledger:structuredClone(SEED),session:null,quotes:[]};
    // Preserve the historical test ledger; ordinary owner grants start at zero.
    r.ordinaryLedger??={version:1,cap:0,spent:0,held:0,grantCount:0};
    try{applyOperatorBudget(r,this.d.operatorBudget);r.operatorBudgetReconciliation={ready:true};}
    catch(e){if(!(e instanceof SessionError)||!e.code?.startsWith('OPERATOR_BUDGET_'))throw e;r.operatorBudgetReconciliation={ready:false,code:e.code};}
    const result=await fn(r,tx);await tx.put(recordKey,r);if(wakeAt!==undefined)await tx.setAlarm(wakeAt);return result;
  });}
  async read(){return this.tx(r=>structuredClone(r));}
  currentBinding(){return this.lifecycle.binding??JSON.stringify({provider:'runpod-legacy',image:IMAGE,gpu:GPU,disk:DISK_GB});}
  budgetKind(){return this.d.validationMode===true?'test':'ordinary';}
  funding(r,s){return s.budgetKind==='ordinary'?r.ordinaryLedger:r.ledger;}
  canAllocate(r){return !r.cleanupIncidents?.some(i=>!i.resolved)&&terminal(r.session)&&r.ledger.held===0&&r.ordinaryLedger.held===0&&(!r.session?.createAttempted||r.session.phase==='stopped'||r.session.definiteNoCreate===true);}
  launchEnabled(r){return !!(this.d.enabled&&this.d.connected&&this.canAllocate(r)&&r.operatorBudgetReconciliation?.ready!==false&&(this.budgetKind()==='test'?this.d.approval&&!r.ledger.usedApprovals.includes(this.d.approval):r.ordinaryLedger.cap-r.ordinaryLedger.spent-r.ordinaryLedger.held>0));}
  views(r){const ordinary=ordinaryBudgetView(r.ordinaryLedger);return {budget:ordinary,ordinaryBudget:ordinary,testBudget:budgetView(r.ledger,this.d.originalAcceptance),budgetMode:this.budgetKind()};}
  async status(){const r=await this.read();return {launchEnabled:this.launchEnabled(r),agentToolsEnabled:false,terminalEnabled:false,session:safeSession(r.session),cleanupAttention:!!r.cleanupIncidents?.some(i=>!i.resolved),...this.views(r),operatorBudgetReconciliation:r.operatorBudgetReconciliation};}
  async grant(input){
    if(this.d.validationMode===true)throw new SessionError('ORDINARY_ALLOWANCE_DISABLED_DURING_ACCEPTANCE');
    const grant=parseGrant(input);
    await this.tx(async(r,tx)=>{
      const key='ordinary-grant-v1:'+grant.id,prior=await tx.get(key);
      if(prior){if(prior.amountUnits!==grant.amountUnits)throw new SessionError('GRANT_ID_REUSED');return;}
      if(!Number.isSafeInteger(r.ordinaryLedger.cap+grant.amountUnits)||!Number.isSafeInteger(r.ordinaryLedger.grantCount+1))throw new SessionError('GRANT_LIMIT');
      r.ordinaryLedger.cap+=grant.amountUnits;r.ordinaryLedger.grantCount++;
      await tx.put(key,{amountUnits:grant.amountUnits,grantedAt:this.d.now()});
    });
    return this.status();
  }
  async quote(input){
    const minutes=this.lifecycle.quoteMinutes(input,this.d.validationMode===true);
    const raw=await this.d.catalog(),catalog=this.lifecycle.catalogFrom(raw),q={...this.lifecycle.makeQuote(catalog,this.d.now(),this.d.id(),minutes),live:!!this.d.connected,budgetKind:this.budgetKind(),lifecycleBinding:this.currentBinding()};
    const ceiling=this.d.maxHourly??1;
    if(!Number.isFinite(ceiling)||ceiling<=0||ceiling>1||catalog.totalHourly>ceiling)throw new SessionError('PRICE_CHANGED');
    return this.tx(r=>{r.quotes=[...r.quotes.slice(-19),q];return {...q,holdUnits:undefined,lifecycleBinding:undefined,launchEnabled:this.launchEnabled(r),...this.views(r),includes:q.includes??'GPU, 60 GB temporary disk, cold start and 5-minute stop/cleanup margin',excludes:q.excludes??'Tax/FX if applicable; existing domain; provider outages can exceed operational allowance'};});
  }
  async start(input){
    if(!input||Object.keys(input).sort().join()!=='maximumUSD,quoteId'||typeof input.quoteId!=='string')throw new SessionError('INVALID_START',400);
    await this.tx(async(r,tx)=>{
      if(r.session?.quoteId===input.quoteId)return; // Idempotent even after cleanup.
      if(r.operatorBudgetReconciliation?.ready===false)throw new SessionError(r.operatorBudgetReconciliation.code);
      const kind=this.budgetKind();
      if(!this.d.enabled||!this.d.connected||(kind==='test'&&!this.d.approval))throw new SessionError('LAUNCH_LOCKED');
      if(!this.canAllocate(r))throw new SessionError('SESSION_ALREADY_ACTIVE');
      if(kind==='test'&&r.ledger.usedApprovals.includes(this.d.approval))throw new SessionError('APPROVAL_ALREADY_USED');
      const q=r.quotes.find(q=>q.id===input.quoteId);
      if(!q||!q.live||q.expiresAt<=this.d.now())throw new SessionError('QUOTE_EXPIRED');
      if(q.lifecycleBinding!==this.currentBinding())throw new SessionError('QUOTE_CHANGED');
      if((q.budgetKind??'test')!==kind)throw new SessionError('QUOTE_CHANGED');
      if(input.maximumUSD!==q.maximumUSD)throw new SessionError('QUOTE_CHANGED');
      const maxUSD=kind==='test'?(this.d.maxUSD??.25):10;
      if(!Number.isFinite(maxUSD)||maxUSD<=0||q.maximumUSD>maxUSD)throw new SessionError('APPROVAL_LIMIT');
      if(q.availability==='NONE')throw new SessionError('NO_STOCK');
      const ledger=kind==='ordinary'?r.ordinaryLedger:r.ledger;
      if(ledger.cap-ledger.spent-ledger.held<q.holdUnits)throw new SessionError('BUDGET_EXHAUSTED');
      const marker='session-start-v1:'+q.id;
      if(await tx.get(marker))throw new SessionError('QUOTE_ALREADY_USED');
      ledger.held+=q.holdUnits;
      r.session={id:this.d.id(),quoteId:q.id,quote:q,budgetKind:kind,approval:kind==='test'?this.d.approval:null,phase:'preflight',requestedAt:this.d.now(),stopRequested:false,createAttempted:false,leaseUntil:0};
      await tx.put(marker,{sessionId:r.session.id,budgetKind:kind});
    },this.d.now()+100);
    return this.status();
  }
  async stop(input){
    if(!input||Object.keys(input).join()!=='sessionId')throw new SessionError('INVALID_STOP',400);
    const s=await this.tx(r=>{if(!r.session||r.session.id!==input.sessionId)throw new SessionError('SESSION_CHANGED');if(!terminal(r.session)){r.session.stopRequested=true;r.session.stopAt??=this.d.now();}return structuredClone(r.session);},this.d.now()+100);
    // Fan out to BOTH independent guards; a failure in one cannot skip the other.
    if(!terminal(s)&&s.reservation)await Promise.allSettled(this.d.guards.map(g=>g.shorten(s.reservation.name,s.stopAt)));
    await this.d.wake();return this.status();
  }
  async context(){
    const s=(await this.read()).session;
    if(s?.phase!=='ready'||s.stopRequested||this.d.now()>=s.deadline)return null;
    return this.lifecycle.context(s);
  }
  async update(id,fn){return this.tx(r=>{if(r.session?.id!==id)throw new SessionError('SESSION_CHANGED');return fn(r.session,r);});}
  async rememberPods(s,pods){
    // Keep every observation before any cleanup I/O, not just the chat Pod.
    // The legacy pod field remains evidence for already-persisted sessions.
    s.knownPodIds=await this.update(s.id,current=>{
      current.knownPodIds=[...new Set([...knownPodIds(current),...pods.map(p=>p.id)])];
      if(this.d.lifecycle){current.knownAllocations??=[];for(const p of pods)if(!current.knownAllocations.some(a=>a.id===p.id))current.knownAllocations.push(structuredClone(p));}
      return structuredClone(current.knownPodIds);
    });
  }
  async inventory(s){
    const pods=(await this.d.provider.list()).filter(p=>this.lifecycle.matches(p,s.reservation));
    for(const p of pods)this.lifecycle.validate(p,s.reservation,Infinity);
    if(pods.length)await this.rememberPods(s,pods);
    return pods;
  }
  async recordCleanup(s,receipt){
    let stop;const accepted=await this.tx(async(r,tx)=>{
      // Late observations remain durable even after an operation lease expires.
      // They cannot rewrite a newer session, but unresolved residual resources
      // prevent any subsequent allocation from ignoring the billing evidence.
      if(receipt?.unexpectedVolumeIds?.length){
        r.cleanupIncidents??=[];let incident=r.cleanupIncidents.find(i=>i.sessionId===s.id);
        if(!incident){incident={sessionId:s.id,volumeIds:[],resolved:false};r.cleanupIncidents.push(incident);}
        incident.volumeIds=[...new Set([...incident.volumeIds,...receipt.unexpectedVolumeIds])];
        if(r.session?.id===s.id)r.session.cleanupAttention=true;
        if(r.session&&!terminal(r.session)){
          r.session.stopRequested=true;r.session.stopAt??=this.d.now();r.session.code='RESIDUAL_RESOURCE_REVIEW_REQUIRED';
          if(r.session.createAttempted)stop=structuredClone(r.session);
          await tx.setAlarm(this.d.now()+100);
        }
      }
      const current=r.session;
      if(current?.id!==s.id||s.lease&&current.lease!==s.lease)return false;
      current.cleanupReceipt=receipt;return true;
    });
    if(stop?.reservation)await Promise.allSettled(this.d.guards.map(g=>g.shorten(stop.reservation.name,stop.stopAt)));
    return accepted;
  }
  async finish(s,phase,code=null){
    let checkedIds;
    const checked=current=>{
      if(current.createAttempted&&!current.definiteNoCreate&&(!checkedIds||knownPodIds(current).some(id=>!checkedIds.has(id))))throw new SessionError('POD_OBSERVATIONS_CHANGED',503);
      if(current.cleanupAttention)throw new SessionError('RESIDUAL_RESOURCE_REVIEW_REQUIRED',503);
      if(s.lease&&current.lease!==s.lease)throw new SessionError('SESSION_LEASE_CHANGED',503);
    };
    if(s.createAttempted&&!s.definiteNoCreate){
      const current=(await this.read()).session;
      if(current?.id!==s.id)throw new SessionError('SESSION_CHANGED');
      // A partial duplicate cleanup, changed identity, or incomplete inventory
      // cannot erase a previously observed Pod or release its budget hold.
      checkedIds=new Set(knownPodIds(current));
      if(this.d.lifecycle){
        if(current.cleanupAttention)throw new SessionError('RESIDUAL_RESOURCE_REVIEW_REQUIRED',503);
        for(const id of checkedIds){
          const bound=current.knownAllocations?.find(p=>p.id===id)??(current.pod?.id===id?current.pod:null);
          if(!bound)throw new SessionError('ALLOCATION_BINDING_UNCONFIRMED',503);
          const receipt=await this.d.provider.cleanup(bound,s.reservation);
          if(!await this.recordCleanup(s,receipt))throw new SessionError('SESSION_LEASE_CHANGED',503);
          if(!this.lifecycle.cleanupComplete(receipt))throw new SessionError('RESOURCE_ABSENCE_UNCONFIRMED',503);
        }
      }
      for(const id of checkedIds)if(await this.d.provider.get(id)!==null)throw new SessionError('POD_ABSENCE_UNCONFIRMED',503);
      if((await this.inventory(s)).length)throw new SessionError('POD_ABSENCE_UNCONFIRMED',503);
    }
    await this.update(s.id,checked);
    // Never drop a guard credential until cleanup/no-create is confirmed.
    const disarmed=await Promise.allSettled(this.d.guards.map(g=>g.disarm(s.reservation?.name??null,{definiteNoCreate:!s.createAttempted||s.definiteNoCreate===true})));
    if(disarmed.some(x=>x.status==='rejected'))throw new SessionError('GUARD_DISARM_PENDING');
    await this.update(s.id,(current,r)=>{
      checked(current);
      let debit=0;
      if(current.createAttempted&&!current.definiteNoCreate){
        // Conservative elapsed wall-clock upper estimate, including two extra
        // minutes. Not an itemized invoice. Never refund a hold on uncertainty.
        debit=Math.ceil((Math.max(0,this.d.now()-current.bootAt)/1000+120)*Math.ceil(current.quote.totalHourlyUSD*SCALE)/3600);
      }
      const ledger=this.funding(r,current);ledger.held-=current.quote.holdUnits;ledger.spent+=debit;
      current.settledUnits=debit;current.phase=phase;current.code=code;current.finishedAt=this.d.now();current.leaseUntil=0;
      delete current.inferenceKey;delete current.modelKey;delete current.nonce;
    });
  }
  async tick(){
    const op=this.d.id(),now=this.d.now();
    let s=await this.tx(r=>{if(terminal(r.session)||r.session.leaseUntil>now)return null;r.session.lease=op;r.session.leaseUntil=now+190000;return structuredClone(r.session);});
    if(!s)return;
    const sessionId=s.id;
    const update=(id,fn)=>this.update(id,(current,r)=>{if(current.lease!==op)throw new SessionError('SESSION_LEASE_CHANGED',503);return fn(current,r);});
    await this.d.wake(191000); // Crash recovery armed before external I/O.
    try{
      if(s.definiteNoCreate){await this.finish(s,'failed','CAPACITY_OR_PREFLIGHT_REJECTED');return;}
      if(s.stopRequested&&!s.createAttempted){await this.finish(s,'cancelled');return;}
      if(s.phase==='preflight'){
        await this.d.heartbeat();
        await update(s.id,(current,r)=>{if(r.cleanupIncidents?.some(i=>!i.resolved))throw new SessionError('RESIDUAL_RESOURCE_REVIEW_REQUIRED',503);if(current.stopRequested)return;const n=this.d.hex(32);current.nonce=n;current.inferenceKey=this.d.hex(64);if(this.d.lifecycle){current.modelKey=this.d.hex(64);if(current.modelKey===current.inferenceKey)throw new SessionError('KEY_GENERATION_FAILED',503);}current.reservation=this.lifecycle.reservation(this.d.now(),n,current.budgetKind==='ordinary'||this.d.lifecycle?sessionMinutes(current):undefined);current.phase='arming';});
      }else if(s.phase==='arming'){
        const armed=await Promise.allSettled(this.d.guards.map(g=>g.arm(s.reservation,this.d.key)));
        if(armed.some(r=>r.status==='rejected'))throw new SessionError('GUARD_ARM_FAILED');
        const proof=await this.d.receipts(s.reservation);
        const fresh=this.lifecycle.catalogFrom(await this.d.catalog());
        if(fresh.availability==='NONE')throw new SessionError('NO_STOCK');
        if(fresh.gpuHourly>s.quote.gpuHourlyUSD||fresh.totalHourly>s.quote.totalHourlyUSD)throw new SessionError('PRICE_CHANGED');
        if((await this.d.provider.list()).length)throw new SessionError('ACCOUNT_HAS_PODS');
        await this.d.checkVersions(proof);
        const body=await update(s.id,(current,r)=>{
          if(current.stopRequested)return null;
          if(r.cleanupIncidents?.some(i=>!i.resolved))throw new SessionError('RESIDUAL_RESOURCE_REVIEW_REQUIRED',503);
          const kind=current.budgetKind??'test';
          if(current.createAttempted||(kind==='test'&&r.ledger.usedApprovals.includes(current.approval)))throw new SessionError('APPROVAL_ALREADY_USED');
          if(!this.d.enabled||this.budgetKind()!==kind||(kind==='test'&&this.d.approval!==current.approval))throw new SessionError('LAUNCH_LOCKED');
          if(current.quote.lifecycleBinding!==this.currentBinding())throw new SessionError('QUOTE_CHANGED');
          this.lifecycle.receiptFresh(proof,current.reservation,this.d.now());
          current.guardProof=keylessGuardProof(proof,current.reservation,this.d.now());
          current.bootAt=current.reservation.createdNotBefore??this.d.now();current.deadline=current.reservation.deadline??current.bootAt+sessionMinutes(current)*60000;current.phase='reconciling';current.createAttempted=true;
          if(kind==='test')r.ledger.usedApprovals.push(current.approval);return this.lifecycle.createBody(current,current.bootAt);
        });
        if(body){
          // Persisted createAttempted BEFORE the only create. An exception or
          // process death leaves reconciling, never a reason to resend create.
          try{const created=await this.d.provider.create(body);if(created&&this.d.lifecycle)await this.rememberPods(s,[created]);}catch(error){
            if(this.d.lifecycle&&error?.outcome==='definite-no-create'){await update(s.id,c=>{c.definiteNoCreate=true;});await this.finish({...s,createAttempted:true,definiteNoCreate:true},'failed','CAPACITY_OR_PREFLIGHT_REJECTED');}
            // Unknown replies remain reconciling; never resend create.
          }
        }
      }else if(['reconciling','validating','starting','ready','stopping','attention'].includes(s.phase)){
        const pods=await this.inventory(s);
        if(s.createAttempted&&!pods.length){
          if(knownPodIds(s).length){
            await this.finish(s,'stopped');return;
          }
          const reports=await Promise.all(this.d.guards.map(g=>g.report()));
          const completed=reports.filter(r=>(r.armed===false||this.d.lifecycle&&r.vmCleanupVerified===true&&r.complete===true)&&r.name===s.reservation.name&&r.deleted?.length);
          if(completed.length){
            const deleted=completed.flatMap(r=>r.deleted);
            for(const p of deleted)this.lifecycle.validate(p,s.reservation,s.quote.gpuHourlyUSD);
            await this.rememberPods(s,deleted);
            await this.finish(s,'stopped');return;
          }
          if(this.d.now()>Date.parse(s.reservation.windowEnd))await update(s.id,c=>{c.phase='attention';c.code='CREATE_OUTCOME_UNKNOWN';c.stopRequested=true;});
          return; // Hold and guards remain armed until a real outcome is known.
        }
        if(pods.length!==1||pods.some(p=>!this.lifecycle.priceAccept(p,s))||s.stopRequested||this.d.now()>=s.deadline||this.d.now()-s.bootAt>=startupMinutes(s)*60000&&!s.everReady||pods.some(p=>this.lifecycle.isFailed(p))){
          await update(s.id,c=>{c.phase='stopping';c.stopRequested=true;c.stopAt??=this.d.now();c.pod??=pods[0];});
          await Promise.allSettled(this.d.guards.map(g=>g.shorten(s.reservation.name,this.d.now())));
          let complete=true;for(const p of pods){const receipt=await this.d.provider.cleanup(p,s.reservation,Infinity);if(!this.lifecycle.cleanupComplete(receipt))complete=false;if(this.d.lifecycle&&!await this.recordCleanup(s,receipt))throw new SessionError('SESSION_LEASE_CHANGED',503);}
          // finish rechecks every known ID and records any newly listed Pods.
          if(complete)await this.finish({...s,pod:pods[0]},'stopped');
        }else{
          const p=await this.d.provider.get(pods[0].id);if(!p)return;this.lifecycle.validate(p,s.reservation,s.quote.gpuHourlyUSD);
          const healthy=this.lifecycle.isRunning(p)&&await this.d.provider.health(p,s.inferenceKey);
          await update(s.id,c=>{c.pod=p;if(c.stopRequested){c.phase='stopping';return;}c.phase=healthy?'ready':this.d.lifecycle?'validating':'starting';if(healthy)c.everReady=true;});
        }
      }
    }catch(error){
      const current=(await this.read()).session;
      if(current?.id!==sessionId||current.lease!==op)return;
      s=current;
      if(s&&!s.createAttempted){
        try{await this.finish(s,'failed',error instanceof SessionError?error.code:'PREFLIGHT_FAILED');}catch{await update(s.id,c=>{c.stopRequested=true;c.code='GUARD_DISARM_PENDING';});}
      }else if(s){
        await update(s.id,c=>{c.stopRequested=true;c.phase='stopping';c.code='PROVIDER_OR_IDENTITY_UNCONFIRMED';});
        await Promise.allSettled(this.d.guards.map(g=>g.shorten(s.reservation.name,this.d.now())));
      }
    }finally{
      const current=(await this.read()).session;
      if(current?.id===sessionId&&current.lease===op){
        await update(sessionId,c=>{c.leaseUntil=0;});
        if(!terminal(current))await this.d.wake(current.phase==='attention'?60000:10000);
      }
    }
  }
}
