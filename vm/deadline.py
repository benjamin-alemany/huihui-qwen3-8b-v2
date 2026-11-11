"""Local inference stop only. External guards must destroy VM/IP to end billing."""
import json,subprocess,sys,time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from host_policy import root_file,manifest_from,timestamp
m=manifest_from(json.loads(root_file('/etc/unjailed/session.json').read_text()))
if time.time()<timestamp(m['deadlineUTC']):raise SystemExit('Deadline has not arrived')
subprocess.run(['/usr/bin/docker','stop','--time','5','uj-model-'+m['sessionId']],check=False,timeout=15)
# Poweroff does not end provider billing. Both external destroy guards stay armed.
subprocess.run(['/usr/bin/systemctl','poweroff'],check=True,timeout=15)
