# Prepared VM inference boundary — not deployed or GPU verified

These credential-free artifacts prepare a dedicated Ubuntu 24.04 amd64 GPU VM.
They do not create a VM, call Hyperstack, start paid resources, load model weights,
or enable agent tools. Existing `chat/network_boundary.py` is unchanged. The VM
profile is a different candidate boundary and must never be silently selected in
a Runpod image. Root will wire the immutable serving image and provider controller
after this review and the separate target validation gate.

## Trust and package provenance

`packages.lock.json` pins R580 **580.196.07-1ubuntu1** compute-only open DKMS,
Docker Engine/CLI **5:29.9.3-1~ubuntu.24.04~noble**, containerd
**2.4.2-3~ubuntu.24.04~noble**, NVIDIA Container Toolkit **1.20.2-1**, and their
selected NVIDIA components by exact version, architecture, size and SHA256.
The NVIDIA-signed repository also supplies the pinned DKMS build tool needed
by current R580 packages. No desktop driver, unversioned installer, curl-to-shell,
experimental toolkit repository, or automatic alternative driver is used.

Only small repository indexes, signed InRelease files and public signing keys
were read during preparation. All three signatures were checked with isolated
`gpgv`; the indexes were checked against their signed SHA256/SHA512 values and
package hashes copied from those verified indexes. No .deb payload was downloaded
or installed on the laptop. Bundled keyrings have pinned primary fingerprints:

- CUDA: EB693B3035CD5710E231E123A4B469963BF863CC
- Container Toolkit: C95B321B61E88C1809C4F759DDCAE044F796ECB0
- Docker: 9DC858229FC7DD38854AE2D88D81803C0EBFCD88

`metadata.py` rechecks the current signed index for exactly those package bytes;
missing versions, key rotation or changed bytes refuse installation. New unrelated
repository entries do not change the chosen versions. Signature checks establish
provenance, not that a dependency is free of vulnerabilities or behavioral risk.

The actual VM's running kernel is not known in this local checkout. Bootstrap
requires its exact `linux-headers-$(uname -r)` and records every target Ubuntu
APT dependency/version/SHA256 before downloading. Every downloaded .deb is checked
against that resolved lock before an installation using `--no-download`. New
vendor versions or unreviewed APT repositories refuse. This preserves an honest
kernel-specific dependency lock instead of inventing another machine's headers.
Pinned package holds require a separately reviewed update process later.

## Root-only immutable session contract

Copy reviewed source to `/opt/unjailed/vm` with root-owned non-writable parents.
A separately approved VM orchestrator supplies root:root mode 0600
`/etc/unjailed/session.json` with exact keys:

```
version: 1
sessionId: UUID
nonce: immutable 32-character lowercase hexadecimal session nonce
createdAt: immutable UTC timestamp from the cloud controller
deadlineUTC: immutable UTC expiry, at most 60 minutes after createdAt
image: reviewed immutable ghcr.io/benjamin-alemany/huihui-qwen3-8b-v2@sha256:...
resources: {vmId: positive integer or null, publicIpAddress: IP address or null, volumeIds: []}
```

No billing/provider token, backup key, executable project, tunnel token or model
inference key belongs in this manifest. The host bootstrap never needs a provider
API. Initial user-data is rendered before creation and must truthfully use null
VM/IP identifiers; their authoritative provider IDs and readback stay in the
Cloudflare allocation ledger. The immutable host manifest is not rewritten to
add those IDs, and the local deadline only uses the logical session UUID.
The controller's two independent external guards retain destroy authority;
Hyperstack's public IP is VM-coupled, with no independently verified IP-delete API.
External acceptance must verify VM absence and billing/resource activity rather
than claim an unsupported standalone IP readback.

`bootstrap.py --execute` is only for that separately approved root host. It
validates plain Ubuntu, refuses unsupported Secure Boot instead of disabling it,
arms an absolute persistent local deadline timer before package work, verifies
metadata, installs locked packages, then stores the original manifest hash and
reboot phase atomically. It requires a different boot ID before resuming the exact
R580 module/runtime checks. Expiry, manifest changes, clock rollback, interrupted
installation, wrong module/kernel/version or driver failure refuse model start.
It stops at `HOST_READY_MODEL_NOT_STARTED`; no model startup or retry is hidden in
package installation. The root orchestrator must separately verify the full image.

The local deadline stops only this session's exact container and powers off the
VM. **Powering off does not establish a billing stop.** Both cloud destroy guards
must remain armed through independently verified destruction. Neither reboot nor
operator retry grants a new deadline, resets spending or authorizes another VM.

## Sealed runtime candidate

