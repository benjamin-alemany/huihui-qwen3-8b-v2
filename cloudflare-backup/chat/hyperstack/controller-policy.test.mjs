import test from 'node:test';
import assert from 'node:assert/strict';
import release from '../../../release/manifest.json' with {type:'json'};
import {SCALE} from '../controller/session-policy.mjs';
import {hyperstackLifecycle} from './controller-policy.mjs';
import {normalizeVM,validateCatalog,absenceReceipt} from './policy.mjs';
import {NOW,TARGET,rawVM,catalogRaw} from './fixtures.mjs';
function pinned(status='candidate'){return {...structuredClone(release),status,artifact:{...release.artifact,servingImage:'ghcr.io/benjamin-alemany/huihui-qwen3-8b-v2@sha256:'+'a'.repeat(64),bootstrapLockSha256:'b'.repeat(64),bootstrapBundleSha256:'e'.repeat(64),bootstrapSourceCommit:'f'.repeat(40),bootstrapBundleSize:100},hosting:{...release.hosting,flavor:TARGET.flavorName,region:TARGET.region,vmImageId:33}};}
const lifecycle=()=>hyperstackLifecycle({target:TARGET,release:pinned()});
function session(l=lifecycle()){
 const reservation=l.reservation(NOW,'a'.repeat(32),30),quote=l.makeQuote(l.catalogFrom(validateCatalog(catalogRaw(),TARGET,NOW)),NOW,'dummy-quote',30);
 return {phase:'ready',quote,reservation,bootAt:NOW,deadline:reservation.deadline,nonce:reservation.nonce,inferenceKey:'c'.repeat(64),pod:normalizeVM(rawVM())};
}
function proof(q){return {schedulerReady:true,provider:'hyperstack',...(q.ownershipPolicy!==undefined?{ownershipPolicy:q.ownershipPolicy}:{}),reservationName:q.name,image:q.image,nonce:q.nonce,deadline:q.deadline,guards:Object.fromEntries(['primary','backup'].map(role=>[role,{role,mode:'reservation',...(q.ownershipPolicy!==undefined?{ownershipPolicy:q.ownershipPolicy}:{}),nonce:q.nonce,expiry:q.deadline+(role==='backup'?60_000:0),eventTimestamp:NOW,version:'11111111-1111-4111-8111-111111111111'}]))};}
test('otherwise-pinned candidates reject unverified status and missing serving artifact independently',()=>{
 const valid=pinned();assert.equal(hyperstackLifecycle({target:TARGET,release:valid}).provider,'hyperstack');assert.equal(hyperstackLifecycle({target:TARGET,release:pinned('verified')}).provider,'hyperstack');
 for(const mutate of [r=>{r.status='unverified';},r=>{r.artifact.servingImage=null;}]){const invalid=structuredClone(valid);mutate(invalid);assert.throws(()=>hyperstackLifecycle({target:TARGET,release:invalid}),/HYPERSTACK_RELEASE_UNPINNED/);}
 for(const mutate of [r=>{r.artifact.servingImage='image:latest';},r=>{r.artifact.bootstrapLockSha256=null;},r=>{r.hosting.vmImageId=99;},r=>{r.hosting.driverBranch=595;},r=>{delete r.hosting.ownershipPolicy;},r=>{r.hosting.ownershipPolicy='label-v1';},r=>{r.model.revision='0'.repeat(40);},r=>{r.inference.origin='https://attacker.invalid';}]){const r=pinned();mutate(r);assert.throws(()=>hyperstackLifecycle({target:TARGET,release:r}));}
});
test('release and target cannot be changed after policy construction',()=>{
 const r=pinned(),t=structuredClone(TARGET),l=hyperstackLifecycle({target:t,release:r});r.artifact.servingImage='attacker:latest';r.hosting.ownershipPolicy='label-v1';t.imageId=999;const q=l.reservation(NOW,'a'.repeat(32),15);assert.match(q.image,/@sha256:a{64}$/);assert.equal(q.target.imageId,33);assert.equal(q.ownershipPolicy,'nonce-name-v2');assert(Object.isFrozen(l));assert(Object.isFrozen(l.target));
 const bound=JSON.parse(l.binding);assert.equal(bound.provider,'hyperstack');assert.equal(bound.ownershipPolicy,'nonce-name-v2');assert.equal(bound.image,q.image);assert.equal(bound.target.imageId,33);assert.equal(bound.bootstrapLockSha256,'b'.repeat(64));assert.equal(bound.runtimeProfile,'vm-inference-v1');assert.equal(l.binding,lifecycle().binding);
});
test('catalog bridge keeps authenticated GPU/IP price without fabricated p.cost',()=>{
 const l=lifecycle(),r=validateCatalog(catalogRaw(),TARGET,NOW),c=l.catalogFrom(r);assert.deepEqual(c,{provider:'hyperstack',gpu:'RTX-A6000',gpuHourly:.5,totalHourly:.50672043,availability:'AVAILABLE'});assert(!('cost' in normalizeVM(rawVM())));
 for(const patch of [{catalogVerified:false},{target:{...r.target,imageId:99}},{publicIpHourlyUSD:1},{availability:'HIGH'},{gpuCount:2}])assert.throws(()=>l.catalogFrom({...r,...patch}));
});
test('quotes use shared durable units, 15/30/60 minutes and explicit Hyperstack cost text',()=>{
 const l=lifecycle(),c=l.catalogFrom(validateCatalog(catalogRaw(),TARGET,NOW));for(const minutes of [15,30,60]){const q=l.makeQuote(c,NOW,'q',minutes);assert.equal(q.holdUnits,Math.ceil(.50672043*(minutes+5)/60*SCALE));assert.equal(q.maximumUSD,q.holdUnits/SCALE);assert.equal(q.provider,'hyperstack');assert.match(q.includes,/100 GB temporary root disk/);assert(!q.includes.includes('60 GB'));assert.equal(q.expiresAt,NOW+60000);}
 assert.equal(l.quoteMinutes(undefined,true),30);assert.equal(l.quoteMinutes({},false),30);assert.equal(l.quoteMinutes({minutes:15}),15);for(const bad of [{minutes:18},{minutes:30,extra:true},[],null])assert.throws(()=>l.quoteMinutes(bad));assert.equal(l.quoteMinutes({minutes:30},true),30);for(const minutes of [15,60])assert.throws(()=>l.quoteMinutes({minutes},true));assert.throws(()=>l.makeQuote(c,NOW,'q',18));
});
test('reservation fixes deadline at preflight, separates boot OS and immutable serving image',()=>{
 const l=lifecycle(),q=l.reservation(NOW,'a'.repeat(32),30);assert.equal(q.createdNotBefore,NOW);assert.equal(q.deadline,NOW+30*60000);assert.equal(q.createdNotAfter,NOW+5*60000);assert.equal(q.target.imageId,33);assert.equal(q.target.imageName,TARGET.imageName);assert.match(q.image,/@sha256:/);assert.equal(q.windowStart,new Date(NOW).toISOString());assert.equal(q.name.length,46);assert.throws(()=>l.reservation(NOW,'invalid',30));
});
test('new lifecycle accepts empty-label ownership V2 but cannot reinterpret old V1 reservations',()=>{
 const l=lifecycle(),s=session(l),empty=normalizeVM(rawVM({labels:[]}));assert.equal(s.reservation.ownershipPolicy,'nonce-name-v2');assert.equal(l.validate(empty,s.reservation,.5),empty);assert.equal(l.matches(empty,s.reservation),true);
 const original=structuredClone(s.reservation);delete original.ownershipPolicy;
 for(const p of [empty,s.pod]){assert.throws(()=>l.matches(p,original),/HYPERSTACK_RESERVATION_INVALID/);assert.throws(()=>l.validate(p,original,.5),/HYPERSTACK_RESERVATION_INVALID/);}
 assert.throws(()=>l.createBody({...s,reservation:original},NOW),/HYPERSTACK_RESERVATION_INVALID/);assert.throws(()=>l.context({...s,reservation:original}),/HYPERSTACK_RESERVATION_INVALID/);assert.equal(original.ownershipPolicy,undefined);
});
test('VM policy requires exact target and refuses volumes without asserting artifact verification',()=>{
 const l=lifecycle(),s=session(l);assert.equal(l.validate(s.pod,s.reservation,.5),s.pod);assert(l.matches(s.pod,s.reservation));assert.equal(s.pod.artifactVerified,false);
 for(const delta of [{id:44},{id:'../billing'},{volumeIds:['77']},{bootImageName:'other'},{flavor:{...s.pod.flavor,count:2}},{name:'unrelated'}])assert.throws(()=>l.validate({...s.pod,...delta},s.reservation,.5));assert.throws(()=>l.validate(s.pod,s.reservation,2));assert.throws(()=>l.validate(s.pod,s.reservation,NaN));
});
test('create body is exact public reservation without inference/provider/tunnel credentials',()=>{
 const l=lifecycle(),s=session(l),body=l.createBody(s,NOW+1000);assert.deepEqual(body,s.reservation);assert(!JSON.stringify(body).includes(s.inferenceKey));assert(!('inferenceKey' in body));assert(!('user_data' in body));assert.throws(()=>l.createBody({...s,deadline:s.deadline+1},NOW));assert.throws(()=>l.createBody({...s,bootAt:NOW+1},NOW+1));assert.throws(()=>l.createBody(s,s.reservation.createdNotAfter+1));
});
test('context binds exact provider VM/preflight expiry and only inference authentication',()=>{
 const l=lifecycle(),s=session(l),env=l.context(s);assert.deepEqual(Object.keys(env).sort(),['CHAT_ENABLED','CHAT_SESSION','INFERENCE_API_KEY']);assert.deepEqual(JSON.parse(env.CHAT_SESSION),{provider:'hyperstack',vmId:'44',createdAt:new Date(NOW).toISOString(),nonce:'a'.repeat(32),minutes:30});assert.equal(Date.parse(JSON.parse(env.CHAT_SESSION).createdAt)+30*60000,s.deadline);assert.equal(env.INFERENCE_API_KEY,s.inferenceKey);
 for(const delta of [{phase:'validating'},{stopRequested:true},{inferenceKey:'short'},{nonce:'b'.repeat(32)},{deadline:s.deadline+1}])assert.throws(()=>l.context({...s,...delta}));
});
test('price/status hooks use quoted authenticated rates and provider ACTIVE state',()=>{
 const l=lifecycle(),s=session(l);assert(l.priceAccept(s.pod,s));assert.equal(l.priceAccept(s.pod,{...s,quote:{...s.quote,totalHourlyUSD:1.1}}),false);assert.equal(l.priceAccept(s.pod,{...s,quote:{...s.quote,provider:'runpod'}}),false);assert(l.isRunning(s.pod));assert(!l.isRunning({...s.pod,status:'RUNNING'}));for(const status of ['ERROR','SHUTOFF','HIBERNATED','DELETED'])assert(l.isFailed({...s.pod,status}));assert(!l.isFailed({...s.pod,status:'BUILD'}));
});
test('cleanup completion never mistakes truthy legacy response for verified coupled cleanup',()=>{
 const l=lifecycle(),receipt=absenceReceipt({complete:true,vmAbsent:true,inventoryAbsent:true});assert(l.cleanupComplete(receipt));for(const value of [true,{},null,{complete:true},{...receipt,vmAbsent:false},{...receipt,unexpectedVolumeIds:['77']},{...receipt,independentIpReadback:true}])assert.equal(l.cleanupComplete(value),false);
});
test('Hyper receipts bind nonce/image/deadline/primary+backup expiry/fresh version metadata',()=>{
 const l=lifecycle(),q=l.reservation(NOW,'a'.repeat(32),30),p=proof(q);assert.doesNotThrow(()=>l.receiptFresh(p,q,NOW+1000));
 for(const mutate of [x=>{delete x.provider;},x=>{delete x.ownershipPolicy;},x=>{delete x.guards.primary.ownershipPolicy;},x=>{delete x.guards.backup.ownershipPolicy;},x=>{x.guards.backup.ownershipPolicy='label-v1';},x=>{x.image='image:latest';},x=>{x.deadline+=1;},x=>{x.nonce='b'.repeat(32);},x=>{x.guards.primary.expiry+=1;},x=>{x.guards.backup.expiry-=60000;},x=>{x.guards.primary.eventTimestamp=NOW-90001;},x=>{x.guards.primary.version='not-a-uuid';},x=>{x.guards.primary.nonce='b'.repeat(32);}]){const x=structuredClone(p);mutate(x);assert.throws(()=>l.receiptFresh(x,q,NOW));}
 assert.throws(()=>l.receiptFresh(p,q,q.createdNotAfter));assert.throws(()=>l.receiptFresh(p,q,NOW-1));
});
