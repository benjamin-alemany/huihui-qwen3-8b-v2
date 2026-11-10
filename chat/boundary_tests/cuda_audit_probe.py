"""CPU fixture, not a Runpod/CUDA proof. Run in a clean, network-less CI process."""
import ctypes as C
import errno
import json
import os
from pathlib import Path
import socket
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cuda_diagnostic
import network_boundary

assert sys.platform == 'linux' and not sys.argv[1:]
policy = network_boundary.install()
assert policy['named_unix_sockets_denied'] and policy['all_connect_denied']
assert C.CDLL(None).qwen_cuda_audit_version() == 1
# Anonymous STREAM pairs still work; the observer cannot broaden the policy.
a, b = socket.socketpair()
with a, b:
    a.sendall(b'DUMMY-CANARY-NOT-A-KEY')
    assert b.recv(100) == b'DUMMY-CANARY-NOT-A-KEY'
for family, kind in ((socket.AF_UNIX, socket.SOCK_SEQPACKET | socket.SOCK_CLOEXEC),
                     (socket.AF_INET, socket.SOCK_DGRAM)):
    try: socket.socket(family, kind)
    except OSError as error: assert error.errno == errno.EPERM
    else: raise AssertionError('Diagnostic observer weakened socket denial')
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
    try: s.connect(('127.0.0.1', 9))
    except OSError as error: assert error.errno == errno.EPERM
    else: raise AssertionError('Diagnostic observer weakened connect denial')
fd = os.memfd_create('DUMMY-CANARY-NOT-A-KEY')
os.close(fd)
assert cuda_diagnostic.driver_probe() is False
# Exercise the bounded observer after collecting the useful failure evidence.
for _ in range(150):
    try: socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
    except OSError as error: assert error.errno == errno.EPERM
    else: raise AssertionError('UNIX datagram permitted')
print('CPU_AUDIT_FIXTURE ' + json.dumps({'fake_cuda_304_observed': True,
      'outbound_denied': True, 'anonymous_stream_pair_allowed': True,
      'real_cuda_validated': False, 'agent_tools_enabled': False}))
