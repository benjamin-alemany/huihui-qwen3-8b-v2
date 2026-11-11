import {Rejection} from './policy.mjs';
import {chatFrom,backupFrom,conversationFrom,migrateSnapshot,RecoveryError} from './site/recovery.js';
export {HISTORY_LIMITS,BACKUP_LIMITS,importPlan} from './site/recovery.js';
export function historyId(id){if(typeof id!=='string'||! /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))throw new Rejection('Invalid saved chat');return id;}
function checked(fn,input){try{return fn(input);}catch(e){throw new Rejection(e instanceof RecoveryError?e.message:'Invalid saved chat',e instanceof RecoveryError?e.status:400);}}
export const historyFrom=input=>checked(chatFrom,input);
export const historyBackupFrom=input=>checked(backupFrom,input);
export const conversationFromHistory=input=>checked(conversationFrom,input);
export const migrateHistorySnapshot=input=>checked(migrateSnapshot,input);
export function upsertFrom(input){
 if(!input||Array.isArray(input)||Object.keys(input).sort().join()!=='draft,id,messages,revision,title'||!Number.isSafeInteger(input.revision)||input.revision<0)throw new Rejection('Invalid conversation update');
 if(input.id!==null)historyId(input.id);
 if(input.id===null&&input.revision!==0)throw new Rejection('New conversations require revision zero');
 return {id:input.id,revision:input.revision,...conversationFromHistory({title:input.title,messages:input.messages,draft:input.draft})};
}
export function turnFrom(input){
 if(!input||Array.isArray(input)||Object.keys(input).sort().join()!=='conversationId,revision,turnId'||!Number.isSafeInteger(input.revision)||input.revision<1)throw new Rejection('Invalid generation request');
 historyId(input.conversationId);historyId(input.turnId);return input;
}
