import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms || 30));
async function setup(t, count = 60) {
  const dom = new JSDOM(
    await readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    {
      url: "https://localhost/",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  t.after(() => dom.window.close());
  const w = dom.window,
    calls = [],
    timers = [];
  w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new w.Event("close"));
  };
  w.HTMLElement.prototype.scrollIntoView = function () {};
  const original = w.setTimeout.bind(w);
  w.setTimeout = (fn, delay, ...args) => {
    timers.push(delay);
    return original(fn, delay, ...args);
  };
  const books = Array.from({ length: count }, (_, n) => ({
    id: String(n + 1),
    title: `작품 ${String(n + 1).padStart(3, "0")}`,
    genres: [n % 2 ? "무협" : "판타지"],
    storedChapterCount: 1,
    updatedAt: "2026-10-03",
  }));
  w.fetch = async (path, options = {}) => {
    calls.push({ path, options });
    let data;
    if (path === "/api/session") data = { authenticated: true };
    else if (path === "/api/status") data = { maxConcurrency: 2 };
    else if (path === "/api/jobs") data = [];
    else if (path === "/api/books") data = books;
    else if (path === "/api/logout") data = {};
    else if (path.startsWith("/api/jobs/") && path.endsWith("/events"))
      data = [];
    else throw new Error(path);
    return { ok: true, status: 200, json: async () => data };
  };
  for (const name of [
    "performance.js",
    "queue-ui.js",
    "app.js",
    "logs.js",
    "library.js",
  ])
    w.eval(
      (await readFile(new URL("../public/" + name, import.meta.url), "utf8")) +
        "\n//# sourceURL=" +
        new URL("../public/" + name, import.meta.url).href,
    );
  await tick();
  return { w, calls, timers, books };
}
test("preferences apply safely at runtime and only the visible view fetches books", async (t) => {
  const { w, calls, timers } = await setup(t);
  assert.equal(calls.filter((x) => x.path === "/api/books").length, 0);
  w.CollectorUI.applyPreferences({
    refreshIntervalMs: 9000,
    libraryPageSize: 12,
    thumbnailFit: "cover",
    displayDensity: "compact",
  });
  const preferences = w.CollectorUI.preferences();
  assert.equal(preferences.refreshIntervalMs, 9000);
  preferences.libraryPageSize = 999;
  assert.equal(w.CollectorUI.preferences().libraryPageSize, 12);
  assert.equal(w.document.documentElement.dataset.density, "compact");
  assert.equal(w.document.documentElement.dataset.thumbnailFit, "cover");
  assert.ok(timers.includes(9000));
  w.document.querySelector('[data-view="library"]').click();
  await tick();
  assert.equal(
    w.document.querySelectorAll("#books-list .book-card").length,
    12,
  );
});
test("library pagination limits DOM cards and preserves selections across pages and filters", async (t) => {
  const { w } = await setup(t);
  w.document.querySelector('[data-view="library"]').click();
  await tick();
  const $ = (id) => w.document.getElementById(id);
  assert.equal(
    w.document.querySelectorAll("#books-list .book-card").length,
    24,
  );
  const first = w.document.querySelector('#books-list input[type="checkbox"]');
  first.click();
  $("library-next").click();
  assert.equal(
    w.document.querySelectorAll("#books-list .book-card").length,
    24,
  );
  assert.match($("library-selected").textContent, /1개/);
  $("library-prev").click();
  assert.equal(
    w.document.querySelector('#books-list input[type="checkbox"]').checked,
    true,
  );
  $("library-select-all").click();
  assert.match($("library-selected").textContent, /60개/);
  $("library-genre").value = "무협";
  $("library-genre").dispatchEvent(new w.Event("change"));
  assert.match($("library-selected").textContent, /60개/);
  assert.equal(
    w.document.querySelectorAll("#books-list .book-card").length,
    24,
  );
  const cover = w.document.querySelector("#books-list img");
  assert.equal(cover.getAttribute("width"), "160");
  assert.equal(cover.getAttribute("height"), "224");
  assert.equal(cover.loading, "lazy");
});
test("unchanged refresh preserves DOM and search is debounced rather than rebuilt per key", async (t) => {
  const { w } = await setup(t);
  w.document.querySelector('[data-view="library"]').click();
  await tick();
  const list = w.document.getElementById("books-list"),
    first = list.firstElementChild;
  await w.CollectorLibrary.refresh();
  assert.equal(list.firstElementChild, first);
  const input = w.document.getElementById("library-query");
  input.value = "작품 060";
  input.dispatchEvent(new w.Event("input"));
  assert.equal(list.firstElementChild, first);
  await tick(300);
  assert.equal(list.querySelectorAll(".book-card").length, 1);
  assert.match(list.textContent, /060/);
});

