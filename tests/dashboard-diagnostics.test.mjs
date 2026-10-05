import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm,readFile,mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActivityLog,updateLog,updateEvent } from "../src/activity-log.mjs";
import { createApp } from "../src/server.mjs";
import { command } from "../tools/update.mjs";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
async function fixture(t){const root=await mkdtemp(join(tmpdir(),"dashboard-log-"));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
test("dashboard log excludes crawler records while retaining API, browser and update diagnostics",async t=>{
  const root=await fixture(t),log=await new ActivityLog({path:join(root,"activity.jsonl")}).load();
  for(const scope of ["job","captcha","collector","metadata"])log.add({scope,message:"CRAWLER_CANARY"});
  for(const scope of ["api","dashboard","update","instance"])log.add({scope,message:"dashboard event"});await log.close();
  assert.equal(log.query().items.length,4);assert.ok(!(await readFile(join(root,"activity.jsonl"),"utf8")).includes("CRAWLER_CANARY"));
});
test("worker stderr and exit stage are imported into authenticated activity without credentials",async t=>{
  const root=await fixture(t),worker=await updateLog(root);let error;
  try{await command(["-e","console.error('npm failure token=PRIVATE_TOKEN');process.exit(3)"],root,process.env,{log:worker,step:"SETUP_RUNTIME"});}catch(e){error=e;}
  assert.equal(error.exitCode,3);assert.equal(error.step,"SETUP_RUNTIME");await worker.close();
  const log=await new ActivityLog({path:join(root,"activity.jsonl")}).load();await log.syncExternal(join(root,".updates","dashboard-events.jsonl"));await log.syncExternal(join(root,".updates","dashboard-events.jsonl"));
  const events=log.query().items;assert.equal(events.length,1);assert.equal(events[0].scope,"update");assert.equal(events[0].details.step,"SETUP_RUNTIME");assert.ok(!JSON.stringify(events).includes("PRIVATE_TOKEN"));await log.close();
});
test("all dashboard API completions include reads and updater calls, but log polling does not log itself",async t=>{
  const root=await fixture(t),activity=await new ActivityLog({path:join(root,"activity.jsonl")}).load();t.after(()=>activity.close());
  const app=createApp({store:{listJobs:async()=>[]},scheduler:{},adminPassword:"fixture-password",activity,updates:{status:async()=>({currentVersion:"1.0.0.1",job:{state:"idle"}})}});
  await new Promise(r=>app.listen(0,"127.0.0.1",r));t.after(()=>new Promise(r=>app.close(r)));const base=`http://127.0.0.1:${app.address().port}`;
  const login=await fetch(base+"/api/login",{method:"POST",body:JSON.stringify({password:"fixture-password"})}),cookie=login.headers.get("set-cookie").split(";")[0];
  await fetch(base+"/api/jobs",{headers:{cookie}});await fetch(base+"/api/updates/status",{headers:{cookie}});
  const before=activity.query().items.length;await fetch(base+"/api/activity",{headers:{cookie}});assert.equal(activity.query().items.length,before);
  assert.ok(activity.query().items.some(r=>r.message.includes("GET /api/updates/status")));assert.ok(activity.query().items.some(r=>r.message.includes("GET /api/jobs")));
  assert.equal((await fetch(base+"/api/dashboard-log",{method:"POST",headers:{cookie},body:JSON.stringify({events:[{kind:"error",level:"error",message:"Browser error password=PRIVATE_PASSWORD"}]})})).status,202);
  assert.ok(activity.query().items.some(r=>r.scope==="dashboard"));assert.ok(!JSON.stringify(activity.query()).includes("PRIVATE_PASSWORD"));
});

test("a new server bootstrap failure is recorded even when its stdout is hidden",async t=>{
  const root=await fixture(t);await mkdir(join(root,".updates"));await writeFile(join(root,".updates","pending-verification.json"),"{}");
  const preload=new URL("../tools/startup-diagnostics.mjs",import.meta.url).href;
  const code=await new Promise((yes,no)=>{const child=spawn(process.execPath,["--import",preload,"-e","console.error('bootstrap refused token=PRIVATE_TOKEN');process.exit(2)"],{env:{...process.env,UPDATER_DIAGNOSTICS_ROOT:root},stdio:"ignore"});child.on("error",no);child.on("exit",yes);});assert.equal(code,2);
  const log=await new ActivityLog({path:join(root,"activity.jsonl")}).load();await log.syncExternal(join(root,".updates","dashboard-events.jsonl"));assert.equal(log.query().items[0].details.step,"START_SERVER");assert.ok(!JSON.stringify(log.query()).includes("PRIVATE_TOKEN"));await log.close();
});
