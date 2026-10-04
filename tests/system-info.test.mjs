import test from "node:test";
import assert from "node:assert/strict";
import { SystemInfo } from "../src/system-info.mjs";

test("system stats use only metadata, cache for thirty seconds and never reveal private paths or secrets", async () => {
  let now = 10000,
    scans = 0,
    uptime = 12;
  const store = {
    rootDir: "/private/collector/location",
    async listBooks() {
      scans++;
      return [{ id: "book1" }, { id: "book2" }];
    },
    async listChapterMetadata(id) {
      return id === "book1"
        ? [
            { id: "1", size: 10 },
            { id: "2", size: 20 },
          ]
        : [{ id: "3", size: 30 }];
    },
    async readChapter() {
      throw Error("body must not be read");
    },
    async listChapters() {
      throw Error("legacy body reader must not be used");
    },
  };
  const system = new SystemInfo({
    store,
    clock: () => now,
    uptime: () => uptime,
    settings: {
      get: () => ({
        maxConcurrency: 1,
        refreshIntervalMs: 5000,
        secret: "never-show",
      }),
    },
    statfsFn: async (path) => {
      assert.equal(path, store.rootDir);
      return { bavail: 100n, bsize: 4096n };
    },
  });
  const first = await system.get();
  assert.equal(first.bookCount, 2);
  assert.equal(first.chapterCount, 3);
  assert.equal(first.bodyBytes, 60);
  assert.equal(first.diskFreeBytes, 409600);
  assert.equal(first.uptimeSeconds, 12);
  assert.deepEqual(first.backoff, { threshold: null, cooldownMs: 600000, mode:"server-limit" });
  assert.equal(first.maxConcurrency, 2);
  assert.equal(first.cached, false);
  assert.equal(first.settings.maxConcurrency, 1);
  assert.doesNotMatch(JSON.stringify(first), /private|never-show|secret/);
  first.bookCount = 99;
  uptime = 20;
  const cached = await system.get();
  assert.equal(cached.bookCount, 2);
  assert.equal(cached.uptimeSeconds, 20);
  assert.equal(cached.cached, true);
  assert.equal(scans, 1);
  now += 30000;
  assert.equal((await system.get()).cached, false);
  assert.equal(scans, 2);
});

test("simultaneous system queries share their scan and disk errors expose only null availability", async () => {
  let scans = 0;
  const system = new SystemInfo({
    store: {
      rootDir: "/hidden",
      async listBooks() {
        scans++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return [];
      },
      async listChapterMetadata() {
        throw Error("no books");
      },
    },
    statfsFn: async () => {
      throw Error("private access path details");
    },
  });
  const results = await Promise.all([system.get(), system.get(), system.get()]);
  assert.equal(scans, 1);
  assert.ok(
    results.every(
      (result) => result.diskFreeBytes === null && result.bodyBytes === 0,
    ),
  );
  assert.doesNotMatch(JSON.stringify(results), /hidden|private access/);
});
