"""Prepared trusted-host native boundary gate; never called by model code.

Requires a root-created immutable session, Docker container and empty handoff.
No image pull, model import, GPU kernel call, provider API or credential output.
Unexpected NVIDIA hook mount/socket refuses; this code never learns an allowlist.
"""
import ctypes,hashlib,json,os,re,stat,subprocess,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from host_policy import Refused,root_file,manifest_from,atomic,timestamp
from attach_model_network import inspect,owned,run
from attestation import KINDS,context_from,context_digest,protected

BASE={'/':'overlay','/proc':'proc','/dev':'tmpfs','/dev/pts':'devpts','/sys':'sysfs','/sys/fs/cgroup':'cgroup2','/dev/mqueue':'mqueue','/dev/shm':'tmpfs','/tmp':'tmpfs','/cache':'tmpfs','/home/inference':'tmpfs'}
MASKED={'/proc/acpi','/proc/scsi','/sys/firmware','/sys/devices/virtual/powercap','/proc/kcore','/proc/keys','/proc/latency_stats','/proc/timer_list','/proc/timer_stats','/proc/sched_debug','/proc/bus','/proc/fs','/proc/irq','/proc/sys','/proc/sysrq-trigger'}
BINDS={'/etc/resolv.conf':'/etc/unjailed/empty-resolv.conf','/etc/hosts':'/etc/unjailed/empty-hosts','/etc/hostname':'/etc/unjailed/hostname'}
NVIDIA_FILE=re.compile(r'^/usr/lib/(?:x86_64-linux-gnu|x86_64-linux-gnu/nvidia/current)/lib(?:cuda|cudadebugger|nvidia-[a-z0-9-]+)\.so(?:\.[0-9]+)*$')
NVIDIA_BINARY={'/usr/bin/nvidia-cuda-mps-control','/usr/bin/nvidia-cuda-mps-server'}
DEVICE=re.compile(r'^/dev/nvidia(?:[0-9]+|ctl|uvm|uvm-tools|caps/nvidia-cap[0-9]+)$')
GPU_PROC=re.compile(r'^/proc/driver/nvidia/gpus/([0-9a-fA-F]{4,8}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}\.[0-7])$')

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

def reviewed_gpu_file(name,driver_version):
 return bool(NVIDIA_FILE.fullmatch(name) or name in NVIDIA_BINARY or re.fullmatch(r'/usr/lib/firmware/nvidia/'+re.escape(driver_version)+r'/gsp_[a-z0-9_]+\.bin',name))

def installed_gpu_files():
 # Only installed files from the exact pinned compute package, not filenames
 # observed inside the injected container. dpkg metadata came from hashed .debs.
 result={}
 lock=json.loads((Path(__file__).resolve().parent/'packages.lock.json').read_text())
 for package in lock['packages']:
  if not package['name'].startswith('libnvidia-') and package['name'] not in ['nvidia-utils-580','nvidia-firmware-580']:continue
  version=run(['dpkg-query','--show','--showformat=${Version}',package['name']])
  if version!=package['version'] or run(['dpkg','--verify',package['name']]):raise Refused('Pinned host compute files changed')
  for name in run(['dpkg-query','--listfiles',package['name']]).splitlines():
   p=Path(name)
   canonical=str(p.resolve())
   if reviewed_gpu_file(canonical,lock['driver_version']) and p.is_file() and not p.is_symlink():
    s=p.stat()
    if s.st_uid!=0 or s.st_mode&0o022:raise Refused('Untrusted host driver library')
    digest=hashlib.sha256(p.read_bytes()).hexdigest();result[canonical]=digest
    if NVIDIA_FILE.fullmatch(canonical):
     # NVIDIA mount_files puts resolved source basenames in the container's
     # reviewed library directory, even if the host uses nvidia/current.
     for directory in ['/usr/lib/x86_64-linux-gnu','/usr/lib/x86_64-linux-gnu/nvidia/current']:result[directory+'/'+p.name]=digest
 if not result:raise Refused('Pinned host compute file inventory missing')
 return result

def same_bind(entry,target_info,source_info,directory=False):
 # mountinfo.root is relative to the source filesystem (e.g. /run is tmpfs),
 # not necessarily the full host source path. The host Docker mount declaration
 # pins that exact path; inode/device prove the actual visible object is it.
 kind=stat.S_ISDIR if directory else stat.S_ISREG
 if 'ro' not in entry['options'] or not kind(target_info.st_mode) or not kind(source_info.st_mode) or (target_info.st_dev,target_info.st_ino)!=(source_info.st_dev,source_info.st_ino):raise Refused('Fixed readonly host bind identity mismatch')
 if directory and (target_info.st_uid!=0 or target_info.st_mode&0o077):raise Refused('Root-only native handoff required')

