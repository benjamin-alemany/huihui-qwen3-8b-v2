"""Fixed model-free inventory of the approved preinstalled A100 host.

No package installation, reboot, container/image pull, network request, CUDA
initialization, model, gateway, inference credential or automatic approval.
The external controller and both destroy guards still own billable teardown.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import select
import stat
import sys
import time

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from host_policy import Refused, manifest_from, root_file, timestamp
from prepared_host import canonical_inventory, collect_inventory

FILES = ('host_policy.py', 'prepared_host.py', 'host_inventory_probe.py', 'inventory_deadline.py')
PREFIX = 'UNJAILED_HOST_INVENTORY '
MAX_RECEIPT = 65536
FAILURE_PHASES = ('os-identity','gpu-identity','kernel-module','package-inventory','package-file-provenance','file-integrity','docker-version','proposal-contract')


def verified_source(expected):
    if not isinstance(expected, str) or not re.fullmatch('[0-9a-f]{64}', expected):
        raise Refused('Pinned inventory source required')
    files = {}
    for name in FILES:
        path = HERE / name
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or not 0 < info.st_size <= 65536:
            raise Refused('Inventory source refused')
        files[name] = base64.b64encode(path.read_bytes()).decode('ascii')
    raw = json.dumps({'version': 1, 'files': files}, sort_keys=True, separators=(',', ':')).encode()
    if hashlib.sha256(raw).hexdigest() != expected:
        raise Refused('Inventory source changed')


def receipt(session, inventory, source_hash, now=None):
    manifest_from(session)
    inventory = json.loads(canonical_inventory(inventory))
    now = time.time() if now is None else now
    if not timestamp(session['createdAt']) <= now < timestamp(session['deadlineUTC']):
        raise Refused('Original inventory deadline reached')
    result = {'version': 1, 'kind': 'host-inventory-only-v1',
              'sessionId': session['sessionId'], 'nonce': session['nonce'],
              'deadlineUTC': session['deadlineUTC'], 'observedAt': int(now * 1000),
              'sourceSHA256': source_hash, 'inventoryOnly': True,
              'modelLoaded': False, 'cudaValidated': False, 'boundaryValidated': False,
              'modelPermitIssued': False, 'agentToolsEnabled': False, 'inventory': inventory}
    raw = (PREFIX + json.dumps(result, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False) + '\n').encode('ascii')
    if len(raw) > MAX_RECEIPT:
        raise Refused('Inventory receipt exceeds bound')
    return raw


def publish(raw):
    delivered = False
    for name in ('/dev/console', '/dev/ttyS0', '/dev/tty1'):
        fd = None
        try:
            fd = os.open(name, os.O_WRONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NOCTTY | os.O_NONBLOCK)
            info = os.fstat(fd)
            if info.st_uid == 0 and stat.S_ISCHR(info.st_mode):
                data=b'\n'+raw;offset=0;limit=time.monotonic()+8
                while offset<len(data) and time.monotonic()<limit:
                    try:
                        count=os.write(fd,data[offset:])
                        if count<=0:break
                        offset+=count
                    except BlockingIOError:select.select([], [fd], [], .05)
                delivered = offset==len(data) or delivered
        except OSError:
            pass
        finally:
            if fd is not None:
                os.close(fd)
    if not delivered:
        raise Refused('Inventory console delivery unavailable')


def main():
    if sys.platform != 'linux' or os.geteuid() != 0 or len(sys.argv) != 4 or sys.argv[1:3] != ['--execute', '--source-sha256']:
        raise Refused('Approved root inventory execution required')
    verified_source(sys.argv[3])
    session = manifest_from(json.loads(root_file('/etc/unjailed/session.json').read_text()))
    try:
        inventory = collect_inventory(session)
        publish(receipt(session, inventory, sys.argv[3]))
    except Exception as error:
        phase='receipt-limit' if str(error)=='Inventory receipt exceeds bound' else next((p for p in FAILURE_PHASES if str(error)=='Prepared host inventory refused at '+p+'; no model start'),'unknown')
        value={'version':1,'kind':'host-inventory-failure-v1','sessionId':session['sessionId'],'nonce':session['nonce'],'deadlineUTC':session['deadlineUTC'],'sourceSHA256':sys.argv[3],'observedAt':int(time.time()*1000),'phase':phase}
        publish(('UNJAILED_HOST_INVENTORY_FAILURE '+json.dumps(value,sort_keys=True,separators=(',',':'))+'\n').encode('ascii'))
        raise Refused('Host inventory failed; fixed diagnostic emitted') from None


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('Model-free host inventory refused; no model permit or fallback')
