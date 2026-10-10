import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { createApp } from "../src/server.mjs";

const fixtureCredential = "synthetic-ui-layout";
const stamp = "2026-01-01T00:00:00.000Z";
const views = [
  "queue",
  "discover",
  "history",
  "library",
  "settings",
  "activity",
  "presets",
  "releases",
];
const cover =
  '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="224"><rect width="160" height="224" fill="#22364b"/><text x="80" y="110" fill="white" text-anchor="middle">SYNTHETIC</text></svg>';
const presetConfig = {
  version: 2,
  name: "합성 소설 프리셋",
  origin: "https://example.test",
  pages: {
    listing: {
      pagePattern: "/novel",
      fields: {
        items: { selector: ".item", attribute: "text", multiple: true },
      },
    },
    detail: {
      pagePattern: "/novel/{workId}",
      fields: { title: { selector: "h1", attribute: "text", multiple: false } },
    },
    reader: {
      pagePattern: "/novel/{workId}/{episodeId}",
      fields: {
        text: { selector: ".body", attribute: "text", multiple: false },
      },
    },
  },
};

function fixtures() {
  const books = [
    {
      id: "novel-one",
      contentType: "novel",
      title: "긴 제목의 합성 판타지 소설 · 보관함 읽기와 다운로드 검증",
      author: "합성 작가",
      genres: ["판타지"],
      tags: ["성장", "모험"],
      synopsis: "실제 작품과 관계없는 UI 검증용 소개입니다.",
      storedChapterCount: 12,
      expectedChapterCount: 15,
      missingChapterCount: 3,
      publication: "ongoing",
      updatedAt: stamp,
      metadataStatus: "completed",
    },
    {
      id: "novel-two",
      contentType: "novel",
      title: "완결 로맨스 합성 작품",
      author: "다른 작가",
      genres: ["로맨스"],
      storedChapterCount: 20,
      expectedChapterCount: 20,
      publication: "completed",
      updatedAt: stamp,
      metadataStatus: "completed",
    },
    {
      id: "webtoon-one",
      contentType: "webtoon",
      title: "웹툰 합성 보관함",
      author: "합성 작가",
      genres: ["판타지"],
      storedChapterCount: 4,
      expectedChapterCount: 4,
      publication: "completed",
      updatedAt: stamp,
      metadataStatus: "completed",
    },
  ];
  const jobs = [
    {
      id: "running-one",
      title: books[0].title,
      url: "https://example.test/novel/101",
      status: "running",
      phase: "collecting",
      format: "txt",
      total: 15,
      completed: 8,
      skipped: 0,
      failed: 1,
      currentChapter: "9화 · 긴 제목이 있는 현재 회차",
      estimatedSecondsRemaining: 155,
      timing: { confidence: "high", samples: 5 },
      updatedAt: stamp,
    },
    {
      id: "queued-one",
      title: "합성 예약 작품",
      url: "https://example.test/novel/102",
      status: "queued",
      phase: "queued",
      format: "epub",
      total: 20,
      completed: 0,
      skipped: 0,
      failed: 0,
      updatedAt: stamp,
    },
    {
      id: "complete-one",
      title: "합성 완료 기록",
      url: "https://example.test/novel/103",
      status: "completed",
      phase: "completed",
      format: "txt",
      total: 20,
      completed: 20,
      failed: 0,
      exports: ["txt", "epub"],
      updatedAt: stamp,
    },
    {
      id: "failed-one",
      title: "합성 실패 기록",
      url: "https://example.test/novel/104",
      status: "completed_with_errors",
      phase: "completed",
      total: 10,
      completed: 8,
      failed: 2,
      updatedAt: stamp,
    },
  ];
  return {
    books,
    jobs,
    calls: [],
    presets: [],
    bindings: [],
    settings: {
      maxConcurrency: 2,
      chapterDelayMs: 1200,
      defaultFormat: "txt",
      refreshIntervalMs: 30000,
      libraryPageSize: 24,
      thumbnailFit: "contain",
      displayDensity: "comfortable",
    },
  };
}

