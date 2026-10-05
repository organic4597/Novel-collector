import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { SiteAutoAuth } from "../src/site-auto-auth.mjs";

const host = "newtoki1.org";
const sourceCredentialFixture = "source-test-only";
function fixture(
  t,
  { failLogin = false, disabled = false, busy = false } = {},
) {
  let now = 1000,
    opened = null;
  const calls = [],
    site = { host, held: true, requiredSlots: [1, 2], verifiedSlots: [] };
  const attention = {
    get: () => ({ ...site, verifiedSlots: site.verifiedSlots.slice() }),
  };
  const accounts = {
    status: async () => ({ configured: true, enabled: !disabled }),
    getCredentials: async () => ({
      host,
      username: "user",
      password: "secret-test-only",
      pin: "5286",
    }),
  };
  const siteBrowser = {
    async open({ host, slot }) {
      if (busy) throw Object.assign(new Error("busy"), { status: 409 });
      opened = { host, slot };
      calls.push(["open", slot]);
    },
    async authenticate(callback) {
      calls.push(["authenticate", opened.slot]);
      await callback({}, opened);
    },
    async check() {
      calls.push(["check", opened.slot]);
      site.verifiedSlots.push(opened.slot);
      if (site.verifiedSlots.length === 2) site.held = false;
      opened = null;
      return { verified: true, siteReleased: !site.held };
    },
    async status() {
      return { open: !!opened, ...opened };
    },
    async close() {
      calls.push(["close"]);
      opened = null;
    },
  };
  const login = async (_input) => {
    if (failLogin)
      throw Object.assign(new Error("secret-test-only 5286"), {
        code: "NEEDS_ATTENTION",
        kind: "captcha",
      });
    return { authenticated: true, reused: false };
  };
  const auto = new SiteAutoAuth({
    accounts,
    siteBrowser,
    attention,
    scheduler: {},
    login,
    clock: () => now,
  });
  t.after(() => auto.close());
  return {
    auto,
    site,
    calls,
    advance(ms) {
      now += ms;
    },
  };
}
async function settled(auto) {
  for (let i = 0; i < 100; i++) {
    const state = await auto.status(host);
    if (state.state !== "running") return state;
    await wait(5);
  }
  throw Error("did not settle");
}

test("automatic login deduplicates the host and verifies each pending slot before completion", async (t) => {
  const f = fixture(t);
  const [one, two] = await Promise.all([
    f.auto.start(host),
    f.auto.start(host),
  ]);
  assert.equal(one.state, "running");
  assert.equal(one.id, two.id);
  assert.equal((await settled(f.auto)).state, "ready");
  assert.deepEqual(
    f.calls.filter((call) => call[0] === "open"),
    [
      ["open", 1],
      ["open", 2],
    ],
  );
  assert.equal(f.site.held, false);
});

test("CAPTCHA failure keeps the host held, closes its browser and exposes no credentials; retries have a cooldown", async (t) => {
  const f = fixture(t, { failLogin: true });
  await f.auto.start(host);
  const state = await settled(f.auto);
  assert.equal(state.state, "needs_attention");
  assert.ok(!JSON.stringify(state).includes("secret-test-only"));
  assert.ok(!JSON.stringify(state).includes("5286"));
  assert.equal(f.site.held, true);
  assert.ok(f.calls.some((call) => call[0] === "close"));
  await assert.rejects(f.auto.start(host), { status: 429 });
  f.advance(60000);
  assert.equal((await f.auto.start(host)).state, "running");
});

test("disabled credentials and an unheld site cannot open a browser", async (t) => {
  const f = fixture(t, { disabled: true });
  await assert.rejects(f.auto.start(host), { status: 503 });
  assert.deepEqual(f.calls, []);
  const other = fixture(t);
  other.site.held = false;
  await assert.rejects(other.auto.start(host), { status: 409 });
  assert.deepEqual(other.calls, []);
});

test("busy slot never triggers login or closes another session", async (t) => {
  const f = fixture(t, { busy: true });
  await f.auto.start(host);
  assert.equal((await settled(f.auto)).state, "needs_attention");
  assert.deepEqual(f.calls, []);
  assert.equal(f.site.held, true);
});

