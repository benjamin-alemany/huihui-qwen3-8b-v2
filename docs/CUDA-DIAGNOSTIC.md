# CUDA compatibility diagnostic — prepared, not a launch approval

The offline candidate reached `torch.cuda.is_available()` under the intended
Runpod restrictions and failed with CUDA error 304, before model loading or
HTTP serving. The operator stopped/deleted the disposable Pod and restored both
cloud guards to keyless standby. There was no second attempt or protection downgrade.
The exact failing syscall is not known. This document contains no account IDs,
Pod IDs, keys, live deployment receipts or private cumulative budget figures.

## Findings and limits

NVIDIA defines 304 as an operating-system-call failure, not an OOM or model-load
error. A firsthand trace on NVIDIA's forum shows `cuInit()` using an abstract
AF_UNIX SOCK_SEQPACKET socket. Our unchanged policy denies every AF_UNIX socket
and every `connect()`, so that is a plausible compatibility conflict, not a
confirmed diagnosis of our driver. Source:
https://forums.developer.nvidia.com/t/failure-when-using-openacc-after-mpi-init/176124
and the CUDA error definitions:
https://docs.nvidia.com/cuda/cuda-driver-api/cuda_driver_api/group__CUDA__TYPES.html

Do not copy a fix from an issue title: NVIDIA/OpenShell issue 1696 initially
blamed `memfd_create`, but its maintainer follow-up attributed the fix to GPU
procfs access while retaining the memfd block. Our own policy does not block
`memfd_create`; the provider's outer policy remains another possible layer.
https://github.com/NVIDIA/OpenShell/issues/1696

The new probe checks fixed device-node and proc metadata accessibility and the
CUDA driver's numeric version/init/device-count codes. The observer reports
socket, socketpair, connect and memfd outcomes/errno. It never records address
bytes, paths supplied to those syscalls, memfd names, environment, request bodies,
keys, file contents or arbitrary error strings. It emits at most 128 observations
plus one truncation marker. No ptrace, new capabilities, privileged mode or network
exception is needed. Missing credential/network/audit prerequisites refuse startup.

This is **not a complete syscall trace**: direct syscalls, hidden symbols, ioctl
and other unwrapped operations are not observed. A denial in the log is a lead,
not proof it is fatal; CUDA may intentionally tolerate some denials. An empty log
does not establish that the kernel allowed everything. No workaround is applied.

## Prepared image and enforcement

`chat/Dockerfile.cuda-diagnostic` reuses the pinned CUDA/vLLM base of the failed
offline image without downloading or copying weights. Its fixed entrypoint,
clean exec, timer, UID/GID 10001, environment allowlist, closed inherited
descriptors, empty capabilities and network policy are the existing source files.
The only child is `cuda_diagnostic.py`, placed at the launcher's fixed child path.
It never imports torch, vLLM, a tokenizer, model code or the HTTP server. Only the
native CUDA driver initialization/device enumeration is checked. A successful
result would not validate NCCL, full-model startup or chat.

For this diagnostic only, compile the reviewed observer together with the existing
loopback shim into the same fixed trusted preload pathname. The environment
allowlist and production serving image remain unchanged. The observer forwards
the same syscalls; the existing kernel policy still decides whether they succeed.
The new image and shared-library bytes would require an exact artifact review
before any separately approved GPU test. The diagnostic image has now been published and its exact bytes reviewed on a
separate free CPU runner; see `CUDA-DIAGNOSTIC-IMAGE.json`. This does not approve
a GPU run or validate CUDA on Runpod.

```sh
# Linux x86_64 preparation, not a GPU launch or registry publication:
cc -shared -fPIC -O2 -Wall -Wextra -Werror \
  -Wl,-z,relro,-z,now,-z,noexecstack \
  chat/loopback_ifaddrs.c chat/cuda_syscall_audit.c \
  -o chat/diagnostic-loopback_ifaddrs.so
docker build --platform linux/amd64 -f chat/Dockerfile.cuda-diagnostic \
  -t qwen-cuda-diagnostic:review chat
```

