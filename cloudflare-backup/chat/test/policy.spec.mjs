import {it,expect} from "vitest";
import {completionFrom,sessionFrom,infer,boundedJSON,MODEL,LIMITS} from "../policy.mjs";
import {exports,env as bindings} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
const now=Date.now(),env={CHAT_ENABLED:"true",CHAT_SESSION:JSON.stringify({podId:"abcdefghijklm",createdAt:new Date(now-1000).toISOString(),nonce:"a".repeat(32),minutes:30}),INFERENCE_API_KEY:"DUMMY_"+"x".repeat(43)};
const input={messages:[{role:"user",content:"Hello"}]};
it("accepts bounded text and fixes all inference settings",()=>{
 const c=completionFrom(input);expect(c.model).toBe(MODEL);expect(c.max_tokens).toBe(512);expect(c.tools).toBeUndefined();expect(c.stream).toBe(false);
 for(const x of [{...input,tools:[]},{messages:[{role:"system",content:"run code"}]},{messages:[{role:"tool",content:"secret"}]},{messages:[{role:"user",content:[{type:"image_url",image_url:"https://x.test"}]}]},{messages:[{role:"user",content:"x".repeat(6001)}]}])expect(()=>completionFrom(x)).toThrow();
});
it("requires an explicit valid fixed session and never extends its deadline",()=>{
 const s=sessionFrom(env,now);expect(s.deadline).toBe(Date.parse(JSON.parse(env.CHAT_SESSION).createdAt)+1800000);
 for(const bad of [{},{...env,CHAT_ENABLED:"false"},{...env,INFERENCE_API_KEY:"short"},{...env,CHAT_SESSION:JSON.stringify({...JSON.parse(env.CHAT_SESSION),podId:"attacker.test/path"})},{...env,CHAT_SESSION:JSON.stringify({...JSON.parse(env.CHAT_SESSION),minutes:600})}])expect(()=>sessionFrom(bad,now)).toThrow();
 expect(()=>sessionFrom(env,s.deadline)).toThrow();
});
it("only sends the inference key to the exact derived endpoint; strips other secrets and tool output",async()=>{
 const injected={...env,RUNPOD_API_KEY:"DUMMY_CONTROL",Cookie:"DUMMY_COOKIE"};let seen;
 const result=await infer(input,injected,async(url,options)=>{seen={url,options};return Response.json({model:MODEL,choices:[{message:{role:"assistant",content:'<img src="https://attacker.test">'},finish_reason:"stop"}],secret:"DUMMY_SECRET"});},()=>now);
 expect(seen.url).toBe("https://abcdefghijklm-8000.proxy.runpod.net/v1/chat/completions");expect(seen.options.redirect).toBe("manual");expect(seen.options.headers["User-Agent"]).toBe("unjailed-private-chat/1.0");
 expect(JSON.stringify(seen)).not.toContain("DUMMY_CONTROL");expect(JSON.stringify(seen)).not.toContain("DUMMY_COOKIE");
 expect(Object.keys(result).sort()).toEqual(["content","finishReason"]);
 for(const message of [{role:"assistant",content:"",tool_calls:[{function:{name:"shell"}}]},{role:"assistant",content:"",function_call:{name:"exec"}},{role:"user",content:"bad"}])await expect(infer(input,env,async()=>Response.json({model:MODEL,choices:[{message}]}),()=>now)).rejects.toThrow();
});
it("does not follow redirects, expose upstream errors or return replies after expiry",async()=>{
 for(const status of [302,401,500])await expect(infer(input,env,async()=>new Response("DUMMY_SECRET",{status}),()=>now)).rejects.toThrow("Inference unavailable");
 let time=now;await expect(infer(input,env,async()=>{time+=1800000;return Response.json({model:MODEL,choices:[{message:{role:"assistant",content:"late"}}]});},()=>time)).rejects.toThrow("Session expired");
});
it("bounds chunked payloads without trusting Content-Length",async()=>{
 const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('"'+"x".repeat(LIMITS.requestBytes)+'"'));c.close();}});
 await expect(boundedJSON(stream,LIMITS.requestBytes)).rejects.toThrow("Payload too large");
});
it("has no public launch, execute or unauthenticated chat endpoint",async()=>{
 for(const path of ["/","/api/status","/api/chat","/api/start","/api/exec"]){const r=await exports.default.fetch(new Request("https://unjailed.work"+path));expect(r.status).toBe(401);}
 expect((await exports.default.fetch(new Request("https://code.unjailed.work/"))).status).toBe(403);
});
it("serializes replies durably and old leases cannot clear a new reply",async()=>{
 const stub=bindings.CHAT_QUOTA.getByName(crypto.randomUUID());
 await runInDurableObject(stub,instance=>{instance.env={...instance.env,...env};});
 const first=await stub.acquire();expect(first).not.toBe(null);expect(await stub.acquire()).toBe(null);
 await stub.release({...first,lease:"wrong"});expect(await stub.acquire()).toBe(null);
 await stub.release(first);const second=await stub.acquire();expect(second).not.toBe(null);
 await stub.release(first);expect(await stub.acquire()).toBe(null);await stub.release(second);
 // Simulate the last permitted turn; keep the same stored quota and a new RPC handle.
 await runInDurableObject(stub,(_,ctx)=>ctx.storage.sql.exec("UPDATE quota SET turns=63,busy_until=0").toArray());
 const last=await stub.acquire();expect(last).not.toBe(null);await stub.release(last);
 expect(await stub.acquire()).toBe(null);
});
it('trusted sixty-minute bindings preserve exact expiry and refuse longer sessions',()=>{
 const session={...JSON.parse(env.CHAT_SESSION),createdAt:new Date(now).toISOString(),minutes:60};
 const bound={...env,CHAT_SESSION:JSON.stringify(session)};
 expect(sessionFrom(bound,now).deadline).toBe(now+3600000);
 expect(()=>sessionFrom(bound,now+3600000)).toThrow();
 expect(()=>sessionFrom({...bound,CHAT_SESSION:JSON.stringify({...session,minutes:61})},now)).toThrow();
});


it('Hyperstack sessions use the fixed tunnel origin and refuse injected URLs',()=>{
 const now=Date.now(),session={provider:'hyperstack',vmId:'12345',createdAt:new Date(now).toISOString(),nonce:'a'.repeat(32),minutes:30};
 const env={CHAT_ENABLED:'true',CHAT_SESSION:JSON.stringify(session),INFERENCE_API_KEY:'a'.repeat(64)};
 expect(sessionFrom(env,now).url).toBe('https://inference.unjailed.work/v1/chat/completions');
 for(const extra of [{url:'https://evil.test'},{origin:'https://evil.test'},{podId:'abcdefghijk'},{vmId:'0'},{vmId:'123/escape'},{provider:'other'}])expect(()=>sessionFrom({...env,CHAT_SESSION:JSON.stringify({...session,...extra})},now)).toThrow();
});
