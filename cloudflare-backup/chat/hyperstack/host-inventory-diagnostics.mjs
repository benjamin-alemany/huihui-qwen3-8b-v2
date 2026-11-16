// Supervised operator capture only. Call before Stop, then save the validated
// proposal privately. This collector never persists DO state, reports health,
// seals a firewall, approves a host lock or grants a model permit. The ordinary
// controller progress parser deliberately does not accept these receipts.
import {boundedJSON} from '../policy.mjs';
import {API_BASE,assertBound,matchesReservation,providerId,validateReservation} from './policy.mjs';
import {HOST_INVENTORY_PROFILE,HOST_INVENTORY_SERVING_IMAGE} from './host-inventory-render.mjs';

export const HOST_INVENTORY_PREFIX='UNJAILED_HOST_INVENTORY ';
export const HOST_INVENTORY_FAILURE_PREFIX='UNJAILED_HOST_INVENTORY_FAILURE ';
const MAX_RESPONSE=512*1024,MAX_LINE=65536,REQUEST_MS=8000,OPERATION_MS=30000;
const MAX_FILE_BYTES=256*1024**2,MAX_TOTAL_BYTES=1536*1024**2;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/,KERNEL=/^[A-Za-z0-9][A-Za-z0-9.+-]{0,99}$/;
const VERSION=/^[A-Za-z0-9][A-Za-z0-9.+:~_-]{0,99}$/,DRIVER=/^570\.[0-9]{1,3}\.[0-9]{1,3}$/;
const UTILITIES=Object.freeze(['/usr/bin/python3','/usr/bin/docker','/usr/bin/nvidia-ctk','/usr/bin/nvidia-container-cli','/usr/bin/nvidia-smi','/usr/bin/nsenter','/usr/bin/unshare','/usr/bin/setpriv','/usr/bin/mount','/usr/bin/umount','/usr/sbin/nft','/usr/sbin/ip','/usr/sbin/modinfo','/usr/sbin/modprobe','/usr/bin/systemctl','/usr/bin/bash','/usr/bin/dpkg','/usr/bin/dpkg-query','/usr/bin/uname'].sort());
const UTILITY_PACKAGES=new Set(['docker-ce','docker-ce-cli','docker.io','containerd.io','containerd','runc','nvidia-container-toolkit','nvidia-container-toolkit-base','libnvidia-container1','libnvidia-container-tools','nftables','iproute2','util-linux','mount','kmod','systemd','bash','dpkg','coreutils','libseccomp2','python3-minimal','python3.12-minimal','libpython3.12-minimal']);
const NVIDIA_PACKAGE=/^(?:nvidia-(?:driver|headless|headless-no-dkms|dkms|kernel-common|kernel-source|utils|compute-utils)-570(?:-server)?(?:-open)?|libnvidia-(?:compute|common|extra|decode|encode|fbc1|gl)-570(?:-server)?|nvidia-firmware-570(?:-server)?(?:-[0-9]+(?:\.[0-9]+){1,3})?|cuda-drivers-570|linux-(?:modules|objects|signatures)-nvidia-570(?:-server)?(?:-open)?-[A-Za-z0-9.+-]+)$/;
const GPU_LIBRARY=/^\/usr\/lib\/(?:x86_64-linux-gnu|x86_64-linux-gnu\/nvidia\/current)\/lib(?:cuda|cudadebugger|nvidia-[a-z0-9-]+)\.so(?:\.[0-9]+)*$/;
const GPU_BINARY=new Set(['/usr/bin/nvidia-cuda-mps-control','/usr/bin/nvidia-cuda-mps-server']);
const HOST_EXECUTABLES=new Set(['/usr/bin/dockerd','/usr/bin/containerd','/usr/bin/runc','/usr/bin/nvidia-container-runtime','/usr/bin/nvidia-container-runtime-hook']);
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,fields)=>plain(x)&&Object.keys(x).sort().join()===fields.slice().sort().join();
const canonical=x=>JSON.stringify(x,(_key,value)=>plain(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value);
const safeTime=x=>Number.isSafeInteger(x)&&x>=0&&x<=8_640_000_000_000_000;
const nonzeroHash=x=>typeof x==='string'&&HASH.test(x)&&x!=='0'.repeat(64);
const escaped=x=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const refuse=()=>{throw Error('Host inventory unavailable');};
function context({reservation,sessionId,sourceSHA256,observedAt}){
 const q=validateReservation(reservation),t=q.target,p=HOST_INVENTORY_PROFILE;
 if(q.kind!=='chat'||q.provider!=='hyperstack'||q.ownershipPolicy!=='nonce-name-v2'||q.minutes!==30||q.image!==HOST_INVENTORY_SERVING_IMAGE||q.deadline!==q.createdNotBefore+1800000||t.imageId!==p.imageId||t.imageName!==p.imageName||t.flavorId!==p.flavorId||t.flavorName!==p.flavorName||t.region!==p.region||t.maximumHourlyUSD>p.maximumHourlyUSD||!UUID.test(sessionId??'')||!nonzeroHash(sourceSHA256)||!safeTime(observedAt)||observedAt<q.createdNotBefore||observedAt>=q.deadline)refuse();
 return q;
}
const packageAllowed=(name,kernel)=>typeof name==='string'&&(UTILITY_PACKAGES.has(name)||NVIDIA_PACKAGE.test(name)||['linux-image-'+kernel,'linux-modules-'+kernel,'linux-modules-extra-'+kernel].includes(name));
function pathAllowed(path,kernel,driver){
 if(typeof path!=='string')return false;
 // Match the Python producer's closed usrmerge aliases; do not resolve a
 // console-supplied path or accept any general symlink destination.
 const normalized=['/bin/','/sbin/','/lib/'].some(prefix=>path.startsWith(prefix))?'/usr'+path:path;
 return UTILITIES.includes(normalized)||GPU_BINARY.has(normalized)||HOST_EXECUTABLES.has(normalized)||GPU_LIBRARY.test(normalized)||
  new RegExp('^/usr/lib/firmware/nvidia/'+escaped(driver)+'/gsp_[a-z0-9_]+\\.bin$').test(normalized)||
  new RegExp('^/usr/lib/modules/'+escaped(kernel)+'/(?:updates/dkms|kernel/nvidia-570(?:-server)?|kernel/drivers/video(?:/nvidia)?)/nvidia\\.ko(?:\\.(?:xz|zst|gz))?$').test(normalized)||
  ['/usr/bin/python3.12','/usr/bin/ip','/usr/bin/nft','/usr/bin/kmod','/usr/bin/modinfo','/usr/bin/modprobe'].includes(normalized);
}
function inventoryFrom(value){
 const fields=['version','kind','profile','hostImage','os','kernelRelease','driverVersion','gpu','dockerVersion','packages','files','utilities','modelLoaded','cudaValidated','agentToolsEnabled','provenanceReviewRequired'];
 const p=HOST_INVENTORY_PROFILE;
 if(!exact(value,fields)||value.version!==1||value.kind!=='prepared-host-inventory-proposal'||value.profile!=='hyperstack-prepared-r570-v1'||!exact(value.hostImage,['provider','id','name','region'])||value.hostImage.provider!==p.provider||value.hostImage.id!==p.imageId||value.hostImage.name!==p.imageName||value.hostImage.region!==p.region||!exact(value.os,['id','version','architecture'])||value.os.id!=='ubuntu'||value.os.version!=='24.04'||value.os.architecture!=='amd64'||['modelLoaded','cudaValidated','agentToolsEnabled'].some(key=>value[key]!==false)||value.provenanceReviewRequired!==true)refuse();
 const kernel=value.kernelRelease,driver=value.driverVersion;
 if(typeof kernel!=='string'||!KERNEL.test(kernel)||typeof driver!=='string'||!DRIVER.test(driver)||typeof value.dockerVersion!=='string'||value.dockerVersion.length>100||!/^\d+\.\d+\.\d+(?:[+~.-][A-Za-z0-9.+~_-]+)?$/.test(value.dockerVersion))refuse();
 const gpu=value.gpu;
 if(!exact(gpu,['count','name','pciDeviceId'])||gpu.count!==1||!['NVIDIA A100 80GB PCIe','A100 80GB PCIe'].includes(gpu.name)||typeof gpu.pciDeviceId!=='string'||!/^0x[0-9A-F]{4}10DE$/.test(gpu.pciDeviceId))refuse();
 if(!Array.isArray(value.packages)||value.packages.length<1||value.packages.length>96)refuse();
 const packages=value.packages.map(item=>{
  if(!exact(item,['name','version','architecture'])||!packageAllowed(item.name,kernel)||typeof item.version!=='string'||!VERSION.test(item.version)||!['amd64','all'].includes(item.architecture))refuse();
  return {name:item.name,version:item.version,architecture:item.architecture};
 });
 const names=packages.map(item=>item.name);
 if(names.join()!==[...new Set(names)].sort().join()||!names.some(name=>NVIDIA_PACKAGE.test(name)))refuse();
 if(!Array.isArray(value.files)||value.files.length<1||value.files.length>96)refuse();
 let total=0;
 const files=value.files.map(item=>{
  if(!exact(item,['path','package','sha256','size'])||!pathAllowed(item.path,kernel,driver)||!names.includes(item.package)||!nonzeroHash(item.sha256)||!Number.isSafeInteger(item.size)||item.size<=0||item.size>MAX_FILE_BYTES)refuse();
  total+=item.size;return {path:item.path,package:item.package,sha256:item.sha256,size:item.size};
 });
 const paths=files.map(item=>item.path);
 if(total>MAX_TOTAL_BYTES||paths.join()!==[...new Set(paths)].sort().join()||!paths.some(path=>path.includes('/libcuda.so'))||!paths.some(path=>/\/nvidia\.ko(?:\.|$)/.test(path)))refuse();
 if(!Array.isArray(value.utilities)||value.utilities.length!==UTILITIES.length)refuse();
 const utilities=value.utilities.map((item,index)=>{
  if(!exact(item,['path','available','resolvedPath'])||item.path!==UTILITIES[index]||typeof item.available!=='boolean'||(item.available?!paths.includes(item.resolvedPath):item.resolvedPath!==null))refuse();
  return {path:item.path,available:item.available,resolvedPath:item.resolvedPath};
 });
 return {version:1,kind:'prepared-host-inventory-proposal',profile:'hyperstack-prepared-r570-v1',hostImage:{provider:p.provider,id:p.imageId,name:p.imageName,region:p.region},os:{id:'ubuntu',version:'24.04',architecture:'amd64'},kernelRelease:kernel,driverVersion:driver,gpu:{count:1,name:gpu.name,pciDeviceId:gpu.pciDeviceId},dockerVersion:value.dockerVersion,packages,files,utilities,modelLoaded:false,cudaValidated:false,agentToolsEnabled:false,provenanceReviewRequired:true};
}
function receiptFrom(value,q,{sessionId,sourceSHA256,observedAt}){
 const fields=['version','kind','sessionId','nonce','deadlineUTC','observedAt','sourceSHA256','inventoryOnly','modelLoaded','cudaValidated','boundaryValidated','modelPermitIssued','agentToolsEnabled','inventory'];
 if(!exact(value,fields)||value.version!==1||value.kind!=='host-inventory-only-v1'||value.sessionId!==sessionId||value.nonce!==q.nonce||value.deadlineUTC!==new Date(q.deadline).toISOString()||!safeTime(value.observedAt)||value.observedAt<q.createdNotBefore||value.observedAt>observedAt||value.observedAt>=q.deadline||value.sourceSHA256!==sourceSHA256||value.inventoryOnly!==true||['modelLoaded','cudaValidated','boundaryValidated','modelPermitIssued','agentToolsEnabled'].some(key=>value[key]!==false))refuse();
 return {version:1,kind:'host-inventory-only-v1',sessionId,nonce:q.nonce,deadlineUTC:new Date(q.deadline).toISOString(),observedAt:value.observedAt,sourceSHA256,inventoryOnly:true,modelLoaded:false,cudaValidated:false,boundaryValidated:false,modelPermitIssued:false,agentToolsEnabled:false,inventory:inventoryFrom(value.inventory)};
}
// Canonical encoding is also a duplicate-key/escaped-key rejection gate. Every
// permitted field is ASCII; no raw console value can bypass reconstruction.
export function parseHostInventory(logs,binding={}){
 try{
  const q=context(binding);
  if(typeof logs!=='string'||new TextEncoder().encode(logs).byteLength>MAX_RESPONSE)refuse();
  let result=null,encoded=null;
  for(const line of logs.split(/\r?\n/)){
   if(!line.startsWith(HOST_INVENTORY_PREFIX))continue;
   if(new TextEncoder().encode(line).byteLength+1>MAX_LINE)refuse();
   const text=line.slice(HOST_INVENTORY_PREFIX.length),parsed=JSON.parse(text);
   if(canonical(parsed)!==text)refuse();
   const receipt=receiptFrom(parsed,q,binding),current=canonical(receipt);
   if(encoded!==null&&encoded!==current)refuse();
   encoded=current;result=receipt;
  }
  return result;
 }catch{return null;}
}
// Fixed phase categories preserve useful failure evidence without returning a
// command, exception, package stderr, arbitrary filename or native log text.
export function parseHostInventoryFailure(logs,binding={}){
 try{
  const q=context(binding),{sessionId,sourceSHA256,observedAt}=binding;
  if(typeof logs!=='string'||new TextEncoder().encode(logs).byteLength>MAX_RESPONSE)refuse();
  let result=null,encoded=null;
  for(const line of logs.split(/\r?\n/)){
   if(!line.startsWith(HOST_INVENTORY_FAILURE_PREFIX))continue;
   if(new TextEncoder().encode(line).byteLength+1>MAX_LINE)refuse();
   const text=line.slice(HOST_INVENTORY_FAILURE_PREFIX.length),value=JSON.parse(text);
   if(canonical(value)!==text||!exact(value,['version','kind','sessionId','nonce','deadlineUTC','sourceSHA256','observedAt','phase'])||value.version!==1||value.kind!=='host-inventory-failure-v1'||value.sessionId!==sessionId||value.nonce!==q.nonce||value.deadlineUTC!==new Date(q.deadline).toISOString()||value.sourceSHA256!==sourceSHA256||!safeTime(value.observedAt)||value.observedAt<q.createdNotBefore||value.observedAt>observedAt||value.observedAt>=q.deadline||!['os-identity','gpu-identity','kernel-module','package-inventory','package-file-provenance','file-integrity','docker-version','proposal-contract','receipt-limit','unknown'].includes(value.phase))refuse();
   const receipt={version:1,kind:'host-inventory-failure-v1',sessionId,nonce:q.nonce,deadlineUTC:new Date(q.deadline).toISOString(),sourceSHA256,observedAt:value.observedAt,phase:value.phase},current=canonical(receipt);
   if(encoded!==null&&encoded!==current)refuse();
   encoded=current;result=receipt;
  }
  return result;
 }catch{return null;}
}
export async function collectHostInventory({key,allocation,reservation,sessionId,sourceSHA256,providerGet,fetchImpl=fetch,now=Date.now}={}){
 const started=performance.now();
 try{
  const initial=now(),q=context({reservation,sessionId,sourceSHA256,observedAt:initial}),id=providerId(allocation?.id);
  if(!matchesReservation(allocation,q)||typeof key!=='string'||key.length<16||key.length>512||!/^[!-~]+$/.test(key)||typeof providerGet!=='function'||typeof fetchImpl!=='function')refuse();
  async function bounded(action){
   const remaining=OPERATION_MS-(performance.now()-started);if(remaining<=0)refuse();
   const controller=new AbortController();let timer;
   try{return await Promise.race([Promise.resolve().then(()=>action(controller.signal)),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('Host inventory unavailable'));},Math.min(REQUEST_MS,remaining));})]);}
   finally{clearTimeout(timer);controller.abort();}
  }
  async function fresh(){
   const at=now();if(!safeTime(at)||at<initial||at>=q.deadline)refuse();
   const current=await bounded(()=>providerGet(id));assertBound(current,allocation,q);if(current.status!=='ACTIVE')refuse();
   const after=now();if(!safeTime(after)||after<at||after>=q.deadline)refuse();
  }
  async function request(path,method='GET',body){
   return bounded(async signal=>{
    const response=await fetchImpl(API_BASE+path,{method,headers:{api_key:key,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'manual',signal});
    if(!(method==='POST'?[200,202]:[200]).includes(response.status)){await response.body?.cancel();refuse();}
    return boundedJSON(response.body,MAX_RESPONSE);
   });
  }
  const path='/core/virtual-machines/'+id+'/logs';await fresh();
  const requested=await request(path,'POST',{length:200});
  if(!plain(requested)||Object.keys(requested).some(field=>!['status','message','request_id'].includes(field))||('status'in requested&&requested.status!==true)||!Number.isSafeInteger(requested.request_id)||requested.request_id<=0||requested.request_id>999_999_999_999_999)refuse();
  for(let poll=0;poll<2;poll++){
   if(poll)await new Promise(resolve=>setTimeout(resolve,500));
   await fresh();const result=await request(path+'?request_id='+requested.request_id);
   if(!plain(result)||Object.keys(result).some(field=>!['status','message','logs'].includes(field))||!Object.hasOwn(result,'logs')||('status'in result&&result.status!==true))refuse();
   if(result.logs===null)continue;
   if(typeof result.logs!=='string')refuse();
   const binding={reservation:q,sessionId,sourceSHA256,observedAt:now()},success=parseHostInventory(result.logs,binding),failure=parseHostInventoryFailure(result.logs,binding);
   if(success&&failure)return null;
   const receipt=success??failure;if(!receipt)return null;
   // A successful console response alone cannot establish that the allocation
   // is still the exact active VM. Recheck after its body and receipt are read.
   await fresh();return receipt;
  }
  return null;
 }catch{return null;}
}
