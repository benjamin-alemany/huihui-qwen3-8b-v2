"""Dummy files only: no checkpoint downloaded or executed."""
import hashlib,importlib.util,json,os,tempfile,unittest
from pathlib import Path
s=importlib.util.spec_from_file_location('offline_cache',Path(__file__).with_name('offline_cache.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class CacheTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
  self.data={n:b'{}' for n in ('config.json','tokenizer.json','tokenizer_config.json')}
  self.data['model.safetensors.index.json']=json.dumps({'weight_map':{'dummy':'model-1.safetensors'}}).encode()
  self.data['model-1.safetensors']=b'DUMMY_NOT_MODEL_WEIGHTS'
  self.manifest={'files':{}}
  for n,b in self.data.items():
   (self.root/n).write_bytes(b);self.manifest['files'][n]={'size':len(b),'algorithm':'sha256','digest':hashlib.sha256(b).hexdigest()}
 def tearDown(self):self.tmp.cleanup()
 def check(self):return m.verify_files(self.root,self.manifest,owner_uid=os.getuid())
 def test_valid_dummy_files(self):self.assertEqual(self.check(),str(self.root))
 def test_changed_or_missing_file(self):
  (self.root/'config.json').write_bytes(b'xx')
  with self.assertRaises(m.CacheError):self.check()
 def test_extra_file(self):
  (self.root/'extra.py').write_bytes(b'DUMMY')
  with self.assertRaises(m.CacheError):self.check()
 def test_symlink(self):
  p=self.root/'config.json';p.unlink();p.symlink_to(self.root/'tokenizer.json')
  with self.assertRaises(m.CacheError):self.check()
 def test_group_writable_file(self):
  (self.root/'config.json').chmod(0o666)
  with self.assertRaises(m.CacheError):self.check()
 def test_unsafe_index_even_with_matching_digest(self):
  n='model.safetensors.index.json';b=json.dumps({'weight_map':{'dummy':'../outside.safetensors'}}).encode();(self.root/n).write_bytes(b);self.manifest['files'][n].update(size=len(b),digest=hashlib.sha256(b).hexdigest())
  with self.assertRaises(m.CacheError):self.check()
if __name__=='__main__':unittest.main()
