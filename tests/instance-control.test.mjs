import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm,mkdir,writeFile,readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InstanceControl,stopExisting,controlRequest,instanceIdentity } from "../src/instance-control.mjs";
import { readJson } from "../src/update-files.mjs";
async function root(t){const dir=await mkdtemp(join(tmpdir(),"instance-test-"));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
test("start replacement identifies and gracefully stops only the same installation",async t=>{
  const a=await root(t),b=await root(t);let stoppedA=0,stoppedB=0,one,two;
  one=await new InstanceControl({root:a,onStop:async()=>{stoppedA++;await one.close();}}).listen();two=await new InstanceControl({root:b,onStop:async()=>{stoppedB++;await two.close();}}).listen();t.after(()=>two.close());
  assert.equal(await stopExisting(a),true);assert.equal(stoppedA,1);assert.equal(stoppedB,0);assert.ok(await readJson(join(b,".updates","instance.json")));
});
test("a wrong management secret or a foreign installation record cannot terminate a process",async t=>{
  const dir=await root(t);let stopped=0;const server=await new InstanceControl({root:dir,onStop:async()=>{stopped++;}}).listen();t.after(()=>server.close());
  await assert.rejects(controlRequest({...server.record,token:"wrong"},"stop",{timeoutMs:200}));assert.equal(stopped,0);
  const other=await root(t);await mkdir(join(other,".updates"));await writeFile(join(other,".updates","instance.json"),JSON.stringify(server.record));
  await assert.rejects(stopExisting(other),{code:"INSTANCE_IDENTITY"});assert.equal(stopped,0);
});
test("old PID-only records do not cause unrelated PID killing; Windows endpoints are root-specific named pipes",async t=>{
  const dir=await root(t);await mkdir(join(dir,".updates"));await writeFile(join(dir,".updates","server.json"),JSON.stringify({pid:process.pid}));
  await assert.rejects(stopExisting(dir),{code:"INSTANCE_LEGACY"});
  const identity=await instanceIdentity(dir,"win32");assert.ok(identity.address.startsWith("\\\\.\\pipe\\novel-collector-"));
});
