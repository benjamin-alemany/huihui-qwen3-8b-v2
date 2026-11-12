import test from 'node:test';
import assert from 'node:assert/strict';
import {hyperstackClient,SEALED_RULES} from './client.mjs';
import {normalizeVM} from './policy.mjs';
import {NOW,TARGET,RESERVATION,rawVM,fixture} from './fixtures.mjs';
const key='DUMMY_PROVIDER_KEY_NEVER_SENT_TO_VM';
const broad=(id,direction='egress',ethertype='IPv4')=>({id,direction,ethertype,protocol:'any',remote_ip_prefix:ethertype==='IPv4'?'0.0.0.0/0':'::/0',port_range_min:1,port_range_max:65535,status:'SUCCESS'});
const sealed=()=>SEALED_RULES.map((r,i)=>({id:500+i,...r,status:'SUCCESS'}));
function setup(rules=[broad(1),broad(2,'egress','IPv6'),{...broad(3,'ingress'),protocol:'tcp',port_range_min:22,port_range_max:22}]){const s=fixture({vms:[rawVM({security_rules:rules})]}),c=hyperstackClient(key,{target:TARGET,fetchImpl:s.fetch,now:()=>NOW}),bound=normalizeVM(s.vms[0]);return {s,c,bound};}
test('provider sealing removes broad IPv4/IPv6 and ingress, then proves only fixed six egress rules',async()=>{
 const {s,c,bound}=setup(),receipt=await c.sealFirewall(bound,RESERVATION);assert.deepEqual(receipt,{provider:'hyperstack',sealed:true,allocationId:'44',nonce:RESERVATION.nonce,deadline:RESERVATION.deadline,policy:'tunnel-dns-egress-v1'});assert.equal(s.vms[0].security_rules.length,6);assert(s.vms[0].security_rules.every(r=>r.direction==='egress'&&r.ethertype==='IPv4'));
 const posts=s.calls.filter(x=>x.method==='POST');assert.equal(posts.length,6);assert(posts.every(x=>x.path==='/v1/core/virtual-machines/44/sg-rules'));assert(posts.every(x=>!JSON.stringify(x.body).includes(key)));assert(s.calls.filter(x=>x.method==='DELETE').every(x=>/^\/v1\/core\/virtual-machines\/44\/sg-rules\/[123]$/.test(x.path)));
 assert.equal((await c.sealFirewall(bound,RESERVATION)).sealed,true);assert.equal(s.calls.filter(x=>x.method==='POST').length,6);
});
test('attached shared firewalls are detached only from the owned VM; shared rules and other attachments survive',async()=>{
 const {s,c,bound}=setup();s.firewalls=[{id:90,attachments:[{id:91,vm:{id:44}},{id:92,vm:{id:99}}],rules:[broad(93)]}];await c.sealFirewall(bound,RESERVATION);assert.deepEqual(s.firewalls[0].attachments,[{id:92,vm:{id:99}}]);assert.deepEqual(s.firewalls[0].rules,[broad(93)]);assert.deepEqual(s.calls.find(x=>x.path.endsWith('/attach-firewalls')).body,{firewalls:[]});assert(!s.calls.some(x=>x.method!=='GET'&&x.path.startsWith('/v1/core/firewalls/')));
});
test('pending shared detach or pending rules cannot issue a seal receipt',async()=>{
 const a=setup();a.s.firewalls=[{id:90,attachments:[{id:91,vm:{id:44}}],rules:[]}];a.s.detachWorks=false;await assert.rejects(a.c.sealFirewall(a.bound,RESERVATION),/DETACH_PENDING/);assert.equal(a.s.calls.filter(x=>x.path.endsWith('/sg-rules')&&x.method==='POST').length,0);
 const b=setup([]);b.s.ruleStatus='pending';await assert.rejects(b.c.sealFirewall(b.bound,RESERVATION),/READBACK_UNCONFIRMED/);assert.equal(b.s.vms[0].security_rules.length,6);b.s.vms[0].security_rules.forEach(r=>r.status='SUCCESS');assert.equal((await b.c.sealFirewall(b.bound,RESERVATION)).sealed,true);assert.equal(b.s.vms[0].security_rules.length,6);
});
test('acknowledged but ineffective broad-rule deletion, malformed rule metadata and duplicate allowances refuse success',async()=>{
 const a=setup();a.s.rulesDeleteWorks=false;await assert.rejects(a.c.sealFirewall(a.bound,RESERVATION),/READBACK_UNCONFIRMED/);assert(a.s.vms[0].security_rules.some(r=>r.remote_ip_prefix==='::/0'));
 const b=setup([{...broad(1),arbitrary_field:'DUMMY_SECRET'}]);await assert.rejects(b.c.sealFirewall(b.bound,RESERVATION),e=>!e.message.includes('DUMMY_SECRET'));assert.equal(b.s.calls.filter(x=>x.method!=='GET').length,0);
 const d=setup([...sealed(),{...sealed()[0],id:700}]);assert.equal((await d.c.sealFirewall(d.bound,RESERVATION)).sealed,true);assert.equal(d.s.vms[0].security_rules.length,6);
});
test('fresh immutable identity checks prevent touching reused or unrelated VM IDs',async()=>{
 const {s,c,bound}=setup();s.vms[0].created_at=new Date(NOW+1).toISOString();await assert.rejects(c.sealFirewall(bound,RESERVATION),/OWNERSHIP_UNCONFIRMED/);assert.equal(s.calls.filter(x=>x.method!=='GET').length,0);
 await assert.rejects(c.sealFirewall({...bound,name:'unrelated'},RESERVATION));assert.equal(s.calls.filter(x=>x.method!=='GET').length,0);
});
test('deadline before or during sealing prevents model permission and never widens a rule',async()=>{
 const s=fixture({vms:[rawVM({security_rules:[broad(1)]})]});let clock=RESERVATION.deadline;const fetch=s.fetch,wrapped=async(...args)=>{const response=await fetch(...args);if(args[1]?.method==='DELETE')clock=RESERVATION.deadline;return response;},c=hyperstackClient(key,{target:TARGET,fetchImpl:wrapped,now:()=>clock}),bound=normalizeVM(s.vms[0]);await assert.rejects(c.sealFirewall(bound,RESERVATION));assert.equal(s.calls.length,0);clock=NOW;await assert.rejects(c.sealFirewall(bound,RESERVATION),/DEADLINE_EXPIRED/);assert.equal(s.calls.filter(x=>x.method==='POST').length,0);
});
test('full-page current-count inventory follows subsequent pages instead of returning partial absence',async()=>{
 const {s,c,bound}=setup(sealed());s.pageCountIsCurrent=true;s.firewalls=Array.from({length:101},(_,i)=>({id:100+i,attachments:i===100?[{id:500,vm:{id:44}}]:[],rules:[]}));const receipt=await c.sealFirewall(bound,RESERVATION);assert.equal(receipt.sealed,true);assert(s.calls.some(x=>x.path==='/v1/core/firewalls'&&x.query.includes('page=2')));assert(s.calls.some(x=>x.path.endsWith('/attach-firewalls')));
 const v=fixture({vms:Array.from({length:101},(_,i)=>rawVM({id:100+i}))});v.pageCountIsCurrent=true;const vc=hyperstackClient(key,{target:TARGET,fetchImpl:v.fetch});assert.equal((await vc.list()).length,101);
});
test('a new broad rule or shared attachment observed in final readback prevents permission',async()=>{
 const {s,bound}=setup(sealed());let gets=0;const fetch=s.fetch,wrapped=async(url,options)=>{if(String(url).endsWith('/virtual-machines/44')&&++gets===3)s.vms[0].security_rules.push(broad(999,'egress','IPv6'));return fetch(url,options);},c=hyperstackClient(key,{target:TARGET,fetchImpl:wrapped,now:()=>NOW});await assert.rejects(c.sealFirewall(bound,RESERVATION));
 const b=setup(sealed());let inventories=0;const base=b.s.fetch,late=async(url,options)=>{if(String(url).includes('/core/firewalls?')&&++inventories===2)b.s.firewalls.push({id:90,attachments:[{id:91,vm:{id:44}}],rules:[]});return base(url,options);},bc=hyperstackClient(key,{target:TARGET,fetchImpl:late,now:()=>NOW});await assert.rejects(bc.sealFirewall(b.bound,RESERVATION),/ATTACHMENTS_UNCONFIRMED/);
});
test('clamped full firewall page cannot hide an attachment or authorize model execution',async()=>{
 const {s,bound}=setup(sealed());s.firewalls=Array.from({length:21},(_,i)=>({id:100+i,attachments:i===20?[{id:500,vm:{id:44}}]:[],rules:[]}));const fetch=s.fetch,clamped=async(url,options)=>String(url).includes('/core/firewalls?')?Response.json({status:true,page:1,page_size:20,count:20,firewalls:s.firewalls.slice(0,20)}):fetch(url,options),c=hyperstackClient(key,{target:TARGET,fetchImpl:clamped,now:()=>NOW});await assert.rejects(c.sealFirewall(bound,RESERVATION),/INVENTORY_INVALID/);assert.equal(s.calls.filter(x=>x.method!=='GET').length,0);assert.equal(s.firewalls[20].attachments[0].vm.id,44);
});
test('explicitly requested pagination refuses null metadata even when count equals returned rows',async()=>{
 const {s,c}=setup();s.listHook=()=>Response.json({status:true,page:null,page_size:null,count:1,instances:[s.vms[0]]});await assert.rejects(c.list(),/INVENTORY_INVALID/);
});
