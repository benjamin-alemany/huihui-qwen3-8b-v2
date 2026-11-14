"""CPU-only signed-index section regressions; no network, package or GPU use."""
import hashlib,unittest
from vm.metadata import verify_index,Refused

DATA=b'DUMMY SIGNED PACKAGE INDEX\n'
NAME='stable/binary-amd64/Packages.gz'
def row(algorithm,data=DATA,name=NAME):
    return ' '+hashlib.new(algorithm,data).hexdigest()+' '+str(len(data))+' '+name+'\n'
def release(sha256=None,sha512=None):
    # Same signed filename in both fields is valid and used by Docker's index.
    return ('Origin: DUMMY\nSHA256:\n'+(row('sha256') if sha256 is None else sha256)+'SHA512:\n'+(row('sha512') if sha512 is None else sha512)+'-----BEGIN PGP SIGNATURE-----\nDUMMY\n').encode()

class SignedIndexSectionTests(unittest.TestCase):
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