def verify_mount_inventory(entries,root,driver_files,handoff_source=None):
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
   same_bind(entry,s,Path(BINDS[target]).lstat())
  elif target=='/run/unjailed/attestation':
   if handoff_source is None:raise Refused('Pinned native handoff source required')
   same_bind(entry,s,protected(handoff_source,True).lstat(),True)
  elif target in driver_files:
   if not read_only or not stat.S_ISREG(s.st_mode) or hashlib.sha256(p.read_bytes()).hexdigest()!=driver_files[target]:raise Refused('Injected GPU file differs from pinned host package')
  elif DEVICE.fullmatch(target):
   host=Path(target);h=host.lstat()
   if not stat.S_ISCHR(s.st_mode) or not stat.S_ISCHR(h.st_mode) or s.st_rdev!=h.st_rdev:raise Refused('Unexpected NVIDIA device injection')
  elif target=='/proc/driver/nvidia':
   if entry['type']!='tmpfs' or entry['root']!='/' or not {'ro','nosuid','nodev','noexec'}.issubset(entry['options']):raise Refused('NVIDIA metadata snapshot not sealed read-only')
   for child in p.iterdir():
    if child.name=='gpus' and child.is_dir() and not child.is_symlink():
     for gpu in child.iterdir():
      gpu_target='/proc/driver/nvidia/gpus/'+gpu.name
      if gpu.is_symlink() or not gpu.is_dir() or not GPU_PROC.fullmatch(gpu_target) or gpu_target not in {e['target'] for e in entries}:raise Refused('Unreviewed NVIDIA proc child')
      for metadata in gpu.iterdir():
       if metadata.name not in {'information','registry','power'} or metadata.is_symlink() or not metadata.is_file() or len(metadata.read_bytes())>65536:raise Refused('NVIDIA proc child contains an IPC or unreviewed entry')
     continue
    if child.name not in {'params','version','registry'} or child.is_symlink() or not child.is_file() or child.stat().st_size>65536:raise Refused('Unexpected NVIDIA metadata snapshot')
    original=Path('/proc/driver/nvidia')/child.name
    expected=original.read_bytes()
    if child.name=='params':expected=expected.replace(b'ModifyDeviceFiles: 1',b'ModifyDeviceFiles: 0')
    if child.read_bytes()!=expected:raise Refused('NVIDIA metadata differs from bounded host driver metadata')
  elif GPU_PROC.fullmatch(target):
   if entry['type']!='proc' or entry['root']!=target.removeprefix('/proc') or not {'ro','nosuid','nodev','noexec'}.issubset(entry['options']):raise Refused('Unexpected host proc exposure')
   host=Path(target)
   if p.stat().st_dev!=host.stat().st_dev or p.stat().st_ino!=host.stat().st_ino:raise Refused('GPU proc subtree identity mismatch')
   gpu_dirs=list(Path('/proc/driver/nvidia/gpus').iterdir())
   if len(gpu_dirs)!=1 or host.resolve()!=gpu_dirs[0].resolve():raise Refused('GPU proc metadata is not the sole dedicated VM GPU')
   for child in p.iterdir():
    if child.name not in {'information','registry','power'} or child.is_symlink() or not child.is_file() or len(child.read_bytes())>65536:raise Refused('Unexpected GPU proc metadata entry')
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
 if sys.argv[1:] not in [['--execute'],['--prepare-context'],['--seal-driver-metadata']] or os.geteuid()!=0 or sys.platform!='linux':raise Refused('Explicit reviewed native root execution required')
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
   if sys.argv[1:]==['--seal-driver-metadata']:
    inventory=mounts_from(read('mountinfo'));metadata=[entry for entry in inventory if entry['target']=='/proc/driver/nvidia']
    if len(metadata)>1 or metadata and (metadata[0]['type']!='tmpfs' or metadata[0]['root']!='/'):raise Refused('Unreviewed NVIDIA metadata mount cannot be sealed')
    if metadata:
     namespace=os.open('ns/mnt',os.O_RDONLY,dir_fd=proc)
     try:
      child=os.fork()
      if child==0:
       try:
        libc=ctypes.CDLL(None,use_errno=True)
        if libc.setns(namespace,0):os._exit(1)
        os.fchdir(root_fd);os.chroot('.');os.chdir('/')
        # Match NVIDIA's scoped bind-remount and add readonly. No image binary
        # or model code runs with trusted host privileges.
        libc.mount.argtypes=[ctypes.c_void_p,ctypes.c_char_p,ctypes.c_void_p,ctypes.c_ulong,ctypes.c_void_p]
        if libc.mount(None,b'/proc/driver/nvidia',None,4096|32|1|2|4|8,None):os._exit(1)
        os._exit(0)
       except BaseException:os._exit(1)
      if os.waitpid(child,0)[1]!=0:raise Refused('NVIDIA metadata readonly seal refused')
     finally:os.close(namespace)
    print('SCOPED_NVIDIA_METADATA_READONLY_SEAL_COMPLETED_NOT_NATIVE_ACCEPTANCE');return
   verify_mount_inventory(mounts_from(read('mountinfo')),root,installed_gpu_files(),directory);verify_sockets(root)
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
