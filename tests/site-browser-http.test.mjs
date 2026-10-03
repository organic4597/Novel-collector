import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";

test("manual verification controls and images require admin session and same-origin requests", async (t) => {
  const calls = [];
  const siteBrowser = {
    status: async () => ({ open: false }),
    open: async (data) => {
      calls.push(data);
      return { open: true, host: data.host, slot: data.slot };
    },
    frame: async () => ({
      bytes: Buffer.from("test-frame"),
      mimeType: "image/jpeg",
    }),
    close: async () => ({ open: false }),
  };
  const app = createApp({
    store: {},
    scheduler: {},
    adminPassword: "only-test-password",
    siteBrowser,
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const origin = "http://127.0.0.1:" + app.address().port;
  assert.equal((await fetch(origin + "/api/site-browser/status")).status, 401);
  assert.equal((await fetch(origin + "/api/site-browser/frame")).status, 401);
  const login = await fetch(origin + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "only-test-password" }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const forbidden = await fetch(origin + "/api/site-browser/open", {
    method: "POST",
    headers: {
      cookie,
      Origin: "https://outside.example",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ host: "newtoki1.org", slot: 1 }),
  });
  assert.equal(forbidden.status, 403);
  assert.equal(calls.length, 0);
  const open = await fetch(origin + "/api/site-browser/open", {
    method: "POST",
    headers: { cookie, Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ host: "newtoki1.org", slot: 1 }),
  });
  assert.equal(open.status, 200);
  assert.equal(calls.length, 1);
  const frame = await fetch(origin + "/api/site-browser/frame", {
    headers: { cookie },
  });
  assert.equal(frame.status, 200);
  assert.equal(frame.headers.get("content-type"), "image/jpeg");
  assert.match(frame.headers.get("cache-control"), /no-store/);
  assert.equal(await frame.text(), "test-frame");
  await fetch(origin + "/api/logout", {
    method: "POST",
    headers: { cookie, Origin: origin },
    body: "{}",
  });
  assert.equal(
    (await fetch(origin + "/api/site-browser/frame", { headers: { cookie } }))
      .status,
    401,
  );
});

test("logout revokes the session without waiting for a slow source browser cleanup", async (t) => {
  const siteBrowser = { close: () => new Promise(() => {}) };
  const app = createApp({
    store: {},
    scheduler: {},
    siteBrowser,
    adminPassword: "only-test-password",
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    app.closeAllConnections();
    return new Promise((resolve) => app.close(resolve));
  });
  const origin = "http://127.0.0.1:" + app.address().port;
  const login = await fetch(origin + "/api/login", {
    method: "POST",
    body: JSON.stringify({ password: "only-test-password" }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const logout = await fetch(origin + "/api/logout", {
    method: "POST",
    headers: { cookie },
    body: "{}",
    signal: AbortSignal.timeout(500),
  });
  assert.equal(logout.status, 200);
  const session = await (
    await fetch(origin + "/api/session", { headers: { cookie } })
  ).json();
  assert.equal(session.authenticated, false);
});
