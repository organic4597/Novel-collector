import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
const tick=()=>new Promise(r=>setTimeout(r,30));
test("logs render collapsed one-line summaries with repeat counts and replace grouped cursor updates",async t=>{
  const dom=new JSDOM(await readFile(new URL("../public/index.html",import.meta.url),"utf8"),{url:"http://localhost/",runScripts:"outside-only",pretendToBeVisual:true});t.after(()=>dom.window.close());const w=dom.window,d=w.document;
  w.eval(await readFile(new URL("../public/performance.js",import.meta.url),"utf8"));let count=1;
  w.CollectorUI={authenticated:()=>true,view:()=>"activity",generation:()=>1,preferences:()=>({refreshIntervalMs:60000}),date:x=>String(x),textError:e=>e.message,node:w.CollectorPerformance.node,
    api:async()=>({items:[{id:count,time:"now",level:"info",scope:"api",message:"GET /api/status · 200",groupId:"poll-group",count,details:{status:200}}],latestId:count})};
  w.eval(await readFile(new URL("../public/activity.js",import.meta.url),"utf8"));d.dispatchEvent(new w.CustomEvent("collector:view"));await tick();
  const row=d.querySelector("details.activity-row");assert.ok(row);assert.equal(row.open,false);assert.equal(row.querySelector(".activity-repeat").textContent,"×1");
  count=7;d.getElementById("activity-refresh").click();await tick();assert.equal(d.querySelectorAll("details.activity-row").length,1);assert.equal(d.querySelector(".activity-repeat").textContent,"×7");
});
