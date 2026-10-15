import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { deflateSync } from "node:zlib";
import { FolderStore } from "../src/store.mjs";
import { webtoonImageInfo } from "../src/webtoon-images.mjs";
import { ReaderImages, READER_PROFILE } from "../src/reader-images.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function chunk(type, bytes) {
  const body = Buffer.concat([Buffer.from(type), bytes]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const output = Buffer.alloc(bytes.length + 12);
  output.writeUInt32BE(bytes.length); body.copy(output, 4); output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
  return output;
}
function png(width, height, { depth = 8, extra = [] } = {}) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = depth; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 * (depth / 8) + 1) * height);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), ...extra, chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
// Cache tests validate the renderer boundary; decoding and visual quality have separate processor tests.
function webp(width, height, animated = false) {
  const bytes = Buffer.alloc(30); bytes.write("RIFF"); bytes.writeUInt32LE(22, 4); bytes.write("WEBPVP8X", 8); bytes.writeUInt32LE(10, 16);
  bytes[20] = animated ? 2 : 0; bytes.writeUIntLE(width - 1, 24, 3); bytes.writeUIntLE(height - 1, 27, 3);
  return bytes;
}
function jpeg(width, height, exif = false) {
  const frame = Buffer.from([255,192,0,17,8,0,0,0,0,3,1,17,0,2,17,0,3,17,0]);
  frame.writeUInt16BE(height, 5); frame.writeUInt16BE(width, 7);
  const app1 = exif ? Buffer.from([255,225,0,8,69,120,105,102,0,0]) : Buffer.alloc(0);
  return Buffer.concat([Buffer.from([255,216]), app1, frame, Buffer.from([255,218,0,12,3,1,0,2,17,3,17,0,63,0,255,217])]);
}
async function rendered({ directory, image }) {
  const scale = Math.min(1, 1280 / image.width), width = Math.min(image.width, 1280), height = Math.round(image.height * scale), parts = [];
  for (let top = 0; top < height; top += 2048) {
    const tileHeight = Math.min(2048, height - top), filename = `${parts.length + 1}.webp`, bytes = webp(width, tileHeight);
    await writeFile(join(directory, filename), bytes);
    parts.push({ filename, width, height: tileHeight, bytes: bytes.length, sha256: hash(bytes) });
  }
  return parts;
}
async function saveChapter(store, bytes = png(2000, 7003), id = "chapter", override = {}) {
  const info = webtoonImageInfo(bytes), extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[info.mimeType];
  const filename = `0001-${info.sha256.slice(0, 16)}.${extension}`, directory = store.path("books", "book", "chapters", id);
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, filename), bytes);
  const images = [{ index: 1, filename, ...info, ...override }];
  await store.writeWebtoonChapter("book", id, { number: 1, title: "Synthetic chapter", url: `https://sbxh9.com/webtoon/book/${id}`, contentType: "webtoon", complete: true, expectedImages: 1, savedImages: 1, images, hash: hash(JSON.stringify(images)), size: bytes.length });
  return store.readChapter("book", id);
}
async function fixture(t, { bytes, render = rendered, timeoutMs } = {}) {
  const root = await mkdtemp(join(tmpdir(), "reader-images-")), store = await new FolderStore(root).init();
  await store.upsertBook("book", { title: "Synthetic book", contentType: "webtoon" });
  const chapter = await saveChapter(store, bytes), readers = [];
  const open = (options = {}) => { const reader = new ReaderImages({ store, render, ...(timeoutMs ? { timeoutMs } : {}), ...options }); readers.push(reader); return reader; };
  const reader = open();
  t.after(async () => { for (const item of readers) await item.close(); await rm(root, { recursive: true, force: true }); });
  return { root, store, chapter, reader, open, source: store.path("books", "book", "chapters", chapter.id, chapter.images[0].filename) };
}
const file = (f, reader = f.reader, chapter = f.chapter) => reader.file("book", chapter, chapter.images[0].sha256, READER_PROFILE, 1);
const cacheDirectory = f => f.store.path("books", "book", "chapters", f.chapter.id, ".viewer", READER_PROFILE, f.chapter.images[0].sha256);
async function assertNoVariant(f) { await assert.rejects(stat(cacheDirectory(f)), { code: "ENOENT" }); }

