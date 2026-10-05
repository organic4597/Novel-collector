import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,cp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
const exec=promisify(execFile);
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),"launcher update import "));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await cp(new URL("../run.mjs",import.meta.url),join(root,"run.mjs"));
  await mkdir(join(root,".updates"));await writeFile(join(root,".updates","lock.json"),JSON.stringify({pid:process.pid}));
  return root;
}
test("a launcher waiting for source replacement does not cache the old shared module",async t=>{
  const root=await fixture(t);await mkdir(join(root,"src"));
  await writeFile(join(root,"src","update-files.mjs"),"export function readJson(){return null;}");
  await writeFile(join(root,"src","instance-control.mjs"),"import {readJson} from './update-files.mjs';export async function stopExisting(){return readJson();}");
  await writeFile(join(root,"src","server.mjs"),"import {assertUpdatePermissions} from './update-files.mjs';export const ready=assertUpdatePermissions();");
  const wrapper=join(root,"verify.mjs");
  await writeFile(wrapper,`import assert from 'node:assert/strict';import {writeFile,rm} from 'node:fs/promises';import {waitForUpdate} from './run.mjs';await waitForUpdate(${JSON.stringify(root)},{alive:()=>true,sleep:async()=>{await writeFile(${JSON.stringify(join(root,"src","update-files.mjs"))},'export function readJson(){return null;}export function assertUpdatePermissions(){return true;}');await rm(${JSON.stringify(join(root,".updates","lock.json"))});}});const {ready}=await import('./src/server.mjs');assert.equal(ready,true);console.log('NEW_MODULE_LOADED');`);
  const result=await exec(process.execPath,[wrapper],{cwd:root});assert.match(result.stdout,/NEW_MODULE_LOADED/);
});
test("replace refuses an active update before loading any instance-control module",async t=>{
  const root=await fixture(t);
  await assert.rejects(exec(process.execPath,[join(root,"run.mjs"),"--no-setup","--replace"],{cwd:root}),error=>{
    assert.equal(error.code,1);assert.match(error.stderr,/UPDATE_BUSY/);assert.doesNotMatch(error.stderr,/ERR_MODULE_NOT_FOUND/);return true;
  });
});
