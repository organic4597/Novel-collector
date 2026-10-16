import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { FolderStore } from "../src/store.mjs";
import { createApp } from "../src/server.mjs";

for (const touch of [false, true]) test(`compact fullscreen menu supports ${touch ? "touch" : "hover and keyboard"} without moving the reading area`, { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "reader-menu-")), width = touch ? 390 : 1280;
  let app, browser;
  t.after(async () => {
    await browser?.close();
    if (app?.listening) { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); }
    await rm(root, { recursive: true, force: true });
  });
  const store = await new FolderStore(join(root, "data")).init();
  await store.upsertBook("book", { title: "합성 작품 ".repeat(20), contentType: "novel", expectedChapterCount: 2, url: "https://newtoki1.org/novel/900000" });
  for (const number of [1, 2]) await store.writeChapter("book", `chapter-${number}`, { number, title: `Chapter ${number}`,
    url: `https://newtoki1.org/novel/900000/${number}`, text: `Chapter ${number}\n${"합성 본문에서 메뉴가 읽기 위치를 바꾸지 않는지 확인합니다.\n".repeat(180)}` });
  app = createApp({ store, scheduler: {}, adminPassword: "synthetic-menu-password",
    accounts: { status: host => ({ host, configured: false, enabled: false, username: "" }) },
    updates: { status: ({ channel }) => ({ currentVersion: "1.3.0", channel, job: { state: "idle" }, busy: false, available: false }) } });
  await new Promise(resolve => app.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_PATH || undefined });
  const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: touch, isMobile: touch });
  const page = await context.newPage(), errors = [], requests = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (/\/chapters\/chapter-\d+$/.test(new URL(request.url()).pathname)) requests.push(request.url()); });
  assert.equal((await context.request.post(base + "/api/login", { data: { password: "synthetic-menu-password" } })).status(), 200);
  await page.goto(base, { waitUntil: "domcontentloaded" }); await page.locator("#nav-library").click();
  await page.locator('.book-card[data-id="book"]').click();
  assert.equal(await page.locator("#reader-menu-toggle").isVisible(), false);
  await page.locator("#reader-fullscreen-toggle").click();
  await page.waitForFunction(() => document.querySelector("#reader-text").textContent.startsWith("Chapter 1"));
  const trigger = page.locator("#reader-menu-toggle"), menu = page.locator("#reader-menu");
  const outside = async () => touch ? page.touchscreen.tap(width / 2, 740) : page.mouse.move(width / 2, 740);
  const open = async () => touch ? trigger.tap() : trigger.hover();
  await outside(); await page.waitForFunction(() => document.querySelector("#reader-menu").hidden);
  await page.locator(".reader-body").evaluate(element => { element.scrollTop = 160; });
  const before = await page.locator(".reader-body").boundingBox(), requestCount = requests.length;
  await page.evaluate(() => { window.savedMenuBody = document.querySelector("#reader-text").firstChild; });
  const bar = await page.locator("#reader-toolbar").boundingBox();
  assert.ok(Math.abs(bar.height - (touch ? 40 : 32)) <= 1, JSON.stringify(bar));
  assert.ok(before.y <= bar.height + 2 && before.height > 740, JSON.stringify(before));
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  await open(); await page.waitForFunction(() => !document.querySelector("#reader-menu").hidden);
  assert.equal(await trigger.getAttribute("aria-expanded"), "true");
  if (touch) {
    await trigger.tap(); await page.waitForFunction(() => document.querySelector("#reader-menu").hidden);
    await trigger.tap(); await page.waitForFunction(() => !document.querySelector("#reader-menu").hidden);
  } else {
    await trigger.click(); assert.equal(await menu.isVisible(), true, "clicking after hover must keep the menu open");
  }
  const panel = await menu.boundingBox();
  assert.ok(panel.y >= bar.y + bar.height - 1 && panel.y + panel.height <= 845, JSON.stringify(panel));
  const after = await page.locator(".reader-body").boundingBox();
  for (const field of ["x", "y", "width", "height"]) assert.ok(Math.abs(after[field] - before[field]) <= 1, `${field} changed when opening the overlay`);
  assert.equal(await page.locator(".reader-body").evaluate(element => element.scrollTop), 160);
  for (const id of ["reader-fullscreen-toggle", "library-info-tab", "library-content-tab", "reader-sidebar-toggle", "reader-next"])
    assert.equal(await page.locator(`#${id}`).isVisible(), true, id);
  if (!touch) await page.locator("#reader-next").hover();
  assert.equal(await menu.isVisible(), true, "the menu must remain open while pointing at a dropdown control");
  await outside(); await page.waitForFunction(() => document.querySelector("#reader-menu").hidden);
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  assert.equal(await page.locator(".reader-body").evaluate(element => element.scrollTop), 160);
  assert.equal(await page.evaluate(() => window.savedMenuBody === document.querySelector("#reader-text").firstChild), true);
  assert.equal(requests.length, requestCount);
  if (!touch) {
    await trigger.focus(); await page.keyboard.press("ArrowDown");
    await page.waitForFunction(() => !document.querySelector("#reader-menu").hidden);
    assert.equal(await menu.evaluate(element => element.contains(document.activeElement)), true);
    await page.keyboard.press("Escape");
    assert.equal(await menu.isVisible(), false); assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
    await page.keyboard.press("Enter"); await page.waitForFunction(() => !document.querySelector("#reader-menu").hidden);
    let bodyFocused = false;
    for (let step = 0; step < 20 && !bodyFocused; step++) { await page.keyboard.press("Tab"); bodyFocused = await page.locator(".reader-body").evaluate(element => element === document.activeElement); }
    assert.equal(bodyFocused, true); assert.equal(await menu.isVisible(), false);
    await page.keyboard.press("PageDown"); await page.waitForFunction(() => document.querySelector(".reader-body").scrollTop > 160);
  }
  await open(); await page.waitForFunction(() => !document.querySelector("#reader-menu").hidden);
  await page.keyboard.press("Escape");
  assert.equal(await menu.isVisible(), false);
  assert.equal(await page.locator("#reader-dialog").evaluate(element => element.classList.contains("reader-fullscreen")), true);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector("#reader-dialog").open && !document.querySelector("#reader-dialog").classList.contains("reader-fullscreen"));
  assert.equal(await page.locator("#reader-dialog").evaluate(element => element.open && !element.classList.contains("reader-fullscreen")), true);
  assert.equal(await menu.isVisible(), true); assert.equal(await trigger.isVisible(), false);
  await page.keyboard.press("Escape"); await page.waitForFunction(() => !document.querySelector("#reader-dialog").open);
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains("reader-fullscreen-open")), false);
  assert.deepEqual(errors, []);
});
