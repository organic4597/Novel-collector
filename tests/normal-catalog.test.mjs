import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  Collector,
  readCatalogDocument,
  chapterIdFor,
} from "../src/collector.mjs";
import { readWorkMetadata } from "../src/collection-metadata.mjs";

const source = "https://newtoki1.org/novel/21104";
const viewer = "https://sbxh9.com/novel/21104";
const row = (number) =>
  `<li class="novel-ep-row" data-ep="${number}" data-episode-id="${3001000 + number}"><a class="novel-ep-link" href="/novel/21104/${3001000 + number}"><span class="ne-num">${number}화</span><span class="ne-title">회차 ${number}</span></a></li>`;
const more = '<button type="button">이전 회차 더 보기</button>';
function html(count, total = 376, button = true) {
  return `<section class="novel-detail"><div class="nd-thumb"><img src="/cover.jpg"></div><div class="nd-info"><h1>정상 작품 제목</h1><div class="nd-meta"><a href="/search?q=작가&field=author">실제 작가</a> · ${total}화</div><div class="nd-platform">플랜피</div><span class="nv-badge--done">완결</span><div class="hero-v2-tags"><a>#현대</a><a>#성장</a></div><div class="nd-desc">소개 첫 줄<br>소개 다음 줄</div></div></section><section><h2>에피소드 (${total}화)</h2><ul class="novel-eps" id="novel-episode-list-21104">${Array.from({ length: count }, (_, i) => row(i)).join("")}</ul>${button ? more : ""}</section>`;
}
const origins = {
  resolve: (url) => url.replace("https://newtoki1.org", "https://sbxh9.com"),
  isViewerHost: (host) => host === "sbxh9.com",
  assertNavigation(original, actual) {
    assert.equal(
      new URL(actual).origin,
      new URL(this.resolve(original)).origin,
    );
    assert.equal(new URL(actual).pathname, new URL(original).pathname);
  },
  canonicalChapter(value, original) {
    const url = new URL(value);
    assert.equal(url.origin, new URL(this.resolve(original)).origin);
    assert.match(url.pathname, /^\/novel\/21104\/\d+$/);
    return new URL(url.pathname, new URL(original).origin).href;
  },
};

function fixture(
  t,
  {
    count = 100,
    total = 376,
    onClick,
    initialDelay = 0,
    contentTimeoutMs = 2000,
  } = {},
) {
  const dom = new JSDOM(html(initialDelay ? 0 : count, total), { url: viewer });
  t.after(() => dom.window.close());
  let clicks = 0;
  const addButton = () => {
    const section =
      dom.window.document.querySelector("ul.novel-eps").parentElement;
    section.insertAdjacentHTML("beforeend", more);
    wire();
  };
  const append = (from, to) =>
    dom.window.document
      .querySelector("ul.novel-eps")
      .insertAdjacentHTML(
        "beforeend",
        Array.from({ length: to - from }, (_, i) => row(from + i)).join(""),
      );
  const wire = () => {
    const button = dom.window.document.querySelector("button");
    button?.addEventListener("click", () => {
      clicks++;
      button.remove();
      if (onClick) return onClick({ dom, clicks, append, addButton });
      const current =
        dom.window.document.querySelectorAll("li.novel-ep-row").length;
      setTimeout(() => {
        const next = Math.min(total, current + 100);
        append(current, next);
        if (next < total) addButton();
      }, 10);
    });
  };
  wire();
  if (initialDelay) setTimeout(() => append(0, count), initialDelay);
  const page = {
    visits: [],
    async goto(url) {
      this.visits.push(url);
      return { status: () => 200 };
    },
    url: () => dom.window.document.URL,
    evaluate: async (fn) => fn(dom.window.document),
  };
  const events = [];
  const collector = new Collector({
    viewerOrigins: origins,
    delayMs: 0,
    contentTimeoutMs,
  });
  return {
    dom,
    page,
    collector,
    clicks: () => clicks,
    hooks: {
      report: async () => {},
      event: async (...args) => events.push(args),
    },
    events,
  };
}

test("normal catalog parser scopes title, count, rows and more button", () => {
  const dom = new JSDOM(html(2), { url: viewer });
  const parsed = readCatalogDocument(dom.window.document);
  assert.equal(parsed.normalCatalog, true);
  assert.equal(parsed.title, "정상 작품 제목");
  assert.equal(parsed.expectedChapters, 376);
  assert.equal(parsed.hasMore, true);
  assert.equal(parsed.chapters[0].number, 0);
  assert.equal(parsed.chapters[0].title, "회차 0");
  assert.equal(parsed.chapters[0].url, `${viewer}/3001000`);
  const list = dom.window.document.querySelector("ul");
  list.insertAdjacentHTML(
    "beforeend",
    row(2).replace("/novel/21104/", "/novel/99999/"),
  );
  list.insertAdjacentHTML(
    "beforeend",
    row(3).replace('href="/novel/', 'href="https://evil.example/novel/'),
  );
  assert.equal(readCatalogDocument(dom.window.document).chapters.length, 2);
  dom.window.close();
});

