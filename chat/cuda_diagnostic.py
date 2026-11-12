"""Model-free CUDA driver diagnostic. Existing process/network policy is mandatory.

This file replaces model_boot.py only in a separate diagnostic image. No torch,
model, tokenizer, HTTP server, arbitrary command, or unrestricted CUDA warmup.
"""
import ctypes as C
import json
import os
from pathlib import Path
import stat
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import credential_boundary as boundary
import network_boundary


def emit(stage, **fields):
    print('CUDA_DIAGNOSTIC ' + json.dumps({'stage': stage, **fields}, sort_keys=True), flush=True)


def device_nodes():
    result = []
    for name in ('/dev/nvidiactl', '/dev/nvidia-uvm', '/dev/nvidia0'):
        try:
            info = os.stat(name)
            result.append({'node': name, 'present': True, 'character_device': stat.S_ISCHR(info.st_mode),
                           'readable': os.access(name, os.R_OK), 'writable': os.access(name, os.W_OK)})
        except OSError as error:
            result.append({'node': name, 'present': False, 'errno': error.errno})
    return result


def proc_access():
    """Report access to fixed metadata paths, never read their contents."""
    result = []
    for path in ('/proc/self/maps', '/proc/self/fd', '/proc/self/ns/pid', '/proc/driver/nvidia/version'):
        try:
            fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC)
            os.close(fd)
            result.append({'path': path, 'open_allowed': True})
        except OSError as error:
            result.append({'path': path, 'open_allowed': False, 'errno': error.errno})
    return result


def driver_probe(load=C.CDLL):
    """Fixed library only. Results contain numeric CUDA codes, never error text."""
    emit('driver_library_load_begin')
    driver = load('libcuda.so.1', mode=os.RTLD_NOW | os.RTLD_LOCAL)
    driver.cuDriverGetVersion.argtypes = [C.POINTER(C.c_int)]
    driver.cuDriverGetVersion.restype = C.c_int
    version = C.c_int()
    code = driver.cuDriverGetVersion(C.byref(version))
    emit('driver_version', cuda_code=code, version=version.value if code == 0 else None)
    driver.cuInit.argtypes = [C.c_uint]
    driver.cuInit.restype = C.c_int
    emit('cuInit_begin')
    code = driver.cuInit(0)
    emit('cuInit_result', cuda_code=code)
    if code != 0:
        return False
    driver.cuDeviceGetCount.argtypes = [C.POINTER(C.c_int)]
    driver.cuDeviceGetCount.restype = C.c_int
    count = C.c_int()
    code = driver.cuDeviceGetCount(C.byref(count))
    passed = code == 0 and count.value == 1
    emit('device_count', cuda_code=code, count=count.value if code == 0 else None, passed=passed)
    return passed


def main():
    if sys.argv[1:]:
        raise ValueError('Fixed diagnostic only')
    receipt = boundary.verify_child()
    emit('credential_boundary_passed', **receipt)
    policy = network_boundary.install()  # Same policy, before CUDA or any thread.
    emit('network_boundary_installed', **policy)
    process = C.CDLL(None)
    audit = process.qwen_cuda_audit_version
    audit.argtypes = []
    audit.restype = C.c_int
    if audit() != 1:
        raise ValueError('Fixed diagnostic audit library required')
    emit('audit_ready', complete_syscall_trace=False, numeric_fields_only=True)
    emit('device_nodes', nodes=device_nodes())
    emit('proc_metadata_access', checks=proc_access())
    passed = driver_probe()
    emit('finished', driver_initialization_passed=passed, model_loaded=False, server_started=False,
         agent_tools_enabled=False, gpu_serving_validated=False)
    return 0 if passed else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        # No exception message or traceback: third-party strings may contain data.
        emit('refused', model_loaded=False, server_started=False, agent_tools_enabled=False)
        sys.exit(1)
