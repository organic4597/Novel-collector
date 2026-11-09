import test from "node:test";
import assert from "node:assert/strict";
import {Scheduler} from "../src/queue.mjs";
import {CollectionNetwork} from "../src/collection-network.mjs";
const offline={enabled:true,snapshot:()=>({active:true})};
function fixture({network=offline,jobs=[],listJobs,patchJob}={}){
 const records=new Map(jobs.map(j=>[j.id,{...j}]));let listed=0,failures=0;
 const store={async listJobs(){listed++;return listJobs?listJobs(records):[...records.values()];},async getJob(id){return records.get(id);},async locked(_key,fn){return fn();},async patchJob(id,patch){if(patchJob)await patchJob(id,patch,records);const old=records.get(id);const value=typeof patch==="function"?patch(old):patch;if(value)records.set(id,{...old,...value});return records.get(id);}};
 const scheduler=new Scheduler({store,collector:{},network,backoff:{snapshot:()=>({active:false}),async clearAfterExpiry(){},async failure(){failures++;return{triggered:false};}}});
 return{scheduler,records,store,listed:()=>listed,failures:()=>failures};
}
test("offline fill never lists or starts a server job",async()=>{const f=fixture();f.scheduler.enabled=true;await f.scheduler.fillSlots();assert.equal(f.listed(),0);});
test("external claims are disabled in tether mode even when connected",async()=>{for(const network of [offline,{enabled:true,snapshot:()=>({active:false})}]){const f=fixture({network});assert.deepEqual(await f.scheduler.claim("desktop"),{job:null});assert.equal(f.listed(),0);assert.equal(f.scheduler.agents.size,0);}});
test("network hold preserves both slots, completed progress and manual pauses",async()=>{
 const f=fixture({jobs:[{id:"a",status:"running",completed:4,currentChapterId:"c2"},{id:"b",status:"running",completed:6,backoffResumeChapterId:"b1"},{id:"p",status:"paused",completed:8},{id:"c",status:"cancelled"}]});
 f.scheduler.queuePaused=true;for(const j of f.records.values())f.scheduler.active.set(j.id,{job:j,controller:new AbortController()});
 await f.scheduler.holdNetwork();
 for(const id of ["a","b"]){assert.equal(f.records.get(id).status,"queued");assert.equal(f.scheduler.active.get(id).controller.signal.aborted,true);}
 assert.equal(f.records.get("a").completed,4);assert.equal(f.records.get("a").backoffResumeChapterId,"c2");assert.equal(f.records.get("b").backoffResumeChapterId,"b1");
 assert.equal(f.records.get("p").status,"paused");assert.equal(f.records.get("c").status,"cancelled");assert.equal(f.scheduler.active.get("p").controller.signal.aborted,false);assert.equal(f.scheduler.queuePaused,true);
});
test("temporary network errors do not increment source failure backoff",async()=>{
 const f=fixture({jobs:[{id:"a",status:"running",currentChapterId:"c"}]});const controller=new AbortController();f.scheduler.active.set("a",{job:f.records.get("a"),controller});
 await f.scheduler.requestFailed("a",Object.assign(Error("offline"),{code:"COLLECTION_NETWORK_PAUSED"}));assert.equal(f.failures(),0);assert.equal(controller.signal.aborted,true);
});
test("simultaneous IP blocks coalesce and onChange can hold without queue deadlock",async()=>{
 let saved=null,off=0;const store={path:x=>x,json:async()=>saved,atomic:async(_p,v)=>{saved=v;}};
 const network=new CollectionNetwork({enabled:true,store,phone:async action=>{if(action==="off")off++;return{enabled:action==="on"};},connect:async()=>({ready:true}),probe:async()=>({ready:true}),schedule:()=>1,cancel:()=>{},onChange:async state=>{if(state.active)await f.scheduler.holdNetwork();}});
 const f=fixture({network,jobs:[{id:"a",status:"running",currentChapterId:"c"}]});f.scheduler.active.set("a",{job:f.records.get("a"),controller:new AbortController()});await network.start();
 const error=Object.assign(Error("blocked"),{code:"SOURCE_IP_BLOCKED",siteHost:"sbxh9.com",blockCode:"NGINX_CIDR_REALIP"});
 await Promise.all([f.scheduler.requestFailed("a",error),f.scheduler.requestFailed("a",error)]);assert.equal(off,1);assert.equal(f.failures(),0);assert.equal(f.records.get("a").status,"queued");network.close();
});
test("ready tether keeps ordinary failures on the existing backoff path",async()=>{
 const f=fixture({network:{enabled:true,snapshot:()=>({active:false})}});await f.scheduler.requestFailed(null,Error("connection reset"));assert.equal(f.failures(),1);
});
test("disconnect while clearing backoff cannot list jobs",async()=>{
 let active=false;const f=fixture({network:{enabled:true,snapshot:()=>({active})}});f.scheduler.enabled=true;f.scheduler.backoff.clearAfterExpiry=async()=>{active=true;};await f.scheduler.fillSlots();assert.equal(f.listed(),0);
});
test("disconnect during job selection cannot reserve a slot or run it",async()=>{
 let active=false,runs=0;const job={id:"a",status:"queued",executor:"server",url:"https://newtoki1.org/novel/1"};const f=fixture({jobs:[job],network:{enabled:true,snapshot:()=>({active})},listJobs:()=>{active=true;return[job];}});f.scheduler.collector.run=async()=>{runs++;await new Promise(()=>{});};f.scheduler.enabled=true;await f.scheduler.fillSlots();assert.equal(runs,0);assert.equal(f.scheduler.active.size,0);assert.equal(f.records.get("a").status,"queued");
});
test("disconnect during running-state write requeues before invoking collector",async()=>{
 let active=false,runs=0;const job={id:"a",status:"queued",executor:"server",url:"https://newtoki1.org/novel/1"};const f=fixture({jobs:[job],network:{enabled:true,snapshot:()=>({active})},patchJob:async(_id,p)=>{if(p.status==="running")active=true;}});f.scheduler.collector.run=async()=>{runs++;await new Promise(()=>{});};f.scheduler.enabled=true;await f.scheduler.tick();assert.equal(runs,0);assert.equal(f.records.get("a").status,"queued");assert.equal(f.scheduler.active.size,0);
});
test("legacy direct mode keeps ordinary external claim behavior",async()=>{
 const f=fixture({network:{enabled:false,snapshot:()=>({active:false})}});assert.deepEqual(await f.scheduler.claim("desktop"),{job:null});assert.equal(f.listed(),1);assert.equal(f.scheduler.agents.size,1);
});

test("network hold revokes an existing external lease without losing saved counters",async()=>{
 const f=fixture({jobs:[{id:"b",status:"running",completed:3,currentChapterId:"bc"}]});
 f.scheduler.active.set("b",{job:f.records.get("b"),type:"browser"});f.scheduler.lease={jobId:"b"};
 await f.scheduler.holdNetwork();assert.equal(f.scheduler.lease,null);assert.equal(f.scheduler.active.size,0);assert.equal(f.records.get("b").status,"needs_attention");assert.equal(f.records.get("b").completed,3);assert.equal(f.records.get("b").backoffResumeChapterId,"bc");
});
test("an absent active record is not recreated by a network hold",async()=>{
 const f=fixture();const controller=new AbortController();f.scheduler.active.set("gone",{job:{id:"gone"},controller});
 await f.scheduler.holdNetwork();assert.equal(f.records.has("gone"),false);assert.equal(controller.signal.aborted,false);
});
test("ordinary failure while offline defers instead of recording a source failure",async()=>{
 const f=fixture();await f.scheduler.requestFailed(null,Error("request aborted"));assert.equal(f.failures(),0);
});
