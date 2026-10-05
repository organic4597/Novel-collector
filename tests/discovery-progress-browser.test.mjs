import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createApp } from "../src/server.mjs";

test("Chromium displays and selects a streamed prefix before the source finishes on desktop and mobile", { skip: !process.env.BROWSER_PATH }, async () => {
  let release;
  const app = createApp({ store: {}, scheduler: {}, adminPassword: "synthetic-progress-test", discovery: {
    async list(query, { onProgress }) {
      const page = Number(query.page), items = Array.from({ length: 40 }, (_, index) => {
        const id = String((page - 1) * 40 + index + 1);
        return { id, title: `합성 작품 ${id}`, url: `https://newtoki1.org/novel/${id}`, thumbnail: null,
          episodeCount: 20, genres: [], publication: "ongoing" };
      });
      const data = { items, page, total: 95, maxPage: 3, pageSize: 40, filters: {} };
      onProgress({ ...data, items: items.slice(0, 8), loadedCount: 8 });
      await new Promise(resolve => { release = resolve; });
      return { ...data, loadedCount: 40 };
    },
  } });
  await new Promise(resolve => app.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.BROWSER_PATH, headless: true });
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 844 } }), errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/api/**", route => {
        const path = new URL(route.request().url()).pathname;
        if (["/api/login", "/api/session", "/api/discover"].includes(path)) return route.continue();
        let data = ["/api/books", "/api/jobs"].includes(path) ? [] : {};
        if (path === "/api/status") data = { siteAttention: [], maxConcurrency: 2 };
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
      });
      const base = `http://127.0.0.1:${app.address().port}`;
      await page.request.post(base + "/api/login", { data: { password: "synthetic-progress-test" } });
      await page.goto(base);
      await page.locator("#nav-discover").click();
      await page.waitForFunction(() => document.querySelectorAll("#discover-list [data-id]").length === 8);
      assert.equal(await page.locator("#discover-list .is-loading").count(), 32);
      await page.locator('#discover-list input[type="checkbox"]').first().check();
      release();
      await page.waitForFunction(() => document.getElementById("discover-list").getAttribute("aria-busy") === "false");
      assert.equal(await page.locator("#discover-list [data-id]").count(), 40);
      assert.equal(await page.locator('#discover-list input[type="checkbox"]').first().isChecked(), true);
      await page.locator("#discover-next").click();
      await page.waitForFunction(() => document.querySelectorAll("#discover-list [data-id]").length === 8);
      const first = await page.locator("#discover-list .discover-card").first().boundingBox();
      assert.ok(first.y >= 0 && first.y <= 20, JSON.stringify({ width, first }));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      release();
      await page.waitForFunction(() => document.getElementById("discover-list").getAttribute("aria-busy") === "false");
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    release?.();
    await browser?.close();
    app.closeAllConnections();
    await new Promise(resolve => app.close(resolve));
  }
});
