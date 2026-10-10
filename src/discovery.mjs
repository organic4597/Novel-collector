import {
  normalizeDiscoveryUrl,
  readDiscoveryDocument,
} from "./discovery-document.mjs";
export {
  normalizeDiscoveryUrl,
  readDiscoveryDocument,
} from "./discovery-document.mjs";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readCatalogDocument, readReaderDocument } from "./collector.mjs";
import {
  fetchThumbnail,
  validateImage,
  validateThumbnailUrl,
} from "./thumbnail-cache.mjs";

import {
  normalizeWorkSource,
  mergeSourceMetadata,
} from "./source-metadata.mjs";

import { SourceRequestGate } from "./source-request-gate.mjs";
import { readWorkMetadata } from "./collection-metadata.mjs";
import { DiscoveryPageCache, catalogFreshness } from "./discovery-page-cache.mjs";
import { isWebtoonUrl, validDiscoveryId, isImageType } from "./webtoon-source.mjs";
import { webtoonMetadata, webtoonPreset } from "./webtoon-runtime.mjs";
import {discoveryRankings} from './discovery-rankings.mjs';

const PAGE_TTL = 30 * 60 * 1000,
  NEGATIVE_TTL = 6 * 60 * 60 * 1000;
export const DISCOVERY_PAGE_SIZE = 40;
const SORT = new Set([
  "updated",
  "new",
  "episodes",
  "views",
  "rating",
  "bookmarks",
]);
const badInput = (message) =>
  Object.assign(new Error(message), { status: 400 });
function publicWork(work) {
  const { thumbnailUrl, ...item } = work;
  return {
    ...item,
    thumbnail: thumbnailUrl ? `/api/discover/${work.id}/thumbnail` : null,
  };
}
const validId = (value) => {
  if (!validDiscoveryId(value))
    throw badInput("작품 번호가 잘못됐습니다.");
  return String(value);
};
const attention = (message) =>
  Object.assign(new Error(message), { code: "NEEDS_ATTENTION" });
export function normalizeDiscoveryQuery(input = {}, pageLimit = 1000) {
  if(input.contentType!==undefined&&!["novel","webtoon","manhwa"].includes(input.contentType))throw badInput("콘텐츠 유형을 확인하세요.");
  const integer = (value, fallback, max) => {
    const n = value === undefined || value === "" ? fallback : Number(value);
    if (!Number.isSafeInteger(n) || n < 1 || n > max)
      throw badInput("필터 숫자가 잘못됐습니다.");
    return n;
  };
  const text = (value, max) => {
    if (value === undefined) return "";
    if (
      typeof value !== "string" ||
      value.length > max ||
      /[\x00-\x1f]/.test(value)
    )
      throw badInput("필터 값이 잘못됐습니다.");
    return value.trim();
  };
  const query = text(input.query ?? input.search, 100),
    genre = text(input.genre, 40),
    platform = text(input.platform, 40),
    author = text(input.author, 100);
  const publication = input.publication || (input.contentType==="webtoon"?"ongoing":"all"),
    sort = input.sort || "updated";
  if (!["all", "ongoing", "completed"].includes(publication) || !SORT.has(sort))
    throw badInput("필터 선택이 잘못됐습니다.");
  const minEpisodes =
    input.minEpisodes === undefined || input.minEpisodes === ""
      ? null
      : integer(input.minEpisodes, null, 1000000);
  const maxEpisodes =
    input.maxEpisodes === undefined || input.maxEpisodes === ""
      ? null
      : integer(input.maxEpisodes, null, 1000000);
  if (minEpisodes !== null && maxEpisodes !== null && minEpisodes > maxEpisodes)
    throw badInput("회차 범위가 잘못됐습니다.");
  return {
    ...(isImageType(input.contentType)?{contentType:input.contentType}:{}),
    page: integer(input.page, 1, pageLimit),
    query,
    genre,
    platform,
    author,
    publication,
    sort,
    minEpisodes,
    maxEpisodes,
  };
}
async function json(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function atomic(path, data) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, data, { mode: 0o600 });
  await rename(tmp, path);
}

