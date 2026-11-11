import {hyperstackLifecycle} from './controller-policy.mjs';
import {validateReservation} from './policy.mjs';

// Static source paths only. This is a gzip JSON file map, not an executable tar
// archive; links, modes, owners and arbitrary destinations cannot be supplied.
export const BOOTSTRAP_FILES=Object.freeze(['bootstrap.py','bootstrap.service','host_policy.py','metadata.py','packages.lock.json','daemon.json','deadline.py','keys/cuda.gpg','keys/docker.gpg','keys/toolkit.gpg']);
export const RUNTIME_FILES=Object.freeze(['attestation.py','native_attest.py','attach_model_network.py','attach_model_network.sh','seal_boundary.py','boundary.service','tunnel.service','run.py','runtime.service','gateway.py','gateway.service','preflight.py','egress_probe.py','linux_fixture.py','linux_fixture.sh','inference_policy.py','cloudflared.lock.json']);
const ALLOWED=Object.freeze([...BOOTSTRAP_FILES,...RUNTIME_FILES]);
const MAX_EXPANDED=256*1024,MAX_COMPRESSED=256*1024,MAX_FILE=128*1024;
const hash=/^[a-f0-9]{64}$/,uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const exact=(o,keys)=>o!==null&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join()===keys.slice().sort().join();
function refuse(code){throw Error(code);}
const canonical=o=>JSON.stringify(o,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(k=>[k,value[k]])):value);
function encode(bytes){let binary='';for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(binary);}
const encodedText=text=>encode(new TextEncoder().encode(text));
function decode(text,max){
  if(typeof text!=='string'||!text.length||text.length%4||text.length>Math.ceil(max/3)*4||!/^[A-Za-z0-9+/]*={0,2}$/.test(text))refuse('BOOTSTRAP_BASE64_INVALID');
  let bytes;try{bytes=Uint8Array.from(atob(text),c=>c.charCodeAt(0));}catch{refuse('BOOTSTRAP_BASE64_INVALID');}
  if(bytes.length>max||encode(bytes)!==text)refuse('BOOTSTRAP_BASE64_INVALID');return bytes;
}
async function sha256(bytes){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');}
async function expandedJSON(stream){
  const reader=stream.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let size=0,text='';
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_EXPANDED)refuse('BOOTSTRAP_BUNDLE_LIMIT');text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  const doc=JSON.parse(text);
  // Canonical JSON from a fixed builder makes duplicate/hidden keys, alternate
  // encodings and ignored trailing whitespace fail before any provider POST.
  if(canonical(doc)!==text)refuse('BOOTSTRAP_BUNDLE_NONCANONICAL');return doc;
}
function structurallyPinned(release,bundle){
  return exact(bundle,['sha256','gzipBase64'])&&hash.test(bundle.sha256??'')&&release?.artifact?.bootstrapBundleSha256===bundle.sha256&&hash.test(release?.artifact?.bootstrapLockSha256??'')&&/^[a-f0-9]{40}$/.test(release?.artifact?.bootstrapSourceCommit??'')&&Number.isSafeInteger(release?.artifact?.bootstrapBundleSize)&&release.artifact.bootstrapBundleSize>0&&release.artifact.bootstrapBundleSize<=MAX_COMPRESSED&&['candidate','verified'].includes(release?.status)&&/^ghcr\.io\/benjamin-alemany\/huihui-qwen3-8b-v2@sha256:[a-f0-9]{64}$/.test(release?.artifact?.servingImage??'');
}
// Structural source gate only. This never claims a VM, driver, network, model,
// gateway or tunnel is ready; renderCloudInit performs full bounded verification.
export function bootstrapRenderReady(release,bundle){try{if(!structurallyPinned(release,bundle))return false;const raw=decode(bundle.gzipBase64,MAX_COMPRESSED);return raw.length===release.artifact.bootstrapBundleSize&&raw[0]===31&&raw[1]===139;}catch{return false;}}
async function verifiedBundle(release,bundle){
  if(!bootstrapRenderReady(release,bundle))refuse('BOOTSTRAP_BUNDLE_UNPINNED');
  const compressed=decode(bundle.gzipBase64,MAX_COMPRESSED);if(await sha256(compressed)!==bundle.sha256)refuse('BOOTSTRAP_BUNDLE_HASH_MISMATCH');
  let doc;try{const stream=new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));doc=await expandedJSON(stream);}catch{refuse('BOOTSTRAP_BUNDLE_INVALID');}
  if(!exact(doc,['version','files'])||doc.version!==1||!doc.files||typeof doc.files!=='object'||Array.isArray(doc.files))refuse('BOOTSTRAP_BUNDLE_INVALID');
  const names=Object.keys(doc.files);if(names.some(n=>!ALLOWED.includes(n))||BOOTSTRAP_FILES.some(n=>!Object.hasOwn(doc.files,n)))refuse('BOOTSTRAP_FILE_SET_INVALID');
  const files={};let total=0;for(const name of names){const raw=decode(doc.files[name],MAX_FILE);total+=raw.length;if(total>MAX_EXPANDED)refuse('BOOTSTRAP_BUNDLE_LIMIT');files[name]=raw;}
  if(await sha256(files['packages.lock.json'])!==release.artifact.bootstrapLockSha256)refuse('BOOTSTRAP_PACKAGE_LOCK_MISMATCH');
  return names;
}
function tunnelCredential(value){
  if(!exact(value,['TunnelID','AccountTag','TunnelSecret'])||!uuid.test(value.TunnelID??'')||!/^[a-f0-9]{32}$/.test(value.AccountTag??''))refuse('BOOTSTRAP_TUNNEL_CREDENTIAL_INVALID');
  if(decode(value.TunnelSecret,32).length!==32)refuse('BOOTSTRAP_TUNNEL_CREDENTIAL_INVALID');
  return {TunnelID:value.TunnelID,AccountTag:value.AccountTag,TunnelSecret:value.TunnelSecret};
}
function installer(expected){
  // Expected contains public hashes/flags, never credentials. No shell, tar,
  // unbounded decompression, arbitrary URL, path or post-install command exists.
  return `import base64,gzip,hashlib,io,json,os,pwd,grp,re,stat,subprocess,time,urllib.request
from pathlib import Path
EXPECTED=json.loads(base64.b64decode('${encodedText(JSON.stringify(expected))}'))
REQUIRED=${JSON.stringify(BOOTSTRAP_FILES)}
ALLOWED=${JSON.stringify(ALLOWED)}
MAX_EXPANDED=${MAX_EXPANDED}
def refused():raise ValueError('Trusted bootstrap refused')
def unique(pairs):
 out={}
 for key,value in pairs:
  if key in out:refused()
  out[key]=value
 return out
def verify_bundle(raw,bundle_sha,lock_sha):
 if len(raw)>${MAX_COMPRESSED} or hashlib.sha256(raw).hexdigest()!=bundle_sha:refused()
 with gzip.GzipFile(fileobj=io.BytesIO(raw)) as stream:expanded=stream.read(MAX_EXPANDED+1)
 if len(expanded)>MAX_EXPANDED:refused()
 doc=json.loads(expanded,object_pairs_hook=unique)
 if json.dumps(doc,sort_keys=True,separators=(',',':')).encode()!=expanded:refused()
 if type(doc)is not dict or set(doc)!={'version','files'} or doc['version']!=1 or type(doc['files'])is not dict:refused()
 if not set(REQUIRED)<=set(doc['files']) or not set(doc['files'])<=set(ALLOWED):refused()
 files={}
 for name,encoded in doc['files'].items():
  if type(encoded)is not str:refused()
  data=base64.b64decode(encoded,validate=True)
  if not data or len(data)>${MAX_FILE} or base64.b64encode(data).decode()!=encoded:refused()
  files[name]=data
 if sum(map(len,files.values()))>MAX_EXPANDED or hashlib.sha256(files['packages.lock.json']).hexdigest()!=lock_sha:refused()
 return files
def download_bundle(opener=None):
 commit=EXPECTED['sourceCommit']
 if not re.fullmatch('[a-f0-9]{40}',commit):refused()
 url='https://raw.githubusercontent.com/benjamin-alemany/huihui-qwen3-8b-v2/'+commit+'/release/bootstrap.bundle.json.gz'
 class NoRedirect(urllib.request.HTTPRedirectHandler):
  def redirect_request(self,*args):refused()
 if opener is None:opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
 request=urllib.request.Request(url,headers={'User-Agent':'unjailed-pinned-bootstrap/1.0','Accept':'application/octet-stream'},method='GET')
 with opener.open(request,timeout=25) as response:
  if response.status!=200 or response.geturl()!=url:refused()
  raw=response.read(EXPECTED['bundleSize']+1)
 if len(raw)!=EXPECTED['bundleSize'] or len(raw)>${MAX_COMPRESSED} or hashlib.sha256(raw).hexdigest()!=EXPECTED['bundleSHA256']:refused()
 return raw
def safe_dir(path,mode=0o755):
 path=Path(path)
 for part in [*reversed(path.parents),path]:
  if part.exists() or part.is_symlink():
   s=part.lstat()
   if not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or s.st_mode&0o022:refused()
  else:part.mkdir(mode=mode)
 os.chmod(path,mode)
def root_file(path):
 p=Path(path);s=p.lstat()
 if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_mode&0o077:refused()
 return p
def write_file(path,data,mode=0o644):
 safe_dir(Path(path).parent)
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
 try:
  os.fchown(fd,0,0)
  with os.fdopen(fd,'wb',closefd=False) as out:out.write(data);out.flush();os.fsync(out.fileno())
 finally:os.close(fd)
def main():
 if os.geteuid()!=0:refused()
 safe_dir('/etc/unjailed',0o700);safe_dir('/var/lib/unjailed',0o700)
 manifest=root_file('/etc/unjailed/session.json').read_bytes()
 if hashlib.sha256(manifest).hexdigest()!=EXPECTED['sessionSHA256']:refused()
 session=json.loads(manifest,object_pairs_hook=unique)
 def stamp(s):return __import__('datetime').datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()
 if not stamp(session['createdAt'])<=time.time()<stamp(session['deadlineUTC']):refused()
 downloaded=download_bundle()
 if not stamp(session['createdAt'])<=time.time()<stamp(session['deadlineUTC']):refused()
 files=verify_bundle(downloaded,EXPECTED['bundleSHA256'],EXPECTED['lockSHA256'])
 write_file('/var/lib/unjailed/bootstrap-bundle.gz',downloaded,0o600)
 safe_dir('/opt/unjailed');safe_dir('/opt/unjailed/vm')
 for name in sorted(files):write_file('/opt/unjailed/vm/'+name,files[name])
 marker={'version':1,'sha256':EXPECTED['bundleSHA256'],'files':{name:hashlib.sha256(data).hexdigest() for name,data in files.items()}}
 write_file('/var/lib/unjailed/bootstrap-bundle.json',json.dumps(marker,sort_keys=True,separators=(',',':')).encode(),0o600)
 try:g=grp.getgrgid(10002)
 except KeyError:subprocess.run(['/usr/sbin/groupadd','--gid','10002','unjailed-host'],check=True);g=grp.getgrgid(10002)
 if g.gr_name!='unjailed-host':refused()
 try:u=pwd.getpwuid(10002)
 except KeyError:subprocess.run(['/usr/sbin/useradd','--uid','10002','--gid','10002','--system','--no-create-home','--shell','/usr/sbin/nologin','unjailed-host'],check=True);u=pwd.getpwuid(10002)
 if u.pw_name!='unjailed-host' or u.pw_gid!=10002 or u.pw_shell!='/usr/sbin/nologin':refused()
 for name in ['session.json','inference.env','gateway.json','tunnel.json','tunnel.yml']:root_file('/etc/unjailed/'+name)
 os.chown('/etc/unjailed',0,10002);os.chmod('/etc/unjailed',0o750)
 os.chown('/etc/unjailed/gateway.json',0,10002);os.chmod('/etc/unjailed/gateway.json',0o640)
 safe_dir('/var/lib/unjailed',0o700)
 if EXPECTED['enableRuntime']:
  for source,target in [('runtime.service','unjailed-runtime.service'),('gateway.service','unjailed-gateway.service'),('tunnel.service','unjailed-tunnel.service')]:write_file('/etc/systemd/system/'+target,files[source])
  subprocess.run(['/usr/bin/systemctl','daemon-reload'],check=True)
  subprocess.run(['/usr/bin/systemctl','enable','unjailed-runtime.service'],check=True)
 # Bootstrap arms the original timer, installs exact packages, reboots once,
 # then stops HOST_READY_MODEL_NOT_STARTED. A source-pinned runtime service,
 # when separately reviewed, may run only after that bootstrap on next boot.
 os.execve('/usr/bin/python3',['/usr/bin/python3','-I','-B','/opt/unjailed/vm/bootstrap.py','--execute'],{'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C'})
if __name__=='__main__':
 try:main()
 except Exception:raise SystemExit('Trusted bootstrap installer refused; no fallback')
`;
}