test("collector loginPage serializes source-host attempts, shares failure cooldown and skips disabled accounts", async (t) => {
  const f = fixture(t),
    page = { url: () => "https://newtoki1.org/novel/21104/111" };
  let active = 0,
    maximum = 0,
    calls = 0;
  f.auto.login = async () => {
    calls++;
    maximum = Math.max(maximum, ++active);
    await wait(10);
    active--;
    return { authenticated: true, reused: calls > 1 };
  };
  await Promise.all([f.auto.loginPage(page), f.auto.loginPage(page)]);
  assert.equal(maximum, 1);
  assert.equal(calls, 2);
  f.auto.login = async () => {
    calls++;
    throw Object.assign(new Error("secret-test-only 5286"), {
      kind: "rate",
      httpStatus: 429,
      retryAfterMs: 600000,
    });
  };
  await assert.rejects(
    f.auto.loginPage(page),
    (error) =>
      error.attentionKind === "authentication" &&
      error.httpStatus === 429 &&
      error.retryAfterMs === 600000 &&
      !error.message.includes("5286"),
  );
  await assert.rejects(f.auto.loginPage(page), { code: "NEEDS_ATTENTION" });
  assert.equal(calls, 3);
  const disabled = fixture(t, { disabled: true });
  assert.equal(await disabled.auto.loginPage(page), null);
  assert.deepEqual(disabled.calls, []);
});

test("public slot results are independent copies and missing credentials never open the source browser", async (t) => {
  const f = fixture(t);
  assert.equal(f.auto.status(host).state, "idle");
  await assert.rejects(f.auto.start("127.0.0.1"), { status: 400 });
  await f.auto.start(host);
  const state = await settled(f.auto);
  state.slotResults[0].status = "tampered";
  state.pendingSlots.push(99);
  assert.equal(f.auto.status(host).slotResults[0].status, "ready");
  assert.deepEqual(f.auto.status(host).pendingSlots, []);
  const missing = fixture(t);
  missing.auto.accounts.getCredentials = async () => null;
  await missing.auto.start(host);
  assert.equal((await settled(missing.auto)).state, "needs_attention");
  assert.deepEqual(missing.calls, []);
});

test("shutdown aborts a pending verification and closes the owned session without deadlock or releasing the host", async (t) => {
  const f = fixture(t);
  let verificationStarted;
  const started = new Promise((resolve) => {
    verificationStarted = resolve;
  });
  let releaseCheck;
  f.auto.siteBrowser.check = async () => {
    verificationStarted();
    return new Promise((resolve) => {
      releaseCheck = resolve;
    });
  };
  const originalClose = f.auto.siteBrowser.close;
  f.auto.siteBrowser.close = async () => {
    releaseCheck?.({ verified: false });
    await originalClose();
  };
  await f.auto.start(host);
  await started;
  await Promise.race([
    f.auto.close(),
    wait(500).then(() => {
      throw Error("shutdown stalled");
    }),
  ]);
  assert.equal(f.site.held, true);
  assert.ok(f.calls.some((call) => call[0] === "close"));
  await assert.rejects(f.auto.start(host), { status: 503 });
});

test("preflight rate failure publishes its full server cooldown and prevents early automatic login", async (t) => {
  const f = fixture(t),
    page = { url: () => "https://newtoki1.org/novel/21104/111" };
  let calls = 0;
  f.auto.login = async () => {
    calls++;
    throw Object.assign(new Error("private error"), {
      kind: "rate",
      httpStatus: 429,
      retryAfterMs: 900000,
    });
  };
  await assert.rejects(
    f.auto.loginPage(page),
    (error) => error.retryAfterMs === 900000,
  );
  const state = f.auto.status(host);
  assert.equal(state.state, "needs_attention");
  assert.equal(Date.parse(state.retryAt), 901000);
  f.advance(899999);
  await assert.rejects(f.auto.start(host), { status: 429 });
  assert.equal(calls, 1);
  f.advance(1);
  assert.equal((await f.auto.start(host)).state, "running");
});

test("wait follows the actual operation and reused membership checks the already opened body", async (t) => {
  const f = fixture(t);
  f.auto.login = async () => ({ authenticated: true, reused: true });
  const originalCheck = f.auto.siteBrowser.check;
  f.auto.siteBrowser.check = async (options) => {
    assert.deepEqual(options, { reload: false });
    return originalCheck();
  };
  await f.auto.start(host);
  const state = await f.auto.wait(host);
  assert.equal(state.state, "ready");
  assert.deepEqual(state.pendingSlots, []);
  assert.equal(state.failureKind, null);
  assert.equal(f.site.held, false);
});

test("a viewer with canonical credentials fails closed before authentication or releasing the held site", async (t) => {
  const f = fixture(t),
    originalOpen = f.auto.siteBrowser.open;
  f.auto.siteBrowser.open = async (input) => {
    await originalOpen(input);
    return { open: true, ...input, viewerHost: "sbxh9.com" };
  };
  f.auto.siteBrowser.authenticate = async () =>
    assert.fail("canonical credentials must not reach peer viewer");
  f.auto.login = async () =>
    assert.fail("peer viewer must not attempt canonical login");
  f.auto.siteBrowser.check = async () =>
    assert.fail("mismatched credentials cannot authorize body verification");
  await f.auto.start(host);
  assert.equal((await f.auto.wait(host)).state, "needs_attention");
  assert.equal(f.site.held, true);
  assert.deepEqual(f.site.verifiedSlots, []);
  assert.equal(
    f.calls.some((call) => call[0] === "authenticate"),
    false,
  );
});

