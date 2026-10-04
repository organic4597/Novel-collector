import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Discovery, normalizeDiscoveryQuery } from "../src/discovery.mjs";

function fixture({ total = 119, size = 48, knownTotal = true } = {}) {
  const works = Array.from({ length: total }, (_, index) => ({
    id: String(index + 1), title: `Synthetic work ${index + 1}`,
    episodeCount: index % 2 ? 20 : null,
  }));
  const calls = [];
  const discovery = new Discovery({ rootDir: "/tmp/opencode/discovery-pagination-synthetic" });
  discovery.sourceList = async query => {
    calls.push(query);
    const page = query.page;
    return { items: works.slice((page - 1) * size, page * size), page,
      maxPage: Math.max(1, Math.ceil(total / size)), total: knownTotal ? total : null,
      normalCatalog: true, cacheHit: page !== 2,
      cachedAt: "2026-10-04T00:00:00.000Z", filters: { genres: ["Synthetic"] } };
  };
  return { discovery, calls, works };
}

test("discovery returns forty ordered works and carries overflow across source pages", async () => {
  const f = fixture();
  const pages = [];
  for (let page = 1; page <= 3; page++) pages.push(await f.discovery.list({ page }));
  assert.deepEqual(pages.map(page => page.items.length), [40, 40, 39]);
  assert.deepEqual(pages.flatMap(page => page.items.map(item => item.id)), f.works.map(item => item.id));
  assert.deepEqual(pages.map(page => page.maxPage), [3, 3, 3]);
  assert.deepEqual(pages.map(page => page.page), [1, 2, 3]);
  assert.deepEqual(f.calls.map(query => query.page), [1, 1, 2, 1, 2, 3]);
  assert.equal(pages[0].cacheHit, true);
  assert.equal(pages[1].cacheHit, false);
  assert.equal(pages[2].pageSize, 40);
});

test("a direct page jump fetches only the source pages needed for that range", async () => {
  const f = fixture({ total: 200, size: 96 });
  const result = await f.discovery.list({ page: 4, query: "name", genre: "Synthetic" });
  assert.deepEqual(result.items.map(item => item.id), f.works.slice(120, 160).map(item => item.id));
  assert.deepEqual(f.calls.map(query => query.page), [1, 2]);
  assert.ok(f.calls.every(query => query.query === "name" && query.genre === "Synthetic"));
  assert.equal(result.maxPage, 5);
});

test("small physical pages fill one forty-item dashboard page", async () => {
  const f = fixture({ total: 65, size: 20 });
  const first = await f.discovery.list({});
  const last = await f.discovery.list({ page: 2 });
  assert.equal(first.items.length, 40);
  assert.equal(last.items.length, 25);
  assert.equal(last.maxPage, 2);
  assert.deepEqual([...first.items, ...last.items].map(item => item.id), f.works.map(item => item.id));
});

test("empty and exact-boundary results do not invent pages or fetch beyond the end", async () => {
  const empty = fixture({ total: 0 });
  assert.deepEqual((await empty.discovery.list({})).items, []);
  assert.equal(empty.calls.length, 1);
  const exact = fixture({ total: 80 });
  assert.equal((await exact.discovery.list({ page: 2 })).items.length, 40);
  await assert.rejects(exact.discovery.list({ page: 3 }), { status: 400 });
});

test("unknown totals use the last source page to calculate the exact final range", async () => {
  const f = fixture({ knownTotal: false });
  const result = await f.discovery.list({ page: 3 });
  assert.equal(result.items.length, 39);
  assert.equal(result.maxPage, 3);
  assert.equal(result.total, 119);
  assert.deepEqual(f.calls.map(query => query.page), [1, 3, 2]);
});

test("episode filters are applied after pagination without hiding overflow works", async () => {
  const f = fixture();
  const result = await f.discovery.list({ page: 2, minEpisodes: 10 });
  assert.equal(result.items.length, 20);
  assert.equal(result.unknownEpisodeCount, 20);
  assert.deepEqual(result.items.map(item => item.id), f.works.slice(40, 80).filter(item => item.episodeCount !== null).map(item => item.id));
  assert.ok(f.calls.every(query => query.minEpisodes === undefined && query.maxEpisodes === undefined));
  assert.equal(result.filters.episodeScope, "known-only");
});

test("a source rate-limit stops aggregation without requesting another page", async () => {
  const f = fixture();
  const read = f.discovery.sourceList;
  f.discovery.sourceList = async query => {
    if (query.page === 2) throw Object.assign(new Error("Source rate limit"), { status: 429 });
    return read(query);
  };
  await assert.rejects(f.discovery.list({ page: 2 }), { status: 429 });
  assert.deepEqual(f.calls.map(query => query.page), [1]);
});

test("cached physical pages are repaginated after restart without browser requests", async t => {
  const rootDir = await mkdtemp(join(tmpdir(), "discovery-pages-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await mkdir(join(rootDir, "pages"));
  const f = fixture();
  for (let page = 1; page <= 3; page++) {
    const query = normalizeDiscoveryQuery({ page });
    const key = createHash("sha256").update(`normal-v1:https://sbxh9.com:${JSON.stringify(query)}`).digest("hex");
    const data = await f.discovery.sourceList(query);
    await writeFile(join(rootDir, "pages", `${key}.json`), JSON.stringify({ ...data, savedAt: Date.now() }));
  }
  const discovery = new Discovery({ rootDir, launchContext: () => { throw Error("Unexpected browser request"); } });
  const result = await discovery.list({ page: 2 });
  assert.equal(result.items.length, 40);
  assert.deepEqual(result.items.map(item => item.id), f.works.slice(40, 80).map(item => item.id));
  assert.equal(result.cacheHit, true);
  assert.equal(Object.hasOwn(result, "normalCatalog"), false);
});

test("changed page sizes fail explicitly instead of silently skipping works", async () => {
  const f = fixture();
  const read = f.discovery.sourceList;
  f.discovery.sourceList = async query => {
    const data = await read(query);
    return query.page === 2 ? { ...data, items: data.items.slice(1) } : data;
  };
  await assert.rejects(f.discovery.list({ page: 2 }), { status: 409 });
});

test("logical pages above the physical-page limit remain accessible", async () => {
  const f = fixture({ total: 95000, size: 96 });
  const result = await f.discovery.list({ page: 2375 });
  assert.equal(result.items.length, 40);
  assert.equal(result.items[0].id, "94961");
  assert.equal(result.items.at(-1).id, "95000");
  assert.ok(f.calls.every(query => query.page <= 1000));
});
