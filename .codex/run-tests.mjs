import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {preflight,root} from './preflight.mjs';
preflight();
const suite=process.argv[2]??'all';if(!['all','node','chat','controller','guard'].includes(suite)||process.argv.length>3)throw Error('Unknown test suite');
const temporary=mkdtempSync(join(tmpdir(),'unjailed-tests-'));
const env={PATH:dirname(process.execPath)+':/usr/bin:/bin:/usr/sbin:/sbin',TMPDIR:temporary,CI:'1',WRANGLER_SEND_METRICS:'false',WRANGLER_LOG_PATH:join(temporary,'wrangler.log'),UNJAILED_TEST_VIOLATION_FILE:join(temporary,'unexpected-outbound'),NODE_OPTIONS:'--import='+pathToFileURL(join(root,'.codex/deny-fetch.mjs')).href};
let command,args;
if(process.platform==='darwin'){
 const denied=['.codex','.ssh','.aws','.config','.docker','Library'].map(p=>'(subpath '+JSON.stringify(join(homedir(),p))+')').join('\n');
 const profile=join(temporary,'offline.sb');
 writeFileSync(profile,`(version 1)\n(allow default)\n(deny network*)\n(allow network-bind (local ip "localhost:*"))\n(allow network-inbound (local ip "localhost:*"))\n(allow network-outbound (remote ip "localhost:*"))\n(deny file-read* ${denied})\n`);
 command='/usr/bin/sandbox-exec';args=['-f',profile,process.execPath];
}else if(process.platform==='linux'){
 // Namespace creation failure is fatal. Never fall back to unrestricted tests.
 command='unshare';args=['--user','--map-root-user','--net','--','/bin/sh','-eu','-c','ip link set lo up; exec "$@"','unjailed-tests',process.execPath];
}else throw Error('No verified OS network isolation adapter for this platform');
try{
 const r=spawnSync(command,[...args,join(root,'.codex/test-inner.mjs'),suite],{cwd:root,env,stdio:'inherit'});
 if(r.error)throw r.error;
 process.exitCode=r.status??1;
}finally{rmSync(temporary,{recursive:true,force:true});}
