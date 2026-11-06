# Chat-only security review — 2026-11-06

## Release decision: blocked, no paid runtime

PR #2 retains the reviewed cleanup fixes, owner JWT/CSRF, plain-text output,
versioned bounded recovery and test egress controls. Its earlier automatic code
review reported no findings; that was not a model or infrastructure security audit.

The published inference image has no verified production egress boundary. New
source pins APPROVED_NETWORK_IMAGE to null: environment flags/approval/key cannot
make that image launch. Existing cleanup/Stop access is deliberately unaffected.
This source pin may only change after an exact replacement image passes the
kernel probe AND intended GPU/runtime compatibility, with reviewed evidence.
No browser receipt, model statement or environment boolean can satisfy it.
Deployed Start remains disabled; this work does not deploy or provision anything.

## Candidate, not a validated replacement image

chat/network_boundary.py installs Landlock ABI >=4 with CONNECT_TCP handled and
zero allowed ports. It also installs libseccomp rules to prevent Internet UDP,
raw/alternate socket families/protocols, socketpair families other than UNIX,
and io_uring operations. Enforcement precedes torch, model/tokenizer imports and
new threads; restrictions are inherited by fork/exec. Missing Linux support,
library, syscall, rule or enforcement is fatal, with no unrestricted fallback.
It requires no new privileged mode, NET_ADMIN, host firewall mutation or namespace
creation. Offline Hugging Face/Transformers settings prevent runtime downloads.
The intended revision must be supplied in a separately verified offline cache;
this work does not download weights, build or publish an image.

Inbound TCP bind/accept/replies remain possible. Outbound TCP, even loopback, is
blocked. vLLM may require loopback TCP internally: if it does, this candidate will
fail and must not be weakened to force startup. UNIX IPC is retained for runtime
compatibility, so reachable filesystem/abstract UNIX proxy or control sockets are
an outstanding review gate. Existing known credential-path checks are not a full
filesystem sandbox. The trusted bootstrap/host/kernel and serving dependencies
remain trusted. This is not authorization for agent execution.

## Verification and remaining gates

Portable Python checks verify unsupported-platform refusal before native loads,
required ordering and existing credential/deadline behavior. These do NOT prove
Linux packet enforcement. The real model-free probe is chat/network_probe.py:
it checks IPv4/IPv6 TCP policy refusal, UDP/raw socket denial, exec inheritance,
UNIX IPC and an inbound request/reply using only dummy loopback data.
Unsupported kernels must fail; do not skip the gate or enable privileged mode.

Local Docker is not running. The prepared model-free network probe passed on a
standard GitHub Ubuntu CPU runner, demonstrating policy denial, exec inheritance
and inbound replies there. It does not establish Runpod compatibility. No serving
image or GPU test was performed. The first full CPU run exposed a missing module
in the credential-test fixture; the fixture now copies that required module.
No assumption is made about Runpod's Landlock/libseccomp availability.
Before another paid acceptance can be proposed:
1. Run the prepared probe in a permitted credential-free Linux environment.
2. Review available UNIX IPC/services and offline-cache provisioning.
3. Build/review a credential-free image only when publication is authorized.
4. Quote intended-runtime validation costs within the preserved separate budgets;
   obtain approval before any Pod. Never reuse an exhausted allowance or retry.
5. Validate vLLM compatibility and kernel denial on that exact image/runtime.
Only then can the reviewed release pin and controller image digest be updated.

Official references:
https://docs.kernel.org/userspace-api/landlock.html
https://man7.org/linux/man-pages/man3/seccomp_rule_add.3.html
