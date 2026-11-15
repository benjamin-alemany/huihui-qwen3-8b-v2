import {test} from 'node:test';import assert from 'node:assert/strict';
import {Autosave,boundedRecords,recordFrom,OUTBOX_LIMITS,reconcileTurn} from './autosave.js';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const doc=(n=1)=>({id:id(n),revision:0,title:'Dummy chat',messages:[],draft:'Unsent dummy text'});
const record=(n=1)=>({version:1,key:id(n),conversationId:id(n),revision:0,title:'Dummy',messages:[],draft:'Text',pendingTurnId:null,updatedAt:100});
class Store{rows=[];async put(r){this.rows=boundedRecords(this.rows,r);}async remove(k){this.rows=this.rows.filter(r=>r.key!==k);}async removeIfMatch(expected){const row=this.rows.find(r=>r.key===expected.key);if(!row||JSON.stringify(recordFrom(row))!==JSON.stringify(recordFrom(expected)))return false;await this.remove(expected.key);return true;}async list(){return structuredClone(this.rows);}}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const setup=(request,d=doc())=>{const store=new Store();const model=new Autosave({doc:d,key:id(100),store,request,now:()=>100});return {store,model};};
test('cloud Saved appears only after the exact acknowledgement; draft remains separate',async()=>{const d=deferred(),{store,model}=setup(()=>d.promise);await model.edit({draft:'  kept whitespace  '});const saving=model.flush();await new Promise(r=>setImmediate(r));assert.equal(model.status,'saving');assert.equal(store.rows[0].draft,'  kept whitespace  ');d.resolve({item:{...model.snapshot(),revision:1}});assert.equal(await saving,true);assert.equal(model.status,'saved');assert.equal(model.doc.revision,1);assert.equal(store.rows.length,0);});
test('edits while save is in flight serialize against the returned revision',async()=>{const d=deferred(),calls=[];const {model}=setup(async(_,body)=>{calls.push(structuredClone(body));return calls.length===1?d.promise:{item:{...body,revision:body.revision+1}};});const saving=model.flush();await new Promise(r=>setImmediate(r));await model.edit({draft:'Later edit'});d.resolve({item:{...calls[0],revision:1}});assert.equal(await saving,true);assert.equal(calls.length,2);assert.equal(calls[1].revision,1);assert.equal(calls[1].draft,'Later edit');assert.equal(model.doc.revision,2);assert.equal(model.status,'saved');});
test('lost create acknowledgement uses stable UUID and recognizes matching revision conflict without another create',async()=>{const {model}=setup(async(_,body)=>{const e=Error('REVISION_CONFLICT');e.status=409;e.data={item:{...body,revision:1}};throw e;});assert.equal(await model.flush(),true);assert.equal(model.doc.id,id(1));assert.equal(model.status,'saved');});
test('conflicting remote text is retained separately and never overwritten automatically',async()=>{let calls=0;const remote={...doc(),revision:2,draft:'Cloud version'};const {model,store}=setup(async()=>{calls++;const e=Error('REVISION_CONFLICT');e.status=409;e.data={item:remote};throw e;});assert.equal(await model.flush(),false);assert.equal(model.status,'conflict');assert.equal(model.doc.draft,'Unsent dummy text');assert.equal(model.conflict.draft,'Cloud version');assert.equal(store.rows[0].draft,'Unsent dummy text');assert.equal(await model.flush(),false);assert.equal(calls,1);await model.fork(id(2),model.key);assert.equal(model.doc.id,id(2));assert.equal(model.doc.revision,0);assert.equal(model.doc.draft,'Unsent dummy text');assert.equal(store.rows.length,1);});
test('offline and quota errors preserve local content and do not report a saved acknowledgement',async()=>{for(const status of [undefined,429]){const {model,store}=setup(async()=>{const e=Error('Unavailable');e.status=status;throw e;});assert.equal(await model.flush(),false);assert.equal(model.status,status===429?'full':'offline');assert.notEqual(model.savedEpoch,model.epoch);assert.equal(store.rows.length,1);}});
test('bounded recovery updates in place, refuses entry twenty-one and never evicts text',()=>{let rows=[];for(let n=1;n<=20;n++)rows=boundedRecords(rows,record(n));const saved=structuredClone(rows);assert.throws(()=>boundedRecords(rows,record(21)),/full/);assert.deepEqual(rows,saved);rows=boundedRecords(rows,{...record(1),draft:'Updated'});assert.equal(rows.length,20);assert.equal(rows.find(r=>r.key===id(1)).draft,'Updated');assert.throws(()=>recordFrom({...record(),API_KEY:'DUMMY'}),/Invalid/);assert.throws(()=>recordFrom({...record(),draft:'x'.repeat(OUTBOX_LIMITS.entryBytes)}));});
test('pending turn identifier survives recovery but never starts or retries a generation',async()=>{let calls=0;const {model,store}=setup(async()=>{calls++;assert.fail('network not expected');});await model.pending(id(500));const raw=store.rows[0];const restored=setup(()=>assert.fail('generation not expected'));await restored.model.restore(raw);assert.equal(restored.model.pendingTurnId,id(500));assert.equal(await restored.model.flush(),false);assert.equal(calls,0);await restored.model.accept({...doc(),revision:3,messages:[{role:'user',content:'Dummy question'},{role:'assistant',content:'<script>plain text</script>'}],draft:''});assert.equal(restored.model.pendingTurnId,null);assert.equal(restored.model.status,'saved');});
test('input typed during local acknowledgement cleanup also receives a fresh cloud acknowledgement',async()=>{const removing=deferred(),calls=[];const {model,store}=setup(async(_,body)=>{calls.push(structuredClone(body));return {item:{...body,revision:body.revision+1}};});const original=store.removeIfMatch.bind(store);let first=true;store.removeIfMatch=async record=>{if(first){first=false;await removing.promise;}return original(record);};const flushing=model.flush();await new Promise(r=>setImmediate(r));await model.edit({draft:'Edit during cleanup'});removing.resolve();assert.equal(await flushing,true);assert.equal(calls.length,2);assert.equal(calls[1].draft,'Edit during cleanup');assert.equal(model.doc.revision,2);});

