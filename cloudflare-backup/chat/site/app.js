const $=selector=>document.querySelector(selector);
let messages=[],deadline=0,ready=false,busy=false,historyReady=false,controlClosed=false;
let guardPollingUntil=0;
async function guardStatus(){
 try{
  const r=await fetch('/api/controller/status',{cache:'no-store'});if(!r.ok)throw Error();const s=await r.json(),state=s.readiness;
  const checking=['pending','checking'].includes(state?.phase);$('#check-guards').disabled=checking;
  if(checking){$('#guard-status').textContent='Checking both cloud safeguards. This continues if you close the browser. This check does not start a GPU.';guardPollingUntil=Math.max(guardPollingUntil,state.expiresAt||0);}
  else if(state?.phase==='verified')$('#guard-status').textContent='Last cloud heartbeat check passed'+(state.finishedAt?' at '+new Date(state.finishedAt).toLocaleString():'')+'. Every launch still requires fresh reservation checks. This check started no GPU.';
  else if(state?.phase==='failed')$('#guard-status').textContent='Cloud safeguard verification failed. GPU launch stays locked. You can run this free check again.';
  else $('#guard-status').textContent='Check that both cloud safeguards are running. This free check does not start a GPU.';
  if(checking&&Date.now()<guardPollingUntil)setTimeout(guardStatus,3000);
 }catch{$('#check-guards').disabled=true;$('#guard-status').textContent='Cloud safeguard verification is unavailable. GPU launch stays locked.';}
}
$('#check-guards').addEventListener('click',async()=>{
 $('#check-guards').disabled=true;
 try{const r=await fetch('/api/controller/check',{method:'POST',headers:{'Content-Type':'application/json','X-Workstation-Request':'1'},body:'{}'});if(!r.ok)throw Error();guardPollingUntil=Date.now()+180000;await guardStatus();}
 catch{$('#guard-status').textContent='Could not start the safeguard check. No GPU was started.';$('#check-guards').disabled=false;}
});
function update(){const active=ready&&!controlClosed&&Date.now()<deadline;$('#message').disabled=busy||(!active&&!historyReady);$('#send').disabled=busy||!active;
  $('#clear').disabled=busy;$('#save').disabled=busy||!historyReady||(!messages.length&&!$('#message').value.trim());$('#saved').disabled=busy||!historyReady;$('#clock').textContent=active?`${Math.ceil((deadline-Date.now())/60000)} minutes until the session deadline`:'';
  if(ready&&!active){ready=false;$('#session').textContent='Session deadline reached. Chat is closed; cloud shutdown verification is separate.';}}
function append(role,content){$('#empty')?.remove();const article=document.createElement('article'),label=document.createElement('strong'),p=document.createElement('p');
  article.dataset.role=role;label.textContent=role==='user'?'You':'Qwen';p.textContent=content;article.append(label,p);$('#messages').append(article);}
