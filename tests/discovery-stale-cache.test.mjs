import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Discovery, normalizeDiscoveryQuery } from "../src/discovery.mjs";
const ttl = 30 * 60 * 1000;

async function fixture(t) {
  const rootDir = await mkdtemp(join(tmpdir(), "discovery-stale-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  let now = 10 * ttl;
  const discovery = new Discovery({ rootDir, now: () => now });
  await mkdir(join(rootDir, "pages"));
  const query = normalizeDiscoveryQuery({});
  const key = createHash("sha256").update(`normal-v1:https://sbxh9.com:${JSON.stringify(query)}`).digest("hex");
  const data = { items: [{ id: "1", url: "https://newtoki1.org/novel/1", title: "저장된 작품", episodeCount: 10 }], page: 1, maxPage: 1, total: 1, normalCatalog: true, savedAt: now - ttl - 1, cachedAt: new Date(now - ttl - 1).toISOString() };
  await writeFile(join(rootDir, "pages", `${key}.json`), JSON.stringify(data));
  return { discovery, setNow: value => { now = value; }, now: () => now, data };
}

test("expired cached catalog returns immediately and deduplicates one sequential background refresh", async t => {
  const f = await fixture(t);
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  f.discovery.pageCache.fetchPage = async () => { calls++; await gate; return { ...f.data, items: [{ ...f.data.items[0], title: "새 작품", episodeCount: 20 }] }; };
  const one = await f.discovery.list({});
  assert.equal(one.items[0].title, "저장된 작품");
  assert.equal(one.stale, true);
  assert.equal(one.revalidating, true);
  const two = await f.discovery.list({});
  assert.equal(two.items[0].title, "저장된 작품");
  assert.equal(calls, 1);
  release();
  await f.discovery.pageCache.wait();
  const fresh = await f.discovery.list({});
  assert.equal(fresh.stale, false);
  assert.equal(fresh.items[0].title, "새 작품");
  assert.equal(fresh.items[0].episodeCount, 20);
  assert.equal(calls, 1);
});

test("source backoff and CAPTCHA holds retain the expired snapshot without new source work", async t => {
  for (const held of ["backoff", "captcha"]) {
    const f = await fixture(t);
    let calls = 0;
    f.discovery.pageCache.fetchPage = async () => { calls++; throw Error("unexpected request"); };
    if (held === "backoff") f.discovery.sourceGate.backoff = { snapshot: () => ({ active: true }) };
    else f.discovery.sourceGate.attention = { isHeld: () => true };
    const cached = await f.discovery.list({});
    assert.equal(cached.items.length, 1);
    assert.equal(cached.stale, true);
    assert.equal(cached.revalidating, false);
    assert.ok(cached.refreshError);
    assert.equal(calls, 0);
  }
});

test("failed refresh preserves cached rows and has a bounded retry interval", async t => {
  const f = await fixture(t);
  let calls = 0;
  f.discovery.pageCache.fetchPage = async () => { calls++; throw Object.assign(Error("blocked"), { code: "NEEDS_ATTENTION", attentionKind: "captcha" }); };
  await f.discovery.list({});
  await f.discovery.pageCache.wait();
  const failed = await f.discovery.list({});
  assert.equal(failed.items[0].title, "저장된 작품");
  assert.equal(failed.revalidating, false);
  assert.ok(failed.refreshError);
  assert.equal(calls, 1);
  f.setNow(f.now() + 60001);
  await f.discovery.list({});
  await f.discovery.pageCache.wait();
  assert.equal(calls, 2);
});

test("refresh failure retention is capped and expired failures are pruned", async t=>{
  const f=await fixture(t);
  for(let key=0;key<600;key++)f.discovery.pageCache.rememberFailure(String(key),Error("failed"));
  assert.equal(f.discovery.pageCache.failures.size,500);
  f.setNow(f.now()+60001);f.discovery.pageCache.pruneFailures();
  assert.equal(f.discovery.pageCache.failures.size,0);
});
