import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { JSDOM } from "jsdom";
import { chromium } from "playwright";

const prefix = "/api/books/book/chapters/chapter";
const profile = "v1-w1280-h2048-q90";
const sha = "a".repeat(64);
const nextSha = "b".repeat(64);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function chapter() {
  return {
    contentType: "webtoon", title: "긴 회차", hash: "chapter-revision", savedImages: 2,
    images: [{ width: 2118, height: 28800, sha256: sha }, { width: 720, height: 2500, sha256: nextSha }],
    viewer: { revision: "chapter-revision", profile, images: [
      { index: 1, originalUrl: `${prefix}/images/1?v=${sha}`, parts: Array.from({ length: 9 }, (_, i) => ({
        url: `${prefix}/viewer/${sha}/${profile}/${i + 1}.webp`, width: 1280, height: i === 8 ? 1021 : 2048,
      })) },
      { index: 2, originalUrl: `${prefix}/images/2?v=${nextSha}`, parts: [{ url: `${prefix}/images/2?v=${nextSha}`, width: 720, height: 2500 }] },
    ] },
  };
}
async function setup(t, { library = false } = {}) {
  const dom = new JSDOM(await readFile(new URL("../public/index.html", import.meta.url), "utf8"), {
    url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document, calls = [];
  let auth = true, generation = 1, handler = async () => ({});
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; w.setTimeout(() => this.dispatchEvent(new w.Event("close")), 0); };
  w.eval(await readFile(new URL("../public/performance.js", import.meta.url), "utf8"));
  w.CollectorUI = {
    ...w.CollectorPerformance, authenticated: () => auth, generation: () => generation, view: () => "library",
    preferences: () => ({ libraryPageSize: 24 }), toast() {}, textError: error => error.message,
    api: async path => { calls.push(path); return handler(path); },
  };
  w.eval(await readFile(new URL("../public/reader-images.js", import.meta.url), "utf8"));
  if (library) w.eval(await readFile(new URL("../public/library.js", import.meta.url), "utf8"));
  const container = d.getElementById("reader-text"), scrollContainer = d.querySelector(".reader-body");
  return {
    w, d, calls, container, scrollContainer, setHandler: value => { handler = value; },
    mount: (data = chapter(), isCurrent = () => auth) => w.CollectorReaderImages.mount({ container, scrollContainer, prefix, chapter: data, isCurrent }),
    logout: () => { auth = false; generation++; d.dispatchEvent(new w.CustomEvent("collector:auth", { detail: false })); },
  };
}

test("fast reading keeps original order, tile dimensions and exactly one eager image without prefetch", async t => {
  const f = await setup(t), data = chapter();
  f.mount(data);
  const groups = [...f.container.querySelectorAll(".reader-image-group")], images = [...f.container.querySelectorAll("img")];
  assert.equal(groups.length, 2);
  assert.deepEqual(images.map(image => image.getAttribute("src")), data.viewer.images.flatMap(image => image.parts.map(part => part.url)));
  assert.deepEqual(images.map(image => [image.width, image.height]), data.viewer.images.flatMap(image => image.parts.map(part => [part.width, part.height])));
  assert.equal(images[0].getAttribute("loading"), "eager");
  assert.equal(images[0].getAttribute("fetchpriority"), "high");
  assert.ok(images.slice(1).every(image => image.getAttribute("loading") === "lazy" && image.getAttribute("fetchpriority") !== "high"));
  assert.ok(images.every(image => image.getAttribute("decoding") === "async"));
  const select = f.container.querySelector("select");
  assert.equal(select.value, "fast");
  assert.match(f.container.querySelector(`label[for="${select.id}"]`).textContent, /화질/);
  assert.equal(f.container.querySelector("a").getAttribute("href"), prefix + "/cbz");
  assert.equal(f.container.querySelectorAll('link[rel="prefetch"],link[rel="preload"]').length, 0);
  assert.deepEqual(f.calls, []);
});

test("quality switching keeps the reader position within the same original and leaves downloads intact", async t => {
  const f = await setup(t);
  f.mount();
  const groups = [...f.container.querySelectorAll(".reader-image-group")], select = f.container.querySelector("select");
  f.scrollContainer.scrollTop = 600;
  f.scrollContainer.getBoundingClientRect = () => ({ top: 0 });
  groups[0].getBoundingClientRect = () => ({ top: -500, bottom: select.value === "fast" ? 500 : 1500, height: select.value === "fast" ? 1000 : 2000 });
  groups[1].getBoundingClientRect = () => ({ top: 1600, bottom: 2600, height: 1000 });
  select.value = "original";
  // The old layout remains fast until the change event is handled.
  let firstRead = true;
  groups[0].getBoundingClientRect = () => {
    const height = firstRead ? 1000 : 2000; firstRead = false;
    return { top: -500, bottom: height - 500, height };
  };
  select.dispatchEvent(new f.w.Event("change"));
  assert.equal(f.scrollContainer.scrollTop, 1100);
  assert.deepEqual([...f.container.querySelectorAll("img")].map(image => image.getAttribute("src")), chapter().viewer.images.map(image => image.originalUrl));
  assert.equal(f.container.querySelector("a").getAttribute("href"), prefix + "/cbz");
  assert.equal(f.container.querySelectorAll("select").length, 1);
  assert.deepEqual(f.calls, []);
});

test("a tile failure falls back once, while manual retry respects the selected quality", async t => {
  const f = await setup(t);
  f.mount();
  const groups = [...f.container.querySelectorAll(".reader-image-group")], tiles = [...groups[0].querySelectorAll("img")];
  const untouched = groups[1].querySelector("img");
  tiles[4].dispatchEvent(new f.w.Event("error"));
  const original = groups[0].querySelector("img");
  assert.equal(groups[0].querySelectorAll("img").length, 1);
  assert.equal(original.getAttribute("src"), `${prefix}/images/1?v=${sha}`);
  assert.equal(groups[1].querySelector("img"), untouched);
  assert.match(groups[0].textContent, /원본 화질/);
  tiles[7].dispatchEvent(new f.w.Event("error"));
  assert.equal(groups[0].querySelector("img"), original);
  original.dispatchEvent(new f.w.Event("error"));
  assert.match(groups[0].textContent, /불러오지 못/);
  const retry = groups[0].querySelector("button");
  assert.ok(retry && !retry.hidden);
  const originalUrl = original.getAttribute("src");
  const oldOriginalError = original.onerror;
  retry.click();
  const retriedTiles = [...groups[0].querySelectorAll("img")];
  assert.equal(retriedTiles.length, 9);
  assert.deepEqual(retriedTiles.map(image => image.getAttribute("src")), chapter().viewer.images[0].parts.map(part => part.url));
  oldOriginalError();
  assert.equal(groups[0].querySelector("img"), retriedTiles[0]);
  retriedTiles[3].dispatchEvent(new f.w.Event("error"));
  const nextOriginal = groups[0].querySelector("img");
  assert.equal(groups[0].querySelectorAll("img").length, 1);
  assert.equal(nextOriginal.getAttribute("src"), originalUrl);
  retriedTiles[7].dispatchEvent(new f.w.Event("error"));
  assert.equal(groups[0].querySelector("img"), nextOriginal);
  assert.match(groups[0].textContent, /원본 화질/);
  const select = f.container.querySelector("select");
  select.value = "original"; select.dispatchEvent(new f.w.Event("change"));
  nextOriginal.dispatchEvent(new f.w.Event("error"));
  retry.click();
  assert.equal(groups[0].querySelectorAll("img").length, 1);
  assert.equal(groups[0].querySelector("img").getAttribute("src"), originalUrl);
  assert.notEqual(groups[0].querySelector("img"), nextOriginal);
  assert.equal(groups[1].querySelector("img"), untouched);
  assert.deepEqual(f.calls, []);
});

test("untrusted viewer paths and dimensions use only this chapter's original and show the fallback", async t => {
  for (const mutation of [
    data => { data.viewer.images[0].parts[0].url = "https://foreign.example/image.webp"; },
    data => { data.viewer.images[0].parts[0].url = `${prefix}/viewer/${sha}/${profile}/../1.webp`; },
    data => { data.viewer.images[0].originalUrl = "/api/books/book/chapters/other/images/1"; },
    data => { data.viewer.images[0].parts[0].height = -1; },
    data => { data.viewer.revision = "old"; },
  ]) {
    const f = await setup(t), data = chapter(); mutation(data); f.mount(data);
    const first = f.container.querySelector(".reader-image-group");
    assert.equal(first.querySelectorAll("img").length, 1);
    assert.equal(first.querySelector("img").getAttribute("src"), `${prefix}/images/1?v=${sha}`);
    assert.match(first.textContent, /원본 화질/);
    assert.ok([...f.container.querySelectorAll("img")].every(image => image.getAttribute("src").startsWith(prefix + "/")));
  }
});

test("legacy chapter JSON displays originals immediately with no manifest request", async t => {
  const f = await setup(t), data = chapter(); delete data.viewer;
  f.mount(data);
  assert.equal(f.container.querySelectorAll("img").length, 2);
  assert.ok([...f.container.querySelectorAll("img")].every(image => image.getAttribute("src").startsWith(prefix + "/images/")));
  assert.deepEqual(f.calls, []);
});

test("disposed or stale image handlers cannot mutate the reader", async t => {
  const f = await setup(t); let current = true;
  const reader = f.mount(chapter(), () => current), images = [...f.container.querySelectorAll("img")];
  current = false;
  images[0].dispatchEvent(new f.w.Event("error"));
  assert.equal(f.container.querySelectorAll("img").length, 10);
  reader.dispose();
  f.container.textContent = "다음 회차";
  images[1].dispatchEvent(new f.w.Event("error"));
  assert.equal(f.container.textContent, "다음 회차");
});

test("late chapter responses after close, same-chapter reopen or logout cannot replace current content", async t => {
  const f = await setup(t, { library: true }), gates = [];
  f.setHandler(path => path === "/api/books/book" ? { chapters: [{ id: "chapter", title: "회차" }] } : new Promise(resolve => gates.push(resolve)));
  const book = { id: "book", title: "작품", contentType: "webtoon", storedChapterCount: 1 };
  const opening = f.w.CollectorLibrary.openBook(book); await tick();
  f.d.getElementById("reader-dialog").close();
  const reopening = f.w.CollectorLibrary.openBook(book); await tick();
  gates[1]({ ...chapter(), title: "최신 회차" }); await reopening;
  assert.equal(f.d.getElementById("reader-chapter-title").textContent, "최신 회차");
  gates[0]({ ...chapter(), title: "늦은 회차" }); await opening;
  assert.equal(f.d.getElementById("reader-chapter-title").textContent, "최신 회차");
  const third = f.w.CollectorLibrary.openBook(book); await tick();
  f.logout();
  gates[2]({ ...chapter(), title: "로그아웃 뒤 회차" }); await third;
  assert.equal(f.container.textContent, "");
  assert.equal(f.d.getElementById("reader-dialog").open, false);
});

test("late chapter-list errors cannot overwrite a reopened reader and novel text remains unchanged", async t => {
  const f = await setup(t, { library: true }); let rejectOld;
  f.setHandler(() => new Promise((_, reject) => { rejectOld = reject; }));
  const opening = f.w.CollectorLibrary.openBook({ id: "old", storedChapterCount: 1 });
  f.d.getElementById("reader-dialog").close();
  const text = "첫 줄\n둘째 줄  그대로";
  f.setHandler(path => path === "/api/books/new" ? { chapters: [{ id: "novel" }] } : { contentType: "novel", text });
  await f.w.CollectorLibrary.openBook({ id: "new", storedChapterCount: 1 });
  rejectOld(new Error("이전 목록 실패")); await opening;
  assert.equal(f.container.textContent, text);
  assert.equal(f.container.querySelector("select"), null);
});

test("browser leaves tile boundaries flush, defers distant images and retains the reading position on quality changes", async t => {
  const data = chapter(), requests = [];
  const assets = new Map(await Promise.all(["performance.js", "reader-images.js", "styles.css"].map(async name => ["/" + name, await readFile(new URL("../public/" + name, import.meta.url))])));
  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    if (assets.has(path)) {
      response.writeHead(200, { "content-type": path.endsWith(".css") ? "text/css" : "text/javascript" }); response.end(assets.get(path));
    } else if (path.startsWith(prefix + "/")) {
      requests.push(path);
      const tile = path.match(/\/(\d+)\.webp$/), original = path.match(/\/images\/(\d+)$/);
      const image = tile ? data.viewer.images[0].parts[Number(tile[1]) - 1] : data.images[Number(original?.[1]) - 1];
      if (!image) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "private,no-cache" });
      response.end(`<svg xmlns="http://www.w3.org/2000/svg" width="${image.width}" height="${image.height}"><rect width="100%" height="100%" fill="#ddd"/></svg>`);
    } else {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><style>body{margin:0}.reader-body{width:min(640px,100vw);height:500px;padding:0;overflow:auto}</style><script defer src="/performance.js"></script><script defer src="/reader-images.js"></script><div class="reader-body"><div id="reader-text" class="reader-text"></div></div>');
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_PATH, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("http://127.0.0.1:" + server.address().port);
  await page.evaluate(({ prefix, chapter }) => {
    window.CollectorUI = { node: window.CollectorPerformance.node };
    window.CollectorReaderImages.mount({ container: document.getElementById("reader-text"), scrollContainer: document.querySelector(".reader-body"), prefix, chapter, isCurrent: () => true });
  }, { prefix, chapter: data });
  await page.waitForFunction(() => { const first = document.querySelector(".webtoon-reader-image"); return first.complete && first.naturalWidth > 0; });
  const rectangles = await page.locator(".reader-image-group").first().locator("img").evaluateAll(images => images.map(image => { const r = image.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }));
  rectangles.slice(1).forEach((rect, i) => assert.ok(Math.abs(rect.top - rectangles[i].bottom) < 0.01));
  assert.ok(requests.includes(`${prefix}/viewer/${sha}/${profile}/1.webp`));
  assert.ok(!requests.includes(`${prefix}/viewer/${sha}/${profile}/9.webp`));
  assert.ok(!requests.includes(`${prefix}/images/2`));
  const position = () => page.evaluate(() => {
    const body = document.querySelector(".reader-body"), group = document.querySelector(".reader-image-group").getBoundingClientRect();
    return (body.getBoundingClientRect().top - group.top) / group.height;
  });
  await page.locator(".reader-body").evaluate(body => { body.scrollTop = 3200; });
  const before = await position();
  await page.locator("#reader-image-quality").selectOption("original");
  assert.ok(Math.abs(await position() - before) < 0.001);
  await page.locator("#reader-image-quality").selectOption("fast");
  assert.ok(Math.abs(await position() - before) < 0.001);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
});
