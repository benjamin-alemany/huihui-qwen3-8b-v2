"""Generate dummy-only Docker contexts reproducing the actual COPY-mode failure."""
import hashlib
import json
from pathlib import Path
import shutil
import sys

target = Path(sys.argv[1]);target.mkdir()
cache = target/'dummy';cache.mkdir(mode=0o700)
data = {n: b'{}' for n in ('config.json','tokenizer.json','tokenizer_config.json')}
data['model.safetensors.index.json'] = json.dumps({'weight_map': {'dummy': 'model-1.safetensors'}}).encode()
data['model-1.safetensors'] = b'DUMMY_NOT_WEIGHTS'
manifest = {'model': 'huihui-ai/Huihui-Qwen3-8B-abliterated-v2',
            'revision': '7d89db76029281fd8f3e6698a8e30738608105a9', 'files': {}}
for name, value in data.items():
    (cache/name).write_bytes(value)
    (cache/name).chmod(0o444)
    manifest['files'][name] = {'algorithm': 'sha256','size': len(value),'digest': hashlib.sha256(value).hexdigest()}
(target/'model-manifest.json').write_text(json.dumps(manifest))
shutil.copyfile(Path(__file__).resolve().parents[1]/'offline_cache.py', target/'offline_cache.py')
for directory in ('opt/qwen/model-notices','opt/qwen-model'):
    (target/directory).mkdir(parents=True,exist_ok=True)
(target/'Dockerfile.bad').write_text('''FROM docker.io/library/python@sha256:623674a14ef93d052bb9b0de4dbf5f28eb578a35263838941cc8aa43213c1487
COPY --chown=0:0 --chmod=0444 offline_cache.py /opt/qwen/offline_cache.py
COPY --chown=0:0 --chmod=0444 model-manifest.json /opt/qwen/model-manifest.json
COPY --link --chown=0:0 --chmod=0444 dummy/* /opt/qwen-model/
''')
(target/'Dockerfile.fixed').write_text('''FROM qwen-copy-mode-bad:fixture
COPY --link --chown=0:0 --chmod=0555 opt/ /opt/
''')
(target/'verify.py').write_text('''import os,sys,stat
sys.path.insert(0,"/opt/qwen")
import offline_cache
root=offline_cache.verify_cache()
for path in ("/opt/qwen","/opt/qwen-model"):
 assert stat.S_IMODE(os.stat(path).st_mode)==0o555
 assert not os.access(path,os.W_OK)
assert os.getuid()==10001
print("Directory-only layer preserves exact dummy hashes/ownership, readable files and no runtime writes")
''')
