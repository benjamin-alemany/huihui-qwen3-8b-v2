"""Trusted Linux image-build stage only. No downloads or untrusted code execution."""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import sysconfig
from pathlib import Path
from isolation.seccomp import export_filter

def prepare(destination):
    if sys.platform!='linux' or os.geteuid()!=0:raise RuntimeError('Trusted Linux root build stage required')
    dst=Path(destination)
    if dst.exists():raise RuntimeError('Destination must not exist')
    fs=dst/'rootfs';fs.mkdir(parents=True)
    for name in ('project','tmp','dev','proc','home/runner','etc','usr/bin','opt'):(fs/name).mkdir(parents=True,exist_ok=True)
    copied=set()
    def copy_file(source,target=None):
        source=Path(source);target=fs/str(target or source).lstrip('/')
        target.parent.mkdir(parents=True,exist_ok=True)
        if target.exists():return
        shutil.copyfile(source.resolve(),target);target.chmod(0o555 if os.access(source,os.X_OK) else 0o444)
    def libs(binary):
        # ldd is used only on OS-provided Python and its trusted stdlib extensions.
        data=subprocess.run(['/usr/bin/ldd',str(binary)],capture_output=True,text=True,check=True,env={'PATH':'/usr/bin:/bin','LANG':'C'}).stdout
        for match in re.findall(r'(/[^\s()]+)',data):
            if Path(match).is_file():copy_file(match)
    executable=Path(sys.executable).resolve();copy_file(executable,'/usr/bin/python3');libs(executable)
    stdlib=Path(sysconfig.get_path('stdlib'))
    excluded={'__pycache__','site-packages','dist-packages','ensurepip','idlelib','tkinter','turtledemo','test','tests'}
    for source in stdlib.rglob('*'):
        relative=source.relative_to(stdlib)
        if any(part in excluded for part in relative.parts) or not source.is_file():continue
        # Exclude startup customization installed by a host/application.
        if source.name in ('sitecustomize.py','usercustomize.py'):continue
        copy_file(source,Path('/usr/lib')/stdlib.name/relative)
        if source.suffix=='.so':libs(source)
    (fs/'etc/passwd').write_text('runner:x:10004:10004:executor:/home/runner:/nonexistent\n')
    (fs/'etc/group').write_text('runner:x:10004:\n')
    export_filter(dst/'seccomp.bpf')
    for p in dst.rglob('*'):
        if p.is_dir():p.chmod(0o555)
        else:p.chmod(0o555 if os.access(p,os.X_OK) else 0o444)
    manifest={str(p.relative_to(dst)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(dst.rglob('*')) if p.is_file()}
    (dst/'manifest.json').write_text(json.dumps(manifest,sort_keys=True,indent=2)+'\n')
    (dst/'manifest.json').chmod(0o444);dst.chmod(0o555)
    print(json.dumps({'runtime_files':len(manifest),'runtime_bytes':sum(p.stat().st_size for p in dst.rglob('*') if p.is_file()),'agent_tools_enabled':False}))
if __name__=='__main__':prepare(sys.argv[1])
