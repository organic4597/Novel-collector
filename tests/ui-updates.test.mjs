import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
const tick=()=>new Promise(r=>setTimeout(r,20));
test("dashboard update notice is authenticated, uses cached status and dispatches only the advertised version",async t=>{
  const dom=new JSDOM(await readFile(new URL("../public/index.html",import.meta.url),"utf8"),{url:"http://localhost/",runScripts:"outside-only",pretendToBeVisual:true});t.after(()=>dom.window.close());const w=dom.window,d=w.document,calls=[];let auth=false,generation=1;
  const state={currentVersion:"1.0.0.0",latestVersion:"1.0.0.1",available:true,installable:true,busy:false,repository:"example/repo",releaseUrl:"https://github.com/example/repo/releases/tag/1.0.0.1",job:{state:"idle",message:""}};
  w.CollectorUI={authenticated:()=>auth,generation:()=>generation,api:async(path,options={})=>{calls.push({path,options});return path.endsWith("apply")?{accepted:true}:state;}};
  w.eval(await readFile(new URL("../public/updates.js",import.meta.url),"utf8"));assert.equal(calls.length,0);
  auth=true;d.dispatchEvent(new w.CustomEvent("collector:auth"));await tick();assert.equal(d.getElementById("update-notice").hidden,false);assert.equal(d.getElementById("update-current").textContent,"1.0.0.0");
  d.getElementById("update-banner-apply").click();await tick();const write=calls.find(c=>c.path.endsWith("apply"));assert.equal(JSON.parse(write.options.body).version,"1.0.0.1");
  assert.ok(!calls.some(c=>c.path.includes("api.github.com")));auth=false;generation++;d.dispatchEvent(new w.CustomEvent("collector:auth"));assert.equal(d.getElementById("update-notice").hidden,true);
});
