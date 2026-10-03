import { readWorkMetadata } from "./collection-metadata.mjs";
import { readCatalogDocument, clickCatalogMore } from "./catalog-document.mjs";

async function assertPage(collector, page, source, signal, helpers) {
  helpers.abortIfNeeded(signal);
  try {
    if (collector.viewerOrigins)
      collector.viewerOrigins.assertNavigation(source, page.url());
    else if (
      new URL(page.url()).origin !== new URL(source).origin ||
      new URL(page.url()).pathname.replace(/\/$/, "") !==
        new URL(source).pathname.replace(/\/$/, "")
    )
      throw new Error("Unexpected page");
  } catch {
    throw helpers.attention(
      "목차 수집 중 다른 페이지로 이동했습니다. 사이트 접근 상태를 확인하세요.",
      "site_blocked",
    );
  }
  const reader = await page.evaluate(helpers.readReaderDocument);
  if (reader.challenge || reader.verificationKind === "captcha")
    throw helpers.attention(
      "목차 수집 중 CAPTCHA 확인이 필요합니다.",
      "captcha",
    );
  if (reader.verificationRequired)
    throw helpers.attention(
      "목차 수집 중 사이트 로그인 확인이 필요합니다.",
      "authentication",
    );
}

function checkCount(data) {
  if (
    data.expectedChapters != null &&
    (!Number.isSafeInteger(data.expectedChapters) ||
      data.expectedChapters > 100000)
  )
    throw new Error("목차 회차 수가 비정상적입니다.");
  if (
    data.expectedChapters &&
    new Set(data.chapters.map((row) => row.url)).size > data.expectedChapters
  )
    throw new Error("목차 회차 수와 작품에 표시된 전체 회차 수가 다릅니다.");
}

function watchResponses(collector, page, source) {
  const origin = new URL(collector.viewerOrigins?.resolve(source) || source)
    .origin;
  const pending = new Set();
  let problem;
  const onResponse = (response) => {
    const type = response.request?.().resourceType?.();
    if (
      new URL(response.url()).origin !== origin ||
      (type && !["xhr", "fetch"].includes(type)) ||
      response.status() < 400
    )
      return;
    const task = collector
      .responseProblem(response)
      .then((failure) => {
        problem ||= failure;
      })
      .catch(() => {
        problem ||= new Error("목차 요청 상태를 확인하지 못했습니다.");
      });
    pending.add(task);
    task.finally(() => pending.delete(task));
  };
  page.on?.("response", onResponse);
  return {
    async check() {
      await Promise.all([...pending]);
      if (problem) throw problem;
    },
    close() {
      page.off?.("response", onResponse);
    },
  };
}

async function waitNormal(
  collector,
  page,
  source,
  signal,
  helpers,
  checkResponse,
  previous = new Map(),
) {
  const deadline = Date.now() + collector.contentTimeoutMs;
  do {
    await checkResponse();
    await assertPage(collector, page, source, signal, helpers);
    const data = await page.evaluate(readCatalogDocument);
    checkCount(data);
    // The normal frontend retains at most 300 rows; keep prior DOM windows.
    const accumulated = new Map([
      ...previous,
      ...data.chapters.map((chapter) => [chapter.url, chapter]),
    ]);
    const count = accumulated.size;
    if (data.expectedChapters && count > data.expectedChapters)
      throw new Error("누적 목차와 작품에 표시된 전체 회차 수가 다릅니다.");
    const complete = data.expectedChapters && count === data.expectedChapters;
    if (
      data.normalCatalog &&
      data.expectedChapters != null &&
      count > previous.size &&
      (complete || data.moreReady)
    )
      return { ...data, chapters: [...accumulated.values()] };
    await helpers.delay(50, signal);
  } while (Date.now() < deadline);
  throw new Error(
    "목차 불러오기를 완료하지 못했습니다. 회차 목록의 응답 또는 전체 회차 수를 확인하세요.",
  );
}

