"""Sanitized GPU/user receipt from the unprivileged inference child, before weights."""
import json
import os
from pathlib import Path
import runpy
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import credential_boundary as boundary
import network_boundary


def main():
    receipt = boundary.verify_child()  # Before torch, model, tokenizer or weights.
    receipt["network_boundary"] = network_boundary.install()
    import torch
    if os.getuid() != 10001 or os.getgid() != 10001 or not torch.cuda.is_available():
        raise ValueError("Expected unprivileged CUDA inference runtime")
    properties = torch.cuda.get_device_properties(0)
    print("CHAT_RUNTIME " + json.dumps({"uid": os.getuid(), "gid": os.getgid(),
          "gpu": torch.cuda.get_device_name(0), "vram_bytes": properties.total_memory,
          "control_key_present": False, "credential_boundary": receipt}), flush=True)
    runpy.run_path("/opt/qwen/start.py", run_name="__main__")


if __name__ == "__main__":
    main()
