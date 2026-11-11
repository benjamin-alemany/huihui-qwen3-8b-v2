import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseOperatorBudget,applyOperatorBudget} from './budget-reconcile.mjs';
const policy=(id='0123456789abcdef',capUnits=1000,spentFloorUnits=450)=>parseOperatorBudget(JSON.stringify({id:'operator-budget-'+id,capUnits,spentFloorUnits}));
const record=()=>({ledger:{version:1,cap:500,spent:200,held:0,usedApprovals:['already-used']},session:null,quotes:[{id:'old-quote'}]});
test('trusted parser rejects malformed unknown or unsafe values',()=>{assert.equal(parseOperatorBudget(undefined),null);for(const raw of ['{}','[]','not-json',JSON.stringify({id:'__proto__',capUnits:1000,spentFloorUnits:1}),JSON.stringify({id:'operator-budget-0123456789abcdef',capUnits:1,spentFloorUnits:2}),JSON.stringify({id:'operator-budget-0123456789abcdef',capUnits:Infinity,spentFloorUnits:0}),JSON.stringify({id:'operator-budget-0123456789abcdef',capUnits:1000,spentFloorUnits:0,reset:true})])assert.throws(()=>parseOperatorBudget(raw));});
test('monotonic reconciliation preserves approvals quotes and existing overspend',()=>{const r=record();r.ledger.spent=600;applyOperatorBudget(r,policy());assert.equal(r.ledger.cap,1000);assert.equal(r.ledger.spent,600);assert.deepEqual(r.ledger.usedApprovals,['already-used']);assert.deepEqual(r.quotes,[{id:'old-quote'}]);assert.equal(r.ledger.held,0);});
test('identical replay cannot double-debit and permits later active sessions',()=>{const r=record(),p=policy();applyOperatorBudget(r,p);r.ledger.held=20;r.session={phase:'ready',createAttempted:true};const before=structuredClone(r);applyOperatorBudget(r,p);assert.deepEqual(r,before);});
test('active holds and uncertain creations block all new migrations atomically',()=>{for(const patch of [{held:1},{session:{phase:'ready'}},{session:{phase:'failed',createAttempted:true}},{session:{phase:'cancelled',pod:{id:'unresolved'}}}]){const r=record();if('held'in patch)r.ledger.held=patch.held;else r.session=patch.session;const before=structuredClone(r);assert.throws(()=>applyOperatorBudget(r,policy()),/OPERATOR_BUDGET_ACTIVE/);assert.deepEqual(r,before);}});
test('cap cannot fall and spent floor never refunds prior accounting',()=>{const r=record(),before=structuredClone(r);assert.throws(()=>applyOperatorBudget(r,policy('0123456789abcdef',400,100)),/OPERATOR_BUDGET_WOULD_LOWER/);assert.deepEqual(r,before);applyOperatorBudget(r,policy('0123456789abcdef',1000,100));assert.equal(r.ledger.spent,200);});
test('reused id with changed parameters refuses without mutation',()=>{const r=record();applyOperatorBudget(r,policy());const before=structuredClone(r);assert.throws(()=>applyOperatorBudget(r,policy('0123456789abcdef',1100,450)),/OPERATOR_BUDGET_ID_REUSED/);assert.deepEqual(r,before);});


test('settled definite no-create can reconcile monotonically but unresolved holds cannot',()=>{
 const r=record();r.session={phase:'failed',createAttempted:true,definiteNoCreate:true};applyOperatorBudget(r,policy());assert.equal(r.ledger.cap,1000);assert.deepEqual(r.ledger.usedApprovals,['already-used']);
 for(const patch of [{ledger:{held:1}},{ordinaryLedger:{held:1}},{session:{phase:'failed',createAttempted:true,definiteNoCreate:false}}]){
  const state=record();state.session={phase:'failed',createAttempted:true,definiteNoCreate:true};for(const [key,value]of Object.entries(patch))state[key]={...state[key],...value};const before=structuredClone(state);assert.throws(()=>applyOperatorBudget(state,policy()),/OPERATOR_BUDGET_ACTIVE/);assert.deepEqual(state,before);
 }
});
