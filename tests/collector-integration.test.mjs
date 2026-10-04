import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JSDOM } from "jsdom";
import JSZip from "jszip";
import { Collector, chapterIdFor, makeBookId } from "../src/collector.mjs";
import { FolderStore } from "../src/store.mjs";
import { BackoffController } from "../src/request-backoff.mjs";

const base = "https://newtoki1.org/novel/21104";
const chapterUrl = (number) => `${base}/${100 + number}`;
const bookTitle = "테스트 작품";
const bodyFor = (number) =>
  `<div data-theme-novel-content><template shadowrootmode="open"><p>${number}화 첫 줄<br>이어지는 줄</p><p>${number}화 마지막 문단</p></template><div class="wr-none">본문 불러오는 중...</div></div>`;
const missingBody =
  '<div data-theme-novel-content><div class="wr-none">본문이 아직 준비되지 않았습니다.</div></div>';
const textFor = (number) =>
  `${number}화 첫 줄\n이어지는 줄\n\n${number}화 마지막 문단`;

test("declared unready chapters count in the catalog, skip requests, preserve cached text and remain retryable", async (t) => {
  const f = await fixture(t, {
    pages: new Map([
      [chapterUrl(1), { html: bodyFor(1) }],
      [chapterUrl(3), { html: bodyFor(3) }],
    ]),
  });
  const chapters = [1, 2, 3].map((number) => ({
    id: chapterIdFor(chapterUrl(number)),
    number,
    title: `${number}화`,
    url: chapterUrl(number),
    ...(number < 3 ? { notReady: true } : {}),
  }));
  f.collector.catalog = async () => ({
    title: bookTitle,
    chapters,
    allChapters: chapters,
    expectedChapters: 3,
  });
  const bookId = makeBookId(base);
  await f.store.writeChapter(bookId, chapters[1].id, {
    ...chapters[1],
    text: textFor(2),
  });
  let failures = 0,
    successes = 0;
  f.hooks.requestFailure = async () => failures++;
  f.hooks.requestSuccess = async () => successes++;
  const result = await f.collector.run(f.job, f.hooks);
  assert.deepEqual(f.browser.visited, [chapterUrl(3)]);
  assert.equal(result.total, 3);
  assert.equal(result.failed, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.completed, 1);
  assert.equal(
    failures,
    0,
    "No source request failed for a declared missing body",
  );
  assert.equal(successes, 1);
  assert.equal((await f.store.readCatalog(bookId)).chapters.length, 3);
  assert.equal(
    (await f.store.listFailures(bookId))[0].code,
    "CONTENT_NOT_READY",
  );
  assert.equal(
    (await f.store.readChapter(bookId, chapters[1].id)).text,
    textFor(2),
  );
  const retry = await f.collector.run(
    { ...f.job, retryOnlyFailed: true },
    f.hooks,
  );
  assert.equal(retry.completed, 1);
  assert.equal(retry.failed, 0);
  assert.deepEqual(f.browser.visited, [chapterUrl(3), chapterUrl(1)]);
  assert.deepEqual(await f.store.listFailures(bookId), []);
});

