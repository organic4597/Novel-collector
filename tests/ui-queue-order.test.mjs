import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {JSDOM} from "jsdom";
const tick=()=>new Promise(resolve=>setTimeout(resolve,25));
async function fixture(t){
  const dom=new JSDOM(await readFile(new URL("../public/index.html",import.meta.url),"utf8"),{url:"http://localhost/",runScripts:"outside-only",pretendToBeVisual:true});
  t.after(()=>dom.window.close());const w=dom.window,calls=[];let handler;
  let jobs=["running","a","b","c"].map((id,index)=>({id,title:`합성 작품 ${id}`,status:id==="running"?"running":id==="c"?"paused":"queued",url:`https://newtoki1.org/novel/${index+1}`,exports:{},updatedAt:"2026-10-05",lastActivity:"2026-10-05"}));
  w.fetch=async(path,options={})=>{
    let data={};if(path==="/api/session")data={authenticated:true};else if(path==="/api/status")data={maxConcurrency:2,activeJobIds:["running"]};else if(path==="/api/jobs")data=structuredClone(jobs);
    else if(path==="/api/queue/reorder"){
      const move=JSON.parse(options.body);calls.push(move);if(handler)return handler(move);
      const moved=jobs.find(job=>job.id===move.jobId);jobs=jobs.filter(job=>job.id!==move.jobId);jobs.splice(move.beforeId===null?jobs.length:jobs.findIndex(job=>job.id===move.beforeId),0,moved);data={jobs:structuredClone(jobs)};
    }
    return{ok:true,status:200,json:async()=>data};
  };
  for(const name of ["performance.js","queue-ui.js","app.js"])w.eval(await readFile(new URL("../public/"+name,import.meta.url),"utf8"));
  await tick();return{w,calls,setHandler:value=>{handler=value;},card:id=>w.document.querySelector(`[data-job-id="${id}"]`),order:()=>Array.from(w.document.querySelectorAll("#jobs-list .job-card"),card=>card.dataset.jobId)};
}
function drag(w,source,target){
  for(const [type,node] of [["dragstart",source],["dragover",target],["drop",target],["dragend",source]]){
    const event=new w.Event(type,{bubbles:true,cancelable:true});Object.defineProperty(event,"dataTransfer",{value:{setData(){}}});Object.defineProperty(event,"clientY",{value:0});node.dispatchEvent(event);
  }
}
test("running reservations can be dragged and remain marked running until their chapter boundary",async t=>{
  const f=await fixture(t),running=f.card("running");assert.equal(running.draggable,true);
  drag(f.w,running,f.card("b"));await tick();
  assert.deepEqual(f.calls,[{jobId:"running",beforeId:"b"}]);assert.deepEqual(f.order(),["a","running","b","c"]);
  assert.match(running.querySelector(".status-pill").textContent,/수집 중/);
  assert.match(f.w.document.getElementById("toast").textContent,/현재 회차 저장 후/);
});
test("dragging a paused reservation changes the waiting order and preserves the running card",async t=>{
  const f=await fixture(t),running=f.card("running");assert.equal(running.draggable,true);
  drag(f.w,f.card("c"),f.card("a"));await tick();
  assert.deepEqual(f.calls,[{jobId:"c",beforeId:"a"}]);assert.deepEqual(f.order(),["running","c","a","b"]);assert.equal(f.card("running"),running);
  assert.equal(f.card("c").querySelector(".job-order").textContent,"2");
});
test("keyboard movement buttons use the same API and disable queue boundaries",async t=>{
  const f=await fixture(t),d=f.w.document;
  assert.equal(d.getElementById("queue-move-up-running").disabled,true);assert.equal(d.getElementById("queue-move-down-c").disabled,true);
  d.getElementById("queue-move-up-b").click();await tick();
  assert.deepEqual(f.calls,[{jobId:"b",beforeId:"a"}]);assert.deepEqual(f.order(),["running","b","a","c"]);
  d.getElementById("queue-move-down-b").click();await tick();assert.deepEqual(f.order(),["running","a","b","c"]);
});
test("failed order writes retain the visible order and duplicate clicks cannot submit twice",async t=>{
  const f=await fixture(t),d=f.w.document;let release;
  f.setHandler(()=>new Promise(resolve=>{release=resolve;}));
  d.getElementById("queue-move-up-b").click();d.getElementById("queue-move-up-b").click();await tick();assert.equal(f.calls.length,1);
  release({ok:false,status:503,json:async()=>({error:"순서를 저장하지 못했습니다."})});await tick();
  assert.deepEqual(f.order(),["running","a","b","c"]);assert.match(d.getElementById("global-error").textContent,/순서를 저장/);
  assert.equal(d.getElementById("queue-move-up-b").disabled,false);
});
test("external drops cannot reorder reservations and a late result after logout restores no private cards",async t=>{
  const f=await fixture(t),d=f.w.document;d.getElementById("jobs-list").dispatchEvent(new f.w.Event("drop",{bubbles:true,cancelable:true}));assert.equal(f.calls.length,0);
  let release;f.setHandler(()=>new Promise(resolve=>{release=resolve;}));d.getElementById("queue-move-up-b").click();await tick();
  d.getElementById("logout-button").click();await tick();release({ok:true,status:200,json:async()=>({jobs:[{id:"private-late",status:"queued"}]})});await tick();
  assert.equal(d.getElementById("jobs-list").children.length,0);
});
