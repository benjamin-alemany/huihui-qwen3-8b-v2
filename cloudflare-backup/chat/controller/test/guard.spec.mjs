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
  expect(f.calls.some(c=>c.tool==='delete-pod')).toBe(false);f.pods=[];await stub.disarm(q.name);
 }finally{spy.mockRestore();}
});
function cleanupCase(){
 const q=reservation(Date.now()-20*60000,'d'.repeat(32));
 const a={id:'aaaaaaaaaaaaa',name:q.name,image:IMAGE,createdAt:new Date(Date.now()-19*60000).toISOString(),cloud:'SECURE',gpu:{id:GPU,count:1},disk:60,ports:['8000/http'],mounts:{},cost:.59,status:'EXITED',actions:['stop']};
 return {q,a,b:{...a,id:'bbbbbbbbbbbbb'}};
}
it('a renamed known Pod cannot be forgotten when another matching Pod is deleted',async()=>{
 const stub=env.STOP_RESERVATION.getByName(crypto.randomUUID()),{q,a,b}=cleanupCase();
 const f=providerFixture([{...a,name:'renamed',status:'RUNNING'},b]),spy=vi.spyOn(globalThis,'fetch').mockImplementation(f.fetch);
 try{
  await stub.arm({reservation:q,key:'DUMMY_CONTROL_KEY'});
  await runInDurableObject(stub,async(_,ctx)=>{const s=await ctx.storage.get('active');s.seen=[a];await ctx.storage.put('active',s);});
  await stub.tick();expect((await stub.report()).armed).toBe(true);expect(f.pods).toEqual([{...a,name:'renamed',status:'RUNNING'}]);
  await runInDurableObject(stub,async(_,ctx)=>{const s=await ctx.storage.get('active');expect(s.key).toBe('DUMMY_CONTROL_KEY');expect(s.seen.map(p=>p.id)).toEqual([a.id,b.id]);});
  // A later explicit absence for every observed ID permits normal completion.
  f.pods=[];await stub.tick();expect((await stub.report()).armed).toBe(false);
  await runInDurableObject(stub,async(_,ctx)=>expect(await ctx.storage.get('active')).toBeUndefined());
 }finally{spy.mockRestore();}
});
it('partial duplicate cleanup retains the other observed ID across ticks and identity changes',async()=>{
 const stub=env.STOP_RESERVATION.getByName(crypto.randomUUID()),{q,a,b}=cleanupCase(),f=providerFixture([a,b]);
 const spy=vi.spyOn(globalThis,'fetch').mockImplementation(async(url,options)=>{
  const input=options?.body?JSON.parse(options.body):null;
  if(input?.params?.name==='delete-pod'&&input.params.arguments.id===b.id)throw Error('dummy uncertain delete');
  return f.fetch(url,options);
 });
 try{
  await stub.arm({reservation:q,key:'DUMMY_CONTROL_KEY'});await stub.tick();expect((await stub.report()).armed).toBe(true);expect(f.pods.map(p=>p.id)).toEqual([b.id]);
  await runInDurableObject(stub,async(_,ctx)=>expect((await ctx.storage.get('active')).seen.map(p=>p.id)).toEqual([a.id,b.id]));
  f.pods=[{...b,name:'renamed',status:'RUNNING'}];await stub.tick();expect((await stub.report()).armed).toBe(true);expect(f.pods[0].status).toBe('RUNNING');
  f.pods=[];await stub.tick();expect((await stub.report()).armed).toBe(false);
 }finally{spy.mockRestore();}
});
for(const failure of ['failed','malformed'])it(`a ${failure} direct read of an omitted known Pod retains the guard credential`,async()=>{
 const stub=env.STOP_RESERVATION.getByName(crypto.randomUUID()),{q,a,b}=cleanupCase(),f=providerFixture([b]);let uncertain=true;
 const spy=vi.spyOn(globalThis,'fetch').mockImplementation(async(url,options)=>{
  const input=options?.body?JSON.parse(options.body):null;
  if(uncertain&&input?.params?.name==='get-pod'&&input.params.arguments.id===a.id){
   if(failure==='failed')throw Error('dummy read failure');
   return Response.json({jsonrpc:'2.0',id:input.id,result:{content:[{type:'text',text:'null'}]}});
  }
  return f.fetch(url,options);
 });
 try{
  await stub.arm({reservation:q,key:'DUMMY_CONTROL_KEY'});
  await runInDurableObject(stub,async(_,ctx)=>{const s=await ctx.storage.get('active');s.seen=[a];await ctx.storage.put('active',s);});
  expect(await runInDurableObject(stub,async instance=>{try{await instance.tick();return false;}catch{return true;}})).toBe(true);expect((await stub.report()).armed).toBe(true);
  await runInDurableObject(stub,async(_,ctx)=>expect((await ctx.storage.get('active')).key).toBe('DUMMY_CONTROL_KEY'));
  uncertain=false;await stub.tick();expect((await stub.report()).armed).toBe(false);
 }finally{spy.mockRestore();}
});
it('explicit controller disarm retains a renamed guard-only observation until verified absent',async()=>{
 const stub=env.STOP_RESERVATION.getByName(crypto.randomUUID()),{q,a}=cleanupCase(),f=providerFixture([{...a,name:'renamed',status:'RUNNING'}]);
 const spy=vi.spyOn(globalThis,'fetch').mockImplementation(f.fetch);
 try{
  await stub.arm({reservation:q,key:'DUMMY_CONTROL_KEY'});
  await runInDurableObject(stub,async(instance,ctx)=>{
   const s=await ctx.storage.get('active');s.seen=[a];await ctx.storage.put('active',s);
   let rejected=false;try{await instance.disarm(q.name);}catch{rejected=true;}expect(rejected).toBe(true);
   expect((await ctx.storage.get('active')).key).toBe('DUMMY_CONTROL_KEY');
  });
  expect(f.pods[0].status).toBe('RUNNING');f.pods=[];await stub.disarm(q.name);expect((await stub.report()).armed).toBe(false);
 }finally{spy.mockRestore();}
});
it('explicit disarm rejects observations added during its asynchronous absence checks',async()=>{
 const stub=env.STOP_RESERVATION.getByName(crypto.randomUUID()),{q,a,b}=cleanupCase(),f=providerFixture([]);let duringRead;
 const spy=vi.spyOn(globalThis,'fetch').mockImplementation(async(url,options)=>{
  const input=options?.body?JSON.parse(options.body):null;
  if(input?.params?.name==='get-pod'&&duringRead){const update=duringRead;duringRead=null;await update();}
  return f.fetch(url,options);
 });
 try{
  await stub.arm({reservation:q,key:'DUMMY_CONTROL_KEY'});
  await runInDurableObject(stub,async(instance,ctx)=>{
   const s=await ctx.storage.get('active');s.seen=[a];await ctx.storage.put('active',s);
   duringRead=async()=>{const live=await ctx.storage.get('active');live.seen.push(b);await ctx.storage.put('active',live);};
   let rejected=false;try{await instance.disarm(q.name);}catch{rejected=true;}expect(rejected).toBe(true);
   expect((await ctx.storage.get('active')).seen.map(p=>p.id)).toEqual([a.id,b.id]);
  });
  await stub.disarm(q.name);expect((await stub.report()).armed).toBe(false);
 }finally{spy.mockRestore();}
});
it('no-create explicit disarm with no observed Pods remains keyless at the provider',async()=>{
 const stub=env.STOP_RESERVATION.getByName(crypto.randomUUID()),{q}=cleanupCase();
 const spy=vi.spyOn(globalThis,'fetch').mockImplementation(()=>{throw Error('No provider request allowed');});
 try{await stub.arm({reservation:q,key:'DUMMY_CONTROL_KEY'});await stub.disarm(q.name);expect((await stub.report()).armed).toBe(false);expect(spy).not.toHaveBeenCalled();}finally{spy.mockRestore();}
});
for(const mode of ['tick','disarm'])it(`${mode} durably remembers a new Pod first observed in the final inventory`,async()=>{
 const stub=env.STOP_RESERVATION.getByName(crypto.randomUUID()),{q,a,b}=cleanupCase(),f=providerFixture(mode==='tick'?[a]:[]);let lists=0;
 const spy=vi.spyOn(globalThis,'fetch').mockImplementation(async(url,options)=>{
  const input=options?.body?JSON.parse(options.body):null;
  if(input?.params?.name==='list-pods'&&++lists===(mode==='tick'?2:1))f.pods=[{...b,status:'RUNNING'}];
  return f.fetch(url,options);
 });
 const attempt=async()=>runInDurableObject(stub,async instance=>{try{await (mode==='tick'?instance.tick():instance.disarm(q.name));return true;}catch{return false;}});
 try{
  await stub.arm({reservation:q,key:'DUMMY_CONTROL_KEY'});
  if(mode==='disarm')await runInDurableObject(stub,async(_,ctx)=>{const s=await ctx.storage.get('active');s.seen=[a];await ctx.storage.put('active',s);});
  await attempt();expect((await stub.report()).armed).toBe(true);
  await runInDurableObject(stub,async(_,ctx)=>expect((await ctx.storage.get('active')).seen.map(p=>p.id)).toEqual([a.id,b.id]));
  f.pods=[{...b,name:'renamed',status:'RUNNING'}];await attempt();expect((await stub.report()).armed).toBe(true);expect(f.pods[0].status).toBe('RUNNING');
  f.pods=[];await attempt();expect((await stub.report()).armed).toBe(false);
 }finally{spy.mockRestore();}
});
it('rearming the same nonce cannot change its bound duration or creation window',async()=>{
 const stub=env.STOP_RESERVATION.getByName(crypto.randomUUID()),q={...reservation(Date.now(),'e'.repeat(32)),minutes:30};
 await stub.arm({reservation:q,key:'DUMMY_CONTROL_KEY'});await stub.arm({reservation:q,key:'DUMMY_CONTROL_KEY'});
 await runInDurableObject(stub,async instance=>{
  for(const patch of [{minutes:60},{windowEnd:new Date(Date.parse(q.windowEnd)+1000).toISOString()}]){
   let denied=false;try{await instance.arm({reservation:{...q,...patch},key:'DUMMY_CONTROL_KEY'});}catch{denied=true;}expect(denied).toBe(true);
  }
 });
 expect((await stub.report()).image).toBe(q.image);await stub.disarm(q.name);
});