test('terminal turn replay preserves a newer cloud draft and refuses to erase later local edits',()=>{const before={...doc(),revision:1};const completed={...before,revision:2,messages:[{role:'user',content:before.draft},{role:'assistant',content:'Dummy answer'}],draft:''};const latest={...completed,revision:3,draft:'Newer cloud draft'};const result=reconcileTurn(before,{status:'completed',item:completed},latest);assert.equal(result.conflict,false);assert.equal(result.item.draft,'Newer cloud draft');assert.equal(result.item.revision,3);const edited={...before,draft:'Later local edit after a poll failure'};assert.equal(reconcileTurn(edited,{status:'completed',item:completed},latest).conflict,true);assert.equal(edited.draft,'Later local edit after a poll failure');assert.throws(()=>reconcileTurn(before,{status:'completed',item:completed},{...latest,id:id(2)}));});

test('acknowledging A cannot erase durable edit B even if the browser stops before B is saved again',async()=>{
 const cleanupEntered=deferred(),releaseCleanup=deferred(),rewriteEntered=deferred(),releaseRewrite=deferred();
 const {model,store}=setup(async(_,body)=>({item:{...body,revision:body.revision+1}}));
 const remove=store.removeIfMatch.bind(store),put=store.put.bind(store);let first=true,afterCleanup=false;
 store.removeIfMatch=async expected=>{if(first){first=false;cleanupEntered.resolve();await releaseCleanup.promise;const removed=await remove(expected);afterCleanup=true;return removed;}return remove(expected);};
 store.put=async record=>{if(afterCleanup&&record.draft==='Durable edit B'){rewriteEntered.resolve();await releaseRewrite.promise;}return put(record);};
 const flushing=model.flush();await cleanupEntered.promise;await model.edit({draft:'Durable edit B'});releaseCleanup.resolve();await rewriteEntered.promise;
 // This is the crash window: no eventual rewrite or second cloud request has run.
 assert.equal(store.rows.length,1);assert.equal(store.rows[0].draft,'Durable edit B');
 const recovered=setup(()=>assert.fail('recovery must not start a request'));await recovered.model.restore(store.rows[0]);assert.equal(recovered.model.doc.draft,'Durable edit B');
 releaseRewrite.resolve();assert.equal(await flushing,true);
});
test('accepting a cloud result in one recovered tab preserves a newer recovery record from another tab',async()=>{
 const {model:first,store}=setup(()=>assert.fail('no request expected'));await first.persist();const original=structuredClone(store.rows[0]);
 const second=new Autosave({doc:doc(),key:original.key,store,request:()=>assert.fail('no request expected'),now:()=>101});await second.restore(original);await second.edit({draft:'Newer draft from tab B'});
 await first.accept({...doc(),revision:1});assert.equal(store.rows.length,1);assert.equal(store.rows[0].draft,'Newer draft from tab B');assert.equal(second.doc.draft,'Newer draft from tab B');
});