test("backoff resume retries the interrupted cursor and skips older recorded failures without resetting streak from cache", async (t) => {
  const f = await fixture(t, {
    pages: new Map([
      [base, { html: catalogHtml([1, 2, 3]) }],
      [chapterUrl(2), { html: bodyFor(2) }],
      [chapterUrl(3), { html: bodyFor(3) }],
    ]),
  });
  const bookId = makeBookId(base);
  const first = {
    id: chapterIdFor(chapterUrl(1)),
    number: 1,
    title: "1화 제목",
    url: chapterUrl(1),
  };
  await f.store.recordFailure(bookId, first, {
    message: "지난 시도의 영구 누락",
    code: "CHAPTER_ERROR",
  });
  await f.store.writeChapter(bookId, chapterIdFor(chapterUrl(3)), {
    id: chapterIdFor(chapterUrl(3)),
    number: 3,
    title: "3화 제목",
    url: chapterUrl(3),
    text: textFor(3),
  });
  let successes = 0;
  f.hooks.requestSuccess = async () => successes++;
  const result = await f.collector.run(
    { ...f.job, backoffResumeChapterId: chapterIdFor(chapterUrl(2)) },
    f.hooks,
  );
  assert.deepEqual(f.browser.visited, [base, chapterUrl(2)]);
  assert.equal(successes, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.completed, 1);
  assert.equal(result.backoffResumeChapterId, null);
  assert.ok(
    f.reports.some((p) => p.currentChapterId === chapterIdFor(chapterUrl(2))),
  );
});
test("real reader failures report once and HTTP429 carries the server longer Retry-After", async (t) => {
  const f = await fixture(t, {
    pages: new Map([
      [base, { html: catalogHtml([1, 2]) }],
      [chapterUrl(1), { html: missingBody }],
      [chapterUrl(2), { html: bodyFor(2) }],
    ]),
  });
  let failures = 0,
    successes = 0;
  f.hooks.requestFailure = async () => failures++;
  f.hooks.requestSuccess = async () => successes++;
  await f.collector.run(f.job, f.hooks);
  assert.equal(failures, 1);
  assert.equal(successes, 1);
  const page = {
    goto: async () => ({ status: () => 429, headerValue: async () => "1200" }),
  };
  await assert.rejects(
    f.collector.navigate(page, base),
    (error) => error.httpStatus === 429 && error.retryAfterMs === 1200000,
  );
});

test("overwrite cooldown resume reuses prior successes and retains earlier failed reload records", async (t) => {
  const f = await fixture(t, {
    jobInput: { overwrite: true },
    pages: new Map([
      [base, { html: catalogHtml([1, 2, 3]) }],
      [chapterUrl(3), { html: bodyFor(3) }],
    ]),
  });
  const bookId = makeBookId(base);
  for (const number of [1, 2])
    await f.store.writeChapter(bookId, chapterIdFor(chapterUrl(number)), {
      number,
      title: `${number}화 제목`,
      url: chapterUrl(number),
      text: textFor(number),
    });
  await f.store.recordFailure(
    bookId,
    {
      id: chapterIdFor(chapterUrl(2)),
      number: 2,
      title: "2화 제목",
      url: chapterUrl(2),
    },
    { message: "지난 강제 재수집 실패" },
  );
  const result = await f.collector.run(
    { ...f.job, backoffResumeChapterId: chapterIdFor(chapterUrl(3)) },
    f.hooks,
  );
  assert.deepEqual(f.browser.visited, [base, chapterUrl(3)]);
  assert.equal(result.skipped, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.completed, 1);
  assert.equal((await f.store.listFailures(bookId)).length, 1);
});

test("resuming a verified complete catalog avoids source rescan and still applies the requested range", async t => {
  const f=await fixture(t);
  const id=makeBookId(f.job.url);
  const chapters=[1,2,3].map(n=>({id:chapterIdFor(chapterUrl(n)),number:n,title:`${n}화`,url:chapterUrl(n)}));
  chapters[2].notReady=true;
  await f.store.writeCatalog(id,{title:bookTitle,chapters,expectedChapters:3});
  f.collector.catalog=async()=>assert.fail("should reuse complete saved catalog");
  const plan=await f.collector.collectionPlan({}, {...f.job,resumeCatalog:true,startEpisode:2,endEpisode:2}, f.hooks,undefined,id);
  assert.equal(plan.allChapters.length,3);assert.deepEqual(plan.chapters.map(c=>c.number),[2]);
  assert.equal(plan.allChapters[2].notReady,true);
});

test("seven missing bodies are recorded and skipped before the next valid chapter without a global pause",{timeout:3000},async t=>{
  const numbers=Array.from({length:8},(_,i)=>i+1);
  const f=await fixture(t,{pages:new Map([[base,{html:catalogHtml(numbers)}],
    ...numbers.map(n=>[chapterUrl(n),{html:n===8?bodyFor(n):missingBody}])])});
  const backoff=new BackoffController({store:f.store});await backoff.load();f.collector.backoff=backoff;
  f.hooks.requestFailure=error=>backoff.failure({reason:error.message});f.hooks.requestSuccess=()=>backoff.success();
  const result=await f.collector.run(f.job,f.hooks);
  assert.equal(result.failed,7);assert.equal(result.completed,1);
  assert.equal(backoff.snapshot().active,false);
  assert.equal((await f.store.listFailures(makeBookId(base))).length,7);
  assert.equal((await f.store.readChapter(makeBookId(base),chapterIdFor(chapterUrl(8)))).text,textFor(8));
});

