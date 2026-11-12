import {it,expect,vi} from 'vitest';
import {env,exports} from 'cloudflare:workers';
import {runInDurableObject,evictDurableObject,runDurableObjectAlarm} from 'cloudflare:test';
import {IMAGE,GPU,reservation,SCALE,SEED} from '../session-policy.mjs';
import {TARGET as HYPER_TARGET,rawVM} from '../../hyperstack/fixtures.mjs';
import manifest from '../../../../release/manifest.json' with {type:'json'};
import {hyperstackLifecycle} from '../../hyperstack/controller-policy.mjs';
import {normalizeVM,validateReservation} from '../../hyperstack/policy.mjs';
import {verifyOperatorAbsence} from '../../hyperstack/operator-absence.mjs';
it('has no public admin/start/inference endpoint',async()=>{
  for(const path of ['/','/api/start','/api/status','/api/exec','/api/check'])expect((await exports.default.fetch(new Request('https://dummy.test'+path))).status).toBe(404);
});
it('budget and spent approvals survive real object eviction; no key means paid Start stays locked',async()=>{
 const name=crypto.randomUUID(),a=env.SESSION_CONTROLLER.getByName(name);const quote=await a.quote();expect(quote.maximumUSD).toBe(.35);expect(quote.live).toBe(false);
 const result=await a.start({quoteId:quote.id,maximumUSD:quote.maximumUSD});expect(result.error).toBe('LAUNCH_LOCKED');
 await runInDurableObject(a,instance=>instance.engine().tx(r=>{r.ledger.spent+=100;r.ledger.usedApprovals.push('already-used');}));
 const before=await a.status();await evictDurableObject(a);const after=await env.SESSION_CONTROLLER.getByName(name).status();expect(after.budget).toEqual(before.budget);expect(after.testBudget.originalAcceptance.spentUSD).toBe(.4);expect(after.launchEnabled).toBe(false);
});
it('persists one pending free check across handles and refuses duplicate scheduling',async()=>{
  const name=crypto.randomUUID(),a=env.SESSION_CONTROLLER.getByName(name);
  const initial=await a.status();expect(initial.launchEnabled).toBe(false);expect(initial.agentToolsEnabled).toBe(false);expect(initial.readiness.phase).toBe('not-checked');
  const [first,second]=await Promise.all([a.check(),env.SESSION_CONTROLLER.getByName(name).check()]);
  expect(first.readiness.id).toBe(second.readiness.id);
  const restored=await env.SESSION_CONTROLLER.getByName(name).status();expect(restored.readiness.id).toBe(first.readiness.id);expect(restored.launchEnabled).toBe(false);
  const other=await env.SESSION_CONTROLLER.getByName(crypto.randomUUID()).status();expect(other.readiness.phase).toBe('not-checked');
  expect(JSON.stringify(restored)).not.toContain('DUMMY_');
  await runInDurableObject(a,(_,ctx)=>ctx.storage.deleteAlarm());
});

