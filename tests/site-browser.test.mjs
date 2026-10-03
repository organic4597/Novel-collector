import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { SiteBrowser } from "../src/site-browser.mjs";
import { createSiteBrowserRouter } from "../src/site-browser-api.mjs";
import { SiteAutoAuth } from "../src/site-auto-auth.mjs";
import { AutoRecovery } from "../src/auto-recovery.mjs";
import { ensureSiteLogin } from "../src/site-login.mjs";

const host = "newtoki1.org";
const probe = `https://${host}/novel/21104/111`;
function fixture(
  t,
  {
    busy = false,
    launchFailure = false,
    idleMs = 120000,
    maxSessionMs = 900000,
  } = {},
) {
  let now = 1000,
    body =
      '<div data-theme-novel-content><div class="wr-none">일일 조회 인증이 필요합니다.</div></div>';
  const site = {
    host,
    held: true,
    jobIds: ["job-1"],
    requiredSlots: [1, 2],
    verifiedSlots: [],
  };
  const calls = [],
    page = {
      currentUrl: probe,
      url() {
        return this.currentUrl;
      },
      async goto(url, options) {
        this.currentUrl = url;
        calls.push(["goto", url, options.timeout]);
        return { status: () => this.responseStatus || 200 };
      },
      async evaluate(reader) {
        const dom = new JSDOM(body, { url: probe });
        try {
          return reader(dom.window.document);
        } finally {
          dom.window.close();
        }
      },
      async screenshot(options) {
        calls.push(["screenshot", options]);
        return Buffer.from("JPEG");
      },
      mouse: {
        async click(x, y) {
          calls.push(["click", x, y]);
        },
        async wheel(x, y) {
          calls.push(["scroll", x, y]);
        },
      },
      keyboard: {
        async press(key) {
          calls.push(["key", key]);
        },
        async insertText(text) {
          calls.push(["text", text]);
        },
      },
    };
  const context = {
    async route() {},
    async newPage() {
      return page;
    },
    async close() {
      calls.push(["close"]);
    },
  };
  const scheduler = {
    async reserveManualSlot(slot) {
      if (busy) throw Object.assign(new Error("busy"), { status: 409 });
      calls.push(["reserve", slot]);
      return true;
    },
    async releaseManualSlot(slot) {
      calls.push(["release", slot]);
    },
    async releaseSite(value) {
      calls.push(["releaseSite", value]);
      site.held = false;
    },
  };
  const attention = {
    snapshot: () => ({
      sites: [{ ...site, verifiedSlots: site.verifiedSlots.slice() }],
    }),
    get: (value) =>
      value === host
        ? { ...site, verifiedSlots: site.verifiedSlots.slice() }
        : null,
    async verifySlot(value, slot, { viewerOrigin, beforeRelease } = {}) {
      assert.equal(value, host);
      const priorSlots =
        site.proofOrigin === viewerOrigin ? site.verifiedSlots : [];
      const verifiedSlots = [...new Set([...priorSlots, slot])];
      const held = !site.requiredSlots.every((id) =>
        verifiedSlots.includes(id),
      );
      if (!held) await beforeRelease?.();
      Object.assign(site, { verifiedSlots, held, proofOrigin: viewerOrigin });
      return { ...site };
    },
  };
  const store = {
    async getJob() {
      return {
        id: "job-1",
        url: `https://${host}/novel/21104`,
        bookId: "book",
        currentChapterId: "chapter-1",
      };
    },
    async readCatalog() {
      return {
        chapters: [
          { id: "chapter-1", url: probe },
          { id: "chapter-2", url: `${probe}2` },
        ],
      };
    },
  };
  const browser = new SiteBrowser({
    store,
    scheduler,
    attention,
    profileDir: "/profiles",
    clock: () => now,
    idleMs,
    maxSessionMs,
    launchContext: async (options) => {
      calls.push(["launch", options]);
      if (launchFailure) throw new Error("secret password=hidden");
      return context;
    },
  });
  t.after(() => browser.close());
  return {
    browser,
    site,
    calls,
    page,
    store,
    attention,
    scheduler,
    setBody(value) {
      body = value;
    },
    advance(ms) {
      now += ms;
    },
  };
}

