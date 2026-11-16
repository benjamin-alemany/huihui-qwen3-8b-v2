"""Pure restricted-container verification tests; no Docker or GPU is invoked."""
import copy,json,os,stat,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent))
import compat_image as compat
from host_policy import Refused
from test_prepared_host import NativeFixture

class Container:
    def __init__(self,session):self.session=session;self.calls=[];self.created=False;self.removed=False;self.proof=None;self.mutate=None;self.bad_receipt=False;self.rm_fail=False;self.create_lost=False;self.sources={}
    def run(self,args,seconds):
        self.calls.append(args);assert 0<seconds<=120
        if args[:2]==['/usr/bin/docker','create']:
            self.created=True
            for index,item in enumerate(args):
                if item=='--mount':
                    parts=dict(piece.split('=',1) for piece in args[index+1].split(',') if '='in piece)
                    self.sources[parts['target']]=parts['source']
                    selftest=Path(parts['source']);assert stat.S_IMODE(selftest.stat().st_mode)==0o444;assert stat.S_IMODE(selftest.parent.stat().st_mode)==0o700
            self.proof={'id':'a'*64,'name':'/uj-compat-'+self.session['sessionId'],'config':{'Image':compat.IMAGE,'User':'10001:10001','Entrypoint':['/usr/bin/env'],'Cmd':compat.COMMAND,'WorkingDir':'/','Labels':{'unjailed.compat-session':self.session['sessionId'],'unjailed.compat-nonce':self.session['nonce']},'Env':['NVIDIA_VISIBLE_DEVICES=void']},'host':{'Runtime':'runc','NetworkMode':'none','IpcMode':'private','ReadonlyRootfs':True,'Privileged':False,'PidsLimit':64,'Memory':1024**3,'NanoCpus':10**9,'PidMode':'','UTSMode':'','CapDrop':['ALL'],'SecurityOpt':['no-new-privileges'],'CapAdd':None,'Devices':None,'DeviceRequests':None,'VolumesFrom':None,'GroupAdd':None,'PortBindings':None,'PublishAllPorts':False,'RestartPolicy':{'Name':'no'}},'mounts':[{'Type':'bind','RW':False,'Destination':target,'Source':source} for target,source in self.sources.items()]}
            if self.mutate:self.mutate(self.proof)
            if self.create_lost:raise Refused('DUMMY_PRIVATE_CREATE_REPLY_LOST')
            return 'a'*64
        if args[:2]==['/usr/bin/docker','inspect']:return json.dumps(self.proof)
        if args[:3]==['/usr/bin/docker','start','--attach']:
            value={'version':1,'kind':'existing-image-compat-cpu-v1','image':compat.IMAGE,'lockSHA256':compat.LOCK_SHA256,'libraryPath':compat.LIBRARY_PATH,'modelLoaded':False,'cudaInitialized':False,'gpuUsed':False}
            if self.bad_receipt:value['cudaInitialized']=True
            return compat._canonical(value)
        if args[:3]==['/usr/bin/docker','rm','--force']:
            if self.rm_fail:raise Refused('DUMMY_PRIVATE_REMOVE_FAILED')
            self.removed=True;return 'a'*64
        if args[:4]==['/usr/bin/docker','container','ls','--all']:return '' if self.removed else 'a'*64
        raise AssertionError('Unexpected Docker command')

