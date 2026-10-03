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

test("five real failures trigger ten minutes; success resets streak without cancelling cooldown", async (t) => {
  const { backoff } = await fixture(t);
  for (let index = 0; index < 4; index++)
    assert.equal(
      (await backoff.failure({ reason: "reader failure" })).triggered,
      false,
    );
  assert.equal(backoff.snapshot().active, false);
  const fifth = await backoff.failure({ reason: "reader failure" });
  assert.equal(fifth.triggered, true);
  assert.equal(fifth.remainingMs, 600000);
  assert.equal(backoff.snapshot().remainingSeconds, 600);
  await backoff.success();
  assert.equal(backoff.snapshot().consecutiveFailures, 0);
  assert.equal(backoff.snapshot().active, true);
});

test("parallel failures serialize and cooldown survives restart before expiry reset", async (t) => {
  const { store, backoff, clock, advance } = await fixture(t);
  const results = await Promise.all(
    Array.from({ length: 5 }, () => backoff.failure({ reason: "failed" })),
  );
  assert.equal(results.filter((result) => result.triggered).length, 1);
  assert.equal(backoff.snapshot().consecutiveFailures, 5);
  const restored = new BackoffController({ store, clock });
  await restored.load();
  assert.equal(restored.snapshot().active, true);
  advance(600001);
  await restored.clearAfterExpiry();
  assert.equal(restored.snapshot().active, false);
  assert.equal(restored.snapshot().consecutiveFailures, 0);
  const again = new BackoffController({ store, clock });
  await again.load();
  assert.equal(again.snapshot().consecutiveFailures, 0);
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
