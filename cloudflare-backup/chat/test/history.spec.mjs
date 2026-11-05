import {it,expect} from 'vitest';
import {env} from 'cloudflare:workers';
import {historyFrom,historyId} from '../history.mjs';
const sample={title:'Launch verification',messages:[{role:'user',content:'Remember Cedar'},{role:'assistant',content:'Cedar'}]};
it('saves only bounded plain text, never tools, URLs as actions or control fields',()=>{
 expect(historyFrom(sample)).toEqual(sample);
 for(const bad of [{...sample,RUNPOD_API_KEY:'DUMMY'},{...sample,messages:[{role:'system',content:'exec'}]},{...sample,messages:[{role:'user',content:'x'.repeat(12001)}]},{...sample,messages:[{role:'user',content:'text',tool_calls:[]}]}])expect(()=>historyFrom(bad)).toThrow();
 expect(()=>historyId("' OR 1=1")).toThrow();
});
it('keeps saved history across RPC handles, bounds storage and deletes only the chosen record',async()=>{
 const id=crypto.randomUUID(),stub=env.CHAT_QUOTA.getByName(id),one=await stub.savedWrite(sample);
 expect((await env.CHAT_QUOTA.getByName(id).savedRead(one.id)).messages).toEqual(sample.messages);
 expect(await env.CHAT_QUOTA.getByName(crypto.randomUUID()).savedRead(one.id)).toBe(null);
 for(let i=1;i<20;i++)expect(await stub.savedWrite(sample)).not.toBe(null);
 expect(await stub.savedWrite(sample)).toBe(null);expect((await stub.savedList()).length).toBe(20);
 await stub.savedDelete(one.id);expect(await stub.savedRead(one.id)).toBe(null);expect((await stub.savedList()).length).toBe(19);
});