export async function renderCloudInit({reservation,session,release,bundle,hostTunnelCredential,now=Date.now()}={}){
  const s=session;
  if(!exact(s,['id','nonce','phase','createAttempted','stopRequested','inferenceKey','modelKey','reservation','bootAt','deadline','quote'])||!exact(s.quote,['minutes'])||!uuid.test(s.id??'')||s.phase!=='reconciling'||s.createAttempted!==true||s.stopRequested!==false||!/^[a-f0-9]{64}$/.test(s.inferenceKey??'')||!/^[a-f0-9]{64}$/.test(s.modelKey??'')||s.inferenceKey===s.modelKey)refuse('BOOTSTRAP_SESSION_INVALID');
  let q,own;try{q=validateReservation(reservation);own=validateReservation(s.reservation);}catch{refuse('BOOTSTRAP_RESERVATION_INVALID');}
  if(canonical(q)!==canonical(own)||s.nonce!==q.nonce||s.bootAt!==q.createdNotBefore||s.deadline!==q.deadline||s.quote.minutes!==q.minutes||!Number.isSafeInteger(now)||now<q.createdNotBefore||now>q.createdNotAfter||now>=q.deadline)refuse('BOOTSTRAP_SESSION_BINDING_INVALID');
  const lifecycle=hyperstackLifecycle({target:q.target,release});if(lifecycle.image!==q.image)refuse('BOOTSTRAP_RELEASE_MISMATCH');
  const names=await verifiedBundle(release,bundle),credential=tunnelCredential(hostTunnelCredential);
  const enableRuntime=release.artifact.runtimeOrchestrator==='vm-run-v1';
  if(release.artifact.runtimeOrchestrator!==undefined&&release.artifact.runtimeOrchestrator!==null&&!enableRuntime)refuse('BOOTSTRAP_RUNTIME_UNREVIEWED');
  if(enableRuntime&&RUNTIME_FILES.some(n=>!names.includes(n)))refuse('BOOTSTRAP_RUNTIME_FILES_MISSING');
  const manifest={version:1,sessionId:s.id,nonce:q.nonce,createdAt:new Date(q.createdNotBefore).toISOString(),deadlineUTC:new Date(q.deadline).toISOString(),image:q.image,resources:{vmId:null,publicIpAddress:null,volumeIds:[]}};
  const manifestText=canonical(manifest),sessionSHA256=await sha256(new TextEncoder().encode(manifestText));
  const gateway={version:1,sessionId:s.id,nonce:q.nonce,createdAt:manifest.createdAt,deadlineUTC:manifest.deadlineUTC,servingImage:q.image,bootstrapLockSha256:release.artifact.bootstrapLockSha256,bootstrapBundleSha256:bundle.sha256,model:{name:release.model.repository,revision:release.model.revision},gatewayKey:s.inferenceKey,modelKey:s.modelKey};
  const modelEnv=`VLLM_API_KEY=${s.modelKey}\nCHAT_CLOUD_GUARDS_VERIFIED=true\nCHAT_RESERVED_AT=${manifest.createdAt}\nCHAT_DEADLINE_UTC=${manifest.deadlineUTC}\n`;
  const tunnel=`tunnel: ${credential.TunnelID}\ncredentials-file: /run/credentials/unjailed-tunnel.service/tunnel.json\ningress:\n  - hostname: inference.unjailed.work\n    service: http://127.0.0.1:8765\n  - service: http_status:404\n`;
  const write=(path,content)=>({path,owner:'root:root',permissions:'0600',encoding:'b64',content:encodedText(content)});
  const config={ssh_pwauth:false,disable_root:true,bootcmd:[['/usr/bin/systemctl','mask','--now','ssh.service','ssh.socket']],write_files:[
    write('/etc/unjailed/session.json',manifestText),write('/etc/unjailed/inference.env',modelEnv),write('/etc/unjailed/gateway.json',canonical(gateway)),write('/etc/unjailed/tunnel.json',canonical(credential)),write('/etc/unjailed/tunnel.yml',tunnel),
    write('/var/lib/unjailed/install-bootstrap.py',installer({bundleSHA256:bundle.sha256,bundleSize:release.artifact.bootstrapBundleSize,sourceCommit:release.artifact.bootstrapSourceCommit,lockSHA256:release.artifact.bootstrapLockSha256,sessionSHA256,enableRuntime}))
  ],runcmd:[['/usr/bin/python3','-I','-B','/var/lib/unjailed/install-bootstrap.py']]};
  const output='#cloud-config\n'+JSON.stringify(config)+'\n';
  if(Math.ceil(new TextEncoder().encode(output).length/3)*4>65535)refuse('BOOTSTRAP_USER_DATA_LIMIT');
  return output;
}