async function openFixture(browser, base, width, theme = "light") {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage(),
    data = fixtures(),
    errors = [];
  await context.addInitScript((theme) => {
    if (!localStorage.getItem("collector.theme"))
      localStorage.setItem("collector.theme", theme);
  }, theme);
  page.setDefaultTimeout(8000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    if (url.origin !== base) return route.abort();
    if (
      !path.startsWith("/api/") ||
      ["/api/session", "/api/login"].includes(path)
    )
      return route.continue();
    if (path.endsWith("/thumbnail"))
      return route.fulfill({ contentType: "image/svg+xml", body: cover });
    const method = request.method(),
      body = request.postDataJSON();
    data.calls.push({
      path,
      method,
      body,
      query: Object.fromEntries(url.searchParams),
    });
    let result = {};
    if (path === "/api/status")
      result = {
        siteAttention: [],
        maxConcurrency: 2,
        activeJobIds: ["running-one"],
        source: { host: "sbxh9.com" },
      };
    else if (path === "/api/jobs" && method === "GET") result = data.jobs;
    else if (path === "/api/jobs" && method === "POST") {
      result = {
        ...body,
        id: "added-one",
        status: "queued",
        phase: "queued",
        updatedAt: stamp,
      };
      data.jobs = [...data.jobs, result];
    } else if (path === "/api/jobs/batch") {
      const jobs = body.jobs.map((job, index) => ({
        ...job,
        id: "batch-" + index,
        status: "queued",
        phase: "queued",
        updatedAt: stamp,
      }));
      data.jobs = [...data.jobs, ...jobs];
      result = { jobs, skipped: [] };
    } else if (path.endsWith("/events"))
      result = [{ level: "info", time: stamp, message: "합성 회차 저장 완료" }];
    else if (path === "/api/books") result = data.books;
    else if (/^\/api\/books\/[^/]+$/.test(path))
      result = {
        book: data.books.find((book) => path.endsWith(book.id)),
        chapters: [{ id: "one", number: 1, title: "합성 첫 회차" }],
      };
    else if (/^\/api\/books\/[^/]+\/chapters\/one$/.test(path))
      result = {
        title: "합성 첫 회차",
        number: 1,
        text: "본문 읽기 UI를 확인하는 합성 문장입니다.",
      };
    else if (path === "/api/discover") {
      const webtoon = url.searchParams.get("contentType") === "webtoon";
      const items = Array.from({ length: 6 }, (_, index) => ({
        id: webtoon
          ? "webtoon-" + String(index + 1).repeat(32)
          : String(201 + index),
        contentType: webtoon ? "webtoon" : "novel",
        title: `${webtoon ? "웹툰" : "소설"} 합성 검색 ${index + 1}`,
        author: "합성 작가",
        url: "https://example.test/novel/" + (201 + index),
        episodeCount: 20 + index,
        genres: ["판타지"],
        publication: "ongoing",
        thumbnail: "/api/discover/" + (201 + index) + "/thumbnail",
      }));
      result = {
        items,
        page: 1,
        total: 6,
        maxPage: 1,
        loadedCount: 6,
        filters: { genres: ["판타지", "로맨스"], platforms: ["합성 플랫폼"] },
      };
    } else if (path === "/api/settings") {
      if (method === "PUT") data.settings = body;
      result = data.settings;
    } else if (path === "/api/system/info")
      result = {
        bookCount: 3,
        chapterCount: 36,
        bodyBytes: 4096,
        diskFreeBytes: 100000000,
        uptimeSeconds: 3600,
        computedAt: stamp,
      };
    else if (path === "/api/updates/history")
      result = {
        currentVersion: "1.0.0.11",
        records: [
          {
            version: "1.0.0.11",
            title: "합성 업데이트",
            status: "current",
            date: "2026-01-01",
            groups: [{ title: "개선", items: ["합성 화면 검증"] }],
          },
        ],
      };
    else if (path.startsWith("/api/updates/"))
      result = {
        currentVersion: "1.0.0.11",
        latestVersion: "1.0.0.11",
        repository: "synthetic/repository",
        releaseUrl: "https://example.test/release",
        available: false,
        busy: false,
        installable: false,
        job: { state: "idle", message: "최신 버전입니다." },
      };
    else if (path === "/api/activity")
      result = {
        items: [
          {
            id: 1,
            level: "info",
            scope: "dashboard",
            time: stamp,
            message: "합성 대시보드 로그",
            details: { step: "조회" },
          },
        ],
        hasMore: false,
        latestId: 1,
      };
    else if (path === "/api/extraction-presets/bindings")
      result = { version: 1, bindings: data.bindings };
    else if (path === "/api/extraction-presets/defaults" && method === "GET")
      result = [
        {
          id: "synthetic-novel",
          name: presetConfig.name,
          contentType: "novel",
          description: "합성 선택자 프리셋",
        },
      ];
    else if (path === "/api/extraction-presets/defaults" && method === "POST") {
      result = {
        id: "preset-one",
        name: presetConfig.name,
        origin: presetConfig.origin,
        contentType: "novel",
        fieldCount: 3,
        pages: presetConfig.pages,
        config: presetConfig,
        updatedAt: stamp,
      };
      data.presets = [result];
    } else if (path === "/api/extraction-presets") result = data.presets;
    else if (
      path === "/api/extraction-presets/preset-one" &&
      method === "PUT"
    ) {
      result = { ...data.presets[0], name: body.name, config: body };
      data.presets = [result];
    } else if (path === "/api/extraction-presets/preset-one/validate")
      result = {
        valid: true,
        pageKind: body.pageKind,
        presetHash: "synthetic-hash",
        matches: { title: 1, text: 1, items: 6 },
      };
    else if (path === "/api/extraction-presets/preset-one/binding") {
      data.bindings =
        method === "DELETE"
          ? []
          : [
              {
                presetId: "preset-one",
                origin: presetConfig.origin,
                contentType: "novel",
                validated: true,
              },
            ];
      result = { version: 1, bindings: data.bindings };
    } else if (path === "/api/site-account")
      result = { host: "sbxh9.com", configured: false };
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(result),
    });
  });
  await context.request.post(base + "/api/login", {
    data: { password: fixtureCredential },
  });
  await page.goto(base);
  await page.locator("#app-view").waitFor({ state: "visible" });
  await page.locator("#jobs-list .job-card").first().waitFor();
  return { context, page, data, errors };
}

