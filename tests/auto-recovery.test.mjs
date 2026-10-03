import test from "node:test";
import assert from "node:assert/strict";
import { AutoRecovery } from "../src/auto-recovery.mjs";
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
async function until(predicate) {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail("automatic recovery did not settle");
    await tick();
  }
}
test("automatic recovery runs once after collectors close and never retries failed credentials", async () => {
  const calls = [];
  let failed = false;
  const scheduler = {
    active: new Map([["j", { job: { url: "https://newtoki1.org/novel/1" } }]]),
  };
  const recovery = new AutoRecovery({
    scheduler,
    accounts: { status: () => ({ enabled: true, configured: true }) },
    autoAuth: {
      status: () => ({ state: failed ? "needs_attention" : "idle" }),
      start: async (host) => {
        calls.push(host);
      },
      wait: async () => ({ state: "ready" }),
    },
    pollMs: 1,
    maxWaitMs: 30,
  });
  recovery.request({
    host: "newtoki1.org",
    held: true,
    kind: "authentication",
  });
  await tick();
  assert.equal(calls.length, 0);
  scheduler.active.clear();
  await tick();
  assert.deepEqual(calls, ["newtoki1.org"]);
  failed = true;
  recovery.request({
    host: "newtoki1.org",
    held: true,
    kind: "authentication",
  });
  await tick();
  assert.equal(calls.length, 1);
  recovery.close();
});
test("disabled accounts and shutdown cannot initiate recovery", async () => {
  let calls = 0;
  const r = new AutoRecovery({
    scheduler: { active: new Map() },
    accounts: { status: () => ({ enabled: false }) },
    autoAuth: {
      status: () => ({ state: "idle" }),
      start: async () => calls++,
      wait: async () => ({ state: "ready" }),
    },
    pollMs: 1,
  });
  r.request({ host: "newtoki1.org", held: true, kind: "authentication" });
  await tick();
  assert.equal(calls, 0);
  r.close();
  r.request({ host: "newtoki1.org", held: true, kind: "authentication" });
  await tick();
  assert.equal(calls, 0);
});

test("waiting recovery reports progress and a bounded busy timeout becomes actionable", async () => {
  const recovery = new AutoRecovery({
    scheduler: {
      active: new Map([
        ["busy", { job: { url: "https://newtoki1.org/novel/1" } }],
      ]),
    },
    accounts: { status: () => ({ enabled: true, configured: true }) },
    autoAuth: {
      status: () => ({ state: "idle" }),
      start: async () => assert.fail("busy collector must not share a browser"),
    },
    pollMs: 1,
    maxWaitMs: 5,
  });
  recovery.request({
    host: "newtoki1.org",
    held: true,
    kind: "authentication",
  });
  assert.equal(recovery.status("newtoki1.org").state, "waiting");
  await until(() => recovery.status("newtoki1.org").state === "failed");
  recovery.close();
});

test("saving updated account settings explicitly allows one retry after a prior failed attempt", async () => {
  let attempts = 0;
  const recovery = new AutoRecovery({
    scheduler: { active: new Map() },
    accounts: { status: () => ({ enabled: true, configured: true }) },
    autoAuth: {
      status: () => ({ state: "needs_attention" }),
      start: async () => {
        attempts++;
      },
      wait: async () => ({ state: "ready" }),
    },
    pollMs: 1,
  });
  const site = { host: "newtoki1.org", held: true, kind: "authentication" };
  recovery.request(site);
  await tick();
  assert.equal(attempts, 0);
  recovery.request(site, { force: true });
  await tick();
  assert.equal(attempts, 1);
  recovery.request({ ...site, kind: "captcha" }, { force: true });
  await tick();
  assert.equal(attempts, 2);
  recovery.close();
});

function captchaFixture(
  t,
  { failures = ["captcha"], delays = [4, 5, 6, 7], maxWaitMs = 40 } = {},
) {
  let calls = 0,
    running = 0,
    maximum = 0;
  let state = { state: "idle" };
  const scheduler = {
    active: new Map(),
    manualSlots: new Set(),
    backoff: { snapshot: () => ({ active: false }) },
  };
  const autoAuth = {
    status: () => state,
    async start() {
      calls++;
      running++;
      maximum = Math.max(maximum, running);
      state = { state: "running" };
    },
    async wait() {
      await new Promise((resolve) => setTimeout(resolve, 2));
      running--;
      const failureKind = failures[Math.min(calls - 1, failures.length - 1)];
      state = failureKind
        ? { state: "needs_attention", failureKind }
        : { state: "ready" };
      return state;
    },
  };
  const recovery = new AutoRecovery({
    scheduler,
    accounts: { status: () => ({ configured: true, enabled: true }) },
    autoAuth,
    pollMs: 1,
    maxWaitMs,
    captchaDelaysMs: delays,
  });
  t.after(() => recovery.close());
  return {
    recovery,
    scheduler,
    autoAuth,
    calls: () => calls,
    maximum: () => maximum,
  };
}
const captchaSite = { host: "newtoki1.org", held: true, kind: "captcha" };

