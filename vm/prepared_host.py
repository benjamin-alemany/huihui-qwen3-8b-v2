"""Model-free prepared-host inventory and verification, with no provisioning.

An inventory is a proposal, never permission. Only an independently reviewed,
source-pinned canonical lock can validate an installed host. This module never
imports CUDA/Torch/model code, reads session credentials, installs packages,
reboots, changes services, or substitutes an observed allowlist for a lock.
"""
import hashlib,json,os,re,stat,subprocess,time
from pathlib import Path
from host_policy import Refused,manifest_from,timestamp

PROFILE='hyperstack-prepared-r570-v1'
HOST_IMAGE={'provider':'hyperstack','id':517,'name':'Ubuntu Server 24.04 LTS R570 CUDA 12.8 with Docker','region':'CANADA-1'}
ENV={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C'}
MAX_OUTPUT=1024*1024
MAX_FILES=96
MAX_FILE_BYTES=256*1024**2
MAX_TOTAL_BYTES=1536*1024**2
MAX_LOCK_BYTES=256*1024
HEX=re.compile(r'^[0-9a-f]{64}$')
KERNEL=re.compile(r'^[A-Za-z0-9][A-Za-z0-9.+-]{0,99}$')
VERSION=re.compile(r'^[A-Za-z0-9][A-Za-z0-9.+:~_-]{0,99}$')
DRIVER=re.compile(r'^570\.[0-9]{1,3}\.[0-9]{1,3}$')
GPU_NAMES={'NVIDIA A100 80GB PCIe','A100 80GB PCIe'}
REQUIRED_UTILITIES=('/usr/bin/python3','/usr/bin/docker','/usr/bin/nvidia-ctk','/usr/bin/nvidia-container-cli','/usr/bin/nvidia-smi','/usr/bin/nsenter','/usr/bin/unshare','/usr/bin/setpriv','/usr/bin/mount','/usr/bin/umount','/usr/sbin/nft','/usr/sbin/ip','/usr/sbin/modinfo','/usr/sbin/modprobe','/usr/bin/systemctl','/usr/bin/bash','/usr/bin/dpkg','/usr/bin/dpkg-query','/usr/bin/uname')
UTILITY_PACKAGES={'docker-ce','docker-ce-cli','docker.io','containerd.io','containerd','runc','nvidia-container-toolkit','nvidia-container-toolkit-base','libnvidia-container1','libnvidia-container-tools','nftables','iproute2','util-linux','mount','kmod','systemd','bash','dpkg','coreutils','libseccomp2','python3-minimal','python3.12-minimal','libpython3.12-minimal'}
NVIDIA_PACKAGE=re.compile(r'^(?:nvidia-(?:driver|headless|headless-no-dkms|dkms|kernel-common|kernel-source|utils|compute-utils)-570(?:-server)?(?:-open)?|libnvidia-(?:compute|common|extra|decode|encode|fbc1|gl)-570(?:-server)?|nvidia-firmware-570(?:-server)?(?:-[0-9]+(?:\.[0-9]+){1,3})?|cuda-drivers-570|linux-(?:modules|objects|signatures)-nvidia-570(?:-server)?(?:-open)?-[A-Za-z0-9.+-]+)$')
GPU_LIBRARY=re.compile(r'^/usr/lib/(?:x86_64-linux-gnu|x86_64-linux-gnu/nvidia/current)/lib(?:cuda|cudadebugger|nvidia-[a-z0-9-]+)\.so(?:\.[0-9]+)*$')
GPU_BINARY={'/usr/bin/nvidia-cuda-mps-control','/usr/bin/nvidia-cuda-mps-server'}
HOST_EXECUTABLES={'/usr/bin/dockerd','/usr/bin/containerd','/usr/bin/runc','/usr/bin/nvidia-container-runtime','/usr/bin/nvidia-container-runtime-hook'}
REPOSITORIES={'ubuntu','nvidia-cuda','nvidia-toolkit','docker'}

def _refuse():raise Refused('Prepared host verification refused; no provisioning or model start')
def _canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=True,allow_nan=False).encode('ascii')
def _unique(pairs):
    result={}
    for key,value in pairs:
        if key in result:_refuse()
        result[key]=value
    return result
