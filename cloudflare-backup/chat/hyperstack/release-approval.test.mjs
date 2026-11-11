import test from 'node:test';
import assert from 'node:assert/strict';
import manifest from '../../../release/manifest.json' with {type:'json'};
import {matchesReleasePin,releaseApprovedFor,APPROVED_ACCEPTANCE_RELEASE,ACCEPTED_PRODUCTION_RELEASE} from '../../../release/approval.mjs';
const pin=()=>({releaseId:manifest.id,servingImage:manifest.artifact.servingImage,bootstrapLockSha256:manifest.artifact.bootstrapLockSha256,bootstrapBundleSha256:manifest.artifact.bootstrapBundleSha256,bootstrapSourceCommit:manifest.artifact.bootstrapSourceCommit,bootstrapBundleSize:manifest.artifact.bootstrapBundleSize,runtimeOrchestrator:manifest.artifact.runtimeOrchestrator,vmImageId:manifest.hosting.vmImageId,runtimeProfile:manifest.artifact.runtimeProfile,ownershipPolicy:'nonce-name-v2'});
test('release authorization binds ownership V2 in addition to unchanged artifact/runtime pins',()=>{
 assert.equal(manifest.hosting.ownershipPolicy,'nonce-name-v2');assert.equal(matchesReleasePin(manifest,pin()),true);
 for(const value of [undefined,'label-v1','nonce-name-v3']){const p=pin();if(value===undefined)delete p.ownershipPolicy;else p.ownershipPolicy=value;assert.equal(matchesReleasePin(manifest,p),false);const r=structuredClone(manifest);if(value===undefined)delete r.hosting.ownershipPolicy;else r.hosting.ownershipPolicy=value;assert.equal(matchesReleasePin(r,pin()),false);}
});
test('ownership V2 preparation never authorizes another native attempt or production session',()=>{
 assert.equal(APPROVED_ACCEPTANCE_RELEASE,null);assert.equal(ACCEPTED_PRODUCTION_RELEASE,null);assert.equal(releaseApprovedFor('acceptance',manifest),false);assert.equal(releaseApprovedFor('production',{...manifest,status:'verified'}),false);
});
