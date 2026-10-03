import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderStore, validateJob } from "../src/store.mjs";
const chapters = [1, 2, 3].map((number) => ({
  id: `chapter${number}`,
  number,
  title: `${number}화`,
  url: `https://newtoki1.org/novel/30458/${number}`,
}));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "novel-ledger-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: await new FolderStore(root).init() };
}
test("full catalog and failure records survive restart, repaired text clears failures and preserves metadata", async (t) => {
  const { root, store } = await fixture(t);
  await store.writeCatalog("book30458", {
    url: "https://newtoki1.org/novel/30458",
    title: "책",
    author: "작가",
    genres: ["무협"],
    tags: ["성장"],
    expectedChapters: 3,
    chapters,
  });
  await store.writeChapter("book30458", chapters[0].id, {
    ...chapters[0],
    text: "보존 본문",
  });
  await store.recordFailure("book30458", chapters[1], {
    code: "CONTENT_MISSING",
    message: "본문 없음",
    retryable: true,
    jobId: "job123",
  });
  const first = await store.getBook("book30458");
  assert.equal(first.expectedChapterCount, 3);
  assert.equal(first.storedChapterCount, 1);
  assert.equal(first.missingChapterCount, 2);
  assert.equal(first.failureCount, 1);
  assert.deepEqual(first.genres, ["무협"]);
  const reopened = await new FolderStore(root).init();
  assert.equal((await reopened.readCatalog("book30458")).chapters.length, 3);
  assert.equal(
    (await reopened.listFailures("book30458"))[0].code,
    "CONTENT_MISSING",
  );
  const hash = (await reopened.readChapter("book30458", chapters[0].id)).hash;
  await reopened.writeChapter("book30458", chapters[1].id, {
    ...chapters[1],
    text: "복구한 본문",
  });
  assert.equal((await reopened.getBook("book30458")).storedChapterCount, 2);
  assert.equal((await reopened.getBook("book30458")).failureCount, 0);
  assert.equal(
    (await reopened.readChapter("book30458", chapters[0].id)).hash,
    hash,
  );
  assert.deepEqual(await reopened.listFailures("book30458"), []);
  await reopened.writeChapter("book30458", chapters[1].id, {
    ...chapters[1],
    text: "수정 본문",
  });
  assert.equal((await reopened.getBook("book30458")).storedChapterCount, 2);
});
test("duplicate failures count once, sanitize errors and never accept unsafe IDs or malformed catalogs", async (t) => {
  const { store } = await fixture(t);
  await store.writeCatalog("book30458", { title: "책", chapters });
  for (let i = 0; i < 2; i++)
    await store.recordFailure("book30458", chapters[2], {
      message: "Bearer hidden-token",
      code: "FAILED",
    });
  assert.equal((await store.getBook("book30458")).failureCount, 1);
  assert.match((await store.listFailures("book30458"))[0].message, /redacted/);
  await assert.rejects(store.writeCatalog("../bad", { chapters }), {
    status: 400,
  });
  await assert.rejects(
    store.writeCatalog("book30458", { chapters: [chapters[0], chapters[0]] }),
    { status: 400 },
  );
  await assert.rejects(
    store.recordFailure("book30458", { ...chapters[0], id: "../bad" }, {}),
    { status: 400 },
  );
  assert.equal(await store.clearFailure("book30458", "chapter3"), true);
  assert.equal(await store.clearFailure("book30458", "chapter3"), false);
});
test("old library entries gain saved counts and full-range job counts without changing body data", async (t) => {
  const { root, store } = await fixture(t);
  await mkdir(join(root, "books", "legacy", "chapters", "chapter1"), {
    recursive: true,
  });
  await writeFile(
    join(root, "books", "legacy", "book.json"),
    JSON.stringify({ id: "legacy", title: "기존 작품" }),
  );
  await writeFile(
    join(root, "books", "legacy", "chapters", "chapter1", "chapter.json"),
    JSON.stringify({ id: "chapter1", text: "기존 본문", hash: "untouched" }),
  );
  const job = await store.createJob({
    url: "https://newtoki1.org/novel/30458",
  });
  await store.patchJob(job.id, { bookId: "legacy", total: 3 });
  const reopened = await new FolderStore(root).init();
  const book = await reopened.getBook("legacy");
  assert.equal(book.storedChapterCount, 1);
  assert.equal(book.expectedChapterCount, 3);
  assert.equal(book.missingChapterCount, 2);
  assert.equal(
    (await reopened.readChapter("legacy", "chapter1")).hash,
    "untouched",
  );
});
test("retry flags survive validation and reject malformed selected chapter IDs", () => {
  const job = validateJob({
    url: "https://newtoki1.org/novel/30458",
    retryOnlyFailed: true,
    retryChapterIds: ["chapter1", "chapter1"],
  });
  assert.equal(job.retryOnlyFailed, true);
  assert.deepEqual(job.retryChapterIds, ["chapter1"]);
  assert.throws(() => validateJob({ url: job.url, retryOnlyFailed: "true" }), {
    status: 400,
  });
  assert.throws(
    () => validateJob({ url: job.url, retryChapterIds: ["../bad"] }),
    { status: 400 },
  );
});