it('runs the readiness alarm deterministically with only dummy Cloudflare responses',async()=>{
 const a=env.SESSION_CONTROLLER.getByName(crypto.randomUUID()),calls=[];
 const spy=vi.spyOn(globalThis,'fetch').mockImplementation(async url=>{calls.push(String(url));expect(String(url)).toMatch(/^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/0{32}\/workers\/scripts\/unjailed-chat-stop-(?:primary|backup)\/deployments$/);return new Response(null,{status:503});});
 try{expect(env.RUNPOD_API_KEY).toBe('');await a.check();await runDurableObjectAlarm(a);const s=await a.status();expect(s.readiness.phase).toBe('failed');expect(s.launchEnabled).toBe(false);expect(calls.length).toBe(2);await runInDurableObject(a,async(_,ctx)=>expect(await ctx.storage.getAlarm()).toBe(null));}
 finally{spy.mockRestore();}
});
it('readiness alarm uses the trusted account setting and never the compiled dummy account',async()=>{
 const a=env.SESSION_CONTROLLER.getByName(crypto.randomUUID()),accountId='1'.repeat(32),calls=[];
 await runInDurableObject(a,instance=>{instance.env={...instance.env,CLOUDFLARE_ACCOUNT_ID:accountId};});
 const spy=vi.spyOn(globalThis,'fetch').mockImplementation(async url=>{calls.push(String(url));expect(String(url)).toMatch(new RegExp('^https://api\\.cloudflare\\.com/client/v4/accounts/'+accountId+'/workers/scripts/unjailed-chat-stop-(?:primary|backup)/deployments$'));return new Response(null,{status:503});});
 try{await a.check();await runDurableObjectAlarm(a);expect((await a.status()).readiness.phase).toBe('failed');expect(calls.length).toBe(2);}finally{spy.mockRestore();}
});
it('Hyperstack missing account setting refuses its free readiness alarm before HTTP',async()=>{
 const a=env.SESSION_CONTROLLER.getByName(crypto.randomUUID());await runInDurableObject(a,instance=>{instance.env={...instance.env,HOSTING_PROVIDER:'hyperstack'};});
 const spy=vi.spyOn(globalThis,'fetch').mockImplementation(()=>{throw Error('No request allowed');});
 try{await a.check();await runDurableObjectAlarm(a);const s=await a.status();expect(s.readiness.phase).toBe('failed');expect(s.readiness.code).toBe('ACCOUNT_FORMAT');expect(s.launchBlockers).toContain('HYPERSTACK_GUARD_ACCOUNT_UNCONFIGURED');expect(spy).not.toHaveBeenCalled();}finally{spy.mockRestore();}
});
it('unverified inference-network image cannot launch even if owner launch flags and a key are supplied',async()=>{
 const a=env.SESSION_CONTROLLER.getByName(crypto.randomUUID());
 await runInDurableObject(a,instance=>{instance.env={...instance.env,START_ENABLED:'true',APPROVED_ACCEPTANCE_ID:'DUMMY-APPROVAL',RUNPOD_API_KEY:'DUMMY_CONTROL_KEY',OPERATOR_BUDGET_RECONCILIATION:JSON.stringify({id:'operator-budget-0123456789abcdef',capUnits:10000000000,spentFloorUnits:3000000000})};});
 const before=await a.status();expect(before.networkBoundaryReady).toBe(false);expect(before.launchEnabled).toBe(false);
 expect((await a.start({quoteId:'anything',maximumUSD:.23})).error).toBe('NETWORK_BOUNDARY_UNVERIFIED');
 expect((await a.status()).budget).toEqual(before.budget);
});
it('retains every observed Pod across SQLite eviction until explicit absence is confirmed',async()=>{
 const name=crypto.randomUUID(),stub=env.SESSION_CONTROLLER.getByName(name),now=Date.now();
 const q=reservation(now,'d'.repeat(32)),p={id:'abcdefghijklm',name:q.name,image:IMAGE,createdAt:new Date(now).toISOString(),cloud:'SECURE',gpu:{id:GPU,count:1},disk:60,ports:['8000/http'],mounts:{},cost:.59,status:'RUNNING'};
 const other={...p,id:'nopqrstuvwxyz'};
 await runInDurableObject(stub,async instance=>{
  const engine=instance.engine();await engine.tx(r=>{
   r.ledger.held=2300000000;
   r.session={id:'dummy-session',phase:'stopping',quote:{maximumUSD:.23,holdUnits:2300000000,totalHourlyUSD:.60},reservation:q,pod:p,createAttempted:true,stopRequested:true,bootAt:now,leaseUntil:0};
  });
  await engine.rememberPods((await engine.read()).session,[p,other]);
 });
 await evictDurableObject(stub);
 const restored=env.SESSION_CONTROLLER.getByName(name);
 const result=await runInDurableObject(restored,async instance=>{
  const engine=instance.engine(),disarmed=[];
  engine.d.guards=[0,1].map(i=>({shorten:async()=>{},disarm:async()=>{disarmed.push(i);}}));
  engine.d.provider={list:async()=>[],get:async id=>id===other.id?{...other,name:other.name+'-renamed'}:null};
  await engine.tick();
  const blocked=await engine.status(),ids=(await engine.read()).session.knownPodIds,earlyDisarms=[...disarmed];
  engine.d.provider.get=async()=>null;await engine.tick();
  return {blocked,ids,earlyDisarms,finished:await engine.status(),disarmed};
 });
 expect(result.ids).toEqual([p.id,other.id]);expect(result.blocked.session.cleanupVerified).toBe(false);
 expect(result.blocked.testBudget.reservedUSD).toBe(.23);expect(result.earlyDisarms).toEqual([]);
 expect(result.finished.session.cleanupVerified).toBe(true);expect(result.finished.testBudget.reservedUSD).toBe(0);
 expect(result.disarmed).toEqual([0,1]);
});