async function withBrowser(run) {
  const app = createApp({
    store: {},
    scheduler: {},
    adminPassword: fixtureCredential,
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.BROWSER_PATH,
      headless: true,
    });
    await run(browser, `http://127.0.0.1:${app.address().port}`);
  } finally {
    await browser?.close();
    app.closeAllConnections();
    await new Promise((resolve) => app.close(resolve));
  }
}

async function snapshot(page, name) {
  if (!process.env.ARTIFACT_DIR) return;
  await mkdir(process.env.ARTIFACT_DIR, { recursive: true });
  await page.screenshot({
    path: join(process.env.ARTIFACT_DIR, name + ".png"),
    fullPage: true,
  });
}

async function shown(page, selector) {
  await page.locator(selector).waitFor({ state: "visible" });
  assert.equal(
    await page.locator(selector).isVisible(),
    true,
    selector + " remains reachable",
  );
}

async function assertThemeSurface(page, theme) {
  const surface = await page.evaluate(() => ({
    scheme: getComputedStyle(document.documentElement).colorScheme,
    background: getComputedStyle(document.body).backgroundColor,
  }));
  assert.equal(
    surface.scheme,
    theme,
    "native browser controls use the selected theme",
  );
  const rgb = surface.background
    .match(/[\d.]+/g)
    .slice(0, 3)
    .map(Number);
  const luminance = rgb
    .map((channel) => {
      const value = channel / 255;
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    })
    .reduce(
      (sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index],
      0,
    );
  assert.ok(
    theme === "light" ? luminance > 0.7 : luminance < 0.1,
    `${theme} has a genuinely ${theme} page surface (${surface.background})`,
  );
}

