"""One-shot prepared-host validation/configuration. No package work or reboot.

Only a source-pinned root profile selects this entry point. A failed or completed
attempt cannot rerun. Native isolation, CUDA, firewall and model permits belong
to the unchanged later runtime gates, never to this host-ready state.
"""
import datetime as dt,fcntl,json,os,re,stat,sys,tempfile,time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from host_policy import Refused,manifest_from,root_file,progress,atomic,deadline_units,timestamp
from prepared_host import verify_prepared_host
from bootstrap import run as command_run
from console_diagnostics import emit

HERE=Path(__file__).resolve().parent
SESSION=Path('/etc/unjailed/session.json')
PROFILE=Path('/etc/unjailed/prepared-host-profile.json')
HOST_LOCK=HERE/'prepared-host.lock.json'
STATE=Path('/var/lib/unjailed/bootstrap.json')
SYSTEMD=Path('/etc/systemd/system')
DAEMON=Path('/etc/docker/daemon.json')
BOOT_ID=Path('/proc/sys/kernel/random/boot_id')
DAEMON_POLICY={'iptables':False,'ip6tables':False,'ip-forward':False,'userland-proxy':False,'live-restore':False,'bridge':'none','log-driver':'local','log-opts':{'max-size':'10m','max-file':'2'}}

def refused():raise Refused('Prepared bootstrap refused; no package work, reboot or model start')
def unique(pairs):
    value={}
    for key,item in pairs:
        if key in value:refused()
        value[key]=item
    return value
def strict_json(raw):
    try:return json.loads(raw,object_pairs_hook=unique,parse_constant=lambda _:refused())
    except Exception:refused()
def profile_from(value):
    if not isinstance(value,dict) or set(value)!={'version','mode','hostLockSHA256'} or type(value['version']) is not int or value['version']!=1 or value['mode']!='prepared-host-r570-v1' or not isinstance(value['hostLockSHA256'],str) or not re.fullmatch('[0-9a-f]{64}',value['hostLockSHA256']) or value['hostLockSHA256']=='0'*64:refused()
    return dict(value)
def source_bytes(path,maximum=256*1024):
    try:
        info=path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022 or not 0<info.st_size<=maximum:refused()
        data=path.read_bytes()
        if len(data)!=info.st_size:refused()
        return data
    except OSError:refused()
def protected_directory(path,private=False):
    path.mkdir(parents=True,exist_ok=True,mode=0o700 if private else 0o755)
    info=path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&(0o077 if private else 0o022):refused()
def write_config(path,data,existing_must_match=False):
    protected_directory(path.parent)
    if path.exists() or path.is_symlink():
        previous=source_bytes(path)
        if existing_must_match and previous!=data:refused()
    descriptor,name=tempfile.mkstemp(prefix='.unjailed-prepared-',dir=path.parent)
    try:
        os.fchmod(descriptor,0o644)
        with os.fdopen(descriptor,'wb') as stream:stream.write(data);stream.flush();os.fsync(stream.fileno())
        os.replace(name,path)
        directory=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
        try:os.fsync(directory)
        finally:os.close(directory)
    finally:
        if os.path.exists(name):os.unlink(name)
def configured_daemon(value):
    if not isinstance(value,dict) or set(value)!=set(DAEMON_POLICY)|{'runtimes'} or any(value.get(key)!=item for key,item in DAEMON_POLICY.items()):refused()
    runtimes=value['runtimes']
    if not isinstance(runtimes,dict) or set(runtimes)!={'nvidia'}:refused()
    runtime=runtimes['nvidia']
    if not isinstance(runtime,dict) or set(runtime) not in ({'path','args'},{'path','runtimeArgs'}) or runtime.get('path') not in ('nvidia-container-runtime','/usr/bin/nvidia-container-runtime') or runtime.get('args',runtime.get('runtimeArgs'))!=[]:refused()
    return value

def prepared_deadline_units(session):
    # Legacy rendering rounds to whole seconds. This explicitly selected
    # profile must retain the original fractional expiry, never fire before it.
    manifest_from(session)
    expiry=dt.datetime.fromisoformat(session['deadlineUTC'].replace('Z','+00:00'))
    calendar=expiry.strftime('%Y-%m-%d %H:%M:%S')
    if expiry.microsecond:calendar+='.'+f'{expiry.microsecond:06d}'.rstrip('0')
    calendar+=' UTC'
    units=deadline_units(session);name='unjailed-deadline.timer';timer=units[name]
    if len(re.findall(r'^OnCalendar=.*$',timer,re.M))!=1:refused()
    timer=re.sub(r'^OnCalendar=.*$','OnCalendar='+calendar,timer,count=1,flags=re.M)
    units[name]=timer.replace('AccuracySec=1s\n','AccuracySec=1us\n')
    return units

