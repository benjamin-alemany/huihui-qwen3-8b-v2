import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SCALE} from './session-policy.mjs';
import {parseTestCampaign,reconcileCampaign,campaignBinding,campaignQuoteReady,campaignStart,campaignBeforeCreate,campaignPostReady,campaignObserve,campaignFinish,campaignView} from './campaign.mjs';
const NOW=Date.parse('2026-01-01T00:00:00Z'),ID='00000000-0000-4000-8000-000000000001';
const policy=(patch={})=>parseTestCampaign(JSON.stringify({version:1,id:ID,validFrom:NOW,expiresAt:NOW+86400000,maxStarts:20,maxPosts:5,maxAllocations:3,capUSD:5,...patch}));
const target=(a100=false)=>({region:'CANADA-1',flavorName:a100?'n3-A100x1':'n3-RTX-A6000x1',maximumHourlyUSD:a100?1.36:.507});
const record=()=>({ledger:{cap:5*SCALE,spent:123,held:0,usedApprovals:['DUMMY_OLD_APPROVAL']},ordinaryLedger:{cap:0,spent:0,held:0}});
function session(n,p,a100=false){return {id:'dummy-session-'+n,quoteId:'dummy-quote-'+n,approval:'DUMMY_CHILD_'+n,budgetKind:'test',phase:'preflight',stopRequested:false,createAttempted:false,quote:{provider:'hyperstack',gpu:a100?'A100-80G-PCIe':'RTX-A6000',minutes:30,totalHourlyUSD:a100?1.356:.506,maximumUSD:a100 ? .8 : .3,campaignBinding:campaignBinding(p)}};}
function begin(r,p,n,a100=false){r.campaignReconciliation=reconcileCampaign(r,p,true);const s=session(n,p,a100);campaignStart(r,s,{policy:p,required:true,target:target(a100),now:NOW});r.session=s;return s;}
function claim(r,p,s,a100=false){campaignBeforeCreate(r,s,{policy:p,required:true,target:target(a100),now:NOW});s.createAttempted=true;s.phase='reconciling';}
function reject(r,s){s.definiteNoCreate=true;campaignFinish(r,s,'failed');s.phase='failed';}
test('trusted campaign parsing bounds time, counters and fields without exposing arbitrary values',()=>{
 const p=policy();assert.equal(parseTestCampaign(undefined),null);assert.equal(p.maxStarts,20);
 for(const patch of [{id:'DUMMY_SECRET'},{expiresAt:NOW+86400001},{maxPosts:6},{maxAllocations:4},{maxStarts:21},{capUSD:6},{endpoint:'https://attacker.invalid'}])assert.throws(()=>policy(patch),/CAMPAIGN_INVALID/);
});
test('same parent persists across child IDs and both profiles; rejected posts still count to five',()=>{
 let r=record();const p=policy(),before=structuredClone(r.ledger);
 for(let n=0;n<5;n++){const s=begin(r,p,n,n%2===1);claim(r,p,s,n%2===1);reject(r,s);r=structuredClone(r);assert.equal(campaignView(r,p,true,NOW).postsUsed,n+1);assert.equal(r.testCampaigns[ID].candidates,0);}
 assert.throws(()=>begin(r,p,6),/CAMPAIGN_POST_LIMIT/);assert.equal(r.testCampaigns[ID].startsUsed,5);assert.deepEqual(r.ledger,before);
});
test('observed allocation IDs count once and never refund after verified teardown or a later no-create claim',()=>{
 const r=record(),p=policy();
 for(let n=1;n<=3;n++){const s=begin(r,p,n);claim(r,p,s);campaignObserve(r,s,[{id:String(n)}]);campaignObserve(r,s,[{id:String(n)}]);s.knownPodIds=[String(n)];campaignFinish(r,s,'stopped');s.phase='stopped';assert.equal(r.testCampaigns[ID].allocationsUsed,n);}
 assert.throws(()=>begin(r,p,4),/CAMPAIGN_ALLOCATION_LIMIT/);assert.equal(r.testCampaigns[ID].allocationsUsed,3);
 const r2=record(),s=begin(r2,p,1);claim(r2,p,s);campaignObserve(r2,s,[{id:'88'}]);s.definiteNoCreate=true;assert.throws(()=>campaignFinish(r2,s,'failed'),/CAMPAIGN_OUTCOME_UNCONFIRMED/);assert.equal(r2.testCampaigns[ID].allocationsUsed,1);
});
test('unknown outcome retains candidate across handles and even a new parent cannot bypass it',()=>{
 const p=policy(),r=record(),s=begin(r,p,1);claim(r,p,s);assert.throws(()=>campaignFinish(r,s,'failed'),/CAMPAIGN_OUTCOME_UNCONFIRMED/);
 const restored=structuredClone(r);assert.equal(campaignView(restored,p,true,NOW).candidates,1);assert.throws(()=>begin(restored,p,2),/CAMPAIGN_UNRESOLVED_ATTEMPT/);
 const other=policy({id:'00000000-0000-4000-8000-000000000002'});assert.throws(()=>begin(restored,other,3),/CAMPAIGN_UNRESOLVED_ATTEMPT/);assert.equal(restored.testCampaigns[ID].candidates,1);
});
test('twenty free preflights remain counted and policy/expiry cannot be reset for an existing ID',()=>{
 const r=record(),p=policy();for(let n=0;n<20;n++){const s=begin(r,p,n);campaignFinish(r,s,'failed');s.phase='failed';}
 assert.throws(()=>begin(r,p,21),/CAMPAIGN_START_LIMIT/);assert.equal(r.testCampaigns[ID].postsUsed,0);
 for(const changed of [policy({expiresAt:p.expiresAt-1}),policy({maxPosts:4})])assert.equal(reconcileCampaign(r,changed,true).code,'CAMPAIGN_CHANGED');assert.equal(r.testCampaigns[ID].policy.expiresAt,p.expiresAt);assert.equal(r.testCampaigns[ID].startsUsed,20);
});
test('expiry is checked before Start and again at the durable create barrier; cleanup remains possible',()=>{
 const r=record(),p=policy({expiresAt:NOW+1000});r.campaignReconciliation=reconcileCampaign(r,p,true);const s=session(1,p);
 assert.throws(()=>campaignStart(r,s,{policy:p,required:true,target:target(),now:NOW-1}),/CAMPAIGN_NOT_STARTED/);assert.throws(()=>campaignStart(r,s,{policy:p,required:true,target:target(),now:NOW+1000}),/CAMPAIGN_EXPIRED/);
 campaignStart(r,s,{policy:p,required:true,target:target(),now:NOW});r.session=s;assert.throws(()=>campaignBeforeCreate(r,s,{policy:p,required:true,target:target(),now:NOW+1000}),/CAMPAIGN_EXPIRED/);campaignFinish(r,s,'failed');assert.equal(r.testCampaigns[ID].postsUsed,0);
});
test('post-bootstrap gate refuses expiry, Stop, parent/session changes and does not claim another POST',()=>{
 const r=record(),p=policy({expiresAt:NOW+1000}),s=begin(r,p,1);claim(r,p,s);const options={policy:p,required:true,target:target(),now:NOW,childApprovalId:s.approval};assert.deepEqual(campaignPostReady(r,s,options),{expiresAt:p.expiresAt});assert.equal(r.testCampaigns[ID].postsUsed,1);
 assert.throws(()=>campaignPostReady(r,s,{...options,now:p.expiresAt}),/CAMPAIGN_EXPIRED/);s.stopRequested=true;assert.throws(()=>campaignPostReady(r,s,options),/CAMPAIGN_ATTEMPT_MISMATCH/);s.stopRequested=false;
 assert.throws(()=>campaignPostReady({...r,session:{...s,id:'other'}},s,options),/CAMPAIGN_CHANGED/);assert.throws(()=>campaignPostReady(r,s,{...options,policy:policy({id:'00000000-0000-4000-8000-000000000002'})}),/CAMPAIGN_STATE_INVALID/);assert.equal(r.testCampaigns[ID].postsUsed,1);
});
test('profile caps and owner status projection cannot disclose child approvals, IDs or arbitrary secrets',()=>{
 const r=record(),p=policy(),s=session(1,p);r.campaignReconciliation=reconcileCampaign(r,p,true);s.quote.maximumUSD=.36;assert.throws(()=>campaignStart(r,s,{policy:p,required:true,target:target(),now:NOW}),/CAMPAIGN_PROFILE_MISMATCH/);
 const valid=begin(r,p,2);valid.approval='DUMMY_PRIVATE_SECRET';assert(!JSON.stringify(campaignView(r,p,true,NOW)).includes('DUMMY_PRIVATE_SECRET'));assert(!JSON.stringify(campaignView(r,p,true,NOW)).includes('dummy-session'));
 assert.equal(campaignView(record(),null,true,NOW).code,'CAMPAIGN_REQUIRED');
});
const BASELINE=19638881734,ADDITIONAL=17000000000,NEW_ID='00000000-0000-4000-8000-000000000002';
const boundedPolicy=(patch={})=>policy({id:NEW_ID,maxStarts:10,maxPosts:3,maxAllocations:2,spentBaselineUnits:BASELINE,maximumAdditionalSpendUnits:ADDITIONAL,...patch});
const boundedRecord=()=>{const r=record();r.ledger.spent=BASELINE;return r;};
function boundedSession(n,p,holdUnits=8500000000){const s=session(n,p,true);s.quote.holdUnits=holdUnits;s.quote.maximumUSD=holdUnits/SCALE;return s;}
function startBounded(r,p,n,holdUnits=8500000000){
 r.campaignReconciliation=reconcileCampaign(r,p,true);const s=boundedSession(n,p,holdUnits);campaignStart(r,s,{policy:p,required:true,target:target(true),now:NOW});r.ledger.held+=holdUnits;r.session=s;return s;
}
test('optional incremental spend policy is paired, integer-bounded and leaves old canonical policies unchanged',()=>{
 const p=boundedPolicy();assert.equal(p.spentBaselineUnits,BASELINE);assert.equal(p.maximumAdditionalSpendUnits,ADDITIONAL);
 const legacy=policy();assert(!Object.hasOwn(legacy,'spentBaselineUnits'));assert.equal(campaignBinding(legacy),JSON.stringify({version:1,id:ID,validFrom:NOW,expiresAt:NOW+86400000,maxStarts:20,maxPosts:5,maxAllocations:3,capUSD:5}));
 for(const patch of [{spentBaselineUnits:undefined},{maximumAdditionalSpendUnits:undefined},{spentBaselineUnits:-1},{spentBaselineUnits:1.1},{maximumAdditionalSpendUnits:0},{maximumAdditionalSpendUnits:-1},{maximumAdditionalSpendUnits:1.1},{maximumAdditionalSpendUnits:Number.MAX_SAFE_INTEGER},{spentBaselineUnits:4*SCALE,maximumAdditionalSpendUnits:2*SCALE},{spentBaselineUnits:'19638881734'}])assert.throws(()=>boundedPolicy(patch),/CAMPAIGN_INVALID/);
 assert.equal(boundedPolicy({spentBaselineUnits:0,maximumAdditionalSpendUnits:5*SCALE}).maximumAdditionalSpendUnits,5*SCALE);
});
test('new grant keeps historical records and baseline immutable across eviction and policy redeployment',()=>{
 let r=boundedRecord();const old=policy();r.campaignReconciliation=reconcileCampaign(r,old,true);const oldState=structuredClone(r.testCampaigns[ID]),ledger=structuredClone(r.ledger),p=boundedPolicy();
 r.campaignReconciliation=reconcileCampaign(r,p,true);assert.deepEqual(r.testCampaigns[ID],oldState);assert.deepEqual(r.ledger,ledger);
 const s=startBounded(r,p,1);claim(r,p,s,true);campaignObserve(r,s,[{id:'99'}]);s.knownPodIds=['99'];campaignFinish(r,s,'stopped');s.phase='stopped';r.ledger.held=0;r.ledger.spent+=8500000000;
 r=structuredClone(r);assert.equal(reconcileCampaign(r,p,true).ready,true);assert.equal(r.testCampaigns[NEW_ID].policy.spentBaselineUnits,BASELINE);assert.equal(r.testCampaigns[NEW_ID].allocationsUsed,1);assert.deepEqual(r.testCampaigns[ID],oldState);
 for(const changed of [boundedPolicy({spentBaselineUnits:BASELINE+1}),boundedPolicy({maximumAdditionalSpendUnits:ADDITIONAL+1})])assert.equal(reconcileCampaign(r,changed,true).code,'CAMPAIGN_CHANGED');
 const view=campaignView(r,p,true,NOW);assert.equal(view.additionalSpentUpperUSD,.85);assert.equal(view.additionalReservedUSD,0);assert.equal(view.additionalRemainingUSD,.85);assert.equal(view.spentBaselineUSD,BASELINE/SCALE);assert.equal(view.maximumAdditionalSpendUSD,1.7);
});
test('Quote and Start count a prospective hold once; durable create and POST count that existing hold once',()=>{
 const r=boundedRecord(),p=boundedPolicy(),q=boundedSession(1,p).quote;
 r.campaignReconciliation=reconcileCampaign(r,p,true);const before=structuredClone(r.ledger);
 campaignQuoteReady(r,{policy:p,required:true,target:target(true),quote:q,now:NOW});assert.deepEqual(r.ledger,before);assert.equal(r.testCampaigns[NEW_ID].startsUsed,0);
 const first=startBounded(r,p,1);claim(r,p,first,true);assert.deepEqual(campaignPostReady(r,first,{policy:p,required:true,target:target(true),now:NOW,childApprovalId:first.approval}),{expiresAt:p.expiresAt});
 campaignObserve(r,first,[{id:'101'}]);first.knownPodIds=['101'];campaignFinish(r,first,'stopped');first.phase='stopped';r.ledger.held=0;r.ledger.spent+=8500000000;
 campaignQuoteReady(r,{policy:p,required:true,target:target(true),quote:boundedSession(2,p).quote,now:NOW});
 const second=startBounded(r,p,2);assert.equal(r.ledger.spent+r.ledger.held,BASELINE+ADDITIONAL);claim(r,p,second,true);assert.deepEqual(campaignPostReady(r,second,{policy:p,required:true,target:target(true),now:NOW,childApprovalId:second.approval}),{expiresAt:p.expiresAt});
 assert.equal(r.testCampaigns[NEW_ID].postsUsed,2);assert.equal(campaignView(r,p,true,NOW).additionalRemainingUSD,0);
});
test('new allowance includes actual spend overrun and every existing hold, independently of five-dollar headroom',()=>{
 const p=boundedPolicy();
 for(const held of [0,1000000000]){
  const r=boundedRecord();r.ledger.spent=BASELINE+9000000000;r.ledger.held=held;r.campaignReconciliation=reconcileCampaign(r,p,true);const s=boundedSession(1,p);
  assert(r.ledger.cap-r.ledger.spent-r.ledger.held>s.quote.holdUnits);
  assert.throws(()=>campaignQuoteReady(r,{policy:p,required:true,target:target(true),quote:s.quote,now:NOW}),/CAMPAIGN_SPEND_LIMIT/);
  assert.throws(()=>campaignStart(r,s,{policy:p,required:true,target:target(true),now:NOW}),/CAMPAIGN_SPEND_LIMIT/);assert.equal(r.testCampaigns[NEW_ID].startsUsed,0);
 }
 const r=boundedRecord();r.ledger.spent=BASELINE-1;r.campaignReconciliation=reconcileCampaign(r,p,true);assert.equal(campaignView(r,p,true,NOW).code,'CAMPAIGN_SPEND_BASELINE_MISMATCH');assert.equal(r.ledger.spent,BASELINE-1);
});
test('pre-create and post-bootstrap barriers recheck the spend ceiling and reject missing or inconsistent holds',()=>{
 const p=boundedPolicy();
 const r=boundedRecord(),s=startBounded(r,p,1,8000000000);r.ledger.spent=BASELINE+9000000001;assert.throws(()=>claim(r,p,s,true),/CAMPAIGN_SPEND_LIMIT/);assert.equal(r.testCampaigns[NEW_ID].postsUsed,0);
 const r2=boundedRecord(),s2=startBounded(r2,p,1,8000000000);claim(r2,p,s2,true);r2.ledger.spent=BASELINE+9000000001;
 const options={policy:p,required:true,target:target(true),now:NOW,childApprovalId:s2.approval};assert.throws(()=>campaignPostReady(r2,s2,options),/CAMPAIGN_SPEND_LIMIT/);assert.equal(r2.testCampaigns[NEW_ID].postsUsed,1);
 r2.ledger.spent=BASELINE;r2.ledger.held=7999999999;assert.throws(()=>campaignPostReady(r2,s2,options),/CAMPAIGN_BUDGET_MISMATCH/);
 const r3=boundedRecord(),s3=boundedSession(1,p);r3.campaignReconciliation=reconcileCampaign(r3,p,true);s3.quote.holdUnits--;assert.throws(()=>campaignStart(r3,s3,{policy:p,required:true,target:target(true),now:NOW}),/CAMPAIGN_BUDGET_MISMATCH/);
});
test('spend exhaustion blocks new work but never prevents expired-campaign teardown or refunds observed allocation slots',()=>{
 const r=boundedRecord(),p=boundedPolicy(),s=startBounded(r,p,1);claim(r,p,s,true);campaignObserve(r,s,[{id:'102'}]);s.knownPodIds=['102'];r.ledger.spent=BASELINE+ADDITIONAL;
 assert.equal(campaignView(r,p,true,NOW).code,'CAMPAIGN_SPEND_LIMIT');assert.throws(()=>campaignPostReady(r,s,{policy:p,required:true,target:target(true),now:NOW,childApprovalId:s.approval}),/CAMPAIGN_SPEND_LIMIT/);
 // The existing cleanup entry point deliberately has no current-policy spend
 // or time gate: even an overrun must be recorded and torn down promptly.
 campaignFinish(r,s,'stopped');s.phase='stopped';r.ledger.held=0;
 assert.equal(r.testCampaigns[NEW_ID].allocationsUsed,1);assert.equal(r.testCampaigns[NEW_ID].attempts[0].closed,true);assert.equal(r.testCampaigns[NEW_ID].policy.spentBaselineUnits,BASELINE);assert.equal(campaignView(r,p,true,p.expiresAt).code,'CAMPAIGN_EXPIRED');
});
