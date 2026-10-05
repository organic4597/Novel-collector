import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const nonce = "a".repeat(64);
const confirmation = "관리자 비밀번호 초기화";
const fixturePassword = "fixture-new-local-admin";
const markup = await readFile(
  new URL("../public/index.html", import.meta.url),
  "utf8",
);
async function fixture(
  t,
  { url = "http://localhost:8789/", request = null } = {},
) {
  const dom = new JSDOM(markup, { url, runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const w = dom.window,
    calls = [],
    blobs = [],
    downloads = [],
    revoked = [];
  let generation = 1,
    authenticated = false;
  w.CollectorUI = {
    generation: () => generation,
    authenticated: () => authenticated,
  };
  w.fetch = async (path, options = {}) => {
    calls.push({ path, options });
    if (request) return request(path, options);
    return {
      ok: true,
      status: 200,
      json: async () =>
        options.method === "POST"
          ? {
              reset: true,
              authenticated: false,
              newPassword: fixturePassword,
              passwordFile: "secrets/admin-login.txt",
            }
          : { localAvailable: true, nonce, expiresAt: Date.now() + 120000 },
    };
  };
  w.Blob = class {
    constructor(parts, options) {
      this.parts = parts;
      this.options = options;
      blobs.push(this);
    }
  };
  w.URL.createObjectURL = () => "blob:local-reset-file";
  w.URL.revokeObjectURL = (value) => revoked.push(value);
  w.HTMLAnchorElement.prototype.click = function () {
    downloads.push({ href: this.href, name: this.download });
  };
  w.console.log = () => assert.fail("recovery must not log passwords");
  const source = new URL("../public/login-recovery.js", import.meta.url);
  runInContext(await readFile(source, "utf8"), dom.getInternalVMContext(), {
    filename: fileURLToPath(source),
  });
  const d = w.document,
    $ = (id) => d.getElementById(id);
  const open = async () => {
    $("login-recovery").open = true;
    $("login-recovery").dispatchEvent(new w.Event("toggle"));
    await tick();
  };
  const authorize = () => {
    $("recovery-ack").checked = true;
    $("recovery-ack").dispatchEvent(new w.Event("change"));
    $("recovery-phrase").value = confirmation;
    $("recovery-phrase").dispatchEvent(new w.Event("input"));
  };
  const authEvent = (value) => {
    authenticated = value;
    generation++;
    d.dispatchEvent(new w.CustomEvent("collector:auth", { detail: value }));
  };
  return {
    w,
    d,
    $,
    calls,
    blobs,
    downloads,
    revoked,
    open,
    authorize,
    authEvent,
  };
}

test("remote viewers only receive manual guidance and never request reset availability", async (t) => {
  const f = await fixture(t, { url: "https://collector.example.com/" });
  await f.open();
  assert.equal(f.calls.length, 0);
  assert.equal(f.$("recovery-local-panel").hidden, true);
  assert.equal(f.$("recovery-remote-guide").hidden, false);
  f.authorize();
  f.$("recovery-reset").click();
  await tick();
  assert.equal(f.calls.length, 0);
});

test("real login markup supplies recovery guidance without changing normal login submission", async (t) => {
  const f = await fixture(t);
  const details = f.$("login-recovery");
  assert.equal(details.closest("form"), null);
  assert.equal(details.closest("#login-view"), f.$("login-view"));
  assert.ok(details.textContent.includes("secrets/admin-login.txt"));
  assert.ok(details.textContent.includes("SSH"));
  for (const text of [
    "모든 관리자 로그인 세션",
    "소설",
    "회차",
    "사이트 계정",
    "브라우저 프로필",
  ])
    assert.ok(f.$("recovery-warning").textContent.includes(text));
  const release = details.querySelector(
    'a[href="https://github.com/organic4597/Novel-collector/releases/latest"]',
  );
  assert.ok(release);
  assert.equal(release.target, "_blank");
  assert.ok(release.rel.split(" ").includes("noopener"));
  assert.equal(f.$("recovery-reset").type, "button");
  assert.equal(f.$("recovery-save").type, "button");
  assert.equal(f.$("login-password").type, "password");
  assert.equal(f.$("login-password").autocomplete, "current-password");
  assert.ok(f.d.querySelector('script[src="/login-recovery.js"][defer]'));
  let submitted = 0;
  f.$("login-form").addEventListener("submit", (event) => {
    event.preventDefault();
    submitted++;
  });
  f.$("login-password").value = "fixture-normal-login";
  f.$("login-form").dispatchEvent(
    new f.w.Event("submit", { bubbles: true, cancelable: true }),
  );
  assert.equal(submitted, 1);
  assert.equal(f.$("login-password").value, "fixture-normal-login");
  assert.equal(f.calls.length, 0);
  await f.open();
  assert.equal(
    f.$("recovery-phrase-guide").textContent,
    `확인 문구: ${confirmation}`,
  );
});

test("local reset requires checkbox and exact phrase then downloads credentials without login or secret persistence", async (t) => {
  const f = await fixture(t);
  f.$("login-password").value = "normal-login-input";
  await f.open();
  assert.equal(f.$("recovery-local-panel").hidden, false);
  assert.equal(f.$("recovery-reset").disabled, true);
  f.$("recovery-phrase").value = confirmation;
  f.$("recovery-phrase").dispatchEvent(new f.w.Event("input"));
  assert.equal(f.$("recovery-reset").disabled, true);
  f.authorize();
  f.$("recovery-reset").click();
  f.$("recovery-reset").click();
  await tick();
  const posts = f.calls.filter((call) => call.options.method === "POST");
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0].options.body), { confirmation, nonce });
  assert.equal(f.$("recovery-result").hidden, false);
  assert.equal(f.$("recovery-next").hidden, true);
  assert.equal(f.$("recovery-saved").disabled, true);
  assert.equal(f.d.body.textContent.includes(fixturePassword), false);
  assert.equal(f.$("login-password").value, "normal-login-input");
  assert.equal(f.w.localStorage.length, 0);
  assert.equal(f.w.sessionStorage.length, 0);
  f.$("recovery-save").click();
  assert.equal(f.downloads.length, 1);
  assert.match(f.blobs[0].parts.join(""), new RegExp(fixturePassword));
  assert.equal(f.$("recovery-saved").disabled, false);
  assert.equal(f.$("recovery-next").hidden, true);
  f.$("recovery-saved").checked = true;
  f.$("recovery-saved").dispatchEvent(new f.w.Event("change"));
  assert.equal(f.$("recovery-next").hidden, false);
  assert.equal(f.calls.filter((call) => call.path === "/api/login").length, 0);
});