`seal_boundary.py` checks/applies only the dedicated `inet unjailed` nft table;
it does not flush unrelated tables. Seal the host before starting any model.
`docker_arguments()` emits a read-only, no-new-privileges,
PID/memory/CPU-bounded container with private default PID/mount and explicit IPC
namespaces. There is no privileged flag, host namespace, published port, project
mount or Docker/containerd socket. Trusted image PID 1 may perform the reviewed
credential drop; the actual model still must pass UID 10001/capability/FD checks.

**Networking starts with `--network=none`, not a Docker bridge network.** Empty,
root-owned `/etc/resolv.conf` is mounted read-only. The trusted host may then
attach a dedicated veth to the verified owned container network namespace using
`attach_model_network.py` (or its fixed shell wrapper). The helper verifies the exact manifest/name/image/label, private runtime flags,
and process cgroup, then pins the namespace FD before attaching; PID reuse cannot
redirect it into the host namespace. It has fixed private addresses, no default route and
no Docker embedded DNS resolver. Model traffic to host services, DNS, link-local
metadata, IPv4 and IPv6 is denied by host nftables independently of model syscalls.
Only the separate host tunnel UID 10002 may connect to the model's port 8000,
Cloudflare Tunnel IPv4 TCP 7844 ranges (forced IPv4 HTTP/2), and the two declared DNS resolvers. The tunnel
service gets its own read-only resolver file to avoid a privileged host DNS proxy.
All IPv6 initiation remains denied; no broad ICMPv6 exception is needed.
Its reviewed binary, tunnel credential/config and model inference key are supplied
later by the root orchestrator; none is included here.

`inference_policy.py` is an additional unprivileged kernel boundary: outbound TCP
initiation is denied by Landlock; Internet datagrams/raw/alternate families,
io_uring, tracing/descriptor theft and namespace-entry APIs are denied. UNIX
STREAM/SEQPACKET are allowed **only because the external VM container namespaces
and host firewall isolate their peers**. It is not a filesystem or agent execution
sandbox. Required driver IPC, CUDA/NCCL, full model startup and Docker's built-in
seccomp/namespace behavior remain target tests. GPU-driver/kernel escapes remain
outside the assurance of these process rules; credentials/control services stay
outside the model container and billing credentials outside the VM entirely.

## Free verification and remaining gates

Portable dummy tests: `python3 -B vm/test_vm.py`. They check exact locks, tampered
metadata digests, manifest/secret rejection, reboot/expiry immutability, no auto
retry, Docker isolation arguments, external firewall shape and absolute timers.

`linux_fixture.sh` is a prepared adversarial CPU fixture for an approved standard
Linux CI runner with `ip`, `nft`, `setpriv`, Python and libseccomp available. It
creates isolated mount/PID/network namespaces before controlled dummy services;
there is no route to the runner's real Internet even if the fixture policy fails.
It first attacks the external nft boundary **without child seccomp**, including
IPv4/IPv6, host services, metadata, direct DNS and 127.0.0.11. Before sealing, positive controls prove IPv4/IPv6 routes, metadata and a fake
host DNS proxy actually work; after sealing, only the trusted tunnel UID reaches
controlled TCP/DNS endpoints, and the
controlled resolver must observe exactly that one query. It then separately tests
Landlock/TCP denial and local named/anonymous UNIX SEQPACKET inside the private
namespace. Missing namespace or firewall support is fatal; no unrestricted fallback.

The fixture has not yet run in this preparation pass. Root must review/publish
and run it on free CI. CPU success is not evidence that the chosen Hyperstack VM,
R580 DKMS, Docker/NVIDIA device injection or full Qwen serving works. No runtime
release pin is changed by any of these files. The first actual paid VM test must
repeat the adversarial checks on the exact target, then native CUDA, then the
full offline serving artifact, with both external destroy guards verified first.

Official references:
- https://docs.nvidia.com/datacenter/tesla/driver-installation-guide/kernel-modules.html
- https://docs.nvidia.com/datacenter/tesla/driver-installation-guide/version-locking.html
- https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html
- https://docs.docker.com/engine/install/ubuntu/
- https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/tunnel-with-firewall/

## VM serving layer and actual-Docker CPU fixture

`Dockerfile.inference` is a prepared overlay on the exact existing offline
`sha256:436f9088dac4df3b77e18c3dbf284bf736be85628385e187d2c41d28b43c37fa`
image; it reuses its model-weight/cache layers and does not fetch weights. Build
context is the repository root, using its Dockerfile-specific strict allowlist.
The overlay explicitly selects the VM-only network profile in `model_boot.py`;
there is no environment flag that makes the old Runpod boundary disappear.
Credential clean-exec, protected-parent/FD checks, pinned cache hashing before
Torch import, fixed in-process chat adapter and immutable local expiry remain.

