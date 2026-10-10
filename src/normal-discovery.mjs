import { watchNormalDiscoveryResponses } from "./normal-discovery-network.mjs";
// Ordinary public controls only; no website API or private session state.
export function readNormalListState(doc = document) {
  const list = doc.querySelector("ul.novel-list, .search-results-grid, .work-card-grid");
  const pager = doc.querySelector(".pager-window--desktop");
  const active = pager
    ?.querySelector(".pager-num.is-active")
    ?.textContent.trim();
  const mode = doc.querySelector(
    '.view-mode-toggle button[title="페이지 형식"]',
  );
  const end = pager?.querySelector('button[aria-label="끝"]');
  const labels = [...doc.querySelectorAll(".filter .filter-row")].map(
    (row) => ({
      label: row.querySelector(".label")?.textContent.trim(),
      active: [...row.querySelectorAll(".chips .active")].map((node) =>
        node.textContent.replace(/^[✓✕]\s*/, "").trim()||node.querySelector("img[alt]")?.getAttribute("alt")||node.getAttribute("aria-label")||node.getAttribute("title")||"",
      ),
    }),
  );
  return {
    ready: !!list || /\b0\s*개/.test(doc.querySelector(".toolbar .count")?.textContent||""),
    pageMode: mode
      ? mode.getAttribute("aria-selected") === "true" ||
        mode.classList.contains("active")
      : !!pager,
    pagerPresent: !!pager,
    endDisabled: !!end?.disabled,
    total: Number(
      doc
        .querySelector(".toolbar .count")
        ?.textContent.match(/([\d,]+)\s*개/)?.[1]
        ?.replace(/,/g, ""),
    ),
    cardCount: list?.querySelectorAll("a[href]").length || 0,
    page: Number(active || new URL(doc.URL).searchParams.get("page") || 1),
    signature: [...(list?.querySelectorAll("a[href]") || [])]
      .map((node) => node.getAttribute("href"))
      .join("|"),
    sort:
      doc
        .querySelector(".sort-tabs .active .sort-label-full")
        ?.textContent.trim() ||
      doc.querySelector(".sort-tabs .active")?.textContent.trim() ||
      "",
    labels,
    busy:
      !!doc.querySelector(
        '.toolbar.is-pending, .filter.is-pending, .toolbar.is-loading, .novel-list.is-loading, [aria-busy="true"]',
      ) ||
      /불러오는\s*중/.test(
        doc.querySelector(".toolbar .count, .adm-empty")?.textContent || "",
      ),
    expanded:
      doc
        .querySelector('button[aria-controls="novel-more-panel"]')
        ?.getAttribute("aria-expanded") === "true",
  };
}

export function clickNormalListControl(control, doc = document) {
  const text = (node) =>
    node.textContent
      .replace(/^[✓✕]\s*/, "")
      .replace(/\s+/g, " ")
      .trim()||node.querySelector("img[alt]")?.getAttribute("alt")||node.getAttribute("aria-label")||node.getAttribute("title")||"";
  const pager = doc.querySelector(".pager-window--desktop");
  let node;
  let expectedPage = null;
  if (control.kind === "page") {
    const current = Number(
      pager?.querySelector(".pager-num.is-active")?.textContent,
    );
    if (current === Number(control.value)) return { changed: false };
    node = [...(pager?.querySelectorAll("button.pager-num") || [])].find(
      (item) => text(item) === String(control.value),
    );
    if (node) expectedPage = Number(control.value);
    else {
      const numbers = [...(pager?.querySelectorAll(".pager-num") || [])]
        .map((item) => Number(text(item)))
        .filter(Number.isSafeInteger);
      const previous = Number(control.value) < current;
      expectedPage = previous
        ? Math.max(1, Math.min(...numbers) - 10)
        : Math.max(...numbers) + 1;
      node = pager?.querySelector(
        `button[aria-label="${Number(control.value) < current ? "이전 10페이지" : "다음 10페이지"}"]`,
      );
    }
  } else if (["end", "first"].includes(control.kind)) {
    node = pager?.querySelector(
      `button[aria-label="${control.kind === "end" ? "끝" : "처음"}"]`,
    );
    if (node?.disabled) return { changed: false };
  } else if (control.kind === "sort") {
    node = [...doc.querySelectorAll(".sort-tabs button,.sort-tabs a")].find(
      (item) =>
        text(item.querySelector(".sort-label-full") || item) === control.value,
    );
  } else if (control.kind === "mode") {
    node = doc.querySelector('.view-mode-toggle button[title="페이지 형식"]');
    if (!node && pager) return { changed: false };
    if (node?.getAttribute("aria-selected") === "true")
      return { changed: false };
  } else if (["genre", "platform", "publication", "category"].includes(control.kind)) {
    const label = { genre: "장르", platform: "플랫폼", publication: "상태",category:"분류" }[
      control.kind
    ];
    const row = [...doc.querySelectorAll(".filter .filter-row")].find(
      (item) => text(item.querySelector(".label") || item) === label,
    );
    node = [...(row?.querySelectorAll(".chips button,.chips a") || [])].find(
      (item) => text(item) === control.value,
    );
  } else if (control.kind === "expand") {
    node = doc.querySelector('button[aria-controls="novel-more-panel"]');
    if (node?.getAttribute("aria-expanded") === "true")
      return { changed: false };
  }
  if (!node || node.disabled || node.getAttribute("aria-disabled") === "true")
    return { missing: true };
  if (node.classList.contains("active")) return { changed: false };
  node.click();
  return { changed: true, expectedPage };
}

