import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
test("browser diagnostics record actions/errors without form values and cannot recursively log delivery",async t=>{
  const dom=new JSDOM('<button id="update-apply">업데이트</button><input id="password" value="PRIVATE_FORM_VALUE">',{url:"http://localhost/",runScripts:"outside-only"});t.after(()=>dom.window.close());const w=dom.window,calls=[];let auth=true;
  w.fetch=async(path,options)=>{calls.push({path,options});return{ok:true};};w.CollectorUI={authenticated:()=>auth,view:()=>"settings"};
  w.eval(await readFile(new URL("../public/dashboard-logger.js",import.meta.url),"utf8"));w.document.getElementById("update-apply").click();
  w.dispatchEvent(new w.ErrorEvent("error",{message:"Failure token=PRIVATE_TOKEN"}));await w.CollectorDashboardLog.flush();
  assert.equal(calls.length,1);const events=JSON.parse(calls[0].options.body).events;assert.ok(events.some(e=>e.kind==="action"));assert.ok(events.some(e=>e.kind==="error"));
  assert.ok(!JSON.stringify(events).includes("PRIVATE_FORM_VALUE"));assert.ok(!JSON.stringify(events).includes("PRIVATE_TOKEN"));
  auth=false;w.document.dispatchEvent(new w.CustomEvent("collector:auth"));await w.CollectorDashboardLog.flush();assert.equal(calls.length,1);
});
