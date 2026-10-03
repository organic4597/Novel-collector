import { makeBookId } from "./collector.mjs";

const unavailable = () =>
  Object.assign(new Error("작품 등록 서버가 종료 중입니다."), { status: 503 });

export class JobProfiles {
  constructor({ store, metadata, onError = () => {}, maxPending = 1000 }) {
    this.store = store;
    this.metadata = metadata;
    this.onError = onError;
    this.maxPending = maxPending;
    this.pending = new Set();
    this.deferred = new Map();
    this.serial = Promise.resolve();
    this.registration = Promise.resolve();
    this.closing = false;
  }
  state(bookId) {
    if (this.pending.has(bookId)) return { status: "pending" };
    if (this.metadata.states?.has(bookId)) this.deferred.delete(bookId);
    return this.deferred.get(bookId) || null;
  }
  registerJobs(jobs) {
    const task = this.registration
      .catch(() => {})
      .then(() => this.seedJobs(jobs));
    this.registration = task;
    return task;
  }
  async seedJobs(jobs) {
    if (this.closing) throw unavailable();
    const sources = jobs.map((job) => ({
      job,
      source: this.source(job.url),
      bookId: makeBookId(job.url),
    }));
    const registered = [];
    for (const { job, source, bookId } of sources) {
      if (this.closing) throw unavailable();
      await this.store.upsertBook(bookId, (previous) => ({
        ...(!previous.id ? { storedChapterCount: 0, failureCount: 0 } : {}),
        ...(!previous.title ? { title: job.title || `작품 ${source.id}` } : {}),
        url: source.url,
      }));
      registered.push(
        await this.store.patchJob(job.id, (current) => ({
          bookId: current.bookId || bookId,
        })),
      );
    }
    for (const { bookId } of sources) await this.enqueue(bookId);
    return registered;
  }
  source(value) {
    makeBookId(value);
    const url = new URL(value);
    const id = url.pathname.match(/^\/novel\/(\d+)/)[1];
    url.pathname = `/novel/${id}`;
    url.search = "";
    url.hash = "";
    return { id, url: url.href };
  }
  async enqueue(bookId) {
    if (this.closing || this.pending.has(bookId)) return;
    if (this.pending.size >= this.maxPending) {
      const book = await this.store.getBook(bookId);
      if (this.metadata.fresh?.(book)) {
        this.deferred.delete(bookId);
        return;
      }
      const state = {
        status: "deferred",
        code: "PROFILE_QUEUE_FULL",
        error:
          "작품 정보 조회 대기열이 가득 찼습니다. 잠시 후 다시 요청하세요.",
      };
      await this.store.upsertBook(bookId, {
        metadataQueueDeferredAt: new Date().toISOString(),
        metadataQueueDeferredError: state.error,
      });
      if (this.deferred.size >= this.maxPending)
        this.deferred.delete(this.deferred.keys().next().value);
      this.deferred.set(bookId, state);
      return;
    }
    this.deferred.delete(bookId);
    this.pending.add(bookId);
    const task = this.serial
      .then(async () => {
        if (this.closing) return;
        await this.store.upsertBook(bookId, {
          metadataQueueDeferredAt: null,
          metadataQueueDeferredError: null,
        });
        const requested = await this.metadata.request(bookId);
        const result =
          requested.status === "pending"
            ? await this.metadata.wait(bookId)
            : requested;
        if (!this.closing && result.status === "completed") {
          try {
            await this.metadata.thumbnail(bookId);
          } catch (problem) {
            this.onError(problem, { bookId, phase: "thumbnail" });
          }
        }
      })
      .catch(async (problem) => {
        if (this.closing) return;
        this.onError(problem, { bookId });
        if (await this.store.getBook(bookId))
          await this.store.upsertBook(bookId, {
            metadataFetchFailedAt: new Date().toISOString(),
            metadataFetchError:
              problem.status === 400
                ? problem.message
                : "작품 정보 조회에 실패했습니다. 잠시 후 다시 시도하세요.",
          });
      })
      .finally(() => this.pending.delete(bookId));
    this.serial = task.catch(() => {});
  }
  async wait() {
    await this.registration;
    await this.serial;
  }
  async close() {
    this.closing = true;
    this.pending.clear();
    this.deferred.clear();
  }
}