async function visit(page, view) {
  if (!(await page.locator("#nav-" + view).isVisible()))
    await page.locator("#management-menu summary").click();
  await page.locator("#nav-" + view).click();
  await shown(page, "#" + view + "-view");
  assert.ok(
    (await page.locator("#" + view + "-view h1").innerText()).trim(),
    view + " has a heading",
  );
  assert.equal(
    await page.locator("#nav-" + view).getAttribute("aria-current"),
    "page",
  );
  if (["settings", "activity", "presets", "releases"].includes(view))
    assert.equal(
      await page.locator("#management-menu").getAttribute("open"),
      null,
      "choosing a management view closes the menu",
    );
}

async function contrastFailures(page, view) {
  return page.evaluate((view) => {
    const rgba = (color) => {
      const channels = color.match(/[\d.]+/g)?.map(Number);
      return channels?.length >= 3
        ? [...channels.slice(0, 3), channels[3] ?? 1]
        : [0, 0, 0, 0];
    };
    const blend = (front, back) =>
      front
        .slice(0, 3)
        .map(
          (channel, index) => channel * front[3] + back[index] * (1 - front[3]),
        );
    const luminance = (rgb) =>
      rgb
        .map((channel) => {
          const value = channel / 255;
          return value <= 0.04045
            ? value / 12.92
            : ((value + 0.055) / 1.055) ** 2.4;
        })
        .reduce(
          (sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index],
          0,
        );
    const background = (element) => {
      const parents = [];
      for (let node = element; node; node = node.parentElement)
        parents.push(node);
      return parents
        .reverse()
        .reduce(
          (back, node) =>
            blend(rgba(getComputedStyle(node).backgroundColor), back),
          [255, 255, 255],
        );
    };
    const section = document.getElementById(view + "-view");
    const elements = [
      ...section.querySelectorAll(
        "h1, .page-heading p, .metric-label, .discover-title-link, .book-title, .status-pill, .discover-author, .discover-count, .discover-meta, .discover-tags span, .book-meta, input:not([type=checkbox]), select, .primary, .secondary, .quiet",
      ),
      ...document.querySelectorAll(
        ".nav-item.active, #connection-label, #theme-toggle",
      ),
    ];
    return elements
      .filter(
        (element) =>
          element.getClientRects().length &&
          !element.disabled &&
          !element.closest("[hidden]"),
      )
      .flatMap((element) => {
        if (!element.matches("input,select") && !element.textContent.trim())
          return [];
        const style = getComputedStyle(element),
          back = background(element);
        const text = blend(rgba(style.color), back);
        const values = [luminance(text), luminance(back)].sort((a, b) => b - a);
        const ratio = (values[0] + 0.05) / (values[1] + 0.05);
        return ratio + 0.01 < 4.5
          ? [
              {
                id: element.id || element.className,
                ratio: Number(ratio.toFixed(2)),
                color: style.color,
                background: back,
              },
            ]
          : [];
      });
  }, view);
}

