// Only same-origin owner-authenticated APIs. No credentials or provider URLs.
(()=>{
 const $=s=>document.querySelector(s);let state=null,quote=null,pending=false,uncertain=false,poll,feedback='',stopIntent=false;
 const money=n=>'$'+Number(n).toFixed(2),active=s=>s&&!['stopped','cancelled','failed'].includes(s.phase);
 const phases={preflight:'Checking cloud safeguards before billing starts.',arming:'Arming both independent stop guards before billing starts.',reconciling:'Confirming the launch outcome. No automatic retry.',starting:'The GPU is starting Qwen. Startup counts toward the session timer.',ready:'Your private chat is ready.',stopping:'Chat is closed. Verifying GPU shutdown and temporary disk removal…',stopped:'Session ended. GPU and temporary disk removal verified.',cancelled:'Launch cancelled before a Pod was created.',failed:'Launch refused before a Pod was created.',attention:'Launch outcome is uncertain. Start is locked; budget remains reserved. Operator reconciliation is required.'};
 function render(){
  const s=state?.session,live=active(s);$('#quote').disabled=pending||live;$('#stop-session').disabled=pending||!live;
  $('#control-status').textContent=(feedback?feedback+' ':'')+(s?(phases[s.phase]??'Checking session status…'):(state?.launchEnabled?'No session running. Review the cost to begin.':'Session controls are prepared. Paid launch is locked pending acceptance approval.'));
  if(state?.budget)$('#budget').textContent=`Chat-test allowance remaining: ${money(state.budget.remainingUSD)} · Reserved: ${money(state.budget.reservedUSD)}. Earlier acceptance spending is tracked separately.`;
  $('#start-session').disabled=pending||uncertain||live||!state?.launchEnabled||!quote?.live||!quote?.launchEnabled||quote.availability==='NONE'||Date.now()>=quote.expiresAt||!$('#accept-cost').checked;
  if(quote){$('#quote-price').textContent=`${money(quote.totalHourlyUSD)}/hour with temporary disk · ${quote.minutes}-minute timer · reserve up to ${money(quote.maximumUSD)}`;
   $('#consent-label').textContent=`I approve up to ${money(quote.maximumUSD)} for this timed session.`;
   $('#quote-detail').textContent=(quote.live?(quote.availability==='NONE'?'No Secure A40 stock is available. No automatic stock retries. ':'Stock will be rechecked immediately before launch. '):'Prepared price only; a live quote is required after approval. ')+quote.includes+'. '+quote.excludes+'. Timers provide an operational allowance, not a guaranteed provider dollar cap.';}
  window.dispatchEvent(new CustomEvent('session-state',{detail:stopIntent&&live?{phase:'stopping',stopRequested:true}:s}));
 }
 async function api(path,body){const r=await fetch(path,body===undefined?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json','X-Workstation-Request':'1'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(data.error||'Request unconfirmed');return data;}
 async function refresh(){try{state=await api('/api/controller/status');render();if(active(state.session))poll=setTimeout(refresh,4000);}catch{$('#control-status').textContent='Controller connection interrupted. A cloud session may still be running. Refresh status; do not repeat Start.';uncertain=true;$('#start-session').disabled=true;$('#stop-session').disabled=false;}}
 $('#quote').addEventListener('click',async()=>{pending=true;uncertain=false;feedback='';render();try{quote=await api('/api/session/quote',{});$('#quote-panel').hidden=false;$('#accept-cost').checked=false;}catch{feedback='A fresh quote is unavailable. No session was started.';}finally{pending=false;render();}});
 $('#accept-cost').addEventListener('change',render);
 $('#start-session').addEventListener('click',async()=>{if($('#start-session').disabled)return;pending=true;uncertain=true;stopIntent=false;feedback='';render();try{state=await api('/api/session/start',{quoteId:quote.id,maximumUSD:quote.maximumUSD});}catch{feedback='Start was refused or its response was lost. Check the status below; no automatic retry will run.';}finally{pending=false;clearTimeout(poll);await refresh();}});
 $('#stop-session').addEventListener('click',async()=>{if(pending)return;pending=true;feedback='';stopIntent=true;render();window.dispatchEvent(new CustomEvent('session-state',{detail:{phase:'stopping'}}));try{if(!state?.session?.id){await refresh();return;}state=await api('/api/session/stop',{sessionId:state.session.id});}catch{feedback='Stop could not be confirmed. Cloud timers remain armed; cleanup is not yet verified.';}finally{pending=false;clearTimeout(poll);await refresh();}});
 setInterval(()=>{if(quote&&Date.now()>=quote.expiresAt)$('#start-session').disabled=true;},1000);
 refresh();
})();
