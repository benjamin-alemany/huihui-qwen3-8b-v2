import {SESSION_MINUTES} from './release-ui.js';
export {SESSION_MINUTES} from './release-ui.js';
export const sessionActive=s=>!!s&&!['stopped','cancelled','failed'].includes(s.phase);
export function minutesFrom(value){const minutes=Number(value);if(!SESSION_MINUTES.includes(minutes))throw Error('Choose 15, 30 or 60 minutes');return minutes;}
export function grantFrom(grantId,value){const amountUSD=Number(value);if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(grantId)||!Number.isFinite(amountUSD)||amountUSD<=0||amountUSD>10||Math.abs(amountUSD-Math.round(amountUSD*100)/100)>1e-10)throw Error('Choose an allowance from $0.01 to $10.00 in whole cents');return {grantId,amountUSD};}
export const sessionBudget=state=>state?.budgetMode==='test'?state?.testBudget:(state?.ordinaryBudget??state?.budget);
export function canStart({state,quote,minutes,pending,uncertain,accepted,now=Date.now()}){const balance=sessionBudget(state)?.remainingUSD;return Number.isFinite(balance)&&Number.isFinite(quote?.maximumUSD)&&quote.maximumUSD>0&&quote.maximumUSD<=balance&& !pending&&!uncertain&&!sessionActive(state?.session)&&state?.launchEnabled===true&&quote?.live===true&&quote?.launchEnabled===true&&quote.availability!=='NONE'&&quote.minutes===minutes&&Number.isFinite(quote.expiresAt)&&now<quote.expiresAt&&accepted===true;}