function catalogHtml(numbers, maxPage = 1) {
  return `<div class="page-title"><h2><span>${bookTitle}</span></h2></div><div class="theme-detail-info-row"><span class="theme-detail-info-label">작가</span><span class="theme-detail-info-value">작가</span></div><ul class="list-body">${numbers.map((number) => `<li class="list-item"><span class="wr-num">${number}</span><a class="item-subject" href="${chapterUrl(number)}">${number}화 제목</a></li>`).join("")}</ul><div class="pg"><a href="?epage=${maxPage}">마지막</a></div>`;
}

function fakeBrowser(pages) {
  let currentDom;
  let currentUrl;
  let closeCount = 0;
  let routeHandler;
  const visited = [];
  const page = {
    async goto(url) {
      visited.push(url);
      const fixture = pages.get(url);
      assert.ok(fixture, `Unexpected navigation: ${url}`);
      currentDom?.window.close();
      currentUrl = fixture.finalUrl || url;
      currentDom = new JSDOM(fixture.html || "", { url: currentUrl });
      return { status: () => fixture.status || 200 };
    },
    url: () => currentUrl,
    async evaluate(reader) {
      return reader(currentDom.window.document);
    },
  };
  const context = {
    async route(pattern, handler) {
      assert.equal(pattern, "**/*");
      routeHandler = handler;
    },
    async newPage() {
      return page;
    },
    async close() {
      closeCount++;
      currentDom?.window.close();
    },
  };
  return {
    context,
    visited,
    get closeCount() {
      return closeCount;
    },
    get routeHandler() {
      return routeHandler;
    },
  };
}

