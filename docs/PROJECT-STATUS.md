# Project status — 2026-11-10

Goal: an owner-only cloud workstation that remains usable without a laptop or
development assistant running. Phase one is timed private Qwen chat. Phase two
adds a separately verified execution sandbox, agent harness, browser editor and
persistent projects with independent backups.

## Evidence and integration

Owner-approved free cloud download/publication is complete. The exact offline
image in OFFLINE-IMAGE.json passed full cache hashes, ownership, read-only UID
10001 access, entrypoint, kernel policy installation and runtime-import checks.
Run 42741842571 passed both jobs. The first candidate refused startup because a
cache directory lacked search permission; a regression-tested directory-only
layer corrected it without changing any application/model layer. All weights
remained on GitHub/GHCR, not the laptop. One subsequently approved Runpod test
failed at CUDA initialization (error 304), before model loading. Its Pod was
stopped/deleted; the candidate remains launch-blocked. A model-free diagnostic
is prepared in CUDA-DIAGNOSTIC.md without relaxing security or enabling tools.

Main remains at 442408e. PR #2 contains the prepared hardening/recovery release;
it is not merged or deployed. Dot's initial cleanup patch was already included.
The additional PR #1 commit 6e7b659 is now integrated on the PR #2 branch, retaining
our hardened test wrapper, draft/restore features and network release lock.

After integration: 67 portable Node + 31 Workers runtime tests passed (98
application tests), plus 31 portable Python tests after the chat/cache changes. The suite ran
behind verified OS external-network denial with dummy provider responses.
Earlier Linux CPU CI passed on fb7bf04. These tests do not establish compatibility
of the candidate image with the Runpod kernel, CUDA, vLLM or model weights.
Final free CPU run 42736136833 passed native restrictions, 17 credential cases,
single-rank Gloo collectives and the actual serving libraries with the new shim.
The 16-package OSV review returned no matching advisories; its scope excludes
transitive/OS/CUDA packages and model behavior. See CHAT-SCOPED-ADVISORIES.json.

The bounded GPU test verified both current-version scheduled stop guards before
creation and observed both guards tracking its immutable expiry. Temporary guard
configuration was restored and all test keys/reservations removed afterward. The
website/controller were not deployed or unlocked. These operational checks do
not establish browser-to-GPU acceptance or validate the failed CUDA boundary.

## Component progress

| Component | Verified progress | Remaining acceptance |
|---|---|---|
| Domain and owner login | Existing site and Cloudflare Access configured | Owner browser walkthrough for final release |
| Chat and saved history | Existing UI/gateway; authentication and text-only output tests | New release's browser-to-GPU acceptance |
| Start/Stop and spending controls | Durable create marker, quote/consent, holds, expiry and revocation tested with dummy failures | Integration against one separately approved live session |
| Independent stop guards | Historical live stop tests; newer duplicate/renamed-Pod persistence and disarm checks tested locally | Deploy reviewed changes; validate relevant changed integration once |
| Draft protection | Save/Discard/Cancel and unsent-draft handling prepared/tested | Deploy and owner walkthrough |
| Chat backup/restore | Bounded versioned JSON export/import, duplicate safety and atomic rollback prepared/tested | Deploy; independent automatic destination not implemented |
| Inference credentials | Historical functional credential-boundary tests; no billing key intended in serving process | Exact candidate boundary readback and validation |
| Internet egress | Candidate inherited Landlock/seccomp denial and Linux dummy tests | Exact serving-image/Runpod compatibility |
| UNIX socket isolation | Named/abstract sockets, all connect calls and datagram pairs denied; Linux CPU checks passed | Exact final image and Runpod kernel validation |
| vLLM compatibility | Synchronous adapter prepared; actual serving libraries and single-rank Gloo checked on free CPU | CUDA/NCCL and full-model startup under the unchanged restrictions |
| Offline cache | 14 pinned files downloaded on GitHub, published and rehashed in the exact image as UID 10001; directory-only correction verified | Intended Runpod/GPU runtime gate |
| Dependency/artifact review | Exact image/configuration/cache readback and 16-package advisory review recorded | No claim of complete OS/CUDA/transitive audit; hardware/model validation pending |
| Execution sandbox | Previous Runpod namespace incompatibility recorded; separate CPU architecture proposed | Provider selection, complete fresh costs and verified target isolation |
| OpenCode harness | Repository/incident research and bounded benchmark fixture prepared | Pinned review and exact-model read/edit/test/correct benchmark in verified sandbox |
| Browser editor and projects | Architecture/repository research | Implement editor, project lifecycle and persistent session layout |
| Independent workstation backups | Design and historical planning estimates | Approved destination, automation and clean-machine restore drill |
| Full acceptance/operations | Gates and roadmap documented | Monitoring, failure drills, timed workstation lifecycle and owner handoff |

## Launch sequence

1. Review the new socket/descriptor restrictions and successful model-free CPU
   probes. Missing protection must refuse startup; do not add privileges or
   network exceptions to force compatibility.
2. Review the published artifact in OFFLINE-IMAGE.json and refresh bounded runtime
   costs before asking for paid approval. Free build/publication permission does
   not authorize a Pod or increase any cumulative budget.
3. Validate the candidate image/runtime; preserve the null network release pin
   until the precise image and boundary pass. Earlier GPU tests are not a pass
   for changed inference security code.
4. Merge/deploy only with explicit instruction, preserving private configuration
   and cumulative ledgers. Perform one consolidated approved chat acceptance,
   including owner login, Start, response, Stop/expiry and restored history.
5. Address the separate agent workstation phase after chat acceptance. Agent,
   terminal and browsing tools remain disabled throughout phase one.

CHAT-LAUNCH-ACCEPTANCE.md contains the historical bounded proposal and public
cost sources. The one approved runtime attempt failed and is complete; further
paid testing and website acceptance require a new quote and approval. No model
was loaded, no agent tools enabled, and no ten-hour run or automatic retry began.
Free diagnostic preparation does not authorize paid resources or production
deployment. Historical estimates are not current spending authorization.
