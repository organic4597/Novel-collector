import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderStore } from "../src/store.mjs";
import { Scheduler } from "../src/queue.mjs";
import { BackoffController } from "../src/request-backoff.mjs";
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

test("automatic cooldown holds server/browser work but expiry never overrides user pause", async (t) => {
  const execution = controlledCollectors();
  const { store, scheduler } = await setup(t, execution.collector, {
    collectorFactory: execution.collectorFactory,
  });
  let now = 10000;
  const backoff = new BackoffController({ store, clock: () => now });
  await backoff.load();
  scheduler.backoff = backoff;
  await backoff.failure({ retryAfterMs: 1, reason: "HTTP 429" });
  const server = await store.createJob({ url: "https://newtoki1.org/novel/1" });
  await store.createJob({
    url: "https://newtoki1.org/novel/2",
    executor: "browser",
  });
  await scheduler.start();
  assert.deepEqual(scheduler.activeJobIds, []);
  assert.equal(scheduler.queuePaused, false);
  assert.deepEqual(await scheduler.claim("pc"), { job: null });
  await scheduler.pauseAll();
  now += 600001;
  await scheduler.tick();
  assert.equal(scheduler.queuePaused, true);
  assert.deepEqual(scheduler.activeJobIds, []);
  await scheduler.startAll();
  assert.ok(scheduler.activeJobIds.includes(server.id));
  assert.equal(backoff.snapshot().active, false);
});

test("manual start does not bypass an active automatic cooldown", async (t) => {
  const { store, scheduler } = await setup(t, {
    async run() {},
    async close() {},
  });
  const backoff = new BackoffController({ store, clock: () => 10000 });
  await backoff.load();
  scheduler.backoff = backoff;
  await scheduler.start();
  await scheduler.pauseAll();
  const job = await store.createJob({ url: "https://newtoki1.org/novel/1" });
  await backoff.failure({ retryAfterMs: 1 });
  await scheduler.startAll();
  assert.equal(scheduler.queuePaused, false);
  assert.deepEqual(scheduler.activeJobIds, []);
  assert.equal(backoff.snapshot().active, true);
  assert.equal((await store.getJob(job.id)).status, "queued");
});

test("five body failures leave both collectors running; explicit HTTP429 pauses them", async (t) => {
  const execution = controlledCollectors();
  const { store, scheduler } = await setup(t, execution.collector, {
    collectorFactory: execution.collectorFactory,
  });
  let now = 10000;
  scheduler.backoff = new BackoffController({ store, clock: () => now });
  await scheduler.backoff.load();
  const jobs = [];
  for (const number of [1, 2, 3])
    jobs.push(
      await store.createJob({ url: `https://newtoki1.org/novel/${number}` }),
    );
  await scheduler.start();
  await store.patchJob(jobs[0].id, {
    currentChapterId: "failed-5",
    completed: 3,
  });
  await store.patchJob(jobs[1].id, { currentChapterId: "in-flight-2" });
  for (let index = 0; index < 5; index++)
    await scheduler.requestFailed(jobs[0].id, new Error("reader failed"));
  assert.equal(scheduler.backoff.snapshot().active,false);
  assert.equal(scheduler.activeJobIds.length,2);
  assert.ok(execution.started.every(entry=>!entry.signal.aborted));
  await scheduler.requestFailed(jobs[0].id,Object.assign(new Error("HTTP 429"),{httpStatus:429}));
  await until(() => scheduler.activeJobIds.length === 0);
  assert.equal(scheduler.queuePaused, false);
  assert.ok(
    execution.started.every(
      (entry) =>
        entry.signal.aborted && entry.signal.reason.code === "AUTO_BACKOFF",
    ),
  );
  assert.ok((await store.listJobs()).every((job) => job.status === "queued"));
  assert.equal(
    (await store.getJob(jobs[0].id)).backoffResumeChapterId,
    "failed-5",
  );
  assert.equal(
    (await store.getJob(jobs[1].id)).backoffResumeChapterId,
    "in-flight-2",
  );
  assert.equal((await store.getJob(jobs[0].id)).completed, 3);
  await scheduler.tick();
  assert.equal(execution.started.length, 2);
  now += 600001;
  await scheduler.tick();
  assert.equal(execution.started.length, 4);
});

