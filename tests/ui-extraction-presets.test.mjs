import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { PRESET_PAGE_FIELDS } from "../src/extraction-presets.mjs";
const tick=()=>new Promise(r=>setTimeout(r,25));
const config={version:1,name:"safe preset",origin:"https://example.com",pagePattern:"/novel/{workId}",kind:"detail",fields:{title:{selector:"h1",attribute:"text",multiple:false,shadowPath:[]}}};
async function pendingFixture(t,api,hash=""){
  const dom=new JSDOM(await readFile(new URL("../public/index.html",import.meta.url),"utf8"),{url:"http://localhost/"+hash,runScripts:"outside-only",pretendToBeVisual:true});
  t.after(()=>dom.window.close());const w=dom.window,state={view:"presets",auth:true,generation:1};
  w.eval(await readFile(new URL("../public/performance.js",import.meta.url),"utf8"));
  w.CollectorUI={node:w.CollectorPerformance.node,authenticated:()=>state.auth,view:()=>state.view,generation:()=>state.generation,textError:e=>e.message,api,navigate:view=>{state.view=view;w.document.dispatchEvent(new w.CustomEvent("collector:view"));}};
  for(const file of ["element-picker.js","preset-guide.js","preset-connection.js","extraction-presets.js"])w.eval(await readFile(new URL("../public/"+file,import.meta.url),"utf8"));
  return{w,d:w.document,state};
}
test("preset manager creates an inline bookmarklet, imports JSON only on save and clears after logout",async t=>{
  const dom=new JSDOM(await readFile(new URL("../public/index.html",import.meta.url),"utf8"),{url:"http://localhost/",runScripts:"outside-only",pretendToBeVisual:true});
  t.after(()=>dom.window.close());const w=dom.window,calls=[];let view="queue",auth=true,generation=1,records=[];
  w.eval(await readFile(new URL("../public/performance.js",import.meta.url),"utf8"));
  w.CollectorUI={node:w.CollectorPerformance.node,authenticated:()=>auth,view:()=>view,generation:()=>generation,textError:e=>e.message,
    api:async(path,options={})=>{calls.push({path,options});if(options.method==="POST"){records=[{id:"saved",name:config.name,origin:config.origin,kind:config.kind,pagePattern:config.pagePattern,fieldCount:1}];return{id:"saved",config};}return records;}};
  for(const file of ["element-picker.js","preset-guide.js","preset-connection.js","extraction-presets.js"])w.eval(await readFile(new URL("../public/"+file,import.meta.url),"utf8"));
  const d=w.document;assert.ok(d.getElementById("preset-bookmarklet").getAttribute("href").startsWith("javascript:"));assert.equal(calls.length,0);
  view="presets";d.dispatchEvent(new w.CustomEvent("collector:view"));await tick();
  d.getElementById("preset-json").value=JSON.stringify(config);assert.equal(calls.filter(c=>c.options.method==="POST").length,0);
  d.getElementById("preset-save").click();await tick();
  assert.equal(calls.filter(c=>c.options.method==="POST").length,1);assert.match(d.getElementById("preset-list").textContent,/safe preset/);
  auth=false;generation++;d.dispatchEvent(new w.CustomEvent("collector:auth"));assert.equal(d.getElementById("preset-json").value,"");assert.equal(d.getElementById("preset-list").children.length,0);
  assert.equal(d.getElementById("preset-page-tree").children.length,0);assert.notEqual(d.getElementById("preset-name").value,config.name);
});

test("an unregistered return link cannot trigger an authenticated preset write",async t=>{
  const calls=[],hash="#preset-return="+encodeURIComponent(JSON.stringify({token:"not-registered",config}));
  const {w,d}=await pendingFixture(t,async(path,options={})=>{calls.push({path,options});return[];},hash);await tick();
  assert.ok(!calls.some(c=>["POST","PUT"].includes(c.options.method)));assert.equal(w.location.hash,"");
  assert.match(d.getElementById("preset-error").textContent,/만료|다른 프리셋/);
});

test("every supported category and field has an annotated image and selecting a card updates the target",async t=>{
  const {w,d}=await pendingFixture(t,async()=>[]);
  for(const [kind,fields] of Object.entries(PRESET_PAGE_FIELDS)){
    d.getElementById("preset-kind").value=kind;d.getElementById("preset-kind").dispatchEvent(new w.Event("change"));
    assert.deepEqual([...d.querySelectorAll("#preset-target-field option")].map(o=>o.value),fields);
    assert.equal(d.querySelectorAll("#preset-field-gallery svg[role=img]").length,fields.length);
    const last=d.querySelector("#preset-field-gallery").lastElementChild;last.click();
    assert.equal(d.getElementById("preset-target-field").value,fields.at(-1));
    assert.match(d.getElementById("preset-guide-focus").textContent,/초록 테두리/);
    assert.ok(d.getElementById("preset-field-help").textContent.length>10);
  }
});

test("native source opening uses the user's browser without any server picker request and clears its link after logout",async t=>{
  const calls=[],opened=[];const {w,d,state}=await pendingFixture(t,async path=>{calls.push(path);return[];});
  w.open=(...args)=>{opened.push(args);return null;};
  const url="https://example.com/novel/1?page=2";d.getElementById("preset-source-url").value=url;
  d.getElementById("preset-connect-form").dispatchEvent(new w.Event("submit",{cancelable:true}));
  assert.equal(opened.length,1);assert.equal(opened[0][0],url);assert.equal(opened[0][1],"_blank");
  assert.equal(opened[0][2],"noopener,noreferrer","no window-size or UI features that request a toolbar-less popup");
  assert.deepEqual(calls,[]);assert.equal(d.getElementById("preset-source-open-link").href,url);
  assert.equal(d.getElementById("preset-connection-error").textContent,"");
  state.auth=false;state.generation++;d.dispatchEvent(new w.CustomEvent("collector:auth"));
  assert.equal(d.getElementById("preset-source-url").value,"");assert.equal(d.getElementById("preset-source-open-link").hasAttribute("href"),false);
});

test("native opener rejects executable URLs and the illustrated field becomes the new bookmark's initial selection",async t=>{
  const {w,d}=await pendingFixture(t,async()=>[]);let opened=0;w.open=()=>{opened++;};
  for(const url of ["javascript:alert(1)","data:text/html,bad","http://example.com/","https://user:fake@example.com/"]){
    d.getElementById("preset-source-url").value=url;d.getElementById("preset-connect-form").dispatchEvent(new w.Event("submit",{cancelable:true}));
  }
  assert.equal(opened,0);
  d.getElementById("preset-kind").value="detail";d.getElementById("preset-kind").dispatchEvent(new w.Event("change"));
  d.getElementById("preset-target-field").value="thumbnail";d.getElementById("preset-target-field").dispatchEvent(new w.Event("change"));
  const code=decodeURIComponent(d.getElementById("preset-bookmarklet").getAttribute("href").slice("javascript:".length));
  assert.ok(code.includes('"kind":"detail","field":"thumbnail","attribute":"src","multiple":false'));
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
