"""Model-free Linux kernel probe. Dummy loopback only; unsupported means FAIL."""
import errno
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
import network_boundary

def denied_operations():
 for family,host in ((socket.AF_INET,'127.0.0.1'),(socket.AF_INET6,'::1')):
  with socket.socket(family,socket.SOCK_STREAM) as s:
   try:s.connect((host,9))
   except OSError as e:
    if e.errno not in (errno.EPERM,errno.EACCES):raise RuntimeError('TCP refusal was not a policy denial') from None
   else:raise RuntimeError('Outbound TCP permitted')
  for kind in (socket.SOCK_DGRAM,socket.SOCK_DGRAM|socket.SOCK_NONBLOCK,socket.SOCK_RAW):
   try:s=socket.socket(family,kind)
   except OSError as e:
    if e.errno != errno.EPERM:raise RuntimeError('Socket refusal was not seccomp denial') from None
   else:s.close();raise RuntimeError('Internet datagram/raw socket permitted')
 # No named/abstract UNIX socket can even be created. Raw syscall policy,
 # rather than pathname scanning or Python monkeypatching, denies both types.
 for kind in (socket.SOCK_STREAM,socket.SOCK_DGRAM,socket.SOCK_SEQPACKET):
  try:s=socket.socket(socket.AF_UNIX,kind)
  except OSError as e:
   if e.errno != errno.EPERM:raise RuntimeError('UNIX refusal was not seccomp denial') from None
  else:s.close();raise RuntimeError('Named UNIX socket creation permitted')
 # Anonymous pairs connect only descendants of the same launch boundary.
 a,b=socket.socketpair();a.sendall(b'DUMMY');assert b.recv(5)==b'DUMMY';a.close();b.close()
 for kind in (socket.SOCK_DGRAM,socket.SOCK_DGRAM|socket.SOCK_NONBLOCK,socket.SOCK_SEQPACKET):
  try:a,b=socket.socketpair(socket.AF_UNIX,kind)
  except OSError as e:
   if e.errno != errno.EPERM:raise RuntimeError('Non-stream pair was not seccomp denial') from None
  else:a.close();b.close();raise RuntimeError('Non-stream UNIX pair permitted')
 # Even a socketpair descriptor cannot reconnect to a pathname/abstract peer.
 for address in ('/tmp/DUMMY-unjailed-proxy.sock','\0DUMMY-unjailed-proxy'):
  a,b=socket.socketpair()
  try:
   try:a.connect(address)
   except OSError as e:
    if e.errno != errno.EPERM:raise RuntimeError('UNIX connect was not seccomp denial') from None
   else:raise RuntimeError('UNIX connect permitted')
  finally:a.close();b.close()

if __name__=='__main__':
 if sys.argv[1:]==['--inherit']:
  denied_operations();sys.exit(0)
 if sys.argv[1:]==['--child']:
  receipt=network_boundary.install();denied_operations()
  subprocess.run([sys.executable,'-I','-B',__file__,'--inherit'],check=True,timeout=10)
  with socket.socket() as listener:
   listener.bind(('127.0.0.1',0));listener.listen(1);listener.settimeout(10)
   print(json.dumps({'port':listener.getsockname()[1],'receipt':receipt}),flush=True)
   peer,_=listener.accept()
   with peer:assert peer.recv(5)==b'DUMMY';peer.sendall(b'REPLY')
  sys.exit(0)
 if sys.argv[1:]:raise RuntimeError('Fixed probe only')
 child=subprocess.Popen([sys.executable,'-I','-B',__file__,'--child'],stdout=subprocess.PIPE,text=True,stdin=subprocess.DEVNULL,close_fds=True)
 try:
  line=child.stdout.readline();record=json.loads(line)
  with socket.create_connection(('127.0.0.1',record['port']),timeout=5) as peer:
   peer.sendall(b'DUMMY');assert peer.recv(5)==b'REPLY'
  if child.wait(timeout=15):raise RuntimeError('Kernel probe failed')
  print('Kernel egress/named-UNIX denial, exec inheritance, anonymous pairs and inbound reply verified; no model loaded.')
 finally:
  if child.poll() is None:child.kill();child.wait()
