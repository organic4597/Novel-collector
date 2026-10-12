import test from "node:test";
import assert from "node:assert/strict";
import { siteAuthStatus } from "../src/site-auth-status.mjs";

const site = {
  host: "newtoki1.org",
  held: true,
  kind: "authentication",
  requiredSlots: [1, 2],
};
const accounts = {
  status: () => ({
    configured: true,
    enabled: true,
    username: "demo",
    password: "fake-secret",
    pin: "0000",
  }),
};
test("held-site status shows sanitized automatic login progress without account or session secrets", () => {
  const value = siteAuthStatus(site, {
    accounts,
    autoAuth: {
      status: () => ({
        state: "running",
        phase: "fake-secret",
        pendingToken: "private-token",
        error: "fake-secret",
        retryAt: null,
        pendingSlots: [1, 2],
      }),
    },
  });
  assert.equal(value.autoLogin.state, "running");
  assert.equal(value.autoLogin.enabled, true);
  assert.equal(value.autoLogin.configured, true);
  const serialized = JSON.stringify(value);
  for (const secret of ["fake-secret", "private-token", "demo", "0000"])
    assert.equal(serialized.includes(secret), false);
});
test("pending browser shutdown is waiting and a stalled recovery is failed instead of an endless automatic wait", () => {
  for (const expected of ["waiting", "failed"]) {
    const value = siteAuthStatus(site, {
      accounts,
      autoAuth: { status: () => ({ state: "idle" }) },
      recovery: { status: () => ({ state: expected }) },
    });
    assert.equal(value.autoLogin.state, expected);
  }
});
test("unavailable automatic login retains manual legacy status and disabled settings stay disabled", () => {
  assert.deepEqual(siteAuthStatus(site, {}), site);
  const value = siteAuthStatus(site, {
    accounts: { status: () => ({ configured: false, enabled: false }) },
    autoAuth: { status: () => ({ state: "idle" }) },
  });
  assert.equal(value.autoLogin.enabled, false);
  assert.equal(value.autoLogin.configured, false);
});

test("CAPTCHA recovery waiting and exhausted state override stale login failure without exposing internal errors", () => {
  for (const state of ["waiting", "needs_attention"]) {
    const value = siteAuthStatus(
      { ...site, kind: "captcha" },
      {
        accounts,
        autoAuth: {
          status: () => ({
            state: "needs_attention",
            failureKind: "captcha",
            error: "fake-secret",
          }),
        },
        recovery: {
          status: () => ({
            state,
            attempts: 5,
            maxAttempts: 5,
            retryAt: null,
            failureKind: "captcha",
            error: "private-queue",
          }),
        },
      },
    );
    assert.equal(value.autoLogin.state, state);
    assert.equal(value.autoLogin.attempts, 5);
    assert.equal(value.autoLogin.maxAttempts, 5);
    assert.equal(value.autoLogin.failureKind, "captcha");
    for (const privateValue of ["fake-secret", "private-queue"])
      assert.equal(JSON.stringify(value).includes(privateValue), false);
  }
});
test("access recovery exposes its actual waiting or running state and scheduled retry time", () => {
  const retryAt = "2026-10-12T15:00:00.000Z";
  for (const state of ["waiting", "running"]) {
    const value = siteAuthStatus({ ...site, host: "sbxh9.com" }, {
      accounts,
      autoAuth: { status: () => ({ state: "needs_attention", failureKind: "site_blocked", error: "private-error" }) },
      recovery: { status: () => ({ state, failureKind: "site_blocked", retryAt }) },
    });
    assert.equal(value.autoLogin.state, state);
    assert.equal(value.autoLogin.retryAt, retryAt);
    assert.match(value.autoLogin.phase, state === "waiting" ? /재확인 대기/ : /재확인 진행/);
    assert.equal(JSON.stringify(value).includes("private-error"), false);
  }
});
