import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import release from '../../../release/manifest.json' with {type:'json'};
import {BOOTSTRAP_FILES,RUNTIME_FILES,bootstrapRenderReady,renderCloudInit} from './bootstrap-render.mjs';
import {hyperstackLifecycle} from './controller-policy.mjs';
import {NOW,TARGET} from './fixtures.mjs';
const digest=raw=>createHash('sha256').update(raw).digest('hex');
const canonical=o=>JSON.stringify(o,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
function bundleOf(files,text){const expanded=text??canonical({version:1,files}),compressed=gzipSync(expanded,{mtime:0});return {sha256:digest(compressed),gzipBase64:compressed.toString('base64')};}
function fixture({runtime=false,files:override}={}){
 const files=Object.fromEntries([...BOOTSTRAP_FILES,...(runtime?RUNTIME_FILES:[])].map(n=>[n,Buffer.from(n==='packages.lock.json'?'{}':`dummy fixed ${n}\n`).toString('base64')]));Object.assign(files,override);
 const bundle=bundleOf(files),pinned={...structuredClone(release),status:'candidate',artifact:{...release.artifact,servingImage:'ghcr.io/benjamin-alemany/huihui-qwen3-8b-v2@sha256:'+'a'.repeat(64),bootstrapLockSha256:digest(Buffer.from('{}')),bootstrapBundleSha256:bundle.sha256,bootstrapSourceCommit:'f'.repeat(40),bootstrapBundleSize:Buffer.from(bundle.gzipBase64,'base64').length,runtimeOrchestrator:runtime?'vm-run-v1':null},hosting:{...release.hosting,vmImageId:33}},reservation=hyperstackLifecycle({target:TARGET,release:pinned}).reservation(NOW,'a'.repeat(32),30);
 const session={id:'11111111-1111-4111-8111-111111111111',nonce:reservation.nonce,phase:'reconciling',createAttempted:true,stopRequested:false,inferenceKey:'c'.repeat(64),modelKey:'d'.repeat(64),reservation:structuredClone(reservation),bootAt:NOW,deadline:reservation.deadline,quote:{minutes:30}};
 return {reservation,session,release:pinned,bundle,hostTunnelCredential:{TunnelID:'22222222-2222-4222-8222-222222222222',AccountTag:'3'.repeat(32),TunnelSecret:Buffer.alloc(32,4).toString('base64')},now:NOW,files};
}
function rebind(f,bundle){f.bundle=bundle;f.release.artifact.bootstrapBundleSha256=bundle.sha256;f.release.artifact.bootstrapBundleSize=Buffer.from(bundle.gzipBase64,'base64').length;}
function config(text){assert(text.startsWith('#cloud-config\n'));return JSON.parse(text.slice(text.indexOf('\n')+1));}
function writes(c){return Object.fromEntries(c.write_files.map(f=>[f.path,Buffer.from(f.content,'base64')]));}
function hostVerify(source,bundle,lock){
 const command="import base64,json,sys\nx=json.load(sys.stdin);scope={'__name__':'fixture'};exec(x['source'],scope);scope['verify_bundle'](base64.b64decode(x['bundle']),x['sha'],x['lock']);print('VERIFIED')";
 return spawnSync('python3',['-I','-c',command],{encoding:'utf8',input:JSON.stringify({source,bundle:bundle.gzipBase64,sha:bundle.sha256,lock}),timeout:5000});
}
test('pure renderer stages a bounded bootstrap with unknown provider IDs and immutable logical binding',async()=>{
 const f=fixture(),text=await renderCloudInit(f),c=config(text),w=writes(c);assert(bootstrapRenderReady(f.release,f.bundle));assert.equal(Math.ceil(Buffer.byteLength(text)/3)*4<=65535,true);
 const m=JSON.parse(w['/etc/unjailed/session.json']);assert.deepEqual(m.resources,{vmId:null,publicIpAddress:null,volumeIds:[]});assert.equal(m.sessionId,f.session.id);assert.equal(m.nonce,f.reservation.nonce);assert.equal(m.image,f.reservation.image);assert.equal(Date.parse(m.deadlineUTC),f.reservation.deadline);
 assert.deepEqual(c.runcmd,[['/usr/bin/python3','-I','-B','/var/lib/unjailed/install-bootstrap.py']]);assert.equal(c.ssh_pwauth,false);assert.deepEqual(c.bootcmd,[['/usr/bin/systemctl','mask','--now','ssh.service','ssh.socket']]);assert(c.write_files.every(x=>x.owner==='root:root'&&x.permissions==='0600'));
 const script=w['/var/lib/unjailed/install-bootstrap.py'].toString();assert(script.includes("EXPECTED['sessionSHA256']"));assert(script.includes('HOST_READY_MODEL_NOT_STARTED'));assert(script.includes("'/opt/unjailed/vm/bootstrap.py','--execute'"));assert(!script.includes('shell=True'));assert(!script.includes('tarfile'));assert(!script.includes('docker run'));
});
test('model sees model key only; outer gateway and named tunnel credentials stay in host files',async()=>{
 const f=fixture(),w=writes(config(await renderCloudInit(f))),env=w['/etc/unjailed/inference.env'].toString(),gateway=JSON.parse(w['/etc/unjailed/gateway.json']);assert(env.includes('VLLM_API_KEY='+f.session.modelKey));assert(!env.includes(f.session.inferenceKey));assert.equal(gateway.gatewayKey,f.session.inferenceKey);assert.equal(gateway.modelKey,f.session.modelKey);assert.equal(gateway.bootstrapBundleSha256,f.bundle.sha256);
 for(const p of ['/etc/unjailed/session.json','/etc/unjailed/tunnel.json','/etc/unjailed/tunnel.yml','/var/lib/unjailed/install-bootstrap.py']){assert(!w[p].toString().includes(f.session.inferenceKey));assert(!w[p].toString().includes(f.session.modelKey));}
 const tunnel=w['/etc/unjailed/tunnel.yml'].toString();assert(tunnel.includes('service: http://127.0.0.1:8765'));assert(!tunnel.includes('8000'));assert(tunnel.includes('/run/credentials/unjailed-tunnel.service/tunnel.json'));assert(tunnel.endsWith('  - service: http_status:404\n'));
 const script=w['/var/lib/unjailed/install-bootstrap.py'].toString();assert(script.includes("os.chmod('/etc/unjailed/gateway.json',0o640)"));assert(!script.includes("os.chmod('/etc/unjailed/tunnel.json',0o644)"));
});
test('minimal session contract rejects secrets/budgets/commands and cancellation or changed binding',async()=>{
 for(const mutate of [x=>{x.session.providerKey='NEVER_REFLECT_DUMMY';},x=>{x.session.ledger={cap:10};},x=>{x.session.stopRequested=true;},x=>{x.session.phase='ready';},x=>{x.session.createAttempted=false;},x=>{x.session.nonce='b'.repeat(32);},x=>{x.session.deadline+=1;},x=>{x.session.quote.maximumUSD=1;},x=>{x.session.modelKey=x.session.inferenceKey;},x=>{x.now=x.reservation.createdNotAfter+1;}]){const x=fixture();mutate(x);await assert.rejects(renderCloudInit(x),e=>!e.message.includes('NEVER_REFLECT_DUMMY'));}
});
test('bundle, package lock and immutable release pins are independently checked',async()=>{
 for(const mutate of [x=>{x.release.artifact.bootstrapBundleSha256='0'.repeat(64);},x=>{x.release.artifact.bootstrapLockSha256='0'.repeat(64);},x=>{x.release.artifact.servingImage='image:latest';},x=>{const raw=Buffer.from(x.bundle.gzipBase64,'base64');raw[raw.length-3]^=1;x.bundle.gzipBase64=raw.toString('base64');},x=>{x.bundle.sha256='0'.repeat(64);x.release.artifact.bootstrapBundleSha256=x.bundle.sha256;}]){const x=fixture();mutate(x);await assert.rejects(renderCloudInit(x));}
 assert.equal(bootstrapRenderReady(release,null),false);
});
test('fixed file map refuses traversal, unknown paths, missing bootstrap and duplicate JSON keys',async()=>{
 for(const extra of ['../escape.py','/etc/shadow','keys/../../bad','unreviewed.py']){const x=fixture();x.files[extra]=Buffer.from('bad').toString('base64');rebind(x,bundleOf(x.files));await assert.rejects(renderCloudInit(x),/BOOTSTRAP_FILE_SET_INVALID/);}
 const x=fixture();delete x.files['bootstrap.py'];rebind(x,bundleOf(x.files));await assert.rejects(renderCloudInit(x));
 const y=fixture(),text=canonical({version:1,files:y.files}),duplicate=text.replace('"version":1','"version":1,"version":1');rebind(y,bundleOf(null,duplicate));await assert.rejects(renderCloudInit(y),/BOOTSTRAP_BUNDLE_INVALID/);
});
test('bounded gzip and userdata limits reject expansion bombs and oversized opaque credentials',async()=>{
 const x=fixture();rebind(x,bundleOf(null,' '.repeat(300000)));await assert.rejects(renderCloudInit(x),/BOOTSTRAP_BUNDLE_INVALID/);
 const y=fixture();y.hostTunnelCredential.TunnelSecret='A'.repeat(1000000);await assert.rejects(renderCloudInit(y));
});
test('Python host verifier independently checks canonical JSON, fixed paths, hashes and expansion bound without executing install',async()=>{
 const x=fixture(),source=writes(config(await renderCloudInit(x)))['/var/lib/unjailed/install-bootstrap.py'].toString();const good=hostVerify(source,x.bundle,x.release.artifact.bootstrapLockSha256);assert.equal(good.status,0,good.stderr);assert.match(good.stdout,/VERIFIED/);
 const badFiles={...x.files,'../escape.py':Buffer.from('bad').toString('base64')};assert.notEqual(hostVerify(source,bundleOf(badFiles),x.release.artifact.bootstrapLockSha256).status,0);
 const duplicate=bundleOf(null,canonical({version:1,files:x.files}).replace('"version":1','"version":1,"version":1'));assert.notEqual(hostVerify(source,duplicate,x.release.artifact.bootstrapLockSha256).status,0);
 assert.notEqual(hostVerify(source,bundleOf(null,' '.repeat(300000)),x.release.artifact.bootstrapLockSha256).status,0);assert.notEqual(hostVerify(source,x.bundle,'0'.repeat(64)).status,0);
});
test('runtime activation requires a source pin and complete fixed runtime file set',async()=>{
 const x=fixture();x.release.artifact.runtimeOrchestrator='vm-run-v1';await assert.rejects(renderCloudInit(x),/BOOTSTRAP_RUNTIME_FILES_MISSING/);
 const y=fixture({runtime:true}),source=writes(config(await renderCloudInit(y)))['/var/lib/unjailed/install-bootstrap.py'].toString();assert(source.includes("'unjailed-runtime.service'"));assert(!source.includes("'enable','--now','unjailed-runtime.service'"));
 const z=fixture();z.release.artifact.runtimeOrchestrator='unreviewed';await assert.rejects(renderCloudInit(z));
});
test('local-managed named tunnel credential has one bounded typed format',async()=>{
 for(const value of ['opaque-token',{token:'opaque'},{...fixture().hostTunnelCredential,command:'run arbitrary'}, {...fixture().hostTunnelCredential,TunnelID:'../../bad'}, {...fixture().hostTunnelCredential,AccountTag:'bad'},{...fixture().hostTunnelCredential,TunnelSecret:Buffer.alloc(31).toString('base64')}]){const x=fixture();x.hostTunnelCredential=value;await assert.rejects(renderCloudInit(x));}
});
test('rendered logical manifest and separated gateway config pass the actual host parsers',async()=>{
 const f=fixture(),w=writes(config(await renderCloudInit(f))),payload={manifest:JSON.parse(w['/etc/unjailed/session.json']),gateway:JSON.parse(w['/etc/unjailed/gateway.json'])};
 const command="import json,sys\nsys.path.insert(0,sys.argv[1]);from host_policy import manifest_from;from gateway import config_from\nx=json.load(sys.stdin);manifest_from(x['manifest']);config_from(x['gateway']);print('HOST_CONTRACT_VALIDATED')";
 const result=spawnSync('python3',['-I','-B','-c',command,fileURLToPath(new URL('../../../vm/',import.meta.url))],{input:JSON.stringify(payload),encoding:'utf8',timeout:5000});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/HOST_CONTRACT_VALIDATED/);
});
test('full real source bundle uses only commit-pinned remote download and stays below userdata limit',async()=>{
 const f=fixture({runtime:true}),files=Object.fromEntries([...BOOTSTRAP_FILES,...RUNTIME_FILES].map(name=>[name,readFileSync(new URL('../../../vm/'+name,import.meta.url)).toString('base64')]));rebind(f,bundleOf(files));f.release.artifact.bootstrapLockSha256=digest(Buffer.from(files['packages.lock.json'],'base64'));
 assert(f.bundle.gzipBase64.length>65535,'real inline bundle should exercise the size blocker');const text=await renderCloudInit(f),c=config(text),w=writes(c);assert(Math.ceil(Buffer.byteLength(text)/3)*4<=65535);assert(!c.write_files.some(x=>x.path==='/var/lib/unjailed/bootstrap-bundle.gz'));assert(!text.includes(f.bundle.gzipBase64));assert(w['/var/lib/unjailed/install-bootstrap.py'].toString().includes('https://raw.githubusercontent.com/benjamin-alemany/huihui-qwen3-8b-v2/'));
});
test('remote source accepts one pinned commit/path only and rejects arbitrary refs or caller URLs',async()=>{
 for(const ref of ['main','latest','../bad','f'.repeat(39),'f'.repeat(40)+'/../other','https://attacker.invalid']){const f=fixture();f.release.artifact.bootstrapSourceCommit=ref;assert.equal(bootstrapRenderReady(f.release,f.bundle),false);await assert.rejects(renderCloudInit(f));}
 const f=fixture();f.bundle.url='https://attacker.invalid/bundle';await assert.rejects(renderCloudInit(f));const g=fixture();g.release.artifact.bootstrapBundleSize+=1;await assert.rejects(renderCloudInit(g));
});
test('host remote downloader checks fixed HTTPS URL, no redirect, exact size and hash with fake transport',async()=>{
 const f=fixture(),source=writes(config(await renderCloudInit(f)))['/var/lib/unjailed/install-bootstrap.py'].toString();
 const command="import base64,json,sys\nx=json.load(sys.stdin);scope={'__name__':'fixture'};exec(x['source'],scope)\nclass Reply:\n status=x['status']\n def __enter__(self):return self\n def __exit__(self,*_):pass\n def geturl(self):return x['url'] or self.request.full_url\n def read(self,n):return base64.b64decode(x['data'])[:n]\nclass Opener:\n def open(self,request,timeout):\n  assert timeout==25;assert request.method=='GET';assert not request.has_header('Authorization');assert not request.has_header('api_key');r=Reply();r.request=request;return r\nscope['download_bundle'](Opener());print('PINNED_FETCH_VERIFIED')";
 const attempt=(patch={})=>spawnSync('python3',['-I','-c',command],{input:JSON.stringify({source,status:200,url:null,data:f.bundle.gzipBase64,...patch}),encoding:'utf8',timeout:5000});assert.equal(attempt().status,0);
 for(const patch of [{status:302},{url:'https://attacker.invalid/bundle'},{url:'http://raw.githubusercontent.com/bundle'},{data:Buffer.from('wrong').toString('base64')}])assert.notEqual(attempt(patch).status,0);
});
