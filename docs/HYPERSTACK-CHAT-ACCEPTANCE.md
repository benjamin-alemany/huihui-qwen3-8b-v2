# Hyperstack chat acceptance — bounded campaign, approval required

This is the current public acceptance runbook. It authorizes no deployment,
funding, VM or retry. Use the reviewed release and private operational plan with
fresh stock, price, remaining allowance and explicit owner approval. A historical
single allocation failed provider identity checks and was deleted/reconciled;
its approval cannot be reused. See [current status](PROJECT-STATUS.md) and the
[release record](../release/README.md).

## Before creation

- Select only a pre-staged Hyperstack A6000 48 GB or on-demand A100 80 GB target
  in CANADA-1, Ubuntu image 574, using the unchanged immutable serving/bootstrap
  pins. The acceptance selection API validates the exact trusted target and its
  ceiling ($0.507/hour A6000 or $1.36/hour A100); no source edits are needed when
  stock changes. The quote, consent binding and reservation retain that one
  selected target. Source selection does not authorize spending or retries.
  Keep ordinary allowance and all agent/terminal tools off. No provider shopping
  is permitted. Retries require the separately approved campaign below.
- Require the approved quote, preserved historical ledgers, no unresolved resource
  evidence and exactly one durably consumed child approval per creation request.
  Unknown outcomes retain holds and freeze further campaign attempts.
- Arm both independent destroy guards before create. Both must emit fresh,
  current-version `nonce-name-v2` feature receipts for the exact reservation.
  Matching version IDs alone are insufficient.

## Supervised campaign limits

Prepare and test the configuration before starting the owner-approved campaign
clock. Hyperstack validation requires trusted `TEST_CAMPAIGN_JSON`: an immutable
UUID, `validFrom`/`expiresAt` UTC epoch milliseconds no more than 24 hours apart,
`maxStarts` at most 20, `maxPosts` at most five, `maxAllocations` at most three,
and the source's five-dollar cumulative ceiling. This is not a new ledger or a
funding purchase. Preserve prior spending, reserves, approvals and ordinary-use
allowances. Missing or changed campaign configuration fails closed.

The existing controller Durable Object retains campaign counters across restarts,
new child approval IDs and either pre-staged target. It consumes each child and
POST candidate before creation, then checks the campaign again after bootstrap
rendering immediately before the actual provider POST. Observed allocation slots
are never refunded. A confirmed rejected request consumes its POST count; only
its unallocated candidate can be released after independent guard clearance.

A supervised operator may retry only within the owner's current grant, after
confirmed no-create or verified teardown, released holds and cleared guards.
Unknown results freeze the campaign. Keep one allocation at a time and reuse a
healthy allocation for all remaining acceptance checks within its original
expiry. Cleanup remains available after campaign expiry. Stop on success, budget,
attempt or validity limits, or a blocker requiring a security/architecture change.
This runbook itself authorizes no execution, retry, purchase or access change.

## Time budget and failure meaning

The acceptance session is thirty minutes from reservation preflight, including guard arming,
VM bootstrap, reboot, image pull, cache hashing and model startup. It is not a
thirty-minute cold-start window. A never-ready session reaches the controller's
startup cutoff after fifteen minutes and initiates shutdown with
`STARTUP_TIMEOUT`. The product cutoff remains `min(15, duration - 2)` minutes.
Neither browser reload nor recovery may renew that cutoff or the original expiry.

Once a session has been ready, a later health interruption does not restart its
startup allowance. The original session deadline still applies and is recorded
as `SESSION_DEADLINE_REACHED`. Owner Stop keeps its existing semantics; earlier
provider/identity diagnoses survive cleanup. A terminal `stopped` phase means
cleanup completed, not that native checks or chat acceptance passed. Inspect
both the reason and the native/browser evidence.

For an early never-ready failure with at least 45 seconds left before the
original expiry, the controller may attempt one diagnostic-only host-console
read before deletion, bounded to 30 seconds and the existing operation lease.
Inference is revoked first. Manual Stop, actual expiry and near-expiry cleanup
bypass this wait. Diagnostic failure cannot skip cleanup or change its reason,
health, model permission, budget or immutable deadline. Only allowlisted progress
events are stored; the owner API exposes a keyless stage summary, never raw logs.

## One-allocation sequence

1. On that allocation, verify packages/driver, private namespaces and mounts,
   process/resource restrictions, credential/socket isolation, adversarial host
   egress, offline cache and native CUDA without loading the model. Failure ends
   the attempt; do not relax restrictions. A replacement needs the separately
   approved campaign and verified cleanup, not a repeated create request.
2. Require fresh independent provider-firewall readback, then the exact host
   model permit. Only a later authenticated model-ready receipt permits Qwen
   chat. The provider key remains outside the VM and agent access remains off.
3. Verify owner login → quote → Start → bounded reply → cloud autosave and durable
   reply recovery → draft/chat reopen → manual export/restore → Stop. Browser
   closure must not cancel the cloud timer or erase an already completed reply.
4. Revoke inference, delete the VM, and verify structured absence, complete
   inventory, guard cleanup and provider resource/billing evidence. Power-off,
   DELETE acknowledgement or an empty invoice alone is insufficient. Record
   which shutdown mechanism actually acted; one deletion does not prove a
   separate backup intervention.
5. Record failures and actual evidence without upgrading the release to accepted
   based on CPU tests or successful cleanup alone. Promotion and subsequent use
   require the exact accepted release and separately authorized owner allowance.

Stop promptly on success or failure within the approved operational allowance.
Cloud timers and cleanup are safeguards, not a guaranteed provider billing cap.
Another allocation requires an eligible unused child under the existing explicit
campaign grant or a new owner approval. Changed scope, an exhausted grant or an
unknown outcome never creates permission to retry.
