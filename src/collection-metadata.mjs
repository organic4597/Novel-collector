// Self-contained for page.evaluate; contains no navigation or private credentials.
export function readWorkMetadata(doc = document) {
  const normal = doc.querySelector("section.novel-detail");
  const values = new Map();
  for (const row of doc.querySelectorAll(".theme-detail-info-row")) {
    const label =
      row
        .querySelector(
          ".theme-detail-info-label, .theme-detail-info-key, dt, th",
        )
        ?.textContent.replace(/[:\s]/g, "") || "";
    const value =
      row
        .querySelector(".theme-detail-info-value, dd, td")
        ?.textContent.trim() || "";
    if (label && value) values.set(label, value);
  }
  const find = (pattern) =>
    [...values].find(([key]) => pattern.test(key))?.[1] || "";
  const split = (value) => [
    ...new Set(
      value
        .split(/[,，|·/#\n]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  const title =
    normal?.querySelector(".nd-info h1")?.textContent.trim() ||
    doc
      .querySelector(
        ".page-title h2 span, .theme-detail-title, .theme-detail-title-line",
      )
      ?.textContent.trim() ||
    doc.title?.split(" - ")[0]?.trim() ||
    "";
  const synopsisNode = doc.querySelector(
    "section.novel-detail .nd-desc, .theme-detail-summary, .theme-detail-synopsis, .theme-detail-description, .view-content .novel-description, [data-theme-novel-description]",
  );
  const readText = (node) => {
    if (!node) return "";
    if (node.nodeType === 3) return node.textContent;
    if (node.tagName === "BR") return "\n";
    if (/^(SCRIPT|STYLE)$/.test(node.tagName || "")) return "";
    return [...node.childNodes].map(readText).join("");
  };
  const publicationRaw =
    normal?.querySelector(".nv-badge--done")?.textContent.trim() ||
    find(/^(발행구분|연재상태|상태|연재|완결|발행상태)$/);
  const publication = /완결|완료/.test(publicationRaw)
    ? "completed"
    : /연재|진행/.test(publicationRaw)
      ? "ongoing"
      : "unknown";
  const tagNodes = [
    ...doc.querySelectorAll(
      "section.novel-detail .hero-v2-tags a, .theme-detail-tags a, .theme-detail-tag, .theme-detail-tag-list a",
    ),
  ];
  const tags = tagNodes.length
    ? [
        ...new Set(
          tagNodes
            .map((node) => node.textContent.replace(/^#/, "").trim())
            .filter(Boolean),
        ),
      ]
    : split(find(/태그|키워드/));
  const image = doc.querySelector(
    "section.novel-detail .nd-thumb img, .theme-detail-cover img, .theme-detail-thumbnail img, .theme-detail-image img, .view-img img, img[data-theme-novel-cover]",
  );
  let thumbnailUrl = null;
  if (image) {
    try {
      const source =
        image.getAttribute("data-src") || image.getAttribute("src");
      if (source) {
        const url = new URL(source, doc.URL);
        if (url.protocol === "https:" && !url.username && !url.password)
          thumbnailUrl = url.href;
      }
    } catch {
      /* Missing covers stay unknown. */
    }
  }
  const normalAuthor =
    [...(normal?.querySelectorAll(".nd-meta a[href]") || [])]
      .find((node) => {
        try {
          return (
            new URL(node.getAttribute("href"), doc.URL).searchParams.get(
              "field",
            ) === "author"
          );
        } catch {
          return false;
        }
      })
      ?.textContent.trim() || "";
  const count = Number(
    normal
      ?.querySelector(".nd-info .nd-meta")
      ?.textContent.match(/(?:^|[\s·(])(\d[\d,]*)\s*화(?:$|[\s)])/u)?.[1]
      ?.replace(/,/g, ""),
  );
  return {
    title,
    author: normalAuthor || find(/작가|저자/),
    genres: split(find(/장르/)),
    tags,
    platform:
      normal?.querySelector(".nd-platform")?.textContent.trim() ||
      find(/플랫폼|출판|발행처|연재처/),
    publication,
    publicationRaw,
    synopsis: readText(synopsisNode)
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    thumbnailUrl,
    ...(Number.isSafeInteger(count) && count > 0 && count <= 100000
      ? { expectedChapterCount: count }
      : {}),
  };
}