test("an initially stalled catalog gets one fresh navigation before failing the job", async (t) => {
  const f = fixture(t, { count: 0, total: 3, contentTimeoutMs: 60 });
  f.dom.window.document.querySelector("button").disabled = true;
  const goto = f.page.goto.bind(f.page);
  f.page.goto = async (url) => {
    const response = await goto(url);
    if (f.page.visits.length === 2) {
      f.dom.window.document.querySelector("ul").innerHTML = [0, 1, 2].map(row).join("");
      f.dom.window.document.querySelector("button").remove();
    }
    return response;
  };
  const catalog = await f.collector.catalog(f.page, { url: `${source}?epage=3` }, f.hooks);
  assert.equal(catalog.chapters.length, 3);
  assert.deepEqual(f.page.visits, [viewer, viewer]);
  assert.equal(f.events.filter(([level]) => level === "warn").length, 1);
});

test("persistent partial catalog reports counts and button state without treating it as complete", async (t) => {
  const f = fixture(t, { count: 2, total: 4, contentTimeoutMs: 60, onClick: () => {} });
  await assert.rejects(f.collector.catalog(f.page, { url: source }, f.hooks), (error) => {
    assert.equal(error.code, "CATALOG_LOAD_TIMEOUT");
    assert.equal(error.catalogState.loaded, 2);
    assert.equal(error.catalogState.expected, 4);
    assert.equal(error.catalogState.hasMore, false);
    assert.match(error.message, /누적 2\/4/);
    return true;
  });
  assert.equal(f.page.visits.length, 2);
});

test("normal catalog includes explicitly disabled not-ready rows using their publicly declared numeric identity", () => {
  const dom = new JSDOM(html(3, 3, false), { url: viewer });
  const disabled = dom.window.document.querySelectorAll("li")[1];
  disabled.classList.add("novel-ep--not-ready");
  const link = disabled.querySelector("a");
  link.setAttribute("aria-disabled", "true");
  link.setAttribute("href", "/novel/21104");
  const catalog = readCatalogDocument(dom.window.document);
  assert.equal(catalog.chapters.length, 3);
  assert.equal(catalog.chapters[1].url, `${viewer}/3001001`);
  assert.equal(catalog.chapters[1].number, 1);
  assert.equal(catalog.chapters[1].notReady, true);
  assert.equal(Object.hasOwn(catalog.chapters[0], "notReady"), false);
  dom.window.close();
});

test("not-ready identity never converts malformed, foreign, unmarked or mismatching row links", () => {
  const dom = new JSDOM(html(1, 1, false), { url: viewer });
  const original = dom.window.document.querySelector("li");
  original.classList.add("novel-ep--not-ready");
  original.querySelector("a").setAttribute("aria-disabled", "true");
  original.querySelector("a").setAttribute("href", "/novel/21104");
  for (const mutate of [
    (node) => node.querySelector("a").removeAttribute("aria-disabled"),
    (node) => node.classList.remove("novel-ep--not-ready"),
    (node) => node.setAttribute("data-episode-id", "bad-id"),
    (node) => node.setAttribute("data-ep", "1.5"),
    (node) =>
      node
        .querySelector("a")
        .setAttribute("href", "https://evil.example/novel/21104"),
    (node) => node.querySelector("a").setAttribute("href", "/novel/99999"),
    (node) => node.querySelector("a").setAttribute("href", "/novel/21104/888"),
  ]) {
    const row = original.cloneNode(true);
    mutate(row);
    original.replaceWith(row);
    assert.equal(readCatalogDocument(dom.window.document).chapters.length, 0);
    row.replaceWith(original);
  }
  dom.window.close();
});

test("normal complete catalog retains not-ready flags and canonical hashes for later skip and retry handling", async (t) => {
  const f = fixture(t, { count: 2, total: 4 });
  const first = f.dom.window.document.querySelector("li");
  first.classList.add("novel-ep--not-ready");
  first.querySelector("a").setAttribute("aria-disabled", "true");
  first.querySelector("a").setAttribute("href", "/novel/21104");
  const catalog = await f.collector.catalog(f.page, { url: source }, f.hooks);
  assert.equal(catalog.expectedChapters, 4);
  assert.equal(catalog.chapters[0].notReady, true);
  assert.equal(catalog.chapters[0].url, `${source}/3001000`);
  assert.equal(catalog.chapters[0].id, chapterIdFor(`${source}/3001000`));
  assert.equal(catalog.chapters[0].number, 0);
});

