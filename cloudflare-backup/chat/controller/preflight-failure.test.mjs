import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SessionError} from './session-policy.mjs';
import {safePreflightFailure} from './preflight-failure.mjs';

test('preflight keeps reviewed SessionError and Hyperstack classifications only',()=>{
 for(const code of ['NO_STOCK','PRICE_CHANGED','GUARD_ARM_FAILED','GUARD_RECEIPTS_EXPIRED','GUARD_VERSION_CHANGED','RESIDUAL_RESOURCE_REVIEW_REQUIRED'])assert.equal(safePreflightFailure(new SessionError(code)),code);
 for(const code of ['HYPERSTACK_FLAVOR_UNAVAILABLE','HYPERSTACK_IMAGE_INCOMPATIBLE','HYPERSTACK_COMPATIBILITY_UNVERIFIED','HYPERSTACK_PRICE_EXPIRING','HYPERSTACK_INVENTORY_INCOMPLETE','HYPERSTACK_REQUEST_UNCONFIRMED']){assert.equal(safePreflightFailure(Error(code)),code);assert.equal(safePreflightFailure({code}),code);}
});
test('preflight reuses the existing exact safe TailFailure whitelist',()=>{
 for(const code of ['TOKEN_FORMAT','GUARD_TIMEOUT','VERSIONS_READ_HTTP_403','TAIL_UPGRADE_HTTP_502','TAIL_SOCKET_CLOSE_1006','GUARD_DEPLOYMENT_CHANGED'])assert.equal(safePreflightFailure(Object.assign(Error('DUMMY_PRIVATE_MESSAGE'),{code})),code);
});
test('arbitrary errors, lookalike codes, secrets and raw messages remain generic',()=>{
 const secret='DUMMY_PRIVATE_CONTROL_KEY';
 for(const error of [Error(secret),new SessionError(secret),{code:secret,message:secret},{code:'HYPERSTACK_'+secret,message:secret},Error('HYPERSTACK_FLAVOR_UNAVAILABLE '+secret),{code:'TAIL_CREATE_HTTP_403_'+secret},null,secret]){
  assert.equal(safePreflightFailure(error),'PREFLIGHT_FAILED');assert(!JSON.stringify(safePreflightFailure(error)).includes(secret));
 }
});
