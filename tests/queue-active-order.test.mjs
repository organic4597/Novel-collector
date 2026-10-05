import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {FolderStore} from "../src/store.mjs";
import {Scheduler} from "../src/queue.mjs";
import {runCollection} from "../src/collector-runner.mjs";
import {createHash} from "node:crypto";
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
async function until(check){for(let n=0;n<200;n++){if(await check())return;await tick();}throw Error("Timed out waiting for chapter boundary");}
async function fixture(t,slots=1){
  const root=await mkdtemp(join(tmpdir(),"active-order-")),store=await new FolderStore(root).init(),reads=[],gates=new Map();
  const collectorFactory=()=>({store,delayMs:0,clock:()=>Date.now(),async close(){},async installNetworkGuard(){},async openContext(){return{newPage:async()=>({})};},
    async collectionPlan(_page,job){const chapters=[1,2].map(number=>({id:`chapter-${number}`,number,title:`${number}화`,url:job.url+"/"+number}));return{title:"합성 작품",chapters,allChapters:chapters,expectedChapters:2};},
    async chapterText(_page,chapter,signal){const key=chapter.url;reads.push(key);await new Promise((resolve,reject)=>{gates.set(key,resolve);signal.addEventListener("abort",()=>reject(signal.reason),{once:true});});return"SYNTHETIC_BODY_"+chapter.number;},
    async exportBook(){return{};},async run(job,hooks,signal){return runCollection.call(this,job,hooks,signal,job.id);}});
  const scheduler=new Scheduler({store,collector:collectorFactory(),collectorFactory,maxConcurrency:slots,intervalMs:10,chapterDelayMs:0,queuePaused:true});
  const jobs=[];for(const id of [1,2,3])jobs.push(await store.createJob({url:`https://newtoki1.org/novel/${id}`}));
  t.after(async()=>{await scheduler.stop();await rm(root,{recursive:true,force:true});});
  return{store,scheduler,jobs,reads,gates};
}
test("moving a running job waits for its current chapter write and resumes later without reading saved text twice",async t=>{
  const f=await fixture(t),[a,b]=f.jobs;
  await f.scheduler.start();await f.scheduler.startAll();await until(()=>f.gates.has(a.url+"/1"));
  await f.scheduler.reorder(a.id,null);
  assert.equal((await f.store.getJob(a.id)).status,"running");assert.equal(f.scheduler.active.get(a.id).controller.signal.aborted,false);
  assert.deepEqual(f.reads,[a.url+"/1"]);f.gates.get(a.url+"/1")();
  await until(()=>f.gates.has(b.url+"/1"));
  assert.equal((await f.store.readChapter(a.id,"chapter-1")).text,"SYNTHETIC_BODY_1");
  assert.equal((await f.store.getJob(a.id)).status,"queued");assert.equal((await f.store.getJob(a.id)).resumeCatalog,true);
  assert.ok(!f.reads.includes(a.url+"/2"));
  await f.scheduler.pauseAll();await f.scheduler.reorder(a.id,b.id);await f.scheduler.startAll();await until(()=>f.gates.has(a.url+"/2"));
  assert.equal(f.reads.filter(url=>url===a.url+"/1").length,1);
});
test("two-slot ordering yields only the displaced running job and keeps the other chapter request alive",async t=>{
  const f=await fixture(t,2),[a,b,c]=f.jobs;
  await f.scheduler.start();await f.scheduler.startAll();await until(()=>f.gates.has(a.url+"/1")&&f.gates.has(b.url+"/1"));
  const aSignal=f.scheduler.active.get(a.id).controller.signal;
  await f.scheduler.reorder(b.id,null);f.gates.get(b.url+"/1")();await until(()=>f.gates.has(c.url+"/1"));
  assert.equal(aSignal.aborted,false);assert.ok(f.scheduler.active.has(a.id));assert.ok(!f.reads.includes(b.url+"/2"));
  assert.equal((await f.store.readChapter(b.id,"chapter-1")).text,"SYNTHETIC_BODY_1");
});
test("moving a running job ahead again before the boundary cancels the pending switch",async t=>{
  const f=await fixture(t),[a,b]=f.jobs;
  await f.scheduler.start();await f.scheduler.startAll();await until(()=>f.gates.has(a.url+"/1"));
  await f.scheduler.reorder(a.id,null);await f.scheduler.reorder(a.id,b.id);f.gates.get(a.url+"/1")();
  await until(()=>f.gates.has(a.url+"/2"));assert.ok(!f.reads.includes(b.url+"/1"));
});
test("future reservations and the same canonical work do not interrupt a current chapter stream",async t=>{
  const f=await fixture(t),[a,b,c]=f.jobs;
  await f.store.patchJob(b.id,{startAt:new Date(Date.now()+3600000).toISOString()});await f.store.patchJob(c.id,{url:a.url});
  await f.scheduler.start();await f.scheduler.startAll();await until(()=>f.gates.has(a.url+"/1"));
  await f.scheduler.reorder(a.id,null);f.gates.get(a.url+"/1")();await until(()=>f.gates.has(a.url+"/2"));
  assert.equal(f.scheduler.activeJobIds[0],a.id);
});
test("manual pause overrides a pending chapter-boundary reorder",async t=>{
  const f=await fixture(t),[a]=f.jobs;
  await f.scheduler.start();await f.scheduler.startAll();await until(()=>f.gates.has(a.url+"/1"));
  await f.scheduler.reorder(a.id,null);await f.scheduler.pauseAll();
  assert.equal((await f.store.getJob(a.id)).status,"paused");assert.equal(f.scheduler.queuePaused,true);assert.equal(f.scheduler.active.size,0);
});
test("browser reservations finish the saved chapter before releasing their lease and preserve the resume cursor",async t=>{
  const f=await fixture(t),[a,b]=f.jobs;
  await f.store.patchJob(a.id,{executor:"browser",overwrite:true});await f.store.patchJob(b.id,{executor:"browser"});f.scheduler.queuePaused=false;
  const claim=await f.scheduler.claim("synthetic-client"),bookId="newtoki1_org-1";
  const chapters=[1,2].map(number=>{const url=a.url+"/"+number;return{id:createHash("sha256").update(url).digest("hex").slice(0,24),number,title:`${number}화`,url};});
  await f.scheduler.agentOperation(a.id,"catalog",{clientId:"synthetic-client",bookId,chapters},claim.leaseToken);
  await f.scheduler.reorder(a.id,null);
  assert.equal((await f.scheduler.agentOperation(a.id,"heartbeat",{clientId:"synthetic-client"},claim.leaseToken)).status,"running");
  const result=await f.scheduler.agentOperation(a.id,"chapter",{clientId:"synthetic-client",id:chapters[0].id,text:"SYNTHETIC_SAVED_BODY"},claim.leaseToken);
  assert.equal(result.saved,true);assert.equal(result.status,"queued");assert.equal(f.scheduler.lease,null);
  assert.equal((await f.store.readChapter(bookId,chapters[0].id)).text,"SYNTHETIC_SAVED_BODY");
  await assert.rejects(f.scheduler.agentOperation(a.id,"heartbeat",{clientId:"synthetic-client"},claim.leaseToken),{status:409});
  assert.equal((await f.scheduler.claim("synthetic-client")).job.id,b.id);await f.scheduler.action(b.id,"pause");
  await f.scheduler.reorder(a.id,b.id);const resumed=await f.scheduler.claim("synthetic-client");
  const catalog=await f.scheduler.agentOperation(a.id,"catalog",{clientId:"synthetic-client",bookId,chapters},resumed.leaseToken);
  assert.deepEqual(catalog.existingChapterIds,[chapters[0].id]);
});
