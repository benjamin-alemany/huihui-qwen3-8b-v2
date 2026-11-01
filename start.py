"""Fixed inference configuration. No provisioning or control-plane credentials."""
import os
import sys

MODEL = "huihui-ai/Huihui-Qwen3-8B-abliterated-v2"
REVISION = "7d89db76029281fd8f3e6698a8e30738608105a9"


def arguments():
    return [
        "vllm", "serve", MODEL,
        "--revision", REVISION, "--tokenizer-revision", REVISION,
        "--served-model-name", "huihui-qwen3-8b-v2",
        "--load-format", "safetensors", "--no-trust-remote-code",
        "--no-trust-request-chat-template", "--dtype", "bfloat16",
        "--max-model-len", "4096", "--max-num-seqs", "1",
        "--gpu-memory-utilization", "0.90", "--enforce-eager",
        "--host", "0.0.0.0", "--port", "8000",
        "--no-enable-log-requests", "--no-enable-log-outputs",
        "--disable-fastapi-docs", "--disable-uvicorn-access-log",
        "--middleware", "secure_middleware.BearerGate",
    ]


def validate_environment(env):
    key = env.get("VLLM_API_KEY", "")
    if len(key) < 32 or key.startswith("__"):
        raise ValueError("Set a fresh random VLLM_API_KEY of at least 32 characters")
    if any(env.get(k) for k in ("RUNPOD_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "HF_TOKEN")):
        raise ValueError("Control-plane/cloud credentials must stay outside the inference Pod")


if __name__ == "__main__":
    try:
        validate_environment(os.environ)
    except ValueError as exc:
        sys.exit(str(exc))
    os.execvp("vllm", arguments())
