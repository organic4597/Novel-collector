// Rendered DOM adapters; historical parser is retained for fixtures only.
export function normalizeDiscoveryUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !(
      /^newtoki\d*\.(org|com|net|me)$/i.test(url.hostname) ||
      ["sbxh9.com", "toki32.com"].includes(url.hostname)
    )
  )
    throw new Error("지원하는 목록 주소가 아닙니다.");
  if (
    /^\/novel(?:\/\d+)?\/?$/.test(url.pathname) ||
    url.pathname === "/novel-end"
  )
    return url;
  if (url.pathname === "/search") {
    const allowed = ["q", "kind", "field", "match", "page", "status", "sort"];
    if (
      [...url.searchParams].some(
        ([key, value]) =>
          !allowed.includes(key) ||
          value.length > 200 ||
          /[\x00-\x1f\x7f]/.test(value),
      ) ||
      (url.searchParams.has("kind") && url.searchParams.get("kind") !== "novel")
    )
      throw new Error("소설 검색 주소가 잘못됐습니다.");
    return url;
  }
  const encoded = url.pathname.match(
    /^\/novel\/__q\/([A-Za-z0-9_-]{1,2048})\/?$/,
  )?.[1];
  if (!encoded) throw new Error("목록 경로가 잘못됐습니다.");
  const decoded = atob(
    encoded
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(encoded.length / 4) * 4, "="),
  );
  if (
    !/^[A-Za-z_][A-Za-z0-9_]*=/.test(decoded) ||
    /[\x00-\x1f\x7f]/.test(decoded)
  )
    throw new Error("목록 검색 경로가 잘못됐습니다.");
  const params = new URLSearchParams(decoded);
  if (
    [...params.keys()].some(
      (key) =>
        ![
          "kind",
          "page",
          "pub",
          "sod",
          "sst",
          "toon",
          "jaum",
          "tag",
          "plat",
          "stx",
          "author",
        ].includes(key),
    )
  )
    throw new Error("목록 검색 항목이 잘못됐습니다.");
  url.pathname = "/novel";
  url.search = params.toString();
  return url;
}
export function readDiscoveryDocument(doc = document) {
  const normalBase = new URL(doc.URL);
  const normalList = doc.querySelector("ul.novel-list, .search-results-grid");
  if (normalList && ["sbxh9.com", "toki32.com"].includes(normalBase.hostname)) {
    const items = new Map();
    for (const row of normalList.querySelectorAll(
      "a.novel-card[href], a.card[href]",
    )) {
      let url;
      try {
        url = new URL(row.getAttribute("href"), normalBase);
      } catch {
        continue;
      }
      const id = url.pathname.match(/^\/novel\/(\d{1,15})\/?$/)?.[1];
      if (
        !id ||
        items.has(id) ||
        url.origin !== normalBase.origin ||
        url.username ||
        url.password ||
        url.port ||
        url.hash ||
        url.search
      )
        continue;
      const spans = [...row.querySelectorAll(".nv-meta > span")];
      const countText =
        spans.find((node) => /^\s*[\d,]+\s*화\s*$/.test(node.textContent))
          ?.textContent || row.querySelector(".ep")?.textContent;
      const count = Number(countText?.replace(/[^\d]/g, ""));
      const ratingText = row.querySelector(".novel-rating-badge")?.textContent.trim() || "";
      const rating = /^\d(?:\.\d+)?$/.test(ratingText) ? Number(ratingText) : null;
      let thumbnailUrl = null;
      try {
        const image = row.querySelector(".nv-thumb img, .thumb img");
        const source =
          image?.getAttribute("data-src") || image?.getAttribute("src");
        if (source) {
          const cover = new URL(source, normalBase);
          if (
            cover.protocol === "https:" &&
            !cover.username &&
            !cover.password &&
            !cover.port
          )
            thumbnailUrl = cover.href;
        }
      } catch {
        /* An absent cover does not remove a useful work. */
      }
      const publicationRaw =
        row
          .querySelector(".nv-badge--done, .thumb > .badge")
          ?.textContent.trim() || "";
      items.set(id, {
        id,
        url: `https://newtoki1.org/novel/${id}`,
        title:
          row.querySelector(".nv-title, .subject")?.textContent.trim() ||
          "제목 없음",
        author: row.querySelector(".nv-author")?.textContent.trim() || "",
        genres: (row.querySelector(".genre")?.textContent || "")
          .split(/[,，|·/#\n]+/)
          .map((value) => value.trim())
          .filter(Boolean),
        tags: [],
        platform:
          spans
            .find(
              (node) =>
                !node.classList.contains("nv-date") &&
                !/화\s*$/.test(node.textContent),
            )
            ?.textContent.trim() || "",
        publication: /완결|완료/.test(publicationRaw) ? "completed" : "unknown",
        publicationRaw,
        rating: Number.isFinite(rating) && rating >= 0 && rating <= 5 ? rating : null,
        episodeCount:
          Number.isSafeInteger(count) && count > 0 && count <= 100000
            ? count
            : null,
        thumbnailUrl,
        updatedLabel: row.querySelector(".nv-date")?.textContent.trim() || "",
      });
    }
    const total = Number(
      doc
        .querySelector(".toolbar .count")
        ?.textContent.match(/([\d,]+)\s*개/)?.[1]
        ?.replace(/,/g, ""),
    );
    const page = Number(
      doc
        .querySelector(".pager-window--desktop .pager-num.is-active")
        ?.textContent.trim() ||
        normalBase.searchParams.get("page") ||
        1,
    );
    const filterRows = [...doc.querySelectorAll(".filter .filter-row")];
    const options = (label) => {
      const row = filterRows.find(
        (node) => node.querySelector(".label")?.textContent.trim() === label,
      );
      return [...(row?.querySelectorAll(".chips > button") || [])]
        .map((node) => node.textContent.replace(/^[✓✕]\s*/, "").trim())
        .filter((value) => value && value !== "전체");
    };
    const knownTotal =
      Number.isSafeInteger(total) && total >= 0 && total <= 1000000
        ? total
        : null;
    let maxPage = page;
    for (const node of doc.querySelectorAll(
      ".pager .pager-num, .pager a[href]",
    )) {
      const number = Number(node.textContent.trim());
      if (Number.isSafeInteger(number) && number >= 1 && number <= 1000)
        maxPage = Math.max(maxPage, number);
    }
    const end = doc.querySelector(
      '.pager-window--desktop button[aria-label="끝"]',
    );
    return {
      items: [...items.values()],
      page,
      maxPage,
      paginationUnresolved: !!end && !end.disabled,
      total: knownTotal,
      filters: { genres: options("장르"), platforms: options("플랫폼") },
      normalCatalog: true,
    };
  }
  // Historical theme parser: fixture compatibility only. Its network route is
  // disabled in SourceRequestGate; it is never a fallback source request.
  // Kept inside the parser because Playwright evaluates it without module scope.
  const listUrl = (value) => {
    const url = new URL(value);
    const match = url.pathname.match(
      /^\/novel\/__q\/([A-Za-z0-9_-]{1,2048})\/?$/,
    );
    if (match) {
      const encoded = match[1];
      const decoded = atob(
        encoded
          .replace(/-/g, "+")
          .replace(/_/g, "/")
          .padEnd(Math.ceil(encoded.length / 4) * 4, "="),
      );
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*=/.test(decoded) ||
        /[\x00-\x1f\x7f]/.test(decoded)
      )
        throw new Error("목록 검색 경로가 잘못됐습니다.");
      const params = new URLSearchParams(decoded);
      if (
        [...params.keys()].some(
          (key) =>
            ![
              "kind",
              "page",
              "pub",
              "sod",
              "sst",
              "toon",
              "jaum",
              "tag",
              "plat",
              "stx",
              "author",
            ].includes(key),
        )
      )
        throw new Error("목록 검색 항목이 잘못됐습니다.");
      url.pathname = "/novel";
      url.search = params.toString();
    }
    return url;
  };
  const base = listUrl(doc.URL),
    unique = new Map();
  for (const row of doc.querySelectorAll("li[data-genre][date-title]")) {
    let url;
    const link = [...row.querySelectorAll("a[href]")].find((a) => {
      try {
        return /^\/novel\/\d+\/?$/.test(
          new URL(a.getAttribute("href"), base).pathname,
        );
      } catch {
        return false;
      }
    });
    try {
      url = new URL(link?.getAttribute("href"), base);
    } catch {
      continue;
    }
    if (!link || url.origin !== base.origin) continue;
    const id = url.pathname.match(/^\/novel\/(\d+)/)?.[1];
    if (!id || unique.has(id)) continue;
    url.search = "";
    url.hash = "";
    let thumbnailUrl = null;
    try {
      const src = row.querySelector("img.theme-thumb-img")?.getAttribute("src");
      if (src) thumbnailUrl = new URL(src, base).href;
    } catch {
      /* optional image */
    }
    unique.set(id, {
      id,
      url: url.href,
      title: (
        row.querySelector("span.title")?.textContent ||
        row.getAttribute("date-title") ||
        "제목 없음"
      ).trim(),
      genres: (row.getAttribute("data-genre") || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
      platform: row.querySelector(".list-platform")?.textContent.trim() || "",
      publication: base.searchParams.get("pub") || "unknown",
      episodeCount: null,
      thumbnailUrl,
      updatedLabel: row.querySelector(".list-date")?.textContent.trim() || "",
    });
  }
  let maxPage = Number(base.searchParams.get("page") || 1);
  for (const a of doc.querySelectorAll(".pg a[href],.pagination a[href]")) {
    try {
      const url = listUrl(new URL(a.getAttribute("href"), base).href);
      const raw = url.searchParams.get("page");
      if (
        url.origin === base.origin &&
        url.pathname.replace(/\/$/, "") === "/novel" &&
        /^\d+$/.test(raw || "")
      )
        maxPage = Math.max(maxPage, Number(raw));
    } catch {
      /* invalid link */
    }
  }
  const filters = {
    genres: [
      ...new Set(
        [...doc.querySelectorAll(".s-genre[data-value]")]
          .map((el) => el.getAttribute("data-value"))
          .filter(Boolean)
          .concat([...unique.values()].flatMap((item) => item.genres)),
      ),
    ],
    platforms: [
      ...new Set(
        [...doc.querySelectorAll(".s-plat[data-value]")]
          .filter((el) => el.getAttribute("data-value"))
          .map((el) => el.textContent.trim())
          .concat(
            [...unique.values()].map((item) => item.platform).filter(Boolean),
          ),
      ),
    ],
  };
  return {
    items: [...unique.values()],
    page: Number(base.searchParams.get("page") || 1),
    maxPage,
    total: null,
    filters,
  };
}
