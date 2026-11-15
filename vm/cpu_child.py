"""Actual Docker dummy-only verification. No model, CUDA import or tool execution."""
import ctypes as C,json,os,socket,stat,sys
from pathlib import Path
sys.path.insert(0,'/opt/qwen')
import credential_boundary as boundary,inference_policy,offline_cache
p=Path('/tmp/qwen-inference');p.mkdir(mode=0o700,exist_ok=True)
receipt=boundary.verify_child()
assert os.statvfs('/').f_flag&os.ST_RDONLY
host=json.loads(Path('/fixture-host-namespaces.json').read_text())
for kind,identity in host.items():assert os.readlink('/proc/self/ns/'+kind)!=identity
for path in ['/var/run/docker.sock','/run/containerd/containerd.sock','/root','/run/unjailed/attestation']:
 assert not os.access(path,os.R_OK) and not os.access(path,os.W_OK)
for path in ['/cache','/home/inference','/tmp/qwen-inference']:
 info=Path(path).stat();assert info.st_uid==10001 and info.st_gid==10001 and not info.st_mode&0o077
 (Path(path)/'dummy').write_text('DUMMY')
for path in ['/opt/qwen/forbidden','/etc/passwd']:
 try:fd=os.open(path,os.O_WRONLY|os.O_CREAT);os.close(fd)
 except OSError:pass
 else:raise AssertionError('Protected root writable')
cgroup=Path('/sys/fs/cgroup')
assert int((cgroup/'memory.max').read_text())<=512*1024**2
assert int((cgroup/'pids.max').read_text())<=64
cpu=(cgroup/'cpu.max').read_text().split();assert cpu[0]!='max' and int(cpu[0])<=int(cpu[1])
# Before child policy, Docker none must not offer an embedded resolver/proxy.
for kind in [socket.SOCK_STREAM,socket.SOCK_DGRAM]:
 with socket.socket(socket.AF_INET,kind) as s:
  s.settimeout(.15)
  try:
   if kind==socket.SOCK_STREAM:s.connect(('127.0.0.11',53));s.send(b'DUMMY');s.recv(5)
   else:s.sendto(b'DUMMY',('127.0.0.11',53));s.recv(5)
  except OSError:pass
  else:raise AssertionError('Embedded DNS/proxy reachable')
policy=inference_policy.install()
a,b=socket.socketpair(socket.AF_UNIX,socket.SOCK_SEQPACKET);a.send(b'DUMMY');assert b.recv(5)==b'DUMMY';a.close();b.close()
try:socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
except OSError:pass
else:raise AssertionError('Child datagram allowed')
# Same cache verification code, tiny dummy bytes and pinned manifest identity only.
assert offline_cache.verify_cache()=='/opt/qwen-model'
print('VM_DOCKER_CPU_RECEIPT '+json.dumps({'credential':receipt,'policy':policy,'privateNamespaces':True,'readonlyRoot':True,'resourceBounds':True,'dummyCacheHashesVerified':True,'embeddedDNSAbsent':True,'gpuValidated':False,'modelLoaded':False,'agentToolsEnabled':False}),flush=True)
