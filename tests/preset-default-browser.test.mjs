import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createApp } from "../src/server.mjs";
import { FolderStore } from "../src/store.mjs";
import { ExtractionPresets } from "../src/extraction-presets.mjs";
const fixtureCredential = "fixture-password";

test("basic preset dropdown adds independent copies in the real dashboard without changing the active source", async (t) => {
  const bundled = fileURLToPath(
    new URL(
      process.platform === "win32"
        ? "../browser/chrome-win64/chrome.exe"
        : "../browser/chrome-linux64/chrome",
      import.meta.url,
    ),
  );
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.BROWSER_PATH || (existsSync(bundled) ? bundled : undefined),
  });
  const root = await mkdtemp(join(tmpdir(), "preset-basic-browser-"));
  const store = await new FolderStore(root).init();
  const presets = await new ExtractionPresets({ store }).load();
  const previous = await presets.save({
    version: 1,
    name: "기존 사용자 설정",
    origin: "https://custom.example",
    pagePattern: "/works/{workId}",
    kind: "detail",
    fields: {
      title: { selector: "h2.user-title", attribute: "text", multiple: false },
    },
  });
  const sourceState = {
    version: 1,
    origins: { "newtoki1.org": "https://sbxh9.com" },
  };
  await store.atomic(store.path("viewer-origins.json"), sourceState);
  const app = createApp({
    store,
    scheduler: {},
    adminPassword: fixtureCredential,
    extractionPresets: presets,
  });
  await new Promise((done) => app.listen(0, "127.0.0.1", done));
  t.after(async () => {
    await browser.close();
    await new Promise((done) => app.close(done));
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.address().port}`;
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage(),
    errors = [],
    externalRequests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await context.route("**/*", (route) => {
    if (
      route
        .request()
        .url()
        .startsWith(base + "/")
    )
      return route.continue();
    externalRequests.push(route.request().url());
    return route.abort();
  });
  await context.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (
      ["/api/session", "/api/login"].includes(path) ||
      path.startsWith("/api/extraction-presets")
    )
      return route.continue();
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        path === "/api/jobs"
          ? []
          : path === "/api/status"
            ? { maxConcurrency: 2, siteAttention: [] }
            : {},
      ),
    });
  });
  assert.equal(
    (
      await page.request.post(base + "/api/login", {
        data: { password: fixtureCredential },
      })
    ).status(),
    200,
  );
  await page.goto(base);
  await page.locator("#nav-presets").click();
  await page
    .locator('#preset-default option[value="sbxh9-novel-v1"]')
    .waitFor({ state: "attached" });
  await page.locator("#preset-default").selectOption("sbxh9-novel-v1");
  await page.locator("#preset-add-default").click();
  await page.waitForFunction(
    () => document.getElementById("preset-count").textContent === "2개 저장",
  );
  assert.equal(
    await page.locator("#preset-save").textContent(),
    "프리셋 수정 저장",
  );
  assert.match(
    await page.locator("#preset-page-tree").textContent(),
    /✓ 소설 제목/,
  );
  const json = JSON.parse(await page.locator("#preset-json").inputValue());
  assert.equal(json.origin, "https://sbxh9.com");
  assert.equal(json.version, 2);
  await page.locator("#preset-add-default").click();
  await page.waitForFunction(
    () => document.getElementById("preset-count").textContent === "3개 저장",
  );
  assert.match(await page.locator("#preset-name").inputValue(), /복사본 2/);
  assert.deepEqual(presets.get(previous.id), previous);
  assert.deepEqual(
    await store.json(store.path("viewer-origins.json")),
    sourceState,
  );
  assert.equal(presets.list().length, 3);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    true,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
});
