"""VM-only candidate inference boot; pre-baked NSS and read-only root. No provider API client or billing credential.

Not launched or GPU-tested. Trusted cloud stop reservations must be armed and
verified before Pod creation. The local timer stops inference, not GPU billing.
"""
import datetime as dt
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import credential_boundary as boundary
import start
import stat
import attestation


def deadline_from(env, now=None):
    boundary.check_names(env)
    if env.get("CHAT_CLOUD_GUARDS_VERIFIED") != "true":
        raise ValueError("External cloud stop reservations must be verified before launch")
    try:
        created_text, deadline_text = env["CHAT_RESERVED_AT"], env["CHAT_DEADLINE_UTC"]
        if not created_text.endswith("Z") or not deadline_text.endswith("Z"):
            raise ValueError()
        created = dt.datetime.fromisoformat(created_text.replace("Z", "+00:00")).timestamp()
        deadline = dt.datetime.fromisoformat(deadline_text.replace("Z", "+00:00")).timestamp()
    except (KeyError, TypeError, ValueError):
        raise ValueError("Valid immutable UTC creation and deadline timestamps are required") from None
    current = time.time() if now is None else now
    if not created <= current < deadline or not 0 < deadline - created <= 60 * 60:
        raise ValueError("Only an unexpired session of at most sixty minutes is allowed")
    start.validate_environment(env)
    return deadline


def main():
    boundary.assert_clean_boot()
    deadline = deadline_from(os.environ)
    model_env = boundary.model_environment(os.environ)
    # Fixed trusted compatibility code, never inherited/caller-selected. It only
    # reports loopback interface metadata; kernel network restrictions stay on.
    model_env['LD_PRELOAD'] = '/opt/qwen/loopback_ifaddrs.so'
    model_env['GLOO_SOCKET_IFNAME'] = 'lo'
    # This VM layer is baked before read-only runtime. No CHOWN/FOWNER needed.
    for name in ('/cache','/home/inference'):
        p=Path(name);info=p.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or info.st_uid!=boundary.UID or info.st_gid!=boundary.GID or info.st_mode&0o077:
            raise ValueError('Private runtime tmpfs was not prepared correctly')
    if not os.statvfs('/').f_flag&os.ST_RDONLY:
        raise ValueError('Read-only container root required')
    if os.getuid()!=0 or not any(line.startswith('inference:x:10001:10001:') for line in Path('/etc/passwd').read_text().splitlines()):
        raise ValueError('Dedicated inference identity must be baked into image')
    # Native GPU runtime hooks execute before PID1, and may inject mounts that
    # Docker's declared .Mounts omits. No unprivileged child exists until the
    # trusted host has inspected the actual runtime and sealed its receipt.
    attestation.wait_for_receipt(os.environ['CHAT_RESERVED_AT'],os.environ['CHAT_DEADLINE_UTC'])
    requested = [False]
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: requested.__setitem__(0, True))
    wall, mono = time.time(), time.monotonic()
    child = None
    try:
        child = subprocess.Popen([sys.executable, "-I", "-B", "/opt/qwen/model_boot.py"],env=model_env,cwd="/opt/qwen",
                                 preexec_fn=boundary.drop_privileges,close_fds=True,stdin=subprocess.DEVNULL)
        # Child failure stops this boot; it never starts another model in this loop.
        while child.poll() is None and not requested[0] and max(time.time(), wall + time.monotonic()-mono) < deadline:
            time.sleep(1)
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()

    if child is not None and child.returncode:
        raise ValueError("Inference child refused; no retry")

if __name__ == "__main__":
    main()
