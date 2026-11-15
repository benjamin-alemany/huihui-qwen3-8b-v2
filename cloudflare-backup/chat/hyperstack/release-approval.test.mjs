import test from 'node:test';
import assert from 'node:assert/strict';
import manifest from '../../../release/manifest.json' with {type:'json'};
import {matchesReleasePin,releaseApprovedFor,acceptanceReleaseForTarget,APPROVED_ACCEPTANCE_TARGETS,APPROVED_ACCEPTANCE_RELEASE,ACCEPTED_PRODUCTION_RELEASE} from '../../../release/approval.mjs';
import {hyperstackLifecycle} from './controller-policy.mjs';
import {TARGET,NOW} from './fixtures.mjs';
const pin=()=>({...structuredClone(APPROVED_ACCEPTANCE_RELEASE)});
const selectedTarget=(flavor='n3-A100x1')=>({...TARGET,imageId:574,flavorName:flavor,maximumHourlyUSD:flavor==='n3-A100x1'?1.36:.507});
test('release authorization binds ownership V2 in addition to unchanged artifact/runtime pins',()=>{
 assert.equal(manifest.hosting.ownershipPolicy,'nonce-name-v2');assert.equal(matchesReleasePin(manifest,pin()),true);
 for(const value of [undefined,'label-v1','nonce-name-v3']){const p=pin();if(value===undefined)delete p.ownershipPolicy;else p.ownershipPolicy=value;assert.equal(matchesReleasePin(manifest,p),false);const r=structuredClone(manifest);if(value===undefined)delete r.hosting.ownershipPolicy;else r.hosting.ownershipPolicy=value;assert.equal(matchesReleasePin(r,pin()),false);}
});
test('source acceptance is limited to the exact owner-approved candidate and cannot authorize production',()=>{
 assert.equal(matchesReleasePin(manifest,APPROVED_ACCEPTANCE_RELEASE),true);assert.equal(ACCEPTED_PRODUCTION_RELEASE,null);assert.equal(releaseApprovedFor('acceptance',manifest),true);assert.equal(releaseApprovedFor('production',{...manifest,status:'verified'}),false);
 for(const field of ['servingImage','bootstrapBundleSha256','bootstrapSourceCommit']){const changed=structuredClone(manifest);changed.artifact[field]='unreviewed';assert.equal(releaseApprovedFor('acceptance',changed),false);}
 for(const field of ['repository','revision','servedName']){const changed=structuredClone(manifest);changed.model[field]='unreviewed';assert.equal(releaseApprovedFor('acceptance',changed),false);}
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
test('acceptance pre-stages only two reviewed targets without changing canonical or production pins',()=>{
 assert.deepEqual(manifest.hosting.acceptanceTargets,APPROVED_ACCEPTANCE_TARGETS);assert(Object.isFrozen(APPROVED_ACCEPTANCE_TARGETS));
 const original=structuredClone(manifest),bindings=[];
 for(const flavor of ['n3-RTX-A6000x1','n3-A100x1']){
  const target=selectedTarget(flavor),selected=acceptanceReleaseForTarget({target}),lifecycle=hyperstackLifecycle({target,release:selected}),reservation=lifecycle.reservation(NOW,'a'.repeat(32),30);
  assert.equal(selected.hosting.flavor,flavor);assert.deepEqual(selected.artifact,manifest.artifact);assert.deepEqual(selected.model,manifest.model);assert.equal(reservation.target.flavorName,flavor);assert.deepEqual(JSON.parse(lifecycle.binding).target,reservation.target);bindings.push(lifecycle.binding);
  assert.equal(releaseApprovedFor('production',{...selected,status:'verified'}),false);selected.hosting.acceptanceTargets[0].maximumHourlyUSD=99;
 }
 assert.notEqual(bindings[0],bindings[1]);assert.deepEqual(manifest,original);assert.equal(ACCEPTED_PRODUCTION_RELEASE,null);
});
test('acceptance selection rejects unknown shapes, regions, images, price ceilings and changed metadata',()=>{
 const valid=selectedTarget();assert.doesNotThrow(()=>acceptanceReleaseForTarget({target:valid}));
 for(const delta of [{flavorName:'n3-A100x1-spot'},{flavorName:'n3-A100x2'},{flavorName:'n3-L40x1'},{region:'NORWAY-1'},{imageId:33},{imageName:'Other Ubuntu'},{maximumHourlyUSD:1.360001},{flavorName:'n3-RTX-A6000x1',maximumHourlyUSD:.507001}])assert.throws(()=>acceptanceReleaseForTarget({target:{...valid,...delta}}),/HYPERSTACK_ACCEPTANCE_TARGET_UNAPPROVED/);
 for(const change of [r=>{delete r.hosting.acceptanceTargets;},r=>{r.hosting.acceptanceTargets.push({flavor:'n3-A100x1-spot',region:'CANADA-1',vmImageId:574,maximumHourlyUSD:1});},r=>{r.hosting.acceptanceTargets[0].maximumHourlyUSD=1;},r=>{r.hosting.acceptanceTargets[0].extra=true;},r=>{r.model.revision='0'.repeat(40);},r=>{r.artifact.servingImage='image:latest';}]){
  const release=structuredClone(manifest);change(release);assert.equal(releaseApprovedFor('acceptance',release),false);assert.throws(()=>acceptanceReleaseForTarget({target:valid,release}),/HYPERSTACK_ACCEPTANCE_TARGET_UNAPPROVED/);
 }
});
