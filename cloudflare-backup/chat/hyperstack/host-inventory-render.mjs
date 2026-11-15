// Pure, credential-free rendering for one separately approved native inventory.
// Inventory never establishes CUDA, isolation, model readiness or a model permit.
export const HOST_INVENTORY_FILES=Object.freeze(['host_policy.py','prepared_host.py','host_inventory_probe.py','inventory_deadline.py']);
export const HOST_INVENTORY_PROFILE=Object.freeze({id:'hyperstack-prepared-r570-inventory-v1',provider:'hyperstack',region:'CANADA-1',imageId:517,imageName:'Ubuntu Server 24.04 LTS R570 CUDA 12.8 with Docker',flavorId:100,flavorName:'n3-A100x1',maximumHourlyUSD:1.36});
export const HOST_INVENTORY_SERVING_IMAGE='ghcr.io/benjamin-alemany/huihui-qwen3-8b-v2@sha256:86b61fca502d259910c36ec372c31adf59e0fb4495371904acc20f6bde535278';
const MAX_FILE=32*1024,MAX_SOURCE=48*1024,MAX_USER_DATA_BASE64=65535;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&(Object.getPrototypeOf(x)===Object.prototype||Object.getPrototypeOf(x)===null);
const exact=(x,fields)=>plain(x)&&Object.keys(x).sort().join()===fields.slice().sort().join();
const canonical=x=>JSON.stringify(x,(_key,value)=>plain(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value);
const refuse=code=>{throw Error(code);};
const time=x=>Number.isSafeInteger(x)&&x>=0&&x<=8_640_000_000_000_000;
const text=x=>typeof x==='string'&&x.length>0&&x.length<=160&&!/[\x00-\x1f\x7f]/.test(x);
function base64(bytes){let binary='';for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(binary);}
const encoded=text=>base64(new TextEncoder().encode(text));
async function digest(bytes){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('');}
function decoded(value){
 if(typeof value!=='string'||!value.length||value.length%4||value.length>Math.ceil(MAX_FILE/3)*4||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))refuse('HOST_INVENTORY_SOURCE_INVALID');
 let bytes;try{bytes=Uint8Array.from(atob(value),char=>char.charCodeAt(0));}catch{refuse('HOST_INVENTORY_SOURCE_INVALID');}
 if(!bytes.length||bytes.length>MAX_FILE||base64(bytes)!==value||bytes.includes(0))refuse('HOST_INVENTORY_SOURCE_INVALID');
 try{new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{refuse('HOST_INVENTORY_SOURCE_INVALID');}
 return bytes;
}
function sourceFiles(source){
 if(!exact(source,['version','files'])||source.version!==1||!exact(source.files,HOST_INVENTORY_FILES))refuse('HOST_INVENTORY_SOURCE_INVALID');
 const files={};let total=0;
 for(const name of HOST_INVENTORY_FILES){const bytes=decoded(source.files[name]);total+=bytes.length;if(total>MAX_SOURCE)refuse('HOST_INVENTORY_SOURCE_LIMIT');files[name]=bytes;}
 return files;
}
// The caller must obtain the expected digest independently from its reviewed
// release pin. Computing a digest does not approve a source or authorize a VM.
export function canonicalHostInventorySource(source){sourceFiles(source);return canonical(source);}
export async function hostInventorySourceSHA256(source){return digest(new TextEncoder().encode(canonicalHostInventorySource(source)));}
function reservationFrom(r,now){
 const fields=['kind','provider','ownershipPolicy','minutes','name','image','nonce','target','createdNotBefore','createdNotAfter','deadline','windowStart','windowEnd'];
 if(!exact(r,fields)||r.kind!=='chat'||r.provider!=='hyperstack'||r.ownershipPolicy!=='nonce-name-v2'||r.minutes!==30||!/^[a-f0-9]{32}$/.test(r.nonce??'')||r.name!=='unjailed-chat-'+r.nonce||r.image!==HOST_INVENTORY_SERVING_IMAGE)refuse('HOST_INVENTORY_RESERVATION_INVALID');
 const t=r.target,p=HOST_INVENTORY_PROFILE;
 if(!exact(t,['environmentId','environmentName','region','flavorId','flavorName','imageId','imageName','keyName','inferenceOrigin','maximumHourlyUSD'])||!Number.isSafeInteger(t.environmentId)||t.environmentId<=0||!text(t.environmentName)||!text(t.keyName)||t.region!==p.region||t.flavorId!==p.flavorId||t.flavorName!==p.flavorName||t.imageId!==p.imageId||t.imageName!==p.imageName||t.inferenceOrigin!=='https://inference.unjailed.work'||typeof t.maximumHourlyUSD!=='number'||!Number.isFinite(t.maximumHourlyUSD)||t.maximumHourlyUSD<=0||t.maximumHourlyUSD>p.maximumHourlyUSD)refuse('HOST_INVENTORY_TARGET_INVALID');
 if(!time(now)||!time(r.createdNotBefore)||!time(r.createdNotAfter)||!time(r.deadline)||r.createdNotAfter!==r.createdNotBefore+300000||r.deadline!==r.createdNotBefore+1800000||r.windowStart!==new Date(r.createdNotBefore).toISOString()||r.windowEnd!==new Date(r.createdNotAfter).toISOString()||now<r.createdNotBefore||now>r.createdNotAfter||now>=r.deadline)refuse('HOST_INVENTORY_TIME_INVALID');
 return r;
}
function launcher(expected){
 // All paths/argv are fixed. Expected contains only public hashes and binding
 // times; no shell, URL, runtime mode, secret or command comes from the caller.
 return `import base64,hashlib,json,os,stat,subprocess,time
from pathlib import Path
EXPECTED=json.loads(base64.b64decode('${encoded(canonical(expected))}'))
FILES=${JSON.stringify(HOST_INVENTORY_FILES)}
ENV={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C'}
def refuse():raise ValueError('Host inventory refused')
def root_bytes(path,limit):
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  info=os.fstat(fd)
  if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o077 or not 0<info.st_size<=limit:refuse()
  with os.fdopen(fd,'rb',closefd=False) as stream:data=stream.read(limit+1)
  if len(data)!=info.st_size or len(data)>limit:refuse()
  return data
 finally:os.close(fd)
def main():
 if os.geteuid()!=0:refuse()
 for name in ['/etc','/etc/unjailed','/opt','/opt/unjailed','/opt/unjailed/vm','/etc/systemd','/etc/systemd/system']:
  info=Path(name).lstat()
  if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:refuse()
 files={}
 for name in FILES:
  data=root_bytes('/opt/unjailed/vm/'+name,${MAX_FILE})
  if hashlib.sha256(data).hexdigest()!=EXPECTED['files'][name]:refuse()
  files[name]=base64.b64encode(data).decode('ascii')
 payload=json.dumps({'version':1,'files':files},sort_keys=True,separators=(',',':')).encode()
 if hashlib.sha256(payload).hexdigest()!=EXPECTED['sourceSHA256']:refuse()
 manifest=root_bytes('/etc/unjailed/session.json',4096)
 if hashlib.sha256(manifest).hexdigest()!=EXPECTED['sessionSHA256']:refuse()
 for name,value in EXPECTED['units'].items():
  if hashlib.sha256(root_bytes('/etc/systemd/system/'+name,4096)).hexdigest()!=value:refuse()
 if not EXPECTED['createdAt']/1000<=time.time()<EXPECTED['deadline']/1000:refuse()
 for args in [['/usr/bin/systemctl','daemon-reload'],['/usr/bin/systemctl','enable','--now','unjailed-inventory-deadline.timer'],['/usr/bin/systemctl','is-active','--quiet','unjailed-inventory-deadline.timer']]:
  subprocess.run(args,check=True,timeout=10,env=ENV,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 if not EXPECTED['createdAt']/1000<=time.time()<EXPECTED['deadline']/1000:refuse()
 os.execve('/usr/bin/python3',['/usr/bin/python3','-I','-B','/opt/unjailed/vm/host_inventory_probe.py','--execute','--source-sha256',EXPECTED['sourceSHA256']],ENV)
if __name__=='__main__':
 try:main()
 except Exception:raise SystemExit('Host inventory refused; no model or fallback')
`;
}
export async function renderHostInventory(input){
 const required=['reservation','sessionId','source','sourceSHA256'];
 if(!plain(input)||!exact(input,[...required,...(Object.hasOwn(input,'now')?['now']:[])]))refuse('HOST_INVENTORY_ARGUMENTS_INVALID');
 const {sessionId,source,sourceSHA256}=input,now=Object.hasOwn(input,'now')?input.now:Date.now();
 if(!UUID.test(sessionId??'')||!HASH.test(sourceSHA256??'')||sourceSHA256==='0'.repeat(64))refuse('HOST_INVENTORY_SOURCE_UNPINNED');
 const r=reservationFrom(input.reservation,now),files=sourceFiles(source);
 if(await hostInventorySourceSHA256(source)!==sourceSHA256)refuse('HOST_INVENTORY_SOURCE_MISMATCH');
 const manifest={version:1,sessionId,nonce:r.nonce,createdAt:new Date(r.createdNotBefore).toISOString(),deadlineUTC:new Date(r.deadline).toISOString(),image:r.image,resources:{vmId:null,publicIpAddress:null,volumeIds:[]}},manifestText=canonical(manifest);
 const calendar=new Date(r.deadline).toISOString().replace('T',' ').replace('Z',' UTC');
 const units={
  'unjailed-inventory-deadline.timer':'[Unit]\nDescription=Immutable local inventory deadline\n[Timer]\nOnCalendar='+calendar+'\nPersistent=true\nAccuracySec=1s\nRandomizedDelaySec=0\nUnit=unjailed-inventory-deadline.service\n[Install]\nWantedBy=timers.target\n',
  'unjailed-inventory-deadline.service':'[Unit]\nDescription=Power off inventory VM at immutable deadline\n[Service]\nType=oneshot\nTimeoutStartSec=20\nExecStart=/usr/bin/python3 -I -B /opt/unjailed/vm/inventory_deadline.py\n'
 };
 const hashes={};for(const name of HOST_INVENTORY_FILES)hashes[name]=await digest(files[name]);
 const unitHashes={};for(const [name,value]of Object.entries(units))unitHashes[name]=await digest(new TextEncoder().encode(value));
 const expected={sourceSHA256,files:hashes,units:unitHashes,sessionSHA256:await digest(new TextEncoder().encode(manifestText)),createdAt:r.createdNotBefore,deadline:r.deadline};
 const write=(path,content)=>({path,owner:'root:root',permissions:'0600',encoding:'b64',content});
 const config={ssh_pwauth:false,disable_root:true,bootcmd:[['/usr/bin/systemctl','mask','--now','ssh.service','ssh.socket']],write_files:[
  write('/etc/unjailed/session.json',encoded(manifestText)),
  ...HOST_INVENTORY_FILES.map(name=>write('/opt/unjailed/vm/'+name,source.files[name])),
  ...Object.entries(units).map(([name,value])=>write('/etc/systemd/system/'+name,encoded(value)))
 ],runcmd:[['/usr/bin/python3','-I','-B','-c',launcher(expected)]]};
 const output='#cloud-config\n'+JSON.stringify(config)+'\n';
 if(Math.ceil(new TextEncoder().encode(output).byteLength/3)*4>MAX_USER_DATA_BASE64)refuse('HOST_INVENTORY_USER_DATA_LIMIT');
 return output;
}
