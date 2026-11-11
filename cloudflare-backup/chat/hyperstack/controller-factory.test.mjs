import test from 'node:test';
import assert from 'node:assert/strict';
import manifest from '../../../release/manifest.json' with {type:'json'};
import {hyperstackControllerFactory,boundBootstrapFor,boundHealthVerifier,verifyHostGatewayReceipt} from './controller-factory.mjs';
import {hyperstackLifecycle} from './controller-policy.mjs';
import {normalizeVM} from './policy.mjs';
import {TARGET,NOW,Store,rawVM} from './fixtures.mjs';
const PROVIDER_KEY='DUMMY_PROVIDER_KEY_NEVER_BOOTSTRAP',OUTER_KEY='o'.repeat(64),MODEL_KEY='m'.repeat(64);
const release=()=>({...structuredClone(manifest),status:'candidate',artifact:{...manifest.artifact,servingImage:'ghcr.io/benjamin-alemany/huihui-qwen3-8b-v2@sha256:'+'a'.repeat(64),bootstrapLockSha256:'b'.repeat(64),bootstrapBundleSha256:'c'.repeat(64),bootstrapSourceCommit:'f'.repeat(40),bootstrapBundleSize:100},hosting:{...manifest.hosting,vmImageId:TARGET.imageId}});
const tunnel={AccountTag:'a'.repeat(32),TunnelID:'11111111-1111-4111-8111-111111111111',TunnelSecret:btoa('D'.repeat(32))};
const environment=()=>({HOSTING_PROVIDER:'hyperstack',CLOUDFLARE_ACCOUNT_ID:'1'.repeat(32),CF_TAIL_TOKEN:'D'.repeat(40),START_ENABLED:'true',VALIDATION_MODE:'true',APPROVED_ACCEPTANCE_ID:'DUMMY_ACCEPTANCE',HYPERSTACK_TARGET_JSON:JSON.stringify(TARGET),HYPERSTACK_API_KEY:PROVIDER_KEY,HYPERSTACK_HOST_TUNNEL_CREDENTIAL_JSON:JSON.stringify(tunnel),ORIGINAL_ACCEPTANCE_JSON:JSON.stringify({capUSD:.51,spentUSD:.4,remainingUSD:.11}),OPERATOR_BUDGET_RECONCILIATION:JSON.stringify({id:'operator-budget-0123456789abcdef',capUnits:10000000000,spentFloorUnits:4000000000})});
function prepared(){
 const r=release(),lifecycle=hyperstackLifecycle({target:TARGET,release:r}),q=lifecycle.reservation(NOW,'a'.repeat(32),30),p=normalizeVM(rawVM());
 const s={id:'22222222-2222-4222-8222-222222222222',nonce:q.nonce,phase:'reconciling',createAttempted:true,stopRequested:false,inferenceKey:OUTER_KEY,modelKey:MODEL_KEY,reservation:q,bootAt:NOW,deadline:q.deadline,quote:{minutes:30},knownPodIds:[p.id],knownAllocations:[p],approval:'DUMMY_NOT_PASSED',ledger:'DUMMY_NOT_PASSED'};
 const store=new Store();store.rows.set('session-ledger-v1',{session:s,ledger:{cap:999}});return {r,lifecycle,q,p,s,store};
}
function receipt(s,r){return {version:1,provider:'hyperstack',status:'ready',sessionId:s.id,nonce:s.nonce,servingImage:r.artifact.servingImage,bootstrapLockSha256:r.artifact.bootstrapLockSha256,bootstrapBundleSha256:r.artifact.bootstrapBundleSha256,runtimeProfile:'vm-inference-v1',createdAt:new Date(s.bootAt).toISOString(),deadlineUTC:new Date(s.deadline).toISOString(),sealed:true,nativeAttestation:true,privateNamespaces:true,modelEgressDenied:true,offlineCacheVerified:true,cudaReady:true,modelRevision:r.model.revision,modelName:r.model.servedName,agentToolsEnabled:false};}

