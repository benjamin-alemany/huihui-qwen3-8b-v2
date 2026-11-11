import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SessionEngine} from './engine.mjs';
import {SEED,IMAGE,GPU,MINUTES,catalogFrom,makeQuote,receiptFresh,parseGrant} from './session-policy.mjs';
class Store {
  data=new Map();chain=Promise.resolve();
  async get(k){return structuredClone(this.data.get(k));}
  async put(k,v){this.data.set(k,structuredClone(v));}
  async setAlarm(at){this.data.set('$alarm',at);}
  transaction(fn){const p=this.chain.then(()=>fn(this));this.chain=p.catch(()=>{});return p;}
}
function harness(){
  let now=Date.parse('2026-11-03T12:00:00Z'),id=0,pods=[],createCalls=0,health=true,clean=true,createError=false,quotePrice=.59,stock='HIGH',otherPods=[],proofFail=false,heartbeatFail=false,disarmFail=false,armFail=false,versionsFail=false;
  const store=new Store(),calls=[],guardState=[null,null],reports=[[],[]];
  const provider={catalog:async()=>({id:GPU,secure:true,price:{secure:quotePrice},availability:stock}),list:async()=>structuredClone([...pods,...otherPods]),
    get:async p=>structuredClone(pods.find(x=>x.id===p)??null),
    create:async body=>{createCalls++;calls.push(['create',body]);if(createError)throw Error('network response lost');const p={id:'abcdefghijklm',name:body.name,image:IMAGE,createdAt:new Date(now).toISOString(),cloud:'SECURE',gpu:{id:GPU,count:1},disk:60,ports:['8000/http'],mounts:{},cost:.59,status:'RUNNING',actions:['stop']};pods.push(p);return structuredClone(p);},
    health:async()=>health,
    cleanup:async p=>{calls.push(['cleanup',p.id]);if(clean)pods=pods.filter(x=>x.id!==p.id);return clean;}};
  const deps={now:()=>now,id:()=>`id-${++id}`,hex:n=>(id++%2?'a':'b').repeat(n),enabled:true,connected:true,approval:'one-approved-test',validationMode:true,key:'DUMMY_CONTROL_KEY',provider,catalog:provider.catalog,wake:async()=>{},
    guards:[0,1].map(i=>({arm:async(q,key)=>{assert.equal(key,'DUMMY_CONTROL_KEY');if(armFail&&i===1)throw Error('guard failed');guardState[i]=structuredClone(q);},shorten:async(name,at)=>{calls.push(['shorten',i,name,at]);},disarm:async()=>{if(disarmFail&&i===1)throw Error('disarm failed');guardState[i]=null;},report:async()=>({name:guardState[i]?.name,deleted:reports[i]})})),
    heartbeat:async()=>{if(heartbeatFail)throw Error('heartbeat failed');},
    receipts:async q=>{if(proofFail)throw Error('missing current reservation tick');return {schedulerReady:true,reservationName:q.name,image:q.image,guards:Object.fromEntries(['primary','backup'].map(role=>[role,{role,mode:'reservation',eventTimestamp:now,worker:'dummy-'+role,version:'dummy-current-version'}]))};},
    checkVersions:async()=>{if(versionsFail)throw Error('version changed');}};
  const engine=()=>new SessionEngine(store,deps);
  return {store,deps,engine,calls,guardState,provider,set(o){if(o.now!==undefined)now=o.now;if(o.health!==undefined)health=o.health;if(o.clean!==undefined)clean=o.clean;if(o.createError!==undefined)createError=o.createError;if(o.price!==undefined)quotePrice=o.price;if(o.stock!==undefined)stock=o.stock;if(o.pods!==undefined)pods=o.pods;if(o.otherPods!==undefined)otherPods=o.otherPods;if(o.proofFail!==undefined)proofFail=o.proofFail;if(o.heartbeatFail!==undefined)heartbeatFail=o.heartbeatFail;if(o.disarmFail!==undefined)disarmFail=o.disarmFail;if(o.armFail!==undefined)armFail=o.armFail;if(o.versionsFail!==undefined)versionsFail=o.versionsFail;},advance:ms=>now+=ms,get now(){return now;},get pods(){return pods;},get creates(){return createCalls;},
    async start(input){const q=await engine().quote(input);await engine().start({quoteId:q.id,maximumUSD:q.maximumUSD});return q;},async ready(input){await this.start(input);await engine().tick();await engine().tick();await engine().tick();return (await engine().status()).session;}};
}
test('current guard proof commits before create and owner evidence never includes raw tail/control secrets',async()=>{
 const h=harness(),receipts=h.deps.receipts,create=h.provider.create;
 h.deps.receipts=async q=>{const proof=await receipts(q);proof.rawTail='DUMMY_PRIVATE_TAIL_URL';proof.apiKey='DUMMY_PRIVATE_CONTROL_KEY';for(const g of Object.values(proof.guards))g.rawFrame='DUMMY_PRIVATE_RAW_FRAME';return proof;};
 h.provider.create=async body=>{const r=await h.engine().read();assert.equal(r.session.createAttempted,true);assert.ok(r.session.guardProof);assert.equal(r.session.guardProof.name,r.session.reservation.name);assert.equal(r.session.guardProof.guards.primary.version,'dummy-current-version');assert.equal(r.session.guardProof.verifiedAt,h.now);return create(body);};
 const s=await h.ready(),text=JSON.stringify(s.guardProof);assert.equal(h.creates,1);for(const secret of ['DUMMY_PRIVATE_TAIL_URL','DUMMY_PRIVATE_CONTROL_KEY','DUMMY_PRIVATE_RAW_FRAME','DUMMY_CONTROL_KEY'])assert(!text.includes(secret));assert.deepEqual(Object.keys(s.guardProof.guards).sort(),['backup','primary']);
});
test('one quote, single-flight Start, persistence across handles, exact image and no billing key in Pod',async()=>{
  const h=harness(),q=await h.start();const initial=await h.engine().status();
  const requests=await Promise.all([h.engine().start({quoteId:q.id,maximumUSD:q.maximumUSD}),h.engine().start({quoteId:q.id,maximumUSD:q.maximumUSD})]);assert.equal(requests[0].session.id,requests[1].session.id);
  await h.engine().tick();await h.engine().tick();await h.engine().tick();assert.equal(h.creates,1);assert.equal((await h.engine().status()).session.phase,'ready');
  const body=h.calls.find(x=>x[0]==='create')[1];assert.equal(body.image,IMAGE);assert.equal(body.gpu.id,GPU);assert.equal(body.startSsh,false);assert.deepEqual(Object.keys(body.env).sort(),['CHAT_CLOUD_GUARDS_VERIFIED','CHAT_DEADLINE_UTC','CHAT_RESERVED_AT','VLLM_API_KEY']);assert.ok(!JSON.stringify(body).includes('DUMMY_CONTROL_KEY'));
  assert.equal(initial.testBudget.reservedUSD,q.maximumUSD);assert.equal((await h.engine().status()).testBudget.originalAcceptance.spentUSD,.4);
  assert.ok(!JSON.stringify(await h.engine().status()).includes('inferenceKey'));assert.ok(await h.engine().context());
});
test('Stop immediately revokes inference, survives new handles, verifies cleanup and cannot replay approval',async()=>{
  const h=harness(),s=await h.ready();await h.engine().stop({sessionId:s.id});assert.equal(await h.engine().context(),null);
  h.advance(60000);await h.engine().tick();assert.equal((await h.engine().status()).session.phase,'stopped');assert.equal(h.pods.length,0);assert.deepEqual(h.guardState,[null,null]);
  const status=await h.engine().status();assert.equal(status.testBudget.reservedUSD,0);assert.equal(status.launchEnabled,false);assert.ok(status.testBudget.spentUpperUSD>SEED.spent/1e10);
  const q=await h.engine().quote();await assert.rejects(h.engine().start({quoteId:q.id,maximumUSD:q.maximumUSD}),/APPROVAL_ALREADY_USED/);assert.equal(h.creates,1);
});
test('automatic immutable deadline stops without browser activity and cannot extend on reload',async()=>{
  const h=harness(),s=await h.ready();h.advance(MINUTES*60000);assert.equal(await h.engine().context(),null);await h.engine().tick();assert.equal((await h.engine().status()).session.phase,'stopped');assert.equal((await h.engine().status()).session.deadline,s.deadline);assert.equal(h.creates,1);
});
test('legacy validation cold startup stops at the bounded cutoff without extending expiry',async()=>{
  const h=harness();h.set({health:false});await h.ready();assert.equal((await h.engine().status()).session.phase,'starting');const deadline=(await h.engine().status()).session.deadline;h.advance(12*60000);await h.engine().tick();assert.equal((await h.engine().status()).session.phase,'starting');h.advance((15-12)*60000);await h.engine().tick();assert.equal((await h.engine().status()).session.phase,'stopped');assert.equal((await h.engine().status()).session.deadline,deadline);assert.equal(h.creates,1);
});
test('unknown create result holds budget and reconciles without blind retry',async()=>{
  const h=harness();h.set({createError:true});await h.start();await h.engine().tick();await h.engine().tick();const reserved=(await h.engine().status()).testBudget.reservedUSD;
  h.advance(301000);await h.engine().tick();const status=await h.engine().status();assert.equal(status.session.phase,'attention');assert.equal(status.testBudget.reservedUSD,reserved);assert.equal(h.creates,1);
  await h.engine().tick();assert.equal(h.creates,1);assert.equal((await h.engine().status()).session.phase,'attention');
});
test('a delayed successful create is adopted and immediately cleaned after owner cancellation',async()=>{
  const h=harness();h.set({createError:true});await h.start();await h.engine().tick();await h.engine().tick();const s=(await h.engine().read()).session;
  await h.engine().stop({sessionId:s.id});h.set({pods:[{id:'abcdefghijklm',name:s.reservation.name,image:IMAGE,createdAt:new Date(h.now).toISOString(),cloud:'SECURE',gpu:{id:GPU,count:1},disk:60,ports:['8000/http'],mounts:{},cost:.59,status:'RUNNING'}]});
  await h.engine().tick();assert.equal((await h.engine().status()).session.phase,'stopped');assert.equal(h.creates,1);
});
test('no stock, changed price, stale guards and active unrelated resources refuse create',async()=>{
  for(const failure of [{stock:'NONE'},{price:.60},{proofFail:true},{armFail:true},{versionsFail:true},{otherPods:[{id:'unrelated'}]}]){
    const h=harness();await h.start();await h.engine().tick();h.set(failure);await h.engine().tick();assert.equal(h.creates,0);assert.equal((await h.engine().status()).session.phase,'failed');assert.equal((await h.engine().status()).testBudget.reservedUSD,0);assert.deepEqual(h.guardState,[null,null]);assert.ok(!h.calls.some(x=>x[0]==='cleanup'));
  }
});
test('lost STOP/delete responses and guard disarm failure never report successful cleanup early',async()=>{
  const h=harness(),s=await h.ready();h.set({clean:false});await h.engine().stop({sessionId:s.id});await h.engine().tick();assert.equal((await h.engine().status()).session.phase,'stopping');assert.ok((await h.engine().status()).testBudget.reservedUSD>0);
  h.set({clean:true,disarmFail:true});await h.engine().tick();assert.equal((await h.engine().status()).session.cleanupVerified,false);h.set({disarmFail:false});await h.engine().tick();assert.equal((await h.engine().status()).session.cleanupVerified,true);
});
test('Stop during heartbeat or arming cannot race into create',async()=>{
  for(const stage of ['heartbeat','receipts']){
    const h=harness();await h.start();const original=h.deps[stage];h.deps[stage]=async(...args)=>{const s=(await h.engine().status()).session;await h.engine().stop({sessionId:s.id});return original(...args);};
    await h.engine().tick();if(stage==='receipts')await h.engine().tick();await h.engine().tick();assert.equal(h.creates,0);assert.equal((await h.engine().status()).session.phase,'cancelled');
  }
});
test('expired/tampered quotes, locked launch, exhausted budget and wrong Stop ID fail closed',async()=>{
  for(const kind of ['expired','price','locked','budget','fields']){
    const h=harness(),q=await h.engine().quote();if(kind==='expired')h.advance(120001);if(kind==='locked')h.deps.enabled=false;if(kind==='budget')await h.engine().tx(r=>{r.ledger.spent=r.ledger.cap;});
    const body={quoteId:q.id,maximumUSD:kind==='price'?0:q.maximumUSD,...(kind==='fields'?{tools:true}:{})};await assert.rejects(h.engine().start(body));assert.equal(h.creates,0);
  }
  const h=harness();await h.start();await assert.rejects(h.engine().stop({sessionId:'wrong'}),/SESSION_CHANGED/);
});
test('unsafe catalog or missing/wrong/stale proof cannot authorize a launch',()=>{
  for(const c of [{id:GPU,secure:true,price:{secure:2},availability:'HIGH'},{id:'other',secure:true,price:{secure:.59}},{id:GPU,secure:true,price:{secure:NaN}}])assert.throws(()=>catalogFrom(c));
  assert.equal(makeQuote(catalogFrom({id:GPU,secure:true,price:{secure:.59},availability:'HIGH'}),0,'x').maximumUSD,.35);
  assert.throws(()=>receiptFresh({schedulerReady:true,guards:{}},{windowEnd:'2099-01-01'},Date.now()));
});
test('overlapping alarm executions cannot send duplicate creates',async()=>{
 const h=harness();await h.start();await h.engine().tick();await Promise.all([h.engine().tick(),h.engine().tick(),h.engine().tick()]);assert.equal(h.creates,1);
});
test('a receipt that becomes stale before the create transaction refuses launch',async()=>{
 const h=harness();await h.start();await h.engine().tick();const old=h.deps.receipts;h.deps.receipts=async q=>{const p=await old(q);h.advance(90001);return p;};await h.engine().tick();assert.equal(h.creates,0);assert.equal((await h.engine().status()).session.phase,'failed');
});
test('changed Pod identity closes inference and retains the hold without touching another resource',async()=>{
 const h=harness();await h.ready();h.set({pods:h.pods.map(p=>({...p,gpu:{id:'other-GPU',count:1}}))});await h.engine().tick();assert.equal(await h.engine().context(),null);assert.ok((await h.engine().status()).testBudget.reservedUSD>0);assert.ok(!h.calls.some(x=>x[0]==='cleanup'));
});
test('a transient health failure after initial readiness closes chat and can recover without extending the timer',async()=>{
 const h=harness(),s=await h.ready();h.advance(13*60000);h.set({health:false});await h.engine().tick();assert.equal((await h.engine().status()).session.phase,'starting');assert.equal(await h.engine().context(),null);h.set({health:true});await h.engine().tick();assert.equal((await h.engine().status()).session.phase,'ready');assert.equal((await h.engine().status()).session.deadline,s.deadline);assert.equal(h.creates,1);
});
test('Start and Stop commit their wakeup atomically with state, without an external wake call',async()=>{
 const h=harness();h.deps.wake=async()=>{throw Error('unexpected external wake');};await h.start();assert.equal(h.store.data.get('$alarm'),h.now+100);const s=(await h.engine().status()).session;
 // Stop fans out only after its durable cancellation+wakeup transaction.
 await assert.rejects(h.engine().stop({sessionId:s.id}));assert.equal((await h.engine().status()).session.stopRequested,true);assert.equal(h.store.data.get('$alarm'),h.now+100);assert.equal(h.creates,0);
});

