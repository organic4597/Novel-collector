import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {releaseHistory,releaseNotesFor} from "../src/release-history.mjs";
import {Updates} from "../src/updates.mjs";
import {createApp} from "../src/server.mjs";
import {JSDOM} from "jsdom";

test("release history distinguishes published versions, installed version and development notes without ghost links",()=>{
  const history=releaseHistory("1.0.0.11");assert.equal(history.records.find(record=>record.version==="1.0.0.11").status,"current");
  const pending=history.records.find(record=>record.version==="1.0.0.14");assert.equal(pending.status,"development");assert.equal(pending.url,null);
  assert.equal(history.records.some(record=>["1.0.0.8","1.0.0.9"].includes(record.version)),false);
  const installed=releaseHistory("1.0.0.14").records[0];assert.equal(installed.status,"current");assert.match(installed.url,/1\.0\.0\.14$/);
  history.records[1].groups[0].items[0]="changed";assert.notEqual(releaseHistory("1.0.0.11").records[1].groups[0].items[0],"changed");
  assert.match(releaseNotesFor("1.0.0.11"),/웹툰.*검색/);assert.match(releaseNotesFor("1.0.0.12"),/버전별/);assert.match(releaseNotesFor("1.0.0.13"),/설치/);assert.match(releaseNotesFor("1.0.0.14"),/썸네일/);assert.throws(()=>releaseNotesFor("unknown"),/기능 내역/);
});
test("history API is admin protected and reads local curated notes without checking or applying releases",async t=>{
  const root=await mkdtemp(join(tmpdir(),"release-history-"));let network=0;
  const updates=new Updates({rootDir:root,fetcher:async()=>{network++;throw Error("must not fetch");}});
  updates.currentVersion="1.0.0.11";const app=createApp({store:{},scheduler:{},adminPassword:"fixture-password",updates});
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));t.after(async()=>{app.closeAllConnections();await new Promise(resolve=>app.close(resolve));await rm(root,{recursive:true,force:true});});
  const origin="http://127.0.0.1:"+app.address().port;
  assert.equal((await fetch(origin+"/api/updates/history")).status,401);
  const login=await fetch(origin+"/api/login",{method:"POST",body:JSON.stringify({password:"fixture-password"})}),cookie=login.headers.get("set-cookie").split(";")[0];
  const response=await fetch(origin+"/api/updates/history",{headers:{cookie}});assert.equal(response.status,200);assert.equal((await response.json()).currentVersion,"1.0.0.11");assert.equal(network,0);
});
async function fixture(t){
  const dom=new JSDOM(await readFile(new URL("../public/index.html",import.meta.url),"utf8"),{url:"http://localhost/",runScripts:"outside-only",pretendToBeVisual:true});t.after(()=>dom.window.close());
  const window=dom.window,calls=[];let view="queue",auth=true,handler=async()=>releaseHistory("1.0.0.11");
  window.eval(await readFile(new URL("../public/performance.js",import.meta.url),"utf8"));
  window.CollectorUI={...window.CollectorPerformance,authenticated:()=>auth,generation:()=>auth?1:2,view:()=>view,navigate:value=>{view=value;window.document.dispatchEvent(new window.CustomEvent("collector:view",{detail:value}));},
    api:async path=>{calls.push(path);return handler();}};
  window.eval(await readFile(new URL("../public/release-history.js",import.meta.url),"utf8"));
  return{window,calls,open:()=>window.CollectorUI.navigate("releases"),set:value=>{handler=value;},logout:()=>{auth=false;window.document.dispatchEvent(new window.CustomEvent("collector:auth"));}};
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
test("release page loads only when opened, filters versions and opens from update settings without applying",async t=>{
  const f=await fixture(t),doc=f.window.document;assert.equal(f.calls.length,0);
  doc.getElementById("update-history-open").click();await tick();assert.deepEqual(f.calls,["/api/updates/history"]);
  assert.equal(doc.querySelectorAll(".release-record").length,releaseHistory("1.0.0.11").records.length);
  doc.getElementById("release-history-version").value="1.0.0.11";doc.getElementById("release-history-version").dispatchEvent(new f.window.Event("change"));
  assert.equal(doc.querySelectorAll(".release-record").length,1);assert.match(doc.getElementById("release-history-list").textContent,/웹툰/);
  assert.equal(doc.querySelector(".release-record a").getAttribute("href"),"https://github.com/organic4597/Novel-collector/releases/tag/1.0.0.11");
  doc.getElementById("release-history-refresh").click();await tick();assert.equal(doc.querySelectorAll(".release-record").length,1);
  assert.equal(f.calls.every(path=>path==="/api/updates/history"),true);
});
test("release page retains existing notes on failure and drops late replies and errors after logout",async t=>{
  const f=await fixture(t),doc=f.window.document;f.open();await tick();
  f.set(async()=>{throw Error("fixture failure");});doc.getElementById("release-history-refresh").click();await tick();
  assert.equal(doc.querySelectorAll(".release-record").length,releaseHistory("1.0.0.11").records.length);assert.ok(doc.getElementById("release-history-error").textContent);
  let resolve;f.set(()=>new Promise(done=>{resolve=done;}));doc.getElementById("release-history-refresh").click();await tick();f.logout();resolve(releaseHistory("1.0.0.11"));await tick();
  assert.equal(doc.getElementById("release-history-list").children.length,0);assert.equal(doc.getElementById("release-history-error").textContent,"");
});
test("release page renders notes as text, rejects foreign links and handles an empty history",async t=>{
  const f=await fixture(t),doc=f.window.document,data=releaseHistory("1.0.0.11");data.records[1].groups[0].items[0]='<img src=x onerror="alert(1)">';
  f.set(async()=>data);f.open();await tick();assert.equal(doc.querySelector("#release-history-list img"),null);assert.match(doc.getElementById("release-history-list").textContent,/<img/);
  const invalid=releaseHistory("1.0.0.11");invalid.records[1].url="https://foreign.example/releases/tag/1.0.0.11";
  f.set(async()=>invalid);doc.getElementById("release-history-refresh").click();await tick();assert.ok(doc.getElementById("release-history-error").textContent);assert.equal(doc.querySelector('a[href*="foreign.example"]'),null);
  f.set(async()=>({currentVersion:"1.0.0.11",records:[]}));doc.getElementById("release-history-refresh").click();await tick();assert.match(doc.getElementById("release-history-list").textContent,/등록된.*없습니다/);
});
