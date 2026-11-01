"""Native-architecture syscall allowlist for the initial single-process Python runner."""
import ctypes
import errno
from pathlib import Path
# Deliberately excludes socket/socketpair, clone/fork, mount/unshare/setns,
# ptrace/process_vm, keyring, bpf, perf, io_uring, chmod/chown and prctl.
ALLOW = """
read write readv writev close close_range fstat newfstatat stat lstat statx
statfs fstatfs lseek pread64 pwrite64 open openat access faccessat faccessat2 readlink readlinkat
getdents64 fcntl dup dup2 dup3 pipe pipe2
mmap mprotect munmap mremap madvise brk
rt_sigaction rt_sigprocmask rt_sigreturn sigaltstack
futex set_tid_address set_robust_list rseq arch_prctl
getrandom clock_gettime clock_getres gettimeofday time nanosleep clock_nanosleep
getpid getppid gettid getuid geteuid getgid getegid getgroups
getcwd chdir fchdir uname sysinfo getrlimit prlimit64 getrusage
sched_getaffinity sched_yield poll ppoll select pselect6
mkdir mkdirat rmdir unlink unlinkat rename renameat renameat2
fsync fdatasync ftruncate truncate umask
seccomp execve exit exit_group restart_syscall
""".split()

def export_filter(path,lockdown=False):
    lib=ctypes.CDLL('libseccomp.so.2',use_errno=True)
    lib.seccomp_init.argtypes=[ctypes.c_uint32];lib.seccomp_init.restype=ctypes.c_void_p
    lib.seccomp_syscall_resolve_name.argtypes=[ctypes.c_char_p];lib.seccomp_syscall_resolve_name.restype=ctypes.c_int
    lib.seccomp_rule_add.argtypes=[ctypes.c_void_p,ctypes.c_uint32,ctypes.c_int,ctypes.c_uint]
    lib.seccomp_export_bpf.argtypes=[ctypes.c_void_p,ctypes.c_int]
    lib.seccomp_release.argtypes=[ctypes.c_void_p]
    ctx=lib.seccomp_init(0x7fff0000 if lockdown else 0x00050000|errno.EPERM) # SCMP_ACT_ERRNO(EPERM), default deny.
    if not ctx:raise RuntimeError('seccomp_init failed')
    try:
        for name in (['execve','execveat','seccomp','prctl'] if lockdown else ALLOW):
            number=lib.seccomp_syscall_resolve_name(name.encode())
            if number<0:continue # Different native architectures/older libseccomp.
            if lib.seccomp_rule_add(ctx,0x00050000|errno.EPERM if lockdown else 0x7fff0000,number,0)!=0:raise RuntimeError('seccomp rule failed: '+name)
        with Path(path).open('xb') as out:
            if lib.seccomp_export_bpf(ctx,out.fileno())!=0:raise RuntimeError('seccomp export failed')
    finally:lib.seccomp_release(ctx)

def native_seccomp_number():
    lib=ctypes.CDLL('libseccomp.so.2')
    lib.seccomp_syscall_resolve_name.argtypes=[ctypes.c_char_p]
    lib.seccomp_syscall_resolve_name.restype=ctypes.c_int
    number=lib.seccomp_syscall_resolve_name(b'seccomp')
    if number<0:raise RuntimeError('Native seccomp syscall unavailable')
    return number
