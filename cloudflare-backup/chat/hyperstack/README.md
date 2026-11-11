# Hyperstack adapter candidate

## Exceptional operator cleanup

`OPERATOR_ABSENCE_RECONCILIATION_JSON` is a temporary private deployment
directive for a known-created, manually deleted acceptance VM whose provider
readback omitted its reservation label. It never changes normal ownership
matching, creates a tag, authorizes DELETE, or asserts that creation never ran.
Start and new guard arming must stay locked. The controller alarm and both
private guard RPCs independently require direct absence, complete empty account
inventory, then direct absence again. Missing evidence retains keys and holds.
After all proofs, guards archive keyless receipts and the controller consumes
the existing hold once as a conservative upper estimate, preserving previous
spending, approvals and the separate original ledger. Billing remains pending;
this is neither a refund nor an invoice. Remove the directive after verifying
its archive. It blocks all new Start and inference while present.

The candidate controller, guard, bootstrap and runtime-handshake paths are wired
in source and covered by CPU/dummy tests. Those tests do not establish native VM,
CUDA, model or provider-firewall compatibility. Paid Start remains locked by the
release approval gates; agent tools and terminals remain disabled. Importing these
modules or running their dummy tests creates no VM.

`hyperstackClient(key, {target, bootstrapFor, verifyHealth, fetchImpl, now})`
exposes `catalog`, `list`, `get`, `create`, `health`, `sealFirewall`, `cleanup`,
and a narrowed `destroyClient()` capability containing only `list`, `get`, `remove`. Its fixed
API base is `https://infrahub-api.nexgencloud.com/v1`; no caller-controlled URL,
raw request, VM body or provider error text is exposed. Pass the key only from
controller/guard secret storage, never from or into the inference VM.

