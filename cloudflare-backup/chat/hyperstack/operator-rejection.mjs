import {NONCE_NAME_OWNERSHIP,validateReservation,validateTarget,fail} from './policy.mjs';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const FIELDS=['version','id','sessionId','approvalId','reservation','requestAt','confirmedAt','httpStatus','evidenceSHA256','reason'];
const plain=p=>p!==null&&typeof p==='object'&&!Array.isArray(p);
const exact=(p,keys)=>plain(p)&&Object.keys(p).sort().join()===keys.toSorted().join();
const canonical=v=>Array.isArray(v)?v.map(canonical):plain(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const bad=()=>fail('OPERATOR_REJECTION_PACKET_INVALID');
const sizeOK=p=>{try{return new TextEncoder().encode(JSON.stringify(p)).byteLength<=16384;}catch{return false;}};

// Private operator evidence only. The digest identifies separately reviewed
// provider correspondence; this parser does not authenticate email or broaden
// the ordinary HTTP-error classification, ownership or create policy.
export function validateOperatorRejection(input,{target,now=Date.now()}={}){
 if(!Number.isSafeInteger(now)||now<0||!sizeOK(input)||!exact(input,FIELDS)||input.version!==1||!UUID.test(input.id??'')||!UUID.test(input.sessionId??'')||typeof input.approvalId!=='string'||!input.approvalId.length||input.approvalId.length>160||/[\x00-\x1f\x7f]/.test(input.approvalId)||input.reason!=='PROVIDER_CONFIRMED_NO_CREATE'||!Number.isInteger(input.httpStatus)||input.httpStatus<400||input.httpStatus>499||!/^[a-f0-9]{64}$/.test(input.evidenceSHA256??''))bad();
 let q;try{const t=validateTarget(target??input.reservation?.target);q=validateReservation(input.reservation,t);}catch{bad();}
 if(q.kind!=='chat'||q.provider!=='hyperstack'||q.ownershipPolicy!==NONCE_NAME_OWNERSHIP||![15,30,60].includes(q.minutes)||!q.image||!exact(input.reservation,Object.keys(q))||!same(input.reservation,q))bad();
 if(!['requestAt','confirmedAt'].every(k=>Number.isSafeInteger(input[k])&&input[k]>=0)||input.requestAt<q.createdNotBefore||input.requestAt>q.createdNotAfter||input.requestAt>=q.deadline||input.confirmedAt<input.requestAt||input.confirmedAt>now)bad();
 return {version:1,id:input.id,sessionId:input.sessionId,approvalId:input.approvalId,reservation:structuredClone(q),requestAt:input.requestAt,confirmedAt:input.confirmedAt,httpStatus:input.httpStatus,evidenceSHA256:input.evidenceSHA256,reason:'PROVIDER_CONFIRMED_NO_CREATE'};
}
export function parseOperatorRejection(value,options){
 if(typeof value!=='string'||new TextEncoder().encode(value).byteLength>16384)bad();
 let input;try{input=JSON.parse(value);}catch{bad();}return validateOperatorRejection(input,options);
}
export const sameOperatorRejection=(a,b)=>same(a,b);
