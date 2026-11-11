# Cloud handoff for Dot and Codex

## Goal and current state

Implement the approved private-chat product plan. The canonical code is this reviewed branch; current facts are in PROJECT-STATUS.md and CUDA-DRIVER-RUNPOD-FINDINGS.md. The existing Cloudflare interface/controller are deployed with inference and paid Start locked. Earlier functional GPU chat does not establish readiness for the newer network boundary. The exact offline image failed native CUDA; its release pin remains null.

The selected next inference host is a Hyperstack A6000 VM, subject to the account-access/price/stock/permissions/image gate. No VM or funding is authorized by this document. Provider-independent autosave and repeat-session work can proceed free; do not build around an unverified provider or initiate another Runpod compatibility experiment.

Free code changes do not authorize credit purchases, subscriptions, auto-pay, paid resources, production unlocks or agent execution. Paid acceptance and provider funding retain their separate explicit approval requirements. The owner must complete account/legal/payment actions. Keep all real credentials out of this development checkout and all public evidence.

## Repository map

- Root Docker recipes and `chat/`: the existing inference-image project.
- `cloudflare-backup/chat/site/`: browser UI, manual saved chats, quote/consent/Start/Stop.
- `cloudflare-backup/chat/worker.mjs`: owner authentication, CSRF, history and inference gateway.
- `cloudflare-backup/chat/controller/engine.mjs`: durable lifecycle, budget and single-create logic.
- `cloudflare-backup/chat/controller/guard.mjs`: independent per-guard reservation stores.
- `cloudflare-backup/chat/validation/stop.mjs`: the reused fixed-deadline STOP core.
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

The production-source suite also replayed private real tail exports. In this
public copy that one fixture case uses sanitized scheduled-tail data, so it is
not a new live transport validation.

## First bounded Dot assignment

Independently review the session controller for duplicate creates, budget resets,
crash/restart races, receipt bypasses, Stop races, credential disclosure and false
cleanup success. Reproduce concrete findings with dummy tests. Prepare patches
on a branch for review and report only material findings, failures or required
owner action. Stop after the review deliverable; do not keep changing code to
stay busy, schedule recurring work, deploy, or request extra credentials.

## Development environment choice

A Codex Cloud environment is optional and has not been created. Dot's built-in
cloud computer was unavailable for the first trial; it produced draft PR #1 via
GitHub and the full suite was verified locally. Current implementation continues
in the owner's development workspace. The published code and test instructions
can be used in another permitted, isolated environment without cloud credentials.
Do not provision a replacement machine or create recurring work without approval.