test("manifest computes exact scaled geometry and last tile without encoding", async t => {
  let calls = 0;
  const f = await fixture(t, { render: async options => { calls++; return rendered(options); } });
  const manifest = await f.reader.manifest("book", f.chapter), image = manifest.images[0], sha = f.chapter.images[0].sha256;
  assert.equal(READER_PROFILE, "v1-w1280-h2048-q90");
  assert.equal(manifest.revision, f.chapter.hash); assert.equal(manifest.profile, READER_PROFILE);
  assert.equal(image.index, 1); assert.equal(image.originalUrl, `/api/books/book/chapters/chapter/images/1?v=${sha}`);
  assert.deepEqual(image.parts.map(({ width, height }) => [width, height]), [[1280,2048],[1280,2048],[1280,386]]);
  assert.equal(image.parts.reduce((sum, part) => sum + part.height, 0), Math.round(7003 * 1280 / 2000));
  assert.ok(image.parts.every((part, index) => part.url === `/api/books/book/chapters/chapter/viewer/${sha}/${READER_PROFILE}/${index + 1}.webp`));
  assert.equal(calls, 0); await assertNoVariant(f);
});

test("tall narrow images keep their width and the 4096-pixel threshold passes through", async t => {
  const f = await fixture(t, { bytes: png(800, 5001) });
  const manifest = await f.reader.manifest("book", f.chapter);
  assert.deepEqual(manifest.images[0].parts.map(({ width, height }) => [width, height]), [[800,2048],[800,2048],[800,905]]);
  const boundary = await saveChapter(f.store, png(1280, 4096), "boundary"), original = (await f.reader.manifest("book", boundary)).images[0];
  assert.deepEqual(original.parts, [{ url: original.originalUrl, width: 1280, height: 4096 }]);
});

test("small images and formats with animation or preserved metadata use original bytes", async t => {
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  gif.writeUInt16LE(2000, 6); gif.writeUInt16LE(8000, 8);
  const animation = Buffer.alloc(8); animation.writeUInt32BE(2);
  const cases = [png(640, 800), gif, webp(2000, 8000, true), png(1400, 80, { depth: 16 }), png(1400, 80, { extra: [chunk("acTL", animation)] }), png(1400, 80, { extra: [chunk("iCCP", Buffer.concat([Buffer.from("synthetic\0\0"), deflateSync(Buffer.from("profile"))]))] }), png(1400, 80, { extra: [chunk("eXIf", Buffer.from("Exif\0\0"))] })];
  const f = await fixture(t, { render: () => { throw Error("preserved originals must not be rendered"); } });
  for (const [index, bytes] of cases.entries()) {
    const chapter = await saveChapter(f.store, bytes, `preserve-${index}`), manifest = await f.reader.manifest("book", chapter), image = manifest.images[0], info = webtoonImageInfo(bytes);
    assert.deepEqual(image.parts, [{ url: image.originalUrl, width: info.width, height: info.height }]);
  }
});

test("large baseline JPEG uses viewer tiles while EXIF APP1 JPEG preserves the original", async t => {
  let calls = 0;
  const f = await fixture(t, { bytes: jpeg(2000, 7003), render: async options => { calls++; return rendered(options); } });
  const image = (await f.reader.manifest("book", f.chapter)).images[0];
  assert.equal(f.chapter.images[0].mimeType, "image/jpeg"); assert.match(f.chapter.images[0].filename, /\.jpg$/);
  assert.deepEqual(image.parts.map(({ width, height }) => [width,height]), [[1280,2048],[1280,2048],[1280,386]]);
  assert.ok(image.parts.every(part => part.url.endsWith(".webp")));
  const exif = await saveChapter(f.store, jpeg(2000, 7003, true), "exif-jpeg"), preserved = (await f.reader.manifest("book", exif)).images[0];
  assert.deepEqual(preserved.parts, [{ url: preserved.originalUrl, width: 2000, height: 7003 }]); assert.equal(calls, 0);
  assert.equal((await file(f)).mimeType, "image/webp"); assert.equal(calls, 1);
});

