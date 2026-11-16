"""Inspect and verify a source-reviewed CUDA 13 compatibility library lock.

This module never imports Torch, initializes CUDA, installs packages or changes
the environment. Inventory output is evidence for review, never an approval:
the caller must ship the reviewed lock in its pinned, root-owned application.
Only the fixed compatibility directory and fixed CUDA loader directories are
examined. No inherited or caller-provided LD_LIBRARY_PATH is accepted.
"""
import argparse
import hashlib
import json
import os
from pathlib import PurePosixPath
import re
import stat
import subprocess


COMPAT_DIRECTORY = '/usr/local/cuda-13.0/compat'
LIBRARY_DIRECTORIES = (
    '/usr/local/nvidia/lib64',
    '/usr/local/nvidia/lib',
    '/usr/local/cuda-13.0/targets/x86_64-linux/lib',
)
PACKAGE_NAME = 'cuda-compat-13-0'
MAX_FILE_BYTES = 256 * 1024 * 1024
MAX_TOTAL_BYTES = 512 * 1024 * 1024
MAX_FILES = 32
_SHA256 = re.compile(r'[0-9a-f]{64}')
_IMAGE = re.compile(r'[a-z0-9][a-z0-9./_-]*@sha256:[0-9a-f]{64}')
_VERSION = re.compile(r'[0-9][0-9A-Za-z.+:~_-]{0,127}')
_LIBRARY = re.compile(
    r'lib(?:cuda|cudadebugger|nvidia-(?:gpucomp|nvvm(?:70)?|ptxjitcompiler|pkcs11(?:-openssl3)?))'
    r'\.so(?:\.[0-9]+)*'
)


class CompatibilityRefused(ValueError):
    """Fixed diagnostics contain no credentials or file contents."""


def _refuse(message):
    raise CompatibilityRefused(message)


def _package(value):
    if (not isinstance(value, dict) or set(value) != {'name', 'version', 'architecture'}
            or value['name'] != PACKAGE_NAME or value['architecture'] != 'amd64'
            or not isinstance(value['version'], str) or not _VERSION.fullmatch(value['version'])):
        _refuse('Exact CUDA compatibility package identity required')
    return dict(value)


def _entries(files, symlinks):
    if (not isinstance(files, dict) or not files or not isinstance(symlinks, dict)
            or len(files) + len(symlinks) > MAX_FILES or set(files) & set(symlinks)):
        _refuse('Exact bounded compatibility library inventory required')
    total = 0
    for name, value in files.items():
        if (not isinstance(name, str) or not _LIBRARY.fullmatch(name)
                or not isinstance(value, dict) or set(value) != {'size', 'sha256'}
                or type(value['size']) is not int or not 0 < value['size'] <= MAX_FILE_BYTES
                or not isinstance(value['sha256'], str) or not _SHA256.fullmatch(value['sha256'])):
            _refuse('Invalid pinned compatibility library')
        total += value['size']
    if total > MAX_TOTAL_BYTES:
        _refuse('Compatibility library inventory exceeds size bound')
    for name, target in symlinks.items():
        if (not isinstance(name, str) or not _LIBRARY.fullmatch(name)
                or not isinstance(target, str) or not _LIBRARY.fullmatch(target)):
            _refuse('Only reviewed local library symlinks are permitted')
        seen = {name}
        while target in symlinks:
            if target in seen:
                _refuse('Compatibility symlink cycle forbidden')
            seen.add(target)
            target = symlinks[target]
            if not isinstance(target, str) or not _LIBRARY.fullmatch(target):
                _refuse('Only reviewed local library symlinks are permitted')
        if target not in files:
            _refuse('Compatibility symlink must resolve to a pinned regular file')
    if 'libcuda.so.1' not in files and 'libcuda.so.1' not in symlinks:
        _refuse('Pinned CUDA driver soname required')


