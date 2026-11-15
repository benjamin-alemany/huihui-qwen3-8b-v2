import manifest from '../../../release/host-inventory.json' with {type:'json'};
import payload from '../../../release/host-inventory-payload.json' with {type:'json'};
import {hostInventoryReleaseApproved} from '../../../release/approval.mjs';
import {canonicalHostInventorySource,renderHostInventory} from './host-inventory-render.mjs';

export const HOST_INVENTORY_RELEASE=manifest;
export const HOST_INVENTORY_PAYLOAD=payload;
export function hostInventoryBootstrapReady(release,bundle){
 try{
  return hostInventoryReleaseApproved(release)&&bundle&&Object.keys(bundle).sort().join()==='sha256,source'&&
   bundle.sha256===release.artifact.bootstrapBundleSha256&&bundle.sha256===release.artifact.bootstrapLockSha256&&
   new TextEncoder().encode(canonicalHostInventorySource(bundle.source)).byteLength===release.artifact.bootstrapBundleSize;
 }catch{return false;}
}
// BoundBootstrapFor rereads and validates the durable session before/after this
// callback. Only its public identity is forwarded; all generated inference
// keys and any legacy tunnel credential remain in the controller.
export async function renderBoundHostInventory({reservation,session,release,bundle,now}){
 if(!hostInventoryBootstrapReady(release,bundle))throw Error('HOST_INVENTORY_SOURCE_UNPINNED');
 return renderHostInventory({reservation,sessionId:session.id,source:bundle.source,sourceSHA256:release.artifact.bootstrapBundleSha256,now});
}
