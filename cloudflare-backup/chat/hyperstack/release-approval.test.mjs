import test from 'node:test';
import assert from 'node:assert/strict';
import manifest from '../../../release/manifest.json' with {type:'json'};
import {matchesReleasePin,releaseApprovedFor,APPROVED_ACCEPTANCE_RELEASE,ACCEPTED_PRODUCTION_RELEASE} from '../../../release/approval.mjs';
const pin=()=>({releaseId:manifest.id,servingImage:manifest.artifact.servingImage,bootstrapLockSha256:manifest.artifact.bootstrapLockSha256,bootstrapBundleSha256:manifest.artifact.bootstrapBundleSha256,bootstrapSourceCommit:manifest.artifact.bootstrapSourceCommit,bootstrapBundleSize:manifest.artifact.bootstrapBundleSize,runtimeOrchestrator:manifest.artifact.runtimeOrchestrator,flavor:manifest.hosting.flavor,region:manifest.hosting.region,vmImageId:manifest.hosting.vmImageId,runtimeProfile:manifest.artifact.runtimeProfile,ownershipPolicy:'nonce-name-v2'});
test('release authorization binds ownership V2 in addition to unchanged artifact/runtime pins',()=>{
 assert.equal(manifest.hosting.ownershipPolicy,'nonce-name-v2');assert.equal(matchesReleasePin(manifest,pin()),true);
 for(const value of [undefined,'label-v1','nonce-name-v3']){const p=pin();if(value===undefined)delete p.ownershipPolicy;else p.ownershipPolicy=value;assert.equal(matchesReleasePin(manifest,p),false);const r=structuredClone(manifest);if(value===undefined)delete r.hosting.ownershipPolicy;else r.hosting.ownershipPolicy=value;assert.equal(matchesReleasePin(r,pin()),false);}
});
test('source acceptance is limited to the exact owner-approved candidate and cannot authorize production',()=>{
 assert.equal(matchesReleasePin(manifest,APPROVED_ACCEPTANCE_RELEASE),true);assert.equal(ACCEPTED_PRODUCTION_RELEASE,null);assert.equal(releaseApprovedFor('acceptance',manifest),true);assert.equal(releaseApprovedFor('production',{...manifest,status:'verified'}),false);
 for(const field of ['servingImage','bootstrapBundleSha256','bootstrapSourceCommit']){const changed=structuredClone(manifest);changed.artifact[field]='unreviewed';assert.equal(releaseApprovedFor('acceptance',changed),false);}
});
test('source acceptance cannot silently switch GPU flavor or region',()=>{
 const active=APPROVED_ACCEPTANCE_RELEASE.flavor;
 assert(['n3-RTX-A6000x1','n3-A100x1'].includes(active));assert.equal(manifest.hosting.flavor,active);
 const other=active==='n3-A100x1'?'n3-RTX-A6000x1':'n3-A100x1';
 for(const [field,value] of [['flavor',other],['flavor','n3-A100x2'],['region','NORWAY-1']]){
  const changed=structuredClone(manifest);changed.hosting[field]=value;
  assert.equal(releaseApprovedFor('acceptance',changed),false);
 }
 for(const field of ['flavor','region']){const omitted=pin();delete omitted[field];assert.equal(matchesReleasePin(manifest,omitted),false);}
});