test("concurrent requests share one conversion and the disk cache survives reopen", async t => {
  let calls = 0;
  const entered = deferred(), release = deferred();
  const render = async options => { calls++; entered.resolve(); await release.promise; return rendered(options); };
  const f = await fixture(t, { render }), requests = [file(f), file(f), file(f)];
  await entered.promise; assert.equal(calls, 1); release.resolve();
  const files = await Promise.all(requests), first = files[0], before = await stat(first.path);
  assert.ok(files.every(item => item.path === first.path)); assert.equal(first.mimeType, "image/webp");
  assert.equal(first.size, (await readFile(first.path)).length); assert.match(first.etag, /^"[a-f0-9]{64}"$/);
  assert.equal(relative(cacheDirectory(f), first.path), "1.webp");
  assert.ok((await readFile(join(cacheDirectory(f), "manifest.json"))).length > 0);
  await f.reader.close();
  const reopenedStore = await new FolderStore(f.root).init(), reopened = f.open({ store: reopenedStore });
  const cached = await file(f, reopened);
  assert.equal(cached.path, first.path); assert.equal((await stat(cached.path)).mtimeMs, before.mtimeMs); assert.equal(calls, 1);
});

test("different image variants are rendered one at a time", async t => {
  let active = 0, maximum = 0, calls = 0;
  const render = async options => { calls++; active++; maximum = Math.max(maximum, active); try { await new Promise(resolve => setTimeout(resolve, 15)); return await rendered(options); } finally { active--; } };
  const f = await fixture(t, { render }), second = await saveChapter(f.store, png(1800, 5000), "second");
  await Promise.all([file(f), file(f, f.reader, second)]);
  assert.equal(calls, 2); assert.equal(maximum, 1);
});

test("conversion queue rejects overflow while allowing accepted requests to finish", { timeout: 3000 }, async t => {
  const entered = deferred(), release = deferred(), overflow = deferred();
  const f = await fixture(t, { render: async options => { entered.resolve(); await release.promise; return rendered(options); } });
  const chapters = [f.chapter];
  for (let index = 1; index < 10; index++) chapters.push(await saveChapter(f.store, png(1300 + index, 10), `queued-${index}`));
  const first = file(f); await entered.promise;
  const queued = chapters.slice(1).map(chapter => file(f, f.reader, chapter).then(value => ({ value }), error => { overflow.resolve(error); return { error }; }));
  let timer;
  try {
    const error = await Promise.race([overflow.promise, new Promise(resolve => { timer = setTimeout(() => resolve(null), 500); })]);
    assert.ok(error, "the bounded queue must reject excess work before conversion completes");
    assert.ok([429,503].includes(error.status));
  } finally { clearTimeout(timer); release.resolve(); await first; await Promise.all(queued); }
});

test("corrupt tiles are rebuilt once and original file bytes stay unchanged", async t => {
  let calls = 0;
  const f = await fixture(t, { render: async options => { calls++; return rendered(options); } }), original = await readFile(f.source), first = await file(f);
  await writeFile(first.path, "corrupt tile");
  const rebuilt = await file(f, f.open());
  assert.equal(rebuilt.path, first.path); assert.equal(calls, 2); assert.equal(webtoonImageInfo(await readFile(rebuilt.path)).mimeType, "image/webp");
  assert.deepEqual(await readFile(f.source), original);
});