test('known Pod identity change cannot be reported as verified cleanup',async()=>{
 const h=harness();await h.ready();const before=(await h.engine().status()).testBudget.reservedUSD;
 h.set({pods:h.pods.map(p=>({...p,name:p.name+'-renamed'}))});
 await h.engine().tick();const status=await h.engine().status();
 assert.equal(status.session.phase,'stopping');assert.equal(status.session.cleanupVerified,false);
 assert.equal(status.testBudget.reservedUSD,before);assert.equal(h.pods.length,1);
 assert.ok(h.guardState.every(Boolean));assert.equal(await h.engine().context(),null);
 assert.ok(!h.calls.some(c=>c[0]==='cleanup'));
});
test('list omission of a known live Pod is not verified deletion',async()=>{
 const h=harness();await h.ready();const before=(await h.engine().status()).testBudget.reservedUSD;
 h.provider.list=async()=>[];
 await h.engine().tick();const status=await h.engine().status();
 assert.equal(status.session.phase,'stopping');assert.equal(status.session.cleanupVerified,false);
 assert.equal(status.testBudget.reservedUSD,before);assert.ok(h.guardState.every(Boolean));assert.equal(h.pods.length,1);
});
test('known Pod get failure retains the hold and both guards',async()=>{
 const h=harness();await h.ready();const before=(await h.engine().status()).testBudget.reservedUSD;
 h.set({pods:[]});h.provider.get=async()=>{throw Error('503');};
 await h.engine().tick();const status=await h.engine().status();
 assert.equal(status.session.phase,'stopping');assert.equal(status.session.cleanupVerified,false);
 assert.equal(status.testBudget.reservedUSD,before);assert.ok(h.guardState.every(Boolean));
});

