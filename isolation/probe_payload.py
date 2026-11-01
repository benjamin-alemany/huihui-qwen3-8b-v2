"""Trusted verification code copied into disposable scratch; no real credentials."""
import ctypes
import errno
import fcntl
import termios
import json
import os
import resource
import socket
import unittest
from pathlib import Path

class Boundaries(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.expected=json.loads(Path('/project/boundary.json').read_text())
    def test_namespaces_and_privileges(self):
        status=Path('/proc/self/status').read_text()
        self.assertIn('NoNewPrivs:\t1',status)
        self.assertIn('Seccomp:\t2',status)
        caps=next(x.split(':',1)[1].strip() for x in status.splitlines() if x.startswith('CapEff:'))
        self.assertEqual(int(caps,16),0)
        for name,host in self.expected['namespaces'].items():self.assertNotEqual(os.readlink('/proc/self/ns/'+name),host,name)
    def test_no_sockets_or_dns(self):
        for family in (socket.AF_INET,socket.AF_INET6,socket.AF_UNIX):
            with self.assertRaises(PermissionError):socket.socket(family,socket.SOCK_STREAM)
        with self.assertRaises(socket.gaierror):socket.getaddrinfo('isolation-probe.invalid',80)
    def test_no_host_files_model_gpu_control_backup_or_credentials(self):
        for path in self.expected['hidden_paths']+['/workspace','/run/secrets','/opt/qwen','/dev/nvidia0','/var/run/docker.sock','/home/runner/.ssh']:
            self.assertFalse(Path(path).exists(),path)
        for name in ('RUNPOD_API_KEY','VLLM_API_KEY','CLOUDFLARE_API_TOKEN','AWS_SECRET_ACCESS_KEY','GITHUB_TOKEN'):
            self.assertNotIn(name,os.environ)
        self.assertEqual(Path('/project/dummy.env.example').read_text(),'DUMMY_ONLY=not-a-real-credential\n')
    def test_readonly_project_and_runtime(self):
        for path in ('/project/test_boundaries.py','/usr/bin/python3','/etc/passwd'):
            with self.assertRaises(OSError):open(path,'ab')
        self.assertEqual(os.statvfs('/tmp').f_blocks*os.statvfs('/tmp').f_frsize,16*1024*1024)
        with self.assertRaises(OSError):Path('/tmp/scratch.txt').write_text('disposable')
        with self.assertRaises(OSError):Path('/dev/untrusted-file').write_text('disposable')
        with self.assertRaises(PermissionError):fcntl.ioctl(0,termios.TIOCSTI,b'x')
    def test_no_fork_namespace_changes_or_ptrace(self):
        with self.assertRaises(PermissionError):os.fork()
        with self.assertRaises(PermissionError):os.execve('/usr/bin/python3',['python3','-I','-c','raise SystemExit(97)'],{})
        libc=ctypes.CDLL(None,use_errno=True)
        self.assertEqual(libc.unshare(0x40000000),-1);self.assertEqual(ctypes.get_errno(),errno.EPERM)
        self.assertEqual(libc.ptrace(0,0,None,None),-1);self.assertEqual(ctypes.get_errno(),errno.EPERM)
    def test_memory_and_cpu_limits(self):
        self.assertEqual(resource.getrlimit(resource.RLIMIT_AS),(512*1024*1024,)*2)
        self.assertEqual(resource.getrlimit(resource.RLIMIT_CPU),(4,4))
        with self.assertRaises(MemoryError):bytearray(1024*1024*1024)
if __name__=='__main__':unittest.main()
