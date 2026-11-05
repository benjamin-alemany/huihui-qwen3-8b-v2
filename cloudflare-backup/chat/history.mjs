import {Rejection} from './policy.mjs';
export const HISTORY_LIMITS=Object.freeze({conversations:20,messages:32,characters:12000,bytes:65536});
export function historyId(id){if(typeof id!=='string'||! /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))throw new Rejection('Invalid saved chat');return id;}
export function historyFrom(input){
 if(!input||Array.isArray(input)||Object.keys(input).sort().join()!=='messages,title'||typeof input.title!=='string'||input.title.length>80||!Array.isArray(input.messages)||!input.messages.length||input.messages.length>HISTORY_LIMITS.messages)throw new Rejection('Choose a short title and a bounded text conversation');
 let total=0;const messages=input.messages.map((m,i)=>{
  if(!m||Object.keys(m).sort().join()!=='content,role'||m.role!==(i%2?'assistant':'user')||typeof m.content!=='string'||!m.content.trim())throw new Rejection('Only alternating plain-text messages can be saved');
  total+=m.content.length;if(total>HISTORY_LIMITS.characters)throw new Rejection('Saved chat is too large',413);
  return {role:m.role,content:m.content};
 });
 return {title:input.title.trim()||messages[0].content.trim().slice(0,80),messages};
}
