"""Pure tests of explicit prepared source/host pins; no native GPU execution."""
import copy,hashlib,importlib.util,json,os,stat,sys,tempfile,unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
import native_attest as native
import prepared_bootstrap
from test_prepared_host import NativeFixture
from host_policy import Refused,canonical,docker_arguments
spec=importlib.util.spec_from_file_location('prepared_runtime_under_test',HERE/'run.py')
runtime=importlib.util.module_from_spec(spec);spec.loader.exec_module(runtime)

class PreparedAttestorTests(unittest.TestCase):
    def fixture(self):
        host=NativeFixture();raw,digest=host.lock();profile={'version':1,'mode':'prepared-host-r570-v1','hostLockSHA256':digest}
        return host,raw,profile
    def adapters(self,host,raw,*,version_changed=False,integrity_changed=False):
        stack=ExitStack();calls=[];real_path=Path
        class HostFile:
            def __init__(self,path):self.path=path;self.name=real_path(path).name
            def lstat(self):return SimpleNamespace(st_mode=stat.S_IFREG|host.details[self.path]['mode'],st_uid=host.details[self.path]['uid'],st_size=len(host.data[self.path]))
            def read_bytes(self):return host.data[self.path]
        def path(value):return HostFile(str(value)) if str(value) in host.data else real_path(value)
        def command(args):
            calls.append(args)
            if args[:2]==['dpkg-query','--show']:
                return 'DUMMY_WRONG_VERSION' if version_changed else host.package_versions[args[-1]]
            if args[:2]==['dpkg','--verify']:return 'DUMMY_PRIVATE_INTEGRITY' if integrity_changed else ''
            raise AssertionError('No discovery or other native command permitted')
        stack.enter_context(patch.object(native,'Path',path));stack.enter_context(patch.object(native,'run',side_effect=command))
        stack.enter_context(patch.object(prepared_bootstrap,'source_bytes',return_value=raw))
        return stack,calls
    def test_prepared_attestor_uses_only_reviewed_gpu_digests_and_exact_owning_packages(self):
        host,raw,profile=self.fixture();context,calls=self.adapters(host,raw)
        with context:files=native.installed_gpu_files(profile)
        expected=hashlib.sha256(host.data[host.library]).hexdigest()
        self.assertEqual(files[host.library],expected)
        self.assertEqual(files['/usr/lib/x86_64-linux-gnu/nvidia/current/'+Path(host.library).name],expected)
        self.assertEqual(calls,[['dpkg-query','--show','--showformat=${Version}','libnvidia-compute-570'],['dpkg','--verify','libnvidia-compute-570']])
        self.assertFalse(any('--listfiles'in command for command in calls))
    def test_driver_byte_ownership_and_package_drift_never_create_new_allowlist(self):
        for change in ['bytes','owner','writable','version','integrity']:
            host,raw,profile=self.fixture()
            if change=='bytes':host.data[host.library]=b'x'*len(host.data[host.library])
            if change=='owner':host.details[host.library]['uid']=10001
            if change=='writable':host.details[host.library]['mode']=0o666
            context,calls=self.adapters(host,raw,version_changed=change=='version',integrity_changed=change=='integrity')
            with self.subTest(change=change),context,self.assertRaises(Refused):native.installed_gpu_files(profile)
            if change in ['bytes','owner','writable']:self.assertEqual(calls,[])
    def test_prepared_pin_failure_refuses_instead_of_using_legacy_lock(self):
        host,raw,profile=self.fixture();profile['hostLockSHA256']='a'*64
        context,calls=self.adapters(host,raw)
        with context,patch.object(native,'_legacy_installed_gpu_files') as legacy,self.assertRaises(Refused):native.installed_gpu_files(profile)
        legacy.assert_not_called();self.assertEqual(calls,[])
    def test_no_prepared_selection_keeps_exact_legacy_dispatch(self):
        expected={'DUMMY_LEGACY_GPU_FILE':'b'*64}
        with patch.object(native,'_legacy_installed_gpu_files',return_value=expected) as legacy,patch.object(native,'_prepared_gpu_files') as prepared:
            self.assertIs(native.installed_gpu_files(),expected)
        legacy.assert_called_once_with();prepared.assert_not_called()

