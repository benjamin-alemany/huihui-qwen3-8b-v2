"""Prepared root bootstrap, NOT run by import, CPU tests or a provider API.

Only a separately approved, disposable Ubuntu24 VM may invoke --execute.
The manifest's original absolute deadline survives all stages and the one reboot.
"""
import argparse,fcntl,hashlib,json,os,platform,re,shutil,subprocess,sys,time,urllib.parse
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from host_policy import Refused,root_file,manifest_from,progress,atomic,deadline_units
from metadata import verify,records
HERE=Path(__file__).resolve().parent
STATE=Path('/var/lib/unjailed/bootstrap.json');SESSION=Path('/etc/unjailed/session.json')
ENV={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','DEBIAN_FRONTEND':'noninteractive','LC_ALL':'C'}

def run(args,timeout=1200):
    r=subprocess.run(args,env=ENV,capture_output=True,text=True,timeout=timeout)
    if r.returncode:raise Refused('Trusted bootstrap command failed: '+args[0])
    return r.stdout

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

def install(lock,kernel):
    # apt-get uses authenticated Ubuntu/vendor metadata; no insecure override.
    roots,selected=resolve(lock,kernel);atomic('/var/lib/unjailed/resolved-packages.json',{'kernel':kernel,'packages':selected})
    cache=Path('/var/lib/unjailed/packages');cache.mkdir(mode=0o700,exist_ok=True);archives=cache/'archives';archives.mkdir(mode=0o755,exist_ok=True)
    opts=['-o','Dir::Cache='+str(cache),'-o','Dir::Cache::archives='+str(archives),'-o','APT::Get::AllowUnauthenticated=false','-o','Acquire::AllowInsecureRepositories=false']
    run(['apt-get',*opts,'--yes','--download-only','--no-install-recommends','install',*roots])
    expected={(p['name'],p['version'],p['architecture']):p for p in selected};seen=set()
    for file in archives.glob('*.deb'):
        fields=[run(['dpkg-deb','--field',str(file),name]).strip() for name in ['Package','Version','Architecture']];key=tuple(fields)
        if key not in expected or hashlib.sha256(file.read_bytes()).hexdigest()!=expected[key]['sha256']:raise Refused('Downloaded package does not match reviewed target lock')
        seen.add(key)
    if seen!=set(expected):raise Refused('Target package closure incomplete')
    run(['apt-get',*opts,'--yes','--no-download','--no-install-recommends','install',*roots])
    run(['apt-mark','hold',*[p['name'] for p in lock['packages']]])
    for p in lock['packages']:
        if run(['dpkg-query','--show','--showformat=${Version}',p['name']]).strip()!=p['version']:raise Refused('Installed vendor version mismatch')

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
    host();m=manifest_from(json.loads(root_file(SESSION).read_text()));lock=json.loads((HERE/'packages.lock.json').read_text())
    STATE.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    with (STATE.parent/'bootstrap.lock').open('a') as handle:
        fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
        previous=json.loads(root_file(STATE).read_text()) if STATE.exists() else None
        boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip();state=progress(m,previous,time.time(),boot);old_boot=previous.get('bootId') if previous else None
        def save(phase):
            state.update(progress(m,state,time.time(),boot));state['phase']=phase;atomic(STATE,state)
        try:
            # Local timer is armed before metadata, package downloads or reboot.
            for name,text in deadline_units(m).items():Path('/etc/systemd/system',name).write_text(text)
            run(['systemctl','daemon-reload']);run(['systemctl','enable','--now','unjailed-deadline.timer'])
            if state['phase']=='new':
                atomic(STATE,state);verify(lock);apt_sources(lock);validate_apt_sources();run(['apt-get','-o','APT::Get::AllowUnauthenticated=false','update']);save('installing')
                install(lock,platform.release());save('awaiting-reboot')
                shutil.copyfile(HERE/'bootstrap.service','/etc/systemd/system/unjailed-bootstrap.service')
                run(['systemctl','daemon-reload']);run(['systemctl','enable','unjailed-bootstrap.service']);run(['systemctl','reboot']);return
            if state['phase']=='installing':raise Refused('Interrupted installation requires operator review; no automatic reinstall')
            if state['phase']=='awaiting-reboot' and old_boot==boot:raise Refused('Driver reboot not observed')
            kernel_probe(lock,platform.release());Path('/etc/docker').mkdir(exist_ok=True)
            shutil.copyfile(HERE/'daemon.json','/etc/docker/daemon.json');run(['nvidia-ctk','runtime','configure','--runtime=docker']);run(['systemctl','restart','docker'])
            save('host-ready-model-not-started');print('HOST_READY_MODEL_NOT_STARTED')
        except Exception:
            state['failurePhase']=state['phase'];state['phase']='failed';atomic(STATE,state)
            subprocess.run(['systemctl','stop','docker'],env=ENV,capture_output=True,timeout=20)
            raise
if __name__=='__main__':
    try:main()
    except Exception:raise SystemExit('Trusted VM bootstrap refused; no model start or fallback')
