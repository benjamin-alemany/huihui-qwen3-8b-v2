export const MODEL="huihui-qwen3-8b-v2";
export const LIMITS=Object.freeze({requestBytes:16384,responseBytes:65536,characters:6000,messages:25,turns:64,maxTokens:512,timeoutMs:90000});
export class Rejection extends Error {constructor(message,status=400){super(message);this.status=status;}}
const exact=(value,keys)=>value && typeof value==="object" && !Array.isArray(value) && Object.keys(value).sort().join()===keys.sort().join();
// Trusted deployment metadata only. Neither a browser nor the model chooses a URL,
// deadline, credential, model, template, tool definition or generation parameters.
export function sessionFrom(env,now=Date.now()) {
  if(env.CHAT_ENABLED!=="true")throw new Rejection("Chat session is not armed",503);
  let s;try{s=JSON.parse(env.CHAT_SESSION);}catch{throw new Rejection("Chat session is not armed",503);}
  if(!exact(s,["podId","createdAt","nonce","minutes"]) || !/^[a-z0-9]{10,32}$/.test(s.podId) ||
    !/^[a-f0-9]{32}$/.test(s.nonce) || !/^\d{4}-\d\d-\d\dT.*Z$/.test(s.createdAt) ||
    !Number.isInteger(s.minutes) || s.minutes<5 || s.minutes>30)
    throw new Rejection("Invalid session binding",503);
  const created=Date.parse(s.createdAt),deadline=created+s.minutes*60000;
  if(!Number.isFinite(created)||created>now||now>=deadline)throw new Rejection("Session has not started or has expired",409);
  if(!/^[A-Za-z0-9_-]{43,128}$/.test(env.INFERENCE_API_KEY??""))throw new Rejection("Inference authentication is not configured",503);
  return {...s,deadline,url:`https://${s.podId}-8000.proxy.runpod.net/v1/chat/completions`};
}
export function completionFrom(input) {
  if(!exact(input,["messages"])||!Array.isArray(input.messages)||input.messages.length<1||input.messages.length>LIMITS.messages)
    throw new Rejection("Send a bounded text conversation");
  let total=0;
  const messages=input.messages.map((m,i)=>{
    if(!exact(m,["role","content"])||m.role!==(i%2===0?"user":"assistant")||typeof m.content!=="string"||!m.content.trim())
      throw new Rejection("Only alternating user and assistant text is accepted");
    total+=m.content.length;
    if(total>LIMITS.characters)throw new Rejection("Conversation is full; start a new chat",413);
    return {role:m.role,content:m.content};
  });
  if(messages.at(-1).role!=="user")throw new Rejection("A user message is required");
  return {model:MODEL,messages,stream:false,max_tokens:LIMITS.maxTokens,temperature:0.6,
    chat_template_kwargs:{enable_thinking:false}};
}
export async function boundedJSON(body,limit) {
  if(!body)throw new Rejection("Missing body");
  const reader=body.getReader(),decoder=new TextDecoder("utf-8",{fatal:true});let size=0,text="";
  try {
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
      if(size>limit){await reader.cancel();throw new Rejection("Payload too large",413);}
      text+=decoder.decode(value,{stream:true});}
    text+=decoder.decode();
    try{return JSON.parse(text);}catch{throw new Rejection("Invalid JSON");}
  } finally {reader.releaseLock();}
}
export async function infer(input,env,fetchImpl=fetch,now=Date.now) {
  const s=sessionFrom(env,now()),body=completionFrom(input);
  const signal=AbortSignal.timeout(Math.max(1,Math.min(LIMITS.timeoutMs,s.deadline-now())));
  const r=await fetchImpl(s.url,{method:"POST",headers:{"Content-Type":"application/json","User-Agent":"unjailed-private-chat/1.0",Authorization:`Bearer ${env.INFERENCE_API_KEY}`},
    body:JSON.stringify(body),redirect:"manual",signal});
  if(!r.ok){await r.body?.cancel();throw new Rejection("Inference unavailable or conversation exceeds the model context; retry manually or start a new chat",502);}
  const result=await boundedJSON(r.body,LIMITS.responseBytes);
  const choice=result.choices?.[0],message=choice?.message;
  if(result.model!==MODEL||result.choices?.length!==1||!message||message.role!=="assistant"||
    typeof message.content!=="string"||message.tool_calls?.length||message.function_call||choice.finish_reason==="tool_calls")
    throw new Rejection("Unexpected model response; no actions were executed",502);
  if(now()>=s.deadline)throw new Rejection("Session expired",409);
  // Never forward headers, tools, reasoning, links as HTML, upstream errors or cookies.
  return {content:message.content,finishReason:choice.finish_reason==="length"?"length":"stop"};
}
