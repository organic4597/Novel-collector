import { validateUrl } from "./store.mjs";
import { DEFAULT_SOURCE_ORIGIN } from "./source-site.mjs";
const fail = () =>
  Object.assign(new Error("허용된 일반 뷰어 주소를 선택하세요."), {
    status: 400,
  });
export function viewerOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw fail();
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !["sbxh9.com", "toki32.com"].includes(url.hostname)
  )
    throw fail();
  return url.origin;
}
function sourceHost(host) {
  return new URL(validateUrl(`https://${host}/novel/1`)).hostname;
}
export function normalChapter(value, origin) {
  const url = new URL(validateUrl(value));
  if (!/^\/novel\/\d+\/\d+\/?$/.test(url.pathname)) throw fail();
  return viewerOrigin(origin) + url.pathname + url.search;
}
export class ViewerOrigins {
  constructor({ store }) {
    this.store = store;
    this.path = store.path("viewer-origins.json");
    this.origins = new Map();
    this.serial = Promise.resolve();
  }
  async load() {
    const saved = await this.store.json(this.path);
    if (!saved) return;
    if (
      !saved.origins ||
      typeof saved.origins !== "object" ||
      Array.isArray(saved.origins)
    )
      throw fail();
    this.origins = new Map(
      Object.entries(saved.origins).map(([host, origin]) => [
        sourceHost(host),
        viewerOrigin(origin),
      ]),
    );
  }
  get(host) {
    return this.origins.get(sourceHost(host)) || null;
  }
  originFor(host) {
    return this.get(host) || DEFAULT_SOURCE_ORIGIN;
  }
  resolveWork(value) {
    const url = new URL(value);
    const search =
      url.pathname === "/search" &&
      [...url.searchParams.keys()].every((key) =>
        ["q", "kind", "field", "match", "page", "status", "sort"].includes(key),
      ) &&
      [null, "novel", "webtoon", "manhwa"].includes(url.searchParams.get("kind"));
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      !(
        search ||
        url.pathname === "/novel-end" ||
        /^\/novel(?:\/\d+){0,2}\/?$/.test(url.pathname)
      ) ||
      url.search.length > 8192
    )
      throw fail();
    return this.originFor(sourceHost(url.hostname)) + url.pathname + url.search;
  }
  save(host, origin) {
    host = sourceHost(host);
    origin = viewerOrigin(origin);
    const task = this.serial
      .catch(() => {})
      .then(async () => {
        const next = new Map([...this.origins, [host, origin]]);
        await this.store.atomic(this.path, {
          origins: Object.fromEntries(next),
        });
        this.origins = next;
        return origin;
      });
    this.serial = task;
    return task;
  }
  resolve(value) {
    const url = new URL(validateUrl(value));
    const origin = this.originFor(url.hostname);
    return origin + url.pathname + url.search;
  }
  canonicalChapter(value, source) {
    const canonical = new URL(validateUrl(source));
    const expected = new URL(this.resolve(source));
    const url = new URL(value);
    const work = canonical.pathname.match(/^\/novel\/(\d+)/)?.[1];
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.origin !== expected.origin ||
      url.search ||
      url.hash ||
      !/^\/novel\/\d+\/\d+\/?$/.test(url.pathname) ||
      url.pathname.split("/")[2] !== work
    )
      throw fail();
    return validateUrl(canonical.origin + url.pathname);
  }
  isViewerHost(host) {
    return ["sbxh9.com", "toki32.com"].includes(host);
  }
  assertNavigation(source, current) {
    const expected = new URL(this.resolve(source));
    const url = new URL(current);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.origin !== expected.origin ||
      url.searchParams.toString() !== expected.searchParams.toString() ||
      url.hash ||
      url.pathname.replace(/\/$/, "") !== expected.pathname.replace(/\/$/, "")
    )
      throw fail();
  }
}
