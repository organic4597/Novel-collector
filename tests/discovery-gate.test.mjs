import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Discovery } from "../src/discovery.mjs";
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
test("metadata rate limits expose Retry-After separately from site authentication", async () => {
  const failures = [];
  const d = new Discovery({
    rootDir: "unused",
    onRequestFailure: async (problem) => {
      failures.push(problem);
    },
  });
  const page = (status, header) => ({
    goto: async () => ({
      status: () => status,
      headerValue: async (name) => (name === "retry-after" ? header : null),
    }),
    url: () => "https://sbxh9.com/novel",
    evaluate: async () => ({ challenge: false }),
  });
  await assert.rejects(
    d.navigate(page(429, "900"), "https://newtoki1.org/novel"),
    (error) => error.httpStatus === 429 && error.retryAfterMs === 900000,
  );
  assert.equal(failures.length, 1);
  assert.equal(failures[0].retryAfterMs, 900000);
  await assert.rejects(
    d.navigate(page(403, null), "https://newtoki1.org/novel"),
    (error) => error.code === "NEEDS_ATTENTION",
  );
  assert.equal(failures.length, 2);
  assert.equal(failures[1].attentionKind, "site_blocked");
  await assert.rejects(
    d.navigate(page(429, null), "https://newtoki1.org/novel"),
    (error) => error.retryAfterMs === 600000,
  );
  assert.equal(failures.length, 3);
  await assert.rejects(
    d.navigate(
      {
        goto: async () => ({
          status: () => 503,
          headers: () => ({ "retry-after": "1200" }),
        }),
      },
      "https://newtoki1.org/novel",
    ),
    (error) => error.httpStatus === 503 && error.retryAfterMs === 1200000,
  );
  assert.equal(failures.length, 4);
  await d.close();
});
test("site authentication hold blocks uncached requests but retains cached covers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "discovery-attention-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let held = false,
    images = 0,
    launches = 0;
  const attention = {
    isHeld: (host) => host === "newtoki1.org" && held,
    snapshot: () => ({
      sites: held
        ? [
            {
              host: "newtoki1.org",
              held: true,
              reason: "일일 조회 인증이 필요합니다.",
            },
          ]
        : [],
    }),
  };
  const d = new Discovery({
    rootDir: root,
    attention,
    publicMetadata: false,
    launchContext: async () => {
      launches++;
      return { route: async () => {}, close: async () => {} };
    },
    fetchImage: async () => {
      images++;
      return { bytes: jpeg, mimeType: "image/jpeg" };
    },
  });
  for (const id of ["1", "2"])
    await d.registerWork(id, {
      url: `https://newtoki1.org/novel/${id}`,
      thumbnailUrl: "https://apitk.peertrk.com/a.jpg",
    });
  assert.ok(await d.thumbnail("1"));
  held = true;
  await assert.rejects(
    d.openContext(),
    (error) =>
      error.status === 503 &&
      error.code === "SITE_VERIFICATION_REQUIRED" &&
      /일일/.test(error.message),
  );
  assert.equal(launches, 0);
  await assert.rejects(
    d.navigate(
      {
        goto: async () => {
          throw new Error("must not request");
        },
      },
      "https://newtoki1.org/novel",
    ),
    (error) => error.code === "SITE_VERIFICATION_REQUIRED",
  );
  assert.ok(await d.thumbnail("1"));
  assert.equal(await d.thumbnail("2"), null);
  assert.equal(images, 1);
  await assert.rejects(
    readFile(join(root, "thumbnails", "2.json")),
    (error) => error.code === "ENOENT",
  );
  held = false;
  assert.ok(await d.thumbnail("2"));
  assert.equal(images, 2);
  await d.close();
});
test("HTTP 200 daily quota CAPTCHA reports explicit attention kind and origin without cooldown", async () => {
  const problems = [];
  const d = new Discovery({
    rootDir: "unused",
    onRequestFailure: async (error) => problems.push(error),
  });
  const page = (reader) => ({
    goto: async () => ({ status: () => 200 }),
    url: () => "https://sbxh9.com/novel/1",
    evaluate: async () => reader,
  });
  await assert.rejects(
    d.navigate(
      page({
        verificationRequired: true,
        verificationKind: "captcha",
        verificationReason: "일일 조회 인증이 필요합니다.",
      }),
      "https://newtoki1.org/novel/1",
    ),
    (error) =>
      error.code === "NEEDS_ATTENTION" &&
      error.attentionKind === "captcha" &&
      !error.retryAfterMs &&
      error.siteHost === "newtoki1.org",
  );
  await assert.rejects(
    d.navigate(page({ challenge: true }), "https://newtoki1.org/novel/1"),
    (error) => error.attentionKind === "captcha",
  );
  assert.equal(problems.length, 2);
  await assert.rejects(
    d.navigate(
      page({
        verificationRequired: true,
        verificationKind: "authentication",
        verificationReason: "로그인이 필요합니다.",
      }),
      "https://newtoki1.org/novel/1",
    ),
    (error) => error.attentionKind === "authentication",
  );
  assert.equal(problems.length, 3);
  await d.close();
});
test("site holds abort browser asset requests and cached lists remain readable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "discovery-held-list-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let held = false,
    guard,
    visits = 0;
  const attention = {
    isHeld: (host) => host === "newtoki1.org" && held,
    snapshot: () => ({
      sites: [{ host: "newtoki1.org", held, reason: "인증 필요" }],
    }),
  };
  const context = {
    route: async (_pattern, callback) => {
      guard = callback;
    },
    close: async () => {},
    newPage: async () => ({
      goto: async () => {
        visits++;
        return { status: () => 200 };
      },
      url: () => "https://sbxh9.com/novel",
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
                  episodeCount: null,
                },
              ],
              page: 1,
              maxPage: 2,
            },
    }),
  };
  const d = new Discovery({
    rootDir: root,
    attention,
    publicMetadata: false,
    launchContext: async () => context,
  });
  await d.list({});
  held = true;
  let aborted = 0;
  await guard({
    request: () => ({
      resourceType: () => "script",
      url: () => "https://apitk.peertrk.com/script.js",
      frame: () => ({ url: () => "https://sbxh9.com/novel" }),
    }),
    abort: async () => {
      aborted++;
    },
    continue: async () => {
      throw new Error("must not request held origin assets");
    },
  });
  assert.equal(aborted, 1);
  const cached = await d.list({});
  assert.equal(cached.cacheHit, true);
  assert.equal(visits, 1);
  await assert.rejects(
    d.requestDetail("1"),
    (error) =>
      error.code === "SITE_VERIFICATION_REQUIRED" && error.status === 503,
  );
  await assert.rejects(
    d.list({ page: 2 }),
    (error) => error.code === "SITE_VERIFICATION_REQUIRED",
  );
  assert.equal(visits, 1);
  await d.close();
});
test("a hold arriving during browser creation closes the pending context before exposure", async () => {
  let held = false,
    release,
    started,
    closed = 0;
  const gate = new Promise((resolve) => {
      release = resolve;
    }),
    ready = new Promise((resolve) => {
      started = resolve;
    });
  const d = new Discovery({
    rootDir: "unused",
    attention: { isHeld: () => held, snapshot: () => ({ sites: [] }) },
    publicMetadata: false,
    launchContext: async () => ({
      route: async () => {
        started();
        await gate;
      },
      close: async () => {
        closed++;
      },
    }),
  });
  const opening = d.openContext();
  await ready;
  held = true;
  release();
  await assert.rejects(
    opening,
    (error) => error.code === "SITE_VERIFICATION_REQUIRED",
  );
  assert.equal(closed, 1);
  assert.equal(d.context, null);
  held = false;
  await d.close();
});
test("default browser launch stays guarded and suspension during creation rejects stale contexts", async (t) => {
  const { chromium } = await import("playwright");
  let release,
    started,
    closed = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  t.mock.method(chromium, "launchPersistentContext", async () => ({
    route: async () => {
      started();
      await gate;
    },
    close: async () => {
      closed++;
    },
  }));
  const d = new Discovery({ rootDir: "unused", profileDir: "unused" });
  const opening = d.openContext();
  await ready;
  await d.suspendRequests();
  release();
  await assert.rejects(opening, (error) => error.code === "REQUEST_BACKOFF");
  assert.equal(closed, 1);
  assert.equal(d.context, null);
  await d.close();
});
test("a route already closed by suspension does not leak an unhandled rejection", async () => {
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
  await guard({
    request: () => {
      throw new Error("request no longer exists");
    },
    abort: async () => {
      throw new Error("route is already closed");
    },
  });
  await d.close();
});

