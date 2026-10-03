import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  readReaderDocument,
  readCatalogDocument,
  isPublicAddress,
  chapterIdFor,
  makeBookId,
  buildTxt,
  buildEpub,
  Collector,
} from "../src/collector.mjs";
import JSZip from "jszip";
import { join } from "node:path";
import { readWorkMetadata } from "../src/collection-metadata.mjs";
import { ChapterTiming } from "../src/timing.mjs";
import { readFile } from "node:fs/promises";

test("synthetic detail fixture preserves author, genre, status and cover without inventing absent fields", async () => {
  const html = await readFile(
    new URL("./fixtures/work-detail-synthetic.html", import.meta.url),
    "utf8",
  );
  const dom = new JSDOM(html, { url: "https://newtoki1.org/novel/63206" });
  const metadata = readWorkMetadata(dom.window.document);
  assert.equal(metadata.title, "합성 테스트 작품");
  assert.equal(metadata.author, "테스트 작가");
  assert.deepEqual(metadata.genres, ["무협"]);
  assert.equal(metadata.publication, "ongoing");
  assert.equal(metadata.publicationRaw, "연재중");
  assert.equal(metadata.platform, "");
  assert.deepEqual(metadata.tags, []);
  assert.equal(new URL(metadata.thumbnailUrl).hostname, "apitk.peertrk.com");
  assert.ok(metadata.synopsis.length > 100);
  assert.ok(metadata.synopsis.includes("\n"));
  dom.window.close();
});

test("work metadata uses labels rather than the first unrelated value", () => {
  const dom = new JSDOM(
    `<div class="page-title"><h2><span>실제 작품</span></h2></div>
    <div class="theme-detail-info-row"><span class="theme-detail-info-label">장르</span><span class="theme-detail-info-value">판타지, 현대</span></div>
    <div class="theme-detail-info-row"><span class="theme-detail-info-label">작가</span><span class="theme-detail-info-value">실제 작가</span></div>
    <div class="theme-detail-info-row"><span class="theme-detail-info-label">플랫폼</span><span class="theme-detail-info-value">문피아</span></div>
    <div class="theme-detail-info-row"><span class="theme-detail-info-label">연재</span><span class="theme-detail-info-value">완결</span></div>
    <div class="theme-detail-tags"><a>#성장</a><a>#마법</a></div>
    <div class="theme-detail-summary">첫 소개<br>다음 소개</div><div class="theme-detail-cover"><img src="/cover.jpg"></div>`,
    { url: "https://newtoki1.org/novel/1" },
  );
  const metadata = readWorkMetadata(dom.window.document);
  assert.equal(metadata.title, "실제 작품");
  assert.equal(metadata.author, "실제 작가");
  assert.deepEqual(metadata.genres, ["판타지", "현대"]);
  assert.equal(metadata.platform, "문피아");
  assert.equal(metadata.publication, "completed");
  assert.deepEqual(metadata.tags, ["성장", "마법"]);
  assert.equal(metadata.thumbnailUrl, "https://newtoki1.org/cover.jpg");
  assert.match(metadata.synopsis, /첫 소개/);
  dom.window.close();
});

test("chapter timing samples only actual attempts and caps its recent window", () => {
  let now = 10000;
  const timing = new ChapterTiming({ clock: () => now });
  assert.equal(timing.estimate(3).estimatedSecondsRemaining, null);
  timing.record(2000);
  now += 2000;
  const eta = timing.estimate(3);
  assert.equal(eta.estimatedSecondsRemaining, 6);
  assert.equal(eta.estimatedCompletionAt, new Date(now + 6000).toISOString());
  for (let index = 0; index < 30; index++) timing.record(1000);
  assert.equal(timing.estimate(3).timing.samples, 20);
  assert.equal(timing.estimate(3).estimatedSecondsRemaining, 3);
});

test("collector slots own separate profile directories and browser contexts", async () => {
  const store = {},
    closed = [];
  const base = new Collector({
    store,
    browserPath: "/usr/bin/chromium",
    profileDir: "/tmp/collector-profile",
    delayMs: 25,
    contentTimeoutMs: 200,
  });
  const first = base.fork(1),
    second = base.fork(2);
  assert.notEqual(first, second);
  assert.equal(first.store, store);
  assert.equal(first.profileDir, join(base.profileDir, "slot-1"));
  assert.equal(second.profileDir, join(base.profileDir, "slot-2"));
  assert.equal(second.browserPath, "/usr/bin/chromium");
  assert.equal(second.delayMs, 25);
  first.context = {
    async close() {
      closed.push(1);
    },
  };
  second.context = {
    async close() {
      closed.push(2);
    },
  };
  await first.close();
  assert.deepEqual(closed, [1]);
  assert.ok(second.context);
  assert.equal(base.context, null);
  await second.close();
  assert.deepEqual(closed, [1, 2]);
  assert.throws(() => base.fork(3));
});