const SORT_LABELS = {
  updated: "최신순",
  new: "신작순",
  bookmarks: "북마크순",
  views: "조회순",
  rating: "평점순",
  episodes: "화수순",
};
const SEARCH_SORT = {
  updated: null,
  bookmarks: "hot",
  views: "views",
  episodes: "episodes",
};
const failure = (message) => Object.assign(new Error(message), { status: 400 });

export function normalSearchUrl(query) {
  if (query.query && query.author)
    throw failure("제목과 작가 검색은 각각 선택해 주세요.");
  if (!(query.sort in SEARCH_SORT))
    throw failure(
      "검색 결과에서는 최신·북마크·조회·화수 정렬을 선택해 주세요.",
    );
  const url = new URL("https://newtoki1.org/search");
  url.searchParams.set("q", query.query || query.author);
  url.searchParams.set("kind", query.contentType||"novel");
  url.searchParams.set("field", query.author ? "author" : "title");
  url.searchParams.set("match", "contains");
  if (query.publication !== "all")
    url.searchParams.set("status", query.publication);
  if (SEARCH_SORT[query.sort])
    url.searchParams.set("sort", SEARCH_SORT[query.sort]);
  if (query.page > 1) url.searchParams.set("page", String(query.page));
  return url.href;
}

export async function openNormalDiscovery(
  owner,
  page,
  query,
  readDocument,
  readReader,
  { knownMaxPage = null, knownTotal = null, readPage = () => page.evaluate(readDocument), webtoonSources = null } = {},
) {
  const search = !!(query.query || query.author);
  if (!search && query.publication === "ongoing" && !["webtoon","manhwa"].includes(query.contentType))
    throw failure(
      "새 사이트의 전체 작품 목록에서는 연재 중 필터를 제공하지 않습니다. 제목·작가 검색에서 연재 상태를 선택해 주세요.",
    );
  const base = query.contentType==="manhwa"?new URL(owner.transportUrl("https://newtoki1.org/novel")).origin+"/manhwa":query.contentType==="webtoon"?
    new URL(owner.transportUrl("https://newtoki1.org/novel")).origin+(query.publication==="completed"?webtoonSources?.completed||"/end":webtoonSources?.ongoing||"/ing"):
    query.publication === "completed"
      ? "https://newtoki1.org/novel-end"
      : "https://newtoki1.org/novel";
  await owner.navigate(page, search ? normalSearchUrl(query) : base);
  // SSR buttons are present at DOMContentLoaded; their ordinary site handlers
  // are installed by asynchronously loaded client scripts. Let those scripts
  // finish before activating public controls, without reading private state.
  await page.waitForLoadState?.("load", { timeout: 15000 }).catch(() => {});
  if (search) {
    if (query.genre || query.platform)
      throw failure(
        "제목·작가 검색 결과의 장르·플랫폼은 작품 정보에서 확인해 주세요.",
      );
    return readPage();
  }
  const responses = watchNormalDiscoveryResponses(owner, page, base);
  const currentUrl = () => {
    const actual = new URL(page.url());
    const expected = new URL(owner.transportUrl(base));
    if (
      actual.origin !== expected.origin ||
      actual.pathname !== expected.pathname ||
      actual.username ||
      actual.password ||
      actual.port ||
      actual.hash
    )
      throw failure("소설 목록이 다른 주소로 이동했습니다.");
  };
  async function change(control) {
    owner.sourceGate.assertAvailable("newtoki1.org");
    currentUrl();
    const before = await page.evaluate(readNormalListState);
    const beforeStarted = responses.started;
    const beforeCompleted = responses.completed;
    let action = await page.evaluate(clickNormalListControl, control);
    if (action.missing)
      throw failure("요청한 목록 필터 또는 페이지 버튼을 찾지 못했습니다.");
    if (!action.changed) return;
    const deadline = Date.now() + 15000;
    const retryAt = Date.now() + 500;
    let retried = false;
    let stable = 0;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      owner.sourceGate.assertAvailable("newtoki1.org");
      currentUrl();
      await responses.check();
      const reader = await page.evaluate(readReader);
      if (reader.challenge || reader.verificationRequired)
        throw Object.assign(
          new Error("목록 조회 중 사이트 접근 확인이 필요합니다."),
          {
            code: "NEEDS_ATTENTION",
            attentionKind: reader.challenge
              ? "captcha"
              : reader.verificationKind,
            siteHost: "newtoki1.org",
          },
        );
      const after = await page.evaluate(readNormalListState);
      const label = { genre: "장르", platform: "플랫폼", publication: "상태",category:"분류" }[
        control.kind
      ];
      const proved =
        control.kind === "end"
          ? after.endDisabled
          : control.kind === "first"
            ? after.page === 1
            : control.kind === "page"
              ? after.page === action.expectedPage
              : control.kind === "sort"
                ? after.sort === control.value
                : label
                  ? after.labels.some(
                      (row) =>
                        row.label === label &&
                        row.active.includes(control.value),
                    )
                  : control.kind === "mode"
                    ? after.pageMode &&
                      (after.pagerPresent ||
                        (after.total >= 0 && after.total <= after.cardCount))
                    : control.kind === "expand"
                      ? after.expanded
                      : false;
      const filterChanged = ["genre", "platform", "sort", "category"].includes(
        control.kind,
      );
      const responseProved = responses.completedFor(
        page.url(),
        beforeCompleted,
        { page: after.page, startedAfter: beforeStarted },
      );
      const cachedProved =
        !filterChanged &&
        responses.started === beforeStarted &&
        (after.signature !== before.signature || control.kind === "mode");
      const dataProved = !responses.enabled || responseProved || cachedProved;
      stable =
        after.ready &&
        !after.busy &&
        proved &&
        dataProved &&
        responses.inFlight === 0
          ? stable + 1
          : 0;
      if (stable >= 2) return;
      if (
        !retried &&
        !after.busy &&
        Date.now() >= retryAt &&
        after.page === before.page
      ) {
        // An SSR control can be visible before its own site handler is ready.
        // Recheck active/disabled DOM state before one safe retry; selected
        // genre buttons are never toggled a second time.
        retried = true;
        const next = await page.evaluate(clickNormalListControl, control);
        if (next.changed) action = next;
      }
    }
    throw failure(
      "목록 필터 적용을 완료하지 못했습니다. 잠시 후 다시 시도하세요.",
    );
  }
  try {
    const initial = await readPage();
    // DOM-only fixtures and saved legacy catalog adapters keep their historical
    // tests. The live path always starts on an allowed normal frontend.
    if (!initial.normalCatalog) return initial;
    await change({ kind: "mode" });
    if(query.contentType==="webtoon"&&query.genre&&(await page.evaluate(readNormalListState)).labels.some(row=>row.label==="분류"))
      await change({kind:"category",value:"전체"});
    if (query.genre) await change({ kind: "genre", value: query.genre });
    if (query.platform)
      await change({ kind: "platform", value: query.platform });
    await change({ kind: "sort", value: SORT_LABELS[query.sort] });
    let data = await readPage();
    let maximum = data.maxPage;
    if (data.paginationUnresolved) {
      if (Number.isSafeInteger(knownMaxPage) && knownMaxPage >= maximum &&
          knownMaxPage <= 1000 && data.total === knownTotal) {
        maximum = knownMaxPage;
      } else {
        await change({ kind: "end" });
        maximum = (await page.evaluate(readNormalListState)).page;
        await change({ kind: "first" });
      }
    }
    if (query.page > maximum)
      throw failure("목록의 마지막 페이지를 초과했습니다.");
    for (
      let moves = 0;
      (await page.evaluate(readNormalListState)).page !== query.page;
      moves++
    ) {
      if (moves > 100) throw failure("목록 페이지 이동을 완료하지 못했습니다.");
      await change({ kind: "page", value: query.page });
    }
    data = await readPage();
    return { ...data, maxPage: maximum, paginationUnresolved: false };
  } finally {
    responses.close();
  }
}