export class Discovery {
  constructor({
    rootDir,
    browserPath,
    profileDir,
    launchContext,
    fetchImage = fetchThumbnail,
    now = () => Date.now(),
    delayMs = 1000,
    backoff = null,
    onRequestFailure = null,
    attention = null,
    viewerOrigins = null,
    publicMetadata = true,
    presets = null,
  }) {
    this.rootDir = rootDir;
    this.browserPath = browserPath;
    this.profileDir = profileDir;
    this.launchContext = launchContext;
    this.fetchImage = fetchImage;
    this.now = now;
    this.delayMs = delayMs;
    this.context = null;
    this.serial = Promise.resolve();
    this.detailSerial = Promise.resolve();
    this.pending = new Map();
    this.listObservers = new Map();
    this.imageSerial = Promise.resolve();
    this.detailStates = new Map();
    this.overviewStates = new Map();
    this.contextPromise = null;
    this.dnsCache = new Map();
    this.workLocks = new Map();
    this.closing = false;
    this.onRequestFailure = onRequestFailure;
    this.viewerOrigins = viewerOrigins;
    this.publicMetadata = publicMetadata;
    this.presets = presets;
    this.pageCache = new DiscoveryPageCache(this, normalizeDiscoveryQuery, PAGE_TTL);
    this.sourceGate = new SourceRequestGate({
      owner: this,
      backoff,
      attention,
      normalizeUrl: normalizeDiscoveryUrl,
      resolveUrl: (url) => this.transportUrl(url),
      validateNavigation: (source, current) =>
        this.assertNavigation(source, current),
    });
  }
  async init() {
    await Promise.all(
      ["pages", "works", "thumbnails"].map((dir) =>
        mkdir(join(this.rootDir, dir), { recursive: true }),
      ),
    );
  }
  transportUrl(value) {
    const source = normalizeDiscoveryUrl(value);
    if(isWebtoonUrl(value)||/^\/(?:ing|end|manhwa|rank)\/?$/.test(source.pathname))return source.href;
    if (this.viewerOrigins)
      return (
        this.viewerOrigins.resolveWork?.(source.href) ||
        this.viewerOrigins.resolve(source.href)
      );
    return `https://sbxh9.com${source.pathname}${source.search}`;
  }
  assertNavigation(source, current) {
    const expected = new URL(this.transportUrl(source));
    const actual = normalizeDiscoveryUrl(current);
    if (
      actual.origin !== expected.origin ||
      actual.pathname.replace(/\/$/, "") !==
        expected.pathname.replace(/\/$/, "") ||
      actual.searchParams.toString() !== expected.searchParams.toString() ||
      actual.hash
    )
      throw attention("선택한 사이트의 작품 페이지에서 벗어났습니다.");
  }
  async exclusive(task) {
    const pending = this.serial.then(() => {
      this.checkOpen();
      return task();
    });
    this.serial = pending.catch(() => {});
    return pending;
  }
  checkOpen() {
    if (this.closing)
      throw Object.assign(new Error("작품 조회 서버가 종료 중입니다."), {
        status: 503,
      });
  }
  async exclusiveDetail(task) {
    const pending = this.detailSerial.then(() => {
      this.checkOpen();
      return task();
    });
    this.detailSerial = pending.catch(() => {});
    return pending;
  }
  updateWork(id, change) {
    const pending = (this.workLocks.get(id) || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const path = join(this.rootDir, "works", `${id}.json`);
        const next = change(await json(path));
        await atomic(path, JSON.stringify(next));
        return next;
      });
    this.workLocks.set(id, pending);
    pending
      .finally(() => {
        if (this.workLocks.get(id) === pending) this.workLocks.delete(id);
      })
      .catch(() => {});
    return pending;
  }
  async registerWork(value, metadata) {
    this.checkOpen();
    const id = validId(value);
    await this.init();
    const source = normalizeWorkSource(metadata.url);
    if (source.id !== id) throw badInput("작품 번호와 원본 주소가 다릅니다.");
    let changed = false;
    const work = await this.updateWork(id, (previous) => {
      const clean = mergeSourceMetadata(previous, metadata);
      changed = previous?.thumbnailUrl !== clean.thumbnailUrl;
      const count = metadata.episodeCount ?? clean.expectedChapterCount;
      return {
        ...previous,
        ...clean,
        id,
        url: source.url,
        title: clean.title || previous?.title || "제목 없음",
        episodeCount:
          Number.isSafeInteger(count) && count >= 0 && count <= 100000
            ? count
            : (previous?.episodeCount ?? null),
        cachedAt: new Date(this.now()).toISOString(),
      };
    });
    if (changed) {
      const path = join(this.rootDir, "thumbnails", `${id}.json`);
      await unlink(path).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    return publicWork(work);
  }
  pruneDetails() {
    for (const [id, state] of this.detailStates)
      if (
        state.status !== "pending" &&
        this.now() - state.updatedAt >= PAGE_TTL
      )
        this.detailStates.delete(id);
  }
  async detailState(value) {
    const id = validId(value);
    this.pruneDetails();
    const state = this.detailStates.get(id);
    if (state) {
      const { updatedAt, ...publicState } = state;
      return publicState;
    }
    const work = await json(join(this.rootDir, "works", `${id}.json`));
    if (
      work?.detailCachedAt &&
      this.now() - Date.parse(work.detailCachedAt) < PAGE_TTL
    )
      return { status: "completed", item: publicWork(work) };
    return { status: "failed", error: "아직 회차 조회를 요청하지 않았습니다." };
  }
  async requestDetail(value) {
    this.checkOpen();
    const id = validId(value);
    const state = await this.detailState(id);
    if (state.status === "completed" || state.status === "pending")
      return state;
    const work = await json(join(this.rootDir, "works", `${id}.json`));
    if (work?.url) this.sourceGate.assertAvailable(new URL(work.url).hostname);
    // Recheck after disk reads so two simultaneous requests do not schedule twice.
    if (this.detailStates.get(id)?.status === "pending")
      return { status: "pending" };
    if (
      [...this.detailStates.values()].filter(
        (item) => item.status === "pending",
      ).length >= 50
    )
      throw Object.assign(
        new Error("회차 조회 대기열이 가득 찼습니다. 잠시 후 다시 시도하세요."),
        { status: 429 },
      );
    if (this.detailStates.size >= 1000) {
      for (const [key, item] of this.detailStates)
        if (item.status !== "pending") {
          this.detailStates.delete(key);
          break;
        }
    }
    this.detailStates.set(id, { status: "pending", updatedAt: this.now() });
    this.detail(id).then(
      (item) =>
        this.detailStates.set(id, {
          status: "completed",
          item,
          updatedAt: this.now(),
        }),
      (error) =>
        this.detailStates.set(id, {
          status: "failed",
          error: error.message,
          updatedAt: this.now(),
        }),
    );
    return { status: "pending" };
  }
  dedupe(key, task) {
    if (this.pending.has(key)) return this.pending.get(key);
    const promise = Promise.resolve()
      .then(task)
      .finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  async overviewState(value) {
    const id = validId(value);
    const state = this.overviewStates.get(id);
    if (state && this.now() - state.updatedAt < PAGE_TTL) {
      const { updatedAt, ...result } = state;
      return result;
    }
    this.overviewStates.delete(id);
    const work = await json(join(this.rootDir, "works", `${id}.json`));
    if (!work) throw Object.assign(new Error("목록에서 작품을 먼저 선택하세요."), { status: 404 });
    const fresh = work.overviewCachedAt && this.now() - Date.parse(work.overviewCachedAt) < PAGE_TTL;
    return { status: fresh ? "completed" : "idle", item: publicWork(work) };
  }

  async requestOverview(value) {
    this.checkOpen();
    const id = validId(value);
    const state = await this.overviewState(id);
    if (["pending", "completed"].includes(state.status)) return state;
    this.sourceGate.assertAvailable(new URL(state.item?.url || `https://newtoki1.org/novel/${id}`).hostname);
    if (this.overviewStates.get(id)?.status === "pending") return { status: "pending" };
    if ([...this.overviewStates.values()].filter(s => s.status === "pending").length >= 50)
      throw Object.assign(new Error("작품 소개 조회가 대기 중입니다. 잠시 후 다시 시도하세요."), { status: 429 });
    if (this.overviewStates.size >= 500) {
      const old = [...this.overviewStates].find(([, s]) => s.status !== "pending");
      if (old) this.overviewStates.delete(old[0]);
    }
    this.overviewStates.set(id, { status: "pending", item: state.item, updatedAt: this.now() });
    this.overview(id).then(
      item => this.overviewStates.set(id, { status: "completed", item, updatedAt: this.now() }),
      error => this.overviewStates.set(id, { status: "failed", item: state.item,
        error: error.httpStatus === 404 ? "사이트에 작품 소개 페이지가 없습니다. 업로드 상태와 주소를 확인하세요." :
          "작품 소개를 확인하지 못했습니다. 사이트 접근 상태를 확인하고 다시 시도하세요.", updatedAt: this.now() }),
    );
    return { status: "pending", item: state.item };
  }

  overview(value) {
    const id = validId(value);
    return this.dedupe(`overview:${id}`, () => this.exclusiveDetail(async () => {
      await this.init();
      const work = await json(join(this.rootDir, "works", `${id}.json`));
      if (!work) throw Object.assign(new Error("목록에서 작품을 먼저 선택하세요."), { status: 404 });
      if (work.overviewCachedAt && this.now() - Date.parse(work.overviewCachedAt) < PAGE_TTL) return publicWork(work);
      const page = await (await this.openContext(new URL(work.url).hostname)).newPage();
      try {
        const source = normalizeWorkSource(work.url).url;
        await this.navigate(page, source);
        // Read the introductory page only. No chapter body, full catalog walk,
        // load-more button, login or CAPTCHA solver is part of this operation.
        const metadata = isWebtoonUrl(work.url)?await webtoonMetadata(page,webtoonPreset(this.presets,new URL(work.url).origin,null,normalizeWorkSource(work.url).contentType).presetSnapshot):await page.evaluate(readWorkMetadata);
        const detail = await this.updateWork(id, latest => ({ ...latest,
          ...mergeSourceMetadata(latest, metadata),
          episodeCount: Number.isSafeInteger(metadata.expectedChapterCount) ? metadata.expectedChapterCount : latest?.episodeCount ?? null,
          overviewCachedAt: new Date(this.now()).toISOString(),
        }));
        return publicWork(detail);
      } finally { await page.close(); }
    }));
  }
  async openContext(host) {
    return this.sourceGate.openContext(host);
  }
  async navigate(page, url) {
    return this.sourceGate.navigate(page, url);
  }
  async suspendRequests() {
    return this.sourceGate.suspend();
  }
  refreshConnection() {
    // Both listing and detail users finish before the shared context is closed.
    // Saved profiles and the site's authentication/rate-limit state are retained.
    return this.exclusive(() => this.exclusiveDetail(async () => {
      await this.sourceGate.suspend();
      this.dnsCache.clear();
    }));
  }
  list(input = {}, { onProgress } = {}) {
    // Dashboard pages are independent of the source site's page size. Keep
    // source-page caches intact and join only the pages covering this range.
    const query = normalizeDiscoveryQuery(input, 25000);
    if(isImageType(query.contentType)&&(query.query||query.author)&&(query.genre||query.platform))return this.filteredWebtoonSearch(query,{onProgress});
    const key = `paged-list:${JSON.stringify(query)}`;
    let observers = this.listObservers.get(key);
    if (!this.pending.has(key)) {
      observers = { listeners: new Set(), last: null };
      this.listObservers.set(key, observers);
    }
    if (typeof onProgress === "function") {
      observers.listeners.add(onProgress);
      if (observers.last) Promise.resolve().then(() => onProgress(observers.last)).catch(() => {});
    }
    const publicPage = result => {
      const unknownEpisodeCount = result.items.filter(item => item.episodeCount == null).length;
      const hasEpisodeFilter = query.minEpisodes !== null || query.maxEpisodes !== null;
      const items = hasEpisodeFilter ? result.items.filter(item => item.episodeCount != null &&
        (query.minEpisodes === null || item.episodeCount >= query.minEpisodes) &&
        (query.maxEpisodes === null || item.episodeCount <= query.maxEpisodes)) : [...result.items];
      const { normalCatalog, ...data } = result;
      return { ...data, items, pageSize: DISCOVERY_PAGE_SIZE, loadedCount: result.items.length, unknownEpisodeCount,
        filters: { ...result.filters, ...query, episodeScope: hasEpisodeFilter ? "known-only" : "all" } };
    };
    const publish = async result => {
      observers.last = publicPage(result);
      await Promise.allSettled([...observers.listeners].map(listener => Promise.resolve().then(() => listener(observers.last))));
    };
    return this.dedupe(key, async () => {
      this.checkOpen();
      const loaded = new Map();
      const read = async page => {
        if (!loaded.has(page)) loaded.set(page, await this.sourceList({
          ...query, page, minEpisodes: undefined, maxEpisodes: undefined,
        }, { knownMaxPage: loaded.get(1)?.maxPage, knownTotal: loaded.get(1)?.total }));
        return loaded.get(page);
      };
      const first = await read(1);
      let result;
      if (!first.normalCatalog && first.items.length <= DISCOVERY_PAGE_SIZE) {
        // The retained historical DOM adapter is already paged. Its inactive
        // network route is not used as a fallback for the normal catalog.
        result = query.page === 1 ? first : await read(query.page);
      } else {
        const sourceSize = first.items.length;
        if (!sourceSize) {
          if (query.page !== 1) throw badInput("목록의 마지막 페이지를 초과했습니다.");
          result = { ...first, page: 1, maxPage: 1, total: 0 };
        } else {
          let total = first.total;
          // A missing or inconsistent count is resolved from the final source
          // page, not an invented full last page. No chapter details are read.
          if (!Number.isSafeInteger(total) || total <= (first.maxPage - 1) * sourceSize ||
              total > first.maxPage * sourceSize) {
            const last = await read(first.maxPage);
            total = (first.maxPage - 1) * sourceSize + last.items.length;
          }
          const maxPage = Math.max(1, Math.ceil(total / DISCOVERY_PAGE_SIZE));
          if (query.page > maxPage) throw badInput("목록의 마지막 페이지를 초과했습니다.");
          const start = (query.page - 1) * DISCOVERY_PAGE_SIZE;
          const end = Math.min(total, start + DISCOVERY_PAGE_SIZE);
          const items = [];
          const ids = new Set();
          const used = [];
          const snapshot = () => ({ ...first, items: [...items], page: query.page, maxPage, total,
            cacheHit: used.every(data => data.cacheHit),
            ...catalogFreshness([first, ...used]),
            cachedAt: used.map(data => data.cachedAt).sort()[0] || first.cachedAt });
          for (let page = Math.floor(start / sourceSize) + 1;
               page <= Math.ceil(end / sourceSize); page++) {
            const data = await read(page);
            if (data.page !== page || data.maxPage !== first.maxPage ||
                (page < first.maxPage && data.items.length !== sourceSize))
              throw Object.assign(new Error("작품 목록이 변경됐습니다. 다시 검색해 주세요."), { status: 409 });
            used.push(data);
            const offset = (page - 1) * sourceSize;
            for (const item of data.items.slice(Math.max(0, start - offset), end - offset)) {
              if (ids.has(item.id))
                throw Object.assign(new Error("작품 목록이 변경됐습니다. 다시 검색해 주세요."), { status: 409 });
              ids.add(item.id);
              items.push(item);
            }
            await publish(snapshot());
          }
          if (items.length !== end - start)
            throw Object.assign(new Error("작품 목록이 변경됐습니다. 다시 검색해 주세요."), { status: 409 });
          result = snapshot();
        }
      }
      return publicPage(result);
    }).finally(() => {
      observers.listeners.delete(onProgress);
      if (this.listObservers.get(key) === observers && !this.pending.has(key)) this.listObservers.delete(key);
    });
  }
  sourceList(input = {}, options = {}) {
    return this.pageCache.list(input, options);
  }
  rankings(input={}){return discoveryRankings(this,input);}
  filteredWebtoonSearch(query,{onProgress}={}){
    const origin=new URL(this.transportUrl("https://newtoki1.org/novel")).origin,selected=webtoonPreset(this.presets,origin,null,query.contentType);
    return this.dedupe("webtoon-search:"+selected.presetHash+":"+JSON.stringify(query),async()=>{
      const normal=await this.sourceList({contentType:query.contentType,page:1,publication:query.publication});
      const remote={...query,genre:"",platform:"",minEpisodes:undefined,maxEpisodes:undefined,page:1};
      const first=await this.sourceList(remote),pages=[first],items=[],ids=new Set();
      for(let page=1;page<=first.maxPage;page++){
        const data=page===1?first:await this.sourceList({...remote,page});if(page>1)pages.push(data);
        for(const item of data.items){const platform=this.webtoonPlatforms?.[origin]?.[item.platform]||item.platform;
          if(ids.has(item.id))throw Object.assign(Error("검색 결과가 변경됐습니다. 다시 검색하세요."),{status:409});ids.add(item.id);
          const counted=query.minEpisodes===null&&query.maxEpisodes===null||item.episodeCount!=null;
          if((!query.genre||query.genre.split("/").some(genre=>item.genres?.includes(genre)))&&(!query.platform||platform===query.platform)&&counted&&
            (query.minEpisodes===null||item.episodeCount>=query.minEpisodes)&&(query.maxEpisodes===null||item.episodeCount<=query.maxEpisodes))items.push({...item,platform});}
      }
      const maximum=Math.max(1,Math.ceil(items.length/DISCOVERY_PAGE_SIZE));if(query.page>maximum)throw badInput("목록의 마지막 페이지를 초과했습니다.");
      const result={items:items.slice((query.page-1)*DISCOVERY_PAGE_SIZE,query.page*DISCOVERY_PAGE_SIZE),page:query.page,maxPage:maximum,total:items.length,
        pageSize:DISCOVERY_PAGE_SIZE,loadedCount:Math.min(DISCOVERY_PAGE_SIZE,Math.max(0,items.length-(query.page-1)*DISCOVERY_PAGE_SIZE)),
        cacheHit:pages.every(page=>page.cacheHit),...catalogFreshness(pages),cachedAt:first.cachedAt,
        filters:{...normal.filters,...query,episodeScope:query.minEpisodes!==null||query.maxEpisodes!==null?"known-only":"all"}};
      result.unknownEpisodeCount=result.items.filter(item=>item.episodeCount==null).length;await onProgress?.(result);return result;
    });
  }
  detail(value) {
    const id = validId(value);
    return this.dedupe(`detail:${id}`, () =>
      this.exclusiveDetail(async () => {
        await this.init();
        const path = join(this.rootDir, "works", `${id}.json`);
        const work = await json(path);
        if (!work)
          throw Object.assign(new Error("목록에서 작품을 먼저 선택하세요."), {
            status: 404,
          });
        if (
          work.detailCachedAt &&
          this.now() - Date.parse(work.detailCachedAt) < PAGE_TTL
        )
          return publicWork(work);
        const page = await (
          await this.openContext(new URL(work.url).hostname)
        ).newPage();
        const chapters = new Set(),
          signatures = new Set();
        let maximum = 1,
          title = work.title;
        try {
          for (let number = 1; number <= maximum; number++) {
            this.checkOpen();
            if (number > 1 && this.delayMs)
              await new Promise((resolve) => setTimeout(resolve, this.delayMs));
            const url = new URL(work.url);
            url.search = "";
            if (number > 1) url.searchParams.set("epage", String(number));
            await this.navigate(page, url.href);
            if(isWebtoonUrl(work.url)){
              const metadata=await webtoonMetadata(page,webtoonPreset(this.presets,new URL(work.url).origin,null,normalizeWorkSource(work.url).contentType).presetSnapshot);
              const detail=await this.updateWork(id,latest=>({...latest,...mergeSourceMetadata(latest,metadata),episodeCount:metadata.expectedChapterCount??null,
                detailCachedAt:new Date(this.now()).toISOString(),overviewCachedAt:new Date(this.now()).toISOString()}));
              return publicWork(detail);
            }
            const data = await page.evaluate(readCatalogDocument);
            if (data.normalCatalog) {
              const metadata = await page.evaluate(readWorkMetadata);
              const count =
                data.expectedChapters ?? metadata.expectedChapterCount;
              if (!Number.isSafeInteger(count) || count < 1 || count > 100000)
                throw attention(
                  "작품에 표시된 전체 회차 수를 확인하지 못했습니다.",
                );
              const detail = await this.updateWork(id, (latest) => ({
                ...latest,
                ...mergeSourceMetadata(latest, metadata),
                episodeCount: count,
                detailCachedAt: new Date(this.now()).toISOString(),
                overviewCachedAt: new Date(this.now()).toISOString(),
              }));
              return publicWork(detail);
            }
            if (!data.chapters.length)
              throw attention("작품 목차를 찾지 못했습니다.");
            if (!Number.isSafeInteger(data.maxPage) || data.maxPage > 1000)
              throw new Error("목차 페이지 수가 잘못됐습니다.");
            maximum = Math.max(maximum, data.maxPage);
            title = data.title || title;
            const signature = data.chapters
              .map((chapter) => chapter.url)
              .sort()
              .join("|");
            if (signatures.has(signature))
              throw new Error("목차 페이지가 같은 회차를 반복합니다.");
            signatures.add(signature);
            for (const chapter of data.chapters) chapters.add(chapter.url);
          }
          const detail = await this.updateWork(id, (latest) => ({
            ...latest,
            title,
            episodeCount: chapters.size,
            detailCachedAt: new Date(this.now()).toISOString(),
          }));
          return publicWork(detail);
        } finally {
          await page.close();
        }
      }),
    );
  }
  async storeThumbnail(value, image) {
    const id = validId(value);
    const imagePath = join(this.rootDir, "thumbnails", `${id}.image`);
    const mimeType = validateImage(image.bytes, image.mimeType);
    const etag = `"${createHash("sha256").update(image.bytes).digest("hex")}"`;
    await atomic(imagePath, image.bytes);
    await atomic(join(this.rootDir, "thumbnails", `${id}.json`),
      JSON.stringify({ etag, mimeType, savedAt: this.now() }));
    return { path: imagePath, mimeType, etag };
  }
  thumbnail(value) {
    const id = validId(value);
    return this.dedupe(`thumbnail:${id}`, async () => {
      await this.init();
      const metaPath = join(this.rootDir, "thumbnails", `${id}.json`),
        imagePath = join(this.rootDir, "thumbnails", `${id}.image`);
      const cached = await json(metaPath);
      if (cached?.etag) {
        try {
          await stat(imagePath);
          return {
            path: imagePath,
            mimeType: cached.mimeType,
            etag: cached.etag,
          };
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      if (this.sourceGate.active) return null;
      const work = await json(join(this.rootDir, "works", `${id}.json`));
      if (!work?.thumbnailUrl) return null;
      const correctedFormat=new URL(work.thumbnailUrl).hostname==='mana.apihost93.com';
      if(cached?.failedAt&&this.now()-cached.failedAt<NEGATIVE_TTL&&(!correctedFormat||cached.formatPolicy==='actual-mime-v1'))return null;
      if (this.sourceGate.isHeld(new URL(work.url).hostname)) return null;
      const task = async () => {
        if (
          this.closing ||
          this.sourceGate.active ||
          this.sourceGate.isHeld(new URL(work.url).hostname)
        )
          return null;
        try {
          const cover = validateThumbnailUrl(work.thumbnailUrl);
          // Cached legacy images remain readable; cold fetches use only the
          // active frontend or the shared public image CDN.
          if (/^newtoki\d*\.(org|com|net|me)$/i.test(cover.hostname))
            cover.hostname = new URL(this.transportUrl(work.url)).hostname;
          const image = await this.fetchImage(cover.href);
          return await this.storeThumbnail(id, image);
        } catch {
          await atomic(metaPath, JSON.stringify({ failedAt: this.now(),...(correctedFormat?{formatPolicy:'actual-mime-v1'}:{}) }));
          return null;
        }
      };
      const pending = this.imageSerial.then(task);
      this.imageSerial = pending.catch(() => {});
      return pending;
    });
  }
  async close() {
    this.closing = true;
    // Closing the browser interrupts an in-flight page, rather than waiting for
    // every page of a large catalog or every queued metadata request.
    if (this.contextPromise) await this.contextPromise.catch(() => {});
    const context = this.context;
    this.context = null;
    await context?.close().catch(() => {});
  }
}
