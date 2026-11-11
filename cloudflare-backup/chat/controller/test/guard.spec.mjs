import {it,expect,vi} from 'vitest';import {env,exports} from 'cloudflare:workers';
import {runInDurableObject} from 'cloudflare:test';
import {IMAGE,GPU,reservation} from '../session-policy.mjs';import {providerFixture} from './provider-fixture.mjs';
import guardWorker from '../guard.mjs';
import {TARGET as HYPER_TARGET,fixture as hyperFixture,rawVM} from '../../hyperstack/fixtures.mjs';
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

const hyperKey='DUMMY_HYPERSTACK_KEY_NO_VM_ACCESS';
function hyperReservation(){
 const start=Date.now(),nonce=crypto.randomUUID().replaceAll('-','');
 return {kind:'chat',provider:'hyperstack',minutes:30,image:IMAGE,name:'unjailed-chat-'+nonce,nonce,target:HYPER_TARGET,
  createdNotBefore:start,createdNotAfter:start+300000,deadline:start+1800000,windowStart:new Date(start).toISOString(),windowEnd:new Date(start+300000).toISOString()};
}
async function hyperStub(patch={}){
 const stub=env.STOP_RESERVATION.getByName(crypto.randomUUID());
 await runInDurableObject(stub,instance=>{instance.env={...instance.env,HOSTING_PROVIDER:'hyperstack',HYPERSTACK_TARGET_JSON:JSON.stringify(HYPER_TARGET),...patch};});
 return stub;
}
const rejected=async(stub,fn)=>runInDurableObject(stub,async instance=>{try{await fn(instance);return false;}catch{return true;}});
it('Hyperstack unarmed actual DO makes zero HTTP requests and cannot expose a public endpoint',async()=>{
 const stub=await hyperStub(),spy=vi.spyOn(globalThis,'fetch').mockImplementation(()=>{throw Error('No request allowed');});
 try{expect((await stub.tick()).status).toBe('unarmed');expect((await stub.report()).armed).toBe(false);expect(spy).not.toHaveBeenCalled();expect((await exports.default.fetch(new Request('https://dummy.test/'))).status).toBe(404);}finally{spy.mockRestore();}
});
it('Hyperstack invalid target and disabled arm refuse without falling back to Runpod',async()=>{
 const q=hyperReservation(),stub=await hyperStub({HYPERSTACK_TARGET_JSON:'{"environmentId":11}'}),locked=await hyperStub({GUARD_ARM_ENABLED:'false'}),spy=vi.spyOn(globalThis,'fetch').mockImplementation(()=>{throw Error('No request allowed');});
 try{expect(await rejected(stub,i=>i.arm({reservation:q,key:hyperKey}))).toBe(true);expect(await rejected(stub,i=>i.tick())).toBe(true);expect(await rejected(locked,i=>i.arm({reservation:q,key:hyperKey}))).toBe(true);expect(spy).not.toHaveBeenCalled();}finally{spy.mockRestore();}
});
it('Hyperstack guard persists its own secret and requires trusted fresh no-create cancellation',async()=>{
 const stub=await hyperStub(),q=hyperReservation(),f=hyperFixture(),spy=vi.spyOn(globalThis,'fetch').mockImplementation(f.fetch);
 try{
  const armed=await stub.arm({reservation:q,key:hyperKey});expect(armed.armed).toBe(true);expect(JSON.stringify(armed)).not.toContain(hyperKey);
  expect(await rejected(stub,i=>i.disarm(q.name))).toBe(true);
  await runInDurableObject(stub,async(_,ctx)=>expect(await ctx.storage.get('hyperstack-guard-key-v1')).toBe(hyperKey));
  const done=await stub.disarm(q.name,{definiteNoCreate:true});expect(done.unarmed).toBe(true);expect(done.armed).toBe(false);expect(JSON.stringify(done)).not.toContain(hyperKey);expect(f.calls.every(c=>c.method==='GET')).toBe(true);
  await runInDurableObject(stub,async(_,ctx)=>{expect(await ctx.storage.get('hyperstack-guard-key-v1')).toBeUndefined();expect(await ctx.storage.getAlarm()).toBeNull();});
 }finally{spy.mockRestore();}
});
it('active provider state blocks both migration directions without losing either guard',async()=>{
 const stub=await hyperStub(),q=hyperReservation(),spy=vi.spyOn(globalThis,'fetch').mockImplementation(()=>{throw Error('No request allowed');});
 try{
  await runInDurableObject(stub,async(_,ctx)=>ctx.storage.put('active',{reservation:{name:'legacy-live'},key:'DUMMY_LEGACY_KEY'}));
  expect(await rejected(stub,i=>i.arm({reservation:q,key:hyperKey}))).toBe(true);expect(await rejected(stub,i=>i.tick())).toBe(true);
  await runInDurableObject(stub,async(instance,ctx)=>{expect((await ctx.storage.get('active')).key).toBe('DUMMY_LEGACY_KEY');await ctx.storage.delete('active');});
  await stub.arm({reservation:q,key:hyperKey});
  await runInDurableObject(stub,instance=>{instance.env={...instance.env,HOSTING_PROVIDER:'runpod'};});
  expect(await rejected(stub,i=>i.arm({reservation:reservation(Date.now(),'f'.repeat(32)),key:'DUMMY_CONTROL_KEY'}))).toBe(true);expect(await rejected(stub,i=>i.tick())).toBe(true);expect(await rejected(stub,i=>i.report())).toBe(true);
  await runInDurableObject(stub,async(instance,ctx)=>{expect(await ctx.storage.get('hyperstack-guard-key-v1')).toBe(hyperKey);await ctx.storage.deleteAlarm();await ctx.storage.deleteAll();});
  expect(spy).not.toHaveBeenCalled();
 }finally{spy.mockRestore();}
});
it('Hyperstack scheduled proof is emitted only for the exact waiting reservation, never Stop or a bound VM',async()=>{
 const stub=await hyperStub(),q=hyperReservation(),f=hyperFixture(),spy=vi.spyOn(globalThis,'fetch').mockImplementation(f.fetch),logs=vi.spyOn(console,'log').mockImplementation(()=>{});
 const workerEnv={...env,HOSTING_PROVIDER:'hyperstack',CHAT_STOP_ROLE:'primary',STOP_RESERVATION:{getByName:()=>stub}};
 try{
  await stub.arm({reservation:q,key:hyperKey});await guardWorker.scheduled(null,workerEnv);
  const waiting=JSON.parse(logs.mock.calls.at(-1)[0]);expect(waiting).toMatchObject({event:'guard_tick',provider:'hyperstack',status:'waiting-for-reserved-vm',name:q.name,reservationName:q.name,image:q.image,nonce:q.nonce,deadline:q.deadline,expiry:q.deadline});expect(JSON.stringify(waiting)).not.toContain(hyperKey);
  f.vms.push(rawVM({name:q.name,created_at:new Date(q.createdNotBefore).toISOString(),labels:['unjailed:'+q.nonce]}));await guardWorker.scheduled(null,workerEnv);expect(JSON.parse(logs.mock.calls.at(-1)[0]).status).not.toBe('waiting-for-reserved-vm');
  await stub.shorten(q.name,Date.now());await guardWorker.scheduled(null,workerEnv);expect(JSON.parse(logs.mock.calls.at(-1)[0]).status).not.toBe('waiting-for-reserved-vm');
  await stub.disarm(q.name);expect((await stub.report()).armed).toBe(false);
 }finally{spy.mockRestore();logs.mockRestore();}
});
