import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, width = 1280) {
  const dom = new JSDOM(await readFile(new URL("../public/index.html", import.meta.url), "utf8"), {
    url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document, calls = [], chapters = [{ id: "first", number: 2 }, { id: "last", number: 10 }];
  Object.defineProperty(w, "innerWidth", { value: width });
  let authenticated = true, generation = 1, handler;
  const book = { id: "book", title: "Synthetic menu book", contentType: "webtoon", storedChapterCount: 2 }, other = { ...book, id: "other", title: "Other synthetic menu book" };
  const body = (bookId, id) => ({ id, title: `${bookId}/${id}`, contentType: "webtoon", savedImages: 1, images: [{ index: 1, width: 640, height: 800, sha256: "a".repeat(64) }] });
  const respond = path => {
    const match = /^\/api\/books\/([^/]+)(?:\/chapters\/([^/]+))?$/.exec(path); assert.ok(match, `unexpected synthetic API request: ${path}`);
    return match[2] ? body(match[1], match[2]) : { book: match[1] === "other" ? other : book, chapters: structuredClone(chapters) };
  };
  handler = respond;
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; w.setTimeout(() => this.dispatchEvent(new w.Event("close")), 0); };
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.eval(await readFile(new URL("../public/performance.js", import.meta.url), "utf8"));
  w.CollectorUI = { ...w.CollectorPerformance, authenticated: () => authenticated, generation: () => generation,
    view: () => "library", preferences: () => ({ libraryPageSize: 24 }), toast() {}, textError: error => error.message,
    api: async path => { calls.push(path); return handler(path); } };
  w.eval(await readFile(new URL("../public/reader-images.js", import.meta.url), "utf8"));
  w.eval(await readFile(new URL("../public/library.js", import.meta.url), "utf8"));
  const el = id => { const element = d.getElementById(id); assert.ok(element, `missing reader menu element: #${id}`); return element; };
  return {
    w, d, calls, book, other, chapters, body, respond, el,
    setHandler: value => { handler = value; },
    open: (value = book) => w.CollectorLibrary.openBook(value),
    close: async () => { el("reader-dialog").close(); await tick(); },
    enter: async () => { await w.CollectorLibrary.openBook(book); el("reader-fullscreen-toggle").click(); },
    logout: () => { authenticated = false; generation++; d.dispatchEvent(new w.CustomEvent("collector:auth", { detail: false })); },
    pointer: (target, type, pointerType, relatedTarget = null) => {
      const event = new w.MouseEvent(type, { bubbles: type === "pointerdown", relatedTarget });
      Object.defineProperty(event, "pointerType", { value: pointerType }); target.dispatchEvent(event);
    },
    cancel: () => { const event = new w.Event("cancel", { cancelable: true }); el("reader-dialog").dispatchEvent(event); if (!event.defaultPrevented) el("reader-dialog").close(); return event; },
  };
}
function assertMenu(f, open) {
  assert.equal(f.el("reader-menu").hidden, !open); assert.equal(f.el("reader-menu-toggle").getAttribute("aria-expanded"), String(open));
}

test("popup tools stay inline while fullscreen starts with its compact menu closed", async t => {
  const f = await fixture(t); await f.open();
  assert.equal(f.el("reader-menu-toggle").hidden, true); assert.equal(f.el("reader-menu").hidden, false);
  assert.equal(f.el("reader-menu-toggle").getAttribute("aria-controls"), "reader-menu");
  assert.equal(f.el("reader-toolbar").contains(f.el("reader-menu-toggle")), true);
  for (const id of ["reader-book-title", "library-info-tab", "library-content-tab", "reader-previous", "reader-next"]) assert.equal(f.el("reader-menu").contains(f.el(id)), true);
  f.el("reader-fullscreen-toggle").click();
  assert.equal(f.el("reader-menu-toggle").hidden, false); assertMenu(f, false);
  f.el("reader-menu-toggle").click(); assertMenu(f, true);
  f.el("reader-fullscreen-toggle").click();
  assert.equal(f.el("reader-menu-toggle").hidden, true); assert.equal(f.el("reader-menu").hidden, false);
});

test("mouse and pen hover open and close the menu without remounting or fetching content", async t => {
  const f = await fixture(t); await f.enter();
  const image = f.el("reader-text").querySelector("img"), body = f.d.querySelector(".reader-body"), calls = [...f.calls]; body.scrollTop = 180;
  for (const pointerType of ["mouse", "pen"]) {
    f.pointer(f.el("reader-toolbar"), "pointerenter", pointerType); assertMenu(f, true);
    f.pointer(f.el("reader-toolbar"), "pointerleave", pointerType, body); assertMenu(f, false);
    assert.equal(f.el("reader-text").querySelector("img"), image); assert.equal(body.scrollTop, 180); assert.deepEqual(f.calls, calls);
  }
});

test("touch hover is ignored and direct activation toggles the menu", async t => {
  const f = await fixture(t, 390); await f.enter();
  f.pointer(f.el("reader-toolbar"), "pointerenter", "touch"); assertMenu(f, false);
  f.el("reader-menu-toggle").click(); assertMenu(f, true);
  f.pointer(f.el("reader-toolbar"), "pointerleave", "touch"); assertMenu(f, true);
  f.el("reader-menu-toggle").click(); assertMenu(f, false);
});

test("mouse and pen activation keep a menu opened by their preceding hover visible", async t => {
  const f = await fixture(t); await f.enter();
  for (const pointerType of ["mouse", "pen"]) {
    f.pointer(f.el("reader-toolbar"), "pointerenter", pointerType); assertMenu(f, true);
    const click = new f.w.MouseEvent("click", { bubbles: true, detail: 1 }); Object.defineProperty(click, "pointerType", { value: pointerType });
    f.el("reader-menu-toggle").dispatchEvent(click); assertMenu(f, true);
    f.pointer(f.el("reader-toolbar"), "pointerleave", pointerType, f.d.querySelector(".reader-body")); assertMenu(f, false);
  }
});

test("clicks without pointerType use the preceding pointer while keyboard clicks still toggle", async t => {
  const f = await fixture(t); await f.enter(); const trigger = f.el("reader-menu-toggle");
  for (const pointerType of ["mouse", "pen"]) {
    f.pointer(f.el("reader-toolbar"), "pointerenter", pointerType);
    f.pointer(trigger, "pointerdown", pointerType); trigger.dispatchEvent(new f.w.MouseEvent("click", { bubbles: true, detail: 1 })); assertMenu(f, true);
    f.pointer(f.el("reader-toolbar"), "pointerleave", pointerType, f.d.querySelector(".reader-body")); assertMenu(f, false);
  }
  for (const open of [true, false]) {
    f.pointer(trigger, "pointerdown", "touch"); trigger.dispatchEvent(new f.w.MouseEvent("click", { bubbles: true, detail: 1 })); assertMenu(f, open);
  }
  f.pointer(trigger, "pointerdown", "mouse"); trigger.click(); assertMenu(f, true); trigger.click(); assertMenu(f, false);
});

test("keyboard activation and ArrowDown open the menu without relying on hover", async t => {
  const f = await fixture(t); await f.enter();
  const trigger = f.el("reader-menu-toggle");
  for (const key of ["Enter", " ", "ArrowDown"]) {
    trigger.focus();
    const event = new f.w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }); trigger.dispatchEvent(event);
    // JSDOM does not perform the native button click for Enter or Space.
    if (key !== "ArrowDown" && !event.defaultPrevented) trigger.click();
    assertMenu(f, true);
    f.pointer(f.d.querySelector(".reader-body"), "pointerdown", "mouse"); assertMenu(f, false);
  }
});

