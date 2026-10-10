import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { FolderStore } from "../src/store.mjs";
import { Discovery } from "../src/discovery.mjs";
import {
  LibraryMetadata,
  normalizeWorkSource,
} from "../src/library-metadata.mjs";
import { readWorkMetadata } from "../src/collection-metadata.mjs";
const jpeg = Buffer.from([255, 216, 255, 224, 1]);

test("normal catalog profile retains the declared total before older rows expand", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "normal-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new FolderStore(root).init();
  await store.upsertBook("book", { url: "https://newtoki1.org/novel/21104" });
  const service = new LibraryMetadata({
    store,
    discovery: {
      exclusiveDetail: (task) => task(),
      openContext: async () => ({
        newPage: async () => ({
          evaluate: async (fn) =>
            fn.name === "readWorkMetadata"
              ? { title: "작품", expectedChapterCount: 376 }
              : {
                  normalCatalog: true,
                  maxPage: 1,
                  hasMore: true,
                  chapters: Array.from({ length: 100 }, (_, i) => ({
                    url: `/novel/21104/${i}`,
                  })),
                },
          close: async () => {},
        }),
      }),
      navigate: async () => {},
      registerWork: async (_, metadata) => metadata,
    },
  });
  const result = await service.hydrate("book", await store.getBook("book"));
  assert.equal(result.expectedChapterCount, 376);
});

