import test from "node:test";
import assert from "node:assert/strict";
import { readFile,mkdtemp,mkdir,writeFile,rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { uvAsset,linuxDependencyCommand } from "../tools/install-runtime.mjs";
import { waitForUpdate } from "../run.mjs";
test("bootstrap chooses native portable Python tooling and distro-specific browser dependencies",()=>{
  assert.equal(uvAsset("win32","x64"),"uv-x86_64-pc-windows-msvc.zip");assert.equal(uvAsset("linux","arm64"),"uv-aarch64-unknown-linux-gnu.tar.gz");
  assert.deepEqual(linuxDependencyCommand('ID=ubuntu',"linux","/app with spaces/playwright/cli.js","/portable node/node"),["/portable node/node",["/app with spaces/playwright/cli.js","install-deps","chromium"]]);
  assert.equal(linuxDependencyCommand('ID=rocky',"linux")[0],"dnf");assert.equal(linuxDependencyCommand('ID=windows',"win32"),null);assert.throws(()=>uvAsset("darwin","x64"));
});
test("clean installers download Node with checksums and never delete user storage",async()=>{
  for(const file of ["install.sh","install.ps1"]){const text=await readFile(new URL("../"+file,import.meta.url),"utf8");assert.match(text,/SHASUMS256/);assert.match(text,/tools[\\/]install-runtime\.mjs/);assert.ok(!/rm[^\n]*(?:data|secrets|profile)|Remove-Item[^\n]*(?:data|secrets|profile)/.test(text));}
});
test("startup waits for a live updater before loading source and clears abandoned preparation locks",async t=>{
  const root=await mkdtemp(join(tmpdir(),"update-wait-"));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,".updates"));await writeFile(join(root,".updates","lock.json"),JSON.stringify({pid:12345}));
  let checks=0;await waitForUpdate(root,{alive:()=>++checks<3,sleep:async()=>{}});assert.equal(checks,3);
  assert.equal(JSON.parse(await readFile(join(root,".updates","job.json"))).state,"failed");
});
test("a live verification worker does not block the new server, but an abandoned verification is cleared",async t=>{
  const root=await mkdtemp(join(tmpdir(),"verification-wait-"));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,".updates"));
  const marker=join(root,".updates","pending-verification.json");await writeFile(marker,JSON.stringify({pid:12345}));
  await waitForUpdate(root,{alive:()=>true});assert.equal(JSON.parse(await readFile(marker)).pid,12345);
  await waitForUpdate(root,{alive:()=>false});await assert.rejects(readFile(marker),{code:"ENOENT"});
});
