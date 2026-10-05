import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

async function fixture(t) {
  const dom = new JSDOM("", {
    url: "https://localhost/",
    runScripts: "outside-only",
  });
  t.after(() => dom.window.close());
  const w = dom.window,
    calls = [],
    mutations = [];
  let generation = 1,
    unauthorized = 0;
  w.eval(
    (await readFile(
      new URL("../public/performance.js", import.meta.url),
      "utf8",
    )) +
      "\n//# sourceURL=" +
      new URL("../public/performance.js", import.meta.url).href,
  );
  const api = w.CollectorPerformance.createApi({
    generation: () => generation,
    onUnauthorized: () => unauthorized++,
    onMutated: (path) => mutations.push(path),
  });
  const response = (value, status = 200) => ({
    ok: status === 200,
    status,
    json: async () => value,
  });
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  return {
    w,
    api,
    calls,
    mutations,
    response,
    deferred,
    unauthorized: () => unauthorized,
    nextSession: () => generation++,
  };
}

test("Concurrent identical GETs share one request but completed reads are always fresh", async (t) => {
  const f = await fixture(t),
    gate = f.deferred();
  f.w.fetch = async (path, options) => {
    f.calls.push({ path, options });
    await gate.promise;
    return f.response({ value: f.calls.length });
  };
  const first = f.api("/api/status"),
    second = f.api("/api/status");
  assert.equal(f.calls.length, 1);
  gate.resolve();
  assert.deepEqual(await first, await second);
  await f.api("/api/status");
  assert.equal(f.calls.length, 2);
});

test("One subscriber abort does not cancel another subscriber of the shared GET", async (t) => {
  const f = await fixture(t),
    gate = f.deferred(),
    controller = new f.w.AbortController();
  f.w.fetch = async (path, options) => {
    f.calls.push({ path, options });
    await gate.promise;
    return f.response({ okay: true });
  };
  const first = f.api("/api/books", { signal: controller.signal }),
    second = f.api("/api/books");
  controller.abort();
  await assert.rejects(first, (error) => error.cancelled === true);
  assert.equal(f.calls[0].options.signal.aborted, false);
  gate.resolve();
  assert.equal((await second).okay, true);
  assert.equal(f.calls.length, 1);
});

test("Last subscriber cancellation aborts the network request and removes the cache entry", async (t) => {
  const f = await fixture(t),
    gate = f.deferred(),
    controller = new f.w.AbortController();
  f.w.fetch = async (path, options) => {
    f.calls.push({ path, options });
    await gate.promise;
    return f.response({ okay: true });
  };
  const first = f.api("/api/jobs", { signal: controller.signal });
  controller.abort();
  await assert.rejects(first, (error) => error.cancelled === true);
  assert.equal(f.calls[0].options.signal.aborted, true);
  const second = f.api("/api/jobs");
  assert.equal(f.calls.length, 2);
  gate.resolve();
  await second;
});

test("Successful mutations invalidate pending reads without sharing or replaying mutations", async (t) => {
  const f = await fixture(t),
    gate = f.deferred();
  f.w.fetch = async (path, options) => {
    f.calls.push({ path, options });
    if (options.method === undefined) await gate.promise;
    return f.response({ current: true });
  };
  const pending = f.api("/api/jobs");
  const cancelled = assert.rejects(
    pending,
    (error) => error.cancelled === true && error.stale === true,
  );
  await Promise.all([
    f.api("/api/queue/pause", { method: "POST", body: "{}" }),
    f.api("/api/queue/pause", { method: "POST", body: "{}" }),
  ]);
  await cancelled;
  assert.equal(
    f.calls.filter((call) => call.options.method === "POST").length,
    2,
  );
  assert.deepEqual(f.mutations, ["/api/queue/pause", "/api/queue/pause"]);
  const fresh = f.api("/api/jobs");
  gate.resolve();
  assert.equal((await fresh).current, true);
  assert.equal(f.calls.filter((call) => call.path === "/api/jobs").length, 2);
});

test("Different auth generations never share reads or let late unauthorized responses log out the new session", async (t) => {
  const f = await fixture(t),
    gate = f.deferred();
  f.w.fetch = async (path, options) => {
    const position = f.calls.length;
    f.calls.push({ path, options });
    if (position === 0) {
      await gate.promise;
      return f.response({ error: "expired" }, 401);
    }
    return f.response({ user: "new" });
  };
  const old = f.api("/api/status");
  const cancelled = assert.rejects(old, (error) => error.cancelled === true);
  f.nextSession();
  assert.equal((await f.api("/api/status")).user, "new");
  gate.resolve();
  await cancelled;
  assert.equal(f.unauthorized(), 0);
  assert.equal(f.calls.length, 2);
});