test("normal metadata records declared author, platform, tags, cover and complete count", () => {
  const dom = new JSDOM(html(1), { url: viewer });
  const metadata = readWorkMetadata(dom.window.document);
  assert.equal(metadata.title, "정상 작품 제목");
  assert.equal(metadata.author, "실제 작가");
  assert.equal(metadata.platform, "플랜피");
  assert.equal(metadata.publication, "completed");
  assert.deepEqual(metadata.tags, ["현대", "성장"]);
  assert.equal(metadata.thumbnailUrl, "https://sbxh9.com/cover.jpg");
  assert.equal(metadata.expectedChapterCount, 376);
  assert.match(metadata.synopsis, /첫 줄\n소개 다음 줄/);
  dom.window.close();
});

test("normal catalog waits for initial rows and expands 376 chapters on the same page while preserving canonical identities", async (t) => {
  const f = fixture(t, { initialDelay: 10 });
  const catalog = await f.collector.catalog(
    f.page,
    { url: `${source}?epage=3`, startEpisode: 0 },
    f.hooks,
  );
  assert.equal(catalog.expectedChapters, 376);
  assert.equal(catalog.chapters.length, 376);
  assert.equal(catalog.chapters[0].number, 0);
  assert.equal(f.clicks(), 3);
  assert.deepEqual(f.page.visits, [viewer]);
  assert.equal(catalog.chapters[0].url, `${source}/3001000`);
  assert.equal(catalog.chapters[0].id, chapterIdFor(`${source}/3001000`));
});

test("normal catalog applies selected range after complete expansion", async (t) => {
  const f = fixture(t, { count: 2, total: 4 });
  const catalog = await f.collector.catalog(
    f.page,
    { url: source, startEpisode: 0, endEpisode: 1 },
    f.hooks,
  );
  assert.equal(catalog.allChapters.length, 4);
  assert.deepEqual(
    catalog.chapters.map((chapter) => chapter.number),
    [0, 1],
  );
});

test("normal catalog accumulates the source moving window capped at 300 rendered rows", async (t) => {
  let loaded = 100;
  const f = fixture(t, {
    onClick: ({ dom, append, addButton }) =>
      setTimeout(() => {
        const next = Math.min(376, loaded + 100);
        append(loaded, next);
        loaded = next;
        const list = dom.window.document.querySelector("ul.novel-eps");
        while (list.children.length > 300) list.firstElementChild.remove();
        if (loaded < 376) addButton();
      }, 10),
  });
  const catalog = await f.collector.catalog(f.page, { url: source }, f.hooks);
  assert.equal(
    f.dom.window.document.querySelectorAll("li.novel-ep-row").length,
    300,
  );
  assert.equal(catalog.chapters.length, 376);
  assert.equal(catalog.chapters[0].number, 0);
  assert.equal(catalog.chapters.at(-1).number, 375);
  assert.equal(catalog.chapters[0].id, chapterIdFor(`${source}/3001000`));
  assert.equal(f.clicks(), 3);
});

test("normal catalog rejects a repeated moving window that contains no new chapter URLs", async (t) => {
  const f = fixture(t, {
    count: 300,
    contentTimeoutMs: 150,
    onClick: ({ dom, addButton }) => {
      const list = dom.window.document.querySelector("ul.novel-eps");
      list.replaceChildren(...Array.from(list.children).reverse());
      addButton();
    },
  });
  await assert.rejects(
    f.collector.catalog(f.page, { url: source }, f.hooks),
    /목차.*(?:완료|응답|불러)/,
  );
  assert.equal(f.clicks(), 2, "one attempt per fresh navigation, still bounded");
  assert.equal(f.page.visits.length, 2);
});

