// Public API metadata is evidence about a VM, not evidence about the serving
// container, driver, firewall, artifact digest, or successful isolation probe.
export const PROVIDER='hyperstack';
export const API_ORIGIN='https://infrahub-api.nexgencloud.com';
export const API_BASE=API_ORIGIN+'/v1';
export const INFERENCE_ORIGIN='https://inference.unjailed.work';
export const NONCE_NAME_OWNERSHIP='nonce-name-v2';
export const SOURCES=Object.freeze({
  schema:'https://docs.hyperstack.cloud/openapi/hyperstack.json',
  deletion:'https://docs.hyperstack.cloud/docs/api-reference/delete-vm/',
  publicIp:'https://docs.hyperstack.cloud/docs/network/public-ip/',
  billing:'https://docs.hyperstack.cloud/docs/billing/states-and-billing/'
});
const plain=o=>o!==null&&typeof o==='object'&&!Array.isArray(o);
const int=n=>Number.isSafeInteger(n)&&n>0;
const text=(s,max=160)=>typeof s==='string'&&s.length>0&&s.length<=max&&!/[\x00-\x1f\x7f]/.test(s);
// Closed, reviewed single-GPU shapes only. A target still pins exact catalog
// IDs, region, image, environment, keypair and its own lower billing ceiling.
const TARGET_PROFILES=new Map([
  ['n3-RTX-A6000x1',Object.freeze({flavorName:'n3-RTX-A6000x1',gpu:'RTX-A6000',count:1,cpu:28,ram:58,disk:100,ephemeral:0,vramGB:48,maximumHourlyUSD:1})],
  ['n3-A100x1',Object.freeze({flavorName:'n3-A100x1',gpu:'A100-80G-PCIe',count:1,cpu:28,ram:120,disk:100,ephemeral:750,vramGB:80,maximumHourlyUSD:1.36})]
]);
export function fail(code){throw Error(code);}
export function providerId(value){if(typeof value==='string'&&/^[1-9][0-9]{0,14}$/.test(value))value=Number(value);if(!int(value))fail('HYPERSTACK_ID_INVALID');return String(value);}
function id(value){return Number(providerId(value));}
function epoch(value){const n=typeof value==='string'?Date.parse(value):NaN;if(!Number.isFinite(n))fail('HYPERSTACK_TIMESTAMP_INVALID');return n;}
// Hyperstack's observed created_at wire form may omit a zone. Under explicit
// V2 ownership it denotes provider UTC, never the operator laptop's local time.
// Retain the original string in readbacks; compare the represented UTC instant.
export function providerCreatedAtUTC(value){
  const m=typeof value==='string'&&value.length<=64?value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})?$/):null;
  if(!m)fail('HYPERSTACK_TIMESTAMP_INVALID');
  const [year,month,day,hour,minute,second]=m.slice(1,7).map(Number),calendar=new Date(0);
  calendar.setUTCFullYear(year,month-1,day);calendar.setUTCHours(hour,minute,second,0);
  if(calendar.getUTCFullYear()!==year||calendar.getUTCMonth()!==month-1||calendar.getUTCDate()!==day||calendar.getUTCHours()!==hour||calendar.getUTCMinutes()!==minute||calendar.getUTCSeconds()!==second)fail('HYPERSTACK_TIMESTAMP_INVALID');
  const n=Date.parse(m[8]?value:value+'Z');if(!Number.isSafeInteger(n))fail('HYPERSTACK_TIMESTAMP_INVALID');return n;
}
export function creationTimestampIdentity(value,reservation){
  const q=validateReservation(reservation);
  if(q.ownershipPolicy===NONCE_NAME_OWNERSHIP)return new Date(providerCreatedAtUTC(value)).toISOString();
  // Existing V1 bindings and permit records retain exact wire-string identity.
  epoch(value);return value;
}
export function validateTarget(t){
  const profile=plain(t)?TARGET_PROFILES.get(t.flavorName):null;
  if(!profile||t.region!=='CANADA-1'||t.imageName!=='Ubuntu Server 24.04 LTS (Noble Numbat)'||!text(t.environmentName)||!text(t.keyName)||t.inferenceOrigin!==INFERENCE_ORIGIN)fail('HYPERSTACK_TARGET_INVALID');
  for(const k of ['environmentId','flavorId','imageId'])id(t[k]);
  if(typeof t.maximumHourlyUSD!=='number'||!Number.isFinite(t.maximumHourlyUSD)||t.maximumHourlyUSD<=0||t.maximumHourlyUSD>profile.maximumHourlyUSD)fail('HYPERSTACK_RATE_LIMIT_INVALID');
  return Object.freeze({environmentId:id(t.environmentId),environmentName:t.environmentName,region:t.region,flavorId:id(t.flavorId),flavorName:t.flavorName,imageId:id(t.imageId),imageName:t.imageName,keyName:t.keyName,inferenceOrigin:INFERENCE_ORIGIN,maximumHourlyUSD:t.maximumHourlyUSD});
}
export function targetProfile(target){return TARGET_PROFILES.get(validateTarget(target).flavorName);}
function one(items,predicate,code){if(!Array.isArray(items))fail(code);const found=items.filter(predicate);if(found.length!==1)fail(code);return found[0];}
function restrictions(r,kind,targetId){
  const field=kind==='flavor'?'has_flavor_restrictions':'has_image_restrictions',items=kind==='flavor'?'compatible_flavors':'compatible_images',key=kind+'_id';
  if(!plain(r)||typeof r[field]!=='boolean')fail('HYPERSTACK_COMPATIBILITY_UNVERIFIED');
  if(!r[field]){if(r.restriction_type!==null||!Array.isArray(r[items])||r[items].length)fail('HYPERSTACK_COMPATIBILITY_UNVERIFIED');return;}
  // A soft warning still needs separate review; this gate does not silently
  // override it. Nonempty constraints also require an operator review.
  if(r.restriction_type!=='hard'||!Array.isArray(r[items]))fail('HYPERSTACK_COMPATIBILITY_UNVERIFIED');
  const match=one(r[items],x=>x?.[key]===targetId,'HYPERSTACK_IMAGE_INCOMPATIBLE');
  if(match.link_type!=='hard'||(match.constraints!==null&&match.constraints!==undefined&&(!plain(match.constraints)||Object.keys(match.constraints).length)))fail('HYPERSTACK_COMPATIBILITY_UNVERIFIED');
}
function decimal(n){if(typeof n==='string'&&!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(n))fail('HYPERSTACK_PRICE_INVALID');if(typeof n!=='number'&&typeof n!=='string')fail('HYPERSTACK_PRICE_INVALID');const v=Number(n);if(!Number.isFinite(v)||v<0)fail('HYPERSTACK_PRICE_INVALID');return v;}
export function validateCatalog(raw,target,now=Date.now()){
  const t=validateTarget(target),profile=TARGET_PROFILES.get(t.flavorName),{flavors,images,environments,keypairs,stocks,pricebook}=raw??{};
  if(flavors?.status!==true||images?.status!==true||environments?.status!==true||keypairs?.status!==true)fail('HYPERSTACK_CATALOG_INVALID');
  const flavor=one(flavors.data?.flatMap(x=>x?.flavors??[]),x=>x?.id===t.flavorId&&x.name===t.flavorName&&x.region_name===t.region,'HYPERSTACK_FLAVOR_UNVERIFIED');
  if(flavor.gpu!==profile.gpu||flavor.gpu_count!==profile.count||flavor.cpu!==profile.cpu||flavor.ram!==profile.ram||flavor.disk!==profile.disk||flavor.ephemeral!==profile.ephemeral||flavor.stock_available!==true)fail('HYPERSTACK_FLAVOR_UNAVAILABLE');
  const image=one(images.images?.flatMap(x=>x?.images??[]),x=>x?.id===t.imageId&&x.name===t.imageName&&x.region_name===t.region,'HYPERSTACK_IMAGE_UNVERIFIED');
  restrictions(image.flavor_restrictions,'flavor',t.flavorId);restrictions(flavor.image_restrictions,'image',t.imageId);
  one(environments.environments,x=>x?.id===t.environmentId&&x.name===t.environmentName&&x.region===t.region,'HYPERSTACK_ENVIRONMENT_UNVERIFIED');
  one(keypairs.keypairs,x=>x?.name===t.keyName&&x.environment?.id===t.environmentId&&x.environment.name===t.environmentName,'HYPERSTACK_KEYPAIR_UNVERIFIED');
  const stock=one(stocks?.stocks,x=>x?.region===t.region&&x['stock-type']==='GPU','HYPERSTACK_STOCK_INVALID');
  const model=one(stock.models,x=>x?.model===profile.gpu,'HYPERSTACK_STOCK_INVALID');
  if(!Number.isSafeInteger(model.configurations?.['1x'])||model.configurations['1x']<=0)fail('HYPERSTACK_FLAVOR_UNAVAILABLE');
  const rate=name=>{const p=one(pricebook,x=>x?.name===name,'HYPERSTACK_PRICE_UNVERIFIED');if(p.start_time!==null&&p.start_time!==undefined&&epoch(p.start_time)>now)fail('HYPERSTACK_PRICE_NOT_ACTIVE');if(p.end_time!==null&&p.end_time!==undefined&&epoch(p.end_time)<=now+65*60_000)fail('HYPERSTACK_PRICE_EXPIRING');return decimal(p.value);};
  const gpuHourlyUSD=rate(profile.gpu),publicIpHourlyUSD=rate('PublicIP');
  if(['vCPU','RAM','hypervisor-local-storage'].some(n=>rate(n)!==0))fail('HYPERSTACK_EXTRA_COMPUTE_PRICE');
  const totalHourlyUSD=gpuHourlyUSD+publicIpHourlyUSD;if(totalHourlyUSD>t.maximumHourlyUSD)fail('HYPERSTACK_RATE_TOO_HIGH');
  return {provider:PROVIDER,target:t,gpu:profile.gpu,gpuCount:profile.count,vramGB:profile.vramGB,cpu:profile.cpu,ramGB:profile.ram,rootDiskGB:profile.disk,gpuHourlyUSD,publicIpHourlyUSD,totalHourlyUSD,availability:'AVAILABLE',quotedAt:now,expiresAt:now+60_000,catalogVerified:true,runtimeVerified:false,permissionsVerified:false};
}
export function normalizeVM(raw){
  if(!plain(raw)||!text(raw.name,50)||!text(raw.status,48)||!text(raw.image?.name)||!text(raw.flavor?.name)||!text(raw.flavor?.gpu)||!text(raw.environment?.name)||!text(raw.environment?.region)||!Array.isArray(raw.labels)||raw.labels.length>32||raw.labels.some(x=>!text(x,100))||!Array.isArray(raw.volume_attachments)||raw.volume_attachments.length>32)fail('HYPERSTACK_VM_INVALID');
  const createdAt=raw.created_at;epoch(createdAt);
  const volumeIds=[...new Set(raw.volume_attachments.map(x=>providerId(x?.volume?.id)))];
  if(raw.floating_ip!==null&&raw.floating_ip!==undefined&&(!text(raw.floating_ip,45)||!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(raw.floating_ip)))fail('HYPERSTACK_IP_INVALID');
  return {provider:PROVIDER,id:providerId(raw.id),name:raw.name,createdAt,status:raw.status,bootImageName:raw.image.name,flavor:{id:id(raw.flavor.id),name:raw.flavor.name,gpu:raw.flavor.gpu,count:raw.flavor.gpu_count,cpu:raw.flavor.cpu,ram:raw.flavor.ram,disk:raw.flavor.disk},environment:{id:id(raw.environment.id),name:raw.environment.name,region:raw.environment.region},publicIp:raw.floating_ip??null,volumeIds,labels:[...raw.labels],artifactVerified:false};
}
export function validateReservation(r,target){
  const t=validateTarget(target??r?.target);
  if(!plain(r)||!/^[a-f0-9]{32}$/.test(r.nonce??'')||r.name!==`unjailed-chat-${r.nonce}`||!Number.isSafeInteger(r.createdNotBefore)||!Number.isSafeInteger(r.createdNotAfter)||r.createdNotAfter<r.createdNotBefore||r.createdNotAfter-r.createdNotBefore>5*60_000||!Number.isSafeInteger(r.deadline)||r.deadline<=r.createdNotAfter||r.deadline-r.createdNotBefore>65*60_000)fail('HYPERSTACK_RESERVATION_INVALID');
  if(r.target&&JSON.stringify(validateTarget(r.target))!==JSON.stringify(t))fail('HYPERSTACK_TARGET_MISMATCH');
  const q={nonce:r.nonce,name:r.name,createdNotBefore:r.createdNotBefore,createdNotAfter:r.createdNotAfter,deadline:r.deadline,target:t};
  // Optional controller wire metadata is kept as one strict allowlisted group.
  // It must survive into the independent guard and trusted bootstrap callback;
  // no arbitrary fields (especially credentials/user_data) are copied through.
  if(['kind','provider','minutes','image','windowStart','windowEnd','ownershipPolicy'].some(k=>k in r)){
    if(r.kind!=='chat'||r.provider!==PROVIDER||![15,30,60].includes(r.minutes)||!/^ghcr\.io\/benjamin-alemany\/huihui-qwen3-8b-v2@sha256:[a-f0-9]{64}$/.test(r.image??'')||r.deadline!==r.createdNotBefore+r.minutes*60_000||r.windowStart!==new Date(r.createdNotBefore).toISOString()||r.windowEnd!==new Date(r.createdNotAfter).toISOString())fail('HYPERSTACK_RESERVATION_METADATA_INVALID');
    if('ownershipPolicy'in r&&r.ownershipPolicy!==NONCE_NAME_OWNERSHIP)fail('HYPERSTACK_OWNERSHIP_POLICY_INVALID');
    Object.assign(q,{kind:r.kind,provider:r.provider,minutes:r.minutes,image:r.image,windowStart:r.windowStart,windowEnd:r.windowEnd});
    if('ownershipPolicy'in r)q.ownershipPolicy=NONCE_NAME_OWNERSHIP;
  }
  return q;
}
function targetMatches(p,t){
  const profile=TARGET_PROFILES.get(t.flavorName);
  // Ephemeral capacity is checked in the authenticated flavor catalog. Keep the
  // established allocation wire shape for historical bindings and guard state.
  return p.provider===PROVIDER&&p.environment?.id===t.environmentId&&p.environment.name===t.environmentName&&p.environment.region===t.region&&p.flavor?.id===t.flavorId&&p.flavor.name===t.flavorName&&p.flavor.gpu===profile.gpu&&p.flavor.count===profile.count&&p.flavor.cpu===profile.cpu&&p.flavor.ram===profile.ram&&p.flavor.disk===profile.disk&&p.bootImageName===t.imageName;
}
export function matchesReservation(p,r){
  const q=validateReservation(r);let created;
  try{created=q.ownershipPolicy===NONCE_NAME_OWNERSHIP?providerCreatedAtUTC(p?.createdAt):Date.parse(p?.createdAt);}catch{return false;}
  const marker=q.ownershipPolicy===NONCE_NAME_OWNERSHIP||p?.labels?.includes(`unjailed:${q.nonce}`);
  return targetMatches(p??{},q.target)&&p.name===q.name&&marker&&created>=q.createdNotBefore&&created<=q.createdNotAfter;
}
export function assertBound(current,bound,r){
  const q=validateReservation(r);
  let sameCreated=false;try{sameCreated=creationTimestampIdentity(current?.createdAt,q)===creationTimestampIdentity(bound?.createdAt,q);}catch{/* Invalid provider time never establishes identity. */}
  if(!matchesReservation(bound,q)||providerId(current?.id)!==providerId(bound.id)||!sameCreated||!targetMatches(current,q.target))fail('HYPERSTACK_OWNERSHIP_UNCONFIRMED');
  // Name/labels may change after a successful durable binding. Immutable ID,
  // original creation time, boot image name, environment and flavor still bind.
  return current;
}
export function absenceReceipt(extra={}){return {provider:PROVIDER,vmAbsent:false,inventoryAbsent:false,complete:false,publicIpReleaseMode:'vm-coupled',independentIpReadback:false,standaloneIpAbsence:'unverified',billingSettlementPending:true,unexpectedVolumeIds:[],sources:SOURCES,...extra};}
