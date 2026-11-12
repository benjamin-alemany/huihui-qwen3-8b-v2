import test from 'node:test';
import assert from 'node:assert/strict';
import {validateTarget,targetProfile,validateCatalog,validateReservation,normalizeVM,matchesReservation,assertBound,NONCE_NAME_OWNERSHIP} from './policy.mjs';
import {NOW,TARGET,RESERVATION,catalogRaw,rawVM} from './fixtures.mjs';

// Synthetic environment/image/key values; the approved flavor's public shape
// is exact. No credentials, live catalog, network access or resources are used.
const A100={...TARGET,flavorId:100,flavorName:'n3-A100x1',maximumHourlyUSD:1.36};
const PROFILE={flavorName:'n3-A100x1',gpu:'A100-80G-PCIe',count:1,cpu:28,ram:120,disk:100,ephemeral:750,vramGB:80,maximumHourlyUSD:1.36};
const reservation=()=>({...structuredClone(RESERVATION),target:structuredClone(A100)});
function catalog(){
 const raw=catalogRaw(),flavor=raw.flavors.data[0].flavors[0];
 Object.assign(flavor,{id:100,name:A100.flavorName,gpu:PROFILE.gpu,gpu_count:1,cpu:28,ram:120,disk:100,ephemeral:750});
 raw.flavors.data[0].gpu=PROFILE.gpu;
 raw.stocks.stocks[0].models[0].model=PROFILE.gpu;
 raw.pricebook[0]={name:PROFILE.gpu,value:'1.350000000'};
 return raw;
}
function allocation(){
 return rawVM({flavor:{id:100,name:A100.flavorName,gpu:PROFILE.gpu,gpu_count:1,cpu:28,ram:120,disk:100}});
}

test('closed A100 profile accepts only the reviewed Canada Ubuntu target and rate ceiling',()=>{
 assert.deepEqual(validateTarget(A100),A100);
 assert.deepEqual(targetProfile(A100),PROFILE);assert(Object.isFrozen(targetProfile(A100)));
 for(const delta of [{flavorName:'n3-A100x2'},{flavorName:'n3-A100x1-spot'},{flavorName:'n3-L40x1'},{flavorName:'__proto__'},{region:'US-1'},{imageName:'Ubuntu Server 24.04 LTS R595 CUDA 13.2 with Docker'},{maximumHourlyUSD:1.36000001},{maximumHourlyUSD:0},{flavorId:0}])assert.throws(()=>validateTarget({...A100,...delta}));
 assert.throws(()=>validateTarget({...TARGET,maximumHourlyUSD:1.36}),/HYPERSTACK_RATE_LIMIT_INVALID/);
});

test('A100 catalog binds exact IDs and derives its stock, included hardware and price from the closed profile',()=>{
 const result=validateCatalog(catalog(),A100,NOW);
 assert.equal(result.gpu,PROFILE.gpu);assert.equal(result.gpuCount,1);assert.equal(result.vramGB,80);assert.equal(result.cpu,28);assert.equal(result.ramGB,120);assert.equal(result.rootDiskGB,100);
 assert.equal(result.gpuHourlyUSD,1.35);assert(Math.abs(result.totalHourlyUSD-1.35672043)<1e-12);assert.equal(result.catalogVerified,true);assert.equal(result.runtimeVerified,false);assert.equal(result.permissionsVerified,false);
 assert.throws(()=>validateCatalog(catalog(),{...A100,flavorId:101},NOW),/HYPERSTACK_FLAVOR_UNVERIFIED/);
 assert.throws(()=>validateCatalog(catalog(),TARGET,NOW),/HYPERSTACK_FLAVOR_UNVERIFIED/);
});

test('every A100 hardware component, live single-GPU stock and correct price resource are required',()=>{
 for(const delta of [{gpu:'A100-80G-PCIe-NVLink'},{gpu_count:2},{cpu:27},{ram:119},{disk:200},{ephemeral:0},{ephemeral:undefined},{stock_available:false}]){
  const raw=catalog();Object.assign(raw.flavors.data[0].flavors[0],delta);assert.throws(()=>validateCatalog(raw,A100,NOW),/HYPERSTACK_FLAVOR_UNAVAILABLE/);
 }
 for(const mutate of [raw=>{raw.stocks.stocks[0].models[0].model='RTX-A6000';},raw=>{raw.stocks.stocks[0].models[0].configurations['1x']=0;},raw=>{raw.pricebook[0].name='RTX-A6000';},raw=>{raw.pricebook[0].value='1.36';},raw=>{raw.pricebook[2].value='0.01';}]){
  const raw=catalog();mutate(raw);assert.throws(()=>validateCatalog(raw,A100,NOW));
 }
});

