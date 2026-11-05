import {chatFrom,parseBackup,backupFrom,draftSnapshot,textExport,draftFingerprint,BACKUP_LIMITS} from './recovery.js';
const $=selector=>document.querySelector(selector);
let messages=[],deadline=0,ready=false,busy=false,historyReady=false,controlClosed=false;
let clean=draftFingerprint([],''),replacement=null,importing=null;
const dirty=()=>draftFingerprint(messages,$('#message').value)!==clean;
const markClean=()=>{clean=draftFingerprint(messages,$('#message').value);update();};
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
function update(){
 const active=ready&&!controlClosed&&Date.now()<deadline,text=messages.length||$('#message').value.trim();
 $('#message').disabled=busy||(!active&&!historyReady);$('#send').disabled=busy||!active;
 for(const id of ['clear','export'])$('#'+id).disabled=busy||(id==='export'&&!text);
 $('#save').disabled=busy||!historyReady||!text||!dirty();
 for(const id of ['saved','backup','restore'])$('#'+id).disabled=busy||!historyReady;
 $('#confirm-import').disabled=busy||!importing?.canImport||!importing?.importable;
 for(const id of ['discard-continue','cancel-replace'])$('#'+id).disabled=busy;$('#save-continue').disabled=busy||!historyReady;
 $('#draft-status').textContent=dirty()?'Unsaved changes. Save a snapshot or export the text before leaving.':text?'This snapshot is saved.':'Drafts stay in this tab until you save them.';
 $('#clock').textContent=active?`${Math.ceil((deadline-Date.now())/60000)} minutes until the session deadline`:'';
 if(ready&&!active){ready=false;$('#session').textContent='Session deadline reached. Chat is closed; cloud shutdown verification is separate.';}
}
function append(role,content){$('#empty')?.remove();const article=document.createElement('article'),label=document.createElement('strong'),p=document.createElement('p');article.dataset.role=role;label.textContent=role==='user'?'You':'Qwen';p.textContent=content;article.append(label,p);$('#messages').append(article);}
async function load(){try{
 const r=await fetch('/api/status',{cache:'no-store'});if(!r.ok)throw Error();const s=await r.json();
 ready=s.chatEnabled===true&&s.agentToolsEnabled===false;deadline=Date.parse(s.deadline)||0;historyReady=s.history==='private-cloud-opt-in';
 $('#session').textContent=ready?'Private chat session is armed.':'Private chat is prepared. No session is armed.';
 $('#notice').textContent=ready?'Plain-text replies. Nothing is executed.':(s.reason||'Chat stays locked until login, inference and cloud shutdown are validated.');
}catch{$('#session').textContent='Owner login or the cloud gateway is unavailable. Save or export your text before signing in again.';}update();}
async function historyRequest(path,body){const r=await fetch(path,body?{method:'POST',headers:{'Content-Type':'application/json','X-Workstation-Request':'1'},body:JSON.stringify(body)}:{cache:'no-store'});const data=await r.json();if(!r.ok)throw Error(data.error||'Saved chat request failed');return data;}
async function saveCurrent(){
 const savedMessages=draftSnapshot(messages,$('#message').value);if(!savedMessages.length||!historyReady)return false;
 busy=true;update();try{await historyRequest('/api/history/save',{title:savedMessages[0].content.slice(0,80),messages:savedMessages});markClean();$('#notice').textContent='Snapshot saved privately, including any unsent draft. It remains available with the GPU off.';return true;}
 catch(e){$('#notice').textContent=e.message;$('#unsaved-error').textContent=e.message;return false;}finally{busy=false;update();}
}
function guardReplacement(action){if(busy)return;if(!dirty()){action();return;}replacement=action;$('#unsaved-error').textContent='';$('#save-continue').disabled=!historyReady;$('#unsaved-dialog').showModal();}
function continueReplacement(){const action=replacement;replacement=null;$('#unsaved-dialog').close();action?.();}
$('#save-continue').addEventListener('click',async()=>{if(await saveCurrent())continueReplacement();});
$('#discard-continue').addEventListener('click',continueReplacement);
$('#cancel-replace').addEventListener('click',()=>{replacement=null;$('#unsaved-dialog').close();});
$('#unsaved-dialog').addEventListener('cancel',()=>{replacement=null;});
window.addEventListener('beforeunload',event=>{if(dirty()){event.preventDefault();event.returnValue='';}});
$('#composer').addEventListener('submit',async event=>{event.preventDefault();if(busy||!ready||Date.now()>=deadline)return;
 const content=$('#message').value.trim();if(!content)return;const candidate=[...messages,{role:'user',content}];
 if(candidate.length>25||candidate.reduce((n,m)=>n+m.content.length,0)>6000){$('#notice').textContent='This conversation is full. Save or export it, then start a new chat.';return;}
 busy=true;update();$('#notice').textContent='Qwen is replying…';
 try{const r=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json','X-Workstation-Request':'1'},body:JSON.stringify({messages:candidate})});
  if(!r.ok){$('#notice').textContent=(await r.json()).error||'Reply unavailable. Retry manually.';if([401,409,503].includes(r.status))ready=false;return;}
  const reply=await r.json();if(typeof reply.content!=='string')throw Error();
  messages=[...candidate,{role:'assistant',content:reply.content}];append('user',content);append('assistant',reply.content);$('#message').value='';
  $('#notice').textContent=reply.finishReason==='length'?'Reply reached the length limit.':'Reply complete. No actions were executed.';
 }catch{$('#notice').textContent='Connection interrupted. No automatic retry; your message is still in the composer.';}finally{busy=false;update();}
});
$('#clear').addEventListener('click',()=>guardReplacement(()=>{messages=[];$('#messages').replaceChildren();$('#message').value='';markClean();$('#notice').textContent='New chat. The session deadline has not changed.';}));
function download(content,type,filename){const url=URL.createObjectURL(new Blob([content],{type})),a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('#export').addEventListener('click',()=>{const text=textExport(messages,$('#message').value);if(text)download(text,'text/plain;charset=utf-8','unjailed-chat.txt');});
$('#save').addEventListener('click',()=>{if(!busy)saveCurrent();});
async function showSaved(){if(busy||!historyReady)return;busy=true;update();try{
 const data=await historyRequest('/api/history'),list=$('#saved-list');list.replaceChildren();$('#saved-panel').hidden=false;
 if(!data.items.length){const p=document.createElement('p');p.textContent='No chats saved yet.';list.append(p);}
 for(const item of data.items){const row=document.createElement('div'),title=document.createElement('p'),open=document.createElement('button'),remove=document.createElement('button');title.textContent=item.title;open.textContent='Open';remove.textContent='Delete';
  open.addEventListener('click',()=>guardReplacement(async()=>{busy=true;update();try{
   const raw=await historyRequest('/api/history/'+encodeURIComponent(item.id)),c=chatFrom({title:raw.title,messages:raw.messages});messages=c.messages;
   const draft=messages.at(-1)?.role==='user'?messages.pop().content:'';$('#message').value=draft;$('#messages').replaceChildren();for(const m of messages)append(m.role,m.content);markClean();
   $('#notice').textContent=draft?'Draft restored. An active GPU session is required to send it.':'Saved chat opened. The session deadline has not changed.';
  }catch(e){$('#notice').textContent=e.message;}finally{busy=false;update();}}));
  remove.addEventListener('click',async()=>{if(busy||!window.confirm('Permanently delete this saved snapshot? Back it up first if you need a copy.'))return;busy=true;update();try{await historyRequest('/api/history/delete',{id:item.id});row.remove();$('#notice').textContent='Saved snapshot deleted. Any open text remains in this tab.';clean=draftFingerprint([], '');}catch(e){$('#notice').textContent=e.message;}finally{busy=false;update();}});
  row.append(title,open,remove);list.append(row);
 }
}catch(e){$('#notice').textContent=e.message;}finally{busy=false;update();}}
$('#saved').addEventListener('click',showSaved);
$('#backup').addEventListener('click',async()=>{if(busy||!historyReady)return;busy=true;update();try{
 const backup=backupFrom(await historyRequest('/api/history/backup'));download(JSON.stringify(backup,null,2),'application/json','unjailed-chats-'+new Date().toISOString().slice(0,10)+'.json');$('#backup-status').textContent=`Downloaded ${backup.conversations.length} saved snapshots. Unsaved text is not included; keep the file somewhere you trust.`;
}catch(e){$('#backup-status').textContent=e.message;}finally{busy=false;update();}});
$('#restore').addEventListener('click',()=>{if(!busy)$('#backup-file').click();});
$('#backup-file').addEventListener('change',async()=>{const file=$('#backup-file').files[0];$('#backup-file').value='';if(!file||busy)return;
 importing=null;$('#import-panel').hidden=true;busy=true;update();try{
 if(file.size>BACKUP_LIMITS.bytes)throw Error('Backup exceeds 2 MiB');const backup=parseBackup(await file.text()),preview=await historyRequest('/api/history/import/preview',backup);importing={backup,...preview};
 $('#import-summary').textContent=`${preview.importable} new snapshots; ${preview.duplicates} identical snapshots skipped; ${preview.remainingSlots} slots available.`+(preview.canImport?'':' Not enough space: nothing will be imported.');
 const list=$('#import-list');list.replaceChildren();for(const c of backup.conversations){const li=document.createElement('li');li.textContent=c.title+' · '+c.messages.length+' messages';list.append(li);}$('#import-panel').hidden=false;$('#backup-status').textContent='Preview only. No chats have been imported.';
}catch(e){$('#backup-status').textContent=e.message;}finally{busy=false;update();}});
$('#confirm-import').addEventListener('click',async()=>{if(busy||!importing?.canImport||!importing?.importable)return;busy=true;update();try{
 const result=await historyRequest('/api/history/import',importing.backup);$('#backup-status').textContent=`Imported ${result.imported} snapshots; skipped ${result.duplicates} identical snapshots. Your open chat and session timer have not changed.`;importing=null;$('#import-panel').hidden=true;
}catch(e){$('#backup-status').textContent=e.message+' No automatic retry.';}finally{busy=false;update();}});
$('#cancel-import').addEventListener('click',()=>{if(busy)return;importing=null;$('#import-panel').hidden=true;$('#backup-status').textContent='Import cancelled. No saved chats changed.';update();});
$('#message').addEventListener('input',update);
window.addEventListener('session-state',event=>{const s=event.detail;if(s?.phase==='ready'&&!s.stopRequested){controlClosed=false;if(!ready)load();}else if(s){controlClosed=true;ready=false;$('#session').textContent=s.phase==='stopped'?'Session ended; GPU cleanup verified.':'Chat is closed while the session is '+s.phase+'.';update();}});
setInterval(update,1000);load();guardStatus();