Do not mount executable projects, credentials or persistent storage. A future Pod
must have no exposed ports, no SSH/Jupyter, no supplied billing key, only a dummy
inference value required by the existing supervisor, and independently verified
cloud stop guards. Obtain a fresh complete compute/disk/cold-start quote and
explicit paid approval first. Prior allowances are not reset or reused silently.

## Free verification

Portable regression tests include failure before CUDA if credential checks,
network installation or the fixed audit library are missing; CUDA 304 stops before
device enumeration; no command override or serving/model import is supported.
The existing OS-isolated inference suite includes these tests.

The manual public-repository CPU workflow uses only a standard Ubuntu runner,
read-only repository permission and dummy data: no cloud keys, model/image pull,
GPU, publication, artifacts, caches or paid runner. Dispatch the existing
`chat-boundary-cpu.yml` on the review branch with `cuda_diagnostic_only=true` to
run only the new reusable observer fixture. Its fake `libcuda.so.1` deliberately
attempts AF_UNIX and returns 304 on EPERM. The real kernel must still reject
named UNIX, Internet datagrams and all connect calls, allow anonymous STREAM
pairs, preserve errno, bound logs and exclude a dummy secret canary. Fake CUDA
success/failure is never evidence about a Runpod GPU. The fake library is not in
the diagnostic image recipe.

Verification passed on source `6d98cb4` in
[CPU run 42823466926](https://github.com/benjamin-alemany/huihui-qwen3-8b-v2/actions/runs/42823466926).
The local network-isolated inference suite passed all 37 tests. Exact source
hashes of the five unchanged launcher/boundary files and the limited verification
claims are recorded in `CUDA-DIAGNOSTIC-CPU.json`. The recipe's strict context
allowlist excludes cached weights, dummy-driver libraries and unrelated files.

If CUDA truly requires an operation that cannot be allowed safely, move egress/IPC
enforcement to a separately verified host/VM boundary. Do not initialize CUDA
unrestricted then pass open sockets to the model or silently enable agent tools.

## Exact-image review

The built diagnostic is 9.21 GB compressed and 23.40 GB uncompressed. Its exact
published source/observer hashes, amd64 entrypoint, protected ownership and absent
model cache passed readback. The protected CPU boot discarded a dummy control
key, reached UID 10001 with zero child capabilities, installed the unchanged
network policy and refused GPU serving without a GPU. The first fixture omitted
CHOWN/FOWNER needed by the trusted root directory setup; the corrected fixture
allows those ordinary bootstrap capabilities only before the existing child
privilege drop. No image bytes or child/network protections were changed to
make that fixture pass. Rechecking the same digest avoided another publication.

[Exact-artifact review 42850263624](https://github.com/benjamin-alemany/huihui-qwen3-8b-v2/actions/runs/42850263624) passed.
The serving release pin stays null, agent tools stay disabled, and intended
Runpod/CUDA validation remains unverified.

## Smaller driver-only follow-up

The large diagnostic can consume the entire fixed deadline extracting its unused serving libraries before the container starts. `Dockerfile.cuda-driver-probe` instead pins the official NVIDIA CUDA 13.0 Ubuntu 24.04 amd64 base by digest, adds only distro Python/libseccomp, and uses the unchanged launcher, credential boundary, network policy and numeric observer. An allowlisted build context excludes weights, fake CUDA libraries, projects and secrets. CPU verification requires size below 1 GiB, protected source hashes, key discard, UID/capability checks and network enforcement before publication. Distro package versions are recorded in the artifact and CI log; package acquisition is restricted to the signed base distribution repositories during the free build.

NVIDIA documents driver library injection via the compute capability in its [Container Toolkit guide](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/docker-specialized.html). This probe uses the host driver API directly; it does not require Torch, vLLM or model weights. Its base and Python patch version differ from the serving image, so a result is a driver-only diagnostic, never full-serving acceptance. The serving release pin and all kernel restrictions remain unchanged. No GPU launch is part of the manual free build workflow.
