# Project status — 2026-11-09

Goal: an owner-only cloud workstation that remains usable without a laptop or
development assistant running. Phase one is timed private Qwen chat. Phase two
adds a separately verified execution sandbox, agent harness, browser editor and
persistent projects with independent backups.

## Evidence and integration

Main remains at 442408e. PR #2 contains the prepared hardening/recovery release;
it is not merged or deployed. Dot's initial cleanup patch was already included.
The additional PR #1 commit 6e7b659 is now integrated on the PR #2 branch, retaining
our hardened test wrapper, draft/restore features and network release lock.

After integration: 67 portable Node + 31 Workers runtime tests passed (98
application tests), plus 16 portable Python tests. The application suite ran
behind verified OS external-network denial with dummy provider responses.
Earlier Linux CPU CI passed on fb7bf04. These tests do not establish compatibility
of the candidate image with the Runpod kernel, CUDA, vLLM or model weights.

Read-only Cloudflare checks confirm that controller, gateway and both independent
stop Workers still serve their November 3 deployments. No deployment was made.
Production behavior was not reauthenticated or tested against a running GPU in
this review. Earlier protected configuration recorded Start/guard arming locked;
deployment history is not a fresh read of all runtime state or Runpod inventory.

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
| UNIX socket isolation | Risk documented; private runtime directory configured | Enforced denial of unrelated pathname/abstract proxies and inherited capabilities |
| vLLM compatibility | Pinned source paths reviewed; offline/local settings prepared | Demonstrate full pinned stack works without weakening restrictions |
| Offline cache | Pinned 14-file manifest and adversarial verifier tests | Approved materialization of ~16.4 GB, immutable cache and candidate image |
| Dependency/artifact review | Scoped research and pinned recipes exist | Review final assembled serving artifact and remaining transport dependencies |
| Execution sandbox | Previous Runpod namespace incompatibility recorded; separate CPU architecture proposed | Provider selection, complete fresh costs and verified target isolation |
| OpenCode harness | Repository/incident research and bounded benchmark fixture prepared | Pinned review and exact-model read/edit/test/correct benchmark in verified sandbox |
| Browser editor and projects | Architecture/repository research | Implement editor, project lifecycle and persistent session layout |
| Independent workstation backups | Design and historical planning estimates | Approved destination, automation and clean-machine restore drill |
| Full acceptance/operations | Gates and roadmap documented | Monitoring, failure drills, timed workstation lifecycle and owner handoff |

## Launch sequence

1. Resolve UNIX socket/inherited-descriptor access and vLLM transport requirements
   using source review and model-free CPU probes. Missing protection must refuse
   startup; do not add privileges or network exceptions to force compatibility.
2. Review the exact artifact/cache plan and quote download/build/storage/idle and
   bounded runtime costs. Obtain the owner's required approvals before weights,
   serving-image publication or paid resources.
3. Validate the candidate image/runtime; preserve the null network release pin
   until the precise image and boundary pass. Earlier GPU tests are not a pass
   for changed inference security code.
4. Merge/deploy only with explicit instruction, preserving private configuration
   and cumulative ledgers. Perform one consolidated approved chat acceptance,
   including owner login, Start, response, Stop/expiry and restored history.
5. Address the separate agent workstation phase after chat acceptance. Agent,
   terminal and browsing tools remain disabled throughout phase one.

No paid resource, model-weight download, serving-image publication, production
deployment, budget change, automatic retry or ten-hour session occurred in this
review. Historical estimates are not current quotes or spending authorization.