test('a matching duplicate cannot hide a renamed known Pod during cleanup',async()=>{
 const h=harness(),s=await h.ready(),before=(await h.engine().status()).testBudget.reservedUSD;
 await h.engine().update(s.id,current=>{delete current.knownPodIds;}); // Existing persisted sessions predate the observation set.
 const original=h.pods[0],duplicate={...original,id:'nopqrstuvwxyz'};
 h.set({pods:[{...original,name:original.name+'-renamed'},duplicate]});
 await h.engine().stop({sessionId:s.id});await h.engine().tick();
 const status=await h.engine().status();
 assert.equal(status.session.cleanupVerified,false);assert.equal(status.testBudget.reservedUSD,before);
 assert.ok(h.guardState.every(Boolean));assert.equal(await h.engine().context(),null);
 assert.ok(h.pods.some(p=>p.id===original.id&&p.status==='RUNNING'));
 assert.ok(!h.calls.some(c=>c[0]==='cleanup'&&c[1]===original.id));
 h.set({pods:[]});await h.engine().tick();
 assert.equal((await h.engine().status()).session.cleanupVerified,true);assert.equal(h.creates,1);
});
test('all observed duplicates survive partial cleanup and new engine handles',async()=>{
 const h=harness();await h.ready();const before=(await h.engine().status()).testBudget.reservedUSD;
 const original=h.pods[0],duplicate={...original,id:'nopqrstuvwxyz'};
 h.set({pods:[original,duplicate]});
 const cleanup=h.provider.cleanup;h.provider.cleanup=async p=>p.id===duplicate.id?false:cleanup(p);
 await h.engine().tick();assert.deepEqual(h.pods.map(p=>p.id),[duplicate.id]);
 h.set({pods:h.pods.map(p=>({...p,name:p.name+'-renamed'}))});
 await h.engine().tick();const status=await h.engine().status();
 assert.equal(status.session.cleanupVerified,false);assert.equal(status.testBudget.reservedUSD,before);
 assert.ok(h.guardState.every(Boolean));assert.equal(h.pods.length,1);
 assert.deepEqual((await h.engine().read()).session.knownPodIds,[original.id,duplicate.id]);
 h.set({pods:[]});await h.engine().tick();
 assert.equal((await h.engine().status()).session.cleanupVerified,true);
 assert.equal((await h.engine().status()).testBudget.reservedUSD,0);assert.equal(h.creates,1);
});
test('partial guard deletion reports cannot settle an unknown create outcome',async()=>{
 const h=harness();h.set({createError:true});await h.start();await h.engine().tick();await h.engine().tick();
 const s=(await h.engine().read()).session,before=(await h.engine().status()).testBudget.reservedUSD;
 const p={id:'abcdefghijklm',name:s.reservation.name,image:IMAGE,createdAt:new Date(h.now).toISOString(),cloud:'SECURE',gpu:{id:GPU,count:1},disk:60,ports:['8000/http'],mounts:{},cost:.59,status:'EXITED'};
 let armed=true;h.deps.guards[0].report=async()=>({armed,name:s.reservation.name,deleted:[p]});
 await h.engine().tick();
 assert.equal((await h.engine().status()).session.cleanupVerified,false);
 assert.equal((await h.engine().status()).testBudget.reservedUSD,before);assert.ok(h.guardState.every(Boolean));
 armed=false;await h.engine().tick();
 assert.equal((await h.engine().status()).session.cleanupVerified,true);assert.equal(h.creates,1);
});
test('a completed guard report is rechecked before releasing an unknown-create hold',async()=>{
 const h=harness();h.set({createError:true});await h.start();await h.engine().tick();await h.engine().tick();
 const s=(await h.engine().read()).session,before=(await h.engine().status()).testBudget.reservedUSD;
 const p={id:'abcdefghijklm',name:s.reservation.name,image:IMAGE,createdAt:new Date(h.now).toISOString(),cloud:'SECURE',gpu:{id:GPU,count:1},disk:60,ports:['8000/http'],mounts:{},cost:.59,status:'EXITED'};
 h.deps.guards[0].report=async()=>({armed:false,name:s.reservation.name,deleted:[p]});
 h.provider.get=async()=>{throw Error('read unconfirmed');};
 await h.engine().tick();
 assert.equal((await h.engine().status()).session.cleanupVerified,false);
 assert.equal((await h.engine().status()).testBudget.reservedUSD,before);assert.ok(h.guardState.every(Boolean));
});
test('a new Pod seen only in final inventory is remembered before a later omission',async()=>{
 const h=harness(),s=await h.ready(),before=(await h.engine().status()).testBudget.reservedUSD;
 const duplicate={...h.pods[0],id:'nopqrstuvwxyz'},list=h.provider.list;let injected=false;
 h.provider.list=async()=>{
  if(!injected&&h.calls.some(c=>c[0]==='cleanup')){injected=true;h.set({pods:[duplicate]});}
  return list();
 };
 await h.engine().stop({sessionId:s.id});await h.engine().tick();
 assert.equal((await h.engine().status()).session.cleanupVerified,false);
 h.set({pods:[{...duplicate,name:duplicate.name+'-renamed'}]});await h.engine().tick();
 assert.equal((await h.engine().status()).session.cleanupVerified,false);
 assert.equal((await h.engine().status()).testBudget.reservedUSD,before);assert.ok(h.guardState.every(Boolean));
 assert.ok((await h.engine().read()).session.knownPodIds.includes(duplicate.id));
 h.set({pods:[]});await h.engine().tick();assert.equal((await h.engine().status()).session.cleanupVerified,true);
});
test('observations added during absence checks cannot pass the settlement snapshot',async()=>{
 const h=harness(),s=await h.ready(),before=(await h.engine().status()).testBudget.reservedUSD;
 const duplicate={...h.pods[0],id:'nopqrstuvwxyz'};h.set({pods:[]});
 let learned=false;h.provider.get=async()=>{
  if(!learned){learned=true;await h.engine().rememberPods((await h.engine().read()).session,[duplicate]);}
  return null;
 };
 await h.engine().stop({sessionId:s.id});await h.engine().tick();
 assert.equal((await h.engine().status()).session.cleanupVerified,false);
 assert.equal((await h.engine().status()).testBudget.reservedUSD,before);assert.ok(h.guardState.every(Boolean));
 await h.engine().tick();assert.equal((await h.engine().status()).session.cleanupVerified,true);
});
test('operator reconciliation is durable and never resets prior approvals or accounting',async()=>{const h=harness();h.deps.operatorBudget={id:'operator-budget-0123456789abcdef',capUnits:10_000_000_000,spentFloorUnits:3_000_000_000};const status=await h.engine().status();assert.equal(status.testBudget.capUSD,1);assert.equal(status.testBudget.spentUpperUSD,.3);await h.ready();const state=await h.engine().read();assert.equal(state.ledger.operatorBudgetReconciliations.length,1);assert.deepEqual(state.ledger.usedApprovals,['one-approved-test']);assert.equal(h.creates,1);});
test('new or malformed budget deployment blocks Start while Stop and cleanup remain available',async()=>{for(const policy of [{id:'operator-budget-0123456789abcdef',capUnits:10_000_000_000,spentFloorUnits:3_000_000_000},{invalid:true}]){const h=harness(),s=await h.ready();h.deps.operatorBudget=policy;const held=(await h.engine().read()).ledger.held;assert.ok(held>0);assert.equal((await h.engine().status()).launchEnabled,false);await h.engine().stop({sessionId:s.id});assert.equal(await h.engine().context(),null);await h.engine().tick();assert.equal(h.pods.length,0);assert.equal((await h.engine().status()).session.phase,'stopped');assert.equal(h.creates,1);}});

