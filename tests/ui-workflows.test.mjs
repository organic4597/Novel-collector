import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

async function setup(t, configuration = {}) {
  const html = await readFile(
    new URL("../public/index.html", import.meta.url),
    "utf8",
  );
  const dom = new JSDOM(html, {
    url: "http://localhost:8788",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const w = dom.window,
    calls = [],
    scrolls = [],
    stats = { refreshActive: 0, maxRefreshActive: 0 },
    observers = [];
  if (configuration.observer)
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
  w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new w.Event("close"));
  };
  w.HTMLElement.prototype.scrollIntoView = function (options) { scrolls.push({ element: this, options }); };
  const statuses = [
    "running",
    "running",
    "queued",
    "paused",
    "needs_attention",
    "failed",
    "completed",
    "completed_with_errors",
    "cancelled",
  ];
  let jobs = statuses.map((status, i) => ({
    id: "job-" + i,
    title: "작품 " + i,
    url: "https://newtoki1.org/novel/" + (100 + i),
    status,
    phase: "본문 읽는 중",
    total: 3,
    completed: status === "completed" ? 3 : 0,
    skipped: 0,
    failed: 0,
    exports: {},
  }));
  const item = (id) => ({
    id,
    url: "https://newtoki1.org/novel/" + id,
    title: "<img src=x> 작품 " + id,
    genres: ["판타지"],
    platform: "플랫폼",
    publication: "ongoing",
    episodeCount: null,
    thumbnail:
      id === "1" ? "/api/discover/1/thumbnail" : "https://unsafe.example/image",
    updatedLabel: "오늘",
  });
  w.fetch = async (path, options = {}) => {
    calls.push({ path, options });
    let data;
    if (path === "/api/session")
      data = { authenticated: configuration.authenticated !== false };
    else if (path === "/api/status")
      data = {
        runner: "running",
        activeJobIds: ["job-0", "job-1"],
        maxConcurrency: 2,
        collector: { available: true },
        browserAgents: [],
      };
    else if (path === "/api/jobs") data = jobs;
    else if (path === "/api/books") data = [];
    else if (path === "/api/jobs/batch") {
      if (configuration.batchError)
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: "올바른 작품 URL을 입력하세요." }),
        };
      data = {
        jobs: JSON.parse(options.body).jobs.map((job, i) => ({
          ...job,
          id: "new-" + i,
          status: "queued",
        })),
        skipped: [{ url: "duplicate", reason: "이미 대기 중" }],
      };
    } else if (/^\/api\/discover\/\d+\/overview$/.test(path)) {
      const id=path.split("/")[3];
      data=options.method==="POST" ? {status:"completed",item:{...item(id),author:"소개 작가",tags:["성장"],synopsis:"소개 첫 줄\n소개 다음 줄",episodeCount:17}} : {status:"idle",item:item(id)};
    } else if (options.method === "DELETE") {
      jobs = jobs.filter((j) => "/api/jobs/" + j.id !== path);
      data = { deleted: true };
    } else if (path.endsWith("/events")) data = [];
    else if (path.startsWith("/api/discover?")) {
      const q = new URL(path, "http://localhost").searchParams;
      data = {
        items: configuration.manyItems
          ? [item("1"), item("2"), item("3")]
          : [item(q.get("page") === "2" ? "2" : "1")],
        page: Number(q.get("page")),
        maxPage: 2,
        total: 2,
        filters: { genres: ["판타지"], platforms: ["플랫폼"] },
        cachedAt: "2026-10-02T00:00:00Z",
      };
      if (configuration.fortyItemPages) {
        const page = data.page;
        data.items = Array.from({ length: page === 3 ? 15 : 40 }, (_, index) => item(String((page - 1) * 40 + index + 1)));
        data.maxPage = 3;
        data.total = 95;
        data.pageSize = 40;
      }
    } else if (path.endsWith("/refresh")) {
      stats.refreshActive++;
      stats.maxRefreshActive = Math.max(
        stats.maxRefreshActive,
        stats.refreshActive,
      );
      await new Promise((r) => setTimeout(r, 10));
      stats.refreshActive--;
      data = configuration.metadataFailure
        ? { status: "failed", error: "사이트 확인이 필요합니다." }
        : configuration.metadataPending
          ? { status: "pending" }
          : { ...item(path.split("/")[3]), episodeCount: 200 };
    } else if (path.endsWith("/metadata")) {
      data = {
        status: "completed",
        item: { ...item(path.split("/")[3]), episodeCount: 200 },
      };
    } else throw Error("Unexpected " + path);
    return { ok: true, status: 200, json: async () => data };
  };
  for (const file of [
    "performance.js",
    "queue-ui.js",
    "app.js",
    "logs.js",
    "library.js",
    "settings.js",
    "discovery.js",
    "discovery-detail.js",
  ]) {
    try {
      w.eval(
        await readFile(new URL("../public/" + file, import.meta.url), "utf8"),
      );
    } catch (e) {
      if (file === "app.js" || e.code !== "ENOENT") throw e;
    }
  }
  await tick();
  return { w, calls, stats, observers, scrolls };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const click = (w, id) => {
  assert.ok(w.document.getElementById(id), "missing " + id);
  w.document.getElementById(id).click();
};

