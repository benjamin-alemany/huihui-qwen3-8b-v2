"""Runs trusted adversarial fixtures, never the model. Does not enable agent tools."""
import argparse
import json
import os
import platform
import tempfile
from pathlib import Path
from isolation.files import Project
from isolation.sandbox import run_project,validate_runtime,Unavailable

HERE=Path(__file__).resolve().parent

def verify(runtime,bwrap):
    identity=validate_runtime(runtime,bwrap)
    results={}
    with tempfile.TemporaryDirectory(prefix='qwen-isolation-proof-') as td:
        td=Path(td);hidden=td/'outside-only';hidden.mkdir(mode=0o700)
        for name in ('model-config','shutdown-control','backup-key'):(hidden/name).write_text('DUMMY-NOT-A-REAL-SECRET')
        info={'namespaces':{n:os.readlink('/proc/self/ns/'+n) for n in ('user','pid','mnt','net','ipc','uts')},'hidden_paths':[str(hidden),str(runtime)]}
        project=td/'project';project.mkdir(mode=0o700)
        with Project(project) as p:
            p.write('boundary.json',json.dumps(info),None)
            p.write('dummy.env.example','DUMMY_ONLY=not-a-real-credential\n',None)
            p.write('test_boundaries.py',(HERE/'probe_payload.py').read_text(),None)
            result=run_project(p,runtime,bwrap)
            results['boundaries']=result
            if result['exit_code']!=0 or result['limit']:raise Unavailable('Boundary verification failed: '+json.dumps(result))
        # Prove child wall-clock and output limits using fixed trusted probes.
        for name,source,want in (
            ('timeout','import time\ntime.sleep(60)\n','wall-time-limit'),
            ('output','import os\nwhile True: os.write(1,b"x"*8192)\n','output-limit')):
            case=td/name;case.mkdir(mode=0o700)
            with Project(case) as p:
                p.write('test_limit.py',source,None)
                result=run_project(p,runtime,bwrap)
                if result['limit']!=want:raise Unavailable(name+' limit failed: '+json.dumps(result))
                results[name]={'limit':result['limit'],'exit_code':result['exit_code'],'output_bytes':len(result['output'].encode())}
        # A real read/failing-test/edit/passing-test broker cycle with trusted data.
        case=td/'repair';case.mkdir(mode=0o700)
        with Project(case) as p:
            p.write('answer.py','def add(a,b): return a-b\n',None)
            p.write('test_answer.py','import unittest\nfrom answer import add\nclass TestAdd(unittest.TestCase):\n def test_add(self): self.assertEqual(add(2,3),5)\n',None)
            before=run_project(p,runtime,bwrap)
            if before['exit_code']==0 or before['limit']:raise Unavailable('Expected ordinary failing test')
            old=p.read('answer.py');p.write('answer.py','def add(a,b): return a+b\n',old['sha256'])
            after=run_project(p,runtime,bwrap)
            if after['exit_code']!=0 or after['limit']:raise Unavailable('Corrected test failed: '+json.dumps(after))
            results['repair']={'broken_exit':before['exit_code'],'fixed_exit':after['exit_code']}
    return {'status':'passed-on-this-linux-host','kernel':platform.release(),'runtime_manifest_sha256':identity,
            'agent_tools_enabled':False,'runpod_target_verified':False,'model_or_opencode_executed':False,'results':results}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--runtime',required=True);parser.add_argument('--bwrap',required=True)
    args=parser.parse_args()
    try:print(json.dumps(verify(args.runtime,args.bwrap),indent=2))
    except Exception as exc:
        print(json.dumps({'status':'blocked','agent_tools_enabled':False,'error':str(exc)}));return 1
    return 0
if __name__=='__main__':raise SystemExit(main())
