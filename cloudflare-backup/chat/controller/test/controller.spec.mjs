import {it,expect,vi} from 'vitest';
import {env,exports} from 'cloudflare:workers';
import {runInDurableObject,evictDurableObject,runDurableObjectAlarm} from 'cloudflare:test';
import {IMAGE,GPU,reservation} from '../session-policy.mjs';
import {TARGET as HYPER_TARGET} from '../../hyperstack/fixtures.mjs';
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
  const status=await stub.status();expect(status.hostingProvider).toBe('hyperstack');expect(status.launchEnabled).toBe(false);expect(status.networkBoundaryReady).toBe(false);expect(status.launchBlockers).toContain('HYPERSTACK_TARGET_UNVERIFIED');expect(status.launchBlockers).toContain('HYPERSTACK_RUNTIME_ORCHESTRATOR_UNAVAILABLE');expect(status.launchBlockers).toContain('HYPERSTACK_ORIGINAL_ACCEPTANCE_UNCONFIGURED');expect(status.testBudget.originalAcceptance).toBeNull();expect(status.operatorBudgetReconciliation.ready).toBe(false);expect(JSON.stringify(status)).not.toContain('DUMMY_');
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
