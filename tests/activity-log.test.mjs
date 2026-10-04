import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ActivityLog, safeActivity } from "../src/activity-log.mjs";
import { createApp } from "../src/server.mjs";

test("activity details exclude cookies, tokens, proof and unknown fields", () => {
  const event = safeActivity({ scope: "captcha", message: "token=private-value https://site.test/path?secret=abc",
    details: { stage: "VERIFYING", x:117.4, elapsedMs:2400, cookie:"private-cookie",captchaToken:"private-token",proof:"private-proof" } });
  assert.deepEqual(event.details, {stage:"VERIFYING",x:117.4,elapsedMs:2400});
  assert.ok(!JSON.stringify(event).includes("private-"));
  assert.ok(!event.message.includes("?secret"));
});

test("log rotation, bounded memory, incremental cursors and reload retain safe records", async t => {
  const root = await mkdtemp(join(tmpdir(), "activity-test-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,"events.jsonl");
  const log=await new ActivityLog({path,capacity:5,maxBytes:700}).load();
  for(let i=0;i<12;i++) log.add({scope:"api",message:`event ${i}`,level:i===11?"error":"info"});
  await log.close();
  const latest=log.query({limit:2});
  assert.equal(log.rows.length,5);
  assert.equal(latest.items.length,2);
  assert.equal(log.query({after:latest.items[0].id}).items.length,1);
  assert.equal(log.query({level:"error"}).items.length,1);
  const restored=await new ActivityLog({path,capacity:5,maxBytes:700}).load();
  assert.ok(restored.rows.length<=5);
  assert.equal(restored.query().items.at(-1).message,"event 11");
});

test("activity route requires admin authentication and bounds pages", async t => {
  const calls=[];
  const app=createApp({store:{},scheduler:{},adminPassword:"test-password",activity:{query:q=>{calls.push(q);return{items:[]};}}});
  await new Promise(r=>app.listen(0,"127.0.0.1",r));
  t.after(()=>new Promise(r=>app.close(r)));
  const origin=`http://127.0.0.1:${app.address().port}`;
  assert.equal((await fetch(origin+"/api/activity")).status,401);
  const login=await fetch(origin+"/api/login",{method:"POST",body:JSON.stringify({password:"test-password"})});
  const cookie=login.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(origin+"/api/activity?limit=900&after=3",{headers:{cookie}})).status,200);
  assert.equal(calls[0].limit,200);
  assert.equal((await fetch(origin+"/api/activity?after=bad",{headers:{cookie}})).status,400);
});

test("simultaneous status and jobs polling share one directory snapshot", async t => {
  let reads=0;
  const app=createApp({store:{listJobs:async()=>{reads++;await new Promise(r=>setTimeout(r,15));return[];}},scheduler:{},adminPassword:"test-password"});
  await new Promise(r=>app.listen(0,"127.0.0.1",r));t.after(()=>new Promise(r=>app.close(r)));
  const origin=`http://127.0.0.1:${app.address().port}`;
  const login=await fetch(origin+"/api/login",{method:"POST",body:JSON.stringify({password:"test-password"})});
  const cookie=login.headers.get("set-cookie").split(";")[0];
  const results=await Promise.all(["/api/status","/api/jobs"].map(p=>fetch(origin+p,{headers:{cookie}})));
  assert.ok(results.every(r=>r.status===200));assert.equal(reads,1);
});