test("changing one queued job retains the other card nodes and focused controls", async (t) => {
  const { w } = await setup(t, 0);
  for (let i = 1; i <= 20; i++)
    w.CollectorUI.addJob({
      id: `job${i}`,
      title: `작품${i}`,
      status: "queued",
      url: `https://newtoki1.org/novel/${i}`,
      exports: {},
    });
  const nodes = [...w.document.querySelectorAll("#jobs-list .job-card")];
  const button = w.document.getElementById("logs-job10");
  button.focus();
  w.CollectorUI.addJob({ ...w.CollectorUI.job("job1"), phase: "변경된 작업" });
  const updated = [...w.document.querySelectorAll("#jobs-list .job-card")];
  assert.equal(updated[0], nodes[0]);
  assert.match(updated[0].textContent, /변경된 작업/);
  assert.equal(
    updated.slice(1).every((node, i) => node === nodes[i + 1]),
    true,
  );
  assert.equal(w.document.activeElement, button);
});

test("Log selection and pending actions update labels without replacing their card or focused controls", async (t) => {
  const { w } = await setup(t, 0);
  const job = {
    id: "stable",
    title: "작품",
    status: "queued",
    url: "https://newtoki1.org/novel/1",
    exports: {},
  };
  w.CollectorUI.addJob(job);
  const card = w.document.querySelector("#jobs-list .job-card"),
    logs = w.document.getElementById("logs-stable"),
    pause = w.document.getElementById("pause-stable");
  logs.focus();
  w.CollectorUI.selectJob("stable");
  assert.equal(w.document.querySelector("#jobs-list .job-card"), card);
  assert.equal(w.document.getElementById("logs-stable"), logs);
  assert.equal(logs.textContent, "로그 보는 중");
  let release;
  w.fetch = async () =>
    new Promise((resolve) => {
      release = () =>
        resolve({ ok: true, json: async () => ({ ...job, status: "paused" }) });
    });
  pause.click();
  assert.equal(pause.disabled, true);
  assert.equal(w.document.querySelector("#jobs-list .job-card"), card);
  release();
  await tick();
  assert.equal(w.document.querySelector("#jobs-list .job-card"), card);
  assert.ok(w.document.getElementById("resume-stable"));
  assert.equal(w.document.activeElement, logs);
});

