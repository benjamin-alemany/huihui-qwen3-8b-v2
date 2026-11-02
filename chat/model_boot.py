"""Sanitized GPU/user receipt from the unprivileged inference child, before weights."""
import json
import os
import runpy


def main():
    import torch
    if os.getuid() != 10001 or os.getgid() != 10001 or not torch.cuda.is_available():
        raise ValueError("Expected unprivileged CUDA inference runtime")
    forbidden = any(value and any(part in name for part in ("RUNPOD_API_KEY", "CLOUDFLARE_API_TOKEN", "AWS_SECRET_ACCESS_KEY", "HF_TOKEN"))
                    for name, value in os.environ.items())
    if forbidden:
        raise ValueError("Unexpected control credential in inference child")
    properties = torch.cuda.get_device_properties(0)
    print("CHAT_RUNTIME " + json.dumps({"uid": os.getuid(), "gid": os.getgid(),
          "gpu": torch.cuda.get_device_name(0), "vram_bytes": properties.total_memory,
          "control_key_present": False}), flush=True)
    runpy.run_path("/opt/qwen/start.py", run_name="__main__")


if __name__ == "__main__":
    main()
