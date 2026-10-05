import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  mkdir,
  rm,
  stat,
  readdir,
  symlink,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as requestHttp } from "node:http";
import { openCredentials, MemoryCredentials } from "../src/auth.mjs";
import { AdminSessions, SESSION_TTL_MS } from "../src/admin-sessions.mjs";
import {
  createAdminRecoveryRouter,
  isLocalAdminRecoveryRequest,
  RESET_CONFIRMATION,
} from "../src/admin-recovery.mjs";

const oldPassword = "recovery-old-fixture-password";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "novel-admin-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "secrets");
  await mkdir(directory);
  await writeFile(join(directory, "admin-login.txt"), oldPassword);
  const credentials = await openCredentials({ directory });
  const store = { path: (...parts) => join(root, "data", ...parts) };
  const sessions = new AdminSessions({
    store,
    binding: credentials.sessionVersion(),
  });
  await sessions.load();
  return { root, directory, credentials, sessions, store };
}
const localRequest = (overrides = {}) => ({
  method: "GET",
  headers: { host: "127.0.0.1:8788", ...overrides.headers },
  socket: {
    remoteAddress: "127.0.0.1",
    localAddress: "127.0.0.1",
    localPort: 8788,
    ...overrides.socket,
  },
  ...Object.fromEntries(
    Object.entries(overrides).filter(
      ([key]) => !["headers", "socket"].includes(key),
    ),
  ),
});

test("recovery accepts only real local sockets, exact local authorities and same-origin browser requests", () => {
  assert.equal(isLocalAdminRecoveryRequest(localRequest()), true);
  assert.equal(
    isLocalAdminRecoveryRequest(
      localRequest({ headers: { host: "localhost:8788" } }),
    ),
    true,
  );
  assert.equal(
    isLocalAdminRecoveryRequest(
      localRequest({
        headers: { host: "[::1]:8788" },
        socket: { remoteAddress: "::1", localAddress: "::1" },
      }),
    ),
    true,
  );
  assert.equal(
    isLocalAdminRecoveryRequest(
      localRequest({
        method: "POST",
        headers: { origin: "http://127.0.0.1:8788" },
      }),
    ),
    true,
  );
  for (const overrides of [
    { socket: { remoteAddress: "192.0.2.18" } },
    { socket: { localAddress: "192.0.2.168" } },
    { socket: { localPort: 0 } },
    { headers: { host: "dashboard.example.test" } },
    { headers: { host: "localhost.evil.example:8788" } },
    { headers: { host: "localhost.:8788" } },
    { headers: { host: "127.0.0.1:8789" } },
    { headers: { host: "localhost:8788@evil.example" } },
    { headers: { host: " localhost:8788" } },
    { headers: { host: "localhost:8788/path" } },
    { headers: { "x-forwarded-proto": "http" } },
    { headers: { "x-real-ip": "127.0.0.1" } },
    { headers: { "x-forwarded-for": "127.0.0.1" } },
    { headers: { "x-forwarded-host": "localhost:8788" } },
    { headers: { forwarded: "for=127.0.0.1" } },
    { headers: { "cf-connecting-ip": "127.0.0.1" } },
    { headers: { "cf-ray": "fixture" } },
    { headers: { "sec-fetch-site": "cross-site" } },
    { headers: { origin: "http://evil.example" } },
    { headers: { origin: "http://localhost:8788" } },
    { method: "POST" },
    { method: "POST", headers: { origin: "http://127.0.0.1:8788/" } },
  ])
    assert.equal(
      isLocalAdminRecoveryRequest(localRequest(overrides)),
      false,
      JSON.stringify(overrides),
    );
});