async function fixture(
  t,
  { format = "txt", pages, onEvent, launchContext, jobInput = {} } = {},
) {
  const directory = await mkdtemp(
    join(tmpdir(), "novel-collector-integration-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await new FolderStore(directory).init();
  const job = await store.createJob({
    url: `${base}?epage=3`,
    format,
    ...jobInput,
  });
  const browser = fakeBrowser(
    pages ||
      new Map([
        [base, { html: catalogHtml([2, 1]) }],
        [chapterUrl(1), { html: bodyFor(1) }],
        [chapterUrl(2), { html: bodyFor(2) }],
      ]),
  );
  const reports = [];
  const hooks = {
    async report(patch) {
      reports.push(patch);
      await store.patchJob(job.id, patch);
    },
    async event(level, message) {
      await store.appendEvent(job.id, { level, message });
      await onEvent?.(level, message);
    },
  };
  const collector = new Collector({
    store,
    launchContext: launchContext || (() => browser.context),
    delayMs: 0,
    contentTimeoutMs: 100,
  });
  t.after(() => collector.close());
  return { store, job, browser, reports, hooks, collector };
}

for (const format of ["txt", "epub"]) {
  test(`Collector.run persists ordered chapters and creates a usable ${format.toUpperCase()} export across catalog pages`, async (t) => {
    const f = await fixture(t, {
      format,
      pages: new Map([
        [base, { html: catalogHtml([2], 2) }],
        [`${base}?epage=2`, { html: catalogHtml([1, 2], 2) }],
        [chapterUrl(1), { html: bodyFor(1) }],
        [chapterUrl(2), { html: bodyFor(2) }],
      ]),
    });
    const result = await f.collector.run(f.job, f.hooks);
    assert.equal(result.status, "completed");
    assert.equal(result.total, 2);
    assert.equal(result.completed, 2);
    assert.equal(result.failed, 0);
    assert.equal(result.error, null);
    assert.deepEqual(f.browser.visited, [
      base,
      `${base}?epage=2`,
      chapterUrl(1),
      chapterUrl(2),
    ]);
    const book = await f.store.getBook(result.bookId);
    assert.equal(book.title, bookTitle);
    assert.equal(book.author, "작가");
    for (const number of [1, 2]) {
      const chapter = await f.store.readChapter(
        result.bookId,
        chapterIdFor(chapterUrl(number)),
      );
      assert.equal(chapter.text, textFor(number));
      assert.equal(chapter.size, Buffer.byteLength(textFor(number)));
      assert.match(chapter.hash, /^[a-f0-9]{64}$/);
    }
    assert.deepEqual(
      (await f.store.listChapters(result.bookId)).map(
        (chapter) => chapter.number,
      ),
      [1, 2],
    );
    const artifact = await f.store.getExport(f.job.id, format);
    assert.equal(artifact.filename, `${bookTitle}_1-2.${format}`);
    const bytes = await readFile(artifact.path);
    if (format === "txt") {
      const output = bytes.toString("utf8");
      assert.ok(output.indexOf(textFor(1)) < output.indexOf(textFor(2)));
      assert.ok(output.includes(textFor(2)));
      assert.ok(!output.includes("본문 불러오는 중"));
    } else {
      const zip = await JSZip.loadAsync(bytes);
      assert.equal(
        await zip.file("mimetype").async("string"),
        "application/epub+zip",
      );
      assert.match(
        await zip.file("OEBPS/chapter_1.xhtml").async("string"),
        /1화 첫 줄/,
      );
      assert.match(
        await zip.file("OEBPS/chapter_2.xhtml").async("string"),
        /2화 마지막 문단/,
      );
      assert.match(
        await zip.file("OEBPS/content.opf").async("string"),
        /테스트 작품/,
      );
    }
    assert.ok(
      f.reports.some((patch) => patch.completed === 2 && patch.failed === 0),
    );
    assert.equal(f.browser.closeCount, 1);
    assert.equal(f.collector.context, null);
  });
}

test("a reservation label survives collection while library metadata keeps the real book title", async (t) => {
  const f = await fixture(t, { jobInput: { title: "밤 예약" } });
  const result = await f.collector.run(f.job, f.hooks);
  assert.equal(result.title, "밤 예약");
  assert.equal((await f.store.getBook(result.bookId)).title, bookTitle);
  assert.equal(
    (await f.store.getExport(f.job.id, "txt")).filename,
    "밤 예약_1-2.txt",
  );
});

test("Collector.run reuses cached chapters without visiting their reader page and exports them", async (t) => {
  const f = await fixture(t);
  const bookId = makeBookId(f.job.url);
  const cached = await f.store.writeChapter(
    bookId,
    chapterIdFor(chapterUrl(1)),
    {
      number: 1,
      title: "기존 제목",
      url: chapterUrl(1),
      text: "이전에 저장한 본문",
    },
  );
  const result = await f.collector.run(f.job, f.hooks);
  assert.equal(result.status, "completed");
  assert.equal(result.skipped, 1);
  assert.equal(result.completed, 1);
  assert.deepEqual(f.browser.visited, [base, chapterUrl(2)]);
  assert.deepEqual(await f.store.readChapter(bookId, cached.id), cached);
  assert.match(
    await readFile((await f.store.getExport(f.job.id, "txt")).path, "utf8"),
    /이전에 저장한 본문/,
  );
  assert.ok(
    (await f.store.readEvents(f.job.id)).some((event) =>
      /저장된 본문 사용/.test(event.message),
    ),
  );
});

test("one unavailable chapter yields completed_with_errors and a partial export with only valid content", async (t) => {
  const f = await fixture(t, {
    pages: new Map([
      [base, { html: catalogHtml([1, 2]) }],
      [chapterUrl(1), { html: missingBody }],
      [chapterUrl(2), { html: bodyFor(2) }],
    ]),
  });
  const result = await f.collector.run(f.job, f.hooks);
  assert.equal(result.status, "completed_with_errors");
  assert.equal(result.failed, 1);
  assert.equal(result.completed, 1);
  assert.match(result.error, /1개 회차/);
  assert.equal(
    await f.store.readChapter(result.bookId, chapterIdFor(chapterUrl(1))),
    null,
  );
  const artifact = await f.store.getExport(f.job.id, "txt");
  assert.equal(artifact.filename, `${bookTitle}_2-2.txt`);
  const content = await readFile(artifact.path, "utf8");
  assert.ok(content.includes(textFor(2)));
  assert.ok(!content.includes("준비되지"));
  assert.ok(
    (await f.store.readEvents(f.job.id)).some(
      (event) =>
        event.level === "error" && /본문이 준비되지/.test(event.message),
    ),
  );
});

test("all unavailable chapters return failed with no misleading empty export", async (t) => {
  const f = await fixture(t, {
    pages: new Map([
      [base, { html: catalogHtml([1, 2]) }],
      [chapterUrl(1), { html: missingBody }],
      [chapterUrl(2), { html: missingBody }],
    ]),
  });
  const result = await f.collector.run(f.job, f.hooks);
  assert.equal(result.status, "failed");
  assert.equal(result.failed, 2);
  assert.equal(result.completed, 0);
  assert.deepEqual(result.exports, []);
  assert.equal(await f.store.getExport(f.job.id, "txt"), null);
  assert.deepEqual(await f.store.listChapters(result.bookId), []);
});

test("AbortSignal stops navigation, closes the browser and preserves chapters already saved", async (t) => {
  const controller = new AbortController();
  const f = await fixture(t, {
    onEvent(_level, message) {
      if (message.startsWith("1화 저장 완료")) controller.abort();
    },
  });
  await assert.rejects(f.collector.run(f.job, f.hooks, controller.signal), {
    name: "AbortError",
  });
  const bookId = makeBookId(f.job.url);
  assert.equal(
    (await f.store.readChapter(bookId, chapterIdFor(chapterUrl(1)))).text,
    textFor(1),
  );
  assert.equal(
    await f.store.readChapter(bookId, chapterIdFor(chapterUrl(2))),
    null,
  );
  assert.deepEqual(f.browser.visited, [base, chapterUrl(1)]);
  assert.equal(f.browser.closeCount, 1);
  assert.equal(f.collector.context, null);
  assert.equal(await f.store.getExport(f.job.id, "txt"), null);
});

test("HTTP 403 stops that work, defers unfinished chapters and exports saved content", async (t) => {
  const f = await fixture(t, {
    pages: new Map([
      [base, { html: catalogHtml([1, 2, 3]) }],
      [chapterUrl(1), { html: bodyFor(1) }],
      [chapterUrl(2), { status: 403 }],
    ]),
  });
  const result = await f.collector.run(f.job, f.hooks);
  assert.equal(result.status, "needs_attention");
  assert.equal(result.failed, 2);
  assert.deepEqual(f.browser.visited, [base, chapterUrl(1), chapterUrl(2)]);
  assert.equal((await f.store.listFailures(result.bookId)).length, 2);
  assert.equal(f.browser.closeCount, 1);
  assert.equal(
    (
      await f.store.readChapter(
        makeBookId(f.job.url),
        chapterIdFor(chapterUrl(1)),
      )
    ).text,
    textFor(1),
  );
  assert.equal(f.collector.availability.available, true);
  assert.ok(await f.store.getExport(f.job.id, "txt"));
});

test("range collection persists the entire catalog and canonical metadata", async (t) => {
  const f = await fixture(t, { jobInput: { startEpisode: 2, endEpisode: 2 } });
  const result = await f.collector.run(f.job, f.hooks);
  const manifest = await f.store.readCatalog(result.bookId);
  assert.equal(result.total, 1);
  assert.equal(manifest.expectedChapters, 2);
  assert.equal(manifest.chapters.length, 2);
  assert.equal((await f.store.getBook(result.bookId)).author, "작가");
  assert.deepEqual(f.browser.visited, [base, chapterUrl(2)]);
});

test("retry failed reads only failed readers and leaves saved hashes unchanged", async (t) => {
  const pages = new Map([
    [base, { html: catalogHtml([1, 2]) }],
    [chapterUrl(1), { html: bodyFor(1) }],
    [chapterUrl(2), { html: missingBody }],
  ]);
  const f = await fixture(t, { pages });
  const first = await f.collector.run(f.job, f.hooks);
  assert.equal(first.failedChapters.length, 1);
  const before = await f.store.readChapter(
    first.bookId,
    chapterIdFor(chapterUrl(1)),
  );
  pages.set(chapterUrl(2), { html: bodyFor(2) });
  f.browser.visited.length = 0;
  const result = await f.collector.run(
    {
      ...f.job,
      retryOnlyFailed: true,
      retryChapterIds: [chapterIdFor(chapterUrl(2))],
    },
    f.hooks,
  );
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(f.browser.visited, [chapterUrl(2)]);
  assert.equal(
    (await f.store.readChapter(first.bookId, before.id)).hash,
    before.hash,
  );
  assert.deepEqual(await f.store.listFailures(first.bookId), []);
  const output = await readFile(
    (await f.store.getExport(f.job.id, "txt")).path,
    "utf8",
  );
  assert.ok(output.includes(textFor(1)));
  assert.ok(output.includes(textFor(2)));
});

test("legacy failed retry rescans missing catalog but reads only missing chapters without a ledger", async (t) => {
  const f = await fixture(t);
  const bookId = makeBookId(f.job.url);
  const saved = await f.store.writeChapter(
    bookId,
    chapterIdFor(chapterUrl(1)),
    {
      number: 1,
      title: "legacy chapter",
      url: chapterUrl(1),
      text: "legacy saved text",
    },
  );
  assert.equal(await f.store.readCatalog(bookId), null);
  assert.deepEqual(await f.store.listFailures(bookId), []);
  const result = await f.collector.run(
    { ...f.job, retryOnlyFailed: true, retryChapterIds: null },
    f.hooks,
  );
  assert.equal(result.total, 1);
  assert.equal(result.completed, 1);
  assert.deepEqual(f.browser.visited, [base, chapterUrl(2)]);
  assert.equal((await f.store.readChapter(bookId, saved.id)).hash, saved.hash);
  assert.equal((await f.store.readCatalog(bookId)).chapters.length, 2);
});

test("failed overwrite retry reads its failed reader even when an older valid file exists", async (t) => {
  const pages = new Map([
    [base, { html: catalogHtml([1, 2]) }],
    [chapterUrl(1), { html: bodyFor(1) }],
    [chapterUrl(2), { html: missingBody }],
  ]);
  const f = await fixture(t, { pages, jobInput: { overwrite: true } });
  const bookId = makeBookId(f.job.url);
  await f.store.writeChapter(bookId, chapterIdFor(chapterUrl(2)), {
    number: 2,
    title: "old",
    url: chapterUrl(2),
    text: "previous version",
  });
  const first = await f.collector.run(f.job, f.hooks);
  assert.equal(first.failed, 1);
  const valid = await f.store.readChapter(bookId, chapterIdFor(chapterUrl(1)));
  pages.set(chapterUrl(2), { html: bodyFor(2) });
  f.browser.visited.length = 0;
  const retry = await f.collector.run(
    { ...f.job, overwrite: false, retryOnlyFailed: true },
    f.hooks,
  );
  assert.equal(retry.completed, 1);
  assert.equal(retry.skipped, 0);
  assert.deepEqual(f.browser.visited, [chapterUrl(2)]);
  assert.equal((await f.store.readChapter(bookId, valid.id)).hash, valid.hash);
  assert.equal(
    (await f.store.readChapter(bookId, chapterIdFor(chapterUrl(2)))).text,
    textFor(2),
  );
});

test("EPUB jobs always produce TXT and ETA excludes cached chapters", async (t) => {
  const f = await fixture(t, { format: "epub" });
  const bookId = makeBookId(f.job.url);
  await f.store.writeChapter(bookId, chapterIdFor(chapterUrl(1)), {
    number: 1,
    title: "cache",
    url: chapterUrl(1),
    text: "saved",
  });
  let clock = 10000;
  f.collector.clock = () => {
    clock += 1000;
    return clock;
  };
  const result = await f.collector.run(f.job, f.hooks);
  assert.ok(await f.store.getExport(f.job.id, "txt"));
  assert.ok(await f.store.getExport(f.job.id, "epub"));
  assert.equal(result.timing.samples, 1);
  assert.equal(result.estimatedSecondsRemaining, 0);
  assert.ok(
    f.reports.some(
      (report) =>
        report.timing?.samples === 0 &&
        report.estimatedSecondsRemaining === null,
    ),
  );
});

test("browser launch failure marks executor unavailable and returns the original failure", async (t) => {
  const launchError = new Error("executable missing");
  const f = await fixture(t, {
    launchContext: async () => {
      throw launchError;
    },
  });
  await assert.rejects(
    f.collector.run(f.job, f.hooks),
    (error) => error === launchError,
  );
  assert.equal(f.collector.availability.available, false);
  assert.match(f.collector.availability.lastError, /브라우저 실행 실패/);
  assert.equal(f.collector.context, null);
  assert.deepEqual(f.browser.visited, []);
  assert.equal(await f.store.getExport(f.job.id, "txt"), null);
});

test("overwrite replaces cached text and an episode range excludes unrequested chapters from export", async (t) => {
  const f = await fixture(t, {
    jobInput: { overwrite: true, startEpisode: 2, endEpisode: 2 },
  });
  const bookId = makeBookId(f.job.url);
  await f.store.writeChapter(bookId, chapterIdFor(chapterUrl(2)), {
    number: 2,
    title: "기존 제목",
    url: chapterUrl(2),
    text: "오래된 본문",
  });
  const result = await f.collector.run(f.job, f.hooks);
  assert.equal(result.total, 1);
  assert.equal(result.completed, 1);
  assert.equal(result.skipped, 0);
  assert.deepEqual(f.browser.visited, [base, chapterUrl(2)]);
  assert.equal(
    (await f.store.readChapter(bookId, chapterIdFor(chapterUrl(2)))).text,
    textFor(2),
  );
  assert.equal(
    await f.store.readChapter(bookId, chapterIdFor(chapterUrl(1))),
    null,
  );
  const artifact = await f.store.getExport(f.job.id, "txt");
  assert.equal(artifact.filename, `${bookTitle}_2-2.txt`);
  assert.ok(!(await readFile(artifact.path, "utf8")).includes("오래된 본문"));
});

test("browser security challenge stops collection with NEEDS_ATTENTION before creating chapter files", async (t) => {
  const f = await fixture(t, {
    pages: new Map([
      [
        base,
        {
          html: '<title>Just a moment...</title><div id="cf-challenge-running"></div>',
        },
      ],
    ]),
  });
  await assert.rejects(
    f.collector.run(f.job, f.hooks),
    (error) =>
      error.code === "NEEDS_ATTENTION" && /보안 확인/.test(error.message),
  );
  assert.deepEqual(f.browser.visited, [base]);
  assert.equal(f.browser.closeCount, 1);
  assert.equal(await f.store.getBook(makeBookId(f.job.url)), null);
});

test("an unexpected redirect stops collection with NEEDS_ATTENTION", async (t) => {
  const f = await fixture(t, {
    pages: new Map([
      [
        base,
        {
          finalUrl: "https://other.example/login",
          html: "<title>Login</title>",
        },
      ],
    ]),
  });
  await assert.rejects(
    f.collector.run(f.job, f.hooks),
    (error) =>
      error.code === "NEEDS_ATTENTION" && /다른 페이지/.test(error.message),
  );
  assert.equal(f.browser.closeCount, 1);
  assert.equal(await f.store.getExport(f.job.id, "txt"), null);
});

test("network guard aborts private literal requests and unsupported requests, permits a public literal without network", async () => {
  const collector = new Collector({ store: {} });
  let guard;
  await collector.installNetworkGuard({
    async route(_pattern, handler) {
      guard = handler;
    },
  });
  async function outcome(url, resourceType = "document") {
    const calls = [];
    await guard({
      request: () => ({ url: () => url, resourceType: () => resourceType }),
      async abort() {
        calls.push("abort");
      },
      async continue() {
        calls.push("continue");
      },
    });
    return calls;
  }
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "192.168.255.254",
    "169.254.169.254",
    "172.16.0.1",
    "100.64.0.1",
  ]) {
    assert.deepEqual(await outcome(`https://${ip}/resource`), ["abort"], ip);
  }
  assert.deepEqual(await outcome("https://8.8.8.8/resource"), ["continue"]);
  assert.deepEqual(await outcome("https://8.8.8.8/resource"), ["continue"]);
  assert.deepEqual(await outcome("https://user:password@8.8.8.8/resource"), [
    "abort",
  ]);
  assert.deepEqual(await outcome("file:///etc/passwd"), ["abort"]);
  assert.deepEqual(await outcome("data:text/html,content"), ["abort"]);
  for (const type of ["image", "media", "font"])
    assert.deepEqual(await outcome("https://8.8.8.8/resource", type), [
      "abort",
    ]);
});
