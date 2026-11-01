"""Dummy-only target probe; never provisions resources or starts a model."""
import json
import os
import platform
import signal
import sys
from pathlib import Path
from isolation.verify import verify

RUNTIME='/usr/lib/qwen-isolation-runtime'
BWRAP='/usr/lib/qwen-sandbox-tools/bin/bwrap'

def diagnostics():
    status=Path('/proc/self/status').read_text()
    keys={'Uid','Gid','CapEff','CapPrm','NoNewPrivs','Seccomp','Seccomp_filters'}
    return {'kernel':platform.release(),'uid':os.getuid(),'gid':os.getgid(),
      'status':{line.split(':',1)[0]:line.split(':',1)[1].strip() for line in status.splitlines() if line.split(':',1)[0] in keys},
      'namespace_links':{key:os.readlink('/proc/self/ns/'+key) for key in ('user','mnt','pid','net')},
      'sysctls':{key:Path('/proc/sys/'+key).read_text().strip() if Path('/proc/sys/'+key).is_file() else 'unavailable' for key in ('user/max_user_namespaces','kernel/unprivileged_userns_clone')}}

def run_once():
    if os.getuid()!=10004 or os.getgid()!=10004:raise RuntimeError('Intended executor UID/GID 10004 required')
    forbidden=('RUNPOD_API_KEY','CLOUDFLARE_API_TOKEN','AWS_SECRET_ACCESS_KEY','AWS_ACCESS_KEY_ID','HF_TOKEN','VLLM_API_KEY','GITHUB_TOKEN')
    if any(os.environ.get(name) and not os.environ[name].startswith('DUMMY-') for name in forbidden):
        raise RuntimeError('Unexpected credential in probe environment; refusing without printing it')
    result=verify(RUNTIME,BWRAP)
    # This result concerns execution only, not model compatibility or the full UI.
    result['runpod_target_verified']=False
    result['target_operator_review_required']=True
    result['target_image_digest_verified_by_operator']=False
    return result

def main():
    report={'probe':'runpod-sandbox-compatibility','agent_tools_enabled':False,'diagnostics':{}}
    try:
        report['diagnostics']=diagnostics();report['verification']=run_once();report['status']='passed-pending-target-identity-review'
    except Exception as exc:report.update(status='blocked',error=str(exc))
    print(json.dumps(report,sort_keys=True),flush=True)
    if '--once' in sys.argv:return 0 if report['status']=='passed-pending-target-identity-review' else 1
    # Keep one report visible without restart loops. Process exit is NOT billing stop.
    # A separately authorized cloud controller must STOP/DELETE and confirm state.
    signal.signal(signal.SIGTERM,lambda *_:sys.exit(0))
    while True:signal.pause()
if __name__=='__main__':raise SystemExit(main())