test('factory construction is side-effect free and flags/callbacks cannot replace source approval pins',()=>{
 const {store,r}=prepared();let calls=0;
 const f=hyperstackControllerFactory({env:{...environment(),APPROVED_ACCEPTANCE_RELEASE:JSON.stringify({releaseId:r.id})},storage:store,release:r,bundle:{},renderBootstrap:async()=>'',bootstrapReady:()=>true,runtimeOrchestratorReady:()=>true,fetchImpl:async()=>{calls++;throw Error();},now:()=>NOW});
 assert.equal(calls,0);assert.equal(f.connected,true);assert.equal(f.enabled,false);assert.equal(f.lifecycle.provider,'hyperstack');assert.equal(f.readiness.sourceApproved,false);assert(f.readiness.blockers.includes('HYPERSTACK_ACCEPTANCE_RELEASE_UNAPPROVED'));assert(!JSON.stringify(f.readiness).includes(PROVIDER_KEY));assert(!JSON.stringify(f.readiness).includes(tunnel.TunnelSecret));
});
test('malformed target, key and release never fall back to Runpod or send any request',async()=>{
 const {store,r}=prepared();let calls=0;const fetchImpl=async()=>{calls++;throw Error('No HTTP');};
 const control=hyperstackControllerFactory({env:environment(),storage:store,release:r,fetchImpl});assert.equal(control.connected,true);assert.equal(control.readiness.releasePinned,true);assert(!control.readiness.blockers.includes('HYPERSTACK_RELEASE_UNPINNED'));
 for(const patch of [{HYPERSTACK_TARGET_JSON:'{}'},{HYPERSTACK_API_KEY:'BAD\nKEY'},{HYPERSTACK_TARGET_JSON:'not JSON'}]){
  const f=hyperstackControllerFactory({env:{...environment(),RUNPOD_API_KEY:'DUMMY_RUNPOD_KEY',...patch},storage:store,release:r,fetchImpl});assert.equal(f.connected,false);assert.equal(f.enabled,false);assert.equal(f.lifecycle.provider,'hyperstack');await assert.rejects(f.provider.create({}));
 }
 const missing=structuredClone(r);missing.artifact.servingImage=null;
 const f=hyperstackControllerFactory({env:environment(),storage:store,release:missing,fetchImpl});assert.equal(f.connected,false);assert(f.readiness.blockers.includes('HYPERSTACK_RELEASE_UNPINNED'));await assert.rejects(f.catalog());assert.equal(calls,0);
});
test('missing budget, bundle, runtime orchestrator and tunnel credentials are independent blockers',()=>{
 const {store,r}=prepared(),env=environment();delete env.OPERATOR_BUDGET_RECONCILIATION;delete env.HYPERSTACK_HOST_TUNNEL_CREDENTIAL_JSON;
 const f=hyperstackControllerFactory({env,storage:store,release:r,now:()=>NOW});assert.equal(f.enabled,false);assert.deepEqual(f.operatorBudget,{invalid:true});
 for(const code of ['HYPERSTACK_BUDGET_UNRECONCILED','HYPERSTACK_HOST_TUNNEL_UNCONFIGURED','HYPERSTACK_BOOTSTRAP_UNAVAILABLE','HYPERSTACK_RUNTIME_ORCHESTRATOR_UNAVAILABLE'])assert(f.readiness.blockers.includes(code));
});
test('Hyperstack requires a real-format nonzero account and formatted tail token',()=>{
 const {store,r}=prepared();
 for(const patch of [{CLOUDFLARE_ACCOUNT_ID:undefined},{CLOUDFLARE_ACCOUNT_ID:'0'.repeat(32)},{CLOUDFLARE_ACCOUNT_ID:'bad'},{CF_TAIL_TOKEN:undefined},{CF_TAIL_TOKEN:'D'.repeat(40)+'\n'}]){
  const f=hyperstackControllerFactory({env:{...environment(),...patch},storage:store,release:r});assert.equal(f.enabled,false);
  assert(f.readiness.blockers.includes('CLOUDFLARE_ACCOUNT_ID'in patch?'HYPERSTACK_GUARD_ACCOUNT_UNCONFIGURED':'HYPERSTACK_GUARD_TAIL_TOKEN_UNCONFIGURED'));
 }
});
test('bound renderer receives only exact current session keys, separate model/outer secrets and typed tunnel credential',async()=>{
 const {store,r,q}=prepared();let received;
 const boot=boundBootstrapFor({storage:store,target:TARGET,release:r,bundle:{sha256:'DUMMY'},hostTunnelCredential:tunnel,now:()=>NOW,renderBootstrap:async p=>{received=p;return 'DUMMY_CLOUD_INIT';}});
 assert.equal(await boot(q),'DUMMY_CLOUD_INIT');assert.deepEqual(Object.keys(received).sort(),['bundle','hostTunnelCredential','now','release','reservation','session']);assert.deepEqual(Object.keys(received.session).sort(),['bootAt','createAttempted','deadline','id','inferenceKey','modelKey','nonce','phase','quote','reservation','stopRequested']);assert.equal(received.session.inferenceKey,OUTER_KEY);assert.equal(received.session.modelKey,MODEL_KEY);assert(!JSON.stringify(received).includes(PROVIDER_KEY));assert(!JSON.stringify(received).includes('DUMMY_NOT_PASSED'));
});
test('changed nonce, phase, credential equality, cancellation or expiry refuses bootstrap before any create',async()=>{
 for(const patch of [{nonce:'b'.repeat(32)},{phase:'stopping'},{modelKey:OUTER_KEY},{stopRequested:true}]){
  const {store,r,q,s}=prepared();Object.assign(s,patch);await store.put('session-ledger-v1',{session:s});let calls=0;
  const boot=boundBootstrapFor({storage:store,target:TARGET,release:r,hostTunnelCredential:tunnel,now:()=>NOW,renderBootstrap:async()=>{calls++;return 'dummy';}});await assert.rejects(boot(q));assert.equal(calls,0);
 }
 const {store,r,q,s}=prepared();const boot=boundBootstrapFor({storage:store,target:TARGET,release:r,hostTunnelCredential:tunnel,now:()=>NOW,renderBootstrap:async()=>{await store.put('session-ledger-v1',{session:{...s,stopRequested:true}});return 'dummy';}});await assert.rejects(boot(q));
});
test('unresolved global cleanup evidence refuses bootstrap even when the current session stop flag is false',async()=>{
 const {store,r,q,s}=prepared();await store.put('session-ledger-v1',{session:s,cleanupIncidents:[{sessionId:'DUMMY_OLD_SESSION',volumeIds:['77'],resolved:false}]});let calls=0;
 const boot=boundBootstrapFor({storage:store,target:TARGET,release:r,hostTunnelCredential:tunnel,now:()=>NOW,renderBootstrap:async()=>{calls++;return 'dummy';}});await assert.rejects(boot(q),e=>e.code==='HYPERSTACK_RESIDUAL_RESOURCE_REVIEW_REQUIRED');assert.equal(calls,0);
});
test('source-unapproved provider create refuses before HTTP even with a renderer and fabricated ready callbacks',async()=>{
 const {store,r,q}=prepared();let calls=0;
 const f=hyperstackControllerFactory({env:environment(),storage:store,release:r,bundle:{},renderBootstrap:async()=> 'DUMMY',bootstrapReady:()=>true,runtimeOrchestratorReady:()=>true,fetchImpl:async()=>{calls++;throw Error();},now:()=>NOW});
 await assert.rejects(f.provider.create(q),e=>e.outcome==='definite-no-create');assert.equal(calls,0);
});
test('strict host receipt binds release bundle, session nonce and original expiry; ordinary model health is insufficient',()=>{
 const {r,s}=prepared(),good=receipt(s,r);assert.equal(verifyHostGatewayReceipt(good,{session:s,release:r,now:NOW}),true);assert.equal(verifyHostGatewayReceipt({...good,vmId:null},{session:s,release:r,now:NOW}),true);
 for(const patch of [{nonce:'b'.repeat(32)},{servingImage:manifest.artifact.reusableOfflineBase},{bootstrapBundleSha256:'d'.repeat(64)},{deadlineUTC:new Date(s.deadline+1000).toISOString()},{nativeAttestation:false},{agentToolsEnabled:true},{vmId:44},{apiKey:'DUMMY'}])assert.equal(verifyHostGatewayReceipt({...good,...patch},{session:s,release:r,now:NOW}),false);
 assert.equal(verifyHostGatewayReceipt({status:'ok'},{session:s,release:r,now:NOW}),false);assert.equal(verifyHostGatewayReceipt(good,{session:s,release:{artifact:{runtimeProfile:'vm-inference-v1'}},now:NOW}),false);assert.equal(verifyHostGatewayReceipt(good,{session:s,release:r,now:s.deadline}),false);
});
test('health uses only fixed host gateway route and outer key, never model/provider key or allocation-selected URL',async()=>{
 const {store,r,s,p,lifecycle}=prepared();s.phase='ready';await store.put('session-ledger-v1',{session:s});const calls=[];
 const verify=boundHealthVerifier({storage:store,target:TARGET,release:r,lifecycle,now:()=>NOW,fetchImpl:async(url,opt)=>{calls.push({url,opt});return Response.json(receipt(s,r));}});
 assert.equal(await verify({allocation:p,origin:TARGET.inferenceOrigin,inferenceKey:OUTER_KEY}),true);assert.equal(calls[0].url,'https://inference.unjailed.work/__unjailed/host-ready');assert.equal(calls[0].opt.headers.Authorization,'Bearer '+OUTER_KEY);assert.equal(calls[0].opt.redirect,'manual');assert(!JSON.stringify(calls).includes(MODEL_KEY));assert(!JSON.stringify(calls).includes(PROVIDER_KEY));
 assert.equal(await verify({allocation:p,origin:'https://evil.invalid',inferenceKey:OUTER_KEY}),false);assert.equal(await verify({allocation:p,origin:TARGET.inferenceOrigin,inferenceKey:MODEL_KEY}),false);assert.equal(calls.length,1);
});
test('host health accepts equivalent V2 UTC wire forms and refuses a genuinely different creation instant',async()=>{
 const {store,r,s,p,lifecycle}=prepared(),calls=[];s.phase='ready';await store.put('session-ledger-v1',{session:s});
 const verify=boundHealthVerifier({storage:store,target:TARGET,release:r,lifecycle,now:()=>NOW,fetchImpl:async(url,opt)=>{calls.push({url,opt});return Response.json(receipt(s,r));}});
 for(const createdAt of [new Date(NOW).toISOString().slice(0,-1),'2026-11-10T07:00:00-05:00',new Date(NOW).toISOString()])assert.equal(await verify({allocation:{...p,createdAt},origin:TARGET.inferenceOrigin,inferenceKey:OUTER_KEY}),true);
 const before=calls.length;assert.equal(await verify({allocation:{...p,createdAt:new Date(NOW+1).toISOString()},origin:TARGET.inferenceOrigin,inferenceKey:OUTER_KEY}),false);assert.equal(calls.length,before);assert.equal((await store.get('session-ledger-v1')).session.knownAllocations[0].createdAt,p.createdAt);
});
test('Stop or an unknown allocation during host-health work cannot reopen inference',async()=>{
 const {store,r,s,p,lifecycle}=prepared();
 const verify=boundHealthVerifier({storage:store,target:TARGET,release:r,lifecycle,now:()=>NOW,fetchImpl:async()=>{await store.put('session-ledger-v1',{session:{...s,stopRequested:true}});return Response.json(receipt(s,r));}});
 assert.equal(await verify({allocation:p,origin:TARGET.inferenceOrigin,inferenceKey:OUTER_KEY}),false);
 await store.put('session-ledger-v1',{session:{...s,knownPodIds:[],knownAllocations:[]}});let called=false;const unknown=boundHealthVerifier({storage:store,target:TARGET,release:r,lifecycle,now:()=>NOW,fetchImpl:async()=>{called=true;throw Error();}});assert.equal(await unknown({allocation:p,origin:TARGET.inferenceOrigin,inferenceKey:OUTER_KEY}),false);assert.equal(called,false);
});
