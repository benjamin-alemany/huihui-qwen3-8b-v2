"""Trusted CPU-fixture build only; never a CUDA or production release receipt."""
import json,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
import credential_boundary as boundary,inference_policy,offline_cache
PROFILE='vm-cpu-fixture-v1'
def main():
 Path('/tmp/qwen-inference').mkdir(mode=0o700,exist_ok=True)
 boundary.verify_child();inference_policy.install();offline_cache.verify_cache()
 print(json.dumps({'version':1,'kind':PROFILE,'offlineCacheVerified':True,'cudaReady':False,'modelLoaded':False,'agentToolsEnabled':False}),flush=True)
if __name__=='__main__':
 try:main()
 except Exception:raise SystemExit('Dummy CPU preflight refused')