async function expandNormal(collector, page, source, hooks, signal, helpers) {
  const responses = watchResponses(collector, page, source);
  try {
    let data = await waitNormal(
      collector,
      page,
      source,
      signal,
      helpers,
      responses.check,
    );
    let clicks = 0;
    while (
      data.hasMore ||
      (data.expectedChapters && data.chapters.length < data.expectedChapters)
    ) {
      if (++clicks > 1000)
        throw new Error("목차 불러오기 횟수가 비정상적입니다.");
      await hooks.report({
        phase: `목차 ${data.chapters.length}${data.expectedChapters ? `/${data.expectedChapters}` : ""}화 확인 중`,
        lastActivity: new Date().toISOString(),
      });
      await helpers.delay(collector.delayMs, signal);
      await collector.backoff?.wait(signal);
      await assertPage(collector, page, source, signal, helpers);
      if (!(await page.evaluate(clickCatalogMore)))
        throw new Error(
          "목차 불러오기 버튼이 없어 전체 회차 수집을 완료하지 못했습니다.",
        );
      data = await waitNormal(
        collector,
        page,
        source,
        signal,
        helpers,
        responses.check,
        new Map(data.chapters.map((chapter) => [chapter.url, chapter])),
      );
      await hooks.event(
        "info",
        `목차 · ${data.chapters.length}${data.expectedChapters ? `/${data.expectedChapters}` : ""}화 발견`,
      );
    }
    if (
      data.expectedChapters &&
      new Set(data.chapters.map((row) => row.url)).size !==
        data.expectedChapters
    )
      throw new Error("목차 전체 회차 수집을 완료하지 못했습니다.");
    return data;
  } finally {
    responses.close();
  }
}

export async function collectCatalog(page, job, hooks, signal, helpers) {
  const url = new URL(job.url);
  url.pathname = `/novel/${url.pathname.match(/^\/novel\/(\d+)/)[1]}`;
  url.search = "";
  url.hash = "";
  const unique = new Map(),
    signatures = new Set();
  let maximum = 1,
    title = job.title || "",
    author = "",
    metadata = {};
  for (let number = 1; number <= maximum; number++) {
    if (number > 1) url.searchParams.set("epage", String(number));
    await hooks.report({
      phase: `목차 ${number}/${maximum}페이지 수집`,
      lastActivity: new Date().toISOString(),
    });
    await this.navigate(page, url.href, signal);
    let data = await page.evaluate(readCatalogDocument);
    if (data.normalCatalog)
      data = await expandNormal(this, page, url.href, hooks, signal, helpers);
    else if (!data.chapters.length) {
      await helpers.delay(1000, signal);
      data = await page.evaluate(readCatalogDocument);
    }
    if (number === 1) metadata = await page.evaluate(readWorkMetadata);
    if (!data.chapters.length)
      throw helpers.attention(
        "작품 목차를 찾지 못했습니다. 해당 페이지의 목록 또는 접근 상태를 확인하세요.",
      );
    if (data.maxPage > 1000 || !Number.isSafeInteger(data.maxPage))
      throw new Error("목차 페이지 수가 비정상적입니다.");
    maximum = Math.max(maximum, data.maxPage);
    title = data.title || title;
    author = metadata.author || data.author || author;
    const signature = data.chapters
      .map((chapter) => chapter.url)
      .sort()
      .join("|");
    if (signatures.has(signature))
      throw new Error("목차 페이지가 같은 회차 목록을 반복합니다.");
    signatures.add(signature);
    for (const chapter of data.chapters) {
      const canonical = this.viewerOrigins
        ? this.viewerOrigins.canonicalChapter(chapter.url, url.href)
        : chapter.url;
      unique.set(canonical, {
        ...chapter,
        url: canonical,
        id: helpers.chapterIdFor(canonical),
      });
    }
    await hooks.event(
      "info",
      `목차 ${number}/${maximum}페이지 · ${unique.size}화 발견`,
    );
    if (number < maximum) await helpers.delay(this.delayMs, signal);
  }
  const allChapters = [...unique.values()].sort(
    (a, b) => a.number - b.number || a.url.localeCompare(b.url),
  );
  const chapters = allChapters.filter(
    (chapter) =>
      (job.startEpisode == null || chapter.number >= job.startEpisode) &&
      (job.endEpisode == null || chapter.number <= job.endEpisode),
  );
  if (!chapters.length) throw new Error("지정한 회차 범위에 항목이 없습니다.");
  return {
    ...metadata,
    title: metadata.title || title,
    author,
    chapters,
    allChapters,
    expectedChapters: allChapters.length,
  };
}
