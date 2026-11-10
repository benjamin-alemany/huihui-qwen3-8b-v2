import net from 'node:net';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
// Fail closed if the selected OS adapter does not enforce the boundary.
await new Promise((resolve,reject)=>{
 const socket=net.connect({host:'203.0.113.1',port:443});
 const timer=setTimeout(()=>{socket.destroy();reject(Error('External TCP denial was not verified'));},1500);
 socket.once('connect',()=>{clearTimeout(timer);socket.destroy();reject(Error('External TCP unexpectedly permitted'));});
 socket.once('error',e=>{clearTimeout(timer);if(['EPERM','EACCES','ENETUNREACH'].includes(e.code))resolve();else reject(Error('Unexpected isolation probe result'));});
});
console.log('OS external-network denial verified. Running dummy-only tests.');
const commands={node:['--test','../.codex/preflight.test.mjs','chat/controller/engine.test.mjs','chat/controller/budget-reconcile.test.mjs','chat/controller/runpod.test.mjs','chat/controller/receipts.test.mjs','chat/validation/stop.test.mjs','chat/site/recovery.test.mjs']};
for(const [suite,config]of Object.entries({chat:'vitest.chat.config.mjs',controller:'vitest.chat-controller.config.mjs',guard:'vitest.chat-guard.config.mjs'}))commands[suite]=['node_modules/vitest/vitest.mjs','run','--config',config];
const suite=process.argv[2]??'all';if(!['all','inference',...Object.keys(commands)].includes(suite))throw Error('Unknown test suite');
for(const args of suite==='all'?Object.values(commands):suite==='inference'?[]:[commands[suite]]){const r=spawnSync(process.execPath,args,{cwd:new URL('../cloudflare-backup/',import.meta.url),env:process.env,stdio:'inherit'});if(r.error)throw r.error;if(r.status!==0){process.exitCode=r.status??1;break;}if(existsSync(process.env.UNJAILED_TEST_VIOLATION_FILE)){console.error('Unexpected auxiliary Worker outbound request; refusing a passing result.');process.exitCode=1;break;}}
if(!process.exitCode&&['all','inference'].includes(suite)){
 const r=spawnSync('/usr/bin/python3',['-B','-m','unittest','chat.test_chat_server','chat.test_network_boundary','chat.test_boot','chat.test_credential_boundary','chat.test_offline_cache','chat.test_cache_materialize','chat.test_cuda_diagnostic'],{cwd:new URL('../',import.meta.url),env:process.env,stdio:'inherit'});
 if(r.error)throw r.error;process.exitCode=r.status??1;
}
