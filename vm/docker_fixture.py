"""Free Linux Docker CPU fixture only. No GPU, publication, model or provider API.

Root must review/authorize running this on a standard disposable Linux CI runner.
Never run it on the laptop: its build may pull the existing small public image.
"""
import datetime as dt,json,os,subprocess,sys,tempfile,uuid
from pathlib import Path
if sys.platform!='linux' or os.geteuid()!=0:raise SystemExit('Disposable Linux CPU fixture root only')
HERE=Path(__file__).resolve().parent;ROOT=HERE.parent
sys.path.insert(0,str(HERE))
from attestation import KINDS,context_digest
subprocess.run(['docker','build','--network=none','--platform','linux/amd64','-f',str(HERE/'Dockerfile.cpu'),'-t','unjailed-vm-cpu:fixture',str(ROOT)],check=True,timeout=300)
def docker(*args):return subprocess.check_output(['docker',*args],text=True,timeout=30).strip()
image_id=docker('image','inspect','--format','{{.Id}}','unjailed-vm-cpu:fixture')
with tempfile.TemporaryDirectory(prefix='unjailed-vm-dummy-') as directory:
 path=Path(directory);host={k:os.readlink('/proc/self/ns/'+k) for k in KINDS};(path/'host.json').write_text(json.dumps(host));(path/'resolv.conf').write_text('');path.chmod(0o755)
 for case in ['missing','forged','mismatched','valid']:
  handoff=path/case;handoff.mkdir(mode=0o700)
  now=dt.datetime.now(dt.timezone.utc);iso=lambda t:t.isoformat().replace('+00:00','Z')
  created=iso(now);deadline=iso(now+dt.timedelta(seconds=3 if case=='missing' else 30));canary='DUMMY-CONTROL-KEY-NEVER-REAL'
  args=['create','--network=none','--read-only','--cap-drop=ALL','--cap-add=SETUID','--cap-add=SETGID','--security-opt=no-new-privileges','--memory=512m','--cpus=1','--pids-limit=64','--ipc=private','--tmpfs=/tmp:rw,nosuid,nodev,mode=1777,size=64m','--tmpfs=/cache:rw,nosuid,nodev,uid=10001,gid=10001,mode=0700,size=16m','--tmpfs=/home/inference:rw,nosuid,nodev,uid=10001,gid=10001,mode=0700,size=8m','--mount=type=bind,source='+str(path/'host.json')+',target=/fixture-host-namespaces.json,readonly','--mount=type=bind,source='+str(path/'resolv.conf')+',target=/etc/resolv.conf,readonly','--mount=type=bind,source='+str(handoff)+',target=/run/unjailed/attestation,readonly','-e','RUNPOD_API_KEY='+canary,'-e','VLLM_API_KEY=DUMMY-'+('x'*43),'-e','CHAT_CLOUD_GUARDS_VERIFIED=true','-e','CHAT_RESERVED_AT='+created,'-e','CHAT_DEADLINE_UTC='+deadline,'unjailed-vm-cpu:fixture']
  cid=docker(*args)
  try:
   # This is deliberately dummy, root-produced CPU evidence. It verifies the
   # real handoff but does not call/claim the native GPU mount attestor.
   c={'version':1,'sessionId':str(uuid.uuid4()),'nonce':uuid.uuid4().hex,'createdAt':created,'deadlineUTC':deadline,'image':'ghcr.io/benjamin-alemany/huihui-qwen3-8b-v2@'+image_id,'imageId':image_id,'containerId':cid}
   context=handoff/'context.json';context.write_text(json.dumps(c));context.chmod(0o600)
   docker('start',cid);pid=int(docker('inspect','--format','{{.State.Pid}}',cid))
   if case!='missing':
    namespaces={kind:os.readlink('/proc/'+str(pid)+'/ns/'+kind) for kind in KINDS}
    r={'version':1,'kind':'vm-native-boundary-v1','contextSHA256':context_digest(c),'containerId':cid,'imageId':image_id,'namespaces':namespaces,'boundaryVerified':True}
    if case=='forged':r['contextSHA256']='0'*64
    if case=='mismatched':r['namespaces']={**namespaces,'net':'net:[1]'}
    receipt_path=handoff/'verified.json';temporary=handoff/'pending';temporary.write_text(json.dumps(r));temporary.chmod(0o600);os.replace(temporary,receipt_path)
   returncode=int(docker('wait',cid));logs=subprocess.run(['docker','logs',cid],capture_output=True,text=True,timeout=20);output=logs.stdout+logs.stderr
   assert canary not in output and 'DUMMY-'+('x'*43) not in output,'Dummy credential leaked'
   if case!='valid':
    assert returncode!=0 and 'VM_DOCKER_CPU_RECEIPT ' not in output,'Missing/invalid native receipt reached child'
   else:
    assert returncode==0 and 'VM_DOCKER_CPU_RECEIPT ' in logs.stdout,'Docker CPU boundary/boot refused'
    receipt=json.loads(next(line.split('VM_DOCKER_CPU_RECEIPT ',1)[1] for line in logs.stdout.splitlines() if line.startswith('VM_DOCKER_CPU_RECEIPT ')))
    assert receipt['credential']['capabilities_empty'] and receipt['readonlyRoot'] and receipt['privateNamespaces'] and receipt['resourceBounds'] and receipt['dummyCacheHashesVerified'] and receipt['embeddedDNSAbsent'] and not receipt['gpuValidated']
  finally:docker('rm','--force',cid)
 print('ACTUAL_DOCKER_DUMMY_BOOT_RECEIPT_FAILURES_AND_BOUNDARY_PASSED_NOT_TARGET_VM_OR_GPU_ACCEPTANCE')