test(
  "all eight dashboard views fit desktop and mobile in both themes with usable targets and readable contrast",
  { skip: !process.env.BROWSER_PATH },
  async () => {
    await withBrowser(async (browser, base) => {
      const failures = [];
      for (const theme of ["light", "dark"]) {
        for (const width of [375, 768, 1024, 1440]) {
          const { context, page, errors } = await openFixture(
            browser,
            base,
            width,
            theme,
          );
          try {
            assert.equal(
              await page.locator("html").getAttribute("data-theme"),
              theme,
            );
            await assertThemeSurface(page, theme);
            await page.keyboard.press("Tab");
            assert.equal(
              await page.evaluate(() =>
                document.activeElement.matches(".skip-link"),
              ),
              true,
              "the skip link is the first keyboard target",
            );
            await shown(page, ".skip-link");
            await page.keyboard.press("Enter");
            assert.equal(
              await page.evaluate(() => document.activeElement.id),
              "main-content",
              "the skip link moves keyboard focus into the dashboard",
            );
            await shown(page, "#logout-button");
            if (width === 375) {
              const logout = await page.locator("#logout-button").boundingBox();
              assert.ok(
                logout.x >= 0 && logout.x + logout.width <= width + 1,
                "mobile logout stays within the screen",
              );
            }
            for (const view of views) {
              await visit(page, view);
              if (view === "discover")
                await page
                  .locator("#discover-list .discover-card[data-id]")
                  .first()
                  .waitFor();
              if (view === "library")
                await page.locator("#books-list .book-card").first().waitFor();
              const layout = await page.evaluate((view) => {
                const section = document.getElementById(view + "-view");
                const controls = [
                  ...section.querySelectorAll(
                    ".page-heading button, .selection-bar button, .selection-bar select, #discover-search, #settings-save, #activity-refresh, #preset-connect, #preset-save",
                  ),
                  ...document.querySelectorAll(
                    ".nav-item, #management-menu summary, #logs-toggle, #theme-toggle",
                  ),
                ];
                return {
                  overflow: document.documentElement.scrollWidth - innerWidth,
                  small: controls
                    .filter((element) => element.getClientRects().length)
                    .map((element) => ({
                      id: element.id,
                      height: element.getBoundingClientRect().height,
                      width: element.getBoundingClientRect().width,
                    }))
                    .filter(
                      (element) =>
                        element.height < 43.5 || element.width < 43.5,
                    ),
                };
              }, view);
              if (layout.overflow > 1)
                failures.push(
                  `${theme} ${width}px ${view}: horizontal overflow ${layout.overflow}px`,
                );
              for (const control of layout.small)
                failures.push(
                  `${theme} ${width}px ${view}: ${control.id} target ${control.width.toFixed(1)} × ${control.height.toFixed(1)}px`,
                );
              for (const result of await contrastFailures(page, view))
                failures.push(
                  `${theme} ${width}px ${view}: ${result.id} text contrast ${result.ratio}:1 (${result.color} on ${result.background.join(",")})`,
                );
              if (
                [375, 1440].includes(width) &&
                ["queue", "discover", "library", "settings"].includes(view)
              )
                await snapshot(page, `${theme}-${view}-${width}`);
              if (["queue", "discover", "library"].includes(view)) {
                await page.locator("#logs-toggle").click();
                await shown(page, "#events-panel");
                assert.equal(
                  await page
                    .locator("#logs-toggle")
                    .getAttribute("aria-expanded"),
                  "true",
                );
                const overflow = await page.evaluate(
                  () => document.documentElement.scrollWidth - innerWidth,
                );
                if (overflow > 1)
                  failures.push(
                    `${theme} ${width}px ${view} with logs: horizontal overflow ${overflow}px`,
                  );
                if ([375, 1440].includes(width))
                  await snapshot(page, `${theme}-${view}-logs-${width}`);
                await page.locator("#close-events").click();
                assert.equal(
                  await page.locator("#events-panel").isVisible(),
                  false,
                );
                assert.equal(
                  await page
                    .locator("#logs-toggle")
                    .getAttribute("aria-expanded"),
                  "false",
                );
              }
            }
            assert.deepEqual(
              errors,
              [],
              `console errors in ${theme} at ${width}px`,
            );
          } finally {
            await context.close();
          }
        }
      }
      assert.deepEqual(failures, []);
    });
  },
);

