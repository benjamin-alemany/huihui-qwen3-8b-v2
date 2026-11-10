"""Exact public-image readback and CPU boot only. Never provisions a Pod."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

ROOT=Path(__file__).resolve().parents[2]
digest=os.environ['CANDIDATE_DIGEST'];audit=os.environ['AUDIT_SHA256']
assert re.fullmatch('sha256:[0-9a-f]{64}',digest) and re.fullmatch('[0-9a-f]{64}',audit)
owner=os.environ['GITHUB_REPOSITORY_OWNER'].lower()
assert re.fullmatch('[a-z0-9-]+',owner)
image='ghcr.io/'+owner+'/huihui-qwen3-8b-v2@'+digest

def docker(args, timeout=90):
    p=subprocess.run(['docker',*args],capture_output=True,text=True,timeout=timeout)
    assert p.returncode==0,'Container verification command refused; inspect scoped CI stage'
    return p.stdout

metadata=json.loads(docker(['image','inspect',image]))[0]
config=metadata['Config']
assert metadata['Architecture']=='amd64' and metadata['Os']=='linux'
assert config['Entrypoint']==['python3','-I','-S','-B','/opt/qwen/credential_boot.py']
assert not config.get('Cmd')
assert config.get('User') in ('root','0','0:0')
for pair in config.get('Env',[]):
    name,_,value=pair.partition('=')
    if value and any(part in name.upper() for part in ('API_KEY','TOKEN','SECRET','PASSWORD','CREDENTIAL')):
        assert name in ('TOKENIZERS_PARALLELISM','HF_HUB_DISABLE_IMPLICIT_TOKEN'),'Credential-like baked environment'
assert metadata['Size'] < 30*1024**3,'Unexpected diagnostic size; check that no cache was included'
expected={
 '/opt/qwen/'+name:hashlib.sha256((ROOT/'chat'/name).read_bytes()).hexdigest()
 for name in ('credential_boot.py','credential_boundary.py','inference_only.py','network_boundary.py')}
expected['/opt/qwen/model_boot.py']=hashlib.sha256((ROOT/'chat/cuda_diagnostic.py').read_bytes()).hexdigest()
expected['/opt/qwen/loopback_ifaddrs.so']=audit
code='''
import ctypes,hashlib,json,os,stat
from pathlib import Path
expected=json.loads(__import__('sys').argv[1])
assert os.getuid()==10001 and os.getgid()==10001
for name,digest in expected.items():
 p=Path(name);s=p.lstat()
 assert s.st_uid==0 and not stat.S_ISLNK(s.st_mode) and not s.st_mode&0o022
 assert not os.access(p,os.W_OK) and hashlib.sha256(p.read_bytes()).hexdigest()==digest
assert not Path('/opt/qwen-model').exists()
assert ctypes.CDLL(None).qwen_cuda_audit_version()==1
print('EXACT_DIAGNOSTIC_BYTES_PROTECTED_NO_MODEL_CACHE')
'''
common=['run','--rm','--network','none','--cpus','2','--memory','2g','--pids-limit','64','--security-opt','no-new-privileges']
output=docker([*common,'--user','10001:10001','--cap-drop','ALL','-e','LD_PRELOAD=/opt/qwen/loopback_ifaddrs.so',
               '--entrypoint','python3',image,'-I','-B','-c',code,json.dumps(expected)])
assert output.strip()=='EXACT_DIAGNOSTIC_BYTES_PROTECTED_NO_MODEL_CACHE'
print('Published amd64 config, protected source/observer hashes and absent offline model cache verified.',flush=True)
now=dt.datetime.now(dt.timezone.utc)
iso=lambda x:x.isoformat().replace('+00:00','Z')
canary='DUMMY-CONTROL-CANARY-NEVER-REAL-KEY'
args=[*common,'--cap-drop','ALL','--cap-add','SETUID','--cap-add','SETGID',
      '-e','RUNPOD_API_KEY='+canary,'-e','VLLM_API_KEY=DUMMY-INFERENCE-'+('x'*40),
      '-e','CHAT_CLOUD_GUARDS_VERIFIED=true','-e','CHAT_RESERVED_AT='+iso(now),
      '-e','CHAT_DEADLINE_UTC='+iso(now+dt.timedelta(minutes=2)),image]
p=subprocess.run(['docker',*args],capture_output=True,text=True,timeout=100)
combined=p.stdout+p.stderr
assert canary not in combined and 'DUMMY-INFERENCE' not in combined,'Dummy credential escaped'
events=[json.loads(line.split(' ',1)[1]) for line in p.stdout.splitlines() if line.startswith('CUDA_DIAGNOSTIC ')]
by_stage={e['stage']:e for e in events}
assert by_stage['credential_boundary_passed']['uid']==10001
assert by_stage['credential_boundary_passed']['capabilities_empty']
assert by_stage['credential_boundary_passed']['parent_process_data_denied']
policy=by_stage['network_boundary_installed']
assert policy['named_unix_sockets_denied'] and policy['all_connect_denied'] and policy['inherited_by_children']
assert by_stage['audit_ready']['complete_syscall_trace'] is False
assert 'device_nodes' in by_stage and 'proc_metadata_access' in by_stage
assert 'driver_library_load_begin' in by_stage
assert ('refused' in by_stage) or ('finished' in by_stage and not by_stage['finished']['driver_initialization_passed'])
assert all(e.get('model_loaded') is not True and e.get('server_started') is not True for e in events)
assert not any(marker in combined for marker in ('CHAT_READY','CHAT_RUNTIME','Traceback','Loading safetensors'))
print('Exact published CPU boot passed credential/network/audit gates, discarded dummy control key and refused GPU serving. No Runpod/CUDA success claimed.',flush=True)
print('CUDA_DIAGNOSTIC_REVIEW '+json.dumps({'digest':digest,'uncompressed_bytes':metadata['Size'],
 'source_hashes_verified':True,'observer_sha256':audit,'cpu_boot_verified':True,
 'model_loaded':False,'paid_resource_started':False,'runpod_cuda_validated':False,'agent_tools_enabled':False}))