def validate_lock(lock):
    """Validate schema only; never promote observed inventory into a lock."""
    if (not isinstance(lock, dict) or set(lock) != {
            'version', 'kind', 'directory', 'sourceImage', 'package', 'reviewed', 'files', 'symlinks'}
            or type(lock['version']) is not int or lock['version'] != 1
            or lock['kind'] != 'cuda-compat-13-0-v1'
            or lock['directory'] != COMPAT_DIRECTORY or lock['reviewed'] is not True
            or not isinstance(lock['sourceImage'], str) or not _IMAGE.fullmatch(lock['sourceImage'])):
        _refuse('Source-reviewed compatibility hash manifest required')
    _package(lock['package'])
    _entries(lock['files'], lock['symlinks'])
    return json.loads(json.dumps(lock))


def lock_digest(lock):
    return hashlib.sha256(json.dumps(validate_lock(lock), sort_keys=True,
                                   separators=(',', ':')).encode()).hexdigest()


def _directory_metadata(info):
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022
            or info.st_mode & 0o7000):
        _refuse('Root-owned non-writable CUDA directory required')
    return {'uid': info.st_uid, 'mode': stat.S_IMODE(info.st_mode), 'kind': 'directory'}


def _directory_fd(root, absolute):
    """Walk with openat/O_NOFOLLOW; return an FD and checked ancestor metadata."""
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    current = os.open(root, flags)
    metadata = {}
    try:
        metadata['/'] = _directory_metadata(os.fstat(current))
        prefix = ''
        for part in PurePosixPath(absolute).parts[1:]:
            child = os.open(part, flags, dir_fd=current)
            os.close(current)
            current = child
            prefix += '/' + part
            metadata[prefix] = _directory_metadata(os.fstat(current))
        return current, metadata
    except Exception:
        os.close(current)
        raise


def query_package_identity():
    """Read only the fixed package's name/version/architecture, with a clean env."""
    try:
        result = subprocess.run(
            ['/usr/bin/dpkg-query', '--show', '--showformat=${Package}\t${Version}\t${Architecture}\n',
             PACKAGE_NAME], check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}, timeout=10, close_fds=True)
        if len(result.stdout) > 4096:
            _refuse('Compatibility package identity unavailable')
        rows = result.stdout.decode('ascii').splitlines()
        if len(rows) != 1 or len(rows[0].split('\t')) != 3:
            _refuse('Compatibility package identity unavailable')
        name, version, architecture = rows[0].split('\t')
        return _package({'name': name, 'version': version, 'architecture': architecture})
    except (OSError, subprocess.SubprocessError, UnicodeError):
        _refuse('Compatibility package identity unavailable')


def build_inventory(package_identity, *, root='/'):
    """Inspect fixed paths without loading libraries; root supports CPU fixtures.

    package_identity must come from query_package_identity() for a live check.
    Offline inspection may supply identity from the image's package metadata.
    This function deliberately emits no reviewed:true value or source-image pin.
    """
    package = _package(package_identity)
    files, symlinks, directories = {}, {}, {}
    descriptor = None
    try:
        descriptor, directories = _directory_fd(root, COMPAT_DIRECTORY)
        before = os.fstat(descriptor)
        names = sorted(os.listdir(descriptor))
        if not names or len(names) > MAX_FILES:
            _refuse('Exact bounded compatibility library inventory required')
        total = 0
        for name in names:
            if not _LIBRARY.fullmatch(name):
                _refuse('Unreviewed compatibility directory entry')
            info = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
            if info.st_uid != 0 or info.st_mode & 0o7000:
                _refuse('Untrusted compatibility directory entry')
            if stat.S_ISLNK(info.st_mode):
                symlinks[name] = os.readlink(name, dir_fd=descriptor)
                continue
            if (not stat.S_ISREG(info.st_mode) or info.st_mode & 0o022 or info.st_nlink != 1
                    or not 0 < info.st_size <= MAX_FILE_BYTES):
                _refuse('Root-owned immutable regular compatibility file required')
            total += info.st_size
            if total > MAX_TOTAL_BYTES:
                _refuse('Compatibility library inventory exceeds size bound')
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK,
                         dir_fd=descriptor)
            with os.fdopen(fd, 'rb') as stream:
                opened = os.fstat(stream.fileno())
                if (opened.st_dev, opened.st_ino, opened.st_mode, opened.st_uid, opened.st_size,
                        opened.st_nlink) != (info.st_dev, info.st_ino, info.st_mode, info.st_uid,
                                             info.st_size, info.st_nlink):
                    _refuse('Compatibility library changed during inspection')
                digest, count = hashlib.sha256(), 0
                while chunk := stream.read(1024 * 1024):
                    digest.update(chunk)
                    count += len(chunk)
                    if count > info.st_size:
                        _refuse('Compatibility library changed during inspection')
                after = os.fstat(stream.fileno())
                if (count != info.st_size or after.st_mtime_ns != opened.st_mtime_ns
                        or after.st_ctime_ns != opened.st_ctime_ns):
                    _refuse('Compatibility library changed during inspection')
            files[name] = {'size': count, 'sha256': digest.hexdigest()}
        after = os.fstat(descriptor)
        if (sorted(os.listdir(descriptor)) != names or before.st_mtime_ns != after.st_mtime_ns
                or before.st_ctime_ns != after.st_ctime_ns):
            _refuse('Compatibility directory changed during inspection')
        _entries(files, symlinks)
        available = []
        for path in LIBRARY_DIRECTORIES:
            try:
                fd, ancestors = _directory_fd(root, path)
            except FileNotFoundError:
                continue
            else:
                os.close(fd)
                directories.update(ancestors)
                available.append(path)
        return {'version': 1, 'kind': 'cuda-compat-inventory-v1', 'directory': COMPAT_DIRECTORY,
                'package': package, 'directories': directories, 'files': files,
                'symlinks': symlinks, 'libraryDirectories': available}
    except OSError:
        _refuse('Trusted compatibility filesystem inventory unavailable')
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _ancestors(path):
    return {str(value) for value in [PurePosixPath(path), *PurePosixPath(path).parents]}


