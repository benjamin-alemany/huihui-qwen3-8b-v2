import {test} from 'node:test';import assert from 'node:assert/strict';
import {backupFrom,parseBackup,importPlan,textExport,draftFingerprint,BACKUP_LIMITS} from './recovery.js';
const c={title:'Dummy <script> title',messages:[{role:'user',content:'Cedar'},{role:'assistant',content:'<script>plain text</script>'}]};
const bundle=conversations=>({format:'unjailed.chat-backup',version:1,conversations});
test('backup round trip preserves roles and text, including an unsent trailing user message',()=>{const b=bundle([c,{title:'Draft',messages:[{role:'user',content:'Unsent'}]}]);assert.deepEqual(parseBackup(JSON.stringify(b)),b);});
test('a full store of maximally escaped valid text still fits the backup bound',()=>{const b=bundle(Array.from({length:20},(_,i)=>({title:'Snapshot '+i,messages:[{role:'user',content:'\u0001'.repeat(12000)}]})));assert.deepEqual(parseBackup(JSON.stringify(b,null,2)),b);});
test('invalid version, control fields, tool messages, extra fields and oversized input are rejected',()=>{
 for(const bad of [{...bundle([c]),version:2},{...bundle([c]),RUNPOD_API_KEY:'DUMMY'},{...bundle([c]),conversations:Array(21).fill(c)},bundle([{...c,id:'foreign-id'}]),bundle([{title:'x',messages:[{role:'tool',content:'exec'}]}]),bundle([{title:'x',messages:[{role:'user',content:'x'.repeat(12001)}]}])])assert.throws(()=>backupFrom(bad));
 assert.throws(()=>parseBackup('x'.repeat(BACKUP_LIMITS.bytes+1)));assert.throws(()=>parseBackup('not JSON'));
});
test('import skips exact snapshots, preserves same-title different content and checks whole-batch quota',()=>{
 assert.equal(importPlan([c],bundle([c,c])).add.length,0);
 const other={...c,messages:[{role:'user',content:'Different'}]};assert.equal(importPlan([c],bundle([other])).add.length,1);
 const p=importPlan(Array(20).fill(c),bundle([other]));assert.equal(p.canImport,false);assert.equal(p.remainingSlots,0);
});
test('text export includes a draft-only chat and fingerprints reflect meaningful edits',()=>{assert.equal(textExport([],' Cedar '),'UNSENT DRAFT\nCedar');assert.ok(textExport(c.messages,'unsent').endsWith('UNSENT DRAFT\nunsent'));assert.notEqual(draftFingerprint([],''),draftFingerprint([],'Cedar'));assert.equal(draftFingerprint([],'Cedar'),draftFingerprint([],' Cedar '));});
