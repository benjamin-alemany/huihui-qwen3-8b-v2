import {it,expect,vi} from 'vitest';
import {env,exports} from 'cloudflare:workers';
import {runInDurableObject,evictDurableObject,runDurableObjectAlarm} from 'cloudflare:test';
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
