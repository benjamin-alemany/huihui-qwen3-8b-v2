"""Root-generated native-boundary receipt. No cloud calls or self-attestation.

The supervisor has no child until this read-only, root-only handoff validates.
CPU fixtures may supply dummy boundary evidence; this is never a CUDA receipt.
"""
import hashlib,json,os,re,stat,time
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from host_policy import UUID,IMAGE,Refused,timestamp
KINDS={'pid','mnt','net','ipc'}

def context_from(c):
 if not isinstance(c,dict) or set(c)!={'version','sessionId','nonce','createdAt','deadlineUTC','image','imageId','containerId'} or type(c['version']) is not int or c['version']!=1:raise Refused('Invalid native context')
 if not UUID.fullmatch(c['sessionId']) or not IMAGE.fullmatch(c['image']) or not re.fullmatch('sha256:[0-9a-f]{64}',c['imageId']) or not re.fullmatch('[0-9a-f]{64}',c['containerId']):raise Refused('Native identity mismatch')
 if not isinstance(c['nonce'],str) or not re.fullmatch('[0-9a-f]{32}',c['nonce']):raise Refused('Native nonce mismatch')
 if not 0<timestamp(c['deadlineUTC'])-timestamp(c['createdAt'])<=3600:raise Refused('Native deadline invalid')
 return c

def context_digest(c):return hashlib.sha256(json.dumps(context_from(c),sort_keys=True,separators=(',',':')).encode()).hexdigest()

def verify_receipt(c,r,namespaces,created,deadline):
 context_from(c)
 if c['createdAt']!=created or c['deadlineUTC']!=deadline:raise Refused('Native deadline differs from immutable launch')
 if not isinstance(r,dict) or set(r)!={'version','kind','contextSHA256','containerId','imageId','namespaces','boundaryVerified'} or type(r['version']) is not int or r['version']!=1 or r['kind']!='vm-native-boundary-v1' or r['boundaryVerified'] is not True:raise Refused('Native boundary not verified')
 if r['contextSHA256']!=context_digest(c) or r['containerId']!=c['containerId'] or r['imageId']!=c['imageId'] or set(r['namespaces'])!=KINDS or r['namespaces']!=namespaces:raise Refused('Native receipt is not this container')
 for kind,value in namespaces.items():
  if not re.fullmatch(kind+r':\[[0-9]+\]',value):raise Refused('Invalid native namespace identity')
 return True

def protected(path,directory=False):
 p=Path(path);s=p.lstat()
 if stat.S_ISLNK(s.st_mode) or s.st_uid!=0 or s.st_mode&0o077 or not (stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode)):raise Refused('Root-only native handoff required')
 return p

def wait_for_receipt(created,deadline,directory='/run/unjailed/attestation'):
 base=protected(directory,True)
 if not os.statvfs(base).f_flag&os.ST_RDONLY:raise Refused('Native handoff must be read-only in the container')
 wall,mono=time.time(),time.monotonic();expiry=timestamp(deadline)
 while max(time.time(),wall+time.monotonic()-mono)<expiry:
  if (base/'context.json').exists() and (base/'verified.json').exists():
   c=json.loads(protected(base/'context.json').read_text());r=json.loads(protected(base/'verified.json').read_text())
   n={kind:os.readlink('/proc/self/ns/'+kind) for kind in KINDS}
   return verify_receipt(c,r,n,created,deadline)
  time.sleep(.05)
 raise Refused('Native attestation absent at immutable expiry; no model child')

def verify_model_permit(c,permit,created,deadline):
 context_from(c)
 expected={'version':1,'sessionId':c['sessionId'],'nonce':c['nonce'],'deadlineUTC':c['deadlineUTC'],'contextSHA256':context_digest(c)}
 if c['createdAt']!=created or c['deadlineUTC']!=deadline or permit!=expected:raise Refused('Model permit does not bind this immutable allocation')
 return True

def wait_for_model_permit(created,deadline,directory='/run/unjailed/attestation'):
 base=protected(directory,True)
 if not os.statvfs(base).f_flag&os.ST_RDONLY:raise Refused('Model permit handoff must be read-only')
 wall,mono=time.time(),time.monotonic();expiry=timestamp(deadline)
 while max(time.time(),wall+time.monotonic()-mono)<expiry:
  if (base/'model-permit.json').exists():
   c=json.loads(protected(base/'context.json').read_text());permit=json.loads(protected(base/'model-permit.json').read_text())
   return verify_model_permit(c,permit,created,deadline)
  time.sleep(.05)
 raise Refused('External firewall permit absent at immutable expiry; no model child')
