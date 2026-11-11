# Unjailed chat V1 — implementation checkpoint

The owner approved the chat-first implementation plan: unchanged Huihui Qwen3 8B v2, repeatable owner-confirmed 15/30/60-minute sessions, automatic cloud saving and draft recovery, manual backup/restore, one concurrent GPU, no laptop dependency. Agent execution, OpenCode, terminal/editor, executable projects, scheduled independent backups and ten-hour sessions remain phase two.

## Current evidence

- The reviewed interface and controller were deployed to the existing Cloudflare resources with Start and inference locked. Public development configs and budget seeds remain synthetic; never deploy them over private configuration or ledgers.
- The offline image/cache is built and CPU-reviewed. Its intended Runpod runtime failed CUDA initialization before weights loaded. The serving-network release pin remains null.
- The small native driver diagnostic started quickly on Secure RTX PRO 4500 Blackwell. It passed credential checks, installed the intended network policy, then returned CUDA 304 immediately after two denied UNIX sequenced-packet socket creations. This strongly implicates the IPC policy but is not a complete syscall trace or causal comparison. No model was loaded. The test resource was stopped/deleted and guards restored keyless. See CUDA-DRIVER-RUNPOD-FINDINGS.md.
- Hyperstack A6000 VM is the selected next target for a controllable equivalent isolation boundary. The funded account displays A6000 + public IP at $0.5067/hour (28 CPU, 58 GB RAM, 100 GB included local root). The preinstalled CUDA 13 image is restricted to B300 hardware; plain Ubuntu 24.04 is selectable with A6000. The owner approved free preparation of a pinned R580 driver bootstrap. Authenticated API IDs, effective permissions and native bootstrap compatibility remain unverified. No VM is approved or provisioned by this implementation checkpoint.

## Work in progress — not release acceptance

Provider-independent code now implements in-place revisioned cloud autosave, durable idempotent turns, draft-aware backups, owner usage allowances, repeat sessions and immutable selected durations. The hardened free suite passed 187 checks (105 Node, 44 Workers runtime, 38 Python). A loopback dummy browser walkthrough verified allowance/quote/Start, durable response and draft recovery after reload, export/restore, repeat Start and Stop. New provider/bootstrap components are separate candidates still under review. None of this is a live GPU acceptance or permission to enable paid Start.

The cloud controller must retain historical/test and ordinary-use ledgers separately, starting ordinary allowance at zero. Owner grants authorize consumption from existing provider credit; they do not purchase credits, change payment settings or renew automatically. Unknown create/cleanup outcomes retain holds and guards.

## Four release checkpoints

1. Provider ready: authenticated compatibility, effective permissions, exact all-in quote, and separately approved funding/paid scope.
2. Free release ready: canonical reviewed source, private config overlay, immutable release manifest, adversarial isolation tests, controller/store/UI failure tests and complete dummy browser walkthrough.
3. Live acceptance passed: one explicitly approved gated allocation performs model-free checks, then CUDA/model/chat only after the boundary passes, followed by verified destruction and spending reconciliation.
4. Product released: promote the exact accepted artifact; future owner sessions require an explicit ordinary-use allowance and per-session quote confirmation.

Existing test history and model layers are reused. Do not repeat unchanged successful GPU checks, shop between providers automatically, relax failed protections, or start paid resources from a roadmap/status entry. Free CPU evidence does not prove compatibility of a chosen VM.

## Source and operations

Canonical application source is this reviewed GitHub branch. Private deployment configuration, account identity, cumulative ledgers and receipts stay outside it. The older private Cloudflare source tree is not an alternate deployment source; deploying it can undo reviewed changes. A release must combine this source with a verified private configuration overlay and preserve existing resource/data identities.

The existing Linear project tracks chat work in M1/M2. M3–M7 stay in the phase-two backlog. Report concrete pass/failure evidence and the next blocker; do not infer product completion from test counts.
