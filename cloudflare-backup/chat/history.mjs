import {Rejection} from './policy.mjs';
import {chatFrom,backupFrom,RecoveryError} from './site/recovery.js';
export {HISTORY_LIMITS,BACKUP_LIMITS,importPlan} from './site/recovery.js';
export function historyId(id){if(typeof id!=='string'||! /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))throw new Rejection('Invalid saved chat');return id;}
function checked(fn,input){try{return fn(input);}catch(e){throw new Rejection(e instanceof RecoveryError?e.message:'Invalid saved chat',e instanceof RecoveryError?e.status:400);}}
export const historyFrom=input=>checked(chatFrom,input);
export const historyBackupFrom=input=>checked(backupFrom,input);
