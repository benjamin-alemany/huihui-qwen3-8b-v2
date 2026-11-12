// Synthetic values only. Never reads credentials or installs a real fetch.
export const NOW=Date.parse('2026-11-10T12:00:00Z');
export const TARGET={environmentId:11,environmentName:'dummy-environment',region:'CANADA-1',flavorId:22,flavorName:'n3-RTX-A6000x1',imageId:33,imageName:'Ubuntu Server 24.04 LTS (Noble Numbat)',keyName:'dummy-keypair',inferenceOrigin:'https://inference.unjailed.work',maximumHourlyUSD:1};
export const RESERVATION={nonce:'a'.repeat(32),name:'unjailed-chat-'+'a'.repeat(32),createdNotBefore:NOW-1000,createdNotAfter:NOW+60_000,deadline:NOW+18*60_000,target:TARGET};
export const unrestrictedFlavor={has_flavor_restrictions:false,restriction_type:null,compatible_flavors:[]};
export const unrestrictedImage={has_image_restrictions:false,restriction_type:null,compatible_images:[]};
export function rawVM(overrides={}){return {id:44,name:RESERVATION.name,status:'ACTIVE',created_at:new Date(NOW).toISOString(),image:{name:TARGET.imageName},flavor:{id:22,name:TARGET.flavorName,gpu:'RTX-A6000',gpu_count:1,cpu:28,ram:58,disk:100},environment:{id:11,name:TARGET.environmentName,region:TARGET.region},floating_ip:'192.0.2.44',volume_attachments:[],labels:[`unjailed:${RESERVATION.nonce}`],user_data:'DO_NOT_RETURN_DUMMY_SECRET',...overrides};}
export function catalogRaw(){return {flavors:{status:true,data:[{gpu:'RTX-A6000',region_name:TARGET.region,flavors:[{id:22,name:TARGET.flavorName,region_name:TARGET.region,cpu:28,ram:58,disk:100,ephemeral:0,gpu:'RTX-A6000',gpu_count:1,stock_available:true,image_restrictions:structuredClone(unrestrictedImage)}]}]},images:{status:true,images:[{region_name:TARGET.region,images:[{id:33,name:TARGET.imageName,region_name:TARGET.region,flavor_restrictions:structuredClone(unrestrictedFlavor)}]}]},environments:{status:true,environments:[{id:11,name:TARGET.environmentName,region:TARGET.region}]},keypairs:{status:true,keypairs:[{id:55,name:TARGET.keyName,environment:{id:11,name:TARGET.environmentName},public_key:'DUMMY_PUBLIC_KEY_NOT_FOR_READBACK'}]},stocks:{stocks:[{region:TARGET.region,'stock-type':'GPU',models:[{model:'RTX-A6000',available:'10+',configurations:{'1x':2}}]}]},pricebook:[{name:'RTX-A6000',value:'0.500000000'},{name:'PublicIP',value:'0.00672043'},...['vCPU','RAM','hypervisor-local-storage'].map(name=>({name,value:'0E-9'}))]};}
export function fixture({vms=[],createMode='ok'}={}){
  const s={vms:structuredClone(vms),calls:[],createMode,deleteWorks:true,getStatus:null,catalog:catalogRaw(),listHook:null,firewalls:[],nextRule:1000,ruleStatus:'SUCCESS',rulesDeleteWorks:true,detachWorks:true,pageCountIsCurrent:false};
  const page=(rows,field,url)=>{const n=Number(url.searchParams.get('page')??1),selected=rows.slice((n-1)*100,n*100);return {status:true,page:n,page_size:100,count:s.pageCountIsCurrent?selected.length:rows.length,[field]:selected};};
  s.fetch=async(url,options={})=>{
    const u=new URL(url),method=options.method??'GET';if(u.origin!=='https://infrahub-api.nexgencloud.com')throw Error('EXTERNAL_DESTINATION_REJECTED');
    const call={path:u.pathname,query:u.search,method,headers:options.headers,...(options.body?{body:JSON.parse(options.body)}:{})};s.calls.push(call);
    if(u.pathname==='/v1/core/virtual-machines'&&method==='POST'){
      if(s.createMode==='lost'){s.vms.push(rawVM());throw Error('DUMMY_SECRET_UPSTREAM_ERROR');}
      if(s.createMode==='blocked')return Response.json({status:false,error_reason:'compatibility_blocked',compatibility_status:'BLOCKED',message:'DUMMY_SECRET_ERROR'},{status:400});
      if(s.createMode==='ambiguous')return Response.json({status:false,error_reason:'bad_request',message:'DUMMY_SECRET_ERROR'},{status:400});
      const p=rawVM();s.vms.push(p);return Response.json({status:true,instances:[p]});
    }
    if(u.pathname==='/v1/core/virtual-machines'&&method==='GET'){if(s.listHook)return s.listHook(u);return Response.json(page(s.vms,'instances',u));}
    if(u.pathname==='/v1/core/firewalls'&&method==='GET')return Response.json(page(s.firewalls,'firewalls',u));
    const scoped=u.pathname.match(/^\/v1\/core\/virtual-machines\/(\d+)\/(attach-firewalls|sg-rules)(?:\/(\d+))?$/);
    if(scoped){
      const vm=s.vms.find(p=>String(p.id)===scoped[1]);if(!vm)return Response.json({status:false,error_reason:'not_found'},{status:404});
      if(scoped[2]==='attach-firewalls'&&method==='POST'){if(s.detachWorks)s.firewalls.forEach(f=>{f.attachments=f.attachments.filter(a=>String(a.vm.id)!==scoped[1]);});return Response.json({status:true});}
      if(scoped[2]==='sg-rules'&&method==='POST'){const rule={id:++s.nextRule,...JSON.parse(options.body),status:s.ruleStatus};vm.security_rules.push(rule);return Response.json({status:true,security_rule:rule});}
      if(scoped[2]==='sg-rules'&&scoped[3]&&method==='DELETE'){if(s.rulesDeleteWorks)vm.security_rules=vm.security_rules.filter(r=>String(r.id)!==scoped[3]);return Response.json({status:true});}
      throw Error('UNEXPECTED_DUMMY_SCOPED_OPERATION');
    }
    const id=u.pathname.match(/^\/v1\/core\/virtual-machines\/(\d+)$/)?.[1];
    if(id){
      if(method==='DELETE'){if(s.deleteWorks)s.vms=s.vms.filter(x=>String(x.id)!==id);return Response.json({status:true,message:'Instance is being deleted.'});}
      if(s.getStatus!==null)return Response.json({status:false,error_reason:'not_found',message:'DUMMY_SECRET_ERROR'},{status:s.getStatus});
      const p=s.vms.find(x=>String(x.id)===id);return p?Response.json({status:true,instance:p}):Response.json({status:false,error_reason:'not_found'},{status:404});
    }
    if(u.pathname==='/v1/core/flavors')return Response.json(s.catalog.flavors);
    if(u.pathname==='/v1/core/images')return Response.json(s.catalog.images);
    if(u.pathname==='/v1/core/environments')return Response.json(page(s.catalog.environments.environments,'environments',u));
    if(u.pathname==='/v1/core/keypairs')return Response.json(page(s.catalog.keypairs.keypairs,'keypairs',u));
    if(u.pathname==='/v1/core/stocks')return Response.json(s.catalog.stocks);
    if(u.pathname==='/v1/pricebook')return Response.json(s.catalog.pricebook);
    throw Error('UNEXPECTED_DUMMY_PATH');
  };return s;
}
export class Store{
  constructor(){this.rows=new Map();this.serial=Promise.resolve();}
  async get(k){return structuredClone(this.rows.get(k));}
  async put(k,v){this.rows.set(k,structuredClone(v));}
  async transaction(fn){const result=this.serial.then(()=>fn(this));this.serial=result.catch(()=>{});return result;}
}