class CompatImageTests(unittest.TestCase):
    def fixture(self):
        f=NativeFixture();f.session['image']=compat.IMAGE;container=Container(f.session)
        return f,container
    def verify(self,f,container):return compat.verify_compat_image(compat.IMAGE,f.session,runner=container.run,now=lambda:f.wall,monotonic=lambda:f.mono)
    def test_exact_existing_image_cpu_verification_returns_path_only_after_cleanup(self):
        f,c=self.fixture();self.assertEqual(self.verify(f,c),compat.LIBRARY_PATH);self.assertTrue(c.removed)
        create=c.calls[0];self.assertIn('--runtime=runc',create);self.assertIn('--network=none',create);self.assertIn('--read-only',create);self.assertIn('--cap-drop=ALL',create);self.assertIn('--env=NVIDIA_VISIBLE_DEVICES=void',create)
        self.assertNotIn('--gpus',create);self.assertFalse(any('inference.env'in str(arg) or 'tunnel'in str(arg) or 'VLLM_API_KEY'in str(arg) for arg in create))
        self.assertEqual(len(c.sources),2);self.assertEqual(set(c.sources),{compat.TARGET+'/cuda_compat.py',compat.TARGET+'/cuda-compat.lock.json'})
        self.assertTrue(all(not Path(source).exists() for source in c.sources.values()))
    def test_wrong_privileges_network_gpu_mounts_or_entrypoint_refuses_before_start(self):
        mutations=[lambda p:p['host'].update(Runtime='nvidia'),lambda p:p['host'].update(NetworkMode='host'),lambda p:p['host'].update(ReadonlyRootfs=False),lambda p:p['host'].update(Privileged=True),lambda p:p['host'].update(DeviceRequests=[{'Count':1}]),lambda p:p['config'].update(User='0'),lambda p:p['config'].update(Entrypoint=['python3']),lambda p:p['config'].update(Env=['NVIDIA_VISIBLE_DEVICES=all']),lambda p:p['mounts'][0].update(RW=True),lambda p:p['mounts'].append({'Type':'bind','Source':'/root','Destination':'/root','RW':False})]
        for mutate in mutations:
            f,c=self.fixture();c.mutate=mutate
            with self.subTest(mutate=mutate),self.assertRaises(Refused):self.verify(f,c)
            self.assertFalse(any(args[:3]==['/usr/bin/docker','start','--attach'] for args in c.calls));self.assertTrue(c.removed)
    def test_bad_verification_receipt_or_unconfirmed_cleanup_cannot_grant_loader_path(self):
        for setting in ['bad_receipt','rm_fail','create_lost']:
            f,c=self.fixture();setattr(c,setting,True)
            with self.subTest(setting=setting),self.assertRaises(Refused) as caught:self.verify(f,c)
            self.assertNotIn('DUMMY_PRIVATE',str(caught.exception));self.assertEqual(sum(args[:2]==['/usr/bin/docker','create'] for args in c.calls),1)
    def test_changed_public_helper_or_lock_refuses_before_docker(self):
        for name in ['cuda_compat.py','cuda-compat.lock.json']:
            f,c=self.fixture()
            with tempfile.TemporaryDirectory() as directory:
                root=Path(directory)
                for file in ['cuda_compat.py','cuda-compat.lock.json']:(root/file).write_bytes((compat.HERE/file).read_bytes())
                (root/name).write_bytes(b'DUMMY_PRIVATE_TAMPER')
                with patch.object(compat,'HERE',root),self.assertRaises(Refused):self.verify(f,c)
            self.assertEqual(c.calls,[])
    def test_private_source_modes_are_copied_as_public_readonly_files_only(self):
        f,c=self.fixture()
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            for name in ['cuda_compat.py','cuda-compat.lock.json']:
                path=root/name;path.write_bytes((compat.HERE/name).read_bytes());path.chmod(0o400)
            with patch.object(compat,'HERE',root):self.assertEqual(self.verify(f,c),compat.LIBRARY_PATH)
        self.assertTrue(c.removed)
    def test_only_exact_image_and_unexpired_original_session_can_execute(self):
        f,c=self.fixture()
        with self.assertRaises(Refused):compat.verify_compat_image('image:latest',f.session,runner=c.run)
        f.wall=f.start+901
        with self.assertRaises(Refused):self.verify(f,c)
        self.assertEqual(c.calls,[])
    def test_fixed_check_script_compiles_without_execution_and_imports_no_model_library(self):
        compile(compat.CHECK_SCRIPT,'fixed-cpu-check','exec')
        self.assertNotIn('import torch',compat.CHECK_SCRIPT);self.assertNotIn('import vllm',compat.CHECK_SCRIPT);self.assertNotIn('ctypes',compat.CHECK_SCRIPT)
    def test_unknown_container_identity_is_never_blindly_deleted(self):
        f,c=self.fixture();c.mutate=lambda value:value['config']['Labels'].update({'unjailed.compat-nonce':'0'*32})
        with self.assertRaises(Refused):self.verify(f,c)
        self.assertFalse(any(args[:3]==['/usr/bin/docker','rm','--force'] for args in c.calls))

if __name__=='__main__':unittest.main()
