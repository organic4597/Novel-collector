import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import https from "node:https";
import { EventEmitter } from "node:events";
import discoveryFixture from "./fixtures/discovery-synthetic.mjs";
import {
  Discovery,
  readDiscoveryDocument,
  normalizeDiscoveryQuery,
  normalizeDiscoveryUrl,
} from "../src/discovery.mjs";
import {
  validateThumbnailUrl,
  fetchThumbnail,
  validateImage,
  requestImage,
} from "../src/thumbnail-cache.mjs";

const html =
  '<ul><li data-genre="판타지,액션" date-title="작품"><a href="/novel/123"><img class="theme-thumb-img" src="https://apitk.peertrk.com/webtoon_uploads/a.jpg"><span class="title">작품</span></a><span class="list-platform">문피아</span><span class="list-date">10.02</span></li><li data-genre="판타지" date-title="작품"><a href="/novel/123"><span class="title">작품</span></a></li></ul><div class="pg"><a href="/novel?page=142">끝</a></div>';
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
test("listing parser preserves metadata, de-duplicates works and reads pagination", () => {
  const dom = new JSDOM(html, { url: "https://newtoki1.org/novel?page=2" });
  const data = readDiscoveryDocument(dom.window.document);
  assert.equal(data.items.length, 1);
  assert.equal(data.maxPage, 142);
  assert.equal(data.page, 2);
  assert.deepEqual(data.items[0].genres, ["판타지", "액션"]);
  assert.equal(data.items[0].episodeCount, null);
  assert.equal(data.items[0].platform, "문피아");
  dom.window.close();
});
test("listing without an image does not invent a source URL", () => {
  const dom = new JSDOM(
    '<li data-genre="" date-title="x"><a href="/novel/1"><span class="title">x</span></a></li>',
    { url: "https://newtoki1.org/novel" },
  );
  assert.equal(
    readDiscoveryDocument(dom.window.document).items[0].thumbnailUrl,
    null,
  );
  dom.window.close();
});
test("raw HTTPS downloader pins DNS, bounds response size, and reads valid images", async (t) => {
  let next = {
    status: 200,
    headers: { "content-type": "image/jpeg" },
    bytes: jpeg,
  };
  t.mock.method(https, "get", (_url, options, onResponse) => {
    options.lookup("apitk.peertrk.com", {}, (error, address, family) => {
      assert.equal(error, null);
      assert.equal(address, "8.8.8.8");
      assert.equal(family, 4);
    });
    options.lookup("apitk.peertrk.com", { all: true }, (error, addresses) => {
      assert.equal(addresses[0].address, "8.8.8.8");
    });
    const req = new EventEmitter();
    req.destroy = (error) => {
      req.emit("error", error);
      req.emit("close");
    };
    queueMicrotask(() => {
      const res = new EventEmitter();
      res.statusCode = next.status;
      res.headers = next.headers;
      res.resume = () => {};
      res.destroy = (error) => {
        if (error) res.emit("error", error);
      };
      onResponse(res);
      if (next.bytes) {
        res.emit("data", next.bytes);
        res.emit("end");
      }
      req.emit("close");
    });
    return req;
  });
  const address = { address: "8.8.8.8", family: 4 };
  assert.equal(
    (await requestImage(new URL("https://apitk.peertrk.com/a.jpg"), address))
      .bytes.length,
    7,
  );
  next = { status: 302, headers: { location: "/next" } };
  assert.equal(
    (await requestImage(new URL("https://apitk.peertrk.com/a.jpg"), address))
      .location,
    "/next",
  );
  next = { status: 500, headers: {} };
  await assert.rejects(
    requestImage(new URL("https://apitk.peertrk.com/a.jpg"), address),
  );
  next = { status: 200, headers: { "content-length": 2 * 1024 * 1024 + 1 } };
  await assert.rejects(
    requestImage(new URL("https://apitk.peertrk.com/a.jpg"), address),
  );
  next = { status: 200, headers: {}, bytes: Buffer.alloc(2 * 1024 * 1024 + 1) };
  await assert.rejects(
    requestImage(new URL("https://apitk.peertrk.com/a.jpg"), address),
  );
});
test("synthetic site fixture reads 96 works and 142 pages without prefetching details", async () => {
  const dom = new JSDOM(
    discoveryFixture,
    { url: "https://newtoki1.org/novel" },
  );
  const data = readDiscoveryDocument(dom.window.document);
  assert.equal(data.items.length, 96);
  assert.equal(data.maxPage, 142);
  assert.equal(data.items[0].id, "1000");
  assert.equal(data.items[0].title, "합성 작품 1");
  assert.match(data.items[0].thumbnailUrl, /apitk.peertrk.com/);
  assert.ok(data.filters.platforms.includes("카카오페이지"));
  dom.window.close();
});
test("encoded canonical list URLs preserve filters and pagination", async () => {
  const encoded = (query) => Buffer.from(query).toString("base64url");
  const canonical = `https://newtoki1.org/novel/__q/${encoded("kind=novel&page=3&pub=all&sst=as_update")}`;
  const dom = new JSDOM(
    html.replace(
      "/novel?page=142",
      `/novel/__q/${encoded("kind=novel&page=142&pub=all")}`,
    ),
    { url: canonical },
  );
  const data = readDiscoveryDocument(dom.window.document);
  assert.equal(data.page, 3);
  assert.equal(data.maxPage, 142);
  assert.equal(data.items[0].publication, "all");
  assert.equal(data.items[0].url, "https://newtoki1.org/novel/123");
  assert.equal(normalizeDiscoveryUrl(canonical).searchParams.get("page"), "3");
  assert.equal(
    normalizeDiscoveryUrl("https://newtoki1.org/novel?page=2").href,
    "https://newtoki1.org/novel?page=2",
  );
  const discovery = new Discovery({ rootDir: "unused" });
  await discovery.navigate(
    {
      goto: async () => ({ status: () => 200 }),
      url: () => "https://sbxh9.com/novel?page=3",
      evaluate: async () => ({ challenge: false }),
    },
    "https://newtoki1.org/novel?page=3",
  );
  for (const invalid of [
    "https://newtoki1.org/novel/__q/!!!",
    `https://newtoki1.org/novel/__q/${"a".repeat(2049)}`,
    `https://newtoki1.org/novel/__q/${encoded("https://evil.example")}`,
  ])
    assert.throws(() => normalizeDiscoveryUrl(invalid));
  dom.window.close();
});
test("query rejects malformed filters and URLs", () => {
  assert.equal(
    normalizeDiscoveryQuery({ page: "2", publication: "completed" }).page,
    2,
  );
  for (const value of [
    { page: 0 },
    { page: 1001 },
    { query: "x".repeat(101) },
    { publication: "evil" },
    { genre: "x".repeat(41) },
  ])
    assert.throws(() => normalizeDiscoveryQuery(value));
  assert.throws(() => validateThumbnailUrl("https://evil.example/a.jpg"));
  assert.throws(() => validateThumbnailUrl("http://apitk.peertrk.com/a.jpg"));
  assert.throws(() =>
    validateThumbnailUrl("https://apitk.peertrk.com:444/a.jpg"),
  );
  assert.throws(
    () => normalizeDiscoveryQuery({ minEpisodes: 5, maxEpisodes: 1 }),
    (error) => error.status === 400,
  );
  assert.throws(
    () => normalizeDiscoveryQuery({ platform: 42 }),
    (error) => error.status === 400,
  );
  assert.throws(
    () => normalizeDiscoveryQuery({ query: "bad\u0000input" }),
    (error) => error.status === 400,
  );
});
test("image validation rejects SVG, MIME mismatch and oversized files", () => {
  assert.equal(validateImage(jpeg, "image/jpeg"), "image/jpeg");
  assert.throws(() => validateImage(Buffer.from("<svg/>"), "image/svg+xml"));
  assert.throws(() => validateImage(jpeg, "image/png"));
  assert.throws(() =>
    validateImage(Buffer.alloc(2 * 1024 * 1024 + 1), "image/jpeg"),
  );
});
test("thumbnail fetch rejects private DNS before making requests", async () => {
  let calls = 0;
  await assert.rejects(
    fetchThumbnail("https://apitk.peertrk.com/a.jpg", {
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      request: async () => {
        calls++;
      },
    }),
  );
  assert.equal(calls, 0);
});
test("redirects validate the next host and DNS, and stop after three redirects", async () => {
  const publicLookup = async () => [{ address: "8.8.8.8", family: 4 }];
  let calls = 0;
  await assert.rejects(
    fetchThumbnail("https://apitk.peertrk.com/a.jpg", {
      lookup: publicLookup,
      request: async () => ({
        status: 302,
        location: "https://evil.example/x",
      }),
    }),
  );
  await assert.rejects(
    fetchThumbnail("https://apitk.peertrk.com/a.jpg", {
      lookup: publicLookup,
      request: async () => {
        calls++;
        return { status: 302, location: "/next.jpg" };
      },
    }),
  );
  assert.equal(calls, 4);
  let lookups = 0;
  await assert.rejects(
    fetchThumbnail("https://apitk.peertrk.com/a.jpg", {
      lookup: async () => [
        { address: ++lookups === 1 ? "8.8.8.8" : "192.168.1.1", family: 4 },
      ],
      request: async () => ({ status: 302, location: "/next.jpg" }),
    }),
  );
  assert.equal(lookups, 2);
  const result = await fetchThumbnail("https://apitk.peertrk.com/a.jpg", {
    lookup: publicLookup,
    request: async (_url, address) => {
      assert.equal(address.address, "8.8.8.8");
      return { status: 200, bytes: jpeg, mimeType: "image/jpeg" };
    },
  });
  assert.equal(result.mimeType, "image/jpeg");
});
test("page and thumbnail survive restart, deduplicate requests and detail counts unique chapters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "discovery-"));
  let currentUrl;
  let navigations = 0,
    images = 0;
  const launchContext = async () => ({
    route: async () => {},
    close: async () => {},
    newPage: async () => ({
      goto: async (url) => {
        currentUrl = url;
        navigations++;
        if (navigations === 1) {
          assert.equal(url, "https://sbxh9.com/novel");
        }
        return { status: () => 200 };
      },
      url: () => currentUrl,
      close: async () => {},
      evaluate: async (fn) =>
        fn.name === "readDiscoveryDocument"
          ? {
              items: [
                {
                  id: "123",
                  title: "작품",
                  url: "https://newtoki1.org/novel/123",
                  genres: ["판타지"],
                  platform: "문피아",
                  publication: "ongoing",
                  thumbnailUrl: "https://apitk.peertrk.com/a.jpg",
                  episodeCount: null,
                },
              ],
              page: 1,
              maxPage: 2,
              total: null,
            }
          : fn.name === "readReaderDocument"
            ? { challenge: false }
            : {
                title: "작품",
                chapters: [
                  { url: "https://newtoki1.org/novel/123/1" },
                  { url: "https://newtoki1.org/novel/123/2" },
                ],
                maxPage: 1,
              },
    }),
  });
  const options = {
    rootDir: dir,
    launchContext,
    fetchImage: async () => {
      images++;
      return { bytes: jpeg, mimeType: "image/jpeg" };
    },
  };
  try {
    const discovery = new Discovery(options);
    const results = await Promise.all([discovery.list({}), discovery.list({})]);
    assert.equal(navigations, 1);
    assert.equal(results[0].items.length, 1);
    await Promise.all([discovery.thumbnail("123"), discovery.thumbnail("123")]);
    assert.equal(images, 1);
    const detail = await discovery.detail("123");
    assert.equal(detail.episodeCount, 2);
    assert.equal(detail.thumbnailUrl, undefined);
    assert.equal(detail.thumbnail, "/api/discover/123/thumbnail");
    await discovery.close();
    const fresh = new Discovery(options);
    const cached = await fresh.list({});
    assert.equal(cached.cacheHit, true);
    assert.equal(cached.items[0].episodeCount, 2);
    assert.ok(await fresh.thumbnail("123"));
    assert.equal(images, 1);
    assert.equal(navigations, 2);
    await fresh.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("failed thumbnails use negative cache and unknown episode filters are explicit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "discovery-"));
  let currentUrl;
  let images = 0;
  const context = {
    route: async () => {},
    close: async () => {},
    newPage: async () => ({
      goto: async url => { currentUrl=url; return { status: () => 200 }; },
      url: () => currentUrl,
      close: async () => {},
      evaluate: async (fn) =>
        fn.name === "readReaderDocument"
          ? { challenge: false }
          : {
              items: [
                {
                  id: "1",
                  title: "작품",
                  url: "https://newtoki1.org/novel/1",
                  thumbnailUrl: "https://apitk.peertrk.com/a.jpg",
                  episodeCount: null,
                },
              ],
              page: 1,
              maxPage: 1,
              total: null,
            },
    }),
  };
  try {
    const d = new Discovery({
      rootDir: dir,
      launchContext: async () => context,
      fetchImage: async () => {
        images++;
        throw new Error("unavailable");
      },
    });
    const list = await d.list({ minEpisodes: 10 });
    assert.equal(list.filters.episodeScope, "known-only");
    assert.equal(list.unknownEpisodeCount, 1);
    assert.equal(list.items.length, 0);
    assert.equal(await d.thumbnail("1"), null);
    assert.equal(await d.thumbnail("1"), null);
    assert.equal(images, 1);
    await d.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("browser requests block images, insecure URLs and private addresses", async () => {
  let guard;
  const d = new Discovery({
    rootDir: "unused",
    launchContext: async () => ({
      route: async (_pattern, callback) => {
        guard = callback;
      },
      close: async () => {},
    }),
  });
  await d.openContext();
  assert.equal(await d.openContext(), d.context);
  for (const [url, type, expected] of [
    ["https://8.8.8.8/test", "image", "abort"],
    ["http://8.8.8.8/test", "script", "abort"],
    ["https://127.0.0.1/test", "document", "abort"],
    ["https://8.8.8.8/test", "script", "continue"],
  ]) {
    let result;
    await guard({
      request: () => ({ url: () => url, resourceType: () => type }),
      abort: async () => {
        result = "abort";
      },
      continue: async () => {
        result = "continue";
      },
    });
    assert.equal(result, expected);
  }
  await d.close();
});
test("navigation rejects access checks, errors, unexpected hosts and CAPTCHA", async () => {
  const d = new Discovery({ rootDir: "unused" });
  const page = (status, url, challenge = false) => ({
    goto: async () => ({ status: () => status }),
    url: () => url,
    evaluate: async () => ({ challenge }),
  });
  await assert.rejects(
    d.navigate(
      page(403, "https://newtoki1.org/novel"),
      "https://newtoki1.org/novel",
    ),
    (error) => error.code === "NEEDS_ATTENTION",
  );
  await assert.rejects(
    d.navigate(
      page(500, "https://newtoki1.org/novel"),
      "https://newtoki1.org/novel",
    ),
  );
  await assert.rejects(
    d.navigate(
      page(200, "https://evil.example/novel"),
      "https://newtoki1.org/novel",
    ),
    (error) => error.code === "NEEDS_ATTENTION",
  );
  await assert.rejects(
    d.navigate(
      page(200, "https://newtoki1.org/novel", true),
      "https://newtoki1.org/novel",
    ),
    (error) => error.code === "NEEDS_ATTENTION",
  );
});
test("detail fixture paginates exactly and the normal search uses public form values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "discovery-"));
  let currentUrl = "",
    navigations = 0;
  let now = Date.now();
  let images = 0;
  const context = {
    route: async () => {},
    close: async () => {},
    newPage: async () => ({
      goto: async (url) => {
        currentUrl = url;
        navigations++;
        return { status: () => 200 };
      },
      url: () => currentUrl,
      close: async () => {},
      evaluate: async (fn) => {
        if (fn.name === "readReaderDocument") return { challenge: false };
        if (fn.name === "readDiscoveryDocument")
          return {
            items: [
              {
                id: "1",
                url: "https://newtoki1.org/novel/1",
                title: "x",
                thumbnailUrl: "https://apitk.peertrk.com/x",
                episodeCount: null,
              },
            ],
            page: 2,
            maxPage: 10,
            total: null,
          };
        const ep = new URL(currentUrl).searchParams.get("epage");
        return {
          title: "x",
          maxPage: 2,
          chapters: ep
            ? [
                { url: "https://newtoki1.org/novel/1/1" },
                { url: "https://newtoki1.org/novel/1/3" },
              ]
            : [
                { url: "https://newtoki1.org/novel/1/1" },
                { url: "https://newtoki1.org/novel/1/2" },
              ],
        };
      },
    }),
  };
  try {
    const d = new Discovery({
      rootDir: dir,
      launchContext: async () => context,
      now: () => now,
      delayMs: 1,
      fetchImage: async () => {
        images++;
        if (images === 1) throw new Error("failure");
        return { bytes: jpeg, mimeType: "image/jpeg" };
      },
    });
    await d.list({
      page: 2,
      publication: "completed",
      sort: "episodes",
      query: "책",
    });
    const url = new URL(currentUrl);
    assert.equal(url.pathname, "/search");
    assert.equal(url.searchParams.get("status"), "completed");
    assert.equal(url.searchParams.get("sort"), "episodes");
    assert.equal(url.searchParams.get("q"), "책");
    assert.equal(url.searchParams.get("field"), "title");
    assert.equal((await d.detail("1")).episodeCount, 3);
    assert.equal((await d.detail("1")).episodeCount, 3);
    assert.equal(navigations, 4, "the logical-page adapter reads the first source page before page two");
    await assert.rejects(d.detail("2"), (error) => error.status === 404);
    assert.throws(
      () => d.detail("../evil"),
      (error) => error.status === 400,
    );
    assert.equal(await d.thumbnail("2"), null);
    assert.equal(await d.thumbnail("1"), null);
    now += 6 * 60 * 60 * 1000 + 1;
    assert.ok(await d.thumbnail("1"));
    assert.equal(images, 2);
    const list = await d.list({
      page: 2,
      publication: "completed",
      sort: "episodes",
      query: "책",
      minEpisodes: 3,
      maxEpisodes: 3,
    });
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].episodeCount, 3);
    await d.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("metadata requests return immediately and allow listing during a slow detail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "discovery-"));
  let release;
  let ready;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    ready = resolve;
  });
  let launches = 0;
  const context = {
    route: async () => {},
    close: async () => {
      release();
    },
    newPage: async () => {
      let current;
      return {
        goto: async (url) => {
          current = url;
          if (new URL(url).pathname === "/novel/1") {
            ready();
            await blocked;
          }
          return { status: () => 200 };
        },
        url: () => current,
        close: async () => {},
        evaluate: async (fn) =>
          fn.name === "readReaderDocument"
            ? { challenge: false }
            : fn.name === "readDiscoveryDocument"
              ? {
                  items: [
                    {
                      id: "1",
                      url: "https://newtoki1.org/novel/1",
                      title: "x",
                      episodeCount: null,
                    },
                  ],
                  page: 1,
                  maxPage: 2,
                }
              : {
                  title: "x",
                  chapters: [{ url: "https://newtoki1.org/novel/1/1" }],
                  maxPage: 1,
                },
      };
    },
  };
  try {
    const d = new Discovery({
      rootDir: dir,
      launchContext: async () => {
        launches++;
        return context;
      },
      delayMs: 0,
    });
    await d.list({});
    const pending = await d.requestDetail("1");
    assert.equal(pending.status, "pending");
    await entered;
    assert.equal((await d.requestDetail("1")).status, "pending");
    assert.equal((await d.detailState("1")).status, "pending");
    const page = await d.list({ page: 2 });
    assert.equal(page.items.length, 1);
    assert.equal(launches, 1);
    release();
    await d.detail("1");
    assert.equal((await d.detailState("1")).status, "completed");
    assert.equal((await d.requestDetail("1")).item.episodeCount, 1);
    await d.close();
  } finally {
    release();
    await rm(dir, { recursive: true, force: true });
  }
});
test("context creation is shared and shutdown aborts a queued metadata crawl promptly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "discovery-"));
  let launches = 0;
  let release;
  let entered;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const context = {
    route: async () => {},
    close: async () => {
      release();
    },
    newPage: async () => {
      let current;
      return {
        goto: async (url) => {
          current = url;
          if (new URL(url).pathname === "/novel/1") {
            entered();
            await blocked;
          }
          return { status: () => 200 };
        },
        url: () => current,
        close: async () => {},
        evaluate: async (fn) =>
          fn.name === "readReaderDocument"
            ? { challenge: false }
            : fn.name === "readDiscoveryDocument"
              ? {
                  items: [
                    {
                      id: "1",
                      url: "https://newtoki1.org/novel/1",
                      title: "x",
                      episodeCount: null,
                    },
                  ],
                  page: 1,
                  maxPage: 2,
                }
              : {
                  title: "x",
                  chapters: [{ url: "https://newtoki1.org/novel/1/1" }],
                  maxPage: 1000,
                },
      };
    },
  };
  try {
    const d = new Discovery({
      rootDir: dir,
      launchContext: async () => {
        launches++;
        await new Promise((r) => setTimeout(r, 5));
        return context;
      },
      delayMs: 0,
    });
    await Promise.all([d.openContext(), d.openContext()]);
    assert.equal(launches, 1);
    await d.list({});
    await d.requestDetail("1");
    await ready;
    await d.close();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal((await d.detailState("1")).status, "failed");
    await assert.rejects(d.openContext());
  } finally {
    release();
    await rm(dir, { recursive: true, force: true });
  }
});
test("context is not exposed until its network guard is installed", async () => {
  let release, started;
  const guardGate = new Promise((resolve) => {
    release = resolve;
  });
  const installing = new Promise((resolve) => {
    started = resolve;
  });
  const context = {
    route: async () => {
      started();
      await guardGate;
    },
    close: async () => {},
  };
  const d = new Discovery({
    rootDir: "unused",
    launchContext: async () => context,
  });
  const first = d.openContext();
  await installing;
  let secondResolved = false;
  const second = d.openContext().then((value) => {
    secondResolved = true;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondResolved, false);
  release();
  assert.equal(await first, context);
  assert.equal(await second, context);
  await d.close();
});
