import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from isolation.files import Project,Denied,MAX_FILE,MAX_FILES,MAX_PROJECT
from isolation.sandbox import command,run_project,Unavailable,TEST_COMMAND
from isolation.broker import Broker
class PolicyTests(unittest.TestCase):
 def test_mandatory_isolation_has_no_optional_fallbacks(self):
  args=command('/opt/sealed','/opt/tools/bwrap','/tmp/fresh-snapshot',42)
  for flag in ('--unshare-user','--unshare-pid','--unshare-net','--unshare-ipc','--unshare-uts','--disable-userns','--clearenv','--new-session','--die-with-parent','--seccomp'):
   self.assertIn(flag,args)
  self.assertFalse(any(x.endswith('-try') for x in args))
  self.assertNotIn('--share-net',args);self.assertNotIn('--bind',args)
  self.assertEqual(args[-len(TEST_COMMAND):],list(TEST_COMMAND))
  self.assertEqual(args.count('--ro-bind'),2)
  self.assertEqual(args[args.index('--cap-drop')+1],'ALL')
 def test_unavailable_isolation_cannot_fall_back_to_popen(self):
  with patch('isolation.sandbox.validate_runtime',side_effect=Unavailable('denied')),patch('isolation.sandbox.subprocess.Popen') as popen:
   with self.assertRaises(Unavailable):run_project(None,'/not-a-runtime','/not-bwrap')
   popen.assert_not_called()
 def test_project_count_and_byte_limits(self):
  with tempfile.TemporaryDirectory() as td:
   with Project(td) as p:
    for i in range(MAX_PROJECT//MAX_FILE):p.write(str(i)+'.py','x'*MAX_FILE,None)
    with self.assertRaises(Denied):p.write('overflow.py','x',None)
  with tempfile.TemporaryDirectory() as td:
   with Project(td) as p:
    for i in range(MAX_FILES):p.write(str(i)+'.py','',None)
    with self.assertRaises(Denied):p.write('overflow.py','',None)
 def test_directory_bomb_is_bounded(self):
  with tempfile.TemporaryDirectory() as td:
   for i in range(MAX_FILES*2+1):(Path(td)/('d'+str(i))).mkdir()
   with Project(td) as p:
    with self.assertRaises(Denied):p.entries()
 def test_wrong_request_types_are_denied(self):
  with tempfile.TemporaryDirectory() as td:
   with Project(td) as p:
    b=Broker(p)
    for r in ({'operation':[]},{'operation':'write','path':'a.py','text':[],'expected_sha256':None},{'operation':'read','path':None}):
     with self.assertRaises(Denied):b.dispatch(r)
if __name__=='__main__':unittest.main()
