"""Keyless probe envelope, source pin and independent local deadline checks."""
import base64
import hashlib
import json
from pathlib import Path
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import host_inventory_probe as probe
import inventory_deadline as deadline
from host_policy import Refused
from test_prepared_host import NativeFixture


class InventoryProbeTests(unittest.TestCase):
    def test_receipt_is_bound_diagnostic_evidence_and_cannot_claim_a_model_permit(self):
        f=NativeFixture();inventory=f.proposal()
        raw=probe.receipt(f.session,inventory,'a'*64,now=f.start+1)
        value=json.loads(raw.decode().removeprefix(probe.PREFIX))
        self.assertEqual(value['sessionId'],f.session['sessionId'])
        self.assertEqual(value['nonce'],f.session['nonce'])
        self.assertTrue(value['inventoryOnly'])
        for field in ['modelLoaded','cudaValidated','boundaryValidated','modelPermitIssued','agentToolsEnabled']:
            self.assertIs(value[field],False)
        self.assertNotIn('UNJAILED_HOST_EVENT',raw.decode())
        self.assertLessEqual(len(raw),probe.MAX_RECEIPT)
        for now in [f.start-1,f.start+1800]:
            with self.assertRaises(Refused):probe.receipt(f.session,inventory,'a'*64,now=now)

    def test_receipt_rejects_unreviewed_extra_fields_and_unbounded_host_output(self):
        f=NativeFixture();inventory=f.proposal();inventory['environment']='DUMMY_NEVER_EXPORTED'
        with self.assertRaises(Refused):probe.receipt(f.session,inventory,'a'*64,now=f.start+1)
        inventory=f.proposal()
        with patch.object(probe,'MAX_RECEIPT',100):
            with self.assertRaises(Refused):probe.receipt(f.session,inventory,'a'*64,now=f.start+1)

    def test_large_but_bounded_package_inventory_is_not_discarded_at_32k(self):
        f=NativeFixture();inventory=f.proposal()
        while len(inventory['files'])<96:
            index=len(inventory['files'])
            inventory['files'].append({'path':'/usr/lib/x86_64-linux-gnu/libnvidia-'+('a'*220)+str(index)+'.so.1','package':'libnvidia-compute-570','sha256':'1'*64,'size':1})
        inventory['files'].sort(key=lambda value:value['path'])
        raw=probe.receipt(f.session,inventory,'a'*64,now=f.start+1)
        self.assertGreater(len(raw),32768)
        self.assertLessEqual(len(raw),65536)

    def test_independent_source_digest_refuses_changed_or_writable_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);files={}
            for name in probe.FILES:
                data=('# fixed '+name+'\n').encode();(root/name).write_bytes(data)
                files[name]=base64.b64encode(data).decode()
            source=json.dumps({'version':1,'files':files},sort_keys=True,separators=(',',':')).encode()
            digest=hashlib.sha256(source).hexdigest()
            def metadata(path):return SimpleNamespace(st_mode=stat.S_IFREG|0o600,st_uid=0,st_size=path.stat().st_size)
            with patch.object(probe,'HERE',root),patch.object(Path,'lstat',metadata):
                probe.verified_source(digest)
                (root/probe.FILES[0]).write_bytes(b'# changed\n')
                with self.assertRaises(Refused):probe.verified_source(digest)
            with patch.object(probe,'HERE',root),patch.object(Path,'lstat',lambda path:SimpleNamespace(st_mode=stat.S_IFREG|0o666,st_uid=0,st_size=10)):
                with self.assertRaises(Refused):probe.verified_source(digest)

    def test_local_deadline_does_not_depend_on_docker_or_change_expiry(self):
        f=NativeFixture();calls=[]
        source=SimpleNamespace(read_text=lambda:json.dumps(f.session))
        with patch.object(deadline.sys,'platform','linux'),patch.object(deadline.sys,'argv',['inventory_deadline.py']),patch.object(deadline.os,'geteuid',lambda:0),patch.object(deadline,'root_file',lambda _:source),patch.object(deadline.time,'time',lambda:f.start+1800),patch.object(deadline.subprocess,'run',lambda args,**kwargs:calls.append(args)):
            deadline.main()
        self.assertEqual(calls,[['/usr/bin/systemctl','poweroff']])
        with patch.object(deadline.sys,'platform','linux'),patch.object(deadline.sys,'argv',['inventory_deadline.py']),patch.object(deadline.os,'geteuid',lambda:0),patch.object(deadline,'root_file',lambda _:source),patch.object(deadline.time,'time',lambda:f.start+1),patch.object(deadline.subprocess,'run',lambda *args,**kwargs:self.fail('Early shutdown')):
            with self.assertRaises(Refused):deadline.main()

    def test_console_partial_writes_are_completed_instead_of_losing_receipt_bytes(self):
        writes=[]
        def write(fd,data):
            count=min(3,len(data));writes.append(data[:count]);return count
        with patch.object(probe.os,'open',lambda *args:7),patch.object(probe.os,'fstat',lambda _:SimpleNamespace(st_uid=0,st_mode=stat.S_IFCHR)),patch.object(probe.os,'write',write),patch.object(probe.os,'close',lambda _:None):
            probe.publish(b'fixed-evidence\n')
        self.assertEqual(b''.join(writes),b'\nfixed-evidence\n'*3)


if __name__=='__main__':unittest.main()
