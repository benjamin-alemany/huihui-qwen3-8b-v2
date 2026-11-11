import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {buildBootstrapBundle} from './bootstrap-pack.mjs';
import {BOOTSTRAP_FILES,RUNTIME_FILES} from './bootstrap-render.mjs';
test('fixed source packaging is deterministic, excludes unrelated secrets and refuses symlinks',async()=>{
 const root=await mkdtemp(join(tmpdir(),'unjailed-bundle-'));
 try{
  for(const name of [...BOOTSTRAP_FILES,...RUNTIME_FILES]){const file=join(root,'vm',name);await mkdir(dirname(file),{recursive:true});await writeFile(file,'dummy '+name);}
  await writeFile(join(root,'vm','.env'),'DUMMY_SECRET_NOT_FOR_ARTIFACT');const first=await buildBootstrapBundle(root),second=await buildBootstrapBundle(root);assert(first.bytes.equals(second.bytes));assert.equal(first.sha256,second.sha256);const doc=JSON.parse(gunzipSync(first.bytes));assert.equal(Object.keys(doc.files).length,27);assert(!JSON.stringify(doc).includes('DUMMY_SECRET'));assert(!('.env'in doc.files));
  await unlink(join(root,'vm','bootstrap.py'));await symlink(join(root,'vm','.env'),join(root,'vm','bootstrap.py'));await assert.rejects(buildBootstrapBundle(root),/SOURCE_FILE_REFUSED/);
 }finally{await rm(root,{recursive:true,force:true});}
});