test("verification waits for asynchronous reader content after navigation before releasing the slot", async (t) => {
  const f = fixture(t);
  f.setBody(
    '<div data-theme-novel-content><div class="wr-none">본문 불러오는 중...</div></div>',
  );
  let waits = 0;
  f.page.waitForTimeout = async (ms) => {
    assert.equal(ms, 250);
    assert.deepEqual(f.site.verifiedSlots, []);
    waits++;
    if (waits === 2)
      f.setBody(
        "<div data-theme-novel-content><p>정상 본문 준비 완료</p></div>",
      );
  };
  await f.browser.open({ host, slot: 1 });
  const result = await f.browser.check();
  assert.equal(result.verified, true);
  assert.equal(waits, 2);
  assert.deepEqual(f.site.verifiedSlots, [1]);
});

test("internal automatic authentication receives only the reserved source page and never returns callback secrets", async (t) => {
  const f = fixture(t);
  await f.browser.open({ host, slot: 1 });
  let invoked = 0;
  const result = await f.browser.authenticate(async (page, target) => {
    assert.equal(page, f.page);
    assert.deepEqual(target, { host, slot: 1 });
    invoked++;
    return { password: "test-only-secret", pendingToken: "private-test-token" };
  });
  assert.equal(invoked, 1);
  assert.equal(result.open, true);
  assert.equal(JSON.stringify(result).includes("test-only-secret"), false);
  f.page.currentUrl = "https://outside.example/";
  await assert.rejects(
    f.browser.authenticate(async () => {
      invoked++;
    }),
    { status: 409 },
  );
  assert.equal(invoked, 1);
});

test("open requires a held host, reserves one slot and launches its actual persistent profile without automatic input", async (t) => {
  const f = fixture(t);
  const state = await f.browser.open({ host, slot: 1 });
  assert.equal(state.open, true);
  assert.equal(state.slot, 1);
  assert.equal(state.url, probe);
  assert.equal(state.width, 1280);
  assert.equal(state.height, 900);
  assert.deepEqual(state.pendingSlots, [1, 2]);
  assert.ok(f.calls.some((call) => call[0] === "reserve" && call[1] === 1));
  assert.match(
    f.calls.find((call) => call[0] === "launch")[1].profileDir,
    /slot-1$/,
  );
  assert.deepEqual(
    f.calls.find((call) => call[0] === "goto"),
    ["goto", probe, 45000],
  );
  assert.ok(
    !f.calls.some((call) =>
      ["click", "text", "key", "scroll"].includes(call[0]),
    ),
  );
  f.page.currentUrl = `${probe}?private_token=do-not-display#secret`;
  assert.equal((await f.browser.status()).url, probe);
});

test("trusted viewer saves its origin only after every canonical slot proves actual body", async (t) => {
  const f = fixture(t),
    saved = [];
  f.browser.viewerOrigins = {
    get: () => null,
    save: async (...args) => saved.push(args),
  };
  const state = await f.browser.open({
    host,
    slot: 1,
    viewerOrigin: "https://sbxh9.com",
  });
  assert.equal(state.viewerHost, "sbxh9.com");
  assert.equal(state.host, host);
  assert.equal(state.url, "https://sbxh9.com/novel/21104/111");
  await assert.rejects(f.browser.check({ reload: false }), { kind: "captcha" });
  assert.deepEqual(saved, []);
  f.advance(5000);
  f.setBody("<div data-theme-novel-content><p>정상 회차 본문</p></div>");
  const proof = await f.browser.check({ reload: false });
  assert.equal(proof.host, host);
  assert.deepEqual(saved, []);
  assert.deepEqual(f.site.verifiedSlots, [1]);
  await f.browser.open({ host, slot: 2, viewerOrigin: "https://sbxh9.com" });
  assert.equal((await f.browser.check({ reload: false })).siteReleased, true);
  assert.deepEqual(saved, [[host, "https://sbxh9.com"]]);
});

