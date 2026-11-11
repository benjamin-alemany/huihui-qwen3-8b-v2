# Cloud handoff for Dot and Codex

## Goal and current state

Implement the approved private-chat product plan: pinned Qwen, owner-confirmed timed sessions, durable cloud chats/replies, draft recovery and manual backup/restore without a laptop dependency. Current facts are in `PROJECT-STATUS.md`; historical Runpod CUDA findings are in `CUDA-DRIVER-RUNPOD-FINDINGS.md`. Full workstation and agent execution remain phase two.

The existing Cloudflare interface/controller and shutdown resources are deployed with paid Start, guard arming, inference, ordinary allowance and agent tools off. The source acceptance pin is limited to the exact separately owner-approved candidate; production approval remains closed. The single approved Hyperstack A6000 attempt failed the provider identity readback gate because optional requested labels returned empty. No model permit was issued; CUDA and Qwen remain untested on this target. The exact allocation was manually deleted and operator-specific controller/guard cloud reconciliation verified. Retain that truthful created/deleted failure record; never recast it as no-create or a successful acceptance.

The prepared V2 candidate uses a versioned protocol: `nonce-name-v2` binds the full random nonce-bearing name, exact target and UTC window, then retains durable allocation IDs. Legacy reservations without the field keep the original strict V1 label predicate. Each actual guard must explicitly prove the V2 policy and its current Worker version for the exact reservation before paid creation. Neither a version ID alone nor a historical V1 record is sufficient. The ownership repair leaves VM/bootstrap/model artifacts unchanged and does not establish native compatibility. Subsequent host-progress preparation refreshes the trusted host bundle for bounded, keyless console diagnostics; the serving image, checkpoint, isolation policy and timers remain unchanged. Diagnostics never grant health or a model permit. Actual provider console capture remains a native check.

The previous approval remains consumed. A new native allocation requires a separate fresh approval, exact candidate pins and all private spending/guard gates; the public source pin is insufficient by itself. The current execution sequence is in [the single-allocation Hyperstack runbook](HYPERSTACK-CHAT-ACCEPTANCE.md); its thirty-minute session has a fifteen-minute startup cutoff. Do not restart the former Runpod compatibility experiments.

Free code changes do not authorize credit purchases, subscriptions, auto-pay, paid resources, production unlocks or agent execution. Paid acceptance and provider funding retain their separate explicit approval requirements. The owner must complete account/legal/payment actions. Keep all real credentials out of this development checkout and all public evidence.

## Repository map

- Root Docker recipes and `chat/`: the existing inference-image project.
- `cloudflare-backup/chat/site/`: browser UI, autosave/draft recovery, backups and quote/consent/Start/Stop.
- `cloudflare-backup/chat/worker.mjs`: owner authentication, CSRF, history and inference gateway.
- `cloudflare-backup/chat/controller/engine.mjs`: durable lifecycle, budget and single-create logic.
- `cloudflare-backup/chat/controller/guard.mjs`: independent per-guard reservation stores.
- `cloudflare-backup/chat/hyperstack/`: versioned ownership, provider API, destroy guards and host/firewall handshake.
- `vm/`: the prepared native VM boundary/bootstrap/runtime; target GPU acceptance remains outstanding.
- `release/`: pinned candidate artifacts and separate closed source approval gates.
- `cloudflare-backup/chat/validation/stop.mjs`: historical Runpod fixed-deadline STOP core.
- `cloudflare-backup/chat/controller/receipts.mjs` and `tails.mjs`: strict current-version cron proof.
- `cloudflare-backup/workstation/auth.mjs`: signed owner JWT verification.

## Development configuration

The publication intentionally excludes private `.secrets`, browser state, personal
emails, real account identifiers, raw production logs, saved conversation exports,
billing ledgers, screenshots and provider deployment receipts. Cloudflare configs
have no account ID or production routes. Receipt fixtures and budget seeds are
synthetic; they test the same logic without disclosing production state.

Do not deploy these examples or replace live policy/ledger values with them.
Production configuration remains in the owner's private workspace/Cloudflare.
Prepare logic changes as reviewable patches so private deployment configuration
and existing ledgers can be preserved when a separately authorized release occurs.

No API keys, personal vault values, HTTP secrets, VPN or cloud identities are
required. Use Node 22.12+ and the existing npm lockfile. Allow package managers
only; leave unrestricted public internet disabled. The tests use local dummy
responses and do not create cloud resources.

## Setup and verification

See `docs/TESTING-AND-RECOVERY.md` for the hardened workflow. Run
`bash .codex/setup.sh` to install pinned packages without lifecycle scripts, then
`bash .codex/test.sh` to run dummy tests behind verified OS external-network denial.
Setup and test phases are separate. Neither phase deploys, downloads a model or
starts a GPU. Review dependency/runtime risks before executing untrusted changes.

Latest local evidence: 293 Node, 25 chat, 17 controller and 20 guard checks passed; 62 Python tests ran with one skip. These CPU/dummy results do not validate the target VM or release the product.

The earlier production-source suite also replayed private real tail exports. In this
public copy that one fixture case uses sanitized scheduled-tail data, so it is
not a new live transport validation.

## Next bounded review

Review the V2 ownership/receipt path for duplicate creates, V1 reinterpretation,
budget resets, crash/restart races, feature-proof bypasses, Stop races, credential
disclosure and false cleanup success. Preserve truthful empty-label evidence and
operator recovery history. Reproduce concrete findings with dummy tests; repeat
existing successful checks only when a relevant change or failure justifies it.
Prepare patches on a branch for review and report only material findings, failures or required
owner action. Stop after the review deliverable; do not keep changing code to
stay busy, schedule recurring work, deploy, or request extra credentials.

## Development environment choice

A Codex Cloud environment is optional and has not been created. Dot's built-in
cloud computer was unavailable for the first trial; it produced draft PR #1 via
GitHub and the full suite was verified locally. Current implementation continues
in the owner's development workspace. The published code and test instructions
can be used in another permitted, isolated environment without cloud credentials.
Do not provision a replacement machine or create recurring work without approval.
