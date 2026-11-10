import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SessionEngine} from './engine.mjs';
import {SEED,IMAGE,GPU,MINUTES,catalogFrom,makeQuote,receiptFresh} from './session-policy.mjs';
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
  const deps={now:()=>now,id:()=>`id-${++id}`,hex:n=>(id++%2?'a':'b').repeat(n),enabled:true,connected:true,approval:'one-approved-test',key:'DUMMY_CONTROL_KEY',provider,catalog:provider.catalog,wake:async()=>{},
    guards:[0,1].map(i=>({arm:async(q,key)=>{assert.equal(key,'DUMMY_CONTROL_KEY');if(armFail&&i===1)throw Error('guard failed');guardState[i]=structuredClone(q);},shorten:async(name,at)=>{calls.push(['shorten',i,name,at]);},disarm:async()=>{if(disarmFail&&i===1)throw Error('disarm failed');guardState[i]=null;},report:async()=>({name:guardState[i]?.name,deleted:reports[i]})})),
    heartbeat:async()=>{if(heartbeatFail)throw Error('heartbeat failed');},
    receipts:async q=>{if(proofFail)throw Error('missing current reservation tick');return {schedulerReady:true,reservationName:q.name,image:q.image,guards:Object.fromEntries(['primary','backup'].map(role=>[role,{role,mode:'reservation',eventTimestamp:now,worker:'dummy-'+role,version:'dummy-current-version'}]))};},
    checkVersions:async()=>{if(versionsFail)throw Error('version changed');}};
  const engine=()=>new SessionEngine(store,deps);
  return {store,deps,engine,calls,guardState,provider,set(o){if(o.now!==undefined)now=o.now;if(o.health!==undefined)health=o.health;if(o.clean!==undefined)clean=o.clean;if(o.createError!==undefined)createError=o.createError;if(o.price!==undefined)quotePrice=o.price;if(o.stock!==undefined)stock=o.stock;if(o.pods!==undefined)pods=o.pods;if(o.otherPods!==undefined)otherPods=o.otherPods;if(o.proofFail!==undefined)proofFail=o.proofFail;if(o.heartbeatFail!==undefined)heartbeatFail=o.heartbeatFail;if(o.disarmFail!==undefined)disarmFail=o.disarmFail;if(o.armFail!==undefined)armFail=o.armFail;if(o.versionsFail!==undefined)versionsFail=o.versionsFail;},advance:ms=>now+=ms,get now(){return now;},get pods(){return pods;},get creates(){return createCalls;},
    async start(){const q=await engine().quote();await engine().start({quoteId:q.id,maximumUSD:q.maximumUSD});return q;},async ready(){await this.start();await engine().tick();await engine().tick();await engine().tick();return (await engine().status()).session;}};
}
test('one quote, single-flight Start, persistence across handles, exact image and no billing key in Pod',async()=>{
  const h=harness(),q=await h.start();const initial=await h.engine().status();
  const requests=await Promise.all([h.engine().start({quoteId:q.id,maximumUSD:q.maximumUSD}),h.engine().start({quoteId:q.id,maximumUSD:q.maximumUSD})]);assert.equal(requests[0].session.id,requests[1].session.id);
  await h.engine().tick();await h.engine().tick();await h.engine().tick();assert.equal(h.creates,1);assert.equal((await h.engine().status()).session.phase,'ready');
  const body=h.calls.find(x=>x[0]==='create')[1];assert.equal(body.image,IMAGE);assert.equal(body.gpu.id,GPU);assert.equal(body.startSsh,false);assert.deepEqual(Object.keys(body.env).sort(),['CHAT_CLOUD_GUARDS_VERIFIED','CHAT_DEADLINE_UTC','CHAT_RESERVED_AT','VLLM_API_KEY']);assert.ok(!JSON.stringify(body).includes('DUMMY_CONTROL_KEY'));
  assert.equal(initial.budget.reservedUSD,q.maximumUSD);assert.equal((await h.engine().status()).budget.originalAcceptance.spentUSD,.4);
  assert.ok(!JSON.stringify(await h.engine().status()).includes('inferenceKey'));assert.ok(await h.engine().context());
});
test('Stop immediately revokes inference, survives new handles, verifies cleanup and cannot replay approval',async()=>{
  const h=harness(),s=await h.ready();await h.engine().stop({sessionId:s.id});assert.equal(await h.engine().context(),null);
  h.advance(60000);await h.engine().tick();assert.equal((await h.engine().status()).session.phase,'stopped');assert.equal(h.pods.length,0);assert.deepEqual(h.guardState,[null,null]);
  const status=await h.engine().status();assert.equal(status.budget.reservedUSD,0);assert.equal(status.launchEnabled,false);assert.ok(status.budget.spentUpperUSD>SEED.spent/1e10);
  const q=await h.engine().quote();await assert.rejects(h.engine().start({quoteId:q.id,maximumUSD:q.maximumUSD}),/APPROVAL_ALREADY_USED/);assert.equal(h.creates,1);
});
test('automatic immutable deadline stops without browser activity and cannot extend on reload',async()=>{
  const h=harness(),s=await h.ready();h.advance(MINUTES*60000);assert.equal(await h.engine().context(),null);await h.engine().tick();assert.equal((await h.engine().status()).session.phase,'stopped');assert.equal((await h.engine().status()).session.deadline,s.deadline);assert.equal(h.creates,1);
});
test('cold startup gets until the final minute, without extending the fixed session deadline',async()=>{
  const h=harness();h.set({health:false});await h.ready();assert.equal((await h.engine().status()).session.phase,'starting');const deadline=(await h.engine().status()).session.deadline;h.advance(12*60000);await h.engine().tick();assert.equal((await h.engine().status()).session.phase,'starting');h.advance((MINUTES-1-12)*60000);await h.engine().tick();assert.equal((await h.engine().status()).session.phase,'stopped');assert.equal((await h.engine().status()).session.deadline,deadline);assert.equal(h.creates,1);
});
test('unknown create result holds budget and reconciles without blind retry',async()=>{
  const h=harness();h.set({createError:true});await h.start();await h.engine().tick();await h.engine().tick();const reserved=(await h.engine().status()).budget.reservedUSD;
  h.advance(301000);await h.engine().tick();const status=await h.engine().status();assert.equal(status.session.phase,'attention');assert.equal(status.budget.reservedUSD,reserved);assert.equal(h.creates,1);
  await h.engine().tick();assert.equal(h.creates,1);assert.equal((await h.engine().status()).session.phase,'attention');
});
test('a delayed successful create is adopted and immediately cleaned after owner cancellation',async()=>{
  const h=harness();h.set({createError:true});await h.start();await h.engine().tick();await h.engine().tick();const s=(await h.engine().read()).session;
  await h.engine().stop({sessionId:s.id});h.set({pods:[{id:'abcdefghijklm',name:s.reservation.name,image:IMAGE,createdAt:new Date(h.now).toISOString(),cloud:'SECURE',gpu:{id:GPU,count:1},disk:60,ports:['8000/http'],mounts:{},cost:.59,status:'RUNNING'}]});
  await h.engine().tick();assert.equal((await h.engine().status()).session.phase,'stopped');assert.equal(h.creates,1);
});
test('no stock, changed price, stale guards and active unrelated resources refuse create',async()=>{
  for(const failure of [{stock:'NONE'},{price:.60},{proofFail:true},{armFail:true},{versionsFail:true},{otherPods:[{id:'unrelated'}]}]){
    const h=harness();await h.start();await h.engine().tick();h.set(failure);await h.engine().tick();assert.equal(h.creates,0);assert.equal((await h.engine().status()).session.phase,'failed');assert.equal((await h.engine().status()).budget.reservedUSD,0);assert.deepEqual(h.guardState,[null,null]);assert.ok(!h.calls.some(x=>x[0]==='cleanup'));
  }
});
test('lost STOP/delete responses and guard disarm failure never report successful cleanup early',async()=>{
  const h=harness(),s=await h.ready();h.set({clean:false});await h.engine().stop({sessionId:s.id});await h.engine().tick();assert.equal((await h.engine().status()).session.phase,'stopping');assert.ok((await h.engine().status()).budget.reservedUSD>0);
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
  assert.equal(makeQuote(catalogFrom({id:GPU,secure:true,price:{secure:.59},availability:'HIGH'}),0,'x').maximumUSD,.23);
  assert.throws(()=>receiptFresh({schedulerReady:true,guards:{}},{windowEnd:'2099-01-01'},Date.now()));
});
test('overlapping alarm executions cannot send duplicate creates',async()=>{
 const h=harness();await h.start();await h.engine().tick();await Promise.all([h.engine().tick(),h.engine().tick(),h.engine().tick()]);assert.equal(h.creates,1);
});
test('a receipt that becomes stale before the create transaction refuses launch',async()=>{
 const h=harness();await h.start();await h.engine().tick();const old=h.deps.receipts;h.deps.receipts=async q=>{const p=await old(q);h.advance(90001);return p;};await h.engine().tick();assert.equal(h.creates,0);assert.equal((await h.engine().status()).session.phase,'failed');
});
test('changed Pod identity closes inference and retains the hold without touching another resource',async()=>{
 const h=harness();await h.ready();h.set({pods:h.pods.map(p=>({...p,gpu:{id:'other-GPU',count:1}}))});await h.engine().tick();assert.equal(await h.engine().context(),null);assert.ok((await h.engine().status()).budget.reservedUSD>0);assert.ok(!h.calls.some(x=>x[0]==='cleanup'));
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
 const h=harness();await h.ready();const before=(await h.engine().status()).budget.reservedUSD;
 h.set({pods:h.pods.map(p=>({...p,name:p.name+'-renamed'}))});
 await h.engine().tick();const status=await h.engine().status();
 assert.equal(status.session.phase,'stopping');assert.equal(status.session.cleanupVerified,false);
 assert.equal(status.budget.reservedUSD,before);assert.equal(h.pods.length,1);
 assert.ok(h.guardState.every(Boolean));assert.equal(await h.engine().context(),null);
 assert.ok(!h.calls.some(c=>c[0]==='cleanup'));
});
test('list omission of a known live Pod is not verified deletion',async()=>{
 const h=harness();await h.ready();const before=(await h.engine().status()).budget.reservedUSD;
 h.provider.list=async()=>[];
 await h.engine().tick();const status=await h.engine().status();
 assert.equal(status.session.phase,'stopping');assert.equal(status.session.cleanupVerified,false);
 assert.equal(status.budget.reservedUSD,before);assert.ok(h.guardState.every(Boolean));assert.equal(h.pods.length,1);
});
test('known Pod get failure retains the hold and both guards',async()=>{
 const h=harness();await h.ready();const before=(await h.engine().status()).budget.reservedUSD;
 h.set({pods:[]});h.provider.get=async()=>{throw Error('503');};
 await h.engine().tick();const status=await h.engine().status();
 assert.equal(status.session.phase,'stopping');assert.equal(status.session.cleanupVerified,false);
 assert.equal(status.budget.reservedUSD,before);assert.ok(h.guardState.every(Boolean));
});

