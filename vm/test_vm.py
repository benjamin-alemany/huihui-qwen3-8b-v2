import copy,datetime as dt,hashlib,io,json,os,stat,sys,tempfile,unittest
from contextlib import redirect_stdout,redirect_stderr
from types import SimpleNamespace
from unittest.mock import patch
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from host_policy import manifest_from,progress,docker_arguments,nftables,deadline_units,Refused
from metadata import verify_index,Refused as MetadataRefused
from attach_model_network import owned
from attestation import context_digest,verify_receipt
from native_attest import mounts_from,verify_sockets,same_bind,reviewed_gpu_file
import console_diagnostics as diagnostics
HERE=Path(__file__).resolve().parent
class PreparedVMTests(unittest.TestCase):
 def fixture(self):return {'version':1,'sessionId':'11111111-1111-4111-8111-111111111111','nonce':'c'*32,'createdAt':'2026-11-11T12:00:00Z','deadlineUTC':'2026-11-11T12:30:00Z','image':'ghcr.io/benjamin-alemany/huihui-qwen3-8b-v2@sha256:'+'1'*64,'resources':{'vmId':123,'publicIpAddress':'203.0.113.1','volumeIds':[]}}
 def test_keyless_console_events_project_only_context_and_allowlisted_stage(self):
  m=self.fixture();at=dt.datetime.fromisoformat(m['createdAt'].replace('Z','+00:00')).timestamp()+1
  raw=diagnostics.event(m,'bootstrap','driver-check','failed',at)
  self.assertLessEqual(len(raw),1024)
  value=json.loads(raw.decode().strip().removeprefix(diagnostics.PREFIX))
  self.assertEqual(set(value),{'version','sessionId','nonce','component','phase','status','at','deadline'})
  self.assertEqual(value['deadline'],round((at-1+1800)*1000));self.assertEqual(value['phase'],'driver-check')
  for secret in [m['image'],'resources','publicIpAddress','gatewayKey','modelKey','api_key']:self.assertNotIn(secret,raw.decode())
  for component,phase,status in [('runtime','DUMMY_SECRET','failed'),('unknown','ready','passed'),('runtime','ready','DUMMY_SECRET')]:
   with self.assertRaises(ValueError):diagnostics.event(m,component,phase,status,at)
  for bad in [True,float('nan'),float('inf'),at-2,at+1800]:
   with self.assertRaises(ValueError):diagnostics.event(m,'runtime','ready','passed',bad)
 def test_console_emitter_writes_only_fixed_root_character_devices_without_blocking_or_links(self):
  m=self.fixture();at=dt.datetime.fromisoformat(m['createdAt'].replace('Z','+00:00')).timestamp()+1;writes=[]
  def write(fd,raw):writes.append((fd,raw));return len(raw)
  with patch.object(diagnostics.time,'time',return_value=at),patch.object(diagnostics.os,'geteuid',return_value=0),patch.object(diagnostics.os,'open',return_value=91) as opened,patch.object(diagnostics.os,'fstat',return_value=SimpleNamespace(st_uid=0,st_mode=stat.S_IFCHR)),patch.object(diagnostics.os,'write',side_effect=write),patch.object(diagnostics.os,'close') as closed:
   self.assertTrue(diagnostics.emit(m,'runtime','image-pull'))
  self.assertEqual([c.args[0] for c in opened.call_args_list],list(diagnostics.DEVICES));self.assertEqual(len(writes),3);self.assertEqual(closed.call_count,3)
  for call in opened.call_args_list:
   for flag in [os.O_NOFOLLOW,os.O_NOCTTY,os.O_NONBLOCK,os.O_CLOEXEC]:self.assertTrue(call.args[1]&flag)
  self.assertTrue(all(raw==writes[0][1] for _,raw in writes))
 def test_console_diagnostics_cannot_emit_regular_files_or_raw_failures(self):
  m=self.fixture();at=dt.datetime.fromisoformat(m['createdAt'].replace('Z','+00:00')).timestamp()+1;output=io.StringIO()
  with patch.object(diagnostics.time,'time',return_value=at),patch.object(diagnostics.os,'geteuid',return_value=0),patch.object(diagnostics.os,'open',return_value=92),patch.object(diagnostics.os,'fstat',return_value=SimpleNamespace(st_uid=0,st_mode=stat.S_IFREG)),patch.object(diagnostics.os,'write') as write,patch.object(diagnostics.os,'close'),redirect_stdout(output),redirect_stderr(output):
   self.assertFalse(diagnostics.emit(m,'runtime','sealing','failed'));write.assert_not_called()
  with patch.object(diagnostics.time,'time',return_value=at),patch.object(diagnostics.os,'geteuid',return_value=0),patch.object(diagnostics.os,'open',side_effect=OSError('DUMMY_PRIVATE_KEY_IN_RAW_ERROR')),redirect_stdout(output),redirect_stderr(output):
   self.assertFalse(diagnostics.emit(m,'runtime','sealing','failed'))
  self.assertEqual(output.getvalue(),'')
 def test_manifest_rejects_hidden_credentials_or_resources(self):
  for patch in [{'RUNPOD_API_KEY':'DUMMY'},{'deadlineUTC':'2026-11-11T13:01:00Z'},{'resources':{'vmId':123,'publicIpAddress':None,'volumeIds':['unexpected']}}]:
   m={**self.fixture(),**patch}
   with self.assertRaises((Refused,ValueError)):manifest_from(m)
  manifest_from({**self.fixture(),'resources':{'vmId':None,'publicIpAddress':None,'volumeIds':[]}})
  with self.assertRaises(Refused):manifest_from({**self.fixture(),'resources':{'vmId':None,'publicIpAddress':'203.0.113.1','volumeIds':[]}})
 def test_reboot_resume_preserves_original_deadline_and_rejects_extension(self):
  m=self.fixture();now=dt.datetime.fromisoformat(m['createdAt'].replace('Z','+00:00')).timestamp();a=progress(m,None,now,'first');a['phase']='awaiting-reboot';b=progress(m,a,now+120,'second');self.assertEqual(b['deadlineUTC'],m['deadlineUTC'])
  with self.assertRaises(Refused):progress({**m,'deadlineUTC':'2026-11-11T12:45:00Z'},b,now+125,'second')
  with self.assertRaises(Refused):progress(m,b,now+118,'second')
  with self.assertRaises(Refused):progress(m,b,now+1800,'second')
  b['phase']='failed'
  with self.assertRaises(Refused):progress(m,b,now+130,'second')
 def test_docker_plan_has_no_host_namespace_api_socket_or_embedded_dns(self):
  args=docker_arguments(self.fixture());self.assertIn('--network=none',args);self.assertIn('--read-only',args);self.assertIn('--restart=no',args);self.assertIn('--cap-drop=ALL',args);self.assertIn('--security-opt=no-new-privileges',args);self.assertIn('--ipc=private',args)
  text=' '.join(args);self.assertNotIn('--privileged',text);self.assertNotIn('--pid=host',text);self.assertNotIn('docker.sock',text);self.assertIn('target=/etc/resolv.conf,readonly',text);self.assertNotIn('--publish',text)
  self.assertIn('--env=NVIDIA_DRIVER_CAPABILITIES=compute',args);self.assertIn('target=/run/unjailed/attestation,readonly',text)
 def test_nft_is_external_default_deny_both_ip_families_and_tunnel_uid_only(self):
  rules=nftables();self.assertEqual(rules.count('policy drop'),3);self.assertIn('iifname "uj-m-host" counter drop',rules);self.assertNotIn('ip6 daddr',rules);self.assertIn('table inet unjailed',rules)
  for line in rules.splitlines():
   if 'dport' in line:self.assertIn('meta skuid 10002',line)
  self.assertNotIn('flush ruleset',rules);self.assertNotIn('dport 443',rules)
 def test_package_lock_has_exact_vendor_bytes_and_correct_branch(self):
  lock=json.loads((HERE/'packages.lock.json').read_text());self.assertEqual(lock['driver_branch'],'580');self.assertFalse(lock['package_payloads_downloaded']);self.assertFalse(lock['target_vm_validated']);self.assertEqual(len(lock['packages']),20)
  for name,r in lock['repositories'].items():self.assertEqual(hashlib.sha256((HERE/'keys'/(name+'.gpg')).read_bytes()).hexdigest(),r['key_sha256'])
  for p in lock['packages']:
   self.assertRegex(p['sha256'],r'^[0-9a-f]{64}$');self.assertTrue(p['version']);self.assertGreater(p['size'],0)
   if p['repository']=='cuda' and p['name']!='dkms':self.assertTrue(p['version'].startswith('580.'))
 def test_veth_attach_requires_the_owned_private_readonly_runtime(self):
  m=self.fixture();name='uj-model-'+m['sessionId'];state={'Running':True,'Pid':123};config={'NetworkMode':'none','PidMode':'','IpcMode':'private','Privileged':False,'ReadonlyRootfs':True,'CapDrop':['ALL'],'CapAdd':['SETUID','SETGID'],'SecurityOpt':['no-new-privileges'],'PortBindings':{}};labels={'unjailed.session':m['sessionId']}
  owned(m,name,state,config,m['image'],labels,'a'*64)
  for patch in [{'NetworkMode':'host'},{'Privileged':True},{'PidMode':'host'},{'ReadonlyRootfs':False},{'CapDrop':[]},{'PortBindings':{'8000/tcp':[]}}]:
   with self.assertRaises(Refused):owned(m,name,state,{**config,**patch},m['image'],labels,'a'*64)
  with self.assertRaises(Refused):owned(m,name,state,config,m['image'],{'unjailed.session':'other'},'a'*64)
 def test_signed_index_digest_tampering_fails(self):
  data=b'DUMMY INDEX';release=('SHA256:\n '+hashlib.sha256(data).hexdigest()+' '+str(len(data))+' Packages\n').encode();verify_index(release,data,'Packages','sha256')
  with self.assertRaises(MetadataRefused):verify_index(release,data+b'x','Packages','sha256')
 def test_local_timer_uses_absolute_expiry_and_does_not_claim_billing_stop(self):
  units=deadline_units(self.fixture());timer=units['unjailed-deadline.timer'];self.assertIn('2026-11-11 12:30:00 UTC',timer);self.assertNotIn('OnBootSec',timer);self.assertIn('Persistent=true',timer)
 def test_native_receipt_binds_session_deadline_image_container_and_namespaces(self):
  m=self.fixture();c={'version':1,**{k:m[k] for k in ['sessionId','nonce','createdAt','deadlineUTC','image']},'containerId':'a'*64,'imageId':'sha256:'+'b'*64};n={k:k+':[123]' for k in ['pid','mnt','net','ipc']}
  r={'version':1,'kind':'vm-native-boundary-v1','contextSHA256':context_digest(c),'containerId':c['containerId'],'imageId':c['imageId'],'namespaces':n,'boundaryVerified':True}
  verify_receipt(c,r,n,c['createdAt'],c['deadlineUTC'])
  for patch in [{'contextSHA256':'0'*64},{'containerId':'c'*64},{'imageId':'sha256:'+'c'*64},{'boundaryVerified':False},{'namespaces':{**n,'net':'net:[999]'}}]:
   with self.assertRaises(Refused):verify_receipt(c,{**r,**patch},n,c['createdAt'],c['deadlineUTC'])
  with self.assertRaises(Refused):verify_receipt(c,r,n,c['createdAt'],'2026-11-11T12:45:00Z')
 def test_native_mount_parser(self):
  records=mounts_from('10 9 0:1 /run/nvidia-persistenced /run/nvidia-persistenced ro - tmpfs tmpfs rw\n');self.assertEqual(records[0]['root'],'/run/nvidia-persistenced')
 def test_native_bind_uses_inode_identity_when_run_is_a_separate_tmpfs(self):
  import stat
  from types import SimpleNamespace
  entry={'root':'/unjailed/attestations/DUMMY','options':{'ro'}}
  source=SimpleNamespace(st_mode=stat.S_IFDIR|0o700,st_uid=0,st_dev=4,st_ino=100)
  same_bind(entry,source,source,True)
  with self.assertRaises(Refused):same_bind(entry,source,SimpleNamespace(st_mode=source.st_mode,st_uid=0,st_dev=4,st_ino=101),True)
  with self.assertRaises(Refused):same_bind({**entry,'options':{'rw'}},source,source,True)
 def test_compute_file_mount_candidates_are_regular_signed_package_files_only(self):
  for path in ['/usr/lib/x86_64-linux-gnu/libcudadebugger.so.580.196.07','/usr/bin/nvidia-cuda-mps-control','/usr/lib/firmware/nvidia/580.196.07/gsp_ga10x.bin']:self.assertTrue(reviewed_gpu_file(path,'580.196.07'))
  for path in ['/run/nvidia-persistenced/socket','/tmp/nvidia-mps/control','/usr/bin/nvidia-smi','/etc/shadow','/usr/lib/firmware/nvidia/999.1/gsp_ga10x.bin']:self.assertFalse(reviewed_gpu_file(path,'580.196.07'))
 @unittest.skipUnless(sys.platform=='linux','Actual pathname socket fixture requires the free Linux CPU runner')
 def test_actual_socket_inventory_fails_closed(self):
  import socket
  with tempfile.TemporaryDirectory() as d:
   verify_sockets(d)
   with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as sock:
    sock.bind(d+'/host-proxy')
    with self.assertRaises(Refused):verify_sockets(d)
if __name__=='__main__':unittest.main()