class PreparedRuntimeTests(unittest.TestCase):
    def bundle(self,directory,prepared):
        root=Path(directory);host=NativeFixture();raw,digest=host.lock();profile={'version':1,'mode':'prepared-host-r570-v1','hostLockSHA256':digest}
        files={'run.py':b'# DUMMY_RUNTIME_SOURCE','packages.lock.json':b'DUMMY_LEGACY_PACKAGE_LOCK'}
        if prepared:files['prepared-host.lock.json']=raw
        for name,data in files.items():(root/name).write_bytes(data)
        marker={'version':1,'sha256':'b'*64,'files':{name:hashlib.sha256(data).hexdigest() for name,data in files.items()}}
        selected=profile if prepared else None
        config={'bootstrapBundleSha256':marker['sha256'],'bootstrapLockSha256':digest if prepared else hashlib.sha256(files['packages.lock.json']).hexdigest()}
        return root,host,marker,config,selected
    def context(self,root,marker):
        stack=ExitStack();real_lstat=Path.lstat
        stack.enter_context(patch.object(runtime,'HERE',root))
        stack.enter_context(patch.object(runtime,'root_file',return_value=SimpleNamespace(read_text=lambda:json.dumps(marker))))
        stack.enter_context(patch.object(Path,'lstat',lambda p:SimpleNamespace(st_mode=real_lstat(p).st_mode,st_uid=0)))
        return stack
    def test_source_bundle_selects_only_explicit_prepared_or_legacy_lock(self):
        for prepared in [False,True]:
            with self.subTest(prepared=prepared),tempfile.TemporaryDirectory() as d:
                root,host,marker,config,profile=self.bundle(d,prepared)
                with self.context(root,marker):self.assertTrue(runtime.bundle_verified(config,profile))
    def test_prepared_host_lock_cannot_be_swapped_or_reinterpreted_as_old_lock(self):
        for change in ['gateway-pin','profile-pin','file-bytes','missing-lock']:
            with self.subTest(change=change),tempfile.TemporaryDirectory() as d:
                root,host,marker,config,profile=self.bundle(d,True)
                if change=='gateway-pin':config['bootstrapLockSha256']=hashlib.sha256((root/'packages.lock.json').read_bytes()).hexdigest()
                elif change=='profile-pin':profile['hostLockSHA256']='c'*64
                elif change=='file-bytes':(root/'prepared-host.lock.json').write_bytes(b'DUMMY_CHANGED_LOCK')
                else:(root/'prepared-host.lock.json').unlink()
                with self.context(root,marker),self.assertRaises((Refused,FileNotFoundError)):runtime.bundle_verified(config,profile)
    def test_prepared_bootstrap_receipt_binds_manifest_profile_and_lock_without_model_claim(self):
        host=NativeFixture();raw,digest=host.lock();profile={'version':1,'mode':'prepared-host-r570-v1','hostLockSHA256':digest}
        state={'phase':'host-ready-model-not-started','deadlineUTC':host.session['deadlineUTC'],'hostProfile':profile['mode'],'hostLockSHA256':digest,'manifestSHA256':hashlib.sha256(canonical(host.session)).hexdigest()}
        self.assertTrue(runtime.bootstrap_verified(host.session,state,profile))
        for key,value in [('phase','ready'),('deadlineUTC','2026-11-15T13:00:00Z'),('hostProfile','cold'),('hostLockSHA256','a'*64),('manifestSHA256','a'*64)]:
            bad={**state,key:value}
            with self.subTest(key=key),self.assertRaises(Refused):runtime.bootstrap_verified(host.session,bad,profile)
        with self.assertRaises(Refused):runtime.bootstrap_verified(host.session,state)
        self.assertTrue(runtime.bootstrap_verified(host.session,{key:state[key] for key in ['phase','deadlineUTC']}))
    def test_prepared_model_gets_only_verified_loader_scalar_without_new_mounts(self):
        from compat_image import IMAGE,LIBRARY_PATH
        host=NativeFixture();host.session['image']=IMAGE
        profile={'version':1,'mode':'prepared-host-r570-v1','hostLockSHA256':'a'*64}
        original=docker_arguments(host.session);result=runtime.model_arguments(host.session,profile,LIBRARY_PATH)
        self.assertEqual(result[-3:],['--env','LD_LIBRARY_PATH='+LIBRARY_PATH,IMAGE])
        self.assertEqual(result[:-3]+result[-1:],original)
        self.assertEqual(runtime.model_arguments(host.session),original)
        for value in [None,'/tmp/unreviewed',LIBRARY_PATH+':/root']:
            with self.subTest(value=value),self.assertRaises(Refused):runtime.model_arguments(host.session,profile,value)
        with self.assertRaises(Refused):runtime.model_arguments(host.session,None,LIBRARY_PATH)

if __name__=='__main__':unittest.main()
