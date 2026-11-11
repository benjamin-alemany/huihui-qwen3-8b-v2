import {test} from 'node:test';import assert from 'node:assert/strict';
import {minutesFrom,grantFrom,canStart,sessionMessage,quoteExceedsAllowance} from './session-policy-ui.js';
const id='00000000-0000-4000-8000-000000000001';
test('only owner-selected bounded durations are accepted',()=>{for(const n of [15,30,60])assert.equal(minutesFrom(String(n)),n);for(const n of [0,18,61,600,NaN])assert.throws(()=>minutesFrom(n));});
test('usage grant is positive whole cents, bounded at ten dollars, and keeps its replay identifier',()=>{for(const n of [.01,.29,.3,1,10])assert.deepEqual(grantFrom(id,n),{grantId:id,amountUSD:n});for(const n of [0,-1,.001,10.01,Infinity,NaN])assert.throws(()=>grantFrom(id,n));assert.throws(()=>grantFrom('new',1));});
test('Start requires a fresh matching duration, live quote, allowance release and separate owner consent',()=>{const input={state:{launchEnabled:true,session:null,ordinaryBudget:{remainingUSD:1}},quote:{live:true,launchEnabled:true,availability:'LOW',minutes:30,expiresAt:200,maximumUSD:.3},minutes:30,pending:false,uncertain:false,accepted:true,now:100};assert.equal(canStart(input),true);for(const patch of [{minutes:15},{state:{...input.state,ordinaryBudget:{remainingUSD:.29}}},{state:{...input.state,ordinaryBudget:{remainingUSD:0}}},{pending:true},{uncertain:true},{accepted:false},{now:200},{state:{launchEnabled:false}},{state:{launchEnabled:true,session:{phase:'starting'}}},{quote:{...input.quote,availability:'NONE'}},{quote:{...input.quote,live:false}}])assert.equal(canStart({...input,...patch}),false);});


test('acceptance uses only its approved test allowance while ordinary allowance remains zero',()=>{
 const input={state:{budgetMode:'test',launchEnabled:true,session:null,ordinaryBudget:{remainingUSD:0},testBudget:{remainingUSD:.35}},quote:{live:true,launchEnabled:true,availability:'AVAILABLE',minutes:30,expiresAt:200,maximumUSD:.3},minutes:30,pending:false,uncertain:false,accepted:true,now:100};
 assert.equal(canStart(input),true);assert.equal(canStart({...input,state:{...input.state,testBudget:{remainingUSD:.2},ordinaryBudget:{remainingUSD:10}}}),false);
 assert.equal(canStart({...input,state:{...input.state,budgetMode:'ordinary'}}),false);
});
test('startup failure and normal timed expiry use plain language without claiming early cleanup or exposing diagnostics',()=>{
 const waiting=sessionMessage({phase:'stopping',code:'STARTUP_TIMEOUT',cleanupVerified:false,diagnostics:{raw:'DUMMY_SECRET'}});assert.match(waiting,/Qwen did not become ready within the startup limit/);assert.match(waiting,/still being checked/);assert(!waiting.includes('cleanup verified'));assert(!waiting.includes('STARTUP_TIMEOUT'));assert(!waiting.includes('DUMMY_SECRET'));
 assert.match(sessionMessage({phase:'stopped',code:'STARTUP_TIMEOUT',cleanupVerified:true}),/startup limit\. Temporary GPU cleanup verified\./);assert(!sessionMessage({phase:'stopped',code:'STARTUP_TIMEOUT',cleanupVerified:false}).includes('cleanup verified'));
 const expired=sessionMessage({phase:'stopped',code:'SESSION_DEADLINE_REACHED',cleanupVerified:true});assert.match(expired,/Your timed session reached its limit/);assert(!expired.includes('did not become ready'));assert(!expired.includes('SESSION_DEADLINE_REACHED'));assert.equal(sessionMessage({phase:'stopped',code:null,cleanupVerified:true}),'Session ended. Temporary GPU cleanup verified.');
});
test('an already consumed quote cannot replace the session timeout explanation with an allowance warning',()=>{
 const state={ordinaryBudget:{remainingUSD:.1},session:{quoteId:'used',phase:'stopped',code:'STARTUP_TIMEOUT',cleanupVerified:true}},quote={id:'used',maximumUSD:.3};assert.equal(quoteExceedsAllowance(state,quote),false);assert.match(sessionMessage(state.session),/did not become ready/);assert.equal(quoteExceedsAllowance(state,{...quote,id:'fresh'}),true);
});