test("an untyped challenge without a server rate limit does not pause unrelated workers", async (t) => {
  const execution = controlledCollectors();
  const { store, scheduler } = await setup(t, execution.collector, {
    collectorFactory: execution.collectorFactory,
  });
  let now = 10000;
  scheduler.backoff = new BackoffController({ store, clock: () => now });
  await scheduler.backoff.load();
  const first = await store.createJob({ url: "https://newtoki1.org/novel/1" });
  const second = await store.createJob({ url: "https://newtoki1.org/novel/2" });
  await scheduler.start();
  for (let index = 0; index < 4; index++)
    await scheduler.requestFailed(first.id, new Error("reader failed"));
  await scheduler.requestFailed(
    first.id,
    Object.assign(new Error("site challenge HTTP 403"), {
      code: "NEEDS_ATTENTION",
    }),
  );
  assert.equal(execution.running.get(first.id).signal.aborted, false);
  assert.equal(execution.running.get(second.id).signal.aborted, false);
  execution.running
    .get(first.id)
    .resolve({ status: "completed_with_errors", completed: 1, failed: 1 });
  await until(() => !scheduler.activeJobIds.includes(first.id));
  now += 600001;
  await scheduler.tick();
  assert.equal((await store.getJob(first.id)).status, "completed_with_errors");
  assert.equal(
    execution.started.filter((entry) => entry.id === first.id).length,
    1,
  );
});

test("manual pause racing an automatic cooldown preserves paused statuses after expiry", async (t) => {
  const execution = controlledCollectors();
  const { store, scheduler } = await setup(t, execution.collector, {
    collectorFactory: execution.collectorFactory,
  });
  let now = 10000;
  scheduler.backoff = new BackoffController({ store, clock: () => now });
  await scheduler.backoff.load();
  const job = await store.createJob({ url: "https://newtoki1.org/novel/1" });
  await scheduler.start();
  for (let index = 0; index < 4; index++)
    await scheduler.requestFailed(job.id, new Error("reader failed"));
  await Promise.all([
    scheduler.pauseAll(),
    scheduler.requestFailed(job.id, new Error("reader failed")),
  ]);
  assert.equal(scheduler.queuePaused, true);
  assert.equal((await store.getJob(job.id)).status, "paused");
  now += 600001;
  await scheduler.tick();
  assert.deepEqual(scheduler.activeJobIds, []);
});

test("uncaught collector errors count once and stopping the service never double counts", async (t) => {
  const { store, scheduler } = await setup(t, {
    async run() {
      throw new Error("catalog failed");
    },
    async close() {},
  });
  scheduler.backoff = new BackoffController({ store });
  await scheduler.backoff.load();
  const failed = await store.createJob({ url: "https://newtoki1.org/novel/1" });
  await scheduler.start();
  await until(async () => (await store.getJob(failed.id)).status === "failed");
  assert.equal(scheduler.backoff.snapshot().consecutiveFailures, 1);
  await scheduler.stop();
  assert.equal(scheduler.backoff.snapshot().consecutiveFailures, 1);
});

