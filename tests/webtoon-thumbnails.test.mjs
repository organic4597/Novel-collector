import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchThumbnail,
  MAX_IMAGE_BYTES,
  validateImage,
  validateThumbnailUrl,
  watchListingThumbnails,
} from "../src/thumbnail-cache.mjs";
import { Discovery } from "../src/discovery.mjs";
import { sanitizeSourceMetadata } from "../src/source-metadata.mjs";

const covers = [
  "https://image-comic.pstatic.net/webtoon/853684/thumbnail/thumbnail_IMAG21_x.jpg",
  "https://user281.quicksharefiles.top/comics/covers/01M408X8539CDYBHRZ14P72CTJ.webp",
];
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const publicLookup = async () => [{ address: "8.8.8.8", family: 4 }];

class ListingPage extends EventEmitter {
  async route(pattern, handler) {
    this.routePattern = pattern;
    this.handler = handler;
  }
  async unroute(pattern, handler) {
    assert.equal(pattern, this.routePattern);
    assert.equal(handler, this.handler);
    this.handler = null;
  }
}
const imageResponse = (url = covers[0], options = {}) => ({
  url: () => url,
  status: () => options.status ?? 200,
  request: () => ({ resourceType: () => options.resourceType ?? "image" }),
  headers: () => ({
    "content-length": String(options.length ?? jpeg.length),
    "content-type": options.mimeType ?? "image/jpeg",
  }),
  body: options.body ?? (async () => jpeg),
});
async function routeResult(page, url = covers[0], resourceType = "image") {
  let action;
  await page.handler({
    request: () => ({ url: () => url, resourceType: () => resourceType }),
    continue: async () => {
      action = "continue";
    },
    abort: async () => {
      action = "abort";
    },
    fallback: async () => {
      action = "fallback";
    },
  });
  return action;
}

test("public listing capture allows only validated source cover image requests", async () => {
  const page = new ListingPage();
  const capture = await watchListingThumbnails(page, { lookup: publicLookup });
  assert.equal(await routeResult(page), "continue");
  assert.equal(await routeResult(page, covers[1]), "continue");
  assert.equal(
    await routeResult(page, "https://evil.example/cover.jpg"),
    "fallback",
  );
  assert.equal(await routeResult(page, covers[0], "fetch"), "fallback");
  await capture.close();
  assert.equal(page.listenerCount("response"), 0);
  assert.equal(page.handler, null);
  const privatePage = new ListingPage();
  const privateCapture = await watchListingThumbnails(privatePage, {
    lookup: async () => [{ address: "192.168.99.12", family: 4 }],
  });
  assert.equal(await routeResult(privatePage), "abort");
  await privateCapture.close();
});
test('listing cover routes absorb late already-handled abort and fallback rejections on close',async()=>{
  const page=new ListingPage(),capture=await watchListingThumbnails(page,{lookup:async()=>[{address:'192.168.99.12',family:4}]});
  await assert.doesNotReject(page.handler({request:()=>({url:()=>covers[0],resourceType:()=> 'image'}),abort:()=>Promise.reject(Error('Route is already handled!'))}));
  await assert.doesNotReject(page.handler({request:()=>({url:()=> 'https://evil.example/cover.jpg',resourceType:()=> 'image'}),fallback:()=>Promise.reject(Error('Route is already handled!'))}));
  await capture.close();
});

