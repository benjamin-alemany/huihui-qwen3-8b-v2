import hashlib
import os
import tempfile
import unittest
from pathlib import Path
from isolation.files import Project,Denied,MAX_FILE
from isolation.broker import Broker
from isolation.sandbox import Unavailable,validate_runtime

class FilesTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)/'project';self.root.mkdir(mode=0o700)
        self.p=Project(self.root);self.b=Broker(self.p)
    def tearDown(self):self.p.close();self.temp.cleanup()
    def test_read_edit_compare_and_swap(self):
        out=self.b.dispatch({'operation':'write','path':'answer.py','text':'value=1\n','expected_sha256':None})
        self.assertEqual(self.b.dispatch({'operation':'read','path':'answer.py'})['text'],'value=1\n')
        self.b.dispatch({'operation':'write','path':'answer.py','text':'value=2\n','expected_sha256':out['sha256']})
        with self.assertRaises(Denied):self.p.write('answer.py','lost update',out['sha256'])
    def test_paths_cannot_escape(self):
        for path in ('/etc/passwd','../outside','a/../../outside','a//b','a/./b','a\\b','a\x00b','.env','.ssh/key','auth.json','opencode.json','a/'+('b/'*15)+'c'):
            with self.subTest(path=path),self.assertRaises(Denied):self.p.read(path)
    def test_symlink_file_and_parent_are_denied(self):
        outside=Path(self.temp.name)/'outside';outside.write_text('dummy-private')
        (self.root/'alias.py').symlink_to(outside)
        with self.assertRaises(Denied):self.p.read('alias.py')
        with self.assertRaises(Denied):self.p.write('alias.py','x',None)
        self.assertEqual(outside.read_text(),'dummy-private')
        (self.root/'alias.py').unlink();(self.root/'sub').symlink_to(self.root)
        with self.assertRaises(Denied):self.p.read('sub/file.py')
        with self.assertRaises(Denied):self.p.entries()
    def test_hardlinks_special_files_and_oversize_denied(self):
        source=Path(self.temp.name)/'outside';source.write_text('dummy')
        os.link(source,self.root/'linked.py')
        with self.assertRaises(Denied):self.p.read('linked.py')
        (self.root/'linked.py').unlink();os.mkfifo(self.root/'fifo.py')
        with self.assertRaises(Denied):self.p.read('fifo.py')
        (self.root/'fifo.py').unlink()
        with self.assertRaises(Denied):self.p.write('big.py','x'*(MAX_FILE+1),None)
    def test_unknown_tools_and_command_injection_are_denied(self):
        for req in ({'operation':'shell','command':'echo x'},{'operation':'test','command':'echo x'},{'operation':'test','env':{}},{'operation':'test','mount':'/'},{'operation':'read','path':'a.py','url':'https://example.test'},[]):
            with self.assertRaises(Denied):self.b.dispatch(req)
        with self.assertRaises(Denied):self.b.dispatch({'operation':'test'})
    def test_snapshot_contains_independent_regular_copies(self):
        self.p.write('a.py','x=1',None);destination=Path(self.temp.name)/'snapshot';destination.mkdir(mode=0o700)
        self.assertEqual(self.p.snapshot(destination),1)
        self.assertNotEqual((self.root/'a.py').stat().st_ino,(destination/'a.py').stat().st_ino)
        self.assertEqual((destination/'a.py').read_text(),'x=1')
    def test_untrusted_runtime_cannot_execute(self):
        with self.assertRaises((Unavailable,FileNotFoundError)):validate_runtime(self.root,self.root/'not-bwrap')
if __name__=='__main__':unittest.main()
