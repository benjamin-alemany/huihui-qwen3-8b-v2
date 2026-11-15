import {it,expect,vi} from 'vitest';
import {env} from 'cloudflare:workers';
import {runDurableObjectAlarm,evictDurableObject,runInDurableObject,abortAllDurableObjects} from 'cloudflare:test';
import {MODEL} from '../policy.mjs';
const draft=stub=>stub.savedUpsert({id:crypto.randomUUID(),revision:0,title:'Durable reply',messages:[],draft:'Remember Cedar'});
const reply=()=>Response.json({model:MODEL,choices:[{message:{role:'assistant',content:'Cedar remains plain text <script>'},finish_reason:'stop'}]});
it('persists a job before inference and saves completion before a client can recover it after eviction',async()=>{
 const objectName=crypto.randomUUID();let stub=env.CHAT_QUOTA.getByName(objectName);const {item}=await draft(stub),turnId=crypto.randomUUID();
 let observedFailure;const spy=vi.spyOn(globalThis,'fetch').mockImplementation(async(url,options)=>{try{
  expect(String(url)).toBe('https://abcdefghijklm-8000.proxy.runpod.net/v1/chat/completions');
  expect(JSON.stringify(options)).not.toContain('RUNPOD_API_KEY');return reply();}catch(e){observedFailure=e;throw e;}
 });
 try{
  const body={conversationId:item.id,revision:item.revision,turnId};
  const {queued,stored}=await runInDurableObject(stub,async(instance,ctx)=>{const queued=await instance.turnQueue(body);await ctx.storage.setAlarm(Date.now()+60000);return {queued,stored:ctx.storage.sql.exec('SELECT status,input_messages FROM generation_turns WHERE turn_id=?',turnId).one()};});
  expect(queued).toMatchObject({status:'pending',item});expect(stored.status).toBe('pending');expect(JSON.parse(stored.input_messages)).toEqual([{role:'user',content:item.draft}]);
  await evictDurableObject(stub);await runDurableObjectAlarm(stub);expect(observedFailure).toBeUndefined();
  const completed=await stub.turnRead(turnId);expect(completed).toMatchObject({status:'completed',conversationId:item.id,item:{revision:2,draft:'',messages:[{role:'user',content:item.draft},{role:'assistant',content:'Cedar remains plain text <script>'}]}});
  await abortAllDurableObjects();stub=env.CHAT_QUOTA.getByName(objectName);expect(await stub.turnQueue(body)).toEqual(completed);expect(await stub.turnRead(turnId)).toEqual(completed);expect(spy).toHaveBeenCalledTimes(1);
 }finally{spy.mockRestore();}
});
it('marks an interrupted in-flight job after restart without ever sending it again',async()=>{
 const stub=env.CHAT_QUOTA.getByName(crypto.randomUUID()),{item}=await draft(stub),turnId=crypto.randomUUID(),body={conversationId:item.id,revision:1,turnId};
 const spy=vi.spyOn(globalThis,'fetch').mockImplementation(()=>{throw Error('must not contact inference');});
 try{
  await runInDurableObject(stub,async(instance,ctx)=>{await instance.turnQueue(body);ctx.storage.sql.exec("UPDATE generation_turns SET status='inflight' WHERE turn_id=?",turnId);await ctx.storage.setAlarm(Date.now()+60000);});
  await evictDurableObject(stub);await runDurableObjectAlarm(stub);
  expect(await stub.turnRead(turnId)).toMatchObject({status:'interrupted',error:'GENERATION_INTERRUPTED',item:{revision:1,draft:item.draft}});
  expect((await stub.turnQueue(body)).status).toBe('interrupted');expect(spy).not.toHaveBeenCalled();
 }finally{spy.mockRestore();}
});
it('serializes owner generations and blocks draft overwrites until the queued turn resolves',async()=>{
 const stub=env.CHAT_QUOTA.getByName(crypto.randomUUID()),{item}=await draft(stub),turnId=crypto.randomUUID();
 await stub.turnQueue({conversationId:item.id,revision:1,turnId});
 expect(await stub.savedUpsert({id:item.id,revision:1,title:item.title,messages:item.messages,draft:'Overwrite'})).toMatchObject({error:'GENERATION_PENDING',status:409,item});
 expect(await stub.turnQueue({conversationId:item.id,revision:1,turnId:crypto.randomUUID()})).toMatchObject({error:'GENERATION_PENDING',status:409});
 expect(await stub.savedDelete(item.id)).toMatchObject({error:'GENERATION_PENDING',status:409});
 await runInDurableObject(stub,(_,ctx)=>ctx.storage.sql.exec('UPDATE quota SET busy_until=0'));
 expect(await stub.acquire({nonce:'c'.repeat(32),deadline:Date.now()+60000})).toBe(null);
 await runInDurableObject(stub,(_,ctx)=>ctx.storage.sql.exec("UPDATE generation_turns SET status='inflight' WHERE turn_id=?",turnId));await runDurableObjectAlarm(stub);
});
it('lost inference responses retain the cloud draft and never automatically replay',async()=>{
 const stub=env.CHAT_QUOTA.getByName(crypto.randomUUID()),{item}=await draft(stub),turnId=crypto.randomUUID(),body={conversationId:item.id,revision:1,turnId};
 const spy=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('DUMMY_SECRET_MUST_NOT_ESCAPE'));
 try{
  await stub.turnQueue(body);await runDurableObjectAlarm(stub);
  const r=await stub.turnRead(turnId);expect(r).toMatchObject({status:'interrupted',error:'GENERATION_UNCONFIRMED',item:{draft:item.draft,revision:1}});expect(JSON.stringify(r)).not.toContain('DUMMY_SECRET');
  await runDurableObjectAlarm(stub);await stub.turnQueue(body);expect(spy).toHaveBeenCalledTimes(1);
 }finally{spy.mockRestore();}
});

