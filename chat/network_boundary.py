"""Candidate Linux egress boundary. Enforce before torch/model imports; no fallback.

Landlock denies every TCP connect (including loopback); libseccomp disallows
non-TCP Internet sockets, alternate families and io_uring network bypasses.
Named/abstract UNIX sockets and all connect() calls are denied. Anonymous UNIX
socketpairs and inbound TCP accept/replies remain possible. Not a filesystem sandbox.
"""
import ctypes as C
import errno
import os
import platform
from pathlib import Path
import sys

class NetworkBoundaryError(RuntimeError):
    pass

class Ruleset(C.Structure):
    _fields_ = [('handled_access_fs', C.c_uint64), ('handled_access_net', C.c_uint64)]

class Compare(C.Structure):
    _fields_ = [('arg', C.c_uint), ('op', C.c_uint), ('a', C.c_uint64), ('b', C.c_uint64)]

def install():
    if sys.platform != 'linux' or C.sizeof(C.c_void_p) != 8 or platform.machine() not in ('x86_64', 'aarch64'):
        raise NetworkBoundaryError('Supported Linux kernel required; inference withheld')
    if Path("/proc/self/status").read_text().split("Threads:",1)[1].split()[0] != "1":
        raise NetworkBoundaryError("Network boundary must precede all threads")
    libc = C.CDLL(None, use_errno=True)
    libc.syscall.restype = C.c_long
    abi = libc.syscall(444, C.c_void_p(), C.c_size_t(0), C.c_uint(1))
    if abi < 4:
        raise NetworkBoundaryError('Landlock TCP restriction unavailable; inference withheld')
    if libc.prctl(38, 1, 0, 0, 0):
        raise NetworkBoundaryError('No-new-privileges unavailable')
    # No allow rules: every TCP destination port is denied. Do not downgrade.
    attr = Ruleset(0, 1 << 1)
    fd = libc.syscall(444, C.byref(attr), C.c_size_t(C.sizeof(attr)), C.c_uint(0))
    if fd < 0:
        raise NetworkBoundaryError('Landlock ruleset refused')
    try:
        if libc.syscall(446, C.c_int(fd), C.c_uint(0)):
            raise NetworkBoundaryError('Landlock enforcement refused')
    finally:
        os.close(fd)
    try:
        sec = C.CDLL('libseccomp.so.2')
    except OSError:
        raise NetworkBoundaryError('Required seccomp library unavailable') from None
    sec.seccomp_init.argtypes = [C.c_uint32]
    sec.seccomp_init.restype = C.c_void_p
    sec.seccomp_syscall_resolve_name.argtypes = [C.c_char_p]
    sec.seccomp_syscall_resolve_name.restype = C.c_int
    sec.seccomp_rule_add_array.argtypes = [C.c_void_p,C.c_uint32,C.c_int,C.c_uint,C.POINTER(Compare)]
    sec.seccomp_load.argtypes = [C.c_void_p]
    sec.seccomp_release.argtypes = [C.c_void_p]
    ctx = sec.seccomp_init(0x7fff0000)  # SCMP_ACT_ALLOW
    if not ctx:
        raise NetworkBoundaryError('Seccomp allocation refused')
    def deny(name, comparisons=()):
        number = sec.seccomp_syscall_resolve_name(name.encode())
        if number < 0:
            raise NetworkBoundaryError('Required syscall policy unavailable')
        rules = (Compare * len(comparisons))(*comparisons)
        if sec.seccomp_rule_add_array(ctx,0x50000 | errno.EPERM,number,len(rules),rules):
            raise NetworkBoundaryError('Seccomp rule refused')
    try:
        # SCMP_CMP_NE=1, EQ=4, MASKED_EQ=7. No named UNIX sockets: this
        # avoids pathname/abstract proxies without depending on Landlock ABI 9.
        deny('socket', (Compare(0,4,1,0),))
        deny('connect')
        # No descriptor theft from a less restricted sibling/ancestor.
        for name in ('pidfd_getfd','ptrace','process_vm_readv','process_vm_writev'):
            deny(name)
        deny('socket', (Compare(0,6,10,0),))
        for family in (0,3,4,5,6,7,8,9):
            deny('socket', (Compare(0,4,family,0),))
        deny('socketpair', (Compare(0,1,1,0),))
        # Datagram pairs can sendto() an unrelated named UNIX socket without
        # connect(). Only already-connected anonymous STREAM pairs are safe.
        for kind in range(0,16):
            if kind != 1:
                deny('socketpair', (Compare(1,7,15,kind),))
        deny('socketpair', (Compare(2,1,0,0),))
        for family in (2,10):
            # Block all base socket types except STREAM, including flags on DGRAM.
            for kind in range(0,16):
                if kind != 1:
                    deny('socket',(Compare(0,4,family,0),Compare(1,7,15,kind)))
            deny('socket',(Compare(0,4,family,0),Compare(2,6,6,0)))
            for protocol in range(1,6):
                deny('socket',(Compare(0,4,family,0),Compare(2,4,protocol,0)))
        for name in ('io_uring_setup','io_uring_enter','io_uring_register'):
            deny(name)
        if sec.seccomp_load(ctx):
            raise NetworkBoundaryError('Seccomp enforcement refused')
    finally:
        sec.seccomp_release(ctx)
    return {'policy':'inbound-only-no-named-ipc-v2','landlock_abi':abi,'tcp_connect_denied':True,
            'internet_datagrams_denied':True,'alternate_socket_families_denied':True,
            'io_uring_denied':True,'inherited_by_children':True,
            'named_unix_sockets_denied':True,'all_connect_denied':True,
            'cross_process_descriptor_access_denied':True}
