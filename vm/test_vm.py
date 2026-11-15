import copy,datetime as dt,hashlib,io,json,os,stat,subprocess,sys,tempfile,time,unittest
from contextlib import ExitStack,redirect_stdout,redirect_stderr
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
import bootstrap
HERE=Path(__file__).resolve().parent
class PreparedVMTests(unittest.TestCase):
 def fixture(self):return {'version':1,'sessionId':'11111111-1111-4111-8111-111111111111','nonce':'c'*32,'createdAt':'2026-11-11T12:00:00Z','deadlineUTC':'2026-11-11T12:30:00Z','image':'ghcr.io/benjamin-alemany/huihui-qwen3-8b-v2@sha256:'+'1'*64,'resources':{'vmId':123,'publicIpAddress':'203.0.113.1','volumeIds':[]}}
 def test_startup_budget_clips_original_window_and_never_resets_on_reboot_or_clock_rollback(self):
  m=self.fixture();created=dt.datetime.fromisoformat(m['createdAt'].replace('Z','+00:00')).timestamp();clock={'wall':created+850,'mono':100}
  with patch.object(bootstrap.time,'time',side_effect=lambda:clock['wall']),patch.object(bootstrap.time,'monotonic',side_effect=lambda:clock['mono']):
   budget=bootstrap.StartupBudget(m);self.assertEqual(budget.remaining(),50)
   clock.update(wall=created+2,mono=140);self.assertEqual(budget.remaining(),10)
   clock.update(wall=created+901,mono=141)
   with self.assertRaises(Refused):budget.remaining()
   with self.assertRaises(Refused):bootstrap.StartupBudget(m).remaining()
   shorter={**m,'deadlineUTC':'2026-11-11T12:15:00Z'};self.assertEqual(bootstrap.StartupBudget(shorter).expiry,created+780)
 def test_expired_startup_refuses_before_spawning_or_renewing_deadline(self):
  budget=SimpleNamespace(remaining=lambda:(_ for _ in ()).throw(Refused('expired')))
  with patch.object(bootstrap,'_BUDGET',budget),patch.object(bootstrap.subprocess,'Popen') as spawned:
   with self.assertRaises(Refused):bootstrap.run([sys.executable,'-c','pass'])
   spawned.assert_not_called()
 def test_total_command_deadline_stops_trickled_output_and_only_its_own_child_group(self):
  with tempfile.TemporaryDirectory() as directory:
   heartbeat=Path(directory)/'child';otherbeat=Path(directory)/'other'
   writer="import time\nfrom pathlib import Path\np=Path(%r)\nwhile True:\n with p.open('ab') as f:f.write(b'x')\n time.sleep(.02)\n"
   independent=subprocess.Popen([sys.executable,'-I','-S','-c',writer%str(otherbeat)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
   script="import subprocess,sys,time\nsubprocess.Popen([sys.executable,'-I','-S','-c',%r])\nwhile True:\n print('DUMMY_TRICKLE',flush=True)\n time.sleep(.02)\n"%(writer%str(heartbeat))
   started=time.monotonic()
   try:
    with self.assertRaises(Refused):bootstrap.run([sys.executable,'-I','-S','-c',script],timeout=.3)
    self.assertLess(time.monotonic()-started,2);self.assertTrue(heartbeat.exists());before=heartbeat.stat().st_size;other=otherbeat.stat().st_size
    time.sleep(.12);self.assertEqual(heartbeat.stat().st_size,before);self.assertGreater(otherbeat.stat().st_size,other);self.assertIsNone(independent.poll())
   finally:independent.terminate();independent.wait(timeout=2)
 def test_metadata_supervisor_requires_all_fixed_vendor_proofs_and_no_fallback(self):
  def runner(args,timeout,line_callback):
   self.assertEqual(args[-1],'--progress');self.assertEqual(timeout,120)
   for phase in ['metadata-cuda','metadata-toolkit','metadata-docker']:
    for status in ['running','passed']:line_callback('UNJAILED_METADATA '+json.dumps({'phase':phase,'status':status}))
   line_callback('UNJAILED_METADATA_VERIFIED');return ''
  events=[]
  with patch.object(bootstrap,'run',side_effect=runner):bootstrap.verify_metadata(lambda phase,status:events.append((phase,status)))
  self.assertEqual(len(events),6)
  for value in ['UNJAILED_METADATA_VERIFIED','UNJAILED_METADATA '+json.dumps({'phase':'metadata-cuda','status':'passed'}),'DUMMY_PRIVATE_RAW_ERROR']:
   with patch.object(bootstrap,'run',side_effect=lambda args,timeout,line_callback:line_callback(value)):
    with self.assertRaises(Refused):bootstrap.verify_metadata(lambda *_:None)
  with patch.object(bootstrap,'run',side_effect=Refused('timeout')) as called:
   with self.assertRaises(Refused):bootstrap.verify_metadata(lambda *_:None)
   self.assertEqual(called.call_count,1)
 def test_actual_metadata_child_total_deadline_refuses_trickle_without_any_verified_fallback(self):
  with tempfile.TemporaryDirectory() as directory:
   script=Path(directory)/'metadata.py';script.write_text("import sys,time\nprint('UNJAILED_METADATA {\"phase\":\"metadata-cuda\",\"status\":\"running\"}',flush=True)\nwhile True:\n sys.stdout.write(' ')\n sys.stdout.flush()\n time.sleep(.02)\n")
   events=[];started=time.monotonic()
   with patch.object(bootstrap,'HERE',Path(directory)),patch.object(bootstrap,'METADATA_SECONDS',.25):
    with self.assertRaises(Refused):bootstrap.verify_metadata(lambda phase,status:events.append((phase,status)))
   self.assertLess(time.monotonic()-started,2);self.assertEqual(events,[('metadata-cuda','running')])
 def test_apt_refresh_is_bounded_and_partial_update_errors_cannot_be_accepted(self):
  args=bootstrap.apt_refresh_arguments();self.assertIn('--error-on=any',args);self.assertIn('Acquire::Retries=0',args);self.assertIn('Acquire::http::Timeout=20',args);self.assertIn('Acquire::https::Timeout=20',args)
  for required in ['APT::Get::AllowUnauthenticated=false','Acquire::AllowInsecureRepositories=false','Acquire::AllowDowngradeToInsecureRepositories=false']:self.assertIn(required,args)
  self.assertNotIn('ForceIPv4',' '.join(args));self.assertNotIn('Verify-Peer=false',' '.join(args))
  with patch.object(bootstrap,'run',side_effect=Refused('partial update')) as run:
   with self.assertRaises(Refused):bootstrap.refresh_indexes()
   run.assert_called_once_with(args,timeout=120,capture_apt_failure=True)
 def test_apt_failure_classifier_has_only_fixed_categories_and_error_repo_labels(self):
  cases=[
   ('E: Failed to fetch https://security.ubuntu.com/index Temporary failure resolving name','dns','ubuntu'),
   ('Err:1 https://developer.download.nvidia.com/index /\n  Connection timed out','network','cuda'),
   ('Err:1 https://download.docker.com/index stable\n  Certificate verification failed','tls','docker'),
   ('W: GPG error: https://nvidia.github.io/index NO_PUBKEY DUMMY_PRIVATE','signature','toolkit'),
   ('E: Failed to fetch https://developer.download.nvidia.com/index Hash Sum mismatch','integrity','cuda'),
   ('E: Could not get lock /var/lib/apt/lists/lock. It is held by process 123','lock','unknown'),
   ('E: The repository https://archive.ubuntu.com/index does not have a Release file.','repository','ubuntu'),
   ('Get:1 https://download.docker.com/index stable\nDUMMY_PRIVATE_UNKNOWN_CONTENT','unknown','unknown')]
  for text,category,repo in cases:
   with self.subTest(category=category):self.assertEqual(bootstrap.apt_failure_phases(text.encode(),'exit',100),('apt-failure-exit-100','apt-error-'+category,'apt-repo-'+repo))
  combined=cases[0][0]+'\n'+cases[2][0];self.assertEqual(bootstrap.apt_failure_phases(combined.encode(),'signal',-15),('apt-failure-signal','apt-error-multiple','apt-repo-multiple'))
  phases=bootstrap.apt_failure_phases(b'E: Failed to fetch https://download.docker.com.attacker.invalid/index Connection refused','DUMMY_PRIVATE',1);self.assertEqual(phases,('apt-failure-unknown','apt-error-network','apt-repo-unknown'))
 def test_apt_stderr_canary_is_classified_in_memory_without_raw_errors_or_success_fallback(self):
  real_popen=subprocess.Popen;secret='DUMMY_PRIVATE_STDERR_CANARY';events=[];output=io.StringIO()
  script="import sys\nprint('Get:1 https://download.docker.com/index stable')\nprint(%r,file=sys.stderr,flush=True)\nsys.exit(100)\n"%('E: Failed to fetch https://security.ubuntu.com/index Temporary failure resolving name '+secret)
  def spawn(args,**kwargs):
   self.assertEqual(args,bootstrap.apt_refresh_arguments());self.assertEqual(kwargs['stderr'],subprocess.STDOUT);self.assertEqual(kwargs['env'],bootstrap.ENV)
   return real_popen([sys.executable,'-I','-S','-c',script],**kwargs)
  with patch.object(bootstrap.subprocess,'Popen',side_effect=spawn),redirect_stdout(output),redirect_stderr(output):
   with self.assertRaises(bootstrap.AptRefreshError) as caught:bootstrap.refresh_indexes(diagnostic=events.append)
  self.assertEqual(events,['apt-failure-exit-100','apt-error-dns','apt-repo-ubuntu']);self.assertEqual(set(vars(caught.exception)),{'phases'})
  self.assertNotIn(secret,str(caught.exception)+repr(vars(caught.exception))+output.getvalue());self.assertNotIn('https://',repr(vars(caught.exception)));self.assertEqual(output.getvalue(),'')
 def test_apt_timeout_signal_nonstandard_exit_and_output_limit_only_emit_closed_indicators(self):
  real_popen=subprocess.Popen
  cases=[("import sys,time\nprint('Err:1 https://developer.download.nvidia.com/index /',flush=True)\nprint('  Connection timed out',file=sys.stderr,flush=True)\ntime.sleep(9)",'timeout','network','cuda'),("import os,signal\nos.kill(os.getpid(),signal.SIGTERM)",'signal','unknown','unknown'),("raise SystemExit(7)",'exit-other','unknown','unknown'),("print('DUMMY_PRIVATE'+'x'*70000,flush=True)",'output-bound','unknown','unknown')]
  for script,outcome,category,repo in cases:
   events=[]
   with self.subTest(outcome=outcome),patch.object(bootstrap.subprocess,'Popen',side_effect=lambda args,**kwargs:real_popen([sys.executable,'-I','-S','-c',script],**kwargs)),patch.object(bootstrap,'APT_REFRESH_SECONDS',.15):
    with self.assertRaises(bootstrap.AptRefreshError) as caught:bootstrap.refresh_indexes(diagnostic=events.append)
   self.assertEqual(events,['apt-failure-'+outcome,'apt-error-'+category,'apt-repo-'+repo]);self.assertNotIn('DUMMY_PRIVATE',str(caught.exception)+repr(vars(caught.exception)))
  expired=SimpleNamespace(remaining=lambda:(_ for _ in ()).throw(Refused('DUMMY_PRIVATE_DEADLINE')));events=[]
  with patch.object(bootstrap,'_BUDGET',expired),patch.object(bootstrap.subprocess,'Popen') as spawned:
   with self.assertRaises(bootstrap.AptRefreshError):bootstrap.refresh_indexes(diagnostic=events.append)
   spawned.assert_not_called()
  self.assertEqual(events,['apt-failure-deadline','apt-error-unknown','apt-repo-unknown'])
 def test_apt_failure_indicators_cannot_emit_as_success_or_arbitrary_console_fields(self):
  m=self.fixture();at=dt.datetime.fromisoformat(m['createdAt'].replace('Z','+00:00')).timestamp()+1
  for phase in diagnostics.APT_DIAGNOSTIC_PHASES:
   raw=diagnostics.event(m,'bootstrap',phase,'failed',at);self.assertLessEqual(len(raw),1024);self.assertEqual(set(json.loads(raw.decode().strip().removeprefix(diagnostics.PREFIX))),{'version','sessionId','nonce','component','phase','status','at','deadline'})
   for status in ['running','passed']:
    with self.assertRaises(ValueError):diagnostics.event(m,'bootstrap',phase,status,at)
 def test_failed_vendor_or_partial_apt_refresh_never_reaches_package_install_or_reboot(self):
  for failed in ['metadata-toolkit','apt-index-refresh']:
   with self.subTest(phase=failed),tempfile.TemporaryDirectory() as directory:
    sandbox=Path(directory);state=sandbox/'state/bootstrap.json';state.parent.mkdir();session=sandbox/'session.json';m=self.fixture();session.write_text(json.dumps(m));events=[];commands=[];output=io.StringIO()
    now=dt.datetime.fromisoformat(m['createdAt'].replace('Z','+00:00')).timestamp()+2
    (sandbox/'etc/systemd/system').mkdir(parents=True);boot=sandbox/'proc/sys/kernel/random/boot_id';boot.parent.mkdir(parents=True);boot.write_text('first-boot')
    def vm_path(*args):
     p=Path(*args)
     return sandbox/str(p).lstrip('/') if p.is_absolute() and (str(p).startswith('/etc/') or str(p).startswith('/proc/')) else p
    def emit(manifest,component,phase,status='running'):events.append(json.loads(diagnostics.event(manifest,component,phase,status,now).decode().strip().removeprefix(diagnostics.PREFIX)))
    def metadata(report):
     for phase in ['metadata-cuda','metadata-toolkit','metadata-docker']:
      report(phase,'running')
      if phase==failed:raise Refused('DUMMY_PRIVATE_VENDOR_ERROR')
      report(phase,'passed')
    def refresh(diagnostic=None):
     error=bootstrap.AptRefreshError(b'E: Could not get lock DUMMY_PRIVATE_APT_PARTIAL_FAILURE','exit',100)
     if diagnostic:
      for phase in error.phases:diagnostic(phase)
     raise error
    contexts=[patch.object(bootstrap,'STATE',state),patch.object(bootstrap,'SESSION',session),patch.object(bootstrap,'Path',side_effect=vm_path),patch.object(bootstrap,'root_file',side_effect=lambda p:Path(p)),patch.object(bootstrap,'host'),patch.object(bootstrap,'verify_metadata',side_effect=metadata),patch.object(bootstrap,'apt_sources'),patch.object(bootstrap,'validate_apt_sources'),patch.object(bootstrap,'refresh_indexes',side_effect=refresh),patch.object(bootstrap,'run',side_effect=lambda args,timeout=1200:commands.append(args)),patch.object(bootstrap,'emit',side_effect=emit),patch.object(bootstrap.fcntl,'flock'),patch.object(bootstrap.time,'time',return_value=now),patch.object(bootstrap.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout='')),patch.object(sys,'argv',['bootstrap.py','--execute']),redirect_stdout(output),redirect_stderr(output)]
    with ExitStack() as stack:
     for context in contexts:stack.enter_context(context)
     install=stack.enter_context(patch.object(bootstrap,'install'))
     with self.assertRaises(Refused):bootstrap.main()
     install.assert_not_called()
    stored=json.loads(state.read_text());self.assertEqual(stored['phase'],'failed');self.assertEqual(stored['failurePhase'],failed);self.assertEqual(stored['deadlineUTC'],m['deadlineUTC']);self.assertEqual(events[-1]['phase'],failed);self.assertEqual(events[-1]['status'],'failed')
    self.assertNotIn(['systemctl','reboot'],commands);self.assertFalse(any(e['phase']=='installing' for e in events));self.assertNotIn('DUMMY_PRIVATE',json.dumps(stored)+json.dumps(events)+output.getvalue());self.assertIsNone(bootstrap._BUDGET)
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
 def _reboot_bootstrap(self,old_hosts=False,fail_at=None):
  # Exercise the real post-reboot bootstrap/catch path with dummy commands and
  # Docker CE's existing systemd -H fd:// listener; no host commands execute.
  with tempfile.TemporaryDirectory() as directory:
   sandbox=Path(directory);state_path=sandbox/'state/bootstrap.json';state_path.parent.mkdir();session_path=sandbox/'session.json'
   m=self.fixture();now=dt.datetime.fromisoformat(m['createdAt'].replace('Z','+00:00')).timestamp();previous=progress(m,None,now,'before-reboot');previous['phase']='awaiting-reboot'
   state_path.write_text(json.dumps(previous));session_path.write_text(json.dumps(m));events=[];commands=[];output=io.StringIO();error=None
   boot=sandbox/'proc/sys/kernel/random/boot_id';boot.parent.mkdir(parents=True);boot.write_text('after-reboot')
   (sandbox/'etc/systemd/system').mkdir(parents=True)
   def vm_path(*args):
    value=Path(*args)
    if value.is_absolute() and (str(value).startswith('/etc/') or str(value).startswith('/proc/')):return sandbox/str(value).lstrip('/')
    return value
   def root_file(p):
    self.assertIn(Path(p),[session_path,state_path]);return Path(p)
   def emit(manifest,component,phase,status='running'):
    events.append(json.loads(diagnostics.event(manifest,component,phase,status,now+120).decode().strip().removeprefix(diagnostics.PREFIX)))
   def copy_config(src,dst):
    self.assertEqual(src,HERE/'daemon.json');self.assertEqual(dst,'/etc/docker/daemon.json')
    config=json.loads(Path(src).read_text())
    if old_hosts:config['hosts']=['unix:///var/run/docker.sock']
    (sandbox/'etc/docker/daemon.json').write_text(json.dumps(config))
   def run(args,timeout=1200):
    commands.append(args)
    if args==['nvidia-ctk','runtime','configure','--runtime=docker']:
     self.assertTrue(any(e['phase']=='driver-check' and e['status']=='passed' for e in events))
     if fail_at=='docker-runtime-config':raise Refused('DUMMY_PRIVATE_TOOLKIT_ERROR')
     config=json.loads((sandbox/'etc/docker/daemon.json').read_text());config['runtimes']={'nvidia':{'path':'nvidia-container-runtime','runtimeArgs':[]}};(sandbox/'etc/docker/daemon.json').write_text(json.dumps(config))
    elif args==['systemctl','restart','docker']:
     # Docker refuses duplicate listener configuration even if both values
     # select Unix sockets. The installed CE unit retains its own -H fd://.
     unit_args=['/usr/bin/dockerd','-H','fd://','--containerd=/run/containerd/containerd.sock'];config=json.loads((sandbox/'etc/docker/daemon.json').read_text())
     if 'hosts' in config and '-H' in unit_args:raise Refused('DUMMY_PRIVATE_DUPLICATE_DOCKER_HOSTS')
     if fail_at=='docker-start':raise Refused('DUMMY_PRIVATE_DOCKER_START_ERROR')
    else:self.assertIn(args,[['systemctl','daemon-reload'],['systemctl','enable','--now','unjailed-deadline.timer']])
    return ''
   with patch.object(bootstrap,'STATE',state_path),patch.object(bootstrap,'SESSION',session_path),patch.object(bootstrap,'Path',side_effect=vm_path),patch.object(bootstrap,'root_file',side_effect=root_file),patch.object(bootstrap,'host'),patch.object(bootstrap,'kernel_probe') as probe,patch.object(bootstrap,'run',side_effect=run),patch.object(bootstrap,'emit',side_effect=emit),patch.object(bootstrap.shutil,'copyfile',side_effect=copy_config),patch.object(bootstrap.fcntl,'flock'),patch.object(bootstrap.time,'time',return_value=now+120),patch.object(bootstrap.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout='')) as cleanup,patch.object(sys,'argv',['bootstrap.py','--execute']),redirect_stdout(output),redirect_stderr(output):
    try:bootstrap.main()
    except Refused as caught:error=caught
   probe.assert_called_once();state=json.loads(state_path.read_text());config=json.loads((sandbox/'etc/docker/daemon.json').read_text())
   return SimpleNamespace(state=state,config=config,events=events,commands=commands,output=output.getvalue(),error=error,cleanup=cleanup.call_args_list)
 def test_bootstrap_uses_existing_systemd_docker_listener_without_duplicate_hosts_or_weaker_network_policy(self):
  result=self._reboot_bootstrap();self.assertIsNone(result.error);self.assertNotIn('hosts',result.config)
  expected={'iptables':False,'ip6tables':False,'ip-forward':False,'userland-proxy':False,'live-restore':False,'bridge':'none','log-driver':'local','log-opts':{'max-size':'10m','max-file':'2'}}
  self.assertEqual(json.loads((HERE/'daemon.json').read_text()),expected);self.assertEqual({k:v for k,v in result.config.items() if k!='runtimes'},expected)
  passed=[e['phase'] for e in result.events if e['status']=='passed'];self.assertEqual(passed,['driver-check','docker-runtime-config','docker-start','host-ready-model-not-started']);self.assertEqual(result.state['phase'],'host-ready-model-not-started');self.assertEqual(result.cleanup,[])
 def test_duplicate_docker_listener_or_docker_start_failure_is_reported_after_driver_pass_without_model_start(self):
  for options in [{'old_hosts':True},{'fail_at':'docker-start'},{'fail_at':'docker-runtime-config'}]:
   with self.subTest(options=options):
    result=self._reboot_bootstrap(**options);phase=options.get('fail_at','docker-start');self.assertIsInstance(result.error,Refused);self.assertEqual(result.state['failurePhase'],phase);self.assertEqual(result.state['phase'],'failed');self.assertEqual(result.state['deadlineUTC'],self.fixture()['deadlineUTC'])
    self.assertTrue(any(e['phase']=='driver-check' and e['status']=='passed' for e in result.events));self.assertEqual(result.events[-1]['phase'],phase);self.assertEqual(result.events[-1]['status'],'failed');self.assertFalse(any(e['phase'] in ['host-ready-model-not-started','model-starting','ready'] for e in result.events));self.assertNotIn('HOST_READY_MODEL_NOT_STARTED',result.output);self.assertNotIn('DUMMY_PRIVATE',json.dumps(result.state)+json.dumps(result.events)+result.output)
    self.assertEqual(result.cleanup[0].args[0],['systemctl','stop','docker'])
    if phase=='docker-runtime-config':self.assertNotIn(['systemctl','restart','docker'],result.commands)
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
