import manifest from './manifest.json' with {type:'json'};
// Source review gate for one separately owner-approved acceptance candidate.
// Private approval identity, durable single-create, budget and both guard gates
// remain required. This pin does not claim native or production acceptance.
export const APPROVED_ACCEPTANCE_RELEASE=Object.freeze({
  "releaseId": "unjailed-chat-v1",
  "servingImage": "ghcr.io/benjamin-alemany/huihui-qwen3-8b-v2@sha256:86b61fca502d259910c36ec372c31adf59e0fb4495371904acc20f6bde535278",
  "bootstrapLockSha256": "064b1db71d0511887d42d926ab2d9a4f4ce4df5ef2859a80c7cc26a712881177",
  "bootstrapBundleSha256": "d184d706b0116fce87987ddf253ba5f9db1ff110491d3dff5629528794f080c6",
  "bootstrapSourceCommit": "f9e8055422e13800f5daa65a3216c44cdd39c848",
  "bootstrapBundleSize": 58303,
  "runtimeOrchestrator": "vm-run-v1",
  "flavor": "n3-A100x1",
  "region": "CANADA-1",
  "vmImageId": 574,
  "ownershipPolicy": "nonce-name-v2",
  "runtimeProfile": "vm-inference-v1"
});
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
  pin.flavor===release.hosting?.flavor&&['n3-RTX-A6000x1','n3-A100x1'].includes(pin.flavor)&&
  pin.region==='CANADA-1'&&pin.region===release.hosting?.region&&
  pin.vmImageId===release.hosting?.vmImageId&&Number.isSafeInteger(pin.vmImageId)&&pin.vmImageId>0&&
  pin.ownershipPolicy==='nonce-name-v2'&&pin.ownershipPolicy===release.hosting?.ownershipPolicy&&
  pin.runtimeProfile==='vm-inference-v1'&&pin.runtimeProfile===release.artifact?.runtimeProfile);
}
export function releaseApprovedFor(mode,release=manifest){
 if(mode==='acceptance')return matchesReleasePin(release,APPROVED_ACCEPTANCE_RELEASE);
 if(mode==='production')return release?.status==='verified'&&matchesReleasePin(release,ACCEPTED_PRODUCTION_RELEASE);
 return false;
}
