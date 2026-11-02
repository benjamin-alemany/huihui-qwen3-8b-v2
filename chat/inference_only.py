"""Candidate inference-only boot. No provider API client or billing credential.

Not launched or GPU-tested. Trusted cloud stop reservations must be armed and
verified before Pod creation. The local timer stops inference, not GPU billing.
"""
import datetime as dt
import os
import signal
import subprocess
import sys
import time

import supervisor


def deadline_from(env, now=None):
    forbidden = [name for name, value in env.items() if value and name != "VLLM_API_KEY"
                 and any(part in name for part in ("API_KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL"))
                 and name not in {"TOKENIZERS_PARALLELISM", "HF_HUB_DISABLE_IMPLICIT_TOKEN"}]
    if forbidden:
        raise ValueError("Control or other credentials are forbidden in the inference Pod")
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
    supervisor.child_environment(env)  # Existing model key and environment checks.
    return deadline


def main():
    if os.geteuid() != 0:
        raise ValueError("Trusted boot requires root before dropping model privileges")
    deadline = deadline_from(os.environ)
    model_env = supervisor.child_environment(os.environ)
    supervisor.prepare_runtime_filesystem()
    requested = [False]
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: requested.__setitem__(0, True))
    wall, mono = time.time(), time.monotonic()
    child = None
    try:
        child = subprocess.Popen([sys.executable, "/opt/qwen/model_boot.py"],env=model_env,cwd="/opt/qwen",
                                 preexec_fn=supervisor.drop_privileges,close_fds=True)
        # Child failure stops this boot; it never starts another model in this loop.
        while child.poll() is None and not requested[0] and max(time.time(), wall + time.monotonic()-mono) < deadline:
            time.sleep(1)
    finally:
        supervisor.stop_child(child)


if __name__ == "__main__":
    main()
