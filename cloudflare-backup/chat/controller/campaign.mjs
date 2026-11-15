import {SessionError,SCALE} from './session-policy.mjs';
const DAY=24*60*60*1000;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PROFILES=Object.freeze([
 Object.freeze({flavor:'n3-RTX-A6000x1',gpu:'RTX-A6000',hourly:.507,total:.35}),
 Object.freeze({flavor:'n3-A100x1',gpu:'A100-80G-PCIe',hourly:1.36,total:.85})
]);
export const CAMPAIGN_ERRORS=Object.freeze(['CAMPAIGN_REQUIRED','CAMPAIGN_INVALID','CAMPAIGN_CHANGED','CAMPAIGN_STATE_INVALID','CAMPAIGN_NOT_STARTED','CAMPAIGN_EXPIRED','CAMPAIGN_START_LIMIT','CAMPAIGN_POST_LIMIT','CAMPAIGN_ALLOCATION_LIMIT','CAMPAIGN_UNRESOLVED_ATTEMPT','CAMPAIGN_PROFILE_MISMATCH','CAMPAIGN_ATTEMPT_MISMATCH','CAMPAIGN_BUDGET_MISMATCH','CAMPAIGN_OUTCOME_UNCONFIRMED']);
const refuse=code=>{throw new SessionError(code,409);};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function policyFrom(p){
 if(!p||Array.isArray(p)||Object.keys(p).sort().join()!=='capUSD,expiresAt,id,maxAllocations,maxPosts,maxStarts,validFrom,version'||p.version!==1||!UUID.test(p.id??'')||!Number.isSafeInteger(p.validFrom)||p.validFrom<0||!Number.isSafeInteger(p.expiresAt)||p.expiresAt<=p.validFrom||p.expiresAt-p.validFrom>DAY||!Number.isInteger(p.maxStarts)||p.maxStarts<1||p.maxStarts>20||!Number.isInteger(p.maxPosts)||p.maxPosts<1||p.maxPosts>5||!Number.isInteger(p.maxAllocations)||p.maxAllocations<1||p.maxAllocations>3||p.capUSD!==5)refuse('CAMPAIGN_INVALID');
 return {version:1,id:p.id,validFrom:p.validFrom,expiresAt:p.expiresAt,maxStarts:p.maxStarts,maxPosts:p.maxPosts,maxAllocations:p.maxAllocations,capUSD:5};
}
export function parseTestCampaign(raw){
 if(raw===undefined||raw==='')return null;
 try{if(typeof raw!=='string'||raw.length>2048)throw Error();return policyFrom(JSON.parse(raw));}catch{refuse('CAMPAIGN_INVALID');}
}
export const campaignBinding=policy=>policy?JSON.stringify(policyFrom(policy)):null;
function stateChecked(state){
 if(!state||!same(policyFrom(state.policy),state.policy)||!same(state.profiles,PROFILES)||!Array.isArray(state.attempts)||state.attempts.length>state.policy.maxStarts||!Array.isArray(state.allocationIds)||state.allocationIds.some(id=>!/^hyperstack:[1-9][0-9]{0,14}$/.test(id))||new Set(state.allocationIds).size!==state.allocationIds.length||state.startsUsed!==state.attempts.length||state.postsUsed!==state.attempts.filter(a=>a.postClaimed).length||state.postsUsed>state.policy.maxPosts||state.allocationsUsed!==state.allocationIds.length||state.candidates!==state.attempts.filter(a=>a.postClaimed&&!a.closed&&!a.allocationIds.length).length)refuse('CAMPAIGN_STATE_INVALID');
 const ids=new Set();for(const a of state.attempts){if(typeof a.sessionId!=='string'||ids.has(a.sessionId)||typeof a.childApprovalId!=='string'||typeof a.quoteId!=='string'||typeof a.postClaimed!=='boolean'||typeof a.closed!=='boolean'||!Array.isArray(a.allocationIds)||a.allocationIds.some(id=>!state.allocationIds.includes(id)))refuse('CAMPAIGN_STATE_INVALID');ids.add(a.sessionId);}
 return state;
}
function stateFor(record,id){const state=record.testCampaigns?.[id];if(!state)refuse('CAMPAIGN_STATE_INVALID');return stateChecked(state);}
function recount(state){state.startsUsed=state.attempts.length;state.postsUsed=state.attempts.filter(a=>a.postClaimed).length;state.allocationsUsed=state.allocationIds.length;state.candidates=state.attempts.filter(a=>a.postClaimed&&!a.closed&&!a.allocationIds.length).length;}
// Pure, transaction-local registration. No configuration can rewrite an old ID.
export function reconcileCampaign(record,policy,required=false){
 try{
  if(!policy){if(required)refuse('CAMPAIGN_REQUIRED');return {ready:true,configured:false};}
  const p=policyFrom(policy);record.testCampaigns??={};const prior=record.testCampaigns[p.id];
  if(prior){stateChecked(prior);if(!same(prior.policy,p))refuse('CAMPAIGN_CHANGED');}
  else record.testCampaigns[p.id]={policy:p,profiles:structuredClone(PROFILES),startsUsed:0,postsUsed:0,allocationsUsed:0,candidates:0,allocationIds:[],attempts:[]};
  return {ready:true,configured:true,id:p.id};
 }catch(e){return {ready:false,configured:!!policy,code:CAMPAIGN_ERRORS.includes(e?.code)?e.code:'CAMPAIGN_INVALID'};}
}
function temporal(policy,now){if(!Number.isSafeInteger(now))refuse('CAMPAIGN_INVALID');if(now<policy.validFrom)refuse('CAMPAIGN_NOT_STARTED');if(now>=policy.expiresAt)refuse('CAMPAIGN_EXPIRED');}
function gate(record,policy,required,now,{start=false}={}){
 const readiness=reconcileCampaign(record,policy,required);if(!readiness.ready)refuse(readiness.code);if(!policy)return null;
 const p=policyFrom(policy),state=stateFor(record,p.id);temporal(p,now);
 if(!Number.isSafeInteger(record.ledger?.cap)||record.ledger.cap>p.capUSD*SCALE)refuse('CAMPAIGN_BUDGET_MISMATCH');
 if(start&&state.startsUsed>=p.maxStarts)refuse('CAMPAIGN_START_LIMIT');
 if(state.postsUsed>=p.maxPosts)refuse('CAMPAIGN_POST_LIMIT');
 if(state.allocationsUsed+state.candidates>=p.maxAllocations)refuse('CAMPAIGN_ALLOCATION_LIMIT');
 for(const other of Object.values(record.testCampaigns??{})){stateChecked(other);if(other.attempts.some(a=>a.postClaimed&&!a.closed))refuse('CAMPAIGN_UNRESOLVED_ATTEMPT');}
 return state;
}
function profileChecked(session,target){
 const p=PROFILES.find(p=>p.flavor===target?.flavorName),q=session.quote;
 if(!p||target.region!=='CANADA-1'||target.maximumHourlyUSD>p.hourly||q?.provider!=='hyperstack'||q.gpu!==p.gpu||q.minutes!==30||!Number.isFinite(q.totalHourlyUSD)||q.totalHourlyUSD<=0||q.totalHourlyUSD>p.hourly||!Number.isFinite(q.maximumUSD)||q.maximumUSD<=0||q.maximumUSD>p.total)refuse('CAMPAIGN_PROFILE_MISMATCH');return p;
}
export function campaignStart(record,session,{policy,required=false,target,now}){
 const state=gate(record,policy,required,now,{start:true});if(!state)return;
 if(session.budgetKind!=='test'||session.quote.campaignBinding!==campaignBinding(policy))refuse('CAMPAIGN_CHANGED');
 const profile=profileChecked(session,target);session.campaignId=state.policy.id;
 state.attempts.push({sessionId:session.id,childApprovalId:session.approval,quoteId:session.quoteId,profile:profile.flavor,startedAt:now,postClaimed:false,closed:false,allocationIds:[]});recount(state);
}
function attemptFor(state,session){const a=state.attempts.find(a=>a.sessionId===session.id);if(!a||a.childApprovalId!==session.approval||a.quoteId!==session.quoteId)refuse('CAMPAIGN_ATTEMPT_MISMATCH');return a;}
export function campaignBeforeCreate(record,session,{policy,required=false,target,now}){
 const state=gate(record,policy,required,now);if(!state){if(session.campaignId)refuse('CAMPAIGN_CHANGED');return;}
 if(session.campaignId!==state.policy.id||session.quote.campaignBinding!==campaignBinding(policy))refuse('CAMPAIGN_CHANGED');
 const profile=profileChecked(session,target),attempt=attemptFor(state,session);
 if(attempt.closed||attempt.postClaimed||attempt.profile!==profile.flavor)refuse('CAMPAIGN_ATTEMPT_MISMATCH');
 attempt.postClaimed=true;attempt.postClaimedAt=now;recount(state);
}
// Read-only second gate inside the provider client, AFTER asynchronous bootstrap
// rendering and immediately before its sole HTTP POST. Never claims a second slot.
export function campaignPostReady(record,session,{policy,required=false,target,now,childApprovalId}){
 if(!policy){if(required||session?.campaignId)refuse('CAMPAIGN_REQUIRED');return null;}
 const p=policyFrom(policy),state=stateFor(record,p.id);if(!same(state.policy,p)||session?.campaignId!==p.id||record.session?.id!==session.id||record.campaignReconciliation?.id!==p.id)refuse('CAMPAIGN_CHANGED');
 temporal(p,now);profileChecked(session,target);const attempt=attemptFor(state,session);
 if(session.approval!==childApprovalId||session.createAttempted!==true||session.stopRequested!==false||session.phase!=='reconciling'||!attempt.postClaimed||attempt.closed||state.postsUsed>p.maxPosts||state.allocationsUsed+state.candidates>p.maxAllocations)refuse('CAMPAIGN_ATTEMPT_MISMATCH');
 for(const other of Object.values(record.testCampaigns??{})){stateChecked(other);if(other.attempts.some(a=>a.postClaimed&&!a.closed&&a.sessionId!==session.id))refuse('CAMPAIGN_UNRESOLVED_ATTEMPT');}
 return {expiresAt:p.expiresAt};
}
export function campaignObserve(record,session,pods){
 if(!session.campaignId)return;const state=stateFor(record,session.campaignId),attempt=attemptFor(state,session);
 if(!attempt.postClaimed||attempt.closed)refuse('CAMPAIGN_ATTEMPT_MISMATCH');
 for(const p of pods){if(!/^[1-9][0-9]{0,14}$/.test(p.id??''))refuse('CAMPAIGN_STATE_INVALID');const id='hyperstack:'+p.id;if(!state.allocationIds.includes(id))state.allocationIds.push(id);if(!attempt.allocationIds.includes(id))attempt.allocationIds.push(id);}
 recount(state);
}
// Called only inside the existing finish transaction AFTER independent guard
// clearance and verified teardown/no-create. Observed allocation slots NEVER refund.
export function campaignFinish(record,session,phase){
 if(!session.campaignId)return;const state=stateFor(record,session.campaignId),attempt=attemptFor(state,session);
 if(attempt.closed)return;
 const ids=[...new Set([...(session.knownPodIds??[]),...(session.knownAllocations??[]).map(p=>p.id),...(session.pod?[session.pod.id]:[])])];
 if(ids.length)campaignObserve(record,session,ids.map(id=>({id})));
 if(attempt.postClaimed){
  if(session.definiteNoCreate===true){if(attempt.allocationIds.length)refuse('CAMPAIGN_OUTCOME_UNCONFIRMED');attempt.noCreateConfirmed=true;}
  else if(phase!=='stopped'||!attempt.allocationIds.length)refuse('CAMPAIGN_OUTCOME_UNCONFIRMED');
 }else if(session.createAttempted)refuse('CAMPAIGN_ATTEMPT_MISMATCH');
 attempt.closed=true;recount(state);
}
export function campaignView(record,policy,required,now){
 if(!policy&&!required)return null;
 let state,p,code=null;try{if(!policy)refuse('CAMPAIGN_REQUIRED');p=policyFrom(policy);state=stateFor(record,p.id);gate(record,policy,required,now,{start:true});}catch(e){code=CAMPAIGN_ERRORS.includes(e?.code)?e.code:'CAMPAIGN_INVALID';}
 return {ready:code===null,code,id:p?.id??null,validFrom:p?new Date(p.validFrom).toISOString():null,expiresAt:p?new Date(p.expiresAt).toISOString():null,maxStarts:p?.maxStarts??null,maxPosts:p?.maxPosts??null,maxAllocations:p?.maxAllocations??null,startsUsed:state?.startsUsed??null,postsUsed:state?.postsUsed??null,allocationsUsed:state?.allocationsUsed??null,candidates:state?.candidates??null};
}