test("source bytes must match recorded SHA before rendering", async t => {
  let calls = 0;
  const f = await fixture(t, { render: async options => { calls++; return rendered(options); } });
  await writeFile(f.source, png(2001, 7003));
  await assert.rejects(file(f), { status: 409 }); assert.equal(calls, 0); await assertNoVariant(f);
});

test("overwriting a chapter invalidates both old manifest objects and old source URLs", async t => {
  const f = await fixture(t); await file(f);
  const current = await saveChapter(f.store, png(1800, 5000));
  await assert.rejects(file(f), { status: 409 });
  await assert.rejects(f.reader.file("book", current, f.chapter.images[0].sha256, READER_PROFILE, 1), { status: 409 });
  assert.equal((await f.reader.manifest("book", current)).revision, current.hash);
});

test("failed rendering cleans partial output and the next request can retry", async t => {
  let calls = 0;
  const render = async options => { calls++; if (calls === 1) { await writeFile(join(options.directory, "1.webp"), webp(1280, 2048)); throw Error("synthetic conversion failure"); } return rendered(options); };
  const f = await fixture(t, { render }), original = await readFile(f.source);
  await assert.rejects(file(f), /synthetic conversion failure/); await assertNoVariant(f);
  await file(f); assert.equal(calls, 2); assert.deepEqual(await readFile(f.source), original);
});

test("renderer metadata mismatch cannot publish a cache", async t => {
  const f = await fixture(t, { render: async options => (await rendered(options)).map(part => ({ ...part, sha256: "0".repeat(64) })) });
  await assert.rejects(file(f)); await assertNoVariant(f);
});

test("timeout aborts conversion, leaves no cache and preserves the source", { timeout: 3000 }, async t => {
  let aborted = false;
  const render = async (_options, { signal }) => new Promise((_resolve, reject) => { signal.addEventListener("abort", () => { aborted = true; reject(signal.reason || Error("aborted")); }, { once: true }); });
  const f = await fixture(t, { render, timeoutMs: 30 }), original = await readFile(f.source);
  await assert.rejects(file(f)); assert.equal(aborted, true); await assertNoVariant(f); assert.deepEqual(await readFile(f.source), original);
});

test("close cancels in-flight conversion and no variant is published", { timeout: 3000 }, async t => {
  const entered = deferred();
  const render = async (_options, { signal }) => new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason || Error("aborted")), { once: true }); entered.resolve(); });
  const f = await fixture(t, { render }), rejected = assert.rejects(file(f));
  await entered.promise; await f.reader.close(); await rejected; await assertNoVariant(f);
});

test("deleting a book during conversion cannot recreate its chapter or cache", { timeout: 3000 }, async t => {
  const entered = deferred(), release = deferred();
  const render = async options => { const parts = await rendered(options); entered.resolve(); await release.promise; return parts; };
  const f = await fixture(t, { render }), rejected = assert.rejects(file(f));
  await entered.promise; await rm(f.store.path("books", "book"), { recursive: true, force: true }); release.resolve(); await rejected;
  await assert.rejects(stat(f.store.path("books", "book")), { code: "ENOENT" });
  assert.deepEqual(await readdir(f.store.path("books")), []);
});

test("invalid cache identifiers and tile numbers cannot escape the chapter directory", async t => {
  let calls = 0;
  const f = await fixture(t, { render: async options => { calls++; return rendered(options); } });
  for (const [sha, profile, part] of [["../secret", READER_PROFILE, 1], [f.chapter.images[0].sha256, "../secret", 1], [f.chapter.images[0].sha256, READER_PROFILE, "../1"], [f.chapter.images[0].sha256, READER_PROFILE, 0], [f.chapter.images[0].sha256, READER_PROFILE, 4]]) {
    await assert.rejects(f.reader.file("book", f.chapter, sha, profile, part), error => [400,404,409].includes(error.status));
  }
  assert.equal(calls, 0); await assertNoVariant(f);
});