test("viewer input has bounded pointer events and rejects untrusted origins before reservation", async (t) => {
  const f = fixture(t);
  for (const viewerOrigin of [
    "http://sbxh9.com",
    "https://sbxh9.com:444",
    "https://user:pass@sbxh9.com",
    "https://evil.example",
    "https://sbxh9.com/path",
  ])
    await assert.rejects(f.browser.open({ host, slot: 1, viewerOrigin }), {
      status: 400,
    });
  assert.equal(f.calls.length, 0);
  f.page.mouse.move = async (x, y) => f.calls.push(["move", x, y]);
  f.page.mouse.down = async () => f.calls.push(["down"]);
  f.page.mouse.up = async () => f.calls.push(["up"]);
  await f.browser.open({ host, slot: 1, viewerOrigin: "https://sbxh9.com" });
  for (const phase of ["down", "move", "up"])
    await f.browser.input({ type: "pointer", phase, x: 100, y: 200 });
  assert.deepEqual(
    f.calls.filter((call) => ["move", "down", "up"].includes(call[0])),
    [
      ["move", 100, 200],
      ["down"],
      ["move", 100, 200],
      ["move", 100, 200],
      ["up"],
    ],
  );
  for (const input of [
    { phase: "down", x: NaN, y: 2 },
    { phase: "move", x: 1280, y: 2 },
    { phase: "other", x: 2, y: 2 },
  ])
    await assert.rejects(f.browser.input({ type: "pointer", ...input }), {
      status: 400,
    });
});

test("owned human session rejects legacy actions and close without its private owner", async (t) => {
  const f = fixture(t);
  await f.browser.open({ host, slot: 1, owner: "internal-owner" });
  await assert.rejects(f.browser.close(), { status: 409 });
  await assert.rejects(f.browser.frame(), { status: 409 });
  await assert.rejects(f.browser.input({ type: "click", x: 1, y: 1 }), {
    status: 409,
  });
  assert.equal((await f.browser.status()).open, true);
  await f.browser.close({ owner: "internal-owner" });
});

test("viewer proof cannot be taken from another chapter path and expiry notifies its human owner", async (t) => {
  const f = fixture(t, { idleMs: 100 }),
    events = [];
  await f.browser.open({
    host,
    slot: 1,
    viewerOrigin: "https://sbxh9.com",
    onExpired: async () => events.push("expired"),
  });
  f.setBody("<div data-theme-novel-content><p>다른 회차 본문</p></div>");
  f.page.currentUrl = "https://sbxh9.com/novel/999/777";
  await assert.rejects(f.browser.check({ reload: false }), {
    kind: "verification",
  });
  assert.deepEqual(f.site.verifiedSlots, []);
  f.advance(101);
  await f.browser.status();
  assert.deepEqual(events, ["expired"]);
});

test("invalid targets, unheld hosts and busy slots never launch a browser", async (t) => {
  const f = fixture(t);
  for (const input of [
    { host: "127.0.0.1", slot: 1 },
    { host, slot: 3 },
    { host: "newtoki2.org", slot: 1 },
  ])
    await assert.rejects(f.browser.open(input), (error) =>
      [400, 409].includes(error.status),
    );
  assert.ok(!f.calls.some((call) => call[0] === "launch"));
  const blocked = fixture(t, { busy: true });
  await assert.rejects(blocked.browser.open({ host, slot: 1 }), {
    status: 409,
  });
  assert.ok(!blocked.calls.some((call) => call[0] === "launch"));
});

