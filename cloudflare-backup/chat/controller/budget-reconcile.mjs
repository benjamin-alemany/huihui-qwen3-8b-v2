import {SessionError,terminal} from './session-policy.mjs';
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const invalid=()=>{throw new SessionError('OPERATOR_BUDGET_INVALID',503);};
// Trusted deployment configuration only. Never read from owner/model request JSON.
export function parseOperatorBudget(raw){
 if(raw===undefined||raw==='')return null;
 let p;try{p=JSON.parse(raw);}catch{invalid();}
 if(!p||Array.isArray(p)||Object.keys(p).sort().join()!=='capUnits,id,spentFloorUnits'||!/^operator-budget-[a-f0-9]{16}$/.test(p.id??'')||!integer(p.capUnits)||!integer(p.spentFloorUnits)||p.capUnits===0||p.spentFloorUnits>p.capUnits)invalid();
 return Object.freeze(p);
}
export function applyOperatorBudget(record,policy){
 if(!policy)return;
 policy=parseOperatorBudget(JSON.stringify(policy));
 const l=record.ledger;
 if(!l||l.version!==1||!integer(l.cap)||!integer(l.spent)||!integer(l.held)||!Array.isArray(l.usedApprovals))invalid();
 const history=l.operatorBudgetReconciliations??[];
 if(!Array.isArray(history))invalid();
 const prior=history.find(p=>p.id===policy.id);
 if(prior){if(prior.capUnits!==policy.capUnits||prior.spentFloorUnits!==policy.spentFloorUnits)throw new SessionError('OPERATOR_BUDGET_ID_REUSED',503);return;}
 // No live/uncertain session, held funds or unresolved create can be re-seeded.
 if(l.held!==0||!terminal(record.session)||(record.session?.createAttempted&&record.session.phase!=='stopped')||(record.session?.pod&&record.session.phase!=='stopped'))throw new SessionError('OPERATOR_BUDGET_ACTIVE',409);
 const spent=Math.max(l.spent,policy.spentFloorUnits);
 if(policy.capUnits<l.cap||policy.capUnits<spent)throw new SessionError('OPERATOR_BUDGET_WOULD_LOWER',409);
 // Only monotonic cap/spend changes. Keep approvals, session, quotes and history.
 l.cap=policy.capUnits;l.spent=spent;
 l.operatorBudgetReconciliations=[...history,{...policy}];
}
