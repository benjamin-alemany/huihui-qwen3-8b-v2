import test from 'node:test';
import assert from 'node:assert/strict';
import {parseOriginalAcceptance,budgetView,SEED,ORIGINAL_ACCEPTANCE} from '../controller/session-policy.mjs';
import {SessionEngine} from '../controller/engine.mjs';
import {hyperstackControllerFactory} from './controller-factory.mjs';
import {Store,NOW} from './fixtures.mjs';
const DUMMY={capUSD:.51,spentUSD:.4,remainingUSD:.11};
test('trusted original acceptance view requires exact numeric keys and preserves the fixed allowance',()=>{
 const view=parseOriginalAcceptance(JSON.stringify(DUMMY));assert.deepEqual(view,DUMMY);assert(Object.isFrozen(view));assert.equal(parseOriginalAcceptance(undefined),null);assert.equal(parseOriginalAcceptance(''),null);
 for(const p of [null,[],true,{...DUMMY,extra:true},{...DUMMY,capUSD:1},{...DUMMY,spentUSD:'0.4'},{...DUMMY,spentUSD:-1},{...DUMMY,remainingUSD:1},{...DUMMY,remainingUSD:0}])assert.throws(()=>parseOriginalAcceptance(JSON.stringify(p)),e=>e.code==='ORIGINAL_ACCEPTANCE_INVALID');
 for(const raw of ['not JSON','{"capUSD":0.51,"spentUSD":1e999,"remainingUSD":0.11}',null])assert.throws(()=>parseOriginalAcceptance(raw),e=>e.code==='ORIGINAL_ACCEPTANCE_INVALID');
});
test('view consistency tolerates only sub-nanodollar floating error and never recalculates private figures',()=>{
 const near={...DUMMY,remainingUSD:DUMMY.remainingUSD+1e-10};assert.deepEqual(parseOriginalAcceptance(JSON.stringify(near)),near);assert.throws(()=>parseOriginalAcceptance(JSON.stringify({...DUMMY,remainingUSD:DUMMY.remainingUSD+1e-8})));
});
test('explicit unknown view never falls back to public synthetic amounts or mutates a budget',()=>{
 const ledger=structuredClone(SEED),before=structuredClone(ledger);assert.deepEqual(budgetView(ledger).originalAcceptance,ORIGINAL_ACCEPTANCE);assert.equal(budgetView(ledger,null).originalAcceptance,null);assert.deepEqual(budgetView(ledger,parseOriginalAcceptance(JSON.stringify(DUMMY))).originalAcceptance,DUMMY);assert.deepEqual(ledger,before);
});
test('engine presentation override leaves stored approvals, ordinary funds and historical ledger intact',async()=>{
 const store=new Store(),record={ledger:structuredClone(SEED),ordinaryLedger:{version:1,cap:10000000000,spent:0,held:0,grantCount:1},session:null,quotes:[]};record.ledger.usedApprovals=['DUMMY_USED'];await store.put('session-ledger-v1',record);
 const deps={now:()=>NOW,enabled:false,connected:false,originalAcceptance:parseOriginalAcceptance(JSON.stringify(DUMMY))},engine=new SessionEngine(store,deps);
 assert.deepEqual((await engine.status()).testBudget.originalAcceptance,DUMMY);deps.originalAcceptance=null;assert.equal((await engine.status()).testBudget.originalAcceptance,null);
 const after=await store.get('session-ledger-v1');assert.deepEqual(after.ledger,record.ledger);assert.deepEqual(after.ordinaryLedger,record.ordinaryLedger);assert.deepEqual(after.quotes,record.quotes);assert.equal(after.session,null);
});
test('Hyperstack missing or malformed original view blocks Start without inventing history',()=>{
 const store=new Store();for(const raw of [undefined,'not JSON',JSON.stringify({...DUMMY,capUSD:1})]){
  const f=hyperstackControllerFactory({env:{HOSTING_PROVIDER:'hyperstack',START_ENABLED:'true',ORIGINAL_ACCEPTANCE_JSON:raw},storage:store});assert.equal(f.enabled,false);assert.equal(f.originalAcceptance,null);assert.equal(f.readiness.originalAcceptanceConfigured,false);assert(f.readiness.blockers.includes('HYPERSTACK_ORIGINAL_ACCEPTANCE_UNCONFIGURED'));
 }
 const f=hyperstackControllerFactory({env:{HOSTING_PROVIDER:'hyperstack',ORIGINAL_ACCEPTANCE_JSON:JSON.stringify(DUMMY)},storage:store});assert.deepEqual(f.originalAcceptance,DUMMY);assert.equal(f.readiness.originalAcceptanceConfigured,true);assert(!f.readiness.blockers.includes('HYPERSTACK_ORIGINAL_ACCEPTANCE_UNCONFIGURED'));assert.equal(store.rows.size,0);
});