test("reset rotates credentials, leaves unrelated data intact and persists only hashes plus the protected recovery file", async (t) => {
  const f = await fixture(t);
  for (const relative of [
    "data/books/book.txt",
    "profile/chromium/fixture.txt",
    "secrets/site-accounts/account.txt",
  ]) {
    await mkdir(join(f.root, relative, ".."), { recursive: true });
    await writeFile(join(f.root, relative), "preserved-fixture");
  }
  const binding = f.credentials.sessionVersion();
  const result = await f.credentials.reset();
  assert.ok(result.newPassword.length >= 24);
  assert.equal(result.passwordFile, "secrets/admin-login.txt");
  assert.equal(f.credentials.verify(oldPassword), false);
  assert.equal(f.credentials.verify(result.newPassword), true);
  assert.notEqual(f.credentials.sessionVersion(), binding);
  assert.equal(
    (await readFile(join(f.directory, "admin-login.txt"), "utf8")).trim(),
    result.newPassword,
  );
  assert.equal(
    (
      await readFile(join(f.directory, "admin-credentials.json"), "utf8")
    ).includes(result.newPassword),
    false,
  );
  assert.equal(
    (await openCredentials({ directory: f.directory })).verify(
      result.newPassword,
    ),
    true,
  );
  for (const relative of [
    "data/books/book.txt",
    "profile/chromium/fixture.txt",
    "secrets/site-accounts/account.txt",
  ])
    assert.equal(
      await readFile(join(f.root, relative), "utf8"),
      "preserved-fixture",
    );
  if (process.platform !== "win32")
    for (const file of ["admin-login.txt", "admin-credentials.json"])
      assert.equal((await stat(join(f.directory, file))).mode & 0o777, 0o600);
});

test("memory-only credentials disable recovery and failed hash writes restore the prior recovery file", async (t) => {
  const memory = new MemoryCredentials({ password: oldPassword });
  assert.equal(memory.recoveryAvailable(), false);
  await assert.rejects(memory.reset(), { status: 403 });
  const f = await fixture(t);
  const target = join(f.directory, "admin-credentials.json");
  await rm(target);
  await mkdir(target);
  await assert.rejects(f.credentials.reset(), /저장/);
  assert.equal(f.credentials.verify(oldPassword), true);
  assert.equal(
    (await readFile(join(f.directory, "admin-login.txt"), "utf8")).trim(),
    oldPassword,
  );
  assert.deepEqual((await readdir(f.directory)).sort(), [
    "admin-credentials.json",
    "admin-login.txt",
  ]);
});

async function httpFixture(t, options = {}) {
  const f = await fixture(t);
  let time = Date.now(),
    closed = 0;
  const recoveryCredentials = options.beforeReset
    ? {
        recoveryAvailable: () => f.credentials.recoveryAvailable(),
        sessionVersion: () => f.credentials.sessionVersion(),
        reset: async () => {
          await options.beforeReset();
          return f.credentials.reset();
        },
      }
    : f.credentials;
  const router = createAdminRecoveryRouter({
    credentials: recoveryCredentials,
    sessions: f.sessions,
    closeBrowser: () => closed++,
    now: () => time,
    ...options,
  });
  const server = createServer(async (request, response) => {
    const send = (res, status, value, headers = {}) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        ...headers,
      });
      res.end(JSON.stringify(value));
    };
    try {
      const readBody = async (req) => {
        let bytes = "";
        for await (const chunk of req) bytes += chunk;
        return JSON.parse(bytes || "{}");
      };
      if (
        !(await router({
          request,
          response,
          url: new URL(request.url, "http://localhost"),
          send,
          readBody,
        }))
      )
        send(response, 404, {});
    } catch (error) {
      send(response, error.status || 500, { error: error.message });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = (
    method = "GET",
    data = null,
    headers = {},
    path = "/api/admin-recovery",
  ) =>
    new Promise((resolve, reject) => {
      const req = requestHttp(
        url + path,
        {
          method,
          headers: {
            "Content-Type": "application/json",
            ...(method === "POST" ? { Origin: url } : {}),
            ...headers,
          },
        },
        (res) => {
          let bytes = "";
          res.on("data", (chunk) => (bytes += chunk));
          res.on("end", () => {
            const responseHeaders = new Headers();
            for (const [key, value] of Object.entries(res.headers))
              for (const item of Array.isArray(value) ? value : [value])
                if (item !== undefined) responseHeaders.append(key, item);
            resolve({
              status: res.statusCode,
              headers: responseHeaders,
              json: async () => JSON.parse(bytes),
            });
          });
        },
      );
      req.on("error", reject);
      req.end(data === null ? undefined : JSON.stringify(data));
    });
  const challenge = async (headers = {}) => {
    const response = await request("GET", null, headers);
    return {
      response,
      info: await response.json(),
      cookie: response.headers.get("set-cookie")?.split(";")[0],
    };
  };
  return {
    ...f,
    request,
    challenge,
    advance: (ms) => (time += ms),
    closed: () => closed,
  };
}

