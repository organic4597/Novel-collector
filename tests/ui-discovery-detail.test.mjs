import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

async function fixture(t, { deferred = false } = {}) {
  const dom=new JSDOM(await readFile(new URL("../public/index.html",import.meta.url),"utf8"),{url:"http://localhost/",runScripts:"outside-only",pretendToBeVisual:true});
  t.after(()=>dom.window.close());const w=dom.window,calls=[];
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event("close"));};
  let view="discover",auth=true,generation=1,complete,selection,updated;
  const work={id:"1",title:"<img src=x> 테스트",author:"작가 이름",platform:"공급처",genres:["판타지"],tags:["성장","모험"],publication:"completed",episodeCount:17,synopsis:"첫 소개\n둘째 소개",thumbnail:"https://unsafe.example/cover.jpg"};
  w.eval(await readFile(new URL("../public/performance.js",import.meta.url),"utf8"));
  w.CollectorUI={node:w.CollectorPerformance.node,count:w.CollectorPerformance.count,status:()=>({source:{origin:"https://sbxh9.com"}}),
    authenticated:()=>auth,generation:()=>generation,view:()=>view,textError:e=>e.message,toast:()=>{},
    navigate:value=>{view=value;w.document.dispatchEvent(new w.CustomEvent("collector:view",{detail:value}));},
    api:async(path,options={})=>{calls.push([path,options.method||"GET"]);if(options.method==="POST")return{status:"completed",item:work};
      if(deferred)return new Promise(r=>{complete=()=>r({status:"completed",item:work});});
      return{status:"idle",item:{id:"1",title:"一覧"}};},
    batch:async jobs=>{calls.push(["batch",jobs]);return{jobs:[{}]};}};
  w.DiscoveryCatalog={update:value=>{updated=value;},select:value=>{selection=value;}};
  w.eval(await readFile(new URL("../public/discovery-detail.js",import.meta.url),"utf8"));
  return{w,calls,work,updated:()=>updated,selection:()=>selection,complete:()=>complete?.(),logout:()=>{auth=false;generation++;w.document.dispatchEvent(new w.CustomEvent("collector:auth"));}};
}
const tick=()=>new Promise(r=>setTimeout(r,25));

test("work introduction displays author tags synopsis safely, caches repeats and registers the canonical work",async t=>{
  const f=await fixture(t);f.w.DiscoveryDetails.open({id:"1",title:"목록 작품"});await tick();
  const d=f.w.document;
  assert.equal(d.getElementById("work-author").textContent,"작가 이름");
  assert.match(d.getElementById("work-tags").textContent,/#성장/);
  assert.equal(d.getElementById("work-synopsis").textContent,"첫 소개\n둘째 소개");
  assert.equal(d.querySelector("#work-title img"),null);
  assert.equal(d.getElementById("work-cover").hasAttribute("src"),false,"external covers are not embedded");
  assert.equal(f.calls.length,2);assert.equal(f.updated().author,"작가 이름");
  assert.equal(d.getElementById("work-dialog").open,true);
  assert.equal(f.w.location.search,"");
  f.w.DiscoveryDetails.open({id:"1"});await tick();assert.equal(f.calls.length,2);
  d.getElementById("work-add").click();await tick();
  assert.equal(f.calls.at(-1)[1][0].url,"https://newtoki1.org/novel/1");
  d.getElementById("work-select").click();await tick();assert.equal(f.selection().id,"1");
  assert.equal(d.getElementById("work-dialog").open,false);
});

test("Escape closes the introduction popup, restores focus and leaves the list view unchanged",async t=>{
  const f=await fixture(t);const d=f.w.document;
  const opener=d.getElementById("discover-search");opener.focus();
  f.w.DiscoveryDetails.open({id:"1"});await tick();
  d.getElementById("work-dialog").dispatchEvent(new f.w.Event("cancel",{cancelable:true}));
  assert.equal(d.getElementById("work-dialog").open,false);
  assert.equal(d.activeElement,opener);assert.equal(f.w.CollectorUI.view(),"discover");
});

test("closing the introduction by changing view ignores late metadata, including after logout",async t=>{
  const f=await fixture(t,{deferred:true});f.w.DiscoveryDetails.open({id:"1",title:"early"});await tick();
  f.logout();f.complete();await tick();
  assert.equal(f.w.document.getElementById("work-synopsis").textContent,"");
  assert.equal(f.updated(),undefined);
});

test("closing a loading popup prevents a late introduction response from updating the list",async t=>{
  const f=await fixture(t,{deferred:true});f.w.DiscoveryDetails.open({id:"1"});await tick();
  f.w.document.getElementById("work-close").click();f.complete();await tick();
  assert.equal(f.updated(),undefined);
  assert.equal(f.w.document.getElementById("work-dialog").open,false);
  assert.equal(f.w.document.documentElement.classList.contains("work-popup-open"),false);
});
