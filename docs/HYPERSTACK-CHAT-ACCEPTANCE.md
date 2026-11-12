# Hyperstack chat acceptance — one allocation, approval required

This is the current public acceptance runbook. It authorizes no deployment,
funding, VM or retry. Use the reviewed release and private operational plan with
fresh stock, price, remaining allowance and explicit owner approval. A historical
single allocation failed provider identity checks and was deleted/reconciled;
its approval cannot be reused. See [current status](PROJECT-STATUS.md) and the
[release record](../release/README.md).

## Before creation

- Use the exact reviewed Hyperstack A100 80 GB target and immutable serving/bootstrap pins.
  Keep ordinary allowance and all agent/terminal tools off. No provider shopping
  or automatic retry is part of acceptance.
- Require the approved quote, preserved historical ledgers, no unresolved resource
  evidence and exactly one durable create attempt. Unknown outcomes retain holds.
- Arm both independent destroy guards before create. Both must emit fresh,
  current-version `nonce-name-v2` feature receipts for the exact reservation.
  Matching version IDs alone are insufficient.

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
   the attempt; do not relax restrictions or launch a replacement.
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
A fresh approval is required for another allocation or a changed scope/quote.
