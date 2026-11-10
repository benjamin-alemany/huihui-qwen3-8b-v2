# Chat launch acceptance — prepared, not authorized

Update: the owner approved and completed only the free cloud download, build and
publication. OFFLINE-IMAGE.json records the corrected image and successful exact
artifact readback (run 42741842571). The paid phases below remain unapproved;
publication does not change the null network release pin or cumulative budgets.

No workflow dispatch, Pod, publication, deployment or budget change follows from
this document. Agent, terminal and browsing tools remain off; no ten-hour run.

## Build and artifact gate

The manual chat-image workflow is prepared with approval defaulting to
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

1. Exact-image runtime validation: one Secure A40, fixed eighteen-minute deadline with
   independent prearmed cloud guards and a five-minute operational cleanup margin.
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

The earlier six-minute runtime/$0.32 combined proposal is superseded. The actual
published image is 22,104,667,316 compressed bytes; give its cold start a bounded
eighteen-minute window. Recommend approval of ONLY the first runtime attempt,
with a $0.25 operational allowance. A successful first phase does not authorize
the website phase. Before any create, stage/test the exact candidate guard pins
and timing, prove both independent cloud guards are current and scheduled, and
keep the public website release pin null until intended-runtime validation passes.

November 9 Runpod get-gpu-type read: Secure A40, 48 GB, $0.59/hour, LOW stock in
CA-MTL-1 and EU-SE-1 with host CUDA 13.2. A 60 GB temporary container disk is $6/month at the
published $0.10/GB/month rate; budget the combined rate at $0.60/hour. No persistent
volume or independent backup service is part of this chat test.

| Item | Operational planning amount |
|---|---:|
| Public GitHub standard runner, temporary build disk and existing public GHCR | $0 at current published terms |
| Runtime phase: 18-minute window + 5-minute cleanup margin | $0.23 |
| Recommended first-phase operational allowance | $0.25 |
| Website phase: 18 minutes plus 5-minute shutdown/cleanup margin | $0.23 |
| Combined estimate if both phases are later approved | $0.46 |
| Combined operational allowance if separately approved | $0.50 |
| New persistent storage, backup service or paid hosting | $0; none proposed |

Cold image pull, cache hashing and model startup consume the timed allowance;
these durations do not promise eighteen minutes of usable chat. Fixed cloud
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
