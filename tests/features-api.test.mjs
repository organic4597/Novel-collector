import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderStore } from "../src/store.mjs";
import { createApp } from "../src/server.mjs";
import { SettingsStore } from "../src/settings.mjs";
import { LibraryDownloads } from "../src/library-downloads.mjs";
async function fixture(t, { recovery = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), "novel-features-"));
  const store = await new FolderStore(root).init();
  const settings = new SettingsStore({ path: join(root, "settings.json") });
  await settings.load();
  const downloads = new LibraryDownloads({
    store,
    rootDir: join(root, "downloads"),
  });
  const config = [],
    actions = [];
  const scheduler = {
    currentJobId: null,
    activeJobIds: [],
    maxConcurrency: 2,
    browserAgents: () => [],
    async pauseAll() {
      this.queuePaused = true;
      return { paused: true, affected: 2, maxConcurrency: 2 };
    },
    async startAll() {
      this.queuePaused = false;
      return { paused: false, affected: 2, maxConcurrency: 2 };
    },
    configure(value) {
      config.push(value);
      this.maxConcurrency = value.maxConcurrency;
      return value;
    },
    async action(id, action, options) {
      actions.push({ id, action, options });
      return store.patchJob(id, { status: "queued" });
    },
  };
  const app = createApp({
    store,
    scheduler,
    settings,
    downloads,
    recovery,
    adminPassword: "fixture-password",
  });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${app.address().port}`;
  const login = async (password) => {
    const r = await fetch(origin + "/api/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    return { response: r, cookie: r.headers.get("set-cookie")?.split(";")[0] };
  };
  let cookie = (await login("fixture-password")).cookie;
  const request = (path, method = "GET", data, customCookie = cookie) =>
    fetch(origin + path, {
      method,
      headers: {
        ...(customCookie ? { cookie: customCookie } : {}),
        origin,
        "content-type": "application/json",
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
  t.after(async () => {
    await downloads.close();
    app.closeAllConnections();
    await new Promise((r) => app.close(r));
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    store,
    settings,
    downloads,
    scheduler,
    config,
    actions,
    login,
    request,
    cookie,
  };
}
test("settings require authentication and persisted validated changes configure the active scheduler", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.request("/api/settings", "GET", null, null)).status,
    401,
  );
  const before = await (await f.request("/api/settings")).json();
  assert.equal(before.maxConcurrency, 2);
  const result = await f.request("/api/settings", "PUT", {
    maxConcurrency: 1,
    chapterDelayMs: 1500,
    defaultFormat: "epub",
  });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).defaultFormat, "epub");
  assert.equal(f.config[0].maxConcurrency, 1);
  assert.deepEqual(f.config[0], { maxConcurrency: 1, chapterDelayMs: 1500 });
  assert.equal(
    (await f.request("/api/settings", "PUT", { maxConcurrency: 3 })).status,
    400,
  );
  assert.equal(f.settings.get().maxConcurrency, 1);
});

test("system information requires auth and UI-only settings never configure scheduler-only fields", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.request("/api/system/info", "GET", null, null)).status,
    401,
  );
  const info = await f.request("/api/system/info");
  assert.equal(info.status, 200);
  const data = await info.json();
  assert.equal(data.bookCount, 0);
  assert.equal(data.chapterCount, 0);
  assert.deepEqual(data.backoff, { threshold: 5, cooldownMs: 600000 });
  assert.equal(data.maxConcurrency, 2);
  assert.doesNotMatch(
    JSON.stringify(data),
    new RegExp(f.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  const update = await f.request("/api/settings", "PUT", {
    refreshIntervalMs: 2000,
    libraryPageSize: 48,
    thumbnailFit: "cover",
    displayDensity: "compact",
  });
  assert.equal(update.status, 200);
  assert.equal((await update.json()).libraryPageSize, 48);
  assert.deepEqual(f.config.at(-1), {
    maxConcurrency: 2,
    chapterDelayMs: 1000,
  });
});

test("global queue controls require auth and expose actual global state", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.request("/api/queue/start", "POST", {}, null)).status,
    401,
  );
  const paused = await f.request("/api/queue/pause", "POST", {});
  assert.equal(paused.status, 200);
  assert.equal((await paused.json()).paused, true);
  assert.equal(
    (await (await f.request("/api/status")).json()).queuePaused,
    true,
  );
  const started = await f.request("/api/queue/start", "POST", {});
  assert.equal(started.status, 200);
  assert.equal((await started.json()).paused, false);
  assert.equal(
    (await (await f.request("/api/status")).json()).queuePaused,
    false,
  );
});

test("status exposes request cooldown without changing manual pause state", async (t) => {
  const f = await fixture(t);
  f.scheduler.queuePaused = true;
  f.scheduler.backoff = {
    snapshot: () => ({
      active: true,
      until: "2026-10-03T01:00:00Z",
      remainingSeconds: 600,
      consecutiveFailures: 5,
      reason: "연속 실패",
    }),
  };
  const status = await (await f.request("/api/status")).json();
  assert.equal(status.backoff.active, true);
  assert.equal(status.backoff.remainingSeconds, 600);
  assert.equal(status.queuePaused, true);
});

test("global start requests a fresh bounded proof budget without status polling or pause causing source checks", async (t) => {
  const probes = [];
  const f = await fixture(t, {
    recovery: {
      request: (site, options) => probes.push({ host: site.host, ...options }),
    },
  });
  f.scheduler.attention = {
    snapshot: () => ({
      sites: [{ host: "newtoki1.org", held: true, kind: "captcha" }],
    }),
  };
  await f.request("/api/status");
  assert.equal(probes.length, 0);
  assert.equal((await f.request("/api/queue/start", "POST", {})).status, 200);
  assert.deepEqual(probes, [{ host: "newtoki1.org", force: true }]);
  await f.request("/api/queue/pause", "POST", {});
  assert.equal(probes.length, 1);
});
test("password change checks current password, keeps a rotated caller session and rejects old sessions", async (t) => {
  const f = await fixture(t);
  const other = (await f.login("fixture-password")).cookie;
  assert.equal(
    (
      await f.request("/api/settings/password", "POST", {
        currentPassword: "wrong",
        newPassword: "new-fixture-password",
        confirmPassword: "new-fixture-password",
      })
    ).status,
    403,
  );
  assert.equal((await f.request("/api/session")).status, 200);
  const changed = await f.request("/api/settings/password", "POST", {
    currentPassword: "fixture-password",
    newPassword: "new-fixture-password",
    confirmPassword: "new-fixture-password",
  });
  assert.equal(changed.status, 200);
  const rotated = changed.headers.get("set-cookie").split(";")[0];
  assert.equal(
    (await f.request("/api/settings", "GET", null, rotated)).status,
    200,
  );
  assert.equal(
    (await f.request("/api/settings", "GET", null, other)).status,
    401,
  );
  assert.equal((await f.login("fixture-password")).response.status, 401);
  assert.equal((await f.login("new-fixture-password")).response.status, 200);
});
test("book-wide TXT and selected ZIP remain available after deleting their source job history", async (t) => {
  const f = await fixture(t);
  const job = await f.store.createJob({
    url: "https://newtoki1.org/novel/30458",
  });
  await f.store.upsertBook("book30458", {
    title: "테스트 책",
    author: "작가",
    expectedChapterCount: 2,
  });
  for (const number of [1, 2])
    await f.store.writeChapter("book30458", `chapter${number}`, {
      number,
      title: `${number}화`,
      url: `https://newtoki1.org/novel/30458/${number}`,
      text: `본문 ${number}`,
    });
  await f.store.patchJob(job.id, { status: "completed" });
  await f.store.deleteJob(job.id);
  const txt = await f.request("/api/books/book30458/export/txt");
  assert.equal(txt.status, 200);
  const text = await txt.text();
  assert.ok(text.includes("본문 1") && text.includes("본문 2"));
  assert.match(txt.headers.get("content-type"), /text\/plain/);
  assert.equal(
    (
      await f.request(
        "/api/downloads",
        "POST",
        { bookIds: ["book30458"] },
        null,
      )
    ).status,
    401,
  );
  const creation = await f.request("/api/downloads", "POST", {
    bookIds: ["book30458"],
  });
  assert.equal(creation.status, 202);
  const bundle = await creation.json();
  let state;
  for (let i = 0; i < 100; i++) {
    state = await (await f.request(`/api/downloads/${bundle.id}`)).json();
    if (state.status !== "preparing") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(state.status, "ready");
  const zip = await f.request(`/api/downloads/${bundle.id}/file`);
  assert.equal(zip.status, 200);
  assert.match(zip.headers.get("content-type"), /application\/zip/);
  assert.ok((await zip.arrayBuffer()).byteLength > 100);
  const all = await f.request("/api/downloads", "POST", { all: true });
  assert.equal(all.status, 202);
  assert.equal((await all.json()).total, 1);
});
test("failed book retry queues selected failed IDs without overwriting good chapters", async (t) => {
  const f = await fixture(t);
  await f.store.upsertBook("book30458", {
    title: "책",
    url: "https://newtoki1.org/novel/30458",
  });
  const chapter = {
    id: "chapter2",
    number: 2,
    title: "실패 회차",
    url: "https://newtoki1.org/novel/30458/2",
  };
  await f.store.recordFailure("book30458", chapter, {
    message: "본문 준비 전",
  });
  assert.equal(
    (await (await f.request("/api/books/book30458/failures")).json()).length,
    1,
  );
  const retry = await f.request("/api/books/book30458/retry-failed", "POST", {
    chapterIds: ["chapter2"],
  });
  assert.equal(retry.status, 201);
  const job = await retry.json();
  assert.equal(job.retryOnlyFailed, true);
  assert.equal(job.overwrite, false);
  assert.deepEqual(job.retryChapterIds, ["chapter2"]);
  assert.equal(
    (
      await f.request("/api/books/book30458/retry-failed", "POST", {
        chapterIds: ["notfailed"],
      })
    ).status,
    400,
  );
  const action = await f.request(`/api/jobs/${job.id}/action`, "POST", {
    action: "retry_failed",
    chapterIds: ["chapter2"],
  });
  assert.equal(action.status, 200);
  assert.deepEqual(f.actions.at(-1).options.chapterIds, ["chapter2"]);
});