test("human input is bounded and text is absent from status or errors", async (t) => {
  const f = fixture(t);
  await f.browser.open({ host, slot: 1 });
  await f.browser.input({ type: "click", x: 20, y: 30 });
  await f.browser.input({ type: "scroll", deltaY: 100, deltaX: 0 });
  await f.browser.input({ type: "key", key: "Tab" });
  await f.browser.input({ type: "text", text: "sensitive-user-input" });
  for (const input of [
    { type: "click", x: -1, y: 0 },
    { type: "click", x: 1280, y: 10 },
    { type: "key", key: "Control+L" },
    { type: "scroll", deltaY: 100000 },
    { type: "text", text: "a".repeat(4097) },
    { type: "navigate", url: "https://evil.example/" },
  ])
    await assert.rejects(f.browser.input(input), { status: 400 });
  assert.ok(
    !JSON.stringify(await f.browser.status()).includes("sensitive-user-input"),
  );
  assert.equal(f.calls.filter((call) => call[0] === "text").length, 1);
});

test("frame rate is limited and an idle browser closes while leaving the host held", async (t) => {
  const f = fixture(t, { idleMs: 100 });
  await f.browser.open({ host, slot: 1 });
  assert.equal((await f.browser.frame()).mimeType, "image/jpeg");
  await assert.rejects(f.browser.frame(), { status: 429 });
  f.advance(101);
  assert.equal((await f.browser.status()).open, false);
  assert.equal(f.site.held, true);
  assert.ok(f.calls.some((call) => call[0] === "release"));
});

test("check rejects notice-only and challenge pages; both slots must prove real body before queue release", async (t) => {
  const f = fixture(t);
  await f.browser.open({ host, slot: 1 });
  await assert.rejects(f.browser.check(), { status: 409 });
  assert.deepEqual(f.site.verifiedSlots, []);
  await assert.rejects(f.browser.check(), { status: 429 });
  f.advance(5000);
  f.setBody(
    "<title>Just a moment</title><div data-theme-novel-content><p>본문같은 글</p></div>",
  );
  await assert.rejects(f.browser.check(), { status: 409 });
  f.advance(5000);
  f.setBody("<div data-theme-novel-content><p>확인된 회차 본문</p></div>");
  const verified = await f.browser.check();
  assert.equal(verified.verified, true);
  assert.equal(verified.siteReleased, false);
  assert.deepEqual(verified.pendingSlots, [2]);
  assert.deepEqual(f.site.verifiedSlots, [1]);
  assert.ok(!f.calls.some((call) => call[0] === "releaseSite"));
  assert.equal((await f.browser.status()).open, false);
  await f.browser.open({ host, slot: 2 });
  assert.equal((await f.browser.check()).siteReleased, true);
  assert.deepEqual(f.site.verifiedSlots, [1, 2]);
  assert.equal(f.calls.filter((call) => call[0] === "releaseSite").length, 1);
});

test("launch failure releases the slot and exposes only a generic safe error", async (t) => {
  const f = fixture(t, { launchFailure: true });
  await assert.rejects(
    f.browser.open({ host, slot: 1 }),
    (error) => error.status === 503 && !error.message.includes("hidden"),
  );
  assert.equal((await f.browser.status()).open, false);
  assert.deepEqual(
    f.calls.filter((call) => call[0] === "release"),
    [["release", 1]],
  );
});

test("foreign main-page navigation cannot receive human input or pass verification", async (t) => {
  const f = fixture(t);
  await f.browser.open({ host, slot: 1 });
  f.page.currentUrl = "https://other.example/login";
  await assert.rejects(f.browser.input({ type: "text", text: "secret" }), {
    status: 409,
  });
  assert.ok(!f.calls.some((call) => call[0] === "text"));
});