test("CAPTCHA attention changes refresh only affected job content even when job data is unchanged", async (t) => {
  const { w } = await setup(t, 0),
    jobs = [
      {
        id: "blocked",
        title: "확인 작품",
        status: "needs_attention",
        url: "https://newtoki1.org/novel/1",
        exports: {},
      },
      {
        id: "safe",
        title: "다른 작품",
        status: "paused",
        url: "https://newtoki2.org/novel/2",
        exports: {},
      },
    ];
  for (const job of jobs) w.CollectorUI.addJob(job);
  const blocked = w.document
      .getElementById("logs-blocked")
      .closest(".job-card"),
    safe = w.document.getElementById("logs-safe").closest(".job-card");
  const original = w.fetch;
  w.fetch = async (path, options) =>
    path === "/api/status"
      ? {
          ok: true,
          json: async () => ({
            siteAttention: [{ host: "newtoki1.org", kind: "captcha" }],
          }),
        }
      : path === "/api/jobs"
        ? { ok: true, json: async () => jobs }
        : original(path, options);
  await w.CollectorUI.refresh();
  assert.equal(
    w.document.getElementById("logs-blocked").closest(".job-card"),
    blocked,
  );
  assert.equal(
    w.document.getElementById("logs-safe").closest(".job-card"),
    safe,
  );
  assert.match(blocked.textContent, /CAPTCHA 대기/);
  assert.equal(w.document.getElementById("resume-blocked"), null);
  assert.ok(w.document.getElementById("resume-safe"));
});
test("hidden tabs pause polling and log requests, and focus retains a single in-flight refresh", async (t) => {
  const { w, calls } = await setup(t);
  let hidden = false;
  Object.defineProperty(w.document, "hidden", {
    get: () => hidden,
    configurable: true,
  });
  await w.CollectorLogs.open({ id: "1", title: "수집" });
  const logs = calls.filter((call) => call.path.endsWith("/events")).length;
  hidden = true;
  w.document.dispatchEvent(new w.Event("visibilitychange"));
  await w.CollectorLogs.refresh();
  w.dispatchEvent(new w.Event("focus"));
  await tick();
  assert.equal(
    calls.filter((call) => call.path.endsWith("/events")).length,
    logs,
  );
  hidden = false;
  let release, started;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const original = w.fetch;
  let jobRequests = 0;
  w.fetch = async (path, options) => {
    if (path === "/api/jobs") {
      jobRequests++;
      started();
      await gate;
    }
    return original(path, options);
  };
  w.dispatchEvent(new w.Event("focus"));
  await ready;
  w.dispatchEvent(new w.Event("focus"));
  assert.equal(jobRequests, 1);
  release();
  await tick();
  assert.equal(w.CollectorUI.authenticated(), true);
});
test("hidden queue DOM stays untouched until shown and late library responses cannot restore logged-out data", async (t) => {
  const { w } = await setup(t);
  const $ = (id) => w.document.getElementById(id);
  w.document.querySelector('[data-view="library"]').click();
  await tick();
  const first = $("jobs-list").firstElementChild;
  w.CollectorUI.addJob({
    id: "job1",
    title: "새로운 예약",
    status: "queued",
    exports: {},
    url: "https://newtoki1.org/novel/1",
  });
  assert.equal($("jobs-list").firstElementChild, first);
  w.document.querySelector('[data-view="queue"]').click();
  assert.match($("jobs-list").textContent, /새로운 예약/);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const original = w.fetch;
  w.fetch = async (path, options) => {
    if (path === "/api/books") {
      await gate;
      return {
        ok: true,
        status: 200,
        json: async () => [{ id: "private", title: "늦은 비공개 응답" }],
      };
    }
    return original(path, options);
  };
  w.document.querySelector('[data-view="library"]').click();
  await tick();
  $("logout-button").click();
  await tick();
  release();
  await tick();
  assert.equal(w.CollectorUI.authenticated(), false);
  assert.equal($("books-list").children.length, 0);
  assert.doesNotMatch($("books-list").textContent, /비공개/);
});
test("discovery updates one card without rebuilding other covers and focus does not start new source scans", async (t) => {
  const { w } = await setup(t);
  const calls = [],
    observers = [];
  w.IntersectionObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      observers.push(this);
    }
    observe(el) {
      this.targets.push(el);
    }
    unobserve() {}
    disconnect() {
      this.targets = [];
    }
  };
  const item = (id) => ({
    id: String(id),
    title: "작품 " + id,
    url: `https://newtoki1.org/novel/${id}`,
    genres: [],
    episodeCount: id === 2 ? 5 : null,
    thumbnail: `/api/discover/${id}/thumbnail`,
  });
  const original = w.fetch;
  w.fetch = async (path, options) => {
    if (path.startsWith("/api/discover")) {
      calls.push(path);
      return {
        ok: true,
        status: 200,
        json: async () =>
          path.includes("/refresh")
            ? { status: "completed", item: { ...item(1), episodeCount: 10 } }
            : { items: [item(1), item(2), item(3)], page: 1, maxPage: 1 },
      };
    }
    return original(path, options);
  };
  w.eval(
    await readFile(new URL("../public/discovery.js", import.meta.url), "utf8"),
  );
  w.document.querySelector('[data-view="discover"]').click();
  await tick();
  const cover = w.document.querySelector('[data-id="2"] img'),
    firstObserver = observers.at(-1);
  firstObserver.callback([
    { isIntersecting: true, target: w.document.querySelector('[data-id="1"]') },
  ]);
  await tick();
  assert.equal(w.document.querySelector('[data-id="2"] img'), cover);
  assert.ok(calls.some((path) => path.endsWith("/1/refresh")));
  let hidden = true;
  Object.defineProperty(w.document, "hidden", {
    get: () => hidden,
    configurable: true,
  });
  w.document.dispatchEvent(new w.Event("visibilitychange"));
  const before = calls.length;
  hidden = false;
  w.document.dispatchEvent(new w.Event("visibilitychange"));
  w.dispatchEvent(new w.Event("focus"));
  await tick();
  assert.equal(calls.length, before);
  const image = w.document.querySelector('[data-id="2"] img');
  assert.equal(image.width, 160);
  assert.equal(image.height, 224);
  assert.equal(image.decoding, "async");
});
