"""CPU-only signed-index section regressions; no network, package or GPU use."""
import contextlib,hashlib,io,json,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from vm import metadata
from vm.metadata import verify_index,Refused

DATA=b'DUMMY SIGNED PACKAGE INDEX\n'
NAME='stable/binary-amd64/Packages.gz'
def row(algorithm,data=DATA,name=NAME):
    return ' '+hashlib.new(algorithm,data).hexdigest()+' '+str(len(data))+' '+name+'\n'
def release(sha256=None,sha512=None):
    # Same signed filename in both fields is valid and used by Docker's index.
    return ('Origin: DUMMY\nSHA256:\n'+(row('sha256') if sha256 is None else sha256)+'SHA512:\n'+(row('sha512') if sha512 is None else sha512)+'-----BEGIN PGP SIGNATURE-----\nDUMMY\n').encode()

class SignedIndexSectionTests(unittest.TestCase):
    def test_vendor_passed_event_requires_signature_digest_and_exact_package(self):
        key=b'DUMMY PUBLIC KEY';fingerprint='A'*40;package={'name':'dummy','version':'1','architecture':'amd64','sha256':'b'*64,'size':5,'filename':'./dummy.deb','repository':'cuda'}
        index=b'Package: dummy\nVersion: 1\nArchitecture: amd64\nSHA256: '+b'b'*64+b'\nSize: 5\nFilename: ./dummy.deb\n\n'
        signed=('SHA256:\n '+hashlib.sha256(index).hexdigest()+' '+str(len(index))+' Packages\nNext: field\n').encode()
        lock={'repositories':{'cuda':{'base':'https://dummy.invalid/','index':'Packages','algorithm':'sha256','fingerprint':fingerprint,'key_sha256':hashlib.sha256(key).hexdigest()}},'packages':[package]}
        with tempfile.TemporaryDirectory() as directory:
            here=Path(directory);(here/'keys').mkdir();(here/'keys/cuda.gpg').write_bytes(key)
            def read(url,limit):return signed if url.endswith('InRelease') else index
            for failure in [None,'signature','digest','package']:
                events=[];data=json.loads(json.dumps(lock))
                if failure=='package':data['packages'][0]['sha256']='c'*64
                getter=(lambda url,limit:read(url,limit)+(b'x' if url.endswith('Packages') else b'')) if failure=='digest' else read
                checked=SimpleNamespace(returncode=1 if failure=='signature' else 0,stdout='[GNUPG:] VALIDSIG '+fingerprint+'\n')
                with patch.object(metadata,'HERE',here),patch.object(metadata.subprocess,'run',return_value=checked):
                    if failure:
                        with self.assertRaises(Refused):metadata.verify(data,read=getter,report=lambda phase,status:events.append((phase,status)))
                    else:self.assertTrue(metadata.verify(data,read=getter,report=lambda phase,status:events.append((phase,status)))['cuda']['signature_verified'])
                self.assertEqual(events,[('metadata-cuda','running')]+([] if failure else [('metadata-cuda','passed')]))
    def test_progress_cli_suppresses_raw_error_and_never_reports_a_failed_vendor_passed(self):
        output=io.StringIO()
        def fail(lock,report=None):report('metadata-cuda','running');raise RuntimeError('DUMMY_PRIVATE_RAW_ERROR')
        with patch.object(metadata,'verify',side_effect=fail),patch('sys.argv',['metadata.py','--progress']),contextlib.redirect_stdout(output):
            with self.assertRaises(SystemExit) as caught:metadata.main()
        self.assertEqual(str(caught.exception),'Trusted vendor metadata verification refused')
        self.assertNotIn('DUMMY_PRIVATE',output.getvalue());self.assertNotIn('VERIFIED',output.getvalue())
        self.assertEqual([json.loads(line.removeprefix('UNJAILED_METADATA '))['status'] for line in output.getvalue().splitlines()],['running','failed'])
    def test_sha256_ignores_same_filename_in_later_sha512_section(self):
        verify_index(release(),DATA,NAME,'sha256')
    def test_sha512_ignores_same_filename_in_earlier_sha256_section(self):
        verify_index(release(),DATA,NAME,'sha512')
    def test_digest_and_size_tampering_still_refuse(self):
        for algorithm in ('sha256','sha512'):
            with self.subTest(algorithm=algorithm):
                with self.assertRaises(Refused):verify_index(release(),DATA+b'x',NAME,algorithm)
                changed=release().replace((' '+str(len(DATA))+' ').encode(),b' 999 ')
                with self.assertRaises(Refused):verify_index(changed,DATA,NAME,algorithm)
    def test_other_checksum_field_cannot_repair_bad_selected_digest(self):
        wrong=' '+'0'*64+' '+str(len(DATA))+' '+NAME+'\n'
        with self.assertRaises(Refused):verify_index(release(sha256=wrong),DATA,NAME,'sha256')
        wrong=' '+'0'*128+' '+str(len(DATA))+' '+NAME+'\n'
        with self.assertRaises(Refused):verify_index(release(sha512=wrong),DATA,NAME,'sha512')
    def test_missing_or_duplicate_selected_field_refuses(self):
        for value in [b'Origin: DUMMY\n',release()+b'SHA256:\n'+row('sha256').encode()]:
            with self.assertRaises(Refused):verify_index(value,DATA,NAME,'sha256')
    def test_duplicate_filename_inside_selected_field_refuses(self):
        with self.assertRaises(Refused):verify_index(release(sha256=row('sha256')*2),DATA,NAME,'sha256')
    def test_missing_filename_cannot_fall_through_to_another_field(self):
        with self.assertRaises(Refused):verify_index(release(sha256=row('sha256',name='another-index')),DATA,NAME,'sha256')
    def test_malformed_selected_rows_and_unreviewed_algorithms_refuse(self):
        for value in [row('sha512'),row('sha256').replace(' '+str(len(DATA))+' ',' -1 '),' DUMMY\n']:
            with self.assertRaises(Refused):verify_index(release(sha256=value),DATA,NAME,'sha256')
        for algorithm in ('md5','SHA256','sha1'):
            with self.assertRaises(Refused):verify_index(release(),DATA,NAME,algorithm)
    def test_invalid_encoding_refuses(self):
        with self.assertRaises(Refused):verify_index(b'\xff',DATA,NAME,'sha256')

if __name__=='__main__':unittest.main()