test(
  "existing reservation, download, failures, reading and work dialogs fit both themes",
  { skip: !process.env.BROWSER_PATH },
  async () => {
    await withBrowser(async (browser, base) => {
      const failures = [];
      for (const theme of ["light", "dark"]) {
        for (const width of [375, 1440]) {
          const { context, page, errors } = await openFixture(
            browser,
            base,
            width,
            theme,
          );
          try {
            for (const id of [
              "job-dialog",
              "batch-dialog",
              "bundle-dialog",
              "failures-dialog",
              "reader-dialog",
              "work-dialog",
            ]) {
              await page
                .locator("#" + id)
                .evaluate((dialog) => dialog.showModal());
              await shown(page, "#" + id);
              const layout = await page.locator("#" + id).evaluate((dialog) => {
                const box = dialog.getBoundingClientRect();
                return {
                  left: box.left,
                  right: box.right,
                  top: box.top,
                  bottom: box.bottom,
                  overflow: dialog.scrollWidth - dialog.clientWidth,
                  targets: [
                    ...dialog.querySelectorAll(
                      "button, input:not([type=checkbox]), select, textarea",
                    ),
                  ]
                    .filter(
                      (control) =>
                        control.getClientRects().length &&
                        !control.closest("[hidden]"),
                    )
                    .map((control) => ({
                      id: control.id || control.className,
                      width: control.getBoundingClientRect().width,
                      height: control.getBoundingClientRect().height,
                    }))
                    .filter(
                      (control) =>
                        control.width < 43.5 || control.height < 43.5,
                    ),
                };
              });
              if (
                layout.left < -1 ||
                layout.right > width + 1 ||
                layout.top < -1 ||
                layout.bottom > 901 ||
                layout.overflow > 1
              )
                failures.push(
                  `${theme} ${width}px ${id}: popup bounds ${JSON.stringify(layout)}`,
                );
              for (const target of layout.targets)
                failures.push(
                  `${theme} ${width}px ${id}: ${target.id} target ${target.width.toFixed(1)} × ${target.height.toFixed(1)}px`,
                );
              await page.locator("#" + id).evaluate((dialog) => dialog.close());
            }
            assert.deepEqual(errors, []);
          } finally {
            await context.close();
          }
        }
      }
      assert.deepEqual(failures, []);
    });
  },
);

