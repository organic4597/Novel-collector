import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const chapters = [
  { id: "chapter-z", number: 20, title: "저장 첫 회차" },
  { id: "chapter-a", number: 1, title: "저장 둘째 회차" },
  { id: "chapter-m", number: 10, title: "저장 마지막 회차" },
];
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(check) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { if (check()) return; await tick(); }
  assert.fail("the expected reader state was not reached");
}
async function fixture(t, { catalog = chapters, contentType = "novel" } = {}) {
  const dom = new JSDOM(await readFile(new URL("../public/index.html", import.meta.url), "utf8"), {
    url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document, calls = [];
  let authenticated = true, generation = 1, handler;
  const book = { id: "book", title: "합성 작품", contentType, storedChapterCount: catalog.length };
  const other = { ...book, id: "other", title: "다른 합성 작품" };
  const body = (bookId, chapterId) => ({
    ...catalog.find(chapter => chapter.id === chapterId), id: chapterId, contentType,
    text: `body ${bookId}/${chapterId}`,
    ...(contentType === "novel" ? {} : { hash: "synthetic-revision", savedImages: 1, images: [{ index: 1, width: 640, height: 800, sha256: "a".repeat(64) }] }),
  });
  const respond = async path => {
    const match = /^\/api\/books\/([^/]+)(?:\/chapters\/([^/]+))?$/.exec(path);
    assert.ok(match, `unexpected synthetic API request: ${path}`);
    return match[2] ? body(match[1], match[2]) : { book: match[1] === "other" ? other : book, chapters: structuredClone(catalog) };
  };
  handler = respond;
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; w.setTimeout(() => this.dispatchEvent(new w.Event("close")), 0); };
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.eval(await readFile(new URL("../public/performance.js", import.meta.url), "utf8"));
  w.CollectorUI = {
    ...w.CollectorPerformance, authenticated: () => authenticated, generation: () => generation,
    view: () => "library", preferences: () => ({ libraryPageSize: 24 }), toast() {}, textError: error => error.message,
    api: async path => { calls.push(path); return handler(path); },
  };
  w.eval(await readFile(new URL("../public/reader-images.js", import.meta.url), "utf8"));
  w.eval(await readFile(new URL("../public/library.js", import.meta.url), "utf8"));
  const el = id => { const element = d.getElementById(id); assert.ok(element, `missing reader control: #${id}`); return element; };
  return {
    w, d, calls, book, other, body, respond, el,
    setHandler: value => { handler = value; },
    open: (value = book) => w.CollectorLibrary.openBook(value),
    profile: (value = book) => w.CollectorLibrary.openProfile(value),
    close: async () => { el("reader-dialog").close(); await tick(); },
    logout: () => { authenticated = false; generation++; d.dispatchEvent(new w.CustomEvent("collector:auth", { detail: false })); },
    cancel: () => { const event = new w.Event("cancel", { cancelable: true }); el("reader-dialog").dispatchEvent(event); if (!event.defaultPrevented) el("reader-dialog").close(); return event; },
  };
}
function assertPopup(f) {
  assert.equal(f.el("reader-dialog").classList.contains("reader-fullscreen"), false);
  assert.equal(f.d.documentElement.classList.contains("reader-fullscreen-open"), false);
  assert.equal(f.el("reader-fullscreen-toggle").getAttribute("aria-pressed"), "false");
  assert.equal(f.el("reader-fullscreen-toggle").textContent.trim(), "전체화면 뷰어로 보기");
}
function assertFullscreen(f) {
  assert.equal(f.el("reader-dialog").open, true);
  assert.equal(f.el("reader-dialog").classList.contains("reader-fullscreen"), true);
  assert.equal(f.d.documentElement.classList.contains("reader-fullscreen-open"), true);
  assert.equal(f.el("reader-fullscreen-toggle").getAttribute("aria-pressed"), "true");
  assert.equal(f.el("reader-fullscreen-toggle").textContent.trim(), "팝업으로 돌아가기");
}
function assertPosition(f, position, total) {
  assert.equal(f.el("reader-position").textContent.trim(), `${position} / ${total}`);
  assert.equal(f.el("reader-previous").disabled, position <= 1);
  assert.equal(f.el("reader-next").disabled, position === 0 || position >= total);
}

test("fullscreen toggles preserve mounted images, quality, scroll and API requests", async t => {
  const f = await fixture(t, { contentType: "webtoon" }); await f.open();
  assertPopup(f);
  const image = f.el("reader-text").querySelector("img"), quality = f.el("reader-image-quality"), scroll = f.d.querySelector(".reader-body"), calls = [...f.calls];
  assert.ok(image); quality.value = "original"; quality.dispatchEvent(new f.w.Event("change"));
  const originalImage = f.el("reader-text").querySelector("img"); scroll.scrollTop = 125;
  f.el("reader-fullscreen-toggle").click(); assertFullscreen(f);
  assert.equal(f.el("reader-text").querySelector("img"), originalImage); assert.equal(f.el("reader-image-quality"), quality);
  assert.equal(quality.value, "original"); assert.equal(scroll.scrollTop, 125); assert.deepEqual(f.calls, calls);
  f.el("reader-fullscreen-toggle").click(); assertPopup(f);
  assert.equal(f.el("reader-text").querySelector("img"), originalImage); assert.equal(scroll.scrollTop, 125); assert.deepEqual(f.calls, calls);
});

test("fullscreen entry from details loads content and reader controls follow the selected tab", async t => {
  const f = await fixture(t); await f.profile();
  assert.equal(f.el("reader-controls").hidden, true); assert.deepEqual(f.calls, []);
  f.el("reader-fullscreen-toggle").click();
  await until(() => f.el("reader-text").textContent === "body book/chapter-z");
  assertFullscreen(f); assert.equal(f.el("reader-controls").hidden, false);
  assert.equal(f.el("library-content-tab").getAttribute("aria-selected"), "true"); assertPosition(f, 1, 3);
  assert.deepEqual(f.calls, ["/api/books/book", "/api/books/book/chapters/chapter-z"]);
  f.el("library-info-tab").click(); assert.equal(f.el("reader-controls").hidden, true);
  f.el("library-content-tab").click(); assert.equal(f.el("reader-controls").hidden, false);
  assert.equal(f.el("reader-text").textContent, "body book/chapter-z"); assert.equal(f.calls.length, 2);
});

test("sidebar folding keeps its accessible state, chapter nodes and content without requests", async t => {
  const f = await fixture(t); await f.open();
  const sidebar = f.el("reader-sidebar"), toggle = f.el("reader-sidebar-toggle"), button = f.el("chapter-list").firstElementChild, body = f.el("reader-text").firstChild, calls = [...f.calls];
  assert.equal(sidebar.tagName, "ASIDE"); assert.equal(toggle.getAttribute("aria-controls"), "reader-sidebar");
  const initial = sidebar.hidden;
  for (const hidden of [!initial, initial]) {
    toggle.click(); assert.equal(sidebar.hidden, hidden); assert.equal(toggle.getAttribute("aria-expanded"), String(!hidden));
    assert.equal(f.el("chapter-list").firstElementChild, button); assert.equal(f.el("reader-text").firstChild, body); assert.deepEqual(f.calls, calls);
  }
});

test("previous and next follow saved API order and stop at both chapter boundaries", async t => {
  const f = await fixture(t); await f.open();
  assert.deepEqual(Array.from(f.el("chapter-list").children, button => button.dataset.chapter), chapters.map(chapter => chapter.id));
  assertPosition(f, 1, 3);
  f.el("reader-previous").click(); assert.equal(f.calls.length, 2);
  for (const [id, position] of [["chapter-a",2],["chapter-m",3]]) {
    f.el("reader-next").click(); await until(() => f.el("reader-text").textContent === `body book/${id}`); assertPosition(f, position, 3);
  }
  const atEnd = f.calls.length; f.el("reader-next").click(); assert.equal(f.calls.length, atEnd);
  f.el("reader-previous").click(); await until(() => f.el("reader-text").textContent === "body book/chapter-a"); assertPosition(f, 2, 3);
  f.el("chapter-list").firstElementChild.click(); await until(() => f.el("reader-text").textContent === "body book/chapter-z"); assertPosition(f, 1, 3);
  assert.deepEqual(f.calls.filter(path => path.includes("/chapters/")), ["chapter-z","chapter-a","chapter-m","chapter-a","chapter-z"].map(id => `/api/books/book/chapters/${id}`));
});

test("books known to have no stored chapters keep content and fullscreen entry disabled", async t => {
  const f = await fixture(t, { catalog: [] }); await f.profile();
  assert.equal(f.el("library-content-tab").disabled, true); assert.equal(f.el("reader-fullscreen-toggle").disabled, true);
  assert.equal(f.el("reader-controls").hidden, true); assertPosition(f, 0, 0);
  f.el("reader-fullscreen-toggle").click(); assertPopup(f); assert.deepEqual(f.calls, []);
});

test("empty API catalogs and single-chapter catalogs keep navigation safe", async t => {
  for (const catalog of [[], chapters.slice(0, 1)]) {
    const f = await fixture(t, { catalog });
    await f.profile({ ...f.book, storedChapterCount: 1 }); f.el("reader-fullscreen-toggle").click();
    await until(() => f.calls.includes("/api/books/book")); await tick();
    assertPosition(f, catalog.length, catalog.length); assertFullscreen(f);
    if (catalog.length) await until(() => f.el("reader-text").textContent === "body book/chapter-z");
    else assert.match(f.el("reader-text").textContent, /아직 저장된 본문이 없습니다/);
    const calls = [...f.calls]; f.el("reader-previous").click(); f.el("reader-next").click(); assert.deepEqual(f.calls, calls);
  }
});

test("chapter-list failure keeps navigation empty and retries only after reopening", async t => {
  const f = await fixture(t); let attempts = 0;
  f.setHandler(path => { if (path === "/api/books/book" && ++attempts === 1) throw Error("synthetic list failure"); return f.respond(path); });
  await f.open(); assert.match(f.el("reader-text").textContent, /synthetic list failure/); assertPosition(f, 0, 0);
  f.el("reader-fullscreen-toggle").click(); assertFullscreen(f);
  f.el("library-info-tab").click(); f.el("library-content-tab").click(); assert.equal(attempts, 1); assertPosition(f, 0, 0);
  await f.close(); await f.open(); assert.equal(attempts, 2); assertPosition(f, 1, 3);
  assert.equal(f.el("reader-text").textContent, "body book/chapter-z");
});

test("Escape returns fullscreen to popup before normal dialog cancellation closes it", async t => {
  const f = await fixture(t); await f.open(); f.el("reader-fullscreen-toggle").click(); assertFullscreen(f);
  const calls = [...f.calls]; assert.equal(f.cancel().defaultPrevented, true); assertPopup(f);
  assert.equal(f.el("reader-dialog").open, true); assert.deepEqual(f.calls, calls);
  assert.equal(f.cancel().defaultPrevented, false); await tick(); assertPopup(f);
  assert.equal(f.el("reader-dialog").open, false); assert.equal(f.el("reader-text").textContent, "");
});

test("close, logout and opening another book clear fullscreen state", async t => {
  for (const action of ["close", "logout", "other"]) {
    const f = await fixture(t); await f.open(); f.el("reader-fullscreen-toggle").click(); assertFullscreen(f);
    if (action === "close") await f.close();
    else if (action === "logout") { f.logout(); await tick(); }
    else await f.open(f.other);
    assertPopup(f);
    if (action === "other") { assertPosition(f, 1, 3); assert.equal(f.el("reader-text").textContent, "body other/chapter-z"); }
    else { assert.equal(f.el("reader-dialog").open, false); assert.equal(f.el("reader-text").textContent, ""); }
  }
});

test("leaving fullscreen while detail-entry catalog is pending cannot re-enable fullscreen later", async t => {
  for (const action of ["cancel", "close", "logout"]) {
    const f = await fixture(t), gate = deferred(); await f.profile();
    f.setHandler(path => path === "/api/books/book" ? gate.promise : f.respond(path));
    f.el("reader-fullscreen-toggle").click(); assertFullscreen(f);
    await until(() => f.calls.includes("/api/books/book"));
    if (action === "cancel") assert.equal(f.cancel().defaultPrevented, true);
    else if (action === "close") await f.close();
    else { f.logout(); await tick(); }
    assertPopup(f);
    gate.resolve({ book: f.book, chapters: structuredClone(chapters) }); await tick();
    assertPopup(f);
    if (action === "cancel") {
      await until(() => f.el("reader-text").textContent === "body book/chapter-z"); assertPosition(f, 1, 3);
      assert.equal(f.el("reader-dialog").open, true);
    } else {
      assert.equal(f.el("reader-dialog").open, false); assert.equal(f.el("reader-text").textContent, "");
      assert.deepEqual(f.calls, ["/api/books/book"]);
    }
  }
});

test("late chapter responses cannot restore a closed, logged-out or replaced fullscreen reader", async t => {
  for (const action of ["close", "logout", "other"]) {
    const f = await fixture(t); await f.open(); f.el("reader-fullscreen-toggle").click();
    const gate = deferred();
    f.setHandler(path => path === "/api/books/book/chapters/chapter-a" ? gate.promise : f.respond(path));
    f.el("reader-next").click(); await until(() => f.calls.includes("/api/books/book/chapters/chapter-a"));
    if (action === "close") await f.close();
    else if (action === "logout") { f.logout(); await tick(); }
    else await f.open(f.other);
    gate.resolve({ ...f.body("book", "chapter-a"), title: "stale title", text: "stale chapter body" }); await tick();
    assertPopup(f); assert.doesNotMatch(f.el("reader-text").textContent, /stale/);
    assert.notEqual(f.el("reader-chapter-title").textContent, "stale title");
    if (action === "other") { assertPosition(f, 1, 3); assert.equal(f.el("reader-text").textContent, "body other/chapter-z"); }
    else assert.equal(f.el("reader-text").textContent, "");
  }
});

test("late list errors and queued close events cannot reset a newly opened fullscreen reader", async t => {
  const f = await fixture(t), gate = deferred();
  f.setHandler(path => path === "/api/books/book" ? gate.promise : f.respond(path));
  const old = f.open(); await until(() => f.calls.includes("/api/books/book"));
  f.el("reader-dialog").close();
  await f.open(f.other); f.el("reader-fullscreen-toggle").click();
  gate.reject(Error("stale catalog failure")); await old; await tick();
  assertFullscreen(f); assertPosition(f, 1, 3);
  assert.equal(f.el("reader-text").textContent, "body other/chapter-z");
  assert.doesNotMatch(f.el("reader-text").textContent, /stale catalog/);
});