test("Queue separates terminal history, two active jobs show, record deletion preserves library", async (t) => {
  const { w, calls } = await setup(t);
  assert.equal(w.document.querySelectorAll("#jobs-list .job-card").length, 6);
  assert.match(w.document.getElementById("active-summary").textContent, /2/);
  assert.match(w.document.getElementById("runner-summary").textContent, /2/);
  click(w, "nav-history");
  assert.equal(
    w.document.querySelectorAll("#history-list .job-card").length,
    3,
  );
  click(w, "logs-job-6");
  await tick();
  click(w, "delete-job-6");
  await tick();
  assert.ok(
    calls.some(
      (c) => c.path === "/api/jobs/job-6" && c.options.method === "DELETE",
    ),
  );
  assert.equal(
    w.document.querySelectorAll("#history-list .job-card").length,
    2,
  );
  assert.equal(w.document.getElementById("events-panel").hidden, true);
  assert.match(
    w.document.getElementById("history-view").textContent,
    /본문.*유지/,
  );
  w.document.querySelector('[data-history-filter="failed"]').click();
  assert.equal(
    w.document.querySelectorAll("#history-list .job-card").length,
    1,
  );
});

test("queue offers reservation deletion for running, queued, paused and attention entries",async t=>{
  const {w,calls}=await setup(t);
  for(const id of ["job-0","job-2","job-3","job-4","job-5"]){
    const button=w.document.getElementById(`delete-${id}`);
    assert.ok(button);assert.equal(button.textContent,"예약 삭제");
  }
  w.document.getElementById("delete-job-2").click();await tick();
  assert.ok(calls.some(c=>c.path==="/api/jobs/job-2"&&c.options.method==="DELETE"));
  assert.equal(w.CollectorUI.job("job-2"),undefined);
  assert.equal(w.document.getElementById("delete-job-2"),null);
});

test("clicking a discovery work opens a popup without leaving the list or losing filters and selection",async t=>{
  const {w}=await setup(t);
  click(w,"nav-discover");await tick();
  const check=w.document.querySelector('#discover-list input[type="checkbox"]');check.click();
  w.document.getElementById("discover-query").value="유지할 검색어";
  w.document.querySelector(".discover-title-link").click();await tick();
  assert.equal(w.CollectorUI.view(),"discover");
  assert.equal(w.document.getElementById("work-dialog").open,true);
  assert.equal(w.document.getElementById("work-author").textContent,"소개 작가");
  assert.match(w.document.getElementById("work-synopsis").textContent,/소개 다음 줄/);
  click(w,"work-back");await tick();await tick();
  assert.equal(w.CollectorUI.view(),"discover");
  assert.equal(w.document.getElementById("work-dialog").open,false);
  assert.equal(w.document.getElementById("discover-query").value,"유지할 검색어");
  assert.equal(w.document.querySelector('#discover-list input[type="checkbox"]').checked,true);
});

