"""Prepared trusted-host native boundary gate; never called by model code.

Requires a root-created immutable session, Docker container and empty handoff.
No image pull, model import, GPU kernel call, provider API or credential output.
Unexpected NVIDIA hook mount/socket refuses; this code never learns an allowlist.
"""
import hashlib,json,os,re,stat,subprocess,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from host_policy import Refused,root_file,manifest_from,atomic,timestamp
from attach_model_network import inspect,owned,run
from attestation import KINDS,context_from,context_digest,protected

BASE={'/':'overlay','/proc':'proc','/dev':'tmpfs','/dev/pts':'devpts','/sys':'sysfs','/sys/fs/cgroup':'cgroup2','/dev/mqueue':'mqueue','/dev/shm':'tmpfs','/tmp':'tmpfs','/cache':'tmpfs','/home/inference':'tmpfs'}
MASKED={'/proc/acpi','/proc/scsi','/sys/firmware','/sys/devices/virtual/powercap','/proc/kcore','/proc/keys','/proc/latency_stats','/proc/timer_list','/proc/timer_stats','/proc/sched_debug','/proc/bus','/proc/fs','/proc/irq','/proc/sys','/proc/sysrq-trigger'}
BINDS={'/etc/resolv.conf':'/etc/unjailed/empty-resolv.conf','/etc/hosts':'/etc/unjailed/empty-hosts','/etc/hostname':'/etc/unjailed/hostname'}
NVIDIA_FILE=re.compile(r'^/usr/lib/(?:x86_64-linux-gnu|x86_64-linux-gnu/nvidia/current)/lib(?:cuda|nvidia-[a-z0-9-]+)\.so(?:\.[0-9]+)*$')
DEVICE=re.compile(r'^/dev/nvidia(?:[0-9]+|ctl|uvm|uvm-tools|caps/nvidia-cap[0-9]+)$')

def unescape(value):
 return re.sub(r'\\(040|011|012|134)',lambda m:chr(int(m[1],8)),value)

def mounts_from(text):
 entries=[]
 for line in text.splitlines():
  fields=line.split();separator=fields.index('-')
  if separator<6 or len(fields)<separator+4:raise Refused('Invalid native mount inventory')
  entries.append({'root':unescape(fields[3]),'target':unescape(fields[4]),'options':set(fields[5].split(',')),'type':fields[separator+1],'source':unescape(fields[separator+2])})
 return entries

def visible(root,target):
 # Target paths come from the kernel inventory, never model input. No .. or
 # symlink traversal may turn an inspection into a host-root read.
 if not target.startswith('/') or '..' in Path(target).parts:raise Refused('Unsafe mount target')
 p=Path(root)
 for part in Path(target).parts[1:]:
  p=p/part
  if p.is_symlink():raise Refused('Unexpected symlink in mount target')
 return p

def installed_gpu_files():
 # Only installed files from the exact pinned compute package, not filenames
 # observed inside the injected container. dpkg metadata came from hashed .debs.
 result={}
 lock=json.loads((Path(__file__).resolve().parent/'packages.lock.json').read_text())
 for package in lock['packages']:
  if not package['name'].startswith('libnvidia-'):continue
  version=run(['dpkg-query','--show','--showformat=${Version}',package['name']])
  if version!=package['version'] or run(['dpkg','--verify',package['name']]):raise Refused('Pinned host compute files changed')
  for name in run(['dpkg-query','--listfiles',package['name']]).splitlines():
   p=Path(name)
   if NVIDIA_FILE.fullmatch(name) and p.is_file() and not p.is_symlink():
    s=p.stat()
    if s.st_uid!=0 or s.st_mode&0o022:raise Refused('Untrusted host driver library')
    result[name]=hashlib.sha256(p.read_bytes()).hexdigest()
 if not result:raise Refused('Pinned host compute file inventory missing')
 return result

