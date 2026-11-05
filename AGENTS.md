# Cloud development scope

This repository contains a Runpod image recipe and a credential-free development
copy of the private chat controller in `cloudflare-backup/`.

- Work on source review, dummy-response tests and proposed fixes. Use a branch
  and a reviewable commit/PR. Do not deploy or merge production changes without
  the owner's explicit instruction.
- Do not create/start/restart GPU Pods, run image publication workflows, download
  model weights, launch GPU tests, alter live cloud resources, modify account
  permissions, change budgets, or enable billing/auto-pay. No paid acceptance has
  been authorized by this cloud-development setup.
- Do not install or request Runpod, Cloudflare, inference or billing credentials.
  Use dummy test values. Do not look for credentials in connected services,
  browser sessions, another project or local computer.
- Qwen remains chat-only. Agent/terminal/browsing/tool execution is disabled;
  arbitrary execution isolation failed its prior Runpod namespace gate. There
  is no ten-hour session authorized.
- Public configs, account identifiers, policy seeds, receipt fixtures and budget
  figures are synthetic development examples. Never copy their initial values
  over production ledgers or treat them as an authorization to spend.
- Preserve exactly-once create attempts, durable budget holds, immutable expiry,
  current-version scheduled receipt gates, independent stop reservations,
  owner JWT/CSRF checks, and explicit STOP/delete verification. Never relax a
  failed gate to make a test pass.
- Production inference/shutdown validation is already recorded privately. Run
  the relevant local dummy tests for changes; do not repeat GPU/model tests.
- There are no deployment secrets or live API domains required for this work.
  Prefer package-registry-only network access. No VPN or cloud identity is needed.
- Read `docs/CLOUD-HANDOFF.md` before work. Keep a bounded task with a concrete
  deliverable; finish or report a blocker rather than looping indefinitely.

Setup: `bash .codex/setup.sh`. Tests: `bash .codex/test.sh`.
