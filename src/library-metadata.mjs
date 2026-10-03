import { readWorkMetadata } from "./collection-metadata.mjs";
import { readCatalogDocument } from "./collector.mjs";
import {
  normalizeWorkSource,
  mergeSourceMetadata,
} from "./source-metadata.mjs";
export { normalizeWorkSource } from "./source-metadata.mjs";

const DAY = 24 * 60 * 60 * 1000,
  RETRY_DELAY = 10 * 60 * 1000;
const error = (message, status = 400) =>
  Object.assign(new Error(message), { status });
export class LibraryMetadata {
  constructor({
    store,
    discovery,
    now = () => Date.now(),
    onError = () => {},
  }) {
    this.store = store;
    this.discovery = discovery;
    this.now = now;
    this.onError = onError;
    this.states = new Map();
    this.tasks = new Map();
    this.serial = Promise.resolve();
    this.closing = false;
  }
  checkOpen() {
    if (this.closing) throw error("작품 정보 조회 서버가 종료 중입니다.", 503);
  }
  defer(bookId, problem) {
    if (
      !["SITE_VERIFICATION_REQUIRED", "REQUEST_BACKOFF"].includes(problem.code)
    )
      return null;
    const result = {
      status: "deferred",
      error: problem.message,
      code: problem.code,
    };
    this.states.set(bookId, { ...result, updatedAt: this.now() });
    return result;
  }
  fresh(book) {
    return (
      book.metadataVersion === 1 &&
      book.metadataSourceOrigin === this.sourceOrigin(book.url) &&
      book.metadataFetchedAt &&
      Number.isFinite(Date.parse(book.metadataFetchedAt))
    );
  }
  sourceOrigin(url) {
    const source = normalizeWorkSource(url);
    return new URL(
      this.discovery.transportUrl?.(source.url) ||
        `https://sbxh9.com/novel/${source.id}`,
    ).origin;
  }
  prune() {
    for (const [id, state] of this.states)
      if (state.status !== "pending" && this.now() - state.updatedAt >= DAY)
        this.states.delete(id);
  }
  async book(bookId) {
    const book = await this.store.getBook(bookId);
    if (!book) throw error("저장된 작품을 찾을 수 없습니다.", 404);
    return book;
  }
  async state(bookId) {
    this.prune();
    const state = this.states.get(bookId);
    if (state && state.status !== "completed") {
      const { updatedAt, ...result } = state;
      return result;
    }
    const book = await this.book(bookId);
    if (state) {
      const { updatedAt, ...result } = state;
      return state.status === "completed"
        ? { status: "completed", book }
        : result;
    }
    if (this.fresh(book)) return { status: "completed", book };
    if (
      book.metadataFetchFailedAt &&
      this.now() - Date.parse(book.metadataFetchFailedAt) < RETRY_DELAY
    )
      return {
        status: "failed",
        error: book.metadataFetchError || "작품 정보 조회에 실패했습니다.",
      };
    if (book.metadataQueueDeferredAt)
      return {
        status: "deferred",
        code: "PROFILE_QUEUE_FULL",
        error: book.metadataQueueDeferredError,
      };
    return { status: "failed", error: "아직 작품 정보를 조회하지 않았습니다." };
  }
  async request(bookId) {
    this.checkOpen();
    this.prune();
    if (this.states.get(bookId)?.status === "pending")
      return { status: "pending" };
    const book = await this.book(bookId),
      previous = this.states.get(bookId);
    if (previous?.status === "pending") return { status: "pending" };
    if (this.fresh(book)) {
      await this.discovery.registerWork(normalizeWorkSource(book.url).id, book);
      return { status: "completed", book };
    }
    try {
      this.discovery.sourceGate?.assertAvailable(
        new URL(normalizeWorkSource(book.url).url).hostname,
      );
    } catch (problem) {
      const deferred = this.defer(bookId, problem);
      if (deferred) return deferred;
      throw problem;
    }
    if (
      book.metadataFetchFailedAt &&
      this.now() - Date.parse(book.metadataFetchFailedAt) < RETRY_DELAY
    )
      return {
        status: "failed",
        error: book.metadataFetchError || "작품 정보 조회에 실패했습니다.",
      };
    if (
      [...this.states.values()].filter((state) => state.status === "pending")
        .length >= 50
    )
      throw error("작품 정보 조회 대기열이 가득 찼습니다.", 429);
    if (this.states.size >= 1000) {
      for (const [id, state] of this.states)
        if (state.status !== "pending") {
          this.states.delete(id);
          break;
        }
    }
    this.states.set(bookId, { status: "pending", updatedAt: this.now() });
    const task = this.serial.then(async () => {
      this.checkOpen();
      const latest = await this.book(bookId);
      if (this.fresh(latest)) return latest;
      return this.hydrate(bookId, latest);
    });
    const completed = task.then(
      () =>
        this.states.set(bookId, { status: "completed", updatedAt: this.now() }),
      async (problem) => {
        if (this.closing) {
          this.states.delete(bookId);
          return;
        }
        if (this.defer(bookId, problem)) return;
        this.onError(problem, { bookId });
        const message =
          problem.status === 400
            ? problem.message
            : problem.code === "NEEDS_ATTENTION"
              ? "원본 사이트의 접근 확인이 필요합니다."
              : "작품 정보 조회에 실패했습니다. 잠시 후 다시 시도하세요.";
        try {
          await this.store.upsertBook(bookId, {
            metadataFetchFailedAt: new Date(this.now()).toISOString(),
            metadataFetchError: message,
          });
        } catch {
          /* A removed book should not break the background queue. */
        }
        this.states.set(bookId, {
          status: "failed",
          error: message,
          updatedAt: this.now(),
        });
      },
    );
    this.tasks.set(bookId, completed);
    this.serial = completed.catch(() => {});
    completed
      .finally(() => {
        if (this.tasks.get(bookId) === completed) this.tasks.delete(bookId);
      })
      .catch(() => {});
    return { status: "pending" };
  }
  async wait(bookId) {
    await this.tasks.get(bookId);
    return this.state(bookId);
  }
  async hydrate(bookId, book) {
    const source = normalizeWorkSource(book.url);
    return this.discovery.exclusiveDetail(async () => {
      this.checkOpen();
      const page = await (await this.discovery.openContext()).newPage();
      try {
        await this.discovery.navigate(page, source.url);
        this.checkOpen();
        const metadata = await page.evaluate(readWorkMetadata);
        const catalog = await page.evaluate(readCatalogDocument);
        if (
          !catalog.normalCatalog &&
          catalog.maxPage === 1 &&
          catalog.chapters.length
        )
          metadata.expectedChapterCount = new Set(
            catalog.chapters.map((chapter) => chapter.url),
          ).size;
        this.checkOpen();
        return this.register(bookId, { ...metadata, url: source.url });
      } finally {
        await page.close().catch(() => {});
      }
    });
  }
  async register(bookId, metadata) {
    this.checkOpen();
    const previous = await this.book(bookId);
    const source = normalizeWorkSource(metadata.url || previous.url);
    const clean = mergeSourceMetadata(previous, metadata);
    const discovered = await this.discovery.registerWork(source.id, {
      ...clean,
      url: source.url,
      episodeCount:
        clean.expectedChapterCount ??
        previous.expectedChapterCount ??
        previous.expectedChapters ??
        null,
    });
    const enriched = mergeSourceMetadata(clean, discovered);
    // Existing complete catalog counts remain intact when a single source page
    // does not establish the total chapter count.
    const book = await this.store.upsertBook(bookId, {
      ...enriched,
      url: source.url,
      metadataFetchedAt: new Date(this.now()).toISOString(),
      metadataSourceOrigin: this.sourceOrigin(source.url),
      metadataVersion: 1,
      metadataFetchFailedAt: null,
      metadataFetchError: null,
      metadataQueueDeferredAt: null,
      metadataQueueDeferredError: null,
    });
    this.states.set(bookId, { status: "completed", updatedAt: this.now() });
    return this.store.getBook(bookId);
  }
  async thumbnail(bookId) {
    this.checkOpen();
    const book = await this.book(bookId);
    const source = normalizeWorkSource(book.url);
    await this.discovery.registerWork(source.id, book);
    if (!this.fresh(book)) {
      const state = await this.request(bookId);
      if (state.status !== "completed")
        return this.discovery.thumbnail(source.id);
    }
    return this.discovery.thumbnail(source.id);
  }
  async close() {
    this.closing = true;
  }
}