it('owner allowance and grant replay survive SQLite eviction without touching historical accounting',async()=>{
 const name=crypto.randomUUID(),a=env.SESSION_CONTROLLER.getByName(name),before=await a.status(),grant={grantId:crypto.randomUUID(),amountUSD:10};
 expect(before.ordinaryBudget.remainingUSD).toBe(0);expect(before.launchEnabled).toBe(false);
 const issued=await a.grant(grant);expect(issued.ordinaryBudget.remainingUSD).toBe(10);expect(issued.ordinaryBudget.grantCount).toBe(1);expect(issued.launchEnabled).toBe(false);
 await evictDurableObject(a);const restored=env.SESSION_CONTROLLER.getByName(name);expect((await restored.grant(grant)).ordinaryBudget).toEqual(issued.ordinaryBudget);
 expect((await restored.grant({...grant,amountUSD:9})).error).toBe('GRANT_ID_REUSED');expect((await restored.grant({...grant,amountUSD:11})).error).toBe('INVALID_GRANT');
 expect((await restored.status()).testBudget).toEqual(before.testBudget);expect((await restored.status()).session).toBe(null);
});
it('actual controller refuses ordinary allowance writes during acceptance and preserves ordinary grants afterward',async()=>{
 const a=env.SESSION_CONTROLLER.getByName(crypto.randomUUID()),grant={grantId:crypto.randomUUID(),amountUSD:1};
 await runInDurableObject(a,i=>{i.env={...i.env,VALIDATION_MODE:'true'};});const before=await a.status();
 expect((await a.grant(grant)).error).toBe('ORDINARY_ALLOWANCE_DISABLED_DURING_ACCEPTANCE');const after=await a.status();expect(after.ordinaryBudget).toEqual(before.ordinaryBudget);expect(after.testBudget).toEqual(before.testBudget);expect(after.ordinaryBudget.capUSD).toBe(0);
 await runInDurableObject(a,async(i,ctx)=>{expect(await ctx.storage.get('ordinary-grant-v1:'+grant.grantId)).toBeUndefined();i.env={...i.env,VALIDATION_MODE:'false'};});expect((await a.grant(grant)).ordinaryBudget.capUSD).toBe(1);
});
it('duration quotes default thirty and capture only the three product choices',async()=>{
 const a=env.SESSION_CONTROLLER.getByName(crypto.randomUUID());expect((await a.quote()).minutes).toBe(30);
 for(const minutes of [15,30,60]){const q=await a.quote({minutes});expect(q.minutes).toBe(minutes);expect(q.maximumUSD).toBeCloseTo(.60*(minutes+5)/60,10);expect(q.launchEnabled).toBe(false);}
 for(const input of [{minutes:18},{minutes:600},{minutes:'30'},{minutes:30,extend:true}])expect((await a.quote(input)).error).toBe('INVALID_DURATION');
});

