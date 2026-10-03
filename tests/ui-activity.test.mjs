import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

test("activity page requests only while visible, uses cursors, renders text safely and clears on logout", async t => {
  const dom=new JSDOM(await readFile(new URL("../public/index.html",import.meta.url),"utf8"),{url:"http://localhost",runScripts:"outside-only",pretendToBeVisual:true});
  t.after(()=>dom.window.close());
  const w=dom.window;let view="queue",auth=true,generation=1;
  const calls=[];
  w.eval(await readFile(new URL("../public/performance.js",import.meta.url),"utf8"));
  w.CollectorUI={node:w.CollectorPerformance.node,date:w.CollectorPerformance.date,
    authenticated:()=>auth,view:()=>view,generation:()=>generation,preferences:()=>({refreshIntervalMs:5000}),textError:e=>e.message,
    api:async path=>{calls.push(path);return{items:[{id:1,level:"info",scope:"job",time:new Date().toISOString(),message:"<script>not markup</script>",details:{stage:"STARTED"}}],latestId:1,hasMore:false};}};
  w.eval(await readFile(new URL("../public/activity.js",import.meta.url),"utf8"));
  await new Promise(r=>setTimeout(r,20));assert.equal(calls.length,0);
  view="activity";w.document.dispatchEvent(new w.CustomEvent("collector:view"));
  await new Promise(r=>setTimeout(r,20));
  assert.equal(calls.length,1);assert.match(calls[0],/limit=100/);
  assert.equal(w.document.querySelector("#activity-list script"),null);
  assert.match(w.document.querySelector("#activity-list").textContent,/not markup/);
  w.document.getElementById("activity-pause").click();
  assert.match(w.document.getElementById("activity-pause").textContent,/재개/);
  auth=false;generation++;w.document.dispatchEvent(new w.CustomEvent("collector:auth"));
  assert.equal(w.document.getElementById("activity-list").children.length,0);
});
