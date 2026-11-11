"""Bounded, keyless host progress. Never an attestation or execution permit.

Only the trusted host writes fixed console devices. Console capture/routing
remains a provider-runtime check; failure to write never relaxes an execution
gate, replaces the original exception or changes the immutable deadline.
"""
import json,os,stat,time
from host_policy import manifest_from,timestamp

PREFIX='UNJAILED_HOST_EVENT '
PHASES={
 'bootstrap':frozenset(['new','metadata-review','installing','awaiting-reboot','driver-check','host-ready-model-not-started']),
 'runtime':frozenset(['preparing','image-pull','connector-install','host-boundary-probe','sealing','container-create','native-boundary','model-free-preflight','awaiting-provider-firewall-permit','model-starting','ready'])}
DEVICES=('/dev/console','/dev/ttyS0','/dev/tty1')

def event(m,component,phase,status,now=None):
 manifest_from(m)
 if component not in PHASES or phase not in PHASES[component] or status not in ('running','failed','passed'):raise ValueError('Unknown host diagnostic stage')
 now=time.time() if now is None else now
 if type(now) not in (int,float) or not timestamp(m['createdAt'])<=now<=timestamp(m['deadlineUTC']):raise ValueError('Host diagnostic outside session')
 value={'version':1,'sessionId':m['sessionId'],'nonce':m['nonce'],'component':component,'phase':phase,'status':status,'at':round(now*1000),'deadline':round(timestamp(m['deadlineUTC'])*1000)}
 raw=('\n'+PREFIX+json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=True,allow_nan=False)+'\n').encode('ascii')
 if len(raw)>1024:raise ValueError('Host diagnostic exceeds bound')
 return raw

def emit(m,component,phase,status='running'):
 # No raw exception, command, environment, path, credential or model text is
 # accepted by this interface. No regular file, symlink or blocking terminal.
 try:
  raw=event(m,component,phase,status)
  if os.geteuid()!=0:return False
  written=False
  for device in DEVICES:
   fd=None
   try:
    fd=os.open(device,os.O_WRONLY|os.O_CLOEXEC|os.O_NOFOLLOW|os.O_NOCTTY|os.O_NONBLOCK)
    info=os.fstat(fd)
    if info.st_uid!=0 or not stat.S_ISCHR(info.st_mode):continue
    written=os.write(fd,raw)==len(raw) or written
   except OSError:pass
   finally:
    if fd is not None:os.close(fd)
  return written
 except Exception:return False