def _package_allowed(name,kernel):return name in UTILITY_PACKAGES or bool(NVIDIA_PACKAGE.fullmatch(name)) or name in {'linux-image-'+kernel,'linux-modules-'+kernel,'linux-modules-extra-'+kernel}
def _driver_package(name):return bool(NVIDIA_PACKAGE.fullmatch(name))
def _usr_path(path):return '/usr'+path if path.startswith(('/bin/','/sbin/','/lib/')) else path
def _file_allowed(path,kernel,driver):
    # dpkg may retain pre-usrmerge paths; only fixed distro prefix aliases and
    # the shared kmod executable are admitted, not arbitrary symlink targets.
    path=_usr_path(path)
    return path in REQUIRED_UTILITIES or path in GPU_BINARY or path in HOST_EXECUTABLES or bool(GPU_LIBRARY.fullmatch(path)) or bool(re.fullmatch(r'/usr/lib/firmware/nvidia/'+re.escape(driver)+r'/gsp_[a-z0-9_]+\.bin',path)) or bool(re.fullmatch(r'/usr/lib/modules/'+re.escape(kernel)+r'/(?:updates/dkms|kernel/nvidia-570(?:-server)?|kernel/drivers/video(?:/nvidia)?)/nvidia\.ko(?:\.(?:xz|zst|gz))?',path)) or path in {'/usr/bin/python3.12','/usr/bin/ip','/usr/bin/nft','/usr/bin/kmod','/usr/bin/modinfo','/usr/bin/modprobe'}

class _Budget:
    def __init__(self,session,now,monotonic):
        manifest_from(session);self.now=now;self.monotonic=monotonic
        self.wall,self.mono=now(),monotonic()
        start,end=timestamp(session['createdAt']),timestamp(session['deadlineUTC'])
        self.expiry=min(start+900,end-120)
        if not start<=self.wall<self.expiry:_refuse()
    def remaining(self):
        value=self.expiry-max(self.now(),self.wall+self.monotonic()-self.mono)
        if value<=0:_refuse()
        return value

def _run(args,timeout):
    # The fixed caller supplies argv. Nothing comes from shell/model input.
    try:
        result=subprocess.run(args,env=ENV,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=timeout,check=False)
    except (OSError,subprocess.TimeoutExpired):_refuse()
    if result.returncode or len(result.stdout)>MAX_OUTPUT:_refuse()
    try:return result.stdout.decode('utf-8')
    except UnicodeError:_refuse()

def _file_info(path):
    # Resolve standard distro symlinks, then pin/hash their real regular file.
    try:
        original=Path(path);target=original.resolve(strict=True)
        for parent in [*reversed(target.parents),target]:
            info=parent.lstat()
            if info.st_uid!=0 or info.st_mode&0o022 or stat.S_ISLNK(info.st_mode):_refuse()
            if parent!=target and not stat.S_ISDIR(info.st_mode):_refuse()
        info=target.lstat()
        if not stat.S_ISREG(info.st_mode):_refuse()
        return {'path':str(target),'uid':info.st_uid,'mode':stat.S_IMODE(info.st_mode),'size':info.st_size,'regular':True}
    except OSError:_refuse()

def _read_bytes(path):
    try:
        with open(path,'rb') as stream:return stream.read(MAX_FILE_BYTES+1)
    except OSError:_refuse()

