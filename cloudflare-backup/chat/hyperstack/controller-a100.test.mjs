import test from 'node:test';
import assert from 'node:assert/strict';
import manifest from '../../../release/manifest.json' with {type:'json'};
import bundle from '../../../release/bootstrap-payload.json' with {type:'json'};
import {SessionEngine} from '../controller/engine.mjs';
import {SCALE,SEED,GPU} from '../controller/session-policy.mjs';
import {hyperstackLifecycle} from './controller-policy.mjs';
import {hyperstackClient} from './client.mjs';
import {validateCatalog,normalizeVM,validateTarget} from './policy.mjs';
import {renderCloudInit} from './bootstrap-render.mjs';
import {NOW,TARGET,Store,rawVM,catalogRaw} from './fixtures.mjs';

const A100={...TARGET,flavorId:77,flavorName:'n3-A100x1',maximumHourlyUSD:1.36};
const release=()=>({...structuredClone(manifest),status:'candidate',hosting:{...manifest.hosting,flavor:A100.flavorName,region:A100.region,vmImageId:A100.imageId}});
function catalog(){const r=catalogRaw(),f=r.flavors.data[0].flavors[0];Object.assign(f,{id:A100.flavorId,name:A100.flavorName,gpu:'A100-80G-PCIe',ram:120,ephemeral:750});r.flavors.data[0].gpu='A100-80G-PCIe';r.stocks.stocks[0].models[0].model='A100-80G-PCIe';r.pricebook[0]={name:'A100-80G-PCIe',value:'1.350000000'};return validateCatalog(r,A100,NOW);}
function vm(){const p=rawVM({labels:[]});Object.assign(p.flavor,{id:A100.flavorId,name:A100.flavorName,gpu:'A100-80G-PCIe',ram:120});return p;}
const lifecycle=()=>hyperstackLifecycle({target:A100,release:release()});
class EngineStore extends Store{async setAlarm(n){this.alarm=n;}async deleteAlarm(){this.alarm=null;}}

test('A100 catalog, quote and context bind the exact approved profile without changing inference artifacts',()=>{
 const l=lifecycle(),raw=catalog(),c=l.catalogFrom(raw),q=l.makeQuote(c,NOW,'dummy-quote',30),reservation=l.reservation(NOW,'a'.repeat(32),30),pod=normalizeVM(vm());
 assert.equal(c.gpu,'A100-80G-PCIe');assert.equal(q.gpu,'A100-80G-PCIe');assert.equal(q.totalHourlyUSD,1.35+.00672043);assert.equal(q.holdUnits,Math.ceil(q.totalHourlyUSD*35/60*SCALE));assert(q.maximumUSD<=.85&&q.maximumUSD>.75);assert.match(q.includes,/100 GB temporary root disk, 750 GB temporary ephemeral disk/);
 assert.equal(reservation.deadline,NOW+30*60000);assert.equal(l.validate(pod,reservation,1.35),pod);assert.equal(l.priceAccept(pod,{reservation,quote:q}),true);
 const env=l.context({phase:'ready',quote:q,reservation,pod,nonce:reservation.nonce,bootAt:NOW,deadline:reservation.deadline,inferenceKey:'c'.repeat(64)});assert.equal(JSON.parse(env.CHAT_SESSION).minutes,30);assert.equal(reservation.image,manifest.artifact.servingImage);
 assert.throws(()=>l.validate(normalizeVM(rawVM()),reservation,1.35));assert.throws(()=>l.catalogFrom({...raw,ramGB:58}));assert.throws(()=>l.makeQuote({...c,gpu:'RTX-A6000'},NOW,'wrong',30));
 const changed=release();changed.hosting.flavor=TARGET.flavorName;assert.throws(()=>hyperstackLifecycle({target:A100,release:changed}),/HYPERSTACK_RELEASE_UNPINNED/);
});

