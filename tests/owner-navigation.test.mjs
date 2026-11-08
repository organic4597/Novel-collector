import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { createApp, startServer } from "../src/server.mjs";
import { ownerNavigation, backgroundWorkEnabled } from "../src/owner-navigation.mjs";

const ownerUrl = "https://hub.example.test/";
test("owner navigation is opt-in development configuration only", () => {
  for (const mode of [undefined, "production", "release", "test", "Development"])
    assert.deepEqual(ownerNavigation(mode, ownerUrl), {});
  assert.deepEqual(ownerNavigation("development", ownerUrl), { href: ownerUrl });
  for (const url of ["", "javascript:alert(1)", "http://hub.example.test", "https://name:password@hub.example.test", "https://hub.example.test/?token=private", "https://hub.example.test/#private", "//hub.example.test"])
    assert.deepEqual(ownerNavigation("development", url), {});
  assert.equal(backgroundWorkEnabled("development", "0"), false);
  assert.equal(backgroundWorkEnabled("release", "0"), true);
  assert.equal(backgroundWorkEnabled("development", undefined), true);
});

test("development migration mode does not start automatic work or updater timers", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-development-"));
  let instance;
  try {
    instance = await startServer({ rootDir: root, host: "127.0.0.1", port: 0, runtimeMode: "development", backgroundWork: "0" });
    assert.equal(instance.scheduler.enabled, false);
    assert.equal(instance.scheduler.queuePaused, true);
    assert.equal(instance.scheduler.timer, null);
    assert.equal(instance.updates.timer, null);
    assert.equal(instance.scheduler.collector.contextPool.refreshTimer, null);
    assert.equal((await fetch(`http://127.0.0.1:${instance.app.address().port}/api/health`)).status, 200);
  } finally {
    await instance?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("only an authenticated development session receives owner navigation", async t => {
  for (const runtimeMode of ["release", "development"]) {
    const app = createApp({ store: {}, scheduler: {}, adminPassword: "test-password", runtimeMode, ownerHubUrl: ownerUrl });
    await new Promise(resolve => app.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise(resolve => app.close(resolve)));
    const base = `http://127.0.0.1:${app.address().port}`;
    const script = await fetch(base + "/owner-navigation.js");
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type"), /javascript/);
    assert.equal((await fetch(base + "/api/owner-navigation")).status, 401);
    const login = await fetch(base + "/api/login", { method: "POST", body: JSON.stringify({ password: "test-password" }) });
    const response = await fetch(base + "/api/owner-navigation", { headers: { Cookie: login.headers.get("set-cookie").split(";")[0] } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), runtimeMode === "development" ? { href: ownerUrl } : {});
  }
});

test("owner menu has no initial link, rejects unsafe destinations, and clears on logout", async t => {
  const dom = new JSDOM('<nav class="management-nav"></nav>', { url: "https://collector.example.test", runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const w = dom.window;
  let answer = {};
  w.CollectorUI = { authenticated: () => true, api: async () => answer };
  w.eval(await readFile(new URL("../public/owner-navigation.js", import.meta.url), "utf8"));
  const auth = async valid => { w.document.dispatchEvent(new w.CustomEvent("collector:auth", { detail: valid })); await new Promise(resolve => setImmediate(resolve)); };
  assert.equal(w.document.querySelector("a"), null);
  await auth(true);
  assert.equal(w.document.querySelector("a"), null);
  answer = { href: "javascript:alert(1)" }; await auth(true);
  assert.equal(w.document.querySelector("a"), null);
  answer = { href: ownerUrl }; await auth(true);
  assert.equal(w.document.querySelector("a").href, ownerUrl);
  assert.equal(w.document.querySelector("a").textContent, "Hub로 돌아가기");
  await auth(false);
  assert.equal(w.document.querySelector("a"), null);
});
