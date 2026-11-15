// Local/CI build helper only; never imported by the Worker runtime. Reads only
// the renderer's fixed credential-free source list. No cloud/network operation.
import {readFile,lstat,writeFile,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {BOOTSTRAP_FILES,RUNTIME_FILES} from './bootstrap-render.mjs';
const sha=raw=>createHash('sha256').update(raw).digest('hex');
const canonical=o=>JSON.stringify(o,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
export async function buildBootstrapBundle(repoRoot){
  const files={},fileHashes={};let lock;
  for(const path of [resolve(repoRoot,'vm'),resolve(repoRoot,'vm','keys')]){const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink())throw Error('BOOTSTRAP_SOURCE_DIRECTORY_REFUSED');}
  for(const name of [...BOOTSTRAP_FILES,...RUNTIME_FILES].sort()){
    const path=resolve(repoRoot,'vm',name),info=await lstat(path);
    if(!info.isFile()||info.isSymbolicLink()||info.size<=0||info.size>128*1024)throw Error('BOOTSTRAP_SOURCE_FILE_REFUSED');
    const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);let raw;
    try{const checked=await handle.stat();if(!checked.isFile()||checked.size!==info.size||checked.ino!==info.ino||checked.dev!==info.dev)throw Error('BOOTSTRAP_SOURCE_CHANGED');raw=await handle.readFile();}finally{await handle.close();}
    if(raw.length!==info.size)throw Error('BOOTSTRAP_SOURCE_CHANGED');
    files[name]=raw.toString('base64');fileHashes[name]=sha(raw);if(name==='packages.lock.json')lock=fileHashes[name];
  }
  const expanded=Buffer.from(canonical({version:1,files}));if(expanded.length>256*1024)throw Error('BOOTSTRAP_SOURCE_LIMIT');
  const bytes=gzipSync(expanded,{level:9,mtime:0});if(bytes.length>256*1024)throw Error('BOOTSTRAP_SOURCE_LIMIT');
  return {bytes,sha256:sha(bytes),size:bytes.length,bootstrapLockSha256:lock,fileHashes};
}
async function main(){
  if(process.argv.length!==3||!['--write','--check'].includes(process.argv[2]))throw Error('Use --write or --check; target is fixed release/bootstrap.bundle.json.gz');
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),output=resolve(root,'release/bootstrap.bundle.json.gz'),payload=resolve(root,'release/bootstrap-payload.json'),bundle=await buildBootstrapBundle(root);
  const embedded=canonical({sha256:bundle.sha256,gzipBase64:bundle.bytes.toString('base64')})+'\n';
  if(process.argv[2]==='--write'){await writeFile(output,bundle.bytes,{mode:0o644});await writeFile(payload,embedded,{mode:0o644});}
  else if(!bundle.bytes.equals(await readFile(output))||embedded!==await readFile(payload,'utf8'))throw Error('BOOTSTRAP_ARTIFACT_DIFFERS_FROM_SOURCE');
  console.log(JSON.stringify({sha256:bundle.sha256,size:bundle.size,bootstrapLockSha256:bundle.bootstrapLockSha256,files:Object.keys(bundle.fileHashes).length}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('Bootstrap source bundle refused');process.exitCode=1;});