def verify_mount_inventory(entries,root,driver_files):
 seen=set()
 for entry in entries:
  target=entry['target'];seen.add(target);p=visible(root,target);s=p.lstat();read_only='ro' in entry['options']
  if stat.S_ISSOCK(s.st_mode):raise Refused('Host socket mount forbidden')
  if target in BASE:
   if entry['type']!=BASE[target] or (target in {'/','/sys','/sys/fs/cgroup'} and not read_only):raise Refused('Private base mount mismatch')
   if target=='/proc' and entry['root']!='/':raise Refused('Unexpected host proc subtree')
  elif target in MASKED:
   if not read_only:raise Refused('Writable OCI mask forbidden')
  elif target in BINDS:
   if not read_only or not stat.S_ISREG(s.st_mode) or entry['root']!=BINDS[target]:raise Refused('Fixed host file bind mismatch')
  elif target=='/run/unjailed/attestation':
   if not read_only or not stat.S_ISDIR(s.st_mode) or not entry['root'].startswith('/run/unjailed/attestations/'):raise Refused('Native handoff mount mismatch')
  elif target in driver_files:
   if not read_only or not stat.S_ISREG(s.st_mode) or hashlib.sha256(p.read_bytes()).hexdigest()!=driver_files[target]:raise Refused('Injected GPU file differs from pinned host package')
  elif DEVICE.fullmatch(target):
   host=Path(target);h=host.lstat()
   if not stat.S_ISCHR(s.st_mode) or not stat.S_ISCHR(h.st_mode) or s.st_rdev!=h.st_rdev:raise Refused('Unexpected NVIDIA device injection')
  else:raise Refused('Unexpected runtime-injected mount; review required')
 if not set(BASE).issubset(seen) or not set(BINDS).issubset(seen) or '/run/unjailed/attestation' not in seen:raise Refused('Required private mount missing')

def verify_sockets(root):
 # proc/sys are exact private kernel mounts checked separately. Walk every
 # ordinary directory without following symlinks; no pathname host proxy is
 # permitted, even a socket not advertised in Docker .Mounts.
 root=Path(root);count=0
 def failed(_):raise Refused('Native filesystem inventory unavailable')
 for directory,dirs,files in os.walk(root,followlinks=False,onerror=failed):
  relative='/'+str(Path(directory).relative_to(root))
  if relative in {'/proc','/sys'}:dirs[:]=[];continue
  for name in dirs+files:
   p=Path(directory)/name;s=p.lstat();count+=1
   if count>1000000:raise Refused('Native filesystem inventory bound exceeded')
   if stat.S_ISSOCK(s.st_mode):raise Refused('Pathname socket visible before model start')
   if stat.S_ISBLK(s.st_mode):raise Refused('Host block device visible')
   if stat.S_ISCHR(s.st_mode):
    target='/'+str(p.relative_to(root))
    if DEVICE.fullmatch(target):
     h=Path(target).lstat()
     if not stat.S_ISCHR(h.st_mode) or s.st_rdev!=h.st_rdev:raise Refused('Unexpected NVIDIA device node')
    elif target not in {'/dev/null','/dev/zero','/dev/full','/dev/random','/dev/urandom','/dev/tty','/dev/pts/ptmx'} and not re.fullmatch('/dev/pts/[0-9]+',target):raise Refused('Unexpected host character device')
   if stat.S_ISDIR(s.st_mode) and name in dirs and stat.S_ISLNK(s.st_mode):dirs.remove(name)