test('healthy cold start after minute twelve retains its original automatic deadline',async()=>{const h=harness();h.set({health:false});await h.ready();const deadline=(await h.engine().status()).session.deadline;h.advance(13*60000);h.set({health:true});await h.engine().tick();assert.equal((await h.engine().status()).session.phase,'ready');assert.equal((await h.engine().status()).session.deadline,deadline);h.advance((MINUTES-13)*60000);await h.engine().tick();assert.equal((await h.engine().status()).session.phase,'stopped');assert.equal(h.creates,1);});

const grantId=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
async function ordinary(allowance=2){const h=harness();h.deps.validationMode=false;h.deps.approval='';if(allowance)await h.engine().grant({grantId:grantId(1),amountUSD:allowance});return h;}
test('acceptance refuses ordinary grants without writing funds or replay markers; ordinary mode remains available',async()=>{
 const h=harness(),grant={grantId:grantId(9),amountUSD:1},before=await h.engine().status();
 await assert.rejects(h.engine().grant(grant),e=>e.code==='ORDINARY_ALLOWANCE_DISABLED_DURING_ACCEPTANCE');
 const after=await h.engine().status();assert.deepEqual(after.ordinaryBudget,before.ordinaryBudget);assert.deepEqual(after.testBudget,before.testBudget);assert.equal(after.ordinaryBudget.capUSD,0);assert.equal(await h.store.get('ordinary-grant-v1:'+grant.grantId),undefined);assert.equal(h.creates,0);
 h.deps.validationMode=false;const ordinary=await h.engine().grant(grant);assert.equal(ordinary.ordinaryBudget.capUSD,1);assert.deepEqual(ordinary.testBudget,before.testBudget);
 h.deps.validationMode=true;await assert.rejects(h.engine().grant(grant),e=>e.code==='ORDINARY_ALLOWANCE_DISABLED_DURING_ACCEPTANCE');assert.equal((await h.engine().status()).ordinaryBudget.capUSD,1);
});
test('ordinary allowance is zero by default and cannot consume historical test funds',async()=>{
 const h=await ordinary(0),before=structuredClone((await h.engine().read()).ledger),q=await h.engine().quote();
 assert.equal(q.minutes,30);assert.equal(q.maximumUSD,.35);assert.equal(q.ordinaryBudget.remainingUSD,0);assert.equal(q.launchEnabled,false);
 await assert.rejects(h.engine().start({quoteId:q.id,maximumUSD:q.maximumUSD}),/BUDGET_EXHAUSTED/);
 assert.deepEqual((await h.engine().read()).ledger,before);assert.equal(h.creates,0);
});
test('owner grants are exact, bounded, idempotent across handles and never create or renew a session',async()=>{
 const h=await ordinary(0),before=structuredClone((await h.engine().read()).ledger),input={grantId:grantId(1),amountUSD:10};
 await Promise.all([h.engine().grant(input),h.engine().grant(input)]);
 let s=await h.engine().status();assert.equal(s.ordinaryBudget.capUSD,10);assert.equal(s.ordinaryBudget.grantCount,1);assert.equal(s.session,null);assert.equal(h.creates,0);
 await assert.rejects(h.engine().grant({...input,amountUSD:9}),/GRANT_ID_REUSED/);
 for(const bad of [null,[],{}, {...input,grantId:[grantId(1)]},{...input,amountUSD:0},{...input,amountUSD:-1},{...input,amountUSD:10.01},{...input,amountUSD:Infinity},{...input,amountUSD:.00000000001},{...input,amountUSD:'1'},{...input,renew:true}])await assert.rejects(h.engine().grant(bad),/INVALID_GRANT/);
 await h.engine().grant({grantId:grantId(2),amountUSD:.01});s=await h.engine().status();assert.equal(s.ordinaryBudget.capUSD,10.01);assert.equal(s.ordinaryBudget.grantCount,2);assert.deepEqual((await h.engine().read()).ledger,before);
});
test('duration is bound to the quote, reservation, model deadline and immutable session context',async()=>{
 for(const minutes of [15,30,60]){
  const h=await ordinary(),historical=structuredClone((await h.engine().read()).ledger),s=await h.ready({minutes}),record=(await h.engine().read()).session;
  assert.equal(s.minutes,minutes);assert.equal(record.reservation.minutes,minutes);assert.equal(Date.parse(s.deadline)-record.bootAt,minutes*60000);
  const body=h.calls.find(c=>c[0]==='create')[1];assert.equal(Date.parse(body.env.CHAT_DEADLINE_UTC)-Date.parse(body.env.CHAT_RESERVED_AT),minutes*60000);
  assert.equal(JSON.parse((await h.engine().context()).CHAT_SESSION).minutes,minutes);
  const later=await h.engine().quote({minutes:minutes===60?15:60});assert.equal((await h.engine().status()).session.deadline,s.deadline);assert.equal(later.launchEnabled,false);
  h.advance(minutes*60000);assert.equal(await h.engine().context(),null);await h.engine().tick();assert.equal((await h.engine().status()).session.cleanupVerified,true);
  assert.deepEqual((await h.engine().read()).ledger,historical);assert.equal((await h.engine().status()).ordinaryBudget.reservedUSD,0);assert.equal(h.creates,1);
 }
});
test('product quotes reject arbitrary durations, fields and validation-mode overrides',async()=>{
 const h=await ordinary();for(const input of [null,0,'30',[],{minutes:18},{minutes:10},{minutes:600},{minutes:'30'},{minutes:30,tools:true}])await assert.rejects(h.engine().quote(input),/INVALID_DURATION/);
 h.deps.validationMode=true;await assert.rejects(h.engine().quote({minutes:30}),/INVALID_DURATION/);const q=await h.engine().quote();assert.equal(q.minutes,18);assert.equal(q.budgetKind,'test');
});
test('ordinary sessions can repeat within allowance without a deployment approval, but never overlap or replay old quotes',async()=>{
 const h=await ordinary(),first=await h.start({minutes:15});await h.engine().tick();await h.engine().tick();await h.engine().tick();
 const secondQuote=await h.engine().quote({minutes:30});await assert.rejects(h.engine().start({quoteId:secondQuote.id,maximumUSD:secondQuote.maximumUSD}),/SESSION_ALREADY_ACTIVE/);
 let s=(await h.engine().status()).session;await h.engine().stop({sessionId:s.id});await h.engine().tick();assert.equal(h.pods.length,0);
 await h.ready({minutes:30});s=(await h.engine().status()).session;await h.engine().stop({sessionId:s.id});await h.engine().tick();assert.equal(h.creates,2);
 await assert.rejects(h.engine().start({quoteId:first.id,maximumUSD:first.maximumUSD}),/QUOTE_ALREADY_USED/);assert.equal(h.creates,2);assert.deepEqual((await h.engine().read()).ledger.usedApprovals,[]);
});
test('startup includes cold boot and aborts after min(15,duration-2) without renewing time',async()=>{
 for(const minutes of [15,30,60]){
  const h=await ordinary();h.set({health:false});const s=await h.ready({minutes}),cutoff=Math.min(15,minutes-2);
  h.advance(cutoff*60000-1);await h.engine().tick();assert.equal((await h.engine().status()).session.phase,'starting');
  h.advance(1);await h.engine().tick();assert.equal((await h.engine().status()).session.cleanupVerified,true);assert.equal((await h.engine().status()).session.code,'STARTUP_TIMEOUT');assert.equal((await h.engine().status()).session.deadline,s.deadline);assert.equal(h.creates,1);
 }
});
test('ordinary holds survive unknown creates and test-budget mode changes without pooling',async()=>{
 const h=await ordinary(),historical=structuredClone((await h.engine().read()).ledger);h.set({createError:true});await h.start({minutes:30});await h.engine().tick();await h.engine().tick();
 let s=await h.engine().status();assert.equal(s.ordinaryBudget.reservedUSD,.35);assert.equal(s.testBudget.reservedUSD,0);h.deps.validationMode=true;h.advance(301000);await h.engine().tick();s=await h.engine().status();
 assert.equal(s.session.phase,'attention');assert.equal(s.ordinaryBudget.reservedUSD,.35);assert.deepEqual((await h.engine().read()).ledger,historical);assert.equal(h.creates,1);
});