test("shutdown of an in-flight worker and later cached completion leave the request failure streak unchanged", async (t) => {
  const execution = controlledCollectors();
  const { store, scheduler } = await setup(t, execution.collector, {
    collectorFactory: execution.collectorFactory,
  });
  const backoff = new BackoffController({ store });
  await backoff.load();
  scheduler.backoff = backoff;
  for (let index = 0; index < 4; index++)
    await backoff.failure({ reason: "previous reader failure" });
  const job = await store.createJob({ url: "https://newtoki1.org/novel/1" });
  await scheduler.start();
  await scheduler.stop();
  assert.equal(backoff.snapshot().consecutiveFailures, 4);
  const restored = new Scheduler({
    store,
    backoff,
    collector: {
      async run() {
        return { skipped: 3, total: 3 };
      },
      async close() {},
    },
  });
  await restored.start();
  await until(async () => (await store.getJob(job.id)).status === "completed");
  assert.equal(backoff.snapshot().consecutiveFailures, 4);
  await restored.stop();
});

test("request outcome hooks reset the streak only when explicitly reporting a real reader success", async (t) => {
  const execution = controlledCollectors();
  const { store, scheduler } = await setup(t, execution.collector, {
    collectorFactory: execution.collectorFactory,
  });
  scheduler.backoff = new BackoffController({ store });
  await scheduler.backoff.load();
  const job = await store.createJob({ url: "https://newtoki1.org/novel/1" });
  await scheduler.start();
  const hooks = execution.running.get(job.id).hooks;
  for (let index = 0; index < 4; index++)
    await hooks.requestFailure(new Error("reader error"));
  assert.equal(scheduler.backoff.snapshot().consecutiveFailures, 4);
  await hooks.requestSuccess();
  assert.equal(scheduler.backoff.snapshot().consecutiveFailures, 0);
});

test("filesystem and abort errors never add to source request failure counters", async (t) => {
  const { store, scheduler } = await setup(t, {
    async run() {},
    async close() {},
  });
  scheduler.backoff = new BackoffController({ store });
  await scheduler.backoff.load();
  for (const code of [
    "EPERM",
    "EACCES",
    "EBUSY",
    "ENOSPC",
    "EIO",
    "ENOENT",
    "ABORTED",
  ])
    await scheduler.requestFailed(
      "job",
      Object.assign(new Error("not source traffic"), { code }),
    );
  await scheduler.requestFailed(
    "job",
    Object.assign(new Error("stopped"), { name: "AbortError" }),
  );
  assert.equal(scheduler.backoff.snapshot().consecutiveFailures, 0);
});

test("uncaught filesystem errors still fail the job and retain their log without starting cooldown", async (t) => {
  const { store, scheduler } = await setup(t, {
    async run() {
      throw Object.assign(new Error("export storage EIO"), { code: "EIO" });
    },
    async close() {},
  });
  scheduler.backoff = new BackoffController({ store });
  await scheduler.backoff.load();
  const job = await store.createJob({ url: "https://newtoki1.org/novel/1" });
  await scheduler.start();
  await until(async () => (await store.getJob(job.id)).status === "failed");
  assert.equal(scheduler.backoff.snapshot().consecutiveFailures, 0);
  assert.ok(
    (await store.readEvents(job.id)).some((event) =>
      event.message.includes("export storage EIO"),
    ),
  );
});

test("explicit retry clears old cursor and catalog 429 never restores a stale last-reader ID", async (t) => {
  const { store, scheduler } = await setup(t, {
    async run() {
      throw Object.assign(new Error("server asks retry later"), {
        code: "NEEDS_ATTENTION",
        httpStatus: 429,
      });
    },
    async close() {},
  });
  scheduler.backoff = new BackoffController({ store });
  await scheduler.backoff.load();
  const job = await store.createJob({ url: "https://newtoki1.org/novel/1" });
  await store.patchJob(job.id, {
    status: "failed",
    currentChapterId: "old-last-reader",
    backoffResumeChapterId: "old-cursor",
  });
  await scheduler.action(job.id, "retry");
  await scheduler.start();
  await until(() => scheduler.activeJobIds.length === 0);
  const retried = await store.getJob(job.id);
  assert.equal(retried.status, "queued");
  assert.equal(retried.currentChapterId, null);
  assert.equal(retried.backoffResumeChapterId, null);
  assert.equal(scheduler.backoff.snapshot().active, true);
});
