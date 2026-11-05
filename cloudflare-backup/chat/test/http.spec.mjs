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
