"""Read-only verification of separately prepared model files; never downloads."""
import hashlib
import json
import os
from pathlib import Path
import stat
import re
MODEL_ROOT=Path('/opt/qwen-model')
MANIFEST=Path('/opt/qwen/model-manifest.json')
MODEL='huihui-ai/Huihui-Qwen3-8B-abliterated-v2'
REVISION='7d89db76029281fd8f3e6698a8e30738608105a9'
class CacheError(ValueError):pass

def trusted(path,uid):
 info=path.lstat()
 if stat.S_ISLNK(info.st_mode) or info.st_uid!=uid or info.st_mode&0o022:raise CacheError('Untrusted model cache ownership/permissions')
 return info

def verify_cache(root=MODEL_ROOT,manifest=MANIFEST,*,owner_uid=0):
 root=Path(root);manifest=Path(manifest)
 for p in [root,*root.parents,manifest,*manifest.parents]:trusted(p,owner_uid)
 if manifest.stat().st_size>65536:raise CacheError('Manifest too large')
 m=json.loads(manifest.read_text())
 if set(m)!= {'model','revision','files'} or m['model']!=MODEL or m['revision']!=REVISION or not isinstance(m['files'],dict):raise CacheError('Wrong pinned manifest')
 return verify_files(root,m,owner_uid=owner_uid)

def manifest_files(m):
 expected=m['files']
 if not isinstance(expected,dict) or not {'config.json','tokenizer.json','tokenizer_config.json','model.safetensors.index.json'}.issubset(expected) or len(expected)>64 or any(not isinstance(n,str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}',n) or not n.endswith(('.json','.safetensors','.txt','.jinja')) for n in expected):raise CacheError('Unexpected model file list')
 for item in expected.values():
  if not isinstance(item,dict) or set(item)!={'size','algorithm','digest'} or type(item['size']) is not int or not 0<item['size']<=8*1024**3:raise CacheError('Invalid manifest item')
  length={'sha256':64,'git-sha1':40}.get(item['algorithm'])
  if not length or not isinstance(item['digest'],str) or not re.fullmatch('[0-9a-f]{'+str(length)+'}',item['digest']):raise CacheError('Invalid manifest digest')
 if sum(i['size'] for i in expected.values())>32*1024**3:raise CacheError('Cache too large')
 return expected

def verify_files(root,m,*,owner_uid):
 expected=manifest_files(m)
 if {p.name for p in root.iterdir()}!=set(expected):raise CacheError('Missing or extra model files')
 for name,item in expected.items():
  p=root/name;info=trusted(p,owner_uid)
  if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size!=item['size']:raise CacheError('Invalid cached file')
  if item['algorithm']=='sha256':h=hashlib.sha256()
  elif item['algorithm']=='git-sha1':h=hashlib.sha1(b'blob '+str(info.st_size).encode()+b'\0')
  else:raise CacheError('Unknown digest algorithm')
  with p.open('rb') as stream:
   for block in iter(lambda:stream.read(1024*1024),b''):h.update(block)
  if h.hexdigest()!=item['digest']:raise CacheError('Cached file digest mismatch')
 index=json.loads((root/"model.safetensors.index.json").read_text())
 shards=set(index.get("weight_map",{}).values())
 if not shards or any(n not in expected or "/" in n or not n.endswith(".safetensors") for n in shards):raise CacheError("Invalid shard index")
 if shards!={n for n in expected if n.endswith(".safetensors")}:raise CacheError("Unreferenced or missing shards")
 return str(root)
