import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import JSZip from "jszip";
import { safeId } from "./store.mjs";
import { webtoonCbz, webtoonZip } from "./webtoon-images.mjs";

const fail = (message, status) => Object.assign(new Error(message), { status });
const digest = (value) => createHash("sha256").update(value).digest("hex");
const safeFilename = (value) =>
  String(value || "제목 없음")
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 100) || "제목 없음";
const changed = () =>
  Object.assign(
    new Error("수집 중인 본문이 변경됐습니다. 잠시 후 다시 다운로드하세요."),
    { code: "SNAPSHOT_CHANGED", status: 409 },
  );
const maximumArchiveBytes = 3 * 1024 ** 3;
const maximumArchiveBooks = 60000; // Classic ZIP has a 16-bit entry count; no ZIP64 writer here.

async function* fileChunks(path) {
  for await (const chunk of createReadStream(path)) yield chunk;
}

async function json(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function exists(path) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function counts(book, chapters) {
  const raw =
    book.expectedChapterCount ?? book.expectedChapters ?? book.totalChapters;
  const expectedChapterCount =
    Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
  return {
    chapterCount: chapters.length,
    expectedChapterCount,
    missingChapterCount:
      expectedChapterCount === null
        ? null
        : Math.max(0, expectedChapterCount - chapters.length),
    complete:
      expectedChapterCount !== null && chapters.length >= expectedChapterCount,
  };
}

function sanitizedState(value) {
  return {
    id: value.id,
    status: value.status,
    processed: value.processed,
    total: value.total,
    filename: value.filename ?? null,
    error: value.error ?? null,
    createdAt: value.createdAt ?? null,
    completedAt: value.completedAt ?? null,
  };
}

export class LibraryDownloads {
  constructor({ store, rootDir, maxArchiveBytes = maximumArchiveBytes }) {
    if (
      !Number.isSafeInteger(maxArchiveBytes) ||
      maxArchiveBytes < 1 ||
      maxArchiveBytes > maximumArchiveBytes
    )
      throw fail("올바른 ZIP 크기 제한이 필요합니다.", 400);
    this.store = store;
    this.rootDir = resolve(rootDir);
    this.bookWork = new Map();
    this.states = new Map();
    this.queue = [];
    this.running = null;
    this.controller = new AbortController();
    this.closed = false;
    this.closeWork = null;
    this.maxArchiveBytes = maxArchiveBytes;
  }

  checkOpen() {
    if (this.closed || this.controller.signal.aborted)
      throw fail("다운로드 서비스가 종료 중입니다.", 503);
  }

  async bookTxt(bookId) {
    safeId(bookId);
    this.checkOpen();
    if (this.bookWork.has(bookId)) return this.bookWork.get(bookId);
    const operation = this.createBookTxt(bookId);
    this.bookWork.set(bookId, operation);
    try {
      return await operation;
    } finally {
      if (this.bookWork.get(bookId) === operation) this.bookWork.delete(bookId);
    }
  }
  async bookZip(bookId){safeId(bookId);this.checkOpen();return webtoonZip(this.store,this.rootDir,bookId,this.controller.signal,this.maxArchiveBytes);}
  async chapterCbz(bookId,chapterId){safeId(bookId);safeId(chapterId);this.checkOpen();return webtoonCbz(this.store,this.rootDir,bookId,
    await this.store.readChapter(bookId,chapterId),this.controller.signal);}
  async bookFile(bookId){return (await this.store.getBook(bookId))?.contentType==="webtoon"?this.bookZip(bookId):this.bookTxt(bookId);}

  async createBookTxt(bookId) {
    for (let attempt = 0; attempt < 3; attempt++) {
      this.checkOpen();
      const book = await this.store.getBook(bookId);
      if (!book) throw fail("작품을 찾을 수 없습니다.", 404);
      if(book.contentType==="webtoon")throw fail("웹툰은 회차 CBZ·작품 ZIP으로 내려받으세요.",400);
      const chapters = (await this.store.listChapters(bookId))
        .slice()
        .sort(
          (a, b) =>
            (a.number ?? 0) - (b.number ?? 0) || a.id.localeCompare(b.id),
        );
      if (!chapters.length)
        throw Object.assign(
          fail("저장된 본문이 없습니다. 회차 수집 후 다운로드하세요.", 409),
          { code: "NO_STORED_TEXT" },
        );
      const summary = counts(book, chapters);
      const revision = digest(
        JSON.stringify({
          title: book.title,
          author: book.author,
          summary,
          chapters: chapters.map(({ id, number, title, hash, size }) => ({
            id,
            number,
            title,
            hash,
            size,
          })),
        }),
      );
      const directory = join(this.rootDir, "books", bookId);
      const path = join(directory, `${revision}.txt`);
      const manifestPath = join(directory, `${revision}.json`);
      const output = {
        path,
        filename: `${safeFilename(book.title)}_[${bookId}].txt`,
        mimeType: "text/plain; charset=utf-8",
        etag: `"${revision}"`,
        ...summary,
      };
      const cached = await json(manifestPath);
      if (cached?.etag === output.etag && (await exists(path))) return output;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await pipeline(
          Readable.from(this.txtChunks(bookId, book, chapters, summary)),
          createWriteStream(temporary, { mode: 0o600, flags: "wx" }),
          { signal: this.controller.signal },
        );
        this.checkOpen();
        await rename(temporary, path);
        await this.store.atomic(manifestPath, { ...output, path: undefined });
        return output;
      } catch (error) {
        await rm(temporary, { force: true });
        if (error.code !== "SNAPSHOT_CHANGED" || attempt === 2) throw error;
      }
    }
    throw changed();
  }

  async *txtChunks(bookId, book, chapters, summary) {
    const total =
      summary.expectedChapterCount === null
        ? "미확인"
        : summary.expectedChapterCount;
    const missing =
      summary.missingChapterCount === null
        ? "미확인"
        : summary.missingChapterCount;
    yield `[ ${book.title || "제목 없음"} ]\n작가: ${book.author || "미확인"}\n저장 ${summary.chapterCount}화 · 전체 ${total}화 · 누락 ${missing}화\n수집 상태: ${summary.complete ? "전체 본문 저장됨" : "일부 저장 또는 전체 회차 미확인"}\n`;
    for (const meta of chapters) {
      this.checkOpen();
      const chapter = await this.store.readChapter(bookId, safeId(meta.id));
      if (
        !chapter ||
        typeof chapter.text !== "string" ||
        !chapter.text.trim() ||
        digest(chapter.text) !== meta.hash ||
        chapter.hash !== meta.hash ||
        chapter.title !== meta.title ||
        chapter.number !== meta.number
      )
        throw changed();
      yield `\n\n=== ${chapter.number ?? "?"} · ${chapter.title || "제목 없음"} ===\n\n`;
      yield chapter.text;
    }
    yield "\n";
  }

  async requestBundle(bookIds) {
    this.checkOpen();
    if (!Array.isArray(bookIds) || !bookIds.length || bookIds.length > 200)
      throw fail("한 번에 1~200개 작품을 선택하세요.", 400);
    const unique = [...new Set(bookIds.map(safeId))];
    for (const id of unique) {
      const book = await this.store.getBook(id);
      if (!book) throw fail("선택한 작품을 찾을 수 없습니다.", 404);
      if (book.storedChapterCount === 0)
        throw Object.assign(
          fail(
            "선택한 작품에 저장된 본문이 없습니다. 회차 수집 후 다운로드하세요.",
            409,
          ),
          { code: "NO_STORED_TEXT" },
        );
    }
    return this.enqueueBundle(unique);
  }

  async requestAllBundle() {
    this.checkOpen();
    const books = await this.store.listBooks();
    const unique = [
      ...new Set(
        books
          .filter((book) => book.storedChapterCount !== 0)
          .map((book) => safeId(book.id)),
      ),
    ];
    if (!unique.length) throw fail("다운로드할 저장 작품이 없습니다.", 400);
    if (unique.length > maximumArchiveBooks)
      throw fail(
        "ZIP 한 개에는 최대 60,000개 작품을 담을 수 있습니다. 작품을 나누어 선택하세요.",
        413,
      );
    return this.enqueueBundle(unique);
  }

  async enqueueBundle(unique) {
    this.checkOpen();
    for (const [id, state] of this.states) {
      if (this.states.size < 100) break;
      if (state.status !== "preparing") this.states.delete(id);
    }
    if (
      [...this.states.values()].filter((state) => state.status === "preparing")
        .length >= 5
    )
      throw fail("파일 준비 요청이 많습니다. 잠시 후 재시도하세요.", 429);
    const id = randomUUID();
    const state = sanitizedState({
      id,
      status: "preparing",
      processed: 0,
      total: unique.length,
      createdAt: new Date().toISOString(),
    });
    this.states.set(id, state);
    try {
      await this.saveState(state);
    } catch (error) {
      this.states.delete(id);
      throw error;
    }
    this.queue.push({ id, bookIds: unique });
    const reply = { ...state };
    this.pump();
    return reply;
  }

  async saveState(state) {
    await this.store.atomic(
      join(this.rootDir, "jobs", safeId(state.id), "state.json"),
      sanitizedState(state),
    );
  }

  async updateState(id, patch) {
    const previous = this.states.get(id);
    const state = sanitizedState({ ...previous, ...patch });
    this.states.set(id, state);
    await this.saveState(state);
    return state;
  }

  pump() {
    if (this.closed || this.running || !this.queue.length) return;
    const next = this.queue.shift();
    this.running = this.prepareBundle(next)
      .catch(() => {
        console.error(
          "[LibraryDownloads] 파일 준비 상태를 저장하지 못했습니다. 서버 디스크와 권한을 확인하세요.",
        );
      })
      .finally(() => {
        this.running = null;
        this.pump();
      });
  }

  async prepareBundle({ id, bookIds }) {
    const directory = join(this.rootDir, "jobs", id);
    const temporary = join(directory, `bundle.${randomUUID()}.tmp`);
    const streams = [];
    try {
      const zip = new JSZip();
      let plannedBytes = 0;
      for (const bookId of bookIds) {
        this.checkOpen();
        const file = await this.bookFile(bookId);
        this.checkOpen();
        plannedBytes +=
          (await stat(file.path)).size +
          Buffer.byteLength(file.filename) * 2 +
          512;
        if (plannedBytes > this.maxArchiveBytes)
          throw fail(
            "ZIP 한 개는 3 GB 이내로 준비할 수 있습니다. 작품을 나누어 선택해 다운로드하세요.",
            413,
          );
        // Open each TXT only when JSZip consumes it, avoiding thousands of open files.
        const stream = Readable.from(fileChunks(file.path));
        streams.push(stream);
        zip.file(file.filename, stream, { binary: true });
        await this.updateState(id, { processed: streams.length });
      }
      await pipeline(
        zip.generateNodeStream({
          streamFiles: true,
          compression: "DEFLATE",
          compressionOptions: { level: 3 },
        }),
        createWriteStream(temporary, { mode: 0o600, flags: "wx" }),
        { signal: this.controller.signal },
      );
      this.checkOpen();
      await rename(temporary, join(directory, "bundle.zip"));
      await this.updateState(id, {
        status: "ready",
        filename: `선택한_소설_${id}.zip`,
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      const message = this.closed
        ? "서버 종료로 파일 준비가 중단됐습니다. 다시 요청하세요."
        : error.status && error.status < 500
          ? error.message
          : "파일 준비에 실패했습니다. 다시 요청하거나 서버 로그를 확인하세요.";
      await this.updateState(id, {
        status: "failed",
        error: message,
        completedAt: new Date().toISOString(),
      });
    } finally {
      for (const stream of streams) stream.destroy();
    }
  }

  async getBundle(id) {
    safeId(id);
    const remembered = this.states.get(id);
    if (remembered) return { ...remembered };
    const persisted = await json(join(this.rootDir, "jobs", id, "state.json"));
    if (!persisted || persisted.id !== id) return null;
    const state = sanitizedState(persisted);
    if (state.status === "preparing") {
      const interrupted = {
        ...state,
        status: "failed",
        error: "서버 재시작으로 파일 준비가 중단됐습니다. 다시 요청하세요.",
        completedAt: new Date().toISOString(),
      };
      await this.saveState(interrupted);
      return interrupted;
    }
    return state;
  }

  async bundleFile(id) {
    const state = await this.getBundle(id);
    if (state?.status !== "ready") return null;
    const path = join(this.rootDir, "jobs", safeId(id), "bundle.zip");
    return (await exists(path))
      ? { path, filename: state.filename, mimeType: "application/zip" }
      : null;
  }

  close() {
    if (this.closeWork) return this.closeWork;
    this.closed = true;
    this.controller.abort();
    this.queue = [];
    this.closeWork = this.finishClose();
    return this.closeWork;
  }

  async finishClose() {
    await Promise.all(
      [...this.states.values()]
        .filter((state) => state.status === "preparing")
        .map((state) =>
          this.updateState(state.id, {
            status: "failed",
            error: "서버 종료로 파일 준비가 중단됐습니다. 다시 요청하세요.",
            completedAt: new Date().toISOString(),
          }),
        ),
    );
    let timeout;
    try {
      await Promise.race([
        Promise.allSettled(
          [...this.bookWork.values(), this.running].filter(Boolean),
        ),
        new Promise((resolve) => {
          timeout = setTimeout(resolve, 2000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }
}