async function load(){try{const r=await fetch('/api/status',{cache:'no-store'});if(!r.ok)throw Error();const s=await r.json();
  ready=s.chatEnabled===true&&s.agentToolsEnabled===false;deadline=Date.parse(s.deadline)||0;historyReady=s.history==='private-cloud-opt-in';
  $('#session').textContent=ready?'Private chat session is armed.':'Private chat is prepared. No session is armed.';
  $('#notice').textContent=ready?'Plain-text replies. Nothing is executed.':(s.reason||'Chat stays locked until login, inference and cloud shutdown are validated.');
}catch{$('#session').textContent='Private chat preview. Owner login and the cloud gateway are not connected.';}update();}
$('#composer').addEventListener('submit',async event=>{event.preventDefault();if(busy||!ready||Date.now()>=deadline)return;
  const content=$('#message').value.trim();if(!content)return;
  const candidate=[...messages,{role:'user',content}];
  if(candidate.length>25||candidate.reduce((n,m)=>n+m.content.length,0)>6000){$('#notice').textContent='This conversation is full. Export it, then start a new chat.';return;}
  busy=true;update();$('#notice').textContent='Qwen is replying…';
  try{const r=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json','X-Workstation-Request':'1'},body:JSON.stringify({messages:candidate})});
    if(!r.ok){$('#notice').textContent=(await r.json()).error||'Reply unavailable. Retry manually.';if(r.status===401||r.status===409||r.status===503)ready=false;return;}
    const reply=await r.json();if(typeof reply.content!=='string')throw Error();
    messages=[...candidate,{role:'assistant',content:reply.content}];append('user',content);append('assistant',reply.content);$('#message').value='';
    $('#notice').textContent=reply.finishReason==='length'?'Reply reached the length limit.':'Reply complete. No actions were executed.';
  }catch{$('#notice').textContent='Connection interrupted. No automatic retry; your message is still in the composer.';}
  finally{busy=false;update();}
});
$('#clear').addEventListener('click',()=>{if(busy)return;messages=[];$('#messages').replaceChildren();$('#message').value='';$('#notice').textContent='New chat. The session deadline has not changed.';});
$('#export').addEventListener('click',()=>{if(!messages.length)return;const url=URL.createObjectURL(new Blob([messages.map(m=>`${m.role.toUpperCase()}\n${m.content}`).join('\n\n')],{type:'text/plain;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download='unjailed-chat.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
window.addEventListener('pagehide',()=>{messages=[];$('#messages').replaceChildren();$('#message').value='';});
async function historyRequest(path,body){const r=await fetch(path,body?{method:'POST',headers:{'Content-Type':'application/json','X-Workstation-Request':'1'},body:JSON.stringify(body)}:{cache:'no-store'});const data=await r.json();if(!r.ok)throw Error(data.error||'Saved chat request failed');return data;}
$('#save').addEventListener('click',async()=>{if(busy||!historyReady)return;const draft=$('#message').value.trim(),savedMessages=draft?[...messages,{role:'user',content:draft}]:messages;if(!savedMessages.length)return;busy=true;update();try{await historyRequest('/api/history/save',{title:savedMessages[0].content.slice(0,80),messages:savedMessages});$('#notice').textContent='Chat saved privately. It will remain available when the GPU is off.';}catch(e){$('#notice').textContent=e.message;}finally{busy=false;update();}});
$('#saved').addEventListener('click',async()=>{if(busy||!historyReady)return;busy=true;update();try{
 const data=await historyRequest('/api/history'),list=$('#saved-list');list.replaceChildren();$('#saved-panel').hidden=false;
 if(!data.items.length){const p=document.createElement('p');p.textContent='No chats saved yet.';list.append(p);}
 for(const item of data.items){const row=document.createElement('div'),title=document.createElement('p'),open=document.createElement('button'),remove=document.createElement('button');title.textContent=item.title;open.textContent='Open';remove.textContent='Delete';
  open.addEventListener('click',async()=>{if(busy)return;busy=true;update();try{const c=await historyRequest('/api/history/'+encodeURIComponent(item.id));if(!Array.isArray(c.messages)||c.messages.some((m,i)=>m.role!==(i%2?'assistant':'user')||typeof m.content!=='string'))throw Error('Invalid saved conversation');messages=c.messages;const draft=messages.at(-1)?.role==='user'?messages.pop().content:'';$('#message').value=draft;$('#messages').replaceChildren();for(const m of messages)append(m.role,m.content);$('#notice').textContent=draft?'Draft restored. An active GPU session is required to send it.':'Saved chat opened. The session deadline has not changed.';}catch(e){$('#notice').textContent=e.message;}finally{busy=false;update();}});
  remove.addEventListener('click',async()=>{if(busy||!window.confirm('Permanently delete this saved chat? Export it first if you need a copy.'))return;busy=true;update();try{await historyRequest('/api/history/delete',{id:item.id});row.remove();$('#notice').textContent='Saved chat deleted.';}catch(e){$('#notice').textContent=e.message;}finally{busy=false;update();}});
  row.append(title,open,remove);list.append(row);
 }
}catch(e){$('#notice').textContent=e.message;}finally{busy=false;update();}});
$('#message').addEventListener('input',update);
window.addEventListener('session-state',event=>{
 const s=event.detail;
 if(s?.phase==='ready'&&!s.stopRequested){controlClosed=false;if(!ready)load();}
 else if(s){controlClosed=true;ready=false;$('#session').textContent=s.phase==='stopped'?'Session ended; GPU cleanup verified.':'Chat is closed while the session is '+s.phase+'.';update();}
});
setInterval(update,1000);load();guardStatus();
