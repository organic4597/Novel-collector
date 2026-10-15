import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { chromium } from "playwright";
import { FolderStore } from "../src/store.mjs";
import { SettingsStore } from "../src/settings.mjs";
import { ReaderImages, READER_PROFILE } from "../src/reader-images.mjs";
import { renderViewerImage } from "../src/reader-image-processor.mjs";
import { webtoonImageInfo } from "../src/webtoon-images.mjs";
import { createApp } from "../src/server.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function chunk(type, bytes) {
  const body = Buffer.concat([Buffer.from(type), bytes]); let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  const output = Buffer.alloc(bytes.length + 12); output.writeUInt32BE(bytes.length); body.copy(output, 4); output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
  return output;
}
function syntheticPng() {
  const width = 1600, height = 4101, header = Buffer.alloc(13), stride = width * 3 + 1, pixels = Buffer.alloc(stride * height, 255);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  for (let y = 0; y < height; y++) {
    const row = y * stride; pixels[row] = 0;
    if (y % 100 < 3) pixels.fill(0, row + 1, row + stride);
    else if (y % 100 > 20 && y % 100 < 40) {
      for (let x = 30; x < width - 30; x++) if (x % 28 < 12) pixels.fill(40, row + 1 + x * 3, row + 4 + x * 3);
    }
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

test("real library reader decodes generated WebP, revalidates its native cache and switches to unchanged original bytes", { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "reader-browser-"));
  let browser, app, readerImages;
  t.after(async () => {
    await browser?.close();
    if (app?.listening) { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); }
    await readerImages?.close();
    await rm(root, { recursive: true, force: true });
  });
  const store = await new FolderStore(join(root, "data")).init(), bytes = syntheticPng(), info = webtoonImageInfo(bytes);
  const directory = store.path("books", "book", "chapters", "chapter"), filename = `0001-${info.sha256.slice(0,16)}.png`, source = join(directory, filename);
  await mkdir(directory, { recursive: true }); await writeFile(source, bytes);
  await store.upsertBook("book", { title: "Synthetic reader book", contentType: "webtoon", url: "https://sbxh9.com/webtoon/book", metadataVersion: 1, expectedChapterCount: 1 });
  const images = [{ index: 1, filename, ...info }];
  await store.writeWebtoonChapter("book", "chapter", { number: 1, title: "Synthetic reader chapter", url: "https://sbxh9.com/webtoon/book/chapter", contentType: "webtoon", complete: true, expectedImages: 1, savedImages: 1, images, hash: hash(JSON.stringify(images)), size: bytes.length });
  let conversions = 0;
  readerImages = new ReaderImages({ store, render: (input, options) => { conversions++; return renderViewerImage(input, options); } });
  const settings = new SettingsStore({ path: join(root, "settings.json") }); await settings.load();
  app = createApp({
    store, scheduler: {}, readerImages, settings, adminPassword: "synthetic-browser-password",
    accounts: { status: host => ({ host, configured: false, enabled: false, username: "" }) },
    updates: { status: ({ channel }) => ({ currentVersion: "1.0.0", channel, job: { state: "idle" }, busy: false, available: false }) },
  });
  await new Promise(resolve => app.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.address().port}`, bundled = fileURLToPath(new URL(process.platform === "win32" ? "../browser/chrome-win64/chrome.exe" : "../browser/chrome-linux64/chrome", import.meta.url));
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_PATH || (existsSync(bundled) ? bundled : undefined) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  assert.equal((await context.request.get(`${base}/api/books`)).status(), 401);
  assert.equal((await context.request.post(`${base}/api/login`, { data: { password: "synthetic-browser-password" } })).status(), 200);
  const page = await context.newPage(), errors = [], externalRequests = [], readerResponses = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (!request.url().startsWith(base + "/")) externalRequests.push(request.url()); });
  page.on("response", response => { if (response.url().includes("/chapters/chapter/")) readerResponses.push({ url: response.url(), status: response.status() }); });
  const cdp = await context.newCDPSession(page), requests = new Map();
  await cdp.send("Network.enable"); await cdp.send("Network.setCacheDisabled", { cacheDisabled: false });
  cdp.on("Network.requestWillBeSent", event => requests.set(event.requestId, event.request.url));
  let tileUrl, revalidating = false, resolveRevalidated;
  const revalidated = new Promise(resolve => { resolveRevalidated = resolve; });
  cdp.on("Network.responseReceivedExtraInfo", event => {
    if (revalidating && event.statusCode === 304 && requests.get(event.requestId) === tileUrl) resolveRevalidated(event.statusCode);
  });
  async function openReader() {
    await page.locator("#nav-library").click();
    await page.locator('.book-card[data-id="book"]').click();
    await page.locator("#library-content-tab").click();
    await page.waitForFunction(() => {
      const image = document.querySelector(".webtoon-reader-image");
      return image?.complete && image.naturalWidth > 0;
    });
    const image = page.locator(".webtoon-reader-image").first();
    assert.equal(await image.evaluate(element => element.naturalWidth), 1280, `the viewer must decode WebP instead of falling back to original bytes: ${JSON.stringify(readerResponses)}`);
    return image;
  }
  await page.goto(base, { waitUntil: "domcontentloaded" });
  let image = await openReader();
  tileUrl = await image.evaluate(element => element.currentSrc);
  assert.equal(new URL(tileUrl).pathname, `/api/books/book/chapters/chapter/viewer/${info.sha256}/${READER_PROFILE}/1.webp`);
  assert.equal(await image.evaluate(element => element.naturalHeight), 2048); assert.equal(conversions, 1);
  assert.equal(readerResponses.some(response => response.url === tileUrl && response.status === 200), true);
  assert.equal(hash(await readFile(source)), info.sha256);

  await page.locator('[data-close="reader-dialog"]').click();
  await page.reload({ waitUntil: "domcontentloaded" });
  revalidating = true;
  image = await openReader();
  assert.equal(await image.evaluate(element => element.currentSrc), tileUrl);
  let timer;
  try {
    assert.equal(await Promise.race([revalidated, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Error("native browser cache did not revalidate the tile with HTTP 304")), 10000); })]), 304);
  } finally { clearTimeout(timer); }
  assert.equal(conversions, 1);
  await page.locator("#reader-image-quality").selectOption("original");
  await page.waitForFunction(() => {
    const image = document.querySelector(".webtoon-reader-image");
    return image?.complete && image.naturalWidth === 1600 && image.naturalHeight === 4101;
  });
  const originalUrl = new URL(await page.locator(".webtoon-reader-image").first().evaluate(element => element.currentSrc));
  assert.equal(originalUrl.pathname, "/api/books/book/chapters/chapter/images/1"); assert.equal(originalUrl.searchParams.get("v"), info.sha256);
  assert.equal(conversions, 1); assert.equal(hash(await readFile(source)), info.sha256);
  assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
  assert.equal(readerResponses.some(response => response.status >= 400), false);
});
