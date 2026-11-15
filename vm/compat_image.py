"""Verify existing image compatibility bytes in a restricted CPU container.

No build/publication, GPU request, model import, provider API or credentials.
Only two reviewed public files enter the disposable verification container.
The model container receives a fixed loader path afterward, never new mounts.
"""
import argparse,datetime as dt,hashlib,json,os,re,stat,subprocess,sys,tempfile,time,uuid
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from host_policy import Refused,manifest_from,timestamp

HERE=Path(__file__).resolve().parent
IMAGE='ghcr.io/benjamin-alemany/huihui-qwen3-8b-v2@sha256:86b61fca502d259910c36ec372c31adf59e0fb4495371904acc20f6bde535278'
HELPER_SHA256='f0b59d53b57c2f14ecc50de9a19f02d1d146f5a12ac8b07c2395cb4a980d5faa'
LOCK_SHA256='26ade5e7f4a83f68f06c977aed5f33b5f361bf6002458340548d6100dec45161'
LIBRARY_PATH='/usr/local/cuda-13.0/compat:/usr/local/cuda-13.0/targets/x86_64-linux/lib'
TARGET='/opt/unjailed-compat'
ENV={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C'}
INSPECT='{"id":{{json .Id}},"name":{{json .Name}},"config":{{json .Config}},"host":{{json .HostConfig}},"mounts":{{json .Mounts}}}'
CHECK_SCRIPT='''import hashlib,json,os,sys
sys.path.insert(0,"/opt/unjailed-compat")
from cuda_compat import lock_digest,verify_compatibility
if os.getuid()!=10001 or os.getgid()!=10001 or not os.statvfs("/").f_flag&os.ST_RDONLY:raise ValueError("CPU verification boundary refused")
if any(name.startswith("nvidia") for name in os.listdir("/dev")):raise ValueError("GPU device exposed to CPU verification")
fields=dict(line.split(":",1) for line in open("/proc/self/status") if ":" in line)
if fields.get("NoNewPrivs","").strip()!="1" or any(int(fields.get(k,"1"),16) for k in ("CapEff","CapPrm","CapInh","CapAmb")):raise ValueError("CPU verification privileges refused")
with open("/opt/unjailed-compat/cuda-compat.lock.json") as source:lock=json.load(source)
if lock_digest(lock)!="26ade5e7f4a83f68f06c977aed5f33b5f361bf6002458340548d6100dec45161":raise ValueError("Compatibility lock differs")
value=verify_compatibility(lock)
if value!="/usr/local/cuda-13.0/compat:/usr/local/cuda-13.0/targets/x86_64-linux/lib" or "torch" in sys.modules or "vllm" in sys.modules:raise ValueError("Fixed CPU compatibility verification refused")
print(json.dumps({"version":1,"kind":"existing-image-compat-cpu-v1","image":"ghcr.io/benjamin-alemany/huihui-qwen3-8b-v2@sha256:86b61fca502d259910c36ec372c31adf59e0fb4495371904acc20f6bde535278","lockSHA256":"26ade5e7f4a83f68f06c977aed5f33b5f361bf6002458340548d6100dec45161","libraryPath":value,"modelLoaded":False,"cudaInitialized":False,"gpuUsed":False},sort_keys=True,separators=(",",":")))
'''
COMMAND=['-i','PATH=/usr/local/bin:/usr/bin:/bin','LC_ALL=C','/usr/bin/python3','-I','-S','-B','-c',CHECK_SCRIPT]

def refused():raise Refused('Existing image compatibility verification refused; no GPU or model start')
def _canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=True,allow_nan=False)
def _unique(pairs):
    result={}
    for key,value in pairs:
        if key in result:refused()
        result[key]=value
    return result
def _json(raw):
    try:return json.loads(raw,object_pairs_hook=_unique,parse_constant=lambda _:refused())
    except Exception:refused()
def process_runner(args,seconds):
    try:result=subprocess.run(args,env=ENV,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=seconds,check=False)
    except (OSError,subprocess.SubprocessError):refused()
    if result.returncode or len(result.stdout)>1024*1024:refused()
    try:return result.stdout.decode('utf-8').strip()
    except UnicodeError:refused()
