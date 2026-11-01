"""Linux-only fixed-command sandbox. Missing isolation always fails closed."""
import hashlib
import json
import os
import resource
import selectors
import signal
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

class Unavailable(RuntimeError):pass

# Fixed command, never parsed from a tool request or model response.
TEST_COMMAND=('/usr/bin/python3','-I','-B','-m','unittest','discover','-s','/project','-p','test_*.py','-v')
WALL_SECONDS=8
OUTPUT_BYTES=65536

def trusted(path,directory=False):
    path=Path(path)
    if not path.is_absolute() or path.is_symlink():raise Unavailable('Trusted absolute non-symlink path required')
    current=path
    while True:
        info=current.lstat()
        if info.st_uid!=0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):raise Unavailable('Runtime/policy must be root-owned and not writable')
        if current.parent==current:break
        current=current.parent
    info=path.stat()
    if directory and not stat.S_ISDIR(info.st_mode):raise Unavailable('Runtime directory required')
    if not directory and (not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_mode & 0o6000):raise Unavailable('Unprivileged regular executable/policy required')

def validate_runtime(runtime,bwrap):
    if sys.platform!='linux' or os.getuid()==0:raise Unavailable('Unprivileged Linux executor required; no fallback')
    trusted(bwrap);trusted(runtime,directory=True)
    runtime=Path(runtime);manifest_path=runtime/'manifest.json';trusted(manifest_path)
    if manifest_path.stat().st_size>2*1024*1024:raise Unavailable('Manifest too large')
    manifest=json.loads(manifest_path.read_text())
    actual=set()
    for p in runtime.rglob('*'):
        trusted(p,directory=p.is_dir())
        if p.is_file() and p!=manifest_path:actual.add(str(p.relative_to(runtime)))
    if set(manifest)!=actual:raise Unavailable('Runtime contents changed')
    for name,want in manifest.items():
        if not isinstance(name,str) or name.startswith('/') or '..' in name.split('/'):raise Unavailable('Invalid manifest path')
        if hashlib.sha256((runtime/name).read_bytes()).hexdigest()!=want:raise Unavailable('Runtime digest mismatch')
    for needed in ('seccomp.bpf','rootfs/usr/bin/python3'):
        if needed not in manifest:raise Unavailable('Incomplete runtime')
    return hashlib.sha256(manifest_path.read_bytes()).hexdigest()

def limits():
    # Child setup runs in the single-threaded executor, before bwrap exec.
    for kind,value in ((resource.RLIMIT_CPU,4),(resource.RLIMIT_AS,512*1024*1024),
                       (resource.RLIMIT_FSIZE,1024*1024),(resource.RLIMIT_NOFILE,64),
                       (resource.RLIMIT_NPROC,32),(resource.RLIMIT_CORE,0)):
        resource.setrlimit(kind,(value,value))

def command(runtime,bwrap,project,filter_fd):
    # Mandatory unshare flags only. Never *-try, share-net, privileged, or host /.
    return [str(bwrap),'--die-with-parent','--new-session','--unshare-user','--unshare-pid',
      '--unshare-net','--unshare-ipc','--unshare-uts','--disable-userns','--cap-drop','ALL',
      '--clearenv','--ro-bind',str(Path(runtime)/'rootfs'),'/',
      '--ro-bind',str(project),'/project','--proc','/proc','--dev','/dev',
      '--size','16777216','--tmpfs','/tmp','--chdir','/project',
      '--setenv','HOME','/home/runner','--setenv','PATH','/usr/bin',
      '--setenv','LANG','C.UTF-8','--setenv','PYTHONHASHSEED','0',
      '--seccomp',str(filter_fd),'--',*TEST_COMMAND]

def run_project(project,runtime,bwrap):
    validate_runtime(runtime,bwrap)
    # A fresh snapshot is the only project mount. Caller paths never reach bwrap.
    with tempfile.TemporaryDirectory(prefix='qwen-exec-') as staging:
        snapshot=Path(staging)/'project';snapshot.mkdir(mode=0o700)
        project.snapshot(snapshot)
        fd=os.open(Path(runtime)/'seccomp.bpf',os.O_RDONLY|os.O_NOFOLLOW)
        process=None;selector=selectors.DefaultSelector();data=bytearray();reason=None
        try:
            process=subprocess.Popen(command(runtime,bwrap,snapshot,fd),stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,stderr=subprocess.STDOUT,env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'},
                close_fds=True,pass_fds=(fd,),preexec_fn=limits,start_new_session=True)
            selector.register(process.stdout,selectors.EVENT_READ)
            deadline=time.monotonic()+WALL_SECONDS
            while selector.get_map():
                remaining=deadline-time.monotonic()
                if remaining<=0:reason='wall-time-limit';break
                ready=selector.select(min(remaining,.1))
                for key,_ in ready:
                    block=os.read(key.fileobj.fileno(),min(8192,OUTPUT_BYTES+1-len(data)))
                    if not block:selector.unregister(key.fileobj);break
                    data.extend(block)
                    if len(data)>OUTPUT_BYTES:reason='output-limit';break
                if reason:break
            if reason is None:
                try:process.wait(timeout=max(.01,deadline-time.monotonic()))
                except subprocess.TimeoutExpired:reason='wall-time-limit'
        finally:
            os.close(fd);selector.close()
            if process:
                # Kill all tools/background descendants too; no process is reused.
                try:os.killpg(process.pid,signal.SIGKILL)
                except ProcessLookupError:pass
                process.wait()
                process.stdout.close()
        return {'exit_code':process.returncode,'limit':reason,'output':bytes(data[:OUTPUT_BYTES]).decode('utf-8','replace')}
