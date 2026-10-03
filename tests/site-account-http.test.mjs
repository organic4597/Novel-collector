import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";

test("site account setup is administrator-only and never reflects passwords or PINs", async (t) => {
  let saved;
  const accounts = {
    status: (host) => ({
      host,
      configured: !!saved,
      enabled: !!saved?.enabled,
      username: saved?.username || "",
    }),
    save: async (data) => {
      saved = data;
      return accounts.status(data.host);
    },
    clear: async (host) => {
      saved = null;
      return accounts.status(host);
    },
  };
  const app = createApp({
    store: {},
    scheduler: {},
    accounts,
    adminPassword: "test-admin-password",
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const origin = "http://127.0.0.1:" + app.address().port,
    path = "/api/site-account?host=newtoki1.org";
  assert.equal((await fetch(origin + path)).status, 401);
  const login = await fetch(origin + "/api/login", {
    method: "POST",
    body: JSON.stringify({ password: "test-admin-password" }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const data = {
    host: "newtoki1.org",
    username: "demoUser",
    password: "test-secret-password",
    pin: "4802",
    enabled: true,
  };
  const write = await fetch(origin + "/api/site-account", {
    method: "PUT",
    headers: { cookie, Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  assert.equal(write.status, 200);
  const value = await write.text();
  assert.equal(value.includes(data.password), false);
  assert.equal(value.includes(data.pin), false);
  const bad = await fetch(origin + "/api/site-account", {
    method: "PUT",
    headers: {
      cookie,
      Origin: "https://other.example",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });
  assert.equal(bad.status, 403);
});

test("saving an enabled account starts held-site recovery and status is safe and read-only", async (t) => {
  let account = {
    host: "newtoki1.org",
    configured: false,
    enabled: false,
    username: "",
  };
  const calls = [];
  const held = {
    host: "newtoki1.org",
    held: true,
    kind: "authentication",
    requiredSlots: [1, 2],
    verifiedSlots: [],
    reason: "서버 브라우저에서 직접 인증하세요.",
  };
  const app = createApp({
    store: { listJobs: async () => [] },
    scheduler: {
      attention: { get: () => held, snapshot: () => ({ sites: [held] }) },
    },
    accounts: {
      status: () => account,
      save: async (data) => {
        account = {
          host: data.host,
          configured: true,
          enabled: data.enabled,
          username: data.username,
        };
        return account;
      },
    },
    autoAuth: {
      status: () => ({
        state: "idle",
        pendingToken: "fake-token",
        phase: "fake-secret",
      }),
    },
    recovery: {
      request: (site, options) => calls.push({ host: site.host, ...options }),
      status: () => ({ state: "waiting" }),
    },
    adminPassword: "fixture-password",
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const origin = "http://127.0.0.1:" + app.address().port;
  const login = await fetch(origin + "/api/login", {
    method: "POST",
    body: JSON.stringify({ password: "fixture-password" }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const write = await fetch(origin + "/api/site-account", {
    method: "PUT",
    headers: { cookie, origin, "content-type": "application/json" },
    body: JSON.stringify({
      host: "newtoki1.org",
      username: "demo",
      password: "fake-secret",
      pin: "0000",
      enabled: true,
    }),
  });
  assert.equal(write.status, 200);
  assert.deepEqual(calls, [{ host: "newtoki1.org", force: true }]);
  const response = await fetch(origin + "/api/status", { headers: { cookie } });
  const value = await response.json();
  assert.equal(value.siteAttention[0].autoLogin.state, "waiting");
  assert.equal(value.siteAttention[0].autoLogin.enabled, true);
  assert.equal(JSON.stringify(value).includes("fake-token"), false);
  assert.equal(JSON.stringify(value).includes("fake-secret"), false);
  assert.equal(
    calls.length,
    1,
    "status polling must not repeat authentication",
  );
});
