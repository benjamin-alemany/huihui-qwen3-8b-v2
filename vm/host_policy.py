"""Trusted-host policy builder. No cloud API or execution from model-controlled input."""
import datetime as dt,hashlib,ipaddress,json,os,re,stat,tempfile
from pathlib import Path
MODEL_IP='10.203.0.2';BRIDGE='uj-m-host';TUNNEL_UID=10002
UUID=re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
IMAGE=re.compile(r'^ghcr\.io/benjamin-alemany/huihui-qwen3-8b-v2@sha256:[0-9a-f]{64}$')
class Refused(ValueError):pass

def timestamp(text):
    if not isinstance(text,str) or not text.endswith('Z'):raise Refused('UTC timestamp required')
    return dt.datetime.fromisoformat(text.replace('Z','+00:00')).timestamp()

def manifest_from(m):
    if not isinstance(m,dict) or set(m)!={'version','sessionId','nonce','createdAt','deadlineUTC','image','resources'} or type(m['version']) is not int or m['version']!=1 or not UUID.fullmatch(m['sessionId']) or not isinstance(m['nonce'],str) or not re.fullmatch('[0-9a-f]{32}',m['nonce']):raise Refused('Invalid resource manifest')
    start,end=timestamp(m['createdAt']),timestamp(m['deadlineUTC'])
    if not 0<end-start<=60*60 or not IMAGE.fullmatch(m['image']) or m['image'].endswith('0'*64):raise Refused('Invalid immutable runtime')
    r=m['resources']
    if not isinstance(r,dict) or set(r)!={'vmId','publicIpAddress','volumeIds'} or not (r['vmId'] is None or type(r['vmId']) is int and r['vmId']>0) or not (r['publicIpAddress'] is None or isinstance(r['publicIpAddress'],str)) or r['volumeIds']!=[]:raise Refused('Unexpected billable resource shape')
    if r['vmId'] is None and r['publicIpAddress'] is not None:raise Refused('Pre-create resource address must remain unknown')
    if r['publicIpAddress'] is not None:ipaddress.ip_address(r['publicIpAddress'])
    return m

def canonical(m):return json.dumps(manifest_from(m),sort_keys=True,separators=(',',':')).encode()
def progress(m,state,now,boot_id):
    manifest_from(m);start,end=timestamp(m['createdAt']),timestamp(m['deadlineUTC'])
    digest=hashlib.sha256(canonical(m)).hexdigest()
    if not start<=now<end:raise Refused('Immutable deadline expired or clock invalid')
    if state:
        if state['manifestSHA256']!=digest or now<state['lastSeenUTC']-1:raise Refused('Manifest changed or clock rolled back')
        if state['phase'] in ('failed','expired'):raise Refused('Failed bootstrap cannot auto-retry')
    return {**(state or {}),'manifestSHA256':digest,'deadlineUTC':m['deadlineUTC'],'lastSeenUTC':now,'bootId':boot_id,'phase':state['phase'] if state else 'new'}

def atomic(path,value):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    fd,name=tempfile.mkstemp(prefix='.unjailed-',dir=path.parent)
    try:
        os.fchmod(fd,0o600)
        with os.fdopen(fd,'w') as stream:json.dump(value,stream,sort_keys=True);stream.write('\n');stream.flush();os.fsync(stream.fileno())
        os.replace(name,path)
        directory=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
        try:os.fsync(directory)
        finally:os.close(directory)
    finally:
        if os.path.exists(name):os.unlink(name)

def root_file(path):
    p=Path(path);s=p.lstat()
    if stat.S_ISLNK(s.st_mode) or not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_mode&0o077:raise Refused('Root-only regular file required')
    return p

def nftables():
    # Table is dedicated to this new, disposable VM; never flush unrelated tables.
    return '''table inet unjailed {
 set tunnel4 { type ipv4_addr; flags interval; elements = { 198.41.192.0/24, 198.41.200.0/24 } }
 chain input { type filter hook input priority -200; policy drop;
  ct state invalid drop
  ct state established,related accept
  iifname "lo" accept
 }
 chain output { type filter hook output priority -200; policy drop;
  ct state invalid drop
  ct state established,related accept
  oifname "lo" accept
  meta skuid 10002 ip daddr 10.203.0.2 tcp dport 8000 accept
  meta skuid 10002 ip daddr @tunnel4 tcp dport 7844 accept
  meta skuid 10002 ip daddr { 1.1.1.1, 1.0.0.1 } udp dport 53 accept
  meta skuid 10002 ip daddr { 1.1.1.1, 1.0.0.1 } tcp dport 53 accept
 }
 chain forward { type filter hook forward priority -200; policy drop;
  iifname "uj-m-host" counter drop
  oifname "uj-m-host" counter drop
 }
}'''

def docker_arguments(m):
    manifest_from(m)
    return ['docker','run','--name','uj-model-'+m['sessionId'],'--label','unjailed.session='+m['sessionId'],'--restart=no','--read-only','--cap-drop=ALL','--cap-add=SETUID','--cap-add=SETGID','--security-opt=no-new-privileges','--pids-limit=256','--memory=24g','--cpus=8','--network=none','--mount=type=bind,source=/etc/unjailed/empty-resolv.conf,target=/etc/resolv.conf,readonly','--mount=type=bind,source=/etc/unjailed/empty-hosts,target=/etc/hosts,readonly','--mount=type=bind,source=/etc/unjailed/hostname,target=/etc/hostname,readonly','--mount=type=bind,source=/run/unjailed/attestations/'+m['sessionId']+',target=/run/unjailed/attestation,readonly','--ipc=private','--gpus=1','--tmpfs=/tmp:rw,nosuid,nodev,size=1g,mode=1777','--tmpfs=/cache:rw,nosuid,nodev,size=512m,uid=10001,gid=10001,mode=0700','--tmpfs=/home/inference:rw,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=0700','--env-file=/etc/unjailed/inference.env','--env=NVIDIA_DRIVER_CAPABILITIES=compute',m['image']]

def deadline_units(m):
    at=dt.datetime.fromtimestamp(timestamp(m['deadlineUTC']),dt.timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')
    return {'unjailed-deadline.timer':'[Unit]\nDescription=Immutable local inference stop\n[Timer]\nOnCalendar='+at+'\nPersistent=true\nAccuracySec=1s\n[Install]\nWantedBy=timers.target\n','unjailed-deadline.service':'[Unit]\nDescription=Stop local inference at immutable deadline\n[Service]\nType=oneshot\nExecStart=/usr/bin/python3 -I -B /opt/unjailed/vm/deadline.py\n'}
