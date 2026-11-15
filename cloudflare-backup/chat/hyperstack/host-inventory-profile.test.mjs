import test from 'node:test';
import assert from 'node:assert/strict';
import {HOST_INVENTORY_RELEASE as release,HOST_INVENTORY_PAYLOAD as bundle,hostInventoryBootstrapReady,renderBoundHostInventory} from './host-inventory-profile.mjs';
import {releaseApprovedFor,acceptanceReleaseForTarget} from '../../../release/approval.mjs';
import {validateTarget,normalizeVM} from './policy.mjs';
import {hyperstackLifecycle} from './controller-policy.mjs';
import {hyperstackControllerFactory,boundBootstrapFor} from './controller-factory.mjs';
import {NOW,Store,rawVM} from './fixtures.mjs';

const target={environmentId:11,environmentName:'dummy-environment',region:'CANADA-1',flavorId:100,flavorName:'n3-A100x1',imageId:517,imageName:'Ubuntu Server 24.04 LTS R570 CUDA 12.8 with Docker',keyName:'dummy-keypair',inferenceOrigin:'https://inference.unjailed.work',maximumHourlyUSD:1.36};
const env={VALIDATION_MODE:'true',START_ENABLED:'true',APPROVED_ACCEPTANCE_ID:'DUMMY_FRESH_APPROVAL',HYPERSTACK_TARGET_JSON:JSON.stringify(target),HYPERSTACK_API_KEY:'DUMMY_PROVIDER_KEY_IN_CONTROLLER_ONLY',CLOUDFLARE_ACCOUNT_ID:'1'.repeat(32),CF_TAIL_TOKEN:'D'.repeat(40),ORIGINAL_ACCEPTANCE_JSON:JSON.stringify({capUSD:.51,spentUSD:.4,remainingUSD:.11}),OPERATOR_BUDGET_RECONCILIATION:JSON.stringify({id:'operator-budget-0123456789abcdef',capUnits:50000000000,spentFloorUnits:19638881734})};
function state(){
 const lifecycle=hyperstackLifecycle({target,release}),q=lifecycle.reservation(NOW,'a'.repeat(32),30),store=new Store();
 const session={id:'22222222-2222-4222-8222-222222222222',nonce:q.nonce,phase:'reconciling',createAttempted:true,stopRequested:false,inferenceKey:'o'.repeat(64),modelKey:'m'.repeat(64),reservation:q,bootAt:NOW,deadline:q.deadline,quote:{minutes:30}};
 store.rows.set('session-ledger-v1',{session});return {lifecycle,q,store,session};
}
test('inventory approval is exact, acceptance-only and cannot approve a serving release',()=>{
 assert(releaseApprovedFor('acceptance',release));assert(!releaseApprovedFor('production',release));
 assert.deepEqual(acceptanceReleaseForTarget({target,release}),release);
 for(const patch of [{status:'verified'},{id:'unjailed-chat-v1'},{artifact:{...release.artifact,runtimeProfile:'vm-inference-v1'}}])assert(!releaseApprovedFor('acceptance',{...structuredClone(release),...patch}));
 for(const patch of [{imageId:574},{flavorName:'n3-RTX-A6000x1'},{flavorId:111},{maximumHourlyUSD:1.37}])assert.throws(()=>acceptanceReleaseForTarget({target:{...target,...patch},release}));
});
test('prepared target is restricted to exact A100 image pair and old source cannot select it',()=>{
 assert.deepEqual(validateTarget(target),target);
 for(const patch of [{flavorId:111},{imageId:518},{flavorName:'n3-RTX-A6000x1'},{region:'NORWAY-1'}])assert.throws(()=>validateTarget({...target,...patch}));
 assert.throws(()=>acceptanceReleaseForTarget({target}));
});
test('the bound keyless renderer never forwards generated inference or legacy tunnel keys',async()=>{
 const {q,store,session}=state();const boot=boundBootstrapFor({storage:store,target,release,bundle,renderBootstrap:renderBoundHostInventory,hostTunnelCredential:{TunnelSecret:'DUMMY_NEVER_IN_GUEST'},now:()=>NOW});
 const output=await boot(q);assert(output.startsWith('#cloud-config\n'));
 const config=JSON.parse(output.slice('#cloud-config\n'.length));
 const decoded=config.write_files.map(f=>atob(f.content)).join('\n');
 for(const key of [session.inferenceKey,session.modelKey,'DUMMY_NEVER_IN_GUEST',env.HYPERSTACK_API_KEY])assert(!output.includes(key)&&!decoded.includes(key));
 for(const suffix of ['inference.env','gateway.json','tunnel.json','tunnel.yml'])assert(!config.write_files.some(f=>f.path.endsWith(suffix)));
});
test('tampered same-size source is rejected before a provider POST',async()=>{
 const {q,session}=state(),changed=structuredClone(bundle),name='inventory_deadline.py';
 const data=atob(changed.source.files[name]);changed.source.files[name]=btoa(data.replace('Local','local')===data?'#'+data.slice(1):data.replace('Local','local'));
 await assert.rejects(renderBoundHostInventory({reservation:q,session,release,bundle:changed,now:NOW}));
 assert(hostInventoryBootstrapReady(release,bundle));
});
test('inventory factory has no tunnel prerequisite, never performs health/firewall calls or exposes inference context',async()=>{
 const {store,lifecycle,q}=state();let calls=0;
 const factory=hyperstackControllerFactory({env,storage:store,release,bundle,renderBootstrap:renderBoundHostInventory,bootstrapReady:hostInventoryBootstrapReady,runtimeOrchestratorReady:hostInventoryBootstrapReady,now:()=>NOW,fetchImpl:async()=>{calls++;throw Error('No live HTTP');}});
 assert.equal(factory.enabled,true);assert.equal(factory.readiness.inventoryOnly,true);assert.equal(factory.readiness.modelLaunchPossible,false);assert.deepEqual(factory.readiness.blockers,[]);
 const allocation=normalizeVM(rawVM({image:{name:target.imageName},flavor:{id:100,name:target.flavorName,gpu:'A100-80G-PCIe',gpu_count:1,cpu:28,ram:120,disk:100}}));
 assert.equal(await factory.provider.health(allocation,'o'.repeat(64)),false);assert.equal(calls,0);
 assert.throws(()=>lifecycle.context({phase:'ready',pod:allocation,reservation:q}),e=>e.code==='HYPERSTACK_INVENTORY_ONLY');
 const production=hyperstackControllerFactory({env:{...env,VALIDATION_MODE:'false'},storage:store,release,bundle,renderBootstrap:renderBoundHostInventory,bootstrapReady:hostInventoryBootstrapReady,runtimeOrchestratorReady:hostInventoryBootstrapReady});
 assert.equal(production.enabled,false);assert(production.readiness.blockers.includes('HYPERSTACK_PRODUCTION_RELEASE_UNAPPROVED'));
});
