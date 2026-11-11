"""One-shot trusted VM runtime. No cloud/provider API or arbitrary project code.

Not a provisioner. The immutable host and both external destroy guards must
already exist. Every startup stage consumes the original session deadline.
"""
import fcntl,hashlib,json,os,re,signal,socket,stat,subprocess,sys,threading,time,urllib.request
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from host_policy import Refused,root_file,manifest_from,atomic,timestamp,docker_arguments
from attestation import context_digest,protected
from gateway import config_from,strict_json,protected_group_file,MODEL,REVISION
from egress_probe import EXPECTED_CHECKS
HERE=Path(__file__).resolve().parent
ENV={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C'}
STATE=Path('/var/lib/unjailed/runtime.json')

def bundle_verified(config):
 marker=json.loads(root_file('/var/lib/unjailed/bootstrap-bundle.json').read_text())
 if not isinstance(marker,dict) or set(marker)!={'version','sha256','files'} or marker['version']!=1 or marker['sha256']!=config['bootstrapBundleSha256'] or not isinstance(marker['files'],dict):raise Refused('Runtime source bundle not pinned')
 actual={str(p.relative_to(HERE)) for p in HERE.rglob('*') if p.is_file()}
 if actual!=set(marker['files']):raise Refused('Installed runtime source inventory differs from bundle')
 for name,digest in marker['files'].items():
  if not re.fullmatch('[0-9a-f]{64}',digest) or name.startswith('/') or '..' in Path(name).parts:raise Refused('Invalid bundle file inventory')
  p=HERE/name;info=p.lstat()
  if stat.S_ISLNK(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022 or hashlib.sha256(p.read_bytes()).hexdigest()!=digest:raise Refused('Installed runtime source changed')
 if hashlib.sha256((HERE/'packages.lock.json').read_bytes()).hexdigest()!=config['bootstrapLockSha256']:raise Refused('Bootstrap package lock changed')
 return True

def install_cloudflared():
 lock=json.loads((HERE/'cloudflared.lock.json').read_text())
 if set(lock)!={'version','release','url','sha256','size'} or lock['version']!=1 or not re.fullmatch(r'https://github\.com/cloudflare/cloudflared/releases/download/[0-9]{4}\.[0-9]+\.[0-9]+/cloudflared-linux-amd64',lock['url']) or not re.fullmatch('[0-9a-f]{64}',lock['sha256']) or type(lock['size']) is not int or not 0<lock['size']<64*1024**2:raise Refused('Cloudflared asset is not pinned')
 target=Path('/usr/local/bin/cloudflared')
 if target.exists():
  info=target.lstat()
  if stat.S_ISLNK(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022 or hashlib.sha256(target.read_bytes()).hexdigest()!=lock['sha256']:raise Refused('Unexpected existing cloudflared binary')
  return
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
 with opener.open(lock['url'],timeout=60) as response:
  # GitHub's official release redirects to a signed assets URL. TLS and the
  # reviewed exact artifact hash are mandatory; no response is executed here.
  if response.geturl().split(':',1)[0]!='https':raise Refused('Cloudflared asset downgrade')
  data=response.read(lock['size']+1)
 if len(data)!=lock['size'] or hashlib.sha256(data).hexdigest()!=lock['sha256']:raise Refused('Cloudflared asset bytes changed')
 temporary=target.with_name('cloudflared.unjailed-pending')
 with temporary.open('xb') as f:f.write(data);f.flush();os.fsync(f.fileno())
 temporary.chmod(0o755);os.replace(temporary,target)

class Canary:
 def __init__(self):self.sockets=[];self.threads=[];self.seen=0;self.closed=False
 def __enter__(self):
  for kind,port in [(socket.SOCK_STREAM,9090),(socket.SOCK_STREAM,53),(socket.SOCK_DGRAM,53)]:
   sock=socket.socket(socket.AF_INET,kind);sock.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);sock.bind(('10.203.0.1',port));sock.settimeout(.2)
   if kind==socket.SOCK_STREAM:sock.listen(4)
   self.sockets.append(sock)
   def serve(sock=sock,kind=kind):
    while not self.closed:
     try:
      if kind==socket.SOCK_STREAM:
       client,_=sock.accept()
       with client:
        client.settimeout(.2);data=client.recv(64)
        if data:self.seen+=1
        client.sendall(data)
      else:
       data,address=sock.recvfrom(64)
       if data:self.seen+=1
       sock.sendto(data,address)
     except OSError:pass
   thread=threading.Thread(target=serve,daemon=True);thread.start();self.threads.append(thread)
  return self
 def __exit__(self,*_):
  self.closed=True
  for sock in self.sockets:sock.close()
  for thread in self.threads:thread.join(timeout=1)

def preflight_from_logs(output,context):
 lines=[line.removeprefix('VM_PREFLIGHT ') for line in output.splitlines() if line.startswith('VM_PREFLIGHT ')]
 if not lines:return None
 if len(lines)!=1:raise Refused('Duplicate native preflight evidence')
 proof=strict_json(lines[0].encode())
 expected={'version':1,'kind':'vm-native-cuda-v1','offlineCacheVerified':True,'cudaReady':True,'modelLoaded':False,'agentToolsEnabled':False,'contextSHA256':context_digest(context)}
 if proof!=expected:raise Refused('Native model-free preflight did not pass')
 return proof

def main():
 if sys.argv[1:]!=['--execute'] or sys.platform!='linux' or os.geteuid()!=0:raise Refused('Approved one-shot Linux root runtime required')
 m=manifest_from(json.loads(root_file('/etc/unjailed/session.json').read_text()));name='uj-model-'+m['sessionId'];expiry=timestamp(m['deadlineUTC']);wall,mono=time.time(),time.monotonic()
 def interrupted(*_):raise Refused('Trusted startup interrupted; no retry')
 for number in [signal.SIGTERM,signal.SIGINT]:signal.signal(number,interrupted)
 def remaining():
  value=expiry-max(time.time(),wall+time.monotonic()-mono)
  if value<=0:raise Refused('Original immutable expiry reached')
  return value
 def run(args,seconds=120):
  r=subprocess.run(args,env=ENV,capture_output=True,text=True,timeout=max(.01,min(seconds,remaining())))
  if r.returncode:raise Refused('Trusted runtime command refused: '+args[0])
  return r.stdout.strip()
 Path('/var/lib/unjailed').mkdir(mode=0o700,parents=True,exist_ok=True)
 with Path('/var/lib/unjailed/runtime.lock').open('a') as lock:
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  if STATE.exists():raise Refused('Runtime already attempted; no automatic retry')
  state={'version':1,'sessionId':m['sessionId'],'nonce':m['nonce'],'deadlineUTC':m['deadlineUTC'],'phase':'preparing'};atomic(STATE,state)
  def save(phase):remaining();state['phase']=phase;atomic(STATE,state)
  try:
   c=config_from(strict_json(protected_group_file('/etc/unjailed/gateway.json').read_bytes()))
   if any(c[key]!=m[key] for key in ['sessionId','nonce','createdAt','deadlineUTC']) or c['servingImage']!=m['image']:raise Refused('Gateway config differs from allocation')
   boot=json.loads(root_file('/var/lib/unjailed/bootstrap.json').read_text())
   if boot['phase']!='host-ready-model-not-started' or boot['deadlineUTC']!=m['deadlineUTC']:raise Refused('Native driver bootstrap incomplete')
   bundle_verified(c);remaining()
   # Before sealing, only reviewed image/binary downloads. All startup costs
   # still consume the original deadline and the independent external guards.
   run(['docker','pull',m['image']],seconds=900);install_cloudflared();remaining()
   run(['/bin/bash',str(HERE/'linux_fixture.sh')],seconds=120)
   save('sealing');run(['/usr/bin/python3','-I','-B',str(HERE/'seal_boundary.py'),'--execute'])
   directory=Path('/run/unjailed');directory.chown(0,10002);directory.chmod(0o750)
   # gateway.json is root-written at install, gateway-group readable at runtime.
   config_path=Path('/etc/unjailed/gateway.json');config_path.chown(0,10002);config_path.chmod(0o640)
   args=docker_arguments(m);args[1]='create';run(args)
   run(['/usr/bin/python3','-I','-B',str(HERE/'native_attest.py'),'--prepare-context'])
   context=json.loads(root_file('/run/unjailed/attestations/'+m['sessionId']+'/context.json').read_text())
   run(['docker','start',name]);save('native-boundary')
   run(['/usr/bin/python3','-I','-B',str(HERE/'attach_model_network.py')])
   with Canary() as canary:
    # Positive control proves a real host endpoint; model attack observations
    # must remain zero, not merely claim errno from an absent service.
    with socket.create_connection(('10.203.0.1',9090),timeout=1) as sock:sock.sendall(b'DUMMY');assert sock.recv(5)==b'DUMMY'
    time.sleep(.05);before=canary.seen
    result=run(['docker','exec','--user','10001:10001',name,'python3','-I','-B','/opt/qwen/egress_probe.py'],seconds=30)
    match=re.fullmatch(r'EXTERNAL_EGRESS_PROBE (.+)',result)
    proof=strict_json(match[1].encode()) if match else None
    if proof!={'version':1,'checks':EXPECTED_CHECKS,'allDenied':True,'childPolicyInstalled':False,'modelLoaded':False,'agentToolsEnabled':False}:raise Refused('External native container egress probe refused')
    time.sleep(.1)
    if canary.seen!=before:raise Refused('Model reached a controlled host endpoint')
   input_rules=run(['nft','list','chain','inet','unjailed','input'])
   if not re.search(r'iifname "uj-m-host" counter packets [1-9][0-9]*',input_rules):raise Refused('Native host packet denial not independently observed')
   if run(['ip','-n','uj-model','route','show','default']) or run(['ip','-n','uj-model','-6','route','show','default']):raise Refused('Unexpected model route')
   run(['/usr/bin/python3','-I','-B',str(HERE/'native_attest.py'),'--seal-driver-metadata'])
   run(['/usr/bin/python3','-I','-B',str(HERE/'native_attest.py'),'--execute']);save('model-free-preflight')
   while True:
    remaining();logs=run(['docker','logs','--tail','100',name],seconds=10)
    if preflight_from_logs(logs,context):break
    if run(['docker','inspect','--format','{{.State.Running}}',name])!='true':raise Refused('Inference bootstrap exited')
    time.sleep(.5)
   validated={'version':1,'provider':'hyperstack','status':'validated',**{key:c[key] for key in ['sessionId','nonce','servingImage','bootstrapLockSha256','bootstrapBundleSha256','createdAt','deadlineUTC']},'runtimeProfile':'vm-inference-v1','sealed':True,'nativeAttestation':True,'privateNamespaces':True,'modelEgressDenied':True,'offlineCacheVerified':True,'cudaReady':True,'modelName':MODEL,'modelRevision':REVISION,'modelLoaded':False,'agentToolsEnabled':False}
   def write_ready(receipt):
    atomic('/run/unjailed/host-ready.json',receipt);ready=Path('/run/unjailed/host-ready.json');ready.chown(0,10002);ready.chmod(0o640)
   write_ready(validated)
   permissions=Path('/run/unjailed/permissions');permissions.mkdir(mode=0o700,exist_ok=False);permissions.chown(10002,10002)
   # Model supervisor remains blocked on its second root-only handoff. The
   # authenticated controller must independently seal/read back provider SGs
   # before requesting this exact permission through the trusted gateway.
   run(['systemctl','start','unjailed-gateway.service','unjailed-tunnel.service']);save('awaiting-provider-firewall-permit')
   request=permissions/'model-request.json'
   while not request.exists():
    remaining()
    if run(['docker','inspect','--format','{{.State.Running}}',name])!='true':raise Refused('Inference bootstrap exited before permit')
    time.sleep(.1)
   remaining();info=request.lstat()
   if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_uid!=10002 or info.st_mode&0o077 or info.st_size>1024:raise Refused('Trusted gateway permit file invalid')
   permit=strict_json(request.read_bytes());expected={'version':1,**{key:c[key] for key in ['sessionId','nonce','deadlineUTC']}}
   if permit!=expected:raise Refused('Gateway permit did not bind original session')
   remaining();atomic('/run/unjailed/attestations/'+m['sessionId']+'/model-permit.json',{**expected,'contextSHA256':context_digest(context)});save('model-starting')
   while True:
    remaining()
    probe=subprocess.run(['setpriv','--reuid','10002','--regid','10002','--clear-groups','--no-new-privs','/usr/bin/python3','-I','-B',str(HERE/'gateway.py'),'--probe-model'],env=ENV,capture_output=True,text=True,timeout=min(4,remaining()))
    if probe.returncode==0 and probe.stdout.strip()=='FIXED_PRIVATE_MODEL_HEALTH_PASSED':break
    if run(['docker','inspect','--format','{{.State.Running}}',name])!='true':raise Refused('Model startup failed')
    time.sleep(1)
   write_ready({**validated,'status':'ready','modelLoaded':True})
   save('ready');print('HOST_GATEWAY_READY_MODEL_CHAT_ONLY')
  except BaseException:
   state['phase']='failed';atomic(STATE,state)
   Path('/run/unjailed/host-ready.json').unlink(missing_ok=True)
   subprocess.run(['docker','stop','--time','3',name],env=ENV,capture_output=True,timeout=10)
   subprocess.run(['systemctl','stop','--no-block','unjailed-gateway.service','unjailed-tunnel.service'],env=ENV,capture_output=True,timeout=10)
   raise
if __name__=='__main__':
 try:main()
 except Exception:raise SystemExit('Trusted session runtime refused; no retry or unrestricted fallback')