def _validate_inventory(value):
    fields={'version','kind','profile','hostImage','os','kernelRelease','driverVersion','gpu','dockerVersion','packages','files','utilities','modelLoaded','cudaValidated','agentToolsEnabled','provenanceReviewRequired'}
    if not isinstance(value,dict) or set(value)!=fields or type(value['version']) is not int or value['version']!=1 or value['kind']!='prepared-host-inventory-proposal' or value['profile']!=PROFILE or value['hostImage']!=HOST_IMAGE or value['os']!={'id':'ubuntu','version':'24.04','architecture':'amd64'}:_refuse()
    if any(value[k] is not False for k in ['modelLoaded','cudaValidated','agentToolsEnabled']) or value['provenanceReviewRequired'] is not True:_refuse()
    kernel,driver=value['kernelRelease'],value['driverVersion']
    if not isinstance(kernel,str) or not KERNEL.fullmatch(kernel) or not isinstance(driver,str) or not DRIVER.fullmatch(driver) or not isinstance(value['dockerVersion'],str) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:[+~.-][A-Za-z0-9.+~_-]+)?',value['dockerVersion']):_refuse()
    gpu=value['gpu']
    if not isinstance(gpu,dict) or set(gpu)!={'count','name','pciDeviceId'} or type(gpu['count']) is not int or gpu['count']!=1 or not isinstance(gpu['name'],str) or gpu['name'] not in GPU_NAMES or not isinstance(gpu['pciDeviceId'],str) or not re.fullmatch(r'0x[0-9A-F]{4}10DE',gpu['pciDeviceId']):_refuse()
    packages=value['packages'];names=[]
    if not isinstance(packages,list) or not 1<=len(packages)<=96:_refuse()
    for p in packages:
        if not isinstance(p,dict) or set(p)!={'name','version','architecture'} or not isinstance(p['name'],str) or not _package_allowed(p['name'],kernel) or not isinstance(p['version'],str) or not VERSION.fullmatch(p['version']) or not isinstance(p['architecture'],str) or p['architecture'] not in {'amd64','all'}:_refuse()
        names.append(p['name'])
    if names!=sorted(set(names)) or not any(_driver_package(name) for name in names):_refuse()
    files=value['files'];paths=[]
    if not isinstance(files,list) or not 1<=len(files)<=MAX_FILES:_refuse()
    for f in files:
        if not isinstance(f,dict) or set(f)!={'path','package','sha256','size'} or not isinstance(f['path'],str) or not _file_allowed(f['path'],kernel,driver) or f['package'] not in names or not isinstance(f['sha256'],str) or not HEX.fullmatch(f['sha256']) or f['sha256']=='0'*64 or type(f['size']) is not int or not 0<f['size']<=MAX_FILE_BYTES:_refuse()
        paths.append(f['path'])
    if paths!=sorted(set(paths)) or sum(f['size'] for f in files)>MAX_TOTAL_BYTES or not any('/libcuda.so' in path for path in paths) or not any(re.search(r'/nvidia\.ko(?:\.|$)',path) for path in paths):_refuse()
    utilities=value['utilities']
    if not isinstance(utilities,list) or len(utilities)!=len(REQUIRED_UTILITIES):_refuse()
    for expected,utility in zip(sorted(REQUIRED_UTILITIES),utilities):
        if not isinstance(utility,dict) or set(utility)!={'path','available','resolvedPath'} or utility['path']!=expected or type(utility['available']) is not bool:_refuse()
        if utility['available']:
            if utility['resolvedPath'] not in paths:_refuse()
        elif utility['resolvedPath'] is not None:_refuse()
    return value

def canonical_inventory(proposal):return _canonical(_validate_inventory(proposal))

