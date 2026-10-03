import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as wait } from "node:timers/promises";
import JSZip from "jszip";
import { FolderStore } from "../src/store.mjs";
import { LibraryDownloads } from "../src/library-downloads.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "library-downloads-"));
  const store = await new FolderStore(join(directory, "data")).init();
  const rootDir = join(directory, "downloads");
  const downloads = new LibraryDownloads({ store, rootDir });
  t.after(async () => {
    await downloads.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { store, downloads, rootDir };
}
async function addBook(
  store,
  id,
  {
    title = "작품 이름",
    author = "작가",
    expectedChapterCount = 2,
    chapters = [2, 1],
  } = {},
) {
  await store.upsertBook(id, { title, author, expectedChapterCount });
  for (const number of chapters)
    await store.writeChapter(id, `chapter-${number}`, {
      number,
      title: `${number}화 제목`,
      url: `https://newtoki1.org/novel/100/${number}`,
      text: `${number}화 첫 줄\r\n\r\n  본문 공백 그대로  \n마지막 줄`,
    });
}
async function untilSettled(downloads, id) {
  for (let i = 0; i < 200; i++) {
    const state = await downloads.getBundle(id);
    if (state.status !== "preparing") return state;
    await wait(10);
  }
  throw new Error("Bundle never settled");
}

test("book TXT contains every stored chapter in order, exact text and truthful summary independent of jobs", async (t) => {
  const f = await fixture(t);
  await addBook(f.store, "book-one", { expectedChapterCount: 3 });
  const output = await f.downloads.bookTxt("book-one");
  assert.equal(output.chapterCount, 2);
  assert.equal(output.expectedChapterCount, 3);
  assert.equal(output.missingChapterCount, 1);
  assert.equal(output.complete, false);
  assert.equal(output.mimeType, "text/plain; charset=utf-8");
  assert.match(output.etag, /^"[a-f0-9]{64}"$/);
  const text = await readFile(output.path, "utf8");
  assert.match(text, /작품 이름/);
  assert.match(text, /작가/);
  assert.match(text, /저장.*2.*전체.*3.*누락.*1/);
  for (const number of [1, 2])
    assert.ok(
      text.includes(
        (await f.store.readChapter("book-one", `chapter-${number}`)).text,
      ),
    );
  assert.ok(text.indexOf("1화 제목") < text.indexOf("2화 제목"));
  assert.deepEqual(await f.store.listJobs(), []);
});

test("unknown catalog size is not marked complete, known fully stored size is complete", async (t) => {
  const f = await fixture(t);
  await addBook(f.store, "unknown");
  await f.store.upsertBook("unknown", { expectedChapterCount: null });
  assert.equal((await f.downloads.bookTxt("unknown")).complete, false);
  assert.equal(
    (await f.downloads.bookTxt("unknown")).expectedChapterCount,
    null,
  );
  assert.equal(
    (await f.downloads.bookTxt("unknown")).missingChapterCount,
    null,
  );
  await addBook(f.store, "complete");
  assert.equal((await f.downloads.bookTxt("complete")).complete, true);
});

test("cache is reused across process objects and invalidates on added/changed chapters and metadata", async (t) => {
  const f = await fixture(t);
  await addBook(f.store, "book");
  const first = await f.downloads.bookTxt("book");
  const modifiedAt = (await stat(first.path)).mtimeMs;
  await f.downloads.close();
  const reopened = new LibraryDownloads({ store: f.store, rootDir: f.rootDir });
  t.after(() => reopened.close());
  const second = await reopened.bookTxt("book");
  assert.equal(second.path, first.path);
  assert.equal((await stat(second.path)).mtimeMs, modifiedAt);
  await f.store.writeChapter("book", "chapter-3", {
    number: 3,
    title: "추가 회차",
    url: "https://newtoki1.org/novel/100/3",
    text: "새 본문",
  });
  const third = await reopened.bookTxt("book");
  assert.notEqual(third.etag, first.etag);
  assert.equal(third.chapterCount, 3);
  await f.store.writeChapter("book", "chapter-3", {
    number: 3,
    title: "추가 회차",
    url: "https://newtoki1.org/novel/100/3",
    text: "교체된 본문",
  });
  const fourth = await reopened.bookTxt("book");
  assert.notEqual(fourth.etag, third.etag);
  assert.match(await readFile(fourth.path, "utf8"), /교체된 본문/);
  await f.store.upsertBook("book", { title: "수정 제목", author: "새 작가" });
  const fifth = await reopened.bookTxt("book");
  assert.notEqual(fifth.etag, fourth.etag);
  assert.match(await readFile(fifth.path, "utf8"), /수정 제목/);
});

test("concurrent same-book exports share one completed cache generation", async (t) => {
  const f = await fixture(t);
  await addBook(f.store, "book");
  let reads = 0;
  const read = f.store.readChapter.bind(f.store);
  f.store.readChapter = async (...args) => {
    reads++;
    return read(...args);
  };
  const [one, two, three] = await Promise.all([
    f.downloads.bookTxt("book"),
    f.downloads.bookTxt("book"),
    f.downloads.bookTxt("book"),
  ]);
  assert.deepEqual(one, two);
  assert.deepEqual(two, three);
  assert.ok(
    reads >= 2 && reads <= 4,
    "same-book callers must share the chapter reads",
  );
});

test("a chapter overwritten between manifest and streaming is retried, never emitted with stale hash", async (t) => {
  const f = await fixture(t);
  await addBook(f.store, "book", { chapters: [1], expectedChapterCount: 1 });
  const list = f.store.listChapters.bind(f.store);
  let overwrite = true;
  f.store.listChapters = async (id) => {
    const snapshot = await list(id);
    if (overwrite) {
      overwrite = false;
      await f.store.writeChapter(id, "chapter-1", {
        number: 1,
        title: "수정 회차",
        url: "https://newtoki1.org/novel/100/1",
        text: "최신 본문",
      });
    }
    return snapshot;
  };
  const output = await f.downloads.bookTxt("book");
  assert.match(await readFile(output.path, "utf8"), /최신 본문/);
  assert.match(await readFile(output.path, "utf8"), /수정 회차/);
});

test("bundle returns immediately, deduplicates selected books and has safe unique UTF-8 TXT filenames", async (t) => {
  const f = await fixture(t);
  await addBook(f.store, "one", { title: "../같은/제목\r\n" });
  await addBook(f.store, "two", { title: "../같은/제목\r\n" });
  const requested = await f.downloads.requestBundle(["one", "two", "one"]);
  assert.equal(requested.status, "preparing");
  assert.equal(requested.total, 2);
  assert.equal(requested.processed, 0);
  const ready = await untilSettled(f.downloads, requested.id);
  assert.equal(ready.status, "ready");
  assert.equal(ready.processed, 2);
  assert.ok(!JSON.stringify(ready).includes(f.rootDir));
  const file = await f.downloads.bundleFile(requested.id);
  assert.equal(file.mimeType, "application/zip");
  const zip = await JSZip.loadAsync(await readFile(file.path));
  const names = Object.keys(zip.files);
  assert.equal(names.length, 2);
  assert.equal(new Set(names).size, 2);
  for (const name of names) {
    assert.ok(!/[\/\\\r\n]/.test(name));
    assert.ok(!name.startsWith("."));
    assert.match(name, /같은.*제목/);
    assert.match(name, /\.txt$/);
    assert.match(await zip.file(name).async("string"), /본문 공백 그대로/);
  }
});

test("ready bundle metadata/file survives reopen; stale preparing state becomes failed", async (t) => {
  const f = await fixture(t);
  await addBook(f.store, "book");
  const requested = await f.downloads.requestBundle(["book"]);
  const ready = await untilSettled(f.downloads, requested.id);
  await f.downloads.close();
  const reopened = new LibraryDownloads({ store: f.store, rootDir: f.rootDir });
  t.after(() => reopened.close());
  assert.deepEqual(await reopened.getBundle(requested.id), ready);
  assert.ok(await reopened.bundleFile(requested.id));
  await f.store.atomic(join(f.rootDir, "jobs", "stale", "state.json"), {
    id: "stale",
    status: "preparing",
    processed: 0,
    total: 1,
  });
  assert.equal((await reopened.getBundle("stale")).status, "failed");
  assert.equal(await reopened.bundleFile("stale"), null);
  assert.equal(await reopened.getBundle("unknown"), null);
});

test("invalid/missing/excessive bundle selections reject before enqueueing any work", async (t) => {
  const f = await fixture(t);
  await addBook(f.store, "book");
  for (const ids of [
    null,
    [],
    "book",
    ["../book"],
    ["book", "missing"],
    Array.from({ length: 201 }, (_, i) => `book-${i}`),
  ]) {
    await assert.rejects(f.downloads.requestBundle(ids), (error) =>
      [400, 404].includes(error.status),
    );
  }
  await assert.rejects(f.downloads.bookTxt("../book"), { status: 400 });
  await assert.rejects(f.downloads.bookTxt("missing"), { status: 404 });
  await assert.rejects(f.downloads.getBundle("../id"), { status: 400 });
});

test("bundle queue caps outstanding work and close aborts blocked preparation boundedly", async (t) => {
  const f = await fixture(t);
  await addBook(f.store, "book");
  let release;
  const block = new Promise((resolve) => {
    release = resolve;
  });
  const original = f.downloads.bookTxt.bind(f.downloads);
  f.downloads.bookTxt = async (id) => {
    await block;
    return original(id);
  };
  const states = [];
  for (let i = 0; i < 5; i++)
    states.push(await f.downloads.requestBundle(["book"]));
  await assert.rejects(f.downloads.requestBundle(["book"]), { status: 429 });
  const closing = f.downloads.close();
  release();
  await closing;
  for (const state of states)
    assert.equal((await f.downloads.getBundle(state.id)).status, "failed");
  await assert.rejects(f.downloads.requestBundle(["book"]), { status: 503 });
});

test("continuous chapter changes fail boundedly and a failed bundle exposes no internal error or file", async (t) => {
  const f = await fixture(t);
  await addBook(f.store, "book", { chapters: [1], expectedChapterCount: 1 });
  const list = f.store.listChapters.bind(f.store);
  let revisions = 0;
  f.store.listChapters = async (id) => {
    const snapshot = await list(id);
    await f.store.writeChapter(id, "chapter-1", {
      number: 1,
      title: "수정 회차",
      url: "https://newtoki1.org/novel/100/1",
      text: `변경 ${++revisions}`,
    });
    return snapshot;
  };
  await assert.rejects(
    f.downloads.bookTxt("book"),
    (error) => error.code === "SNAPSHOT_CHANGED" && error.status === 409,
  );
  assert.equal(revisions, 3);
  f.downloads.bookTxt = async () => {
    throw new Error("private internal path /secret/password=leaked");
  };
  const state = await f.downloads.requestBundle(["book"]);
  assert.equal(await f.downloads.bundleFile(state.id), null);
  const failed = await untilSettled(f.downloads, state.id);
  assert.equal(failed.status, "failed");
  assert.ok(!JSON.stringify(failed).includes("/secret"));
  assert.ok(!JSON.stringify(failed).includes("leaked"));
  assert.equal(await f.downloads.bundleFile(state.id), null);
});

test("all-library download snapshots more than 200 books while selected downloads keep their limit", async (t) => {
  const f = await fixture(t);
  const books = Array.from({ length: 201 }, (_, index) => ({
    id: `book-${index}`,
    title: `작품 ${index}`,
  }));
  f.store.listBooks = async () => books.slice();
  f.store.getBook = async (id) => books.find((book) => book.id === id) || null;
  const bodyPath = join(f.rootDir, "..", "all-book-fixture.txt");
  await writeFile(bodyPath, "저장된 모든 본문", "utf8");
  f.downloads.bookTxt = async (id) => ({
    path: bodyPath,
    filename: `${id}.txt`,
  });
  await assert.rejects(
    f.downloads.requestBundle(books.map((book) => book.id)),
    { status: 400 },
  );
  const state = await f.downloads.requestAllBundle();
  assert.equal(state.status, "preparing");
  assert.equal(state.total, 201);
  books.push({ id: "added-after-request", title: "나중 작품" });
  const ready = await untilSettled(f.downloads, state.id);
  assert.equal(ready.status, "ready");
  assert.equal(ready.processed, 201);
  const file = await f.downloads.bundleFile(state.id);
  const zip = await JSZip.loadAsync(await readFile(file.path));
  assert.equal(Object.keys(zip.files).length, 201);
  assert.equal(zip.file("added-after-request.txt"), null);
  assert.equal(
    await zip.file("book-200.txt").async("string"),
    "저장된 모든 본문",
  );
});

test("all-library download rejects an empty library and oversized ZIPs fail clearly", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.downloads.requestAllBundle(), { status: 400 });
  await addBook(f.store, "book");
  const oversized = join(f.rootDir, "..", "large-fixture.txt");
  await writeFile(oversized, "실제 제한 검사에 사용하는 작은 본문");
  f.downloads.maxArchiveBytes = 16; // Exercise the same size guard without a multi-gigabyte fixture.
  f.downloads.bookTxt = async () => ({
    path: oversized,
    filename: "large.txt",
  });
  const state = await f.downloads.requestAllBundle();
  const failed = await untilSettled(f.downloads, state.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /3.*GB/);
  assert.equal(await f.downloads.bundleFile(state.id), null);
});

