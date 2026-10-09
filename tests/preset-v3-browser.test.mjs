import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { FolderStore } from "../src/store.mjs";
import { ExtractionPresets } from "../src/extraction-presets.mjs";
import { createApp } from "../src/server.mjs";

const credential = "fixture-password";

test("webtoon v3 bookmark saves selectors and explicit validation/binding/unbinding never starts a collection job", async t => {
  const root = await mkdtemp(join(tmpdir(), "preset-v3-browser-"));
  const store = await new FolderStore(root).init();
  const presets = await new ExtractionPresets({ store }).load();
  const app = createApp({ store, scheduler: {}, adminPassword: credential, extractionPresets: presets });
  await new Promise(resolve => app.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_PATH, headless: true });
  t.after(async () => { await browser.close(); app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const base = `http://127.0.0.1:${app.address().port}`, requests = [], errors = [];
  context.on("request", request => requests.push({ url: request.url(), method: request.method() }));
  await context.route("https://example.test/**", route => route.request().resourceType() === "document"
    ? route.fulfill({ contentType: "text/html", body: '<!doctype html><style>body{margin:20px}.vw-imgs{width:560px;max-width:100%;padding:20px;box-sizing:border-box}.episode-image{display:block;width:320px;max-width:100%;height:40px;margin:3px}</style><h1>PREVIEW_ONLY_TITLE</h1><img class="advertisement" src="/ad.css"><div class="vw-imgs">' + Array.from({ length: 21 }, (_, i) => `<img class="episode-image" src="/page-${i}.css?token=NEVER_EXPORT_TOKEN">`).join("") + '</div><a class="card" href="/webtoon/work"><span class="title">PREVIEW_ONLY_CARD</span></a><div class="chapter"><a href="/webtoon/work/nv-first">PREVIEW_ONLY_CHAPTER</a></div>' })
    : route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="40"/>' }));
  await context.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (["/api/login", "/api/session"].includes(path) || path.startsWith("/api/extraction-presets")) return route.continue();
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(path === "/api/jobs" || path === "/api/books" ? [] : path === "/api/status" ? { maxConcurrency: 2, siteAttention: [] } : {}) });
  });
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  assert.equal((await page.request.post(base + "/api/login", { data: { password: credential } })).status(), 200);
  await page.goto(base); await page.locator("#nav-presets").click();
  await page.locator("#preset-content-type").selectOption("webtoon");
  await page.locator("#preset-kind").selectOption("reader");
  await page.locator("#preset-target-field").selectOption("root");
  await page.locator("#preset-source-url").fill("https://example.test/webtoon/work/nv-first");
  const opening = context.waitForEvent("page"); await page.locator("#preset-connect").click(); const source = await opening; await source.waitForLoadState();
  const bookmark = await page.locator("#preset-bookmarklet").getAttribute("href");
  await source.evaluate(code => { location.href = code; }, bookmark);
  const tool = source.locator("#nc-element-picker"); await tool.waitFor();
  await tool.locator("#field").selectOption("root");
  await source.locator(".vw-imgs").click({ position: { x: 530, y: 10 } }); await tool.locator("#assign").click();
  await tool.locator("#field").selectOption("images");
  await source.locator(".episode-image").first().click(); await tool.locator("#assign").click();
  const returned = context.waitForEvent("page"); await tool.locator("#save-preset").click(); const dashboard = await returned;
  dashboard.on("pageerror", error => errors.push(error.message));
  await dashboard.waitForFunction(() => document.getElementById("preset-status").textContent.includes("서버에 저장했습니다."));
  assert.equal(presets.list().length, 1);
  const saved = presets.get(presets.list()[0].id).config;
  assert.equal(saved.version, 3); assert.equal(saved.contentType, "webtoon");
  assert.deepEqual(saved.pages.reader.fields.images, { selector: "img", shadowPath: [], attribute: "imageUrl", multiple: true, relativeTo: "root" });
  assert.deepEqual(saved.pages.listing.sources, { ongoing: "/ing", completed: "/end" });
  assert.ok(!/PREVIEW_ONLY|NEVER_EXPORT|page-\d+\.css|advertisement/.test(JSON.stringify(saved)));
  assert.equal(await dashboard.evaluate(() => location.hash), "");
  assert.ok(!requests.some(request => ["POST", "PUT", "DELETE"].includes(request.method) && /\/(?:validate|binding|bindings|jobs)(?:[/?]|$)/.test(request.url)));
  const id = presets.list()[0].id;
  const locator = (selector, options = {}) => ({ selector, shadowPath: [], attribute: "text", multiple: false, ...options });
  const complete = structuredClone(saved);
  complete.pages.listing.fields = { items: locator(".card", { multiple: true }), title: locator(".title", { relativeTo: "items" }), url: locator(":scope", { attribute: "href", relativeTo: "items" }) };
  complete.pages.detail.fields = { title: locator("h1"), rows: locator(".chapter", { multiple: true }), chapterUrl: locator("a", { attribute: "href", relativeTo: "rows" }) };
  await presets.save(complete, id);
  await context.route(`**/api/extraction-presets/${id}/validate`, async route => {
    const input = route.request().postDataJSON(), checked = await context.newPage();
    try {
      await checked.goto(input.url);
      const proof = await presets.validatePage(id, input, checked);
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(proof) });
    } finally { await checked.close(); }
  });
  await dashboard.locator("#preset-refresh").click();
  await dashboard.locator("#preset-list button").filter({ hasText: "불러오기" }).click();
  await dashboard.locator("#preset-activation").waitFor({ state: "visible" });
  await dashboard.locator("#preset-apply").click();
  await dashboard.waitForFunction(() => document.getElementById("preset-error").textContent.includes("검증"));
  assert.equal(presets.listBindings().bindings.length, 0);
  for (const [kind, url] of Object.entries({ listing: "https://example.test/ing", detail: "https://example.test/webtoon/work", reader: "https://example.test/webtoon/work/nv-first" })) {
    await dashboard.locator(`#preset-check-${kind}-url`).fill(url);
    await dashboard.locator(`#preset-check-${kind}`).click();
    await dashboard.waitForFunction(kind => document.getElementById(`preset-check-${kind}-status`).textContent.includes("확인 완료"), kind);
  }
  await dashboard.locator("#preset-apply").click();
  await dashboard.waitForFunction(() => document.getElementById("preset-binding-status").textContent.includes("적용 중"));
  assert.equal(presets.listBindings().bindings[0].presetId, id);
  assert.equal(presets.snapshot({ origin: "https://example.test", contentType: "webtoon" }).presetSnapshot.version, 3);
  assert.equal(await dashboard.locator("#preset-list button").filter({ hasText: "삭제" }).isDisabled(), true);
  await mkdir(".webtoon-test", { recursive: true });
  for (const width of [1280, 390]) {
    await dashboard.setViewportSize({ width, height: 844 });
    assert.equal(await dashboard.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await dashboard.screenshot({ path: `.webtoon-test/preset-v3-${width}.png` });
  }
  await dashboard.locator("#preset-unbind").click();
  await dashboard.waitForFunction(() => document.getElementById("preset-unbind").hidden);
  assert.equal(presets.listBindings().bindings.length, 0);
  assert.ok(!requests.some(request => request.method === "POST" && new URL(request.url).pathname === "/api/jobs"));
  assert.deepEqual(errors, []);
});
