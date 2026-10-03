import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderStore } from "../src/store.mjs";
import { Scheduler } from "../src/queue.mjs";
import { SiteAttention } from "../src/site-attention.mjs";
import { BackoffController } from "../src/request-backoff.mjs";
const authentication = () =>
  Object.assign(new Error("일일 조회 인증이 필요합니다."), {
    code: "NEEDS_ATTENTION",
    attentionKind: "authentication",
  });
async function until(check) {
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error("Timed out");
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "queue-site-attention-"));
  const store = await new FolderStore(root).init();
  const attention = new SiteAttention({ store });
  await attention.load();
  const backoff = new BackoffController({ store });
  await backoff.load();
  const started = [];
  const collector = {
    async close() {},
    fork(slotId) {
      return {
        async close() {},
        async run(job, hooks, signal) {
          started.push({ id: job.id, slotId, signal });
          return new Promise((resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            }),
          );
        },
      };
    },
  };
  const scheduler = new Scheduler({
    store,
    collector,
    attention,
    backoff,
    intervalMs: 10,
  });
  t.after(async () => {
    await scheduler.stop();
    await rm(root, { recursive: true, force: true });
  });
  return { root, store, attention, backoff, scheduler, started, collector };
}

test("authentication holds both sessions for its host and allows another host to proceed", async (t) => {
  const f = await fixture(t);
  const first = await f.store.createJob({
    url: "https://newtoki1.org/novel/1",
  });
  const second = await f.store.createJob({
    url: "https://newtoki1.org/novel/2",
  });
  const other = await f.store.createJob({
    url: "https://newtoki2.org/novel/3",
  });
  await f.scheduler.start();
  await f.store.patchJob(first.id, {
    currentChapterId: "reader-1",
    completed: 7,
  });
  await f.scheduler.requestFailed(first.id, authentication());
  await until(() => f.started.some((entry) => entry.id === other.id));
  for (const job of [first, second]) {
    assert.equal((await f.store.getJob(job.id)).status, "needs_attention");
    assert.equal(
      f.started.find((entry) => entry.id === job.id).signal.reason.code,
      "SITE_ATTENTION",
    );
  }
  assert.deepEqual(f.attention.get("newtoki1.org").requiredSlots, [1, 2]);
  assert.equal(
    (await f.store.getJob(first.id)).backoffResumeChapterId,
    "reader-1",
  );
  assert.equal((await f.store.getJob(first.id)).completed, 7);
  assert.equal(f.backoff.snapshot().consecutiveFailures, 0);
});

test("manual actions cannot bypass a held host; full verification releases only attention jobs", async (t) => {
  const f = await fixture(t);
  const first = await f.store.createJob({
    url: "https://newtoki1.org/novel/1",
  });
  const second = await f.store.createJob({
    url: "https://newtoki1.org/novel/2",
  });
  await f.scheduler.start();
  await f.scheduler.requestFailed(first.id, authentication());
  await until(() => f.scheduler.activeJobIds.length === 0);
  await f.scheduler.startAll();
  await f.scheduler.action(first.id, "resume");
  await f.scheduler.tick();
  assert.deepEqual(f.scheduler.activeJobIds, []);
  assert.equal(f.attention.isHeld("newtoki1.org"), true);
  await f.scheduler.action(first.id, "pause");
  await assert.rejects(f.scheduler.releaseSite("newtoki1.org"), {
    status: 409,
  });
  await f.attention.verifySlot("newtoki1.org", 1);
  await assert.rejects(f.scheduler.releaseSite("newtoki1.org"), {
    status: 409,
  });
  await f.attention.verifySlot("newtoki1.org", 2);
  await f.scheduler.releaseSite("newtoki1.org");
  assert.equal((await f.store.getJob(first.id)).status, "paused");
  assert.ok(f.scheduler.activeJobIds.includes(second.id));
});