async function selectedController(patch){
 const stub=env.SESSION_CONTROLLER.getByName(crypto.randomUUID());
 await runInDurableObject(stub,instance=>{instance.env={...instance.env,HOSTING_PROVIDER:'hyperstack',START_ENABLED:'true',RUNPOD_API_KEY:'DUMMY_LEGACY_KEY_NEVER_USED',...patch};});
 return stub;
}
it('malformed Hyperstack configuration reports honest blockers without Runpod fallback or HTTP',async()=>{
 const stub=await selectedController({HYPERSTACK_TARGET_JSON:'{}',HYPERSTACK_API_KEY:'DUMMY_HYPERSTACK_KEY'}),spy=vi.spyOn(globalThis,'fetch').mockImplementation(()=>{throw Error('No request allowed');});
 try{
  const status=await stub.status();expect(status.hostingProvider).toBe('hyperstack');expect(status.launchEnabled).toBe(false);expect(status.networkBoundaryReady).toBe(false);expect(status.launchBlockers).toContain('HYPERSTACK_TARGET_UNVERIFIED');expect(status.providerReadiness.targetConfigured).toBe(false);expect(status.launchBlockers).toContain('HYPERSTACK_ORIGINAL_ACCEPTANCE_UNCONFIGURED');expect(status.testBudget.originalAcceptance).toBeNull();expect(status.operatorBudgetReconciliation.ready).toBe(false);expect(JSON.stringify(status)).not.toContain('DUMMY_');
  expect((await stub.quote()).error).toBe('HYPERSTACK_TARGET_UNVERIFIED');expect((await stub.start({quoteId:'anything',maximumUSD:.3})).error).toBe('HYPERSTACK_TARGET_UNVERIFIED');expect(await runInDurableObject(stub,i=>i.context())).toBeNull();expect(spy).not.toHaveBeenCalled();
 }finally{spy.mockRestore();}
});
it('Hyperstack source release locks preserve grants and ledgers; Stop still revokes a durable session',async()=>{
 const stub=await selectedController({HYPERSTACK_TARGET_JSON:JSON.stringify(HYPER_TARGET),HYPERSTACK_API_KEY:'DUMMY_HYPERSTACK_KEY'}),spy=vi.spyOn(globalThis,'fetch').mockImplementation(()=>{throw Error('No request allowed');});
 try{
  const before=await stub.status();await stub.grant({grantId:crypto.randomUUID(),amountUSD:1});const granted=await stub.status();expect(granted.ordinaryBudget.capUSD).toBe(1);expect(granted.testBudget).toEqual(before.testBudget);expect(granted.launchBlockers).toContain('HYPERSTACK_RELEASE_UNPINNED');expect(granted.launchBlockers).toContain('HYPERSTACK_BUDGET_UNRECONCILED');expect(granted.launchEnabled).toBe(false);
  const sessionId=crypto.randomUUID();await runInDurableObject(stub,instance=>instance.engine().tx(r=>{r.session={id:sessionId,phase:'ready',stopRequested:false,createAttempted:true,bootAt:Date.now(),deadline:Date.now()+60000,reservation:{name:'unjailed-chat-'+'a'.repeat(32),provider:'hyperstack'},quote:{minutes:30},leaseUntil:0};}));
  const stopped=await stub.stop({sessionId});expect(stopped.session.stopRequested).toBe(true);expect(stopped.launchEnabled).toBe(false);expect(await runInDurableObject(stub,i=>i.context())).toBeNull();await runInDurableObject(stub,(_,ctx)=>ctx.storage.deleteAlarm());expect(spy).not.toHaveBeenCalled();
 }finally{spy.mockRestore();}
});
it('unknown hosting-provider spelling cannot select the configured legacy provider',async()=>{
 const stub=await selectedController({HOSTING_PROVIDER:'hyperstak'}),spy=vi.spyOn(globalThis,'fetch').mockImplementation(()=>{throw Error('No request allowed');});
 try{const status=await stub.status();expect(status.hostingProvider).toBe('invalid');expect(status.launchBlockers[0]).toBe('HOSTING_PROVIDER_INVALID');expect(status.launchEnabled).toBe(false);expect((await stub.start({quoteId:'anything',maximumUSD:.3})).error).toBe('HOSTING_PROVIDER_INVALID');expect(spy).not.toHaveBeenCalled();}finally{spy.mockRestore();}
});
it('a trusted recovery directive always blocks Start and context even when launch flags are enabled',async()=>{
 const a=await selectedController({START_ENABLED:'true',OPERATOR_ABSENCE_RECONCILIATION_JSON:'invalid-private-directive'});
 const spy=vi.spyOn(globalThis,'fetch').mockImplementation(()=>{throw Error('No request allowed');});
 try{expect((await a.start({quoteId:'anything',maximumUSD:.35})).error).toBe('OPERATOR_RECOVERY_ACTIVE');expect(await runInDurableObject(a,i=>i.context())).toBeNull();expect(await runInDurableObject(a,i=>i.engine().d.enabled)).toBe(false);expect((await a.status()).launchEnabled).toBe(false);expect((await exports.default.fetch(new Request('https://dummy.test/api/operator-absence'))).status).toBe(404);expect(spy).not.toHaveBeenCalled();}finally{spy.mockRestore();}
});

