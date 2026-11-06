# Chat compatibility and offline cache — 2026-11-06

## Source findings, not a GPU compatibility pass

Reviewed the pinned vLLM v0.32.0 source. Local-only engine input/output and
handshake paths can use ZMQ ipc:// endpoints. UniProcExecutor normally chooses
file rendezvous when the ROCm/AITER TCP-store special case is absent. However,
Torch/Gloo process-group initialization remains in the call graph, including a
CPU group. These facts do not prove that the full path runs without TCP.

The serving environment now sets fixed VLLM_HOST_IP and VLLM_LOOPBACK_IP values
of 127.0.0.1, avoiding address-discovery UDP socket probes that the kernel filter
correctly denies. VLLM_RPC_BASE_PATH is fixed to the private mode-0700 runtime
directory. No caller/model-supplied addresses or broad loopback exception are
accepted. Outbound TCP denial stays intact; exact GPU/runtime validation is still
required. No weights were downloaded or serving image published.

## UNIX sockets remain a release blocker

A private IPC directory is useful but is not a kernel-enforced restriction on
connecting to unrelated pathname/abstract UNIX sockets. The current network
candidate permits UNIX IPC; filesystem/control/proxy services could offer a route
around Internet-socket denial if reachable. No socket enumeration or userspace
monkeypatch is accepted as a durable boundary. Need an independently enforced IPC
boundary compatible with the runtime (or a separately costed execution platform).
If that boundary is unavailable, refuse launch; do not add privileges, expose
host sockets, or broaden the network policy to force success.

## Offline cache preparation

Fetched only public metadata for checkpoint revision
7d89db76029281fd8f3e6698a8e30738608105a9. model-manifest.json lists 14 required
flat files and 16,397,433,656 eventual bytes. No cache file contents/weights were
fetched. A later approved preparation must materialize these files, with root
ownership and no group/other writes or links, under /opt/qwen-model.

Before importing torch, model_boot verifies the fixed cache and trusted manifest:
pinned identity, exact file set, sizes, SHA-256 for LFS artifacts and Git blob
SHA-1 for ordinary files, ownership/modes, symlink/hardlink rejection, and bounded
shard references with no path traversal. Missing or changed files refuse startup.
Serving uses that fixed absolute path with offline flags, retaining Safetensors
and no-remote-code options. This pins file identity; it does not prove model trust.

Full-file hashing is part of startup and must be included in any later session
cost/startup-time quote. Storage placement, downloads, image publication and
persistence/idle charges still require separate approval; none are performed here.

## Sources

https://github.com/vllm-project/vllm/blob/v0.32.0/vllm/utils/network_utils.py
https://github.com/vllm-project/vllm/blob/v0.32.0/vllm/v1/executor/uniproc_executor.py
https://github.com/vllm-project/vllm/blob/v0.32.0/vllm/v1/engine/utils.py
https://github.com/vllm-project/vllm/blob/v0.32.0/vllm/distributed/parallel_state.py
https://huggingface.co/api/models/huihui-ai/Huihui-Qwen3-8B-abliterated-v2/revision/7d89db76029281fd8f3e6698a8e30738608105a9?blobs=true
