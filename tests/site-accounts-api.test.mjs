import test from "node:test";
import assert from "node:assert/strict";
import { createSiteAccountsRouter } from "../src/site-accounts-api.mjs";

async function invoke(router, path, method = "GET", body = {}) {
  const output = {};
  output.matched = await router({
    request: { method },
    response: {},
    url: new URL(path, "https://collector.example"),
    readBody: async () => body,
    send(_response, status, value) {
      output.status = status;
      output.value = value;
    },
  });
  return output;
}
test("account routes return public state and dispatch save/clear only to validated hosts", async () => {
  const calls = [];
  const state = {
    host: "newtoki1.org",
    configured: true,
    enabled: true,
    username: "member",
  };
  const router = createSiteAccountsRouter({
    accounts: {
      status: (host) => ({ ...state, host }),
      async save(input) {
        calls.push(input);
        return state;
      },
      async clear(host) {
        calls.push(host);
        return { host, configured: false, enabled: false, username: "" };
      },
    },
  });
  assert.equal(
    (await invoke(router, "/api/site-account?host=newtoki1.org")).value
      .username,
    "member",
  );
  assert.equal(
    (
      await invoke(router, "/api/site-account", "PUT", {
        host: "newtoki1.org",
        enabled: false,
      })
    ).status,
    200,
  );
  assert.equal(
    (await invoke(router, "/api/site-account?host=newtoki1.org", "DELETE"))
      .value.configured,
    false,
  );
  await assert.rejects(invoke(router, "/api/site-account?host=localhost"), {
    status: 400,
  });
  assert.equal((await invoke(router, "/api/other")).matched, false);
});

test("a failed recovery callback does not undo successfully saved account settings", async () => {
  let notifications = 0;
  const state = {
    host: "newtoki1.org",
    enabled: true,
    configured: true,
    username: "demo",
  };
  const router = createSiteAccountsRouter({
    accounts: { save: async () => state },
    onChanged: async (saved) => {
      assert.deepEqual(saved, state);
      notifications++;
      throw new Error("background service unavailable");
    },
  });
  const result = await invoke(router, "/api/site-account", "PUT", {
    host: "newtoki1.org",
    enabled: true,
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.value, state);
  assert.equal(notifications, 1);
});

test("account test routes are asynchronous and never return private credentials or raw failures", async () => {
  const router = createSiteAccountsRouter({
    accounts: {},
    autoAuth: {
      async start(host) {
        return {
          host,
          state: "running",
          phase: "hidden-password",
          pendingSlots: [1, 2],
          slotResults: [
            {
              slot: 1,
              status: "ready",
              success: true,
              reused: true,
              password: "nested-private",
            },
          ],
          password: "hidden-password",
          pin: "1234",
          credentials: { password: "nested-private" },
        };
      },
      status(host) {
        return {
          host,
          state: "failed",
          error: "password hidden-password pin1234 /private/path",
        };
      },
    },
  });
  const started = await invoke(router, "/api/site-account/test", "POST", {
    host: "newtoki1.org",
  });
  assert.equal(started.status, 202);
  assert.equal(started.value.state, "running");
  assert.deepEqual(started.value.pendingSlots, [1, 2]);
  assert.deepEqual(started.value.slotResults, [
    { slot: 1, status: "ready", success: true, reused: true },
  ]);
  assert.doesNotMatch(
    JSON.stringify(started.value),
    /hidden-password|1234|credentials/,
  );
  const status = await invoke(
    router,
    "/api/site-account/test?host=newtoki1.org",
  );
  assert.equal(status.status, 200);
  assert.doesNotMatch(
    JSON.stringify(status.value),
    /hidden-password|1234|private/,
  );
  await assert.rejects(
    invoke(router, "/api/site-account/test", "POST", {
      host: "newtoki1.org",
      password: "unexpected",
    }),
    { status: 400 },
  );
});

test("login state timestamps and slot details are bounded and service errors are always generic", async () => {
  const good = createSiteAccountsRouter({
    accounts: {},
    autoAuth: {
      status: () => ({
        state: "ready",
        startedAt: "2026-10-03T00:00:00Z",
        finishedAt: "invalid",
        retryAt: "2026-10-03T00:10:00Z",
        needsAttention: false,
        success: true,
        slotResults: [null, { slot: 3, status: "ready" }],
        pendingToken: "never-visible",
      }),
    },
  });
  const status = (
    await invoke(good, "/api/site-account/test?host=newtoki1.org")
  ).value;
  assert.equal(status.state, "ready");
  assert.equal(status.startedAt, "2026-10-03T00:00:00.000Z");
  assert.equal(status.retryAt, "2026-10-03T00:10:00.000Z");
  assert.deepEqual(status.slotResults, []);
  assert.ok(!Object.hasOwn(status, "finishedAt"));
  assert.doesNotMatch(JSON.stringify(status), /never-visible|pendingToken/);
  const broken = createSiteAccountsRouter({
    accounts: {},
    autoAuth: {
      async start() {
        throw Object.assign(new Error("secret-raw-value"), { status: 409 });
      },
      status() {
        throw Error("private-file-path");
      },
    },
  });
  await assert.rejects(
    invoke(broken, "/api/site-account/test", "POST", { host: "newtoki1.org" }),
    (error) =>
      error.status === 409 && !error.message.includes("secret-raw-value"),
  );
  await assert.rejects(
    invoke(broken, "/api/site-account/test?host=newtoki1.org"),
    (error) =>
      error.status === 503 && !error.message.includes("private-file-path"),
  );
  await assert.rejects(
    invoke(good, "/api/site-account/test?password=forbidden", "POST", {
      host: "newtoki1.org",
    }),
    { status: 400 },
  );
  await assert.rejects(
    invoke(good, "/api/site-account/test?host=newtoki1.org&host=newtoki2.org"),
    { status: 400 },
  );
  await assert.rejects(
    invoke(
      createSiteAccountsRouter({ accounts: {} }),
      "/api/site-account/test?host=newtoki1.org",
    ),
    { status: 503 },
  );
});
