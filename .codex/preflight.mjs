import {readdirSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
export const root=fileURLToPath(new URL('../',import.meta.url));
export function preflight(env=process.env,base=root){
 const [major,minor]=process.versions.node.split('.').map(Number);
 if(major<22||(major===22&&minor<12))throw Error('Use Node 22.12+');
 // Report variable names only. Never print their values.
 const keys=Object.keys(env).filter(k=>env[k]&&(/(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|AUTH_SOCK)(?:$|_)/i.test(k)||/^AWS_(?:ACCESS|SECRET|SESSION)/.test(k)));
 if(keys.length)throw Error('Refusing credential-bearing environment: '+keys.join(', '));
 function walk(dir){for(const e of readdirSync(dir,{withFileTypes:true})){
  if(['.git','node_modules','.wrangler'].includes(e.name))continue;
  if(/^\.(?:env|dev\.vars)(?:\.|$)/.test(e.name)||e.name==='.secrets'||e.name==='.npmrc'||/\.secret(?:\.|$)/.test(e.name))throw Error('Refusing local secret/config file; use a fresh credential-free checkout');
  if(e.isDirectory())walk(resolve(dir,e.name));
 }}walk(base);
 const lock=JSON.parse(readFileSync(resolve(base,'cloudflare-backup/package-lock.json'),'utf8'));
 for(const [name,p]of Object.entries(lock.packages)){
  if(!name)continue;
  if(typeof p.resolved!=='string'||!p.resolved.startsWith('https://registry.npmjs.org/')||!/^sha512-[A-Za-z0-9+/=]+$/.test(p.integrity??''))throw Error('Only integrity-pinned npm registry packages are allowed');
 }
}
if(process.argv[1]===fileURLToPath(import.meta.url)){preflight();console.log('Credential/config and lockfile preflight passed.');}