test('engine admits only the explicit A100 rate and existing test budget; legacy hourly ceiling remains one dollar',async()=>{
 for(const maximumUSD of [.85,.75]){
  const l=lifecycle(),store=new EngineStore(),ledger={...structuredClone(SEED),cap:2*SCALE,spent:SCALE,held:0,usedApprovals:['DUMMY_OLDER_CONSUMED_APPROVAL']};
  await store.put('session-ledger-v1',{ledger,session:null,quotes:[],ordinaryLedger:{version:1,cap:0,spent:0,held:0,grantCount:0}});
  let calls=0;const d={lifecycle:l,enabled:true,connected:true,validationMode:true,approval:'DUMMY_NEW_A100_APPROVAL',maxUSD:maximumUSD,maxHourly:1.36,now:()=>NOW,id:()=>crypto.randomUUID(),catalog:async()=>catalog(),wake:async()=>{},provider:{create:async()=>{calls++;throw Error('Never tick or create in this test');}}},e=new SessionEngine(store,d);
  const q=await e.quote({minutes:30});assert(q.maximumUSD<.85);assert.equal(q.minutes,30);
  if(maximumUSD===.85){await e.start({quoteId:q.id,maximumUSD:q.maximumUSD});const after=await e.read();assert.equal(after.ledger.cap,ledger.cap);assert.equal(after.ledger.spent,ledger.spent);assert.equal(after.ledger.held,Math.round(q.maximumUSD*SCALE));assert.deepEqual(after.ledger.usedApprovals,ledger.usedApprovals);assert.equal(after.ordinaryLedger.cap,0);assert.equal(after.session.createAttempted,false);}
  else {await assert.rejects(e.start({quoteId:q.id,maximumUSD:q.maximumUSD}),/APPROVAL_LIMIT/);assert.equal((await e.read()).ledger.held,0);}
  assert.equal(calls,0);d.maxHourly=1.360001;await assert.rejects(e.quote(),/PRICE_CHANGED/);
 }
 const legacy=new SessionEngine(new EngineStore(),{now:()=>NOW,id:()=>crypto.randomUUID(),maxHourly:1.36,catalog:async()=>({id:GPU,secure:true,price:{secure:.59},availability:'HIGH'})});await assert.rejects(legacy.quote(),/PRICE_CHANGED/);
});

test('A100 uses the existing bounded bootstrap and constrained client body with no provider key in guest data',async()=>{
 const r=release(),q=lifecycle().reservation(NOW,'a'.repeat(32),30),session={id:'11111111-1111-4111-8111-111111111111',nonce:q.nonce,phase:'reconciling',createAttempted:true,stopRequested:false,inferenceKey:'c'.repeat(64),modelKey:'d'.repeat(64),reservation:q,bootAt:NOW,deadline:q.deadline,quote:{minutes:30}};
 const text=await renderCloudInit({reservation:q,session,release:r,bundle,hostTunnelCredential:{TunnelID:'22222222-2222-4222-8222-222222222222',AccountTag:'3'.repeat(32),TunnelSecret:btoa('D'.repeat(32))},now:NOW});assert(Math.ceil(new TextEncoder().encode(text).length/3)*4<=65535);
 const cloudInit=JSON.parse(text.slice(text.indexOf('\n')+1)),logical=JSON.parse(atob(cloudInit.write_files.find(f=>f.path==='/etc/unjailed/session.json').content));assert.equal(logical.image,manifest.artifact.servingImage);assert.equal(logical.deadlineUTC,new Date(q.deadline).toISOString());
 const key='DUMMY_PROVIDER_KEY_NOT_IN_GUEST',calls=[];
 const client=hyperstackClient(key,{target:validateTarget(A100),now:()=>NOW,bootstrapFor:async()=>text,fetchImpl:async(url,options)=>{calls.push({url,options});return Response.json({status:true,instances:[vm()]});}});
 const p=await client.create(q);assert.equal(p.flavor.gpu,'A100-80G-PCIe');assert.equal(calls.length,1);assert.equal(calls[0].options.method,'POST');const body=JSON.parse(calls[0].options.body);assert.equal(body.flavor_name,'n3-A100x1');assert.equal(body.image_id,A100.imageId);assert.equal(body.count,1);assert.equal(body.create_bootable_volume,false);assert.deepEqual(body.security_rules,[]);assert(!('labels'in body));assert(!body.user_data.includes(key));
});
