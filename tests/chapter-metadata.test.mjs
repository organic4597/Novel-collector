import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderStore } from "../src/store.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "collector-metadata-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new FolderStore(root).init();
  await store.writeChapter("book1", "chapter1", {
    number: 1,
    title: "첫 회차",
    url: "https://newtoki1.org/novel/1/11",
    text: "보존할 본문 ".repeat(1000),
  });
  return { store, root };
}

test("new chapter lists use metadata without reading saved body, preserving legacy API shape", async (t) => {
  const { store } = await fixture(t);
  const original = await store.readChapter("book1", "chapter1");
  store.readChapter = async () => {
    throw new Error("body must not be read");
  };
  const rows = await store.listChapterMetadata("book1");
  const { text, ...expected } = original;
  assert.deepEqual(rows, [expected]);
  assert.deepEqual(await store.listChapters("book1"), rows);
  assert.equal("text" in rows[0], false);
});

test("legacy chapter metadata is migrated once and persisted across restarts", async (t) => {
  const { store, root } = await fixture(t);
  await unlink(
    store.path("books", "book1", "chapters", "chapter1", "metadata.json"),
  );
  let reads = 0;
  const read = store.readChapter.bind(store);
  store.readChapter = async (...args) => {
    reads++;
    return read(...args);
  };
  const rows = await store.listChapters("book1");
  assert.equal(reads, 1);
  await store.listChapters("book1");
  assert.equal(reads, 1);
  const reopened = await new FolderStore(root).init();
  reopened.readChapter = async () => {
    throw new Error("body must not be read");
  };
  assert.deepEqual(await reopened.listChapterMetadata("book1"), rows);
});

test("stale metadata is refreshed after a body replacement and overwrites preserve counts", async (t) => {
  const { store } = await fixture(t);
  const path = store.path(
    "books",
    "book1",
    "chapters",
    "chapter1",
    "chapter.json",
  );
  const original = JSON.parse(await readFile(path, "utf8"));
  const replacement = {
    ...original,
    text: "다른 본문",
    size: Buffer.byteLength("다른 본문"),
    hash: "new-hash",
  };
  await writeFile(path, JSON.stringify(replacement));
  const rows = await store.listChapterMetadata("book1");
  assert.equal(rows[0].hash, "new-hash");
  assert.equal(rows[0].size, replacement.size);
  await store.writeChapter("book1", "chapter1", {
    ...original,
    text: "다시 저장",
  });
  assert.equal((await store.getBook("book1")).storedChapterCount, 1);
  assert.equal(
    (await store.listChapters("book1"))[0].size,
    Buffer.byteLength("다시 저장"),
  );
});

test("removed chapter files never appear through cached metadata", async (t) => {
  const { store } = await fixture(t);
  await unlink(
    store.path("books", "book1", "chapters", "chapter1", "chapter.json"),
  );
  assert.deepEqual(await store.listChapterMetadata("book1"), []);
});
