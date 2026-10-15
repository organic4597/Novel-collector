import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import JSZip from "jszip";
import { FolderStore } from "../src/store.mjs";
import { LibraryDownloads } from "../src/library-downloads.mjs";
import { webtoonImageInfo } from "../src/webtoon-images.mjs";
import { ReaderImages, READER_PROFILE } from "../src/reader-images.mjs";
import { createApp } from "../src/server.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const chapterPath = "/api/books/book/chapters/chapter";
function chunk(type, bytes) {
  const body = Buffer.concat([Buffer.from(type), bytes]); let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  const output = Buffer.alloc(bytes.length + 12); output.writeUInt32BE(bytes.length); body.copy(output, 4); output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
  return output;
}
function png(width = 2000, height = 7003) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.alloc((width * 3 + 1) * height))), chunk("IEND", Buffer.alloc(0))]);
}
async function render({ directory, image }) {
  const width = Math.min(image.width, 1280), height = Math.round(image.height * Math.min(1, 1280 / image.width)), parts = [];
  for (let top = 0; top < height; top += 2048) {
    const tileHeight = Math.min(2048, height - top), filename = `${parts.length + 1}.webp`, bytes = Buffer.alloc(30);
    bytes.write("RIFF"); bytes.writeUInt32LE(22, 4); bytes.write("WEBPVP8X", 8); bytes.writeUInt32LE(10, 16); bytes.writeUIntLE(width - 1, 24, 3); bytes.writeUIntLE(tileHeight - 1, 27, 3);
    await writeFile(join(directory, filename), bytes); parts.push({ filename, width, height: tileHeight, bytes: bytes.length, sha256: hash(bytes) });
  }
  return parts;
}
async function saveChapter(store, bytes) {
  const info = webtoonImageInfo(bytes), filename = `0001-${info.sha256.slice(0,16)}.png`, directory = store.path("books", "book", "chapters", "chapter");
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, filename), bytes);
  const images = [{ index: 1, filename, ...info }];
  await store.writeWebtoonChapter("book", "chapter", { number: 1, title: "Synthetic chapter", url: "https://sbxh9.com/webtoon/book/chapter", contentType: "webtoon", complete: true, expectedImages: 1, savedImages: 1, images, hash: hash(JSON.stringify(images)), size: bytes.length });
  return store.readChapter("book", "chapter");
}
async function fixture(t, bytes = png()) {
  const root = await mkdtemp(join(tmpdir(), "reader-http-")), store = await new FolderStore(join(root, "data")).init();
  await store.upsertBook("book", { title: "Synthetic book", contentType: "webtoon" });
  const chapter = await saveChapter(store, bytes); let conversions = 0;
  const readerImages = new ReaderImages({ store, render: async options => { conversions++; return render(options); } }), downloads = new LibraryDownloads({ store, rootDir: join(root, "downloads") });
  const app = createApp({ store, scheduler: {}, readerImages, downloads, adminPassword: "synthetic-reader-password" });
  await new Promise(resolve => app.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.address().port}`, request = (path, options = {}) => fetch(base + path, options);
  t.after(async () => { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); await readerImages.close(); await downloads.close(); await rm(root, { recursive: true, force: true }); });
  const login = await request("/api/login", { method: "POST", body: JSON.stringify({ password: "synthetic-reader-password" }) });
  assert.equal(login.status, 200);
  const headers = { Cookie: login.headers.get("set-cookie").split(";")[0] };
  return { root, store, chapter, bytes, readerImages, downloads, request, headers, conversions: () => conversions };
}
const tilePath = (f, sha = f.chapter.images[0].sha256, part = 1) => `${chapterPath}/viewer/${sha}/${READER_PROFILE}/${part}.webp`;
async function manifest(f) { const response = await f.request(`${chapterPath}/viewer`, { headers: f.headers }); assert.equal(response.status, 200); return response.json(); }

test("index HTML links a fingerprinted reader script that the static router serves", async t => {
  const f = await fixture(t, png(1, 1)), index = await f.request("/index.html");
  assert.equal(index.status, 200);
  const html = await index.text(), scriptPath = html.match(/<script\b[^>]*\bsrc="(\/reader-images\.js\?v=[a-f0-9]{64})"/i)?.[1];
  assert.ok(scriptPath, "index.html must load the reader script with its content fingerprint");
  const response = await f.request(scriptPath);
  assert.equal(response.status, 200); assert.match(response.headers.get("content-type"), /^text\/javascript/);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(bytes, await readFile(new URL("../public/reader-images.js", import.meta.url)));
  assert.equal(new URL(scriptPath, "http://fixture.invalid").searchParams.get("v"), hash(bytes));
});

test("manhwa chapters provide the same viewer manifest, tile and original image routes", async t => {
  const f = await fixture(t);
  await f.store.upsertBook("book", { contentType: "manhwa" });
  await f.store.writeWebtoonChapter("book", "chapter", { ...f.chapter, contentType: "manhwa", url: "https://sbxh9.com/manhwa/book/chapter" });
  const chapterResponse = await f.request(chapterPath, { headers: f.headers });
  assert.equal(chapterResponse.status, 200);
  const chapter = await chapterResponse.json(), viewer = await manifest(f);
  assert.equal(chapter.contentType, "manhwa"); assert.deepEqual(chapter.viewer, viewer);
  assert.deepEqual(viewer.images[0].parts.map(({ width, height }) => [width,height]), [[1280,2048],[1280,2048],[1280,386]]);
  const tile = await f.request(viewer.images[0].parts[0].url, { headers: f.headers });
  assert.equal(tile.status, 200); assert.match(tile.headers.get("content-type"), /^image\/webp/); assert.equal((await tile.arrayBuffer()).byteLength, 30);
  const original = await f.request(viewer.images[0].originalUrl, { headers: f.headers });
  assert.equal(original.status, 200); assert.deepEqual(Buffer.from(await original.arrayBuffer()), f.bytes); assert.equal(f.conversions(), 1);
});

test("chapter and viewer manifests share geometry and defer conversion until a tile is fetched", async t => {
  const f = await fixture(t), response = await f.request(chapterPath, { headers: f.headers });
  assert.equal(response.status, 200); const chapter = await response.json(), viewer = await manifest(f);
  assert.equal(chapter.id, f.chapter.id); assert.equal(chapter.hash, f.chapter.hash); assert.deepEqual(chapter.images, f.chapter.images);
  assert.deepEqual(chapter.viewer, viewer); assert.equal(viewer.revision, f.chapter.hash); assert.equal(viewer.profile, READER_PROFILE);
  assert.deepEqual(viewer.images[0].parts.map(({ width, height }) => [width,height]), [[1280,2048],[1280,2048],[1280,386]]);
  assert.equal(f.conversions(), 0);
});

test("tile GET, HEAD and weak/list/star conditional requests return consistent private cache headers", async t => {
  const f = await fixture(t), path = (await manifest(f)).images[0].parts[0].url, response = await f.request(path, { headers: f.headers });
  assert.equal(response.status, 200); assert.match(response.headers.get("content-type"), /^image\/webp/);
  assert.match(response.headers.get("cache-control"), /private/); assert.match(response.headers.get("cache-control"), /no-cache/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const etag = response.headers.get("etag"), bytes = Buffer.from(await response.arrayBuffer());
  assert.match(etag, /^"[a-f0-9]{64}"$/); assert.equal(bytes.length, 30); assert.equal(response.headers.get("content-length"), String(bytes.length));
  const head = await f.request(path, { method: "HEAD", headers: f.headers });
  assert.equal(head.status, 200); assert.equal(head.headers.get("etag"), etag); assert.equal(head.headers.get("content-length"), String(bytes.length)); assert.equal((await head.arrayBuffer()).byteLength, 0);
  for (const value of [etag, `W/${etag}`, `"another", W/${etag}`, "*"]) {
    const cached = await f.request(path, { headers: { ...f.headers, "If-None-Match": value } });
    assert.equal(cached.status, 304, value); assert.equal(cached.headers.get("etag"), etag); assert.equal((await cached.arrayBuffer()).byteLength, 0); assert.match(cached.headers.get("cache-control"), /private/);
  }
  const fresh = await f.request(path, { headers: { ...f.headers, "If-None-Match": '"different"' } });
  assert.equal(fresh.status, 200); await fresh.arrayBuffer(); assert.equal(f.conversions(), 1);
});

test("authentication is required before HEAD and If-None-Match can observe a cached tile", async t => {
  const f = await fixture(t), first = await f.request(tilePath(f), { headers: f.headers }), etag = first.headers.get("etag");
  assert.equal(first.status, 200); await first.arrayBuffer();
  for (const path of [tilePath(f), `${chapterPath}/images/1?v=${f.chapter.images[0].sha256}`, `${chapterPath}/viewer`]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await f.request(path, { method, headers: { "If-None-Match": etag } });
      assert.equal(response.status, 401, `${method} ${path}`); assert.equal(response.headers.get("etag"), null);
    }
  }
});

test("original image URLs preserve source bytes and support authenticated conditional requests", async t => {
  const f = await fixture(t), sha = f.chapter.images[0].sha256, path = `${chapterPath}/images/1?v=${sha}`;
  const first = await f.request(path, { headers: f.headers });
  assert.equal(first.status, 200); assert.equal(first.headers.get("etag"), `"${sha}"`); assert.match(first.headers.get("cache-control"), /private.*no-cache/);
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), f.bytes);
  const head = await f.request(path, { method: "HEAD", headers: f.headers });
  assert.equal(head.status, 200); assert.equal(head.headers.get("etag"), `"${sha}"`); assert.equal((await head.arrayBuffer()).byteLength, 0);
  for (const value of [`"${sha}"`, `W/"${sha}"`, `"other", W/"${sha}"`, "*"]) {
    const cached = await f.request(path, { headers: { ...f.headers, "If-None-Match": value } }); assert.equal(cached.status, 304); assert.equal((await cached.arrayBuffer()).byteLength, 0);
  }
  const legacy = await f.request(`${chapterPath}/images/1`, { headers: f.headers }); assert.equal(legacy.status, 200); assert.deepEqual(Buffer.from(await legacy.arrayBuffer()), f.bytes);
  assert.equal((await f.request(`${chapterPath}/images/1?v=${"0".repeat(64)}`, { headers: f.headers })).status, 409);
  assert.equal(f.conversions(), 0);
});

test("small source manifest parts point at the versioned original endpoint", async t => {
  const f = await fixture(t, png(800, 900)), viewer = await manifest(f), image = viewer.images[0];
  assert.equal(image.originalUrl, `${chapterPath}/images/1?v=${f.chapter.images[0].sha256}`);
  assert.deepEqual(image.parts, [{ url: image.originalUrl, width: 800, height: 900 }]);
  const response = await f.request(image.parts[0].url, { headers: f.headers }); assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes); assert.equal(f.conversions(), 0);
});

test("stale source hashes return conflict even when a conditional request matches an old tile", async t => {
  const f = await fixture(t), old = await f.request(tilePath(f), { headers: f.headers }), etag = old.headers.get("etag");
  assert.equal(old.status, 200); await old.arrayBuffer();
  const current = await saveChapter(f.store, png(1800, 5000));
  assert.notEqual(current.images[0].sha256, f.chapter.images[0].sha256);
  for (const path of [tilePath(f), `${chapterPath}/images/1?v=${f.chapter.images[0].sha256}`]) {
    const response = await f.request(path, { headers: { ...f.headers, "If-None-Match": etag } }); assert.equal(response.status, 409);
  }
  const viewer = await manifest(f); assert.equal(viewer.revision, current.hash); assert.match(viewer.images[0].parts[0].url, new RegExp(current.images[0].sha256));
});

test("malformed and encoded traversal requests never expose cache files or convert images", async t => {
  const f = await fixture(t), sha = f.chapter.images[0].sha256;
  const paths = [`${chapterPath}/viewer/%2e%2e%2fsecret/${READER_PROFILE}/1.webp`, `${chapterPath}/viewer/${sha}/%2e%2e%2fsecret/1.webp`, `${chapterPath}/viewer/${sha}/${READER_PROFILE}/%2e%2e%2fsecret.webp`, `${chapterPath}/viewer/${sha}/${READER_PROFILE}/0.webp`, `${chapterPath}/viewer/${sha}/${READER_PROFILE}/4.webp`, `${chapterPath}/viewer/${sha}/${READER_PROFILE}/1.png`, `${chapterPath}/images/%2e%2e%2fsecret`];
  for (const path of paths) {
    const response = await f.request(path, { headers: f.headers }); assert.ok([400,404].includes(response.status), `${path}: ${response.status}`);
  }
  assert.equal(f.conversions(), 0);
});

test("viewer cache generation leaves downloaded CBZ/ZIP original image entries unchanged", async t => {
  const f = await fixture(t), beforeCbz = await f.downloads.chapterCbz("book", "chapter"), beforeZip = await f.downloads.bookZip("book");
  const cbzHash = hash(await readFile(beforeCbz.path)), zipHash = hash(await readFile(beforeZip.path));
  const tile = await f.request(tilePath(f), { headers: f.headers }); assert.equal(tile.status, 200); await tile.arrayBuffer();
  const cbzResponse = await f.request(`${chapterPath}/cbz`, { headers: f.headers }), zipResponse = await f.request("/api/books/book/export/zip", { headers: f.headers });
  assert.equal(cbzResponse.status, 200); assert.equal(zipResponse.status, 200);
  const cbzBytes = Buffer.from(await cbzResponse.arrayBuffer()), zipBytes = Buffer.from(await zipResponse.arrayBuffer());
  assert.equal(hash(cbzBytes), cbzHash); assert.equal(hash(zipBytes), zipHash);
  const cbz = await JSZip.loadAsync(cbzBytes); assert.deepEqual(Object.keys(cbz.files), ["0001.png"]); assert.deepEqual(await cbz.file("0001.png").async("nodebuffer"), f.bytes);
  const zip = await JSZip.loadAsync(zipBytes), entry = Object.keys(zip.files).find(name => name.endsWith(".cbz")), nested = await JSZip.loadAsync(await zip.file(entry).async("nodebuffer"));
  assert.deepEqual(await nested.file("0001.png").async("nodebuffer"), f.bytes);
});