test(
  "theme controls work with keyboard, survive reload, synchronize tabs and remain reachable after logout",
  { skip: !process.env.BROWSER_PATH },
  async () => {
    await withBrowser(async (browser, base) => {
      const { context, page, errors } = await openFixture(browser, base, 375);
      try {
        const toggle = page.locator("#theme-toggle");
        await toggle.focus();
        await page.keyboard.press("Space");
        assert.equal(
          await page.locator("html").getAttribute("data-theme"),
          "dark",
        );
        await assertThemeSurface(page, "dark");
        assert.equal(await toggle.getAttribute("aria-pressed"), "true");
        assert.equal(
          await page.evaluate(() => localStorage.getItem("collector.theme")),
          "dark",
        );
        await page.reload();
        await shown(page, "#app-view");
        assert.equal(
          await page.locator("html").getAttribute("data-theme"),
          "dark",
        );
        await toggle.focus();
        await page.keyboard.press("Enter");
        assert.equal(
          await page.locator("html").getAttribute("data-theme"),
          "light",
        );
        await assertThemeSurface(page, "light");
        assert.equal(await toggle.getAttribute("aria-pressed"), "false");

        await page.locator("#management-menu summary").focus();
        await page.keyboard.press("Enter");
        await shown(page, "#nav-presets");
        await page.locator("#nav-presets").focus();
        await page.keyboard.press("Enter");
        await shown(page, "#presets-view");
        assert.equal(
          await page.locator("#management-menu").getAttribute("open"),
          null,
        );

        const secondTab = await context.newPage();
        await secondTab.goto(base);
        await shown(secondTab, "#app-view");
        await secondTab.locator("#theme-toggle").click();
        await page.waitForFunction(
          () => document.documentElement.dataset.theme === "dark",
        );
        assert.equal(await toggle.getAttribute("aria-pressed"), "true");
        await secondTab.close();

        await page.locator("#logout-button").click();
        await shown(page, "#login-view");
        await shown(page, "#login-theme-toggle");
        assert.deepEqual(await contrastFailures(page, "login"), []);
        await page.locator("#login-theme-toggle").focus();
        await page.keyboard.press("Enter");
        assert.equal(
          await page.locator("html").getAttribute("data-theme"),
          "light",
        );
        assert.deepEqual(await contrastFailures(page, "login"), []);
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });
  },
);

test(
  "redesign preserves search, selection, reservations, reading, settings, presets and logs",
  { skip: !process.env.BROWSER_PATH },
  async () => {
    await withBrowser(async (browser, base) => {
      const { context, page, data, errors } = await openFixture(
        browser,
        base,
        1440,
      );
      try {
        await visit(page, "discover");
        await page
          .locator("#discover-list .discover-card[data-id]")
          .first()
          .waitFor();
        await page.locator("#discover-search-type").selectOption("author");
        await page.locator("#discover-query").fill("합성 작가");
        await page.locator("#discover-publication").selectOption("completed");
        await page.locator("#discover-search").click();
        await page.waitForFunction(
          () =>
            document
              .getElementById("discover-list")
              .getAttribute("aria-busy") === "false",
        );
        assert.ok(
          data.calls.some(
            (call) =>
              call.path === "/api/discover" &&
              call.query.author === "합성 작가" &&
              call.query.publication === "completed",
          ),
        );
        await page.locator("#discover-select-page").check();
        assert.match(
          await page.locator("#discover-selected").innerText(),
          /6개/,
        );
        assert.equal(
          await page.locator("#discover-add-selected").isEnabled(),
          true,
        );
        await page.locator("#discover-clear").click();
        assert.match(
          await page.locator("#discover-selected").innerText(),
          /0개/,
        );
        await page.locator("#discover-content-type").selectOption("webtoon");
        await page.waitForFunction(
          () =>
            document
              .getElementById("discover-list")
              .getAttribute("aria-busy") === "false",
        );
        assert.ok(
          data.calls.some(
            (call) =>
              call.path === "/api/discover" &&
              call.query.contentType === "webtoon",
          ),
        );
        assert.equal(
          await page.locator("#discover-format").inputValue(),
          "cbz",
        );

        await visit(page, "library");
        await page.locator("#books-list .book-card").first().waitFor();
        assert.equal(await page.locator("#books-list .book-card").count(), 3);
        await page.locator("#library-content-type").selectOption("webtoon");
        assert.equal(await page.locator("#books-list .book-card").count(), 1);
        await page.locator("#books-list .book-card").click();
        assert.equal(
          await page
            .locator("#library-profile-download")
            .first()
            .getAttribute("href"),
          "/api/books/webtoon-one/export/zip",
        );
        await page.locator('[data-close="reader-dialog"]').click();
        await page.locator("#library-content-type").selectOption("novel");
        await page.locator("#library-sort").selectOption("title");
        await page.locator("#library-genre").selectOption("판타지");
        assert.equal(await page.locator("#books-list .book-card").count(), 1);
        await page.locator("#library-select-page").check();
        assert.match(
          await page.locator("#library-selected").innerText(),
          /1개/,
        );
        assert.equal(
          await page.locator("#library-download-selected").isEnabled(),
          true,
        );
        await page.locator("#library-clear").click();
        await page.locator("#books-list .book-card").first().click();
        await shown(page, "#reader-dialog");
        await page.locator("#library-content-tab").click();
        await page.waitForFunction(() =>
          document
            .getElementById("reader-text")
            .textContent.includes("합성 문장"),
        );
        await page.locator('[data-close="reader-dialog"]').click();

        await visit(page, "queue");
        await page.locator("#add-job-button").click();
        await shown(page, "#job-dialog");
        await page.locator("#job-url").fill("https://example.test/novel/301");
        await page.locator("#job-title").fill("합성 단일 예약");
        await page.locator("#job-from").fill("3");
        await page.locator("#job-to").fill("8");
        await page.locator("#job-format").selectOption("epub");
        await page.locator("#job-overwrite").check();
        await page.locator("#job-submit").click();
        await page.locator("#job-dialog").waitFor({ state: "hidden" });
        const single = data.calls.find(
          (call) => call.path === "/api/jobs" && call.method === "POST",
        ).body;
        assert.deepEqual(
          {
            title: single.title,
            start: single.startEpisode,
            end: single.endEpisode,
            format: single.format,
            overwrite: single.overwrite,
          },
          {
            title: "합성 단일 예약",
            start: 3,
            end: 8,
            format: "epub",
            overwrite: true,
          },
        );
        await page.locator("#add-batch-button").click();
        await shown(page, "#batch-dialog");
        await page
          .locator("#batch-urls")
          .fill(
            "https://example.test/novel/401\nhttps://example.test/novel/402",
          );
        await page.locator("#batch-from").fill("2");
        await page.locator("#batch-to").fill("5");
        await page.locator("#batch-format").selectOption("epub");
        await page.locator("#batch-submit").click();
        await page.waitForFunction(() =>
          document.getElementById("batch-result").textContent.includes("2"),
        );
        const batch = data.calls.find((call) => call.path === "/api/jobs/batch")
          .body.jobs;
        assert.equal(batch.length, 2);
        assert.equal(batch[0].startEpisode, 2);
        assert.equal(batch[0].endEpisode, 5);
        assert.equal(batch[1].format, "epub");
        await page
          .locator('#batch-dialog [data-close="batch-dialog"]')
          .first()
          .click();
        await page.locator("#logs-running-one").click();
        await shown(page, "#events-panel");
        await page.waitForFunction(() =>
          document
            .getElementById("events-list")
            .textContent.includes("합성 회차 저장"),
        );
        await page.locator("#close-events").click();

        await visit(page, "settings");
        await page.locator("#settings-concurrency").selectOption("1");
        await page.locator("#settings-delay").fill("2500");
        await page.locator("#settings-save").click();
        await page.waitForFunction(() =>
          document
            .getElementById("settings-save-message")
            .textContent.includes("적용"),
        );
        assert.equal(data.settings.maxConcurrency, 1);
        assert.equal(data.settings.chapterDelayMs, 2500);
        for (const id of [
          "settings-export",
          "settings-import-preview",
          "password-save",
          "update-apply",
          "site-account-save",
        ])
          await shown(page, "#" + id);
        await page.locator("#update-apply").click();
        for (const id of ["update-channel", "update-candidate", "update-check"])
          await shown(page, "#" + id);
        await page.keyboard.press("Escape");

        await visit(page, "presets");
        await page.waitForFunction(
          () => !document.getElementById("preset-add-default").disabled,
        );
        await page.locator("#preset-add-default").click();
        await shown(page, "#preset-activation");
        for (const kind of ["listing", "detail", "reader"]) {
          await page
            .locator("#preset-check-" + kind + "-url")
            .fill(
              "https://example.test/novel/" +
                (kind === "listing" ? "" : kind === "detail" ? "101" : "101/1"),
            );
          await page.locator("#preset-check-" + kind).click();
          await page.waitForFunction(
            (kind) =>
              document
                .getElementById("preset-check-" + kind + "-status")
                .textContent.includes("확인 완료"),
            kind,
          );
        }
        await page.locator("#preset-apply").click();
        await shown(page, "#preset-unbind");
        await page.locator("#preset-unbind").click();
        await page.locator("#preset-unbind").waitFor({ state: "hidden" });
        assert.equal(data.bindings.length, 0);
        await shown(page, "#preset-save");
        await shown(page, "#preset-bookmarklet");
        await shown(page, "#preset-connect");
        await shown(page, "#preset-content-type");
        await visit(page, "releases");
        await page.locator("#release-history-list .release-record").waitFor();
        await page.locator("#release-history-version").selectOption("1.0.0.11");
        assert.equal(
          await page.locator("#release-history-list .release-record").count(),
          1,
        );
        assert.match(
          await page.locator("#release-history-list").innerText(),
          /합성 화면 검증/,
        );
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });
  },
);
