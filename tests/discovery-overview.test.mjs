import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { Discovery } from "../src/discovery.mjs";
import { createApp } from "../src/server.mjs";

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),"work-overview-"));
  const dom=new JSDOM(`<section class="novel-detail"><div class="nd-info"><h1>소개 작품</h1><div class="nd-meta"><a href="/search?field=author&q=writer">작가 이름</a> · 17화</div><div class="nd-platform">공급처</div><span class="nv-badge--done">완결</span><div class="hero-v2-tags"><a>#성장</a><a>#모험</a></div><div class="nd-desc">첫 소개<br>다음 소개</div></div></section>`,{url:"https://sbxh9.com/novel/1"});
  const calls={visits:[],reads:[]};
  let release;const gate=new Promise(r=>{release=r;});
  const page={url:()=>dom.window.document.URL,goto:async url=>{calls.visits.push(url);await gate;return{status:()=>200};},
    evaluate:async fn=>{calls.reads.push(fn.name);assert.notEqual(fn.name,"readCatalogDocument");return fn(dom.window.document);},close:async()=>{}};
  const discovery=new Discovery({rootDir:root,launchContext:async()=>({route:async()=>{},newPage:async()=>page,close:async()=>{}})});
  await discovery.registerWork("1",{url:"https://newtoki1.org/novel/1",title:"목록 제목",genres:["판타지"],rating:4.8});
  t.after(async()=>{release();await discovery.close();dom.window.close();await rm(root,{recursive:true,force:true});});
  return{discovery,calls,release};
}

test("overview reads one introduction page, deduplicates concurrent requests and caches metadata without catalog scanning",async t=>{
  const f=await fixture(t);
  assert.equal((await f.discovery.overviewState("1")).status,"idle");
  assert.equal(f.calls.visits.length,0,"GET status is disk-only");
  const [a,b]=await Promise.all([f.discovery.requestOverview("1"),f.discovery.requestOverview("1")]);
  assert.equal(a.status,"pending");assert.equal(b.status,"pending");f.release();
  const item=await f.discovery.overview("1");
  assert.deepEqual(f.calls.visits,["https://sbxh9.com/novel/1"]);
  assert.equal(item.author,"작가 이름");assert.deepEqual(item.tags,["성장","모험"]);
  assert.equal(item.synopsis,"첫 소개\n다음 소개");assert.equal(item.episodeCount,17);
  assert.equal(item.publication,"completed");assert.deepEqual(item.genres,["판타지"]);
  assert.equal(item.rating,4.8);
  assert.equal((await f.discovery.overviewState("1")).status,"completed");
  await f.discovery.requestOverview("1");assert.equal(f.calls.visits.length,1);
});

test("overview API keeps admin and same-origin protection and returns asynchronous status",async t=>{
  const seen=[];
  const app=createApp({store:{},scheduler:{},adminPassword:"fixture-password",discovery:{
    overviewState:async id=>{seen.push(["get",id]);return{status:"idle",item:{id}};},
    requestOverview:async id=>{seen.push(["post",id]);return{status:"pending"};},
  }});
  await new Promise(r=>app.listen(0,"127.0.0.1",r));t.after(()=>new Promise(r=>app.close(r)));
  const origin=`http://127.0.0.1:${app.address().port}`;
  assert.equal((await fetch(origin+"/api/discover/1/overview")).status,401);
  const login=await fetch(origin+"/api/login",{method:"POST",body:JSON.stringify({password:"fixture-password"})});
  const cookie=login.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(origin+"/api/discover/1/overview",{headers:{cookie}})).status,200);
  assert.equal((await fetch(origin+"/api/discover/1/overview",{method:"POST",headers:{cookie,origin,"content-type":"application/json"},body:"{}"})).status,202);
  assert.equal((await fetch(origin+"/api/discover/1/overview",{method:"POST",headers:{cookie,origin:"https://foreign.test","content-type":"application/json"},body:"{}"})).status,403);
  assert.equal((await fetch(origin+"/api/discover/bad/overview",{headers:{cookie}})).status,400);
  assert.deepEqual(seen,[["get","1"],["post","1"]]);
});

test("a refreshed listing with empty metadata cannot erase the saved author tags and synopsis",async t=>{
  const root=await mkdtemp(join(tmpdir(),"listing-metadata-"));let current="https://sbxh9.com/novel";
  const page={goto:async url=>{current=url;return{status:()=>200};},url:()=>current,close:async()=>{},
    evaluate:async fn=>fn.name==="readReaderDocument"?{challenge:false,verificationRequired:false}:
       {items:[{id:"1",url:"https://newtoki1.org/novel/1",title:"작품",author:"",tags:[],genres:[],rating:3.7,thumbnailUrl:null,episodeCount:null}],page:1,maxPage:1,filters:{}}};
  const discovery=new Discovery({rootDir:root,launchContext:async()=>({route:async()=>{},newPage:async()=>page,close:async()=>{}})});
  t.after(async()=>{await discovery.close();await rm(root,{recursive:true,force:true});});
   await discovery.registerWork("1",{url:"https://newtoki1.org/novel/1",title:"작품",author:"보존할 작가",tags:["성장"],genres:["판타지"],synopsis:"보존할 소개",rating:4.2});
  const result=await discovery.list();
  assert.equal(result.items[0].author,"보존할 작가");assert.deepEqual(result.items[0].tags,["성장"]);
  assert.deepEqual(result.items[0].genres,["판타지"]);assert.equal(result.items[0].synopsis,"보존할 소개");
  assert.equal(result.items[0].rating,3.7);
  const reopened=new Discovery({rootDir:root,launchContext:()=>{throw Error("Unexpected source request");}});
  t.after(()=>reopened.close());
  assert.equal((await reopened.list()).items[0].rating,3.7);
});
