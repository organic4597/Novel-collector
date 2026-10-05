import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,mkdir,writeFile,chmod,lstat,symlink,rm,cp } from "node:fs/promises";
import {pathToFileURL} from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertUpdatePermissions } from "../src/update-files.mjs";
import { prepareInstallPermissions } from "../tools/install-runtime.mjs";
const exec=promisify(execFile);
const modules=new Map();
const linux=process.platform==="linux";
const rootUser=process.geteuid?.()===0;
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),"update permissions "));
  const code=await mkdtemp(join(tmpdir(),"permission test modules "));await chmod(code,0o755);
  await cp(new URL("../src",import.meta.url),join(code,"src"),{recursive:true});modules.set(root,code);
  t.after(async()=>{modules.delete(root);await rm(root,{recursive:true,force:true});await rm(code,{recursive:true,force:true});});await chmod(root,0o755);return root;
}
async function checkAsUser(root){
  const script=`import {assertUpdatePermissions} from ${JSON.stringify(pathToFileURL(join(modules.get(root),"src","update-files.mjs")).href)};try{await assertUpdatePermissions(process.argv[1]);console.log('OK');}catch(e){console.log(e.code);}`;
  return (await exec(process.execPath,["--input-type=module","-e",script,root],rootUser?{uid:65534,gid:65534}:{})).stdout.trim();
}
test("update preflight accepts a writable installation and skips browser cache and profile symlinks",async t=>{
  const root=await fixture(t);await mkdir(join(root,"profile","playwright-browsers"),{recursive:true});
  await writeFile(join(root,"profile","playwright-browsers","cache"),"CACHE");await chmod(join(root,"profile","playwright-browsers"),0o000);
  if(linux)await symlink("/missing-synthetic-lock",join(root,"profile","SingletonLock"));
  await assertUpdatePermissions(root);
});
test("a root-owned private verification file is rejected before backup without leaking its name",{skip:!linux},async t=>{
  const root=await fixture(t);await chmod(root,0o777);await mkdir(join(root,"data"),{mode:0o755});
  const path=join(root,"data","PRIVATE_SYNTHETIC_NAME.txt");await writeFile(path,"PRIVATE_CANARY",{mode:rootUser?0o600:0o000});
  assert.equal(await checkAsUser(root),"PRIVATE_NOT_READABLE");
});
test("a root-owned runtime directory is rejected before source activation",{skip:!linux},async t=>{
  const root=await fixture(t);await chmod(root,0o777);await mkdir(join(root,"node_modules"),{mode:rootUser?0o755:0o500});
  assert.equal(await checkAsUser(root),"INSTALL_NOT_WRITABLE");
});
for(const kind of ["private","runtime"])test(`the apply API rejects ${kind} permissions before launching or stopping a worker`,{skip:!linux},async t=>{
  const root=await fixture(t);await chmod(root,0o777);
  if(kind==="private"){await mkdir(join(root,"data"),{mode:0o755});await writeFile(join(root,"data","canary"),"PRIVATE_CANARY",{mode:rootUser?0o600:0o000});}
  else await mkdir(join(root,"node_modules"),{mode:rootUser?0o755:0o500});
  const script=`import{Updates}from ${JSON.stringify(pathToFileURL(join(modules.get(root),"src","updates.mjs")).href)};import{APP_VERSION,versionParts}from ${JSON.stringify(pathToFileURL(join(modules.get(root),"src","version.mjs")).href)};const parts=versionParts(APP_VERSION);parts[3]++;const version=parts.join('.');let launches=0,stops=0;const updates=new Updates({rootDir:process.argv[1],launch:()=>{launches++;}});updates.cached={checkedAt:Date.now(),release:{version,download:'synthetic'}};updates.onReady=async()=>{stops++;};try{await updates.apply(version);}catch(e){console.log(JSON.stringify({status:e.status,step:e.step,errorCode:e.errorCode,launches,stops}));}`;
  const env={...process.env};delete env.INVOCATION_ID;
  const {stdout}=await exec(process.execPath,["--input-type=module","-e",script,root],{env,...(rootUser?{uid:65534,gid:65534}:{})});
  assert.deepEqual(JSON.parse(stdout),{status:503,step:kind==="private"?"CHECK_BACKUP_PERMISSION":"CHECK_WRITE_PERMISSION",errorCode:kind==="private"?"PRIVATE_NOT_READABLE":"INSTALL_NOT_WRITABLE",launches:0,stops:0});
});
test("installation shares source and runtime with the service group and keeps private files service-owned and owner-only",{skip:!linux||!rootUser},async t=>{
  const root=await fixture(t),outside=await fixture(t);await mkdir(join(root,".git"));
  for(const path of ["node_modules",".venv-captcha","data","secrets","profile","src"]){await mkdir(join(root,path));await writeFile(join(root,path,"canary"),"CANARY",{mode:0o600});}
  await symlink(outside,join(root,"profile","external"));await prepareInstallPermissions(root,{uid:65534,gid:65534});
  assert.equal((await lstat(root)).uid,0);assert.equal((await lstat(join(root,"node_modules"))).uid,0);
  assert.equal((await lstat(join(root,"data","canary"))).mode&0o777,0o600);
  assert.equal((await lstat(join(root,"data","canary"))).uid,65534);
  assert.equal((await lstat(join(root,"data","canary"))).gid,65534);
  assert.equal((await lstat(join(root,"data"))).mode&0o2000,0o2000);
  assert.equal((await lstat(join(root,".git"))).uid,0);assert.equal((await lstat(outside)).uid,0);
  assert.equal(await checkAsUser(root),"OK");
  const script=`import {rename,mkdir,chmod} from 'node:fs/promises';import {join} from 'node:path';const root=process.argv[1];await mkdir(join(root,'backup'));await rename(join(root,'node_modules'),join(root,'backup','node_modules'));await chmod(join(root,'secrets','canary'),0o600);console.log('OK');`;
  assert.equal((await exec(process.execPath,["--input-type=module","-e",script,root],{uid:65534,gid:65534})).stdout.trim(),"OK");
});
