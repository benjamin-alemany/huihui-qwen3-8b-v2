import manifest from './manifest.json' with {type:'json'};
// Source review gates, not deployment flags, browser grants or model receipts.
// The single approved allocation ended at the provider identity readback gate.
// Both pins are closed; another native allocation requires a new reviewed
// authorization. No model, runtime or isolation acceptance is implied.
export const APPROVED_ACCEPTANCE_RELEASE=null;
export const ACCEPTED_PRODUCTION_RELEASE=null;
export function matchesReleasePin(release,pin){
 return !!(pin&&release&&release.schemaVersion===1&&['candidate','verified'].includes(release.status)&&
  pin.releaseId===release.id&&pin.servingImage===release.artifact?.servingImage&&
  /^ghcr\.io\/benjamin-alemany\/huihui-qwen3-8b-v2@sha256:[a-f0-9]{64}$/.test(pin.servingImage??'')&&
  pin.bootstrapLockSha256===release.artifact?.bootstrapLockSha256&&/^[a-f0-9]{64}$/.test(pin.bootstrapLockSha256??'')&&
  pin.bootstrapBundleSha256===release.artifact?.bootstrapBundleSha256&&/^[a-f0-9]{64}$/.test(pin.bootstrapBundleSha256??'')&&
  pin.bootstrapSourceCommit===release.artifact?.bootstrapSourceCommit&&/^[a-f0-9]{40}$/.test(pin.bootstrapSourceCommit??'')&&
  pin.bootstrapBundleSize===release.artifact?.bootstrapBundleSize&&Number.isSafeInteger(pin.bootstrapBundleSize)&&pin.bootstrapBundleSize>0&&pin.bootstrapBundleSize<=262144&&
  pin.runtimeOrchestrator==='vm-run-v1'&&pin.runtimeOrchestrator===release.artifact?.runtimeOrchestrator&&
  pin.vmImageId===release.hosting?.vmImageId&&Number.isSafeInteger(pin.vmImageId)&&pin.vmImageId>0&&
  pin.ownershipPolicy==='nonce-name-v2'&&pin.ownershipPolicy===release.hosting?.ownershipPolicy&&
  pin.runtimeProfile==='vm-inference-v1'&&pin.runtimeProfile===release.artifact?.runtimeProfile);
}
export function releaseApprovedFor(mode,release=manifest){
 if(mode==='acceptance')return matchesReleasePin(release,APPROVED_ACCEPTANCE_RELEASE);
 if(mode==='production')return release?.status==='verified'&&matchesReleasePin(release,ACCEPTED_PRODUCTION_RELEASE);
 return false;
}
