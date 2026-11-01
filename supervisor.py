"""In-Pod automatic STOP; model process has no control-plane credential.

Only local preparation is performed by authoring/importing this file. Running its
main function is for a separately authorized, billable Runpod deployment.
"""
import ctypes
import datetime as dt
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

import start
import watchdog

UID = GID = 10001
MODEL_ENV_KEYS = {
    "PATH", "LD_LIBRARY_PATH", "CUDA_HOME", "CUDA_VISIBLE_DEVICES",
    "NVIDIA_VISIBLE_DEVICES", "NVIDIA_DRIVER_CAPABILITIES", "VLLM_API_KEY",
}


def prepare_runtime_filesystem(root=Path("/")):
    """Root-only boot setup, avoiding unpacking CUDA layers during image build."""
    for relative in ("cache", "home/inference"):
        directory = root / relative
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chown(directory, UID, GID)
        os.chmod(directory, 0o700)
    # Numeric IDs are sufficient for setuid, but libraries can also look up the
    # username/home through NSS. Preserve every base-image account and group.
    for relative, number, entry in (
        ("etc/group", GID, "inference:x:10001:"),
        ("etc/passwd", UID, "inference:x:10001:10001:Inference:/home/inference:/usr/sbin/nologin"),
    ):
        path = root / relative
        content = path.read_text()
        if not any(len(parts := line.split(":")) > 2 and parts[2] == str(number)
                   for line in content.splitlines()):
            with path.open("a") as stream:
                stream.write(("" if content.endswith("\n") else "\n") + entry + "\n")


def child_environment(source):
    # Allowlist, not a growing blacklist: unknown/cloud secrets never propagate.
    result = {key: source[key] for key in MODEL_ENV_KEYS if key in source}
    result.update({
        "HOME": "/home/inference", "PYTHONPATH": "/opt/qwen", "HF_HOME": "/cache/huggingface",
        "HF_HUB_DISABLE_TELEMETRY": "1", "DO_NOT_TRACK": "1", "VLLM_NO_USAGE_STATS": "1",
        "VLLM_LOGGING_LEVEL": "WARNING", "TOKENIZERS_PARALLELISM": "false",
    })
    start.validate_environment(result)
    return result


def drop_privileges():
    """Linux child only: discard supplementary groups/root and forbid regaining it."""
    os.setgroups([])
    os.setgid(GID)
    os.setuid(UID)
    # PR_SET_NO_NEW_PRIVS prevents setuid executables from regaining privilege.
    if ctypes.CDLL(None, use_errno=True).prctl(38, 1, 0, 0, 0) != 0:
        raise OSError("Unable to set no_new_privs")


def bind_self(client, pod_id, expected_image):
    if not re.fullmatch(r"[A-Za-z0-9_-]+", pod_id):
        raise ValueError("RUNPOD_POD_ID must be supplied by Runpod")
    pod = client.get(pod_id)
    if pod.get("id") != pod_id:
        raise ValueError("Returned Pod does not match this container's Pod ID")
    return watchdog.make_state(pod, expected_image)


def stop_child(child):
    if child is None or child.poll() is not None:
        return
    child.terminate()
    try:
        child.wait(timeout=10)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()


def run_loop(client, state, launch, now=time.time, sleep=time.sleep, stopping=lambda: False):
    """Start inference only with an armed timer; STOP on expiry or model failure."""
    child = None
    wall_start, mono_start = now(), time.monotonic()
    stop_requested = False
    try:
        while True:
            # A backwards wall-clock jump during this container run cannot extend
            # the timer; container restarts rebind to immutable provider createdAt.
            current = max(now(), wall_start + time.monotonic() - mono_start)
            expired = current >= state["deadline"]
            failed = child is not None and child.poll() is not None
            stop_requested = stop_requested or expired or failed or stopping()
            try:
                if stop_requested:
                    stop_child(child)
                    status = watchdog.stop_bound_pod(client, state)
                else:
                    status = watchdog.tick(client, state, current)
                if status == "stopped_verified":
                    print("Pod stop verified", flush=True)
                    return
                if not stop_requested and child is None and status == "armed":
                    # The guard is bound before any model code is started.
                    print("Timer armed; deadline UTC: " + dt.datetime.fromtimestamp(
                        state["deadline"], dt.timezone.utc).isoformat(), flush=True)
                    child = launch()
            except (OSError, ValueError, KeyError) as exc:
                # Never dump API responses, request headers, or environment values.
                print("Supervisor failure (" + type(exc).__name__ + "); retrying", file=sys.stderr, flush=True)
                # Unexpected policy/launch errors stop inference and request STOP.
                stop_requested = True
            sleep(5 if stop_requested else 15)
    finally:
        stop_child(child)


def main():
    if os.geteuid() != 0:
        raise ValueError("The supervisor requires root; inference is launched as UID 10001")
    env = child_environment(os.environ)
    # Keep control credential only in root's client object, never child's env.
    client = watchdog.Client(key=os.environ.pop("RUNPOD_API_KEY", ""))
    pod_id = os.environ.pop("RUNPOD_POD_ID", "")
    expected_image = os.environ.pop("EXPECTED_IMAGE", "")
    requested = [False]
    def handle_signal(signum, frame):
        requested[0] = True
    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)
    state = None
    while state is None:
        try:
            state = bind_self(client, pod_id, expected_image)
        except (OSError, ValueError, KeyError):
            print("Unable to arm timer; inference withheld; retrying", file=sys.stderr, flush=True)
            time.sleep(5)
    def launch():
        prepare_runtime_filesystem()
        return subprocess.Popen(
            [sys.executable, "/opt/qwen/start.py"], env=env, cwd="/opt/qwen",
            preexec_fn=drop_privileges, close_fds=True,
        )
    run_loop(client, state, launch, stopping=lambda: requested[0])


if __name__ == "__main__":
    main()
