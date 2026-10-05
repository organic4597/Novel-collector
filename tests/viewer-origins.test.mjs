import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderStore } from "../src/store.mjs";
import { ViewerOrigins } from "../src/viewer-origins.mjs";
import {
  Collector,
  readReaderDocument,
  makeBookId,
} from "../src/collector.mjs";
import { JSDOM } from "jsdom";
import { SiteAutoAuth } from "../src/site-auto-auth.mjs";

test("verified viewer mapping persists and changes catalog and chapter transport, never canonical identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "viewer-origin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new FolderStore(root).init();
  const origins = new ViewerOrigins({ store });
  await origins.load();
  const chapter = "https://newtoki1.org/novel/21104/3001372";
  assert.equal(origins.get("newtoki1.org"), null);
  assert.equal(
    origins.resolve(chapter),
    "https://sbxh9.com/novel/21104/3001372",
  );
  assert.equal(await store.json(origins.path), null);
  await origins.save("newtoki1.org", "https://sbxh9.com");
  assert.equal(
    origins.resolve(chapter),
    "https://sbxh9.com/novel/21104/3001372",
  );
  assert.equal(
    origins.resolve("https://newtoki1.org/novel/21104?epage=2"),
    "https://sbxh9.com/novel/21104?epage=2",
  );
  assert.equal(makeBookId(chapter), "newtoki1_org-21104");
  const again = new ViewerOrigins({ store });
  await again.load();
  assert.equal(again.get("newtoki1.org"), "https://sbxh9.com");
  for (const value of [
    "http://sbxh9.com",
    "https://sbxh9.com.evil.test",
    "https://user@sbxh9.com",
    "https://sbxh9.com:444",
    "https://sbxh9.com/other",
    "https://127.0.0.1",
  ])
    assert.throws(() => origins.save("newtoki1.org", value));
  assert.throws(() =>
    origins.assertNavigation(chapter, "https://sbxh9.com/novel/21104/999"),
  );
  assert.throws(() =>
    origins.assertNavigation(chapter, "https://evil.test/novel/21104/3001372"),
  );
  assert.throws(() =>
    origins.assertNavigation(
      "https://newtoki1.org/novel/21104?epage=2",
      "https://sbxh9.com/novel/21104?epage=1",
    ),
  );
  assert.throws(() =>
    origins.assertNavigation(
      chapter,
      "https://sbxh9.com/novel/21104/3001372?token=untrusted",
    ),
  );
});

test("rendered normal chapter links map to canonical identities with strict work and origin checks", async () => {
  const origins = new ViewerOrigins({
    store: { path: (v) => v, json: async () => null, atomic: async () => {} },
  });
  const source = "https://newtoki1.org/novel/21104?epage=2";
  await origins.save("newtoki1.org", "https://sbxh9.com");
  assert.equal(
    origins.canonicalChapter("https://sbxh9.com/novel/21104/3001372", source),
    "https://newtoki1.org/novel/21104/3001372",
  );
  for (const value of [
    "https://toki32.com/novel/21104/3001372",
    "https://sbxh9.com/novel/999/3001372",
    "https://sbxh9.com/novel/21104",
    "https://sbxh9.com/novel/21104/3001372?token=secret",
    "https://sbxh9.com/novel/21104/3001372#private",
    "https://user@sbxh9.com/novel/21104/3001372",
    "https://sbxh9.com:444/novel/21104/3001372",
  ])
    assert.throws(() => origins.canonicalChapter(value, source));
});

test("normal-viewer chapter collection uses its own account lookup without posting canonical credentials to a peer", async (t) => {
  const origins = new ViewerOrigins({
    store: { path: (v) => v, json: async () => null, atomic: async () => {} },
  });
  await origins.save("newtoki1.org", "https://sbxh9.com");
  let posts = 0;
  const accountLookups = [];
  const visits = [];
  const reader = {
    text: "정상 본문",
    challenge: false,
    verificationRequired: false,
  };
  const page = {
    url: () => visits.at(-1),
    goto: async (url) => {
      visits.push(url);
      return { status: () => 200 };
    },
    evaluate: async () => reader,
    context: () => ({
      request: {
        post: async () => {
          posts++;
          assert.fail("canonical credentials must not be posted to a viewer");
        },
      },
    }),
  };
  const autoAuth = new SiteAutoAuth({
    accounts: {
      status: (name) => {
        accountLookups.push(name);
        return {
          configured: name === "newtoki1.org",
          enabled: name === "newtoki1.org",
        };
      },
      getCredentials: () =>
        assert.fail("an unconfigured viewer cannot load canonical credentials"),
    },
    siteBrowser: {},
    attention: {},
    scheduler: {},
  });
  t.after(() => autoAuth.close());
  const collector = new Collector({
    store: {},
    profileDir: "fixture/profiles",
    viewerOrigins: origins,
    authenticatePage: (page, signal) => autoAuth.loginPage(page, signal),
  });
  await collector.navigate(
    page,
    "https://newtoki1.org/novel/21104/3001372",
    new AbortController().signal,
  );
  assert.deepEqual(visits, ["https://sbxh9.com/novel/21104/3001372"]);
  assert.equal(posts, 0);
  assert.deepEqual(accountLookups, ["sbxh9.com"]);
  assert.equal(collector.fork(1).viewerOrigins, origins);
});

test("normal viewer rendered closed shadow body is readable, but visible puzzle still blocks proof", () => {
  const dom = new JSDOM(
    '<article class="novel-viewer"><div id="host"></div></article>',
  );
  const host = dom.window.document.getElementById("host");
  host.__novelShadow = host.attachShadow({ mode: "closed" });
  host.__novelShadow.innerHTML = "<p>화면에 표시된 정상 본문</p>";
  assert.equal(
    readReaderDocument(dom.window.document).text,
    "화면에 표시된 정상 본문",
  );
  const slider = dom.window.document.createElement("button");
  slider.setAttribute("aria-label", "퍼즐 슬라이더");
  dom.window.document.body.append(slider);
  assert.equal(readReaderDocument(dom.window.document).challenge, true);
  dom.window.close();
});
