import {boundedJSON} from '../policy.mjs';
import {API_BASE,INFERENCE_ORIGIN,NONCE_NAME_OWNERSHIP,validateTarget,validateCatalog,normalizeVM,validateReservation,matchesReservation,assertBound,providerId,absenceReceipt,fail} from './policy.mjs';

export const FIREWALL_POLICY='tunnel-dns-egress-v1';
export const SEALED_RULES=Object.freeze([
  ...['198.41.192.0/24','198.41.200.0/24'].map(remote_ip_prefix=>Object.freeze({direction:'egress',ethertype:'IPv4',protocol:'tcp',remote_ip_prefix,port_range_min:7844,port_range_max:7844})),
  ...['udp','tcp'].flatMap(protocol=>['1.1.1.1/32','1.0.0.1/32'].map(remote_ip_prefix=>Object.freeze({direction:'egress',ethertype:'IPv4',protocol,remote_ip_prefix,port_range_min:53,port_range_max:53})))
]);
const ruleKey=r=>JSON.stringify([r.direction,r.ethertype,r.protocol,r.remote_ip_prefix,r.port_range_min,r.port_range_max]);
function securityRules(raw){
  if(!Array.isArray(raw)||raw.length>256)fail('HYPERSTACK_FIREWALL_RULES_INVALID');
  const ids=new Set(),allowed=['id','direction','ethertype','protocol','remote_ip_prefix','port_range_min','port_range_max','status','created_at'];
  return raw.map(r=>{
    if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).some(k=>!allowed.includes(k))||!['ingress','egress'].includes(r.direction)||!['IPv4','IPv6'].includes(r.ethertype)||!(r.protocol===null||typeof r.protocol==='string'&&/^[a-z0-9-]{1,24}$/.test(r.protocol))||!(r.remote_ip_prefix===null||typeof r.remote_ip_prefix==='string'&&/^[0-9a-fA-F.:/]{1,80}$/.test(r.remote_ip_prefix))||!['port_range_min','port_range_max'].every(k=>r[k]===null||Number.isSafeInteger(r[k])&&r[k]>=0&&r[k]<=65535)||typeof r.status!=='string'||!/^[A-Za-z_-]{1,32}$/.test(r.status))fail('HYPERSTACK_FIREWALL_RULES_INVALID');
    const id=providerId(r.id);if(ids.has(id))fail('HYPERSTACK_FIREWALL_RULES_INVALID');ids.add(id);
    return {id,direction:r.direction,ethertype:r.ethertype,protocol:r.protocol,remote_ip_prefix:r.remote_ip_prefix,port_range_min:r.port_range_min,port_range_max:r.port_range_max,status:r.status};
  });
}
function exactRules(rules){return rules.length===SEALED_RULES.length&&rules.every(r=>r.status==='SUCCESS')&&new Set(rules.map(ruleKey)).size===SEALED_RULES.length&&SEALED_RULES.every(wanted=>rules.some(r=>ruleKey(r)===ruleKey(wanted)));}

