"""Disposable CPU image check only. No keys, cache, model, GPU or provider API."""
import ctypes
import os
import sys

if os.getuid() != 0 or sys.argv[1:]:
    raise RuntimeError('Fixed disposable root launcher required')
if ctypes.CDLL(None).prctl(38, 1, 0, 0, 0):
    raise RuntimeError('No-new-privileges required')
os.setgroups([])
os.setresgid(10001,10001,10001)
os.setresuid(10001,10001,10001)
env = {'PATH': os.path.dirname(sys.executable)+':/usr/bin:/bin', 'HOME': '/tmp',
       'LD_PRELOAD': '/opt/qwen/loopback_ifaddrs.so', 'GLOO_SOCKET_IFNAME': 'lo',
       'VLLM_ENABLE_V1_MULTIPROCESSING': '0', 'HF_HUB_OFFLINE': '1',
       'TRANSFORMERS_OFFLINE': '1', 'VLLM_NO_USAGE_STATS': '1', 'DO_NOT_TRACK': '1',
       'OMP_NUM_THREADS': '1', 'MKL_NUM_THREADS': '1'}
os.execve(sys.executable, [sys.executable,'-I','-B','/opt/qwen/boundary_tests/transport_probe.py','--serving-libraries'], env)