def main():
 import time
 if sys.argv[1:] not in [['--execute'],['--prepare-context']] or os.geteuid()!=0 or sys.platform!='linux':raise Refused('Explicit reviewed native root execution required')
 m=manifest_from(json.loads(root_file('/etc/unjailed/session.json').read_text()))
 if not timestamp(m['createdAt'])<=time.time()<timestamp(m['deadlineUTC']):raise Refused('Native gate expired')
 name='uj-model-'+m['sessionId'];state=inspect(name,'.State');config=inspect(name,'.HostConfig');cid=inspect(name,'.Id')
 directory=protected('/run/unjailed/attestations/'+m['sessionId'],True)
 if sys.argv[1:] == ['--prepare-context']:
  if state.get('Running') or state.get('Status')!='created' or inspect(name,'.Config.Image')!=m['image'] or inspect(name,'.Config.Labels').get('unjailed.session')!=m['sessionId'] or any(directory.iterdir()):raise Refused('Context requires one owned not-yet-started container and empty handoff')
  c={'version':1,**{key:m[key] for key in ['sessionId','nonce','createdAt','deadlineUTC','image']},'containerId':cid,'imageId':inspect(name,'.Image')}
  atomic(directory/'context.json',context_from(c));print('OWNED_NATIVE_CONTEXT_PREPARED_MODEL_NOT_STARTED');return
 owned(m,name,state,config,inspect(name,'.Config.Image'),inspect(name,'.Config.Labels'),cid)
 if config.get('Devices') or config.get('VolumesFrom') or config.get('GroupAdd') or not 0<config.get('Memory',0)<=24*1024**3 or not 0<config.get('NanoCpus',0)<=8*10**9 or not 0<config.get('PidsLimit',0)<=256:raise Refused('Native resources or devices differ from reviewed runtime')
 env=inspect(name,'.Config.Env')
 if [x for x in env if x.startswith('NVIDIA_DRIVER_CAPABILITIES=')]!=['NVIDIA_DRIVER_CAPABILITIES=compute'] or any(x.startswith(('CUDA_MPS_','NVIDIA_MPS_')) for x in env):raise Refused('Compute-only runtime required')
 requests=config.get('DeviceRequests')
 if not isinstance(requests,list) or len(requests)!=1 or requests[0].get('Count')!=1 or requests[0].get('Capabilities')!=[['gpu']]:raise Refused('One exact GPU request required')
 if (directory/'verified.json').exists():raise Refused('Native receipt already exists; no replay or renewal')
 c=context_from(json.loads(protected(directory/'context.json').read_text()))
 expected={key:m[key] for key in ['sessionId','nonce','createdAt','deadlineUTC','image']}
 if any(c[key]!=value for key,value in expected.items()) or c['containerId']!=cid or c['imageId']!=inspect(name,'.Image'):raise Refused('Native context differs from owned allocation')
 # No arbitrary host mounts may hide in Docker config, independent of OCI hook
 # mounts subsequently inspected in mountinfo.
 allowed={**BINDS,'/run/unjailed/attestation':str(directory)}
 for mount in inspect(name,'.Mounts'):
  if mount['Type']=='tmpfs' and mount['Destination'] in ['/tmp','/cache','/home/inference']:continue
  if mount['Type']!='bind' or mount['RW'] or allowed.get(mount['Destination'])!=mount['Source']:raise Refused('Unexpected configured mount')
 run(['nft','list','table','inet','unjailed'])
 proc=os.open('/proc/'+str(state['Pid']),os.O_RDONLY|os.O_DIRECTORY)
 try:
  def read(name):
   fd=os.open(name,os.O_RDONLY,dir_fd=proc)
   with os.fdopen(fd) as f:return f.read()
  if cid not in read('cgroup'):raise Refused('Container PID identity changed')
  namespaces={kind:os.readlink('ns/'+kind,dir_fd=proc) for kind in KINDS}
  if any(value==os.readlink('/proc/self/ns/'+kind) for kind,value in namespaces.items()):raise Refused('Host namespace exposed')
  root_fd=os.open('root',os.O_RDONLY|os.O_DIRECTORY,dir_fd=proc)
  try:
   root='/proc/self/fd/'+str(root_fd)
   verify_mount_inventory(mounts_from(read('mountinfo')),root,installed_gpu_files());verify_sockets(root)
   for forbidden in ['/run/nvidia-persistenced','/tmp/nvidia-mps','/run/docker.sock','/run/containerd/containerd.sock']:
    if (Path(root)/forbidden.lstrip('/')).exists():raise Refused('Host IPC/control surface visible')
  finally:os.close(root_fd)
  # Re-read the pinned task after the expensive scan and re-check absolute expiry.
  if cid not in read('cgroup') or namespaces!={kind:os.readlink('ns/'+kind,dir_fd=proc) for kind in KINDS} or time.time()>=timestamp(m['deadlineUTC']):raise Refused('Native identity or expiry changed')
  atomic(directory/'verified.json',{'version':1,'kind':'vm-native-boundary-v1','contextSHA256':context_digest(c),'containerId':cid,'imageId':c['imageId'],'namespaces':namespaces,'boundaryVerified':True})
 finally:os.close(proc)
 print('NATIVE_BOUNDARY_ATTESTED_NOT_CUDA_OR_MODEL_ACCEPTANCE')

if __name__=='__main__':
 try:main()
 except Exception:raise SystemExit('Native boundary refused; no model child or unrestricted fallback')