async function recoveryControllerFixture(){
 const name=crypto.randomUUID(),stub=env.SESSION_CONTROLLER.getByName(name),target={...HYPER_TARGET,imageId:manifest.hosting.vmImageId},lifecycle=hyperstackLifecycle({target,release:manifest}),start=Date.now()-10*60000;
 const historical=lifecycle.reservation(start,'a'.repeat(32),30);delete historical.ownershipPolicy;const q=validateReservation(historical),quote=lifecycle.makeQuote({provider:'hyperstack',gpu:'RTX-A6000',gpuHourly:.5,totalHourly:.50672043,availability:'AVAILABLE'},start,crypto.randomUUID(),30);
 const packet={version:1,id:crypto.randomUUID(),sessionId:crypto.randomUUID(),approvalId:'DUMMY_ONE_ACCEPTANCE',reservation:q,allocation:normalizeVM(rawVM({name:q.name,created_at:new Date(start+1000).toISOString(),labels:[]})),observedAt:start+2000,deleteRequestedAt:start+3000,absenceObservedAt:start+4000,reason:'MISSING_PROVIDER_LABEL'};
 const policy={id:'operator-budget-0123456789abcdef',capUnits:2*SCALE,spentFloorUnits:Math.round(.4*SCALE)},ledger={...structuredClone(SEED),cap:policy.capUnits,spent:policy.spentFloorUnits,held:quote.holdUnits,usedApprovals:['DUMMY_EARLIER_APPROVAL',packet.approvalId],operatorBudgetReconciliations:[policy]},ordinaryLedger={version:1,cap:0,spent:0,held:0,grantCount:0};
 const record={ledger,ordinaryLedger,quotes:[],session:{id:packet.sessionId,quoteId:quote.id,quote,reservation:q,approval:packet.approvalId,budgetKind:'test',createAttempted:true,phase:'attention',stopRequested:true,everReady:false,nonce:q.nonce,bootAt:q.createdNotBefore,deadline:q.deadline,inferenceKey:'c'.repeat(64),modelKey:'d'.repeat(64),leaseUntil:0}};
 const guardCalls=[];let guardFailure=false;
 const guard=role=>({operatorAbsence:async p=>{guardCalls.push([role,'rpc']);expect(p).toEqual(packet);if(guardFailure&&role==='backup')throw Error('DUMMY_GUARD_UNCONFIRMED');const provider={get:async id=>{guardCalls.push([role,'get',id]);return null;},list:async()=>{guardCalls.push([role,'list']);return [];}};return {...await verifyOperatorAbsence({provider,packet:p,target,now:Date.now}),role,armed:false,bindings:[],deleted:[]};}});
 const patch={HOSTING_PROVIDER:'hyperstack',START_ENABLED:'false',VALIDATION_MODE:'true',APPROVED_ACCEPTANCE_ID:packet.approvalId,HYPERSTACK_TARGET_JSON:JSON.stringify(target),HYPERSTACK_API_KEY:'DUMMY_HYPERSTACK_RECOVERY_KEY',MAX_ACCEPTANCE_USD:'.35',MAX_SESSION_HOURLY_USD:'.507',CLOUDFLARE_ACCOUNT_ID:'1'.repeat(32),CF_TAIL_TOKEN:'D'.repeat(40),ORIGINAL_ACCEPTANCE_JSON:JSON.stringify({capUSD:.51,spentUSD:.4,remainingUSD:.11}),OPERATOR_BUDGET_RECONCILIATION:JSON.stringify(policy),OPERATOR_ABSENCE_RECONCILIATION_JSON:JSON.stringify(packet),PRIMARY_GUARD:guard('primary'),BACKUP_GUARD:guard('backup')};
 const configure=async object=>runInDurableObject(object,i=>{i.env={...i.env,...patch};});await configure(stub);
 await runInDurableObject(stub,async(_,ctx)=>{await ctx.storage.put('session-ledger-v1',record);await ctx.storage.put('session-start-v1:'+quote.id,{sessionId:packet.sessionId,budgetKind:'test'});await ctx.storage.setAlarm(Date.now()+60000);});
 const fetchCalls=[],fetchImpl=async(url,opt={})=>{const u=new URL(url);fetchCalls.push({path:u.pathname,method:opt.method??'GET'});expect(u.origin).toBe('https://infrahub-api.nexgencloud.com');expect(opt.method??'GET').toBe('GET');if(u.pathname==='/v1/core/virtual-machines/44')return Response.json({status:false,error_reason:'not_found'},{status:404});expect(u.pathname).toBe('/v1/core/virtual-machines');return Response.json({status:true,page:1,page_size:100,count:0,instances:[]});};
 return {name,stub,packet,record,quote,configure,fetchCalls,fetchImpl,guardCalls,setGuardFailure:value=>{guardFailure=value;}};
}
it('durable recovery alarm survives eviction, conservatively settles once, erases session keys and preserves evidence',async()=>{
 const h=await recoveryControllerFixture(),spy=vi.spyOn(globalThis,'fetch').mockImplementation(h.fetchImpl);
 try{
  const beforeAlarm=await runInDurableObject(h.stub,(_,ctx)=>ctx.storage.getAlarm());expect(beforeAlarm).not.toBeNull();await evictDurableObject(h.stub);const restored=env.SESSION_CONTROLLER.getByName(h.name);await h.configure(restored);expect(await runInDurableObject(restored,(_,ctx)=>ctx.storage.getAlarm())).toBe(beforeAlarm);
  await runDurableObjectAlarm(restored);const after=await runInDurableObject(restored,(_,ctx)=>ctx.storage.get('session-ledger-v1'));
  expect(after.ledger.cap).toBe(h.record.ledger.cap);expect(after.ledger.spent).toBe(h.record.ledger.spent+h.quote.holdUnits);expect(after.ledger.held).toBe(0);expect(after.ledger.usedApprovals).toEqual(h.record.ledger.usedApprovals);expect(after.ordinaryLedger).toEqual(h.record.ordinaryLedger);expect(after.session).toMatchObject({phase:'stopped',createAttempted:true,acceptancePassed:false,settledUnits:h.quote.holdUnits,code:'ACCEPTANCE_IDENTITY_FAILURE_MANUAL_CLEANUP'});expect(after.session.definiteNoCreate).not.toBe(true);for(const key of ['inferenceKey','modelKey','nonce'])expect(after.session[key]).toBeUndefined();expect(after.session.knownAllocations).toBeUndefined();
  const archive=await runInDurableObject(restored,(_,ctx)=>ctx.storage.get('hyperstack-controller-operator-absence-v1:'+h.packet.id));expect(archive.packet.allocation.labels).toEqual([]);expect(archive.receipt.billingSettlementPending).toBe(true);expect((await restored.status()).operatorRecovery.phase).toBe('verified');expect(await runInDurableObject(restored,(_,ctx)=>ctx.storage.getAlarm())).toBeNull();expect(h.fetchCalls.length).toBe(6);for(const role of ['primary','backup'])expect(h.guardCalls.filter(c=>c[0]===role).map(c=>c[1])).toEqual(['rpc','get','list','get']);
  const reads=h.fetchCalls.length;await runInDurableObject(restored,(_,ctx)=>ctx.storage.setAlarm(Date.now()+60000));await runDurableObjectAlarm(restored);expect((await runInDurableObject(restored,(_,ctx)=>ctx.storage.get('session-ledger-v1'))).ledger).toEqual(after.ledger);expect(h.fetchCalls.length).toBe(reads);expect((await restored.start({quoteId:h.quote.id,maximumUSD:h.quote.maximumUSD})).error).toBe('OPERATOR_RECOVERY_ACTIVE');expect(await runInDurableObject(restored,i=>i.context())).toBeNull();
 }finally{spy.mockRestore();}
});
it('partial guard recovery failure leaves durable hold, approval and session keys for a later free retry',async()=>{
 const h=await recoveryControllerFixture();h.setGuardFailure(true);const spy=vi.spyOn(globalThis,'fetch').mockImplementation(h.fetchImpl);
 try{
  await runDurableObjectAlarm(h.stub);const blocked=await runInDurableObject(h.stub,(_,ctx)=>ctx.storage.get('session-ledger-v1'));expect(blocked.ledger).toEqual(h.record.ledger);expect(blocked.ordinaryLedger).toEqual(h.record.ordinaryLedger);expect(blocked.session.phase).toBe('attention');expect(blocked.session.inferenceKey).toBe(h.record.session.inferenceKey);expect(blocked.session.modelKey).toBe(h.record.session.modelKey);expect(await runInDurableObject(h.stub,(_,ctx)=>ctx.storage.get('hyperstack-controller-operator-absence-v1:'+h.packet.id))).toBeUndefined();expect((await h.stub.status()).operatorRecovery.phase).toBe('refused');expect(await runInDurableObject(h.stub,(_,ctx)=>ctx.storage.getAlarm())).not.toBeNull();
  h.setGuardFailure(false);await runDurableObjectAlarm(h.stub);const recovered=await runInDurableObject(h.stub,(_,ctx)=>ctx.storage.get('session-ledger-v1'));expect(recovered.ledger.spent).toBe(h.record.ledger.spent+h.quote.holdUnits);expect(recovered.ledger.held).toBe(0);expect(recovered.session.modelKey).toBeUndefined();expect((await h.stub.status()).operatorRecovery.phase).toBe('verified');
 }finally{await runInDurableObject(h.stub,(_,ctx)=>ctx.storage.deleteAlarm());spy.mockRestore();}
});

