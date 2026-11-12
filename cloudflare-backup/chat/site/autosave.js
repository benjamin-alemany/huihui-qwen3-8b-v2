// Text-only recovery. No provider URL, credentials, attachments or executable data.
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const OUTBOX_LIMITS=Object.freeze({entries:20,bytes:2*1024*1024,entryBytes:65536});
export const sameText=(a,b)=>JSON.stringify([a.title,a.messages,a.draft])===JSON.stringify([b.title,b.messages,b.draft]);
export function documentFrom(value){
 if(!value||!uuid.test(value.id??'')||!Number.isSafeInteger(value.revision)||value.revision<0||typeof value.title!=='string'||value.title.length>80||typeof value.draft!=='string'||!Array.isArray(value.messages)||value.messages.length>32||value.messages.length%2)throw Error('Invalid saved conversation');
 let size=value.draft.length;const messages=value.messages.map((m,i)=>{if(!m||Object.keys(m).sort().join()!=='content,role'||m.role!==(i%2?'assistant':'user')||typeof m.content!=='string'||!m.content.trim())throw Error('Only completed plain-text exchanges can be saved');size+=m.content.length;return {role:m.role,content:m.content};});
 if(size>12000)throw Error('Conversation is full. Export it before starting a new chat.');
 return {id:value.id,revision:value.revision,title:value.title,messages,draft:value.draft};
}
export function recordFrom(raw){
 if(!raw||Object.keys(raw).sort().join()!=='conversationId,draft,key,messages,pendingTurnId,revision,title,updatedAt,version'||raw.version!==1||!uuid.test(raw.key??'')||!(raw.pendingTurnId===null||uuid.test(raw.pendingTurnId??''))||!Number.isSafeInteger(raw.updatedAt)||raw.updatedAt<0)throw Error('Invalid local recovery record');
 const doc=documentFrom({...raw,id:raw.conversationId});const record={version:1,key:raw.key,conversationId:doc.id,revision:doc.revision,title:doc.title,messages:doc.messages,draft:doc.draft,pendingTurnId:raw.pendingTurnId,updatedAt:raw.updatedAt};
 if(new TextEncoder().encode(JSON.stringify(record)).byteLength>OUTBOX_LIMITS.entryBytes)throw Error('Local recovery entry is too large');return record;
}
export function boundedRecords(existing,raw){const record=recordFrom(raw),records=existing.map(recordFrom).filter(r=>r.key!==record.key);records.push(record);if(records.length>OUTBOX_LIMITS.entries||new TextEncoder().encode(JSON.stringify(records)).byteLength>OUTBOX_LIMITS.bytes)throw Error('Local recovery is full. Save or export a recovered draft before clearing it.');return records;}
export function browserOutbox(indexedDB=globalThis.indexedDB){
 let opening;
 const db=()=>opening??=new Promise((resolve,reject)=>{if(!indexedDB){reject(Error('Local recovery is unavailable in this browser'));return;}const r=indexedDB.open('unjailed-text-recovery',1);r.onupgradeneeded=()=>r.result.createObjectStore('drafts',{keyPath:'key'});r.onsuccess=()=>{r.result.onversionchange=()=>r.result.close();resolve(r.result);};r.onerror=()=>reject(Error('Local recovery could not be opened'));r.onblocked=()=>reject(Error('Close other Unjailed tabs to open local recovery'));});
 async function transaction(mode,run){const database=await db();return new Promise((resolve,reject)=>{const tx=database.transaction('drafts',mode),store=tx.objectStore('drafts');let answer,error;tx.oncomplete=()=>resolve(answer);tx.onerror=tx.onabort=()=>reject(error||Error('Local recovery could not be saved'));run(store,value=>answer=value,e=>{error=e;tx.abort();});});}
 return {list:()=>transaction('readonly',(s,done,fail)=>{const r=s.getAll();r.onsuccess=()=>{try{done(r.result.map(recordFrom));}catch(e){fail(e);}};}),put:record=>transaction('readwrite',(s,done,fail)=>{const r=s.getAll();r.onsuccess=()=>{try{boundedRecords(r.result,record);s.put(recordFrom(record));done();}catch(e){fail(e);}};}),remove:key=>transaction('readwrite',(s,done)=>{s.delete(key);done();}),removeIfMatch:expected=>transaction('readwrite',(s,done,fail)=>{
   const acknowledged=recordFrom(expected),r=s.get(acknowledged.key);
   r.onsuccess=()=>{try{const matches=r.result!==undefined&&JSON.stringify(recordFrom(r.result))===JSON.stringify(acknowledged);if(matches)s.delete(acknowledged.key);done(matches);}catch(e){fail(e);}};
  })};
}
export class Autosave {
 constructor({doc,key,store,request,onChange=()=>{},now=Date.now,newKey=()=>crypto.randomUUID()}){this.doc=documentFrom(doc);this.key=key;this.store=store;this.request=request;this.onChange=onChange;this.now=now;this.epoch=0;this.savedEpoch=doc.revision>0?0:-1;this.status=doc.revision>0?'saved':'new';this.pendingTurnId=null;this.conflict=null;this.localError=null;this.inflight=null;this.lastRecord=null;this.recoverySource=null;this.newKey=newKey;}
 snapshot(){return structuredClone(this.doc);}
 changed(){this.onChange(this);}
 record(){return recordFrom({version:1,key:this.key,conversationId:this.doc.id,revision:this.doc.revision,title:this.doc.title,messages:this.doc.messages,draft:this.doc.draft,pendingTurnId:this.pendingTurnId,updatedAt:this.now()});}
 async persist(){const record=this.record();try{await this.store.put(record);if(this.key===record.key&&this.doc.id===record.conversationId)this.lastRecord=record;this.localError=null;}catch(e){this.localError=e.message;}this.changed();return record;}
 async acknowledge(record){if(!record)return;try{const removed=await this.store.removeIfMatch(record);if(removed&&JSON.stringify(this.lastRecord)===JSON.stringify(record)){this.lastRecord=null;this.localError=null;}}catch(e){this.localError=e.message;}}
 edit(patch){this.doc=documentFrom({...this.doc,...patch});this.epoch++;if(!this.conflict)this.status='saving';this.changed();return this.persist();}
 async restore(record){
  const r=recordFrom(record),key=this.newKey();if(!uuid.test(key)||key===r.key)throw Error('A fresh local recovery identifier is required');
  // Each recovered tab owns a separate row. The source stays intact until its
  // exact contents are acknowledged or the owner explicitly clears it.
  this.key=key;this.recoverySource=r;this.lastRecord=null;this.doc=documentFrom({...r,id:r.conversationId});this.pendingTurnId=r.pendingTurnId;this.epoch++;this.savedEpoch=-1;this.status='offline';this.conflict=null;await this.persist();
 }
 async pending(turnId){if(!uuid.test(turnId))throw Error('Invalid reply identifier');this.pendingTurnId=turnId;await this.persist();}
 async acknowledgeSource(){const source=this.recoverySource;if(!source)return;try{await this.store.removeIfMatch(source);if(this.recoverySource===source)this.recoverySource=null;}catch(e){this.localError=e.message;}}
 async accept(item){const acknowledged=this.lastRecord;this.doc=documentFrom(item);this.pendingTurnId=null;this.conflict=null;this.epoch++;this.savedEpoch=this.epoch;this.status='saved';await this.acknowledge(acknowledged);await this.acknowledgeSource();this.changed();}
 async fork(id,key){this.key=key;this.doc={...this.snapshot(),id,revision:0};this.conflict=null;this.pendingTurnId=null;this.epoch++;this.savedEpoch=-1;this.status='saving';await this.persist();}
 async flush(){
  if(this.inflight)return this.inflight;if(this.conflict||this.pendingTurnId)return false;if(this.savedEpoch===this.epoch)return true;
  this.inflight=this.saveLoop();try{return await this.inflight;}finally{this.inflight=null;}
 }
 async saveLoop(){
  while(this.savedEpoch!==this.epoch){const sent=this.snapshot(),epoch=this.epoch;this.status='saving';const acknowledged=await this.persist();let item;
   try{item=(await this.request('/api/history/upsert',sent)).item;}catch(e){if(e.status===409&&e.data?.item){const current=documentFrom(e.data.item);if(sameText(current,sent))item=current;else{this.conflict=current;this.status='conflict';this.changed();return false;}}else{this.status=e.status===429?'full':'offline';this.error=e.message;this.changed();return false;}}
   try{item=documentFrom(item);}catch{this.status='offline';this.error='Cloud save acknowledgement was invalid';this.changed();return false;}if(item.id!==sent.id||item.revision<1||!sameText(item,sent)){this.conflict=item;this.status='conflict';this.changed();return false;}
   this.doc.revision=item.revision;this.savedEpoch=epoch;
   if(this.epoch===epoch){this.status='saved';await this.acknowledge(acknowledged);await this.acknowledgeSource();this.changed();if(this.epoch===epoch)return true;}
   await this.persist();
  }return true;
 }
}

export function reconcileTurn(local,job,latest){
 const before=documentFrom(local),finished=documentFrom(job.item),cloud=documentFrom(latest);
 if(finished.id!==before.id||cloud.id!==before.id||cloud.revision<finished.revision)throw Error('Reply conversation revision could not be verified');
 const original=job.status==='completed'?JSON.stringify(finished.messages.slice(0,-1))===JSON.stringify([...before.messages,{role:'user',content:before.draft}])&&before.title===finished.title:sameText(before,finished);
 return {item:cloud,conflict:!original||before.revision>finished.revision};
}