test("public and forwarded requests never receive a nonce, password or recovery cookie", async (t) => {
  const f = await httpFixture(t);
  for (const headers of [
    { Host: "dashboard.example.test" },
    { "X-Real-IP": "127.0.0.1" },
    { "X-Forwarded-Proto": "https" },
    { "CF-Connecting-IP": "127.0.0.1" },
  ]) {
    const response = await f.request("GET", null, headers);
    assert.deepEqual(await response.json(), {
      localAvailable: false,
      initialPasswordFile: "secrets/admin-login.txt",
    });
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(
      (
        await f.request(
          "POST",
          { confirmation: RESET_CONFIRMATION, nonce: "a".repeat(64) },
          headers,
        )
      ).status,
      403,
    );
  }
  assert.equal(f.credentials.verify(oldPassword), true);
});

test("local reset requires a fresh browser-bound nonce and exact typed acknowledgement", async (t) => {
  const f = await httpFixture(t);
  const { response, info, cookie } = await f.challenge();
  assert.equal(info.localAvailable, true);
  assert.match(info.nonce, /^[a-f0-9]{64}$/);
  assert.match(response.headers.get("set-cookie"), /HttpOnly/);
  assert.match(response.headers.get("set-cookie"), /SameSite=Strict/);
  assert.match(response.headers.get("set-cookie"), /Max-Age=120/);
  const valid = { confirmation: RESET_CONFIRMATION, nonce: info.nonce };
  assert.equal((await f.request("POST", valid)).status, 403);
  assert.equal(
    (
      await f.request(
        "POST",
        { ...valid, confirmation: "" },
        { Cookie: cookie },
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request(
        "POST",
        { ...valid, nonce: "b".repeat(64) },
        { Cookie: cookie },
      )
    ).status,
    403,
  );
  assert.equal(f.credentials.verify(oldPassword), true);
});

test("successful recovery revokes every durable admin cookie and returns the password only once", async (t) => {
  const f = await httpFixture(t),
    token = "a".repeat(64);
  f.sessions.set(token, Date.now() + SESSION_TTL_MS);
  await f.sessions.flush();
  const { info, cookie } = await f.challenge();
  const data = { confirmation: RESET_CONFIRMATION, nonce: info.nonce };
  const response = await f.request("POST", data, { Cookie: cookie });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const result = await response.json();
  assert.equal(result.reset, true);
  assert.equal(result.authenticated, false);
  assert.equal(f.credentials.verify(result.newPassword), true);
  assert.equal(f.sessions.get(token), null);
  assert.equal(f.closed(), 1);
  assert.match(
    response.headers.get("set-cookie"),
    /collector_session=;.*Max-Age=0/,
  );
  const restarted = new AdminSessions({
    store: f.store,
    binding: f.credentials.sessionVersion(),
  });
  await restarted.load();
  assert.equal(restarted.get(token), null);
  assert.equal((await f.request("POST", data, { Cookie: cookie })).status, 403);
  const remote = await f.request("GET", null, { Host: "public.example" });
  assert.equal(
    JSON.stringify(await remote.json()).includes(result.newPassword),
    false,
  );
});

test("expired nonces, cross-site JSON requests, unsupported methods and repeated reset attempts are rejected", async (t) => {
  const f = await httpFixture(t);
  const expired = await f.challenge();
  f.advance(120001);
  assert.equal(
    (
      await f.request(
        "POST",
        { confirmation: RESET_CONFIRMATION, nonce: expired.info.nonce },
        { Cookie: expired.cookie },
      )
    ).status,
    403,
  );
  const challenge = await f.challenge();
  const data = {
    confirmation: RESET_CONFIRMATION,
    nonce: challenge.info.nonce,
  };
  assert.equal(
    (
      await f.request("POST", data, {
        Cookie: challenge.cookie,
        Origin: "http://evil.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("POST", data, {
        Cookie: challenge.cookie,
        "Content-Type": "text/plain",
      })
    ).status,
    400,
  );
  assert.equal((await f.request("PUT")).status, 405);
  assert.equal((await f.request("GET", null, {}, "/other")).status, 404);
  for (let i = 0; i < 3; i++) {
    const next = await f.challenge();
    assert.equal(
      (
        await f.request(
          "POST",
          { confirmation: RESET_CONFIRMATION, nonce: next.info.nonce },
          { Cookie: next.cookie },
        )
      ).status,
      200,
    );
  }
  const next = await f.challenge();
  assert.equal(
    (
      await f.request(
        "POST",
        { confirmation: RESET_CONFIRMATION, nonce: next.info.nonce },
        { Cookie: next.cookie },
      )
    ).status,
    429,
  );
});

test("failed durable session writes disclose no generated password and do not revive old cookies", async (t) => {
  const f = await httpFixture(t),
    token = "c".repeat(64);
  f.sessions.set(token, Date.now() + SESSION_TTL_MS);
  await f.sessions.flush();
  const stale = await readFile(f.store.path("admin-sessions.json"), "utf8");
  const { info, cookie } = await f.challenge();
  await rm(f.store.path("admin-sessions.json"));
  await mkdir(f.store.path("admin-sessions.json"));
  const response = await f.request(
    "POST",
    { confirmation: RESET_CONFIRMATION, nonce: info.nonce },
    { Cookie: cookie },
  );
  assert.equal(response.status, 503);
  const result = await response.json();
  assert.equal(result.newPassword, undefined);
  assert.equal(f.sessions.get(token), null);
  await rm(f.store.path("admin-sessions.json"), { recursive: true });
  await writeFile(f.store.path("admin-sessions.json"), stale);
  const restarted = new AdminSessions({
    store: f.store,
    binding: f.credentials.sessionVersion(),
  });
  await restarted.load();
  assert.equal(restarted.get(token), null);
});

test("simultaneous owner challenges allow only one reset and reject new challenges while resetting", async (t) => {
  let release,
    entered,
    resetCalls = 0;
  const gate = new Promise((resolve) => (release = resolve)),
    started = new Promise((resolve) => (entered = resolve));
  const f = await httpFixture(t, {
    beforeReset: async () => {
      resetCalls++;
      entered();
      await gate;
    },
  });
  const a = await f.challenge(),
    b = await f.challenge();
  const posts = [a, b].map(({ info, cookie }) =>
    f.request(
      "POST",
      { confirmation: RESET_CONFIRMATION, nonce: info.nonce },
      { Cookie: cookie },
    ),
  );
  await started;
  try {
    assert.equal((await f.request()).status, 409);
  } finally {
    release();
    await Promise.all(posts);
  }
  const replies = await Promise.all(posts);
  assert.deepEqual(replies.map((reply) => reply.status).sort(), [200, 409]);
  assert.equal(resetCalls, 1);
  const result = await replies.find((reply) => reply.status === 200).json();
  assert.equal(f.credentials.verify(result.newPassword), true);
  for (const { info, cookie } of [a, b])
    assert.equal(
      (
        await f.request(
          "POST",
          { confirmation: RESET_CONFIRMATION, nonce: info.nonce },
          { Cookie: cookie },
        )
      ).status,
      403,
    );
  assert.equal((await f.request()).status, 200);
});

for (const filename of ["admin-login.txt", "admin-credentials.json"])
  test(`web recovery refuses a linked ${filename} without touching the link target`, async (t) => {
    const f = await fixture(t),
      target = join(f.root, "outside-fixture.txt"),
      path = join(f.directory, filename);
    await writeFile(target, "external-fixture-never-change");
    await rm(path);
    try {
      await symlink(target, path, "file");
    } catch (error) {
      if (
        process.platform === "win32" &&
        ["EPERM", "EACCES"].includes(error.code)
      )
        return t.skip("Windows file symlink privilege unavailable");
      throw error;
    }
    await assert.rejects(f.credentials.reset(), /경로|안전/);
    assert.equal(
      await readFile(target, "utf8"),
      "external-fixture-never-change",
    );
    assert.equal(f.credentials.verify(oldPassword), true);
  });

test("web recovery refuses a linked secrets directory", async (t) => {
  const f = await fixture(t),
    target = join(f.root, "secret-directory-backup");
  await rename(f.directory, target);
  await symlink(
    target,
    f.directory,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(f.credentials.reset(), /경로|안전/);
  assert.equal(
    (await readFile(join(target, "admin-login.txt"), "utf8")).trim(),
    oldPassword,
  );
});
