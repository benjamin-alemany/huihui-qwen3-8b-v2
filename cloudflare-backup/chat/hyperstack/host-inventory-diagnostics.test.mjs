import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {HOST_INVENTORY_PREFIX,HOST_INVENTORY_FAILURE_PREFIX,parseHostInventory,parseHostInventoryFailure,collectHostInventory} from './host-inventory-diagnostics.mjs';
import {HOST_INVENTORY_PROFILE,HOST_INVENTORY_SERVING_IMAGE} from './host-inventory-render.mjs';
import {normalizeVM} from './policy.mjs';
import {rawVM,NOW} from './fixtures.mjs';
const SESSION='22222222-2222-4222-8222-222222222222',SOURCE='d'.repeat(64);
const canonical=x=>JSON.stringify(x,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value);
const UTILITIES=['/usr/bin/python3','/usr/bin/docker','/usr/bin/nvidia-ctk','/usr/bin/nvidia-container-cli','/usr/bin/nvidia-smi','/usr/bin/nsenter','/usr/bin/unshare','/usr/bin/setpriv','/usr/bin/mount','/usr/bin/umount','/usr/sbin/nft','/usr/sbin/ip','/usr/sbin/modinfo','/usr/sbin/modprobe','/usr/bin/systemctl','/usr/bin/bash','/usr/bin/dpkg','/usr/bin/dpkg-query','/usr/bin/uname'].sort();
function fixture(){
 const p=HOST_INVENTORY_PROFILE,target={environmentId:11,environmentName:'dummy-environment',region:p.region,flavorId:p.flavorId,flavorName:p.flavorName,imageId:p.imageId,imageName:p.imageName,keyName:'dummy-public-key',inferenceOrigin:'https://inference.unjailed.work',maximumHourlyUSD:p.maximumHourlyUSD};
 const reservation={kind:'chat',provider:'hyperstack',ownershipPolicy:'nonce-name-v2',minutes:30,name:'unjailed-chat-'+'a'.repeat(32),image:HOST_INVENTORY_SERVING_IMAGE,nonce:'a'.repeat(32),target,createdNotBefore:NOW,createdNotAfter:NOW+300000,deadline:NOW+1800000,windowStart:new Date(NOW).toISOString(),windowEnd:new Date(NOW+300000).toISOString()};
 const inventory={version:1,kind:'prepared-host-inventory-proposal',profile:'hyperstack-prepared-r570-v1',hostImage:{provider:p.provider,id:p.imageId,name:p.imageName,region:p.region},os:{id:'ubuntu',version:'24.04',architecture:'amd64'},kernelRelease:'6.8.0-1018-nvidia',driverVersion:'570.195.03',gpu:{count:1,name:'NVIDIA A100 80GB PCIe',pciDeviceId:'0x20B510DE'},dockerVersion:'28.1.1',packages:[{name:'docker-ce',version:'5:28.1.1-1~ubuntu.24.04~noble',architecture:'amd64'},{name:'libnvidia-compute-570',version:'570.195.03-0ubuntu1',architecture:'amd64'},{name:'nvidia-kernel-source-570',version:'570.195.03-0ubuntu1',architecture:'amd64'}],files:[{path:'/lib/modules/6.8.0-1018-nvidia/updates/dkms/nvidia.ko.zst',package:'nvidia-kernel-source-570',sha256:'a'.repeat(64),size:100},{path:'/usr/lib/x86_64-linux-gnu/libcuda.so.570.195.03',package:'libnvidia-compute-570',sha256:'b'.repeat(64),size:200}],utilities:UTILITIES.map(path=>({path,available:false,resolvedPath:null})),modelLoaded:false,cudaValidated:false,agentToolsEnabled:false,provenanceReviewRequired:true};
 const receipt={version:1,kind:'host-inventory-only-v1',sessionId:SESSION,nonce:reservation.nonce,deadlineUTC:new Date(reservation.deadline).toISOString(),observedAt:NOW+1000,sourceSHA256:SOURCE,inventoryOnly:true,modelLoaded:false,cudaValidated:false,boundaryValidated:false,modelPermitIssued:false,agentToolsEnabled:false,inventory};
 const allocation=normalizeVM(rawVM({image:{name:p.imageName},flavor:{id:100,name:p.flavorName,gpu:'A100-80G-PCIe',gpu_count:1,cpu:28,ram:120,disk:100}}));
 const binding={reservation,sessionId:SESSION,sourceSHA256:SOURCE,observedAt:NOW+2000};
 return {reservation,allocation,receipt,binding,logs:HOST_INVENTORY_PREFIX+canonical(receipt)+'\n'};
}
function collector(f,{processing=false,postPatch={},resultPatch={},readHook,fetchHook}={}){
 const calls=[];let gets=0,reads=0;
 const options={key:'DUMMY_PROVIDER_KEY_NOT_IN_RECEIPT',allocation:f.allocation,reservation:f.reservation,sessionId:SESSION,sourceSHA256:SOURCE,now:()=>NOW+2000,
  providerGet:async id=>{calls.push({type:'read',id});reads++;return readHook?readHook(reads):structuredClone(f.allocation);},
  fetchImpl:async(url,request)=>{
   calls.push({type:'fetch',url,method:request.method,body:request.body,redirect:request.redirect});
   assert.equal(request.headers.api_key,'DUMMY_PROVIDER_KEY_NOT_IN_RECEIPT');assert(request.signal instanceof AbortSignal);
   if(fetchHook)return fetchHook(url,request);
   if(request.method==='POST')return Response.json({status:true,request_id:8,...postPatch},{status:202});
   gets++;return Response.json({status:true,logs:processing&&gets===1?null:f.logs,...resultPatch});
  }};
 return {options,calls};
}
test('strict canonical parser returns only context-bound diagnostic proposal with every permit flag false',()=>{
 const f=fixture(),result=parseHostInventory('Unrelated boot line\n'+f.logs,f.binding);assert.deepEqual(result,f.receipt);
 assert.equal(result.modelPermitIssued,false);assert.equal(result.boundaryValidated,false);assert.equal(result.cudaValidated,false);assert.equal(result.inventory.provenanceReviewRequired,true);
 assert.equal(parseHostInventory(f.logs+f.logs,f.binding)?.sessionId,SESSION);
 assert.equal(parseHostInventory('Unrelated boot output',f.binding),null);
});
test('Python proposal contract accepts the same receipt inventory the JavaScript parser returns',()=>{
 const f=fixture(),parsed=parseHostInventory(f.logs,f.binding);assert(parsed);
 const command='import json,sys\nsys.path.insert(0,sys.argv[1]);from prepared_host import canonical_inventory\ncanonical_inventory(json.load(sys.stdin));print("PYTHON_PROPOSAL_ACCEPTED")';
 const run=spawnSync('python3',['-I','-B','-c',command,fileURLToPath(new URL('../../../vm/',import.meta.url))],{input:JSON.stringify(parsed.inventory),encoding:'utf8',timeout:5000});assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/PYTHON_PROPOSAL_ACCEPTED/);
});
test('source/session/nonce/deadline/time bindings, canonical JSON and duplicate keys are mandatory',()=>{
 for(const mutate of [f=>{f.receipt.sessionId='33333333-3333-4333-8333-333333333333';},f=>{f.receipt.sourceSHA256='f'.repeat(64);},f=>{f.receipt.nonce='b'.repeat(32);},f=>{f.receipt.deadlineUTC=new Date(NOW+1800001).toISOString();},f=>{f.receipt.observedAt=NOW-1;},f=>{f.receipt.observedAt=NOW+2001;},f=>{f.binding.observedAt=NOW+1800000;},f=>{f.binding.sourceSHA256='0'.repeat(64);},f=>{f.binding.reservation.target.imageId=574;},f=>{f.receipt.modelPermitIssued=true;},f=>{f.receipt.cudaValidated=true;},f=>{f.receipt.inferenceKey='NEVER_RETURN_DUMMY_SECRET';}]){
  const f=fixture();mutate(f);assert.equal(parseHostInventory(HOST_INVENTORY_PREFIX+canonical(f.receipt),f.binding),null);
 }
 const f=fixture(),json=canonical(f.receipt);
 for(const text of [json.replace('"version":1','"version":1,"version":1'),json.replace('"nonce":','"\\u006eonce":'),JSON.stringify(f.receipt,null,2),json+' ',json.replace('"inventoryOnly":true','"inventoryOnly":true,"arbitrary":"NEVER_RETURN_DUMMY_SECRET"')])assert.equal(parseHostInventory(HOST_INVENTORY_PREFIX+text,f.binding),null);
 const changed=structuredClone(f.receipt);changed.observedAt++;assert.equal(parseHostInventory(f.logs+HOST_INVENTORY_PREFIX+canonical(changed)+'\n',f.binding),null);
});
test('nested inventory rejects arbitrary strings, unknown fields, packages, paths and fabricated hardware',()=>{
 for(const mutate of [i=>{i.hostImage.id=518;},i=>{i.hostImage.token='NEVER_RETURN_DUMMY_SECRET';},i=>{i.os.version='22.04';},i=>{i.profile='vm-inference-v1';},i=>{i.driverVersion='580.95.05';},i=>{i.gpu.name='RTX-A6000';},i=>{i.gpu.count=2;},i=>{i.gpu.pciDeviceId='0x20B510de';},i=>{i.dockerVersion='NEVER_RETURN_DUMMY_SECRET';},i=>{i.kernelRelease='../etc/shadow';},i=>{i.packages[0].name='credential-agent';},i=>{i.packages[0].version='x\nSECRET';},i=>{i.packages.push(i.packages[0]);},i=>{i.packages.reverse();},i=>{i.files[0].path='/etc/shadow';},i=>{i.files[0].path='/lib/modules/6x8x0-1018-nvidia/updates/dkms/nvidia.ko.zst';},i=>{i.files[0].path='/lib/modules/6.8.0-1018-nvidia/updates/dkms/../nvidia.ko.zst';},i=>{i.files[0].sha256='0'.repeat(64);},i=>{i.files[0].size=256*1024**2+1;},i=>{i.files[0].package='other';},i=>{i.files.reverse();},i=>{i.files.push(i.files[0]);},i=>{i.utilities[0].available=true;i.utilities[0].resolvedPath='/etc/shadow';},i=>{i.utilities[0].available='true';},i=>{i.utilities.pop();},i=>{i.modelLoaded=true;},i=>{i.provenanceReviewRequired=false;}]){
  const f=fixture();mutate(f.receipt.inventory);assert.equal(parseHostInventory(HOST_INVENTORY_PREFIX+canonical(f.receipt),f.binding),null);
 }
});
test('optional daemon/toolkit binaries and closed usrmerge aliases match the actual Python allowlist',()=>{
 const f=fixture(),extra=['/usr/bin/dockerd','/usr/bin/containerd','/usr/bin/runc','/usr/bin/nvidia-container-runtime','/usr/bin/nvidia-container-runtime-hook','/usr/bin/kmod','/bin/bash','/sbin/nft','/lib/x86_64-linux-gnu/libcuda.so.570.195.03'];
 for(const path of extra)f.receipt.inventory.files.push({path,package:'docker-ce',sha256:'c'.repeat(64),size:100});
 f.receipt.inventory.files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 const parsed=parseHostInventory(HOST_INVENTORY_PREFIX+canonical(f.receipt),f.binding);assert(parsed);
 const command='import json,sys\nsys.path.insert(0,sys.argv[1]);from prepared_host import canonical_inventory\ncanonical_inventory(json.load(sys.stdin));print("PYTHON_ALIASES_ACCEPTED")';
 const run=spawnSync('python3',['-I','-B','-c',command,fileURLToPath(new URL('../../../vm/',import.meta.url))],{input:JSON.stringify(parsed.inventory),encoding:'utf8',timeout:5000});assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/PYTHON_ALIASES_ACCEPTED/);
 for(const path of ['/usr/bin/arbitrary-hook','/bin/arbitrary-hook','/usr/bin/nvidia-container-runtime-evil','/usr/bin/../bin/dockerd','/lib/../etc/shadow','/usr/sbin/docker-proxy']){
  const x=fixture();x.receipt.inventory.files[0].path=path;assert.equal(parseHostInventory(HOST_INVENTORY_PREFIX+canonical(x.receipt),x.binding),null);
 }
});
test('console and per-line size bounds never return raw native text',()=>{
 const f=fixture();assert.equal(parseHostInventory('X'.repeat(256*1024+1),f.binding),null);
 assert.equal(parseHostInventory(HOST_INVENTORY_PREFIX+' '.repeat(32768),f.binding),null);
 assert.equal(parseHostInventory(HOST_INVENTORY_PREFIX+'NEVER_RETURN_DUMMY_SECRET',f.binding),null);
});
function failureFixture(){
 const f=fixture(),receipt={version:1,kind:'host-inventory-failure-v1',sessionId:SESSION,nonce:f.reservation.nonce,deadlineUTC:new Date(f.reservation.deadline).toISOString(),sourceSHA256:SOURCE,observedAt:NOW+1000,phase:'package-file-provenance'};
 return {...f,receipt,logs:'\n'+HOST_INVENTORY_FAILURE_PREFIX+canonical(receipt)+'\n'};
}
test('failure parser exposes only a bound closed phase and rejects arbitrary errors or permits',()=>{
 const f=failureFixture();assert.deepEqual(parseHostInventoryFailure(f.logs,f.binding),f.receipt);assert.equal(parseHostInventory(f.logs,f.binding),null);
 assert.deepEqual(parseHostInventoryFailure(f.logs+f.logs,f.binding),f.receipt);
 for(const patch of [{phase:'NEVER_RETURN_DUMMY_SECRET'},{phase:'ready'},{sourceSHA256:'f'.repeat(64)},{nonce:'b'.repeat(32)},{sessionId:'33333333-3333-4333-8333-333333333333'},{observedAt:NOW-1},{observedAt:NOW+2001},{observedAt:1.5},{deadlineUTC:new Date(NOW+1800001).toISOString()},{modelPermitIssued:true},{error:'NEVER_RETURN_DUMMY_SECRET'}]){
  assert.equal(parseHostInventoryFailure(HOST_INVENTORY_FAILURE_PREFIX+canonical({...f.receipt,...patch}),f.binding),null);
 }
 const json=canonical(f.receipt);assert.equal(parseHostInventoryFailure(HOST_INVENTORY_FAILURE_PREFIX+json.replace('"phase":','"phase":"unknown","phase":'),f.binding),null);
 assert.equal(parseHostInventoryFailure(HOST_INVENTORY_FAILURE_PREFIX+json+' ',f.binding),null);
 assert.equal(parseHostInventoryFailure(HOST_INVENTORY_FAILURE_PREFIX+' '.repeat(32768),f.binding),null);
});
test('collector uses only the exact documented console API and validates the VM before and after capture',async()=>{
 const f=fixture(),{options,calls}=collector(f),result=await collectHostInventory(options);assert.deepEqual(result,f.receipt);
 assert.deepEqual(calls.map(call=>call.type),['read','fetch','read','fetch','read']);
 const fetches=calls.filter(call=>call.type==='fetch');assert.equal(fetches[0].url,'https://infrahub-api.nexgencloud.com/v1/core/virtual-machines/44/logs');assert.equal(fetches[0].method,'POST');assert.equal(fetches[0].body,'{"length":200}');assert.equal(fetches[1].method,'GET');assert.equal(fetches[1].url,fetches[0].url+'?request_id=8');assert(fetches.every(call=>call.redirect==='manual'));
 assert(!JSON.stringify(result).includes(options.key));assert.equal(result.modelPermitIssued,false);
});
test('collector supports one existing asynchronous log request without submitting another console job',async()=>{
 const f=fixture(),{options,calls}=collector(f,{processing:true});assert.deepEqual(await collectHostInventory(options),f.receipt);assert.equal(calls.filter(call=>call.method==='POST').length,1);assert.equal(calls.filter(call=>call.method==='GET').length,2);
});
test('collector retains a validated failure phase and rejects contradictory success/failure observations',async()=>{
 const f=failureFixture(),h=collector(f);assert.deepEqual(await collectHostInventory(h.options),f.receipt);assert.equal(h.calls.at(-1).type,'read');
 const success=fixture(),conflict=collector({...success,logs:success.logs+f.logs});assert.equal(await collectHostInventory(conflict.options),null);
 const absentAfter=collector(f,{readHook:count=>count===3?null:structuredClone(f.allocation)});assert.equal(await collectHostInventory(absentAfter.options),null);
});
test('renamed/replaced/stopped/absent VM, provider rejection and malformed bodies refuse without raw errors',async()=>{
 const f=fixture();
 for(const readHook of [()=>null,()=>({...f.allocation,status:'SHUTOFF'}),count=>count===3?({...f.allocation,id:'999'}):structuredClone(f.allocation),count=>count===3?({...f.allocation,createdAt:new Date(NOW+1).toISOString()}):structuredClone(f.allocation)])assert.equal(await collectHostInventory(collector(f,{readHook}).options),null);
 for(const postPatch of [{status:false},{request_id:'8'},{request_id:0},{request_id:1.1},{secret:'NEVER_RETURN_DUMMY_SECRET'}])assert.equal(await collectHostInventory(collector(f,{postPatch}).options),null);
 for(const resultPatch of [{status:false},{logs:77},{secret:'NEVER_RETURN_DUMMY_SECRET'},{logs:HOST_INVENTORY_PREFIX+'bad'}])assert.equal(await collectHostInventory(collector(f,{resultPatch}).options),null);
 for(const fetchHook of [async()=>new Response('NEVER_RETURN_DUMMY_SECRET',{status:400}),async()=>new Response('NEVER_RETURN_DUMMY_SECRET',{status:302,headers:{Location:'https://attacker.invalid'}}),async()=>{throw Error('NEVER_RETURN_DUMMY_SECRET');},async()=>new Response('{notJSON',{status:200})])assert.equal(await collectHostInventory(collector(f,{fetchHook}).options),null);
});
test('collector rejects invalid bindings before any provider request and refuses deadline during final readback',async()=>{
 const f=fixture();
 for(const patch of [{sourceSHA256:'bad'},{key:'short'},{sessionId:'../escape'},{allocation:{...f.allocation,id:'bad'}},{now:()=>NOW-1}]){const h=collector(f);Object.assign(h.options,patch);assert.equal(await collectHostInventory(h.options),null);assert.equal(h.calls.length,0);}
 const h=collector(f);let count=0;h.options.now=()=>++count>=8?f.reservation.deadline:NOW+2000;assert.equal(await collectHostInventory(h.options),null);assert.equal(h.calls.at(-1).type,'read');
});