test("a viewer authenticates only with its own account record and proves both pending slots before release", async (t) => {
  const f = fixture(t),
    accountHost = "sbxh9.com",
    requestedAccounts = [];
  f.auto.accountHostFor = () => accountHost;
  f.auto.accounts.status = async (name) => {
    requestedAccounts.push(name);
    assert.equal(name, accountHost);
    return { configured: true, enabled: true };
  };
  f.auto.accounts.getCredentials = async (name) => {
    assert.equal(name, accountHost);
    return {
      host: name,
      username: "source_user",
      password: sourceCredentialFixture,
      pin: "1234",
    };
  };
  const originalOpen = f.auto.siteBrowser.open;
  f.auto.siteBrowser.open = async (input) => {
    await originalOpen(input);
    return { ...input, viewerHost: accountHost };
  };
  f.auto.siteBrowser.authenticate = async (callback) => {
    const slot = f.calls.filter((call) => call[0] === "open").at(-1)[1];
    f.calls.push(["authenticate", slot]);
    await callback(
      { url: () => `https://${accountHost}/novel/21104/111` },
      { host, viewerHost: accountHost, slot },
    );
  };
  f.auto.login = async ({ page, credentials }) => {
    assert.equal(new URL(page.url()).hostname, credentials.host);
    assert.equal(credentials.host, accountHost);
    return { authenticated: true, reused: true };
  };
  await f.auto.start(host);
  const state = await f.auto.wait(host);
  assert.equal(state.accountHost, accountHost);
  assert.equal(state.host, host);
  assert.equal(state.state, "ready");
  assert.deepEqual(requestedAccounts, [accountHost]);
  assert.deepEqual(f.site.verifiedSlots, [1, 2]);
  assert.equal(f.site.held, false);
  assert.deepEqual(
    f.calls.filter((call) => call[0] === "authenticate"),
    [
      ["authenticate", 1],
      ["authenticate", 2],
    ],
  );
});

test("sanitized failureKind distinguishes proof failures from wrong credentials", async (t) => {
  const captcha = fixture(t, { failLogin: true });
  await captcha.auto.start(host);
  assert.equal((await captcha.auto.wait(host)).failureKind, "captcha");
  const credentials = fixture(t);
  credentials.auto.login = async () => {
    throw Object.assign(new Error("secret-test-only"), {
      kind: "login",
      attentionKind: "authentication",
    });
  };
  await credentials.auto.start(host);
  assert.equal(
    (await credentials.auto.wait(host)).failureKind,
    "authentication",
  );
  const proof = fixture(t);
  proof.auto.siteBrowser.check = async () => {
    throw Object.assign(Error("no body"), { kind: "verification" });
  };
  await proof.auto.start(host);
  assert.equal((await proof.auto.wait(host)).failureKind, "verification");
});

test("different hosts serialize the shared source browser until all pending slots finish", async (t) => {
  const sites = new Map(
    [host, "newtoki2.org"].map((name) => [
      name,
      { host: name, held: true, requiredSlots: [1], verifiedSlots: [] },
    ]),
  );
  let target = null;
  const opened = [];
  const auto = new SiteAutoAuth({
    accounts: {
      status: () => ({ enabled: true, configured: true }),
      getCredentials: (name) => ({
        host: name,
        username: "test",
        password: "test-only",
      }),
    },
    attention: { get: (name) => structuredClone(sites.get(name)) },
    scheduler: {},
    login: async () => {
      await wait(5);
      return { authenticated: true, reused: true };
    },
    siteBrowser: {
      async open(value) {
        assert.equal(target, null);
        target = value;
        opened.push(value.host);
      },
      async authenticate(callback) {
        await callback({}, target);
      },
      async check() {
        const site = sites.get(target.host);
        site.verifiedSlots = [1];
        site.held = false;
        target = null;
        return { verified: true };
      },
      status: async () => ({ open: !!target, ...target }),
      close: async () => {
        target = null;
      },
    },
  });
  t.after(() => auto.close());
  await Promise.all([...sites.keys()].map((name) => auto.start(name)));
  const states = await Promise.all(
    [...sites.keys()].map((name) => auto.wait(name)),
  );
  assert.deepEqual(
    states.map((state) => state.state),
    ["ready", "ready"],
  );
  assert.equal(opened.length, 2);
});