test("HTTP router serves only documented routes and returns uncached JPEG frames", async (t) => {
  const f = fixture(t);
  const router = createSiteBrowserRouter({ siteBrowser: f.browser });
  const sends = [],
    request = { method: "POST" };
  const response = {
    headers: {},
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(bytes) {
      this.bytes = bytes;
    },
  };
  const invoke = async (path, method, input = {}) =>
    router({
      request: { ...request, method },
      response,
      url: new URL(path, "http://localhost"),
      readBody: async () => input,
      send: (_res, status, state) => sends.push({ status, state }),
    });
  assert.equal(
    await invoke("/api/site-browser/open", "POST", { host, slot: 1 }),
    true,
  );
  assert.equal(sends.at(-1).state.open, true);
  assert.equal(await invoke("/api/site-browser/frame", "GET"), true);
  assert.equal(response.headers["Content-Type"], "image/jpeg");
  assert.equal(response.headers["Cache-Control"], "no-store");
  assert.ok(Buffer.isBuffer(response.bytes));
  assert.equal(await invoke("/api/site-browser/unknown", "GET"), false);
  assert.equal(await invoke("/api/site-browser/close", "POST"), true);
  assert.equal(sends.at(-1).state.open, false);
});

test("frame activity cannot extend the hard session limit and user close never clears a held site", async (t) => {
  const f = fixture(t, { idleMs: 3000, maxSessionMs: 2500 });
  await f.browser.open({ host, slot: 1 });
  f.advance(1000);
  await f.browser.frame();
  f.advance(1000);
  await f.browser.frame();
  f.advance(501);
  assert.equal((await f.browser.status()).open, false);
  assert.equal(f.site.held, true);
  assert.deepEqual(f.site.verifiedSlots, []);
  await f.browser.open({ host, slot: 2 });
  await f.browser.close();
  assert.equal(f.site.held, true);
  assert.ok(!f.calls.some((call) => call[0] === "releaseSite"));
});

test("current saved chapter lookup and safe errors handle unavailable catalogs and browser action failures", async (t) => {
  const f = fixture(t);
  f.store.readCatalog = async () => null;
  f.store.listChapters = async () => [{ url: probe }];
  await f.browser.open({ host, slot: 1 });
  f.page.keyboard.insertText = async () => {
    throw new Error("private text and token=hidden");
  };
  await assert.rejects(
    f.browser.input({ type: "text", text: "private text" }),
    (error) => error.status === 503 && !/private|hidden/.test(error.message),
  );
  await assert.rejects(f.browser.input(null), { status: 400 });
  f.page.screenshot = async () => {
    throw new Error("private text and cookie=hidden");
  };
  await assert.rejects(
    f.browser.frame(),
    (error) => error.status === 503 && !/private|hidden/.test(error.message),
  );
  await f.browser.close();
  f.store.listChapters = async () => [];
  await assert.rejects(f.browser.open({ host, slot: 1 }), { status: 409 });
});

test("verification-required flag and failing HTTP responses cannot be accepted even when visible body exists", async (t) => {
  const f = fixture(t);
  await f.browser.open({ host, slot: 1 });
  f.page.evaluate = async () => ({
    text: "이미 보이는 본문",
    challenge: false,
    verificationRequired: true,
  });
  await assert.rejects(f.browser.check(), { status: 409 });
  assert.deepEqual(f.site.verifiedSlots, []);
  f.advance(5000);
  f.page.evaluate = async () => ({
    text: "확인된 본문",
    challenge: false,
    verificationRequired: false,
  });
  f.page.responseStatus = 403;
  await assert.rejects(f.browser.check(), { status: 409 });
  assert.deepEqual(f.site.verifiedSlots, []);
});

test("router input/status/check dispatch validates service availability and leaves unsupported methods unhandled", async (t) => {
  const f = fixture(t);
  const router = createSiteBrowserRouter({ siteBrowser: f.browser });
  const states = [];
  const invoke = (path, method, input = {}) =>
    router({
      request: { method },
      response: {},
      url: new URL(path, "http://localhost"),
      readBody: async () => input,
      send: (_res, _status, state) => states.push(state),
    });
  assert.equal(await invoke("/api/other", "GET"), false);
  assert.equal(await invoke("/api/site-browser/status", "POST"), false);
  await invoke("/api/site-browser/open", "POST", { host, slot: 1 });
  await invoke("/api/site-browser/input", "POST", {
    type: "key",
    key: "Enter",
  });
  assert.equal(await invoke("/api/site-browser/status", "GET"), true);
  assert.equal(states.at(-1).open, true);
  f.setBody("<div data-theme-novel-content><p>확인된 본문</p></div>");
  assert.equal(await invoke("/api/site-browser/check", "POST"), true);
  assert.equal(states.at(-1).verified, true);
  const unavailable = createSiteBrowserRouter({ siteBrowser: null });
  await assert.rejects(
    unavailable({
      request: { method: "GET" },
      url: new URL("/api/site-browser/status", "http://localhost"),
    }),
    { status: 503 },
  );
});

