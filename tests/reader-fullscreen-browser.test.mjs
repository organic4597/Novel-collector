import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { FolderStore } from "../src/store.mjs";
import { createApp } from "../src/server.mjs";
import { webtoonImageInfo } from "../src/webtoon-images.mjs";

for (const width of [1280, 390]) test(`library fullscreen reading, chapter navigation and cleanup at ${width}px`, { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "reader-fullscreen-"));
  let app, browser;
  t.after(async () => {
    await browser?.close();
    if (app?.listening) { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); }
    await rm(root, { recursive: true, force: true });
  });
  const store = await new FolderStore(join(root, "data")).init();
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  const info = webtoonImageInfo(gif), filename = `0001-${info.sha256.slice(0, 16)}.gif`;
  for (const contentType of ["novel", "webtoon", "manhwa"]) {
    const workUrl = `https://${contentType === "novel" ? "newtoki1.org" : "sbxh9.com"}/${contentType}/${contentType === "novel" ? "900000" : "synthetic"}`;
    await store.upsertBook(contentType, { title: `${contentType} ${"긴 작품 제목 ".repeat(12)}`, contentType,
      url: workUrl, metadataVersion: 1, expectedChapterCount: 3 });
    for (const number of [2, 10, 11]) {
      const id = `chapter-${number}`, url = `${workUrl}/${number}`;
      if (contentType === "novel") await store.writeChapter(contentType, id, { number, title: `Chapter ${number}`, url,
        text: `Chapter ${number}\n${"읽기 위치와 줄바꿈을 확인하는 합성 본문입니다.\n".repeat(100)}` });
      else {
        const directory = store.path("books", contentType, "chapters", id);
        await mkdir(directory, { recursive: true }); await writeFile(join(directory, filename), gif);
        const images = [{ index: 1, filename, ...info }];
        await store.writeWebtoonChapter(contentType, id, { number, title: `Chapter ${number}`, url, contentType,
          complete: true, expectedImages: 1, savedImages: 1, images,
          hash: createHash("sha256").update(JSON.stringify(images)).digest("hex"), size: gif.length });
      }
    }
  }
  app = createApp({ store, scheduler: {}, adminPassword: "synthetic-fullscreen-password",
    accounts: { status: host => ({ host, configured: false, enabled: false, username: "" }) },
    updates: { status: ({ channel }) => ({ currentVersion: "1.2.1", channel, job: { state: "idle" }, busy: false, available: false }) } });
  await new Promise(resolve => app.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_PATH || undefined });
  const context = await browser.newContext({ viewport: { width, height: 844 } }), page = await context.newPage();
  const errors = [], chapters = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (/\/chapters\/chapter-\d+$/.test(new URL(request.url()).pathname)) chapters.push(request.url()); });
  assert.equal((await context.request.post(base + "/api/login", { data: { password: "synthetic-fullscreen-password" } })).status(), 200);
  await page.goto(base, { waitUntil: "domcontentloaded" }); await page.locator("#nav-library").click();

  for (const contentType of ["novel", "webtoon", "manhwa"]) {
    await page.locator(`.book-card[data-id="${contentType}"]`).click();
    assert.equal(await page.locator("#reader-dialog").evaluate(element => element.classList.contains("reader-fullscreen")), false);
    await page.locator("#reader-fullscreen-toggle").click();
    await page.waitForFunction(() => document.querySelector("#reader-meta").textContent && !document.querySelector("#reader-meta").textContent.includes("불러오는 중"));
    assert.equal(await page.locator("#reader-fullscreen-toggle").getAttribute("aria-pressed"), "true");
    assert.match(await page.locator("#reader-position").textContent(), /1\s*\/\s*3/);
    assert.equal(await page.locator("#reader-previous").isDisabled(), true);
    assert.equal(await page.locator("#reader-next").isEnabled(), true);
    const bounds = await page.locator("#reader-dialog").boundingBox();
    assert.ok(Math.abs(bounds.x) <= 1 && Math.abs(bounds.y) <= 1 && Math.abs(bounds.width - width) <= 1 && Math.abs(bounds.height - 844) <= 1, JSON.stringify(bounds));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.ok(await page.locator(".reader-body").evaluate(element => element.clientHeight) > 200);
    if (contentType === "novel") {
      await page.locator("#reader-fullscreen-toggle").focus();
      let bodyFocused = false;
      for (let step = 0; step < 18 && !bodyFocused; step++) {
        await page.keyboard.press("Tab");
        bodyFocused = await page.locator(".reader-body").evaluate(element => element === document.activeElement);
      }
      assert.equal(bodyFocused, true, "the reading area must be reachable by keyboard");
      await page.keyboard.press("PageDown");
      await page.waitForFunction(() => document.querySelector(".reader-body").scrollTop > 0);
    }
    if (width === 390) assert.equal(await page.locator("#reader-sidebar-toggle").getAttribute("aria-expanded"), "false");
    if (contentType !== "novel") {
      await page.waitForFunction(() => document.querySelector(".webtoon-reader-image")?.naturalWidth > 0);
      await page.locator("#reader-image-quality").selectOption("original");
    }
    const before = chapters.length;
    await page.evaluate(() => { window.savedReaderNode = document.querySelector("#reader-text").firstChild; });
    await page.locator("#reader-fullscreen-toggle").click();
    await page.locator("#reader-fullscreen-toggle").click();
    assert.equal(await page.evaluate(() => window.savedReaderNode === document.querySelector("#reader-text").firstChild), true);
    assert.equal(chapters.length, before, "mode changes must not reload chapter JSON");
    if (contentType !== "novel") assert.equal(await page.locator("#reader-image-quality").inputValue(), "original");
    await page.locator("#reader-next").click();
    await page.waitForFunction(() => document.querySelector("#reader-chapter-title").textContent === "Chapter 10");
    assert.match(await page.locator("#reader-position").textContent(), /2\s*\/\s*3/);
    if (await page.locator("#reader-sidebar-toggle").getAttribute("aria-expanded") !== "true") await page.locator("#reader-sidebar-toggle").click();
    assert.equal(await page.locator("#reader-sidebar").isVisible(), true);
    await page.locator('#chapter-list [data-chapter="chapter-11"]').click();
    await page.waitForFunction(() => document.querySelector("#reader-chapter-title").textContent === "Chapter 11");
    assert.equal(await page.locator("#reader-next").isDisabled(), true);
    if (await page.locator("#reader-sidebar-toggle").getAttribute("aria-expanded") === "true") await page.locator("#reader-sidebar-toggle").click();
    assert.equal(await page.locator("#reader-sidebar").isVisible(), false);
    await page.locator("#reader-previous").click();
    await page.waitForFunction(() => document.querySelector("#reader-chapter-title").textContent === "Chapter 10");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#reader-dialog").evaluate(element => element.open && !element.classList.contains("reader-fullscreen")), true);
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains("reader-fullscreen-open")), false);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("#reader-dialog").open);
  }
  await page.locator('.book-card[data-id="novel"]').click(); await page.locator("#reader-fullscreen-toggle").click();
  await page.locator("#logout-button").evaluate(element => element.click());
  await page.waitForFunction(() => !document.querySelector("#reader-dialog").open);
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains("reader-fullscreen-open")), false);
  assert.equal(await page.locator("#reader-text").textContent(), "");
  assert.deepEqual(errors, []);
});
