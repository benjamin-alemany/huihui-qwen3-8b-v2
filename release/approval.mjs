import manifest from './manifest.json' with {type:'json'};
import {validateTarget} from '../cloudflare-backup/chat/hyperstack/policy.mjs';
// Source review gate for one separately owner-approved acceptance candidate.
// Private approval identity, durable single-create, budget and both guard gates
// remain required. This pin does not claim native or production acceptance.
export const APPROVED_ACCEPTANCE_TARGETS=Object.freeze([
 Object.freeze({flavor:'n3-RTX-A6000x1',region:'CANADA-1',vmImageId:574,maximumHourlyUSD:.507}),
 Object.freeze({flavor:'n3-A100x1',region:'CANADA-1',vmImageId:574,maximumHourlyUSD:1.36})
]);
export const APPROVED_ACCEPTANCE_RELEASE=Object.freeze({
  "releaseId": "unjailed-chat-v1",
  "modelRepository": "huihui-ai/Huihui-Qwen3-8B-abliterated-v2",
  "modelRevision": "7d89db76029281fd8f3e6698a8e30738608105a9",
  "modelServedName": "huihui-qwen3-8b-v2",
  "servingImage": "ghcr.io/benjamin-alemany/huihui-qwen3-8b-v2@sha256:86b61fca502d259910c36ec372c31adf59e0fb4495371904acc20f6bde535278",
  "bootstrapLockSha256": "064b1db71d0511887d42d926ab2d9a4f4ce4df5ef2859a80c7cc26a712881177",
  "bootstrapBundleSha256": "d3e1ba88ce53c49914c2fe7ae0bb4c71040cc99853171dc2a87ee54de1e09bd0",
  "bootstrapSourceCommit": "83f444937f3d8ea9829835c941ed0dc69df75d05",
  "bootstrapBundleSize": 61737,
  "runtimeOrchestrator": "vm-run-v1",
  "flavor": "n3-A100x1",
  "acceptanceTargets": APPROVED_ACCEPTANCE_TARGETS,
  "region": "CANADA-1",
  "vmImageId": 574,
  "ownershipPolicy": "nonce-name-v2",
  "runtimeProfile": "vm-inference-v1"
});
export const ACCEPTED_PRODUCTION_RELEASE=null;
export function matchesReleasePin(release,pin){
 return !!(pin&&release&&release.schemaVersion===1&&['candidate','verified'].includes(release.status)&&
  pin.releaseId===release.id&&pin.servingImage===release.artifact?.servingImage&&
  pin.modelRepository===release.model?.repository&&pin.modelRepository==='huihui-ai/Huihui-Qwen3-8B-abliterated-v2'&&
  pin.modelRevision===release.model?.revision&&pin.modelRevision==='7d89db76029281fd8f3e6698a8e30738608105a9'&&
  pin.modelServedName===release.model?.servedName&&pin.modelServedName==='huihui-qwen3-8b-v2'&&
  /^ghcr\.io\/benjamin-alemany\/huihui-qwen3-8b-v2@sha256:[a-f0-9]{64}$/.test(pin.servingImage??'')&&
  pin.bootstrapLockSha256===release.artifact?.bootstrapLockSha256&&/^[a-f0-9]{64}$/.test(pin.bootstrapLockSha256??'')&&
  pin.bootstrapBundleSha256===release.artifact?.bootstrapBundleSha256&&/^[a-f0-9]{64}$/.test(pin.bootstrapBundleSha256??'')&&
  pin.bootstrapSourceCommit===release.artifact?.bootstrapSourceCommit&&/^[a-f0-9]{40}$/.test(pin.bootstrapSourceCommit??'')&&
  pin.bootstrapBundleSize===release.artifact?.bootstrapBundleSize&&Number.isSafeInteger(pin.bootstrapBundleSize)&&pin.bootstrapBundleSize>0&&pin.bootstrapBundleSize<=262144&&
  pin.runtimeOrchestrator==='vm-run-v1'&&pin.runtimeOrchestrator===release.artifact?.runtimeOrchestrator&&
  pin.flavor===release.hosting?.flavor&&['n3-RTX-A6000x1','n3-A100x1'].includes(pin.flavor)&&
  (!('acceptanceTargets'in pin)||(JSON.stringify(pin.acceptanceTargets)===JSON.stringify(APPROVED_ACCEPTANCE_TARGETS)&&JSON.stringify(release.hosting?.acceptanceTargets)===JSON.stringify(APPROVED_ACCEPTANCE_TARGETS)))&&
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
// Acceptance-only selection from trusted configuration, never a browser GPU
// string. The source manifest stays pinned; only its reviewed per-allocation
// copy changes flavor. Production continues to require its separate exact pin.
export function acceptanceReleaseForTarget({target,release=manifest}={}){
 let selected;try{selected=validateTarget(target);}catch{throw Error('HYPERSTACK_ACCEPTANCE_TARGET_UNAPPROVED');}
 const profile=APPROVED_ACCEPTANCE_TARGETS.find(p=>p.flavor===selected.flavorName&&p.region===selected.region&&p.vmImageId===selected.imageId);
 if(!releaseApprovedFor('acceptance',release)||!profile||selected.maximumHourlyUSD>profile.maximumHourlyUSD||
  release.model?.repository!=='huihui-ai/Huihui-Qwen3-8B-abliterated-v2'||release.model?.revision!=='7d89db76029281fd8f3e6698a8e30738608105a9'||release.model?.servedName!=='huihui-qwen3-8b-v2')throw Error('HYPERSTACK_ACCEPTANCE_TARGET_UNAPPROVED');
 const copy=structuredClone(release);copy.hosting.flavor=selected.flavorName;return copy;
}
