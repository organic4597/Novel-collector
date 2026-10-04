import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createApp } from "../src/server.mjs";

test("desktop and mobile page navigation scrolls the first work into view in Chromium", { skip: !process.env.BROWSER_PATH }, async () => {
  const app = createApp({ store: {}, scheduler: {}, adminPassword: "synthetic-browser-test" });
  await new Promise(resolve => app.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.BROWSER_PATH, headless: true });
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/api/**", async route => {
        const url = new URL(route.request().url());
        let data = {};
        if (url.pathname === "/api/session") data = { authenticated: true };
        else if (["/api/jobs", "/api/books"].includes(url.pathname)) data = [];
        else if (url.pathname === "/api/status") data = { maxConcurrency: 2, siteAttention: [], source: { origin: "https://sbxh9.com" } };
        else if (url.pathname === "/api/activity") data = { items: [], hasMore: false };
        else if (url.pathname === "/api/discover") {
          const current = Number(url.searchParams.get("page"));
          data = { page: current, maxPage: 3, pageSize: 40, total: 95, filters: {},
            items: Array.from({ length: current === 3 ? 15 : 40 }, (_, index) => {
              const id = String((current - 1) * 40 + index + 1);
              return { id, title: `합성 작품 ${id}`, url: `https://newtoki1.org/novel/${id}`,
                episodeCount: 20, thumbnail: null, genres: [], publication: "ongoing" };
            }) };
        }
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
      });
      await page.goto(`http://127.0.0.1:${app.address().port}/`);
      await page.locator("#nav-discover").click();
      await page.waitForFunction(() => document.querySelectorAll(".discover-card").length === 40);
      await page.locator('#discover-list input[type="checkbox"]').first().check();
      await page.locator("#discover-next").click();
      await page.waitForFunction(() => document.getElementById("discover-page").textContent === "2 / 3");
      const first = await page.locator(".discover-card").first().boundingBox();
      assert.ok(first.y >= 0 && first.y <= 20, `first work at ${first.y}px for ${width}px viewport`);
      assert.equal(await page.evaluate(() => document.activeElement === document.querySelector(".discover-title-link")), true);
      assert.ok(await page.evaluate(() => scrollY > 0), "the first card, rather than the page header, is the scroll target");
      await page.locator("#discover-prev").click();
      await page.waitForFunction(() => document.getElementById("discover-page").textContent === "1 / 3");
      assert.equal(await page.locator('#discover-list input[type="checkbox"]').first().isChecked(), true);
      const previous = await page.locator(".discover-card").first().boundingBox();
      assert.ok(previous.y >= 0 && previous.y <= 20);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser?.close();
    await new Promise(resolve => app.close(resolve));
  }
});