The trusted root supervisor needs only SETUID and SETGID to discard groups and
start the sole UID10001 model child. It gets those two capabilities after an
ALL-capability drop. CHOWN/FOWNER are unnecessary: NSS identity is baked at build
and private tmpfs mounts are created by Docker already owned by10001/mode0700.
VM `boot.py` checks these mounts and a read-only root instead of trying to edit
`/etc/passwd`, chown directories or modify the image at runtime. The actual model
child must still report all effective/permitted/inheritable/ambient caps empty.
A failed child exits the supervisor; Docker restart policy is explicitly `no`.

`Dockerfile.cpu` and `docker_fixture.py` exercise this exact trusted bootstrap on
the existing small published driver-probe base, using tiny dummy cache bytes and
the real offline-cache verification function. It checks actual Docker private
PID/mount/network/IPC namespaces against the runner's namespace identities,
read-only root, private runtime directories, memory/CPU/PID limits, parent data
and inherited descriptor protection, missing control sockets, kernel network
policy, local SEQPACKET, and absence of an embedded resolver at127.0.0.11. A dummy
control credential is discarded and must never appear in either output stream.
It does not import Torch, CUDA, vLLM or a real checkpoint, or expose any port.

Run only on an approved free disposable Linux CPU runner:

```
python3 -B vm/test_vm.py
sudo -n env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin python3 -I -B vm/docker_fixture.py
sudo -n env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin bash vm/linux_fixture.sh
```

The separate manually dispatched `vm-boundary-cpu.yml` uses only standard free
public-repository CPU runners, with no caches, artifacts or publishing. Neither Docker fixture nor Linux host
fixture has run in this local preparation pass. Successful portable tests are
not a substitute for either of them, and neither is target Hyperstack proof.
The production serving overlay must itself be built/reviewed and its full
original cache verified before the separately approved target GPU acceptance.
The root orchestrator supplies a separately pinned cloudflared binary/config,
tunnel credential and inference-only environment; their selection is not hidden
in this bootstrap. Existing provider billing/destroy credentials stay off the VM.

### Mandatory native NVIDIA mount gate

The free CPU fixture does not run the NVIDIA Container Toolkit hook. A correct
Docker command is therefore insufficient to prove the GPU container has no host
IPC. Before a model child or CUDA import starts, target acceptance must inspect
the exact running Docker configuration, the container's actual `/proc/PID/mountinfo`
and visible filesystem/socket entries. Runtime-injected mounts do not necessarily
appear in Docker's user-declared `.Mounts` list. `/run/nvidia-persistenced`, CUDA
MPS, host abstract/pathname socket proxies, Docker/containerd APIs, host `/run`
or arbitrary host directories are forbidden. Unexpected mount roots, writable
host file mounts or socket files must refuse model startup, rather than become
an automatically learned allowlist. Only the reviewed read-only library files
and required NVIDIA character devices may be added to the ordinary OCI mounts.

The launcher requests compute-only NVIDIA capabilities. `boot.py` waits for a
root-generated, session/image/container/namespace-bound native attestation before
starting its child, until the original absolute expiry with no fallback. The
read-only handoff directory is root-only and starts empty. Compute-only is risk
reduction, not proof that no IPC mount was injected. Namespace identity, socket
inspection and adversarial controlled-host tests must be repeated on the
exact GPU runtime, and any toolkit-injected socket is a hard failure.

`native_attest.py` is the prepared trusted-host gate. The intended sequence is:
seal host; create (not run) the exact container using `docker_arguments()` with
its verb changed to `create`; run `native_attest.py --prepare-context`; start
the container, which runs only its waiting trusted supervisor; attach the owned
veth and complete the external adversarial checks; then run
`native_attest.py --execute`. The attestor pins the owned task and checks exact
private runtime flags/resources, declared binds, actual mounts, all ordinary
filesystem socket/device entries, separate namespaces and original expiry.
It permits read-only injected NVIDIA library files only when they match the
already pinned/verified host NVIDIA packages, and required matching NVIDIA
character devices. It refuses any unreviewed runtime mount, including an extra
host `/proc` subtree, rather than infer that it is safe or learn a new allowlist.
Its receipt is boundary evidence, never a CUDA/model success claim.

The Docker CPU fixture uses the same handoff validator and trusted supervisor:
missing, forged and wrong-namespace receipts must stop without a child, while a
root-generated **dummy CPU** receipt permits the bounded dummy checks. This
tests the handoff and refusal behavior, not NVIDIA hook inspection. The target
attestor, DKMS/reboot, native CUDA, model import and complete cloud
orchestration/gateway integration remain unverified. No bootstrap service starts
the inference container or tunnel automatically; that separately reviewed runtime
orchestration must preserve this sequence and both external destruction guards.
