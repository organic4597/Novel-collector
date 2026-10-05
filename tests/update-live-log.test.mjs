import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/server.mjs";
import { ActivityLog, updateLog, updateEvent } from "../src/activity-log.mjs";
import { Updates } from "../src/updates.mjs";
import { APP_VERSION, versionParts } from "../src/version.mjs";

async function fixture(t, updates) {
  const root = await mkdtemp(join(tmpdir(), "update-live-log-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const activity = await new ActivityLog({ path: join(root, "activity.jsonl") }).load();
  activity.externalPath = join(root, ".updates", "dashboard-events.jsonl");
  t.after(() => activity.close());
  const app = createApp({ store: {}, scheduler: {}, adminPassword: "synthetic-log-test", updates, activity });
  await new Promise(resolve => app.listen(0, "127.0.0.1", resolve));
  t.after(() => { app.closeAllConnections(); return new Promise(resolve => app.close(resolve)); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const login = await fetch(base + "/api/login", { method: "POST", body: JSON.stringify({ password: "synthetic-log-test" }) });
  return { root, activity, base, cookie: login.headers.get("set-cookie").split(";")[0] };
}

test("the updater log requires authentication and returns incremental masked worker events without recording its own polling", async t => {
  const f = await fixture(t, {});
  assert.equal((await fetch(f.base + "/api/updates/log")).status, 401);
  const worker = await updateLog(f.root);
  updateEvent(worker, "SETUP_NPM", "Preparing token=PRIVATE_TOKEN C:\\Users\\private\\source", { targetVersion: "1.0.0.5" });
  await worker.pending;
  const response = await fetch(f.base + "/api/updates/log", { headers: { cookie: f.cookie } });
  assert.equal(response.status, 200);
  const first = await response.json();
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].details.step, "SETUP_NPM");
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE_TOKEN|Users\\\\private/);
  const count = f.activity.query().items.length;
  const second = await fetch(f.base + "/api/updates/log?after=" + first.items[0].id, { headers: { cookie: f.cookie } });
  assert.deepEqual((await second.json()).items, []);
  assert.equal(f.activity.query().items.length, count);
  assert.equal((await fetch(f.base + "/api/updates/log?after=-1", { headers: { cookie: f.cookie } })).status, 400);
  await worker.close();
});

test("a pre-launch failure is recorded as an update event rather than a running worker", async t => {
  const f = await fixture(t, { apply: async () => { throw Object.assign(Error("Service configuration missing"), { status: 503, step: "CHECK_SERVICE_CONFIG", errorCode: "SERVICE_CONFIG_REQUIRED" }); } });
  const response = await fetch(f.base + "/api/updates/apply", { method: "POST", headers: { cookie: f.cookie, Origin: f.base }, body: JSON.stringify({ version: "1.0.0.5" }) });
  assert.equal(response.status, 503);
  const rows = await fetch(f.base + "/api/updates/log", { headers: { cookie: f.cookie } }).then(response => response.json());
  assert.equal(rows.items.length, 1);
  assert.equal(rows.items[0].level, "error");
  assert.equal(rows.items[0].details.step, "CHECK_SERVICE_CONFIG");
});

test("missing restart connection leaves a visible failed preflight state without launching a worker", async t => {
  const root = await mkdtemp(join(tmpdir(), "update-preflight-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parts = versionParts(APP_VERSION); parts[3]++;
  const version = parts.join("."), repository = "example/Novel-collector";
  const release = { tag_name: version, draft: false, prerelease: false, assets: [{ name: "source.zip", state: "uploaded", size: 1,
    digest: "sha256:" + "a".repeat(64), browser_download_url: `https://github.com/${repository}/releases/download/${version}/source.zip` }] };
  let launches = 0;
  const updates = await new Updates({ rootDir: root, repository, fetcher: async () => new Response(JSON.stringify(release)), launch: () => { launches++; } }).load();
  await updates.check();
  await assert.rejects(updates.apply(version), { status: 503 });
  const status = await updates.status();
  assert.equal(status.busy, false);
  assert.equal(status.job.state, "failed");
  assert.equal(status.job.step, "CHECK_RESTART");
  assert.equal(launches, 0);
  assert.equal(JSON.parse(await readFile(join(root, ".updates", "job.json"))).errorCode, "RESTART_UNAVAILABLE");
});
