"""Fixed dummy-only attacks against the *external* container boundary.

Executed only by trusted host before attestation/model child. Deliberately does
not install child seccomp: Docker namespaces, routes and host nft must deny it.
"""
import json,socket
ENDPOINTS=[(socket.AF_INET,'10.203.0.1',[53,9090]),(socket.AF_INET,'127.0.0.11',[53]),(socket.AF_INET,'169.254.169.254',[80]),(socket.AF_INET,'1.1.1.1',[53,443]),(socket.AF_INET6,'::1',[53]),(socket.AF_INET6,'fd42:203::1',[53,9090]),(socket.AF_INET6,'2606:4700:4700::1111',[53,443])]
EXPECTED_CHECKS=sum(len(ports)*2 for _,_,ports in ENDPOINTS)
def main():
 checks=[]
 for family,host,ports in ENDPOINTS:
  for port in ports:
   for kind in [socket.SOCK_STREAM,socket.SOCK_DGRAM]:
    with socket.socket(family,kind) as sock:
     sock.settimeout(.2)
     try:
      sock.connect((host,port));sock.send(b'UNJAILED-DUMMY-PROBE');sock.recv(64)
     except OSError:checks.append(True)
     else:raise ValueError('External model network boundary failed')
 print('EXTERNAL_EGRESS_PROBE '+json.dumps({'version':1,'checks':len(checks),'allDenied':all(checks),'childPolicyInstalled':False,'modelLoaded':False,'agentToolsEnabled':False}),flush=True)
if __name__=='__main__':
 try:main()
 except Exception:raise SystemExit('External egress probe refused')