test('unresolved historical allocations and stranded holds cannot be displaced by an ordinary session',async()=>{
 for(const patch of [{session:{id:'legacy',phase:'failed',createAttempted:true}},{session:{id:'legacy',phase:'cancelled',createAttempted:true}},{held:1}]){
  const h=await ordinary();await h.engine().tx(r=>{if(patch.session)r.session=patch.session;else r.ledger.held=patch.held;});
  const before=await h.engine().read(),q=await h.engine().quote({minutes:15});assert.equal(q.launchEnabled,false);
  await assert.rejects(h.engine().start({quoteId:q.id,maximumUSD:q.maximumUSD}),/SESSION_ALREADY_ACTIVE/);const after=await h.engine().read();assert.deepEqual(after.session,before.session);assert.deepEqual(after.ledger,before.ledger);assert.equal(h.creates,0);
 }
});

test('all whole-cent grants through ten dollars are exact, and subcent values are refused',()=>{
 const grantId='00000000-0000-4000-8000-000000000001';
 for(let cents=1;cents<=1000;cents++)assert.equal(parseGrant({grantId,amountUSD:cents/100}).amountUnits,cents*100000000);
 for(const amountUSD of [.005,.015,.0001,1e-10,.07000000001])assert.throws(()=>parseGrant({grantId,amountUSD}),/INVALID_GRANT/);
});
