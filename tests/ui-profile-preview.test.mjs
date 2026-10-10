import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { publicBook } from "../src/features-api.mjs";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function setup(t, initialBooks) {
  const dom = new JSDOM(
    await readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    {
      url: "http://localhost/",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  t.after(() => dom.window.close());
  const w = dom.window,
    calls = [];
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
  let books = initialBooks,
    handler = async () => ({ status: "pending" });
  let bookHandler = async (value) => structuredClone(value);
  let authenticated = true,
    generation = 1;
  w.eval(await readFile(new URL("../public/performance.js",import.meta.url),"utf8"));
  w.CollectorPerformance = {
    ...w.CollectorPerformance,
    debounce(fn) {
      fn.cancel = () => {};
      return fn;
    },
  };
  w.CollectorUI = {
    api: async (path, options = {}) => {
      calls.push({ path, options });
      return path === "/api/books"
        ? bookHandler(books)
        : handler(path, options);
    },
    node: (tag, className = "", text) => {
      const element = w.document.createElement(tag);
      element.className = className;
      if (text !== undefined) element.textContent = text;
      return element;
    },
    count: (value) => String(value ?? 0),
    date: (value) => value,
    empty: (_, text) => w.CollectorUI.node("p", "empty", text),
    textError: (error) => error.message,
    toast() {},
    preferences: () => ({ libraryPageSize: 24 }),
    authenticated: () => authenticated,
    generation: () => generation,
    view: () => "library",
  };
  w.eval(
    await readFile(new URL("../public/library.js", import.meta.url), "utf8"),
  );
  await w.CollectorLibrary.refresh();
  return {
    w,
    calls,
    card: () => w.document.querySelector(".library-card"),
    profile:()=>{w.CollectorLibrary.openProfile(books[0]);return w.document.getElementById('library-profile-panel');},
    setBooks: (next) => {
      books = next;
    },
    setHandler: (next) => {
      handler = next;
    },
    setBookHandler: (next) => {
      bookHandler = next;
    },
    logout() {
      authenticated = false;
      generation++;
      w.document.dispatchEvent(
        new w.CustomEvent("collector:auth", { detail: false }),
      );
    },
  };
}
const book = (metadataState = "pending", extra = {}) => ({
  id: "11",
  title: "정보를 확인할 작품",
  storedChapterCount: 0,
  expectedChapterCount: null,
  metadata: { state: metadataState },
  ...extra,
});

test("library renders the real publicBook flat metadata contract for every profile state", async (t) => {
  for (const state of ["pending", "failed", "deferred", "completed"]) {
    const metadataError = ["failed", "deferred"].includes(state)
      ? "원본 사이트의 접근 확인이 필요합니다."
      : undefined;
    const profile = publicBook(
      {
        id: "11",
        title: "서버 응답 작품",
        author: "실제 작가",
        genres: ["판타지"],
        tags: ["회귀"],
        synopsis: "서버에서 제공한 줄거리",
        storedChapterCount: 0,
        expectedChapterCount: state === "completed" ? 15 : null,
        metadataVersion: state === "completed" ? 1 : undefined,
        metadataFetchedAt:
          state === "completed" ? "2026-10-03T01:00:00Z" : undefined,
        thumbnailUrl: "https://example.com/source-cover.jpg",
      },
      { status: state, error: metadataError },
    );
    assert.equal(profile.metadata, undefined);
    assert.equal(profile.metadataStatus, state);
    const app = await setup(t, [profile]);
    assert.match(
      app.card().textContent,
      /서버 응답 작품.*실제 작가.*판타지.*회귀/,
    );
    assert.match(app.card().textContent, /서버에서 제공한 줄거리/);
    if (state === "pending") {
      assert.match(app.card().textContent, /작품 정보.*불러오는 중/);
      assert.equal(app.card().querySelector("img"), null);
    } else if (state === "completed") {
      assert.match(app.card().textContent, /총 15화/);
      assert.match(
        app.card().querySelector("img").getAttribute("src"),
        /^\/api\/books\/11\/thumbnail\?v=/,
      );
      assert.equal(app.card().querySelector(".metadata-retry"), null);
    } else {
      assert.match(
        app.card().textContent,
        /원본 사이트의 접근 확인이 필요합니다/,
      );
      app.profile().querySelector("#library-profile-metadata").click();
      await tick();
      assert.equal(
        app.calls.filter((call) => call.path === "/api/books/11/metadata")
          .length,
        1,
      );
    }
  }
});

test("flat profile status and error take precedence over legacy nested metadata", async (t) => {
  const app = await setup(t, [
    book("pending", {
      metadataStatus: "failed",
      metadataError: "현재 원본 사이트를 연결할 수 없습니다.",
      metadata: { state: "pending", error: "이전 상태 설명" },
    }),
  ]);
  assert.match(app.card().textContent, /작품 정보를 불러오지 못/);
  assert.match(app.card().textContent, /현재 원본 사이트를 연결할 수 없습니다/);
  assert.doesNotMatch(app.card().textContent, /이전 상태 설명/);
  assert.equal(app.profile().querySelector("#library-profile-metadata").hidden,false);
});

test("pending profile is visible immediately without source requests or chapter actions", async (t) => {
  const { w, calls, card } = await setup(t, [book()]);
  assert.match(card().textContent, /작품 정보.*불러오는 중/);
  assert.match(card().textContent, /본문 수집 대기/);
  card().click();assert.equal(w.document.getElementById('library-content-tab').disabled,true);
  assert.equal(card().querySelector('input[type="checkbox"]').disabled, true);
  assert.equal(card().querySelector("a.export-link"), null);
  assert.equal(card().querySelector(".book-actions .quiet"), null);
  assert.equal(card().querySelector("img"), null);
  assert.equal(
    w.document.getElementById("library-download-all").disabled,
    true,
  );
  await w.CollectorLibrary.refresh();
  assert.equal(
    calls.every((call) => call.path === "/api/books"),
    true,
  );
});

test("completed profile previews synopsis, writer, tags, expected chapters and cached cover before any body", async (t) => {
  const app = await setup(t, [book()]);
  app.setBooks([
    book("completed", {
      title: "왕의 귀환",
      author: "테스트 작가",
      genres: ["판타지"],
      tags: ["회귀"],
      synopsis: "잃어버린 왕국을 되찾기 위해 다시 시작하는 이야기.",
      expectedChapterCount: 123,
      metadataFetchedAt: "2026-10-03T01:00:00Z",
    }),
  ]);
  await app.w.CollectorLibrary.refresh();
  for (const text of [
    /왕의 귀환/,
    /테스트 작가/,
    /판타지/,
    /회귀/,
    /잃어버린 왕국/,
    /총 123화/,
    /본문 수집 대기/,
  ])
    assert.match(app.card().textContent, text);
  assert.equal(app.card().querySelector(".book-actions .quiet"), null);
  app.profile();assert.equal(app.w.document.getElementById('library-content-tab').disabled,true);
  assert.match(
    app.card().querySelector("img").getAttribute("src"),
    /^\/api\/books\/11\/thumbnail/,
  );
  assert.equal(
    app.calls.some((call) => call.options.method === "POST"),
    false,
  );
});

test("failed and deferred profiles show clear status and explicit retry only", async (t) => {
  for (const state of ["failed", "deferred"]) {
    const { card, calls, profile } = await setup(t, [
      book(state, {
        metadata: { state, error: "원본 사이트의 접근 확인이 필요합니다." },
      }),
    ]);
    assert.match(
      card().textContent,
      state === "failed" ? /작품 정보를.*불러오지 못/ : /작품 정보.*대기/,
    );
    assert.match(card().textContent, /원본 사이트의 접근 확인이 필요합니다/);
    assert.equal(
      profile().querySelector("#library-profile-metadata").textContent,
      "작품 정보 다시 불러오기",
    );
    assert.equal(calls.length, 1);
  }
});

test("metadata retry deduplicates clicks through response and library refresh", async (t) => {
  const app = await setup(t, [book("failed")]);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  app.setHandler(async () => {
    await gate;
    app.setBooks([book()]);
    return { status: "pending" };
  });
  const button = app.profile().querySelector("#library-profile-metadata");
  button.click();
  button.dispatchEvent(new app.w.Event("click"));
  assert.equal(button.disabled, true);
  assert.equal(
    app.calls.filter((call) => call.path.endsWith("/metadata")).length,
    1,
  );
  release();
  await tick();
  await tick();
  const request = app.calls.find((call) => call.path.endsWith("/metadata"));
  assert.equal(request.options.method, "POST");
  assert.deepEqual(JSON.parse(request.options.body), {});
  assert.match(app.card().textContent, /작품 정보.*불러오는 중/);
  assert.equal(button.hidden,true);
});

test("metadata retry waits for an already running library refresh and keeps its button locked", async (t) => {
  const app = await setup(t, [book("failed")]);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  app.setBookHandler(async () => {
    await gate;
    return [book()];
  });
  const refresh = app.w.CollectorLibrary.refresh();
  const button=app.profile().querySelector("#library-profile-metadata");button.click();
  await tick();
  assert.equal(button.disabled, true);
  const posts = app.calls.filter((call) => call.path.endsWith("/metadata"));
  assert.equal(posts.length, 1);
  button.dispatchEvent(new app.w.Event("click"));
  assert.equal(
    app.calls.filter((call) => call.path.endsWith("/metadata")).length,
    1,
  );
  app.setBooks([book()]);
  release();
  await refresh;
  await tick();
  assert.equal(button.hidden,true);
  assert.equal(
    app.calls.filter((call) => call.path === "/api/books").length,
    2,
  );
});

test("profile completion restores a previously missing cover and renders synopsis as text", async (t) => {
  const app = await setup(t, [book(undefined, { metadata: undefined })]);
  app.card().querySelector("img").dispatchEvent(new app.w.Event("error"));
  assert.equal(app.card().querySelector("img"), null);
  app.setBooks([
    book("completed", {
      synopsis: "<img src=x onerror=alert(1)> 줄거리",
      metadataFetchedAt: "2026-10-03T01:00:00Z",
    }),
  ]);
  await app.w.CollectorLibrary.refresh();
  assert.match(app.card().querySelector("img").getAttribute("src"), /\?v=/);
  assert.equal(app.card().querySelector(".book-synopsis img"), null);
  assert.match(app.card().querySelector(".book-synopsis").textContent, /<img/);
  app.setBooks([
    book("completed", { thumbnail: "https://example.com/private-cover.jpg" }),
  ]);
  await app.w.CollectorLibrary.refresh();
  assert.equal(app.card().querySelector("img"), null);
});

test("metadata errors can retry again and late retry errors cannot restore logged-out UI", async (t) => {
  const app = await setup(t, [book("failed")]);
  app.setHandler(async () => {
    throw new Error("요청 실패");
  });
  const button=app.profile().querySelector("#library-profile-metadata");button.click();
  await tick();
  assert.equal(button.disabled, false);
  assert.match(
    app.w.document.getElementById("library-error").textContent,
    /요청 실패/,
  );
  let reject;
  app.setHandler(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  button.click();
  app.logout();
  reject(new Error("private late error"));
  await tick();
  assert.equal(app.w.document.getElementById("books-list").children.length, 0);
  assert.doesNotMatch(
    app.w.document.getElementById("library-error").textContent,
    /private late error/,
  );
});

test("legacy chapter controls require stored content or actual failed chapters", async (t) => {
  const app = await setup(t, [
    book(undefined, { metadata: undefined, expectedChapterCount: 5 }),
  ]);
  assert.equal(app.card().querySelector(".book-actions .quiet"), null);
  app.setBooks([
    book(undefined, {
      metadata: undefined,
      expectedChapterCount: 5,
      failedChapterCount: 1,
    }),
  ]);
  await app.w.CollectorLibrary.refresh();
  assert.match(
    app.profile().querySelector("#library-profile-retry").textContent,
    /실패 회차/,
  );
  app.setBooks([
    book(undefined, {
      metadata: undefined,
      expectedChapterCount: 5,
      storedChapterCount: 1,
    }),
  ]);
  await app.w.CollectorLibrary.refresh();
  assert.match(
    app.profile().querySelector("#library-profile-retry").textContent,
    /누락 회차/,
  );
  assert.equal(app.w.document.getElementById('library-content-tab').disabled,false);
});
