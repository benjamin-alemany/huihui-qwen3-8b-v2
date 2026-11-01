"""Sealed entrypoint: lock out exec before importing any executable project."""
import ctypes
import sys
import unittest
from pathlib import Path

class SockFilter(ctypes.Structure):
    _fields_=[('code',ctypes.c_ushort),('jt',ctypes.c_ubyte),('jf',ctypes.c_ubyte),('k',ctypes.c_uint32)]
class SockProgram(ctypes.Structure):
    _fields_=[('length',ctypes.c_ushort),('filters',ctypes.POINTER(SockFilter))]

def lock_execution():
    raw=Path('/opt/no-exec.bpf').read_bytes()
    if not raw or len(raw)%ctypes.sizeof(SockFilter) or len(raw)>32768:raise RuntimeError('Invalid sealed filter')
    filters=(SockFilter*(len(raw)//ctypes.sizeof(SockFilter))).from_buffer_copy(raw)
    program=SockProgram(len(filters),filters)
    number=int(Path('/opt/seccomp-number.txt').read_text())
    if not 0<number<1024:raise RuntimeError('Invalid native syscall number')
    libc=ctypes.CDLL(None,use_errno=True)
    libc.syscall.argtypes=[ctypes.c_long,ctypes.c_uint,ctypes.c_uint,ctypes.c_void_p]
    libc.syscall.restype=ctypes.c_long
    if libc.syscall(number,1,0,ctypes.byref(program))!=0:
        raise RuntimeError('Second seccomp layer unavailable')

def main():
    lock_execution() # Failure aborts. Project code cannot run before this succeeds.
    sys.path.insert(0,'/project')
    suite=unittest.defaultTestLoader.discover('/project',pattern='test_*.py',top_level_dir='/project')
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1
if __name__=='__main__':raise SystemExit(main())
