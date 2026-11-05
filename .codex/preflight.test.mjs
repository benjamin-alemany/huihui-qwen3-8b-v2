import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {preflight} from './preflight.mjs';
import {spawnSync} from 'node:child_process';
test('an unexpected Node fetch makes the process fail even if its exception is caught',()=>{const r=spawnSync(process.execPath,['--import',new URL('./deny-fetch.mjs',import.meta.url).href,'--input-type=module','-e','await fetch("https://unexpected.invalid").catch(()=>{})'],{encoding:'utf8'});assert.equal(r.status,1);assert.match(r.stderr,/Unexpected Node fetch attempts: 1/);});
test('a caught auxiliary Worker fetch still records a violation for the runner',()=>{
 const dir=mkdtempSync(join(tmpdir(),'outbound-denial-')),marker=join(dir,'violation');
 const code=`import {Miniflare,convertV4MiniflareOptions} from ${JSON.stringify(new URL('../cloudflare-backup/node_modules/miniflare/dist/src/index.js',import.meta.url).href)};import {denyOutbound} from ${JSON.stringify(new URL('../cloudflare-backup/chat/test/deny-outbound.mjs',import.meta.url).href)};const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'dummy',modules:true,compatibilityDate:'2026-10-30',script:"export default {fetch(){return fetch('https://unexpected.invalid')}}",outboundService:denyOutbound}]}));try{await mf.dispatchFetch('https://dummy.test').catch(()=>{});}finally{await mf.dispose();}`;
 try{const r=spawnSync(process.execPath,['--input-type=module','-e',code],{env:{...process.env,UNJAILED_TEST_VIOLATION_FILE:marker},encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.match(readFileSync(marker,'utf8'),/unexpected outbound request/);}finally{rmSync(dir,{recursive:true,force:true});}
});
test('refuses credential-bearing environments without printing their values',()=>{assert.throws(()=>preflight({RUNPOD_API_KEY:'PRIVATE_CANARY'}),e=>e.message.includes('RUNPOD_API_KEY')&&!e.message.includes('PRIVATE_CANARY'));assert.throws(()=>preflight({SSH_AUTH_SOCK:'/dummy'}));});
test('refuses local secret files and non-registry dependencies before execution',()=>{
 const dir=mkdtempSync(join(tmpdir(),'preflight-'));try{
  mkdirSync(join(dir,'cloudflare-backup'));writeFileSync(join(dir,'cloudflare-backup/package-lock.json'),JSON.stringify({packages:{}}));preflight({},dir);
  writeFileSync(join(dir,'.dev.vars'),'DUMMY_ONLY');assert.throws(()=>preflight({},dir),/local secret/);rmSync(join(dir,'.dev.vars'));
  writeFileSync(join(dir,'cloudflare-backup/package-lock.json'),JSON.stringify({packages:{'node_modules/bad':{resolved:'https://attacker.test/x',integrity:'sha512-abc='}}}));assert.throws(()=>preflight({},dir),/registry/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
