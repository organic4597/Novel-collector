import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderStore } from "../src/store.mjs";
import { Scheduler } from "../src/queue.mjs";
import { createApp, requestAddress } from "../src/server.mjs";
import { writeFile } from "node:fs/promises";
test("proxy IPs are ignored by default and only trusted from exact loopback", () => {
  const request = (peer, address) => ({
    socket: { remoteAddress: peer },
    headers: { "x-real-ip": address },
  });
  assert.equal(
    requestAddress(request("127.0.0.1", "203.0.113.1")),
    "127.0.0.1",
  );
  for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1"])
    assert.equal(
      requestAddress(request(peer, "203.0.113.1"), true),
      "203.0.113.1",
    );
  for (const peer of ["192.168.255.254", "127.0.0.2", "::ffff:127.0.0.2"])
    assert.equal(requestAddress(request(peer, "203.0.113.1"), true), peer);
  for (const address of ["invalid", "1.2.3.4, 5.6.7.8", undefined, ["1.2.3.4"]])
    assert.equal(
      requestAddress(request("127.0.0.1", address), true),
      "127.0.0.1",
    );
});
test("HTTP rate limits use trusted valid IPs and invalid values fall back", async (t) => {
  async function server(trustProxy) {
    const app = createApp({
      store: {},
      scheduler: {},
      adminPassword: "test-password",
      requestLimit: 1,
      trustProxy,
    });
    await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => app.close(resolve)));
    return (address) =>
      fetch(`http://127.0.0.1:${app.address().port}/api/session`, {
        headers: { "X-Real-IP": address },
      });
  }
  const untrusted = await server(false);
  assert.equal((await untrusted("203.0.113.1")).status, 200);
  assert.equal((await untrusted("203.0.113.2")).status, 429);
  const trusted = await server(true);
  assert.equal((await trusted("203.0.113.1")).status, 200);
  assert.equal((await trusted("203.0.113.2")).status, 200);
  assert.equal((await trusted("203.0.113.1")).status, 429);
  assert.equal((await trusted("invalid")).status, 200);
  assert.equal((await trusted("203.0.113.3, 203.0.113.4")).status, 429);
});
test("failed-login protection uses the same trusted proxy address", async (t) => {
  const app = createApp({
    store: {},
    scheduler: {},
    adminPassword: "test-password",
    trustProxy: true,
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const login = (address) =>
    fetch(`http://127.0.0.1:${app.address().port}/api/login`, {
      method: "POST",
      headers: { "X-Real-IP": address },
      body: '{"password":"wrong-password"}',
    });
  for (let attempt = 0; attempt < 10; attempt++)
    assert.equal((await login("203.0.113.1")).status, 401);
  assert.equal((await login("203.0.113.1")).status, 429);
  assert.equal((await login("203.0.113.2")).status, 401);
});
test("all routes share a bounded per-IP limit with retry information", async (t) => {
  const app = createApp({
    store: {},
    scheduler: {},
    adminPassword: "test-password",
    requestLimit: 2,
    requestWindowMs: 400,
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const url = `http://127.0.0.1:${app.address().port}`;
  assert.equal((await fetch(url + "/api/session")).status, 200);
  assert.equal((await fetch(url + "/not-found")).status, 404);
  const limited = await fetch(url + "/api/login", {
    method: "POST",
    body: '{"password":"test-password"}',
  });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("Retry-After")) >= 1);
  assert.ok((await limited.json()).retryAfterSeconds >= 1);
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal((await fetch(url + "/api/session")).status, 200);
});
test("HTTP API requires auth, validates input and exposes persistent jobs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "novel-api-"));
  const store = await new FolderStore(root).init();
  const scheduler = new Scheduler({
    store,
    collector: {
      async run() {
        return {};
      },
      async close() {},
    },
  });
  const app = createApp({ store, scheduler, adminPassword: "test-password" });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await new Promise((r) => app.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${app.address().port}`;
  const req = (path, options) => fetch(url + path, options);
  assert.equal((await req("/api/jobs")).status, 401);
  assert.deepEqual(await (await req("/api/session")).json(), {
    authenticated: false,
  });
  assert.equal(
    (
      await req("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "wrong" }),
      })
    ).status,
    401,
  );
  const login = await req("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "test-password" }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.match(login.headers.get("set-cookie"), /HttpOnly/);
  const headers = { Cookie: cookie, "Content-Type": "application/json" };
  assert.equal(
    (
      await req("/api/jobs", {
        method: "POST",
        headers,
        body: JSON.stringify({ url: "https://localhost/novel/1" }),
      })
    ).status,
    400,
  );
  const response = await req("/api/jobs", {
    method: "POST",
    headers,
    body: JSON.stringify({ url: "https://newtoki1.org/novel/1" }),
  });
  assert.equal(response.status, 201);
  const job = await response.json();
  assert.equal((await (await req("/api/jobs", { headers })).json()).length, 1);
  assert.equal(
    (
      await req(`/api/jobs/${job.id}/action`, {
        method: "POST",
        headers,
        body: '{"action":"pause"}',
      })
    ).status,
    200,
  );
  assert.equal((await req("/api/jobs/invalid", { headers })).status, 404);
  await req("/api/logout", { method: "POST", headers });
  assert.equal((await req("/api/jobs", { headers })).status, 401);
});
test("HTTP book/export/static APIs and browser token remain scoped", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "novel-api-"));
  const store = await new FolderStore(join(root, "data")).init();
  const scheduler = new Scheduler({
    store,
    collector: {
      async run() {
        return {};
      },
      async close() {},
    },
  });
  await writeFile(join(root, "index.html"), "<html>test</html>");
  const app = createApp({
    store,
    scheduler,
    adminPassword: "test-password",
    agentToken: "agent-secret",
    publicDir: root,
  });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await scheduler.stop();
    await new Promise((r) => app.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.address().port}`;
  const req = (path, options) => fetch(base + path, options);
  const login = await req("/api/login", {
    method: "POST",
    body: '{"password":"test-password"}',
  });
  const headers = {
    Cookie: login.headers.get("set-cookie").split(";")[0],
    "Content-Type": "application/json",
  };
  assert.equal((await req("/")).status, 200);
  assert.equal((await req("/", { method: "HEAD" })).status, 200);
  assert.equal((await req("/other")).status, 404);
  assert.equal((await req("/app.js")).status, 404);
  const job = await store.createJob({
    url: "https://newtoki1.org/novel/1",
    executor: "browser",
  });
  await store.upsertBook("1", { title: "책" });
  await store.writeChapter("1", "11", {
    number: 1,
    title: "본문",
    url: "https://newtoki1.org/novel/1/11",
    text: "내용",
  });
  await store.appendEvent(job.id, { level: "info", message: "complete" });
  await store.writeExport(job.id, "txt", Buffer.from("내용"), "책.txt");
  assert.equal(
    (await (await req(`/api/jobs/${job.id}`, { headers })).json()).id,
    job.id,
  );
  assert.equal(
    (await (await req(`/api/jobs/${job.id}/events`, { headers })).json())
      .length,
    1,
  );
  assert.equal(
    await (await req(`/api/jobs/${job.id}/export/txt`, { headers })).text(),
    "내용",
  );
  assert.equal(
    (await req(`/api/jobs/${job.id}/export/epub`, { headers })).status,
    404,
  );
  assert.equal((await (await req("/api/books", { headers })).json()).length, 1);
  assert.equal(
    (await (await req("/api/books/1", { headers })).json()).chapters.length,
    1,
  );
  assert.equal(
    (await (await req("/api/books/1/chapters/11", { headers })).json()).text,
    "내용",
  );
  assert.equal(
    (await req("/api/books/1/chapters/12", { headers })).status,
    404,
  );
  assert.equal((await req("/api/books/2", { headers })).status, 404);
  assert.equal((await req("/api/status", { headers })).status, 200);
  assert.equal((await req("/api/unknown", { headers })).status, 404);
  assert.equal(
    (
      await req("/api/jobs", {
        method: "POST",
        headers: { ...headers, Origin: "https://evil.example" },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal(
    (await req("/api/jobs", { method: "POST", headers, body: "not-json" }))
      .status,
    400,
  );
  assert.equal(
    (
      await req("/api/jobs", {
        method: "POST",
        headers,
        body: "x".repeat(2 * 1024 * 1024 + 1),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await req("/api/agents/claim", {
        method: "POST",
        headers,
        body: '{"clientId":"pc"}',
      })
    ).status,
    401,
  );
  const agentHeaders = {
    Authorization: "Bearer agent-secret",
    "Content-Type": "application/json",
  };
  assert.equal((await req("/api/jobs", { headers: agentHeaders })).status, 401);
  await scheduler.start();
  const claim = await (
    await req("/api/agents/claim", {
      method: "POST",
      headers: agentHeaders,
      body: '{"clientId":"pc"}',
    })
  ).json();
  assert.equal(claim.job.id, job.id);
  const leased = { ...agentHeaders, "X-Collector-Lease": claim.leaseToken };
  assert.equal(
    (
      await req(`/api/agents/jobs/${job.id}/heartbeat`, {
        method: "POST",
        headers: leased,
        body: '{"clientId":"pc","phase":"ready"}',
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await req(`/api/agents/jobs/${job.id}/finish`, {
        method: "POST",
        headers: leased,
        body: '{"clientId":"pc","error":"failure"}',
      })
    ).status,
    200,
  );
  assert.equal((await store.getJob(job.id)).status, "failed");
  assert.equal(
    (await req("/api/agents/claim", { headers: agentHeaders })).status,
    404,
  );
});
