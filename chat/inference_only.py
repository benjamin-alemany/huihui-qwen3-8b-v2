"""Candidate inference-only boot. No provider API client or billing credential.

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
    if not created <= current < deadline or not 0 < deadline - created <= 30 * 60:
        raise ValueError("Only an unexpired session of at most thirty minutes is allowed")
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
    boundary.prepare_filesystem()
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


if __name__ == "__main__":
    main()
