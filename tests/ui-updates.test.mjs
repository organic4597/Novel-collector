import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
const tick=()=>new Promise(r=>setTimeout(r,20));
test("dashboard update notice is authenticated, uses cached status and dispatches only the advertised version",async t=>{
  const dom=new JSDOM(await readFile(new URL("../public/index.html",import.meta.url),"utf8"),{url:"http://localhost/",runScripts:"outside-only",pretendToBeVisual:true});t.after(()=>dom.window.close());const w=dom.window,d=w.document,calls=[];let auth=false,generation=1;
  const state={currentVersion:"1.0.0.0",latestVersion:"1.0.0.1",available:true,installable:true,busy:false,repository:"example/repo",releaseUrl:"https://github.com/example/repo/releases/tag/1.0.0.1",job:{state:"idle",message:""}};
  w.confirm=()=>true;
  w.CollectorUI={authenticated:()=>auth,generation:()=>generation,api:async(path,options={})=>{calls.push({path,options});return path.endsWith("apply")?{accepted:true}:state;}};
  w.eval(await readFile(new URL("../public/updates.js",import.meta.url),"utf8"));assert.equal(calls.length,0);
  auth=true;d.dispatchEvent(new w.CustomEvent("collector:auth"));await tick();assert.equal(d.getElementById("update-notice").hidden,false);assert.equal(d.getElementById("update-current").textContent,"1.0.0.0");
  d.getElementById("update-banner-apply").click();assert.equal(d.getElementById("update-options").hidden,false);
  d.getElementById("update-check").click();await tick();const write=calls.find(c=>c.path.endsWith("apply"));assert.deepEqual(JSON.parse(write.options.body),{channel:"stable",version:"1.0.0.1",commit:null});
  assert.ok(!calls.some(c=>c.path.includes("api.github.com")));auth=false;generation++;d.dispatchEvent(new w.CustomEvent("collector:auth"));assert.equal(d.getElementById("update-notice").hidden,true);
});