test("mapped old-theme viewer keeps epage pagination and canonical chapter identities", async (t) => {
  let dom;
  t.after(() => dom?.window.close());
  const visits = [];
  const page = {
    async goto(url) {
      visits.push(url);
      dom?.window.close();
      const number = new URL(url).searchParams.get("epage") === "2" ? 1 : 0;
      dom = new JSDOM(
        `<div class="page-title"><h2><span>기존 테마 작품</span></h2></div><ul class="list-body"><li class="list-item"><span class="wr-num">${number}</span><a class="item-subject" href="/novel/21104/${3001000 + number}">회차 ${number}</a></li></ul><div class="pg"><a href="?epage=2">2</a></div>`,
        { url },
      );
      return { status: () => 200 };
    },
    url: () => dom.window.document.URL,
    evaluate: async (fn) => fn(dom.window.document),
  };
  const collector = new Collector({ viewerOrigins: origins, delayMs: 0 });
  const catalog = await collector.catalog(
    page,
    { url: source },
    { report: async () => {}, event: async () => {} },
  );
  assert.deepEqual(visits, [viewer, `${viewer}?epage=2`]);
  assert.deepEqual(
    catalog.chapters.map((chapter) => chapter.url),
    [`${source}/3001000`, `${source}/3001001`],
  );
});

test("normal catalog waits for delayed metadata hydration before proving the total and reading metadata", async (t) => {
  const f = fixture(t, { count: 2, total: 4, initialDelay: 10 });
  const meta = f.dom.window.document.querySelector(".nd-meta");
  meta.innerHTML = "";
  f.dom.window.document.querySelector("h2").textContent = "에피소드";
  setTimeout(() => {
    meta.innerHTML =
      '<a href="/search?field=author">늦게 도착한 작가</a> · 4화';
  }, 20);
  const catalog = await f.collector.catalog(f.page, { url: source }, f.hooks);
  assert.equal(catalog.author, "늦게 도착한 작가");
  assert.equal(catalog.expectedChapters, 4);
});

test("normal catalog refuses an unknown declared total instead of trusting a temporarily missing more button", async (t) => {
  const f = fixture(t, { contentTimeoutMs: 150 });
  f.dom.window.document.querySelector(".nd-meta").innerHTML =
    '<a href="/search?field=author">실제 작가</a>';
  f.dom.window.document.querySelector("h2").textContent = "에피소드";
  await assert.rejects(
    f.collector.catalog(f.page, { url: source }, f.hooks),
    /전체 회차 수/,
  );
  assert.equal(f.clicks(), 0);
});

test("normal catalog load-more HTTP429 retains Retry-After and stops without exporting a partial catalog", async (t) => {
  let responseHandler;
  const f = fixture(t, {
    onClick: () =>
      responseHandler({
        status: () => 429,
        headerValue: async () => "1200",
        url: () => `${viewer}/episodes?before=100`,
      }),
  });
  f.page.on = (event, handler) => {
    assert.equal(event, "response");
    responseHandler = handler;
  };
  f.page.off = (event, handler) => {
    assert.equal(event, "response");
    assert.equal(handler, responseHandler);
    responseHandler = null;
  };
  await assert.rejects(
    f.collector.catalog(f.page, { url: source }, f.hooks),
    (problem) => problem.httpStatus === 429 && problem.retryAfterMs === 1200000,
  );
  assert.equal(f.clicks(), 1);
  assert.equal(responseHandler, null);
});

test("normal catalog refuses an incomplete list if load more never produces rows", async (t) => {
  const f = fixture(t, { onClick: () => {}, contentTimeoutMs: 150 });
  await assert.rejects(
    f.collector.catalog(f.page, { url: source }, f.hooks),
    /목차.*(?:완료|응답|늘|불러)/,
  );
  assert.equal(f.clicks(), 1);
});

test("normal catalog stops before another click when CAPTCHA appears during expansion", async (t) => {
  const f = fixture(t, {
    onClick: ({ dom }) =>
      dom.window.document.body.insertAdjacentHTML(
        "beforeend",
        '<div aria-label="퍼즐 슬라이더"></div>',
      ),
  });
  await assert.rejects(
    f.collector.catalog(f.page, { url: source }, f.hooks),
    (problem) => problem.attentionKind === "captcha",
  );
  assert.equal(f.clicks(), 1);
});

test("normal catalog rejects an unexpected navigation after expansion", async (t) => {
  const f = fixture(t, {
    onClick: ({ dom }) =>
      dom.reconfigure({ url: "https://sbxh9.com/novel/99999" }),
  });
  await assert.rejects(
    f.collector.catalog(f.page, { url: source }, f.hooks),
    (problem) => problem.attentionKind === "site_blocked",
  );
  assert.equal(f.clicks(), 1);
});

test("normal catalog cancellation interrupts load-more waiting and no further clicks", async (t) => {
  const abort = new AbortController();
  const f = fixture(t, { onClick: () => setTimeout(() => abort.abort(), 5) });
  await assert.rejects(
    f.collector.catalog(f.page, { url: source }, f.hooks, abort.signal),
    (problem) => problem.name === "AbortError",
  );
  assert.equal(f.clicks(), 1);
});
