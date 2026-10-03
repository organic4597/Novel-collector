import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
test("server-session CAPTCHA routes require administrator cookie and same-origin mutations", async (t) => {
  const calls = [];
  const app = createApp({
    store: {},
    scheduler: {},
    adminPassword: "fixture-password",
    captchaSession: {
      open: async (value) => {
        calls.push(value);
        return { open: true, host: value.host, viewerHost: "sbxh9.com" };
      },
      frame: async () => ({
        bytes: Buffer.from("fixture-image"),
        mimeType: "image/jpeg",
      }),
    },
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const origin = `http://127.0.0.1:${app.address().port}`;
  const data = { host: "newtoki1.org" };
  assert.equal(
    (await fetch(origin + "/api/captcha-session/frame")).status,
    401,
  );
  const login = await fetch(origin + "/api/login", {
    method: "POST",
    body: JSON.stringify({ password: "fixture-password" }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const write = (src) =>
    fetch(origin + "/api/captcha-session/open", {
      method: "POST",
      headers: { cookie, origin: src, "content-type": "application/json" },
      body: JSON.stringify(data),
    });
  assert.equal((await write("https://foreign.test")).status, 403);
  assert.equal(calls.length, 0);
  assert.equal((await write(origin)).status, 200);
  assert.deepEqual(calls, [data]);
  const image = await fetch(origin + "/api/captcha-session/frame", {
    headers: { cookie },
  });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("cache-control"), "no-store");
  const html = await fetch(origin + "/");
  assert.match(
    html.headers.get("content-security-policy"),
    /img-src 'self' blob:/,
  );
});

for (const action of ["logout", "password"]) {
  test(`${action} closes the owned CAPTCHA session without blocking on browser cleanup`, async (t) => {
    let closeCalls = 0,
      finish;
    const closed = new Promise((resolve) => {
      finish = resolve;
    });
    const app = createApp({
      store: {},
      scheduler: {},
      adminPassword: "fixture-password",
      captchaSession: {
        close: () => {
          closeCalls++;
          return closed;
        },
      },
      siteBrowser: {
        close: async () => {
          throw Error("owned-session");
        },
      },
    });
    await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      finish();
      return new Promise((resolve) => app.close(resolve));
    });
    const origin = `http://127.0.0.1:${app.address().port}`;
    const login = await fetch(origin + "/api/login", {
      method: "POST",
      body: JSON.stringify({ password: "fixture-password" }),
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const body =
      action === "password"
        ? {
            currentPassword: "fixture-password",
            newPassword: "new-fixture-password",
            confirmPassword: "new-fixture-password",
          }
        : {};
    const result = await fetch(
      origin +
        (action === "password" ? "/api/settings/password" : "/api/logout"),
      {
        method: "POST",
        headers: { cookie, origin, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(1500),
      },
    );
    assert.equal(result.status, 200);
    assert.equal(closeCalls, 1);
  });
}