test('a matching duplicate cannot hide a renamed known Pod during cleanup',async()=>{
 const h=harness(),s=await h.ready(),before=(await h.engine().status()).budget.reservedUSD;
 await h.engine().update(s.id,current=>{delete current.knownPodIds;}); // Existing persisted sessions predate the observation set.
 const original=h.pods[0],duplicate={...original,id:'nopqrstuvwxyz'};
 h.set({pods:[{...original,name:original.name+'-renamed'},duplicate]});
 await h.engine().stop({sessionId:s.id});await h.engine().tick();
 const status=await h.engine().status();
 assert.equal(status.session.cleanupVerified,false);assert.equal(status.budget.reservedUSD,before);
 assert.ok(h.guardState.every(Boolean));assert.equal(await h.engine().context(),null);
 assert.ok(h.pods.some(p=>p.id===original.id&&p.status==='RUNNING'));
 assert.ok(!h.calls.some(c=>c[0]==='cleanup'&&c[1]===original.id));
 h.set({pods:[]});await h.engine().tick();
 assert.equal((await h.engine().status()).session.cleanupVerified,true);assert.equal(h.creates,1);
});
test('all observed duplicates survive partial cleanup and new engine handles',async()=>{
 const h=harness();await h.ready();const before=(await h.engine().status()).budget.reservedUSD;
 const original=h.pods[0],duplicate={...original,id:'nopqrstuvwxyz'};
 h.set({pods:[original,duplicate]});
 const cleanup=h.provider.cleanup;h.provider.cleanup=async p=>p.id===duplicate.id?false:cleanup(p);
 await h.engine().tick();assert.deepEqual(h.pods.map(p=>p.id),[duplicate.id]);
 h.set({pods:h.pods.map(p=>({...p,name:p.name+'-renamed'}))});
 await h.engine().tick();const status=await h.engine().status();
 assert.equal(status.session.cleanupVerified,false);assert.equal(status.budget.reservedUSD,before);
 assert.ok(h.guardState.every(Boolean));assert.equal(h.pods.length,1);
 assert.deepEqual((await h.engine().read()).session.knownPodIds,[original.id,duplicate.id]);
 h.set({pods:[]});await h.engine().tick();
 assert.equal((await h.engine().status()).session.cleanupVerified,true);
 assert.equal((await h.engine().status()).budget.reservedUSD,0);assert.equal(h.creates,1);
});
test('partial guard deletion reports cannot settle an unknown create outcome',async()=>{
 const h=harness();h.set({createError:true});await h.start();await h.engine().tick();await h.engine().tick();
 const s=(await h.engine().read()).session,before=(await h.engine().status()).budget.reservedUSD;
 const p={id:'abcdefghijklm',name:s.reservation.name,image:IMAGE,createdAt:new Date(h.now).toISOString(),cloud:'SECURE',gpu:{id:GPU,count:1},disk:60,ports:['8000/http'],mounts:{},cost:.59,status:'EXITED'};
 let armed=true;h.deps.guards[0].report=async()=>({armed,name:s.reservation.name,deleted:[p]});
 await h.engine().tick();
 assert.equal((await h.engine().status()).session.cleanupVerified,false);
 assert.equal((await h.engine().status()).budget.reservedUSD,before);assert.ok(h.guardState.every(Boolean));
 armed=false;await h.engine().tick();
 assert.equal((await h.engine().status()).session.cleanupVerified,true);assert.equal(h.creates,1);
});
test('a completed guard report is rechecked before releasing an unknown-create hold',async()=>{
 const h=harness();h.set({createError:true});await h.start();await h.engine().tick();await h.engine().tick();
 const s=(await h.engine().read()).session,before=(await h.engine().status()).budget.reservedUSD;
 const p={id:'abcdefghijklm',name:s.reservation.name,image:IMAGE,createdAt:new Date(h.now).toISOString(),cloud:'SECURE',gpu:{id:GPU,count:1},disk:60,ports:['8000/http'],mounts:{},cost:.59,status:'EXITED'};
 h.deps.guards[0].report=async()=>({armed:false,name:s.reservation.name,deleted:[p]});
 h.provider.get=async()=>{throw Error('read unconfirmed');};
 await h.engine().tick();
 assert.equal((await h.engine().status()).session.cleanupVerified,false);
 assert.equal((await h.engine().status()).budget.reservedUSD,before);assert.ok(h.guardState.every(Boolean));
});
test('a new Pod seen only in final inventory is remembered before a later omission',async()=>{
 const h=harness(),s=await h.ready(),before=(await h.engine().status()).budget.reservedUSD;
 const duplicate={...h.pods[0],id:'nopqrstuvwxyz'},list=h.provider.list;let injected=false;
 h.provider.list=async()=>{
  if(!injected&&h.calls.some(c=>c[0]==='cleanup')){injected=true;h.set({pods:[duplicate]});}
  return list();
 };
 await h.engine().stop({sessionId:s.id});await h.engine().tick();
 assert.equal((await h.engine().status()).session.cleanupVerified,false);
 h.set({pods:[{...duplicate,name:duplicate.name+'-renamed'}]});await h.engine().tick();
 assert.equal((await h.engine().status()).session.cleanupVerified,false);
 assert.equal((await h.engine().status()).budget.reservedUSD,before);assert.ok(h.guardState.every(Boolean));
 assert.ok((await h.engine().read()).session.knownPodIds.includes(duplicate.id));
 h.set({pods:[]});await h.engine().tick();assert.equal((await h.engine().status()).session.cleanupVerified,true);
});
test('observations added during absence checks cannot pass the settlement snapshot',async()=>{
 const h=harness(),s=await h.ready(),before=(await h.engine().status()).budget.reservedUSD;
 const duplicate={...h.pods[0],id:'nopqrstuvwxyz'};h.set({pods:[]});
 let learned=false;h.provider.get=async()=>{
  if(!learned){learned=true;await h.engine().rememberPods((await h.engine().read()).session,[duplicate]);}
  return null;
 };
 await h.engine().stop({sessionId:s.id});await h.engine().tick();
 assert.equal((await h.engine().status()).session.cleanupVerified,false);
 assert.equal((await h.engine().status()).budget.reservedUSD,before);assert.ok(h.guardState.every(Boolean));
 await h.engine().tick();assert.equal((await h.engine().status()).session.cleanupVerified,true);
});
test('operator reconciliation is durable and never resets prior approvals or accounting',async()=>{const h=harness();h.deps.operatorBudget={id:'operator-budget-0123456789abcdef',capUnits:10_000_000_000,spentFloorUnits:3_000_000_000};const status=await h.engine().status();assert.equal(status.budget.capUSD,1);assert.equal(status.budget.spentUpperUSD,.3);await h.ready();const state=await h.engine().read();assert.equal(state.ledger.operatorBudgetReconciliations.length,1);assert.deepEqual(state.ledger.usedApprovals,['one-approved-test']);assert.equal(h.creates,1);});
test('new or malformed budget deployment blocks Start while Stop and cleanup remain available',async()=>{for(const policy of [{id:'operator-budget-0123456789abcdef',capUnits:10_000_000_000,spentFloorUnits:3_000_000_000},{invalid:true}]){const h=harness(),s=await h.ready();h.deps.operatorBudget=policy;const held=(await h.engine().read()).ledger.held;assert.ok(held>0);assert.equal((await h.engine().status()).launchEnabled,false);await h.engine().stop({sessionId:s.id});assert.equal(await h.engine().context(),null);await h.engine().tick();assert.equal(h.pods.length,0);assert.equal((await h.engine().status()).session.phase,'stopped');assert.equal(h.creates,1);}});

test('healthy cold start after minute twelve retains its original automatic deadline',async()=>{const h=harness();h.set({health:false});await h.ready();const deadline=(await h.engine().status()).session.deadline;h.advance(13*60000);h.set({health:true});await h.engine().tick();assert.equal((await h.engine().status()).session.phase,'ready');assert.equal((await h.engine().status()).session.deadline,deadline);h.advance((MINUTES-13)*60000);await h.engine().tick();assert.equal((await h.engine().status()).session.phase,'stopped');assert.equal(h.creates,1);});
