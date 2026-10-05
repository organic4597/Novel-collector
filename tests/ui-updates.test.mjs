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

async function fixture(t, api) {
  const dom = new JSDOM(await readFile(new URL("../public/index.html", import.meta.url), "utf8"), {
    url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window, state = { auth: true, generation: 1, view: "settings" };
  w.CollectorUI = { authenticated: () => state.auth, generation: () => state.generation,
    view: () => state.view, api, textError: error => error.message };
  w.eval(await readFile(new URL("../public/updates.js", import.meta.url), "utf8"));
  await tick();
  return { w, d: w.document, state };
}
const status = patch => ({ currentVersion: "1.0.0.4", latestVersion: "1.0.0.5", available: true,
  installable: true, busy: true, repository: "example/repo", releaseUrl: "https://github.com/example/repo/releases/tag/1.0.0.5",
  job: { state: "preparing", version: "1.0.0.5", step: "SETUP_NPM", message: "npm 준비 중" }, ...patch });

test("settings shows the running phase and appends incremental logs without interpreting markup", async t => {
  const calls = [];
  const rows = [{ id: 10, time: "2026-10-05T00:00:00Z", level: "info", message: "<img src=x> npm 준비", details: { step: "SETUP_NPM" } }];
  const f = await fixture(t, async path => {
    calls.push(path);
    return path.startsWith("/api/updates/log") ? { items: rows, hasMore: false, latestId: 999 } : status();
  });
  assert.match(f.d.getElementById("update-task-state").textContent, /준비 중/);
  assert.match(f.d.getElementById("update-task-step").textContent, /npm/);
  assert.match(f.d.getElementById("update-log").textContent, /<img src=x>/);
  assert.equal(f.d.querySelector("#update-log img"), null);
  rows.splice(0, rows.length, { id: 11, time: "2026-10-05T00:00:01Z", level: "warn", message: "명령 출력", details: { step: "SETUP_NPM" } });
  f.d.dispatchEvent(new f.w.CustomEvent("collector:view")); await tick();
  assert.ok(calls.some(path => path === "/api/updates/log?after=10"));
  assert.equal(f.d.querySelectorAll(".update-log-row").length, 2);
});

test("a rejected update request retains its actual error and never claims a worker is running", async t => {
  const f = await fixture(t, async path => {
    if (path.endsWith("/apply")) throw Error("서비스 업데이트 설정을 먼저 적용하세요.");
    if (path.startsWith("/api/updates/log")) return { items: [], hasMore: false };
    return status({ busy: false, job: { state: "idle", message: "" } });
  });
  f.d.getElementById("update-apply").click(); await tick();
  assert.match(f.d.getElementById("update-error").textContent, /서비스 업데이트 설정/);
  assert.match(f.d.getElementById("update-task-state").textContent, /시작 실패/);
});

test("an accepted update remains in preparation until its status reports a later stage", async t => {
  const f = await fixture(t, async path => {
    if (path.endsWith("/apply")) return { accepted: true };
    if (path.startsWith("/api/updates/log")) return { items: [], hasMore: false };
    return status({ busy: false, job: { state: "idle", message: "" } });
  });
  f.d.getElementById("update-apply").click(); await tick();
  assert.equal(f.d.getElementById("update-task-state").textContent, "준비 중");
  assert.doesNotMatch(f.d.getElementById("update-progress").textContent, /재시작 중/);
});

test("leaving settings and logging out stops log polling and drops a late response", async t => {
  let finish;
  const f = await fixture(t, async path => {
    if (path.startsWith("/api/updates/log")) return new Promise(resolve => { finish = resolve; });
    return status();
  });
  f.state.view = "queue";
  f.d.dispatchEvent(new f.w.CustomEvent("collector:view"));
  f.state.auth = false; f.state.generation++;
  f.d.dispatchEvent(new f.w.CustomEvent("collector:auth"));
  finish({ items: [{ id: 20, message: "late private operation", details: {} }], hasMore: false }); await tick();
  assert.equal(f.d.querySelectorAll(".update-log-row").length, 0);
  assert.doesNotMatch(f.d.getElementById("update-log").textContent, /late private/);
});
