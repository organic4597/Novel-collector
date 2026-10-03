// Self-contained for page.evaluate; reads only rendered catalog DOM.
export function readCatalogDocument(doc = document) {
  const base = new URL(doc.URL);
  const workId = base.pathname.match(/^\/novel\/(\d+)/)?.[1];
  const normalList = doc.querySelector(
    `ul.novel-eps#novel-episode-list-${workId}`,
  );
  const normal =
    !!normalList || !!doc.querySelector("section.novel-detail .nd-info");
  const title =
    doc
      .querySelector("section.novel-detail .nd-info h1, .page-title h2 span")
      ?.textContent.trim() ||
    doc.title?.split(" - ")[0]?.trim() ||
    "제목 없음";
  const rows = normal
    ? [...(normalList?.querySelectorAll("li.novel-ep-row") || [])]
    : [...doc.querySelectorAll("ul.list-body li.list-item")];
  const chapters = rows.flatMap((row) => {
    const link = row.querySelector(
      normal ? "a.novel-ep-link[href]" : "a.item-subject[href]",
    );
    if (!link) return [];
    let url;
    try {
      url = new URL(link.getAttribute("href"), base);
    } catch {
      return [];
    }
    const raw = normal ? row.getAttribute("data-ep") : null;
    const notReady = normal && row.classList.contains("novel-ep--not-ready");
    if (notReady) {
      const id = row.getAttribute("data-episode-id");
      const workPath = `/novel/${workId}`;
      const episodePath = `${workPath}/${id}`;
      if (
        (link.getAttribute("aria-disabled") !== "true" &&
          row.getAttribute("aria-disabled") !== "true") ||
        !/^[1-9]\d*$/.test(id || "") ||
        !/^\d+$/.test(raw || "") ||
        !Number.isSafeInteger(Number(raw)) ||
        url.search ||
        url.hash ||
        ![workPath, episodePath].includes(url.pathname.replace(/\/$/, ""))
      )
        return [];
      // This identity is metadata only; callers skip visibly unavailable bodies.
      url.pathname = episodePath;
    }
    if (
      url.origin !== base.origin ||
      url.username ||
      url.password ||
      !/^\/novel\/\d+(?:\/\d+)?\/?$/.test(url.pathname) ||
      url.pathname.replace(/\/$/, "") === base.pathname.replace(/\/$/, "")
    )
      return [];
    const parts = url.pathname.split("/").filter(Boolean);
    if (
      (parts.length === 3 && parts[1] !== workId) ||
      (normal && parts.length !== 3)
    )
      return [];
    url.search = "";
    url.hash = "";
    const numberText =
      row.querySelector(normal ? ".ne-num" : ".wr-num")?.textContent || "";
    const number = Number(
      raw != null && /^\d+$/.test(raw)
        ? raw
        : numberText.match(/\d+/)?.[0] ||
            link.textContent.match(/(\d+)\s*화/)?.[1] ||
            0,
    );
    if (!Number.isSafeInteger(number) || number < 0) return [];
    return [
      {
        number,
        title:
          (normal
            ? link.querySelector(".ne-title")?.textContent
            : null
          )?.trim() || link.textContent.trim(),
        url: url.href,
        ...(notReady ? { notReady: true } : {}),
      },
    ];
  });
  let maxPage = Number(base.searchParams.get("epage") || 1);
  if (!normal)
    for (const link of doc.querySelectorAll(".pg a[href]")) {
      try {
        const url = new URL(link.getAttribute("href"), base);
        const raw = url.searchParams.get("epage");
        if (
          url.origin === base.origin &&
          url.pathname.replace(/\/$/, "") ===
            base.pathname.replace(/\/$/, "") &&
          /^\d+$/.test(raw || "")
        )
          maxPage = Math.max(maxPage, Number(raw));
      } catch {
        /* Invalid page links are not navigation targets. */
      }
    }
  const visible = (element) => {
    for (
      let current = element;
      current?.nodeType === 1;
      current = current.parentElement
    ) {
      if (current.hidden || current.getAttribute("aria-hidden") === "true")
        return false;
      const style = doc.defaultView?.getComputedStyle?.(current);
      if (style?.display === "none" || style?.visibility === "hidden")
        return false;
    }
    return true;
  };
  const button =
    normalList &&
    [...normalList.parentElement.querySelectorAll("button")].find(
      (node) =>
        node.textContent.replace(/\s+/g, " ").trim() === "이전 회차 더 보기" &&
        visible(node),
    );
  const countText =
    doc.querySelector("section.novel-detail .nd-info .nd-meta")?.textContent ||
    normalList?.parentElement.querySelector("h2")?.textContent ||
    "";
  const expected = Number(
    countText
      .match(/(?:^|[\s·(])(\d[\d,]*)\s*화(?:$|[\s)])/u)?.[1]
      ?.replace(/,/g, ""),
  );
  return {
    title,
    chapters,
    maxPage: normal ? 1 : maxPage,
    author: normal
      ? [...doc.querySelectorAll("section.novel-detail .nd-meta a[href]")]
          .find((node) => {
            try {
              return (
                new URL(node.getAttribute("href"), base).searchParams.get(
                  "field",
                ) === "author"
              );
            } catch {
              return false;
            }
          })
          ?.textContent.trim() || ""
      : [...doc.querySelectorAll(".theme-detail-info-row")]
          .find((row) =>
            /작가|저자/.test(
              row.querySelector(
                ".theme-detail-info-label, .theme-detail-info-key",
              )?.textContent || "",
            ),
          )
          ?.querySelector(".theme-detail-info-value")
          ?.textContent.trim() || "",
    ...(normal
      ? {
          normalCatalog: true,
          expectedChapters:
            Number.isSafeInteger(expected) && expected > 0 ? expected : null,
          hasMore: !!button,
          moreReady:
            !!button &&
            !button.disabled &&
            button.getAttribute("aria-disabled") !== "true",
        }
      : {}),
  };
}

// Activates the website's ordinary DOM button; never constructs an API request.
export function clickCatalogMore(doc = document) {
  const workId = new URL(doc.URL).pathname.match(/^\/novel\/(\d+)/)?.[1];
  const list = doc.querySelector(`ul.novel-eps#novel-episode-list-${workId}`);
  const button = [
    ...(list?.parentElement.querySelectorAll("button") || []),
  ].find((node) => {
    if (
      node.textContent.replace(/\s+/g, " ").trim() !== "이전 회차 더 보기" ||
      node.disabled ||
      node.getAttribute("aria-disabled") === "true"
    )
      return false;
    for (
      let parent = node;
      parent?.nodeType === 1;
      parent = parent.parentElement
    ) {
      const style = doc.defaultView?.getComputedStyle?.(parent);
      if (
        parent.hidden ||
        parent.getAttribute("aria-hidden") === "true" ||
        style?.display === "none" ||
        style?.visibility === "hidden"
      )
        return false;
    }
    return true;
  });
  if (!button) return false;
  button.click();
  return true;
}