test("focus inside the wrapper keeps the menu open while focus outside closes it without stealing focus", async t => {
  const f = await fixture(t); await f.enter(); f.el("reader-menu-toggle").click();
  f.el("reader-next").focus(); assertMenu(f, true);
  f.el("library-content-tab").focus(); await tick(); assertMenu(f, true);
  const body = f.d.querySelector(".reader-body"); body.focus(); await tick();
  assertMenu(f, false); assert.equal(f.d.activeElement, body);
});

test("closing a focused menu returns focus to the compact bar", async t => {
  const f = await fixture(t); await f.enter();
  for (const action of ["leave", "outside", "toggle"]) {
    f.el("reader-menu-toggle").click(); f.el("reader-next").focus(); assertMenu(f, true);
    if (action === "leave") f.pointer(f.el("reader-toolbar"), "pointerleave", "mouse", f.d.querySelector(".reader-body"));
    else if (action === "outside") f.pointer(f.d.querySelector(".reader-body"), "pointerdown", "touch");
    else f.el("reader-menu-toggle").click();
    assertMenu(f, false); assert.equal(f.d.activeElement, f.el("reader-menu-toggle"));
  }
});

test("Escape closes the menu, then returns to popup, then closes the dialog", async t => {
  const f = await fixture(t); await f.enter(); f.el("reader-menu-toggle").click(); f.el("reader-next").focus();
  const calls = [...f.calls];
  assert.equal(f.cancel().defaultPrevented, true); assertMenu(f, false);
  assert.equal(f.el("reader-dialog").classList.contains("reader-fullscreen"), true); assert.equal(f.d.activeElement, f.el("reader-menu-toggle"));
  assert.equal(f.cancel().defaultPrevented, true);
  assert.equal(f.el("reader-dialog").open, true); assert.equal(f.el("reader-dialog").classList.contains("reader-fullscreen"), false);
  assert.equal(f.el("reader-menu-toggle").hidden, true); assert.equal(f.el("reader-menu").hidden, false); assert.deepEqual(f.calls, calls);
  assert.equal(f.cancel().defaultPrevented, false); await tick();
  assert.equal(f.el("reader-dialog").open, false); assert.equal(f.el("reader-text").textContent, "");
});

