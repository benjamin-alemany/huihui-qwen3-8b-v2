"""VM candidate only. Never substitute this into a Runpod image.

Host namespace + nftables enforcement is mandatory. UNIX STREAM/SEQPACKET IPC
is local to the isolated container. TCP initiation is also denied by Landlock.
This is not a code-execution sandbox or target-GPU validation.
"""
import ctypes as C,errno,os,platform,sys
from pathlib import Path
class Refused(RuntimeError):pass
class Ruleset(C.Structure):_fields_=[('fs',C.c_uint64),('net',C.c_uint64)]
class Compare(C.Structure):_fields_=[('arg',C.c_uint),('op',C.c_uint),('a',C.c_uint64),('b',C.c_uint64)]
def install():
    if sys.platform!='linux' or platform.machine()!='x86_64' or os.getuid()!=10001:raise Refused('Dedicated Linux model identity required')
    status=dict(line.split(':',1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)
    if int(status['Threads'])!=1 or int(status['NoNewPrivs'])!=1 or any(int(status[k],16) for k in ['CapEff','CapPrm','CapInh','CapAmb']):raise Refused('Unprivileged single-threaded bootstrap required')
    libc=C.CDLL(None,use_errno=True);libc.syscall.restype=C.c_long
    abi=libc.syscall(444,C.c_void_p(),C.c_size_t(0),C.c_uint(1))
    if abi<4:raise Refused('Landlock TCP boundary unavailable')
    rule=Ruleset(0,2);fd=libc.syscall(444,C.byref(rule),C.sizeof(rule),0)
    if fd<0:raise Refused('Landlock creation refused')
    try:
        if libc.syscall(446,fd,0):raise Refused('Landlock enforcement refused')
    finally:os.close(fd)
    sec=C.CDLL('libseccomp.so.2');sec.seccomp_init.argtypes=[C.c_uint32];sec.seccomp_init.restype=C.c_void_p
    sec.seccomp_rule_add_array.argtypes=[C.c_void_p,C.c_uint32,C.c_int,C.c_uint,C.POINTER(Compare)]
    sec.seccomp_syscall_resolve_name.argtypes=[C.c_char_p];sec.seccomp_load.argtypes=[C.c_void_p];sec.seccomp_release.argtypes=[C.c_void_p]
    ctx=sec.seccomp_init(0x7fff0000)
    if not ctx:raise Refused('Seccomp creation refused')
    def deny(name,rules=()):
        syscall=sec.seccomp_syscall_resolve_name(name.encode());array=(Compare*len(rules))(*rules)
        if syscall<0 or sec.seccomp_rule_add_array(ctx,0x50000|errno.EPERM,syscall,len(rules),array):raise Refused('Required syscall rule refused')
    try:
        for name in ['io_uring_setup','io_uring_enter','io_uring_register','pidfd_getfd','ptrace','process_vm_readv','process_vm_writev','setns','unshare','mount','umount2','bpf','perf_event_open','keyctl']:deny(name)
        # Permit only UNIX STREAM/SEQPACKET and Internet STREAM/TCP sockets.
        deny('socket',(Compare(0,6,10,0),))
        for family in [0,3,4,5,6,7,8,9]:deny('socket',(Compare(0,4,family,0),))
        for family in [1,2,10]:
            for kind in range(16):
                if kind not in ([1,5] if family==1 else [1]):deny('socket',(Compare(0,4,family,0),Compare(1,7,15,kind)))
            if family==1:deny('socket',(Compare(0,4,family,0),Compare(2,1,0,0)))
            else:
                deny('socket',(Compare(0,4,family,0),Compare(2,6,6,0)))
                for protocol in range(1,6):deny('socket',(Compare(0,4,family,0),Compare(2,4,protocol,0)))
        deny('socketpair',(Compare(0,1,1,0),))
        for kind in range(16):
            if kind not in [1,5]:deny('socketpair',(Compare(1,7,15,kind),))
        deny('socketpair',(Compare(2,1,0,0),))
        if sec.seccomp_load(ctx):raise Refused('Seccomp enforcement refused')
    finally:sec.seccomp_release(ctx)
    return {'profile':'vm-private-ipc-v1','landlockABI':abi,'tcpInitiationDenied':True,'privateUnixIPCAllowed':True,'requiresExternalHostBoundary':True,'agentToolsEnabled':False}
