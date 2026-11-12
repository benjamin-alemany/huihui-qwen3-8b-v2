"""Dummy listeners/clients for the isolated Linux fixture; never real endpoints."""
import errno,json,os,socket,sys,threading,time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
mode=sys.argv[1];work=Path(sys.argv[2])
def server_tcp(address,port,family=socket.AF_INET):
 s=socket.socket(family,socket.SOCK_STREAM)
 if family==socket.AF_INET6:s.setsockopt(socket.IPPROTO_IPV6,socket.IPV6_V6ONLY,1)
 s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind((address,port));s.listen()
 while True:
  c,_=s.accept();c.sendall(b'DUMMY');c.close()
def server_udp(address,logname='dns.received'):
 s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.bind((address,53))
 while True:
  data,address=s.recvfrom(256)
  with (work/logname).open('a') as f:f.write('DUMMY\n')
  s.sendto(b'DUMMY',address)
def start(fn,*args):threading.Thread(target=fn,args=args,daemon=True).start()
def tcp(address,port,family=socket.AF_INET):
 with socket.socket(family,socket.SOCK_STREAM) as s:s.settimeout(2 if mode in ['baseline','positive'] else .3);s.connect((address,port));return s.recv(5)
def denied(fn):
 try:fn()
 except OSError:return
 raise AssertionError('Forbidden channel reached dummy endpoint')
def dns(address):
 with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as s:s.settimeout(.3);s.sendto(b'DUMMY',(address,53));return s.recv(10)
if mode=='outside':
 work.chmod(0o755);start(server_udp,'1.1.1.1')
 for ip,port,family in [('0.0.0.0',8080,socket.AF_INET),('0.0.0.0',7844,socket.AF_INET),('0.0.0.0',80,socket.AF_INET),('::',8080,socket.AF_INET6),('::',7844,socket.AF_INET6)]:start(server_tcp,ip,port,family)
 (work/'outside.ready').touch();time.sleep(120)
elif mode=='model-server':
 start(server_tcp,'0.0.0.0',8000);(work/'model.ready').touch();time.sleep(120)
elif mode=='host-server':
 start(server_tcp,'0.0.0.0',9090);start(server_tcp,'0.0.0.0',53);start(server_udp,'10.203.0.1','host-dns.received')
 abstract=socket.socket(socket.AF_UNIX,socket.SOCK_SEQPACKET);abstract.bind('\0unjailed-dummy-host-control');abstract.listen()
 (work/'host.ready').touch();time.sleep(120)
elif mode=='baseline':
 assert tcp('172.30.0.2',8080)==b'DUMMY';assert tcp('fd42:99::2',8080,socket.AF_INET6)==b'DUMMY';assert tcp('169.254.169.254',80)==b'DUMMY';assert tcp('10.203.0.1',9090)==b'DUMMY';assert tcp('10.203.0.1',53)==b'DUMMY';assert dns('1.1.1.1')==b'DUMMY';assert dns('10.203.0.1')==b'DUMMY';print('CONTROLLED_ROUTES_AND_HOST_DNS_PROXY_REACHABLE_BEFORE_SEAL')
elif mode=='positive':
 assert tcp('10.203.0.2',8000)==b'DUMMY';assert tcp('198.41.192.1',7844)==b'DUMMY';assert dns('1.1.1.1')==b'DUMMY'
 # Host tunnel UID still cannot use arbitrary ports/metadata.
 denied(lambda:tcp('172.30.0.2',8080));denied(lambda:tcp('169.254.169.254',80));print('CONTROLLED_TUNNEL_AND_DNS_POSITIVE_CONTROLS_PASSED')
elif mode=='hostile':
 for ip,port,family in [('172.30.0.2',8080,socket.AF_INET),('fd42:99::2',8080,socket.AF_INET6),('169.254.169.254',80,socket.AF_INET),('10.203.0.1',9090,socket.AF_INET),('10.203.0.1',53,socket.AF_INET),('127.0.0.11',53,socket.AF_INET)]:denied(lambda:tcp(ip,port,family))
 for ip in ['1.1.1.1','10.203.0.1','127.0.0.11']:denied(lambda:dns(ip))
 with socket.socket(socket.AF_UNIX,socket.SOCK_SEQPACKET) as s:denied(lambda:s.connect('\0unjailed-dummy-host-control'))
 print('HOST_BOUNDARY_BLOCKED_RAW_MODEL_TCP_UDP_DNS_METADATA_IPV6_AND_HOST_PROXY_WITHOUT_CHILD_POLICY')
elif mode=='child-policy':
 import inference_policy
 receipt=inference_policy.install();assert receipt['tcpInitiationDenied']
 a,b=socket.socketpair(socket.AF_UNIX,socket.SOCK_SEQPACKET);a.send(b'DUMMY');assert b.recv(5)==b'DUMMY';a.close();b.close()
 listener=socket.socket(socket.AF_UNIX,socket.SOCK_SEQPACKET);listener.bind('\0unjailed-dummy-private-local');listener.listen()
 client=socket.socket(socket.AF_UNIX,socket.SOCK_SEQPACKET);client.connect('\0unjailed-dummy-private-local');peer,_=listener.accept();client.send(b'DUMMY');assert peer.recv(5)==b'DUMMY';peer.close();client.close();listener.close()
 denied(lambda:tcp('10.203.0.1',9090));denied(lambda:socket.socket(socket.AF_INET,socket.SOCK_DGRAM));denied(lambda:socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM))
 print('CHILD_TCP_DENIAL_AND_PRIVATE_UNIX_SEQPACKET_PASSED')
elif mode=='check-counters':
 assert (work/'dns.received').read_text().splitlines()==['DUMMY'],'Model reached controlled DNS resolver'
 assert not (work/'host-dns.received').read_text(),'Model reached host DNS proxy'
 print('CONTROLLED_DNS_SAW_ONLY_TRUSTED_TUNNEL_UID_QUERY')
else:raise SystemExit('Unknown dummy stage')
