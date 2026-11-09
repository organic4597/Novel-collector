import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {JSDOM} from "jsdom";
const flush=()=>new Promise(r=>setImmediate(r));
const defaults={maxConcurrency:2,chapterDelayMs:1000,defaultFormat:"txt",refreshIntervalMs:5000,libraryPageSize:24,thumbnailFit:"contain",displayDensity:"comfortable"};
async function fixture(t,{network={enabled:true,active:true,phase:"offline",reason:"USB 연결을 확인하세요."},connect}={}){
 const dom=new JSDOM(await readFile(new URL("../public/index.html",import.meta.url),"utf8"),{url:"http://localhost:8788",runScripts:"outside-only",pretendToBeVisual:true});t.after(()=>dom.window.close());
 const w=dom.window,calls=[];let authenticated=true,generation=1,status={queuePaused:false,collectionNetwork:network};
 w.CollectorUI={authenticated:()=>authenticated,generation:()=>generation,defaults:{},status:()=>status,view:()=>"settings",toast(){},textError:e=>e.message,async refresh(){},async api(path,options={}){calls.push({path,options});if(path==="/api/settings")return defaults;if(path==="/api/collection-network/connect")return connect?connect():{accepted:true};throw Error("Unexpected "+path);}};
 w.document.getElementById("settings-view").hidden=false;
 w.eval(await readFile(new URL("../public/settings.js",import.meta.url),"utf8"));await flush();
 return{w,calls,$:id=>w.document.getElementById(id),setNetwork(value){status={...status,collectionNetwork:value};w.document.dispatchEvent(new w.CustomEvent("collector:status",{detail:status}));},expire(){authenticated=false;generation++;w.document.dispatchEvent(new w.CustomEvent("collector:auth",{detail:false}));}};
}
test("tether hold preserves dashboard controls and renders backend text safely",async t=>{
 const f=await fixture(t,{network:{enabled:true,active:true,phase:"offline",reason:"<img src=x onerror=alert(1)>"}});
 assert.match(f.$("collection-network-status").textContent,/테더링/);assert.equal(f.$("settings-save").disabled,false);assert.equal(f.$("collection-network-connect").disabled,false);assert.equal(f.$("collection-network-retry").querySelector("img"),null);assert.ok(f.$("collection-network-retry").textContent.includes("<img"));
});
test("cooldown displays remaining time and prevents premature reconnect",async t=>{
 const f=await fixture(t,{network:{enabled:true,active:true,phase:"cooldown",retryAt:new Date(Date.now()+299000).toISOString()}});
 assert.match(f.$("collection-network-retry").textContent,/[45]분/);assert.equal(f.$("collection-network-connect").disabled,true);f.$("collection-network-connect").click();await flush();assert.equal(f.calls.filter(c=>c.path==="/api/collection-network/connect").length,0);
 f.setNetwork({enabled:true,active:false,phase:"ready"});assert.match(f.$("collection-network-status").textContent,/연결됨/);assert.equal(f.$("collection-network-retry").textContent,"");assert.equal(f.$("collection-network-connect").disabled,false);
});
test("connect posts only one authenticated request and does not alter other settings",async t=>{
 let resolve;const pending=new Promise(r=>{resolve=r;});const f=await fixture(t,{connect:()=>pending});
 f.$("collection-network-connect").click();f.$("collection-network-connect").click();assert.equal(f.$("collection-network-connect").disabled,true);const calls=f.calls.filter(c=>c.path==="/api/collection-network/connect");assert.equal(calls.length,1);assert.equal(calls[0].options.method,"POST");assert.deepEqual(JSON.parse(calls[0].options.body),{});assert.equal(f.$("settings-save").disabled,false);resolve({accepted:true});await flush();assert.match(f.$("collection-network-message").textContent,/요청/);
});
test("logout clears network state and ignores late connect failure",async t=>{
 let reject;const pending=new Promise((_,r)=>{reject=r;});const f=await fixture(t,{connect:()=>pending});f.$("collection-network-connect").click();f.expire();reject(Error("old session error"));await flush();assert.equal(f.$("collection-network-connect").disabled,true);assert.equal(f.$("collection-network-error").textContent,"");assert.ok(!f.$("collection-network-status").textContent.includes("USB"));
});
test("disabled mode offers no direct-mode switch or connect operation",async t=>{
 const f=await fixture(t,{network:{enabled:false,active:false,phase:"disabled"}});assert.equal(f.$("collection-network-connect").disabled,true);assert.equal(f.$("settings-network").querySelectorAll('select,input[type="checkbox"]').length,0);assert.match(f.$("collection-network-status").textContent,/미설정/);
});
test("connection failure is shown as text without stopping settings",async t=>{
 const f=await fixture(t,{connect:async()=>{throw Error("연결 확인 실패");}});f.$("collection-network-connect").click();await flush();assert.equal(f.$("collection-network-error").textContent,"연결 확인 실패");assert.equal(f.$("settings-save").disabled,false);
});
test("dashboard reports tether hold while connected and library navigation remains available",async t=>{
 const dom=new JSDOM(await readFile(new URL("../public/index.html",import.meta.url),"utf8"),{url:"http://localhost:8788",runScripts:"outside-only",pretendToBeVisual:true});t.after(()=>dom.window.close());const w=dom.window;
 w.HTMLElement.prototype.scrollIntoView=function(){};
 w.fetch=async path=>({ok:true,status:200,json:async()=>path==="/api/session"?{authenticated:true}:path==="/api/status"?{collector:{available:true},collectionNetwork:{enabled:true,active:true,phase:"offline"},browserAgents:[]}:[]});
 for(const file of ["performance.js","queue-ui.js","app.js"])w.eval(await readFile(new URL("../public/"+file,import.meta.url),"utf8"));
 for(let i=0;i<20;i++){await flush();if(w.document.getElementById("connection-label").textContent.includes("테더링"))break;}
 assert.match(w.document.getElementById("connection-label").textContent,/서버 연결됨.*테더링/);assert.ok(w.document.getElementById("connection-dot").classList.contains("connected"));assert.equal(w.document.getElementById("nav-library").disabled,false);
});