def validate_inventory(lock, inventory):
    """Pure comparison of reviewed lock and CPU/native filesystem evidence."""
    lock = validate_lock(lock)
    if (not isinstance(inventory, dict) or set(inventory) != {
            'version', 'kind', 'directory', 'package', 'directories', 'files', 'symlinks',
            'libraryDirectories'} or type(inventory['version']) is not int
            or inventory['version'] != 1 or inventory['kind'] != 'cuda-compat-inventory-v1'
            or inventory['directory'] != COMPAT_DIRECTORY):
        _refuse('Fixed compatibility inventory required')
    if (_package(inventory['package']) != lock['package'] or inventory['files'] != lock['files']
            or inventory['symlinks'] != lock['symlinks']):
        _refuse('Compatibility inventory differs from reviewed manifest')
    available = inventory['libraryDirectories']
    if (not isinstance(available, list) or any(type(item) is not str for item in available)
            or available != [item for item in LIBRARY_DIRECTORIES if item in available]):
        _refuse('Only fixed reviewed CUDA loader directories are permitted')
    expected = _ancestors(COMPAT_DIRECTORY)
    for path in available:
        expected.update(_ancestors(path))
    directories = inventory['directories']
    if not isinstance(directories, dict) or set(directories) != expected:
        _refuse('Complete fixed CUDA ancestor inventory required')
    for value in directories.values():
        if (not isinstance(value, dict) or set(value) != {'uid', 'mode', 'kind'}
                or type(value['uid']) is not int or value['uid'] != 0
                or type(value['mode']) is not int or not 0 <= value['mode'] <= 0o777
                or value['mode'] & 0o022 or value['kind'] != 'directory'):
            _refuse('Root-owned non-writable CUDA directory required')
    return True


def trusted_library_path(lock, inventory):
    """Return a new fixed value; inherited loader paths are never consulted."""
    validate_inventory(lock, inventory)
    return ':'.join([COMPAT_DIRECTORY, *inventory['libraryDirectories']])


def verify_compatibility(lock):
    """Live filesystem/package verification; caller pins the lock in source."""
    validate_lock(lock)  # A missing lock must refuse before any filesystem read.
    inventory = build_inventory(query_package_identity())
    return trusted_library_path(lock, inventory)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inventory', action='store_true', required=True)
    parser.parse_args()
    print(json.dumps(build_inventory(query_package_identity()), sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except CompatibilityRefused as error:
        raise SystemExit(str(error))
