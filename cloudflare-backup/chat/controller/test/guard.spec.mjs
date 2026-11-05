import {it,expect,vi} from 'vitest';import {env,exports} from 'cloudflare:workers';
import {runInDurableObject} from 'cloudflare:test';
import {IMAGE,GPU,reservation} from '../session-policy.mjs';import {providerFixture} from './provider-fixture.mjs';
it('unarmed guards are keyless and make no provider request; public access is absent',async()=>{
 const stub=env.STOP_RESERVATION.getByName(crypto.randomUUID());const spy=vi.spyOn(globalThis,'fetch').mockImplementation(()=>{throw Error('No request allowed');});
 try{expect((await stub.tick()).status).toBe('unarmed');expect((await stub.report()).armed).toBe(false);expect(spy).not.toHaveBeenCalled();expect((await exports.default.fetch(new Request('https://dummy.test/'))).status).toBe(404);}finally{spy.mockRestore();}
});
it('guard stops/deletes independently with controller unavailable and drops its active credential',async()=>{
 const stub=env.STOP_RESERVATION.getByName(crypto.randomUUID()),q=reservation(Date.now()-20*60000,'b'.repeat(32));
 const p={id:'abcdefghijklm',name:q.name,image:IMAGE,createdAt:new Date(Date.now()-19*60000).toISOString(),cloud:'SECURE',gpu:{id:GPU,count:1},disk:60,ports:['8000/http'],mounts:{},cost:.59,status:'RUNNING',actions:['stop']};
 const f=providerFixture([p]),spy=vi.spyOn(globalThis,'fetch').mockImplementation(f.fetch);
 try{
  await stub.arm({reservation:q,key:'DUMMY_CONTROL_KEY'});await stub.tick();const report=await stub.report();expect(report.armed).toBe(false);expect(report.deleted[0].id).toBe(p.id);expect(f.pods).toEqual([]);expect(f.calls.every(c=>!c.url.includes('controller'))).toBe(true);
  await runInDurableObject(stub,async(_,ctx)=>expect(await ctx.storage.get('active')).toBeUndefined());expect(JSON.stringify(report)).not.toContain('DUMMY_CONTROL_KEY');
 }finally{spy.mockRestore();}
});
it('unconfirmed stop remains armed and a wrong nonce cannot disarm or extend it',async()=>{
 const stub=env.STOP_RESERVATION.getByName(crypto.randomUUID()),q=reservation(Date.now()-20*60000,'c'.repeat(32)),p={id:'abcdefghijklm',name:q.name,image:IMAGE,createdAt:new Date(Date.now()-19*60000).toISOString(),cloud:'SECURE',gpu:{id:GPU,count:1},disk:60,ports:['8000/http'],mounts:{},cost:.59,status:'RUNNING',actions:['stop']};
 const f=providerFixture([p]);f.stopWorks=false;const spy=vi.spyOn(globalThis,'fetch').mockImplementation(f.fetch);
 try{await stub.arm({reservation:q,key:'DUMMY_CONTROL_KEY'});await stub.tick();expect((await stub.report()).armed).toBe(true);
  expect(await runInDurableObject(stub,async instance=>{try{await instance.disarm('other');return false;}catch{return true;}})).toBe(true);
  await stub.shorten(q.name,Date.now()-1000);
  expect(await runInDurableObject(stub,async instance=>{try{await instance.shorten(q.name,Date.now()+60000);return false;}catch{return true;}})).toBe(true);
  expect(f.calls.some(c=>c.tool==='delete-pod')).toBe(false);await stub.disarm(q.name);
 }finally{spy.mockRestore();}
});