test("internal proof reuses the opened reader and classifies CAPTCHA without releasing held slots", async (t) => {
  const f = fixture(t);
  await f.browser.open({ host, slot: 1 });
  await assert.rejects(f.browser.check({ reload: false }), { kind: "captcha" });
  assert.equal(f.calls.filter((call) => call[0] === "goto").length, 1);
  assert.deepEqual(f.site.verifiedSlots, []);
  f.advance(5000);
  f.setBody(
    "<div data-theme-novel-content><p>사람이 인증을 완료한 정상 본문</p></div>",
  );
  assert.equal((await f.browser.check({ reload: false })).verified, true);
  assert.equal(f.calls.filter((call) => call[0] === "goto").length, 1);
});

test("reused body verification retains the navigation HTTP failure and Retry-After", async (t) => {
  const f = fixture(t);
  f.setBody(
    "<div data-theme-novel-content><p>본문처럼 보이는 오류 화면</p></div>",
  );
  f.page.goto = async () => ({
    status: () => 429,
    headers: () => ({ "retry-after": "900" }),
  });
  await f.browser.open({ host, slot: 1 });
  await assert.rejects(f.browser.check({ reload: false }), {
    kind: "rate",
    httpStatus: 429,
    retryAfterMs: 900000,
  });
  assert.deepEqual(f.site.verifiedSlots, []);
});

test("automatic held-site recovery uses legitimate membership and real body proof, without credential POSTs", async (t) => {
  for (const cleared of [true, false]) {
    const f = fixture(t);
    f.scheduler.active = new Map();
    f.scheduler.manualSlots = new Set();
    f.scheduler.queuePaused = true;
    f.setBody(
      "<header><button data-theme-user-toggle>회원</button></header>" +
        (cleared
          ? "<div data-theme-novel-content><p>사람이 인증을 완료한 정상 본문</p></div>"
          : '<div data-theme-novel-content><div class="wr-none">일일 조회 인증이 필요합니다.</div></div>'),
    );
    let posts = 0;
    f.page.request = {
      post: async () => {
        posts++;
        throw Error("unexpected credential POST");
      },
    };
    const accounts = {
      status: () => ({ configured: true, enabled: true }),
      getCredentials: () => ({
        host,
        username: "test-user",
        password: "test-only",
        pin: "5286",
      }),
    };
    const auto = new SiteAutoAuth({
      accounts,
      siteBrowser: f.browser,
      attention: f.attention,
      scheduler: f.scheduler,
      login: (input) =>
        ensureSiteLogin({ ...input, validateHost: async () => true }),
    });
    const recovery = new AutoRecovery({
      accounts,
      autoAuth: auto,
      scheduler: f.scheduler,
      pollMs: 1,
    });
    t.after(async () => {
      recovery.close();
      await auto.close();
    });
    recovery.request({ ...f.site, kind: "captcha" });
    const deadline = Date.now() + 1500;
    while (!["ready", "needs_attention"].includes(auto.status(host).state)) {
      assert.ok(Date.now() < deadline, "automatic body proof must settle");
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    await auto.wait(host);
    assert.equal(posts, 0);
    assert.equal(f.scheduler.queuePaused, true);
    assert.equal(f.site.held, !cleared);
    assert.deepEqual(f.site.verifiedSlots, cleared ? [1, 2] : []);
    assert.equal(
      f.calls.filter((call) => call[0] === "goto").length,
      cleared ? 2 : 1,
    );
    assert.equal(auto.status(host).failureKind, cleared ? null : "captcha");
  }
});