The exact account-metadata target must contain numeric `environmentId`,
`flavorId`, `imageId`, exact `environmentName`, `keyName`, `imageName` (plain
Ubuntu Server 24.04 LTS (Noble Numbat)), `flavorName` (n3-RTX-A6000x1), `region`
(CANADA-1), fixed `inferenceOrigin` (https://inference.unjailed.work), and
`maximumHourlyUSD` <= 1. `catalog()` cross-checks image/flavor restrictions,
stock, environment/keypair, the authenticated pricebook and its validity window.
Catalog evidence does not verify create/delete permissions or runtime behavior.
The adapter refuses missing compatibility metadata, soft warnings and constraints
that have not been reviewed. Resolve actual account IDs before enabling Start.

A reservation contains `nonce` (32 lowercase hex), exact `name`
(`unjailed-chat-${nonce}`), `createdNotBefore`, `createdNotAfter` (milliseconds,
window <= five minutes), immutable absolute `deadline` (maximum 65 minutes from
window start), and the validated `target`. `create(reservation)` invokes a trusted
`bootstrapFor(reservation)` callback; no browser-supplied user_data is accepted.
The caller must durably mark create attempted and arm both guards **before**
calling create. The adapter sends one POST, never retries, and classifies errors
as `CreateError.outcome`: `definite-no-create` for local preflight or documented
image compatibility rejection; `unknown` for lost/ambiguous replies. Keep budget
holds and both guards for unknown results. No automatic retry/provider fallback.
The inspected public create schema documents the exact compatibility rejection,
but no exact capacity-rejection payload that proves no VM was created. Capacity
failures therefore remain unknown until independently reconciled; a generic
4xx, error string or empty list never releases that hold by itself.

Creation has no independent persistent volume (`create_bootable_volume:false`),
no user-provided volume/profile/custom flavor/callback, and no ingress rules.
**An empty security_rules array is not proof of default-deny egress:** Hyperstack
may retain provider defaults. Root bootstrap and independent firewall readback
must seal IPv4/IPv6 before model execution. This module never enables the model,
agent tools or a terminal. `health()` returns false without the trusted runtime
receipt verifier; ordinary /health alone cannot pass the runtime gate.

Provider readbacks are normalized to minimal allowlisted data. VM responses
contain an image *name*, not image ID; bind its ID via the catalog. They contain
a floating-IP address, not an independent IP ID. They never prove the serving
artifact digest. `artifactVerified` remains false in VM readbacks.

`cleanup(boundAllocation,reservation)` verifies the original exact nonce/name/
tag/time/target binding, then fresh GET, DELETE, fresh structured 404, complete VM
inventory and another fresh GET. The immutable ID and creation time retain the
binding if name/tags later change. Acknowledged DELETE, SHUTOFF, 401, malformed
JSON, partial pagination and transient failures never prove absence. Attached
volumes trigger review and are never deleted without attributable ownership.

Cleanup returns a receipt rather than a boolean. `complete` means bounded VM
absence/inventory verification and no observed unexpected volumes; it does not
mean independent public-IP absence or settled billing. Receipts explicitly state
`publicIpReleaseMode:'vm-coupled'`, `independentIpReadback:false`,
`standaloneIpAbsence:'unverified'`, `billingSettlementPending:true`.
Hyperstack documents that deleting a VM returns its attached public IP to the
pool, but its public API provides no standalone IP list/delete endpoint. No such
endpoint is invented here. Actual provider billing and console Resource Activity
must be checked before accepting zero residual charges.

`armDestroyGuard(store,reservation,{role:'primary'|'backup'})`,
`requestDestroy(store,nonce)` and `runDestroyGuard({store,provider,now})` are an
independently executable, durable destroy core. Each guard has its own durable
store and its own narrowed provider client. Primary expiry is the reservation's
absolute deadline; backup is exactly one minute later. The core discovers and
durably binds IDs before DELETE, retains all bindings, handles unknown creates
without releasing holds and never creates/stops/hibernates anything. Guard
integration in `guard-runtime.mjs` and `controller/guard.mjs` adds separate secret
storage, alarms, scheduled version receipts, operation leases and keyless cleanup
archives. The core never disarms itself; the runtime requires fresh verified
absence or explicit no-create proof before clearing its active key. Actual
provider billing settlement still requires operator reconciliation.

Public API schema inspected 2026-11-10:

- https://docs.hyperstack.cloud/openapi/hyperstack.json
- https://docs.hyperstack.cloud/docs/network/public-ip/
- https://docs.hyperstack.cloud/docs/billing/states-and-billing/
- https://docs.hyperstack.cloud/docs/api-reference/delete-vm/

Run dummy tests through the hardened repository wrapper:
`node .codex/run-tests.mjs node`, using the clean environment described in
`docs/TESTING-AND-RECOVERY.md`. Every provider test injects fake responses;
OS outbound-network denial is verified before execution.

## Injected session lifecycle

`hyperstackLifecycle({target,release})` in `controller-policy.mjs` supplies the
provider-specific hooks for an explicitly injected `SessionEngine`. There is no
default export or import-time provider switch. Construction requires the exact
model/revision, VM metadata, immutable serving image, bootstrap lock and runtime
profile. A fully pinned `candidate` can support a separately approved acceptance
test; `verified` remains a different production acceptance state. Missing release
pins refuse construction, and the separate acceptance/production source approval
pins remain null. Environment flags cannot replace them.

The hooks use the existing ledger's SCALE/units/dollars functions, quote actual
GPU plus IP rates, preserve 15/30/60-minute owner sessions and select 30 minutes
for validation. They never grant funds or reset either ledger. Hyperstack quote
text describes 100 GB temporary root storage rather than the legacy Pod disk.

Controller reservations add `kind:'chat'`, `provider:'hyperstack'`, `minutes`,
the pinned serving `image`, and ISO `windowStart`/`windowEnd`. These fields are
strictly validated and preserved by the shared reservation validator, so they
reach bootstrap and both independent guards. The immutable session starts at
preflight: `bootAt=createdNotBefore`, `deadline=bootAt+minutes*60000`; arming and
startup consume that session. The gateway context contains exactly provider,
numeric-string VM ID, ISO bootAt, nonce and minutes. Agent tools stay disabled.

The q-only `createBody` includes no credential. The wired trusted bootstrap
callback rereads the durable session before and after rendering and checks its
exact reservation/nonce. It separates the host gateway key, model-only key and
host tunnel credential; provider billing/API keys stay outside the VM. This
integration has CPU coverage; exact-target native acceptance is still required.

Hyperstack scheduled receipts must bind provider, name, pinned image, nonce and
deadline; each role must supply a fresh timestamp, UUID version and matching
nonce/expiry (primary deadline, backup deadline + one minute). Authenticated tail
parsing must check the exact scheduled-log status/name/image and active version;
the engine separately rechecks live versions. Missing expiry or metadata refuses
creation. Legacy Runpod receipt shapes remain separate.

The injected-engine tests cover repeated sessions and separate ledgers, explicit
Stop, immutable deadline including guard-arming time, receipt-gated readiness,
30-minute acceptance single-use, definite/unknown create outcomes and durable
cleanup attention when an unexpected volume outlives its VM.

## Provider firewall gate

`client.sealFirewall(boundAllocation,reservation)` operates only on that exact
owned VM. It detaches shared firewalls from this VM using the documented
`attach-firewalls` endpoint; shared definitions and other VM attachments are
untouched. It removes VM ingress/default/broad egress rules and reconciles exactly
six IPv4 egress rules: TCP 7844 to the two fixed Cloudflare Tunnel CIDRs, and
UDP/TCP 53 to the two fixed DNS /32s. It never invents deny fields or allows IPv6
initiation. Final rule statuses must be SUCCESS, with no extra rule or shared
firewall attachment in fresh complete readbacks. Missing/pending/readback errors
refuse the seal receipt. This is a candidate API gate, not a real provider probe.

The returned receipt is exactly `{provider:'hyperstack',sealed:true,allocationId,
nonce,deadline,policy:'tunnel-dns-egress-v1'}`. The wired host handshake requires
a validated model-free preflight receipt, calls this gate outside the VM, durably records its permit intent, then permits
weights through the fixed host gateway route. A later actual-model-ready receipt
is required before chat becomes available. The provider key never enters the VM.
Inventory pagination follows pages until short/empty, rather than interpreting
the API's current-page count as a total and prematurely accepting absence.

## Cloud-init renderer

`renderCloudInit` accepts the exact minimal trusted session projection (including
distinct gateway `inferenceKey` and model `modelKey`), bound reservation, pinned
release, static source bundle and typed local-managed named-tunnel JSON. The model
environment gets only modelKey; outer authentication stays in the host gateway.
The session manifest contains the logical UUID/nonce and unknown pre-create VM/IP
values. Root-only staged secrets, package/bundle/session hashes, a fixed file
allowlist, bounded canonical gzip JSON and duplicate/traversal refusal are checked
both before render and by the host installer. No tar or arbitrary command exists.

Runtime activation is a separate source pin plus a complete fixed runtime file
set, enabled only for the next boot after native bootstrap. Otherwise the stage
stops at HOST_READY_MODEL_NOT_STARTED. CPU tests do not establish native readiness.

The full bundle is delivered outside inline user_data. The manifest pins its
public GitHub source commit, SHA256 and compressed size; the installer downloads
only the fixed repository/path at that commit, with bounded bytes, no redirects
or proxy use, and verifies the digest before unpacking or package work. The
Worker is wired to the corresponding credential-free bundle and renderer.
This resolves artifact delivery preparation, not native/GPU acceptance or paid
launch authorization.
