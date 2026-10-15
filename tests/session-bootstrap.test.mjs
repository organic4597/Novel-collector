import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const scripts = await Promise.all(["performance.js", "queue-ui.js", "app.js"].map(name =>
  readFile(new URL("../public/" + name, import.meta.url), "utf8")));
const reply = (data, status = 200) => ({ ok:status < 400, status, json:async()=>data });
const deferred = () => { let resolve, reject; const promise = new Promise((yes,no)=>{resolve=yes;reject=no;}); return {promise,resolve,reject}; };
async function settled(predicate) {
  for (let tries=0;tries<100;tries++) { if (predicate()) return; await new Promise(resolve=>setTimeout(resolve,5)); }
  assert.fail("bootstrap did not settle");
}
function fixture(t, { saved = null, storageDenied = false } = {}) {
  const dom = new JSDOM(html,{url:"https://collector.test/",runScripts:"outside-only",pretendToBeVisual:true});
  t.after(()=>dom.window.close());
  const w=dom.window, calls=[], sessions=[], gates=[];
  if (saved !== null) w.localStorage.setItem("collector.lastView",saved);
  if (storageDenied) Object.defineProperty(w,"localStorage",{get(){throw new w.DOMException("denied","SecurityError");}});
  w.fetch=async(path)=>{
    calls.push(path);
    if(path==="/api/session"){ const gate=deferred();gates.push(gate);return gate.promise; }
    if(path==="/api/status")return reply({maxConcurrency:2});
    if(path==="/api/jobs")return reply([]);
    return reply({});
  };
  w.HTMLElement.prototype.scrollIntoView=function(){};
  for(const [index,script] of scripts.entries())w.eval(script+"\n//# sourceURL="+new URL("../public/"+["performance.js","queue-ui.js","app.js"][index],import.meta.url).href);
  w.CollectorLibrary={refresh:async()=>calls.push("library-refresh")};
  w.document.addEventListener("collector:auth",event=>sessions.push(event.detail));
  return {w,calls,gates,sessions,$:id=>w.document.getElementById(id)};
}

test("HTML starts with a neutral session check and hides both login and protected app", t => {
  const f=fixture(t);
  assert.equal(f.$("login-view").hidden,true);
  assert.equal(f.$("app-view").hidden,true);
  assert.equal(f.$("session-view").hidden,false);
  assert.match(f.$("session-message").textContent,/확인/);
  assert.equal(f.calls.filter(path=>path!=="/api/session").length,0);
});

test("a valid session goes straight to the saved tab after auth notification", async t => {
  const f=fixture(t,{saved:"library"}), events=[];
  f.w.document.addEventListener("collector:auth",event=>events.push("auth:"+event.detail));
  f.w.document.addEventListener("collector:view",event=>events.push("view:"+event.detail));
  f.gates[0].resolve(reply({authenticated:true}));
  await settled(()=>!f.$("app-view").hidden);
  assert.equal(f.$("login-view").hidden,true);
  assert.equal(f.$("session-view").hidden,true);
  assert.equal(f.$("library-view").hidden,false);
  assert.deepEqual(events.slice(0,2),["auth:true","view:library"]);
  f.w.CollectorUI.navigate("history");
  assert.equal(f.w.localStorage.getItem("collector.lastView"),"history");
});

test("explicit navigation during authentication wins and dispatches only once", async t => {
  for(const [saved,target] of [["library","discover"],["presets","presets"]]){
    const f=fixture(t,{saved}),events=[];
    f.w.document.addEventListener("collector:view",event=>events.push(event.detail));
    f.w.document.addEventListener("collector:auth",event=>{if(event.detail)f.w.CollectorUI.navigate(target);});
    f.gates[0].resolve(reply({authenticated:true}));
    await settled(()=>!f.$("app-view").hidden);
    assert.equal(f.w.CollectorUI.view(),target);
    assert.equal(f.$(target+"-view").hidden,false);
    assert.equal(f.w.localStorage.getItem("collector.lastView"),target);
    assert.deepEqual(events,[target]);
  }
});

test("expired and unauthorized sessions show login without loading a saved protected tab", async t => {
  for(const response of [reply({authenticated:false}),reply({error:"로그인이 필요합니다."},401)]){
    const f=fixture(t,{saved:"library"});f.gates[0].resolve(response);
    await settled(()=>!f.$("login-view").hidden);
    assert.equal(f.$("app-view").hidden,true);
    assert.equal(f.$("session-view").hidden,true);
    assert.equal(f.calls.includes("library-refresh"),false);
  }
});

test("network failure keeps the neutral error screen and retry restores the session", async t => {
  const f=fixture(t);f.gates[0].reject(new f.w.TypeError("offline"));
  await settled(()=>f.$("session-retry")&&!f.$("session-retry").hidden);
  assert.equal(f.$("login-view").hidden,true);
  assert.equal(f.$("app-view").hidden,true);
  assert.equal(f.$("session-view").getAttribute("aria-busy"),"false");
  assert.match(f.$("session-message").textContent,/네트워크|연결/);
  f.$("session-retry").click();f.$("session-retry").click();
  assert.equal(f.gates.length,2,"double click cannot start parallel retries");
  f.gates[1].resolve(reply({authenticated:true}));
  await settled(()=>!f.$("app-view").hidden);
  assert.equal(f.$("session-view").hidden,true);
});

test("server errors and malformed session data never grant access or claim expiry", async t => {
  for(const response of [reply({error:"unavailable"},503),reply({}),reply({authenticated:"true"}),reply(null)]){
    const f=fixture(t);f.gates[0].resolve(response);
    await settled(()=>f.$("session-retry")&&!f.$("session-retry").hidden);
    assert.equal(f.$("login-view").hidden,true);
    assert.equal(f.$("app-view").hidden,true);
    assert.equal(f.w.CollectorUI.authenticated(),false);
  }
});

test("invalid tab values and unavailable storage do not break session restoration", async t => {
  for(const configuration of [{saved:"<img src=x>"},{saved:"constructor"},{storageDenied:true}]){
    const f=fixture(t,configuration);f.gates[0].resolve(reply({authenticated:true}));
    await settled(()=>!f.$("app-view").hidden);
    assert.equal(f.$("queue-view").hidden,false);
    f.w.CollectorUI.navigate("bogus");
    assert.equal(f.w.CollectorUI.view(),"queue");
    f.w.CollectorUI.navigate("library");
    assert.equal(f.$("library-view").hidden,false);
  }
});

test("a stale successful bootstrap cannot reopen the app after an unauthorized response", async t => {
  const f=fixture(t);
  f.w.fetch=async path=>path==="/api/session"?f.gates[0].promise:reply({error:"expired"},401);
  await assert.rejects(f.w.CollectorUI.api("/api/status"));
  assert.equal(f.$("login-view").hidden,false);
  f.gates[0].resolve(reply({authenticated:true}));
  await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(f.$("login-view").hidden,false);
  assert.equal(f.$("app-view").hidden,true);
  assert.deepEqual(f.sessions,[false]);
});
