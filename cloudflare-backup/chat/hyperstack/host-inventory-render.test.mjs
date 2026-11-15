import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {HOST_INVENTORY_FILES,HOST_INVENTORY_PROFILE,HOST_INVENTORY_SERVING_IMAGE,canonicalHostInventorySource,hostInventorySourceSHA256,renderHostInventory} from './host-inventory-render.mjs';
const NOW=1794762000102,SESSION='11111111-1111-4111-8111-111111111111';
const digest=value=>createHash('sha256').update(value).digest('hex');
async function fixture(){
 const target={environmentId:11,environmentName:'dummy-environment',region:'CANADA-1',flavorId:100,flavorName:'n3-A100x1',imageId:517,imageName:'Ubuntu Server 24.04 LTS R570 CUDA 12.8 with Docker',keyName:'dummy-public-key',inferenceOrigin:'https://inference.unjailed.work',maximumHourlyUSD:1.36};
 const reservation={kind:'chat',provider:'hyperstack',ownershipPolicy:'nonce-name-v2',minutes:30,name:'unjailed-chat-'+'a'.repeat(32),image:HOST_INVENTORY_SERVING_IMAGE,nonce:'a'.repeat(32),target,createdNotBefore:NOW,createdNotAfter:NOW+300000,deadline:NOW+1800000,windowStart:new Date(NOW).toISOString(),windowEnd:new Date(NOW+300000).toISOString()};
 const source={version:1,files:Object.fromEntries(HOST_INVENTORY_FILES.map(name=>[name,Buffer.from('# Credential-free dummy '+name+'\n').toString('base64')]))};
 return {reservation,sessionId:SESSION,source,sourceSHA256:await hostInventorySourceSHA256(source),now:NOW};
}
function config(text){assert(text.startsWith('#cloud-config\n'));return JSON.parse(text.slice(text.indexOf('\n')+1));}
const writes=c=>Object.fromEntries(c.write_files.map(file=>[file.path,Buffer.from(file.content,'base64')]));
const launcher=c=>{assert.equal(c.runcmd.length,1);assert.deepEqual(c.runcmd[0].slice(0,4),['/usr/bin/python3','-I','-B','-c']);return c.runcmd[0][4];};
test('pure inventory renderer writes only root-only fixed sources, immutable manifest and local deadline units',async()=>{
 const f=await fixture(),text=await renderHostInventory(f),c=config(text),w=writes(c);
 assert(Math.ceil(Buffer.byteLength(text)/3)*4<=65535);
 assert.equal(c.ssh_pwauth,false);assert.equal(c.disable_root,true);assert.deepEqual(c.bootcmd,[['/usr/bin/systemctl','mask','--now','ssh.service','ssh.socket']]);
 assert.deepEqual(Object.keys(w).sort(),['/etc/unjailed/session.json',...HOST_INVENTORY_FILES.map(name=>'/opt/unjailed/vm/'+name),'/etc/systemd/system/unjailed-inventory-deadline.service','/etc/systemd/system/unjailed-inventory-deadline.timer'].sort());
 assert(c.write_files.every(file=>file.owner==='root:root'&&file.permissions==='0600'&&file.encoding==='b64'));
 const m=JSON.parse(w['/etc/unjailed/session.json']);assert.deepEqual(m,{version:1,sessionId:SESSION,nonce:f.reservation.nonce,createdAt:new Date(NOW).toISOString(),deadlineUTC:new Date(f.reservation.deadline).toISOString(),image:HOST_INVENTORY_SERVING_IMAGE,resources:{vmId:null,publicIpAddress:null,volumeIds:[]}});
 for(const name of HOST_INVENTORY_FILES)assert.equal(w['/opt/unjailed/vm/'+name].toString('base64'),f.source.files[name]);
 const timer=w['/etc/systemd/system/unjailed-inventory-deadline.timer'].toString(),service=w['/etc/systemd/system/unjailed-inventory-deadline.service'].toString();
 assert(timer.includes('OnCalendar='+new Date(f.reservation.deadline).toISOString().replace('T',' ').replace('Z',' UTC')));assert(timer.includes('Persistent=true'));assert(timer.includes('RandomizedDelaySec=0'));
 assert(service.includes('ExecStart=/usr/bin/python3 -I -B /opt/unjailed/vm/inventory_deadline.py'));assert(!service.includes('/deadline.py'));
 const command=launcher(c);assert(command.includes("['/usr/bin/systemctl','is-active','--quiet','unjailed-inventory-deadline.timer']"));assert(command.includes("'--execute','--source-sha256'"));assert(command.includes('check=True'));assert(command.includes('os.O_NOFOLLOW'));assert(command.includes("info.st_uid!=0 or info.st_mode&0o077"));assert(command.includes("EXPECTED['sessionSHA256']"));
 for(const forbidden of ['inference.env','gateway.json','tunnel.json','tunnel.yml','model-permit','docker run','apt-get','reboot','shell=True','urlopen','unjailed-runtime','unjailed-gateway','unjailed-tunnel'])assert(!text.includes(forbidden),forbidden);
});
test('independently supplied source digest binds the exact canonical fixed file payload',async()=>{
 const f=await fixture(),canonical=canonicalHostInventorySource(f.source);assert.equal(await hostInventorySourceSHA256(f.source),digest(canonical));
 const reordered={files:Object.fromEntries(Object.entries(f.source.files).reverse()),version:1};assert.equal(canonicalHostInventorySource(reordered),canonical);assert.equal(await hostInventorySourceSHA256(reordered),f.sourceSHA256);
 f.source.files['prepared_host.py']=Buffer.from('# altered without source approval\n').toString('base64');await assert.rejects(renderHostInventory(f),/HOST_INVENTORY_SOURCE_MISMATCH/);
 const g=await fixture();g.sourceSHA256='f'.repeat(64);await assert.rejects(renderHostInventory(g),/HOST_INVENTORY_SOURCE_MISMATCH/);
});
test('no optional credential, URL, command, runtime or environment inputs are accepted or reflected',async()=>{
 for(const field of ['inferenceKey','modelKey','hostTunnelCredential','providerKey','url','command','env','runtime','release']){
  const f=await fixture();f[field]='NEVER_REFLECT_DUMMY_SECRET';await assert.rejects(renderHostInventory(f),error=>error.message==='HOST_INVENTORY_ARGUMENTS_INVALID'&&!error.message.includes('NEVER_REFLECT'));
 }
 for(const mutate of [f=>{f.reservation.providerKey='NEVER_REFLECT_DUMMY_SECRET';},f=>{f.reservation.target.command='NEVER_REFLECT_DUMMY_SECRET';},f=>{f.source.url='https://attacker.invalid/script';},f=>{f.source.files['../escape.py']=f.source.files['host_policy.py'];}]){
  const f=await fixture();mutate(f);await assert.rejects(renderHostInventory(f),error=>!error.message.includes('NEVER_REFLECT')&&!error.message.includes('attacker.invalid'));
 }
});
test('only the exact prepared image517 A100 target and preserved hourly ceiling are eligible',async()=>{
 assert.equal(HOST_INVENTORY_PROFILE.imageId,517);assert.equal(HOST_INVENTORY_PROFILE.flavorId,100);
 for(const patch of [{imageId:574},{imageId:'517'},{imageName:'Ubuntu latest'},{flavorId:111},{flavorName:'n3-RTX-A6000x1'},{region:'NORWAY-1'},{maximumHourlyUSD:1.36001},{maximumHourlyUSD:NaN},{maximumHourlyUSD:0},{environmentId:-1},{environmentId:1.1},{keyName:'bad\ncommand'},{inferenceOrigin:'https://attacker.invalid'}]){
  const f=await fixture();Object.assign(f.reservation.target,patch);await assert.rejects(renderHostInventory(f),/HOST_INVENTORY_TARGET_INVALID/);
 }
});
test('reservation identity, source image and all original time bindings are mandatory',async()=>{
 for(const mutate of [f=>{f.sessionId='../escape';},f=>{f.sessionId='11111111-1111-0111-0111-111111111111';},f=>{f.reservation.nonce='b'.repeat(32);},f=>{f.reservation.kind='inventory';},f=>{f.reservation.provider='runpod';},f=>{f.reservation.ownershipPolicy='labels-v1';},f=>{f.reservation.minutes=60;},f=>{f.reservation.image='image:latest';},f=>{f.reservation.image=HOST_INVENTORY_SERVING_IMAGE.replace(/.$/,'9');},f=>{f.reservation.deadline+=1;},f=>{f.reservation.createdNotAfter+=1;},f=>{f.reservation.windowStart=new Date(NOW+1).toISOString();},f=>{f.now=NOW-1;},f=>{f.now=NOW+300001;},f=>{f.now=f.reservation.deadline;},f=>{f.now=NaN;}]){
  const f=await fixture();mutate(f);await assert.rejects(renderHostInventory(f));
 }
});
test('fixed source schema, canonical base64, UTF8 and independent byte limits fail closed',async()=>{
 for(const mutate of [f=>{delete f.source.files['inventory_deadline.py'];},f=>{f.source.version=2;},f=>{f.source.files['host_policy.py']='';},f=>{f.source.files['host_policy.py']='Zh==';},f=>{f.source.files['host_policy.py']='!!!!';},f=>{f.source.files['host_policy.py']=Buffer.from([255]).toString('base64');},f=>{f.source.files['host_policy.py']=Buffer.from('a\0b').toString('base64');},f=>{f.source.files['host_policy.py']=Buffer.alloc(32769,35).toString('base64');},f=>{for(const name of HOST_INVENTORY_FILES)f.source.files[name]=Buffer.alloc(13000,35).toString('base64');}]){
  const f=await fixture();mutate(f);await assert.rejects(renderHostInventory(f),/HOST_INVENTORY_SOURCE_/);
 }
 const f=await fixture();for(const name of HOST_INVENTORY_FILES)f.source.files[name]=Buffer.alloc(10000,35).toString('base64');f.sourceSHA256=await hostInventorySourceSHA256(f.source);await assert.rejects(renderHostInventory(f),/HOST_INVENTORY_USER_DATA_LIMIT/);
});
test('generated fixed launcher compiles without execution and manifest passes actual host parser',async()=>{
 const f=await fixture(),c=config(await renderHostInventory(f)),w=writes(c);
 const compile=spawnSync('python3',['-I','-B','-c','import sys;compile(sys.stdin.read(),"inventory-launcher","exec");print("COMPILED_WITHOUT_EXECUTION")'],{input:launcher(c),encoding:'utf8',timeout:5000});assert.equal(compile.status,0,compile.stderr);assert.match(compile.stdout,/COMPILED_WITHOUT_EXECUTION/);
 const command='import json,sys\nsys.path.insert(0,sys.argv[1]);from host_policy import manifest_from\nmanifest_from(json.load(sys.stdin));print("HOST_MANIFEST_VERIFIED")';
 const parsed=spawnSync('python3',['-I','-B','-c',command,fileURLToPath(new URL('../../../vm/',import.meta.url))],{input:w['/etc/unjailed/session.json'],encoding:'utf8',timeout:5000});assert.equal(parsed.status,0,parsed.stderr);assert.match(parsed.stdout,/HOST_MANIFEST_VERIFIED/);
});
test('host-side launcher independently refuses source/session/unit tampering before timer or probe execution',async()=>{
 const f=await fixture(),c=config(await renderHostInventory(f)),w=writes(c),payload={source:launcher(c),files:Object.fromEntries(Object.entries(w).map(([name,value])=>[name,value.toString('base64')])),now:NOW/1000};
 // Execute the actual generated verifier with an in-memory root filesystem and
 // recording process adapters. No source file, systemd command or probe runs.
 const command=`import base64,json,stat,sys,types
x=json.load(sys.stdin);scope={'__name__':'fixture'};exec(x['source'],scope)
files={name:base64.b64decode(value) for name,value in x['files'].items()}
class FakePath:
 def __init__(self,name):self.name=name
 def lstat(self):return types.SimpleNamespace(st_mode=stat.S_IFDIR|0o755,st_uid=0)
calls=[]
def run(args,**kwargs):
 calls.append(args)
 if x.get('failTimer'):raise ValueError('dummy timer failure')
def execute(path,args,env):calls.append(['EXEC',path,*args]);return None
scope['Path']=FakePath;scope['root_bytes']=lambda path,limit:files[path]
scope['os']=types.SimpleNamespace(geteuid=lambda:0,execve=execute)
scope['subprocess']=types.SimpleNamespace(run=run,DEVNULL=-3)
scope['time']=types.SimpleNamespace(time=lambda:x['now'])
try:scope['main']();outcome='verified'
except Exception:outcome='refused'
print(json.dumps({'outcome':outcome,'calls':calls}))`;
 const attempt=patch=>{
  const r=spawnSync('python3',['-I','-B','-c',command],{input:JSON.stringify({...payload,...patch}),encoding:'utf8',timeout:5000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
 };
 const good=attempt({});assert.equal(good.outcome,'verified');assert.equal(good.calls.length,4);assert.equal(good.calls[3][0],'EXEC');assert(good.calls[3].includes(f.sourceSHA256));
 for(const name of ['/opt/unjailed/vm/prepared_host.py','/etc/unjailed/session.json','/etc/systemd/system/unjailed-inventory-deadline.service']){
  const files={...payload.files,[name]:Buffer.from('tampered').toString('base64')},bad=attempt({files});assert.equal(bad.outcome,'refused');assert.deepEqual(bad.calls,[]);
 }
 const expired=attempt({now:f.reservation.deadline/1000});assert.equal(expired.outcome,'refused');assert.deepEqual(expired.calls,[]);
 const timer=attempt({failTimer:true});assert.equal(timer.outcome,'refused');assert.equal(timer.calls.length,1);assert(!timer.calls.some(args=>args[0]==='EXEC'));
});
test('the actual credential-free probe source fits provider userdata without network or model initialization',async()=>{
 const f=await fixture();f.source={version:1,files:Object.fromEntries(HOST_INVENTORY_FILES.map(name=>[name,readFileSync(new URL('../../../vm/'+name,import.meta.url)).toString('base64')]))};f.sourceSHA256=await hostInventorySourceSHA256(f.source);
 const text=await renderHostInventory(f);assert(Math.ceil(Buffer.byteLength(text)/3)*4<=65535);assert.equal(config(text).write_files.length,7);
});
