import {it,expect,vi} from 'vitest';
import {env,exports} from 'cloudflare:workers';
import {runInDurableObject,evictDurableObject,runDurableObjectAlarm} from 'cloudflare:test';
import {IMAGE,GPU,reservation} from '../session-policy.mjs';
it('has no public admin/start/inference endpoint',async()=>{
  for(const path of ['/','/api/start','/api/status','/api/exec','/api/check'])expect((await exports.default.fetch(new Request('https://dummy.test'+path))).status).toBe(404);
});
it('budget and spent approvals survive real object eviction; no key means paid Start stays locked',async()=>{
 const name=crypto.randomUUID(),a=env.SESSION_CONTROLLER.getByName(name);const quote=await a.quote();expect(quote.maximumUSD).toBe(.23);expect(quote.live).toBe(false);
 const result=await a.start({quoteId:quote.id,maximumUSD:quote.maximumUSD});expect(result.error).toBe('LAUNCH_LOCKED');
 await runInDurableObject(a,instance=>instance.engine().tx(r=>{r.ledger.spent+=100;r.ledger.usedApprovals.push('already-used');}));
 const before=await a.status();await evictDurableObject(a);const after=await env.SESSION_CONTROLLER.getByName(name).status();expect(after.budget).toEqual(before.budget);expect(after.budget.originalAcceptance.spentUSD).toBe(.4);expect(after.launchEnabled).toBe(false);
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
 expect(result.blocked.budget.reservedUSD).toBe(.23);expect(result.earlyDisarms).toEqual([]);
 expect(result.finished.session.cleanupVerified).toBe(true);expect(result.finished.budget.reservedUSD).toBe(0);
 expect(result.disarmed).toEqual([0,1]);
});