test("backend refusal and invalid availability never enable local reset", async (t) => {
  for (const result of [
    { localAvailable: false },
    { localAvailable: true, nonce: "bad", expiresAt: Date.now() + 120000 },
    { localAvailable: true, nonce, expiresAt: Date.now() - 1 },
  ]) {
    const f = await fixture(t, {
      request: async () => ({ ok: true, json: async () => result }),
    });
    await f.open();
    f.authorize();
    assert.equal(f.$("recovery-reset").disabled, true);
    assert.equal(f.$("recovery-local-panel").hidden, true);
  }
});

test("late availability and reset responses are discarded on auth changes", async (t) => {
  let finishGet;
  const f = await fixture(t, {
    request: async () =>
      new Promise((resolve) => {
        finishGet = resolve;
      }),
  });
  await f.open();
  f.authEvent(true);
  finishGet({
    ok: true,
    json: async () => ({
      localAvailable: true,
      nonce,
      expiresAt: Date.now() + 120000,
    }),
  });
  await tick();
  assert.equal(f.$("recovery-local-panel").hidden, true);
  let finishPost;
  const g = await fixture(t, {
    request: async (path, options) =>
      options.method === "POST"
        ? new Promise((resolve) => {
            finishPost = resolve;
          })
        : {
            ok: true,
            json: async () => ({
              localAvailable: true,
              nonce,
              expiresAt: Date.now() + 120000,
            }),
          },
  });
  await g.open();
  g.authorize();
  g.$("recovery-reset").click();
  await tick();
  g.authEvent(false);
  finishPost({
    ok: true,
    json: async () => ({ reset: true, newPassword: fixturePassword }),
  });
  await tick();
  assert.equal(g.$("recovery-result").hidden, true);
  g.$("recovery-save").click();
  assert.equal(g.downloads.length, 0);
});

