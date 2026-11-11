import {test} from 'node:test';import assert from 'node:assert/strict';
import {minutesFrom,grantFrom,canStart,sessionMessage,quoteExceedsAllowance} from './session-policy-ui.js';
import * as sessionPolicy from './session-policy-ui.js';
import {SESSION_MINUTES,DEFAULT_MINUTES} from './release-ui.js';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
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

// Execute the shipped event handler against a dummy DOM and ordered fake replies.
// No browser state, live service, network or real timers are involved.
async function sessionUi(steps){
 const elements=new Map(),calls=[],scheduled=[];
 const element=id=>{if(!elements.has(id))elements.set(id,{id,value:id==='session-minutes'?String(DEFAULT_MINUTES):'',disabled:false,hidden:true,checked:false,textContent:'',options:[],handlers:new Map(),replaceChildren(...children){this.options=children;this.value=String(children.find(c=>c.selected)?.value??children[0]?.value??'');},addEventListener(type,handler){this.handlers.set(type,handler);}});return elements.get(id);};
 const source=(await readFile(new URL('./session-ui.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
 runInNewContext(source,{...sessionPolicy,SESSION_MINUTES,DEFAULT_MINUTES,document:{querySelector:selector=>element(selector.slice(1)),createElement:()=>({})},window:{dispatchEvent(){}},CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}},sessionStorage:{getItem(){return null;}},AbortSignal:{timeout(){return {};}},fetch:async(path,options)=>{calls.push({path,body:options?.body?JSON.parse(options.body):undefined});const step=steps.shift();assert.equal(path,step?.path,'unexpected request from real UI handler');if(step.fail)throw Error('Dummy connection failure');return {ok:true,json:async()=>structuredClone(step.body)};},setInterval(){},setTimeout(fn,ms){scheduled.push({fn,ms});return scheduled.length;},clearTimeout(){}});
 await new Promise(resolve=>setImmediate(resolve));
 return {element,calls,scheduled,async click(id){await element(id).handlers.get('click')();},change(id){element(id).handlers.get('change')();}};
}
const idleState=(patch={})=>({launchEnabled:true,session:null,ordinaryBudget:{remainingUSD:1},...patch});
const liveQuote=()=>({id:'fresh',live:true,launchEnabled:true,availability:'AVAILABLE',minutes:DEFAULT_MINUTES,expiresAt:Date.now()+60000,maximumUSD:.3,totalHourlyUSD:.5});
test('Review session cost refreshes a stale launch lock before quoting and still requires fresh consent',async()=>{
 const ui=await sessionUi([{path:'/api/controller/status',body:idleState({launchEnabled:false})},{path:'/api/controller/status',body:idleState()},{path:'/api/session/quote',body:liveQuote()}]);
 assert.equal(ui.element('start-session').disabled,true);ui.element('accept-cost').checked=true;
 await ui.click('quote');assert.deepEqual(ui.calls.map(c=>c.path),['/api/controller/status','/api/controller/status','/api/session/quote']);assert.equal(ui.element('accept-cost').checked,false);assert.equal(ui.element('start-session').disabled,true);
 ui.element('accept-cost').checked=true;ui.change('accept-cost');assert.equal(ui.element('start-session').disabled,false);
});
test('Review session cost uses the fresh allowance and refuses a newly active session',async()=>{
 const budget=await sessionUi([{path:'/api/controller/status',body:idleState()},{path:'/api/controller/status',body:idleState({ordinaryBudget:{remainingUSD:0}})},{path:'/api/session/quote',body:liveQuote()}]);await budget.click('quote');budget.element('accept-cost').checked=true;budget.change('accept-cost');assert.equal(budget.element('start-session').disabled,true);
 const active=await sessionUi([{path:'/api/controller/status',body:idleState()},{path:'/api/controller/status',body:idleState({session:{id,phase:'reconciling'}})}]);await active.click('quote');assert.equal(active.calls.length,2);assert.equal(active.element('quote-panel').hidden,true);assert.equal(active.element('start-session').disabled,true);assert.equal(active.element('stop-session').disabled,false);assert(active.scheduled.some(x=>x.ms===4000));
});
test('unconfirmed status or quote leaves Start locked and sends no create request',async()=>{
 for(const failure of ['status','quote']){
  const steps=[{path:'/api/controller/status',body:idleState()}];steps.push({path:'/api/controller/status',...(failure==='status'?{fail:true}:{body:idleState()})});if(failure==='quote')steps.push({path:'/api/session/quote',fail:true});
  const ui=await sessionUi(steps);ui.element('accept-cost').checked=true;await ui.click('quote');ui.element('accept-cost').checked=true;ui.change('accept-cost');assert.equal(ui.element('start-session').disabled,true);assert.equal(ui.element('quote-panel').hidden,true);assert(ui.calls.every(c=>c.path!=='/api/session/start'));assert.match(ui.element('control-status').textContent,/No new session was requested/);
 }
});
