# Unjailed chat V1 — current implementation checkpoint

The goal is private browser chat with the pinned Huihui Qwen3 8B v2 model, owner-confirmed timed sessions, cloud autosave and durable replies, draft recovery, and manual backup/restore. Sessions and shutdown must work without the laptop or Codex. OpenCode, terminal/editor access, executable projects and independent scheduled backups remain phase two. Agent tools and ten-hour sessions are disabled.

## Current evidence

- The existing Cloudflare interface, controller and independent shutdown resources are deployed. Ordinary-use allowance and agent tools remain off. The source acceptance pin is limited to one separately approved candidate; private one-use authorization, budget and both guard gates still precede creation. Production approval remains closed.
- An earlier Hyperstack RTX A6000 allocation failed the provider identity gate: its readback returned `labels:[]` despite optional labels being requested. No model permit was issued. That historical attempt established no native CUDA or Qwen result.
- The exact allocation was manually deleted. Fresh structured absence and complete inventory checks were followed by operator-specific cloud reconciliation of the controller and both guards. The failure and truthful empty-label readback remain recorded; keyless reconciliation receipts were archived, and session keys and guard key copies were cleared. This was a known-created, manually deleted attempt, not a no-create outcome or a passed acceptance.
- Earlier Runpod CUDA/network-boundary failures are separate historical evidence; see `CUDA-DRIVER-RUNPOD-FINDINGS.md`. The pinned offline serving artifact passed free published-artifact checks, but the current Hyperstack runtime still needs native validation.

## Prepared V2 candidate — native acceptance outstanding

The prepared ownership protocol explicitly uses `nonce-name-v2`: the full random nonce-bearing VM name, exact target and UTC creation window establish initial ownership; durably observed IDs retain that binding through later name or label changes. Labels remain truthful diagnostic data. Reservations without the new version keep the strict legacy V1 label predicate. Historical V1 failure/recovery records are never upgraded into V2 or made eligible for another allocation.

Each guard must emit an explicit matching V2 policy receipt, with its current Worker version and immutable reservation/deadline. A current version ID alone cannot substitute for feature support. Both roles must pass before a new create attempt. This is free-tested code preparation; a cloud deployment must preserve the launch locks and does not validate the target VM. The VM code, bootstrap bundle, serving image and model remain unchanged by the ownership repair.

The latest free verification passed 334 Node checks, 26 chat Worker tests, 20 controller Durable Object tests and 20 guard Durable Object tests. The previously recorded Python suite ran 62 tests with one skip. These are CPU/dummy checks, not native target-provider or live browser-to-model acceptance.

Reviewed source now refreshes owner controller state before quoting and requires fresh cost consent. Safe preflight reasons survive cleanup recovery, including a concurrent owner Stop. The exact authenticated Cloudflare logout return redirects to the canonical root without relaxing other query or login restrictions. Create-failure diagnostics retain only whitelisted status/reason metadata and bounded response-byte counts; raw responses and credentials are excluded. Completed provider 4xx responses now reject only that create request, including unusable error bodies; contradictory success/resource evidence, lost replies and server errors remain unknown. A private, exact-session recovery directive can reconcile separately confirmed historical rejection evidence through fresh empty inventories and both existing guard disarms. It preserves consumed approvals and all other accounting, and grants no new launch or native acceptance. These source fixes do not establish native acceptance or production promotion.

The trusted host bundle now emits bounded, keyless progress through fixed console devices. The controller reads only context-bound markers from the bound VM's ACTIVE console-log API, retaining a sanitized startup-failure summary before deletion when there is sufficient time. Owner Stop and expiry take priority, and diagnostics never grant health or permission. Actual console capture remains a native check; a missing marker is unavailable evidence, not a pass. Startup timeouts now survive cleanup as a distinct reason and have a plain-language owner message.

Cloud autosave, revision conflicts, durable idempotent turns, draft-aware backups, fixed session limits and repeat-session controls are implemented. Historical/test and ordinary-use ledgers stay separate. Ordinary allowance remains zero; owner grants never purchase provider credits or renew sessions automatically. Unknown create or cleanup outcomes retain holds and guards.

The current candidate targets one on-demand A100 80 GB in CANADA-1 (`n3-A100x1`). Source approval binds that flavor and region explicitly. The controller uses a closed hardware profile and its separately configured hourly ceiling; prior A6000 reservation parsing remains supported for historical cleanup. The serving image, offline checkpoint, host bundle, isolation and session timers are unchanged. Spot and other flavors are not automatic substitutes. Native acceptance remains outstanding. Reviewed A6000 profile support remains available in code but is not selected by the active source approval.

## Remaining release gates

1. Reconcile any unresolved create or cleanup outcome before a new paid attempt; empty inventory alone does not release an unknown-outcome hold or guards. Use the reviewed source and preserve paid launch locks during any separately authorized deployment preparation. Both actual guards must produce the exact V2 feature/version receipts before any future create.
2. Present a fresh bounded acceptance plan and quote for explicit approval. The previous single-allocation authorization is consumed; no paid retry is authorized by this checkpoint.
3. Follow the [single-allocation Hyperstack runbook](HYPERSTACK-CHAT-ACCEPTANCE.md). Its thirty-minute acceptance includes startup, and a never-ready session is cleaned up at the fifteen-minute startup cutoff (`STARTUP_TIMEOUT`). Pass native model-free isolation/cache/CUDA checks, independently verify the provider firewall, then permit Qwen loading and a bounded chat reply. Verify login → quote → Start → chat → autosave/reopen/recovery → export/restore → Stop, followed by fresh destruction and resource/billing evidence.
4. Promote only the exact accepted release. Ordinary use still requires an explicit allowance and owner confirmation of each session quote.

No product release, native compatibility result or completion percentage is implied by source preparation or test counts. Do not relax failed protections, automatically retry, shop providers, or repeat unchanged successful GPU tests.

## Source and operations

Application changes belong in the canonical checkout/reviewed branch. Private deployment configuration, account identity, cumulative ledgers and receipts stay outside the public repository. Preserve the existing Worker, Durable Object, login and saved-chat identities when applying a reviewed release; the older private source tree is not an alternate codebase.

Report concrete pass/failure evidence and the next gate. Keep full workstation execution separate from completing secure chat acceptance.
