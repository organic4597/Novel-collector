import { statfs } from "node:fs/promises";
import { SETTINGS_KEYS } from "./settings.mjs";

export class SystemInfo {
  constructor({
    store,
    settings = null,
    clock = Date.now,
    uptime = () => process.uptime(),
    statfsFn = statfs,
    cacheMs = 30000,
  }) {
    this.store = store;
    this.settings = settings;
    this.clock = clock;
    this.uptime = uptime;
    this.statfsFn = statfsFn;
    this.cacheMs = cacheMs;
    this.cache = null;
    this.pending = null;
  }
  async scan() {
    const books = await this.store.listBooks();
    let chapterCount = 0,
      bodyBytes = 0;
    for (const book of books) {
      const chapters = await this.store.listChapterMetadata(book.id);
      chapterCount += chapters.length;
      for (const chapter of chapters) {
        if (Number.isSafeInteger(chapter.size) && chapter.size >= 0)
          bodyBytes += chapter.size;
      }
    }
    let diskFreeBytes = null;
    try {
      const disk = await this.statfsFn(this.store.rootDir);
      const bytes = Number(disk.bavail) * Number(disk.bsize);
      if (Number.isSafeInteger(bytes) && bytes >= 0) diskFreeBytes = bytes;
    } catch {
      /* Disk availability is optional; never expose filesystem errors. */
    }
    const computed = this.clock();
    this.cache = {
      bookCount: books.length,
      chapterCount,
      bodyBytes,
      diskFreeBytes,
      computedAtISO: new Date(computed).toISOString(),
      expires: computed + this.cacheMs,
    };
    return this.cache;
  }
  async get() {
    const fresh = this.cache && this.clock() < this.cache.expires;
    const cached = !!fresh || !!this.pending;
    if (!fresh) {
      if (!this.pending) {
        this.pending = this.scan().finally(() => {
          this.pending = null;
        });
      }
      await this.pending;
    }
    const { expires, ...stats } = this.cache;
    const values = this.settings?.get();
    const settings = values
      ? Object.fromEntries(
          SETTINGS_KEYS.filter((key) => Object.hasOwn(values, key)).map(
            (key) => [key, values[key]],
          ),
        )
      : null;
    return {
      ...stats,
      uptimeSeconds: Math.max(0, Math.floor(this.uptime())),
      backoff: { threshold: 5, cooldownMs: 600000 },
      maxConcurrency: 2,
      computedAtISO: stats.computedAtISO,
      cached,
      ...(settings ? { settings } : {}),
    };
  }
}
