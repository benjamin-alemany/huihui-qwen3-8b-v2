"""No HTTP listener or OpenCode integration. Explicit owned-project API only."""
from isolation.files import Denied
from isolation.sandbox import run_project

class Broker:
    def __init__(self,project,runtime=None,bwrap=None):
        self.project=project;self.runtime=runtime;self.bwrap=bwrap
    def dispatch(self,request):
        if not isinstance(request,dict):raise Denied('Object required')
        operation=request.get('operation')
        if not isinstance(operation,str):raise Denied('Operation must be a string')
        schema={'read':{'operation','path'},'write':{'operation','path','text','expected_sha256'},'test':{'operation'}}
        if operation not in schema or set(request)!=schema[operation]:raise Denied('Unknown operation or parameters')
        if operation=='read':return self.project.read(request['path'])
        if operation=='write':return self.project.write(request['path'],request['text'],request['expected_sha256'])
        if not self.runtime or not self.bwrap:raise Denied('Execution sandbox not configured')
        # No supplied command, shell, destination, timeout, environment or mount.
        return run_project(self.project,self.runtime,self.bwrap)
