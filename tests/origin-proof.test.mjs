import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderStore } from "../src/store.mjs";
import { SiteAttention } from "../src/site-attention.mjs";
import { SiteBrowser } from "../src/site-browser.mjs";
import { ViewerOrigins } from "../src/viewer-origins.mjs";
import { CaptchaSession } from "../src/captcha-session.mjs";

const host = "newtoki1.org",
  origin = "https://sbxh9.com";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "novel-origin-proof-"));
  const store = await new FolderStore(root).init();
  store.getJob = async () => ({ url: `https://${host}/novel/1/2` });
  const attention = new SiteAttention({ store });
  await attention.holdSite(host, {
    kind: "captcha",
    requiredSlots: [1, 2],
    jobIds: ["job1"],
  });
  const viewerOrigins = new ViewerOrigins({ store }),
    calls = [],
    blocked = new Set();
  const scheduler = {
    reserveManualSlot: async () => true,
    releaseManualSlot: async () => {},
    releaseSite: async () => {
      assert.equal(viewerOrigins.get(host), attention.get(host).proofOrigin);
      assert.equal(attention.isHeld(host), false);
      calls.push("release");
    },
  };
  const browser = new SiteBrowser({
    store,
    attention,
    scheduler,
    viewerOrigins,
    profileDir: root,
    launchContext: async ({ profileDir }) => {
      const slot = Number(profileDir.slice(-1));
      let url;
      return {
        route: async () => {},
        close: async () => {},
        newPage: async () => ({
          url: () => url,
          goto: async (value) => {
            url = value;
            return { status: () => 200 };
          },
          evaluate: async () => ({
            text: blocked.has(slot) ? "" : "Actual rendered chapter body",
            challenge: blocked.has(slot),
          }),
        }),
      };
    },
  });
  const service = new CaptchaSession({
    siteBrowser: browser,
    attention,
    scheduler,
  });
  t.after(async () => {
    await service.close();
    await browser.close();
    await rm(root, { recursive: true, force: true });
  });
  return { store, attention, viewerOrigins, calls, blocked, browser, service };
}

test("human origin becomes shared only after both real profiles prove that origin", async (t) => {
  const f = await fixture(t);
  await f.service.open({ host });
  const first = await f.service.apply();
  assert.equal(first.siteReleased, false);
  assert.equal(first.status.slot, 2);
  assert.equal(f.viewerOrigins.get(host), null);
  assert.equal(await f.store.json(f.viewerOrigins.path), null);
  assert.equal(f.attention.get(host).proofOrigin, origin);
  const restored = new SiteAttention({ store: f.store });
  await restored.load();
  assert.equal(restored.get(host).proofOrigin, origin);
  assert.deepEqual(restored.get(host).verifiedSlots, [1]);
  assert.equal((await f.service.apply()).siteReleased, true);
  assert.equal(f.viewerOrigins.get(host), origin);
  assert.deepEqual(f.calls, ["release"]);
});

test("a second profile with no body cannot publish the viewer origin or release the queue", async (t) => {
  const f = await fixture(t);
  f.blocked.add(2);
  await f.service.open({ host });
  await f.service.apply();
  await assert.rejects(f.service.apply(), { kind: "captcha" });
  assert.equal(f.viewerOrigins.get(host), null);
  assert.equal(f.attention.isHeld(host), true);
  assert.deepEqual(f.attention.get(host).verifiedSlots, [1]);
  assert.deepEqual(f.calls, []);
});

test("failed final viewer persistence leaves held proof state intact across restart", async (t) => {
  const f = await fixture(t);
  await f.service.open({ host });
  await f.service.apply();
  const atomic = f.store.atomic.bind(f.store);
  f.store.atomic = async (path, data) => {
    if (path === f.viewerOrigins.path) throw Error("disk unavailable");
    return atomic(path, data);
  };
  await assert.rejects(f.service.apply(), /disk unavailable/);
  assert.equal(f.viewerOrigins.get(host), null);
  assert.equal(f.attention.isHeld(host), true);
  assert.deepEqual(f.attention.get(host).verifiedSlots, [1]);
  const restored = new SiteAttention({ store: f.store });
  await restored.load();
  assert.equal(restored.isHeld(host), true);
  assert.deepEqual(restored.get(host).verifiedSlots, [1]);
  assert.deepEqual(f.calls, []);
});

test("different legacy viewer origins start a fresh proof cycle before committing mapping", async (t) => {
  const f = await fixture(t);
  await f.browser.open({ host, slot: 1, viewerOrigin: origin });
  await f.browser.check({ reload: false });
  await f.browser.open({ host, slot: 2, viewerOrigin: "https://toki32.com" });
  const second = await f.browser.check({ reload: false });
  assert.equal(second.siteReleased, false);
  assert.deepEqual(second.pendingSlots, [1]);
  assert.deepEqual(f.attention.get(host).verifiedSlots, [2]);
  assert.equal(f.viewerOrigins.get(host), null);
  await f.browser.open({ host, slot: 1, viewerOrigin: "https://toki32.com" });
  assert.equal((await f.browser.check({ reload: false })).siteReleased, true);
  assert.equal(f.viewerOrigins.get(host), "https://toki32.com");
});

test("unknown older partial proof resets when an explicit viewer proves its next profile", async (t) => {
  const f = await fixture(t);
  await f.attention.verifySlot(host, 1);
  await f.browser.open({ host, slot: 2, viewerOrigin: origin });
  assert.equal((await f.browser.check({ reload: false })).siteReleased, false);
  assert.deepEqual(f.attention.get(host).verifiedSlots, [2]);
  assert.equal(f.viewerOrigins.get(host), null);
});

test("completed legacy state survives load and a new hold starts a fresh proof cycle", async (t) => {
  const f = await fixture(t);
  await f.attention.verifySlot(host, 1);
  await f.attention.verifySlot(host, 2);
  const restored = new SiteAttention({ store: f.store });
  await restored.load();
  assert.equal(restored.isHeld(host), false);
  assert.deepEqual(restored.get(host).verifiedSlots, [1, 2]);
  await restored.holdSite(host, { requiredSlots: [1, 2] });
  assert.deepEqual(restored.get(host).verifiedSlots, []);
  await restored.verifySlot(host, 1, { viewerOrigin: origin });
  await restored.verifySlot(host, 2, { viewerOrigin: origin });
  await restored.holdSite(host, { requiredSlots: [1, 2] });
  assert.deepEqual(restored.get(host).verifiedSlots, []);
  assert.equal(restored.get(host).proofOrigin, undefined);
});

test("proof origins reject cross-site and malformed inputs before recording slots", async (t) => {
  const f = await fixture(t);
  for (const viewerOrigin of [
    "https://evil.example",
    "http://sbxh9.com",
    "https://sbxh9.com:444",
    "https://user@sbxh9.com",
    "https://newtoki2.org",
  ]) {
    await assert.rejects(f.attention.verifySlot(host, 1, { viewerOrigin }), {
      status: 400,
    });
  }
  assert.deepEqual(f.attention.get(host).verifiedSlots, []);
});
