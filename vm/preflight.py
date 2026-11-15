"""Fixed unprivileged model-free native CUDA/cache gate, before Torch or weights."""
import ctypes as C,json,os,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
import credential_boundary as boundary,inference_policy,offline_cache
PROFILE='vm-native-cuda-v1'
def main():
 private=Path('/tmp/qwen-inference');private.mkdir(mode=0o700,exist_ok=True)
 boundary.verify_child();inference_policy.install();offline_cache.verify_cache()
 driver=C.CDLL('libcuda.so.1',mode=os.RTLD_NOW|os.RTLD_LOCAL)
 driver.cuInit.argtypes=[C.c_uint];driver.cuInit.restype=C.c_int
 if driver.cuInit(0)!=0:raise ValueError('Native CUDA initialization refused')
 driver.cuDriverGetVersion.argtypes=[C.POINTER(C.c_int)];driver.cuDriverGetVersion.restype=C.c_int
 version=C.c_int()
 if driver.cuDriverGetVersion(C.byref(version))!=0 or version.value<13000:raise ValueError('CUDA13-compatible native driver required')
 driver.cuDeviceGetCount.argtypes=[C.POINTER(C.c_int)];driver.cuDeviceGetCount.restype=C.c_int
 count=C.c_int()
 if driver.cuDeviceGetCount(C.byref(count))!=0 or count.value!=1:raise ValueError('Exactly one native GPU required')
 print(json.dumps({'version':1,'kind':PROFILE,'offlineCacheVerified':True,'cudaReady':True,'modelLoaded':False,'agentToolsEnabled':False}),flush=True)
if __name__=='__main__':
 try:main()
 except Exception:raise SystemExit('Model-free CUDA/cache preflight refused')
