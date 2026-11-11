import manifest from './manifest.json' with {type:'json'};
// Source review gates, not deployment flags, browser grants or model receipts.
// Exact candidate approved for one separately authorized acceptance allocation.
// Runtime flags, durable one-use authorization and budget holds remain required.
// The production pin remains null until native/browser/cleanup acceptance passes.
export const APPROVED_ACCEPTANCE_RELEASE=Object.freeze({
  "releaseId": "unjailed-chat-v1",
  "servingImage": "ghcr.io/benjamin-alemany/huihui-qwen3-8b-v2@sha256:86b61fca502d259910c36ec372c31adf59e0fb4495371904acc20f6bde535278",
  "bootstrapLockSha256": "064b1db71d0511887d42d926ab2d9a4f4ce4df5ef2859a80c7cc26a712881177",
  "bootstrapBundleSha256": "8b79eb97356233a3b2be02124a7bd1224aed810fd3dcb7d7444ac8d0ded974b5",
  "bootstrapSourceCommit": "02885a597f8deae6b9a5532f39828e09cee363db",
  "bootstrapBundleSize": 56684,
  "runtimeOrchestrator": "vm-run-v1",
  "runtimeProfile": "vm-inference-v1",
  "vmImageId": 574
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
  pin.vmImageId===release.hosting?.vmImageId&&Number.isSafeInteger(pin.vmImageId)&&pin.vmImageId>0&&
  pin.runtimeProfile==='vm-inference-v1'&&pin.runtimeProfile===release.artifact?.runtimeProfile);
}
export function releaseApprovedFor(mode,release=manifest){
 if(mode==='acceptance')return matchesReleasePin(release,APPROVED_ACCEPTANCE_RELEASE);
 if(mode==='production')return release?.status==='verified'&&matchesReleasePin(release,ACCEPTED_PRODUCTION_RELEASE);
 return false;
}