def execute_prepared(session,profile,*,runner=None,verifier=None,reporter=None,now=None,monotonic=None):
    """Validate one fixed root session; injectable operations support pure tests.

    runner(argv, timeout) must return text or raise on failure. verifier uses
    prepared_host.verify_prepared_host's signature. Paths are fixed module
    constants; CLI/owner/model input cannot supply paths or commands.
    """
    manifest_from(session);profile=profile_from(profile)
    clock=now or time.time;mono=monotonic or time.monotonic
    # Retain the immutable original window across all stages; a private
    # monotonic clock prevents renewing that window through a wall-clock edit.
    wall,started=clock(),mono()
    end=min(timestamp(session['createdAt'])+900,timestamp(session['deadlineUTC'])-120)
    if not timestamp(session['createdAt'])<=wall<end:refused()
    def remaining():
        value=end-max(clock(),wall+mono()-started)
        if value<=0:refused()
        return value
    invoke=runner or (lambda args,timeout:command_run(args,timeout=timeout))
    verify=verifier or verify_prepared_host
    report=reporter or (lambda phase,status='running':emit(session,'bootstrap',phase,status))
    def command(args,seconds=120):
        result=invoke(args,min(seconds,remaining()));remaining()
        if not isinstance(result,str):refused()
        return result
    protected_directory(STATE.parent,private=True)
    lock_path=STATE.parent/'bootstrap.lock'
    descriptor=os.open(lock_path,os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW,0o600)
    with os.fdopen(descriptor,'a') as handle:
        info=os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o077:refused()
        fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
        if STATE.exists() or STATE.is_symlink():refused()
        boot=BOOT_ID.read_text().strip()
        if not re.fullmatch('[0-9a-f-]{36}',boot):refused()
        state=progress(session,None,clock(),boot)
        state.update(phase='prepared-verifying',hostProfile=profile['mode'],hostLockSHA256=profile['hostLockSHA256'])
        atomic(STATE,state);phase='driver-check';verified=False
        try:
            report(phase)
            # Source lock is fixed, root-owned and independently pinned. The
            # verifier hashes its reviewed host executables before commands.
            raw=source_bytes(HOST_LOCK)
            proof=verify(session,raw,profile['hostLockSHA256'],runner=runner,now=clock,monotonic=mono)
            expected={'version':1,'profile':'hyperstack-prepared-r570-v1','hostImageId':517,'lockSha256':profile['hostLockSHA256'],'preparedHostValidated':True,'driverBranch':570,'modelLoaded':False,'cudaValidated':False,'agentToolsEnabled':False}
            if proof!=expected:refused()
            remaining();verified=True;report(phase,'passed');phase='new';report(phase)
            for name,value in prepared_deadline_units(session).items():write_config(SYSTEMD/name,value.encode(),existing_must_match=True)
            command(['/usr/bin/systemctl','daemon-reload'])
            command(['/usr/bin/systemctl','enable','--now','unjailed-deadline.timer'])
            command(['/usr/bin/systemctl','is-active','--quiet','unjailed-deadline.timer'])
            phase='docker-runtime-config';report(phase)
            policy_bytes=source_bytes(HERE/'daemon.json',16384)
            if strict_json(policy_bytes)!=DAEMON_POLICY:refused()
            write_config(DAEMON,policy_bytes)
            command(['/usr/bin/nvidia-ctk','runtime','configure','--runtime=docker'])
            configured_daemon(strict_json(source_bytes(DAEMON,16384)));report(phase,'passed')
            phase='docker-start';report(phase)
            command(['/usr/bin/systemctl','restart','docker']);report(phase,'passed')
            remaining();state.update(progress(session,state,clock(),boot));state['phase']='host-ready-model-not-started';atomic(STATE,state)
            report('host-ready-model-not-started','passed')
            return state
        except Exception:
            state['phase']='failed';state['failurePhase']=phase;atomic(STATE,state)
            try:report(phase,'failed')
            except Exception:pass
            if verified:
                # Cleanup never renews a timer or starts/retries a workload.
                try:invoke(['/usr/bin/systemctl','stop','docker'],20)
                except Exception:pass
            raise Refused('Prepared bootstrap failed; no retry or model start') from None

def main():
    if sys.argv[1:]!=['--execute'] or sys.platform!='linux' or os.geteuid()!=0:refused()
    session=manifest_from(strict_json(root_file(SESSION).read_bytes()))
    profile=profile_from(strict_json(root_file(PROFILE).read_bytes()))
    execute_prepared(session,profile)
    print('HOST_READY_MODEL_NOT_STARTED')

if __name__=='__main__':
    try:main()
    except Exception:raise SystemExit('Prepared bootstrap refused; no package work, reboot or model start')