test("Multiline links submit one batch; shared settings and duplicate notice retained", async (t) => {
  const { w, calls } = await setup(t);
  click(w, "add-batch-button");
  w.document.getElementById("batch-urls").value =
    "https://newtoki1.org/novel/1\n\nhttps://newtoki1.org/novel/2";
  w.document.getElementById("batch-format").value = "epub";
  w.document.getElementById("batch-schedule").value = "2026-10-03T09:00";
  w.document
    .getElementById("batch-form")
    .dispatchEvent(new w.Event("submit", { cancelable: true }));
  await tick();
  const request = calls.find((c) => c.path === "/api/jobs/batch");
  assert.ok(request);
  const body = JSON.parse(request.options.body);
  assert.equal(body.jobs.length, 2);
  assert.equal(body.jobs[1].format, "epub");
  assert.equal(body.jobs[0].startAt, "2026-10-03T00:00:00.000Z");
  assert.match(w.document.getElementById("batch-result").textContent, /2.*1/);
});

test("Discovery selection survives pages, checks counts sequentially, safe thumbnails and selected batch", async (t) => {
  const { w, calls, stats } = await setup(t);
  click(w, "nav-discover");
  await tick();
  assert.equal(
    w.document.querySelectorAll("#discover-list .discover-card").length,
    1,
  );
  assert.equal(w.document.querySelectorAll("#discover-list img").length, 1);
  assert.match(
    w.document.getElementById("discover-list").textContent,
    /회차 확인 전/,
  );
  const checkbox = w.document.querySelector(
    '#discover-list input[type="checkbox"]',
  );
  checkbox.click();
  click(w, "discover-next");
  await tick();
  assert.equal(
    w.document.querySelectorAll("#discover-list img").length,
    0,
    "external thumbnail rejected",
  );
  w.document.querySelector('#discover-list input[type="checkbox"]').click();
  assert.match(w.document.getElementById("discover-selected").textContent, /2/);
  click(w, "discover-check-selected");
  await tick();
  await tick();
  assert.equal(calls.filter((c) => c.path.endsWith("/refresh")).length, 2);
  assert.equal(stats.maxRefreshActive, 1);
  click(w, "discover-add-selected");
  await tick();
  const request = calls.find((c) => c.path === "/api/jobs/batch");
  assert.ok(request);
  assert.equal(JSON.parse(request.options.body).jobs.length, 2);
  assert.equal(
    w.document.querySelectorAll('#discover-list img[src^="https:"]').length,
    0,
  );
  assert.equal(
    w.document.querySelectorAll('#discover-list img[src="x"]').length,
    0,
    "title escaped",
  );
});

test("Invalid batch stays editable, no jobs inserted; unauthenticated discovery stays unrequested", async (t) => {
  const { w, calls } = await setup(t, { batchError: true });
  click(w, "add-batch-button");
  const input = w.document.getElementById("batch-urls");
  input.value = "bad-url";
  w.document
    .getElementById("batch-form")
    .dispatchEvent(new w.Event("submit", { cancelable: true }));
  await tick();
  assert.match(w.document.getElementById("batch-error").textContent, /URL/);
  assert.equal(input.value, "bad-url");
  assert.equal(w.document.getElementById("batch-submit").disabled, false);
  assert.equal(w.document.querySelectorAll("#jobs-list .job-card").length, 6);
  const anonymous = await setup(t, { authenticated: false });
  click(anonymous.w, "nav-discover");
  await tick();
  assert.equal(anonymous.w.document.getElementById("app-view").hidden, true);
  assert.equal(
    anonymous.calls.filter((c) => c.path.startsWith("/api/discover")).length,
    0,
  );
});

