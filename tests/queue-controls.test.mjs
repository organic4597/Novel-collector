import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderStore } from "../src/store.mjs";
import { Scheduler } from "../src/queue.mjs";
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

test("global pause stops both workers and holds existing/new/resumed jobs until global start", async (t) => {
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
  const paused = await scheduler.pauseAll();
  assert.equal(paused.paused, true);
  assert.equal(paused.affected, 3);
  assert.deepEqual(scheduler.activeJobIds, []);
  assert.ok(execution.started.every((entry) => entry.signal.aborted));
  assert.ok((await store.listJobs()).every((job) => job.status === "paused"));
  const added = await store.createJob({ url: "https://newtoki1.org/novel/4" });
  await scheduler.action(jobs[0].id, "resume");
  await scheduler.tick();
  assert.equal((await store.getJob(jobs[0].id)).status, "queued");
  assert.equal((await store.getJob(added.id)).status, "queued");
  assert.equal(execution.started.length, 2);
  const started = await scheduler.startAll();
  assert.equal(started.paused, false);
  assert.equal(scheduler.activeJobIds.length, 2);
  assert.equal(execution.started.length, 4);
});

test("global pause survives restart and start preserves future reservations and terminal states", async (t) => {
  const execution = controlledCollectors();
  const { store, scheduler } = await setup(t, execution.collector, {
    collectorFactory: execution.collectorFactory,
  });
  const future = await store.createJob({
    url: "https://newtoki1.org/novel/1",
    startAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const failed = await store.createJob({ url: "https://newtoki1.org/novel/2" });
  await store.patchJob(failed.id, { status: "failed" });
  await scheduler.start();
  await scheduler.pauseAll();
  await scheduler.stop();
  const restored = new Scheduler({
    store,
    collector: execution.collector,
    collectorFactory: execution.collectorFactory,
    intervalMs: 10,
  });
  t.after(() => restored.stop());
  await restored.start();
  assert.equal(restored.queuePaused, true);
  assert.deepEqual(restored.activeJobIds, []);
  assert.equal((await restored.claim("pc")).job, null);
  await restored.startAll();
  assert.equal((await store.getJob(future.id)).status, "queued");
  assert.equal((await store.getJob(failed.id)).status, "failed");
  assert.deepEqual(restored.activeJobIds, []);
  await restored.stop();
});

test("global pause invalidates the browser lease and persists before pausing workers", async (t) => {
  const { store, scheduler } = await setup(t, {
    async run() {},
    async close() {},
  });
  const job = await store.createJob({
    url: "https://newtoki1.org/novel/1",
    executor: "browser",
  });
  await scheduler.start();
  const claim = await scheduler.claim("pc");
  await scheduler.pauseAll();
  assert.equal(scheduler.lease, null);
  assert.equal((await store.getJob(job.id)).status, "paused");
  assert.deepEqual(await store.json(store.path("queue-state.json")), {
    paused: true,
  });
  await assert.rejects(
    scheduler.agentOperation(
      job.id,
      "heartbeat",
      { clientId: "pc" },
      claim.leaseToken,
    ),
  );
});

test("a failed global pause persistence write leaves running workers untouched", async (t) => {
  const execution = controlledCollectors();
  const { store, scheduler } = await setup(t, execution.collector, {
    collectorFactory: execution.collectorFactory,
  });
  const job = await store.createJob({ url: "https://newtoki1.org/novel/1" });
  await scheduler.start();
  const atomic = store.atomic.bind(store);
  store.atomic = async (path, value) => {
    if (path === store.path("queue-state.json"))
      throw Object.assign(new Error("write denied"), { code: "EACCES" });
    return atomic(path, value);
  };
  await assert.rejects(scheduler.pauseAll(), { code: "EACCES" });
  assert.equal(scheduler.queuePaused, false);
  assert.equal((await store.getJob(job.id)).status, "running");
  assert.equal(execution.running.get(job.id).signal.aborted, false);
});
