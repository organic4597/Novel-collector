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
import { openNormalDiscovery } from "./normal-discovery.mjs";

const PAGE_TTL = 30 * 60 * 1000,
  NEGATIVE_TTL = 6 * 60 * 60 * 1000;
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
  if (!/^\d{1,15}$/.test(String(value)))
    throw badInput("작품 번호가 잘못됐습니다.");
  return String(value);
};
const attention = (message) =>
  Object.assign(new Error(message), { code: "NEEDS_ATTENTION" });
export function normalizeDiscoveryQuery(input = {}) {
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
  const publication = input.publication || "all",
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
    page: integer(input.page, 1, 1000),
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
        const metadata = await page.evaluate(readWorkMetadata);
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
  list(input = {}) {
    const query = normalizeDiscoveryQuery(input),
      remote = { ...query, minEpisodes: null, maxEpisodes: null };
    const key = createHash("sha256")
      .update(
        `normal-v1:${new URL(this.transportUrl("https://newtoki1.org/novel")).origin}:${JSON.stringify(remote)}`,
      )
      .digest("hex");
    return this.dedupe(
      `list:${key}:${query.minEpisodes}:${query.maxEpisodes}`,
      () =>
        this.exclusive(async () => {
          await this.init();
          const path = join(this.rootDir, "pages", `${key}.json`);
          let data = await json(path);
          const cacheHit = !!data && this.now() - data.savedAt < PAGE_TTL;
          if (!cacheHit) {
            const context = await this.openContext();
            const page = await context.newPage();
            try {
              // The former newtoki pub/sst/plat/epage list request is backed up
              // and inactive. Only the normal site's rendered public controls
              // and its observed ordinary search page drive discovery.
              const parsed = await openNormalDiscovery(
                this,
                page,
                query,
                readDiscoveryDocument,
                readReaderDocument,
              );
              if (!parsed.items.length && parsed.maxPage > 1)
                throw attention("작품 목록을 찾지 못했습니다.");
              if (
                !Number.isSafeInteger(parsed.maxPage) ||
                parsed.maxPage < 1 ||
                parsed.maxPage > 1000
              )
                throw new Error("목록 페이지 수가 잘못됐습니다.");
              data = {
                ...parsed,
                savedAt: this.now(),
                cachedAt: new Date(this.now()).toISOString(),
              };
              await atomic(path, JSON.stringify(data));
              for (const item of data.items) {
                validId(item.id);
                await this.updateWork(item.id, (previous) => ({
                  ...previous,
                  ...item,
                  ...mergeSourceMetadata(previous, item),
                  episodeCount:
                    previous?.episodeCount ?? item.episodeCount ?? null,
                  detailCachedAt: previous?.detailCachedAt || null,
                  cachedAt: data.cachedAt,
                }));
              }
            } finally {
              await page.close();
            }
          }
          let items = await Promise.all(
            data.items.map(async (item) => {
              const work = await json(
                join(this.rootDir, "works", `${validId(item.id)}.json`),
              );
              const { thumbnailUrl, ...publicItem } = { ...item, ...work };
              return {
                ...publicItem,
                thumbnail: thumbnailUrl
                  ? `/api/discover/${item.id}/thumbnail`
                  : null,
                cachedAt: data.cachedAt,
              };
            }),
          );
          const hasEpisodeFilter =
            query.minEpisodes !== null || query.maxEpisodes !== null;
          const unknownEpisodeCount = items.filter(
            (item) => item.episodeCount === null,
          ).length;
          if (hasEpisodeFilter)
            items = items.filter(
              (item) =>
                item.episodeCount !== null &&
                (query.minEpisodes === null ||
                  item.episodeCount >= query.minEpisodes) &&
                (query.maxEpisodes === null ||
                  item.episodeCount <= query.maxEpisodes),
            );
          return {
            items,
            page: data.page,
            maxPage: data.maxPage,
            total: data.total ?? null,
            cachedAt: data.cachedAt,
            cacheHit,
            unknownEpisodeCount,
            filters: {
              ...data.filters,
              ...query,
              episodeScope: hasEpisodeFilter ? "known-only" : "all",
            },
          };
        }),
    );
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
      if (cached?.failedAt && this.now() - cached.failedAt < NEGATIVE_TTL)
        return null;
      if (this.sourceGate.active) return null;
      const work = await json(join(this.rootDir, "works", `${id}.json`));
      if (!work?.thumbnailUrl) return null;
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
          const mimeType = validateImage(image.bytes, image.mimeType);
          const etag = `"${createHash("sha256").update(image.bytes).digest("hex")}"`;
          await atomic(imagePath, image.bytes);
          await atomic(
            metaPath,
            JSON.stringify({ etag, mimeType, savedAt: this.now() }),
          );
          return { path: imagePath, mimeType, etag };
        } catch {
          await atomic(metaPath, JSON.stringify({ failedAt: this.now() }));
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