def collect_inventory(session,*,runner=None,read_bytes=None,file_info=None,now=None,monotonic=None,_budget=None):
    """Return bounded public evidence only. It never approves that evidence.

    runner(argv, timeout) returns text; read_bytes(path) returns bytes;
    file_info(path) returns canonical path, uid, mode, size, regular. These
    injectable interfaces permit pure tests without executing host commands.
    """
    budget=_budget or _Budget(session,now or time.time,monotonic or time.monotonic)
    execute=runner or _run;read=read_bytes or _read_bytes;info_for=file_info or _file_info
    def command(args):
        try:result=execute(args,min(30,budget.remaining()))
        except Exception:_refuse()
        budget.remaining()
        if not isinstance(result,str) or len(result.encode('utf-8'))>MAX_OUTPUT or '\x00' in result:_refuse()
        return result.strip()
    stage='os-identity'
    try:
        release=read('/etc/os-release')
        if not isinstance(release,bytes) or len(release)>16384:_refuse()
        text=release.decode('ascii')
        def os_field(name):
            matches=re.findall(r'^'+name+r'=(?:"([^"\n]*)"|([^\s\n]+))$',text,re.M)
            if len(matches)!=1:_refuse()
            return matches[0][0] or matches[0][1]
        if os_field('ID')!='ubuntu' or os_field('VERSION_ID')!='24.04':_refuse()
        kernel=command(['/usr/bin/uname','-r'])
        if not KERNEL.fullmatch(kernel) or command(['/usr/bin/dpkg','--print-architecture'])!='amd64':_refuse()
        stage='gpu-identity';raw=command(['/usr/bin/nvidia-smi','--query-gpu=name,driver_version,pci.device_id','--format=csv,noheader,nounits'])
        if len(raw.splitlines())!=1:_refuse()
        fields=[p.strip() for p in raw.split(',')]
        if len(fields)!=3 or fields[0] not in GPU_NAMES or not DRIVER.fullmatch(fields[1]) or not re.fullmatch(r'0x[0-9A-Fa-f]{8}',fields[2]):_refuse()
        gpu_name,driver,pci=fields;pci='0x'+pci[2:].upper()
        stage='kernel-module'
        if not pci.endswith('10DE') or command(['/usr/sbin/modinfo','-F','version','nvidia'])!=driver or command(['/usr/sbin/modinfo','-F','vermagic','nvidia']).split()[0]!=kernel:_refuse()
        module=command(['/usr/sbin/modinfo','-n','nvidia'])
        if not _file_allowed(module,kernel,driver):_refuse()
        stage='package-inventory';package_text=command(['/usr/bin/dpkg-query','--show','--showformat=${binary:Package}\t${Version}\t${Architecture}\t${db:Status-Status}\n'])
        packages=[]
        for line in package_text.splitlines():
            cells=line.split('\t')
            if len(cells)!=4:_refuse()
            name=cells[0].removesuffix(':amd64')
            if _package_allowed(name,kernel):
                if cells[3] in ('config-files','not-installed'):continue
                if cells[3]!='installed':_refuse()
                packages.append({'name':name,'version':cells[1],'architecture':cells[2]})
        packages.sort(key=lambda p:p['name']);owners={};stage='package-file-provenance'
        for package in packages:
            for path in command(['/usr/bin/dpkg-query','--listfiles',package['name']]).splitlines():
                if not _file_allowed(path,kernel,driver):continue
                try:details=info_for(path)
                except Exception:_refuse()
                canonical=details.get('path') if isinstance(details,dict) else None
                if not isinstance(canonical,str) or not _file_allowed(canonical,kernel,driver):_refuse()
                # A symlink package owns its alias, not another package's
                # payload (python3-minimal -> python3.12-minimal, for example).
                if _usr_path(path)!=canonical:continue
                old=owners.get(canonical)
                if old is not None and old!=package['name']:_refuse()
                owners[canonical]=package['name']
        # DKMS output need not appear in dpkg's file list. Bind its exact bytes
        # to a reviewed installed driver-source package, never an arbitrary path.
        source_names=[p['name'] for p in packages if re.fullmatch(r'nvidia-(?:dkms|kernel-source)-570(?:-server)?(?:-open)?',p['name'])]
        module_info=info_for(module);module_path=module_info.get('path') if isinstance(module_info,dict) else None
        if module_path not in owners:
            if not source_names:_refuse()
            owners[module_path]=sorted(source_names)[0]
        utilities=[]
        for path in sorted(REQUIRED_UTILITIES):
            try:details=info_for(path)
            except Exception:details=None
            available=bool(isinstance(details,dict) and details.get('path') in owners and details.get('mode',0)&0o111)
            utilities.append({'path':path,'available':available,'resolvedPath':details['path'] if available else None})
        if len(owners)>MAX_FILES:_refuse()
        files=[];total=0;stage='file-integrity'
        for path,owner in sorted(owners.items()):
            budget.remaining();details=info_for(path)
            if not isinstance(details,dict) or details.get('path')!=path or details.get('regular') is not True or details.get('uid')!=0 or type(details.get('mode')) is not int or details['mode']&0o022 or type(details.get('size')) is not int or not 0<details['size']<=MAX_FILE_BYTES:_refuse()
            data=read(path);budget.remaining()
            if not isinstance(data,bytes) or len(data)!=details['size']:_refuse()
            total+=len(data)
            if total>MAX_TOTAL_BYTES:_refuse()
            files.append({'path':path,'package':owner,'sha256':hashlib.sha256(data).hexdigest(),'size':len(data)})
        stage='docker-version'
        result={'version':1,'kind':'prepared-host-inventory-proposal','profile':PROFILE,'hostImage':dict(HOST_IMAGE),'os':{'id':'ubuntu','version':'24.04','architecture':'amd64'},'kernelRelease':kernel,'driverVersion':driver,'gpu':{'count':1,'name':gpu_name,'pciDeviceId':pci},'dockerVersion':command(['/usr/bin/docker','version','--format','{{.Server.Version}}']),'packages':packages,'files':files,'utilities':utilities,'modelLoaded':False,'cudaValidated':False,'agentToolsEnabled':False,'provenanceReviewRequired':True}
        stage='proposal-contract'
        return _validate_inventory(result)
    except Exception:raise Refused('Prepared host inventory refused at '+stage+'; no model start') from None