it('starts the next queued turn promptly instead of waiting for the previous watchdog',async()=>{
 const stub=env.CHAT_QUOTA.getByName(crypto.randomUUID()),{item}=await draft(stub),first=crypto.randomUUID();
 const spy=vi.spyOn(globalThis,'fetch').mockImplementation(reply);
 try{
  await stub.turnQueue({conversationId:item.id,revision:1,turnId:first});await runDurableObjectAlarm(stub);
  const completed=(await stub.turnRead(first)).item,updated=await stub.savedUpsert({id:completed.id,revision:completed.revision,title:completed.title,messages:completed.messages,draft:'Second turn'});
  // Reproduce a stale long watchdog left by an older deployment.
  await runInDurableObject(stub,(_,ctx)=>ctx.storage.setAlarm(Date.now()+100000));
  const second=crypto.randomUUID();await stub.turnQueue({conversationId:item.id,revision:updated.item.revision,turnId:second});
  expect(await runInDurableObject(stub,(_,ctx)=>ctx.storage.getAlarm())).toBeLessThan(Date.now()+1000);
  await runDurableObjectAlarm(stub);expect((await stub.turnRead(second)).status).toBe('completed');expect(spy).toHaveBeenCalledTimes(2);
 }finally{spy.mockRestore();}
});

it('does not commit a reply after Stop or a same-nonce deadline change',async()=>{
 for(const mode of ['stop','extension']){
  const stub=env.CHAT_QUOTA.getByName(crypto.randomUUID()),{item}=await draft(stub),turnId=crypto.randomUUID();
  const spy=vi.spyOn(globalThis,'fetch').mockImplementation(reply);
  try{
   await stub.turnQueue({conversationId:item.id,revision:1,turnId});
   await runInDurableObject(stub,(instance,ctx)=>{
    const job=ctx.storage.sql.exec('SELECT nonce,deadline FROM generation_turns WHERE turn_id=?',turnId).one();let reads=0;
    instance.activeInference=async()=>{reads++;if(reads>1&&mode==='stop')return {};return {CHAT_ENABLED:'true',CHAT_SESSION:JSON.stringify({podId:'abcdefghijklm',createdAt:new Date(job.deadline-30*60000).toISOString(),nonce:job.nonce,minutes:reads>1?60:30}),INFERENCE_API_KEY:'DUMMY_'+ 'x'.repeat(43)};};
   });
   await runDurableObjectAlarm(stub);expect(await stub.turnRead(turnId)).toMatchObject({status:'interrupted',item:{draft:item.draft,revision:1}});expect(spy).toHaveBeenCalledTimes(1);
  }finally{spy.mockRestore();}
 }
});