test("global source backoff blocks cold browser navigation and new routes", async () => {
  let active = true,
    launches = 0,
    guard;
  const backoff = {
    snapshot: () => ({
      active,
      resumeAt: new Date(Date.now() + 600000).toISOString(),
    }),
  };
  const context = {
    route: async (_pattern, callback) => {
      guard = callback;
    },
    close: async () => {},
  };
  const d = new Discovery({
    rootDir: "unused",
    backoff,
    launchContext: async () => {
      launches++;
      return context;
    },
  });
  await assert.rejects(
    d.openContext(),
    (problem) => problem.code === "REQUEST_BACKOFF" && problem.status === 503,
  );
  assert.equal(launches, 0);
  await assert.rejects(
    d.navigate(
      {
        goto: async () => {
          throw new Error("should not navigate");
        },
      },
      "https://newtoki1.org/novel",
    ),
    (problem) => problem.code === "REQUEST_BACKOFF",
  );
  active = false;
  await d.openContext();
  active = true;
  let aborted = false;
  await guard({
    abort: async () => {
      aborted = true;
    },
    request: () => {
      throw new Error("must abort before request handling");
    },
  });
  assert.equal(aborted, true);
  await d.close();
});
test("source backoff keeps cached images and defers uncached covers without negative cache", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "discovery-backoff-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let active = false,
    images = 0;
  const d = new Discovery({
    rootDir: dir,
    backoff: { snapshot: () => ({ active }) },
    fetchImage: async () => {
      images++;
      return { bytes: jpeg, mimeType: "image/jpeg" };
    },
  });
  for (const id of ["1", "2"])
    await d.registerWork(id, {
      url: `https://newtoki1.org/novel/${id}`,
      thumbnailUrl: "https://apitk.peertrk.com/a.jpg",
    });
  assert.ok(await d.thumbnail("1"));
  active = true;
  assert.ok(await d.thumbnail("1"));
  assert.equal(await d.thumbnail("2"), null);
  assert.equal(images, 1);
  await assert.rejects(
    readFile(join(dir, "thumbnails", "2.json")),
    (problem) => problem.code === "ENOENT",
  );
  active = false;
  assert.ok(await d.thumbnail("2"));
  assert.equal(images, 2);
  await d.close();
});
test("suspending source requests closes a context and permits a new one after expiry", async () => {
  let active = false,
    closed = 0,
    launches = 0;
  const d = new Discovery({
    rootDir: "unused",
    backoff: { snapshot: () => ({ active }) },
    launchContext: async () => {
      launches++;
      return {
        route: async () => {},
        close: async () => {
          closed++;
        },
      };
    },
  });
  const first = await d.openContext();
  active = true;
  await d.suspendRequests();
  assert.equal(closed, 1);
  assert.equal(d.closing, false);
  await assert.rejects(
    d.openContext(),
    (problem) => problem.code === "REQUEST_BACKOFF",
  );
  active = false;
  const second = await d.openContext();
  assert.notEqual(first, second);
  assert.equal(launches, 2);
  await d.close();
});
test("a context still installing routes cannot escape suspension or a new backoff", async () => {
  let active = false,
    release,
    started,
    closed = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const d = new Discovery({
    rootDir: "unused",
    backoff: { snapshot: () => ({ active }) },
    launchContext: async () => ({
      route: async () => {
        started();
        await gate;
      },
      close: async () => {
        closed++;
      },
    }),
  });
  const opening = d.openContext();
  await ready;
  active = true;
  await d.suspendRequests();
  release();
  await assert.rejects(opening, (error) => error.code === "REQUEST_BACKOFF");
  assert.equal(d.context, null);
  assert.equal(closed, 1);
  await d.close();
});
test("images already queued recheck the backoff before making an external request", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "discovery-image-queue-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let active = false,
    images = 0,
    release,
    started;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const d = new Discovery({
    rootDir: dir,
    backoff: { snapshot: () => ({ active }) },
    fetchImage: async () => {
      images++;
      started();
      await gate;
      return { bytes: jpeg, mimeType: "image/jpeg" };
    },
  });
  for (const id of ["1", "2"])
    await d.registerWork(id, {
      url: `https://newtoki1.org/novel/${id}`,
      thumbnailUrl: "https://apitk.peertrk.com/a.jpg",
    });
  const first = d.thumbnail("1");
  await ready;
  const previousSerial = d.imageSerial;
  const second = d.thumbnail("2");
  for (let n = 0; n < 100 && d.imageSerial === previousSerial; n++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.notEqual(d.imageSerial, previousSerial);
  active = true;
  release();
  assert.ok(await first);
  assert.equal(await second, null);
  assert.equal(images, 1);
  await assert.rejects(
    readFile(join(dir, "thumbnails", "2.json")),
    (error) => error.code === "ENOENT",
  );
  await d.close();
});
