"""Pod stop control logic, used by the root supervisor or an external backup.

No network activity on import. `arm` only reads Runpod. `watch` issues STOP,
never creates, restarts, or deletes a Pod. Deployment is deliberately separate.
"""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.request

HOURS = 10
API = "https://api.runpod.io/v2"
NAME = "huihui-qwen3-8b-v2-10h"


def timestamp(value):
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("A timezone-aware creation timestamp is required")
    return parsed.timestamp()


class Client:
    def __init__(self, key=None):
        self.key = os.environ.get("RUNPOD_API_KEY", "") if key is None else key
        if not self.key:
            raise ValueError("A dedicated Pod control credential is required by the supervisor")

    def call(self, pod_id, action=False):
        if not re.fullmatch(r"[A-Za-z0-9_-]+", pod_id):
            raise ValueError("Invalid Pod ID")
        url = f"{API}/pods/{pod_id}" + ("/action" if action else "")
        req = urllib.request.Request(url,
            data=b'{"action":"stop"}' if action else None,
            headers={"Authorization": "Bearer " + self.key, "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as response:
            return json.load(response)

    def get(self, pod_id):
        return self.call(pod_id)

    def stop(self, pod_id):
        return self.call(pod_id, action=True)


def identity(pod, state):
    if any(pod.get(k) != state[k] for k in ("id", "name", "image", "createdAt")):
        raise ValueError("Pod identity changed; refusing to operate on it")


def make_state(pod, expected_image):
    if not re.fullmatch(r"[A-Za-z0-9./_:-]+@sha256:[a-f0-9]{64}", expected_image):
        raise ValueError("Supply the published custom image pinned to its SHA256 digest")
    gpu = pod.get("gpu", {})
    if (pod.get("name") != NAME or pod.get("image") != expected_image
            or pod.get("cloud") != "SECURE"
            or gpu.get("id") != "NVIDIA GeForce RTX 4090" or gpu.get("count") != 1
            or pod.get("locked")):
        raise ValueError("Pod does not match the approved deployment")
    state = {k: pod[k] for k in ("id", "name", "image", "createdAt")}
    state["deadline"] = timestamp(pod["createdAt"]) + HOURS * 3600
    return state


def validate_state(state):
    # Recompute from immutable provider creation time; restart never extends it.
    if state["deadline"] != timestamp(state["createdAt"]) + HOURS * 3600:
        raise ValueError("Deadline must be exactly ten hours after creation")


def tick(client, state, now):
    validate_state(state)
    pod = client.get(state["id"])
    identity(pod, state)
    if pod["status"] == "EXITED":
        return "stopped_verified"
    if now < state["deadline"]:
        return "armed"
    return stop_bound_pod(client, state, pod)


def stop_bound_pod(client, state, pod=None):
    """Stop only this bound Pod, including on early inference failure."""
    validate_state(state)
    if pod is None:
        pod = client.get(state["id"])
    identity(pod, state)
    if pod["status"] == "EXITED":
        return "stopped_verified"
    if pod.get("locked"):
        raise ValueError("Pod is locked; cannot stop. Operator action required")
    if "stop" not in pod.get("actions", []):
        raise ValueError("STOP is unavailable; operator action required")
    client.stop(state["id"])
    # A POST response alone is not stop verification. Fresh GET must confirm.
    current = client.get(state["id"])
    identity(current, state)
    return "stopped_verified" if current["status"] == "EXITED" else "stop_requested_retrying"


def save_state(path, state):
    path.parent.mkdir(parents=True, exist_ok=True)
    # O_EXCL prevents accidentally replacing an existing deadline/Pod binding.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(state, stream, indent=2)
        stream.flush()
        os.fsync(stream.fileno())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, required=True)
    sub = parser.add_subparsers(dest="command", required=True)
    arm = sub.add_parser("arm", help="GET only; bind this new Pod to its fixed deadline")
    arm.add_argument("--pod-id", required=True)
    arm.add_argument("--image", required=True)
    sub.add_parser("watch", help="Poll and STOP this bound Pod at its deadline")
    args = parser.parse_args()
    client = Client()
    if args.command == "arm":
        state = make_state(client.get(args.pod_id), args.image)
        save_state(args.state, state)
        print("Armed; deadline UTC:", dt.datetime.fromtimestamp(state["deadline"], dt.timezone.utc).isoformat())
        return
    state = json.loads(args.state.read_text())
    validate_state(state)
    previous = None
    while True:
        try:
            status = tick(client, state, time.time())
            if status != previous:
                print(status, flush=True)
                previous = status
        except urllib.error.HTTPError as exc:
            # Do not log response bodies or environment/credentials.
            print(f"Control-plane HTTP {exc.code}; retrying", file=sys.stderr, flush=True)
        except (urllib.error.URLError, TimeoutError, OSError):
            print("Control-plane connection failed; retrying", file=sys.stderr, flush=True)
        # Keep supervising even after EXITED; resuming cannot reset the deadline.
        time.sleep(15)


if __name__ == "__main__":
    main()
