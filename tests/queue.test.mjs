import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderStore } from "../src/store.mjs";
import { Scheduler } from "../src/queue.mjs";
import { createHash } from "node:crypto";
const chapterId = (n) =>
  createHash("sha256")
    .update(`https://newtoki1.org/novel/1/${n}`)
    .digest("hex")
    .slice(0, 24);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, diagnostics) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await delay(10);
  }
  throw Error(
    "Timed out" +
      (diagnostics ? ": " + JSON.stringify(await diagnostics()) : ""),
  );
}

test("deleting a failed record before its final event does not reject its worker", async (t) => {
  const { store, scheduler } = await setup(t, {
    async run() {
      throw new Error("reader failed");
    },
    async close() {},
  });
  const job = await store.createJob({ url: "https://newtoki1.org/novel/1" });
  const patchJob = store.patchJob.bind(store);
  let deleted = false,
    missingEvent = false;
  store.patchJob = async (id, patch) => {
    const committed = await patchJob(id, patch);
    if (id === job.id && committed.status === "failed" && !deleted) {
      await store.deleteJob(id);
      deleted = true;
    }
    return committed;
  };
  const appendEvent = store.appendEvent.bind(store);
  store.appendEvent = async (id, event) => {
    try {
      return await appendEvent(id, event);
    } catch (error) {
      if (id === job.id && error.status === 404) missingEvent = true;
      throw error;
    }
  };
  await scheduler.start();
  const task = scheduler.active.get(job.id)?.task;
  assert.ok(task);
  await assert.doesNotReject(task);
  assert.equal(deleted, true);
  assert.equal(missingEvent, true);
  assert.equal(await store.getJob(job.id), null);
  assert.deepEqual(scheduler.activeJobIds, []);
});

test("unexpected cleanup failure is reported and cannot escape the scheduled promise", async (t) => {
  const errors = [];
  const { store, scheduler } = await setup(
    t,
    {
      async run() {
        return { completed: 1 };
      },
      async close() {
        throw Object.assign(new Error("storage cleanup EIO"), { code: "EIO" });
      },
    },
    { onError: (error) => errors.push(error) },
  );
  const job = await store.createJob({ url: "https://newtoki1.org/novel/1" });
  await scheduler.start();
  const task = scheduler.active.get(job.id)?.task;
  assert.ok(task);
  await assert.doesNotReject(task);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /storage cleanup EIO/);
  assert.equal(errors[0].jobId, job.id);
  scheduler.collector.close = async () => {};
});

test("failed running-state write releases the reserved server slot for the next tick", async (t) => {
  const { store, scheduler } = await setup(t, {
    async run() {
      return { completed: 1 };
    },
    async close() {},
  });
  const job = await store.createJob({ url: "https://newtoki1.org/novel/1" });
  const patchJob = store.patchJob.bind(store);
  let failOnce = true;
  store.patchJob = async (id, patch) => {
    if (failOnce && patch.status === "running") {
      failOnce = false;
      throw Object.assign(new Error("atomic rename temporarily locked"), {
        code: "EPERM",
      });
    }
    return patchJob(id, patch);
  };
  scheduler.enabled = true;
  await assert.rejects(scheduler.tick(), { code: "EPERM" });
  assert.deepEqual(scheduler.activeJobIds, []);
  assert.equal((await store.getJob(job.id)).status, "queued");
  await scheduler.tick();
  await until(async () => (await store.getJob(job.id)).status === "completed");
});

