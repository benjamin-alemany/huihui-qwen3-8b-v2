"""Candidate prepared-host entrypoint; verify CUDA libraries before clean exec.

This adds no model permit or GPU claim. The existing credential bootstrap and
VM supervisor still enforce native attestation, CUDA preflight, provider firewall
permission, privilege separation and immutable expiry. Both existing children
inherit the same fixed, verified loader path through boundary.model_environment.
"""
import json
import os
from pathlib import Path
import stat
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import credential_boundary as boundary
import cuda_compat

SOURCE_IMAGE = 'vllm/vllm-openai@sha256:6ee133356d49ed24cee03dd0cda3d3980279a11c107ce3e752c89e76540f41c9'
LOCK_SHA256 = '26ade5e7f4a83f68f06c977aed5f33b5f361bf6002458340548d6100dec45161'
LOCK_PATH = HERE / 'cuda-compat.lock.json'
NEXT_STAGE = HERE / 'credential_boot.py'


def refused():
    raise ValueError('Prepared compatibility bootstrap refused; no model started')


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            refused()
        result[key] = value
    return result


def reviewed_lock(raw):
    if not isinstance(raw, bytes) or not 0 < len(raw) <= 65536:
        refused()
    try:
        lock = json.loads(raw.decode('ascii'), object_pairs_hook=_unique,
                          parse_constant=lambda _: refused())
        cuda_compat.validate_lock(lock)
        if lock['sourceImage'] != SOURCE_IMAGE or cuda_compat.lock_digest(lock) != LOCK_SHA256:
            refused()
    except Exception:
        refused()
    return lock


def prepare_environment(source, lock_bytes, *, verifier=None):
    """Pure preparation plus injectable library verification; never mutate env.

    The real verifier reads the immutable image's package/library identity.
    Test injection exercises fail-closed behavior without loading a driver.
    """
    clean = boundary.boot_environment(source)
    clean.pop('LD_LIBRARY_PATH', None)
    lock = reviewed_lock(lock_bytes)
    value = (verifier or cuda_compat.verify_compatibility)(lock)
    if not isinstance(value, str):
        refused()
    pieces = value.split(':')
    if (pieces[0] != cuda_compat.COMPAT_DIRECTORY
            or pieces[1:] != [name for name in cuda_compat.LIBRARY_DIRECTORIES if name in pieces[1:]]):
        refused()
    clean['LD_LIBRARY_PATH'] = value
    return clean


def read_lock():
    info = LOCK_PATH.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022
            or info.st_mode & 0o7000 or not 0 < info.st_size <= 65536):
        refused()
    raw = LOCK_PATH.read_bytes()
    if len(raw) != info.st_size:
        refused()
    return raw


def main():
    if os.geteuid() != 0 or sys.argv[1:]:
        refused()
    boundary.protect_process()
    boundary.assert_trusted_application(HERE)
    if not os.statvfs('/').f_flag & os.ST_RDONLY:
        refused()
    clean = prepare_environment(os.environ, read_lock())
    boundary.close_inherited_fds()
    # The fixed original stage discards credentials again and performs its own
    # fresh exec. No caller command, path, model or compatibility flag is used.
    os.execve(sys.executable,
              [sys.executable, '-I', '-S', '-B', str(NEXT_STAGE)], clean)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('Prepared compatibility bootstrap refused; no model started')
