// Local credential-free source packer only. Never imports/executes Python,
// contacts a provider, approves observed host state or changes financial data.
import {readFile,writeFile,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
import {HOST_INVENTORY_FILES,canonicalHostInventorySource} from '../cloudflare-backup/chat/hyperstack/host-inventory-render.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const mode=process.argv[2],commit=process.argv[3];
if(!['--write','--check'].includes(mode)||process.argv.length>(mode==='--write'?4:3)||commit!==undefined&&!/^[a-f0-9]{40}$/.test(commit))throw Error('Use --check or --write [reviewed-source-commit]');
const source={version:1,files:{}};
for(const name of HOST_INVENTORY_FILES){
 const path=resolve(root,'vm',name),info=await lstat(path);
 if(!info.isFile()||info.isSymbolicLink()||info.size<=0||info.size>32768)throw Error('Inventory source refused');
 source.files[name]=(await readFile(path)).toString('base64');
}
const canonical=canonicalHostInventorySource(source),sha256=createHash('sha256').update(canonical).digest('hex');
const payload=JSON.stringify({sha256,source})+'\n',payloadPath=resolve(root,'release/host-inventory-payload.json'),releasePath=resolve(root,'release/host-inventory.json');
const manifest=JSON.parse(await readFile(releasePath,'utf8'));
if(mode==='--write'){
 manifest.artifact.bootstrapLockSha256=sha256;manifest.artifact.bootstrapBundleSha256=sha256;manifest.artifact.bootstrapBundleSize=Buffer.byteLength(canonical);
 if(commit!==undefined)manifest.artifact.bootstrapSourceCommit=commit;
 await writeFile(payloadPath,payload,{mode:0o644});await writeFile(releasePath,JSON.stringify(manifest,null,2)+'\n',{mode:0o644});
}else if(await readFile(payloadPath,'utf8')!==payload||manifest.artifact.bootstrapBundleSha256!==sha256||manifest.artifact.bootstrapLockSha256!==sha256||manifest.artifact.bootstrapBundleSize!==Buffer.byteLength(canonical))throw Error('Inventory source pin differs from reviewed source');
console.log(JSON.stringify({sha256,sourceBytes:Buffer.byteLength(canonical),files:HOST_INVENTORY_FILES.length,inventoryOnly:true,modelPermit:false}));