test("forty-item pages scroll to the first work and preserve selection on next and previous", async t => {
  const { w, calls, scrolls } = await setup(t, { fortyItemPages: true });
  click(w, "nav-discover"); await tick();
  const cards = () => w.document.querySelectorAll("#discover-list .discover-card");
  assert.equal(cards().length, 40);
  assert.equal(scrolls.length, 0, "opening discovery does not unexpectedly move the viewport");
  w.document.querySelector('#discover-list input[type="checkbox"]').click();
  w.document.getElementById("discover-query").value = "Synthetic search";
  click(w, "discover-next"); await tick();
  assert.equal(cards().length, 40);
  assert.equal(scrolls.at(-1).element, cards()[0]);
  assert.equal(scrolls.at(-1).options.block, "start");
  assert.equal(w.document.getElementById("discover-page").textContent, "2 / 3");
  w.document.querySelector('#discover-list input[type="checkbox"]').click();
  click(w, "discover-next"); await tick();
  assert.equal(cards().length, 15);
  assert.equal(scrolls.at(-1).element, cards()[0]);
  assert.equal(w.document.getElementById("discover-next").disabled, true);
  click(w, "discover-prev"); await tick();
  click(w, "discover-prev"); await tick();
  assert.equal(cards().length, 40);
  assert.equal(scrolls.length, 4);
  assert.equal(scrolls.at(-1).element, cards()[0]);
  assert.equal(w.document.querySelector('#discover-list input[type="checkbox"]').checked, true);
  assert.match(w.document.getElementById("discover-selected").textContent, /2/);
  assert.equal(w.document.getElementById("discover-query").value, "Synthetic search");
  const requests = calls.filter(call => call.path.startsWith("/api/discover?"));
  assert.deepEqual(requests.map(call => new URL(call.path, "http://localhost").searchParams.get("page")), ["1", "2", "3", "2", "1"]);
});

test("Visible-card auto checks serialize and abandon remaining work when leaving discovery", async (t) => {
  const { w, calls, observers, stats } = await setup(t, {
    observer: true,
    manyItems: true,
  });
  click(w, "nav-discover");
  await tick();
  const observer = observers.at(-1);
  observer.callback(
    observer.targets
      .slice(0, 2)
      .map((target) => ({ target, isIntersecting: true })),
  );
  await tick();
  click(w, "nav-queue");
  await new Promise((r) => setTimeout(r, 1050));
  assert.equal(
    calls.filter((c) => c.path.endsWith("/refresh")).length,
    1,
    "Queued visible card must not refresh after leaving",
  );
  assert.equal(stats.maxRefreshActive, 1);
  assert.ok(
    !calls.some((c) => c.path === "/api/discover/3/refresh"),
    "Offscreen card stays unrequested",
  );
});

test("Pending metadata displays inline and completes via short metadata polling", async (t) => {
  const { w, calls } = await setup(t, { metadataPending: true });
  click(w, "nav-discover");
  await tick();
  w.document.querySelector("#discover-list .discover-content button").click();
  await tick();
  assert.match(
    w.document.querySelector(".discover-count").textContent,
    /회차 확인 중/,
  );
  await new Promise((resolve) => setTimeout(resolve, 2050));
  assert.ok(calls.some((call) => call.path === "/api/discover/1/metadata"));
  assert.match(
    w.document.querySelector(".discover-count").textContent,
    /총 200화/,
  );
});
test("Pending metadata polling stops when user leaves the discovery page", async (t) => {
  const { w, calls } = await setup(t, { metadataPending: true });
  click(w, "nav-discover");
  await tick();
  w.document.querySelector("#discover-list .discover-content button").click();
  await tick();
  click(w, "nav-queue");
  await new Promise((resolve) => setTimeout(resolve, 2050));
  assert.equal(
    calls.filter((call) => call.path.endsWith("/metadata")).length,
    0,
  );
});
test("Failed metadata reports its error and releases the card for retry", async (t) => {
  const { w } = await setup(t, { metadataFailure: true });
  click(w, "nav-discover");
  await tick();
  w.document.querySelector("#discover-list .discover-content button").click();
  await tick();
  assert.match(
    w.document.getElementById("discover-error").textContent,
    /사이트 확인이 필요/,
  );
  assert.match(
    w.document.querySelector(".discover-count").textContent,
    /회차 확인 전/,
  );
  assert.equal(
    w.document.querySelector("#discover-list .discover-content button")
      .disabled,
    false,
  );
});