async function fixture(t, api) {
  const dom = new JSDOM(await readFile(new URL("../public/index.html", import.meta.url), "utf8"), {
    url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window, state = { auth: true, generation: 1, view: "settings" };
  w.confirm = () => true;
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
  f.d.getElementById("update-apply").click(); f.d.getElementById("update-check").click(); await tick();
  assert.match(f.d.getElementById("update-error").textContent, /서비스 업데이트 설정/);
  assert.match(f.d.getElementById("update-task-state").textContent, /시작 실패/);
});

test("an accepted update remains in preparation until its status reports a later stage", async t => {
  const f = await fixture(t, async path => {
    if (path.endsWith("/apply")) return { accepted: true };
    if (path.startsWith("/api/updates/log")) return { items: [], hasMore: false };
    return status({ busy: false, job: { state: "idle", message: "" } });
  });
  f.d.getElementById("update-apply").click(); f.d.getElementById("update-check").click(); await tick();
  assert.equal(f.d.getElementById("update-task-state").textContent, "준비 중");
  assert.doesNotMatch(f.d.getElementById("update-progress").textContent, /재시작 중/);
});

const commit = "a".repeat(40), otherCommit = "b".repeat(40);
const candidate = (channel, hash = commit) => ({ id: `${channel}:1.0.0.5:${hash}`, channel,
  version: "1.0.0.5", commit: hash, baseVersion: "1.0.0.4", summary: "검증된 수정", publishedAt: "2026-10-10T00:00:00Z", url: "https://github.com/example/repo/releases" });
function change(f, id, value) {
  f.d.getElementById(id).value = value;
  f.d.getElementById(id).dispatchEvent(new f.w.Event("change", { bubbles: true }));
}
test("one update menu checks the selected channel and applies the exact chosen revision after confirmation", async t => {
  const calls = [];
  const f = await fixture(t, async (path, options = {}) => {
    calls.push({ path, options });
    if (path.endsWith("/apply")) return { accepted: true };
    if (path.endsWith("/check")) return status({ busy: false, channel: "hotfix", candidates: [candidate("hotfix"), candidate("hotfix", otherCommit)], installed: { version: "1.0.0.4", channel: "hotfix", commit, baseVersion: "1.0.0.4" }, job: { state: "idle", message: "" } });
    if (path.startsWith("/api/updates/log")) return { items: [], hasMore: false };
    return status({ busy: false, candidates: [], installed: { version: "1.0.0.4", channel: "hotfix", commit, baseVersion: "1.0.0.4" } });
  });
  f.d.getElementById("update-apply").click();
  assert.equal(f.d.getElementById("update-options").hidden, false);
  assert.equal(f.d.getElementById("update-channel").value, "stable");
  const before = calls.length;
  change(f, "update-channel", "hotfix"); await tick();
  assert.equal(calls.length, before, "changing mode must not make network requests");
  assert.equal(f.d.getElementById("update-candidate").disabled, true);
  assert.equal(f.d.getElementById("update-check").textContent.trim(), "지금 확인");
  f.d.getElementById("update-check").click(); await tick();
  assert.deepEqual(JSON.parse(calls.find(c => c.path.endsWith("/check")).options.body), { channel: "hotfix" });
  change(f, "update-candidate", candidate("hotfix", otherCommit).id);
  let confirmation = "";
  f.w.confirm = message => { confirmation = message; return true; };
  f.d.getElementById("update-check").click(); await tick();
  assert.deepEqual(JSON.parse(calls.find(c => c.path.endsWith("/apply")).options.body), { channel: "hotfix", version: "1.0.0.5", commit: otherCommit });
  assert.match(confirmation, /핫픽스/); assert.match(confirmation, /bbbbbbb/); assert.match(confirmation, /DB·계정·프로필/);
  assert.match(f.d.getElementById("update-current").textContent, /1.0.0.4.*핫픽스.*aaaaaaa/);
});
test("changing channels discards a late check and never applies the old channel", async t => {
  let finish; const calls = [];
  const f = await fixture(t, async (path, options = {}) => {
    calls.push({ path, options });
    if (path.endsWith("/check")) return new Promise(resolve => { finish = resolve; });
    if (path.startsWith("/api/updates/log")) return { items: [], hasMore: false };
    return status({ busy: false, channel: "stable", candidates: [], job: { state: "idle", message: "" } });
  });
  f.d.getElementById("update-apply").click(); change(f, "update-channel", "develop");
  f.d.getElementById("update-check").click(); await tick();
  assert.equal(f.d.getElementById("update-check").disabled, true);
  change(f, "update-channel", "hotfix");
  finish(status({ busy: false, channel: "develop", candidates: [candidate("develop")] })); await tick();
  assert.equal(f.d.getElementById("update-candidate").options.length, 1);
  assert.equal(f.d.getElementById("update-candidate").disabled, true);
  assert.equal(f.d.getElementById("update-check").textContent.trim(), "지금 확인");
  assert.ok(!calls.some(c => c.path.endsWith("/apply")));
});
test("the pending apply locks its selected target and cannot dispatch twice", async t => {
  let finish; const writes = [];
  const f = await fixture(t, async (path, options = {}) => {
    if (path.endsWith("/apply")) { writes.push(JSON.parse(options.body)); return new Promise(resolve => { finish = resolve; }); }
    if (path.startsWith("/api/updates/log")) return { items: [], hasMore: false };
    return status({ busy: false, candidates: [candidate("stable", null)], job: { state: "idle", message: "" } });
  });
  f.d.getElementById("update-check").click(); await tick();
  assert.equal(f.d.getElementById("update-channel").disabled, true);
  assert.equal(f.d.getElementById("update-candidate").disabled, true);
  f.d.getElementById("update-check").click();
  assert.equal(writes.length, 1);
  finish({ accepted: true }); await tick();
  assert.equal(f.d.getElementById("update-channel").disabled, true);
  assert.equal(f.d.getElementById("update-check").disabled, true);
});
test("unverified experimental targets stay disabled, installed revision is text, and cancelling confirmation writes nothing", async t => {
  const calls = [];
  const f = await fixture(t, async (path, options = {}) => {
    calls.push({ path, options });
    if (path.startsWith("/api/updates/log")) return { items: [], hasMore: false };
    return status({ busy: false, channel: path.endsWith("/check") ? "develop" : "stable",
      candidates: path.endsWith("/check") ? [null, candidate("develop", "HEAD")] : [candidate("stable", null)],
      installed: { version: "<img src=x>", channel: "hotfix", commit: "<img src=x>", baseVersion: "1.0.0.4" }, job: { state: "idle", message: "" } });
  });
  assert.equal(f.d.querySelector("#update-current img"), null);
  assert.match(f.d.getElementById("update-current").textContent, /<img src=x>/);
  f.w.confirm = () => false;
  f.d.getElementById("update-check").click(); await tick();
  assert.ok(!calls.some(c => c.path.endsWith("/apply")));
  change(f, "update-channel", "develop"); f.d.getElementById("update-check").click(); await tick();
  assert.equal(f.d.getElementById("update-check").disabled, true);
  assert.match(f.d.getElementById("update-channel-help").textContent, /실험판.*불안정/);
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
