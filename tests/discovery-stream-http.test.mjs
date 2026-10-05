import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";

async function fixture(t, list) {
  const app = createApp({ store: {}, scheduler: {}, adminPassword: "synthetic-stream-test", discovery: { list } });
  await new Promise(resolve => app.listen(0, "127.0.0.1", resolve));
  t.after(() => { app.closeAllConnections(); return new Promise(resolve => app.close(resolve)); });
  const origin = `http://127.0.0.1:${app.address().port}`;
  const login = await fetch(origin + "/api/login", { method: "POST", body: JSON.stringify({ password: "synthetic-stream-test" }) });
  return { origin, cookie: login.headers.get("set-cookie").split(";")[0] };
}

test("authenticated discovery sends a prepared prefix before the final result", async t => {
  let release;
  const f = await fixture(t, async (_query, { onProgress }) => {
    onProgress({ items: [{ id: "41" }], page: 2 });
    await new Promise(resolve => { release = resolve; });
    return { items: [{ id: "41" }, { id: "42" }], page: 2 };
  });
  const response = await fetch(f.origin + "/api/discover?page=2", { headers: { cookie: f.cookie, Accept: "application/x-ndjson" } });
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  const reader = response.body.getReader();
  const first = JSON.parse(new TextDecoder().decode((await reader.read()).value).trim());
  assert.equal(first.type, "progress"); assert.equal(first.data.items[0].id, "41");
  release();
  let remaining = "";
  while (true) { const chunk = await reader.read(); if (chunk.done) break; remaining += new TextDecoder().decode(chunk.value); }
  assert.equal(JSON.parse(remaining.trim()).type, "result");
});

test("stream authentication and ordinary JSON clients retain their existing contracts", async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return { items: [], page: 1 }; });
  const anonymous = await fetch(f.origin + "/api/discover", { headers: { Accept: "application/x-ndjson" } });
  assert.equal(anonymous.status, 401); assert.equal(calls, 0);
  const response = await fetch(f.origin + "/api/discover", { headers: { cookie: f.cookie } });
  assert.deepEqual(await response.json(), { items: [], page: 1 });
});

test("a source limit becomes a terminal stream error without a fake success result", async t => {
  const f = await fixture(t, async () => { throw Object.assign(Error("요청 제한 대기 중"), { status: 429 }); });
  const response = await fetch(f.origin + "/api/discover", { headers: { cookie: f.cookie, Accept: "application/x-ndjson" } });
  const events = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.type), ["error"]);
  assert.equal(events[0].data.status, 429);
});
