import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { FolderStore } from "../src/store.mjs";
import { Discovery } from "../src/discovery.mjs";
import { LibraryMetadata } from "../src/library-metadata.mjs";
import { createApp } from "../src/server.mjs";

async function fixture(t, { fail = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "job-profiles-http-"));
  const store = await new FolderStore(join(root, "store")).init();
  const source = await readFile(
    new URL("./fixtures/work-detail-synthetic.html", import.meta.url),
    "utf8",
  );
  const dom = new JSDOM(source, { url: "https://sbxh9.com/novel/63206" });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const counts = { visits: 0, images: 0, sourceUrls: [] };
  const discovery = new Discovery({
    rootDir: join(root, "discovery"),
    launchContext: async () => ({
      route: async () => {},
      close: async () => {},
      newPage: async () => ({
        goto: async (target) => {
          assert.equal(target, "https://sbxh9.com/novel/63206");
          counts.visits++;
          counts.sourceUrls.push(target);
          dom.reconfigure({ url: target });
          await gate;
          if (fail) throw new Error("source unavailable");
          return { status: () => 200 };
        },
        url: () => dom.window.document.URL,
        evaluate: async (fn) => fn(dom.window.document),
        close: async () => {},
      }),
    }),
    fetchImage: async () => {
      counts.images++;
      return {
        bytes: Buffer.from([255, 216, 255, 224, 1]),
        mimeType: "image/jpeg",
      };
    },
  });
  const metadata = new LibraryMetadata({ store, discovery });
  const app = createApp({
    store,
    metadata,
    discovery,
    scheduler: { currentJobId: null },
    adminPassword: "fixture-password",
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${app.address().port}`;
  const login = await fetch(origin + "/api/login", {
    method: "POST",
    body: JSON.stringify({ password: "fixture-password" }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const request = (path, method = "GET", data, authenticated = true) =>
    fetch(origin + path, {
      method,
      headers: {
        origin,
        "content-type": "application/json",
        ...(authenticated ? { cookie } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
  t.after(async () => {
    release();
    await metadata.serial;
    await metadata.close();
    await discovery.close();
    app.closeAllConnections();
    await new Promise((resolve) => app.close(resolve));
    dom.window.close();
    await rm(root, { recursive: true, force: true });
  });
  return { store, metadata, counts, request, release };
}

async function settled(f, bookId) {
  for (let n = 0; n < 100; n++) {
    const response = await f.request(`/api/books/${bookId}/metadata`);
    const state = await response.json();
    if (["completed", "failed", "deferred"].includes(state.status))
      return state;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("profile did not settle");
}

test("link registration returns before source loads and exposes a cached profile before any chapters", async (t) => {
  const f = await fixture(t);
  const response = await f.request("/api/jobs", "POST", {
    url: "https://newtoki1.org/novel/63206/123?epage=3",
    startAt: "2099-01-01T00:00:00Z",
  });
  assert.equal(response.status, 201);
  const job = await response.json();
  assert.equal(job.bookId, "newtoki1_org-63206");
  const initial = await (await f.request("/api/books")).json();
  assert.equal(initial.length, 1);
  assert.equal(initial[0].url, "https://newtoki1.org/novel/63206");
  assert.equal(initial[0].storedChapterCount, 0);
  assert.equal(initial[0].metadataStatus, "pending");
  f.release();
  assert.equal((await settled(f, job.bookId)).status, "completed");
  const ready = await (await f.request("/api/books")).json();
  assert.ok(ready[0].title);
  assert.ok(ready[0].author);
  assert.equal(ready[0].storedChapterCount, 0);
  assert.equal(ready[0].metadataStatus, "completed");
  assert.equal(f.counts.visits, 1);
  assert.deepEqual(f.counts.sourceUrls, ["https://sbxh9.com/novel/63206"]);
  assert.equal(ready[0].metadataSourceOrigin, "https://sbxh9.com");
  assert.equal(
    f.counts.images,
    1,
    "cover cached even when the browser has not requested it",
  );
  assert.equal((await f.request(ready[0].thumbnail)).status, 200);
  assert.equal(f.counts.images, 1);
  assert.equal((await f.store.getJob(job.id)).status, "queued");
});

test("normal frontend batch links seed one canonical library profile", async (t) => {
  const f = await fixture(t);
  const response = await f.request("/api/jobs/batch", "POST", {
    jobs: [
      { url: "https://sbxh9.com/novel/63206" },
      { url: "https://toki32.com/novel/63206/123" },
      { url: "https://newtoki1.org/novel/63206?epage=2" },
    ],
  });
  assert.equal(response.status, 201);
  const batch = await response.json();
  assert.equal(batch.jobs.length, 1);
  assert.equal(batch.skipped.length, 2);
  assert.equal(batch.jobs[0].bookId, "newtoki1_org-63206");
  assert.equal((await f.store.listBooks()).length, 1);
  f.release();
  assert.equal((await settled(f, batch.jobs[0].bookId)).status, "completed");
  assert.equal(f.counts.visits, 1);
});

test("batch registration seeds unique profiles and rejected input causes no profile or source request", async (t) => {
  const f = await fixture(t);
  const rejected = await f.request("/api/jobs/batch", "POST", {
    jobs: [
      { url: "https://newtoki1.org/novel/63206" },
      { url: "https://127.0.0.1/novel/1" },
    ],
  });
  assert.equal(rejected.status, 400);
  assert.deepEqual(await f.store.listBooks(), []);
  assert.equal(f.counts.visits, 0);
  assert.equal(
    (
      await f.request(
        "/api/jobs",
        "POST",
        { url: "https://newtoki1.org/novel/63206" },
        false,
      )
    ).status,
    401,
  );
  const batch = await (
    await f.request("/api/jobs/batch", "POST", {
      jobs: [
        { url: "https://newtoki1.org/novel/63206" },
        { url: "https://newtoki1.org/novel/63206/123" },
      ],
    })
  ).json();
  assert.equal(batch.jobs.length, 1);
  assert.equal(batch.skipped.length, 1);
  assert.equal(batch.jobs[0].bookId, "newtoki1_org-63206");
  assert.equal((await f.store.listBooks()).length, 1);
  f.release();
  assert.equal((await settled(f, batch.jobs[0].bookId)).status, "completed");
  assert.equal(f.counts.visits, 1);
});

test("profile fetch failure is visible while the registered collection stays queued", async (t) => {
  const f = await fixture(t, { fail: true });
  const response = await f.request("/api/jobs", "POST", {
    url: "https://newtoki1.org/novel/63206",
  });
  assert.equal(response.status, 201);
  const job = await response.json();
  assert.ok(job.bookId);
  f.release();
  assert.equal((await settled(f, job.bookId)).status, "failed");
  const books = await (await f.request("/api/books")).json();
  assert.equal(books[0].metadataStatus, "failed");
  assert.equal((await f.store.getJob(job.id)).status, "queued");
  assert.equal(books[0].storedChapterCount, 0);
});
