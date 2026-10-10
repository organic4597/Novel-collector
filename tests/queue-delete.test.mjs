import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FolderStore } from "../src/store.mjs";
import { Scheduler } from "../src/queue.mjs";
import { SiteAttention } from "../src/site-attention.mjs";
import { createApp } from "../src/server.mjs";

async function fixture(t, collector={delayMs:0,run:async()=>({})}) {
  const root=await mkdtemp(join(tmpdir(),"delete-job-"));
  const store=await new FolderStore(root).init();
  const attention=new SiteAttention({store});await attention.load();
  const scheduler=new Scheduler({store,collector,attention,intervalMs:1000000});
  t.after(async()=>{await scheduler.stop();await rm(root,{recursive:true,force:true});});
  return{root,store,scheduler,attention};
}

test("queued, paused and held reservations can be deleted while library chapters remain",async t=>{
  const f=await fixture(t);
  await f.store.upsertBook("book",{title:"stored"});
  await f.store.writeChapter("book","chapter",{number:1,title:"synthetic",url:"https://newtoki1.org/novel/1/2",text:"saved synthetic body"});
  for(const status of ["queued","paused","needs_attention"]){
    const job=await f.store.createJob({url:"https://newtoki1.org/novel/1"});await f.store.patchJob(job.id,{status});
    await f.attention.holdSite("newtoki1.org",{kind:"captcha",requiredSlots:[1],jobIds:[job.id]});
    const result=await f.scheduler.deleteJob(job.id);
    assert.equal(result.deleted,true);assert.equal(await f.store.getJob(job.id),null);
    assert.ok((await stat(f.store.path("trash","jobs",job.id,"job.json"))).isFile());
    assert.equal(f.attention.get("newtoki1.org"),null);
  }
  assert.equal((await f.store.readChapter("book","chapter")).text,"saved synthetic body");
});

test("running deletion waits outside the scheduler lock, returns pending and never cancels another slot",{timeout:5000},async t=>{
  let finish,started;const gate=new Promise(r=>{finish=r;}),startedBoth=new Promise(r=>{started=r;});const signals=new Map();
  t.after(()=>finish());
  const collector={delayMs:0,run:async(job,hooks,signal)=>{
    signals.set(job.id,signal);if(signals.size===2)started();
    await new Promise(r=>{if(signal.aborted)r();else signal.addEventListener("abort",r,{once:true});});
    if(job.url.endsWith("/1"))await gate;
    await hooks.report({completed:999});
    return{};
  }};
  const f=await fixture(t,collector);
  const a=await f.store.createJob({url:"https://newtoki1.org/novel/1"});
  const b=await f.store.createJob({url:"https://newtoki1.org/novel/2"});
  await f.scheduler.start();await startedBoth;
  const result=await f.scheduler.deleteJob(a.id,{waitMs:10});
  assert.equal(result.pending,true);
  assert.equal(signals.get(a.id).aborted,true);assert.equal(signals.get(b.id).aborted,false);
  assert.equal((await f.store.getJob(a.id)).deleting,true);
  await assert.rejects(f.scheduler.action(a.id,"retry"),{status:409});
  const again=await f.scheduler.deleteJob(a.id,{waitMs:10});assert.equal(again.pending,true);
  finish();await f.scheduler.deletions.get(a.id).work;
  assert.equal(await f.store.getJob(a.id),null);
  assert.equal((await f.store.getJob(b.id)).status,"running");
});

test("graceful restart completes a previously pending deletion rather than requeueing it",async t=>{
  const f=await fixture(t);const job=await f.store.createJob({url:"https://newtoki1.org/novel/1"});
  await f.store.patchJob(job.id,{status:"cancelled",deleting:true});
  await f.scheduler.start();
  assert.equal(await f.store.getJob(job.id),null);
});

test("reservation DELETE remains admin protected and accepts a queued job through the scheduler",async t=>{
  const f=await fixture(t);const job=await f.store.createJob({url:"https://newtoki1.org/novel/1"});
  const app=createApp({store:f.store,scheduler:f.scheduler,adminPassword:"fixture-password"});
  await new Promise(r=>app.listen(0,"127.0.0.1",r));t.after(()=>new Promise(r=>app.close(r)));
  const base=`http://127.0.0.1:${app.address().port}`;
  assert.equal((await fetch(base+`/api/jobs/${job.id}`,{method:"DELETE"})).status,401);
  const login=await fetch(base+"/api/login",{method:"POST",body:JSON.stringify({password:"fixture-password"})});
  const cookie=login.headers.get("set-cookie").split(";")[0];
  const response=await fetch(base+`/api/jobs/${job.id}`,{method:"DELETE",headers:{cookie,origin:base}});
  assert.equal(response.status,200);assert.equal((await response.json()).deleted,true);
  assert.equal(await f.store.getJob(job.id),null);
});

test("browser-worker deletion revokes its lease so a late writer cannot recreate the reservation",async t=>{
  const f=await fixture(t);const job=await f.store.createJob({url:"https://newtoki1.org/novel/1",executor:"browser"});
  f.scheduler.enabled=true;
  const claimed=await f.scheduler.claim("test-client");assert.equal(claimed.job.id,job.id);
  await f.scheduler.deleteJob(job.id);
  assert.equal(f.scheduler.lease,null);assert.equal(f.scheduler.active.has(job.id),false);
  await assert.rejects(f.scheduler.agentOperation(job.id,"heartbeat",{clientId:"test-client"},claimed.leaseToken));
  assert.equal(await f.store.getJob(job.id),null);
});
