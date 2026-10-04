import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,mkdir,writeFile,rm,readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dependenciesReady } from "../run.mjs";
import { activate,transactionId } from "../src/update-engine.mjs";
test("staging must not count matching node_modules from its installed parent",async t=>{
  const root=await mkdtemp(join(tmpdir(),"runtime-isolation-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const stage=join(root,".updates","job","source"),dependencies={playwright:"1.63.0",jszip:"3.10.1",ws:"8.22.0"};await mkdir(stage,{recursive:true});
  await writeFile(join(stage,"package.json"),JSON.stringify({dependencies}));
  for(const [name,version] of Object.entries(dependencies)){const dir=join(root,"node_modules",name);await mkdir(dir,{recursive:true});await writeFile(join(dir,"package.json"),JSON.stringify({name,version}));}
  assert.equal(await dependenciesReady(stage),false,"a prepared parent is not a prepared staging runtime");
});
test("a missing staged runtime is rejected before any installed source or dependency is moved",async t=>{
  const root=await mkdtemp(join(tmpdir(),"runtime-missing-"));t.after(()=>rm(root,{recursive:true,force:true}));const id=transactionId(),stage=join(root,".updates",id,"source");
  await mkdir(stage,{recursive:true});await mkdir(join(root,"node_modules"));await writeFile(join(root,"node_modules","canary.txt"),"OLD_DEPENDENCIES");await writeFile(join(root,"run.mjs"),"OLD_SOURCE");await writeFile(join(stage,"run.mjs"),"NEW_SOURCE");
  let moves=0;await assert.rejects(activate(root,{id,stage,files:{"run.mjs":"new"},runtimes:["node_modules"],version:"1.0.0.1"},{move:async()=>{moves++;}}),{code:"STAGED_RUNTIME_MISSING"});
  assert.equal(moves,0);assert.equal(await readFile(join(root,"run.mjs"),"utf8"),"OLD_SOURCE");assert.equal(await readFile(join(root,"node_modules","canary.txt"),"utf8"),"OLD_DEPENDENCIES");
});
