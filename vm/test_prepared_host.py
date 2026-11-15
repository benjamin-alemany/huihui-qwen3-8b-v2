"""Pure prepared-host contracts. All versions/digests below are dummy fixtures."""
import copy,datetime as dt,hashlib,json,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
import prepared_host as host
from host_policy import Refused

class NativeFixture:
    def __init__(self):
        self.session={'version':1,'sessionId':'11111111-1111-4111-8111-111111111111','nonce':'c'*32,'createdAt':'2026-11-15T12:00:00Z','deadlineUTC':'2026-11-15T12:30:00Z','image':'ghcr.io/benjamin-alemany/huihui-qwen3-8b-v2@sha256:'+'1'*64,'resources':{'vmId':None,'publicIpAddress':None,'volumeIds':[]}}
        self.start=dt.datetime(2026,11,15,12,tzinfo=dt.timezone.utc).timestamp();self.wall=self.start+5;self.mono=100
        self.kernel='6.8.0-999-dummy';self.driver='570.999.01';self.calls=[];self.bad_integrity=None;self.gpus='NVIDIA A100 80GB PCIe, '+self.driver+', 0x20b510de'
        self.module='/usr/lib/modules/'+self.kernel+'/updates/dkms/nvidia.ko';self.library='/usr/lib/x86_64-linux-gnu/libcuda.so.'+self.driver
        self.package_files={'coreutils':list(host.REQUIRED_UTILITIES),'nvidia-dkms-570':[],'libnvidia-compute-570':[self.library]}
        self.package_versions={'coreutils':'9.0-dummy','nvidia-dkms-570':self.driver+'-dummy','libnvidia-compute-570':self.driver+'-dummy'};self.package_status={}
        self.data={p:('DUMMY_INSTALLED_BYTES:'+p).encode() for p in [*host.REQUIRED_UTILITIES,self.module,self.library]}
        self.details={p:{'path':p,'uid':0,'mode':0o755,'size':len(data),'regular':True} for p,data in self.data.items()}
        self.os=b'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="24.04"\n'
    def kwargs(self):return {'runner':self.runner,'read_bytes':self.read,'file_info':self.info,'now':lambda:self.wall,'monotonic':lambda:self.mono}
    def read(self,path):return self.os if path=='/etc/os-release' else self.data[path]
    def info(self,path):return dict(self.details[path])
    def runner(self,args,timeout):
        self.calls.append(list(args))
        assert 0<timeout<=30
        if args==['/usr/bin/uname','-r']:return self.kernel
        if args==['/usr/bin/dpkg','--print-architecture']:return 'amd64'
        if args[:2]==['/usr/bin/nvidia-smi','--query-gpu=name,driver_version,pci.device_id']:return self.gpus
        if args==['/usr/sbin/modinfo','-F','version','nvidia']:return self.driver
        if args==['/usr/sbin/modinfo','-F','vermagic','nvidia']:return self.kernel+' SMP DUMMY'
        if args==['/usr/sbin/modinfo','-n','nvidia']:return self.module
        if args[:2]==['/usr/bin/dpkg-query','--show']:
            return '\n'.join(name+'\t'+version+'\tamd64\t'+self.package_status.get(name,'installed') for name,version in self.package_versions.items())+'\nDUMMY_PRIVATE_UNRELATED_PACKAGE\t1\tamd64\tinstalled'
        if args[:2]==['/usr/bin/dpkg-query','--listfiles']:return '\n'.join(self.package_files[args[2]])
        if args==['/usr/bin/docker','version','--format','{{.Server.Version}}']:return '28.0.0'
        if args[:2]==['/usr/bin/dpkg','--verify']:return 'DUMMY_PRIVATE_INTEGRITY_ERROR' if args[2]==self.bad_integrity else ''
        raise AssertionError('Unexpected fixture operation')
    def proposal(self):return host.collect_inventory(self.session,**self.kwargs())
    def lock(self,proposal=None):
        observed=proposal or self.proposal()
        proof=[{**package,'repository':'ubuntu','archiveSha256':'a'*64,'signedIndexSha256':'b'*64,'signingKeyFingerprint':'C'*40} for package in observed['packages']]
        raw=host._canonical({'version':1,'kind':'reviewed-prepared-host-lock','inventory':observed,'provenance':proof})
        return raw,hashlib.sha256(raw).hexdigest()
    def verify(self,raw=None,digest=None):
        if raw is None:raw,digest=self.lock()
        return host.verify_prepared_host(self.session,raw,digest,**self.kwargs())