test('A100 still requires both image and flavor compatibility, exact environment and keypair',()=>{
 for(const mutate of [raw=>{raw.images.images[0].images[0].flavor_restrictions={has_flavor_restrictions:true,restriction_type:'hard',compatible_flavors:[{flavor_id:22,link_type:'hard',constraints:{}}]};},raw=>{raw.flavors.data[0].flavors[0].image_restrictions={has_image_restrictions:true,restriction_type:'hard',compatible_images:[{image_id:99,link_type:'hard',constraints:{}}]};},raw=>{raw.environments.environments[0].region='US-1';},raw=>{raw.keypairs.keypairs[0].environment.id=99;}]){
  const raw=catalog();mutate(raw);assert.throws(()=>validateCatalog(raw,A100,NOW));
 }
});

test('A100 normalized ownership preserves the established wire shape without inventing provider fields',()=>{
 const q=reservation(),p=normalizeVM(allocation());
 assert.deepEqual(Object.keys(p.flavor).sort(),['id','name','gpu','count','cpu','ram','disk'].sort());assert.equal('ephemeral' in p.flavor,false);
 assert(matchesReservation(p,q));assert.equal(assertBound({...p,name:'renamed',labels:[]},p,q).id,p.id);
 for(const patch of [{gpu:'RTX-A6000'},{count:2},{cpu:29},{ram:58},{disk:200},{id:22},{name:TARGET.flavorName}])assert.equal(matchesReservation({...p,flavor:{...p.flavor,...patch}},q),false);
 assert.equal(matchesReservation(p,RESERVATION),false);assert.equal(matchesReservation(normalizeVM(rawVM()),q),false);
 assert.throws(()=>assertBound({...p,environment:{...p.environment,id:99}},p,q),/HYPERSTACK_OWNERSHIP_UNCONFIRMED/);
});

test('both A100 ownership policies preserve nonce/time binding and retain durable ID identity',()=>{
 const q=reservation(),p=normalizeVM(allocation());
 assert.equal(matchesReservation({...p,labels:[]},q),false);
 const v2={...q,kind:'chat',provider:'hyperstack',minutes:30,image:'ghcr.io/benjamin-alemany/huihui-qwen3-8b-v2@sha256:'+'b'.repeat(64),deadline:q.createdNotBefore+30*60000,windowStart:new Date(q.createdNotBefore).toISOString(),windowEnd:new Date(q.createdNotAfter).toISOString(),ownershipPolicy:NONCE_NAME_OWNERSHIP};
 assert.equal(validateReservation(v2).target.flavorName,A100.flavorName);assert(matchesReservation({...p,labels:[]},v2));
 assert.equal(matchesReservation({...p,createdAt:new Date(q.createdNotAfter+1).toISOString()},v2),false);
 assert.throws(()=>assertBound({...p,id:'99'},p,v2),/HYPERSTACK_OWNERSHIP_UNCONFIRMED/);
});

test('historical A6000 targets, reservations, catalogs and allocation serialization remain valid',()=>{
 assert.deepEqual(validateTarget(TARGET),TARGET);assert.deepEqual(validateReservation(RESERVATION),RESERVATION);
 assert.deepEqual(targetProfile(TARGET),{flavorName:TARGET.flavorName,gpu:'RTX-A6000',count:1,cpu:28,ram:58,disk:100,ephemeral:0,vramGB:48,maximumHourlyUSD:1});
 const result=validateCatalog(catalogRaw(),TARGET,NOW),p=normalizeVM(rawVM());
 assert.equal(result.totalHourlyUSD,.50672043);assert.equal(result.vramGB,48);assert.equal(result.ramGB,58);assert.equal('ephemeral' in p.flavor,false);
 assert(matchesReservation(p,RESERVATION));assert.equal(assertBound({...p,name:'historically-renamed',labels:[]},p,RESERVATION).id,p.id);
});