test("Escape keydown closes the menu before fullscreen uses native dialog cancellation", async t => {
  const f = await fixture(t); await f.enter(); f.el("reader-menu-toggle").click();
  const escape = () => { const event = new f.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }); f.el("reader-dialog").dispatchEvent(event); return event; };
  assert.equal(escape().defaultPrevented, true); assertMenu(f, false);
  assert.equal(f.el("reader-dialog").classList.contains("reader-fullscreen"), true);
  assert.equal(escape().defaultPrevented, false); assert.equal(f.cancel().defaultPrevented, true);
  assert.equal(f.el("reader-dialog").open, true); assert.equal(f.el("reader-dialog").classList.contains("reader-fullscreen"), false);
  assert.equal(escape().defaultPrevented, false); assert.equal(f.cancel().defaultPrevented, false); await tick();
  assert.equal(f.el("reader-dialog").open, false);
});

test("mode return, another book, close and logout reset the compact menu", async t => {
  for (const action of ["popup", "other", "close", "logout"]) {
    const f = await fixture(t); await f.enter(); f.el("reader-menu-toggle").click(); assertMenu(f, true);
    if (action === "popup") f.el("reader-fullscreen-toggle").click();
    else if (action === "other") await f.open(f.other);
    else if (action === "close") await f.close();
    else { f.logout(); await tick(); }
    assert.equal(f.el("reader-dialog").classList.contains("reader-fullscreen"), false);
    assert.equal(f.d.documentElement.classList.contains("reader-fullscreen-open"), false);
    assert.equal(f.el("reader-menu-toggle").hidden, true); assert.equal(f.el("reader-menu").hidden, false);
    assert.equal(f.el("reader-menu-toggle").getAttribute("aria-expanded"), "false");
    f.pointer(f.el("reader-toolbar"), "pointerenter", "mouse");
    assert.equal(f.el("reader-menu-toggle").getAttribute("aria-expanded"), "false");
    if (["close", "logout"].includes(action)) assert.equal(f.el("reader-dialog").open, false);
  }
});

test("mobile chapter selection returns focus to the visible compact bar after the sidebar closes", async t => {
  const f = await fixture(t, 390); await f.enter(); f.el("reader-menu-toggle").click();
  f.el("reader-sidebar-toggle").click(); await tick();
  assert.equal(f.el("reader-sidebar").hidden, false); assertMenu(f, false);
  f.el("chapter-list").lastElementChild.focus(); f.el("chapter-list").lastElementChild.click(); await tick();
  assert.equal(f.el("reader-sidebar").hidden, true); assertMenu(f, false);
  assert.equal(f.d.activeElement, f.el("reader-menu-toggle")); assert.equal(f.el("reader-position").textContent.trim(), "2 / 2");
});

test("late catalog completion and post-logout chapter replies cannot restore menu or fullscreen state", async t => {
  const f = await fixture(t), catalog = deferred();
  f.setHandler(path => path === "/api/books/book" ? catalog.promise : f.respond(path));
  await f.w.CollectorLibrary.openProfile(f.book); f.el("reader-fullscreen-toggle").click(); assertMenu(f, false);
  f.el("reader-menu-toggle").click(); f.cancel(); f.cancel();
  catalog.resolve({ book: f.book, chapters: f.chapters }); await tick();
  assert.equal(f.el("reader-dialog").classList.contains("reader-fullscreen"), false);
  assert.equal(f.el("reader-menu-toggle").hidden, true); assert.equal(f.el("reader-menu").hidden, false);
  assert.equal(f.el("reader-menu-toggle").getAttribute("aria-expanded"), "false");
  f.setHandler(f.respond); f.el("reader-fullscreen-toggle").click();
  const chapter = deferred(); f.setHandler(path => path.endsWith("/chapters/last") ? chapter.promise : f.respond(path));
  f.el("reader-menu-toggle").click(); f.el("reader-next").click();
  f.logout(); chapter.resolve(f.body("book", "last")); await tick();
  assert.equal(f.el("reader-dialog").open, false); assert.equal(f.el("reader-text").textContent, "");
  assert.equal(f.el("reader-menu-toggle").hidden, true); assert.equal(f.el("reader-menu-toggle").getAttribute("aria-expanded"), "false");
  assert.equal(f.d.documentElement.classList.contains("reader-fullscreen-open"), false);
});
