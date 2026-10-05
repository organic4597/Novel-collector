import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readReaderDocument } from "./collector.mjs";
import { readDiscoveryDocument } from "./discovery-document.mjs";
import { mergeSourceMetadata } from "./source-metadata.mjs";
import { openNormalDiscovery } from "./normal-discovery.mjs";

async function json(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function atomic(path, data) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
  await rename(temporary, path);
}
const errorStatus = error => ({
  refreshError: ["REQUEST_BACKOFF", "SITE_VERIFICATION_REQUIRED"].includes(error.code)
    ? error.message : "목록을 갱신하지 못했습니다. 저장된 목록을 표시합니다.",
  refreshErrorCode: error.code || "REFRESH_FAILED",
});
export function catalogFreshness(pages) {
  const error = pages.find(page => page.refreshError);
  return { stale: pages.some(page => page.stale), revalidating: pages.some(page => page.revalidating),
    ...(error ? { refreshError: error.refreshError, refreshErrorCode: error.refreshErrorCode } : {}) };
}

export class DiscoveryPageCache {
  constructor(owner, normalizeQuery, ttl) {
    this.owner = owner;
    this.normalizeQuery = normalizeQuery;
    this.ttl = ttl;
    this.refreshes = new Map();
    this.failures = new Map();
  }
  fresh(data) { return !!data && this.owner.now() - data.savedAt < this.ttl; }
  pruneFailures() {
    for (const [key, failure] of this.failures) if (failure.retryAt <= this.owner.now()) this.failures.delete(key);
    while (this.failures.size > 500) this.failures.delete(this.failures.keys().next().value);
  }
  rememberFailure(key, error) {
    this.pruneFailures(); this.failures.delete(key);
    this.failures.set(key, { error, retryAt: this.owner.now() + 60000 });
    this.pruneFailures();
  }
  backgroundAvailable() {
    const host = "newtoki1.org";
    this.owner.sourceGate.assertAvailable(host);
    if (this.owner.sourceGate.attention?.isHeld(host))
      throw Object.assign(new Error("사이트 접근 확인 후 목록을 갱신할 수 있습니다."), { code: "SITE_VERIFICATION_REQUIRED" });
  }
  async list(input, options) {
    this.owner.checkOpen();
    this.pruneFailures();
    const query = this.normalizeQuery(input);
    const remote = { ...query, minEpisodes: null, maxEpisodes: null };
    const origin = new URL(this.owner.transportUrl("https://newtoki1.org/novel")).origin;
    const key = createHash("sha256").update(`normal-v1:${origin}:${JSON.stringify(remote)}`).digest("hex");
    await this.owner.init();
    const path = join(this.owner.rootDir, "pages", `${key}.json`);
    let data = await json(path), cacheHit = !!data;
    if (!data) data = await this.refresh(key, path, query, options, false);
    else if (!this.fresh(data)) this.refresh(key, path, query, options, true);
    const stale = !this.fresh(data);
    const failure = this.failures.get(key);
    return this.publicPage(data, query, { cacheHit, stale,
      revalidating: stale && this.refreshes.has(key),
      ...(stale && failure ? errorStatus(failure.error) : {}) });
  }
  refresh(key, path, query, options, background) {
    if (this.refreshes.has(key)) return this.refreshes.get(key);
    const failure = this.failures.get(key);
    if (background && failure && failure.retryAt > this.owner.now()) return;
    try {
      if (background) this.backgroundAvailable();
      else this.owner.sourceGate.assertAvailable("newtoki1.org");
      if (background && this.refreshes.size >= 8)
        throw Object.assign(new Error("다른 목록을 갱신하고 있습니다."), { code: "BACKGROUND_QUEUE_FULL" });
    } catch (error) {
      if (!background) return Promise.reject(error);
      this.rememberFailure(key, error);
      return;
    }
    const task = this.owner.exclusive(async () => {
      if (background) this.backgroundAvailable();
      const current = await json(path);
      if (this.fresh(current)) return current;
      const parsed = await this.fetchPage(query, options);
      if (!parsed.items.length && parsed.maxPage > 1)
        throw Object.assign(new Error("작품 목록을 찾지 못했습니다."), { code: "NEEDS_ATTENTION" });
      if (!Number.isSafeInteger(parsed.maxPage) || parsed.maxPage < 1 || parsed.maxPage > 1000)
        throw new Error("목록 페이지 수가 잘못됐습니다.");
      const data = { ...parsed, savedAt: this.owner.now(), cachedAt: new Date(this.owner.now()).toISOString() };
      for (const item of data.items) {
        if (!/^\d{1,15}$/.test(String(item.id))) throw new Error("작품 번호가 잘못됐습니다.");
        await this.owner.updateWork(item.id, previous => ({ ...previous, ...item,
          ...mergeSourceMetadata(previous, item),
          episodeCount: Number.isFinite(item.episodeCount) ? item.episodeCount : previous?.episodeCount ?? null,
          detailCachedAt: previous?.detailCachedAt || null, cachedAt: data.cachedAt }));
      }
      await atomic(path, data);
      this.failures.delete(key);
      return data;
    });
    this.refreshes.set(key, task);
    task.catch(error => { this.rememberFailure(key, error); })
      .finally(() => { if (this.refreshes.get(key) === task) this.refreshes.delete(key); });
    return task;
  }
  async fetchPage(query, options) {
    const page = await (await this.owner.openContext()).newPage();
    try { return await openNormalDiscovery(this.owner, page, query, readDiscoveryDocument, readReaderDocument, options); }
    finally { await page.close(); }
  }
  async publicPage(data, query, freshness) {
    let items = await Promise.all(data.items.map(async item => {
      if (!/^\d{1,15}$/.test(String(item.id))) throw new Error("작품 번호가 잘못됐습니다.");
      const work = await json(join(this.owner.rootDir, "works", `${item.id}.json`));
      const { thumbnailUrl, ...publicItem } = { ...item, ...work };
      return { ...publicItem, thumbnail: thumbnailUrl ? `/api/discover/${item.id}/thumbnail` : null, cachedAt: data.cachedAt };
    }));
    const unknownEpisodeCount = items.filter(item => item.episodeCount == null).length;
    const filtered = query.minEpisodes !== null || query.maxEpisodes !== null;
    if (filtered) items = items.filter(item => item.episodeCount != null &&
      (query.minEpisodes === null || item.episodeCount >= query.minEpisodes) &&
      (query.maxEpisodes === null || item.episodeCount <= query.maxEpisodes));
    return { items, normalCatalog: !!data.normalCatalog, page: data.page, maxPage: data.maxPage,
      total: data.total ?? null, cachedAt: data.cachedAt, ...freshness, unknownEpisodeCount,
      filters: { ...data.filters, ...query, episodeScope: filtered ? "known-only" : "all" } };
  }
  async wait() { await Promise.allSettled([...this.refreshes.values()]); }
}
