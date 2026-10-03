import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderStore } from "../src/store.mjs";
import { createApp } from "../src/server.mjs";

async function fixture(t, discovery = null) {
  const root = await mkdtemp(join(tmpdir(), "novel-batch-"));
  const store = await new FolderStore(root).init();
  const scheduler = {
    activeJobIds: ["a", "b"],
    maxConcurrency: 2,
    currentJobId: "a",
    browserAgents: () => [],
  };
  const app = createApp({
    store,
    scheduler,
    discovery,
    adminPassword: "fixture-password",
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    app.closeAllConnections();
    await new Promise((resolve) => app.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${app.address().port}`;
  const login = await fetch(origin + "/api/login", {
    method: "POST",
    body: JSON.stringify({ password: "fixture-password" }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const request = (path, method = "GET", input, auth = true) =>
    fetch(origin + path, {
      method,
      headers: {
        ...(auth ? { cookie } : {}),
        origin,
        "content-type": "application/json",
      },
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
  return { root, store, request };
}

test("batch queues unique works, skips existing active work and validates whole input first", async (t) => {
  const { store, request } = await fixture(t);
  await store.createJob({ url: "https://newtoki1.org/novel/30458" });
  const response = await request("/api/jobs/batch", "POST", {
    jobs: [
      { url: "https://newtoki1.org/novel/30458?epage=3" },
      { url: "https://newtoki1.org/novel/21104", format: "epub" },
      { url: "https://newtoki1.org/novel/21104/99" },
    ],
  });
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].format, "epub");
  assert.equal(result.skipped.length, 2);
  const invalid = await request("/api/jobs/batch", "POST", {
    jobs: [
      { url: "https://newtoki1.org/novel/123" },
      { url: "http://127.0.0.1/novel/124" },
    ],
  });
  assert.equal(invalid.status, 400);
  assert.equal((await store.listJobs()).length, 2);
  assert.equal(
    (await request("/api/jobs/batch", "POST", { jobs: [] }, false)).status,
    401,
  );
  assert.equal(
    (await request("/api/jobs/batch", "POST", { jobs: [] })).status,
    400,
  );
  assert.equal(
    (
      await request("/api/jobs/batch", "POST", {
        jobs: Array.from({ length: 101 }, (_, i) => ({
          url: `https://newtoki1.org/novel/${i + 1}`,
        })),
      })
    ).status,
    400,
  );
});

test("simultaneous batch submissions queue one copy of each active work", async (t) => {
  const { request, store } = await fixture(t);
  const input = { jobs: [{ url: "https://newtoki1.org/novel/30458" }] };
  const responses = await Promise.all([
    request("/api/jobs/batch", "POST", input),
    request("/api/jobs/batch", "POST", input),
  ]);
  assert.ok(responses.every((r) => r.status === 201));
  assert.equal((await store.listJobs()).length, 1);
});

test("delete completed record hides its logs and exports but keeps the library after restart", async (t) => {
  const { root, store, request } = await fixture(t);
  const job = await store.createJob({
    url: "https://newtoki1.org/novel/30458",
  });
  await store.upsertBook("work30458", { title: "보관할 작품" });
  await store.writeChapter("work30458", "chapter3", {
    number: 3,
    title: "본문",
    url: "https://newtoki1.org/novel/30458/4153516",
    text: "보존할 본문",
  });
  await store.appendEvent(job.id, { message: "기록" });
  await store.writeExport(
    job.id,
    "txt",
    Buffer.from("보존할 본문"),
    "작품.txt",
  );
  await store.patchJob(job.id, { status: "completed" });
  assert.equal(
    (await request(`/api/jobs/${job.id}`, "DELETE", null, false)).status,
    401,
  );
  assert.equal((await request(`/api/jobs/${job.id}`, "DELETE")).status, 200);
  assert.deepEqual(await store.listJobs(), []);
  for (const suffix of ["", "/events", "/export/txt"])
    assert.equal((await request(`/api/jobs/${job.id}${suffix}`)).status, 404);
  assert.equal((await request(`/api/jobs/${job.id}`, "DELETE")).status, 404);
  const reopened = await new FolderStore(root).init();
  assert.deepEqual(await reopened.listJobs(), []);
  assert.equal(
    (await reopened.readChapter("work30458", "chapter3")).text,
    "보존할 본문",
  );
  assert.equal(await reopened.getExport(job.id, "txt"), null);
});

test("deletion rejects active records and permits all terminal records", async (t) => {
  const { store, request } = await fixture(t);
  const job = await store.createJob({
    url: "https://newtoki1.org/novel/30458",
  });
  for (const status of ["queued", "running", "paused", "needs_attention"]) {
    await store.patchJob(job.id, { status });
    assert.equal((await request(`/api/jobs/${job.id}`, "DELETE")).status, 409);
  }
  for (const status of [
    "completed",
    "completed_with_errors",
    "failed",
    "cancelled",
  ]) {
    const terminal = await store.createJob({
      url: "https://newtoki1.org/novel/21104",
    });
    await store.patchJob(terminal.id, { status });
    assert.equal(
      (await request(`/api/jobs/${terminal.id}`, "DELETE")).status,
      200,
    );
  }
});

test("discovery API protects metadata and cached images and exposes two active slots", async (t) => {
  const discovery = {
    list: async (query) => ({
      items: [],
      page: Number(query.page || 1),
      maxPage: 2,
    }),
    detail: async (id) => ({ id, episodeCount: 518 }),
    thumbnail: async () => null,
  };
  const { request } = await fixture(t, discovery);
  assert.equal(
    (await request("/api/discover", "GET", null, false)).status,
    401,
  );
  assert.equal(
    (await request("/api/discover/30458/thumbnail", "GET", null, false)).status,
    401,
  );
  const browse = await request("/api/discover?page=2");
  assert.equal(browse.status, 200);
  assert.equal((await browse.json()).page, 2);
  assert.equal(
    (await request("/api/discover/30458/refresh", "POST", {})).status,
    200,
  );
  assert.equal((await request("/api/discover/30458/thumbnail")).status, 404);
  assert.equal(
    (await request("/api/discover/not-id/refresh", "POST", {})).status,
    400,
  );
  const status = await (await request("/api/status")).json();
  assert.deepEqual(status.activeJobIds, ["a", "b"]);
  assert.equal(status.maxConcurrency, 2);
});

test("long metadata scans return immediately and expose pollable results", async (t) => {
  let ready = false;
  const state = (id) =>
    ready
      ? { status: "completed", item: { id, episodeCount: 438 } }
      : { status: "pending" };
  const discovery = {
    requestDetail: async (id) => state(id),
    detailState: async (id) => state(id),
  };
  const { request } = await fixture(t, discovery);
  const started = await request("/api/discover/63206/refresh", "POST", {});
  assert.equal(started.status, 202);
  assert.equal((await started.json()).status, "pending");
  assert.equal(
    (await request("/api/discover/63206/metadata", "GET", null, false)).status,
    401,
  );
  ready = true;
  const polled = await request("/api/discover/63206/metadata");
  assert.equal(polled.status, 200);
  assert.equal((await polled.json()).item.episodeCount, 438);
});