test('two offline recovered tabs own independent durable branches and acknowledging one preserves the other',async()=>{
 const store=new Store(),source=record(1);await store.put(source);let requests=0;
 const branch=n=>new Autosave({doc:doc(),key:id(900+n),store,request:()=>{requests++;assert.fail('local recovery must not contact the cloud');},now:()=>200+n,newKey:()=>id(200+n)});
 const a=branch(1),b=branch(2);await a.restore(source);await b.restore(source);await a.edit({draft:'Offline tab A'});await b.edit({draft:'Offline tab B'});
 assert.notEqual(a.key,b.key);assert.notEqual(a.key,source.key);assert.equal(requests,0);
 assert.equal(store.rows.length,3);assert.equal(store.rows.find(r=>r.key===source.key).draft,source.draft);
 assert.equal(store.rows.find(r=>r.key===a.key).draft,'Offline tab A');assert.equal(store.rows.find(r=>r.key===b.key).draft,'Offline tab B');
 await a.accept({...a.snapshot(),revision:1});assert.equal(store.rows.length,1);assert.equal(store.rows[0].key,b.key);assert.equal(store.rows[0].draft,'Offline tab B');
});
test('recovered-branch acknowledgement cannot remove a source row another tab changed',async()=>{
 const store=new Store(),source=record(1);await store.put(source);
 const recovered=new Autosave({doc:doc(),key:id(901),store,request:()=>assert.fail('no cloud request'),newKey:()=>id(201)});await recovered.restore(source);
 const changed={...source,draft:'A newer edit of the source',updatedAt:source.updatedAt+1};await store.put(changed);
 await recovered.accept({...recovered.snapshot(),revision:1});assert.deepEqual(store.rows,[changed]);
});
test('recovery refuses to evict a full outbox or reuse its source key',async()=>{
 const store=new Store();for(let n=1;n<=20;n++)await store.put(record(n));const before=structuredClone(store.rows);
 const recovered=new Autosave({doc:doc(),key:id(901),store,request:()=>assert.fail('no cloud request'),newKey:()=>id(201)});await recovered.restore(before[0]);
 assert.match(recovered.localError,/full/);assert.deepEqual(store.rows,before);assert.equal(recovered.doc.draft,before[0].draft);
 const duplicate=new Autosave({doc:doc(),key:id(902),store,request:()=>assert.fail('no cloud request'),newKey:()=>before[0].key});await assert.rejects(duplicate.restore(before[0]),/fresh/);assert.deepEqual(store.rows,before);
});
