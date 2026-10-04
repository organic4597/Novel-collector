import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderStore } from "../src/store.mjs";
import { BackoffController } from "../src/request-backoff.mjs";

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "novel-backoff-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new FolderStore(root).init();
  let now = 10000;
  const backoff = new BackoffController({
    store,
    clock: () => now,
    ...options,
  });
  await backoff.load();
  return {
    store,
    backoff,
    advance: (ms) => {
      now += ms;
    },
    clock: () => now,
  };
}

test("five ordinary body failures do not pause requests; only server limits start cooldown", async (t) => {
  const { backoff } = await fixture(t);
  for (let index = 0; index < 4; index++)
    assert.equal(
      (await backoff.failure({ reason: "reader failure" })).triggered,
      false,
    );
  assert.equal(backoff.snapshot().active, false);
  const fifth = await backoff.failure({ reason: "reader failure" });
  assert.equal(fifth.triggered, false);
  assert.equal(fifth.remainingMs, 0);
  assert.equal(backoff.snapshot().remainingSeconds, 0);
  await backoff.failure({ reason: "HTTP 429" });
  await backoff.success();
  assert.equal(backoff.snapshot().consecutiveFailures, 0);
  assert.equal(backoff.snapshot().active, true);
});

test("parallel failures serialize and cooldown survives restart before expiry reset", async (t) => {
  const { store, backoff, clock, advance } = await fixture(t);
  const results = await Promise.all(
    Array.from({ length: 5 }, () => backoff.failure({ reason: "failed" })),
  );
  assert.equal(results.filter((result) => result.triggered).length, 0);
  assert.equal(backoff.snapshot().consecutiveFailures, 5);
  const restored = new BackoffController({ store, clock });
  await restored.load();
  assert.equal(restored.snapshot().active, false);
  await restored.failure({ reason:"HTTP 429",retryAfterMs:600000 });
  const limited = new BackoffController({ store, clock });await limited.load();
  assert.equal(limited.snapshot().active,true);
  advance(600001);
  await limited.clearAfterExpiry();
  assert.equal(limited.snapshot().active, false);
  assert.equal(limited.snapshot().consecutiveFailures, 0);
  const again = new BackoffController({ store, clock });
  await again.load();
  assert.equal(again.snapshot().consecutiveFailures, 0);
});

test("legacy failure-streak pauses are cleared while legacy explicit HTTP429 waits remain",async t=>{
  const f=await fixture(t);
  await f.store.atomic(f.backoff.path,{consecutiveFailures:5,until:new Date(f.clock()+600000).toISOString(),reason:"reader failure"});
  const migrated=new BackoffController({store:f.store,clock:f.clock});await migrated.load();
  assert.equal(migrated.snapshot().active,false);
  await f.store.atomic(f.backoff.path,{consecutiveFailures:1,until:new Date(f.clock()+600000).toISOString(),reason:"HTTP 429"});
  const rate=new BackoffController({store:f.store,clock:f.clock});await rate.load();
  assert.equal(rate.snapshot().active,true);
});

test("positive Retry-After immediately holds for at least ten minutes or a longer server delay", async (t) => {
  const { backoff } = await fixture(t);
  assert.equal(
    (await backoff.failure({ retryAfterMs: 2000, reason: "HTTP 429" }))
      .remainingMs,
    600000,
  );
  assert.equal(
    (await backoff.failure({ retryAfterMs: 1200000, reason: "HTTP 429" }))
      .remainingMs,
    1200000,
  );
  assert.equal(backoff.snapshot().reason, "HTTP 429");
});

test("HTTP 429 without Retry-After still holds for ten minutes immediately", async (t) => {
  const { backoff } = await fixture(t);
  const failure = await backoff.failure({
    reason: "사이트 접근 확인이 필요합니다 (HTTP 429).",
  });
  assert.equal(failure.triggered, true);
  assert.equal(failure.remainingMs, 600000);
});

test("wait aborts immediately and never clears a persisted cooldown early", async (t) => {
  const { backoff, advance } = await fixture(t);
  await backoff.failure({ retryAfterMs: 1 });
  const controller = new AbortController();
  const wait = backoff.wait(controller.signal);
  controller.abort(new Error("user pause"));
  await assert.rejects(wait, /user pause/);
  assert.equal(backoff.snapshot().active, true);
  advance(600001);
  await backoff.wait();
  assert.equal(backoff.snapshot().active, false);
});