it('private create-rejection recovery blocks Start and inference and refuses conflicting directives',async()=>{
 const stub=await selectedController({START_ENABLED:'true',OPERATOR_CREATE_REJECTION_JSON:'DUMMY_INVALID_PACKET'}),spy=vi.spyOn(globalThis,'fetch').mockImplementation(()=>{throw Error('No request allowed');});
 try{
  expect((await stub.start({quoteId:'anything',maximumUSD:.35})).error).toBe('OPERATOR_RECOVERY_ACTIVE');expect(await runInDurableObject(stub,i=>i.context())).toBeNull();expect(await runInDurableObject(stub,i=>i.engine().d.enabled)).toBe(false);
  await runInDurableObject(stub,async(i,ctx)=>{i.env={...i.env,START_ENABLED:'false',VALIDATION_MODE:'true',OPERATOR_ABSENCE_RECONCILIATION_JSON:'DUMMY_CONFLICT'};await ctx.storage.setAlarm(Date.now()+60000);});
  await runDurableObjectAlarm(stub);expect((await stub.status()).operatorCreateRejection).toMatchObject({phase:'refused',code:'OPERATOR_REJECTION_LOCK_REQUIRED'});expect((await exports.default.fetch(new Request('https://dummy.test/api/operator-create-rejection'))).status).toBe(404);expect(spy).not.toHaveBeenCalled();
 }finally{await runInDurableObject(stub,(_,ctx)=>ctx.storage.deleteAlarm());spy.mockRestore();}
});

