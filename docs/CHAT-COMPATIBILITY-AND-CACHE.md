# Chat compatibility and offline cache — 2026-11-06

## November 9 update — stricter single-process candidate

The earlier IPC design below is superseded. The candidate now runs the pinned
vLLM synchronous LLM/InprocClient with UniProcExecutor behind a bounded chat-only
HTTP adapter. It denies all connect() calls, all named/abstract UNIX socket
creation, non-STREAM socketpairs, alternate families, Internet datagrams/raw
sockets, descriptor theft syscalls and io_uring. Only anonymous connected UNIX
STREAM pairs and inbound TCP replies remain. No namespace or ABI-9 dependency,
socket allowlist, privileged mode or loopback TCP exception was introduced.

Actual CPU probing found Gloo's getifaddrs() uses a denied NETLINK_ROUTE socket.
The fixed loopback_ifaddrs.c compatibility library supplies only static IPv4
loopback metadata without opening sockets; it is not a security boundary. It has
no constructors, model inputs, environment lookups or file/network operations.
The root-owned library path and GLOO interface are fixed by the trusted launcher;
inherited preload settings are discarded. Kernel denials remain authoritative.
Standard descriptors carrying sockets refuse startup before model imports.

Free CPU verification passed: native socket denials and exec inheritance,
17 Linux credential cases, pinned Torch 2.13 CPU FileStore/Gloo single-rank groups
and collectives, and the existing serving image's Torch/Gloo/vLLM option/import
path under the same denials. Final Actions run 42736136833 also checked the
host-built library against that image. No model/CUDA initialization
occurred. This closes the demonstrated CPU transport failure; it does not prove
Runpod kernel, CUDA, NCCL or full Qwen startup compatibility.

The source release pin remains null. cache_materialize.py and Dockerfile.offline
prepare the exact cache and layer layout only after separate approval. Files are
downloaded with no credentials/proxies/retries, size/hash checked, copied as root
read-only files and rechecked at startup. Individual shard layers stay below
GHCR's 10 GB per-layer limit. GitHub's standard public runner and existing public
GHCR package are the intended free build/storage path; no paid runner, volume,
artifact/cache storage or laptop model download is part of the prepared workflow.
After explicit owner approval, the free workflow downloaded/published the cache.
The first image failed its permission check; its /opt/qwen-model directory had
mode 0444 in the actual OCI metadata. The corrected digest in OFFLINE-IMAGE.json
adds only root-owned 0555 directory metadata. A native dummy regression proves
the original refusal and corrected hash/read-only behavior. All original code
and model layers are identical. Run 42741842571 verifies the complete corrected
image as UID 10001, including all 14 file hashes and pinned runtime imports.
No GPU, model inference, production deployment or agent tool was started.

The bounded HTTP adapter has four connection slots, one generation at a time,
authenticated health/models routes that remain responsive during generation,
strict request framing/JSON/text limits, fixed model/settings and redacted errors.
It exposes no admin, tool, file, media, upload, streaming or template API.

The existing base is 23,403,875,856 uncompressed bytes. Adding the pinned cache
puts expected base-plus-cache near 39.8 GB before small application/runtime data;
retain the proposed 60 GB temporary Pod disk and verify final image size before
paid use. The final image still needs its own readback/cache/ownership checks.
CHAT-SCOPED-ADVISORIES.json records no OSV matches for the 16 explicit serving
packages read from the image. This is not a transitive/OS/CUDA audit, dependency
trust guarantee or model behavioral clearance. Review final artifact findings
before paid validation; never enable tools based on these checks.

The following sections record the earlier source-only investigation and explain
why the default asynchronous server was not retained.

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