def _public_bytes(path):
    try:
        info=path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.geteuid() or info.st_mode&0o022 or not 0<info.st_size<=65536:refused()
        data=path.read_bytes()
        if len(data)!=info.st_size:refused()
        return data
    except OSError:refused()
def _stage_sources(directory):
    raw={'cuda_compat.py':_public_bytes(HERE/'cuda_compat.py'),'cuda-compat.lock.json':_public_bytes(HERE/'cuda-compat.lock.json')}
    if hashlib.sha256(raw['cuda_compat.py']).hexdigest()!=HELPER_SHA256 or hashlib.sha256(_canonical(_json(raw['cuda-compat.lock.json'])).encode()).hexdigest()!=LOCK_SHA256:refused()
    result={}
    for name,data in raw.items():
        target=Path(directory)/name
        with target.open('xb') as stream:stream.write(data);stream.flush();os.fsync(stream.fileno())
        target.chmod(0o444)
        info=target.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.geteuid() or stat.S_IMODE(info.st_mode)!=0o444 or hashlib.sha256(target.read_bytes()).digest()!=hashlib.sha256(data).digest():refused()
        result[name]=str(target)
    return result
def create_arguments(session,sources):
    manifest_from(session)
    if session['image']!=IMAGE or set(sources)!={'cuda_compat.py','cuda-compat.lock.json'}:refused()
    name='uj-compat-'+session['sessionId']
    return ['/usr/bin/docker','create','--name',name,'--label','unjailed.compat-session='+session['sessionId'],'--label','unjailed.compat-nonce='+session['nonce'],'--restart=no','--runtime=runc','--network=none','--ipc=private','--read-only','--user','10001:10001','--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit=64','--memory=1g','--cpus=1','--workdir=/','--env=NVIDIA_VISIBLE_DEVICES=void',*sum((['--mount','type=bind,source='+sources[name]+',target='+TARGET+'/'+name+',readonly'] for name in sorted(sources)),[]),'--entrypoint','/usr/bin/env',IMAGE,*COMMAND]
def _owned(value,session,sources,container_id=None):
    _identity(value,session,container_id)
    if not isinstance(value,dict) or set(value)!={'id','name','config','host','mounts'} or not isinstance(value['id'],str) or not re.fullmatch('[0-9a-f]{64}',value['id']) or container_id is not None and value['id']!=container_id or value['name']!='/uj-compat-'+session['sessionId']:refused()
    config=value['config'];host=value['host'];mounts=value['mounts']
    if not isinstance(config,dict) or config.get('Image')!=IMAGE or config.get('User')!='10001:10001' or config.get('Entrypoint')!=['/usr/bin/env'] or config.get('Cmd')!=COMMAND or config.get('WorkingDir')!='/':refused()
    labels=config.get('Labels')
    if not isinstance(labels,dict) or labels.get('unjailed.compat-session')!=session['sessionId'] or labels.get('unjailed.compat-nonce')!=session['nonce']:refused()
    if not isinstance(config.get('Env'),list) or [item for item in config['Env'] if item.startswith('NVIDIA_VISIBLE_DEVICES=')]!=['NVIDIA_VISIBLE_DEVICES=void']:refused()
    if not isinstance(host,dict) or any(host.get(key)!=value for key,value in {'Runtime':'runc','NetworkMode':'none','IpcMode':'private','ReadonlyRootfs':True,'Privileged':False,'PidsLimit':64,'Memory':1024**3,'NanoCpus':10**9,'PidMode':'','UTSMode':''}.items()) or host.get('CapDrop')!=['ALL'] or host.get('SecurityOpt') not in (['no-new-privileges'],['no-new-privileges=true']):refused()
    if any(host.get(key) not in (None,[]) for key in ['CapAdd','Devices','DeviceRequests','VolumesFrom','GroupAdd']) or host.get('PortBindings') not in (None,{}) or host.get('PublishAllPorts') is not False:refused()
    if host.get('RestartPolicy',{}).get('Name')!='no':refused()
    if not isinstance(mounts,list) or len(mounts)!=2:refused()
    expected={TARGET+'/'+name:source for name,source in sources.items()};seen=set()
    for mount in mounts:
        if not isinstance(mount,dict) or mount.get('Type')!='bind' or mount.get('RW') is not False or expected.get(mount.get('Destination'))!=mount.get('Source') or mount['Destination'] in seen:refused()
        seen.add(mount['Destination'])
    return value['id']
