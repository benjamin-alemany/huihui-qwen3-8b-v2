"""Pure prepared bootstrap tests. Only temporary dummy files/argv are used."""
import copy,datetime as dt,hashlib,json,os,sys,tempfile,unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent))
import prepared_bootstrap as boot
from host_policy import Refused

class Fixture:
    def __init__(self,directory):
        self.root=Path(directory);self.source=self.root/'source';self.source.mkdir()
        self.state=self.root/'state/bootstrap.json';self.state.parent.mkdir()
        self.systemd=self.root/'etc/systemd/system';self.systemd.mkdir(parents=True)
        self.daemon=self.root/'etc/docker/daemon.json';self.daemon.parent.mkdir()
        self.lock=self.source/'prepared-host.lock.json';self.lock.write_bytes(b'DUMMY_REVIEWED_HOST_LOCK')
        (self.source/'daemon.json').write_text(json.dumps(boot.DAEMON_POLICY))
        self.bootid=self.root/'boot-id';self.bootid.write_text('11111111-1111-4111-8111-111111111111')
        self.session={'version':1,'sessionId':'11111111-1111-4111-8111-111111111111','nonce':'c'*32,'createdAt':'2026-11-15T12:00:00Z','deadlineUTC':'2026-11-15T12:30:00Z','image':'ghcr.io/benjamin-alemany/huihui-qwen3-8b-v2@sha256:'+'1'*64,'resources':{'vmId':None,'publicIpAddress':None,'volumeIds':[]}}
        self.start=dt.datetime(2026,11,15,12,tzinfo=dt.timezone.utc).timestamp();self.wall=self.start+5;self.mono=100
        self.profile={'version':1,'mode':'prepared-host-r570-v1','hostLockSHA256':hashlib.sha256(self.lock.read_bytes()).hexdigest()}
        self.events=[];self.fail=None;self.proof_patch={}
    def verifier(self,session,raw,digest,**kwargs):
        self.events.append(('VERIFY',))
        assert self.state.exists()
        if self.fail=='verify' or hashlib.sha256(raw).hexdigest()!=digest:raise Refused('DUMMY_PRIVATE_VERIFY_FAILURE')
        return {**{'version':1,'profile':'hyperstack-prepared-r570-v1','hostImageId':517,'lockSha256':digest,'preparedHostValidated':True,'driverBranch':570,'modelLoaded':False,'cudaValidated':False,'agentToolsEnabled':False},**self.proof_patch}
    def runner(self,args,timeout):
        self.events.append(tuple(args));assert 0<timeout<=120
        if self.fail=='timer' and args==['/usr/bin/systemctl','is-active','--quiet','unjailed-deadline.timer']:raise Refused('DUMMY_PRIVATE_TIMER_FAILURE')
        if args==['/usr/bin/nvidia-ctk','runtime','configure','--runtime=docker']:
            value=copy.deepcopy(boot.DAEMON_POLICY);value['runtimes']={'nvidia':{'path':'nvidia-container-runtime','args':[]}}
            if self.fail=='daemon-readback':value['iptables']=True
            if self.fail=='daemon-hosts':value['hosts']=['tcp://0.0.0.0:2375']
            self.daemon.write_text(json.dumps(value))
        if self.fail=='restart' and args==['/usr/bin/systemctl','restart','docker']:raise Refused('DUMMY_PRIVATE_DOCKER_FAILURE')
        if self.fail=='clock-rollback' and args==['/usr/bin/systemctl','daemon-reload']:self.wall=self.start+1;self.mono+=901
        return ''
    def reporter(self,phase,status='running'):self.events.append(('REPORT',phase,status))
    def context(self):
        stack=ExitStack();original=os.fstat
        stack.enter_context(patch.multiple(boot,HERE=self.source,HOST_LOCK=self.lock,STATE=self.state,SYSTEMD=self.systemd,DAEMON=self.daemon,BOOT_ID=self.bootid))
        stack.enter_context(patch.object(boot,'protected_directory',side_effect=lambda path,private=False:path.mkdir(parents=True,exist_ok=True)))
        stack.enter_context(patch.object(boot,'source_bytes',side_effect=lambda path,maximum=256*1024:path.read_bytes()))
        stack.enter_context(patch.object(boot.os,'fstat',side_effect=lambda fd:SimpleNamespace(st_mode=original(fd).st_mode,st_uid=0)))
        return stack
    def execute(self,**kwargs):return boot.execute_prepared(self.session,self.profile,runner=self.runner,verifier=self.verifier,reporter=self.reporter,now=lambda:self.wall,monotonic=lambda:self.mono,**kwargs)

