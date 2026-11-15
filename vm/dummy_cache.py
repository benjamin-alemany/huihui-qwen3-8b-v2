"""Build tiny dummy fixture bytes only; deliberately not valid model weights."""
import hashlib,json,os
from pathlib import Path
root=Path('/opt/qwen-model');root.mkdir(mode=0o755,exist_ok=True)
files={'config.json':b'{}','tokenizer.json':b'{}','tokenizer_config.json':b'{}','model.safetensors.index.json':b'{"weight_map":{"DUMMY":"model.safetensors"}}','model.safetensors':b'DUMMY-NOT-MODEL-WEIGHTS'}
items={}
for name,data in files.items():
 p=root/name;p.write_bytes(data);p.chmod(0o444);items[name]={'size':len(data),'algorithm':'sha256','digest':hashlib.sha256(data).hexdigest()}
Path('/opt/qwen/model-manifest.json').write_text(json.dumps({'model':'huihui-ai/Huihui-Qwen3-8B-abliterated-v2','revision':'7d89db76029281fd8f3e6698a8e30738608105a9','files':items}));Path('/opt/qwen/model-manifest.json').chmod(0o444)
