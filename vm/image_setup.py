"""Build-time only UID/directory setup; never run with model weights imported."""
import os
from pathlib import Path
for filename,line in [('/etc/passwd','inference:x:10001:10001:Inference:/home/inference:/usr/sbin/nologin'),('/etc/group','inference:x:10001:')]:
 p=Path(filename);text=p.read_text();existing=[x for x in text.splitlines() if len(x.split(':'))>2 and x.split(':')[2]=='10001']
 if existing and existing!=[line]:raise ValueError('Dedicated numeric identity occupied')
 if not existing:p.write_text(text+('' if text.endswith('\n') else '\n')+line+'\n')
for name in ['/cache','/home/inference']:
 p=Path(name);p.mkdir(parents=True,exist_ok=True);os.chown(p,10001,10001);os.chmod(p,0o700)