class PreparedBootstrapTests(unittest.TestCase):
    def test_success_verifies_before_commands_arms_original_timer_and_never_installs_or_reboots(self):
        with tempfile.TemporaryDirectory() as d:
            f=Fixture(d)
            with f.context():state=f.execute()
            self.assertEqual(state['phase'],'host-ready-model-not-started');self.assertEqual(state['deadlineUTC'],f.session['deadlineUTC'])
            commands=[event for event in f.events if event[0] not in {'VERIFY','REPORT'}]
            self.assertEqual(commands,[('/usr/bin/systemctl','daemon-reload'),('/usr/bin/systemctl','enable','--now','unjailed-deadline.timer'),('/usr/bin/systemctl','is-active','--quiet','unjailed-deadline.timer'),('/usr/bin/nvidia-ctk','runtime','configure','--runtime=docker'),('/usr/bin/systemctl','restart','docker')])
            self.assertLess(f.events.index(('VERIFY',)),f.events.index(commands[0]))
            timer=(f.systemd/'unjailed-deadline.timer').read_text();self.assertIn('2026-11-15 12:30:00 UTC',timer);self.assertIn('Persistent=true',timer)
            self.assertFalse(any(term in part for argv in commands for part in argv for term in ['apt','reboot','install','dkms','modprobe','kernel_probe']))
            self.assertNotIn('modelLoaded',state)
    def test_verification_failure_consumes_attempt_without_executing_host_commands(self):
        with tempfile.TemporaryDirectory() as d:
            f=Fixture(d);f.fail='verify'
            with f.context(),self.assertRaises(Refused) as caught:f.execute()
            self.assertNotIn('DUMMY_PRIVATE',str(caught.exception));self.assertEqual(json.loads(f.state.read_text())['phase'],'failed')
            self.assertEqual([e for e in f.events if e[0] not in {'VERIFY','REPORT'}],[])
            self.assertFalse(f.daemon.exists());self.assertEqual(list(f.systemd.iterdir()),[])
    def test_missing_lock_or_wrong_lock_hash_never_executes_a_command(self):
        for kind in ['missing','mismatched']:
            with self.subTest(kind=kind),tempfile.TemporaryDirectory() as d:
                f=Fixture(d)
                if kind=='missing':f.lock.unlink()
                else:f.profile['hostLockSHA256']='a'*64
                with f.context(),self.assertRaises(Refused):f.execute()
                self.assertEqual([e for e in f.events if e[0] not in {'VERIFY','REPORT'}],[])
                self.assertEqual(json.loads(f.state.read_text())['phase'],'failed')
    def test_no_retry_after_failure_or_success_and_no_state_or_deadline_reset(self):
        for failure in [None,'verify','restart']:
            with self.subTest(failure=failure),tempfile.TemporaryDirectory() as d:
                f=Fixture(d);f.fail=failure
                with f.context():
                    if failure:
                        with self.assertRaises(Refused):f.execute()
                    else:f.execute()
                    before=f.state.read_bytes();f.events=[];f.fail=None
                    with self.assertRaises(Refused):f.execute()
                    self.assertEqual(f.state.read_bytes(),before);self.assertEqual(f.events,[])
    def test_timer_failure_never_configures_or_restarts_docker_and_stops_verified_host_daemon(self):
        with tempfile.TemporaryDirectory() as d:
            f=Fixture(d);f.fail='timer'
            with f.context(),self.assertRaises(Refused):f.execute()
            self.assertNotIn(('/usr/bin/nvidia-ctk','runtime','configure','--runtime=docker'),f.events)
            self.assertNotIn(('/usr/bin/systemctl','restart','docker'),f.events)
            self.assertIn(('/usr/bin/systemctl','stop','docker'),f.events)
    def test_daemon_security_changes_or_failed_restart_refuse_without_model_ready(self):
        for failure in ['daemon-readback','daemon-hosts','restart']:
            with self.subTest(failure=failure),tempfile.TemporaryDirectory() as d:
                f=Fixture(d);f.fail=failure
                with f.context(),self.assertRaises(Refused):f.execute()
                state=json.loads(f.state.read_text());self.assertEqual(state['phase'],'failed');self.assertNotEqual(state['phase'],'host-ready-model-not-started')
                self.assertIn(('/usr/bin/systemctl','stop','docker'),f.events)
    def test_unexpected_verifier_receipt_cannot_grant_host_ready_or_execute_a_command(self):
        for patch_value in [{'cudaValidated':True},{'modelLoaded':True},{'agentToolsEnabled':True},{'driverBranch':580},{'hostImageId':574},{'extra':True}]:
            with self.subTest(patch_value=patch_value),tempfile.TemporaryDirectory() as d:
                f=Fixture(d);f.proof_patch=patch_value
                with f.context(),self.assertRaises(Refused):f.execute()
                self.assertEqual([e for e in f.events if e[0] not in {'VERIFY','REPORT'}],[])
    def test_original_startup_cutoff_and_monotonic_clock_block_extension(self):
        with tempfile.TemporaryDirectory() as d:
            f=Fixture(d);f.wall=f.start+901
            with f.context(),self.assertRaises(Refused):f.execute()
            self.assertEqual(f.events,[]);self.assertFalse(f.state.exists())
        with tempfile.TemporaryDirectory() as d:
            f=Fixture(d);f.fail='clock-rollback'
            with f.context(),self.assertRaises(Refused):f.execute()
            self.assertNotIn(('/usr/bin/nvidia-ctk','runtime','configure','--runtime=docker'),f.events)
            self.assertEqual(json.loads(f.state.read_text())['phase'],'failed')
    def test_earlier_or_different_timer_cannot_be_replaced(self):
        with tempfile.TemporaryDirectory() as d:
            f=Fixture(d);timer=f.systemd/'unjailed-deadline.timer';timer.write_bytes(b'DUMMY_OLD_SESSION_TIMER')
            with f.context(),self.assertRaises(Refused):f.execute()
            self.assertEqual(timer.read_bytes(),b'DUMMY_OLD_SESSION_TIMER');self.assertNotIn(('/usr/bin/systemctl','daemon-reload'),f.events)
    def test_profile_requires_exact_explicit_source_pin_and_no_fallback_options(self):
        valid={'version':1,'mode':'prepared-host-r570-v1','hostLockSHA256':'a'*64}
        for patch_value in [{'mode':'cold'},{'hostLockSHA256':'0'*64},{'hostLockSHA256':None},{'version':True},{'fallback':True},{'lockPath':'/tmp/unreviewed'}]:
            with self.subTest(patch_value=patch_value),self.assertRaises(Refused):boot.profile_from({**valid,**patch_value})
        for argv,platform,uid in [(['prog'],'linux',0),(['prog','--execute','--fallback'],'linux',0),(['prog','--execute'],'darwin',0),(['prog','--execute'],'linux',10001)]:
            with patch.object(boot.sys,'argv',argv),patch.object(boot.sys,'platform',platform),patch.object(boot.os,'geteuid',return_value=uid),self.assertRaises(Refused):boot.main()
    def test_reviewed_toolkit_readback_accepts_fixed_docker_argument_forms_only(self):
        for key,path in [('args','nvidia-container-runtime'),('runtimeArgs','/usr/bin/nvidia-container-runtime')]:
            value={**copy.deepcopy(boot.DAEMON_POLICY),'runtimes':{'nvidia':{'path':path,key:[]}}}
            self.assertEqual(boot.configured_daemon(value),value)
            for change in [{'path':'/tmp/unreviewed'},{key:['--unreviewed']},{'unexpected':True}]:
                broken=copy.deepcopy(value);broken['runtimes']['nvidia'].update(change)
                with self.assertRaises(Refused):boot.configured_daemon(broken)
    def test_prepared_timer_preserves_fractional_deadline_without_early_rounding_or_extension(self):
        with tempfile.TemporaryDirectory() as d:
            f=Fixture(d);f.session['deadlineUTC']='2026-11-15T12:30:00.102Z'
            with f.context():f.execute()
            timer=(f.systemd/'unjailed-deadline.timer').read_text()
            calendar=next(line.split('=',1)[1] for line in timer.splitlines() if line.startswith('OnCalendar='))
            self.assertEqual(calendar,'2026-11-15 12:30:00.102 UTC');self.assertIn('AccuracySec=1us',timer)
            planned=dt.datetime.fromisoformat(calendar.removesuffix(' UTC')).replace(tzinfo=dt.timezone.utc)
            original=dt.datetime.fromisoformat(f.session['deadlineUTC'].replace('Z','+00:00'))
            self.assertEqual(planned,original);self.assertEqual(json.loads(f.state.read_text())['deadlineUTC'],f.session['deadlineUTC'])
    def test_prepared_service_stays_active_without_rerunning_bootstrap_for_runtime_dependency(self):
        service=(Path(boot.__file__).resolve().parent/'prepared-bootstrap.service').read_text()
        self.assertIn('Type=oneshot',service);self.assertIn('RemainAfterExit=true',service);self.assertIn('Restart=no',service)
        self.assertIn('ExecStart=/usr/bin/python3 -I -B /opt/unjailed/vm/prepared_bootstrap.py --execute',service)
        runtime=(Path(boot.__file__).resolve().parent/'runtime.service').read_text();self.assertIn('Requires=unjailed-bootstrap.service',runtime)

if __name__=='__main__':unittest.main()
