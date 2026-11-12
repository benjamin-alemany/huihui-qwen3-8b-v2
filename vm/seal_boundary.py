"""Render/check/apply the dedicated trusted-host boundary before model creation.

The caller must be the reviewed root orchestrator on a new disposable VM. This
script never creates a VM, starts a container, installs packages or changes keys.
"""
import argparse,json,os,subprocess,sys,tempfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from host_policy import nftables,root_file,manifest_from
p=argparse.ArgumentParser();p.add_argument('--execute',action='store_true');args=p.parse_args()
if not args.execute or os.geteuid()!=0 or sys.platform!='linux':raise SystemExit('Reviewed VM root execution required')
m=manifest_from(json.loads(root_file('/etc/unjailed/session.json').read_text()))
with tempfile.NamedTemporaryFile(mode='w',prefix='unjailed-nft-',delete=True) as f:
 f.write(nftables());f.flush();subprocess.run(['nft','--check','--file',f.name],check=True,timeout=15);subprocess.run(['nft','--file',f.name],check=True,timeout=15)
Path('/etc/unjailed/tunnel-resolv.conf').write_text('nameserver 1.1.1.1\nnameserver 1.0.0.1\n');Path('/etc/unjailed/tunnel-resolv.conf').chmod(0o444)
Path('/etc/unjailed/empty-resolv.conf').write_text('');Path('/etc/unjailed/empty-resolv.conf').chmod(0o444)
Path('/etc/unjailed/empty-hosts').write_text('');Path('/etc/unjailed/empty-hosts').chmod(0o444)
Path('/etc/unjailed/hostname').write_text('unjailed\n');Path('/etc/unjailed/hostname').chmod(0o444)
handoff=Path('/run/unjailed/attestations')/m['sessionId'];handoff.mkdir(mode=0o700,parents=True,exist_ok=True)
if handoff.stat().st_uid!=0 or handoff.stat().st_mode&0o077 or any(handoff.iterdir()):raise SystemExit('Native handoff is not empty and root-only; no reset')
# Scope receipt: policy loaded, NOT proof of target adversarial/GPU acceptance.
Path('/var/lib/unjailed/host-boundary.json').write_text(json.dumps({'profile':'vm-private-ipc-v1','nftPolicyLoaded':True,'dockerNetwork':'none','embeddedDNS':False,'targetAdversarialTestsPassed':False})+'\n')
print('HOST_BOUNDARY_LOADED_MODEL_NOT_STARTED')