test("human-cleared CAPTCHA automatically verifies, waits for completion, and deduplicates a host", async (t) => {
  const f = captchaFixture(t, { failures: [null] });
  f.recovery.request(captchaSite);
  f.recovery.request(captchaSite);
  await until(() => f.recovery.status(captchaSite.host).state === "ready");
  assert.equal(f.calls(), 1);
  assert.equal(f.recovery.status(captchaSite.host).state, "ready");
});

test("CAPTCHA proof retries have spaced delays and exhaust exactly five attempts until explicitly renewed", async (t) => {
  const f = captchaFixture(t);
  f.recovery.request(captchaSite);
  await until(
    () => f.recovery.status(captchaSite.host).state === "needs_attention",
  );
  assert.equal(f.calls(), 5);
  assert.equal(f.recovery.status(captchaSite.host).state, "needs_attention");
  assert.equal(f.recovery.status(captchaSite.host).attempts, 5);
  assert.equal(f.recovery.status(captchaSite.host).retryAt, null);
  f.recovery.request(captchaSite);
  await tick();
  assert.equal(f.calls(), 5);
  f.recovery.request(captchaSite, { force: true });
  await until(() => f.calls() > 5);
});

test("explicit start wakes an app-owned CAPTCHA delay while retaining cooldown checks", async (t) => {
  const f = captchaFixture(t, {
    failures: ["captcha", null],
    delays: [10000, 10000, 10000, 10000],
  });
  f.recovery.request(captchaSite);
  await until(
    () =>
      f.recovery.status(captchaSite.host).state === "waiting" &&
      f.calls() === 1,
  );
  f.recovery.request(captchaSite, { force: true });
  await until(() => f.recovery.status(captchaSite.host).state === "ready");
  assert.equal(f.calls(), 2);
});

test("human CAPTCHA session suspends proof timers and resumes only after relinquishing its profile", async (t) => {
  const f = captchaFixture(t, {
    failures: ["captcha", null],
    delays: [10000, 10000, 10000, 10000],
  });
  f.scheduler.attention = { get: () => captchaSite };
  f.recovery.request(captchaSite);
  await until(
    () =>
      f.calls() === 1 &&
      f.recovery.status(captchaSite.host).state === "waiting",
  );
  f.recovery.suspend(captchaSite.host);
  f.recovery.request(captchaSite, { force: true });
  await tick();
  assert.equal(f.calls(), 1);
  f.recovery.resume(captchaSite.host);
  await until(() => f.recovery.status(captchaSite.host).state === "ready");
  assert.equal(f.calls(), 2);
});

test("wrong credentials and site blocking stop CAPTCHA retries", async (t) => {
  for (const failure of ["authentication", "site_blocked"]) {
    const f = captchaFixture(t, { failures: [failure] });
    f.recovery.request(captchaSite);
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(f.calls(), 1);
    assert.equal(f.recovery.status(captchaSite.host).state, "needs_attention");
  }
});

test("retryAt and global backoff defer browser preparation even on forced recovery", async (t) => {
  const f = captchaFixture(t);
  const until = Date.now() + 35;
  f.autoAuth.status = () => ({
    state: "needs_attention",
    failureKind: "captcha",
    retryAt: new Date(until).toISOString(),
  });
  f.scheduler.backoff.snapshot = () => ({
    active: true,
    until: new Date(until + 10).toISOString(),
  });
  f.recovery.request(captchaSite, { force: true });
  await tick();
  assert.equal(f.calls(), 0);
  f.scheduler.backoff.snapshot = () => ({ active: false });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(f.calls() > 0);
});

test("hosts share one automatic browser owner and manual profile contention ends within its budget", async (t) => {
  const f = captchaFixture(t, { failures: [null] });
  f.recovery.request(captchaSite);
  f.recovery.request({ ...captchaSite, host: "newtoki2.org" });
  await until(() => f.calls() === 2);
  assert.equal(f.maximum(), 1);
  assert.equal(f.calls(), 2);
  const busy = captchaFixture(t, { maxWaitMs: 5 });
  busy.scheduler.manualSlots.add(1);
  busy.recovery.request(captchaSite);
  await until(() => busy.recovery.status(captchaSite.host).state === "failed");
  assert.equal(busy.calls(), 0);
  assert.equal(busy.recovery.status(captchaSite.host).state, "failed");
});

test("shutdown cancels every scheduled CAPTCHA proof retry", async (t) => {
  const f = captchaFixture(t, { delays: [100, 100, 100, 100] });
  f.recovery.request(captchaSite);
  await tick();
  f.recovery.close();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(f.calls(), 1);
  assert.equal(f.recovery.pending.size, 0);
});
