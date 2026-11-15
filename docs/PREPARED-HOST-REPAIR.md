# Prepared GPU host repair

The chat-only repair uses Hyperstack's public image **517**, `Ubuntu Server 24.04
LTS R570 CUDA 12.8 with Docker`, on **one on-demand A100 80 GB PCIe**, flavor 100,
in CANADA-1. The read-only catalog checked on 2026-11-15 permits this pair. Its
R595/CUDA13.2 image 1624 is hard-restricted to B300 and cannot replace it.

The current CUDA13 model image already includes `cuda-compat-13-0`
580.95.05-0ubuntu1. The exact existing vLLM base's NVIDIA requirement expression
permits R570. Free CPU run [43758276978](https://github.com/benjamin-alemany/huihui-qwen3-8b-v2/actions/runs/43758276978)
recorded the actual seven file hashes and six symlinks, now pinned in
`vm/cuda-compat.lock.json`. NVIDIA supports CUDA13 forward compatibility on
R570 for eligible data-center GPUs. This candidate is restricted to A100;
A6000 eligibility is not assumed. No driver requirement is globally disabled.

## Current executable milestone: host inventory only

`release/host-inventory.json` and its separate source payload describe a
**keyless inventory**, not a serving release. The existing serving image,
checkpoint, production approval, saved-chat identities and cumulative ledgers
are unchanged. An explicit trusted `HOST_VALIDATION_PROFILE=host-inventory-v1`
selects the separate acceptance candidate; flags alone grant no spending authority.

The guest performs no APT refresh/install, driver build, reboot, image pull,
container run, network call, model loading or CUDA initialization. It receives
no inference/gateway/tunnel/provider credentials. It reports only bounded
package/version/file-hash and hardware evidence. A source-pinned launcher checks
the exact script bytes and session, arms/checks the immutable local timer, then
executes the fixed probe. The controller health verifier always returns false
and inference context is unavailable for this profile.

Both current-version cloud destroy guards, single-create barriers, immutable
30-minute expiry, 15-minute startup cutoff, 30/31-minute destroy deadlines,
one-allocation-at-a-time rule and existing accounting remain mandatory. The
operator must capture the inventory **before Stop**, through
`collectHostInventory` in `host-inventory-diagnostics.mjs`; the old generic
progress parser intentionally cannot treat an inventory as model readiness.
The collector bounds the provider console request and validates a fresh owned
ACTIVE VM before and after capture. Unknown output is discarded. Fixed failure
stages remain available without raw error text. Capture is followed promptly
by Stop/delete and fresh inventory/resource cleanup evidence.

The old campaign used all three allocations and expired at 19:14:25 UTC on
November 15. Its history remains immutable. The owner authorized a separate
24-hour campaign at 21:01:30 UTC on November 15: at most two additional A100
allocations, three creation requests and ten Start/preflight attempts, one VM
at a time. The first allocation may collect keyless host inventory only; the
second may test CUDA, isolation and private browser chat after provenance review.
The new incremental ceiling is $1.70 and is enforced durably alongside the
unchanged cumulative $5 cap. The retained baseline is $1.9638881734 spent and
$3.0361118266 remaining. The A100 ceilings remain $1.36/hour and $0.85 per
allocation, including the existing cleanup reserve. No credits, auto-pay,
storage charges or ordinary-use allowance were authorized.

## Gate after inventory

Review installed package provenance against authenticated Ubuntu/NVIDIA/Docker
metadata and compare the actual files with exact package payloads. Pin a
canonical prepared-host lock independently of the observed proposal.
`verify_prepared_host` refuses a missing lock, altered files, unreviewed package
versions, missing utilities, wrong kernel/driver/GPU or failed package integrity.
It verifies locked executable bytes before running those utilities. No observed
allowlist is automatically promoted to trusted source.

The serving integration then skips package construction/reboot, verifies the
prepared host, and uses only the reviewed fixed compatibility library path before
the existing model child executes. The existing native mount/socket checks,
private namespaces, host/provider firewalls, credential separation, model-free
CUDA gate and second model permit remain required. First obtain an authenticated
model reply, then a browser reply and verified teardown. Host inventory and free
CPU success cannot satisfy those gates.

Full coding workstation, terminal/agent tools, new storage subscriptions,
snapshot fees, automatic top-ups and ten-hour sessions remain outside this repair.

References: [Hyperstack preinstalled container hosts](https://docs.hyperstack.cloud/docs/tutorials/docker-support/),
[image/flavor restrictions](https://docs.hyperstack.cloud/docs/virtual-machines/images/),
[NVIDIA forward compatibility](https://docs.nvidia.com/deploy/cuda-compatibility/latest/forward-compatibility.html).