def _reviewed_lock(lock_bytes,expected_lock_sha256):
    if not isinstance(lock_bytes,bytes) or not 0<len(lock_bytes)<=MAX_LOCK_BYTES or not isinstance(expected_lock_sha256,str) or not HEX.fullmatch(expected_lock_sha256) or expected_lock_sha256=='0'*64 or hashlib.sha256(lock_bytes).hexdigest()!=expected_lock_sha256:_refuse()
    try:lock=json.loads(lock_bytes.decode('ascii'),object_pairs_hook=_unique,parse_constant=lambda _: _refuse())
    except Exception:_refuse()
    if _canonical(lock)!=lock_bytes or not isinstance(lock,dict) or set(lock)!={'version','kind','inventory','provenance'} or type(lock['version']) is not int or lock['version']!=1 or lock['kind']!='reviewed-prepared-host-lock':_refuse()
    inventory=_validate_inventory(lock['inventory']);provenance=lock['provenance']
    if not isinstance(provenance,list) or len(provenance)!=len(inventory['packages']):_refuse()
    for package,proof in zip(inventory['packages'],provenance):
        if not isinstance(proof,dict) or set(proof)!={'name','version','architecture','repository','archiveSha256','signedIndexSha256','signingKeyFingerprint'} or any(proof[k]!=package[k] for k in ['name','version','architecture']) or not isinstance(proof['repository'],str) or proof['repository'] not in REPOSITORIES or not isinstance(proof['signingKeyFingerprint'],str) or not re.fullmatch('[A-F0-9]{40}',proof['signingKeyFingerprint']) or proof['signingKeyFingerprint']=='0'*40:_refuse()
        if any(not isinstance(proof[k],str) or not HEX.fullmatch(proof[k]) or proof[k]=='0'*64 for k in ['archiveSha256','signedIndexSha256']):_refuse()
    return lock

def _verify_locked_files(inventory,read,info_for,budget):
    # No command from the unvalidated host runs before its reviewed bytes are
    # checked. The inventory probe is deliberately separate and keyless.
    for expected in inventory['files']:
        budget.remaining()
        try:details=info_for(expected['path']);data=read(expected['path'])
        except Exception:_refuse()
        budget.remaining()
        if not isinstance(details,dict) or details.get('path')!=expected['path'] or details.get('regular') is not True or details.get('uid')!=0 or type(details.get('mode')) is not int or details['mode']&0o022 or details.get('size')!=expected['size'] or not isinstance(data,bytes) or len(data)!=expected['size'] or hashlib.sha256(data).hexdigest()!=expected['sha256']:_refuse()
    for utility in inventory['utilities']:
        if utility['available'] is not True:_refuse()
        try:details=info_for(utility['path'])
        except Exception:_refuse()
        if not isinstance(details,dict) or details.get('path')!=utility['resolvedPath'] or details.get('regular') is not True or details.get('uid')!=0 or type(details.get('mode')) is not int or details['mode']&0o022 or not details['mode']&0o111:_refuse()

def verify_prepared_host(session,lock_bytes,expected_lock_sha256,*,runner=None,read_bytes=None,file_info=None,now=None,monotonic=None):
    """Verify a reviewed lock without provisioning or granting a model permit.

    Signature/package extraction review happens before pinning the lock. Its
    provenance records are immutable review inputs, not a runtime signature
    verification claim. Every reviewed package's installed integrity is checked
    again, and reviewed file SHA256s must match the actual dedicated host.
    """
    lock=_reviewed_lock(lock_bytes,expected_lock_sha256)
    budget=_Budget(session,now or time.time,monotonic or time.monotonic)
    _verify_locked_files(lock['inventory'],read_bytes or _read_bytes,file_info or _file_info,budget)
    observed=collect_inventory(session,runner=runner,read_bytes=read_bytes,file_info=file_info,now=now,monotonic=monotonic,_budget=budget)
    if canonical_inventory(observed)!=canonical_inventory(lock['inventory']):_refuse()
    if any(not utility['available'] for utility in observed['utilities']):_refuse()
    execute=runner or _run
    for package in observed['packages']:
        try:result=execute(['/usr/bin/dpkg','--verify',package['name']],min(30,budget.remaining()))
        except Exception:_refuse()
        budget.remaining()
        if not isinstance(result,str) or result.strip():_refuse()
    return {'version':1,'profile':PROFILE,'hostImageId':517,'lockSha256':expected_lock_sha256,'preparedHostValidated':True,'driverBranch':570,'modelLoaded':False,'cudaValidated':False,'agentToolsEnabled':False}
