import {
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  appendFile,
  stat,
  unlink,
} from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { canonicalWorkInput } from "./source-links.mjs";
import {
  listChapterMetadata,
  writeChapterMetadata,
} from "./chapter-metadata.mjs";

async function replaceAtomicFile(source, target) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(source, target);
    } catch (error) {
      if (
        process.platform !== "win32" ||
        !["EPERM", "EACCES", "EBUSY"].includes(error.code) ||
        attempt >= 7
      )
        throw error;
      await wait(10 * 2 ** attempt);
    }
  }
}

export function safeId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value))
    throw Object.assign(new Error("잘못된 ID입니다."), { status: 400 });
  return value;
}
export function validateUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Object.assign(new Error("올바른 작품 URL을 입력하세요."), {
      status: 400,
    });
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !/^newtoki\d+\.(org|com|net|me|co|io|site|tv)$/.test(url.hostname) ||
    !/^\/novel\/\d+(?:\/\d+)?\/?$/.test(url.pathname) ||
    url.hash
  )
    throw Object.assign(
      new Error("HTTPS 뉴토끼 소설 URL만 사용할 수 있습니다."),
      { status: 400 },
    );
  for (const [key] of url.searchParams)
    if (!["epage"].includes(key))
      throw Object.assign(
        new Error("URL에는 epage 페이지 번호만 사용할 수 있습니다."),
        { status: 400 },
      );
  const page = url.searchParams.get("epage");
  if (page !== null && !/^\d{1,5}$/.test(page))
    throw Object.assign(new Error("잘못된 목차 페이지 번호입니다."), {
      status: 400,
    });
  return url.href;
}
export function validateJob(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw Object.assign(new Error("작품 설정이 필요합니다."), { status: 400 });
  const url = validateUrl(canonicalWorkInput(input.url));
  const executor = input.executor ?? "server",
    format = input.format ?? "txt";
  if (
    !["server", "browser"].includes(executor) ||
    !["txt", "epub"].includes(format)
  )
    throw Object.assign(new Error("지원하지 않는 수집 방식 또는 형식입니다."), {
      status: 400,
    });
  const range = (key) => {
    const v = input[key] ?? null;
    if (v !== null && (!Number.isSafeInteger(v) || v < 0))
      throw Object.assign(new Error("회차는 0 이상의 정수여야 합니다."), {
        status: 400,
      });
    return v;
  };
  const startEpisode = range("startEpisode"),
    endEpisode = range("endEpisode");
  if (startEpisode !== null && endEpisode !== null && startEpisode > endEpisode)
    throw Object.assign(new Error("종료 회차가 시작 회차보다 작습니다."), {
      status: 400,
    });
  let startAt = null;
  if (input.startAt) {
    const date = new Date(input.startAt);
    if (!Number.isFinite(date.getTime()))
      throw Object.assign(new Error("잘못된 예약 시각입니다."), {
        status: 400,
      });
    startAt = date.toISOString();
  }
  if (input.overwrite !== undefined && typeof input.overwrite !== "boolean")
    throw Object.assign(new Error("overwrite는 boolean이어야 합니다."), {
      status: 400,
    });
  if (
    input.title !== undefined &&
    (typeof input.title !== "string" || input.title.length > 500)
  )
    throw Object.assign(new Error("제목이 너무 길거나 올바르지 않습니다."), {
      status: 400,
    });
  if (
    input.retryOnlyFailed !== undefined &&
    typeof input.retryOnlyFailed !== "boolean"
  )
    throw Object.assign(new Error("실패 회차 재수집 설정이 잘못됐습니다."), {
      status: 400,
    });
  let retryChapterIds = null;
  if (input.retryChapterIds != null) {
    if (
      !Array.isArray(input.retryChapterIds) ||
      input.retryChapterIds.length > 10000
    )
      throw Object.assign(new Error("재수집 회차 목록이 잘못됐습니다."), {
        status: 400,
      });
    retryChapterIds = [...new Set(input.retryChapterIds.map(safeId))];
  }
  return {
    url,
    title: input.title?.trim() ?? "",
    executor,
    format,
    startAt,
    startEpisode,
    endEpisode,
    overwrite: input.overwrite ?? false,
    retryOnlyFailed: input.retryOnlyFailed ?? false,
    retryChapterIds,
  };
}
export function cleanMessage(value) {
  return String(value ?? "")
    .replace(/(Bearer\s+)[\w.+\/-]+/gi, "$1[redacted]")
    .replace(/([?&](?:token|password|key|secret)=)[^\s&#]+/gi, "$1[redacted]")
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, "https://[redacted]@")
    .slice(0, 3000);
}
export class FolderStore {
  constructor(rootDir) {
    this.rootDir = resolve(rootDir);
    this.locks = new Map();
    this.lastCreatedMs = 0;
  }
  async init() {
    for (const folder of ["jobs", "books"])
      await mkdir(join(this.rootDir, folder), { recursive: true, mode: 0o700 });
    const existingJobs = await this.listJobs();
    this.lastCreatedMs = Math.max(
      0,
      ...existingJobs.map((job) => Date.parse(job.createdAt) || 0),
    );
    for (const id of await this.ids(this.path("books"))) {
      const book = await this.json(this.path("books", id, "book.json"));
      if (!book) continue;
      if (
        book.storedChapterCount === undefined ||
        book.failureCount === undefined
      ) {
        const fullJobs = existingJobs.filter(
          (job) =>
            job.bookId === id &&
            job.startEpisode == null &&
            job.endEpisode == null &&
            job.total > 0,
        );
        await this.upsertBook(id, {
          storedChapterCount: await this.countStoredChapters(id),
          failureCount: (await this.listFailures(id)).length,
          ...(!Number.isSafeInteger(book.expectedChapterCount) &&
          fullJobs.length
            ? {
                expectedChapterCount: Math.max(
                  ...fullJobs.map((job) => job.total),
                ),
              }
            : {}),
        });
      }
    }
    return this;
  }
  path(...parts) {
    return join(this.rootDir, ...parts);
  }
  async locked(key, operation) {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.locks.set(key, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(key) === next) this.locks.delete(key);
    }
  }
  async atomic(path, value) {
    return this.locked("file:" + path, async () => {
      await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
      const tmp = path + "." + randomUUID() + ".tmp";
      await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
      await replaceAtomicFile(tmp, path);
    });
  }
  async json(path) {
    return this.locked("file:" + path, async () => {
      try {
        return JSON.parse(await readFile(path, "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    });
  }
  async ids(path) {
    try {
      return (await readdir(path, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && /^[A-Za-z0-9_-]{1,100}$/.test(e.name))
        .map((e) => e.name);
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
  }
  async listJobs() {
    const jobs = await Promise.all(
      (await this.ids(this.path("jobs"))).map((id) => this.getJob(id)),
    );
    const sorted = jobs
      .filter(Boolean)
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
    const saved = await this.json(this.path("queue-order.json"));
    const positions = new Map((Array.isArray(saved?.jobIds) ? saved.jobIds : []).map((id,index)=>[id,index]));
    const waiting = sorted.filter(job=>["queued","paused"].includes(job.status)&&!job.deleting)
      .sort((a,b)=>(positions.get(a.id)??positions.size)-(positions.get(b.id)??positions.size));
    let index=0;
    return sorted.map(job=>["queued","paused"].includes(job.status)&&!job.deleting?waiting[index++]:job);
  }
  async reorderJobs(jobId,beforeId,activeJobIds=[]){
    safeId(jobId);if(beforeId!==null)safeId(beforeId);
    return this.locked("queue-order",async()=>{
      const jobs=await this.listJobs(),active=new Set(activeJobIds);
      const waiting=jobs.filter(job=>["queued","paused"].includes(job.status)&&!job.deleting&&!active.has(job.id));
      for(const id of [jobId,beforeId].filter(id=>id!==null)){
        if(!jobs.some(job=>job.id===id))throw Object.assign(Error("예약을 찾을 수 없습니다."),{status:404});
        if(!waiting.some(job=>job.id===id))throw Object.assign(Error("대기·일시정지 예약만 순서를 변경할 수 있습니다."),{status:409});
      }
      if(jobId===beforeId)return jobs;
      const ids=waiting.map(job=>job.id).filter(id=>id!==jobId),index=beforeId===null?ids.length:ids.indexOf(beforeId);
      ids.splice(index,0,jobId);
      const running=jobs.filter(job=>job.status==="running"||active.has(job.id)).map(job=>job.id);
      await this.atomic(this.path("queue-order.json"),{jobIds:[...running,...ids]});
      return this.listJobs();
    });
  }
  async getJob(id) {
    return this.json(this.path("jobs", safeId(id), "job.json"));
  }
  async createJob(input) {
    const validated = validateJob(input);
    return this.locked("job-creation", () =>
      this.createValidatedJob(validated),
    );
  }
  async createJobs(input) {
    if (!Array.isArray(input) || !input.length || input.length > 100)
      throw Object.assign(new Error("한 번에 1~100개 작품을 등록하세요."), {
        status: 400,
      });
    const validated = input.map(validateJob);
    return this.locked("job-creation", async () => {
      const workKey = (value) => {
        const url = new URL(value);
        return `${url.hostname}/${url.pathname.split("/")[2]}`;
      };
      const active = new Set(
        (await this.listJobs())
          .filter((job) =>
            ["queued", "running", "paused", "needs_attention"].includes(
              job.status,
            ),
          )
          .map((job) => workKey(job.url)),
      );
      const jobs = [],
        skipped = [];
      for (const job of validated) {
        const key = workKey(job.url);
        if (active.has(key)) {
          skipped.push({ url: job.url, reason: "이미 등록된 작품입니다." });
          continue;
        }
        jobs.push(await this.createValidatedJob(job));
        active.add(key);
      }
      return { jobs, skipped };
    });
  }
  async createValidatedJob(validated) {
    this.lastCreatedMs = Math.max(Date.now(), this.lastCreatedMs + 1);
    const now = new Date(this.lastCreatedMs).toISOString();
    const job = {
      ...validated,
      id: randomUUID(),
      status: "queued",
      phase: "대기",
      createdAt: now,
      updatedAt: now,
      lastActivity: now,
      total: 0,
      completed: 0,
      skipped: 0,
      failed: 0,
      currentChapter: null,
      bookId: null,
      exports: {},
      error: null,
    };
    await this.atomic(this.path("jobs", job.id, "job.json"), job);
    return job;
  }
  async deleteJob(id) {
    safeId(id);
    return this.locked("job:" + id, () =>
      this.locked("event:" + id, async () => {
        const job = await this.getJob(id);
        if (!job)
          throw Object.assign(new Error("작업을 찾을 수 없습니다."), {
            status: 404,
          });
        if (
          ![
            "completed",
            "completed_with_errors",
            "failed",
            "cancelled",
          ].includes(job.status)
        )
          throw Object.assign(
            new Error("완료하거나 취소한 수집 기록만 삭제할 수 있습니다."),
            { status: 409 },
          );
        const archive = this.path("trash", "jobs", id);
        await mkdir(resolve(archive, ".."), { recursive: true, mode: 0o700 });
        // Move only this validated job folder. Library chapters remain independent.
        await this.locked("file:" + this.path("jobs", id, "job.json"), () =>
          replaceAtomicFile(this.path("jobs", id), archive),
        );
        return { deleted: true };
      }),
    );
  }
  async patchJob(id, patch) {
    safeId(id);
    return this.locked("job:" + id, async () => {
      const job = await this.getJob(id);
      if (!job)
        throw Object.assign(new Error("작업을 찾을 수 없습니다."), {
          status: 404,
        });
      const changes = typeof patch === "function" ? patch(job) : patch;
      if (changes === null) return job;
      const next = {
        ...job,
        ...changes,
        id: job.id,
        createdAt: job.createdAt,
        updatedAt: new Date().toISOString(),
      };
      await this.atomic(this.path("jobs", id, "job.json"), next);
      if (next.status !== job.status || next.phase !== job.phase) {
        try { this.onOperation?.({ scope: "job", jobId: id, message: `${next.status} · ${next.phase || ""}` }); } catch {}
      }
      return next;
    });
  }
  async appendEvent(id, { level = "info", message }) {
    safeId(id);
    return this.locked("event:" + id, async () => {
      if (!(await this.getJob(id)))
        throw Object.assign(new Error("작업을 찾을 수 없습니다."), {
          status: 404,
        });
      try { this.onOperation?.({ scope: "job", jobId: id, level, message }); } catch {}
      await appendFile(
        this.path("jobs", id, "events.jsonl"),
        JSON.stringify({
          time: new Date().toISOString(),
          level: ["info", "warn", "error"].includes(level) ? level : "info",
          message: cleanMessage(message),
        }) + "\n",
        { mode: 0o600 },
      );
    });
  }
  async readEvents(id, limit = 100) {
    safeId(id);
    return this.locked("event:" + id, () => this.readEventsFile(id, limit));
  }
  async readEventsFile(id, limit = 100) {
    try {
      const rows = (
        await readFile(this.path("jobs", id, "events.jsonl"), "utf8")
      )
        .trim()
        .split("\n")
        .filter(Boolean);
      return rows
        .slice(-Math.max(1, Math.min(1000, Number(limit) || 100)))
        .map((row) => JSON.parse(row));
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
  }
  async listBooks() {
    return (
      await Promise.all(
        (await this.ids(this.path("books"))).map((id) => this.getBook(id)),
      )
    ).filter(Boolean);
  }
  async getBook(id) {
    const book = await this.json(this.path("books", safeId(id), "book.json"));
    if (!book) return null;
    const storedChapterCount =
      book.storedChapterCount ?? (await this.countStoredChapters(id));
    const rawExpected =
      book.expectedChapterCount ?? book.expectedChapters ?? book.totalChapters;
    const expectedChapterCount =
      Number.isSafeInteger(rawExpected) && rawExpected >= 0
        ? rawExpected
        : null;
    const failureCount =
      book.failureCount ?? (await this.listFailures(id)).length;
    return {
      ...book,
      storedChapterCount,
      expectedChapterCount,
      failureCount,
      failedChapterCount: failureCount,
      missingChapterCount:
        expectedChapterCount === null
          ? null
          : Math.max(0, expectedChapterCount - storedChapterCount),
      complete:
        expectedChapterCount !== null &&
        storedChapterCount >= expectedChapterCount,
    };
  }
  async countStoredChapters(id) {
    let count = 0;
    for (const chapterId of await this.ids(
      this.path("books", safeId(id), "chapters"),
    )) {
      try {
        if (
          (
            await stat(
              this.path("books", id, "chapters", chapterId, "chapter.json"),
            )
          ).isFile()
        )
          count++;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return count;
  }
  async upsertBook(id, meta) {
    safeId(id);
    return this.locked("book:" + id, async () => {
      const existing = await this.json(this.path("books", id, "book.json"));
      const changes =
        typeof meta === "function" ? await meta(existing ?? {}) : meta;
      const next = {
        ...existing,
        ...changes,
        id,
        updatedAt: new Date().toISOString(),
      };
      await this.atomic(this.path("books", id, "book.json"), next);
      return next;
    });
  }
  async writeCatalog(id, data) {
    safeId(id);
    if (
      !data ||
      !Array.isArray(data.chapters) ||
      !data.chapters.length ||
      data.chapters.length > 100000
    )
      throw Object.assign(new Error("전체 목차가 올바르지 않습니다."), {
        status: 400,
      });
    const chapters = data.chapters.map((chapter) => {
      safeId(chapter.id);
      if (
        !Number.isSafeInteger(chapter.number) ||
        chapter.number < 0 ||
        typeof chapter.title !== "string"
      )
        throw Object.assign(
          new Error("목차의 회차 정보가 올바르지 않습니다."),
          { status: 400 },
        );
      return {
        id: chapter.id,
        number: chapter.number,
        title: chapter.title.slice(0, 1000),
        url: validateUrl(chapter.url),
        ...(chapter.notReady === true ? { notReady: true } : {}),
      };
    });
    if (new Set(chapters.map((chapter) => chapter.id)).size !== chapters.length)
      throw Object.assign(new Error("목차에 중복 회차가 있습니다."), {
        status: 400,
      });
    const { chapters: ignore, ...metadata } = data;
    const catalog = {
      ...metadata,
      expectedChapters: chapters.length,
      chapters,
      updatedAt: new Date().toISOString(),
    };
    await this.locked("catalog:" + id, () =>
      this.atomic(this.path("books", id, "catalog.json"), catalog),
    );
    await this.upsertBook(id, {
      ...metadata,
      expectedChapters: chapters.length,
      expectedChapterCount: chapters.length,
    });
    return catalog;
  }
  async readCatalog(id) {
    return this.json(this.path("books", safeId(id), "catalog.json"));
  }
  async listFailures(id) {
    const directory = this.path("books", safeId(id), "failures");
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const failures = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^([A-Za-z0-9_-]{1,100})\.json$/.test(entry.name))
        continue;
      const record = await this.json(join(directory, entry.name));
      if (record) failures.push(record);
    }
    return failures.sort(
      (a, b) => a.number - b.number || a.id.localeCompare(b.id),
    );
  }
  async recordFailure(bookId, chapter, details = {}) {
    safeId(bookId);
    safeId(chapter.id);
    if (!Number.isSafeInteger(chapter.number) || chapter.number < 0)
      throw Object.assign(new Error("실패 회차 번호가 올바르지 않습니다."), {
        status: 400,
      });
    const record = {
      id: chapter.id,
      number: chapter.number,
      title: String(chapter.title ?? "").slice(0, 1000),
      url: validateUrl(chapter.url),
      code: String(details.code ?? "FAILED").slice(0, 100),
      message: cleanMessage(details.message),
      error: cleanMessage(details.message),
      retryable: details.retryable !== false,
      jobId: details.jobId == null ? null : safeId(details.jobId),
      updatedAt: new Date().toISOString(),
    };
    return this.locked("failure:" + bookId, async () => {
      await this.atomic(
        this.path("books", bookId, "failures", chapter.id + ".json"),
        record,
      );
      await this.upsertBook(bookId, {
        failureCount: (await this.listFailures(bookId)).length,
      });
      return record;
    });
  }
  async clearFailure(bookId, chapterId) {
    safeId(bookId);
    safeId(chapterId);
    return this.locked("failure:" + bookId, async () => {
      try {
        const path = this.path(
          "books",
          bookId,
          "failures",
          chapterId + ".json",
        );
        await this.locked("file:" + path, () => unlink(path));
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
      await this.upsertBook(bookId, {
        failureCount: (await this.listFailures(bookId)).length,
      });
      return true;
    });
  }
  async listChapters(id) {
    return this.listChapterMetadata(id);
  }
  async listChapterMetadata(id) {
    return listChapterMetadata(this, safeId(id));
  }
  async readChapter(bookId, chapterId) {
    return this.json(
      this.path(
        "books",
        safeId(bookId),
        "chapters",
        safeId(chapterId),
        "chapter.json",
      ),
    );
  }
  async writeChapter(bookId, chapterId, { number, title, url, text }) {
    safeId(bookId);
    safeId(chapterId);
    if (typeof text !== "string" || !text.trim())
      throw Object.assign(new Error("본문이 비어 있습니다."), { status: 400 });
    const chapter = {
      id: chapterId,
      number,
      title,
      url: validateUrl(url),
      text,
      hash: createHash("sha256").update(text).digest("hex"),
      size: Buffer.byteLength(text),
      updatedAt: new Date().toISOString(),
    };
    return this.locked("chapter:" + bookId + ":" + chapterId, async () => {
      const path = this.path(
        "books",
        bookId,
        "chapters",
        chapterId,
        "chapter.json",
      );
      const existing = await this.json(path);
      await this.atomic(path, chapter);
      await writeChapterMetadata(this, bookId, chapterId, chapter);
      await this.clearFailure(bookId, chapterId);
      await this.upsertBook(bookId, async (current) => ({
        storedChapterCount: Number.isSafeInteger(current.storedChapterCount)
          ? current.storedChapterCount + (existing ? 0 : 1)
          : await this.countStoredChapters(bookId),
        lastChapterSavedAt: chapter.updatedAt,
      }));
      return chapter;
    });
  }
  async writeExport(jobId, format, bytes, filename) {
    safeId(jobId);
    if (!["txt", "epub"].includes(format))
      throw Object.assign(new Error("잘못된 내보내기 형식입니다."), {
        status: 400,
      });
    const path = this.path("jobs", jobId, "export." + format);
    const tmp = path + "." + randomUUID() + ".tmp";
    await writeFile(tmp, bytes, { mode: 0o600 });
    await replaceAtomicFile(tmp, path);
    const info = {
      filename: basename(String(filename)).replace(/[\r\n"\\/]/g, "_"),
      mimeType:
        format === "txt" ? "text/plain; charset=utf-8" : "application/epub+zip",
    };
    await this.patchJob(jobId, {
      exports: { ...(await this.getJob(jobId)).exports, [format]: info },
    });
    return { path, ...info };
  }
  async getExport(jobId, format) {
    safeId(jobId);
    if (!["txt", "epub"].includes(format)) return null;
    const job = await this.getJob(jobId);
    const meta = job?.exports?.[format];
    if (!meta) return null;
    const path = this.path("jobs", jobId, "export." + format);
    try {
      await stat(path);
      return { path, ...meta };
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }
}