test("reader uses the named open shadow root and preserves paragraphs", () => {
  const dom = new JSDOM(
    "<body><article>unrelated comment</article><div data-theme-novel-content></div></body>",
  );
  const root = dom.window.document
    .querySelector("[data-theme-novel-content]")
    .attachShadow({ mode: "open" });
  root.innerHTML =
    "<style>not content</style><p>첫 문단<br>다음 줄</p><p>둘째 문단</p>";
  assert.equal(
    readReaderDocument(dom.window.document).text,
    "첫 문단\n다음 줄\n\n둘째 문단",
  );
  dom.window.close();
});

test("serialized shadow content excludes the loading fallback", () => {
  const dom = new JSDOM(
    '<div data-theme-novel-content><template shadowrootmode="open"><p>정상 본문</p></template><div class="wr-none">본문 불러오는 중...</div></div>',
  );
  assert.equal(readReaderDocument(dom.window.document).text, "정상 본문");
  dom.window.close();
});

test("a missing chapter never returns page synopsis or comments", () => {
  const dom = new JSDOM(
    '<article>long synopsis</article><div data-theme-novel-content><div class="wr-none">본문이 아직 준비되지 않았습니다.</div></div>',
  );
  const result = readReaderDocument(dom.window.document);
  assert.equal(result.text, "");
  assert.match(result.notice, /준비되지/);
  dom.window.close();
});

test("catalog reads only chapter links, numbered rows and pagination", () => {
  const dom = new JSDOM(
    '<div class="page-title"><h2><span>작품 제목</span></h2></div><ul class="list-body"><li class="list-item"><span class="wr-num">2</span><a class="item-subject" href="/novel/30458/200">두 번째 회차</a></li><li class="list-item"><span class="wr-num">1</span><a class="item-subject" href="/novel/30458/100">첫 회차</a></li></ul><div class="pg"><a href="?epage=6">6</a><a href="https://evil.example/?epage=99">99</a></div>',
    { url: "https://newtoki1.org/novel/30458?epage=3" },
  );
  const result = readCatalogDocument(dom.window.document);
  assert.equal(result.title, "작품 제목");
  assert.equal(result.maxPage, 6);
  assert.equal(result.chapters[0].url, "https://newtoki1.org/novel/30458/200");
  assert.equal(result.chapters[1].number, 1);
  const foreignRow = dom.window.document.createElement("li");
  foreignRow.className = "list-item";
  foreignRow.innerHTML =
    '<a class="item-subject" href="/novel/99999/200">다른 작품</a>';
  dom.window.document.querySelector("ul").appendChild(foreignRow);
  assert.equal(readCatalogDocument(dom.window.document).chapters.length, 2);
  dom.window.close();
});

test("network address checks block private, loopback and mapped private IPv6", () => {
  for (const address of [
    "127.0.0.1",
    "10.1.1.1",
    "172.20.1.1",
    "192.168.255.254",
    "169.254.169.254",
    "::1",
    "fe80::1",
    "fd00::1",
    "::ffff:192.168.1.1",
  ])
    assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});

test("filesystem identities are stable and independent of title text", () => {
  assert.equal(
    makeBookId("https://newtoki1.org/novel/30458?epage=3"),
    "newtoki1_org-30458",
  );
  assert.equal(
    chapterIdFor("https://newtoki1.org/novel/30458/100"),
    chapterIdFor("https://newtoki1.org/novel/30458/100"),
  );
  assert.match(
    chapterIdFor("https://newtoki1.org/novel/30458/100"),
    /^[a-z0-9_-]+$/,
  );
});

test("TXT and EPUB preserve exactly the collected chapter text", async () => {
  const chapters = [
    { number: 1, title: "첫 회차 & <제목>", text: "첫 줄\n\n둘째 줄" },
  ];
  assert.match(buildTxt("작품", chapters).toString("utf8"), /첫 줄\n\n둘째 줄/);
  const zip = await JSZip.loadAsync(await buildEpub("작품", chapters));
  assert.equal(
    await zip.file("mimetype").async("string"),
    "application/epub+zip",
  );
  const content = await zip.file("OEBPS/chapter_1.xhtml").async("string");
  assert.match(content, /첫 줄/);
  assert.match(content, /&amp; &lt;제목&gt;/);
});
