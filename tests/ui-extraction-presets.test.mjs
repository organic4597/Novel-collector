import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
const tick=()=>new Promise(r=>setTimeout(r,25));
const config={version:1,name:"safe preset",origin:"https://example.com",pagePattern:"/novel/{workId}",kind:"detail",fields:{title:{selector:"h1",attribute:"text",multiple:false,shadowPath:[]}}};
async function pendingFixture(t,api){
  const dom=new JSDOM(await readFile(new URL("../public/index.html",import.meta.url),"utf8"),{url:"http://localhost/",runScripts:"outside-only",pretendToBeVisual:true});
  t.after(()=>dom.window.close());const w=dom.window,state={view:"presets",auth:true,generation:1};
  w.eval(await readFile(new URL("../public/performance.js",import.meta.url),"utf8"));
  w.CollectorUI={node:w.CollectorPerformance.node,authenticated:()=>state.auth,view:()=>state.view,generation:()=>state.generation,textError:e=>e.message,api};
  for(const file of ["element-picker.js","extraction-presets.js"])w.eval(await readFile(new URL("../public/"+file,import.meta.url),"utf8"));
  return{w,d:w.document,state};
}
test("preset manager creates an inline bookmarklet, imports JSON only on save and clears after logout",async t=>{
  const dom=new JSDOM(await readFile(new URL("../public/index.html",import.meta.url),"utf8"),{url:"http://localhost/",runScripts:"outside-only",pretendToBeVisual:true});
  t.after(()=>dom.window.close());const w=dom.window,calls=[];let view="queue",auth=true,generation=1,records=[];
  w.eval(await readFile(new URL("../public/performance.js",import.meta.url),"utf8"));
  w.CollectorUI={node:w.CollectorPerformance.node,authenticated:()=>auth,view:()=>view,generation:()=>generation,textError:e=>e.message,
    api:async(path,options={})=>{calls.push({path,options});if(options.method==="POST"){records=[{id:"saved",name:config.name,origin:config.origin,kind:config.kind,pagePattern:config.pagePattern,fieldCount:1}];return{id:"saved",config};}return records;}};
  for(const file of ["element-picker.js","extraction-presets.js"])w.eval(await readFile(new URL("../public/"+file,import.meta.url),"utf8"));
  const d=w.document;assert.ok(d.getElementById("preset-bookmarklet").getAttribute("href").startsWith("javascript:"));assert.equal(calls.length,0);
  view="presets";d.dispatchEvent(new w.CustomEvent("collector:view"));await tick();
  d.getElementById("preset-json").value=JSON.stringify(config);assert.equal(calls.filter(c=>c.options.method==="POST").length,0);
  d.getElementById("preset-save").click();await tick();
  assert.equal(calls.filter(c=>c.options.method==="POST").length,1);assert.match(d.getElementById("preset-list").textContent,/safe preset/);
  auth=false;generation++;d.dispatchEvent(new w.CustomEvent("collector:auth"));assert.equal(d.getElementById("preset-json").value,"");assert.equal(d.getElementById("preset-list").children.length,0);
});

test("leaving during a pending save does not lock the preset editor on return",async t=>{
  let finish;const {w,d,state}=await pendingFixture(t,async(path,options={})=>options.method==="POST"?new Promise(resolve=>{finish=resolve;}):[]);
  d.getElementById("preset-json").value=JSON.stringify(config);d.getElementById("preset-save").click();await tick();
  assert.equal(d.getElementById("preset-save").disabled,true);
  state.view="queue";d.dispatchEvent(new w.CustomEvent("collector:view"));
  finish({id:"saved",config});await tick();
  state.view="presets";d.dispatchEvent(new w.CustomEvent("collector:view"));await tick();
  assert.equal(d.getElementById("preset-save").disabled,false);
});

test("a late clipboard rejection cannot restore preset code after logout",async t=>{
  const {w,d,state}=await pendingFixture(t,async()=>[]);let deny;
  Object.defineProperty(w.navigator,"clipboard",{value:{writeText:()=>new Promise((resolve,reject)=>{deny=reject;})}});
  d.getElementById("preset-copy-bookmarklet").click();state.auth=false;state.generation++;
  d.dispatchEvent(new w.CustomEvent("collector:auth"));deny(Error("denied"));await tick();
  assert.equal(d.getElementById("preset-bookmarklet-code").value,"");
  assert.equal(d.getElementById("preset-bookmarklet-code").hidden,true);
});
