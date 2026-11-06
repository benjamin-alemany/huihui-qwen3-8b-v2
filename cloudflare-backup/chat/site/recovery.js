// Shared browser/server validation. No DOM, credentials, rendering or execution.
export const HISTORY_LIMITS=Object.freeze({conversations:20,messages:32,characters:12000,bytes:65536});
export const BACKUP_LIMITS=Object.freeze({bytes:2097152});
export class RecoveryError extends Error{constructor(message,status=400){super(message);this.status=status;}}
const exact=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join()===keys;
export function chatFrom(input){
 if(!exact(input,'messages,title')||typeof input.title!=='string'||input.title.length>80||!Array.isArray(input.messages)||!input.messages.length||input.messages.length>HISTORY_LIMITS.messages)throw new RecoveryError('Choose a short title and a bounded text conversation');
 let total=0;const messages=input.messages.map((m,i)=>{
  if(!exact(m,'content,role')||m.role!==(i%2?'assistant':'user')||typeof m.content!=='string'||!m.content.trim())throw new RecoveryError('Only alternating plain-text messages can be saved');
  total+=m.content.length;if(total>HISTORY_LIMITS.characters)throw new RecoveryError('Saved chat is too large',413);
  return {role:m.role,content:m.content};
 });
 return {title:input.title.trim()||messages[0].content.trim().slice(0,80),messages};
}
export function backupFrom(input){
 if(!exact(input,'conversations,format,version')||input.format!=='unjailed.chat-backup'||input.version!==1||!Array.isArray(input.conversations)||input.conversations.length>HISTORY_LIMITS.conversations)throw new RecoveryError('Choose an Unjailed version 1 backup with at most 20 chats');
 const backup={format:'unjailed.chat-backup',version:1,conversations:input.conversations.map(chatFrom)};
 if(new TextEncoder().encode(JSON.stringify(backup)).byteLength>BACKUP_LIMITS.bytes)throw new RecoveryError('Backup exceeds 2 MiB',413);
 return backup;
}
export function parseBackup(text){
 if(typeof text!=='string'||new TextEncoder().encode(text).byteLength>BACKUP_LIMITS.bytes)throw new RecoveryError('Backup exceeds 2 MiB',413);
 let value;try{value=JSON.parse(text);}catch{throw new RecoveryError('The selected file is not valid JSON');}return backupFrom(value);
}
export const fingerprint=chat=>JSON.stringify(chatFrom(chat));
export function importPlan(existing,input){
 const backup=backupFrom(input),seen=new Set(existing.map(fingerprint)),add=[];
 for(const c of backup.conversations){const key=fingerprint(c);if(!seen.has(key)){seen.add(key);add.push(c);}}
 const duplicates=backup.conversations.length-add.length,remainingSlots=HISTORY_LIMITS.conversations-existing.length;
 return {add,duplicates,remainingSlots,canImport:add.length<=remainingSlots};
}
export function draftSnapshot(messages,draft){return draft.trim()?[...messages,{role:'user',content:draft.trim()}]:[...messages];}
export function textExport(messages,draft){const text=messages.map(m=>`${m.role.toUpperCase()}\n${m.content}`);if(draft.trim())text.push('UNSENT DRAFT\n'+draft.trim());return text.join('\n\n');}
export const draftFingerprint=(messages,draft)=>JSON.stringify(draftSnapshot(messages,draft));
