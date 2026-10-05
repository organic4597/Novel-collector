import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {FolderStore} from "../src/store.mjs";
import {Scheduler} from "../src/queue.mjs";
import {createApp} from "../src/server.mjs";
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),"queue-order-")),store=await new FolderStore(root).init();
  const scheduler=new Scheduler({store,collector:{async run(){return{};},async close(){}},queuePaused:true,maxConcurrency:1});
  const jobs=[];for(const number of [1,2,3])jobs.push(await store.createJob({url:`https://newtoki1.org/novel/${number}`}));
  t.after(async()=>{await scheduler.stop();await rm(root,{recursive:true,force:true});});return{root,store,scheduler,jobs};
}
test("reservation moves persist after restart and retain job timestamps, progress and pause state",async t=>{
  const {root,store,scheduler,jobs:[a,b,c]}=await fixture(t);
  await store.patchJob(b.id,{status:"paused",completed:3});await scheduler.pauseAll();
  await scheduler.reorder(c.id,a.id);
  assert.deepEqual((await store.listJobs()).map(job=>job.id),[c.id,a.id,b.id]);
  const restored=await new FolderStore(root).init();
  assert.deepEqual((await restored.listJobs()).map(job=>job.id),[c.id,a.id,b.id]);
  assert.equal((await restored.getJob(a.id)).createdAt,a.createdAt);
  assert.equal((await restored.getJob(b.id)).completed,3);
  assert.deepEqual(await store.json(store.path("queue-state.json")),{paused:true});
  const restoredScheduler=new Scheduler({store:restored,collector:{async run(){return{};},async close(){}},queuePaused:true});
  t.after(()=>restoredScheduler.stop());await restoredScheduler.start();assert.equal(restoredScheduler.queuePaused,true);
});
test("future reservations keep their deadline while the next ready job follows the new order",async t=>{
  const {store,scheduler,jobs:[a,b,c]}=await fixture(t),startAt=new Date(Date.now()+3600000).toISOString();
  await store.patchJob(c.id,{startAt});await scheduler.reorder(c.id,a.id);await scheduler.reorder(b.id,a.id);
  assert.equal((await scheduler.nextJob("server")).id,b.id);assert.equal((await store.getJob(c.id)).startAt,startAt);
  await store.patchJob(c.id,{startAt:new Date(Date.now()-1000).toISOString()});assert.equal((await scheduler.nextJob("server")).id,c.id);
});
test("the collector starts the reordered reservation first and further moves leave the active collector intact",async t=>{
  const {scheduler,jobs:[a,b,c]}=await fixture(t),started=[];
  scheduler.collector.run=(job,_hooks,signal)=>{started.push(job.id);return new Promise((_resolve,reject)=>signal.addEventListener("abort",()=>reject(signal.reason),{once:true}));};
  await scheduler.reorder(c.id,a.id);await scheduler.start();await scheduler.startAll();
  assert.deepEqual(started,[c.id]);await scheduler.reorder(b.id,a.id);
  assert.deepEqual(scheduler.activeJobIds,[c.id]);assert.deepEqual(started,[c.id]);
});
test("relative concurrent moves retain every reservation and new jobs append to the waiting order",async t=>{
  const {store,scheduler,jobs:[a,b,c]}=await fixture(t);
  await Promise.all([scheduler.reorder(c.id,a.id),scheduler.reorder(b.id,c.id)]);
  const added=await store.createJob({url:"https://newtoki1.org/novel/4"});
  assert.deepEqual((await store.listJobs()).map(job=>job.id),[b.id,c.id,a.id,added.id]);
});
test("running, terminal, deleting and missing reservations cannot be moved or used as a target",async t=>{
  const {store,scheduler,jobs:[a,b,c]}=await fixture(t);
  await store.patchJob(a.id,{status:"running"});await store.patchJob(b.id,{status:"completed"});
  await assert.rejects(scheduler.reorder(a.id,c.id),{status:409});await assert.rejects(scheduler.reorder(c.id,b.id),{status:409});
  await store.patchJob(b.id,{status:"queued",deleting:true});await assert.rejects(scheduler.reorder(c.id,b.id),{status:409});
  await assert.rejects(scheduler.reorder("missing",null),{status:404});await assert.rejects(scheduler.reorder("../escape",null),{status:400});
});
test("an order persistence failure leaves the existing queue order intact",async t=>{
  const {store,scheduler,jobs:[a,b,c]}=await fixture(t),atomic=store.atomic.bind(store);
  store.atomic=async(path,value)=>{if(path===store.path("queue-order.json"))throw Object.assign(Error("write denied"),{code:"EACCES"});return atomic(path,value);};
  await assert.rejects(scheduler.reorder(c.id,a.id),{code:"EACCES"});assert.deepEqual((await store.listJobs()).map(job=>job.id),[a.id,b.id,c.id]);
});
test("reordering requires admin authentication, same-origin writes and a valid relative move",async t=>{
  const {store,scheduler,jobs:[a,b,c]}=await fixture(t),app=createApp({store,scheduler,adminPassword:"synthetic-order-password"});
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));t.after(()=>{app.closeAllConnections();return new Promise(resolve=>app.close(resolve));});
  const origin=`http://127.0.0.1:${app.address().port}`,move={jobId:c.id,beforeId:a.id};
  assert.equal((await fetch(origin+"/api/queue/reorder",{method:"POST",body:JSON.stringify(move)})).status,401);
  const login=await fetch(origin+"/api/login",{method:"POST",body:JSON.stringify({password:"synthetic-order-password"})}),cookie=login.headers.get("set-cookie").split(";")[0];
  const request=(body,source=origin)=>fetch(origin+"/api/queue/reorder",{method:"POST",headers:{cookie,origin:source},body:JSON.stringify(body)});
  assert.equal((await request(move,"https://foreign.test")).status,403);
  assert.equal((await request({jobId:c.id})).status,400);
  const response=await request(move);assert.equal(response.status,200);assert.deepEqual((await response.json()).jobs.map(job=>job.id),[c.id,a.id,b.id]);
});
