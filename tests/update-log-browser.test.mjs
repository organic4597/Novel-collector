import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createApp } from "../src/server.mjs";

test(
  "settings update logs remain usable on desktop and mobile and show a rejected apply request",
  { skip: !process.env.BROWSER_PATH },
  async () => {
    const app = createApp({
      store: {},
      scheduler: {},
      adminPassword: "synthetic-update-ui",
    });
    await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
    let browser;
    try {
      browser = await chromium.launch({
        executablePath: process.env.BROWSER_PATH,
        headless: true,
      });
      for (const width of [1280, 390]) {
        const page = await browser.newPage({
            viewport: { width, height: 844 },
          }),
          errors = [], checks = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("dialog", dialog => dialog.accept());
        await page.route("**/api/**", (route) => {
          const path = new URL(route.request().url()).pathname;
          let data = {},
            status = 200;
          if (path === "/api/session") data = { authenticated: true };
          else if (["/api/jobs", "/api/books"].includes(path)) data = [];
          else if (path === "/api/status")
            data = { siteAttention: [], maxConcurrency: 2 };
          else if (["/api/updates/status", "/api/updates/check"].includes(path)) {
            const channel = path.endsWith("/check") ? route.request().postDataJSON().channel : "stable";
            if(path.endsWith("/check")) checks.push(channel);
            data = {
              currentVersion: "1.0.0.4",
              latestVersion: "1.0.0.5",
              available: true,
              installable: true,
              busy: false,
              repository: "example/repo",
              releaseUrl: "https://github.com/example/repo/releases",
              job: { state: "idle", message: "" },
              channel,
              candidates: [{ id: `${channel}:1.0.0.5:${"a".repeat(40)}`, channel, version: "1.0.0.5", commit: channel === "stable" ? null : "a".repeat(40), summary: "선택한 수정본", url: "https://github.com/example/repo/releases" }],
            };
          }
          else if (path === "/api/updates/log")
            data = {
              items: [
                {
                  id: 10,
                  time: "2026-10-05T00:00:00Z",
                  level: "info",
                  message: "합성 업데이트 준비 로그",
                  details: { step: "CHECK_RUNTIME" },
                },
              ],
              hasMore: false,
            };
          else if (path === "/api/updates/apply") {
            status = 503;
            data = { error: "서비스 업데이트 설정을 먼저 적용하세요." };
          }
          return route.fulfill({
            status,
            contentType: "application/json",
            body: JSON.stringify(data),
          });
        });
        await page.goto(`http://127.0.0.1:${app.address().port}/`);
        await page.locator("#management-menu summary").click();
        await page.locator("#nav-settings").click();
        await page.waitForSelector(".update-log-row");
        await page.locator("#update-apply").click();
        await page.locator("#update-check").click();
        await page.waitForFunction(
          () =>
            document.getElementById("update-task-state").textContent ===
            "시작 실패",
        );
        assert.match(
          await page.locator("#update-error").textContent(),
          /서비스 업데이트 설정/,
        );
        assert.equal(await page.locator("#update-channel").getAttribute("aria-describedby"), "update-channel-help");
        await page.locator("#update-channel").selectOption("develop");
        assert.deepEqual(checks, [], "changing channel must not check automatically");
        assert.match(await page.locator("#update-channel-help").textContent(), /실험판.*불안정/);
        await page.locator("#update-check").click();
        await page.waitForFunction(() => document.getElementById("update-candidate").disabled === false);
        assert.deepEqual(checks, ["develop"]);
        assert.match(await page.locator("#update-candidate").textContent(), /실험판.*aaaaaaa/);
        await page.locator("#update-channel").press("Escape");
        assert.equal(await page.locator("#update-options").isVisible(), false);
        await page.locator("#update-apply").press("Enter");
        assert.equal(await page.locator("#update-options").isVisible(), true);
        await page.evaluate(() => document.documentElement.dataset.theme = "dark");
        assert.equal(await page.locator("#update-channel").evaluate(node => getComputedStyle(node).colorScheme), "dark");
        await page.locator("#update-log-panel summary").click();
        assert.equal(
          await page.locator("#update-log-panel").evaluate((node) => node.open),
          false,
        );
        await page.locator("#update-log-panel summary").press("Enter");
        assert.equal(
          await page.locator("#update-log-panel").evaluate((node) => node.open),
          true,
        );
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
        );
        assert.deepEqual(errors, []);
        await page.close();
      }
    } finally {
      await browser?.close();
      app.closeAllConnections();
      await new Promise((resolve) => app.close(resolve));
    }
  },
);