test("listing responses reuse the disk thumbnail cache without a second image fetch", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "webtoon-thumbnails-"));
  const page = new ListingPage();
  const capture = await watchListingThumbnails(page, { lookup: publicLookup });
  const discovery = new Discovery({
    rootDir,
    fetchImage: async () => {
      assert.fail("cached image must not be requested again");
    },
  });
  try {
    await discovery.init();
    await writeFile(
      join(
        rootDir,
        "thumbnails",
        "webtoon-0123456789abcdef0123456789abcdef.json",
      ),
      JSON.stringify({ failedAt: Date.now() }),
    );
    page.emit("response", imageResponse());
    await capture.save(
      [
        {
          id: "webtoon-0123456789abcdef0123456789abcdef",
          thumbnailUrl: covers[0],
        },
      ],
      (id, image) => discovery.storeThumbnail(id, image),
    );
    const image = await discovery.thumbnail(
      "webtoon-0123456789abcdef0123456789abcdef",
    );
    assert.equal(image.mimeType, "image/jpeg");
    assert.deepEqual(await readFile(image.path), jpeg);
    const metadata = JSON.parse(
      await readFile(
        join(
          rootDir,
          "thumbnails",
          "webtoon-0123456789abcdef0123456789abcdef.json",
        ),
      ),
    );
    assert.deepEqual(Object.keys(metadata).sort(), [
      "etag",
      "mimeType",
      "savedAt",
    ]);
  } finally {
    await capture.close();
    await discovery.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("listing capture rejects unrelated, oversized, failed and invalid image responses", async () => {
  const page = new ListingPage();
  const capture = await watchListingThumbnails(page, { lookup: publicLookup });
  let bodyCalls = 0,
    stored = 0;
  const body = async () => {
    bodyCalls++;
    return jpeg;
  };
  for (const response of [
    imageResponse(covers[1], { body }),
    imageResponse(covers[0], { status: 403, body }),
    imageResponse(covers[0], { length: MAX_IMAGE_BYTES + 1, body }),
    imageResponse(covers[0], { length: 0, body }),
    imageResponse(covers[0], { resourceType: "fetch", body }),
  ])
    page.emit("response", response);
  await capture.save(
    [
      {
        id: "webtoon-0123456789abcdef0123456789abcdef",
        thumbnailUrl: covers[0],
      },
    ],
    async () => {
      stored++;
    },
  );
  assert.equal(bodyCalls, 0);
  page.emit(
    "response",
    imageResponse(covers[0], { mimeType: "image/png", body }),
  );
  await capture.save(
    [
      {
        id: "webtoon-0123456789abcdef0123456789abcdef",
        thumbnailUrl: covers[0],
      },
    ],
    async () => {
      stored++;
    },
  );
  assert.equal(stored, 0);
  await capture.close();
});

test("a stalled image body cannot delay listing response for more than two seconds", async () => {
  const page = new ListingPage();
  const capture = await watchListingThumbnails(page, { lookup: publicLookup });
  page.emit(
    "response",
    imageResponse(covers[0], { body: () => new Promise(() => {}) }),
  );
  const started = Date.now();
  await capture.save(
    [
      {
        id: "webtoon-0123456789abcdef0123456789abcdef",
        thumbnailUrl: covers[0],
      },
    ],
    () => assert.fail(),
  );
  assert.ok(Date.now() - started < 2600);
  await capture.close();
});

test("listing capture limits retained responses to 96 and stores matching bytes only once", async () => {
  const page = new ListingPage();
  const capture = await watchListingThumbnails(page, { lookup: publicLookup });
  const urls = Array.from(
    { length: 100 },
    (_, index) =>
      `https://image-comic.pstatic.net/webtoon/853684/thumbnail/cover_${index}.jpg`,
  );
  for (const url of urls) page.emit("response", imageResponse(url));
  const items = urls.map((thumbnailUrl, index) => ({
    id: String(index + 1),
    thumbnailUrl,
  }));
  const saved = [];
  await capture.save(items, async (id) => {
    saved.push(id);
  });
  assert.equal(saved.length, 96);
  assert.equal(saved[0], "5");
  assert.equal(saved.at(-1), "100");
  await capture.save(items, async () => {
    assert.fail("response must not be stored twice");
  });
  await capture.close();
});

test("listing cover routes stop when the original source gate suspends requests", async () => {
  const page = new ListingPage();
  let available = true;
  const capture = await watchListingThumbnails(page, {
    lookup: async () => {
      available = false;
      return publicLookup();
    },
    assertAvailable: () => {
      if (!available) throw new Error("REQUEST_BACKOFF");
    },
  });
  assert.equal(await routeResult(page), "abort");
  await capture.close();
});

test("observed webtoon CDN covers survive discovery metadata sanitization", () => {
  for (const thumbnailUrl of covers) {
    assert.equal(validateThumbnailUrl(thumbnailUrl).href, thumbnailUrl);
    assert.equal(
      sanitizeSourceMetadata({ contentType: "webtoon", thumbnailUrl })
        .thumbnailUrl,
      thumbnailUrl,
    );
  }
  assert.equal(
    validateThumbnailUrl(
      "https://user42.quicksharefiles.top/comics/covers/cover.png",
    ).hostname,
    "user42.quicksharefiles.top",
  );
});

test("webtoon CDN rules reject lookalike hosts, unrelated paths and non-image resources", () => {
  for (const value of [
    "https://image-comic.pstatic.net.evil.example/webtoon/1/cover.jpg",
    "https://evil.image-comic.pstatic.net/webtoon/1/cover.jpg",
    "https://image-comic.pstatic.net/other/cover.jpg",
    "https://image-comic.pstatic.net/webtoon/1/cover.html",
    "https://user281.quicksharefiles.top.evil.example/comics/covers/cover.webp",
    "https://userx.quicksharefiles.top/comics/covers/cover.webp",
    "https://quicksharefiles.top/comics/covers/cover.webp",
    "https://user281.quicksharefiles.top/comics/pages/cover.webp",
    "https://user281.quicksharefiles.top/comics/covers/../private/cover.webp",
    "https://user281.quicksharefiles.top/comics/covers/nested/cover.webp",
    "https://user281.quicksharefiles.top/comics/covers/cover.svg",
    "http://user281.quicksharefiles.top/comics/covers/cover.webp",
    "https://user:password@user281.quicksharefiles.top/comics/covers/cover.webp",
    "https://user281.quicksharefiles.top:444/comics/covers/cover.webp",
  ])
    assert.throws(() => validateThumbnailUrl(value), undefined, value);
});

test("new CDN requests keep public DNS pinning and image validation", async () => {
  for (const cover of covers) {
    const image = await fetchThumbnail(cover, {
      lookup: publicLookup,
      request: async (url, address) => {
        assert.equal(url.href, cover);
        assert.deepEqual(address, { address: "8.8.8.8", family: 4 });
        return { status: 200, bytes: jpeg, mimeType: "image/jpeg" };
      },
    });
    assert.equal(image.mimeType, "image/jpeg");
    let requests = 0;
    await assert.rejects(
      fetchThumbnail(cover, {
        lookup: async () => [
          { address: "8.8.8.8", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ],
        request: async () => {
          requests++;
        },
      }),
      /공인 주소/,
    );
    assert.equal(requests, 0);
  }
  assert.throws(() => validateImage(jpeg, "image/png"));
  assert.throws(() => validateImage(Buffer.from("<svg/>"), "image/svg+xml"));
  assert.throws(() =>
    validateImage(Buffer.alloc(MAX_IMAGE_BYTES + 1), "image/jpeg"),
  );
});

test("new CDN redirects revalidate host, path and DNS before another request", async () => {
  for (const location of [
    "https://evil.example/cover.jpg",
    "https://user281.quicksharefiles.top/comics/private/cover.webp",
    "https://image-comic.pstatic.net/other/cover.jpg",
  ]) {
    let requests = 0;
    await assert.rejects(
      fetchThumbnail(covers[0], {
        lookup: publicLookup,
        request: async () => {
          requests++;
          return { status: 302, location };
        },
      }),
      /지원하지 않는/,
    );
    assert.equal(requests, 1);
  }
  let requests = 0;
  await assert.rejects(
    fetchThumbnail(covers[0], {
      lookup: async (hostname) => [
        {
          address:
            hostname === "image-comic.pstatic.net"
              ? "8.8.8.8"
              : "192.168.99.12",
          family: 4,
        },
      ],
      request: async () => {
        requests++;
        return { status: 302, location: covers[1] };
      },
    }),
    /공인 주소/,
  );
  assert.equal(requests, 1);
});