test("Force reads bypass and invalidate a matching pending GET while query strings stay independent", async (t) => {
  const f = await fixture(t),
    gate = f.deferred();
  f.w.fetch = async (path, options) => {
    f.calls.push({ path, options });
    await gate.promise;
    return f.response({ path });
  };
  const old = f.api("/api/books?page=1");
  const cancelled = assert.rejects(old, (error) => error.stale === true);
  const fresh = f.api("/api/books?page=1", { force: true }),
    other = f.api("/api/books?page=2");
  gate.resolve();
  await cancelled;
  await Promise.all([fresh, other]);
  assert.equal(f.calls.length, 3);
  assert.ok(!("force" in f.calls[1].options));
});

test("Current unauthorized GET expires the session; timeout reports a delay and failed mutation does not emit invalidation", async (t) => {
  const f = await fixture(t);
  f.w.fetch = async () => f.response({ error: "forbidden" }, 401);
  await assert.rejects(f.api("/api/status"), /forbidden/);
  assert.equal(f.unauthorized(), 1);
  await assert.rejects(
    f.api("/api/login", { method: "POST", body: "{}" }),
    /forbidden/,
  );
  assert.equal(f.unauthorized(), 1);
  assert.equal(f.mutations.length, 0);
  f.w.fetch = (path, options) =>
    new Promise((resolve, reject) =>
      options.signal.addEventListener("abort", () =>
        reject(new f.w.DOMException("aborted", "AbortError")),
      ),
    );
  await assert.rejects(
    f.api("/api/status", {}, 5),
    (error) => !error.cancelled && /지연/.test(error.message),
  );
});

test("Streaming progress remains isolated per caller and always closes its reader", async (t) => {
  const f = await fixture(t),
    updates = [],
    cleanups = [];
  f.w.TextDecoder = TextDecoder;
  f.w.fetch = async (path) => {
    f.calls.push({ path });
    const chunks = [
      new TextEncoder().encode(
        '{"type":"progress","data":{"loaded":2}}\n{"type":"result","data":{"items":[1,2]}}\n',
      ),
    ];
    const reader = {
      read: async () =>
        chunks.length ? { value: chunks.shift(), done: false } : { done: true },
      cancel: async () => cleanups.push("cancel"),
      releaseLock: () => cleanups.push("release"),
    };
    return {
      ok: true,
      headers: { get: () => "application/x-ndjson" },
      body: { getReader: () => reader },
    };
  };
  const responses = await Promise.all([
    f.api("/api/discover", {}, 12000, (value) => updates.push(value)),
    f.api("/api/discover", {}, 12000, (value) => updates.push(value)),
  ]);
  assert.equal(
    f.calls.length,
    2,
    "Streaming callbacks never share another caller's progress.",
  );
  assert.equal(updates.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(responses)), [
    { items: [1, 2] },
    { items: [1, 2] },
  ]);
  assert.equal(cleanups.length, 4);
});

test("Malformed and interrupted streams fail clearly, failed reads remain retryable, and pre-aborted calls do not fetch", async (t) => {
  const f = await fixture(t);
  f.w.TextDecoder = TextDecoder;
  const controller = new f.w.AbortController();
  controller.abort();
  f.w.fetch = async () => {
    throw Error("should not run");
  };
  await assert.rejects(
    f.api("/api/status", { signal: controller.signal }),
    (error) => error.cancelled,
  );
  for (const [text, expected] of [
    ["invalid\n", /형식/],
    ['{"type":"progress","data":{}}', /중단/],
    [
      '{"type":"error","data":{"error":"source unavailable"}}\n',
      /source unavailable/,
    ],
  ]) {
    let delivered = false,
      closed = false;
    f.w.fetch = async () => ({
      ok: true,
      headers: { get: () => "application/x-ndjson" },
      body: {
        getReader: () => ({
          read: async () =>
            delivered
              ? { done: true }
              : ((delivered = true),
                { done: false, value: new TextEncoder().encode(text) }),
          cancel: async () => {
            closed = true;
          },
          releaseLock: () => {},
        }),
      },
    });
    await assert.rejects(
      f.api("/api/discover", {}, 12000, () => {}),
      expected,
    );
    assert.equal(closed, true);
  }
  f.w.fetch = async () => {
    throw new f.w.TypeError("offline");
  };
  await assert.rejects(f.api("/api/status"), /네트워크/);
  f.w.fetch = async () => f.response({ recovered: true });
  assert.equal((await f.api("/api/status")).recovered, true);
});
