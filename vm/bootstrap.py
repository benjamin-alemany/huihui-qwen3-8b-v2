"""Prepared root bootstrap, NOT run by import, CPU tests or a provider API.

Only a separately approved, disposable Ubuntu24 VM may invoke --execute.
The manifest's original absolute deadline survives all stages and the one reboot.
"""
import argparse,fcntl,hashlib,json,os,platform,re,selectors,shutil,signal,subprocess,sys,time,urllib.parse
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from host_policy import Refused,root_file,manifest_from,progress,atomic,deadline_units,timestamp
from metadata import records
from console_diagnostics import emit,APT_DIAGNOSTIC_PHASES
HERE=Path(__file__).resolve().parent
STATE=Path('/var/lib/unjailed/bootstrap.json');SESSION=Path('/etc/unjailed/session.json')
ENV={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','DEBIAN_FRONTEND':'noninteractive','LC_ALL':'C'}
METADATA_SECONDS=120
APT_REFRESH_SECONDS=120
MAX_COMMAND_OUTPUT=1024*1024
MAX_APT_OUTPUT=64*1024
_BUDGET=None

def apt_failure_phases(raw,outcome,returncode=None):
    # APT output is untrusted. Extract only fixed indicators from diagnostic
    # blocks, never successful URLs, arbitrary errors, credentials or paths.
    text=bytes(raw[:MAX_APT_OUTPUT]).decode('utf-8',errors='replace');blocks=[]
    for line in text.splitlines():
        if re.match(r'^(?:Err:\d+\s|[EW]:\s)',line):blocks.append(line)
        elif blocks and line.startswith((' ','\t')):blocks[-1]+=' '+line
    patterns={
      'dns':r'temporary failure resolving|could not resolve|name or service not known',
      'network':r'could not connect|cannot connect|connection (?:timed out|refused|failed|reset)|network is unreachable|no route to host',
      'tls':r'certificate verification failed|certificate is not trusted|certificate issuer is unknown|could not handshake|tls connection|ssl certificate',
      'signature':r'no_pubkey|badsig|expkeysig|signatures? (?:were|couldn.t be|could not be)|not signed|invalid signature',
      'integrity':r'hash sum mismatch|file has unexpected size|hashes? of expected file',
      'lock':r'could not get lock|unable to acquire .*lock|unable to lock',
      'repository':r'does not have a release file|404 not found|403 forbidden'}
    categories=set();repositories=set()
    for block in blocks:
        found={name for name,pattern in patterns.items() if re.search(pattern,block,re.I)}
        categories.update(found)
        for url in re.findall(r'https?://[^\s\x27"<>]+',block):
            try:host=urllib.parse.urlsplit(url).hostname
            except ValueError:continue
            if host in ('archive.ubuntu.com','security.ubuntu.com','ports.ubuntu.com') or host and host.endswith('.archive.ubuntu.com'):repositories.add('ubuntu')
            elif host=='developer.download.nvidia.com':repositories.add('cuda')
            elif host=='nvidia.github.io':repositories.add('toolkit')
            elif host=='download.docker.com':repositories.add('docker')
    category=next(iter(categories)) if len(categories)==1 else 'multiple' if categories else 'unknown'
    repository=next(iter(repositories)) if len(repositories)==1 else 'multiple' if repositories else 'unknown'
    if outcome=='exit':outcome='exit-100' if returncode==100 else 'exit-other'
    if outcome not in ('exit-100','exit-other','signal','timeout','deadline','output-bound'):outcome='unknown'
    return ('apt-failure-'+outcome,'apt-error-'+category,'apt-repo-'+repository)

class AptRefreshError(Refused):
    def __init__(self,raw,outcome,returncode=None):
        self.phases=apt_failure_phases(raw,outcome,returncode)
        if any(phase not in APT_DIAGNOSTIC_PHASES for phase in self.phases):raise Refused('Invalid fixed APT diagnosis')
        super().__init__('Trusted APT refresh refused')

class StartupBudget:
    def __init__(self,m):
        manifest_from(m);created,expiry=timestamp(m['createdAt']),timestamp(m['deadlineUTC'])
        self.expiry=min(expiry,created+min(900,expiry-created-120))
        self.wall,self.mono=time.time(),time.monotonic()
    def remaining(self):
        remaining=self.expiry-max(time.time(),self.wall+time.monotonic()-self.mono)
        if remaining<=0:raise Refused('Original bootstrap startup deadline reached')
        return remaining

def run(args,timeout=1200,line_callback=None,capture_apt_failure=False):
    # A socket's timeout is not an overall download deadline. Supervise the
    # complete trusted operation, including DNS, slow reads and its children.
    if type(timeout) not in (int,float) or not 0<timeout<=1200:raise Refused('Invalid bootstrap command deadline')
    if type(capture_apt_failure) is not bool or capture_apt_failure and (args!=apt_refresh_arguments() or line_callback is not None):raise Refused('APT diagnosis requires fixed refresh operation')
    output=bytearray();pending=bytearray();complete=False
    def denied(message,kind='unknown',code=None):
        if capture_apt_failure:raise AptRefreshError(output,kind,code)
        raise Refused(message)
    if _BUDGET is not None:
        try:timeout=min(timeout,_BUDGET.remaining())
        except Refused:denied('Original bootstrap startup deadline reached','deadline')
    deadline=time.monotonic()+timeout
    try:process=subprocess.Popen(args,env=ENV,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT if capture_apt_failure else subprocess.DEVNULL,start_new_session=True)
    except OSError:denied('Trusted bootstrap command failed')
    try:
        with selectors.DefaultSelector() as selector:
            os.set_blocking(process.stdout.fileno(),False);selector.register(process.stdout,selectors.EVENT_READ)
            while selector.get_map() or process.poll() is None:
                remaining=deadline-time.monotonic()
                if _BUDGET is not None:
                    try:remaining=min(remaining,_BUDGET.remaining())
                    except Refused:denied('Original bootstrap startup deadline reached','deadline')
                if remaining<=0:denied('Trusted bootstrap command timed out','timeout')
                for key,_ in selector.select(min(.1,remaining)):
                    data=os.read(key.fd,65536)
                    if not data:selector.unregister(key.fileobj);continue
                    limit=MAX_APT_OUTPUT if capture_apt_failure else MAX_COMMAND_OUTPUT;available=limit-len(output);output.extend(data[:available])
                    if len(data)>available:denied('Trusted bootstrap output exceeds bound','output-bound')
                    if line_callback is not None:
                        pending.extend(data)
                        while b'\n' in pending:
                            line,_,rest=pending.partition(b'\n');pending=bytearray(rest)
                            line_callback(line.decode('ascii'))
                        if len(pending)>1024:raise Refused('Trusted bootstrap progress exceeds bound')
            if line_callback is not None and pending:raise Refused('Incomplete trusted bootstrap progress')
        code=process.wait()
        if code!=0:denied('Trusted bootstrap command failed','signal' if code<0 else 'exit',code)
        complete=True;return output.decode('utf-8')
    except AptRefreshError:raise
    except Exception:
        if capture_apt_failure:raise AptRefreshError(output,'unknown') from None
        raise
    finally:
        if not complete:
            # Only this newly created process group. Never remove APT locks,
            # signal another installer, or continue using partial output.
            try:os.killpg(process.pid,signal.SIGKILL)
            except ProcessLookupError:pass
        process.stdout.close()
        try:process.wait(timeout=2)
        except subprocess.TimeoutExpired:raise Refused('Trusted bootstrap child cleanup refused')

def verify_metadata(report):
    phases={'metadata-cuda','metadata-toolkit','metadata-docker'};states={};done=False
    def line(value):
        nonlocal done
        if value=='UNJAILED_METADATA_VERIFIED':
            if done or set(states)!=phases or any(v!='passed' for v in states.values()):raise Refused('Incomplete vendor metadata proof')
            done=True;return
        if done or not value.startswith('UNJAILED_METADATA '):raise Refused('Unexpected vendor metadata progress')
        try:event=json.loads(value.removeprefix('UNJAILED_METADATA '))
        except (ValueError,TypeError):raise Refused('Invalid vendor metadata progress')
        if not isinstance(event,dict) or set(event)!={'phase','status'} or not isinstance(event['phase'],str) or event['phase'] not in phases or event['status'] not in ('running','passed','failed'):raise Refused('Invalid vendor metadata progress')
        phase,status=event['phase'],event['status'];previous=states.get(phase)
        if (status=='running' and previous is not None) or (status!='running' and previous!='running'):raise Refused('Invalid vendor metadata transition')
        states[phase]=status;report(phase,status)
    run([sys.executable,'-I','-B',str(HERE/'metadata.py'),'--progress'],timeout=METADATA_SECONDS,line_callback=line)
    if not done:raise Refused('Vendor metadata verification incomplete')

def apt_refresh_arguments():
    return ['apt-get','--error-on=any','-o','Acquire::Retries=0','-o','Acquire::http::Timeout=20','-o','Acquire::https::Timeout=20','-o','APT::Get::AllowUnauthenticated=false','-o','Acquire::AllowInsecureRepositories=false','-o','Acquire::AllowDowngradeToInsecureRepositories=false','update']

def refresh_indexes(diagnostic=None):
    try:run(apt_refresh_arguments(),timeout=APT_REFRESH_SECONDS,capture_apt_failure=True)
    except AptRefreshError as error:
        if diagnostic:
            for phase in error.phases:diagnostic(phase)
        raise

def host():
    if os.geteuid()!=0 or sys.platform!='linux' or platform.machine()!='x86_64':raise Refused('Dedicated amd64 Linux root host required')
    release=Path('/etc/os-release').read_text()
    if not re.search(r'^ID=ubuntu$',release,re.M) or not re.search(r'^VERSION_ID="24\.04"$',release,re.M):raise Refused('Plain Ubuntu24.04 required')
    for path in Path('/sys/firmware/efi/efivars').glob('SecureBoot-*'):
        if len(path.read_bytes())<5 or path.read_bytes()[4]!=0:raise Refused('Secure Boot requires separate reviewed signing; no downgrade')

def validate_apt_sources():
    paths=[Path('/etc/apt/sources.list'),*Path('/etc/apt/sources.list.d').glob('*.list'),*Path('/etc/apt/sources.list.d').glob('*.sources')]
    for p in paths:
        if not p.exists():continue
        text='\n'.join(line for line in p.read_text().splitlines() if not line.lstrip().startswith('#'))
        if any(token in text.lower() for token in ['trusted=yes','allow-insecure=yes','allow-unauthenticated']):raise Refused('Insecure APT source option')
        for url in re.findall(r'https?://[^\s\]<>]+',text):
            host=urllib.parse.urlsplit(url).hostname
            ubuntu=host in ['archive.ubuntu.com','security.ubuntu.com','ports.ubuntu.com'] or bool(host and host.endswith('.archive.ubuntu.com'))
            if not ubuntu and not (p.name=='unjailed.list' and url.startswith(('https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2404/x86_64/','https://nvidia.github.io/libnvidia-container/stable/deb/amd64/','https://download.docker.com/linux/ubuntu'))):raise Refused('Unreviewed APT repository')

def apt_sources(lock):
    keydir=Path('/etc/apt/keyrings');keydir.mkdir(mode=0o755,exist_ok=True)
    for name,r in lock['repositories'].items():
        src=HERE/'keys'/(name+'.gpg')
        if hashlib.sha256(src.read_bytes()).hexdigest()!=r['key_sha256']:raise Refused('Pinned signing key changed')
        dst=keydir/('unjailed-'+name+'.gpg');shutil.copyfile(src,dst);dst.chmod(0o644)
    lines=[
      'deb [arch=amd64 signed-by=/etc/apt/keyrings/unjailed-cuda.gpg] https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2404/x86_64/ /',
      'deb [arch=amd64 signed-by=/etc/apt/keyrings/unjailed-toolkit.gpg] https://nvidia.github.io/libnvidia-container/stable/deb/amd64/ /',
      'deb [arch=amd64 signed-by=/etc/apt/keyrings/unjailed-docker.gpg] https://download.docker.com/linux/ubuntu noble stable']
    Path('/etc/apt/sources.list.d/unjailed.list').write_text('\n'.join(lines)+'\n')
    Path('/etc/apt/preferences.d/unjailed').write_text('\n'.join('Package: '+p['name']+'\nPin: version '+p['version']+'\nPin-Priority: 1001\n' for p in lock['packages']))

def resolve(lock,kernel):
    if not re.fullmatch('[A-Za-z0-9.+-]{1,100}',kernel):raise Refused('Invalid running kernel')
    roots=[p['name']+'='+p['version'] for p in lock['packages']]
    roots+=['linux-headers-'+kernel,'build-essential','kmod','patch','pahole','nftables','iproute2','libseccomp2','util-linux']
    plan=run(['apt-get','-s','--no-install-recommends','install',*roots]);selected=[]
    pinned={p['name']:p for p in lock['packages']}
    for line in plan.splitlines():
        if not line.startswith('Inst '):continue
        match=re.match(r'^Inst ([A-Za-z0-9+.-]+)(?::amd64)?(?: \[[^]]+\])? \(([^ ]+)',line)
        if not match:raise Refused('Unrecognized APT resolution')
        name,version=match.groups();entries=records(run(['apt-cache','show',name+'='+version]).encode())
        candidates=[p for p in entries if p.get('Version')==version and p.get('Architecture') in ['all','amd64'] and re.fullmatch('[0-9a-f]{64}',p.get('SHA256',''))]
        if name in pinned:candidates=[p for p in candidates if p['SHA256']==pinned[name]['sha256'] and version==pinned[name]['version']]
        elif name.startswith(('nvidia-','libnvidia-','cuda-','docker-','containerd')):raise Refused('Unreviewed vendor package')
        if len(candidates)!=1:raise Refused('Exact target package digest unresolved')
        p=candidates[0];selected.append({'name':name,'version':version,'architecture':p['Architecture'],'sha256':p['SHA256']})
    return roots,selected

def install(lock,kernel,report=None):
    # apt-get uses authenticated Ubuntu/vendor metadata; no insecure override.
    if report:report('package-resolve')
    roots,selected=resolve(lock,kernel);atomic('/var/lib/unjailed/resolved-packages.json',{'kernel':kernel,'packages':selected})
    if report:report('package-resolve','passed')
    cache=Path('/var/lib/unjailed/packages');cache.mkdir(mode=0o700,exist_ok=True);archives=cache/'archives';archives.mkdir(mode=0o755,exist_ok=True)
    opts=['-o','Dir::Cache='+str(cache),'-o','Dir::Cache::archives='+str(archives),'-o','APT::Get::AllowUnauthenticated=false','-o','Acquire::AllowInsecureRepositories=false']
    if report:report('package-download')
    run(['apt-get',*opts,'--yes','--download-only','--no-install-recommends','install',*roots])
    if report:report('package-download','passed');report('package-verify')
    expected={(p['name'],p['version'],p['architecture']):p for p in selected};seen=set()
    for file in archives.glob('*.deb'):
        fields=[run(['dpkg-deb','--field',str(file),name]).strip() for name in ['Package','Version','Architecture']];key=tuple(fields)
        if key not in expected or hashlib.sha256(file.read_bytes()).hexdigest()!=expected[key]['sha256']:raise Refused('Downloaded package does not match reviewed target lock')
        seen.add(key)
    if seen!=set(expected):raise Refused('Target package closure incomplete')
    if report:report('package-verify','passed');report('package-install')
    run(['apt-get',*opts,'--yes','--no-download','--no-install-recommends','install',*roots])
    run(['apt-mark','hold',*[p['name'] for p in lock['packages']]])
    for p in lock['packages']:
        if run(['dpkg-query','--show','--showformat=${Version}',p['name']]).strip()!=p['version']:raise Refused('Installed vendor version mismatch')
    if report:report('package-install','passed')

def kernel_probe(lock,kernel):
    expected=lock['driver_version']
    if run(['modinfo','-F','version','nvidia']).strip()!=expected:raise Refused('R580 module mismatch')
    if run(['modinfo','-F','vermagic','nvidia']).split()[0]!=kernel:raise Refused('NVIDIA module not built for running kernel')
    run(['modprobe','nvidia']);run(['modprobe','nvidia_uvm'])
    versions=run(['nvidia-smi','--query-gpu=driver_version','--format=csv,noheader']).strip().splitlines()
    if versions!=[expected]:raise Refused('Expected exactly one GPU and exact R580 version')

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--execute',action='store_true');args=parser.parse_args()
    if not args.execute:raise Refused('Preparation only; explicit approved VM execution required')
    m=manifest_from(json.loads(root_file(SESSION).read_text()))
    global _BUDGET
    previous_budget=_BUDGET;_BUDGET=StartupBudget(m)
    try:return bootstrap(m)
    finally:_BUDGET=previous_budget

def bootstrap(m):
    emit(m,'bootstrap','new')
    try:host()
    except Exception:
        emit(m,'bootstrap','new','failed');raise
    lock=json.loads((HERE/'packages.lock.json').read_text())
    STATE.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    with (STATE.parent/'bootstrap.lock').open('a') as handle:
        fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
        previous=json.loads(root_file(STATE).read_text()) if STATE.exists() else None
        boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip();state=progress(m,previous,time.time(),boot);old_boot=previous.get('bootId') if previous else None
        diagnostic_phase=state['phase']
        def report(phase,status='running'):
            nonlocal diagnostic_phase
            diagnostic_phase=phase;emit(m,'bootstrap',phase,status)
        def save(phase):
            state.update(progress(m,state,time.time(),boot));state['phase']=phase;atomic(STATE,state)
            report(phase,'passed' if phase=='host-ready-model-not-started' else 'running')
        try:
            report(diagnostic_phase)
            # Local timer is armed before metadata, package downloads or reboot.
            for name,text in deadline_units(m).items():Path('/etc/systemd/system',name).write_text(text)
            run(['systemctl','daemon-reload']);run(['systemctl','enable','--now','unjailed-deadline.timer'])
            if state['phase']=='new':
                atomic(STATE,state);report('metadata-review');verify_metadata(report);report('metadata-review','passed')
                report('apt-source-review');apt_sources(lock);validate_apt_sources();report('apt-source-review','passed')
                report('apt-index-refresh');refresh_indexes(diagnostic=lambda phase:emit(m,'bootstrap',phase,'failed'));report('apt-index-refresh','passed');save('installing')
                install(lock,platform.release(),report=report);save('awaiting-reboot')
                shutil.copyfile(HERE/'bootstrap.service','/etc/systemd/system/unjailed-bootstrap.service')
                run(['systemctl','daemon-reload']);run(['systemctl','enable','unjailed-bootstrap.service']);run(['systemctl','reboot']);return
            if state['phase']=='installing':raise Refused('Interrupted installation requires operator review; no automatic reinstall')
            if state['phase']=='awaiting-reboot' and old_boot==boot:raise Refused('Driver reboot not observed')
            report('driver-check');kernel_probe(lock,platform.release());report('driver-check','passed')
            report('docker-runtime-config');Path('/etc/docker').mkdir(exist_ok=True)
            # Docker CE's systemd unit already supplies -H fd://. A second
            # hosts directive in daemon.json makes dockerd refuse startup.
            shutil.copyfile(HERE/'daemon.json','/etc/docker/daemon.json');run(['nvidia-ctk','runtime','configure','--runtime=docker']);report('docker-runtime-config','passed')
            report('docker-start');run(['systemctl','restart','docker']);report('docker-start','passed')
            save('host-ready-model-not-started');print('HOST_READY_MODEL_NOT_STARTED')
        except Exception:
            state['failurePhase']=diagnostic_phase;state['phase']='failed';atomic(STATE,state);report(diagnostic_phase,'failed')
            subprocess.run(['systemctl','stop','docker'],env=ENV,capture_output=True,timeout=20)
            raise
if __name__=='__main__':
    try:main()
    except Exception:raise SystemExit('Trusted VM bootstrap refused; no model start or fallback')