test("manual verification owns a profile slot and automatic work cannot occupy it", async (t) => {
  const f = await fixture(t);
  await f.scheduler.start();
  await f.scheduler.reserveManualSlot(1);
  const first = await f.store.createJob({
    url: "https://newtoki2.org/novel/1",
  });
  const second = await f.store.createJob({
    url: "https://newtoki2.org/novel/2",
  });
  await f.scheduler.tick();
  assert.equal(f.started.length, 1);
  assert.equal(f.started[0].slotId, 2);
  await assert.rejects(f.scheduler.reserveManualSlot(2), { status: 409 });
  await f.scheduler.releaseManualSlot(1);
  await until(() => f.started.length === 2);
  assert.ok(f.scheduler.activeJobIds.includes(first.id));
  assert.ok(f.scheduler.activeJobIds.includes(second.id));
});

test("429 remains automatic backoff and never becomes permanent site attention", async (t) => {
  const f = await fixture(t);
  const job = await f.store.createJob({ url: "https://newtoki1.org/novel/1" });
  await f.scheduler.start();
  await f.scheduler.requestFailed(
    job.id,
    Object.assign(authentication(), { httpStatus: 429, retryAfterMs: 600000 }),
  );
  assert.equal(f.attention.isHeld("newtoki1.org"), false);
  assert.equal(f.backoff.snapshot().active, true);
  assert.equal((await f.store.getJob(job.id)).status, "queued");
});

test("metadata authentication without a job holds queued work only for its host and suspends metadata requests", async (t) => {
  const f = await fixture(t);
  let suspended = null;
  f.scheduler.onSiteAttention = (state) => {
    suspended = state.host;
  };
  const queued = await f.store.createJob({
    url: "https://newtoki1.org/novel/1",
  });
  const paused = await f.store.createJob({
    url: "https://newtoki1.org/novel/2",
  });
  await f.store.patchJob(paused.id, { status: "paused" });
  const other = await f.store.createJob({
    url: "https://newtoki2.org/novel/3",
  });
  await f.scheduler.requestFailed(
    null,
    Object.assign(authentication(), { siteHost: "newtoki1.org" }),
  );
  assert.equal((await f.store.getJob(queued.id)).status, "needs_attention");
  assert.equal((await f.store.getJob(paused.id)).status, "paused");
  assert.deepEqual(f.attention.get("newtoki1.org").requiredSlots, [1]);
  assert.equal(suspended, "newtoki1.org");
  await f.scheduler.start();
  assert.deepEqual(f.scheduler.activeJobIds, [other.id]);
});

test("all manual slots block browser claims and an active browser lease blocks profile reuse", async (t) => {
  const f = await fixture(t);
  await f.scheduler.start();
  await f.scheduler.reserveManualSlot(1);
  await f.scheduler.reserveManualSlot(2);
  const job = await f.store.createJob({
    url: "https://newtoki1.org/novel/1",
    executor: "browser",
  });
  assert.deepEqual(await f.scheduler.claim("pc"), { job: null });
  await f.scheduler.releaseManualSlot(1);
  const claimed = await f.scheduler.claim("pc");
  assert.equal(claimed.job.id, job.id);
  await assert.rejects(f.scheduler.reserveManualSlot(1), { status: 409 });
});

test("a persistent host hold survives scheduler restart and ordinary manual retry cannot release it", async (t) => {
  const f = await fixture(t);
  const job = await f.store.createJob({ url: "https://newtoki1.org/novel/1" });
  await f.scheduler.start();
  await f.scheduler.requestFailed(job.id, authentication());
  await until(() => f.scheduler.activeJobIds.length === 0);
  await f.scheduler.stop();
  await f.store.patchJob(job.id, { status: "failed" });
  await f.scheduler.action(job.id, "retry");
  const restored = new Scheduler({
    store: f.store,
    collector: f.collector,
    attention: new SiteAttention({ store: f.store }),
    intervalMs: 10,
  });
  await restored.start();
  assert.equal(restored.attention.isHeld("newtoki1.org"), true);
  assert.deepEqual(restored.activeJobIds, []);
  assert.deepEqual(await restored.claim("pc"), { job: null });
  await restored.stop();
});