async function rejectionControllerFixture(){
 const h=await recoveryControllerFixture(),q=validateReservation({...h.packet.reservation,ownershipPolicy:'nonce-name-v2'});
 const packet={version:1,id:crypto.randomUUID(),sessionId:h.packet.sessionId,approvalId:h.packet.approvalId,reservation:q,requestAt:q.createdNotBefore+1000,confirmedAt:q.createdNotAfter+1000,httpStatus:400,evidenceSHA256:'e'.repeat(64),reason:'PROVIDER_CONFIRMED_NO_CREATE'};
 const calls=[],flags={fail:false},guard=role=>({disarm:async(name,proof)=>{calls.push([role,name,proof]);expect(name).toBe(q.name);expect(proof).toEqual({definiteNoCreate:true});if(flags.fail&&role==='backup')throw Error('DUMMY_GUARD_PENDING');return {unarmed:true,armed:false,role,name:q.name,status:'DEFINITE_NO_CREATE_ARCHIVED'};}});
 const configure=async object=>{await h.configure(object);await runInDurableObject(object,i=>{const next={...i.env,START_ENABLED:'false',VALIDATION_MODE:'true',OPERATOR_CREATE_REJECTION_JSON:JSON.stringify(packet),PRIMARY_GUARD:guard('primary'),BACKUP_GUARD:guard('backup')};delete next.OPERATOR_ABSENCE_RECONCILIATION_JSON;i.env=next;});};
 h.record.session.reservation=q;
 h.record.session.quote.lifecycleBinding=await runInDurableObject(h.stub,i=>i.engine().currentBinding());
 await configure(h.stub);await runInDurableObject(h.stub,async(_,ctx)=>{await ctx.storage.put('session-ledger-v1',h.record);await ctx.storage.setAlarm(Date.now()+60000);});
 return {...h,packet,configure,rejectionGuardCalls:calls,setGuardFailure:value=>{flags.fail=value;}};
}
it('confirmed rejection alarm releases only its hold, keeps the approval consumed and survives SQLite eviction/replay',async()=>{
 const h=await rejectionControllerFixture(),spy=vi.spyOn(globalThis,'fetch').mockImplementation(h.fetchImpl);
 try{
  await evictDurableObject(h.stub);const restored=env.SESSION_CONTROLLER.getByName(h.name);await h.configure(restored);await runDurableObjectAlarm(restored);
  const after=await runInDurableObject(restored,(_,ctx)=>ctx.storage.get('session-ledger-v1'));
  expect(after.ledger.held).toBe(0);expect(after.ledger.spent).toBe(h.record.ledger.spent);expect(after.ledger.cap).toBe(h.record.ledger.cap);expect(after.ledger.usedApprovals).toEqual(h.record.ledger.usedApprovals);expect(after.ordinaryLedger).toEqual(h.record.ordinaryLedger);expect(after.session).toMatchObject({phase:'failed',createAttempted:true,definiteNoCreate:true,settledUnits:0,acceptancePassed:false});
  for(const key of ['inferenceKey','modelKey','nonce'])expect(after.session[key]).toBeUndefined();expect(h.rejectionGuardCalls.map(x=>x[0])).toEqual(['primary','backup']);expect(h.fetchCalls.every(c=>c.method==='GET')).toBe(true);expect((await restored.status()).operatorCreateRejection.phase).toBe('verified');expect((await restored.status()).launchEnabled).toBe(false);expect(await runInDurableObject(restored,(_,ctx)=>ctx.storage.getAlarm())).toBeNull();
  const reads=h.fetchCalls.length;await runInDurableObject(restored,(_,ctx)=>ctx.storage.setAlarm(Date.now()+60000));await runDurableObjectAlarm(restored);expect(h.fetchCalls.length).toBe(reads);expect((await runInDurableObject(restored,(_,ctx)=>ctx.storage.get('session-ledger-v1'))).ledger).toEqual(after.ledger);expect(h.rejectionGuardCalls.length).toBe(2);
 }finally{await runInDurableObject(h.stub,(_,ctx)=>ctx.storage.deleteAlarm());spy.mockRestore();}
});
it('rejection recovery retains the hold across a guard failure and retries only cleanup',async()=>{
 const h=await rejectionControllerFixture(),spy=vi.spyOn(globalThis,'fetch').mockImplementation(h.fetchImpl);h.setGuardFailure(true);
 try{
  await runDurableObjectAlarm(h.stub);const blocked=await runInDurableObject(h.stub,(_,ctx)=>ctx.storage.get('session-ledger-v1'));expect(blocked.ledger).toEqual(h.record.ledger);expect(blocked.session.definiteNoCreate).toBe(true);expect(blocked.session.modelKey).toBe(h.record.session.modelKey);expect((await h.stub.status()).operatorCreateRejection.phase).toBe('refused');expect(await runInDurableObject(h.stub,(_,ctx)=>ctx.storage.getAlarm())).not.toBeNull();
  h.setGuardFailure(false);await runDurableObjectAlarm(h.stub);const after=await runInDurableObject(h.stub,(_,ctx)=>ctx.storage.get('session-ledger-v1'));expect(after.ledger.spent).toBe(h.record.ledger.spent);expect(after.ledger.held).toBe(0);expect(after.session.settledUnits).toBe(0);expect(after.session.modelKey).toBeUndefined();expect(h.fetchCalls.every(c=>c.method==='GET')).toBe(true);
 }finally{await runInDurableObject(h.stub,(_,ctx)=>ctx.storage.deleteAlarm());spy.mockRestore();}
});
