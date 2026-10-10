import { validateThumbnailUrl } from "./thumbnail-cache.mjs";
import { canonicalWorkInput } from "./source-links.mjs";
import { isWebtoonUrl, webtoonSource, isImageType } from "./webtoon-source.mjs";

export function normalizeWorkSource(value) {
  if(isWebtoonUrl(value))return webtoonSource(value);
  const bad = (message) => Object.assign(new Error(message), { status: 400 });
  let url;
  try {
    url = new URL(canonicalWorkInput(value));
  } catch {
    throw bad("작품 원본 주소가 올바르지 않습니다.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !/^newtoki\d*\.(org|com|net|me)$/i.test(url.hostname) ||
    !/^\/novel\/\d{1,15}(?:\/\d{1,15})?\/?$/.test(url.pathname)
  )
    throw bad("지원하는 작품 원본 주소가 아닙니다.");
  const id = url.pathname.match(/^\/novel\/(\d+)/)[1];
  url.pathname = `/novel/${id}`;
  url.search = "";
  url.hash = "";
  return { id, url: url.href };
}
const text = (value, max = 1000) =>
  typeof value === "string"
    ? value
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
        .trim()
        .slice(0, max)
    : "";
const labels = (value) =>
  [
    ...new Set(
      (Array.isArray(value) ? value : [])
        .filter((item) => typeof item === "string")
        .map((item) => text(item, 120))
        .filter(Boolean),
    ),
  ].slice(0, 100);
export function sanitizeSourceMetadata(metadata) {
  let thumbnailUrl = null;
  try {
    if (metadata.thumbnailUrl)
      thumbnailUrl = validateThumbnailUrl(metadata.thumbnailUrl).href;
  } catch {
    /* Missing cover still allows useful metadata. */
  }
  const result = {
    title: text(metadata.title),
    author: text(metadata.author),
    genres: labels(metadata.genres),
    tags: labels(metadata.tags),
    platform: text(metadata.platform),
    publication: ["ongoing", "completed", "unknown"].includes(
      metadata.publication,
    )
      ? metadata.publication
      : "unknown",
    publicationRaw: text(metadata.publicationRaw),
    synopsis: text(metadata.synopsis, 50000),
    thumbnailUrl,
    ...(isImageType(metadata.contentType)?{contentType:metadata.contentType}:{}),
    ...(Array.isArray(metadata.authors)?{authors:labels(metadata.authors),author:labels(metadata.authors).join(", ")}:{}),
  };
  const count = metadata.expectedChapterCount ?? metadata.expectedChapters;
  if (Object.hasOwn(metadata, "rating"))
    result.rating = Number.isFinite(metadata.rating) && metadata.rating >= 0 && metadata.rating <= 5
      ? metadata.rating
      : null;
  if (Number.isSafeInteger(count) && count >= 0 && count <= 100000)
    Object.assign(result, {
      expectedChapterCount: count,
      expectedChapters: count,
    });
  return result;
}
export function mergeSourceMetadata(previous = {}, incoming = {}) {
  const known = sanitizeSourceMetadata(previous || {}),
    next = sanitizeSourceMetadata(incoming);
  for (const key of [
    "title",
    "author",
    "platform",
    "publicationRaw",
    "synopsis",
    "thumbnailUrl",
  ])
    if (!next[key]) next[key] = known[key];
  for (const key of ["genres", "tags"])
    if (!next[key].length) next[key] = known[key];
  if(known.authors?.length&&!next.authors?.length)next.authors=known.authors;
  if (next.publication === "unknown") next.publication = known.publication;
  return { ...known, ...next };
}
