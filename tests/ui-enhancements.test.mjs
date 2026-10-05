import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
const tick = () => new Promise((resolve) => setTimeout(resolve, 35));
async function setup(
  t,
  {
    passwordError = false,
    missingOnly = false,
    bookCount = 2,
    zeroBody = false,
    backoff = null,
    manualPaused = false,
    legacyCaptcha = false,
  } = {},
) {
  const dom = new JSDOM(
    await readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    {
      url: "http://localhost:8788",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  t.after(() => dom.window.close());
  const w = dom.window,
    calls = [];
  w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new w.Event("close"));
  };
  w.HTMLElement.prototype.scrollIntoView = function () {};
  const jobs = [
    {
      id: "j1",
      title: "테스트",
      url: "https://newtoki1.org/novel/1",
      status: "running",
      total: 100,
      completed: 2,
      exports: {},
      estimatedSecondsRemaining: 125,
      estimatedCompletionAt: "2026-10-02T15:00:00Z",
      timing: { samples: 2, confidence: "low" },
    },
    {
      id: "j2",
      title: "실패",
      url: "https://newtoki1.org/novel/2",
      status: "failed",
      total: 2,
      failed: 1,
      failedChapters: [
        { id: "22", number: 2, title: "실패한 회차", error: "추출 실패" },
      ],
      exports: {},
    },
  ];
  if (legacyCaptcha)
    Object.assign(jobs[0], {
      status: "needs_attention",
      phase: "사이트 인증 필요",
      error:
        "일일 조회 인증이 필요합니다. 서버 브라우저 1·2에서 직접 인증 후 확인하세요.",
    });
  const books = [
    {
      id: "1",
      title: "첫 작품",
      author: "작가",
      genres: ["판타지"],
      storedChapterCount: 2,
      expectedChapterCount: 5,
      failedChapterCount: 1,
      thumbnail: "/api/books/1/thumbnail",
    },
    {
      id: "2",
      title: "다른 작품",
      storedChapterCount: 10,
      expectedChapterCount: null,
      thumbnail: "https://unsafe.example/cover",
    },
  ];
  if (missingOnly)
    Object.assign(books[0], {
      storedChapterCount: 1,
      expectedChapterCount: 3,
      missingChapterCount: 2,
      failedChapterCount: 0,
    });
  for (let index = books.length; index < bookCount; index++)
    books.push({
      id: String(index + 1),
      title: `작품 ${index + 1}`,
      storedChapterCount: 1,
    });
  if (zeroBody)
    books.push({
      id: "3",
      title: "목차만 있는 작품",
      storedChapterCount: 0,
      expectedChapterCount: 10,
      missingChapterCount: 10,
    });
  w.fetch = async (path, options = {}) => {
    calls.push({ path, options });
    let data;
    if (path === "/api/session") data = { authenticated: true };
    else if (path === "/api/status")
      data = {
        runner: "running",
        maxConcurrency: 2,
        backoff,
        queuePaused:
          (manualPaused ||
            calls.some((call) => call.path === "/api/queue/pause")) &&
          !calls.some((call) => call.path === "/api/queue/start"),
      };
    else if (path === "/api/queue/pause" || path === "/api/queue/start")
      data = {
        paused: path.endsWith("/pause"),
        affected: 2,
        maxConcurrency: 2,
      };
    else if (path === "/api/jobs") data = jobs;
    else if (path === "/api/books") data = books;
    else if (path === "/api/settings")
      data =
        options.method === "PUT"
          ? JSON.parse(options.body)
          : { maxConcurrency: 2, chapterDelayMs: 1200, defaultFormat: "epub" };
    else if (path === "/api/settings/password") {
      if (passwordError)
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: "현재 비밀번호를 확인하세요." }),
        };
      data = { changed: true };
    } else if (path.endsWith("/events"))
      data = [
        {
          time: "2026-10-02T15:00:00Z",
          message: legacyCaptcha ? "일일 조회 인증이 필요합니다." : "정상 로그",
          level: "info",
        },
      ];
    else if (path === "/api/downloads")
      data = { id: "zip1", status: "preparing", processed: 0, total: 2 };
    else if (path === "/api/downloads/zip1")
      data = { id: "zip1", status: "ready", processed: 2, total: 2 };
    else if (path === "/api/books/1/failures")
      data = missingOnly
        ? []
        : [
            { id: "11", number: 1, title: "첫 실패" },
            { id: "12", number: 2, title: "다른 실패" },
          ];
    else if (path === "/api/books/1/retry-failed")
      data = {
        id: "retry-book-1",
        title: "첫 작품",
        url: "https://newtoki1.org/novel/1",
        status: "queued",
        exports: {},
      };
    else if (path.endsWith("/action")) data = { ...jobs[1], status: "queued" };
    else throw Error("Unexpected " + path);
    return { ok: true, status: 200, json: async () => data };
  };
  for (const name of [
    "performance.js",
    "queue-ui.js",
    "app.js",
    "logs.js",
    "library.js",
    "settings.js",
    "discovery.js",
  ]) {
    try {
      w.eval(
        (await readFile(new URL("../public/" + name, import.meta.url), "utf8")) +
          "\n//# sourceURL=" + new URL("../public/" + name, import.meta.url).href,
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  await tick();
  return { w, calls };
}
const click = (w, id) => {
  assert.ok(w.document.getElementById(id), "missing " + id);
  w.document.getElementById(id).click();
};
test("legacy daily CAPTCHA errors are neutral in job cards, phases and logs without changing real rate limits", async (t) => {
  const { w } = await setup(t, {
    legacyCaptcha: true,
    backoff: {
      active: true,
      until: new Date(Date.now() + 600000).toISOString(),
      reason: "일일 조회 인증이 필요합니다.",
      consecutiveFailures: 5,
    },
  });
  assert.ok(
    !w.document
      .getElementById("queue-view")
      .textContent.includes("일일 조회 인증"),
  );
  assert.match(w.document.getElementById("jobs-list").textContent, /CAPTCHA/);
  assert.equal(w.document.getElementById("resume-j1"), null);
  assert.equal(w.document.getElementById("retry-j1"), null);
  assert.equal(
    w.document.querySelector(".job-card .status-pill.needs_attention"),
    null,
  );
  assert.equal(w.document.getElementById("queue-backoff").hidden, false);
  click(w, "logs-j1");
  await tick();
  assert.ok(
    !w.document
      .getElementById("events-list")
      .textContent.includes("일일 조회 인증"),
  );
});

test("Logs inspector opens across menus and persists only collapse preference", async (t) => {
  const { w } = await setup(t);
  click(w, "logs-j1");
  await tick();
  assert.equal(w.document.getElementById("events-panel").hidden, false);
  assert.match(
    w.document.getElementById("events-list").textContent,
    /정상 로그/,
  );
  click(w, "nav-library");
  await tick();
  assert.equal(
    w.document.getElementById("events-panel").parentElement.id,
    "app-view",
  );
  click(w, "close-events");
  assert.equal(w.document.getElementById("events-panel").hidden, true);
  assert.equal(w.localStorage.getItem("collector.logsCollapsed"), "true");
});
test("Settings update and password change keep auth, clear sensitive fields, show current-password error", async (t) => {
  const { w, calls } = await setup(t);
  click(w, "nav-settings");
  await tick();
  assert.equal(w.document.getElementById("settings-format").value, "epub");
  w.document.getElementById("settings-concurrency").value = "1";
  w.document
    .getElementById("settings-form")
    .dispatchEvent(new w.Event("submit", { cancelable: true }));
  await tick();
  assert.equal(
    JSON.parse(
      calls.find(
        (c) => c.path === "/api/settings" && c.options.method === "PUT",
      ).options.body,
    ).maxConcurrency,
    1,
  );
  for (const [id, value] of [
    ["password-current", "old-secret"],
    ["password-new", "new-secret-123"],
    ["password-confirm", "new-secret-123"],
  ])
    w.document.getElementById(id).value = value;
  w.document
    .getElementById("password-form")
    .dispatchEvent(new w.Event("submit", { cancelable: true }));
  await tick();
  assert.equal(w.document.getElementById("password-new").value, "");
  assert.equal(w.document.getElementById("app-view").hidden, false);
  assert.ok(!JSON.stringify({ ...w.localStorage }).includes("secret"));
  const bad = await setup(t, { passwordError: true });
  click(bad.w, "nav-settings");
  await tick();
  for (const [id, value] of [
    ["password-current", "bad"],
    ["password-new", "new-secret-123"],
    ["password-confirm", "new-secret-123"],
  ])
    bad.w.document.getElementById(id).value = value;
  bad.w.document
    .getElementById("password-form")
    .dispatchEvent(new bad.w.Event("submit", { cancelable: true }));
  await tick();
  assert.match(
    bad.w.document.getElementById("password-error").textContent,
    /현재 비밀번호/,
  );
});
test("Library selection prepares one ZIP and offers authenticated download; metadata honest", async (t) => {
  const { w, calls } = await setup(t);
  click(w, "nav-library");
  await tick();
  assert.match(w.document.getElementById("books-list").textContent, /2.*5/);
  assert.equal(
    w.document.querySelectorAll('#books-list img[src^="https:"]').length,
    0,
  );
  click(w, "library-select-all");
  click(w, "library-download-selected");
  await tick();
  assert.deepEqual(
    JSON.parse(calls.find((c) => c.path === "/api/downloads").options.body)
      .bookIds,
    ["1", "2"],
  );
  await new Promise((resolve) => setTimeout(resolve, 2050));
  assert.equal(
    w.document.getElementById("bundle-download-link").getAttribute("href"),
    "/api/downloads/zip1/file",
  );
});
test("ETA shows estimate and retry-failed submits only selected failed chapter IDs", async (t) => {
  const { w, calls } = await setup(t);
  assert.match(w.document.getElementById("jobs-list").textContent, /추정.*2분/);
  click(w, "retry-failed-j2");
  await tick();
  assert.match(
    w.document.getElementById("failures-list").textContent,
    /실패한 회차/,
  );
  click(w, "failures-submit");
  await tick();
  const request = calls.find((c) => c.path === "/api/jobs/j2/action");
  assert.ok(request);
  assert.deepEqual(JSON.parse(request.options.body), {
    action: "retry_failed",
    chapterIds: ["22"],
  });
});
test("Library failure retry excludes unchecked chapters and default setting updates forms", async (t) => {
  const { w, calls } = await setup(t);
  assert.equal(w.document.getElementById("batch-format").value, "epub");
  click(w, "nav-library");
  await tick();
  w.document.querySelector("#books-list .book-actions .quiet").click();
  await tick();
  const checks = w.document.querySelectorAll("#failures-list input");
  assert.equal(checks.length, 2);
  checks[1].checked = false;
  click(w, "failures-submit");
  await tick();
  const request = calls.find((c) => c.path === "/api/books/1/retry-failed");
  assert.deepEqual(JSON.parse(request.options.body), { chapterIds: ["11"] });
});
test("Legacy book with missing chapters and no failure ledger queues missing-only retry", async (t) => {
  const { w, calls } = await setup(t, { missingOnly: true });
  click(w, "nav-library");
  await tick();
  w.document.querySelector("#books-list .book-actions .quiet").click();
  await tick();
  assert.equal(w.document.getElementById("failures-dialog").open, true);
  assert.match(
    w.document.getElementById("failures-title").textContent,
    /누락 회차/,
  );
  assert.match(
    w.document.getElementById("failures-note").textContent,
    /저장된 정상 회차.*유지/,
  );
  click(w, "failures-submit");
  await tick();
  const request = calls.find((c) => c.path === "/api/books/1/retry-failed");
  assert.ok(request);
  assert.deepEqual(JSON.parse(request.options.body), {});
  assert.ok(
    !JSON.parse(request.options.body).overwrite,
    "Saved successful chapters must not be overwritten",
  );
});
test("All TXT download requests entire snapshot beyond selected limit of 200", async (t) => {
  const { w, calls } = await setup(t, { bookCount: 201 });
  click(w, "nav-library");
  await tick();
  click(w, "library-download-all");
  await tick();
  const request = calls.find((call) => call.path === "/api/downloads");
  assert.ok(request);
  assert.deepEqual(JSON.parse(request.options.body), { all: true });
});
test("Catalog-only book waits for stored chapters before reading, selection, downloads or missing retry", async (t) => {
  const { w, calls } = await setup(t, { zeroBody: true });
  click(w, "nav-library");
  await tick();
  const card = [...w.document.querySelectorAll("#books-list .book-card")].find(
    (el) => el.textContent.includes("목차만 있는 작품"),
  );
  assert.ok(card);
  assert.equal(card.querySelector('input[type="checkbox"]').disabled, true);
  assert.equal(card.querySelector("a.export-link"), null);
  assert.match(card.textContent, /저장된 본문 없음/);
  assert.equal(card.querySelector(".book-actions .secondary").disabled, true);
  assert.equal(card.querySelector(".book-actions .quiet"), null);
  assert.match(card.textContent, /본문 수집 대기/);
  click(w, "library-select-all");
  click(w, "library-download-selected");
  await tick();
  const request = calls.find((call) => call.path === "/api/downloads");
  assert.deepEqual(JSON.parse(request.options.body).bookIds, ["1", "2"]);
});
test("Global queue buttons use queue endpoints without resetting jobs and refresh status", async (t) => {
  const { w, calls } = await setup(t);
  click(w, "queue-pause-all");
  await tick();
  const pause = calls.find((call) => call.path === "/api/queue/pause");
  assert.ok(pause);
  assert.equal(pause.options.method, "POST");
  assert.deepEqual(JSON.parse(pause.options.body), {});
  assert.match(
    w.document.getElementById("runner-summary").textContent,
    /전체.*일시정지/,
  );
  assert.equal(w.document.getElementById("queue-pause-all").disabled, false);
  click(w, "queue-start-all");
  await tick();
  const start = calls.find((call) => call.path === "/api/queue/start");
  assert.ok(start);
  assert.deepEqual(JSON.parse(start.options.body), {});
  assert.ok(
    !calls.some((call) => call.path.endsWith("/action")),
    "Global actions must not overwrite/retry individual jobs",
  );
});
test("Discovery and library covers contain the entire portrait or landscape image", async (t) => {
  const { w } = await setup(t);
  const style = w.document.createElement("style");
  style.textContent = await readFile(
    new URL("../public/styles.css", import.meta.url),
    "utf8",
  );
  w.document.head.append(style);
  for (const frameClass of ["discover-cover", "library-cover"]) {
    const frame = w.document.createElement("div");
    frame.className = frameClass;
    const image = w.document.createElement("img");
    frame.append(image);
    w.document.body.append(frame);
    assert.equal(w.getComputedStyle(image).objectFit, "contain");
    assert.equal(w.getComputedStyle(image).objectPosition, "center");
    assert.equal(w.getComputedStyle(frame).aspectRatio, "3 / 4");
  }
});
test("Cooldown shows countdown, keeps global controls and downloads available, start cannot clear it", async (t) => {
  const backoff = {
    active: true,
    until: new Date(Date.now() + 600000).toISOString(),
    remainingSeconds: 600,
    consecutiveFailures: 5,
    reason: "연속 실패",
  };
  const { w, calls } = await setup(t, { backoff });
  assert.equal(w.document.getElementById("queue-backoff").hidden, false);
  assert.match(
    w.document.getElementById("queue-backoff").textContent,
    /서버 요청 제한.*남은.*분/,
  );
  assert.match(
    w.document.getElementById("queue-backoff").textContent,
    /대기 시간.*끝난 뒤/,
  );
  assert.match(
    w.document.getElementById("jobs-list").textContent,
    /요청 대기 후.*다시 계산/,
  );
  assert.equal(w.document.getElementById("queue-pause-all").disabled, false);
  assert.equal(
    w.document.getElementById("library-download-all").disabled,
    false,
  );
  click(w, "queue-start-all");
  await tick();
  assert.equal(w.document.getElementById("queue-backoff").hidden, false);
  assert.ok(!calls.some((call) => /force|reset.*backoff/.test(call.path)));
  backoff.active = false;
  w.dispatchEvent(new w.Event("online"));
  await tick();
  assert.equal(w.document.getElementById("queue-backoff").hidden, true);
});
test("Manual pause remains explicit and survives automatic cooldown expiration", async (t) => {
  const backoff = {
    active: true,
    until: new Date(Date.now() + 600000).toISOString(),
    remainingSeconds: 600,
    consecutiveFailures: 5,
  };
  const { w } = await setup(t, { backoff, manualPaused: true });
  assert.match(
    w.document.getElementById("runner-summary").textContent,
    /전체.*일시정지.*자동 재개 없음/,
  );
  assert.match(
    w.document.getElementById("queue-backoff").textContent,
    /전체 일시정지는 유지/,
  );
  backoff.active = false;
  w.dispatchEvent(new w.Event("online"));
  await tick();
  assert.match(
    w.document.getElementById("runner-summary").textContent,
    /자동 재개 없음/,
  );
});
