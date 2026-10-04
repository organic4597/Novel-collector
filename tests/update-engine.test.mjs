import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,mkdir,writeFile,readFile,rm,symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { extractSource,activate,privateBackup,restorePrivate,rollback,transactionId } from "../src/update-engine.mjs";
import { renameRetry,atomicJson,readJson } from "../src/update-files.mjs";
import { recover } from "../tools/recover-update.mjs";
const sources={"run.mjs":"export const updated=true;","package.json":JSON.stringify({name:"novel-collector"}),"package-lock.json":"{}","src/server.mjs":"export const server=true;","src/updates.mjs":"export const updates=true;","tools/update.mjs":"export const updater=true;"};
async function zip(extra={}){const archive=new JSZip();for(const [path,value] of Object.entries({...sources,...extra}))archive.file("release/"+path,value);return archive.generateAsync({type:"nodebuffer",compression:"DEFLATE"});}
async function fixture(t){const root=await mkdtemp(join(tmpdir(),"update-engine-"));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(join(root,"run.mjs"),"OLD_SOURCE");for(const path of ["data","secrets","profile"]){await mkdir(join(root,path));await writeFile(join(root,path,"user.json"),"PRIVATE_"+path);}await writeFile(join(root,".env"),"PRIVATE_ENV");return root;}
test("source replacement never overlays DB, credentials, profiles or local environment files",async t=>{
  const root=await fixture(t),id=transactionId(),stage=join(root,".updates",id,"source"),files=await extractSource(await zip(),stage);
  await privateBackup(root,join(root,".updates","backups",id));await activate(root,{id,stage,files,version:"1.0.0.1"});
  assert.equal(await readFile(join(root,"run.mjs"),"utf8"),sources["run.mjs"]);
  for(const p of ["data","secrets","profile"])assert.equal(await readFile(join(root,p,"user.json"),"utf8"),"PRIVATE_"+p);
  assert.equal(await readFile(join(root,".env"),"utf8"),"PRIVATE_ENV");assert.equal((await readJson(join(root,".updates","installed-version.json"))).version,"1.0.0.1");
});
test("archives cannot assign private paths, escape via traversal or introduce symlinks",async t=>{
  const root=await fixture(t);
  for(const key of ["data/db.json","secrets/key",".env","profile/auth.json","../src/private.mjs"])
    await assert.rejects(extractSource(await zip({[key]:"MUST_NOT_WRITE"}),join(root,"staging-"+Math.random())));
  const archive=new JSZip();archive.file("release/src/link.mjs","/private",{unixPermissions:0o120777});
  await assert.rejects(extractSource(await archive.generateAsync({type:"nodebuffer",platform:"UNIX"}),join(root,"link-stage")));
  assert.equal(await readFile(join(root,"data","user.json"),"utf8"),"PRIVATE_data");
});
test("partial file swap failure restores old source and keeps every private canary",async t=>{
  const root=await fixture(t),id=transactionId(),stage=join(root,".updates",id,"source"),files=await extractSource(await zip(),stage);
  await assert.rejects(activate(root,{id,stage,files,version:"1.0.0.1"},{onStep:path=>{if(path==="run.mjs")throw Error("simulated interruption");}}));
  assert.equal(await readFile(join(root,"run.mjs"),"utf8"),"OLD_SOURCE");for(const p of ["data","secrets","profile"])assert.equal(await readFile(join(root,p,"user.json"),"utf8"),"PRIVATE_"+p);
});
test("crash recovery works without external dependencies, and failed-start private backup can be restored",async t=>{
  const root=await fixture(t),id=transactionId(),stage=join(root,".updates",id,"source"),files=await extractSource(await zip(),stage);
  await privateBackup(root,join(root,".updates","backups",id));await activate(root,{id,stage,files,version:"1.0.0.1"});await recover(root);
  assert.equal(await readFile(join(root,"run.mjs"),"utf8"),"OLD_SOURCE");await writeFile(join(root,"data","user.json"),"FAILED_NEW_DATA");await restorePrivate(root,id);
  assert.equal(await readFile(join(root,"data","user.json"),"utf8"),"PRIVATE_data");
});
test("a modified managed source is refused, and Windows sharing violations are retried",async t=>{
  const root=await fixture(t),id=transactionId(),stage=join(root,".updates",id,"source"),files=await extractSource(await zip(),stage);
  await atomicJson(join(root,".updates","managed-source.json"),{files:{"run.mjs":"a".repeat(64)}});await assert.rejects(activate(root,{id,stage,files,version:"1.0.0.1"}));
  let attempts=0;await renameRetry("old","new",{platform:"win32",move:async()=>{if(++attempts<3)throw Object.assign(Error("busy"),{code:"EPERM"});}});assert.equal(attempts,3);
});
