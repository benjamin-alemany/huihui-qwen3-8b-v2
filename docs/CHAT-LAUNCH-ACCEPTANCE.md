# Chat launch acceptance — prepared, not authorized

No workflow dispatch, Pod, publication, deployment or budget change follows from
this document. Agent, terminal and browsing tools remain off; no ten-hour run.

## Build and artifact gate

The manual chat-offline-image workflow is prepared with approval defaulting to
not-approved. It requires a successful complete CPU workflow covering unchanged
inference source, a public repository and a standard free Ubuntu runner. It stops
if free ephemeral disk is insufficient; never select a paid/larger runner or
volume. It uses no Actions caches/artifact uploads and no Runpod/Cloudflare keys.

After separate approval: download exactly 14 public files (16,397,433,656 bytes)
at the pinned checkpoint revision on that runner, verify all hashes/sizes and
the shard index, then publish to the existing public GHCR package. No laptop
weight download is needed. Package the model notices, root-owned read-only cache
and compiled compatibility library. Separate shard layers are each below 5 GB;
COPY --link permits reuse of base layers without executing/unpacking the base.

Before any paid phase: record final image digest/source SHA, inspect configuration
and layer contents/ownership, confirm the fixed entrypoint, pinned dependency
inventory and scoped advisory results, and test failure on absent/tampered cache.
No key, build login, private file or synthetic ledger seed may enter the artifact.
Do not approve the source network release pin based on CPU results alone.

## One consolidated paid acceptance proposal

The controller currently has no adoption operation for an externally created Pod.
Therefore do not promise that a separately launched runtime probe automatically
becomes the website-controlled session, and do not mark the image approved first.
The conservative plan has two distinct sequential creates, with no retries:

1. Exact-image runtime validation: one Secure A40, fixed six-minute deadline with
   independent prearmed cloud guards and a two-minute operational cleanup margin.
   Inspect credential/kernel/cache receipts, CUDA identity and startup; confirm
   authenticated health and a bounded text response with no tools. Unsupported
   restrictions or startup failure end the attempt; never relax protection.
   Stop/delete and confirm explicit absence before proceeding.
2. Only if phase one passes, review/pin that exact digest, privately deploy the
   reviewed controller/gateway/guards while preserving all real configuration and
   ledgers, and run one owner-approved website session. Test login, quote/consent,
   exactly one Start, readiness, health during generation, text chat, save/draft/
   backup restoration and owner Stop with verified Pod absence. Its immutable
   eighteen-minute deadline and independent guards remain armed. Expiry and guard
   fault combinations already covered by earlier live tests/dummy regressions
   need not each create another paid Pod.

Check live owner readiness, authenticated cloud control, stock, rate, existing
resources and independent scheduled guards immediately before each create. Never
re-enable the paused hourly launcher or auto-retry a capacity/startup failure.
If phase one fails, phase two is not launched.

## Current planning quote, not spending authority

November 9 Runpod get-gpu-type read: Secure A40, 48 GB, $0.59/hour, LOW stock in
CA-MTL-1 with host CUDA 13.2. A 60 GB temporary container disk is $6/month at the
published $0.10/GB/month rate; budget the combined rate at $0.60/hour. No persistent
volume or independent backup service is part of this chat test.

| Item | Operational planning amount |
|---|---:|
| Public GitHub standard runner, temporary build disk and existing public GHCR | $0 at current published terms |
| Runtime phase: up to 8 billed minutes including cleanup margin | $0.08 |
| Website phase: 18 minutes plus 5-minute shutdown/cleanup margin | $0.23 |
| Proposed combined incremental allowance, rounded up | $0.32 |
| New persistent storage, backup service or paid hosting | $0; none proposed |

Cold image pull, cache hashing and model startup consume the timed allowance;
these durations do not promise six/eighteen minutes of usable chat. Fixed cloud
deadlines and monitoring are operational controls, not a provider-enforced dollar
cap. Tax/FX and exceptional provider stop delays are excluded. Requote if the
rate, disk, artifact size, scope or stock changes; never substitute a pricier GPU.
Reconcile the separate private cumulative ledgers before requesting approval.
If this proposal exceeds the remaining allowance, request an explicit increase;
never borrow between budgets or treat earlier broad ceilings as authorization.

## Sources

- https://docs.runpod.io/pods/pricing
- https://docs.github.com/en/billing/concepts/product-billing/github-actions
- https://docs.github.com/en/billing/concepts/product-billing/github-packages
- https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry
- https://docs.docker.com/reference/dockerfile/#copy---link