def _identity(value,session,container_id=None):
    if not isinstance(value,dict) or not isinstance(value.get('id'),str) or not re.fullmatch('[0-9a-f]{64}',value['id']) or container_id is not None and value['id']!=container_id or value.get('name')!='/uj-compat-'+session['sessionId']:refused()
    config=value.get('config');labels=config.get('Labels') if isinstance(config,dict) else None
    if not isinstance(config,dict) or config.get('Image')!=IMAGE or not isinstance(labels,dict) or labels.get('unjailed.compat-session')!=session['sessionId'] or labels.get('unjailed.compat-nonce')!=session['nonce']:refused()
    return value['id']
def verify_compat_image(image,session,*,runner=None,cleanup_runner=None,now=None,monotonic=None):
    """Return only the fixed verified path after the CPU container is removed."""
    manifest_from(session)
    if image!=IMAGE or session['image']!=IMAGE:refused()
    clock=now or time.time;mono=monotonic or time.monotonic;wall,started=clock(),mono()
    expiry=min(timestamp(session['deadlineUTC']),timestamp(session['createdAt'])+900)
    if not timestamp(session['createdAt'])<=wall<expiry:refused()
    execute=runner or process_runner;cleanup=cleanup_runner or execute
    def command(args,seconds=30):
        left=min(120-(mono()-started),expiry-max(clock(),wall+mono()-started))
        if left<=0:refused()
        result=execute(args,min(seconds,left))
        if not isinstance(result,str) or len(result.encode())>1024*1024:refused()
        return result.strip()
    receipt={'version':1,'kind':'existing-image-compat-cpu-v1','image':IMAGE,'lockSHA256':LOCK_SHA256,'libraryPath':LIBRARY_PATH,'modelLoaded':False,'cudaInitialized':False,'gpuUsed':False}
    container_id=None;attempted=False;passed=False;removed=False
    with tempfile.TemporaryDirectory(prefix='unjailed-compat-') as directory:
        sources=_stage_sources(directory)
        try:
            attempted=True;container_id=command(create_arguments(session,sources))
            if not re.fullmatch('[0-9a-f]{64}',container_id):refused()
            _owned(_json(command(['/usr/bin/docker','inspect','--format',INSPECT,container_id])),session,sources,container_id)
            result=command(['/usr/bin/docker','start','--attach',container_id],120)
            if _json(result)!=receipt or _canonical(_json(result))!=result:refused()
            passed=True
        except Exception:passed=False
        finally:
            if attempted:
                try:
                    # Even a lost create reply cannot authorize a blind delete.
                    identity=container_id if isinstance(container_id,str) and re.fullmatch('[0-9a-f]{64}',container_id) else 'uj-compat-'+session['sessionId']
                    owned=_identity(_json(cleanup(['/usr/bin/docker','inspect','--format',INSPECT,identity],10)),session,container_id if identity==container_id else None)
                    try:cleanup(['/usr/bin/docker','rm','--force',owned],10)
                    except Exception:pass
                    removed=cleanup(['/usr/bin/docker','container','ls','--all','--no-trunc','--filter','id='+owned,'--format','{{.ID}}'],10).strip()==''
                except Exception:removed=False
    if not passed or not removed:refused()
    return LIBRARY_PATH

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--execute',action='store_true',required=True);parser.parse_args()
    if sys.platform!='linux':refused()
    start=dt.datetime.now(dt.timezone.utc);iso=lambda value:value.isoformat(timespec='milliseconds').replace('+00:00','Z')
    session={'version':1,'sessionId':str(uuid.uuid4()),'nonce':uuid.uuid4().hex,'createdAt':iso(start),'deadlineUTC':iso(start+dt.timedelta(minutes=30)),'image':IMAGE,'resources':{'vmId':None,'publicIpAddress':None,'volumeIds':[]}}
    value=verify_compat_image(IMAGE,session)
    print(_canonical({'version':1,'kind':'existing-image-cpu-compat-verified','image':IMAGE,'libraryPath':value,'modelLoaded':False,'cudaInitialized':False,'gpuUsed':False}))

if __name__=='__main__':
    try:main()
    except Exception:raise SystemExit('Existing image compatibility verification refused; no GPU or model start')
