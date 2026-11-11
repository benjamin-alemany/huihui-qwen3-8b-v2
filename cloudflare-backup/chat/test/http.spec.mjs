import {it,expect,vi} from "vitest";
import {exports,env} from "cloudflare:workers";
import {generateKeyPair,exportJWK,SignJWT} from "jose";
import {MODEL} from "../policy.mjs";
import gateway from '../worker.mjs';
it("requires the signed owner JWT and same-origin JSON before contacting inference",async()=>{
 const {privateKey,publicKey}=await generateKeyPair("RS256"),jwk=await exportJWK(publicKey);jwk.kid="dummy-http-test";
 const token=async(overrides={})=>new SignJWT({sub:"owner",email:env.OWNER_EMAIL,iss:env.ACCESS_ISSUER,aud:env.ACCESS_AUD,
   iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600,...overrides})
   .setProtectedHeader({alg:"RS256",kid:jwk.kid}).sign(privateKey);
 const calls=[];
 const spy=vi.spyOn(globalThis,"fetch").mockImplementation(async(url,options)=>{
   if(String(url)===env.ACCESS_ISSUER+"/cdn-cgi/access/certs")return Response.json({keys:[jwk]});
   calls.push({url:String(url),options});
   expect(String(url)).toBe("https://abcdefghijklm-8000.proxy.runpod.net/v1/chat/completions");
   return Response.json({model:MODEL,choices:[{message:{role:"assistant",content:"Dummy reply"},finish_reason:"stop"}]});
 });
 try{
   const request=(jwt,origin="https://unjailed.work",path="/api/chat")=>new Request("https://unjailed.work"+path,{method:"POST",
     headers:{"Cf-Access-Jwt-Assertion":jwt,"Origin":origin,"Content-Type":"application/json","X-Workstation-Request":"1","Cookie":"DUMMY_BROWSER_COOKIE"},
     body:JSON.stringify({messages:[{role:"user",content:"Hello"}]})});
   expect((await exports.default.fetch(request(await token({email:"attacker@example.test"})))).status).toBe(401);
   expect((await exports.default.fetch(request(await token({aud:"dummy-controller-audience"})))).status).toBe(401);
   expect((await exports.default.fetch(request(await token(),"https://attacker.test"))).status).toBe(403);
   expect(calls).toHaveLength(0);
   const valid=await token();const r=await exports.default.fetch(request(valid));expect(r.status).toBe(200);expect(await r.json()).toEqual({content:"Dummy reply",finishReason:"stop"});
   expect(calls).toHaveLength(1);expect(JSON.stringify(calls)).not.toContain(valid);expect(JSON.stringify(calls)).not.toContain("DUMMY_BROWSER_COOKIE");
   for(const path of ["/api/start","/api/exec","/api/terminal","/api/upgrade"])
     expect((await exports.default.fetch(request(valid,"https://unjailed.work",path))).status).toBe(404);
   expect((await exports.default.fetch(request(valid,"https://attacker.test","/api/history/save"))).status).toBe(403);
   const anonymousHistory=await exports.default.fetch(new Request("https://unjailed.work/api/history"));expect(anonymousHistory.status).toBe(401);
   const backup={format:'unjailed.chat-backup',version:1,conversations:[{title:'HTTP restore',messages:[{role:'user',content:'DUMMY restore'}]}]};
   const restoreRequest=(path,body=backup,origin='https://unjailed.work',jwt=valid)=>new Request('https://unjailed.work'+path,{method:'POST',headers:{'Cf-Access-Jwt-Assertion':jwt,Origin:origin,'Content-Type':'application/json','X-Workstation-Request':'1'},body:JSON.stringify(body)});
   for(const path of ['/api/history/import','/api/history/import/preview']){
    expect((await exports.default.fetch(restoreRequest(path,backup,'https://attacker.test'))).status).toBe(403);
    expect((await exports.default.fetch(restoreRequest(path,backup,'https://unjailed.work','forged'))).status).toBe(401);
    expect((await exports.default.fetch(restoreRequest(path,{...backup,version:2}))).status).toBe(400);
   }
   expect((await exports.default.fetch(new Request('https://unjailed.work/api/history/backup'))).status).toBe(401);
   expect((await (await exports.default.fetch(restoreRequest('/api/history/import/preview'))).json()).importable).toBe(1);
   expect((await exports.default.fetch(restoreRequest('/api/history/import'))).status).toBe(201);
   const exportResponse=await exports.default.fetch(new Request('https://unjailed.work/api/history/backup',{headers:{'Cf-Access-Jwt-Assertion':valid}}));
   expect(exportResponse.headers.get('Cache-Control')).toBe('no-store');expect(await exportResponse.json()).toEqual({format:'unjailed.chat-backup',version:2,conversations:[{title:'HTTP restore',messages:[],draft:'DUMMY restore'}]});
   expect(calls).toHaveLength(1);
   const checkRequest=(body={},origin='https://unjailed.work',jwt=valid)=>new Request('https://unjailed.work/api/controller/check',{method:'POST',headers:{'Cf-Access-Jwt-Assertion':jwt,Origin:origin,'Content-Type':'application/json','X-Workstation-Request':'1'},body:JSON.stringify(body)});
   expect((await exports.default.fetch(checkRequest({},'https://attacker.test'))).status).toBe(403);
   expect((await exports.default.fetch(checkRequest({},'https://unjailed.work','forged'))).status).toBe(401);
   expect((await exports.default.fetch(checkRequest({launch:true}))).status).toBe(400);
   const check=await exports.default.fetch(checkRequest());expect(check.status).toBe(202);expect((await check.json()).launchEnabled).toBe(false);
   expect(calls).toHaveLength(1);
   for(const path of ['/api/session/quote','/api/session/start','/api/session/stop']){
    expect((await exports.default.fetch(request(valid,'https://attacker.test',path))).status).toBe(403);
    expect((await exports.default.fetch(request('forged','https://unjailed.work',path))).status).toBe(401);
   }
   const document={id:crypto.randomUUID(),revision:0,title:'HTTP autosave',messages:[],draft:'Exact cloud draft'};
   expect((await exports.default.fetch(restoreRequest('/api/history/upsert',document,'https://attacker.test'))).status).toBe(403);
   expect((await exports.default.fetch(restoreRequest('/api/history/upsert',document,'https://unjailed.work','forged'))).status).toBe(401);
   const upsert=await exports.default.fetch(restoreRequest('/api/history/upsert',document));expect(upsert.status).toBe(200);const current=(await upsert.json()).item;expect(current).toMatchObject({...document,revision:1});
   const conflict=await exports.default.fetch(restoreRequest('/api/history/upsert',document));expect(conflict.status).toBe(409);expect((await conflict.json()).item).toEqual(current);
   const turn={conversationId:current.id,revision:1,turnId:crypto.randomUUID()};
   expect((await exports.default.fetch(restoreRequest('/api/turns',turn,'https://attacker.test'))).status).toBe(403);
   expect((await exports.default.fetch(restoreRequest('/api/turns',turn,'https://unjailed.work','forged'))).status).toBe(401);
   expect((await exports.default.fetch(new Request('https://unjailed.work/api/turns/'+turn.turnId))).status).toBe(401);
   expect((await exports.default.fetch(restoreRequest('/api/turns',{...turn,url:'https://attacker.test'}))).status).toBe(400);
   expect((await exports.default.fetch(restoreRequest('/api/session/quote',{minutes:30}))).status).toBe(200);
   expect((await exports.default.fetch(restoreRequest('/api/session/quote',{minutes:10}))).status).toBe(400);
   expect((await exports.default.fetch(restoreRequest('/api/session/grant',{grantId:crypto.randomUUID(),amountUSD:1},'https://attacker.test'))).status).toBe(403);
   expect((await exports.default.fetch(restoreRequest('/api/session/grant',{grantId:crypto.randomUUID(),amountUSD:1},'https://unjailed.work','forged'))).status).toBe(401);
   expect((await exports.default.fetch(restoreRequest('/api/session/grant',{grantId:crypto.randomUUID(),amountUSD:1}))).status).toBe(202);
   let context=null;
   const dynamic={...env,SESSION_CONTROLLER_ENABLED:'true',INFERENCE_CONTROLLER:{context:async()=>context}};
   expect((await gateway.fetch(request(valid),dynamic)).status).toBe(503);expect(calls).toHaveLength(1);
   context={CHAT_ENABLED:'true',CHAT_SESSION:env.CHAT_SESSION,INFERENCE_API_KEY:env.INFERENCE_API_KEY};
   const first=await gateway.fetch(request(valid),dynamic);expect(first.status).toBe(200);expect(calls).toHaveLength(2);
   // Revoke after the pre-request context, as if Stop arrived during a reply.
   let reads=0;dynamic.INFERENCE_CONTROLLER.context=async()=>++reads===1?context:null;
   expect((await gateway.fetch(request(valid),dynamic)).status).toBe(503);expect(calls).toHaveLength(3);
 }finally{spy.mockRestore();}
});
