import test from 'node:test';
import assert from 'node:assert/strict';
import manifest from '../../../release/manifest.json' with {type:'json'};
import {runtimeHandshake} from './runtime-handshake.mjs';
import {sessionChecked,verifyHostGatewayReceipt} from './controller-factory.mjs';
import {hyperstackLifecycle} from './controller-policy.mjs';
import {normalizeVM} from './policy.mjs';
import {TARGET,NOW,Store,rawVM} from './fixtures.mjs';
const OUTER='o'.repeat(64),MODEL='m'.repeat(64),MARKER='hyperstack-runtime-handshake-v1:';
function setup(){
 const release={...structuredClone(manifest),status:'candidate',artifact:{...manifest.artifact,servingImage:'ghcr.io/benjamin-alemany/huihui-qwen3-8b-v2@sha256:'+'a'.repeat(64),bootstrapLockSha256:'b'.repeat(64),bootstrapBundleSha256:'c'.repeat(64),bootstrapSourceCommit:'f'.repeat(40),bootstrapBundleSize:100},hosting:{...manifest.hosting,vmImageId:TARGET.imageId}};
 const lifecycle=hyperstackLifecycle({target:TARGET,release}),reservation=lifecycle.reservation(NOW,'a'.repeat(32),30),allocation=normalizeVM(rawVM());
 const session={id:'22222222-2222-4222-8222-222222222222',nonce:reservation.nonce,phase:'validating',createAttempted:true,stopRequested:false,inferenceKey:OUTER,modelKey:MODEL,reservation,bootAt:NOW,deadline:reservation.deadline,quote:{minutes:30},knownPodIds:[allocation.id],knownAllocations:[allocation]};
 const storage=new Store();storage.rows.set('session-ledger-v1',{session});
 let time=NOW,stage='validated';const calls=[];
 const receipt=()=>({version:1,provider:'hyperstack',status:stage,modelLoaded:stage==='ready',sessionId:session.id,nonce:session.nonce,servingImage:release.artifact.servingImage,bootstrapLockSha256:release.artifact.bootstrapLockSha256,bootstrapBundleSha256:release.artifact.bootstrapBundleSha256,runtimeProfile:'vm-inference-v1',createdAt:new Date(NOW).toISOString(),deadlineUTC:new Date(session.deadline).toISOString(),sealed:true,nativeAttestation:true,privateNamespaces:true,modelEgressDenied:true,offlineCacheVerified:true,cudaReady:true,modelRevision:release.model.revision,modelName:release.model.servedName,agentToolsEnabled:false});
 const firewall=()=>({provider:'hyperstack',sealed:true,allocationId:allocation.id,nonce:session.nonce,deadline:session.deadline,policy:'tunnel-dns-egress-v1'});
 const h={release,lifecycle,reservation,allocation,session,storage,calls,receipt,firewall,set time(n){time=n;},set stage(s){stage=s;}};
 h.fetch=async(url,opt)=>{
  calls.push({type:'host',url,opt});assert.equal(opt.headers.Authorization,'Bearer '+OUTER);assert.equal(opt.redirect,'manual');
  if(url.endsWith('/host-ready'))return Response.json(receipt());
  assert.equal(url,'https://inference.unjailed.work/__unjailed/allow-model');assert.equal((await storage.get(MARKER+session.id)).phase,'permit-requested');const p=JSON.parse(opt.body);return Response.json({version:1,status:'permitted',...p});
 };
 h.seal=async(a,q)=>{calls.push({type:'firewall',a,q});return firewall();};
 h.make=(options={})=>runtimeHandshake({storage,target:TARGET,release,lifecycle,sessionChecked,verifyHostGatewayReceipt,sealFirewall:(...args)=>h.seal(...args),fetchImpl:(...args)=>h.fetch(...args),now:()=>time,...options});
 h.invoke=verify=>verify({allocation,origin:TARGET.inferenceOrigin,inferenceKey:OUTER});return h;
}
test('validated -> fresh provider seal -> durable intent -> exact host permit -> later actual ready',async()=>{
 const h=setup(),verify=h.make();assert.equal(await h.invoke(verify),false);assert.deepEqual(h.calls.map(x=>x.type),['host','firewall','host']);
 const permit=h.calls[2];assert.equal(permit.opt.method,'POST');assert.deepEqual(JSON.parse(permit.opt.body),{sessionId:h.session.id,nonce:h.session.nonce,deadlineUTC:new Date(h.session.deadline).toISOString()});
 const marker=await h.storage.get(MARKER+h.session.id);assert.equal(marker.phase,'permitted');assert(!JSON.stringify(marker).includes(OUTER));assert(!JSON.stringify(marker).includes(MODEL));assert(!JSON.stringify(marker).includes('api_key'));
 h.stage='ready';assert.equal(await h.invoke(verify),true);assert.deepEqual(h.calls.slice(3).map(x=>x.type),['host','firewall']);assert.equal(h.session.deadline,h.reservation.deadline);
});
test('initial ready, missing modelLoaded or ordinary model health cannot bypass prior provider seal and permit',async()=>{
 for(const patch of [{status:'ready',modelLoaded:true},{modelLoaded:undefined},{status:'ready',modelLoaded:false},{status:'ok'}]){
  const h=setup(),original=h.fetch;h.fetch=async(url,opt)=>{h.calls.push({type:'host'});return Response.json({...h.receipt(),...patch});};assert.equal(await h.invoke(h.make()),false);assert.equal(h.calls.length,1);assert.equal(await h.storage.get(MARKER+h.session.id),undefined);
 }
});
test('wrong firewall policy, allocation, nonce or expiry cannot send a model permit',async()=>{
 for(const patch of [{policy:'broad-egress'},{sealed:false},{allocationId:'99'},{nonce:'b'.repeat(32)},{deadline:NOW+999999},{apiKey:'DUMMY'}]){
  const h=setup();h.seal=async()=>{h.calls.push({type:'firewall'});return {...h.firewall(),...patch};};assert.equal(await h.invoke(h.make()),false);assert.deepEqual(h.calls.map(x=>x.type),['host','firewall']);assert.equal(await h.storage.get(MARKER+h.session.id),undefined);
 }
});
test('Stop or immutable expiry during provider seal prevents permit and durable intent',async()=>{
 for(const expired of [false,true]){
  const h=setup();h.seal=async()=>{h.calls.push({type:'firewall'});if(expired)h.time=h.session.deadline;else await h.storage.put('session-ledger-v1',{session:{...h.session,stopRequested:true}});return h.firewall();};
  assert.equal(await h.invoke(h.make()),false);assert.deepEqual(h.calls.map(x=>x.type),['host','firewall']);assert.equal(await h.storage.get(MARKER+h.session.id),undefined);
 }
});
test('a late global cleanup incident prevents permit without relying on the current session Stop flag',async()=>{
 const h=setup();h.seal=async()=>{h.calls.push({type:'firewall'});await h.storage.put('session-ledger-v1',{session:h.session,cleanupIncidents:[{sessionId:'DUMMY_OLD_SESSION',volumeIds:['77'],resolved:false}]});return h.firewall();};
 assert.equal(await h.invoke(h.make()),false);assert.deepEqual(h.calls.map(x=>x.type),['host','firewall']);assert.equal(await h.storage.get(MARKER+h.session.id),undefined);
});
test('lost permit acknowledgement retains exact intent and recovers only matching ready plus fresh seal',async()=>{
 const h=setup(),original=h.fetch;h.fetch=async(url,opt)=>{if(url.endsWith('/allow-model')){h.calls.push({type:'lost-permit',opt});throw Error('DUMMY_LOST_ACK');}return original(url,opt);};const verify=h.make();assert.equal(await h.invoke(verify),false);assert.equal((await h.storage.get(MARKER+h.session.id)).phase,'permit-requested');
 h.stage='ready';assert.equal(await h.invoke(verify),true);assert.equal(h.calls.filter(c=>c.type==='lost-permit').length,1);assert.equal((await h.storage.get(MARKER+h.session.id)).phase,'permitted');
});
test('identical validated permits retry without resetting the immutable deadline or changing payload',async()=>{
 const h=setup();let posts=0;const original=h.fetch;h.fetch=async(url,opt)=>{if(url.endsWith('/allow-model')){posts++;h.calls.push({type:'host',url,opt});return Response.json({version:1,status:'permitted',...JSON.parse(opt.body)});}return original(url,opt);};const verify=h.make();assert.equal(await h.invoke(verify),false);assert.equal(await h.invoke(verify),false);const bodies=h.calls.filter(c=>c.opt?.body).map(c=>c.opt.body);assert.equal(posts,2);assert.equal(bodies[0],bodies[1]);assert.equal((await h.storage.get(MARKER+h.session.id)).identity.deadline,h.session.deadline);
});
test('changed gateway pins or contradictory ACK cannot produce ready state',async()=>{
 for(const bad of ['bundle','ack']){
  const h=setup(),original=h.fetch;h.fetch=async(url,opt)=>{if(bad==='bundle'&&url.endsWith('/host-ready')){h.calls.push({type:'host'});return Response.json({...h.receipt(),bootstrapBundleSha256:'d'.repeat(64)});}if(bad==='ack'&&url.endsWith('/allow-model')){h.calls.push({type:'host'});return Response.json({version:1,status:'permitted',...JSON.parse(opt.body),deadlineUTC:new Date(h.session.deadline+1000).toISOString()});}return original(url,opt);};assert.equal(await h.invoke(h.make()),false);const m=await h.storage.get(MARKER+h.session.id);assert(bad==='bundle'?m===undefined:m.phase==='permit-requested');
 }
});
test('host origin, allocation and auth inputs cannot select external endpoints or control credentials',async()=>{
 const h=setup(),verify=h.make();for(const input of [{origin:'https://evil.invalid',inferenceKey:OUTER,allocation:h.allocation},{origin:TARGET.inferenceOrigin,inferenceKey:MODEL,allocation:h.allocation},{origin:TARGET.inferenceOrigin,inferenceKey:OUTER,allocation:{...h.allocation,id:'99'}}])assert.equal(await verify(input),false);assert.equal(h.calls.length,0);
});