test("failed browser claim write releases both its lease and reserved slot", async (t) => {
  const { store, scheduler } = await setup(t, {
    async run() {},
    async close() {},
  });
  const job = await store.createJob({
    url: "https://newtoki1.org/novel/1",
    executor: "browser",
  });
  const patchJob = store.patchJob.bind(store);
  let failOnce = true;
  store.patchJob = async (id, patch) => {
    if (failOnce && patch.status === "running") {
      failOnce = false;
      throw Object.assign(new Error("atomic rename temporarily locked"), {
        code: "EPERM",
      });
    }
    return patchJob(id, patch);
  };
  await assert.rejects(scheduler.claim("pc"), { code: "EPERM" });
  assert.deepEqual(scheduler.activeJobIds, []);
  assert.equal(scheduler.lease, null);
  const claimed = await scheduler.claim("pc");
  assert.equal(claimed.job.id, job.id);
});
async function setup(t, collector, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "novel-queue-"));
  const store = await new FolderStore(root).init();
  const scheduler = new Scheduler({
    store,
    collector,
    intervalMs: 10,
    ...options,
  });
  t.after(async () => {
    await scheduler.stop();
    await rm(root, { recursive: true, force: true });
  });
  return { store, scheduler };
}
test("queue runs jobs serially and persists failure state", async (t) => {
  let active = 0,
    max = 0;
  const order = [];
  const { store, scheduler } = await setup(
    t,
    {
      async run(job, { report }) {
        active++;
        max = Math.max(max, active);
        order.push(job.id);
        await report({ completed: 1 });
        await delay(15);
        active--;
        if (job.title === "fail") throw Error("broken");
        return { total: 1, completed: 1 };
      },
      async close() {},
    },
    { maxConcurrency: 1 },
  );
  const first = await store.createJob({ url: "https://newtoki1.org/novel/1" });
  const second = await store.createJob({
    url: "https://newtoki1.org/novel/2",
    title: "fail",
  });
  await scheduler.start();
  await until(
    async () => (await store.getJob(second.id)).status === "failed",
    async () => ({
      jobs: await store.listJobs(),
      activeJobIds: scheduler.activeJobIds,
      lastError: scheduler.lastError,
    }),
  );
  assert.deepEqual(order, [first.id, second.id]);
  assert.equal(max, 1);
  assert.equal((await store.getJob(first.id)).status, "completed");
});
test("pause cancels active collector, resume queues, restart recovers running", async (t) => {
  const { store, scheduler } = await setup(t, {
    async run(job, hooks, signal) {
      await new Promise((resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    },
    async close() {},
  });
  const job = await store.createJob({ url: "https://newtoki1.org/novel/1" });
  await scheduler.start();
  await until(() => Promise.resolve(scheduler.currentJobId === job.id));
  await scheduler.action(job.id, "pause");
  await until(async () => (await store.getJob(job.id)).status === "paused");
  await scheduler.stop();
  await scheduler.action(job.id, "resume");
  assert.equal((await store.getJob(job.id)).status, "queued");
  await store.patchJob(job.id, { status: "running" });
  await scheduler.start();
  await until(() => Promise.resolve(scheduler.currentJobId === job.id));
  await scheduler.action(job.id, "cancel");
  assert.equal((await store.getJob(job.id)).status, "cancelled");
});
test("site challenge becomes needs_attention", async (t) => {
  const { store, scheduler } = await setup(t, {
    async run() {
      throw Object.assign(Error("challenge"), { code: "NEEDS_ATTENTION" });
    },
    async close() {},
  });
  const job = await store.createJob({ url: "https://newtoki1.org/novel/1" });
  await scheduler.start();
  await until(
    async () => (await store.getJob(job.id)).status === "needs_attention",
    async () => ({
      job: await store.getJob(job.id),
      activeJobIds: scheduler.activeJobIds,
      lastError: scheduler.lastError,
    }),
  );
});
test("browser lease limits ownership, validates catalog and persists chapter export", async (t) => {
  const { store, scheduler } = await setup(t, {
    async run() {},
    async close() {},
  });
  const job = await store.createJob({
    url: "https://newtoki1.org/novel/1",
    executor: "browser",
  });
  await scheduler.start();
  const claim = await scheduler.claim("pc1");
  assert.equal(claim.job.id, job.id);
  assert.deepEqual(await scheduler.claim("pc2"), { job: null });
  await assert.rejects(
    scheduler.agentOperation(
      job.id,
      "heartbeat",
      { clientId: "pc2" },
      claim.leaseToken,
    ),
  );
  await assert.rejects(
    scheduler.agentOperation(
      job.id,
      "catalog",
      { clientId: "pc1", bookId: "2", chapters: [] },
      claim.leaseToken,
    ),
  );
  const catalog = await scheduler.agentOperation(
    job.id,
    "catalog",
    {
      clientId: "pc1",
      bookId: "newtoki1_org-1",
      title: "책",
      chapters: [
        {
          id: chapterId("11"),
          number: 1,
          title: "첫화",
          url: "https://newtoki1.org/novel/1/11",
        },
        {
          id: chapterId("12"),
          number: 2,
          title: "둘째",
          url: "https://newtoki1.org/novel/1/12",
        },
      ],
    },
    claim.leaseToken,
  );
  assert.equal(catalog.chapters.length, 2);
  await assert.rejects(
    scheduler.agentOperation(
      job.id,
      "finish",
      { clientId: "pc1" },
      claim.leaseToken,
    ),
  );
  await Promise.all(
    ["11", "12"].map((n) =>
      scheduler.agentOperation(
        job.id,
        "chapter",
        { clientId: "pc1", id: chapterId(n), text: "본문 " + n },
        claim.leaseToken,
      ),
    ),
  );
  await scheduler.agentOperation(
    job.id,
    "chapter",
    { clientId: "pc1", id: chapterId("11"), text: "중복" },
    claim.leaseToken,
  );
  assert.equal((await store.getJob(job.id)).completed, 2);
  const finished = await scheduler.agentOperation(
    job.id,
    "finish",
    { clientId: "pc1" },
    claim.leaseToken,
  );
  assert.equal(finished.status, "completed");
  assert.ok(
    await store.getExport(job.id, "txt"),
    JSON.stringify({
      job: await store.getJob(job.id),
      lastError: scheduler.lastError,
    }),
  );
  assert.equal(scheduler.currentJobId, null);
  await assert.rejects(
    scheduler.agentOperation(
      job.id,
      "heartbeat",
      { clientId: "pc1" },
      claim.leaseToken,
    ),
  );
});
test("expired browser lease needs attention and a future reservation stays queued", async (t) => {
  const { store, scheduler } = await setup(t, {
    async run() {
      return { failed: 1 };
    },
    async close() {},
  });
  const job = await store.createJob({
    url: "https://newtoki1.org/novel/1",
    executor: "browser",
  });
  const future = await store.createJob({
    url: "https://newtoki1.org/novel/2",
    startAt: new Date(Date.now() + 3600000).toISOString(),
  });
  await scheduler.start();
  await scheduler.claim("pc");
  scheduler.lease.expires = Date.now() - 1;
  await scheduler.tick();
  assert.equal((await store.getJob(job.id)).status, "needs_attention");
  assert.equal((await store.getJob(future.id)).status, "queued");
  await scheduler.action(job.id, "retry");
  assert.equal((await store.getJob(job.id)).status, "queued");
  await assert.rejects(scheduler.action(future.id, "resume"));
});
test("collector failure result stays failed and stored export metadata survives array result", async (t) => {
  let storeReference;
  const { store, scheduler } = await setup(t, {
    async run(job) {
      await storeReference.writeExport(
        job.id,
        "txt",
        Buffer.from("saved"),
        "saved.txt",
      );
      return {
        total: 1,
        failed: 1,
        completed: 0,
        skipped: 0,
        status: "failed",
        exports: [{ format: "txt" }],
      };
    },
    async close() {},
  });
  storeReference = store;
  const job = await store.createJob({ url: "https://newtoki1.org/novel/1" });
  await scheduler.start();
  await until(async () => (await store.getJob(job.id)).status === "failed");
  assert.ok(await store.getExport(job.id, "txt"));
});
test("browser EPUB completion delegates exportBook with canonical folder IDs", async (t) => {
  let storeReference, exportedJob;
  const { store, scheduler } = await setup(t, {
    async run() {
      return {};
    },
    async close() {},
    async exportBook(job, chapters) {
      exportedJob = job;
      assert.equal(chapters[0].text, "본문");
      await storeReference.writeExport(
        job.id,
        "epub",
        Buffer.from("epub-bytes"),
        "book.epub",
      );
      return { exports: [{ format: "epub" }] };
    },
  });
  storeReference = store;
  const job = await store.createJob({
    url: "https://newtoki1.org/novel/1",
    executor: "browser",
    format: "epub",
  });
  await scheduler.start();
  const { leaseToken } = await scheduler.claim("pc");
  const identity = { clientId: "pc" };
  await scheduler.agentOperation(
    job.id,
    "catalog",
    {
      ...identity,
      bookId: "newtoki1_org-1",
      title: "제목",
      chapters: [
        {
          id: chapterId("11"),
          number: 1,
          title: "회차",
          url: "https://newtoki1.org/novel/1/11",
        },
      ],
    },
    leaseToken,
  );
  await scheduler.agentOperation(
    job.id,
    "chapter",
    { ...identity, id: chapterId("11"), text: "본문" },
    leaseToken,
  );
  await scheduler.agentOperation(job.id, "finish", identity, leaseToken);
  assert.equal(exportedJob.bookId, "newtoki1_org-1");
  assert.equal((await store.getExport(job.id, "epub")).filename, "book.epub");
});
test("a waiting browser job does not block a later server job", async (t) => {
  const ran = [];
  const { store, scheduler } = await setup(t, {
    async run(job) {
      ran.push(job.id);
      return { total: 1, completed: 1 };
    },
    async close() {},
  });
  const browser = await store.createJob({
    url: "https://newtoki1.org/novel/1",
    executor: "browser",
  });
  const server = await store.createJob({ url: "https://newtoki1.org/novel/2" });
  await scheduler.start();
  await until(
    async () => (await store.getJob(server.id)).status === "completed",
  );
  assert.deepEqual(ran, [server.id]);
  assert.equal((await store.getJob(browser.id)).status, "queued");
  const claim = await scheduler.claim("pc");
  assert.equal(claim.job.id, browser.id);
});
test("browser claim selects browser work even when an older server job is queued and keeps one global job", async (t) => {
  const ran = [];
  const { store, scheduler } = await setup(
    t,
    {
      async run(job) {
        ran.push(job.id);
        return { total: 1, completed: 1 };
      },
      async close() {},
    },
    { maxConcurrency: 1 },
  );
  const server = await store.createJob({ url: "https://newtoki1.org/novel/1" });
  const browser = await store.createJob({
    url: "https://newtoki1.org/novel/2",
    executor: "browser",
  });
  const claim = await scheduler.claim("pc");
  assert.equal(claim.job.id, browser.id);
  scheduler.enabled = true;
  await scheduler.tick();
  assert.deepEqual(ran, []);
  assert.equal((await store.getJob(server.id)).status, "queued");
  assert.deepEqual(await scheduler.claim("other"), { job: null });
  await scheduler.agentOperation(
    browser.id,
    "finish",
    { clientId: "pc", error: "test finished" },
    claim.leaseToken,
  );
  await scheduler.tick();
  await until(
    async () => (await store.getJob(server.id)).status === "completed",
  );
  assert.deepEqual(ran, [server.id]);
});

function controlledCollectors() {
  const started = [],
    running = new Map(),
    instances = [];
  const collector = { async close() {} };
  const collectorFactory = (slotId) => {
    const instance = {
      slotId,
      async run(job, hooks, signal) {
        started.push({ id: job.id, slotId, signal });
        return new Promise((resolve, reject) => {
          running.set(job.id, {
            resolve: (patch = { total: 1, completed: 1 }) => resolve(patch),
            hooks,
            signal,
          });
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
      async close() {},
    };
    instances.push(instance);
    return instance;
  };
  return { collector, collectorFactory, started, running, instances };
}

test("default capacity starts two jobs, queues the third and immediately refills a free slot", async (t) => {
  const execution = controlledCollectors();
  const { store, scheduler } = await setup(t, execution.collector, {
    collectorFactory: execution.collectorFactory,
    intervalMs: 100000,
  });
  const jobs = [];
  for (const number of [1, 2, 3])
    jobs.push(
      await store.createJob({ url: `https://newtoki1.org/novel/${number}` }),
    );
  await scheduler.start();
  assert.equal(scheduler.maxConcurrency, 2);
  assert.deepEqual(
    scheduler.activeJobIds,
    jobs.slice(0, 2).map((job) => job.id),
  );
  assert.equal(execution.started.length, 2);
  assert.equal(new Set(execution.started.map((entry) => entry.slotId)).size, 2);
  assert.equal((await store.getJob(jobs[2].id)).status, "queued");
  execution.running.get(jobs[0].id).resolve();
  await until(() => execution.running.has(jobs[2].id));
  assert.equal(scheduler.activeJobIds.length, 2);
});

test("pausing one collector preserves the other and fills only the freed slot", async (t) => {
  const execution = controlledCollectors();
  const { store, scheduler } = await setup(t, execution.collector, {
    collectorFactory: execution.collectorFactory,
  });
  const jobs = [];
  for (const number of [1, 2, 3])
    jobs.push(
      await store.createJob({ url: `https://newtoki1.org/novel/${number}` }),
    );
  await scheduler.start();
  await scheduler.action(jobs[0].id, "pause");
  await until(() => execution.running.has(jobs[2].id));
  assert.equal(execution.running.get(jobs[0].id).signal.aborted, true);
  assert.equal(execution.running.get(jobs[1].id).signal.aborted, false);
  assert.equal((await store.getJob(jobs[0].id)).status, "paused");
  assert.equal((await store.getJob(jobs[1].id)).status, "running");
});

test("the same canonical work cannot run concurrently even with different titles or catalog pages", async (t) => {
  const execution = controlledCollectors();
  const { store, scheduler } = await setup(t, execution.collector, {
    collectorFactory: execution.collectorFactory,
  });
  const first = await store.createJob({
    url: "https://newtoki1.org/novel/1",
    title: "first",
  });
  const duplicate = await store.createJob({
    url: "https://newtoki1.org/novel/1?epage=3",
    title: "different title",
  });
  const other = await store.createJob({ url: "https://newtoki1.org/novel/2" });
  await scheduler.start();
  assert.deepEqual(scheduler.activeJobIds, [first.id, other.id]);
  assert.equal((await store.getJob(duplicate.id)).status, "queued");
  execution.running.get(first.id).resolve();
  await until(() => execution.running.has(duplicate.id));
  assert.equal(execution.running.get(other.id).signal.aborted, false);
});

test("stop aborts both workers, preserves saved counters and restart restores both jobs", async (t) => {
  const execution = controlledCollectors();
  const { store, scheduler } = await setup(t, execution.collector, {
    collectorFactory: execution.collectorFactory,
  });
  const first = await store.createJob({ url: "https://newtoki1.org/novel/1" });
  const second = await store.createJob({ url: "https://newtoki1.org/novel/2" });
  await scheduler.start();
  await store.patchJob(first.id, { completed: 7 });
  const priorSignals = [first, second].map(
    (job) => execution.running.get(job.id).signal,
  );
  await scheduler.stop();
  assert.ok(priorSignals.every((signal) => signal.aborted));
  assert.deepEqual(scheduler.activeJobIds, []);
  assert.equal((await store.getJob(first.id)).status, "queued");
  assert.equal((await store.getJob(first.id)).completed, 7);
  await scheduler.start();
  assert.equal(execution.started.length, 4);
  assert.equal(scheduler.activeJobIds.length, 2);
});

test("browser and server jobs share capacity and competing tick/claim calls never exceed two", async (t) => {
  const execution = controlledCollectors();
  const { store, scheduler } = await setup(t, execution.collector, {
    collectorFactory: execution.collectorFactory,
  });
  const server = await store.createJob({ url: "https://newtoki1.org/novel/1" });
  const browser = await store.createJob({
    url: "https://newtoki1.org/novel/2",
    executor: "browser",
  });
  await store.createJob({
    url: "https://newtoki1.org/novel/3",
    executor: "browser",
  });
  await scheduler.start();
  const claims = await Promise.all(
    Array.from({ length: 6 }, (_, index) => scheduler.claim(`pc${index}`)),
  );
  const claimed = claims.filter((result) => result.job);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].job.id, browser.id);
  assert.deepEqual(scheduler.activeJobIds, [server.id, browser.id]);
  await store.createJob({ url: "https://newtoki1.org/novel/4" });
  await Promise.all(Array.from({ length: 6 }, () => scheduler.tick()));
  assert.equal(scheduler.activeJobIds.length, 2);
  assert.equal(execution.started.length, 1);
});

test("same work browser claim is held and capacity above two is rejected", async (t) => {
  const execution = controlledCollectors();
  const { store, scheduler } = await setup(t, execution.collector, {
    collectorFactory: execution.collectorFactory,
  });
  await store.createJob({ url: "https://newtoki1.org/novel/1" });
  await store.createJob({
    url: "https://newtoki1.org/novel/1?epage=2",
    executor: "browser",
  });
  await scheduler.start();
  assert.deepEqual(await scheduler.claim("pc"), { job: null });
  for (const maxConcurrency of [0, 3, 100, 1.5])
    assert.throws(
      () =>
        new Scheduler({
          store,
          collector: execution.collector,
          maxConcurrency,
        }),
    );
});

test("runtime capacity and delay settings affect future jobs without aborting active collectors", async (t) => {
  const execution = controlledCollectors();
  const { store, scheduler } = await setup(t, execution.collector, {
    collectorFactory: execution.collectorFactory,
  });
  const jobs = [];
  for (const number of [1, 2, 3])
    jobs.push(
      await store.createJob({ url: `https://newtoki1.org/novel/${number}` }),
    );
  await scheduler.start();
  const oldDelay = execution.instances.map((instance) => instance.delayMs);
  await scheduler.configure({ maxConcurrency: 1, chapterDelayMs: 4321 });
  assert.equal(scheduler.activeJobIds.length, 2);
  assert.ok(execution.started.every((entry) => !entry.signal.aborted));
  assert.deepEqual(
    execution.instances.map((instance) => instance.delayMs),
    oldDelay,
  );
  execution.running.get(jobs[0].id).resolve();
  await until(() => !scheduler.activeJobIds.includes(jobs[0].id));
  assert.equal(execution.started.length, 2);
  execution.running.get(jobs[1].id).resolve();
  await until(() => execution.running.has(jobs[2].id));
  assert.equal(scheduler.active.get(jobs[2].id).collector.delayMs, 4321);
  await assert.rejects(scheduler.configure({ maxConcurrency: 3 }));
});

test("retry_failed records selected safe chapter IDs and preserves successful chapter files", async (t) => {
  const { store, scheduler } = await setup(t, {
    async run() {},
    async close() {},
  });
  const job = await store.createJob({ url: "https://newtoki1.org/novel/1" });
  await store.patchJob(job.id, {
    status: "completed_with_errors",
    failedChapters: [{ id: "chapter-2" }],
  });
  const retry = await scheduler.action(job.id, "retry_failed", {
    chapterIds: ["chapter-2"],
  });
  assert.equal(retry.status, "queued");
  assert.equal(retry.retryOnlyFailed, true);
  assert.equal(retry.overwrite, false);
  assert.deepEqual(retry.retryChapterIds, ["chapter-2"]);
  await store.patchJob(job.id, { status: "failed" });
  await assert.rejects(
    scheduler.action(job.id, "retry_failed", { chapterIds: ["../secret"] }),
  );
  assert.equal((await store.getJob(job.id)).status, "failed");
});

test("a work blocked by site controls releases its slot and the next work proceeds", async (t) => {
  const order = [];
  const { store, scheduler } = await setup(
    t,
    {
      async run(job) {
        order.push(job.id);
        return job.title === "blocked"
          ? {
              status: "completed_with_errors",
              completed: 1,
              failed: 2,
              blockedReason: "HTTP 429",
              failedChapters: [{ id: "deferred" }],
            }
          : { status: "completed", completed: 1 };
      },
      async close() {},
    },
    { maxConcurrency: 1 },
  );
  const first = await store.createJob({
    url: "https://newtoki1.org/novel/1",
    title: "blocked",
  });
  const second = await store.createJob({ url: "https://newtoki1.org/novel/2" });
  await scheduler.start();
  await until(
    async () => (await store.getJob(second.id)).status === "completed",
    async () => ({
      jobs: await store.listJobs(),
      active: [...scheduler.active].map(([id, entry]) => ({
        id,
        taskPresent: !!entry.task,
        signalAborted: entry.controller?.signal.aborted,
      })),
      lastError: scheduler.lastError,
      order,
    }),
  );
  assert.deepEqual(order, [first.id, second.id]);
  assert.equal((await store.getJob(first.id)).blockedReason, "HTTP 429");
});
