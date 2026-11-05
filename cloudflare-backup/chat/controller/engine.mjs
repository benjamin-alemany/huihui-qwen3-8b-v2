import {SEED,SCALE,MINUTES,SessionError,terminal,catalogFrom,makeQuote,reservation,podMatches,validatePod,createBody,safeSession,budgetView,receiptFresh} from './session-policy.mjs';
const recordKey='session-ledger-v1';
// All account state is durable. No network I/O runs inside a transaction.
export class SessionEngine {
  constructor(storage,deps){this.storage=storage;this.d=deps;}
  async tx(fn,wakeAt){return this.storage.transaction(async tx=>{const r=await tx.get(recordKey)??{ledger:structuredClone(SEED),session:null,quotes:[]};const result=fn(r);await tx.put(recordKey,r);if(wakeAt!==undefined)await tx.setAlarm(wakeAt);return result;});}
  async read(){return this.tx(r=>structuredClone(r));}
  async status(){const r=await this.read();return {launchEnabled:!!(this.d.enabled&&this.d.connected&&this.d.approval&&!r.ledger.usedApprovals.includes(this.d.approval)),agentToolsEnabled:false,terminalEnabled:false,session:safeSession(r.session),budget:budgetView(r.ledger)};}
  async quote(){
    const raw=await this.d.catalog(),catalog=catalogFrom(raw),q={...makeQuote(catalog,this.d.now(),this.d.id()),live:!!this.d.connected};
    const ceiling=this.d.maxHourly??1;
    if(!Number.isFinite(ceiling)||ceiling<=0||ceiling>1||catalog.totalHourly>ceiling)throw new SessionError('PRICE_CHANGED');
    return this.tx(r=>{r.quotes=[...r.quotes.slice(-19),q];return {...q,holdUnits:undefined,launchEnabled:!!(this.d.enabled&&this.d.connected&&this.d.approval&&!r.ledger.usedApprovals.includes(this.d.approval)),budget:budgetView(r.ledger),includes:'GPU, 60 GB temporary disk, cold start and 5-minute stop/cleanup margin',excludes:'Tax/FX if applicable; existing domain; provider outages can exceed operational allowance'};});
  }
  async start(input){
    if(!input||Object.keys(input).sort().join()!=='maximumUSD,quoteId'||typeof input.quoteId!=='string')throw new SessionError('INVALID_START',400);
    await this.tx(r=>{
      if(r.session?.quoteId===input.quoteId)return; // Idempotent even after cleanup.
      if(!this.d.enabled||!this.d.connected||!this.d.approval)throw new SessionError('LAUNCH_LOCKED');
      if(!terminal(r.session))throw new SessionError('SESSION_ALREADY_ACTIVE');
      if(r.ledger.usedApprovals.includes(this.d.approval))throw new SessionError('APPROVAL_ALREADY_USED');
      const q=r.quotes.find(q=>q.id===input.quoteId);
      if(!q||!q.live||q.expiresAt<=this.d.now())throw new SessionError('QUOTE_EXPIRED');
      if(input.maximumUSD!==q.maximumUSD)throw new SessionError('QUOTE_CHANGED');
      const maxUSD=this.d.maxUSD??.25;
      if(!Number.isFinite(maxUSD)||maxUSD<=0||q.maximumUSD>maxUSD)throw new SessionError('APPROVAL_LIMIT');
      if(q.availability==='NONE')throw new SessionError('NO_STOCK');
      if(r.ledger.cap-r.ledger.spent-r.ledger.held<q.holdUnits)throw new SessionError('BUDGET_EXHAUSTED');
      r.ledger.held+=q.holdUnits;
      r.session={id:this.d.id(),quoteId:q.id,quote:q,approval:this.d.approval,phase:'preflight',requestedAt:this.d.now(),stopRequested:false,createAttempted:false,leaseUntil:0};
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
    return {CHAT_ENABLED:'true',CHAT_SESSION:JSON.stringify({podId:s.pod.id,createdAt:new Date(s.bootAt).toISOString(),nonce:s.nonce,minutes:MINUTES}),INFERENCE_API_KEY:s.inferenceKey};
  }
  async update(id,fn){return this.tx(r=>{if(r.session?.id!==id)throw new SessionError('SESSION_CHANGED');return fn(r.session,r);});}
  async finish(s,phase,code=null){
    // Never drop a guard credential until cleanup/no-create is confirmed.
    const disarmed=await Promise.allSettled(this.d.guards.map(g=>g.disarm(s.reservation?.name??null)));
    if(disarmed.some(x=>x.status==='rejected'))throw new SessionError('GUARD_DISARM_PENDING');
    await this.update(s.id,(current,r)=>{
      let debit=0;
      if(current.createAttempted){
        // Conservative elapsed wall-clock upper estimate, including two extra
        // minutes. Not an itemized invoice. Never refund a hold on uncertainty.
        debit=Math.ceil((Math.max(0,this.d.now()-current.bootAt)/1000+120)*Math.ceil(current.quote.totalHourlyUSD*SCALE)/3600);
      }
      r.ledger.held-=current.quote.holdUnits;r.ledger.spent+=debit;
      current.settledUnits=debit;current.phase=phase;current.code=code;current.finishedAt=this.d.now();current.leaseUntil=0;
      delete current.inferenceKey;delete current.nonce;
    });
  }
  async tick(){
    const op=this.d.id(),now=this.d.now();
    let s=await this.tx(r=>{if(terminal(r.session)||r.session.leaseUntil>now)return null;r.session.lease=op;r.session.leaseUntil=now+190000;return structuredClone(r.session);});
    if(!s)return;
    await this.d.wake(191000); // Crash recovery armed before external I/O.
    try{
      if(s.stopRequested&&!s.createAttempted){await this.finish(s,'cancelled');return;}
      if(s.phase==='preflight'){
        await this.d.heartbeat();
        await this.update(s.id,current=>{if(current.stopRequested)return;const n=this.d.hex(32);current.nonce=n;current.inferenceKey=this.d.hex(64);current.reservation=reservation(this.d.now(),n);current.phase='arming';});
      }else if(s.phase==='arming'){
        const armed=await Promise.allSettled(this.d.guards.map(g=>g.arm(s.reservation,this.d.key)));
        if(armed.some(r=>r.status==='rejected'))throw new SessionError('GUARD_ARM_FAILED');
        const proof=await this.d.receipts(s.reservation);
        const fresh=catalogFrom(await this.d.catalog());
        if(fresh.availability==='NONE')throw new SessionError('NO_STOCK');
        if(fresh.gpuHourly>s.quote.gpuHourlyUSD||fresh.totalHourly>s.quote.totalHourlyUSD)throw new SessionError('PRICE_CHANGED');
        if((await this.d.provider.list()).length)throw new SessionError('ACCOUNT_HAS_PODS');
        await this.d.checkVersions(proof);
        const body=await this.update(s.id,(current,r)=>{
          if(current.stopRequested)return null;
          if(current.createAttempted||r.ledger.usedApprovals.includes(current.approval))throw new SessionError('APPROVAL_ALREADY_USED');
          if(!this.d.enabled||this.d.approval!==current.approval)throw new SessionError('LAUNCH_LOCKED');
          receiptFresh(proof,current.reservation,this.d.now());
          current.bootAt=this.d.now();current.deadline=current.bootAt+MINUTES*60000;current.phase='reconciling';current.createAttempted=true;
          r.ledger.usedApprovals.push(current.approval);return createBody(current,current.bootAt);
        });
        if(body){
          // Persisted createAttempted BEFORE the only create. An exception or
          // process death leaves reconciling, never a reason to resend create.
          try{await this.d.provider.create(body);}catch{/* Reconcile below/on alarm. */}
        }
      }else if(['reconciling','starting','ready','stopping','attention'].includes(s.phase)){
        const pods=(await this.d.provider.list()).filter(p=>podMatches(p,s.reservation));
        for(const p of pods)validatePod(p,s.reservation,Infinity);
        if(s.createAttempted&&!pods.length){
          if(s.pod){
            // Inventory filtering is not proof that the known Pod was deleted.
            // A changed identity or incomplete list must retain its budget hold.
            const known=await this.d.provider.get(s.pod.id);
            if(known){
              validatePod(known,s.reservation,Infinity);
              throw new SessionError('POD_ABSENCE_UNCONFIRMED',503);
            }
            await this.finish(s,'stopped');return;
          }
          const reports=await Promise.all(this.d.guards.map(g=>g.report()));
          if(reports.some(r=>r.name===s.reservation.name&&r.deleted?.length)){
            for(const report of reports)for(const p of report.deleted??[])validatePod(p,s.reservation,s.quote.gpuHourlyUSD);
            await this.finish(s,'stopped');return;
          }
          if(this.d.now()>Date.parse(s.reservation.windowEnd))await this.update(s.id,c=>{c.phase='attention';c.code='CREATE_OUTCOME_UNKNOWN';c.stopRequested=true;});
          return; // Hold and guards remain armed until a real outcome is known.
        }
        if(pods.length!==1||pods.some(p=>p.cost>s.quote.gpuHourlyUSD)||s.stopRequested||this.d.now()>=s.deadline||this.d.now()-s.bootAt>=12*60000&&!s.everReady||pods.some(p=>p.status==='EXITED'||p.status==='ERROR')){
          await this.update(s.id,c=>{c.phase='stopping';c.stopRequested=true;c.stopAt??=this.d.now();c.pod??=pods[0];});
          await Promise.allSettled(this.d.guards.map(g=>g.shorten(s.reservation.name,this.d.now())));
          let complete=true;for(const p of pods)if(!await this.d.provider.cleanup(p,s.reservation,Infinity))complete=false;
          // A fresh complete inventory is required even after successful deletes.
          if(complete&&!(await this.d.provider.list()).some(p=>podMatches(p,s.reservation)))await this.finish({...s,pod:pods[0]},'stopped');
        }else{
          const p=await this.d.provider.get(pods[0].id);if(!p)return;validatePod(p,s.reservation,s.quote.gpuHourlyUSD);
          const healthy=p.status==='RUNNING'&&await this.d.provider.health(p,s.inferenceKey);
          await this.update(s.id,c=>{c.pod=p;if(c.stopRequested){c.phase='stopping';return;}c.phase=healthy?'ready':'starting';if(healthy)c.everReady=true;});
        }
      }
    }catch(error){
      s=(await this.read()).session;
      if(s&&!s.createAttempted){
        try{await this.finish(s,'failed',error instanceof SessionError?error.code:'PREFLIGHT_FAILED');}catch{await this.update(s.id,c=>{c.stopRequested=true;c.code='GUARD_DISARM_PENDING';});}
      }else if(s){
        await this.update(s.id,c=>{c.stopRequested=true;c.phase='stopping';c.code='PROVIDER_OR_IDENTITY_UNCONFIRMED';});
        await Promise.allSettled(this.d.guards.map(g=>g.shorten(s.reservation.name,this.d.now())));
      }
    }finally{
      await this.update(s.id,c=>{if(c.lease===op)c.leaseUntil=0;});
      const current=(await this.read()).session;
      if(!terminal(current))await this.d.wake(current.phase==='attention'?60000:10000);
    }
  }
}