test("book ID delimiters prevent distinct title/ID combinations from overwriting ZIP entries", async (t) => {
  const f = await fixture(t);
  await addBook(f.store, "c", { title: "a_b" });
  await addBook(f.store, "b_c", { title: "a" });
  const request = await f.downloads.requestBundle(["c", "b_c"]);
  assert.equal((await untilSettled(f.downloads, request.id)).status, "ready");
  const zip = await JSZip.loadAsync(
    await readFile((await f.downloads.bundleFile(request.id)).path),
  );
  assert.deepEqual(Object.keys(zip.files).sort(), [
    "a_[b_c].txt",
    "a_b_[c].txt",
  ]);
});

test("all download excludes metadata-only books; selected and individual empty-text exports fail clearly", async (t) => {
  const f = await fixture(t);
  await addBook(f.store, "saved");
  await f.store.upsertBook("saved", { storedChapterCount: 2 });
  await f.store.upsertBook("metadata-only", {
    title: "목차만 수집한 작품",
    storedChapterCount: 0,
    expectedChapterCount: 300,
  });
  await f.store.upsertBook("legacy-empty", { title: "오래된 빈 작품" });
  await assert.rejects(
    f.downloads.bookTxt("metadata-only"),
    (error) => error.status === 409 && error.code === "NO_STORED_TEXT",
  );
  await assert.rejects(
    f.downloads.bookTxt("legacy-empty"),
    (error) => error.status === 409 && error.code === "NO_STORED_TEXT",
  );
  await assert.rejects(f.downloads.requestBundle(["metadata-only"]), {
    status: 409,
  });
  await f.store.upsertBook("legacy-empty", { storedChapterCount: 0 });
  const request = await f.downloads.requestAllBundle();
  assert.equal(request.total, 1);
  assert.equal((await untilSettled(f.downloads, request.id)).status, "ready");
  const zip = await JSZip.loadAsync(
    await readFile((await f.downloads.bundleFile(request.id)).path),
  );
  assert.deepEqual(Object.keys(zip.files), ["작품 이름_[saved].txt"]);
  await f.store.upsertBook("saved", { storedChapterCount: 0 });
  await assert.rejects(f.downloads.requestAllBundle(), { status: 400 });
});
