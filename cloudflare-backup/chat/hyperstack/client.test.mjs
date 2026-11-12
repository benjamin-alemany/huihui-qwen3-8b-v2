import test from 'node:test';
import assert from 'node:assert/strict';
import {hyperstackClient,CreateError,safeCreateDiagnostics} from './client.mjs';
import {validateCatalog,normalizeVM,matchesReservation,assertBound} from './policy.mjs';
import {NOW,TARGET,RESERVATION,rawVM,catalogRaw,fixture} from './fixtures.mjs';
const KEY='DUMMY_PROVIDER_KEY_NOT_A_REAL_SECRET';
const client=(s,extra={})=>hyperstackClient(KEY,{target:TARGET,fetchImpl:s.fetch,now:()=>NOW,bootstrapFor:async()=> '#cloud-config\nruncmd: []\n',...extra});
test('catalog uses exact authenticated schemas and returns metadata only',async()=>{
 const s=fixture(),c=client(s),q=await c.catalog();assert.equal(q.totalHourlyUSD,.50672043);assert.equal(q.catalogVerified,true);assert.equal(q.runtimeVerified,false);assert.equal(q.permissionsVerified,false);assert.equal(q.target.imageId,33);
 assert.equal(s.calls.length,6);assert(s.calls.every(x=>x.method==='GET'&&x.headers.api_key===KEY));assert(!JSON.stringify(q).includes('DUMMY_PUBLIC_KEY'));
});
test('catalog fails closed on B300-only image restrictions, warnings, missing metadata and zero stock',()=>{
 for(const mutate of [r=>{r.images.images[0].images[0].flavor_restrictions={has_flavor_restrictions:true,restriction_type:'hard',compatible_flavors:[{flavor_id:999,link_type:'hard',constraints:{}}]};},r=>{r.flavors.data[0].flavors[0].image_restrictions.restriction_type='soft';r.flavors.data[0].flavors[0].image_restrictions.has_image_restrictions=true;},r=>{delete r.images.images[0].images[0].flavor_restrictions;},r=>{r.stocks.stocks[0].models[0].configurations['1x']=0;}]){const r=catalogRaw();mutate(r);assert.throws(()=>validateCatalog(r,TARGET,NOW));}
});
test('catalog rejects unquoted charges, expiring rates, malformed or ambiguous prices',()=>{
 for(const mutate of [r=>{r.pricebook[0].value='1';},r=>{r.pricebook[2].value='.01';},r=>{r.pricebook[0].value='NaN';},r=>{r.pricebook.push({...r.pricebook[0]});},r=>{r.pricebook[0].end_time=new Date(NOW+60_000).toISOString();}]){const r=catalogRaw();mutate(r);assert.throws(()=>validateCatalog(r,TARGET,NOW));}
});
test('normalized readbacks cannot reflect user_data, API secrets, image ID or artifact proof',()=>{
 const p=normalizeVM(rawVM());assert.equal(p.bootImageName,TARGET.imageName);assert.equal(p.artifactVerified,false);assert.equal(p.publicIp,'192.0.2.44');assert(!JSON.stringify(p).includes('DUMMY_SECRET'));assert(!('imageId' in p));assert(!('raw' in p));assert(matchesReservation(p,RESERVATION));
});
test('ownership binds exact nonce/name/tag/time/target then retains immutable IDs after rename',()=>{
 const p=normalizeVM(rawVM());for(const delta of [{name:'other'},{labels:[]},{createdAt:new Date(NOW-10_000).toISOString()},{environment:{...p.environment,id:12}},{flavor:{...p.flavor,count:2}}])assert.equal(matchesReservation({...p,...delta},RESERVATION),false);
 assert.equal(assertBound({...p,name:'renamed',labels:[]},p,RESERVATION).id,p.id);assert.throws(()=>assertBound({...p,createdAt:new Date(NOW+1).toISOString()},p,RESERVATION));assert.throws(()=>assertBound({...p,id:'999'},p,RESERVATION));
});
test('create sends one constrained body and never places provider key in VM bootstrap',async()=>{
 const s=fixture(),c=client(s),p=await c.create(RESERVATION);assert.equal(p.id,'44');const post=s.calls.find(x=>x.method==='POST');assert.deepEqual(Object.keys(post.body).sort(),['assign_floating_ip','count','create_bootable_volume','enable_port_randomization','environment_name','flavor_name','image_id','key_name','labels','name','security_rules','user_data'].sort());assert.equal(post.body.count,1);assert.equal(post.body.create_bootable_volume,false);assert.deepEqual(post.body.security_rules,[]);assert(!JSON.stringify(post.body).includes(KEY));
 await assert.rejects(c.create(RESERVATION),e=>e.outcome==='unknown');assert.equal(s.calls.filter(x=>x.method==='POST').length,1);
});
test('simultaneous create calls cannot race the local single-attempt marker',async()=>{
 const s=fixture();let resolve;const wait=new Promise(r=>resolve=r);const c=client(s,{bootstrapFor:async()=>{await wait;return '#cloud-config';}});const a=c.create(RESERVATION),b=c.create(RESERVATION);await assert.rejects(b,e=>e.outcome==='unknown');resolve();await a;assert.equal(s.calls.filter(x=>x.method==='POST').length,1);
});
test('preflight rejects oversized UTF-8 bootstrap, provider key, expired window and arbitrary target',async()=>{
 for(const extra of [{bootstrapFor:async()=>KEY},{bootstrapFor:async()=> '🐱'.repeat(13_000)},{now:()=>NOW+70_000}]){const s=fixture();await assert.rejects(client(s,extra).create(RESERVATION),e=>e instanceof CreateError&&e.outcome==='definite-no-create'&&!e.message.includes(KEY));assert.equal(s.calls.length,0);}
 assert.throws(()=>client(fixture(),{target:{...TARGET,inferenceOrigin:'https://attacker.invalid'}}));
});
test('slow bootstrap cannot send a POST after the creation window or deadline expires',async()=>{
 for(const expired of [RESERVATION.createdNotAfter+1,RESERVATION.deadline]){const s=fixture();let clock=NOW;const c=client(s,{now:()=>clock,bootstrapFor:async()=>{clock=expired;return '#cloud-config';}});await assert.rejects(c.create(RESERVATION),e=>e.outcome==='definite-no-create');assert.equal(s.calls.length,0);}
});
test('lost create retains ambiguity while received API rejection and compatibility rejection are definite',async()=>{
 for(const mode of ['lost','ambiguous','blocked']){const s=fixture({createMode:mode});await assert.rejects(client(s).create(RESERVATION),e=>e.outcome===(mode==='lost'?'unknown':'definite-no-create')&&!e.message.includes('DUMMY_SECRET'));assert.equal(s.calls.filter(x=>x.method==='POST').length,1);if(mode==='lost')assert.equal(s.vms.length,1);}
});
test('create failures keep only bounded HTTP status, known reason and actual response bytes',async()=>{
 for(const [status,data,outcome,reason] of [[400,{status:false,error_reason:'bad_request',message:'DUMMY_PRIVATE_RESPONSE'},'definite-no-create','bad_request'],[400,{status:false,error_reason:'compatibility_blocked',compatibility_status:'BLOCKED',user_data:'DUMMY_PRIVATE_BOOTSTRAP'},'definite-no-create','compatibility_blocked'],[400,{status:false,error_reason:'DUMMY_PRIVATE_REASON',message:KEY,headers:{api_key:KEY}},'definite-no-create','redacted'],[503,{status:false,error_reason:'bad_request'},'unknown','bad_request']]){
  const text=' \n'+JSON.stringify(data)+'\n',s=fixture(),c=client(s,{fetchImpl:async(url,options)=>{assert.equal(options.method,'POST');return new Response(text,{status,headers:{'DUMMY-Private-Header':KEY}});}});
  await assert.rejects(c.create(RESERVATION),error=>{assert.equal(error.outcome,outcome);assert.deepEqual(error.diagnostics,{version:1,provider:'hyperstack',httpStatus:status,errorReason:reason,responseBytes:new TextEncoder().encode(text).byteLength});assert(!JSON.stringify(error).includes('DUMMY_PRIVATE'));assert(!JSON.stringify(error).includes(KEY));return true;});
 }
});
test('malformed and oversized received 400 replies remain rejections with safe diagnostics; lost replies remain unknown',async()=>{
 for(const text of ['', 'DUMMY_PRIVATE_NON_JSON','x'.repeat(2*1024*1024+1)]){const s=fixture(),c=client(s,{fetchImpl:async()=>new Response(text,{status:400})});await assert.rejects(c.create(RESERVATION),error=>{assert.equal(error.outcome,'definite-no-create');assert.equal(error.code,'HYPERSTACK_CREATE_REJECTED');assert.deepEqual(error.diagnostics,{version:1,provider:'hyperstack',httpStatus:400,errorReason:null,responseBytes:text.length>2*1024*1024?null:new TextEncoder().encode(text).byteLength});assert(!JSON.stringify(error).includes('DUMMY_PRIVATE'));return true;});}
 const lost=client(fixture({createMode:'lost'}));await assert.rejects(lost.create(RESERVATION),error=>error.outcome==='unknown'&&error.diagnostics===undefined);
});
test('received 4xx including no stock reject only this create and never retry a consumed nonce',async()=>{
 for(const status of [400,401,403,408,409,422,429,499]){
  let posts=0;const text=JSON.stringify({status:false,error_reason:'bad_request',message:'DUMMY_PRIVATE: insufficient GPU stock '+KEY}),c=client(fixture(),{fetchImpl:async(url,options)=>{posts++;assert.equal(options.method,'POST');assert.equal(options.redirect,'manual');return new Response(text,{status});}});
  await assert.rejects(c.create(RESERVATION),error=>{assert.equal(error.code,'HYPERSTACK_CREATE_REJECTED');assert.equal(error.outcome,'definite-no-create');assert.equal(error.diagnostics.httpStatus,status);assert.equal(error.diagnostics.errorReason,'bad_request');assert(!JSON.stringify(error).includes(KEY));assert(!JSON.stringify(error).includes('DUMMY_PRIVATE'));assert(!JSON.stringify(error).includes('insufficient GPU stock'));return true;});
  await assert.rejects(c.create(RESERVATION),error=>error.code==='HYPERSTACK_CREATE_ALREADY_ATTEMPTED'&&error.outcome==='unknown');assert.equal(posts,1);
 }
});
test('body read failure cannot erase an already received API 4xx rejection',async()=>{
 const c=client(fixture(),{fetchImpl:async()=>new Response(new ReadableStream({start(controller){controller.error(Error('DUMMY_PRIVATE_BODY '+KEY));}}),{status:400})});
 await assert.rejects(c.create(RESERVATION),error=>{assert.equal(error.code,'HYPERSTACK_CREATE_REJECTED');assert.equal(error.outcome,'definite-no-create');assert.equal(error.diagnostics.httpStatus,400);assert.equal(error.diagnostics.errorReason,null);assert(!JSON.stringify(error).includes('DUMMY_PRIVATE'));assert(!JSON.stringify(error).includes(KEY));return true;});
});
test('contradictory successful or resource-bearing 4xx bodies remain unknown without exposing resource data',async()=>{
 for(const status of [400,409])for(const data of [{status:true},{status:false,instances:[rawVM()]},{status:false,instance:rawVM()},{status:false,instances:{id:44}},{status:false,error_reason:'compatibility_blocked',compatibility_status:'BLOCKED',instances:[rawVM()]}]){
  const c=client(fixture(),{fetchImpl:async()=>Response.json(data,{status})});await assert.rejects(c.create(RESERVATION),error=>{assert.equal(error.outcome,'unknown');assert.equal(error.code,'HYPERSTACK_CREATE_UNCONFIRMED');assert.equal(error.diagnostics.httpStatus,status);assert(!JSON.stringify(error).includes('DUMMY_SECRET'));assert(!JSON.stringify(error).includes('instances'));return true;});
 }
});
test('network timeout, redirects, 5xx and malformed or unexpected 2xx create outcomes remain unknown',async()=>{
 const replies=[()=>{throw Error('DUMMY_PRIVATE_NETWORK_TIMEOUT '+KEY);},()=>new Response('DUMMY_PRIVATE',{status:302,headers:{Location:'https://attacker.invalid'}}),()=>Response.json({status:false,error_reason:'bad_request'},{status:500}),()=>new Response('DUMMY_PRIVATE',{status:503}),()=>new Response('DUMMY_PRIVATE',{status:200}),()=>Response.json({status:false,error_reason:'bad_request'}),()=>Response.json({status:true,instances:[]}),()=>Response.json({status:true,instances:[rawVM()]},{status:201})];
 for(const reply of replies){let posts=0;const c=client(fixture(),{fetchImpl:async()=>{posts++;return reply();}});await assert.rejects(c.create(RESERVATION),error=>{assert.equal(error.outcome,'unknown');assert(!JSON.stringify(error).includes('DUMMY_PRIVATE'));assert(!JSON.stringify(error).includes(KEY));return true;});await assert.rejects(c.create(RESERVATION),error=>error.code==='HYPERSTACK_CREATE_ALREADY_ATTEMPTED');assert.equal(posts,1);}
});
test('owner create diagnostic projection rejects invalid bounds and strips every unreviewed field',()=>{
 const sample={version:1,provider:'hyperstack',httpStatus:400,errorReason:'DUMMY_PRIVATE_REASON',responseBytes:143,raw:'DUMMY_PRIVATE_BODY',headers:{api_key:KEY},user_data:KEY};
 assert.deepEqual(safeCreateDiagnostics(sample),{version:1,provider:'hyperstack',httpStatus:400,errorReason:'redacted',responseBytes:143});
 for(const patch of [{httpStatus:0},{httpStatus:600},{responseBytes:-1},{responseBytes:2*1024*1024+1},{provider:'other'},{version:2}])assert.equal(safeCreateDiagnostics({...sample,...patch}),null);
});
test('only structured 404 proves absence, auth failure and malformed successful replies never do',async()=>{
 const s=fixture(),c=client(s);assert.equal(await c.get('44'),null);s.getStatus=401;await assert.rejects(c.get('44'));s.getStatus=500;await assert.rejects(c.get('44'));
 const bad=client(s,{fetchImpl:async()=>Response.json({status:true,instance:null})});await assert.rejects(bad.get('44'));await assert.rejects(c.get('../billing'));
});
test('full inventory pagination rejects partial, repeated and changing-count pages',async()=>{
 const s=fixture(),c=client(s);s.listHook=()=>Response.json({status:true,page:1,page_size:100,count:2,instances:[rawVM()]});await assert.rejects(c.list());
 s.listHook=()=>Response.json({status:true,page:null,page_size:null,count:2,instances:[rawVM()]});await assert.rejects(c.list());
 s.listHook=u=>Response.json({status:true,page:Number(u.searchParams.get('page')),page_size:100,count:101,instances:Array.from({length:100},(_,i)=>rawVM({id:100+i}))});await assert.rejects(c.list());
});
test('trusted inventory page hook runs before each request and cannot turn a failed later page into partial success',async()=>{
 const s=fixture({vms:Array.from({length:101},(_,i)=>rawVM({id:100+i}))}),c=client(s),observed=[];
 const rows=await c.list({beforePage:async()=>{observed.push(s.calls.length);}});assert.equal(rows.length,101);assert.deepEqual(observed,[0,1]);
 const failing=fixture({vms:Array.from({length:101},(_,i)=>rawVM({id:100+i}))});let pages=0;
 await assert.rejects(client(failing).list({beforePage:async()=>{if(++pages===2)throw Error('DUMMY_LEASE_CHANGED');}}),/DUMMY_LEASE_CHANGED/);
 assert.equal(failing.calls.length,1);
 const invalid=fixture();await assert.rejects(client(invalid).list({beforePage:'not-a-trusted-function'}),/INVENTORY_OPTIONS_INVALID/);assert.equal(invalid.calls.length,0);
});
test('cleanup uses DELETE and fresh absence/inventory; public IP release remains coupled and unsettled',async()=>{
 const s=fixture({vms:[rawVM(),rawVM({id:45,name:'unrelated',labels:[]})]}),c=client(s),p=await c.get('44'),r=await c.cleanup(p,RESERVATION);assert.equal(r.complete,true);assert.equal(r.vmAbsent,true);assert.equal(r.inventoryAbsent,true);assert.equal(r.publicIpReleaseMode,'vm-coupled');assert.equal(r.independentIpReadback,false);assert.equal(r.standaloneIpAbsence,'unverified');assert.equal(r.billingSettlementPending,true);assert.equal(s.vms[0].id,45);assert.equal(s.calls.filter(x=>x.method==='DELETE').length,1);assert(s.calls.every(x=>!x.path.includes('action')&&!x.path.includes('floatingip')));
});
test('DELETE acknowledgement alone, duplicate VM or unexpected volumes cannot complete cleanup',async()=>{
 const s=fixture({vms:[rawVM()]}),c=client(s),p=await c.get('44');s.deleteWorks=false;assert.equal((await c.cleanup(p,RESERVATION)).complete,false);s.deleteWorks=true;s.vms.push(rawVM({id:46}));assert.equal((await c.cleanup(p,RESERVATION)).complete,false);
 const v=fixture({vms:[rawVM({volume_attachments:[{id:2,volume:{id:77}}]})]}),vc=client(v),vp=await vc.get('44'),r=await vc.cleanup(vp,RESERVATION);assert.equal(r.vmAbsent,true);assert.equal(r.complete,false);assert.deepEqual(r.unexpectedVolumeIds,['77']);assert(v.calls.every(x=>!x.path.includes('/volumes')));
});
test('cleanup refuses unbound unrelated resources and immutable-target changes',async()=>{
 const s=fixture({vms:[rawVM()]}),c=client(s),p=await c.get('44');await assert.rejects(c.cleanup({...p,name:'unrelated'},RESERVATION));s.vms[0].environment.id=99;await assert.rejects(c.cleanup(p,RESERVATION));assert.equal(s.calls.filter(x=>x.method==='DELETE').length,0);
});
test('runtime health is disabled without explicit independent verifier; guard has no create capability',async()=>{
 const s=fixture(),c=client(s),p=normalizeVM(rawVM());assert.equal(await c.health(p,'DUMMY_INFERENCE_KEY'),false);assert.equal(s.calls.length,0);assert.deepEqual(Object.keys(c.destroyClient()).sort(),['get','list','remove']);let seen;const withVerifier=client(s,{verifyHealth:async v=>{seen=v;return true;}});assert.equal(await withVerifier.health(p,'DUMMY_INFERENCE_KEY'),true);assert.equal(seen.origin,TARGET.inferenceOrigin);assert(!JSON.stringify(seen).includes(KEY));
});
