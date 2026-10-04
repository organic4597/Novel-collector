import test from "node:test";
import assert from "node:assert/strict";
import { SiteBrowser } from "../src/site-browser.mjs";
import { CollectionContexts } from "../src/collection-contexts.mjs";

const host = "newtoki1.org", origin = "https://sbxh9.com";
const probe = `${origin}/novel/21104/111`;
function fixture(t, { launch, pool } = {}) {
  const events = [], calls = [];
  const context = { route: async () => {}, close: async () => calls.push("context-close") };
  const page = { url: () => probe, context: () => context, isClosed: () => false,
    goto: async () => ({ status: () => 200 }) };
  context.newPage = async () => page;
  const site = { host, held: true, jobIds: ["synthetic-job"], requiredSlots: [1], verifiedSlots: [] };
  const browser = new SiteBrowser({
    profileDir: "/tmp/opencode/synthetic-browser-profile", contextPool: pool,
    store: { getJob: async () => ({ url: `https://${host}/novel/21104`, currentChapterUrl: `https://${host}/novel/21104/111` }) },
    scheduler: { reserveManualSlot: async () => { calls.push("reserve"); return true; },
      releaseManualSlot: async () => calls.push("release") },
    attention: { snapshot: () => ({ sites: [site] }) },
    activity: { add: event => events.push(event) },
    launchContext: launch || (async () => context),
  });
  t.after(() => browser.close());
  return { browser, calls, events, context, page };
}

test("manual browser launch errors expose a safe cause and release the reserved slot", async t => {
  const f = fixture(t, { launch: async () => { throw Error("Executable doesn't exist at C:\\Users\\private\\chrome.exe token=SECRET"); } });
  await assert.rejects(f.browser.open({ host, slot: 1, viewerOrigin: origin }), error => {
    assert.equal(error.status, 503);
    assert.equal(error.code, "BROWSER_NOT_INSTALLED");
    assert.equal(error.stage, "OPEN_CONTEXT");
    assert.match(error.message, /설치/);
    assert.doesNotMatch(error.message, /private|SECRET|chrome\.exe/);
    return true;
  });
  assert.deepEqual(f.calls, ["reserve", "release"]);
  assert.equal((await f.browser.status()).open, false);
  assert.equal(f.events[0].details.errorCode, "BROWSER_NOT_INSTALLED");
  assert.equal(f.events[0].details.stage, "OPEN_CONTEXT");
  assert.doesNotMatch(JSON.stringify(f.events), /private|SECRET/);
});

test("the context pool preserves the original launch cause for safe diagnostics", async t => {
  const pool = new CollectionContexts();
  t.after(() => pool.close());
  const f = fixture(t, { pool, launch: async () => { throw Object.assign(Error("Permission denied PRIVATE_PATH"), { code: "EACCES" }); } });
  await assert.rejects(f.browser.open({ host, slot: 1, viewerOrigin: origin }), { code: "BROWSER_PERMISSION_DENIED", stage: "OPEN_CONTEXT" });
  assert.equal(pool.entries.size, 0);
  assert.deepEqual(f.calls, ["reserve", "release"]);
});

test("a closed borrowed browser is discarded once and reopened without changing the profile or slot", async t => {
  let leases = 0, discarded = 0;
  const f = fixture(t);
  const deadContext = { route: async () => { throw Error("Target page, context or browser has been closed"); } };
  f.browser.contextPool = {
    async acquire({ slot, origin: requested, open }) {
      assert.equal(slot, 1); assert.equal(requested, origin); leases++;
      const opened = leases === 1 ? { context: deadContext, page: f.page } : await open();
      return { ...opened, release: async options => { if (options.discard) discarded++; } };
    },
  };
  assert.equal((await f.browser.open({ host, slot: 1, viewerOrigin: origin })).open, true);
  assert.equal(leases, 2);
  assert.equal(discarded, 1);
  assert.deepEqual(f.calls, ["reserve"]);
});

test("network navigation failures are reported distinctly and are not retried", async t => {
  const f = fixture(t);
  let navigations = 0;
  f.page.goto = async () => { navigations++; throw Error("page.goto: net::ERR_NAME_NOT_RESOLVED at https://private.invalid/?token=SECRET"); };
  await assert.rejects(f.browser.open({ host, slot: 1, viewerOrigin: origin }), { code: "BROWSER_DNS_FAILED", stage: "NAVIGATE" });
  assert.equal(navigations, 1);
  assert.deepEqual(f.calls, ["reserve", "context-close", "release"]);
  assert.doesNotMatch(JSON.stringify(f.events), /private|SECRET/);
});

test("a persistent browser failure is retried at most once and returns the slot", async t => {
  let launches = 0;
  const f = fixture(t, { launch: async () => { launches++; throw Error("Target page, context or browser has been closed"); } });
  await assert.rejects(f.browser.open({ host, slot: 1, viewerOrigin: origin }), { code: "BROWSER_CLOSED" });
  assert.equal(launches, 2);
  assert.deepEqual(f.calls, ["reserve", "release"]);
});

test("closed-browser diagnostics do not confuse launch arguments with a sandbox failure", async t => {
  const f = fixture(t, { launch: async () => {
    throw Error("Target page, context or browser has been closed\n<launching> chrome --no-sandbox --user-data-dir=PRIVATE");
  } });
  await assert.rejects(f.browser.open({ host, slot: 1, viewerOrigin: origin }), { code: "BROWSER_CLOSED" });
  assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE/);
});

test("a user-closed browser expires the manual session and releases its slot", async t => {
  const f = fixture(t);
  let expired = 0;
  await f.browser.open({ host, slot: 1, viewerOrigin: origin, onExpired: () => { expired++; } });
  f.page.isClosed = () => true;
  assert.equal((await f.browser.status()).open, false);
  assert.equal(expired, 1);
  assert.deepEqual(f.calls, ["reserve", "context-close", "release"]);
  await assert.rejects(f.browser.frame(), { status: 409 });
  assert.equal(expired, 1);
});
