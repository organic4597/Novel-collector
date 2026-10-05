import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function fixture(t) {
  const dom = new JSDOM(await readFile(new URL("../public/index.html", import.meta.url), "utf8"), {
    url: "http://localhost/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  let rows = [1, 2].map((id) => ({
    id: String(id),
    title: `작품 ${id}`,
    author: "작가",
    genres: ["판타지"],
    storedChapterCount: 1,
    expectedChapterCount: 3,
    metadataStatus: "completed",
    metadataFetchedAt: "2026-10-05",
    updatedAt: "2026-10-05",
  }));
  let auth = true,
    generation = 1,
    now = 10000,
    handler;
  const calls = [];
  w.Date.now = () => now;
  w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new w.Event("close"));
  };
  w.eval(await readFile(new URL("../public/performance.js", import.meta.url), "utf8"));
  w.CollectorUI = {
    ...w.CollectorPerformance,
    preferences: () => ({ libraryPageSize: 24 }),
    generation: () => generation,
    authenticated: () => auth,
    view: () => "library",
    empty: (_, text) => w.CollectorPerformance.node("p", "empty", text),
    toast() {},
    addJob: (job) => {
      calls.push({ path: "added-job", job });
    },
    api: async (path, options = {}) => {
      calls.push({ path, options });
      if (handler) return handler(path, options);
      return structuredClone(rows);
    },
  };
  const source = new URL("../public/library.js", import.meta.url);
  runInContext(await readFile(source, "utf8"), dom.getInternalVMContext(), {
    filename: fileURLToPath(source),
  });
  await w.CollectorLibrary.refresh();
  return {
    w,
    calls,
    rows: () => rows,
    setRows: (value) => {
      rows = value;
    },
    setHandler: (value) => {
      handler = value;
    },
    addJob: (job) => {
      calls.push({ path: "added-job", job });
    },
    now: (value) => {
      now = value;
    },
    logout: () => {
      auth = false;
      generation++;
      w.document.dispatchEvent(new w.CustomEvent("collector:auth", { detail: false }));
    },
    login: () => {
      auth = true;
      generation++;
      w.document.dispatchEvent(new w.CustomEvent("collector:auth", { detail: true }));
    },
  };
}
test("library deduplicates genre, tag and platform labels without changing metadata or rebuilding unchanged labels", async (t) => {
  const f = await fixture(t), d = f.w.document;
  const book = {
    ...f.rows()[0],
    genres: ["판타지", "판타지"],
    tags: ["판타지", "회귀", " 회귀 ", "플랫폼"],
    platform: "플랫폼",
  };
  f.setRows([book]);
  await f.w.CollectorLibrary.refresh();
  const card = d.querySelector('[data-id="1"]'), tags = card.querySelector(".discover-tags");
  const values = () => Array.from(tags.children, node => node.textContent);
  assert.deepEqual(values(), ["판타지", "회귀", "플랫폼"]);
  assert.deepEqual(book.genres, ["판타지", "판타지"]);
  assert.deepEqual(book.tags, ["판타지", "회귀", " 회귀 ", "플랫폼"]);
  const first = tags.firstChild, last = tags.lastChild;
  f.setRows([{ ...book, genres: ["판타지"], tags: ["회귀", "플랫폼", "판타지"] }]);
  await f.w.CollectorLibrary.refresh();
  assert.equal(d.querySelector('[data-id="1"]'), card);
  assert.equal(tags.firstChild, first);
  assert.equal(tags.lastChild, last);
  assert.deepEqual(values(), ["판타지", "회귀", "플랫폼"]);
  f.setRows([{ ...book, genres: [], tags: [], platform: "" }]);
  await f.w.CollectorLibrary.refresh();
  assert.equal(tags.children.length, 0);
});
test("library selection and one-book changes preserve cards, covers and current failure controls", async (t) => {
  const f = await fixture(t),
    d = f.w.document;
  const first = d.querySelector('[data-id="1"]'),
    image = first.querySelector("img"),
    title = first.querySelector("h2");
  d.getElementById("library-select-page").click();
  assert.equal(d.querySelector('[data-id="1"]'), first);
  assert.equal(first.querySelector("img"), image);
  f.setRows(
    f.rows().map((row) =>
      row.id === "1"
        ? {
            ...row,
            title: "갱신된 제목",
            failedChapterCount: 2,
            storedChapterCount: 2,
          }
        : row,
    ),
  );
  await f.w.CollectorLibrary.refresh();
  assert.equal(d.querySelector('[data-id="1"]'), first);
  assert.equal(first.querySelector("img"), image);
  assert.equal(first.querySelector("h2"), title);
  assert.equal(title.textContent, "갱신된 제목");
  assert.match(first.textContent, /실패 2화/);
  assert.match(first.querySelector(".book-actions .quiet").textContent, /실패/);
  assert.equal(first.querySelector('input[type="checkbox"]').checked, true);
});
test("library automatic refresh reuses fresh data but mutation and expiry invalidate it", async (t) => {
  const f = await fixture(t);
  await f.w.CollectorLibrary.refresh({ force: false });
  assert.equal(f.calls.length, 1);
  f.w.document.dispatchEvent(
    new f.w.CustomEvent("collector:mutated", {
      detail: { path: "/api/books/1/metadata" },
    }),
  );
  await f.w.CollectorLibrary.refresh({ force: false });
  assert.equal(f.calls.length, 2);
  f.now(20001);
  await f.w.CollectorLibrary.refresh({ force: false });
  assert.equal(f.calls.length, 3);
});
test("a mutation discards an older in-flight book snapshot before the next refresh", async (t) => {
  const f = await fixture(t);
  let release;
  f.setHandler(
    async () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const stale = f.w.CollectorLibrary.refresh();
  f.w.document.dispatchEvent(
    new f.w.CustomEvent("collector:mutated", {
      detail: { path: "/api/books/1/metadata" },
    }),
  );
  release([{ ...f.rows()[0], title: "옛 응답" }]);
  await stale;
  assert.doesNotMatch(f.w.document.getElementById("books-list").textContent, /옛 응답/);
  f.setHandler(null);
  await f.w.CollectorLibrary.refresh({ force: false });
  assert.equal(f.calls.length, 3);
  f.logout();
  await tick();
  assert.equal(f.w.document.getElementById("books-list").children.length, 0);
});

test("keyed actions and selection use latest data while retaining controls and scroll", async (t) => {
  const f = await fixture(t),
    d = f.w.document;
  const card = d.querySelector('[data-id="1"]'),
    read = card.querySelector(".secondary"),
    check = card.querySelector("input"),
    retry = card.querySelector(".quiet"),
    image = card.querySelector("img");
  d.getElementById("books-list").scrollTop = 300;
  d.getElementById("library-select-all").click();
  d.getElementById("library-clear").click();
  assert.equal(card.querySelector("input"), check);
  assert.equal(check.checked, false);
  f.setRows(
    f.rows().map((row) =>
      row.id === "1"
        ? {
            ...row,
            title: "최신 제목",
            author: "새 작가",
            failedChapterCount: 1,
          }
        : row,
    ),
  );
  await f.w.CollectorLibrary.refresh();
  assert.equal(card.querySelector(".secondary"), read);
  assert.equal(card.querySelector(".quiet"), retry);
  assert.equal(card.querySelector("img"), image);
  assert.equal(d.getElementById("books-list").scrollTop, 300);
  assert.equal(check.getAttribute("aria-label"), "최신 제목 선택");
  f.setHandler(async (path) =>
    path.endsWith("/failures")
      ? [{ id: "failed-one", number: 2, title: "실패 회차" }]
      : { book: { title: "최신 제목" }, chapters: [] },
  );
  retry.click();
  await tick();
  assert.match(d.getElementById("failures-title").textContent, /최신 제목/);
  d.getElementById("failures-dialog").close();
  read.click();
  await tick();
  assert.equal(d.getElementById("reader-book-title").textContent, "최신 제목");
  assert.match(d.getElementById("reader-text").textContent, /본문이 없습니다/);
  d.getElementById("reader-dialog").close();
});

test("availability transitions patch existing nodes, failed cover stays absent and real metadata changes retry it", async (t) => {
  const f = await fixture(t),
    d = f.w.document,
    card = d.querySelector('[data-id="1"]'),
    read = card.querySelector(".secondary"),
    image = card.querySelector("img");
  image.dispatchEvent(new f.w.Event("error"));
  d.getElementById("library-select-all").click();
  assert.equal(card.querySelector("img"), null);
  f.setRows([
    {
      ...f.rows()[0],
      storedChapterCount: 0,
      failedChapterCount: 0,
      metadataStatus: "pending",
      metadataFetchedAt: null,
    },
  ]);
  await f.w.CollectorLibrary.refresh();
  assert.equal(card.querySelector(".secondary"), read);
  assert.equal(read.disabled, true);
  assert.equal(card.querySelector("input").disabled, true);
  assert.equal(card.querySelector("a.export-link"), null);
  assert.equal(card.querySelector(".quiet"), null);
  f.setRows([
    {
      ...f.rows()[0],
      title: "새 표지",
      storedChapterCount: 2,
      metadataStatus: "completed",
      metadataFetchedAt: "fresh",
      synopsis: "<img src=x> 안전한 문자열",
    },
  ]);
  await f.w.CollectorLibrary.refresh();
  assert.equal(card.querySelector("img"), image);
  assert.match(image.getAttribute("src"), /v=fresh/);
  assert.equal(card.querySelector(".book-synopsis img"), null);
  assert.equal(card.querySelector(".secondary"), read);
  assert.equal(read.disabled, false);
  f.setRows([]);
  await f.w.CollectorLibrary.refresh();
  assert.equal(card.isConnected, false);
  assert.match(d.getElementById("books-list").textContent, /등록하면/);
  f.setRows([{ id: "1", title: "다시 등록", storedChapterCount: 1 }]);
  await f.w.CollectorLibrary.refresh();
  assert.notEqual(d.querySelector('[data-id="1"]'), card);
});

test("manual refresh always fetches and post-logout responses cannot restore the library", async (t) => {
  const f = await fixture(t),
    d = f.w.document;
  await f.w.CollectorLibrary.refresh();
  assert.equal(f.calls.length, 2);
  await f.w.CollectorLibrary.refresh({ force: true });
  assert.equal(f.calls.length, 3);
  await f.w.CollectorLibrary.refresh({ force: false });
  assert.equal(f.calls.length, 3);
  d.getElementById("refresh-library").click();
  await tick();
  assert.equal(f.calls.length, 4);
  let finish;
  f.setHandler(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = f.w.CollectorLibrary.refresh();
  f.logout();
  finish([{ id: "late", title: "로그아웃 뒤 데이터" }]);
  await pending;
  assert.equal(d.getElementById("books-list").children.length, 0);
  const callCount = f.calls.length;
  await f.w.CollectorLibrary.refresh({ force: false });
  assert.equal(f.calls.length, callCount);
  f.setHandler(null);
  f.login();
  await f.w.CollectorLibrary.refresh({ force: false });
  assert.equal(d.querySelectorAll(".library-card").length, 2);
});

test("pagination filters sort and preferences reuse previously shown cards", async (t) => {
  const f = await fixture(t),
    d = f.w.document;
  f.setRows(
    Array.from({ length: 26 }, (_, i) => ({
      id: String(i + 1),
      title: i === 0 ? "가나다" : `작품${i}`,
      author: i === 0 ? "첫 작가" : "작가",
      genres: [i % 2 ? "현대" : "판타지"],
      storedChapterCount: i + 1,
      expectedChapterCount: 30,
      updatedAt: String(i).padStart(3, "0"),
    })),
  );
  await f.w.CollectorLibrary.refresh();
  const first = d.querySelector(".library-card");
  d.getElementById("library-next").click();
  assert.equal(d.querySelectorAll(".library-card").length, 2);
  d.getElementById("library-prev").click();
  assert.equal(d.querySelector(".library-card"), first);
  d.getElementById("library-sort").value = "title";
  d.getElementById("library-sort").dispatchEvent(new f.w.Event("change"));
  assert.equal(d.querySelector(".library-card h2").textContent, "가나다");
  d.getElementById("library-sort").value = "chapters";
  d.getElementById("library-sort").dispatchEvent(new f.w.Event("change"));
  assert.match(d.querySelector(".book-completeness").textContent, /26화/);
  d.getElementById("library-genre").value = "현대";
  d.getElementById("library-genre").dispatchEvent(new f.w.Event("change"));
  assert.equal(d.querySelectorAll(".library-card").length, 13);
  d.dispatchEvent(new f.w.CustomEvent("collector:preferences"));
  d.getElementById("library-query").value = "없는 제목";
  d.getElementById("library-query").dispatchEvent(new f.w.Event("input"));
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(d.querySelectorAll(".library-card").length, 0);
  d.getElementById("library-query").value = "";
  d.getElementById("library-query").dispatchEvent(new f.w.Event("input"));
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(d.querySelectorAll(".library-card").length, 13);
});

test("metadata retries retain the button, deduplicate and clear request state after errors", async (t) => {
  const f = await fixture(t),
    d = f.w.document;
  f.setRows([
    {
      ...f.rows()[0],
      metadataStatus: "failed",
      metadataError: "오류",
      metadataFetchedAt: null,
    },
  ]);
  await f.w.CollectorLibrary.refresh();
  const card = d.querySelector(".library-card"),
    button = card.querySelector(".metadata-retry");
  let finish;
  f.setHandler((path, options) =>
    options.method === "POST"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : structuredClone(f.rows()),
  );
  button.click();
  button.dispatchEvent(new f.w.Event("click"));
  assert.equal(card.querySelector(".metadata-retry"), button);
  assert.equal(button.disabled, true);
  f.setRows([{ ...f.rows()[0], metadataStatus: "completed", metadataFetchedAt: "done" }]);
  finish({ status: "pending" });
  await tick();
  await tick();
  assert.equal(card.querySelector(".metadata-retry"), null);
  f.setRows([{ ...f.rows()[0], metadataStatus: "deferred", metadataError: "대기" }]);
  f.setHandler(null);
  await f.w.CollectorLibrary.refresh();
  assert.equal(card.querySelector(".metadata-retry"), button);
  f.setHandler(async () => {
    throw Error("fixture failure");
  });
  button.click();
  await tick();
  assert.equal(button.disabled, false);
  assert.match(d.getElementById("library-error").textContent, /요청을 처리하지/);
});

test("reader and selected bundle operations remain functional with keyed card actions", async (t) => {
  const f = await fixture(t),
    d = f.w.document;
  f.setHandler(async (path, options) => {
    if (path === "/api/books/1")
      return {
        book: { title: "작품 1" },
        chapters: [
          { id: "c1", title: "첫 회차", number: 1 },
          { id: "c2", title: "둘째 회차", number: 2 },
        ],
      };
    if (path.includes("/chapters/"))
      return {
        id: path.endsWith("c1") ? "c1" : "c2",
        title: "본문 제목",
        number: 1,
        text: "본문 내용",
      };
    if (path === "/api/downloads") return { id: "bundle", status: "ready", total: 2, processed: 2 };
    return structuredClone(f.rows());
  });
  d.querySelector('[data-id="1"] .secondary').click();
  await tick();
  await tick();
  assert.equal(d.getElementById("reader-text").textContent, "본문 내용");
  d.getElementById("chapter-list").children[1].click();
  await tick();
  assert.equal(d.getElementById("chapter-list").children[1].getAttribute("aria-pressed"), "true");
  d.getElementById("reader-dialog").close();
  d.getElementById("library-select-all").click();
  d.getElementById("library-download-selected").click();
  await tick();
  const bundle = f.calls.find((call) => call.path === "/api/downloads");
  assert.deepEqual(JSON.parse(bundle.options.body), { bookIds: ["1", "2"] });
  assert.equal(d.getElementById("bundle-download-link").hidden, false);
  assert.match(d.getElementById("bundle-download-link").href, /downloads\/bundle\/file$/);
  d.getElementById("library-bundle-status").click();
  assert.equal(d.getElementById("bundle-dialog").open, true);
  d.getElementById("bundle-dialog").close();
  d.getElementById("library-download-all").click();
  await tick();
  assert.deepEqual(
    JSON.parse(f.calls.filter((call) => call.path === "/api/downloads").at(-1).options.body),
    { all: true },
  );
});

test("failed chapter actions submit only checked rows and queue missing-only retries", async (t) => {
  const f = await fixture(t),
    d = f.w.document;
  f.w.CollectorLibrary.retryJob({
    id: "job",
    title: "실패 작업",
    failedChapters: [
      { id: "c1", number: 1, title: "실패 1" },
      { id: "c2", number: 2, title: "실패 2" },
    ],
  });
  const checks = d.getElementById("failures-list").querySelectorAll("input");
  checks[0].checked = false;
  checks[1].checked = false;
  d.getElementById("failures-submit").click();
  await tick();
  assert.match(d.getElementById("failures-error").textContent, /선택/);
  checks[1].checked = true;
  f.setHandler(async () => ({ id: "retry-job" }));
  d.getElementById("failures-submit").click();
  await tick();
  const request = f.calls.find((call) => call.path === "/api/jobs/job/action");
  assert.deepEqual(JSON.parse(request.options.body), {
    action: "retry_failed",
    chapterIds: ["c2"],
  });
  assert.equal(d.getElementById("failures-dialog").open, false);
  f.setHandler(async (path) => (path.endsWith("/failures") ? [] : { id: "missing-retry" }));
  d.querySelector('[data-id="1"] .quiet').click();
  await tick();
  assert.match(d.getElementById("failures-title").textContent, /누락/);
  d.getElementById("failures-submit").click();
  await tick();
  assert.deepEqual(
    JSON.parse(f.calls.find((call) => call.path === "/api/books/1/retry-failed").options.body),
    {},
  );
});

test("new post-mutation response wins even when the pre-mutation request resolves later", async (t) => {
  const f = await fixture(t),
    d = f.w.document;
  let finishOld;
  f.setHandler(
    () =>
      new Promise((resolve) => {
        finishOld = resolve;
      }),
  );
  const old = f.w.CollectorLibrary.refresh();
  d.dispatchEvent(new f.w.CustomEvent("collector:mutated"));
  f.setHandler(async () => [{ ...f.rows()[0], title: "새 스냅샷" }]);
  await f.w.CollectorLibrary.refresh({ force: false });
  finishOld([{ ...f.rows()[0], title: "버려질 스냅샷" }]);
  await old;
  assert.match(d.getElementById("books-list").textContent, /새 스냅샷/);
  assert.doesNotMatch(d.getElementById("books-list").textContent, /버려질/);
  const before = f.calls.length;
  await f.w.CollectorLibrary.refresh({ force: false });
  assert.equal(f.calls.length, before);
});

test("selection remains bounded at 200 while unavailable books and empty responses stay honest", async (t) => {
  const f = await fixture(t),
    d = f.w.document;
  f.w.CollectorUI.preferences = () => ({ libraryPageSize: 400 });
  f.setRows(
    Array.from({ length: 202 }, (_, i) => ({
      id: String(i + 1),
      title: `제목${i}`,
      chapterCount: i === 0 ? 0 : 1,
      expectedChapterCount: null,
      genres: [],
      tags: ["태그"],
      publication: i % 2 ? "ongoing" : "completed",
    })),
  );
  await f.w.CollectorLibrary.refresh();
  d.getElementById("library-select-all").click();
  assert.match(d.getElementById("library-selected").textContent, /200/);
  assert.match(d.getElementById("library-error").textContent, /처음 200/);
  const excluded = d.querySelector('[data-id="1"] input');
  excluded.checked = true;
  excluded.dispatchEvent(new f.w.Event("change"));
  assert.equal(excluded.checked, false);
  const overflow = d.querySelector('[data-id="202"] input');
  overflow.checked = true;
  overflow.dispatchEvent(new f.w.Event("change"));
  assert.equal(overflow.checked, false);
  const selected = d.querySelector('[data-id="2"] input');
  selected.checked = false;
  selected.dispatchEvent(new f.w.Event("change"));
  assert.match(d.getElementById("library-selected").textContent, /199/);
  d.getElementById("library-select-page").checked = false;
  d.getElementById("library-select-page").dispatchEvent(new f.w.Event("change"));
  assert.match(d.getElementById("library-selected").textContent, /0/);
  f.setHandler(async () => null);
  await f.w.CollectorLibrary.refresh();
  assert.equal(d.querySelectorAll(".library-card").length, 0);
  assert.equal(d.getElementById("library-download-all").disabled, true);
});

test("reader failures and stale reads preserve the active dialog state", async (t) => {
  const f = await fixture(t),
    d = f.w.document;
  f.setHandler(async () => {
    throw Error("fixture load error");
  });
  d.querySelector('[data-id="1"] .secondary').click();
  await tick();
  assert.match(d.getElementById("reader-text").textContent, /요청을 처리하지/);
  d.getElementById("reader-dialog").close();
  f.setHandler(async (path) =>
    path === "/api/books/1"
      ? { chapters: [{ id: "c1", number: 1 }] }
      : Promise.reject(Error("fixture chapter error")),
  );
  d.querySelector('[data-id="1"] .secondary').click();
  await tick();
  await tick();
  assert.equal(d.getElementById("reader-meta").textContent, "본문 조회 실패");
  d.getElementById("reader-dialog").close();
  let finish;
  f.setHandler(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  d.querySelector('[data-id="1"] .secondary').click();
  d.getElementById("reader-dialog").close();
  finish({ chapters: [{ id: "late" }] });
  await tick();
  assert.equal(d.getElementById("chapter-list").children.length, 0);
});

test("bundle preparation deduplicates and polls ready or failed statuses without rebuilding cards", async (t) => {
  const f = await fixture(t),
    d = f.w.document,
    card = d.querySelector(".library-card"),
    originalTimer = f.w.setTimeout.bind(f.w);
  f.w.setTimeout = (fn, delay, ...args) => originalTimer(fn, delay === 2000 ? 0 : delay, ...args);
  f.setHandler(async (path, options) =>
    path === "/api/downloads"
      ? { id: "poll", status: "preparing", processed: 0, total: 2 }
      : { id: "poll", status: "ready", processed: 2, total: 2 },
  );
  d.getElementById("library-select-all").click();
  d.getElementById("library-download-selected").click();
  d.getElementById("library-download-selected").click();
  await tick();
  await tick();
  assert.equal(f.calls.filter((call) => call.path === "/api/downloads").length, 1);
  assert.equal(d.querySelector(".library-card"), card);
  assert.equal(d.getElementById("bundle-download-link").hidden, false);
  f.setHandler(async (path) =>
    path === "/api/downloads"
      ? { id: "fail", status: "preparing", total: 2 }
      : { id: "fail", status: "failed", error: "파일 준비 실패" },
  );
  d.getElementById("library-download-all").click();
  await tick();
  await tick();
  assert.equal(d.getElementById("bundle-error").textContent, "파일 준비 실패");
  f.setHandler(async () => {
    throw Error("request error");
  });
  d.getElementById("library-download-all").click();
  await tick();
  assert.match(d.getElementById("bundle-error").textContent, /요청을 처리하지/);
});

test("render defers off-screen work and resumes latest snapshot on returning to library", async (t) => {
  const f = await fixture(t),
    d = f.w.document,
    card = d.querySelector(".library-card");
  f.w.CollectorUI.view = () => "queue";
  f.setRows([
    {
      ...f.rows()[0],
      title: "화면 복귀 제목",
      storedChapterCount: undefined,
      chapterCount: undefined,
      totalChapters: undefined,
      author: null,
      expectedChapterCount: undefined,
    },
  ]);
  await f.w.CollectorLibrary.refresh();
  assert.doesNotMatch(card.textContent, /화면 복귀/);
  f.w.CollectorUI.view = () => "library";
  d.dispatchEvent(new f.w.CustomEvent("collector:view", { detail: "library" }));
  assert.match(card.textContent, /화면 복귀/);
  assert.match(card.textContent, /저장 회차 확인 전/);
  d.dispatchEvent(new f.w.Event("visibilitychange"));
  f.setHandler(async () => {
    throw Error("refresh failed");
  });
  d.getElementById("refresh-library").click();
  await tick();
  assert.equal(d.getElementById("refresh-library").disabled, false);
  assert.match(d.getElementById("library-error").textContent, /요청을 처리하지/);
});

test("96-card pages retain only three recent pages while selection survives card cache eviction", async (t) => {
  const f = await fixture(t),
    d = f.w.document;
  f.w.CollectorUI.preferences = () => ({ libraryPageSize: 96 });
  f.setRows(
    Array.from({ length: 500 }, (_, i) => ({
      id: String(i + 1),
      title: `작품 ${String(i + 1).padStart(3, "0")}`,
      storedChapterCount: 1,
      updatedAt: String(500 - i).padStart(3, "0"),
    })),
  );
  await f.w.CollectorLibrary.refresh();
  const first = d.querySelector('[data-id="1"]'),
    firstCheck = first.querySelector("input");
  firstCheck.checked = true;
  firstCheck.dispatchEvent(new f.w.Event("change"));
  d.getElementById("library-next").click();
  const second = d.querySelector('[data-id="97"]');
  d.getElementById("library-next").click();
  const third = d.querySelector('[data-id="193"]'),
    thirdImage = third.querySelector("img"),
    thirdCheck = third.querySelector("input");
  d.getElementById("library-select-page").click();
  assert.equal(d.querySelector('[data-id="193"]'), third);
  assert.equal(third.querySelector("img"), thirdImage);
  assert.equal(third.querySelector("input"), thirdCheck);
  d.getElementById("library-next").click();
  const fourth = d.querySelector('[data-id="289"]');
  d.getElementById("library-prev").click();
  assert.equal(d.querySelector('[data-id="193"]'), third);
  d.getElementById("library-prev").click();
  assert.equal(d.querySelector('[data-id="97"]'), second);
  d.getElementById("library-prev").click();
  const recreatedFirst = d.querySelector('[data-id="1"]');
  assert.notEqual(recreatedFirst, first);
  assert.equal(recreatedFirst.querySelector("input").checked, true);
  assert.equal(d.querySelectorAll(".library-card").length, 96);
  assert.match(d.getElementById("library-selected").textContent, /97개 선택/);
  d.getElementById("library-next").click();
  d.getElementById("library-next").click();
  assert.equal(d.querySelector('[data-id="193"]'), third);
  assert.equal(third.querySelector("input").checked, true);
  d.getElementById("library-next").click();
  assert.notEqual(d.querySelector('[data-id="289"]'), fourth);
});

test("small pages keep at least 120 recent cards and page metadata continues after eviction", async (t) => {
  const f = await fixture(t),
    d = f.w.document;
  f.setRows(
    Array.from({ length: 240 }, (_, i) => ({
      id: String(i + 1),
      title: `작품 ${i + 1}`,
      storedChapterCount: 1,
      updatedAt: String(240 - i).padStart(3, "0"),
    })),
  );
  await f.w.CollectorLibrary.refresh();
  const first = d.querySelector('[data-id="1"]');
  for (let i = 0; i < 4; i++) d.getElementById("library-next").click();
  for (let i = 0; i < 4; i++) d.getElementById("library-prev").click();
  assert.equal(d.querySelector('[data-id="1"]'), first);
  for (let i = 0; i < 5; i++) d.getElementById("library-next").click();
  for (let i = 0; i < 5; i++) d.getElementById("library-prev").click();
  assert.notEqual(d.querySelector('[data-id="1"]'), first);
  f.setRows(
    f
      .rows()
      .map((book) =>
        book.id === "1" ? { ...book, title: "최신 보관 정보", author: "보관 작가" } : book,
      ),
  );
  const recreated = d.querySelector('[data-id="1"]');
  await f.w.CollectorLibrary.refresh();
  assert.equal(d.querySelector('[data-id="1"]'), recreated);
  assert.match(recreated.textContent, /최신 보관 정보/);
  assert.match(recreated.textContent, /보관 작가/);
});