export class CreateError extends Error{
  constructor(code,outcome='unknown'){super(code);this.name='CreateError';this.code=code;this.outcome=outcome;}
}
// No generic request/URL passthrough is exposed. The API key never appears in
// VM user_data, normalized readbacks, errors, or inference requests.
export function hyperstackClient(key,{target,bootstrapFor,verifyHealth,fetchImpl=fetch,now=Date.now}={}){
  if(typeof key!=='string'||key.length<16||/[\r\n]/.test(key))fail('HYPERSTACK_NOT_CONFIGURED');
  const t=validateTarget(target),attempted=new Set();
  async function request(path,{method='GET',body}={}){
    let response;try{response=await fetchImpl(API_BASE+path,{method,headers:{api_key:key,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'manual',signal:AbortSignal.timeout(25_000)});}catch{fail('HYPERSTACK_REQUEST_UNCONFIRMED');}
    let data;try{data=await boundedJSON(response.body,2*1024*1024);}catch{fail('HYPERSTACK_RESPONSE_INVALID');}
    return {status:response.status,data};
  }
  async function read(path){const r=await request(path);if(r.status!==200)fail('HYPERSTACK_REQUEST_UNCONFIRMED');return r.data;}
  async function paged(path,field,beforePage){
    const all=[],seen=new Set();
    for(let page=1;page<=11;page++){
      // Guard inventory spans multiple individually bounded API requests. Its
      // trusted lease must remain current before each page, not just before the
      // whole list; a stale callback refuses before another request is sent.
      if(beforePage)await beforePage();
      const d=await read(`${path}?page=${page}&pageSize=100`);
      if(d?.status!==true||!Array.isArray(d[field])||!Number.isSafeInteger(d.count)||d.count<d[field].length||d.count>1000||d[field].length>100)fail('HYPERSTACK_INVENTORY_INVALID');
      // These calls explicitly request page/pageSize. A clamped or missing
      // pagination response cannot prove completeness, even on a short page.
      if(d.page!==page||d.page_size!==100)fail('HYPERSTACK_INVENTORY_INVALID');
      for(const row of d[field]){const k=providerId(row?.id);if(seen.has(k))fail('HYPERSTACK_INVENTORY_INVALID');seen.add(k);all.push(row);}
      if(all.length>1000)fail('HYPERSTACK_INVENTORY_LIMIT');
      // Official schema calls count the current-page count. Never interpret
      // count=100 as proof that a full first page is the complete inventory.
      if(d[field].length<100){if(d.count>all.length)fail('HYPERSTACK_INVENTORY_INCOMPLETE');return all;}
    }
    fail('HYPERSTACK_INVENTORY_LIMIT');
  }
  async function list(options){
    if(options!==undefined&&(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>k!=='beforePage')||'beforePage'in options&&typeof options.beforePage!=='function'))fail('HYPERSTACK_INVENTORY_OPTIONS_INVALID');
    return (await paged('/core/virtual-machines','instances',options?.beforePage)).map(normalizeVM);
  }
  async function get(id){
    const r=await request('/core/virtual-machines/'+providerId(id));
    if(r.status===404&&r.data?.status===false&&r.data.error_reason==='not_found')return null;
    if(r.status!==200||r.data?.status!==true||!r.data.instance)fail('HYPERSTACK_READ_UNCONFIRMED');
    const p=normalizeVM(r.data.instance);if(p.id!==providerId(id))fail('HYPERSTACK_ID_MISMATCH');return p;
  }
  // A single DELETE acknowledgement is not cleanup evidence. CREATING VMs may
  // reject deletion; later guard ticks may repeat DELETE, never CREATE/Stop.
  async function remove(id){const r=await request('/core/virtual-machines/'+providerId(id),{method:'DELETE'});return r.status===200&&r.data?.status===true;}
  async function firewallVM(bound,q){
    if(now()>=q.deadline)fail('HYPERSTACK_FIREWALL_DEADLINE_EXPIRED');
    const r=await request('/core/virtual-machines/'+providerId(bound.id));
    if(r.status!==200||r.data?.status!==true||!r.data.instance)fail('HYPERSTACK_FIREWALL_VM_UNCONFIRMED');
    const p=normalizeVM(r.data.instance);assertBound(p,bound,q);
    return {allocation:p,rules:securityRules(r.data.instance.security_rules)};
  }
  async function attachedFirewalls(id){
    const firewalls=await paged('/core/firewalls','firewalls'),attached=[];
    for(const firewall of firewalls){
      if(!Array.isArray(firewall.attachments)||firewall.attachments.length>1000)fail('HYPERSTACK_FIREWALL_ATTACHMENTS_INVALID');
      for(const a of firewall.attachments){if(!a?.vm||typeof a.vm!=='object')fail('HYPERSTACK_FIREWALL_ATTACHMENTS_INVALID');if(providerId(a.vm.id)===id)attached.push(providerId(firewall.id));}
    }
    return attached;
  }
  async function cleanup(bound,reservation){
    const q=validateReservation(reservation,t);if(!matchesReservation(bound,q))fail('HYPERSTACK_OWNERSHIP_UNCONFIRMED');
    let current=await get(bound.id),unexpectedVolumeIds=[...(bound.volumeIds??[])];
    if(current){assertBound(current,bound,q);unexpectedVolumeIds=[...new Set([...unexpectedVolumeIds,...current.volumeIds])];try{await remove(bound.id);}catch{/* Fresh reads below, never assume success. */}}
    const absent=(await get(bound.id))===null;
    const inventory=await list();
    const inventoryAbsent=!inventory.some(p=>p.id===bound.id||matchesReservation(p,q));
    const finalAbsent=(await get(bound.id))===null;
    return absenceReceipt({vmAbsent:absent&&finalAbsent,inventoryAbsent,complete:absent&&finalAbsent&&inventoryAbsent&&!unexpectedVolumeIds.length,unexpectedVolumeIds});
  }
  return {
    async catalog(){
      const values=await Promise.all([read('/core/flavors?region='+t.region),read('/core/images?region='+t.region+'&include_public=true'),paged('/core/environments','environments'),paged('/core/keypairs','keypairs'),read('/core/stocks'),read('/pricebook')]);
      return validateCatalog({flavors:values[0],images:values[1],environments:{status:true,environments:values[2]},keypairs:{status:true,keypairs:values[3]},stocks:values[4],pricebook:values[5]},t,now());
    },list,get,cleanup,
    async sealFirewall(bound,reservation){
      const q=validateReservation(reservation,t);if(!matchesReservation(bound,q))fail('HYPERSTACK_OWNERSHIP_UNCONFIRMED');
      let current=await firewallVM(bound,q);
      if((await attachedFirewalls(bound.id)).length){
        await firewallVM(bound,q);
        const r=await request('/core/virtual-machines/'+providerId(bound.id)+'/attach-firewalls',{method:'POST',body:{firewalls:[]}});
        if(r.status!==200||r.data?.status!==true)fail('HYPERSTACK_FIREWALL_DETACH_UNCONFIRMED');
        current=await firewallVM(bound,q);if((await attachedFirewalls(bound.id)).length)fail('HYPERSTACK_FIREWALL_DETACH_PENDING');
      }
      // Only this VM's rule IDs are removed. Shared firewall definitions,
      // attachments on other VMs and unrelated resource defaults stay untouched.
      const keep=new Set();
      for(const rule of current.rules){
        const k=ruleKey(rule),wanted=SEALED_RULES.some(w=>ruleKey(w)===k);
        if(wanted&&!keep.has(k)&&rule.status.toUpperCase()!=='ERROR'){keep.add(k);continue;}
        const fresh=await firewallVM(bound,q);if(!fresh.rules.some(r=>r.id===rule.id))continue;
        const removed=await request('/core/virtual-machines/'+providerId(bound.id)+'/sg-rules/'+providerId(rule.id),{method:'DELETE'});
        if(removed.status!==200||removed.data?.status!==true)fail('HYPERSTACK_FIREWALL_DELETE_UNCONFIRMED');
      }
      current=await firewallVM(bound,q);
      for(const wanted of SEALED_RULES){
        if(current.rules.some(r=>ruleKey(r)===ruleKey(wanted)))continue;
        // Re-read ownership and the rule set before each fixed POST. A lost
        // reply is unconfirmed; another invocation reconciles actual rules.
        current=await firewallVM(bound,q);if(current.rules.some(r=>ruleKey(r)===ruleKey(wanted)))continue;
        const added=await request('/core/virtual-machines/'+providerId(bound.id)+'/sg-rules',{method:'POST',body:wanted});
        if(added.status!==200||added.data?.status!==true)fail('HYPERSTACK_FIREWALL_ADD_UNCONFIRMED');
        current=await firewallVM(bound,q);
      }
      if(!exactRules(current.rules))fail('HYPERSTACK_FIREWALL_READBACK_UNCONFIRMED');
      if((await attachedFirewalls(bound.id)).length)fail('HYPERSTACK_FIREWALL_ATTACHMENTS_UNCONFIRMED');
      current=await firewallVM(bound,q);if(!exactRules(current.rules)||now()>=q.deadline)fail('HYPERSTACK_FIREWALL_READBACK_UNCONFIRMED');
      return {provider:'hyperstack',sealed:true,allocationId:bound.id,nonce:q.nonce,deadline:q.deadline,policy:FIREWALL_POLICY};
    },
    async create(reservation){
      let q,userData;
      try{
        q=validateReservation(reservation,t);
        if(now()<q.createdNotBefore||now()>q.createdNotAfter||now()>=q.deadline)fail('HYPERSTACK_CREATE_WINDOW_EXPIRED');
        if(attempted.has(q.nonce))throw new CreateError('HYPERSTACK_CREATE_ALREADY_ATTEMPTED','unknown');
        // Consume before the first await so simultaneous callers cannot each
        // pass the local single-attempt check while bootstrap is being built.
        attempted.add(q.nonce);
        if(typeof bootstrapFor!=='function')fail('HYPERSTACK_BOOTSTRAP_NOT_CONFIGURED');
        userData=await bootstrapFor(structuredClone(q));
        // user_data is cloud-init text; the documented limit applies after
        // provider-side Base64 encoding, not the unencoded character count.
        if(typeof userData!=='string'||!userData.length||Math.ceil(new TextEncoder().encode(userData).length/3)*4>65535||userData.includes(key))fail('HYPERSTACK_BOOTSTRAP_INVALID');
        // Bootstrap generation can await signing/configuration work. Recheck
        // the immutable window after that await, immediately before the POST.
        if(now()<q.createdNotBefore||now()>q.createdNotAfter||now()>=q.deadline)fail('HYPERSTACK_CREATE_WINDOW_EXPIRED');
      }catch(e){if(e instanceof CreateError)throw e;throw new CreateError('HYPERSTACK_CREATE_PREFLIGHT_REJECTED','definite-no-create');}
      // Caller MUST first durably consume its nonce/createAttempted flag and
      // arm both guards. This local set adds protection, not restart durability.
      let r;try{r=await request('/core/virtual-machines',{method:'POST',body:{count:1,environment_name:t.environmentName,flavor_name:t.flavorName,image_id:t.imageId,key_name:t.keyName,name:q.name,user_data:userData,assign_floating_ip:true,enable_port_randomization:false,create_bootable_volume:false,security_rules:[],...(q.ownershipPolicy===NONCE_NAME_OWNERSHIP?{}:{labels:[`unjailed:${q.nonce}`]})}});}catch{throw new CreateError('HYPERSTACK_CREATE_UNCONFIRMED');}
      if(r.status===400&&r.data?.status===false&&r.data.error_reason==='compatibility_blocked'&&r.data.compatibility_status==='BLOCKED')throw new CreateError('HYPERSTACK_IMAGE_INCOMPATIBLE','definite-no-create');
      if(r.status!==200||r.data?.status!==true||!Array.isArray(r.data.instances)||r.data.instances.length!==1)throw new CreateError('HYPERSTACK_CREATE_UNCONFIRMED');
      let p;try{p=normalizeVM(r.data.instances[0]);if(!matchesReservation(p,q))fail('HYPERSTACK_CREATE_IDENTITY_MISMATCH');}catch{throw new CreateError('HYPERSTACK_CREATE_READBACK_UNCONFIRMED');}
      return p;
    },
    async health(allocation,inferenceKey){
      if(typeof verifyHealth!=='function')return false;
      if(allocation?.provider!=='hyperstack'||allocation.environment?.id!==t.environmentId||allocation.flavor?.id!==t.flavorId||allocation.bootImageName!==t.imageName)fail('HYPERSTACK_HEALTH_TARGET_INVALID');
      // This trusted application callback must verify the sealed runtime and
      // pinned artifact receipt in addition to ordinary /health and /v1/models.
      // No API catalog/readback can establish those facts.
      return (await verifyHealth({allocation:structuredClone(allocation),origin:INFERENCE_ORIGIN,inferenceKey}))===true;
    },
    destroyClient(){return Object.freeze({list,get,remove});}
  };
}
