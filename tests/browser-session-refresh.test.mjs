import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CollectionContexts, SESSION_REFRESH_MS } from "../src/collection-contexts.mjs";
import { Discovery } from "../src/discovery.mjs";
import { runCollection } from "../src/collector-runner.mjs";

function native() {
  const context = new EventEmitter(), page = new EventEmitter();
  let closes = 0;
  page.closed = false;
  page.context = () => context;
  page.isClosed = () => page.closed;
  page.url = () => "https://sbxh9.com/novel";
  context.pages = () => page.closed ? [] : [page];
  context.newPage = async () => page;
  context.close = async () => { closes++; page.closed = true; context.emit("close"); };
  return { context, page, closes: () => closes };
}

test("the twelve-hour timer marks busy leases and refreshes idle discovery without interrupting the owner", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const pool = new CollectionContexts(), browser = native();
  t.after(() => pool.close());
  const lease = await pool.acquire({ slot: 1, origin: "https://sbxh9.com", open: async () => browser });
  let discoveryRefreshes = 0;
  pool.startRefresh({ afterRefresh: async () => { discoveryRefreshes++; } });
  t.mock.timers.tick(SESSION_REFRESH_MS - 1);
  assert.equal(discoveryRefreshes, 0); assert.equal(lease.refreshDue, false);
  t.mock.timers.tick(1); await pool.refreshWork;
  assert.equal(discoveryRefreshes, 1);
  assert.equal(browser.closes(), 0);
  assert.equal(lease.refreshDue, true);
  assert.deepEqual(pool.refreshStatus().pendingSlots, [1]);
  await lease.release();
  assert.equal(browser.closes(), 1);
  assert.equal(pool.entries.size, 0);
});

test("expired connections are replaced on the next acquire with the same slot and origin", async t => {
  let now = 0;
  const pool = new CollectionContexts({ clock: () => now }), old = native(), fresh = native();
  t.after(() => pool.close());
  const first = await pool.acquire({ slot: 1, origin: "https://sbxh9.com", open: async () => old });
  await first.release(); now = SESSION_REFRESH_MS;
  const second = await pool.acquire({ slot: 1, origin: "https://sbxh9.com", open: async () => fresh });
  assert.equal(old.closes(), 1); assert.equal(second.context, fresh.context); assert.equal(second.refreshDue, false);
  await first.release({ discard: true });
  assert.equal(fresh.closes(), 0, "a stale lease cannot close the new connection");
});

test("discovery connection rotation waits for both list and detail users and retains cached data", async () => {
  const discovery = new Discovery({ rootDir: "/tmp/opencode/synthetic-session-refresh" });
  let releaseList, releaseDetail, closes = 0;
  discovery.context = { close: async () => { closes++; } };
  discovery.serial = new Promise(resolve => { releaseList = resolve; });
  discovery.detailSerial = new Promise(resolve => { releaseDetail = resolve; });
  discovery.dnsCache.set("synthetic.example", {});
  const work = discovery.refreshConnection();
  assert.equal(closes, 0);
  releaseList(); await Promise.resolve(); await Promise.resolve();
  assert.equal(closes, 0);
  releaseDetail(); await work;
  assert.equal(closes, 1); assert.equal(discovery.context, null); assert.equal(discovery.dnsCache.size, 0);
});

test("shutdown cancels the periodic reconnect timer", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const pool = new CollectionContexts();
  let refreshes = 0;
  pool.startRefresh({ afterRefresh: async () => { refreshes++; } });
  await pool.close();
  t.mock.timers.tick(SESSION_REFRESH_MS * 2);
  assert.equal(refreshes, 0); assert.equal(pool.refreshStatus().nextRefreshAt, null);
});

test("long-running work renews between saved chapters without rescanning the catalog", async t => {
  let now = 0, opens = 0, plans = 0;
  const pool = new CollectionContexts({ clock: () => now }), first = native(), second = native(), writes = [];
  t.after(() => pool.close());
  const chapters = [1, 2].map(number => ({ id: String(number), number, title: `합성 회차 ${number}`, url: `https://newtoki1.org/novel/1/${number}` }));
  const collector = { contextPool: pool, slotId: 1, clock: () => now, delayMs: 0,
    viewerOrigins: { resolve: () => "https://sbxh9.com/novel/1" },
    openContext: async () => (++opens === 1 ? first.context : second.context),
    installNetworkGuard: async () => {},
    collectionPlan: async () => { plans++; return { title: "합성 작품", chapters, allChapters: chapters }; },
    chapterText: async (page, chapter) => {
      assert.equal(page.isClosed(), false);
      if (chapter.id === "2") { assert.equal(first.closes(), 1); assert.equal(page, second.page); }
      return "합성 본문";
    },
    store: { readChapter: async () => null, upsertBook: async () => {}, writeCatalog: async () => {}, clearFailure: async () => {},
      writeChapter: async (_book, id) => { writes.push(id); if (id === "1") { assert.equal(first.closes(), 0); now = SESSION_REFRESH_MS; } } },
    exportBook: async () => ({}),
    async close() { await this.contextLease?.release(); },
  };
  const result = await runCollection.call(collector, { id: "synthetic-job", url: "https://newtoki1.org/novel/1" },
    { report: async () => {}, event: async () => {} }, new AbortController().signal, "synthetic-book");
  assert.equal(result.status, "completed"); assert.deepEqual(writes, ["1", "2"]);
  assert.equal(opens, 2); assert.equal(plans, 1);
});