test("reset errors never reflect backend secrets and force renewed availability", async (t) => {
  const f = await fixture(t, {
    request: async (path, options) =>
      options.method === "POST"
        ? {
            ok: false,
            status: 500,
            json: async () => ({ error: `secret ${fixturePassword}` }),
          }
        : {
            ok: true,
            json: async () => ({
              localAvailable: true,
              nonce,
              expiresAt: Date.now() + 120000,
            }),
          },
  });
  await f.open();
  f.authorize();
  f.$("recovery-reset").click();
  await tick();
  assert.equal(
    f.$("recovery-status").textContent.includes(fixturePassword),
    false,
  );
  assert.equal(f.$("recovery-reset").disabled, true);
  assert.equal(f.$("recovery-result").hidden, true);
});

test("login/logout discard generated credentials and revoke file URLs", async (t) => {
  const f = await fixture(t);
  await f.open();
  f.authorize();
  f.$("recovery-reset").click();
  await tick();
  f.$("recovery-save").click();
  f.authEvent(true);
  assert.equal(f.$("recovery-result").hidden, true);
  assert.ok(f.revoked.includes("blob:local-reset-file"));
  f.$("recovery-save").click();
  assert.equal(f.downloads.length, 1);
});

test("closing and reopening recovery during a reset cannot dispatch another request", async (t) => {
  let finishPost;
  const f = await fixture(t, {
    request: async (path, options) =>
      options.method === "POST"
        ? new Promise((resolve) => {
            finishPost = resolve;
          })
        : {
            ok: true,
            json: async () => ({
              localAvailable: true,
              nonce,
              expiresAt: Date.now() + 120000,
            }),
          },
  });
  await f.open();
  f.authorize();
  f.$("recovery-reset").click();
  await tick();
  f.$("login-recovery").open = false;
  f.$("login-recovery").dispatchEvent(new f.w.Event("toggle"));
  await f.open();
  f.authorize();
  f.$("recovery-reset").click();
  assert.equal(f.calls.length, 2);
  finishPost({
    ok: true,
    json: async () => ({
      reset: true,
      authenticated: false,
      newPassword: fixturePassword,
    }),
  });
  await tick();
  f.$("recovery-save").click();
  assert.equal(f.downloads.length, 1);
  f.$("recovery-saved").checked = true;
  f.$("recovery-saved").dispatchEvent(new f.w.Event("change"));
  f.$("login-recovery").open = false;
  f.$("login-recovery").dispatchEvent(new f.w.Event("toggle"));
  await f.open();
  assert.equal(f.calls.length, 2);
});

test("download failures permit explicit retry and never show credentials in errors", async (t) => {
  const f = await fixture(t);
  await f.open();
  f.authorize();
  f.$("recovery-reset").click();
  await tick();
  f.w.URL.createObjectURL = () => {
    throw Error(fixturePassword);
  };
  f.$("recovery-save").click();
  assert.equal(f.$("recovery-saved").disabled, true);
  assert.equal(
    f.$("recovery-status").textContent.includes(fixturePassword),
    false,
  );
  f.w.URL.createObjectURL = () => "blob:retry";
  f.$("recovery-save").click();
  assert.equal(f.downloads.length, 1);
});

test("availability network errors and malformed reset responses expose only safe guidance", async (t) => {
  const failed = await fixture(t, {
    request: async () => {
      throw Error(fixturePassword);
    },
  });
  await failed.open();
  assert.equal(
    failed.$("recovery-status").textContent.includes(fixturePassword),
    false,
  );
  assert.equal(failed.$("recovery-reset").disabled, true);
  const malformed = await fixture(t, {
    request: async (path, options) => ({
      ok: true,
      json: async () =>
        options.method === "POST"
          ? { reset: true, authenticated: true, newPassword: fixturePassword }
          : { localAvailable: true, nonce, expiresAt: Date.now() + 120000 },
    }),
  });
  await malformed.open();
  malformed.authorize();
  malformed.$("recovery-reset").click();
  await tick();
  assert.equal(malformed.$("recovery-result").hidden, true);
  assert.equal(
    malformed.$("recovery-status").textContent.includes(fixturePassword),
    false,
  );
});
