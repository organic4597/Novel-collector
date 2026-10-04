import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";

test("static assets use content validators and retain security headers on 304", async (t) => {
  const app = createApp({
    store: {},
    scheduler: {},
    adminPassword: "isolated-test-password",
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}`;
  const first = await fetch(base + "/styles.css");
  assert.equal(first.status, 200);
  const etag = first.headers.get("etag");
  assert.ok(etag);
  const size = (await first.text()).length;
  assert.ok(size > 100);
  const second = await fetch(base + "/styles.css", {
    headers: { "if-none-match": etag },
  });
  assert.equal(second.status, 304);
  assert.equal(await second.text(), "");
  assert.ok(second.headers.get("content-security-policy"));
  assert.equal(second.headers.get("x-content-type-options"), "nosniff");
  const changed = await fetch(base + "/styles.css", {
    headers: { "if-none-match": '"different"' },
  });
  assert.equal(changed.status, 200);
  const denied = await fetch(base + "/secrets/admin-credentials.json");
  assert.equal(denied.status, 404);
  const activity=await fetch(base+"/activity.js");
  assert.equal(activity.status,200);
  assert.match(activity.headers.get("content-type"),/javascript/);
  assert.equal((await fetch(base+"/discovery-detail.js")).status,200);
  assert.equal((await fetch(base+"/element-picker.js")).status,200);
  assert.equal((await fetch(base+"/extraction-presets.js")).status,200);
  assert.equal((await fetch(base+"/preset-guide.js")).status,200);
  assert.equal((await fetch(base+"/preset-connection.js")).status,200);
  assert.equal((await fetch(base+"/updates.js")).status,200);
  assert.equal((await fetch(base+"/dashboard-logger.js")).status,200);
});