class PreparedHostTests(unittest.TestCase):
    def test_inventory_is_bounded_public_model_free_proposal_and_canonical(self):
        f=NativeFixture();proposal=f.proposal();encoded=host.canonical_inventory(proposal)
        self.assertLess(len(encoded),host.MAX_LOCK_BYTES);self.assertNotIn(b'DUMMY_PRIVATE',encoded)
        self.assertEqual(proposal['gpu'],{'count':1,'name':'NVIDIA A100 80GB PCIe','pciDeviceId':'0x20B510DE'})
        self.assertTrue(proposal['provenanceReviewRequired']);self.assertFalse(proposal['cudaValidated']);self.assertFalse(proposal['modelLoaded']);self.assertFalse(proposal['agentToolsEnabled'])
        self.assertEqual(json.loads(encoded)['hostImage']['id'],517)
        self.assertTrue(all(item['available'] for item in proposal['utilities']))
        self.assertFalse(any('apt' in part or 'reboot' in part or 'install'==part or 'restart'==part for argv in f.calls for part in argv))
        self.assertFalse(any(argv[0].endswith('python3') for argv in f.calls))
    def test_inventory_does_not_approve_itself_or_accept_missing_or_unpinned_lock(self):
        f=NativeFixture();proposal=host.canonical_inventory(f.proposal());f.calls=[]
        for raw,digest in [(None,None),(b'',None),(proposal,hashlib.sha256(proposal).hexdigest()),(b'{}','0'*64),(b'{}','a'*64)]:
            with self.subTest(raw=raw),self.assertRaises(Refused):host.verify_prepared_host(f.session,raw,digest,**f.kwargs())
        self.assertEqual(f.calls,[])
    def test_reviewed_exact_lock_checks_installed_integrity_without_cuda_or_model_claim(self):
        f=NativeFixture();raw,digest=f.lock();f.calls=[];receipt=f.verify(raw,digest)
        self.assertEqual(receipt,{'version':1,'profile':host.PROFILE,'hostImageId':517,'lockSha256':digest,'preparedHostValidated':True,'driverBranch':570,'modelLoaded':False,'cudaValidated':False,'agentToolsEnabled':False})
        verified=[argv[2] for argv in f.calls if argv[:2]==['/usr/bin/dpkg','--verify']]
        self.assertEqual(verified,sorted(f.package_versions))
    def test_installed_file_version_kernel_or_integrity_drift_refuses(self):
        for change in ['bytes','version','kernel','integrity','driver','gpu','two-gpus','owner','writable','regular','module-path']:
            f=NativeFixture();raw,digest=f.lock()
            if change=='bytes':f.data[f.library]=b'x'*len(f.data[f.library])
            elif change=='version':f.package_versions['coreutils']='9.1-dummy'
            elif change=='kernel':f.kernel='6.8.0-1000-dummy'
            elif change=='integrity':f.bad_integrity='coreutils'
            elif change=='driver':f.gpus=f.gpus.replace('570.999.01','580.999.01')
            elif change=='gpu':f.gpus=f.gpus.replace('A100','H100')
            elif change=='two-gpus':f.gpus+='\n'+f.gpus
            elif change=='owner':f.details[f.library]['uid']=10001
            elif change=='writable':f.details[f.library]['mode']=0o777
            elif change=='regular':f.details[f.library]['regular']=False
            elif change=='module-path':f.module='/tmp/DUMMY_PRIVATE_MODULE'
            with self.subTest(change=change),self.assertRaises(Refused):f.verify(raw,digest)
    def test_changed_host_executable_is_rejected_before_any_host_command(self):
        f=NativeFixture();raw,digest=f.lock();f.calls=[];path='/usr/bin/nvidia-smi'
        f.data[path]=b'x'*len(f.data[path])
        with self.assertRaises(Refused):f.verify(raw,digest)
        self.assertEqual(f.calls,[])
    def test_missing_runtime_utility_is_reported_in_proposal_but_refuses_validation(self):
        f=NativeFixture();path='/usr/sbin/nft';f.package_files['coreutils'].remove(path);del f.details[path]
        proposal=f.proposal();missing=[u for u in proposal['utilities'] if not u['available']]
        self.assertEqual(missing,[{'path':path,'available':False,'resolvedPath':None}])
        raw,digest=f.lock(proposal)
        with self.assertRaises(Refused):f.verify(raw,digest)
    def test_fixed_usrmerge_metadata_and_kmod_symlinks_preserve_exact_canonical_hashes(self):
        f=NativeFixture();kmod='/usr/bin/kmod';f.data[kmod]=b'DUMMY_KMOD_BYTES';f.details[kmod]={'path':kmod,'uid':0,'mode':0o755,'size':len(f.data[kmod]),'regular':True}
        f.package_versions['kmod']='1.0-dummy';f.package_files['kmod']=['/bin/kmod','/sbin/modinfo','/sbin/modprobe']
        for path in ['/bin/kmod','/sbin/modinfo','/sbin/modprobe','/usr/sbin/modinfo','/usr/sbin/modprobe']:f.details[path]=dict(f.details[kmod])
        for path in ['/usr/sbin/modinfo','/usr/sbin/modprobe']:f.package_files['coreutils'].remove(path)
        f.package_files['coreutils'].remove('/usr/bin/bash');f.package_files['coreutils'].append('/bin/bash');f.details['/bin/bash']=dict(f.details['/usr/bin/bash'])
        proposal=f.proposal();entries=[item for item in proposal['files'] if item['path']==kmod]
        self.assertEqual(len(entries),1);self.assertEqual(entries[0]['package'],'kmod')
        self.assertTrue(all(item['available'] for item in proposal['utilities']))
        self.assertTrue(f.verify(*f.lock(proposal))['preparedHostValidated'])
        self.assertFalse(host._file_allowed('/root/kmod',f.kernel,f.driver))
    def test_removed_package_residual_config_is_ignored_but_partial_install_refuses(self):
        for state in ['config-files','not-installed','half-configured']:
            f=NativeFixture();name='nvidia-driver-570-server';f.package_versions[name]='570.1.0-dummy';f.package_status[name]=state
            if state=='half-configured':
                with self.assertRaises(Refused):f.proposal()
            else:self.assertNotIn(name,[p['name'] for p in f.proposal()['packages']])
            self.assertNotIn(['/usr/bin/dpkg-query','--listfiles',name],f.calls)
    def test_python_alias_package_does_not_steal_payload_ownership(self):
        f=NativeFixture();alias='/usr/bin/python3';real='/usr/bin/python3.12'
        f.package_files['coreutils'].remove(alias);f.package_files['python3-minimal']=[alias];f.package_versions['python3-minimal']='3.12-dummy'
        f.package_files['python3.12-minimal']=[real];f.package_versions['python3.12-minimal']='3.12.0-dummy'
        f.data[real]=b'DUMMY_PYTHON_PAYLOAD';details={'path':real,'uid':0,'mode':0o755,'size':len(f.data[real]),'regular':True}
        f.details[real]=dict(details);f.details[alias]=dict(details)
        proposal=f.proposal();entry=next(item for item in proposal['files'] if item['path']==real)
        self.assertEqual(entry['package'],'python3.12-minimal');self.assertFalse(any(item['path']==alias for item in proposal['files']))
        self.assertTrue(f.verify(*f.lock(proposal))['preparedHostValidated'])
    def test_provenance_must_cover_exact_packages_and_cannot_be_placeholders(self):
        f=NativeFixture();raw,_=f.lock();lock=json.loads(raw)
        mutations=[lambda x:x['provenance'].pop(),lambda x:x['provenance'][0].update(version='wrong'),lambda x:x['provenance'][0].update(archiveSha256='0'*64),lambda x:x['provenance'][0].update(signedIndexSha256='0'*64),lambda x:x['provenance'][0].update(signingKeyFingerprint='0'*40),lambda x:x['provenance'][0].update(repository='unreviewed')]
        for mutate in mutations:
            value=copy.deepcopy(lock);mutate(value);bad=host._canonical(value);f.calls=[]
            with self.assertRaises(Refused):f.verify(bad,hashlib.sha256(bad).hexdigest())
            self.assertEqual(f.calls,[])
    def test_duplicate_noncanonical_or_extended_lock_refuses_before_host_queries(self):
        f=NativeFixture();raw,_=f.lock();values=[raw+b'\n',raw.replace(b'"version":1',b'"version":1,"version":1',1)]
        lock=json.loads(raw);lock['unreviewed']='DUMMY_PRIVATE';values.append(host._canonical(lock))
        for bad in values:
            f.calls=[]
            with self.assertRaises(Refused):f.verify(bad,hashlib.sha256(bad).hexdigest())
            self.assertEqual(f.calls,[])
    def test_file_path_and_package_allowlists_refuse_new_arbitrary_reads(self):
        for mutation in ['path','package']:
            f=NativeFixture();raw,_=f.lock();lock=json.loads(raw)
            if mutation=='path':lock['inventory']['files'][0]['path']='/root/DUMMY_PRIVATE_KEY'
            else:lock['inventory']['packages'][0]['name']='DUMMY_PRIVATE_UNREVIEWED'
            bad=host._canonical(lock);f.calls=[]
            with self.assertRaises(Refused):f.verify(bad,hashlib.sha256(bad).hexdigest())
            self.assertEqual(f.calls,[])
    def test_original_startup_deadline_and_monotonic_elapsed_cannot_reset_on_wall_rollback(self):
        f=NativeFixture();f.wall=f.start+901
        with self.assertRaises(Refused):f.proposal()
        self.assertEqual(f.calls,[])
        f=NativeFixture();raw,digest=f.lock();f.calls=[];real=f.runner;calls=0
        def advance(argv,timeout):
            nonlocal calls
            calls+=1
            if calls==2:f.mono+=901;f.wall=f.start+1
            return real(argv,timeout)
        f.runner=advance
        with self.assertRaises(Refused):f.verify(raw,digest)
        self.assertEqual(len(f.calls),2)
    def test_runner_errors_and_untrusted_output_never_escape_as_raw_diagnostics(self):
        f=NativeFixture()
        def failing(*_):raise RuntimeError('DUMMY_PRIVATE_ERROR_CONTENT')
        with self.assertRaises(Refused) as caught:host.collect_inventory(f.session,**{**f.kwargs(),'runner':failing})
        self.assertNotIn('DUMMY_PRIVATE',str(caught.exception))
        with self.assertRaises(Refused):host.collect_inventory(f.session,**{**f.kwargs(),'runner':lambda *_:'x'*(host.MAX_OUTPUT+1)})

if __name__=='__main__':unittest.main()
