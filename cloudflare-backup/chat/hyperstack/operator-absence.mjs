import {validateReservation,validateTarget,absenceReceipt,fail} from './policy.mjs';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const plain=p=>p!==null&&typeof p==='object'&&!Array.isArray(p);
const exact=(p,keys)=>plain(p)&&Object.keys(p).sort().join()===keys.slice().sort().join();
const text=(s,max)=>typeof s==='string'&&s.length>0&&s.length<=max&&!/[\x00-\x1f\x7f]/.test(s);
const bad=()=>fail('OPERATOR_ABSENCE_PACKET_INVALID');
const canonical=value=>Array.isArray(value)?value.map(canonical):plain(value)?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
// Exceptional, post-deletion evidence only. Never changes matchesReservation,
// creates an ownership tag, authorizes DELETE, or declares definite-no-create.
export function validateOperatorAbsence(packet,{target,now=Date.now()}={}){
 if(!Number.isSafeInteger(now)||now<0||!exact(packet,['version','id','sessionId','approvalId','reservation','allocation','observedAt','deleteRequestedAt','absenceObservedAt','reason'])||packet.version!==1||!UUID.test(packet.id??'')||!UUID.test(packet.sessionId??'')||!text(packet.approvalId,160)||packet.reason!=='MISSING_PROVIDER_LABEL')bad();
 let q,t;try{t=validateTarget(target??packet.reservation?.target);q=validateReservation(packet.reservation,t);}catch{bad();}
 if(q.provider!=='hyperstack'||q.kind!=='chat'||q.minutes!==30||!q.image||q.ownershipPolicy!==undefined||!exact(packet.reservation,Object.keys(q))||!same(q,packet.reservation)||now<q.createdNotAfter)bad();
 const p=packet.allocation;
 if(!exact(p,['provider','id','name','createdAt','status','bootImageName','flavor','environment','publicIp','volumeIds','labels','artifactVerified'])||p.provider!=='hyperstack'||typeof p.id!=='string'||!/^[1-9][0-9]{0,14}$/.test(p.id)||p.name!==q.name||!text(p.status,48)||p.bootImageName!==t.imageName||p.artifactVerified!==false||!Array.isArray(p.labels)||p.labels.length!==0||!Array.isArray(p.volumeIds)||p.volumeIds.length!==0)bad();
 if(!exact(p.flavor,['id','name','gpu','count','cpu','ram','disk'])||p.flavor.id!==t.flavorId||p.flavor.name!==t.flavorName||p.flavor.gpu!=='RTX-A6000'||p.flavor.count!==1||p.flavor.cpu!==28||p.flavor.ram!==58||p.flavor.disk!==100||!exact(p.environment,['id','name','region'])||p.environment.id!==t.environmentId||p.environment.name!==t.environmentName||p.environment.region!==t.region)bad();
 if(p.publicIp!==null&&(typeof p.publicIp!=='string'||!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(p.publicIp)||p.publicIp.split('.').some(n=>Number(n)>255)))bad();
 // Hyperstack returns provider UTC timestamps without a timezone suffix.
 // Interpret that wire form explicitly; the operator's laptop timezone must
 // not move an observed VM outside its immutable UTC creation window.
 const created=typeof p.createdAt==='string'?Date.parse(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(p.createdAt)?p.createdAt+'Z':p.createdAt):NaN;
 if(!Number.isSafeInteger(created)||created<q.createdNotBefore||created>q.createdNotAfter||!['observedAt','deleteRequestedAt','absenceObservedAt'].every(k=>Number.isSafeInteger(packet[k])&&packet[k]>=0)||packet.observedAt<created||packet.deleteRequestedAt<packet.observedAt||packet.absenceObservedAt<packet.deleteRequestedAt||packet.absenceObservedAt>now)bad();
 return {version:1,id:packet.id,sessionId:packet.sessionId,approvalId:packet.approvalId,reservation:structuredClone(q),allocation:structuredClone(p),observedAt:packet.observedAt,deleteRequestedAt:packet.deleteRequestedAt,absenceObservedAt:packet.absenceObservedAt,reason:'MISSING_PROVIDER_LABEL'};
}
export function parseOperatorAbsence(raw,options){
 if(typeof raw!=='string'||raw.length>16384)bad();let packet;try{packet=JSON.parse(raw);}catch{bad();}return validateOperatorAbsence(packet,options);
}
export const sameOperatorAbsence=(a,b)=>same(a,b);
// list() is the trusted client's complete paginated account inventory. It must
// not return partial pages. Requiring the entire account empty is deliberate:
// an unlabeled, renamed or delayed duplicate cannot hide behind tag matching.
export async function verifyOperatorAbsence({provider,packet,target,now=Date.now}={}){
 const clock=()=>typeof now==='function'?now():now;
 const p=validateOperatorAbsence(packet,{target,now:clock()});
 if(!provider||typeof provider.get!=='function'||typeof provider.list!=='function')fail('OPERATOR_ABSENCE_PROVIDER_INVALID');
 if(await provider.get(p.allocation.id)!==null)fail('OPERATOR_ABSENCE_UNCONFIRMED');
 const inventory=await provider.list();if(!Array.isArray(inventory)||inventory.length!==0)fail('OPERATOR_ABSENCE_UNCONFIRMED');
 if(await provider.get(p.allocation.id)!==null)fail('OPERATOR_ABSENCE_UNCONFIRMED');
 const checkedAt=clock();validateOperatorAbsence(p,{target,now:checkedAt});
 return absenceReceipt({vmAbsent:true,inventoryAbsent:true,complete:true,operatorReconciled:true,reconciliationId:p.id,sessionId:p.sessionId,approvalId:p.approvalId,nonce:p.reservation.nonce,reservationName:p.reservation.name,name:p.reservation.name,image:p.reservation.image,deadline:p.reservation.deadline,allocationId:p.allocation.id,checkedAt,reason:p.reason});
}
