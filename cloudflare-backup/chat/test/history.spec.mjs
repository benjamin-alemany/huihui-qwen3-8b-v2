import {it,expect} from 'vitest';
import {env} from 'cloudflare:workers';
import {historyFrom,historyId} from '../history.mjs';
import {evictDurableObject,runInDurableObject} from 'cloudflare:test';
const sample={title:'Launch verification',messages:[{role:'user',content:'Remember Cedar'},{role:'assistant',content:'Cedar'}]};
it('saves only bounded plain text, never tools, URLs as actions or control fields',()=>{
 expect(historyFrom(sample)).toEqual(sample);
 for(const bad of [{...sample,RUNPOD_API_KEY:'DUMMY'},{...sample,messages:[{role:'system',content:'exec'}]},{...sample,messages:[{role:'user',content:'x'.repeat(12001)}]},{...sample,messages:[{role:'user',content:'text',tool_calls:[]}]}])expect(()=>historyFrom(bad)).toThrow();
 expect(()=>historyId("' OR 1=1")).toThrow();
});
it('backs up, previews without writes, imports atomically and deduplicates retries across eviction',async()=>{
 const source=env.CHAT_QUOTA.getByName(crypto.randomUUID()),target=env.CHAT_QUOTA.getByName(crypto.randomUUID());
 await source.savedWrite(sample);await source.savedWrite({...sample,title:'Draft',messages:[{role:'user',content:'Unsent <script> plain text'}]});
 const backup=await source.savedBackup();expect(Object.keys(backup).sort()).toEqual(['conversations','format','version']);expect(backup.conversations).toHaveLength(2);
 expect(await target.savedImport(backup,true)).toMatchObject({importable:2,duplicates:0,canImport:true});expect(await target.savedList()).toHaveLength(0);
 expect(await target.savedImport(backup)).toEqual({imported:2,duplicates:0});await evictDurableObject(target);
 expect(await target.savedImport(backup)).toEqual({imported:0,duplicates:2});expect((await target.savedBackup()).conversations.toSorted((a,b)=>a.title.localeCompare(b.title))).toEqual(backup.conversations.toSorted((a,b)=>a.title.localeCompare(b.title)));
});
it('rejects a whole import on quota overflow or invalid later records without changing existing chats',async()=>{
 const stub=env.CHAT_QUOTA.getByName(crypto.randomUUID());for(let i=0;i<19;i++)await stub.savedWrite(sample);
 const bundle={format:'unjailed.chat-backup',version:1,conversations:[{...sample,title:'One'},{...sample,title:'Two'}]};
 expect(await stub.savedImport(bundle,true)).toMatchObject({importable:2,remainingSlots:1,canImport:false});
 expect((await stub.savedImport(bundle)).status).toBe(409);expect(await stub.savedList()).toHaveLength(19);
 expect((await stub.savedImport({...bundle,conversations:[bundle.conversations[0],{title:'Tool',messages:[{role:'tool',content:'exec'}]}]})).status).toBe(400);expect(await stub.savedList()).toHaveLength(19);
});
it('rolls back earlier inserts when a later write fails inside the transaction',async()=>{
 const stub=env.CHAT_QUOTA.getByName(crypto.randomUUID());
 await runInDurableObject(stub,(_,ctx)=>ctx.storage.sql.exec("CREATE TRIGGER reject_bad_title BEFORE INSERT ON conversations WHEN NEW.title='REJECT_DUMMY' BEGIN SELECT RAISE(ABORT,'dummy failure'); END"));
 const backup={format:'unjailed.chat-backup',version:1,conversations:[sample,{...sample,title:'REJECT_DUMMY'}]};
 expect((await stub.savedImport(backup)).status).toBe(503);expect(await stub.savedList()).toHaveLength(0);
});
it('keeps saved history across RPC handles, bounds storage and deletes only the chosen record',async()=>{
 const id=crypto.randomUUID(),stub=env.CHAT_QUOTA.getByName(id),one=await stub.savedWrite(sample);
 expect((await env.CHAT_QUOTA.getByName(id).savedRead(one.id)).messages).toEqual(sample.messages);
 expect(await env.CHAT_QUOTA.getByName(crypto.randomUUID()).savedRead(one.id)).toBe(null);
 for(let i=1;i<20;i++)expect(await stub.savedWrite(sample)).not.toBe(null);
 expect(await stub.savedWrite(sample)).toBe(null);expect((await stub.savedList()).length).toBe(20);
 await stub.savedDelete(one.id);expect(await stub.savedRead(one.id)).toBe(null);expect((await stub.savedList()).length).toBe(19);
});
