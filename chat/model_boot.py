"""Sanitized GPU/user receipt from the unprivileged inference child, before weights."""
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import credential_boundary as boundary
import network_boundary
import offline_cache


def main():
    receipt = boundary.verify_child()  # Before torch, model, tokenizer or weights.
    receipt["network_boundary"] = network_boundary.install()
    model_path = offline_cache.verify_cache()
    import torch
    if os.getuid() != 10001 or os.getgid() != 10001 or not torch.cuda.is_available():
        raise ValueError("Expected unprivileged CUDA inference runtime")
    properties = torch.cuda.get_device_properties(0)
    print("CHAT_RUNTIME " + json.dumps({"uid": os.getuid(), "gid": os.getgid(),
          "gpu": torch.cuda.get_device_name(0), "vram_bytes": properties.total_memory,
          "control_key_present": False, "credential_boundary": receipt}), flush=True)
    # Official async serving requires named ZMQ IPC. The synchronous in-process
    # path avoids it; the inherited kernel policy still refuses any hidden use.
    import chat_server
    chat_server.serve(model_path)


if __name__ == "__main__":
    main()
