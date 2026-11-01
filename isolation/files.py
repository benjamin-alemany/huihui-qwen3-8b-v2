"""Broker-owned disposable project. No shell, network or persistent-project API."""
import contextlib
import hashlib
import os
import re
import secrets
import stat
import threading
from pathlib import Path

MAX_FILE=65536
MAX_FILES=128
MAX_PROJECT=2*1024*1024
class Denied(ValueError): pass

def components(path):
    if not isinstance(path,str) or len(path)>240 or not re.fullmatch(r"[A-Za-z0-9_./-]+",path):
        raise Denied("Invalid relative project path")
    parts=path.split('/')
    if len(parts)>12 or any(not p or p in ('.','..') or p.startswith('.') for p in parts):
        raise Denied("Hidden paths and traversal denied")
    if any(p.lower() in ('auth.json','credentials','credentials.json','opencode.json','id_rsa','id_ed25519') for p in parts):
        raise Denied("Credential and harness configuration paths denied")
    return parts

def regular(info):
    if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>MAX_FILE:
        raise Denied("Only bounded single-link regular files allowed")

class Project:
    def __init__(self,path):
        self.path=Path(path).absolute()
        self.fd=os.open(self.path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        info=os.fstat(self.fd)
        if info.st_uid!=os.getuid() or info.st_mode & 0o077:
            os.close(self.fd);raise Denied("Project root must be private and broker-owned")
        self.lock=threading.RLock()
    def close(self):
        if self.fd is not None:os.close(self.fd);self.fd=None
    def __enter__(self):return self
    def __exit__(self,*args):self.close()
    @contextlib.contextmanager
    def parent(self,path):
        parts=components(path);fd=os.dup(self.fd)
        try:
            for part in parts[:-1]:
                nxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
                os.close(fd);fd=nxt
            yield fd,parts[-1]
        except OSError as exc:raise Denied("Path not accessible") from exc
        finally:os.close(fd)
    def _read(self,path):
        with self.parent(path) as (parent,name):
            try:fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
            except OSError as exc:raise Denied("File not accessible") from exc
            try:
                regular(os.fstat(fd))
                chunks=[];size=0
                while True:
                    block=os.read(fd,min(8192,MAX_FILE+1-size))
                    if not block:break
                    chunks.append(block);size+=len(block)
                    if size>MAX_FILE:raise Denied("File too large")
                return b''.join(chunks)
            finally:os.close(fd)
    def read(self,path):
        with self.lock:
            data=self._read(path)
            try:text=data.decode('utf-8')
            except UnicodeError as exc:raise Denied("Text files only") from exc
            return {'text':text,'sha256':hashlib.sha256(data).hexdigest()}
    def entries(self):
        result=[];size=0;nodes=0
        def walk(fd,prefix=''):
            nonlocal size,nodes
            for name in sorted(os.listdir(fd)):
                nodes+=1
                if nodes>MAX_FILES*2:raise Denied('Project entry quota exceeded')
                path=prefix+name;components(path)
                info=os.stat(name,dir_fd=fd,follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    sub=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
                    try:walk(sub,path+'/')
                    finally:os.close(sub)
                else:
                    regular(info);size+=info.st_size;result.append(path)
                    if len(result)>MAX_FILES or size>MAX_PROJECT:raise Denied("Project quota exceeded")
        with self.lock:walk(self.fd)
        return result
    def write(self,path,text,expected_sha256):
        if not isinstance(text,str):raise Denied("Text required")
        data=text.encode('utf-8')
        if len(data)>MAX_FILE:raise Denied("File too large")
        with self.lock:
            names=self.entries()
            if path in names:
                old=self._read(path)
                if expected_sha256!=hashlib.sha256(old).hexdigest():raise Denied("File changed; read again")
            elif expected_sha256 is not None:raise Denied("New files require null expected hash")
            else:old=b''
            total=sum(len(self._read(name)) for name in names)-len(old)+len(data)
            if total>MAX_PROJECT or (path not in names and len(names)>=MAX_FILES):raise Denied("Project quota exceeded")
            with self.parent(path) as (parent,name):
                # Replacing an existing symlink/hardlink is denied, not followed.
                try:regular(os.stat(name,dir_fd=parent,follow_symlinks=False))
                except FileNotFoundError:pass
                temp='broker-'+secrets.token_hex(16)
                fd=os.open(temp,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600,dir_fd=parent)
                try:
                    with os.fdopen(fd,'wb') as out:out.write(data);out.flush();os.fsync(out.fileno())
                    os.replace(temp,name,src_dir_fd=parent,dst_dir_fd=parent)
                    os.fsync(parent)
                finally:
                    try:os.unlink(temp,dir_fd=parent)
                    except FileNotFoundError:pass
            return {'sha256':hashlib.sha256(data).hexdigest()}
    def snapshot(self,destination):
        """Only fresh private scratch is written; never a caller-supplied persistent path."""
        dst=Path(destination)
        if not dst.is_dir() or any(dst.iterdir()):raise Denied("Empty trusted snapshot directory required")
        with self.lock:
            names=self.entries();size=0
            for name in names:
                content=self._read(name);size+=len(content)
                if size>MAX_PROJECT:raise Denied('Snapshot quota exceeded')
                target=dst/name;target.parent.mkdir(parents=True,exist_ok=True)
                with target.open('xb') as out:out.write(content)
                target.chmod(0o400)
        return len(names)