test("work source accepts only supported canonical chapter/catalog links", () => {
  assert.equal(
    normalizeWorkSource("https://newtoki1.org/novel/63206/123?epage=2").url,
    "https://newtoki1.org/novel/63206",
  );
  for (const url of [
    "http://newtoki1.org/novel/1",
    "https://newtoki1.org.evil.com/novel/1",
    "https://user@newtoki1.org/novel/1",
    "https://newtoki1.org:444/novel/1",
    "https://newtoki1.org/novel/1/../../other",
    "https://127.0.0.1/novel/1",
  ])
    assert.throws(
      () => normalizeWorkSource(url),
      (error) => error.status === 400,
    );
});
test("registration persists only safe source metadata and preserves chapter counts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "library-metadata-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new FolderStore(join(root, "store")).init();
  const discovery = new Discovery({
    rootDir: join(root, "discovery"),
    fetchImage: async () => ({ bytes: jpeg, mimeType: "image/jpeg" }),
  });
  await store.upsertBook("book", {
    url: "https://newtoki1.org/novel/63206",
    storedChapterCount: 1,
    expectedChapterCount: 516,
  });
  const service = new LibraryMetadata({ store, discovery });
  const book = await service.register("book", {
    title: "작품",
    author: "작가",
    genres: ["무협", "무협"],
    tags: ["성장"],
    platform: "카카오페이지",
    publication: "ongoing",
    synopsis: "소개",
    thumbnailUrl: "https://apitk.peertrk.com/a.jpg",
    chapters: [{ text: "body" }],
    adminPassword: "secret",
  });
  assert.equal(book.expectedChapterCount, 516);
  assert.deepEqual(book.genres, ["무협"]);
  assert.equal(book.metadataVersion, 1);
  assert.equal(book.chapters, undefined);
  assert.equal(book.adminPassword, undefined);
  assert.ok(await service.thumbnail("book"));
  assert.equal((await service.request("book")).status, "completed");
  assert.equal((await service.state("book")).status, "completed");
  await service.close();
  await discovery.close();
});
test("hydration fetches one source page, returns pending immediately and survives restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "library-hydrate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new FolderStore(join(root, "store")).init();
  await store.upsertBook("book", {
    url: "https://newtoki1.org/novel/63206",
    storedChapterCount: 1,
    expectedChapterCount: 516,
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let visits = 0;
  const source = await readFile(
    new URL("./fixtures/work-detail-synthetic.html", import.meta.url),
    "utf8",
  );
  const dom = new JSDOM(source, { url: "https://sbxh9.com/novel/63206" });
  const discovery = new Discovery({
    rootDir: join(root, "discovery"),
    launchContext: async () => ({
      route: async () => {},
      close: async () => {},
      newPage: async () => ({
        goto: async (target) => {
          assert.equal(target, "https://sbxh9.com/novel/63206");
          visits++;
          dom.reconfigure({ url: target });
          await gate;
          return { status: () => 200 };
        },
        url: () => dom.window.document.URL,
        evaluate: async (fn) => fn(dom.window.document),
        close: async () => {},
      }),
    }),
  });
  let failure;
  const service = new LibraryMetadata({
    store,
    discovery,
    onError: (error) => {
      failure = error;
    },
  });
  assert.equal((await service.request("book")).status, "pending");
  assert.equal((await service.request("book")).status, "pending");
  assert.equal(await service.thumbnail("book"), null);
  release();
  for (
    let n = 0;
    n < 50 && (await service.state("book")).status === "pending";
    n++
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
  const result = await service.state("book");
  assert.equal(result.status, "completed", failure?.stack || result.error);
  assert.equal(result.book.expectedChapterCount, 516);
  assert.equal(result.book.url, "https://newtoki1.org/novel/63206");
  assert.equal(result.book.metadataSourceOrigin, "https://sbxh9.com");
  assert.equal(
    result.book.author,
    readWorkMetadata(dom.window.document).author,
  );
  assert.ok(result.book.thumbnailUrl);
  assert.equal(visits, 1);
  const reopened = new LibraryMetadata({ store, discovery });
  assert.equal((await reopened.request("book")).status, "completed");
  assert.equal(visits, 1);
  await reopened.close();
  await service.close();
  await discovery.close();
  dom.window.close();
});
test("one-page source establishes exact count while failures have a retry cooldown", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "library-single-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new FolderStore(join(root, "store")).init();
  await store.upsertBook("book", {
    url: "https://newtoki1.org/novel/1",
    storedChapterCount: 1,
  });
  let visits = 0,
    fail = true,
    now = Date.now();
  const discovery = new Discovery({
    rootDir: join(root, "discovery"),
    launchContext: async () => ({
      route: async () => {},
      close: async () => {},
      newPage: async () => ({
        goto: async (target) => {
          assert.equal(target, "https://sbxh9.com/novel/1");
          visits++;
          if (fail) throw new Error("temporary unavailable");
          return { status: () => 200 };
        },
        url: () => "https://sbxh9.com/novel/1",
        close: async () => {},
        evaluate: async (fn) =>
          fn.name === "readReaderDocument"
            ? { challenge: false }
            : fn.name === "readWorkMetadata"
              ? {
                  title: "x",
                  genres: [],
                  tags: [],
                  thumbnailUrl: "https://evil.example/a.svg",
                }
              : {
                  maxPage: 1,
                  chapters: [{ url: "/1" }, { url: "/2" }, { url: "/2" }],
                },
      }),
    }),
  });
  const service = new LibraryMetadata({ store, discovery, now: () => now });
  assert.equal((await service.request("book")).status, "pending");
  for (
    let n = 0;
    n < 400 && (await service.state("book")).status === "pending";
    n++
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await service.state("book")).status, "failed");
  assert.equal((await service.request("book")).status, "failed");
  assert.equal(visits, 1);
  fail = false;
  now += 10 * 60 * 1000 + 1;
  assert.equal((await service.request("book")).status, "pending");
  for (
    let n = 0;
    n < 400 && (await service.state("book")).status === "pending";
    n++
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
  const done = await service.state("book");
  assert.equal(done.status, "completed");
  assert.equal(done.book.expectedChapterCount, 2);
  assert.equal(done.book.thumbnailUrl, null);
  await service.close();
  await assert.rejects(
    service.request("book"),
    (error) => error.status === 503,
  );
  await discovery.close();
});
test("registerWork validates source identities, preserves same-cover caches and refreshes changed cover content", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "discovery-register-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let images = 0;
  const imageUrls = [];
  const discovery = new Discovery({
    rootDir: root,
    fetchImage: async (url) => {
      imageUrls.push(url);
      images++;
      if (images === 1) throw new Error("bad image");
      return {
        bytes: Buffer.from([255, 216, 255, 224, images]),
        mimeType: "image/jpeg",
      };
    },
  });
  await discovery.registerWork("1", {
    url: "https://newtoki1.org/novel/1",
    title: "x",
    thumbnailUrl: "https://apitk.peertrk.com/a.jpg",
  });
  assert.equal(await discovery.thumbnail("1"), null);
  await discovery.registerWork("1", {
    url: "https://newtoki1.org/novel/1",
    title: "x",
    thumbnailUrl: "https://apitk.peertrk.com/a.jpg",
  });
  assert.equal(await discovery.thumbnail("1"), null);
  assert.equal(images, 1, "same failed URL retains the negative retry cache");
  await discovery.registerWork("1", {
    url: "https://newtoki1.org/novel/1",
    title: "x",
    thumbnailUrl: "https://apitk.peertrk.com/b.jpg",
  });
  const previousCover = await discovery.thumbnail("1");
  assert.ok(previousCover);
  assert.deepEqual(
    await readFile(previousCover.path),
    Buffer.from([255, 216, 255, 224, 2]),
  );
  assert.equal(images, 2);
  await discovery.registerWork("1", {
    url: "https://newtoki1.org/novel/1",
    title: "updated title",
    thumbnailUrl: "https://apitk.peertrk.com/b.jpg",
  });
  const preservedCover = await discovery.thumbnail("1");
  assert.equal(preservedCover.etag, previousCover.etag);
  assert.equal(images, 2, "same successful URL preserves its image cache");
  await discovery.registerWork("1", {
    url: "https://newtoki1.org/novel/1",
    title: "x",
    thumbnailUrl: "https://apitk.peertrk.com/c.jpg",
  });
  const changedCover = await discovery.thumbnail("1");
  assert.ok(changedCover);
  assert.notEqual(changedCover.etag, previousCover.etag);
  assert.deepEqual(
    await readFile(changedCover.path),
    Buffer.from([255, 216, 255, 224, 3]),
  );
  assert.equal(
    images,
    3,
    "changed cover content must not serve the previous image",
  );
  assert.equal((await discovery.thumbnail("1")).etag, changedCover.etag);
  assert.equal(images, 3, "the new cover is fetched only once");
  assert.deepEqual(imageUrls, [
    "https://apitk.peertrk.com/a.jpg",
    "https://apitk.peertrk.com/b.jpg",
    "https://apitk.peertrk.com/c.jpg",
  ]);
  await assert.rejects(
    discovery.registerWork("1", { url: "https://newtoki1.org/novel/2" }),
    (error) => error.status === 400,
  );
  await discovery.close();
});
test("state handles persisted success/failure, absent books and bounded pending queues", async () => {
  let now = Date.now();
  const books = new Map([
    [
      "fresh",
      {
        id: "fresh",
        url: "https://newtoki1.org/novel/1",
        metadataVersion: 1,
        metadataSourceOrigin: "https://sbxh9.com",
        metadataFetchedAt: new Date(now).toISOString(),
      },
    ],
    [
      "failed",
      {
        id: "failed",
        url: "https://newtoki1.org/novel/2",
        metadataFetchFailedAt: new Date(now).toISOString(),
        metadataFetchError: "원본 조회 실패",
      },
    ],
    ["new", { id: "new", url: "https://newtoki1.org/novel/3" }],
  ]);
  const store = { getBook: async (id) => books.get(id) || null };
  const service = new LibraryMetadata({
    store,
    discovery: { registerWork: async () => {} },
    now: () => now,
  });
  assert.equal((await service.state("fresh")).status, "completed");
  assert.equal((await service.state("failed")).error, "원본 조회 실패");
  assert.equal((await service.request("failed")).status, "failed");
  assert.equal((await service.state("new")).status, "failed");
  await assert.rejects(
    service.request("missing"),
    (error) => error.status === 404,
  );
  for (let n = 0; n < 50; n++)
    service.states.set(String(n), { status: "pending", updatedAt: now });
  await assert.rejects(service.request("new"), (error) => error.status === 429);
  service.states.set("old", {
    status: "completed",
    updatedAt: now - 24 * 60 * 60 * 1000 - 1,
  });
  service.prune();
  assert.equal(service.states.has("old"), false);
  await service.close();
});
test("sparse source detail preserves known listing platform, tags and cover metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "library-known-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new FolderStore(join(root, "store")).init();
  await store.upsertBook("book", {
    url: "https://newtoki1.org/novel/63206",
    author: "기존작가",
    genres: ["무협"],
    tags: ["성장"],
    publication: "ongoing",
  });
  const discovery = new Discovery({
    rootDir: join(root, "discovery"),
    fetchImage: async () => ({ bytes: jpeg, mimeType: "image/jpeg" }),
  });
  await discovery.registerWork("63206", {
    url: "https://newtoki1.org/novel/63206",
    title: "작품",
    platform: "카카오페이지",
    tags: ["천재"],
    thumbnailUrl: "https://apitk.peertrk.com/a.jpg",
  });
  const service = new LibraryMetadata({ store, discovery });
  const book = await service.register("book", {
    title: "작품",
    platform: "",
    genres: [],
    tags: [],
    author: "",
    publication: "unknown",
    thumbnailUrl: null,
  });
  assert.equal(book.platform, "카카오페이지");
  assert.equal(book.author, "기존작가");
  assert.deepEqual(book.genres, ["무협"]);
  assert.deepEqual(book.tags, ["성장"]);
  assert.equal(book.publication, "ongoing");
  assert.ok(await service.thumbnail("book"));
  const fresh = await discovery.registerWork("63206", {
    url: "https://newtoki1.org/novel/63206",
    platform: "",
    tags: [],
    thumbnailUrl: null,
  });
  assert.equal(fresh.platform, "카카오페이지");
  assert.ok(fresh.thumbnail);
  await service.close();
  await discovery.close();
});
test("site holds and backoff defer metadata without failure cooldown and retry immediately after release", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "library-deferred-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new FolderStore(join(root, "store")).init();
  await store.upsertBook("book", {
    url: "https://newtoki1.org/novel/1",
    expectedChapterCount: 10,
  });
  let held = true,
    backoffActive = false,
    visits = 0;
  const discovery = new Discovery({
    rootDir: join(root, "discovery"),
    publicMetadata: false,
    attention: { isHeld: () => held, snapshot: () => ({ sites: [] }) },
    backoff: { snapshot: () => ({ active: backoffActive }) },
    launchContext: async () => ({
      route: async () => {},
      close: async () => {},
      newPage: async () => ({
        goto: async () => {
          visits++;
          return { status: () => 200 };
        },
        url: () => "https://sbxh9.com/novel/1",
        close: async () => {},
        evaluate: async (fn) =>
          fn.name === "readReaderDocument"
            ? { challenge: false }
            : fn.name === "readWorkMetadata"
              ? { title: "작품", genres: [], tags: [] }
              : { maxPage: 2, chapters: [{ url: "/1" }] },
      }),
    }),
  });
  const service = new LibraryMetadata({ store, discovery });
  const heldResult = await service.request("book");
  assert.equal(heldResult.status, "deferred");
  assert.equal(heldResult.code, "SITE_VERIFICATION_REQUIRED");
  assert.equal((await store.getBook("book")).metadataFetchFailedAt, undefined);
  assert.equal(visits, 0);
  held = false;
  backoffActive = true;
  assert.equal((await service.request("book")).code, "REQUEST_BACKOFF");
  assert.equal((await store.getBook("book")).metadataFetchFailedAt, undefined);
  backoffActive = false;
  assert.equal((await service.request("book")).status, "pending");
  for (
    let n = 0;
    n < 400 && (await service.state("book")).status === "pending";
    n++
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await service.state("book")).status, "completed");
  assert.equal(visits, 1);
  assert.equal((await store.getBook("book")).expectedChapterCount, 10);
  await service.close();
  await discovery.close();
});
test("a legacy library cover already cached remains visible during site authentication", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "library-held-cover-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new FolderStore(join(root, "store")).init();
  let held = false,
    images = 0;
  const discovery = new Discovery({
    rootDir: join(root, "discovery"),
    publicMetadata: false,
    attention: { isHeld: () => held, snapshot: () => ({ sites: [] }) },
    fetchImage: async () => {
      images++;
      return { bytes: jpeg, mimeType: "image/jpeg" };
    },
  });
  await discovery.registerWork("1", {
    url: "https://newtoki1.org/novel/1",
    thumbnailUrl: "https://apitk.peertrk.com/a.jpg",
  });
  await discovery.thumbnail("1");
  await store.upsertBook("book", {
    url: "https://newtoki1.org/novel/1",
    metadataVersion: 0,
  });
  held = true;
  const service = new LibraryMetadata({ store, discovery });
  assert.ok(await service.thumbnail("book"));
  assert.equal(images, 1);
  assert.equal((await service.state("book")).status, "deferred");
  assert.equal((await store.getBook("book")).metadataFetchFailedAt, undefined);
  await service.close();
  await discovery.close();
});
